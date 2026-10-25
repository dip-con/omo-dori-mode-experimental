// dori supervisor (redesign S4 observation + S9 policies). The observer never
// acts by itself; the S9 policies below (quota transition, session_replaced adopt, nudge, reap EMPTY_TAB) act only for
// lanes a flag file enables, and record every act in the ops ledger DORI_HOME/ops/policy/<opId>.json
// (planned -> attempted -> verified | failed | ambiguous, with read-back; ambiguous is never retried, it asks).
// Policy flags (DORI_HOME/flags/): supervisor.no-policies = kill switch (observe only); policies.on = every policy, every lane;
// policy.<quota|adopt|nudge|reap> = that policy for the keys listed in the file (empty file = every lane).
// Without a flag a policy proposes only: quota/nudge/reap proposals stay with the legacy sweeps (LANE_QUOTA, NO-NUDGE,
// LANE_EMPTY_TAB); adopt (no legacy proposer) emits policy.adopt_proposal (ask). Quota acts only with the per-episode
// approval flags/auto-migrate.<key> whose content is the episode id (an empty file binds to the next episode).
//   bun dori-supervisor.ts --adopt <key> --session <durableId>   run the adopt (rebind + seed + receipt) by hand
// One socket per reachable endpoint: get_protocol_info + subscribe_sessions {include_workers, include_context, effects}
// (+ tui `subscribe {cursor}` feed). Lane state machine: opening/idle/running/waiting_input/compacting -> offline on
// transport_gone (or not hosted) -> gone after two registry rescans >= 20 s apart with neither endpoint nor pane.
// lane.turn_done is emitted once on the transition to settled (idle, children known and 0 running, no running DAG run)
// with id lane.turn_done:<durableId>:<instanceId>:<turn_epoch>. Children (S5): session_status rows whose
// context.parent_session_id/root_session_id is the lane (worker rows exist only because include_workers is sent), the
// senpi task store (in-process subagents RPC cannot see) and herdr-dag runs. children.state is 'unknown' before the first
// census, while a host is unreachable/disconnected or reports workers hidden, and when a running DAG file is > 10 min
// old; unknown is never settled. flags/supervisor.no-children: snapshot omits children and settled = status==='idle'.
// Restart boundary: state/supervisor.json keeps the last
// (instanceId, epoch) per lane; a snapshot converges without side effects and only a newer turn is emitted.
//   bun dori-supervisor.ts --once [--json]     one census, print the lane-status snapshot, write nothing
//   bun dori-supervisor.ts                     daemon (launchd); runs only while flags/supervisor.observe exists
// Files (under OMODORI_HOME, default ~/.omodori): events/supervisor.ndjson, state/supervisor.json, lane-status.json.
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CLAUDE_ACCOUNTS } from './lane-classify'
import { accountCheck, accountHeadroom, isClaudeModel, pickAccount, switchBackStep } from './policy-lib'
import {
  acquireDirLock, addLineage, type Entry, doriHome, patchLane, readMap, RegistryError, updateDoriLane, withLaneLease, type LaneMap,
} from './registry'
import { isLeadKey, homeRef } from './config'
import {
  type DagFile, type Endpoint, type EndpointKind, type HostStatusRow, type Link, type OpenLink, SUBSCRIBE_SESSIONS,
  hostStatus, openSocketLink, panesAlive, readDagRuns, scanEndpoints,
} from './supervisor-sources'

export const supPaths = (home = doriHome()) => ({
  events: join(home, 'events', 'supervisor.ndjson'),
  state: join(home, 'state', 'supervisor.json'),
  lock: join(home, 'state', 'supervisor.lock'),
  laneStatus: join(home, 'lane-status.json'),
  observeFlag: join(home, 'flags', 'supervisor.observe'),
  noChildrenFlag: join(home, 'flags', 'supervisor.no-children'),
})

export const GONE_RESCANS = 2
export const GONE_MISS_GAP_MS = 20_000
export const DAG_STALE_MS = 10 * 60_000
/** Task store / DAG files are re-read at most this often outside a rescan (a lane going idle re-checks them). */
export const LOCAL_TTL_MS = 2_000
const BUSY = new Set(['opening', 'running', 'waiting_input', 'compacting'])

export type LaneStatus = 'opening' | 'idle' | 'running' | 'waiting_input' | 'compacting' | 'offline' | 'gone' | 'unknown'
export type Children = {
  state: 'known' | 'unknown'; running: number; done: number; failed: number; dagRuns: { id: string; status: string; nodes: number }[]
  /** Why the state is unknown (absent when known). */
  reasons?: string[]
}
/** One senpi task record (`<store>/st_*.json`); parent/root are durable session ids. */
export type TaskRec = { id: string; status: string; parent: string | null; root: string | null; childSessionId: string | null; updatedAt: string }
export type SupEvent = {
  v: 2; at: string; id: string; kind: string; severity: 'info' | 'act' | 'ask'
  lane: string; durableId: string; generation: number; pane: string | null; thread: string | null
  source: 'supervisor'; data: Record<string, unknown>
}
type Row = {
  sessionId: string; durableSessionId?: string; sessionPath?: string; status: string; kind?: string; cwd?: string; name?: string
  context?: Record<string, unknown> | null; model?: { provider?: string; id?: string } | null
}
type Host = {
  socket: string; kind: EndpointKind; state: 'up' | 'dead' | 'unreachable' | 'connecting'; code?: string
  link: Link | null; instanceId: string | null; generation: number | null; rows: Map<string, Row>
  cursor?: number; superseding?: boolean
  /** The subscribe answer said worker rows are not included: children on this host cannot be counted. */
  workersHidden?: boolean
}
type Lane = {
  key: string; durableId: string; generation: number; pane: string | null; thread: string | null; quiet: boolean; cwd: string | null
  status: LaneStatus; host: string | null; instanceId: string | null; epoch: number | null
  blocking_question: boolean | null; editor_has_draft: boolean | null; model: string | null
  tab: string | null
  turnPending: boolean; misses: number; lastMissAt: number | null; lastWriteAt: string | null
  /** The registry closed the key (sess.ts close) while the session was live: tracked until gone, never in `.lanes`. */
  closing: boolean
}
type Persist = {
  v: 1; lanes: Record<string, { key: string; instanceId: string; epoch: number; at: string }>; cursors: Record<string, { instanceId: string; cursor: number }>
  /** Last durable id per lane key: a reconcile-* rebind seen after a restart is still a session replacement. */
  laneIds?: Record<string, { durableId: string; generation: number }>
  policy?: PolicyState
}
export type Replacement = { key: string; from: string; to: string; via: 'registry' | 'endpoint'; at: number }

export type SupDeps = {
  home: string
  now: () => number
  openLink: OpenLink
  scanEndpoints: () => Endpoint[]
  hostStatus: () => Promise<HostStatusRow[] | null>
  panesAlive: () => Promise<Set<string> | null>
  dagRuns: () => Map<string, DagFile>
  /** Task records from every store (global + each lane cwd); a missing store is just empty. */
  taskRecords: (cwds: string[]) => TaskRec[]
  loadMap: () => LaneMap
  connectTimeoutMs: number
  requestTimeoutMs: number
  /** false for --once: nothing is appended, persisted or snapshotted. */
  write: boolean
  log: (line: string) => void
}

