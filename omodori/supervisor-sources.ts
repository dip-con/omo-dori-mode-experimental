// Inputs of the Dandori supervisor (redesign S4, docs/dori-redesign/final.md §2.3/§2.5).
// Read-only sources: the endpoint registry (rpc-host-daemon/*/endpoint.json), `omo host status`, herdr-dag run files,
// and the herdr pane list (pane presence only, never screen reads). Plus the one live link type the supervisor holds
// per reachable endpoint: a socket that sends observe-only requests and receives session_status / feed records.
// Socket secrets are read into memory only and never logged.
import { createConnection, type Socket } from 'node:net'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.HOME!
export const AGENT_DIR = `${HOME}/.omo/agent`

export type EndpointKind = 'tui' | 'rpc_host'
export type Endpoint = { kind: EndpointKind; socket: string }

/** The subscription every endpoint gets (final.md §2.3 input 2; review 10: workers must be asked for). */
export const SUBSCRIBE_SESSIONS = Object.freeze({
  type: 'subscribe_sessions', sessions: 'all', include_workers: true, include_context: true, effects: true,
})

/** endpoint.json records; a record without endpoint_kind is the pre-registry multi-session host (rpc.sock). */
export function scanEndpoints(root = `${AGENT_DIR}/rpc-host-daemon`): Endpoint[] {
  let dirs: string[]
  try { dirs = readdirSync(root) } catch { return [] }
  const out: Endpoint[] = []
  for (const d of dirs) {
    try {
      const rec = JSON.parse(readFileSync(join(root, d, 'endpoint.json'), 'utf8'))
      if (typeof rec.socket !== 'string') continue
      out.push({ kind: rec.endpoint_kind === 'tui' ? 'tui' : 'rpc_host', socket: rec.socket })
    } catch { continue }
  }
  return out
}

export type HostStatusRow = { socket: string; reachable: boolean; instanceId: string | null; generation: number | null; kind: EndpointKind }
/** `omo host status --json --all --include-workers`; null when the command fails (the scan still stands alone). */
export async function hostStatus(timeoutMs = 20_000): Promise<HostStatusRow[] | null> {
  const p = Bun.spawn(['omo', 'host', 'status', '--json', '--all', '--include-workers'], { stdout: 'pipe', stderr: 'ignore', cwd: HOME })
  const timer = setTimeout(() => p.kill(), timeoutMs)
  try {
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
    if (code !== 0) return null
    const rows: any[] = JSON.parse(out).endpoints ?? []
    return rows.filter((r) => typeof r.socket === 'string').map((r) => ({
      socket: r.socket, reachable: r.reachable === true, instanceId: r.instanceId ?? null, generation: r.generation ?? null,
      kind: r.endpoint_kind === 'tui' ? 'tui' : 'rpc_host',
    }))
  } catch { return null } finally { clearTimeout(timer) }
}

export type DagRun = { id: string; status: string; nodes: { id: string; state: string; taskId: string | null }[] }
export type DagFile = { sessionId: string; runs: DagRun[]; mtimeMs: number }
/** AGENT/herdr-dag/<hex>.json, keyed by the owning session's durable id. */
export function readDagRuns(dir = `${AGENT_DIR}/herdr-dag`): Map<string, DagFile> {
  const out = new Map<string, DagFile>()
  let files: string[] = []
  try { files = readdirSync(dir).filter((f) => /^[0-9a-f]+\.json$/.test(f)) } catch { return out }
  for (const f of files) {
    try {
      const p = join(dir, f)
      const o = JSON.parse(readFileSync(p, 'utf8'))
      if (typeof o.sessionId !== 'string') continue
      const runs: DagRun[] = (o.runs ?? []).map((r: any) => ({
        id: r.id, status: r.status, nodes: (r.nodes ?? []).map((n: any) => ({ id: n.id, state: n.state, taskId: n.taskId ?? null })),
      }))
      const prev = out.get(o.sessionId)
      const mtimeMs = statSync(p).mtimeMs
      out.set(o.sessionId, prev ? { ...prev, runs: [...prev.runs, ...runs], mtimeMs: Math.max(prev.mtimeMs, mtimeMs) } : { sessionId: o.sessionId, runs, mtimeMs })
    } catch { continue }
  }
  return out
}

