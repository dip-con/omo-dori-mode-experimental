// Dori event router (redesign S6): the single entry from machine events to the lead.
//   stdin = the dori sweeps' legacy lines (LANE_QUOTA ..., NUDGED ..., source monitor lines) mixed with supervisor events
//           (JSON lines from `tail -n +1 -F events/supervisor.ndjson`, see dori-monitors.sh)
//   stdout = only `DORI_ASK <json>` (now) and `DORI_DIGEST <json>` (every 15 min, 60 min at night KST; omitted when empty)
// Classification is data: event-rules.json (kind -> ask/act/info/fail/drop) plus the event-rules.json of each enabled
// messenger source (checked first). The router classifies and aggregates; it never executes anything.
//   bun event-router.ts [--events <supervisor.ndjson>]   follow mode: checkpoint in $OMODORI_HOME/state/router-cursor.json
//   bun event-router.ts --now                            read stdin to EOF, print asks + one digest, keep no state
// Checkpoint {fileIno, offset, lastEventId, seen[], pending}: an event id is routed at most once across restarts.
// With --events the router locates each JSON line in the file (same inode -> skip up to the saved offset; a new inode
// or a truncated file -> read from offset 0 but skip through lastEventId and every id already seen).
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { doriHome } from './config'
import { eventRuleFiles } from './sources'

export type Route = 'ask' | 'act' | 'info' | 'fail' | 'drop'
type EventRule = { kind: string; when?: { path: string; eq?: unknown; gt?: number }; route: Route }
type LegacyRule = { re: string; kind: string; route: Route }
export type Rules = {
  digestEveryMin: number; nightDigestEveryMin: number; nightKst: { from: string; to: string }; maxItemsPerList: number
  defaults: { event: Route; legacyVisible: string; legacyUnmatched: Route }
  events: EventRule[]; legacy: LegacyRule[]
}
export type Item = { kind: string; at: string; id?: string; lane?: string | null; pane?: string | null; thread?: string | null; text?: string; herdr?: unknown }
export type Pending = { act: Item[]; info: Item[]; fail: Item[]; dueAt: number | null }
export type Cursor = { v: 1; fileIno: number | null; offset: number; lastEventId: string | null; seen: string[]; pending: Pending }

const SEEN_MAX = 5000
export const DORI_HOME = doriHome()
export const CURSOR_PATH = `${DORI_HOME}/state/router-cursor.json`
export const RULES_PATH = process.env.EVENT_RULES ?? `${import.meta.dir}/event-rules.json`

type SourceRules = { events?: EventRule[]; legacy?: LegacyRule[]; legacyVisible?: string }
export function loadRules(path = RULES_PATH, extra: string[] = eventRuleFiles()): Rules {
  const rules: Rules = JSON.parse(readFileSync(path, 'utf8'))
  for (const f of extra) {
    const s: SourceRules = JSON.parse(readFileSync(f, 'utf8'))
    rules.events = [...(s.events ?? []), ...rules.events]
    rules.legacy = [...(s.legacy ?? []), ...rules.legacy]
    if (s.legacyVisible) rules.defaults.legacyVisible = `(?:${rules.defaults.legacyVisible})|(?:${s.legacyVisible})`
  }
  return rules
}
export const emptyCursor = (): Cursor => ({ v: 1, fileIno: null, offset: 0, lastEventId: null, seen: [], pending: { act: [], info: [], fail: [], dueAt: null } })
export function loadCursor(path: string): Cursor {
  if (!existsSync(path)) return emptyCursor()
  const c = JSON.parse(readFileSync(path, 'utf8'))
  return { ...emptyCursor(), ...c, pending: { ...emptyCursor().pending, ...(c.pending ?? {}) } }
}

const get = (o: any, path: string) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o)

export function classifyEvent(ev: any, rules: Rules): Route {
  for (const r of rules.events) {
    if (r.kind !== ev.kind) continue
    if (r.when) {
      const v = get(ev, r.when.path)
      if ('eq' in r.when && v !== r.when.eq) continue
      if (r.when.gt !== undefined && !(typeof v === 'number' && v > r.when.gt)) continue
    }
    return r.route
  }
  const s = ev.severity
  return s === 'ask' || s === 'act' || s === 'info' ? s : rules.defaults.event
}

const reCache = new Map<string, RegExp>()
const re = (s: string) => { let r = reCache.get(s); if (!r) reCache.set(s, (r = new RegExp(s))); return r }
export function classifyLegacy(line: string, rules: Rules): { route: Route; kind: string } {
  for (const r of rules.legacy) if (re(r.re).test(line)) return { route: r.route, kind: r.kind }
  if (re(rules.defaults.legacyVisible).test(line)) return { route: rules.defaults.legacyUnmatched, kind: 'legacy.unclassified' }
  return { route: 'drop', kind: 'legacy.noise' }
}