const readJson = <T>(p: string, dflt: T): T => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return dflt } }
const atomicWrite = (p: string, body: string) => {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
  const tmp = `${p}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, p)
}
const mapStatus = (s: string): LaneStatus =>
  s === 'opening' || s === 'idle' || s === 'running' || s === 'waiting_input' || s === 'compacting' ? s : s === 'unloaded' || s === 'closed' ? 'offline' : 'unknown'
const lineageOf = (r: Row) => [r.context?.parent_session_id, r.context?.root_session_id].filter((x): x is string => typeof x === 'string')
const TASK_DONE = new Set(['completed', 'succeeded', 'done', 'cancelled', 'canceled'])
const TASK_FAILED = new Set(['failed', 'error', 'errored', 'timeout', 'timed_out', 'lost'])

/**
 * Senpi task records. The store moved between runtime versions: `~/.omo/senpi-task/tasks/*.json`,
 * `~/.omo/agent/projects/<project>/senpi-task/tasks/*.json` (current runtime: a lane's subagents land here),
 * `<cwd>/.omo/senpi-task/tasks/*.json` and `~/.omo/senpi-task/children/<st_id>/*.json` are all read; absence is tolerated.
 * The newest record (updated_at) per task id wins.
 */
export function readTaskRecords(cwds: string[], home = process.env.HOME!): TaskRec[] {
  const root = join(home, '.omo', 'senpi-task')
  const files: string[] = []
  const jsonIn = (dir: string) => { try { for (const f of readdirSync(dir)) if (f.endsWith('.json')) files.push(join(dir, f)) } catch { /* absent store */ } }
  jsonIn(join(root, 'tasks'))
  const projects = join(home, '.omo', 'agent', 'projects')
  try { for (const p of readdirSync(projects)) jsonIn(join(projects, p, 'senpi-task', 'tasks')) } catch { /* absent store */ }
  for (const c of cwds) jsonIn(join(c, '.omo', 'senpi-task', 'tasks'))
  try { for (const d of readdirSync(join(root, 'children'))) if (d.startsWith('st_')) jsonIn(join(root, 'children', d)) } catch { /* absent store */ }
  const out = new Map<string, TaskRec>()
  for (const f of files) {
    let o: any
    try { o = JSON.parse(readFileSync(f, 'utf8')) } catch { continue }
    const id = o?.task_id ?? o?.id
    if (typeof id !== 'string' || typeof o.status !== 'string') continue
    const rec: TaskRec = {
      id, status: o.status, parent: o.parent_session_id ?? null, root: o.root_session_id ?? null,
      childSessionId: typeof o.child_session_id === 'string' ? o.child_session_id : null, updatedAt: String(o.updated_at ?? ''),
    }
    const prev = out.get(id)
    if (!prev || rec.updatedAt >= prev.updatedAt) out.set(id, rec)
  }
  return [...out.values()]
}

export class Supervisor {
  hosts = new Map<string, Host>()
  lanes = new Map<string, Lane>()
  persist: Persist
  emittedIds = new Set<string>()
  emitted: SupEvent[] = []
  censusDone = false
  private inflight = new Set<Promise<unknown>>()
  private dag = new Map<string, DagFile>()
  private tasks: TaskRec[] = []
  private localAt = Number.NEGATIVE_INFINITY
  /** flags/supervisor.no-children (rollback switch). */
  noChildren = false
  private persistDirty = false

  constructor(readonly deps: SupDeps) {
    const p = supPaths(deps.home)
    this.persist = readJson<Persist>(p.state, { v: 1, lanes: {}, cursors: {} })
    this.persist.lanes ??= {}
    this.persist.cursors ??= {}
    if (deps.write && existsSync(p.events)) {
      for (const l of readFileSync(p.events, 'utf8').split('\n')) {
        const m = /"id":"([^"]+)"/.exec(l)
        if (m) this.emittedIds.add(m[1]!)
      }
    }
  }

  /** Resolves once every async step triggered so far (get_state after a transition, resubscribes) has settled. */
  async flush() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight])
  }
  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p)
    p.finally(() => this.inflight.delete(p)).catch(() => {})
    return p
  }

  syncLanes() {
    const map = this.deps.loadMap()
    const seen = new Set<string>()
    for (const e of Object.values(map)) {
      if (e.status !== 'open' || isLeadKey(e.key)) continue
      seen.add(e.key)
      const cur = this.lanes.get(e.key)
      const prevId = cur?.durableId ?? this.persist.laneIds?.[e.key]?.durableId
      if (prevId && prevId !== e.sessionId && /^reconcile/.test(String(e.sessionVia ?? ''))) this.noteReplaced(e.key, prevId, e.sessionId, 'registry')
      const known = this.persist.laneIds?.[e.key]
      if (!known || known.durableId !== e.sessionId || known.generation !== (e.generation ?? 0)) {
        (this.persist.laneIds ??= {})[e.key] = { durableId: e.sessionId, generation: e.generation ?? 0 }
        this.persistDirty = true
      }
      if (cur && cur.durableId === e.sessionId) {
        Object.assign(cur, { generation: e.generation ?? 0, pane: e.pane ?? null, tab: e.tab ?? null, thread: e.thread ?? null, quiet: e.quiet === true, cwd: e.cwd ?? null, closing: false })
        continue
      }
      this.lanes.set(e.key, {
        key: e.key, durableId: e.sessionId, generation: e.generation ?? 0, pane: e.pane ?? null, tab: e.tab ?? null, thread: e.thread ?? null, quiet: e.quiet === true, cwd: e.cwd ?? null,
        status: 'unknown', host: typeof e.endpoint?.socket === 'string' ? e.endpoint.socket : null, instanceId: null, epoch: null, blocking_question: null, editor_has_draft: null, model: null,
        turnPending: false, misses: 0, lastMissAt: null, lastWriteAt: null, closing: false,
      })
    }
    for (const [k, l] of [...this.lanes]) {
      if (seen.has(k)) continue
      if (l.status === 'gone' || l.instanceId === null) this.lanes.delete(k)
      else l.closing = true
    }
  }
  /** Session replacements seen (registry rebind with sessionVia reconcile-*, or the lane's tui endpoint now hosting another
   *  durable id); emitted once as lane.session_replaced and consumed by the adopt policy. */
  replaced = new Map<string, Replacement>()
  noteReplaced(key: string, from: string, to: string, via: Replacement['via']) {
    const id = `${key}:${to}`
    if (this.replaced.has(id)) return
    const rep = { key, from, to, via, at: this.deps.now() }
    this.replaced.set(id, rep)
    const pol = (this.persist.policy ??= emptyPolicyState())
    if (!pol.handledReplacements.includes(id)) { pol.pendingReplacements[id] = rep; this.persistDirty = true }
    const lane = this.lanes.get(key)
    this.emitFor(key, 'lane.session_replaced', id, 'act', { from, to, via }, lane)
  }
  /** emit() for a key that may have no tracked lane object (policy events). */
  emitFor(key: string, kind: string, idTail: string, severity: SupEvent['severity'], data: Record<string, unknown>, lane = this.lanes.get(key)): boolean {
    const stub = lane ?? ({ key, durableId: (data.to as string) ?? '', generation: 0, pane: null, thread: null } as unknown as Lane)
    return this.emit(stub, kind, idTail, severity, data)
  }

  private laneByDurable(id: string | undefined) {
    if (!id) return undefined
    for (const l of this.lanes.values()) if (l.durableId === id) return l
    return undefined
  }

  emit(lane: Lane, kind: string, idTail: string, severity: SupEvent['severity'], data: Record<string, unknown> = {}): boolean {
    const id = `${kind}:${idTail}`
    if (this.emittedIds.has(id)) return false
    this.emittedIds.add(id)
    const ev: SupEvent = {
      v: 2, at: new Date(this.deps.now()).toISOString(), id, kind, severity, lane: lane.key, durableId: lane.durableId,
      generation: lane.generation, pane: lane.pane, thread: lane.thread, source: 'supervisor', data,
    }
    this.emitted.push(ev)
    if (this.deps.write) {
      const f = supPaths(this.deps.home).events
      mkdirSync(dirname(f), { recursive: true, mode: 0o700 })
      appendFileSync(f, `${JSON.stringify(ev)}\n`, { mode: 0o600 })
    }
    this.deps.log(`SUPERVISOR_EVENT ${kind} ${lane.key} ${id}`)
    return true
  }
  markDirty() { this.persistDirty = true }
  savePersist() {
    if (!this.deps.write || !this.persistDirty) return
    this.persistDirty = false
    atomicWrite(supPaths(this.deps.home).state, JSON.stringify(this.persist, null, 1))
  }

  /** Re-read the file sources (DAG runs, task store, rollback flag); `force` on a rescan, else at most every LOCAL_TTL_MS. */
  refreshLocal(force = false) {
    const now = this.deps.now()
    if (!force && now - this.localAt < LOCAL_TTL_MS) return
    this.localAt = now
    this.dag = this.deps.dagRuns()
    this.tasks = this.deps.taskRecords([...new Set([...this.lanes.values()].map((l) => l.cwd).filter((c): c is string => !!c))])
    this.noChildren = existsSync(supPaths(this.deps.home).noChildrenFlag)
  }

  private childRows(lane: Lane): Row[] {
    const out: Row[] = []
    for (const h of this.hosts.values()) for (const r of h.rows.values()) {
      if (r.durableSessionId !== lane.durableId && lineageOf(r).includes(lane.durableId)) out.push(r)
    }
    return out
  }
  private laneTasks(lane: Lane) {
    return this.tasks.filter((t) => t.parent === lane.durableId || t.root === lane.durableId)
  }
  /** Durable ids of the lane's child sessions (RPC rows + task records naming a child session). */
  childrenIds(lane: Lane): string[] {
    const ids = new Set<string>()
    for (const r of this.childRows(lane)) if (r.durableSessionId) ids.add(r.durableSessionId)
    for (const t of this.laneTasks(lane)) if (t.childSessionId) ids.add(t.childSessionId)
    return [...ids]
  }

  children(lane: Lane): Children {
    let running = 0, done = 0, failed = 0
    const seenTasks = new Set<string>(), seenSessions = new Set<string>()
    for (const r of this.childRows(lane)) {
      if (typeof r.context?.task_id === 'string') seenTasks.add(r.context.task_id)
      if (r.durableSessionId) seenSessions.add(r.durableSessionId)
      if (BUSY.has(r.status)) running++
      else if (r.status === 'idle' || r.status === 'unloaded' || r.status === 'closed') done++
      else failed++
    }
    // In-process subagents never show up as session rows: the task store is their only record. A live RPC row wins.
    for (const t of this.laneTasks(lane)) {
      if (seenTasks.has(t.id) || (t.childSessionId && seenSessions.has(t.childSessionId))) continue
      if (TASK_DONE.has(t.status)) done++
      else if (TASK_FAILED.has(t.status)) failed++
      else running++
    }
    const dag = this.dag.get(lane.durableId)
    const dagRuns = (dag?.runs ?? []).map((r) => ({ id: r.id, status: r.status, nodes: r.nodes.length }))
    const reasons: string[] = []
    if (!this.censusDone) reasons.push('census_incomplete')
    const laneHost = lane.host ? this.hosts.get(lane.host) : undefined
    const childHost = (h: Host) => h.kind === 'rpc_host' || h.socket === lane.host
    if ([...this.hosts.values()].some((h) => h.state === 'unreachable' && childHost(h))) reasons.push('host_unreachable')
    if ((laneHost !== undefined && laneHost.state !== 'up')
      || [...this.hosts.values()].some((h) => h.state === 'dead' && h.code?.startsWith('transport_gone') && childHost(h))) reasons.push('host_disconnected')
    if ([...this.hosts.values()].some((h) => h.state === 'up' && h.workersHidden && childHost(h))) reasons.push('workers_hidden')
    if (dag && dag.runs.some((r) => r.status === 'running') && this.deps.now() - dag.mtimeMs > DAG_STALE_MS) reasons.push('dag_stale')
    return reasons.length
      ? { state: 'unknown', running, done, failed, dagRuns, reasons }
      : { state: 'known', running, done, failed, dagRuns }
  }
  settled(lane: Lane) {
    if (this.noChildren) return lane.status === 'idle'
    const c = this.children(lane)
    return lane.status === 'idle' && c.state === 'known' && c.running === 0 && !c.dagRuns.some((r) => r.status === 'running')
  }

  /** Emits lane.turn_done when the lane is settled and its (instanceId, epoch) is newer than the persisted one. */
  private maybeTurnDone(lane: Lane) {
    if (!lane.turnPending || lane.instanceId === null || lane.epoch === null) return
    this.refreshLocal()
    if (!this.settled(lane)) return
    lane.turnPending = false
    const last = this.persist.lanes[lane.durableId]
    if (last && last.instanceId === lane.instanceId && lane.epoch <= last.epoch) return
    this.persist.lanes[lane.durableId] = { key: lane.key, instanceId: lane.instanceId, epoch: lane.epoch, at: new Date(this.deps.now()).toISOString() }
    this.persistDirty = true
    const c = this.children(lane)
    this.emit(lane, 'lane.turn_done', `${lane.durableId}:${lane.instanceId}:${lane.epoch}`, 'info', {
      turn_epoch: lane.epoch, instanceId: lane.instanceId, ...(this.noChildren ? {} : { children: { state: c.state, running: c.running } }),
    })
    this.savePersist()
  }

  /** A converged snapshot: record the baseline, emit only a turn the persisted epoch of the same incarnation has not seen. */
  private baseline(lane: Lane) {
    if (lane.instanceId === null || lane.epoch === null || lane.status !== 'idle') return
    const last = this.persist.lanes[lane.durableId]
    if (last && last.instanceId === lane.instanceId) {
      if (lane.epoch > last.epoch) { lane.turnPending = true; this.maybeTurnDone(lane) }
      return
    }
    this.persist.lanes[lane.durableId] = { key: lane.key, instanceId: lane.instanceId, epoch: lane.epoch, at: new Date(this.deps.now()).toISOString() }
    this.persistDirty = true
    this.savePersist()
  }

  private async readState(host: Host, row: Row) {
    if (!host.link) return null
    const cmd: Record<string, unknown> = host.kind === 'rpc_host' ? { type: 'get_state', observe: true, sessionId: row.sessionId } : { type: 'get_state' }
    try {
      const r = await host.link.request(cmd, this.deps.requestTimeoutMs)
      return r?.success ? r.data : null
    } catch { return null }
  }

  private applyState(lane: Lane, d: any) {
    if (!d) return
    if (typeof d.turn_epoch === 'number') lane.epoch = d.turn_epoch
    if (typeof d.blocking_question === 'boolean' || d.blocking_question === null) lane.blocking_question = d.blocking_question ? true : false
    if (typeof d.editor_has_draft === 'boolean') lane.editor_has_draft = d.editor_has_draft
  }

  private onLaneStatus(host: Host, lane: Lane, row: Row, snapshot: boolean) {
    const prev = lane.status
    lane.status = mapStatus(row.status)
    lane.host = host.socket
    lane.instanceId = host.instanceId
    lane.misses = 0; lane.lastMissAt = null
    if (row.model?.provider) lane.model = `${row.model.provider}/${row.model.id}`
    lane.lastWriteAt = new Date(this.deps.now()).toISOString()
    if (snapshot) {
      lane.turnPending = lane.status === 'running' || lane.status === 'compacting' || lane.status === 'waiting_input'
      this.track(this.readState(host, row).then((d) => { this.applyState(lane, d); this.baseline(lane) }))
      return
    }
    if (lane.status === 'running' || lane.status === 'compacting' || lane.status === 'waiting_input') lane.turnPending = true
    if (lane.status === 'waiting_input' && prev !== 'waiting_input') {
      this.emit(lane, 'lane.question', `${lane.durableId}:${host.instanceId}:${lane.epoch ?? 'na'}:${row.sessionId}`, 'ask', { status: row.status })
    }
    if (lane.status === 'idle' && lane.turnPending) {
      this.track(this.readState(host, row).then((d) => { this.applyState(lane, d); this.maybeTurnDone(lane) }))
    }
  }

  private onChildChange(row: Row) {
    for (const p of lineageOf(row)) { const l = this.laneByDurable(p); if (l) this.maybeTurnDone(l) }
  }

  handleRecord(host: Host, rec: any) {
    if (!rec || typeof rec !== 'object') return
    switch (rec.type) {
      case 'session_status':
      case 'session_opened': {
        const row: Row = { ...(host.rows.get(rec.sessionId) ?? {}), ...rec, status: rec.status ?? host.rows.get(rec.sessionId)?.status ?? 'opening' }
        host.rows.set(rec.sessionId, row)
        const lane = this.laneByDurable(row.durableSessionId)
        if (lane) this.onLaneStatus(host, lane, row, false)
        else this.onChildChange(row)
        break
      }
      case 'session_closed':
      case 'session_parked': {
        const row = host.rows.get(rec.sessionId)
        if (!row) break
        row.status = rec.type === 'session_closed' ? 'closed' : 'unloaded'
        const lane = this.laneByDurable(row.durableSessionId)
        if (lane) this.onLaneStatus(host, lane, row, false)
        else this.onChildChange(row)
        break
      }
      case 'session_control_event': {
        if (typeof rec.seq === 'number') this.saveCursor(host, rec.seq)
        const row = [...host.rows.values()][0]
        const lane = row ? this.laneByDurable(row.durableSessionId) : undefined
        if (lane && rec.kind === 'completion' && typeof rec.data?.turn_epoch === 'number') lane.epoch = Math.max(lane.epoch ?? 0, rec.data.turn_epoch)
        break
      }
      case 'resync_required': this.track(this.resync(host)); break
      case 'host_superseded': this.track(this.supersede(host, rec)); break
      default: break
    }
  }

  private saveCursor(host: Host, seq: number) {
    host.cursor = seq
    if (!host.instanceId) return
    this.persist.cursors[host.socket] = { instanceId: host.instanceId, cursor: seq }
    this.persistDirty = true
  }

  /** Converge from a snapshot: rows replace the host's view; lanes take their state without replaying side effects. */
  private applySnapshot(host: Host, snapshot: any[]) {
    host.rows = new Map(snapshot.filter((r) => typeof r?.sessionId === 'string').map((r) => [r.sessionId, { ...r } as Row]))
    for (const row of host.rows.values()) {
      const lane = this.laneByDurable(row.durableSessionId)
      if (lane) this.onLaneStatus(host, lane, row, true)
    }
  }

  private async subscribe(host: Host): Promise<boolean> {
    const link = host.link!
    const sub = await link.request({ ...SUBSCRIBE_SESSIONS }, this.deps.requestTimeoutMs)
    if (!sub?.success) { host.state = 'unreachable'; host.code = `subscribe_refused:${sub?.errorCode ?? '?'}`; return false }
    host.workersHidden = sub.data?.include_workers === false || sub.data?.workers === 'hidden'
    this.applySnapshot(host, sub.data?.snapshot ?? [])
    return true
  }

  /** tui feed: resume from the persisted cursor; a gap behind the 256-record ring is a resync. */
  private async subscribeFeed(host: Host) {
    const saved = this.persist.cursors[host.socket]
    const cursor = saved && saved.instanceId === host.instanceId ? saved.cursor : undefined
    let first: number | undefined
    host.link!.onEvent((rec) => { if (rec?.type === 'session_control_event' && first === undefined) first = rec.seq })
    const r = await host.link!.request(cursor === undefined ? { type: 'subscribe' } : { type: 'subscribe', cursor }, this.deps.requestTimeoutMs)
    if (!r?.success) return
    const head = r.data?.cursor
    if (cursor !== undefined && typeof head === 'number' && head > cursor && first !== undefined && first > cursor + 1) await this.resync(host)
    if (typeof head === 'number' && (host.cursor === undefined || head > host.cursor)) this.saveCursor(host, head)
  }

  async resync(host: Host) {
    if (!host.link) return
    this.deps.log(`SUPERVISOR_RESYNC ${host.socket}`)
    await this.subscribe(host)
  }

  private async supersede(host: Host, rec: any) {
    if (host.superseding) return
    host.superseding = true
    const next = typeof rec.successor?.socket === 'string' ? rec.successor.socket : host.socket
    for (const l of this.lanes.values()) if (l.host === host.socket) l.status = 'unknown'
    const old = host.link
    host.link = null
    old?.close()
    if (next !== host.socket) this.hosts.delete(host.socket)
    await this.connect({ socket: next, kind: host.kind })
    const h = this.hosts.get(next)
    if (h) h.superseding = false
  }

  private onTransportGone(host: Host, why: string) {
    if (host.superseding || host.link === null) return
    host.link = null
    host.state = 'dead'
    host.code = `transport_gone:${why}`
    this.deps.log(`SUPERVISOR_TRANSPORT_GONE ${host.socket} ${why}`)
    for (const l of this.lanes.values()) {
      if (l.host !== host.socket) continue
      l.status = 'offline'
      this.emit(l, 'lane.offline', `${l.durableId}:${l.instanceId ?? 'none'}`, 'info', { reason: 'transport_gone', socket: host.socket })
    }
  }

  async connect(ep: Endpoint): Promise<Host> {
    const existing = this.hosts.get(ep.socket)
    if (existing && (existing.state === 'up' || existing.state === 'connecting')) return existing
    const host: Host = { socket: ep.socket, kind: ep.kind, state: 'connecting', link: null, instanceId: null, generation: null, rows: new Map() }
    this.hosts.set(ep.socket, host)
    const opened = await this.deps.openLink(ep.socket, this.deps.connectTimeoutMs)
    if (opened.ok === false) { host.state = opened.state; host.code = opened.code; return host }
    host.link = opened.link
    opened.link.onEvent((rec) => this.handleRecord(host, rec))
    opened.link.onClose((why) => this.onTransportGone(host, why))
    try {
      const info = await opened.link.request(ep.kind === 'rpc_host' ? { type: 'get_protocol_info', observe: true } : { type: 'get_protocol_info' }, this.deps.requestTimeoutMs)
      if (!info?.success) { host.state = 'unreachable'; host.code = 'protocol_refused'; opened.link.close(); host.link = null; return host }
      host.instanceId = info.data?.instanceId ?? null
      host.generation = typeof info.data?.generation === 'number' ? info.data.generation : null
      if (info.data?.endpoint_kind === 'tui' || info.data?.mode === 'tui') host.kind = 'tui'
      host.state = 'up'
      if (!(await this.subscribe(host))) { opened.link.close(); host.link = null; return host }
      if (host.kind === 'tui') await this.subscribeFeed(host)
    } catch (e: any) {
      if (host.link) { host.state = 'unreachable'; host.code = e?.message ?? 'error'; host.link.close(); host.link = null }
    }
    return host
  }

  /**
   * Registry rescan: connect to every endpoint not yet linked, then judge lanes nothing hosts. A lane without endpoint
   * and without pane counts one miss per rescan at least GONE_MISS_GAP_MS after the last; GONE_RESCANS misses -> gone.
   */
  async rescan(opts: { hostStatus?: boolean } = {}) {
    this.syncLanes()
    this.refreshLocal(true)
    const eps = new Map<string, Endpoint>()
    for (const e of this.deps.scanEndpoints()) eps.set(e.socket, e)
    if (opts.hostStatus !== false) {
      const hs = await this.deps.hostStatus()
      for (const r of hs ?? []) if (!eps.has(r.socket)) eps.set(r.socket, { kind: r.kind, socket: r.socket })
    }
    for (const s of [...this.hosts.keys()]) if (!eps.has(s) && this.hosts.get(s)!.state !== 'up') this.hosts.delete(s)
    await Promise.all([...eps.values()].map((e) => this.connect(e)))
    await this.flush()
    this.censusDone = true
    const panes = await this.deps.panesAlive()
    const now = this.deps.now()
    for (const lane of this.lanes.values()) {
      let hosted: { host: Host; row: Row } | undefined
      for (const h of this.hosts.values()) {
        if (h.state !== 'up') continue
        const row = [...h.rows.values()].find((r) => r.durableSessionId === lane.durableId && r.status !== 'closed')
        if (row) { hosted = { host: h, row }; break }
      }
      if (hosted) {
        // A lane rebound (registry) to a session whose host was linked before the rebind got its row in a snapshot that
        // no lane matched; an idle session sends no further status, so bind it here once from the row already held.
        if (lane.host !== hosted.host.socket || lane.instanceId !== hosted.host.instanceId) this.onLaneStatus(hosted.host, lane, hosted.row, true)
        continue
      }
      const own = lane.host ? this.hosts.get(lane.host) : undefined
      if (own?.state === 'up' && own.kind === 'tui') {
        const others = [...own.rows.values()].filter((r) => r.durableSessionId && r.durableSessionId !== lane.durableId && r.status !== 'closed' && !this.laneByDurable(r.durableSessionId))
        if (others.length === 1) this.noteReplaced(lane.key, lane.durableId, others[0]!.durableSessionId!, 'endpoint')
      }
      const onUnreachable = lane.host !== null && this.hosts.get(lane.host)?.state === 'unreachable'
      if (onUnreachable) { lane.status = 'unknown'; continue }
      if (lane.status !== 'gone') {
        if (lane.status !== 'offline') {
          lane.status = 'offline'
          this.emit(lane, 'lane.offline', `${lane.durableId}:${lane.instanceId ?? 'none'}`, 'info', { reason: 'not_hosted' })
        }
        const paneAlive = panes === null ? null : lane.pane !== null && panes.has(lane.pane)
        if (paneAlive !== false) { lane.misses = 0; lane.lastMissAt = null; continue }
        if (lane.lastMissAt !== null && now - lane.lastMissAt < GONE_MISS_GAP_MS) continue
        lane.misses++
        lane.lastMissAt = now
        if (lane.misses >= GONE_RESCANS) {
          lane.status = 'gone'
          const c = this.children(lane)
          // sess.ts close marks the registry entry closed first: that gone is expected, so it is info even when the
          // children are unknown (the link is already down by then).
          const entry = this.deps.loadMap()[lane.key]
          const closedByLead = entry?.status === 'closed' && (!entry.sessionId || entry.sessionId === lane.durableId)
          this.emit(lane, 'lane.gone', `${lane.durableId}:${lane.instanceId ?? 'none'}`, closedByLead || (c.state === 'known' && c.running === 0) ? 'info' : 'ask', {
            rescans: lane.misses, children: { state: c.state, running: c.running }, ...(closedByLead ? { closedByLead: true } : {}),
          })
        }
      }
    }
    for (const lane of this.lanes.values()) this.maybeTurnDone(lane)
    this.savePersist()
  }

  census() {
    const unreachable = [...this.hosts.values()].filter((h) => h.state === 'unreachable' || h.state === 'connecting').map((h) => h.socket)
    return { complete: this.censusDone && unreachable.length === 0, hostsUnreachable: unreachable }
  }

  snapshot() {
    const lanes: Record<string, unknown> = {}
    const laneIds = new Set<string>()
    for (const l of this.lanes.values()) {
      if (l.closing) continue
      laneIds.add(l.durableId)
      const h = l.host ? this.hosts.get(l.host) : undefined
      lanes[l.key] = {
        durableId: l.durableId, generation: l.generation, pane: l.pane,
        endpoint: h ? { kind: h.kind, socket: h.socket, instanceId: h.instanceId } : null,
        status: l.status, turn_epoch: l.epoch, blocking_question: l.blocking_question, editor_has_draft: l.editor_has_draft,
        model: l.model, lastWriteAt: l.lastWriteAt,
        ...(this.noChildren ? {} : { children: this.children(l), childrenIds: this.childrenIds(l) }),
        settled: this.settled(l), quiet: l.quiet,
      }
    }
    const unmanaged: unknown[] = []
    for (const h of this.hosts.values()) for (const r of h.rows.values()) {
      if (!r.durableSessionId || laneIds.has(r.durableSessionId) || r.kind === 'worker' || lineageOf(r).some((p) => laneIds.has(p))) continue
      unmanaged.push({ durableId: r.durableSessionId, name: r.name ?? null, cwd: r.cwd ?? null, surface: h.kind === 'tui' ? 'tui' : 'host', status: r.status })
    }
    const hosts = [...this.hosts.values()].map((h) => ({
      socket: h.socket, kind: h.kind, instanceId: h.instanceId, generation: h.generation, reachable: h.state === 'up', state: h.state,
      ...(h.code ? { code: h.code } : {}), sessions: h.rows.size,
    }))
    return { at: new Date(this.deps.now()).toISOString(), v: 2, census: this.census(), lanes, unmanaged, hosts }
  }

  writeLaneStatus() {
    if (this.deps.write) atomicWrite(supPaths(this.deps.home).laneStatus, `${JSON.stringify(this.snapshot(), null, 1)}\n`)
  }

  close() { for (const h of this.hosts.values()) { h.superseding = true; h.link?.close(); h.link = null } }
}

