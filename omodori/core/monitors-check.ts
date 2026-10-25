// Standing-monitor check for the lead (dori-improve 3). Definitions: ~/.omodori/monitors.json.
//   bun monitors-check.ts            after a lead restart: one line per monitor; MISSING/EXPIRING/DRIFT lines end
//                                    with the exact tool.monitor(...) call to paste
//   bun monitors-check.ts --loop 30  (inside dori-monitors.sh) emits MONITOR_MISSING / MONITOR_EXPIRING (day 6 of 7)
//                                    / MONITOR_DRIFT (registered filter differs from monitors.json) once per change
//   bun monitors-check.ts --once     same as no flag (explicit one-shot)
//   bun monitors-check.ts --wakes [--hours 24]  counts monitor wakes in the lead session logs: total, DORI_ASK, non-ask/h
// "Registered at" is read from the lead's own tool calls in its newest LEAD_FILES session logs, so a lead session
// replaced by /handoff or a restart still finds the registrations made in the previous one (redesign S6).
// "Running" means a matching process under the lead pane, or under any process started with --session <lead session id>.
// A monitor that is not running within REPLACED_GRACE_MS of a lead session replacement, while its registration in the
// previous session is still valid, is MONITOR_PENDING (restore in progress), not MONITOR_MISSING.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { doriHome, cfg as doriCfg } from './config'

const HOME = process.env.HOME!
const DORI_HOME = doriHome()
const SESSIONS_ROOT = process.env.OMO_SESSIONS_DIR ?? `${HOME}/.omo/agent/sessions`
const LEAD_FILES = 3
const REPLACED_GRACE_MS = 3600_000
const STATE = `${DORI_HOME}/monitors-check-state.json`
const DAY = 86_400_000

export type MonitorDef = { name: string; match: string; description: string; command: string; filter: string }
export type Registration = { at: number; filter?: string }
export type Status = { def: MonitorDef; running: boolean; reg?: Registration; ageDays?: number; expiresAt?: number; problems: ('missing' | 'pending' | 'expiring' | 'expired' | 'drift')[] }

export const monitorCall = (d: MonitorDef) =>
  `tool.monitor({ description: ${JSON.stringify(d.description)}, command: ${JSON.stringify(d.command)}, filter: ${JSON.stringify(d.filter)}, persistent: true })`

export function registrations(sessionText: string, defs: MonitorDef[]): Map<string, Registration> {
  const out = new Map<string, Registration>()
  for (const line of sessionText.split('\n')) {
    if (!line.includes('persistent')) continue
    let j: any
    try { j = JSON.parse(line) } catch { continue }
    if (j.message?.role !== 'assistant') continue
    for (const b of j.message.content ?? []) {
      if (b.type !== 'toolCall') continue
      const a = b.arguments ?? {}
      const s = typeof a.code === 'string' ? a.code : ''
      for (const call of s.split('tool.monitor(').slice(1)) {
        if (!/persistent\s*:\s*true/.test(call)) continue
        const d = defs.find((x) => call.includes(x.match))
        if (!d) continue
        const f = /filter\s*:\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(call)?.[2]?.replace(/\\(.)/g, '$1')
        out.set(d.name, { at: Date.parse(j.timestamp), filter: f })
      }
    }
  }
  return out
}

export function evaluate(defs: MonitorDef[], running: Set<string>, regs: Map<string, Registration>, now: number, expireDays = 7, warnDays = 6, replacedAt?: number): Status[] {
  return defs.map((def) => {
    const reg = regs.get(def.name)
    const problems: Status['problems'] = []
    const ageDays = reg ? (now - reg.at) / DAY : undefined
    const expiresAt = reg ? reg.at + expireDays * DAY : undefined
    const restoring = replacedAt !== undefined && now - replacedAt < REPLACED_GRACE_MS && reg !== undefined && reg.at < replacedAt && expiresAt! > now
    if (!running.has(def.name)) problems.push(restoring ? 'pending' : 'missing')
    if (ageDays !== undefined && ageDays >= expireDays) problems.push('expired')
    else if (ageDays !== undefined && ageDays >= warnDays) problems.push('expiring')
    if (reg?.filter !== undefined && reg.filter !== def.filter) problems.push('drift')
    return { def, running: running.has(def.name), reg, ageDays, expiresAt, problems }
  })
}

const kst = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ') + ' KST'