/** The OMODORI_HERDR payload herdr-watch used to print for this event (kept inside DORI_ lines for the lead's relays). */
export function herdrCompat(ev: any): unknown {
  switch (ev.kind) {
    case 'lane.turn_done': return { event: 'turn_done', pane: ev.pane, session: ev.lane, thread: ev.thread ?? null, source: 'rpc', id: ev.id, turn_epoch: ev.data?.turn_epoch ?? null }
    case 'lane.gone': return { event: 'gone', pane: ev.pane, session: ev.lane, source: 'rpc', id: ev.id }
    case 'lane.question': return { event: 'question', pane: ev.pane, agent: null, cwd: null, session: ev.lane, source: 'rpc', id: ev.id }
    default: return undefined
  }
}

const kstMinutes = (ms: number) => { const d = new Date(ms + 9 * 3600_000); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const hm = (s: string) => { const [h, m] = s.split(':').map(Number); return h! * 60 + m! }
export function digestEveryMs(rules: Rules, now: number): number {
  const m = kstMinutes(now), from = hm(rules.nightKst.from), to = hm(rules.nightKst.to)
  const night = from > to ? m >= from || m < to : m >= from && m < to
  return (night ? rules.nightDigestEveryMin : rules.digestEveryMin) * 60_000
}

/** A line is an act failure when the event says so; failures are forced into the digest's fail list, never info. */
const failed = (ev: any) => ev.data?.ok === false || ev.data?.error != null || /(_failed|\.failed)$/.test(String(ev.kind))

export type RouterOpts = { rules: Rules; cursor?: Cursor; cursorPath?: string | null; eventsPath?: string | null; out: (line: string) => void; now?: () => number }

export class Router {
  rules: Rules; cursor: Cursor; cursorPath: string | null; eventsPath: string | null; out: (l: string) => void; now: () => number
  private seen: Set<string>
  // position of the stream inside the events file generation it is currently reading
  private fd: number | null = null
  private ino: number | null = null
  private pos = 0
  private offsetValid = false // the saved offset applies to this generation (same inode, not truncated)
  private skipThrough = false // new generation that still contains lastEventId: skip lines up to and including it
  // lines are printed only after the checkpoint that covers them is on disk: a restart never re-emits a printed line
  private outbox: string[] = []
  private commit() { this.save(); for (const l of this.outbox.splice(0)) this.out(l) }

  constructor(o: RouterOpts) {
    this.rules = o.rules; this.cursor = o.cursor ?? emptyCursor(); this.cursorPath = o.cursorPath ?? null
    this.eventsPath = o.eventsPath ?? null; this.out = o.out; this.now = o.now ?? Date.now
    this.seen = new Set(this.cursor.seen)
    if (this.eventsPath && existsSync(this.eventsPath)) this.startGeneration(openSync(this.eventsPath, 'r'), true)
  }

  private startGeneration(fd: number, atStartup: boolean) {
    if (this.fd !== null && this.fd !== fd) closeSync(this.fd)
    const st = fstatSync(fd)
    this.fd = fd; this.ino = Number(st.ino); this.pos = 0
    this.offsetValid = atStartup && this.ino === this.cursor.fileIno && st.size >= this.cursor.offset
    const last = this.cursor.lastEventId
    this.skipThrough = !this.offsetValid && last !== null && readFileSync(this.eventsPath!, 'utf8').includes(`"id":${JSON.stringify(last)}`)
  }

  private matchesAt(fd: number, pos: number, bytes: Buffer): boolean {
    const b = Buffer.alloc(bytes.length)
    return readSync(fd, b, 0, bytes.length, pos) === bytes.length && b.equals(bytes)
  }

  /** End offset of this line in the current events-file generation, or null when it cannot be located. */
  private locate(line: string): number | null {
    if (!this.eventsPath) return null
    const bytes = Buffer.from(`${line}\n`)
    if (this.fd !== null && this.matchesAt(this.fd, this.pos, bytes)) return (this.pos += bytes.length)
    if (!existsSync(this.eventsPath)) return null
    const fd = openSync(this.eventsPath, 'r')
    if (this.matchesAt(fd, 0, bytes)) { // tail -F switched to a replaced/truncated file and replays it from line 1
      this.startGeneration(fd, false)
      return (this.pos = bytes.length)
    }
    closeSync(fd)
    return null
  }

  line(raw: string) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) return
    if (line.startsWith('{')) {
      let ev: any
      try { ev = JSON.parse(line) } catch { ev = null }
      if (ev && typeof ev.kind === 'string') return this.event(ev, line)
    }
    const { route, kind } = classifyLegacy(line, this.rules)
    if (route === 'drop') return
    const item: Item = { kind, at: new Date(this.now()).toISOString(), lane: /^[A-Z_]+ (\S+)/.exec(line)?.[1] ?? null, text: line.slice(0, 400) }
    this.route(route, item)
    this.commit()
  }

  private event(ev: any, line: string) {
    const end = this.locate(line)
    const id: string = typeof ev.id === 'string' ? ev.id : `${ev.kind}:${Bun.hash(line).toString(16)}`
    let skip = false
    if (end !== null && this.offsetValid && end <= this.cursor.offset) skip = true
    else if (this.skipThrough) { skip = true; if (id === this.cursor.lastEventId) this.skipThrough = false }
    else if (this.seen.has(id)) skip = true
    if (!skip) {
      let route = classifyEvent(ev, this.rules)
      if ((route === 'act' || route === 'info') && failed(ev)) route = 'fail'
      if (route !== 'drop') {
        this.route(route, { kind: ev.kind, at: ev.at ?? new Date(this.now()).toISOString(), id, lane: ev.lane ?? null, pane: ev.pane ?? null, thread: ev.thread ?? null, herdr: herdrCompat(ev) })
      }
      this.seen.add(id)
      this.cursor.lastEventId = id
    }
    if (end !== null) { this.cursor.fileIno = this.ino; this.cursor.offset = Math.max(end, this.offsetValid ? this.cursor.offset : 0); this.offsetValid = true }
    this.commit()
  }

  private route(route: Route, item: Item) {
    if (route === 'drop') return
    if (route === 'ask') { this.outbox.push(`DORI_ASK ${JSON.stringify(item)}`); return }
    const p = this.cursor.pending
    p[route].push(item)
    if (p.dueAt === null) p.dueAt = this.now() + digestEveryMs(this.rules, this.now())
  }

  flush(force = false): boolean {
    const p = this.cursor.pending
    if (!p.act.length && !p.info.length && !p.fail.length) { p.dueAt = null; return false }
    if (!force && (p.dueAt === null || this.now() < p.dueAt)) return false
    const max = this.rules.maxItemsPerList
    const counts = { act: p.act.length, info: p.info.length, fail: p.fail.length }
    const more = Object.fromEntries(Object.entries(counts).filter(([, n]) => n > max).map(([k, n]) => [k, n - max]))
    const d = { at: new Date(this.now()).toISOString(), counts, act: p.act.slice(0, max), info: p.info.slice(0, max), fail: p.fail.slice(0, max), ...(Object.keys(more).length ? { more } : {}) }
    this.outbox.push(`DORI_DIGEST ${JSON.stringify(d)}`)
    this.cursor.pending = { act: [], info: [], fail: [], dueAt: null }
    this.commit()
    return true
  }

  save() {
    if (!this.cursorPath) return
    const seen = [...this.seen]
    if (seen.length > SEEN_MAX) this.seen = new Set(seen.slice(-SEEN_MAX))
    this.cursor.seen = [...this.seen]
    mkdirSync(dirname(this.cursorPath), { recursive: true })
    const tmp = `${this.cursorPath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.cursor))
    renameSync(tmp, this.cursorPath)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const now = argv.includes('--now')
  const e = argv.indexOf('--events')
  const eventsPath = e >= 0 ? argv[e + 1]! : null
  const out = (l: string) => process.stdout.write(`${l}\n`)
  const router = new Router({
    rules: loadRules(), out, eventsPath,
    cursor: now ? emptyCursor() : loadCursor(CURSOR_PATH),
    cursorPath: now ? null : CURSOR_PATH,
  })
  const timer = now ? null : setInterval(() => {
    try { router.flush() } catch (err) { out(`DORI_ASK ${JSON.stringify({ kind: 'router.error', at: new Date().toISOString(), text: `digest: ${(err as Error).message}` })}`) }
  }, 30_000)
  let buf = ''
  const take = (s: string) => {
    buf += s
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1)
      try { router.line(l) } catch (err) {
        // a line the router cannot handle is never silently lost: it goes to the digest's fail list
        router.cursor.pending.fail.push({ kind: 'router.error', at: new Date().toISOString(), text: `${(err as Error).message}: ${l.slice(0, 300)}` })
      }
    }
  }
  const dec = new TextDecoder()
  for await (const chunk of Bun.stdin.stream()) take(dec.decode(chunk, { stream: true }))
  take(dec.decode() + (buf ? '\n' : ''))
  if (timer) clearInterval(timer)
  router.flush(true)
}

if (import.meta.main) {
  try { if (statSync(RULES_PATH).size === 0) throw new Error('empty rules') } catch (err) {
    console.log(`DORI_ASK ${JSON.stringify({ kind: 'router.error', at: new Date().toISOString(), text: `event-rules.json: ${(err as Error).message}` })}`)
    process.exit(1)
  }
  main().catch((err) => {
    console.log(`DORI_ASK ${JSON.stringify({ kind: 'router.crash', at: new Date().toISOString(), text: String((err as Error)?.stack ?? err).slice(0, 400) })}`)
    process.exit(1)
  })
}
