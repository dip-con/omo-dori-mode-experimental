// Dori RPC adapter (redesign S1).
// Lane key -> durable session id -> live control endpoint (routing id), then send / state / receipt / wait.
//   resolve <target> [--json]                         durable id, sessionPath, routing {sessionId, socket, kind, instanceId}, managed
//   protocol <target> [--json]                        get_protocol_info of the endpoint hosting the target
//   state <target> [--json]                           get_state subset
//   receipt <target> <id> [--json]                    persisted | absent, read from the session JSONL only
//   wait <target> --until idle [--timeout <s>]        returns on the endpoint's `completion` event (no polling)
//   send <target> <text> [--id X] [--mode steer|follow_up|prompt] [--child-ok] [--plan]   (--plan: checks only, sends nothing)
//   status <target> [--json]                          lane-status.json row + children (S5): settled only when children are known,
//                                                     none run, the snapshot is fresh and herdr does not report the pane working
//   children <target> [--json]                        {state: known|unknown, running, done, failed, dagRuns, childrenIds}
//   answer <target> --option <label>|--text <text> [--question-id <toolCallId>]   settle the lane's pending ask_user_question
//                                                     (extension_ui_response); exit 0 answered+cleared, 2 refused, 3 cleared unconfirmed
// Success is only an exact delivery id persisted in the session JSONL; an admission answer is `accepted`.
// Herdr fallback is offered only when no request byte reached the endpoint (`refused(no_endpoint)`).
// Socket secrets are read into memory only; nothing here prints or stores them.
import { createConnection, type Socket } from 'node:net'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deliver, isOmoProcess, recordHasTag, tagMessage, type Deps as HerdrDeps, type DeliverResult, type Proc } from './deliver'
import { sessionDirSlug, sessionRoot } from './questions'
import { doriHome, isLeadKey } from './config'

const HOME = process.env.HOME!
/** `customType` of the transcript entry an admitted delivery becomes (RT/core/extensions/session-control-types.js). */
export const DELIVERY_TYPE = 'session_control_delivery'
export const PROTOCOL_VERSION = 1

export type Kind = 'tui' | 'rpc_host'
export type Managed = 'lane' | 'child' | 'lead' | 'unmanaged'
export type Routing = {
  sessionId: string; socket: string; kind: Kind; instanceId: string; generation: number
  protocolVersion: number; commands: string[]
}
export type Holder = { pid: number; alive: boolean; inPane: boolean }
export type Resolved = {
  key: string | null; durableId: string; sessionPath: string | null; pane: string | null; cwd: string | null
  routing: Routing | null; routingError?: string; holders: Holder[]; managed: Managed; fallback: 'herdr' | null
}
export type SentTo = { durableId: string; sessionPath: string | null; instanceId: string | null }
export type Delivery = {
  status: 'delivered' | 'accepted' | 'refused' | 'uncertain' | 'planned'; id: string; transport: 'rpc' | 'herdr'
  disposition?: string; reason?: string; fallback?: 'herdr' | null; sentTo: SentTo
}
export type MapEntry = { key: string; sessionId: string; status: string; pane?: string; cwd?: string }
export type RpcDeps = {
  endpointsRoot: string
  sessionsRoot: string
  loadMap: () => Record<string, MapEntry>
  paneProcs: (pane: string) => Promise<Proc[]>
  probeTimeoutMs: number
  requestTimeoutMs: number
  receiptWaitMs: number
  receiptPollMs: number
  /** The supervisor snapshot (DORI_HOME/lane-status.json); null when absent or unreadable. */
  laneStatus?: () => any | null
  /** herdr agent_status of a pane ('working' | 'idle' | ...), null when herdr does not answer. Auxiliary only. */
  agentStatus?: (pane: string) => Promise<string | null>
  /** A snapshot older than this cannot vouch for children (the supervisor rewrites it every ~10 s). */
  statusStaleMs?: number
}

export const laneStatusPath = () => `${doriHome()}/lane-status.json`
export function readLaneStatus(path = laneStatusPath()): any | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** True when one JSONL line proves delivery `id`: an admission entry naming it, or a herdr-typed user message carrying its tag. */
export function lineProvesDelivery(line: string, id: string): boolean {
  if (!line.includes(id)) return false
  let o: any
  try { o = JSON.parse(line) } catch { return false }
  if (o?.type === 'custom_message' && o.customType === DELIVERY_TYPE && o.details?.delivery_id === id) return true
  return recordHasTag(line, id)
}