export function lines(st: Status[]): string[] {
  return st.map((s) => {
    const reg = s.reg ? `registered ${kst(s.reg.at)} (${s.ageDays!.toFixed(1)}d, expires ${kst(s.expiresAt!)})` : 'registration not found in lead session'
    if (!s.problems.length) return `MONITOR_OK ${s.def.name} running; ${reg}`
    const tag = s.problems.includes('missing') ? 'MONITOR_MISSING' : s.problems.includes('pending') ? 'MONITOR_PENDING' : s.problems.includes('expired') || s.problems.includes('expiring') ? 'MONITOR_EXPIRING' : 'MONITOR_DRIFT'
    const drift = s.problems.includes('drift') ? `; registered filter ${JSON.stringify(s.reg?.filter)} != monitors.json` : ''
    return `${tag} ${s.def.name} [${s.problems.join(',')}] ${reg}${drift} -> re-register: ${monitorCall(s.def)}`
  })
}

/** Session ids that belong to the lead: every sessions-map entry under the prefix (open or not) plus the lead pane argv. */
function leadSessionIds(prefix: string, paneIds: string[]): Set<string> {
  const ids = new Set(paneIds)
  try {
    const map = JSON.parse(readFileSync(`${DORI_HOME}/sessions-map.json`, 'utf8'))
    for (const e of Object.values<any>(map)) if (String(e?.key).startsWith(prefix) && e.sessionId) ids.add(String(e.sessionId))
  } catch {}
  return ids
}

const birthOf = (path: string) => {
  const m = /(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z_[^/]*$/.exec(path)
  return m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : statSync(path).birthtimeMs
}

/** Lead session logs, newest first (by start time): files named _<lead session id>.jsonl or *dori-lead*.jsonl. */
export function leadSessionFiles(prefix: string, ids: Set<string>, root = SESSIONS_ROOT): string[] {
  const out: string[] = []
  for (const d of existsSync(root) ? readdirSync(root) : []) {
    let fs: string[] = []
    try { fs = readdirSync(join(root, d)) } catch { continue }
    for (const f of fs) {
      if (!f.endsWith('.jsonl')) continue
      const id = /_([^_]+)\.jsonl$/.exec(f)?.[1]
      if ((id && ids.has(id)) || f.includes(prefix)) out.push(join(root, d, f))
    }
  }
  return out.sort((a, b) => birthOf(b) - birthOf(a))
}

/** Registrations across the newest lead logs; the latest registration of each monitor wins. */
export function leadRegistrations(files: string[], defs: MonitorDef[]): Map<string, Registration> {
  const regs = new Map<string, Registration>()
  for (const f of files.slice(0, LEAD_FILES)) {
    for (const [k, r] of registrations(readFileSync(f, 'utf8'), defs)) if (!(regs.get(k)?.at! >= r.at)) regs.set(k, r)
  }
  return regs
}

function leadPane(leadPane: string): { pids: Set<number>; sessionIds: string[] } {
  const info = Bun.spawnSync(['herdr', 'pane', 'process-info', '--pane', leadPane], { stdout: 'pipe' })
  const pids = new Set<number>()
  const sessionIds: string[] = []
  try {
    const pi = JSON.parse(info.stdout.toString()).result.process_info
    for (const f of pi.foreground_processes ?? []) {
      pids.add(f.pid)
      const argv: string[] = f.argv ?? []
      const i = argv.indexOf('--session')
      if (i >= 0 && argv[i + 1]) sessionIds.push(argv[i + 1]!)
    }
    if (pi.foreground_process_group_id) pids.add(pi.foreground_process_group_id)
  } catch {}
  return { pids, sessionIds }
}

function runningUnderLead(defs: MonitorDef[], leadPids: Set<number>, leadIds: Set<string>): Set<string> {
  const ps = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,command='], { stdout: 'pipe' }).stdout.toString()
  const procs = ps.split('\n').flatMap((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); return m ? [{ pid: +m[1]!, ppid: +m[2]!, cmd: m[3]! }] : [] })
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]))
  const leadProc = (p: { pid: number; cmd: string }) => leadPids.has(p.pid) || [...leadIds].some((id) => p.cmd.includes(`--session ${id}`))
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const underLead = (pid: number) => { for (let p = pid, n = 0; p > 1 && n < 40; p = parent.get(p) ?? 0, n++) { const q = byPid.get(p); if (leadPids.has(p) || (q && leadProc(q))) return true } return false }
  return new Set(defs.filter((d) => procs.some((p) => p.cmd.includes(d.match) && underLead(p.pid))).map((d) => d.name))
}