// ---------------------------------------------------------------------------------------------------------------------
// S9 policies + ops ledger

export const POLICY_NAMES = ['quota', 'adopt', 'nudge', 'reap'] as const
export type PolicyName = (typeof POLICY_NAMES)[number]
export type OpState = 'planned' | 'attempted' | 'verified' | 'failed' | 'ambiguous'
export const TERMINAL: ReadonlySet<OpState> = new Set(['verified', 'failed', 'ambiguous'])
export type PolicyOp = {
  v: 1; opId: string; policy: PolicyName; key: string; state: OpState; step?: string
  createdAt: string; updatedAt: string; history: { state: OpState; step?: string; at: string; note?: string }[]
  data: Record<string, any>; result?: unknown
}
export type PolicyState = {
  pendingReplacements: Record<string, Replacement>
  handledReplacements: string[]
  nudges: Record<string, { generation: number; total: number; heard: number; inEpisode: number; lastAt: number; lastId: string; verified: boolean; stopped?: boolean }>
  switchBack: Record<string, { ref: string; orig: string; count: number }>
  reapSeen: Record<string, { first: number; last: number; count: number }>
}
export const emptyPolicyState = (): PolicyState => ({ pendingReplacements: {}, handledReplacements: [], nudges: {}, switchBack: {}, reapSeen: {} })