export function receiptIn(jsonl: string, id: string): 'persisted' | 'absent' {
  if (!jsonl.includes(id)) return 'absent'
  return jsonl.split('\n').some((l) => lineProvesDelivery(l, id)) ? 'persisted' : 'absent'
}

export function receipt(sessionPath: string | null, id: string): 'persisted' | 'absent' {
  if (!sessionPath) return 'absent'
  try { return receiptIn(readFileSync(sessionPath, 'utf8'), id) } catch { return 'absent' }
}

export class NoEndpoint extends Error { constructor(readonly code: string) { super(`no_endpoint: ${code}`) } }
export class TransportLost extends Error { constructor(readonly code: string) { super(`transport lost: ${code}`) } }

type Pending = { resolve: (r: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class Conn {
  private buf = ''
  private seq = 0
  private pending = new Map<string, Pending>()
  private listeners: ((ev: any) => void)[] = []
  private closed = false
  /** Set the moment a request frame is handed to the socket. */
  requestBytesWritten = false
  private constructor(private socket: Socket) {
    socket.setEncoding('utf8')
    socket.on('data', (d: string) => this.onData(d))
    const gone = () => {
      this.closed = true
      for (const [k, p] of this.pending) { clearTimeout(p.timer); p.reject(new TransportLost('closed')); this.pending.delete(k) }
    }
    socket.on('close', gone)
    socket.on('error', gone)
  }

  /** Connect and send the handshake secret. Every failure here is before any request byte: NoEndpoint. */
  static async open(socketPath: string, timeoutMs: number): Promise<Conn> {
    // Terminal sockets take a 32-byte secret first; POSIX multi-session host sockets have no secret file and no handshake.
    let secret: Buffer | null = null
    try { secret = readFileSync(`${socketPath}.secret`) } catch (e: any) { if (e?.code !== 'ENOENT') throw new NoEndpoint(`secret_${e?.code ?? 'unreadable'}`) }
    if (secret && secret.length !== 32) throw new NoEndpoint('secret_invalid')
    const socket = createConnection(socketPath)
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => { socket.destroy(); rej(new NoEndpoint('connect_timeout')) }, timeoutMs)
      socket.once('connect', () => { clearTimeout(t); res() })
      socket.once('error', (e: any) => { clearTimeout(t); rej(new NoEndpoint(e?.code ?? 'connect_error')) })
    })
    if (secret) socket.write(secret)
    return new Conn(socket)
  }

  private onData(d: string) {
    this.buf += d
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1)
      let o: any
      try { o = JSON.parse(line) } catch { continue }
      if (o?.type === 'response' && typeof o.id === 'string' && this.pending.has(o.id)) {
        const p = this.pending.get(o.id)!; this.pending.delete(o.id); clearTimeout(p.timer); p.resolve(o)
      } else for (const l of this.listeners) l(o)
    }
  }

  onEvent(l: (ev: any) => void) { this.listeners.push(l) }

  request(command: Record<string, unknown>, timeoutMs: number): Promise<any> {
    if (this.closed) return Promise.reject(new TransportLost('closed'))
    const id = `dori_${++this.seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new TransportLost('timeout')) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.requestBytesWritten = true
      this.socket.write(`${JSON.stringify({ ...command, id })}\n`)
    })
  }

  close() { this.closed = true; this.socket.destroy() }
}

type Endpoint = { kind: Kind; socket: string }
const usable = (r: Routing | null) => !!r && r.protocolVersion === PROTOCOL_VERSION && r.commands.includes('steer')

export function createRpc(deps: RpcDeps) {
  const endpoints = (): Endpoint[] => {
    let dirs: string[]
    try { dirs = readdirSync(deps.endpointsRoot) } catch { return [] }
    const out: Endpoint[] = []
    for (const d of dirs) {
      try {
        const rec = JSON.parse(readFileSync(join(deps.endpointsRoot, d, 'endpoint.json'), 'utf8'))
        if ((rec.endpoint_kind === 'tui' || rec.endpoint_kind === 'rpc_host') && typeof rec.socket === 'string') out.push({ kind: rec.endpoint_kind, socket: rec.socket })
      } catch { continue }
    }
    return out
  }

  // Observing reads on a host never hold it open; a terminal does not take the field.
  const read = (kind: Kind, type: string, extra: Record<string, unknown> = {}) => (kind === 'rpc_host' ? { type, observe: true, ...extra } : { type, ...extra })

  type Probe = { routing: Routing; row: any }
  const probe = async (ep: Endpoint, durableId: string): Promise<Probe | null> => {
    let c: Conn | null = null
    try {
      c = await Conn.open(ep.socket, deps.probeTimeoutMs)
      const [info, list] = await Promise.all([
        c.request(read(ep.kind, 'get_protocol_info'), deps.probeTimeoutMs),
        c.request(read(ep.kind, 'list_sessions', { include_workers: true }), deps.probeTimeoutMs),
      ])
      const rows: any[] = list?.data?.sessions ?? []
      const row = rows.find((r) => (r.durableSessionId ?? r.sessionId) === durableId)
      if (!row || !info?.success) return null
      const d = info.data
      return { row, routing: { sessionId: row.sessionId, socket: ep.socket, kind: ep.kind, instanceId: d.instanceId ?? '', generation: d.generation ?? 0, protocolVersion: d.protocolVersion, commands: d.commands ?? [] } }
    } catch { return null } finally { c?.close() }
  }

  const findSessionFile = (durableId: string, cwd: string | null): string | null => {
    const suffix = `_${durableId}.jsonl`
    const inDir = (dir: string) => { try { const f = readdirSync(dir).find((x) => x.endsWith(suffix)); return f ? join(dir, f) : null } catch { return null } }
    if (cwd) { const hit = inDir(join(deps.sessionsRoot, sessionDirSlug(cwd))); if (hit) return hit }
    let dirs: string[] = []
    try { dirs = readdirSync(deps.sessionsRoot) } catch { return null }
    for (const d of dirs) { const hit = inDir(join(deps.sessionsRoot, d)); if (hit) return hit }
    return null
  }

  const holdersOf = (sessionPath: string | null, durableId: string, panePids: number[]): Holder[] => {
    if (!sessionPath) return []
    const dir = join(dirname(sessionPath), 'session-holders', durableId)
    let files: string[] = []
    try { files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)) } catch { return [] }
    return files.map((f) => {
      const pid = Number(f.replace('.json', ''))
      let alive = false
      try { process.kill(pid, 0); alive = true } catch (e: any) { alive = e?.code === 'EPERM' }
      return { pid, alive, inPane: panePids.includes(pid) }
    })
  }

  const parentOf = (row: any, sessionPath: string | null): string[] => {
    const ids = [row?.context?.parent_session_id, row?.context?.root_session_id, row?.parent_session_id, row?.root_session_id]
    if (sessionPath) {
      try {
        const head = JSON.parse(readFileSync(sessionPath, 'utf8').split('\n', 1)[0]!)
        if (typeof head.parentSession === 'string') ids.push(head.parentSession.match(/[0-9a-f-]{36}/)?.[0] ?? head.parentSession)
      } catch { return ids.filter((x): x is string => typeof x === 'string') }
    }
    return ids.filter((x): x is string => typeof x === 'string')
  }

  const local = (target: string) => {
    const map = deps.loadMap()
    const entry = map[target] ?? Object.values(map).find((e) => e.sessionId === target)
    if (!entry && !/^[0-9a-f-]{8,}$/i.test(target)) throw new Error(`unknown target ${target}`)
    const managed: Managed | null = entry ? (isLeadKey(entry.key) ? 'lead' : entry.status === 'open' ? 'lane' : 'unmanaged') : null
    return { map, entry, durableId: entry?.sessionId ?? target, managed }
  }

  async function resolve(target: string): Promise<Resolved> {
    const { map, entry, durableId } = local(target)
    const key = entry?.key ?? null
    const probes = await Promise.all(endpoints().map((ep) => probe(ep, durableId)))
    const hit = probes.find((p) => p !== null) ?? null
    const routing = hit?.routing ?? null
    const sessionPath = hit?.row?.sessionPath ?? hit?.row?.session_file ?? findSessionFile(durableId, entry?.cwd ?? hit?.row?.cwd ?? null)
    let managed: Managed = 'unmanaged'
    if (entry) managed = isLeadKey(entry.key) ? 'lead' : entry.status === 'open' ? 'lane' : 'unmanaged'
    else {
      const lanes = new Set(Object.values(map).filter((e) => e.status === 'open' && !isLeadKey(e.key)).map((e) => e.sessionId))
      if (parentOf(hit?.row, sessionPath).some((p) => lanes.has(p))) managed = 'child'
      else if (childOfLane(durableId, lanes)) managed = 'child'
    }
    const pane = entry?.pane ?? null
    const procs = pane ? await deps.paneProcs(pane).catch(() => [] as Proc[]) : []
    const panePids = procs.map((p: any) => Number(p.pid)).filter((n) => Number.isFinite(n))
    const fallback = !usable(routing) && pane && isOmoProcess(procs) ? 'herdr' : null
    return {
      key, durableId, sessionPath, pane, cwd: entry?.cwd ?? hit?.row?.cwd ?? null, routing,
      ...(routing ? {} : { routingError: 'no_endpoint' }),
      holders: holdersOf(sessionPath, durableId, panePids), managed, fallback,
    }
  }

  const snapshot = () => (deps.laneStatus ?? readLaneStatus)()
  /** The supervisor lists every observed child session of a lane under lanes[key].childrenIds. */
  const childOfLane = (durableId: string, laneIds: Set<string>) => {
    const lanes = snapshot()?.lanes ?? {}
    return Object.values(lanes).some((l: any) => laneIds.has(l?.durableId) && Array.isArray(l?.childrenIds) && l.childrenIds.includes(durableId))
  }

  /**
   * Lane status from the supervisor snapshot. Fail closed: no snapshot, a stale one, a lane missing from it, or a snapshot
   * without children (flags/supervisor.no-children) all make children.state 'unknown', and unknown is never settled.
   * herdr agent_status 'working' only ever turns settled false (in-process work RPC cannot see).
   */
  async function status(target: string, opts: { herdr?: boolean } = {}) {
    const { entry, durableId, managed } = local(target)
    const snap = snapshot()
    const key = entry?.key ?? null
    const lanes: Record<string, any> = snap?.lanes ?? {}
    const row = (key && lanes[key]?.durableId === durableId ? lanes[key] : Object.values(lanes).find((l: any) => l?.durableId === durableId)) ?? null
    const at = typeof snap?.at === 'string' ? Date.parse(snap.at) : NaN
    const ageMs = Number.isFinite(at) ? Date.now() - at : null
    const reasons: string[] = []
    if (!snap) reasons.push('no_snapshot')
    else if (ageMs === null || ageMs > (deps.statusStaleMs ?? 90_000)) reasons.push('snapshot_stale')
    if (snap && !row) reasons.push('lane_not_in_snapshot')
    if (row && !row.children) reasons.push('children_not_observed')
    const c = row?.children
    const children = c && reasons.length === 0 ? c : {
      state: 'unknown' as const, running: c?.running ?? 0, done: c?.done ?? 0, failed: c?.failed ?? 0, dagRuns: c?.dagRuns ?? [],
      reasons: [...(c?.reasons ?? []), ...reasons],
    }
    const pane: string | null = row?.pane ?? entry?.pane ?? null
    const herdr = opts.herdr !== false && pane && deps.agentStatus ? await deps.agentStatus(pane).catch(() => null) : null
    const settled = !!row && row.settled === true && children.state === 'known' && children.running === 0
      && !children.dagRuns.some((r: any) => r.status === 'running') && herdr !== 'working'
    return {
      key, durableId, managed, status: row?.status ?? 'unknown', settled, children, childrenIds: row?.childrenIds ?? [],
      herdr, snapshotAt: snap?.at ?? null, ageMs,
    }
  }

  async function children(target: string) {
    const s = await status(target, { herdr: false })
    return { key: s.key, durableId: s.durableId, ...s.children, childrenIds: s.childrenIds, settled: s.settled, snapshotAt: s.snapshotAt }
  }

  async function withEndpoint<T>(target: string, fn: (c: Conn, r: Resolved) => Promise<T>): Promise<T> {
    const r = await resolve(target)
    if (!r.routing) throw new NoEndpoint('not_found')
    const c = await Conn.open(r.routing.socket, deps.probeTimeoutMs)
    try { return await fn(c, r) } finally { c.close() }
  }

  async function protocol(target: string) {
    return withEndpoint(target, async (c, r) => {
      const info = await c.request(read(r.routing!.kind, 'get_protocol_info'), deps.requestTimeoutMs)
      return { key: r.key, durableId: r.durableId, kind: r.routing!.kind, ...info.data }
    })
  }

  async function state(target: string) {
    return withEndpoint(target, async (c, r) => {
      const res = await c.request(read(r.routing!.kind, 'get_state', r.routing!.kind === 'rpc_host' ? { sessionId: r.routing!.sessionId } : {}), deps.requestTimeoutMs)
      if (!res.success) throw new Error(`get_state refused: ${res.errorCode ?? res.error}`)
      const d = res.data
      return {
        key: r.key, durableId: r.durableId, isStreaming: d.isStreaming, turn_epoch: d.turn_epoch, blocking_question: d.blocking_question ?? null,
        editor_has_draft: d.editor_has_draft ?? null, compacting: d.compacting ?? d.isCompacting ?? null,
        model: d.model ? `${d.model.provider}/${d.model.id}` : null, messageCount: d.messageCount, pendingMessageCount: d.pendingMessageCount,
        sessionFile: d.sessionFile,
      }
    })
  }

  /** Resolves on the endpoint's `completion` event (or at once when get_state already says idle). */
  async function wait(target: string, until: 'idle', timeoutMs: number) {
    return withEndpoint(target, (c, r) => new Promise<any>((res, rej) => {
      const t0 = Date.now()
      const timer = setTimeout(() => res({ key: r.key, until, status: 'timeout', waitedMs: Date.now() - t0 }), timeoutMs)
      c.onEvent((ev) => {
        if (ev?.type === 'session_control_event' && ev.kind === 'completion') {
          clearTimeout(timer); res({ key: r.key, until, status: 'idle', via: 'completion', seq: ev.seq, turn_epoch: ev.data?.turn_epoch, waitedMs: Date.now() - t0 })
        }
      })
      c.request({ type: 'subscribe' }, deps.requestTimeoutMs)
        .then(() => c.request({ type: 'get_state' }, deps.requestTimeoutMs))
        .then((s) => { if (s?.success && s.data?.isStreaming === false) { clearTimeout(timer); res({ key: r.key, until, status: 'idle', via: 'state', waitedMs: Date.now() - t0 }) } })
        .catch((e) => { clearTimeout(timer); rej(e) })
    }))
  }

  /**
   * Settle the lane's newest ask_user_question / request_user_input over `extension_ui_response` (requestId = the tool call id,
   * question ids q1.. for the claude variant). The endpoint's own pending map is the authority: `unknown_request` means nothing is
   * pending. A TUI endpoint settles only async (waitForAnswer:false) questions; a blocking one lives in the overlay, outside that
   * map, so it is refused here instead of sent. Cleared = the feed's `question` event (TUI) or get_state.pendingQuestions (host).
   */
  async function answer(target: string, opts: { option?: string; text?: string; questionId?: string }) {
    return withEndpoint(target, async (c, r) => {
      const kind = r.routing!.kind
      const scope = kind === 'rpc_host' ? { sessionId: r.routing!.sessionId } : {}
      const out = (status: 'answered' | 'refused' | 'unconfirmed', more: Record<string, unknown>) => ({ key: r.key, durableId: r.durableId, status, ...more })
      const st = await c.request(read(kind, 'get_state', scope), deps.requestTimeoutMs)
      if (!st.success) throw new Error(`get_state refused: ${st.errorCode ?? st.error}`)
      const msgs = await c.request(read(kind, 'get_messages', scope), deps.requestTimeoutMs)
      const call = (msgs.data?.messages ?? []).flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
        .filter((p: any) => p?.type === 'toolCall' && (p.name === 'ask_user_question' || p.name === 'request_user_input')).at(-1)
      if (!call) return out('refused', { reason: 'no_pending_question' })
      const requestId: string = call.id
      if (opts.questionId && opts.questionId !== requestId) return out('refused', { reason: 'question_id_mismatch', requestId })
      if (st.data.blocking_question === true && call.arguments?.waitForAnswer !== false) return out('refused', { reason: 'blocking_question_unsupported', requestId })
      const q = call.arguments?.questions?.[0]
      const questionId: string = call.name === 'ask_user_question' ? 'q1' : q?.id
      const labels: string[] = (q?.options ?? []).map((o: any) => o.label)
      if (opts.option !== undefined && !labels.includes(opts.option)) return out('refused', { reason: 'unknown_option', requestId, options: labels })
      const answers = { [questionId]: opts.option !== undefined ? { selected: [opts.option] } : { selected: [], text: opts.text } }
      // finish() publishes the remaining pending ids before the reply is written, so listen first.
      const cleared = new Promise<boolean>((res) => {
        if (kind !== 'tui') return res(false)
        const timer = setTimeout(() => res(false), deps.requestTimeoutMs)
        c.onEvent((ev) => {
          if (ev?.type === 'session_control_event' && ev.kind === 'question' && Array.isArray(ev.data?.pending) && !ev.data.pending.includes(requestId)) { clearTimeout(timer); res(true) }
        })
      })
      if (kind === 'tui') await c.request({ type: 'subscribe' }, deps.requestTimeoutMs)
      const res = await c.request({ type: 'extension_ui_response', uiRequestId: requestId, answers, ...scope }, deps.requestTimeoutMs)
      if (!res.success) {
        const e = String(res.errorCode ?? res.error)
        return out('refused', { reason: e === 'unknown_request' || e === 'unknown_extension_ui_request' ? 'no_pending_question' : e, requestId })
      }
      const after = await c.request(read(kind, 'get_state', scope), deps.requestTimeoutMs)
      const ok = kind === 'tui' ? await cleared : !(after.data?.pendingQuestions ?? []).some((f: any) => f?.requestId === requestId)
      return out(ok ? 'answered' : 'unconfirmed', { requestId, questionId, answer: answers[questionId], cleared: ok, blocking_question: after.data?.blocking_question ?? null })
    })
  }

  async function send(target: string, text: string, opts: { id: string; mode?: 'steer' | 'follow_up' | 'prompt'; childOk?: boolean; plan?: boolean }): Promise<Delivery> {
    const id = opts.id
    const l = local(target)
    if (l.managed === 'lane') {
      const path = findSessionFile(l.durableId, l.entry?.cwd ?? null)
      if (receipt(path, id) === 'persisted') return { status: 'delivered', id, transport: 'rpc', disposition: 'already_persisted', sentTo: { durableId: l.durableId, sessionPath: path, instanceId: null } }
    }
    const r = await resolve(target)
    const sentTo: SentTo = { durableId: r.durableId, sessionPath: r.sessionPath, instanceId: r.routing?.instanceId ?? null }
    const out = (status: Delivery['status'], more: Partial<Delivery> = {}): Delivery => ({ status, id, transport: 'rpc', sentTo, ...more })
    const refuse = (reason: string, fallback: 'herdr' | null = null) => out('refused', { reason, fallback })
    if (r.managed === 'lead' || r.managed === 'unmanaged') return refuse('unmanaged_target')
    if (r.managed === 'child' && !opts.childOk) return refuse('child_target')
    if (/^\s*\//.test(text)) return refuse('invalid_target_text')
    // --plan: every refusal above applies; nothing is written to any endpoint.
    if (opts.plan) return out('planned', r.routing ? {} : { reason: 'no_endpoint' })
    // Rule 1: the disk receipt answers before any retry; a persisted id is never sent again.
    if (receipt(r.sessionPath, id) === 'persisted') return out('delivered', { disposition: 'already_persisted' })
    const paneFallback = r.fallback ?? (r.pane && isOmoProcess(await deps.paneProcs(r.pane).catch(() => [] as Proc[])) ? 'herdr' : null)
    if (!r.routing) return refuse('no_endpoint', paneFallback)
    if (!usable(r.routing)) return refuse('no_endpoint', paneFallback)

    let c: Conn
    try { c = await Conn.open(r.routing.socket, deps.probeTimeoutMs) } catch { return refuse('no_endpoint', paneFallback) }
    try {
      // Handshake check: an endpoint that drops us here never saw a request it could act on.
      let info: any
      try { info = await c.request(read(r.routing.kind, 'get_protocol_info'), deps.probeTimeoutMs) } catch { return refuse('no_endpoint', paneFallback) }
      const d = info?.data ?? {}
      if (!info?.success || d.protocolVersion !== PROTOCOL_VERSION || !(d.commands ?? []).includes('steer')) return refuse('no_endpoint', paneFallback)
      sentTo.instanceId = d.instanceId ?? sentTo.instanceId
      const type = opts.mode ?? 'steer'
      const frame: Record<string, unknown> = { type, message: tagMessage(text, id), clientMessageId: id }
      if (type !== 'prompt') frame.whenIdle = 'start'
      if (r.routing.kind === 'rpc_host') frame.sessionId = r.routing.sessionId
      let res: any
      try { res = await c.request(frame, deps.requestTimeoutMs) } catch (e: any) { return out('uncertain', { reason: `transport_lost_after_write:${e?.code ?? 'unknown'}` }) }
      if (!res.success) return refuse(res.errorCode ?? 'refused')
      const disposition = res.data?.duplicate ? 'duplicate' : String(res.data?.disposition ?? 'queued')
      if (!['started', 'queued', 'steered', 'duplicate'].includes(disposition)) return out('uncertain', { disposition, reason: 'unknown_disposition' })
      // Accepted is not evidence: only the persisted entry is.
      for (let waited = 0; waited < deps.receiptWaitMs; waited += deps.receiptPollMs) {
        if (receipt(r.sessionPath, id) === 'persisted') return out('delivered', { disposition })
        await Bun.sleep(deps.receiptPollMs)
      }
      if (receipt(r.sessionPath, id) === 'persisted') return out('delivered', { disposition })
      return deps.receiptWaitMs > 0 ? out('uncertain', { disposition, reason: 'no_receipt' }) : out('accepted', { disposition })
    } finally { c.close() }
  }

  /**
   * One logical message on one transport: rpc when the key is on the allowlist, herdr otherwise.
   * The herdr path runs after rpc only for refused(no_endpoint) with fallback 'herdr' (no request byte sent).
   */
  async function dispatch(
    entry: MapEntry & { pane: string; cwd: string }, text: string,
    opts: { id: string; mode?: 'steer' | 'follow_up' | 'prompt'; childOk?: boolean; transport: 'rpc' | 'herdr' },
    herdr: HerdrDeps,
  ): Promise<Delivery | (DeliverResult & { transport: 'herdr'; rpcRefused?: string })> {
    const viaHerdr = async (rpcRefused?: string) => ({ ...(await deliver(herdr, entry, text, { id: opts.id })), transport: 'herdr' as const, ...(rpcRefused ? { rpcRefused } : {}) })
    if (opts.transport === 'herdr') return viaHerdr()
    const d = await send(entry.key, text, opts)
    if (d.status === 'refused' && d.reason === 'no_endpoint' && d.fallback === 'herdr') return viaHerdr('no_endpoint')
    return d
  }

  return { resolve, protocol, state, status, children, wait, answer, send, dispatch, receipt }
}

export const TRANSPORT_FILE = `${doriHome()}/transport.json`
export function transportFor(key: string, file = TRANSPORT_FILE): 'rpc' | 'herdr' {
  try {
    const t = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(t.rpc) && t.rpc.includes(key)) return 'rpc'
    return t.default === 'rpc' ? 'rpc' : 'herdr'
  } catch { return 'herdr' }
}

const herdrJson = async (args: string[]) => {
  const p = Bun.spawn(['herdr', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  if (code !== 0) throw new Error(`herdr ${args.slice(0, 2).join(' ')} failed`)
  return JSON.parse(out)
}

export const liveRpcDeps: RpcDeps = {
  endpointsRoot: `${HOME}/.omo/agent/rpc-host-daemon`,
  sessionsRoot: sessionRoot(),
  loadMap: () => (existsSync(`${doriHome()}/sessions-map.json`) ? JSON.parse(readFileSync(`${doriHome()}/sessions-map.json`, 'utf8')) : {}),
  paneProcs: async (pane) => (await herdrJson(['pane', 'process-info', '--pane', pane])).result.process_info.foreground_processes,
  probeTimeoutMs: 1500,
  requestTimeoutMs: 15_000,
  receiptWaitMs: 45_000,
  receiptPollMs: 300,
  laneStatus: () => readLaneStatus(),
  agentStatus: async (pane) => {
    const agents: any[] = (await herdrJson(['agent', 'list'])).result?.agents ?? []
    return agents.find((a) => a.pane_id === pane)?.agent_status ?? 'none'
  },
}

export const rpc = createRpc(liveRpcDeps)

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const flag = (name: string) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v }
  const bool = (name: string) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true }
  bool('--json')
  const until = flag('--until') ?? 'idle'
  const timeout = Number(flag('--timeout') ?? '120')
  const explicitId = flag('--id')
  const id = explicitId ?? crypto.randomUUID()
  const mode = flag('--mode') as 'steer' | 'follow_up' | 'prompt' | undefined
  const childOk = bool('--child-ok')
  const plan = bool('--plan')
  const option = flag('--option')
  const text = flag('--text')
  const questionId = flag('--question-id')
  const [cmd, target, ...rest] = argv
  const print = (o: unknown) => console.log(JSON.stringify(o))
  try {
    switch (cmd) {
      case 'resolve': print(await rpc.resolve(target!)); break
      case 'protocol': print(await rpc.protocol(target!)); break
      case 'state': print(await rpc.state(target!)); break
      case 'status': print(await rpc.status(target!)); break
      case 'children': print(await rpc.children(target!)); break
      case 'receipt': { const r = await rpc.resolve(target!); print({ key: r.key, id: rest[0], sessionPath: r.sessionPath, receipt: receipt(r.sessionPath, rest[0]!) }); break }
      case 'answer': {
        if ((option === undefined) === (text === undefined)) { console.error('usage: rpc.ts answer <target> --option <label>|--text <text> [--question-id <id>]'); process.exitCode = 2; break }
        const a = await rpc.answer(target!, { option, text, questionId })
        print(a); process.exitCode = a.status === 'answered' ? 0 : a.status === 'refused' ? 2 : 3
        break
      }
      case 'wait': { const w = await rpc.wait(target!, until as 'idle', timeout * 1000); print(w); if (w.status !== 'idle') process.exitCode = 1; break }
      case 'send': {
        // 10-24: a retry used an id copied from a truncated print, so it became a new delivery that no record matched.
        // A same-id retry must name an id this CLI or sess.ts already recorded as uncertain/refused.
        if (explicitId !== undefined) {
          const { paths } = await import('./registry')
          let log = ''
          try { log = readFileSync(`${paths().home}/events/supervisor.ndjson`, 'utf8') } catch {}
          if (!log.includes(`"delivery.uncertain:${explicitId}"`) && !log.includes(`"delivery.refused:${explicitId}"`)) {
            console.error(`--id ${explicitId}: no uncertain/refused delivery with this exact id (truncated copy?); refusing`)
            process.exitCode = 2
            break
          }
        }
        const d = await rpc.send(target!, rest.join(' '), { id, mode, childOk, plan })
        print(d); process.exitCode = d.status === 'delivered' || d.status === 'planned' ? 0 : d.status === 'refused' ? 4 : 3
        // Direct CLI sends get the same delivery.* event as sess.ts sendTo, so the router digest sees every lead input.
        if (d.status !== 'planned') {
          const kind = d.status === 'delivered' ? 'delivery.persisted' : d.status === 'refused' ? 'delivery.refused' : 'delivery.uncertain'
          try {
            const [{ appendSupEvent }, { paths }] = await Promise.all([import('./dori-supervisor'), import('./registry')])
            appendSupEvent(paths().home, { id: `${kind}:${d.id}`, kind, severity: kind === 'delivery.persisted' ? 'info' : 'act', lane: target!, data: { id: d.id, transport: (d as any).transport, via: 'rpc-cli', ...((d as any).reason ? { reason: (d as any).reason } : {}) } })
          } catch (err) { console.error(`delivery event not written: ${(err as Error).message}`) }
        }
        break
      }
      default: console.error('usage: rpc.ts resolve|protocol|state|status|children|receipt|wait|send|answer <target> ...'); process.exitCode = 2
    }
  } catch (e: any) {
    print({ error: e?.message ?? String(e) }); process.exitCode = 1
  }
}