export function check(now = Date.now()): Status[] {
  const cfg = JSON.parse(readFileSync(`${DORI_HOME}/monitors.json`, 'utf8'))
  const prefix = cfg.leadKeyPrefix ?? doriCfg.lead.keyPrefix
  let paneId = 'wW:p6'
  try { paneId = JSON.parse(readFileSync(`${HOME}/.dori/config.json`, 'utf8')).leadPane ?? paneId } catch {}
  const pane = leadPane(paneId)
  const ids = leadSessionIds(prefix, pane.sessionIds)
  const files = leadSessionFiles(prefix, ids)
  const regs = leadRegistrations(files, cfg.monitors)
  const replacedAt = files.length > 1 ? birthOf(files[0]!) : undefined
  return evaluate(cfg.monitors, runningUnderLead(cfg.monitors, pane.pids, ids), regs, now, cfg.expireDays, cfg.warnDays, replacedAt)
}

export type Wakes = { hours: number; total: number; ask: number; nonAsk: number; nonAskPerHour: number; standingNonAsk: number; standingNonAskPerHour: number; byMonitor: Record<string, number> }
/** Monitor wakes (senpi-monitor:notification entries) in the lead logs during the last `hours`; a wake carrying DORI_ASK is an ask. */
/** standing = a wake from a monitors.json monitor (matched on the first 20 description chars, so a renamed description still counts); the rest are the lead's own one-shot watches. */
export function wakes(files: string[], hours: number, now = Date.now(), standing: string[] = []): Wakes {
  const since = now - hours * 3600_000
  const w: Wakes = { hours, total: 0, ask: 0, nonAsk: 0, nonAskPerHour: 0, standingNonAsk: 0, standingNonAskPerHour: 0, byMonitor: {} }
  const isStanding = (d: string) => standing.some((s) => d.slice(0, 20) === s.slice(0, 20))
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('senpi-monitor:notification')) continue
      let j: any
      try { j = JSON.parse(line) } catch { continue }
      if (j.customType !== 'senpi-monitor:notification' || !(Date.parse(j.timestamp) >= since)) continue
      const text = typeof j.content === 'string' ? j.content : JSON.stringify(j.content ?? '')
      w.total++
      const ds: string[] = (j.details?.monitors ?? []).map((m: any) => String(m.description))
      if (text.includes('DORI_ASK ')) w.ask++
      else { w.nonAsk++; if (ds.some(isStanding)) w.standingNonAsk++ }
      for (const d of ds) w.byMonitor[d] = (w.byMonitor[d] ?? 0) + 1
    }
  }
  w.nonAskPerHour = Math.round((w.nonAsk / hours) * 100) / 100
  w.standingNonAskPerHour = Math.round((w.standingNonAsk / hours) * 100) / 100
  return w
}

if (import.meta.main) {
  const i = process.argv.indexOf('--loop')
  const at = process.argv.indexOf('--at')
  if (process.argv.includes('--wakes')) {
    const h = process.argv.indexOf('--hours')
    const cfg = JSON.parse(readFileSync(`${DORI_HOME}/monitors.json`, 'utf8'))
    const prefix = cfg.leadKeyPrefix ?? doriCfg.lead.keyPrefix
    const files = leadSessionFiles(prefix, leadSessionIds(prefix, []))
    const standing = [...cfg.monitors.map((d: MonitorDef) => d.description), 'Herdr watch']
    const w = wakes(files, h > 0 ? Number(process.argv[h + 1]) : 24, Date.now(), standing)
    console.log(`MONITOR_WAKES hours=${w.hours} total=${w.total} ask=${w.ask} nonask=${w.nonAsk} nonask_per_hour=${w.nonAskPerHour} standing_nonask=${w.standingNonAsk} standing_nonask_per_hour=${w.standingNonAskPerHour} by_monitor=${JSON.stringify(w.byMonitor)}`)
  } else if (i < 0) {
    for (const l of lines(check(at > 0 ? Date.parse(process.argv[at + 1]!) : Date.now()))) console.log(l)
  } else {
    const every = Number(process.argv[i + 1] ?? 30) * 60_000
    for (;;) {
      try {
        const st = check()
        const state: Record<string, string> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}
        const ls = lines(st)
        st.forEach((s, k) => {
          const sig = `${s.problems.join(',')}@${s.reg?.at ?? 0}`
          if (s.problems.length && state[s.def.name] !== sig) console.log(ls[k])
          state[s.def.name] = s.problems.length ? sig : ''
        })
        const tmp = `${STATE}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(state)); renameSync(tmp, STATE)
      } catch (err) { console.log(`MONITOR_CHECK_ERROR ${(err as Error).message}`) }
      await Bun.sleep(every)
    }
  }
}