export const policyPaths = (home: string) => ({
  ops: join(home, 'ops', 'policy'),
  flags: join(home, 'flags'),
  noPolicies: join(home, 'flags', 'supervisor.no-policies'),
  allOn: join(home, 'flags', 'policies.on'),
  policy: (n: PolicyName) => join(home, 'flags', `policy.${n}`),
  autoMigrate: (key: string) => join(home, 'flags', `auto-migrate.${key}`),
  sim: (key: string) => join(home, 'state', 'quota-sim', `${key}.json`),
})

/** Policy scope from the flag files: null = off (propose only), 'all', or the keys listed in flags/policy.<name>. */
export function policyScope(home: string, name: PolicyName): 'all' | Set<string> | null {
  const p = policyPaths(home)
  if (existsSync(p.noPolicies)) return null
  if (existsSync(p.allOn)) return 'all'
  if (!existsSync(p.policy(name))) return null
  const keys = readFileSync(p.policy(name), 'utf8').split(/[\s,]+/).filter(Boolean)
  return keys.length ? new Set(keys) : 'all'
}
const inScope = (s: 'all' | Set<string> | null, ...keys: (string | null | undefined)[]) => s === 'all' || (!!s && keys.some((k) => !!k && s.has(k)))

export class OpsLedger {
  private seq = 0
  constructor(readonly home: string, readonly now: () => number) {}
  private file(id: string) { return join(policyPaths(this.home).ops, `${id}.json`) }
  read(id: string): PolicyOp { return JSON.parse(readFileSync(this.file(id), 'utf8')) }
  all(): PolicyOp[] {
    let files: string[] = []
    try { files = readdirSync(policyPaths(this.home).ops).filter((f) => f.endsWith('.json')) } catch { return [] }
    return files.flatMap((f) => { try { return [JSON.parse(readFileSync(join(policyPaths(this.home).ops, f), 'utf8')) as PolicyOp] } catch { return [] } })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  save(op: PolicyOp) { op.updatedAt = new Date(this.now()).toISOString(); atomicWrite(this.file(op.opId), JSON.stringify(op, null, 1)) }
  create(policy: PolicyName, key: string, data: Record<string, any>): PolicyOp {
    const at = new Date(this.now()).toISOString()
    const opId = `pop_${policy}_${key}_${at.replace(/[-:.TZ]/g, '').slice(0, 14)}_${process.pid}${++this.seq}`
    const op: PolicyOp = { v: 1, opId, policy, key, state: 'planned', createdAt: at, updatedAt: at, history: [{ state: 'planned', at }], data }
    this.save(op)
    return op
  }
  mark(op: PolicyOp, state: OpState, note?: string, patch: Partial<PolicyOp> = {}) {
    Object.assign(op, patch, { state })
    op.history.push({ state, ...(op.step ? { step: op.step } : {}), at: new Date(this.now()).toISOString(), ...(note ? { note } : {}) })
    this.save(op)
  }
  find(pred: (op: PolicyOp) => boolean) { return this.all().find(pred) }
}

export type QuotaInput = { verdict: string; detail: string; model: string | null; account: string | null }
export type DoriLaneLite = { key: string; status?: string; closedAt?: string; openedAt: string; lastReplyAt?: number }
export type SendResult = { status: string; reason?: string }
export type PolicyDeps = {
  /** lane-transition.ts argv, or ['--adopt-replacement', key, '--session', id, '--op', opId] (adoptReplacement in-process). */
  transition: (argv: string[]) => Promise<{ exit: number; out: any }>
  send: (key: string, text: string, id: string) => Promise<SendResult>
  receipt: (key: string, durableId: string, id: string) => 'persisted' | 'absent'
  quotaInput: (lane: { key: string; durableId: string; model: string | null; status: string; cwd: string | null }) => Promise<QuotaInput | null>
  usage: () => any
  auth: () => any
  migrations: () => any[]
  doriLanes: () => DoriLaneLite[]
  markNudged: (key: string, at: number) => Promise<void>
  nudgeAfterMs: number
  reaperLines: () => Promise<string[]>
  reapApply: (tab: string) => Promise<{ code: number; out: string }>
  tabsAlive: () => Promise<Set<string> | null>
}

export const NUDGE_TEXT = (min: number) => `[LEAD] your work thread has had no update for ${min} min. Post a 1-2 sentence progress line (done since last, next) and keep its status true.`
export const NUDGES_PER_SILENCE = 2
export const REAP_SIGHTINGS = 2

export class Policies {
  readonly ledger: OpsLedger
  readonly home: string
  private resumed = false
  constructor(readonly sup: Supervisor, readonly p: PolicyDeps) {
    this.home = sup.deps.home
    this.ledger = new OpsLedger(this.home, sup.deps.now)
  }
  get state(): PolicyState {
    const s = (this.sup.persist.policy ??= emptyPolicyState())
    for (const [k, v] of Object.entries(emptyPolicyState())) (s as any)[k] ??= v
    return s
  }
  private now() { return this.sup.deps.now() }
  private ask(key: string, kind: string, idTail: string, data: Record<string, unknown>) { this.sup.emitFor(key, kind, idTail, 'ask', data) }
  private act(key: string, kind: string, idTail: string, data: Record<string, unknown>) { this.sup.emitFor(key, kind, idTail, 'act', data) }
  private opFailed(op: PolicyOp, why: string, extra: Record<string, unknown> = {}) {
    this.ask(op.key, op.state === 'ambiguous' ? 'policy.op_ambiguous' : 'policy.op_failed', op.opId, { op: op.opId, policy: op.policy, step: op.step ?? null, why, ...extra })
  }