/** Pane ids Herdr knows (`herdr pane list`); null when Herdr does not answer, so absence is never guessed. */
export async function panesAlive(): Promise<Set<string> | null> {
  const p = Bun.spawn(['herdr', 'pane', 'list'], { stdout: 'pipe', stderr: 'ignore' })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  if (code !== 0) return null
  try { return new Set((JSON.parse(out).result?.panes ?? []).map((x: any) => x.pane_id as string)) } catch { return null }
}

/** One open connection to an endpoint. `dead` = nothing listens; `unreachable` = something is there but did not answer. */
export interface Link {
  request(command: Record<string, unknown>, timeoutMs?: number): Promise<any>
  onEvent(fn: (rec: any) => void): void
  onClose(fn: (why: string) => void): void
  close(): void
}
export type OpenResult = { ok: true; link: Link } | { ok: false; state: 'dead' | 'unreachable'; code: string }
export type OpenLink = (socket: string, timeoutMs: number) => Promise<OpenResult>

const DEAD_CODES = new Set(['ENOENT', 'ECONNREFUSED'])

class SocketLink implements Link {
  private buf = ''
  private seq = 0
  private pending = new Map<string, { resolve: (r: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private events: ((rec: any) => void)[] = []
  private closes: ((why: string) => void)[] = []
  private ended = false
  constructor(private socket: Socket) {
    socket.setEncoding('utf8')
    socket.on('data', (d: string) => this.onData(d))
    const gone = (why: string) => {
      if (this.ended) return
      this.ended = true
      for (const [k, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`transport_gone:${why}`)); this.pending.delete(k) }
      for (const f of this.closes) f(why)
    }
    socket.on('close', () => gone('closed'))
    socket.on('error', (e: any) => gone(e?.code ?? 'error'))
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
      } else for (const f of this.events) f(o)
    }
  }
  request(command: Record<string, unknown>, timeoutMs = 10_000): Promise<any> {
    if (this.ended) return Promise.reject(new Error('transport_gone:closed'))
    const id = `sup_${++this.seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(`${JSON.stringify({ ...command, id })}\n`)
    })
  }
  onEvent(fn: (rec: any) => void) { this.events.push(fn) }
  onClose(fn: (why: string) => void) { this.closes.push(fn) }
  close() { this.ended = true; this.socket.destroy() }
}

/** Terminal control sockets take a 32-byte secret first; POSIX host sockets take none (RT tui-socket.js socketNeedsHandshake). */
export const openSocketLink: OpenLink = async (socketPath, timeoutMs) => {
  let secret: Buffer | null = null
  try { secret = readFileSync(`${socketPath}.secret`) } catch (e: any) {
    if (e?.code !== 'ENOENT') return { ok: false, state: 'unreachable', code: `secret_${e?.code ?? 'unreadable'}` }
  }
  if (secret && secret.length !== 32) return { ok: false, state: 'unreachable', code: 'secret_invalid' }
  const socket = createConnection(socketPath)
  const err = await new Promise<string | null>((res) => {
    const t = setTimeout(() => { socket.destroy(); res('connect_timeout') }, timeoutMs)
    socket.once('connect', () => { clearTimeout(t); res(null) })
    socket.once('error', (e: any) => { clearTimeout(t); res(e?.code ?? 'connect_error') })
  })
  if (err) return { ok: false, state: DEAD_CODES.has(err) ? 'dead' : 'unreachable', code: err }
  if (secret) socket.write(secret)
  return { ok: true, link: new SocketLink(socket) }
}