  async tick() {
    if (existsSync(policyPaths(this.home).noPolicies)) return
    this.sup.refreshLocal(true)
    if (!this.resumed) { this.resumed = true; await this.resumeOpen() }
    await this.adoptPolicy()
    await this.quotaPolicy()
    await this.switchBackPolicy()
    await this.nudgePolicy()
    await this.reapPolicy()
    this.sup.markDirty()
    this.sup.savePersist()
  }

  /** Restart boundary: planned ops never ran their effect (rerun); attempted ops are read back, never re-sent with a new id. */
  async resumeOpen() {
    for (const op of this.ledger.all()) {
      if (TERMINAL.has(op.state)) continue
      try {
        if (op.policy === 'quota') {
          if (op.state === 'planned') await this.runQuota(op)
          else this.quotaReadBack(op, null)
        } else if (op.policy === 'adopt') await this.runAdopt(op)
        else if (op.policy === 'nudge') {
          if (op.state === 'planned') this.ledger.mark(op, 'failed', 'never sent (supervisor restarted before the send); the next tick decides again')
          else this.nudgeReadBack(op, null)
        } else if (op.policy === 'reap') {
          if (op.state === 'planned') this.ledger.mark(op, 'failed', 'never applied (supervisor restarted before --apply)')
          else {
            const alive = await this.p.tabsAlive()
            if (alive && !alive.has(op.data.tab)) this.ledger.mark(op, 'verified', 'read-back after restart: tab gone')
            else { this.ledger.mark(op, 'ambiguous', 'read-back after restart: tab still listed or unreadable'); this.opFailed(op, 'reap result unknown after restart') }
          }
        }
      } catch (e: any) {
        this.ledger.mark(op, 'ambiguous', `resume error: ${e?.message ?? e}`)
        this.opFailed(op, `resume error: ${e?.message ?? e}`)
      }
    }
  }

  // --- session_replaced -> adopt --------------------------------------------------------------------------------------
  async adoptPolicy() {
    const st = this.state
    for (const [id, rep] of Object.entries(st.pendingReplacements)) {
      delete st.pendingReplacements[id]
      st.handledReplacements = [...st.handledReplacements.slice(-200), id]
      const entry = this.sup.deps.loadMap()[rep.key]
      if (!entry || entry.status !== 'open') continue
      if (this.ledger.find((o) => o.policy === 'adopt' && o.key === rep.key && o.data.to === rep.to)) continue
      if (!inScope(policyScope(this.home, 'adopt'), rep.key)) {
        this.ask(rep.key, 'policy.adopt_proposal', id, { from: rep.from, to: rep.to, via: rep.via, command: `bun ${homeRef()}/dori-supervisor.ts --adopt ${rep.key} --session ${rep.to}` })
        continue
      }
      const op = this.ledger.create('adopt', rep.key, { from: rep.from, to: rep.to, via: rep.via })
      await this.runAdopt(op)
    }
  }
  private async runAdopt(op: PolicyOp) {
    const r = await this.p.transition(['--adopt-replacement', op.key, '--session', op.data.to, '--op', op.opId])
    const now = this.ledger.read(op.opId)
    if (!TERMINAL.has(now.state)) { this.ledger.mark(now, 'ambiguous', `adopt returned exit ${r.exit} without a final state`); this.opFailed(now, 'adopt ended without a final state', { out: r.out }) }
    else if (now.state !== 'verified') this.opFailed(now, String(now.history.at(-1)?.note ?? now.state), { out: r.out })
  }

  // --- quota ----------------------------------------------------------------------------------------------------------
  private approved(key: string, episode: string): boolean {
    const f = policyPaths(this.home).autoMigrate(key)
    if (!existsSync(f)) return false
    const content = readFileSync(f, 'utf8').trim()
    if (content === episode) return true
    if (content === '') { writeFileSync(f, `${episode}\n`, { mode: 0o600 }); return true }
    return false
  }
  private simulated(key: string, durableId: string): { episode: string; target: string } | null {
    try {
      const s = JSON.parse(readFileSync(policyPaths(this.home).sim(key), 'utf8'))
      return s?.durableId === durableId && typeof s.target === 'string' && typeof s.episode === 'string' ? { episode: s.episode, target: s.target } : null
    } catch { return null }
  }
  async quotaPolicy() {
    const scope = policyScope(this.home, 'quota')
    if (!scope) return
    const usage = this.p.usage(), auth = this.p.auth(), now = this.now()
    for (const lane of [...this.sup.lanes.values()]) {
      if (lane.closing || lane.status === 'gone' || !inScope(scope, lane.key)) continue
      const sim = this.simulated(lane.key, lane.durableId)
      let episode: string, target: string | null, detail: string
      if (sim) { episode = sim.episode; target = sim.target; detail = `simulated quota -> ${sim.target}` }
      else {
        const q = await this.p.quotaInput({ key: lane.key, durableId: lane.durableId, model: lane.model, status: lane.status, cwd: lane.cwd })
        if (!q || q.verdict !== 'quota') continue
        if (!isClaudeModel(q.model)) continue
        episode = `quota:${lane.key}:${lane.durableId}`
        target = pickAccount(CLAUDE_ACCOUNTS, q.account, usage, auth, now)?.name ?? null
        detail = q.detail
      }
      if (this.ledger.find((o) => o.policy === 'quota' && o.data.episode === episode)) continue
      const command = target ? `bun ${homeRef()}/lane-transition.ts ${lane.key} --fresh --account ${target} --reason quota` : null
      if (!target) { this.ask(lane.key, 'policy.quota_proposal', `${episode}:no-target`, { episode, detail, why: 'no Claude account with fresh usage headroom' }); continue }
      if (!this.approved(lane.key, episode)) {
        this.ask(lane.key, 'policy.quota_proposal', episode, { episode, detail, target, command, approve: `echo '${episode}' > ${homeRef()}/flags/auto-migrate.${lane.key}` })
        continue
      }
      const op = this.ledger.create('quota', lane.key, { episode, target, g: lane.generation, detail, sim: !!sim })
      this.act(lane.key, 'lane.quota', episode, { op: op.opId, target, detail })
      await this.runQuota(op)
    }
  }
  private async runQuota(op: PolicyOp) {
    const argv = [op.key, '--fresh', '--account', op.data.target, '--reason', 'quota']
    this.ledger.mark(op, 'attempted', `lane-transition ${argv.join(' ')}`, { step: 'transition', data: { ...op.data, argv } })
    const r = await this.p.transition(argv)
    this.quotaReadBack(op, r)
    if (op.data.sim && TERMINAL.has(op.state)) { try { rmSync(policyPaths(this.home).sim(op.key)) } catch { /* already gone */ } }
  }
  private quotaReadBack(op: PolicyOp, r: { exit: number; out: any } | null) {
    const e = this.sup.deps.loadMap()[op.key]
    const moved = !!e && (e.generation ?? 0) > op.data.g && e.accountRequested === op.data.target
    if (moved) { this.ledger.mark(op, 'verified', `read-back: generation ${e!.generation}, accountRequested ${e!.accountRequested}`, { result: r?.out ?? null }); return }
    if (r && r.exit === 4) { this.ledger.mark(op, 'failed', `refused: ${r.out?.error ?? 'refused'}`, { result: r.out }); this.opFailed(op, `lane-transition refused: ${r.out?.error ?? '?'}`, { detail: r.out?.detail ?? null }); return }
    if (r && r.exit !== 0) { this.ledger.mark(op, 'failed', `lane-transition exit ${r.exit}`, { result: r.out }); this.opFailed(op, `lane-transition failed (exit ${r.exit})`, { resume: r.out?.resume ?? null, transitionOp: r.out?.opId ?? null }); return }
    this.ledger.mark(op, 'ambiguous', r ? 'exit 0 but the registry does not show the new generation/account' : 'restarted while attempted; registry does not show the move', { result: r?.out ?? null })
    this.opFailed(op, 'quota move not visible in the registry', { transitionOp: r?.out?.opId ?? null })
  }

  /** Return to the original account only after SWITCH_BACK_N consecutive clear checks (proposal: the lead decides). */
  async switchBackPolicy() {
    const scope = policyScope(this.home, 'quota')
    if (!scope) return
    const st = this.state, usage = this.p.usage(), auth = this.p.auth(), now = this.now(), map = this.sup.deps.loadMap()
    const last = new Map<string, any>()
    for (const m of this.p.migrations()) if (m?.reason === 'quota' && typeof m.key === 'string') last.set(m.key, m)
    for (const [key, m] of last) {
      const e = map[key]
      if (!e || e.status !== 'open' || !inScope(scope, key) || !CLAUDE_ACCOUNTS.includes(m.from)) { delete st.switchBack[key]; continue }
      if (e.accountRequested === m.from || e.account === m.from) { delete st.switchBack[key]; continue }
      const ref = String(m.opId ?? m.at)
      const cur = st.switchBack[key]?.ref === ref ? st.switchBack[key]! : { ref, orig: m.from, count: 0 }
      const step = switchBackStep(cur.count, accountCheck(accountHeadroom(m.from, usage, auth, now)))
      st.switchBack[key] = { ...cur, count: step.count }
      if (step.fire) this.ask(key, 'lane.quota_reset', `${key}:${ref}`, { orig: m.from, checks: step.count, command: `bun ${homeRef()}/lane-transition.ts ${key} --fresh --account ${m.from} --reason manual` })
    }
  }

  // --- nudge ----------------------------------------------------------------------------------------------------------
  async nudgePolicy() {
    const scope = policyScope(this.home, 'nudge')
    if (!scope) return
    const st = this.state, now = this.now(), map = this.sup.deps.loadMap()
    for (const dl of this.p.doriLanes()) {
      if (dl.closedAt || (dl.status ?? 'working') !== 'working' || !inScope(scope, dl.key)) continue
      const e = map[dl.key]
      if (!e || e.status !== 'open' || isLeadKey(e.key)) continue
      const g = e.generation ?? 0
      const heard = dl.lastReplyAt ?? Date.parse(dl.openedAt)
      let s = st.nudges[dl.key]
      if (!s || s.generation !== g) s = { generation: g, total: 0, heard, inEpisode: 0, lastAt: 0, lastId: '', verified: false }
      if (s.heard !== heard) s = { ...s, heard, inEpisode: 0, verified: false, stopped: false }
      st.nudges[dl.key] = s
      if (s.stopped) continue
      const since = s.inEpisode === 0 ? heard : s.lastAt
      if (now - since < this.p.nudgeAfterMs) continue
      if (s.inEpisode > 0 && !s.verified) continue
      if (s.inEpisode >= NUDGES_PER_SILENCE) {
        s.stopped = true
        this.ask(dl.key, 'policy.nudge_unanswered', `${dl.key}:${g}:${heard}`, { nudges: s.inEpisode, lastId: s.lastId, silentMin: Math.round((now - heard) / 60_000) })
        continue
      }
      const n = s.total + 1
      const id = `nudge:${dl.key}:${g}:${n}`
      const op = this.ledger.create('nudge', dl.key, { id, n, generation: g, heard, durableId: e.sessionId })
      this.ledger.mark(op, 'attempted', `send ${id}`, { step: 'send' })
      Object.assign(s, { total: n, inEpisode: s.inEpisode + 1, lastAt: now, lastId: id, verified: false })
      this.sup.markDirty(); this.sup.savePersist()
      const r = await this.p.send(dl.key, NUDGE_TEXT(Math.round((now - heard) / 60_000)), id)
      s.verified = this.nudgeReadBack(op, r)
      if (s.verified) await this.p.markNudged(dl.key, now).catch(() => undefined)
      else s.stopped = true
    }
  }
  private nudgeReadBack(op: PolicyOp, r: SendResult | null): boolean {
    if (this.p.receipt(op.key, op.data.durableId, op.data.id) === 'persisted') { this.ledger.mark(op, 'verified', `receipt ${op.data.id} persisted`, { result: r }); return true }
    if (r?.status === 'refused') { this.ledger.mark(op, 'failed', `refused: ${r.reason ?? '?'}`, { result: r }); this.opFailed(op, `nudge refused: ${r.reason ?? '?'}`); return false }
    this.ledger.mark(op, 'ambiguous', `no receipt for ${op.data.id} (${r?.status ?? 'restart'})`, { result: r })
    this.opFailed(op, `nudge ${op.data.id} not confirmed; not retried`)
    return false
  }

  // --- reap LANE_EMPTY_TAB --------------------------------------------------------------------------------------------
  async reapPolicy() {
    const scope = policyScope(this.home, 'reap')
    if (!scope) return
    const st = this.state, now = this.now()
    const tabs = (await this.p.reaperLines()).flatMap((l) => { const m = /^LANE_EMPTY_TAB (\S+)/.exec(l); return m ? [m[1]!] : [] })
    for (const t of Object.keys(st.reapSeen)) if (!tabs.includes(t)) delete st.reapSeen[t]
    for (const tab of tabs) {
      const seen = st.reapSeen[tab] ?? { first: now, last: 0, count: 0 }
      if (now - seen.last >= GONE_MISS_GAP_MS) { seen.count++; seen.last = now }
      st.reapSeen[tab] = seen
      if (seen.count < REAP_SIGHTINGS) continue
      const lane = [...this.sup.lanes.values()].find((l) => l.tab === tab)
      if (lane) {
        const c = this.sup.children(lane)
        if (lane.status !== 'gone' || c.state !== 'known' || c.running > 0) {
          this.ask(lane.key, 'policy.reap_refused', `${tab}:${lane.durableId}:${lane.status}:${c.state}`, { tab, status: lane.status, children: { state: c.state, running: c.running, reasons: c.reasons ?? [] } })
          continue
        }
      }
      if (!inScope(scope, tab, lane?.key)) continue
      if (this.ledger.find((o) => o.policy === 'reap' && o.data.tab === tab && (o.state === 'verified' || !TERMINAL.has(o.state)))) continue
      const leaseKey = lane?.key ?? `reap-${tab.replace(/[^A-Za-z0-9._-]/g, '_')}`
      try {
        await withLaneLease(leaseKey, 'reap', async () => {
          const op = this.ledger.create('reap', leaseKey, { tab, lane: lane?.key ?? null, sightings: seen.count })
          this.ledger.mark(op, 'attempted', `lane-reaper --apply-tab ${tab}`, { step: 'apply' })
          const r = await this.p.reapApply(tab)
          const alive = await this.p.tabsAlive()
          if (alive && !alive.has(tab)) this.ledger.mark(op, 'verified', `read-back: tab ${tab} gone`, { result: r })
          else if (r.code !== 0) { this.ledger.mark(op, 'failed', `apply exit ${r.code}: ${r.out.slice(0, 200)}`, { result: r }); this.opFailed(op, `reap ${tab} failed`) }
          else { this.ledger.mark(op, 'ambiguous', `apply exit 0 but tab ${tab} still listed (or list unreadable)`, { result: r }); this.opFailed(op, `reap ${tab} not confirmed`) }
        }, { home: this.home })
      } catch (e) {
        if (!(e instanceof RegistryError && (e as RegistryError).code === 'lease_held')) throw e
      }
    }
  }
}

/** Policy-side events go to the supervisor events file (the router tails it), deduped by id like Supervisor.emit. */
export function appendSupEvent(home: string, ev: { id: string; kind: string; severity: 'info' | 'act' | 'ask'; lane: string; [k: string]: unknown }): boolean {
  const f = supPaths(home).events
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 })
  if (existsSync(f) && readFileSync(f, 'utf8').includes(`"id":${JSON.stringify(ev.id)}`)) return false
  appendFileSync(f, `${JSON.stringify({ v: 2, at: new Date().toISOString(), source: 'supervisor', ...ev })}\n`, { mode: 0o600 })
  return true
}

// --- late receipts -------------------------------------------------------------------------------------------------
export const LATE_RECEIPT_WINDOW_MS = 24 * 60 * 60_000
export const LATE_RECEIPT_TAIL_BYTES = 512 * 1024
export type LateReceiptDeps = {
  map: () => LaneMap
  find: (durableId: string, cwd: string | null) => string | null
  receipt: (sessionPath: string | null, id: string) => 'persisted' | 'absent'
}
/**
 * A delivery.uncertain (no receipt within the send wait) whose message did land later is settled by a
 * delivery.persisted {late:true}. Read-only toward lanes: it only reads the session JSONL, never re-sends.
 * Scans the tail of the event log; appendSupEvent's id check keeps it once across runs and restarts.
 */
export function settleLateReceipts(home: string, now: number, deps: LateReceiptDeps): string[] {
  const f = supPaths(home).events
  if (!existsSync(f)) return []
  const fd = openSync(f, 'r')
  let text: string
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - LATE_RECEIPT_TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
  } finally { closeSync(fd) }
  const uncertain = new Map<string, any>()
  const settled = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line.includes('"delivery.')) continue
    let e: any
    try { e = JSON.parse(line) } catch { continue }
    const id = e?.data?.id
    if (typeof id !== 'string') continue
    if (e.kind === 'delivery.persisted' || e.kind === 'delivery.refused') settled.add(id)
    else if (e.kind === 'delivery.uncertain' && now - Date.parse(e.at) <= LATE_RECEIPT_WINDOW_MS) uncertain.set(id, e)
  }
  const out: string[] = []
  let map: LaneMap | null = null
  for (const [id, e] of uncertain) {
    if (settled.has(id)) continue
    map ??= deps.map()
    const lane = map[e.lane]
    const durableId: string | null = e.durableId ?? null
    const path = lane?.sessionPath && (!durableId || lane.sessionId === durableId) && existsSync(lane.sessionPath)
      ? lane.sessionPath
      : durableId ? deps.find(durableId, lane?.cwd ?? null) : null
    if (deps.receipt(path, id) !== 'persisted') continue
    const wrote = appendSupEvent(home, {
      id: `delivery.persisted:${id}`, kind: 'delivery.persisted', severity: 'info', lane: e.lane,
      ...(durableId ? { durableId } : {}), data: { id, late: true, uncertainAt: e.at },
    })
    if (wrote) out.push(id)
  }
  return out
}

// --- adopt-replacement (lane-transition.ts has no --adopt-replacement mode; this is that step, run in-process) --------
export type AdoptCtx = {
  home: string; ledger: OpsLedger
  send: (key: string, text: string, id: string) => Promise<SendResult>
  sessionPath: (durableId: string, cwd: string | null) => string | null
  receiptAt: (sessionPath: string | null, id: string) => 'persisted' | 'absent'
  seedText: (key: string, g: number) => string
  now: () => number; sleep: (ms: number) => Promise<void>; receiptWaitMs: number
}
/**
 * Rebind the lane to the replacement session (lease + generation CAS, seed pending), send the seed once with id
 * seed:<key>:<g>, and mark it applied only on its persisted receipt. Resumed at step 'seed' it only waits for that receipt:
 * nothing is re-sent, and never under a new id. A missing receipt is ambiguous (ask lane.empty_after_handoff).
 */
export async function adoptReplacement(ctx: AdoptCtx, opId: string): Promise<{ exit: number; out: Record<string, unknown> }> {
  const op = ctx.ledger.read(opId)
  const key = op.key, to: string = op.data.to
  if (op.step !== 'seed') {
    try {
      await withLaneLease(key, 'transition', async () => {
        const cur = readMap(ctx.home)[key]
        if (!cur || cur.status !== 'open') throw new RegistryError('not_open', `${key} is not open`)
        const g = cur.generation ?? 0
        const old = cur.sessionId !== to ? cur.sessionId : op.data.from
        const seedId = `seed:${key}:${g + 1}`
        await patchLane(key, g, {
          sessionId: to, sessionPath: ctx.sessionPath(to, cur.cwd) ?? undefined, generation: g + 1, sessionVia: 'adopt', endpoint: undefined,
          lineage: addLineage(cur.lineage, old), seed: { state: 'pending', id: seedId, generation: g + 1 },
        }, { home: ctx.home })
        op.data = { ...op.data, g: g + 1, seedId, cwd: cur.cwd }
        ctx.ledger.mark(op, 'attempted', `rebound to ${to} (generation ${g + 1}); seed ${seedId} pending`, { step: 'seed' })
      }, { home: ctx.home })
    } catch (e: any) {
      ctx.ledger.mark(op, 'failed', `rebind refused: ${e?.code ?? e?.message ?? e}`)
      return { exit: 4, out: { error: e?.code ?? 'rebind_failed', opId } }
    }
    const r = await ctx.send(key, ctx.seedText(key, op.data.g), op.data.seedId).catch((e: Error) => ({ status: 'error', reason: e.message }))
    op.data.send = r
    ctx.ledger.save(op)
    if (r.status === 'refused') {
      ctx.ledger.mark(op, 'failed', `seed refused: ${r.reason ?? '?'}`)
      appendSupEvent(ctx.home, { id: `lane.empty_after_handoff:${key}:${op.data.g}`, kind: 'lane.empty_after_handoff', severity: 'ask', lane: key, durableId: to, generation: op.data.g, op: opId, data: { reason: r.reason ?? 'refused' } })
      return { exit: 1, out: { error: 'seed_refused', opId } }
    }
  }
  const until = ctx.now() + ctx.receiptWaitMs
  for (;;) {
    const path = ctx.sessionPath(to, op.data.cwd ?? null)
    if (ctx.receiptAt(path, op.data.seedId) === 'persisted') {
      await patchLane(key, undefined, (cur: Entry | undefined) => (cur?.sessionId === to ? { sessionPath: path ?? undefined, seed: { state: 'applied', id: op.data.seedId, generation: op.data.g } } : {}), { home: ctx.home })
      appendSupEvent(ctx.home, { id: `lane.seed_applied:${key}:${op.data.g}`, kind: 'lane.seed_applied', severity: 'info', lane: key, durableId: to, generation: op.data.g, op: opId })
      ctx.ledger.mark(op, 'verified', `seed ${op.data.seedId} persisted`)
      return { exit: 0, out: { ok: true, opId, key, sessionId: to, generation: op.data.g, seed: op.data.seedId } }
    }
    if (ctx.now() >= until) break
    await ctx.sleep(1000)
  }
  ctx.ledger.mark(op, 'ambiguous', `no receipt for ${op.data.seedId}`)
  appendSupEvent(ctx.home, { id: `lane.empty_after_handoff:${key}:${op.data.g}`, kind: 'lane.empty_after_handoff', severity: 'ask', lane: key, durableId: to, generation: op.data.g, op: opId, data: { reason: 'seed receipt missing' } })
  return { exit: 1, out: { error: 'seed_unconfirmed', opId } }
}

const briefFor = (home: string, key: string): string => {
  const H = process.env.HOME!
  for (const f of [join(H, '.dori', 'state', 'handoffs', key, 'brief.md'), join(H, '.dori', 'state', 'briefs', `${key}.md`), join(home, 'handoffs', key, 'brief.md')]) {
    try { const t = readFileSync(f, 'utf8').trim(); if (t) return t } catch { /* next */ }
  }
  return '(brief not found: ask the lead for it)'
}
export const adoptSeedText = (home: string) => (key: string, g: number) =>
  `[레인 복구] ${key}: 세션이 교체됐다(/handoff 등). 이 세션이 레인 ${key}의 generation ${g}다. 아래 브리프를 다시 읽고, 이미 한 일은 다시 하지 말고 이어서 해라.\n\n## 브리프\n${briefFor(home, key)}\n`

export async function livePolicyDeps(home = doriHome()): Promise<{ deps: PolicyDeps; adoptCtx: AdoptCtx }> {
  const H = process.env.HOME!
  const { rpc, transportFor, receipt } = await import('./rpc')
  const { liveDeps: herdrDeps } = await import('./deliver')
  const { findSessionFile } = await import('./sess')
  const { classify } = await import('./lane-classify')
  const readJ = (p: string) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
  const send = async (key: string, text: string, id: string): Promise<SendResult> => {
    const e = readMap(home)[key]
    if (!e || e.status !== 'open') return { status: 'refused', reason: 'not_open' }
    return (await rpc.dispatch(e as any, text, { id, transport: transportFor(key) }, herdrDeps)) as SendResult
  }
  const ledger = new OpsLedger(home, Date.now)
  const adoptCtx: AdoptCtx = {
    home, ledger, send, sessionPath: (id, cwd) => findSessionFile(id, cwd), receiptAt: receipt, seedText: adoptSeedText(home),
    now: Date.now, sleep: (ms) => Bun.sleep(ms), receiptWaitMs: 120_000,
  }
  const run = async (argv: string[]) => {
    const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out, err }
  }
  let doriCfg: any = readJ(join(H, '.dori', 'config.json')) ?? {}
  const doriLanesDir = join(H, '.dori', 'state', 'lanes')
  const deps: PolicyDeps = {
    transition: async (argv) => {
      if (argv[0] === '--adopt-replacement') return adoptReplacement(adoptCtx, argv[argv.indexOf('--op') + 1]!)
      const r = await run(['bun', join(import.meta.dir, 'lane-transition.ts'), ...argv])
      const last = r.out.trim().split('\n').pop() ?? ''
      let out: any = null
      try { out = JSON.parse(last) } catch { out = { raw: last.slice(0, 300), stderr: r.err.slice(-300) } }
      return { exit: r.code, out }
    },
    send,
    receipt: (key, durableId, id) => receipt(findSessionFile(durableId, readMap(home)[key]?.cwd ?? null), id),
    quotaInput: async (lane) => {
      const e = readMap(home)[lane.key]
      const path = e?.sessionPath && existsSync(e.sessionPath) ? e.sessionPath : findSessionFile(lane.durableId, lane.cwd)
      if (!path) return null
      const text = readFileSync(path, 'utf8').slice(-400_000)
      const account = (readJ(`${path}.claude-sdk-oauth-binding.json`)?.accountName as string | undefined) ?? (e?.account as string | null | undefined) ?? null
      const model = lane.model ?? (e?.model as string | undefined) ?? null
      const c = classify({ transcript: text, status: lane.status, model, account, usage: deps.usage(), auth: deps.auth(), now: Date.now() })
      return { verdict: c.verdict, detail: c.detail, model: model ?? (c.provider ? `${c.provider}/?` : null), account }
    },
    usage: () => readJ(join(H, '.omo', 'agent', 'subscription-usage.json')),
    auth: () => readJ(join(H, '.omo', 'agent', 'auth.json')),
    migrations: () => { try { return readFileSync(join(home, 'lane-migrations.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } }) } catch { return [] } },
    doriLanes: () => { try { return readdirSync(doriLanesDir).filter((f) => f.endsWith('.json')).flatMap((f) => { const j = readJ(join(doriLanesDir, f)); return j?.key ? [j] : [] }) } catch { return [] } },
    markNudged: async (key, at) => { await updateDoriLane(key, (l: any) => l && { ...l, lastNudgeAt: at }, { dir: doriLanesDir }) },
    nudgeAfterMs: Number(doriCfg.nudgeAfterMin ?? 15) * 60_000,
    reaperLines: async () => { const r = await run(['bun', join(import.meta.dir, 'lane-reaper.ts')]); return r.out.split('\n').filter(Boolean) },
    reapApply: async (tab) => { const r = await run(['bun', join(import.meta.dir, 'lane-reaper.ts'), '--apply-tab', tab]); return { code: r.code, out: (r.out + r.err).trim() } },
    tabsAlive: async () => {
      const r = await run(['herdr', 'pane', 'list'])
      if (r.code !== 0) return null
      try { return new Set((JSON.parse(r.out).result.panes as any[]).map((p) => p.tab_id)) } catch { return null }
    },
  }
  doriCfg = null
  return { deps, adoptCtx }
}

// --- progress watchdog (idea from bokdong dori-mode src/supervise-loop.ts Watchdog, MIT; reimplemented for launchd) ----
// launchd KeepAlive only sees an exit: a daemon stuck inside an await (a hung `herdr pane list` in panesAlive has no
// timeout, a policy tick that never settles) would live forever doing nothing. The watchdog is checked on its own timer:
// the loop (no finished pass) or a tracked task (policy tick) past WATCHDOG_ALERT_MS -> one supervisor.stalled event
// naming it; past WATCHDOG_STALL_MS -> supervisor.watchdog_exit + exit(1) so KeepAlive restarts the daemon. Each such exit
// is recorded in state/supervisor-restarts.json; with RESTART_STORM_MAX of them inside RESTART_STORM_WINDOW_MS it asks
// once (supervisor.restart_storm) and stays up instead of exiting again. Subscriptions are not tracked: an idle lane is
// legitimately silent, a dead link already ends in transport_gone, and a hang inside rescan shows up as `loop`.
export const WATCHDOG_ALERT_MS = 5 * 60_000
export const WATCHDOG_STALL_MS = 20 * 60_000
export const WATCHDOG_EVERY_MS = 60_000
export const RESTART_STORM_MAX = 3
// Watchdog exits are at least WATCHDOG_STALL_MS apart, so the window must hold RESTART_STORM_MAX + 1 stall periods with
// slack (launchd throttle, startup); 60 min could never see 3 exits from a daemon that hangs after every restart.
export const RESTART_STORM_WINDOW_MS = 3 * 60 * 60_000

export class Watchdog {
  private last: number
  private running = new Map<string, number>()
  private alerted = new Set<string>()
  private stormAsked = false
  constructor(private readonly home: string, private readonly now: () => number, private readonly exit: (code: number) => void) {
    this.last = now()
  }
  /** The loop finished a pass. */
  progress() { this.last = this.now() }
  /** Counts `name` as running until `p` settles. */
  track<T>(name: string, p: Promise<T>): Promise<T> {
    const since = this.now()
    this.running.set(name, since)
    p.finally(() => { if (this.running.get(name) === since) this.running.delete(name) }).catch(() => {})
    return p
  }
  private event(kind: string, severity: 'act' | 'ask', idTail: string, data: Record<string, unknown>) {
    const id = `${kind}:${idTail}`
    console.log(`SUPERVISOR_WATCHDOG ${kind} ${JSON.stringify(data)}`)
    try { appendSupEvent(this.home, { id, kind, severity, lane: 'dori-supervisor', durableId: '', generation: 0, pane: null, thread: null, data }) }
    catch (e: any) { console.log(`SUPERVISOR_WATCHDOG_EVENT_FAILED ${kind} ${e?.message ?? e}`) }
  }
  check() {
    const now = this.now()
    const items: [string, number][] = [['loop', this.last], ...this.running]
    for (const [name, since] of items) {
      const key = `${name}:${since}`
      if (now - since < WATCHDOG_ALERT_MS || this.alerted.has(key)) continue
      this.alerted.add(key)
      this.event('supervisor.stalled', 'act', key, { name, minutes: Math.round((now - since) / 60_000), restartAtMin: WATCHDOG_STALL_MS / 60_000 })
    }
    const stuck = items.find(([, since]) => now - since >= WATCHDOG_STALL_MS)
    if (!stuck) return
    const f = join(this.home, 'state', 'supervisor-restarts.json')
    const exits = readJson<{ exits?: number[] }>(f, {}).exits?.filter((t) => typeof t === 'number' && now - t < RESTART_STORM_WINDOW_MS) ?? []
    if (exits.length >= RESTART_STORM_MAX) {
      if (this.stormAsked) return
      this.stormAsked = true
      this.event('supervisor.restart_storm', 'ask', String(exits[0]), {
        name: stuck[0], exits: exits.length, windowMin: RESTART_STORM_WINDOW_MS / 60_000,
        note: 'watchdog restarts did not help; staying up (stuck) instead of exiting again. Check the supervisor log, then launchctl kickstart -k gui/$UID/<launchd.prefix>.supervisor',
      })
      return
    }
    atomicWrite(f, JSON.stringify({ exits: [...exits, now] }))
    this.event('supervisor.watchdog_exit', 'act', `${stuck[0]}:${stuck[1]}`, { name: stuck[0], minutes: Math.round((now - stuck[1]) / 60_000), exit: 1 })
    this.exit(1)
  }
}

export const liveDeps = (write: boolean, home = doriHome()): SupDeps => ({
  home, now: Date.now, openLink: openSocketLink, scanEndpoints: () => scanEndpoints(), hostStatus: () => hostStatus(),
  panesAlive, dagRuns: () => readDagRuns(), taskRecords: (cwds) => readTaskRecords(cwds), loadMap: () => readMap(home), connectTimeoutMs: 2_000, requestTimeoutMs: 10_000,
  write, log: (l) => console.log(l),
})

async function daemon() {
  const home = doriHome()
  const p = supPaths(home)
  mkdirSync(dirname(p.lock), { recursive: true, mode: 0o700 })
  chmodSync(dirname(p.lock), 0o700)
  const held = await acquireDirLock(p.lock, { waitMs: 0 }).catch((e) => { console.log(`SUPERVISOR_LOCKED ${e?.message ?? e}`); return null })
  if (!held) { await Bun.sleep(60_000); process.exit(0) }
  process.on('exit', () => held.release())
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0))
  let waitingLogged = false
  while (!existsSync(p.observeFlag)) {
    if (!waitingLogged) { console.log(`SUPERVISOR_WAITING missing ${p.observeFlag}`); waitingLogged = true }
    await Bun.sleep(30_000)
  }
  const sup = new Supervisor(liveDeps(true, home))
  const policies = new Policies(sup, (await livePolicyDeps(home)).deps)
  console.log('SUPERVISOR_READY')
  const watchdog = new Watchdog(home, Date.now, (code) => { sup.close(); process.exit(code) })
  setInterval(() => watchdog.check(), WATCHDOG_EVERY_MS)
  let lastHostStatus = 0
  let lastPolicy = 0
  let lastLate = 0
  const lateDeps: LateReceiptDeps = { map: () => readMap(home), find: (await import('./sess')).findSessionFile, receipt: (await import('./rpc')).receipt }
  let policyRun: Promise<void> | null = null
  for (;;) {
    if (!existsSync(p.observeFlag)) { console.log('SUPERVISOR_STOP observe flag removed'); sup.close(); process.exit(0) }
    const now = Date.now()
    const withStatus = now - lastHostStatus >= 15_000
    if (withStatus) lastHostStatus = now
    try { await sup.rescan({ hostStatus: withStatus }); sup.writeLaneStatus() } catch (e: any) { console.log(`SUPERVISOR_ERROR ${e?.message ?? e}`) }
    watchdog.progress()
    if (now - lastLate >= 60_000) {
      lastLate = now
      try { for (const id of settleLateReceipts(home, now, lateDeps)) console.log(`SUPERVISOR_LATE_RECEIPT ${id}`) } catch (e: any) { console.log(`SUPERVISOR_LATE_RECEIPT_ERROR ${e?.message ?? e}`) }
    }
    // Policies run beside the observer (a transition can take minutes); one tick at a time, every 60 s.
    if (!policyRun && now - lastPolicy >= 60_000) {
      lastPolicy = now
      policyRun = watchdog.track('policy', policies.tick()).catch((e: any) => console.log(`SUPERVISOR_POLICY_ERROR ${e?.message ?? e}`)).finally(() => { policyRun = null })
    }
    await Bun.sleep(10_000)
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  if (argv.includes('--adopt')) {
    const key = argv[argv.indexOf('--adopt') + 1], to = argv[argv.indexOf('--session') + 1]
    if (!key || !to || !argv.includes('--session')) { console.log('usage: dori-supervisor.ts --adopt <key> --session <durableId>'); process.exit(2) }
    const home = doriHome()
    const { adoptCtx } = await livePolicyDeps(home)
    const entry = readMap(home)[key]
    const op = adoptCtx.ledger.create('adopt', key, { from: entry?.sessionId ?? null, to, via: 'manual' })
    const r = await adoptReplacement(adoptCtx, op.opId)
    console.log(JSON.stringify(r.out))
    process.exit(r.exit)
  }
  if (argv.includes('--once')) {
    const sup = new Supervisor(liveDeps(false))
    await sup.rescan()
    const snap = sup.snapshot()
    sup.close()
    console.log(argv.includes('--json') ? JSON.stringify(snap) : JSON.stringify(snap, null, 1))
    process.exit(0)
  }
  await daemon()
}
