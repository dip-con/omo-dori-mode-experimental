// Dori dangerous-command guard (dori-improve 1). Pure check + CLI; the OMO extension
// ~/.omo/agent/extensions/dori-guard.ts calls checkCommand() before every bash tool call.
//   (a) `dori launch ... --thread <id>` / `sess.ts open ... <id>` with a project channel or #일반 id -> refuse.
//   (b) kill/pkill/killall/herdr close aimed at the lead (wW:p6) or at the caller's own ancestors -> refuse.
//   bun dori-guard.ts check "<command>"     prints BLOCK <reason> (exit 3) or ALLOW (exit 0)
// Every BLOCK is appended to ~/.omocat/logs/dori-guard.log. Rollback: delete the extension file.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { cfg } from './config'

const HOME = process.env.HOME!
const LOG_DIR = `${HOME}/.omocat/logs`
const GENERAL = cfg.discord.generalChannel

export type Verdict = { block: true; kind: 'channel' | 'kill'; reason: string } | null

export type GuardEnv = {
  channels: Map<string, string>
  leadPane: string
  leadTab?: string
  leadWorkspace?: string
  protectedPids: Set<number>
  pgrep: (args: string[]) => number[] | null
}

export function loadChannels(): Map<string, string> {
  const m = new Map<string, string>([[GENERAL, '#일반']])
  try {
    const c = JSON.parse(readFileSync(`${HOME}/.omocat/channels.json`, 'utf8'))
    if (c.category_id) m.set(String(c.category_id), 'project category')
    for (const [id, p] of Object.entries<any>(c.projects ?? {})) m.set(id, `#${p.key ?? p.name ?? id}`)
  } catch {}
  return m
}

// Projects with a channel-bound session (channels.json projects[id].session, e.g. #부동산) may keep
// opening that one session and its migrations (<key>-mN) in the channel itself.
export function channelSessionAllowed(channelId: string, laneKey: string | undefined): boolean {
  try {
    const s = JSON.parse(readFileSync(`${HOME}/.omocat/channels.json`, 'utf8')).projects?.[channelId]?.session
    if (!s?.key || !laneKey) return false
    return laneKey === s.key || (laneKey.startsWith(`${s.key}-m`) && /^\d+$/.test(laneKey.slice(s.key.length + 2)))
  } catch { return false }
}

const sh = (args: string[]) => {
  const p = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' })
  return p.exitCode === 0 ? p.stdout.toString() : null
}
const ppidOf = (pid: number) => Number(sh(['ps', '-o', 'ppid=', '-p', String(pid)])?.trim() || 0)
function ancestors(pid: number, into: Set<number>) {
  for (let p = pid, n = 0; p > 1 && n < 30; p = ppidOf(p), n++) into.add(p)
}

export function liveEnv(selfPid = process.pid): GuardEnv {
  let leadPane = 'wW:p6'
  try { leadPane = JSON.parse(readFileSync(`${HOME}/.dori/config.json`, 'utf8')).leadPane ?? leadPane } catch {}
  const pids = new Set<number>()
  ancestors(selfPid, pids)
  let leadTab: string | undefined
  let leadWorkspace: string | undefined
  const info = sh(['herdr', 'pane', 'process-info', '--pane', leadPane])
  if (info) {
    try {
      const pi = JSON.parse(info).result.process_info
      if (pi.foreground_process_group_id) pids.add(pi.foreground_process_group_id)
      for (const f of pi.foreground_processes ?? []) if (f.pid) pids.add(f.pid)
      if (pi.shell_pid) ancestors(pi.shell_pid, pids)
    } catch {}
  }
  const agents = sh(['herdr', 'agent', 'list'])
  if (agents) {
    try {
      const a = JSON.parse(agents).result.agents.find((x: any) => x.pane_id === leadPane)
      leadTab = a?.tab_id; leadWorkspace = a?.workspace_id
    } catch {}
  }
  return {
    channels: loadChannels(), leadPane, leadTab, leadWorkspace, protectedPids: pids,
    pgrep: (args) => {
      const p = Bun.spawnSync(['pgrep', ...args], { stdout: 'pipe', stderr: 'pipe' })
      if (p.exitCode === 1) return []
      if (p.exitCode !== 0) return null
      return p.stdout.toString().split('\n').filter(Boolean).map(Number)
    },
  }
}

// Minimal shell word split: quotes and backslashes; good enough to find argv of each simple command.
export function segments(cmd: string): string[][] {
  const out: string[][] = []
  let cur: string[] = []; let w = ''; let q: '' | "'" | '"' = ''; let has = false
  const endWord = () => { if (has) cur.push(w); w = ''; has = false }
  const endSeg = () => { endWord(); if (cur.length) out.push(cur); cur = [] }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (q) { if (c === q) q = ''; else if (c === '\\' && q === '"' && i + 1 < cmd.length) { w += cmd[++i]; } else w += c; continue }
    if (c === "'" || c === '"') { q = c; has = true; continue }
    if (c === '\\' && i + 1 < cmd.length) { w += cmd[++i]; has = true; continue }
    if (c === ' ' || c === '\t') { endWord(); continue }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`') { endSeg(); continue }
    if (c === '$' && cmd[i + 1] === '(') { endSeg(); i++; continue }
    w += c; has = true
  }
  endSeg()
  return out
}

const PREFIX = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'xargs'])
function strip(argv: string[]) {
  let i = 0
  while (i < argv.length && (PREFIX.has(argv[i]!) || /^[A-Z_][A-Z0-9_]*=/.test(argv[i]!))) i++
  return argv.slice(i)
}
const base = (s: string) => s.split('/').pop()!

function checkChannel(argv: string[], env: GuardEnv): Verdict {
  const a = strip(argv)
  const isLaunch = base(a[0] ?? '') === 'dori' && (a[1] === 'launch' || a[1] === 'adopt')
  const si = a.findIndex((x) => /(^|\/)sess\.ts$/.test(x))
  const isOpen = si >= 0 && a[si + 1] === 'open'
  if (!isLaunch && !isOpen) return null
  const ids = isLaunch
    ? a.flatMap((x, i) => (x === '--thread' ? [a[i + 1] ?? ''] : x.startsWith('--thread=') ? [x.slice(9)] : []))
    : [a[si + 6] ?? '']
  const laneKey = isLaunch ? a[2] : a[si + 2]
  for (const raw of ids) {
    const id = raw.replace(/^discord:/, '')
    const label = env.channels.get(id)
    if (label && !channelSessionAllowed(id, laneKey)) {
      return { block: true, kind: 'channel', reason: `dori-guard: ${id} is the channel ${label}, not a thread. Make a thread first (bun ~/.omocat/mkthread.ts <channel> <message-id> "<name>") and launch with that thread id.` }
    }
  }
  return null
}

const SELF_REFS = /^(\$\$|\$PPID|\$\{PPID\}|\$\{\$\})$/
function checkKill(argv: string[], env: GuardEnv): Verdict {
  const a = strip(argv)
  const cmd = base(a[0] ?? '')
  const hit = (what: string) => ({ block: true as const, kind: 'kill' as const, reason: `dori-guard: refusing to ${what}: that is the Dandori lead (${env.leadPane}) or this session's own parent chain. Ask the owner if it really must stop.` })
  if (cmd === 'kill') {
    let args = a.slice(1)
    if (args[0] === '-s' || args[0] === '-n') args = args.slice(2)
    else if (args.length > 1 && /^-[A-Z0-9]+$/i.test(args[0]!)) args = args.slice(1)
    for (const x of args) {
      if (x === '--') continue
      if (SELF_REFS.test(x) || x === '0' || x === '-1') return hit(`kill ${x}`)
      if (/^-?\d+$/.test(x) && env.protectedPids.has(Math.abs(Number(x)))) return hit(`kill ${x}`)
    }
    return null
  }
  if (cmd === 'pkill' || cmd === 'killall') {
    const pats: string[] = []
    const flags: string[] = []
    for (let i = 1; i < a.length; i++) {
      const x = a[i]!
      if (x === '-s' || x === '--signal' || x === '-SIGNAL') { i++; continue }
      if (x.startsWith('-')) { if (/^-[fx]+$/.test(x) || x === '-i') flags.push(x); continue }
      pats.push(x)
    }
    for (const p of pats) {
      const args = cmd === 'killall' ? ['-x', p] : [...flags.filter((f) => f !== '-i'), p]
      const pids = env.pgrep(args)
      if (pids === null) { if (/omo|senpi|herdr|cli\.js|bun/i.test(p)) return hit(`${cmd} ${p}`); continue }
      if (pids.some((pid) => env.protectedPids.has(pid))) return hit(`${cmd} ${p}`)
    }
    return null
  }
  if (cmd === 'herdr') {
    const [sub, verb, ...rest] = a.slice(1)
    if (sub === 'server' && verb === 'stop') return hit('stop the herdr server')
    if (verb !== 'close') return null
    const targets = rest.flatMap((x, i) => (x.startsWith('-') ? [] : rest[i - 1] === '--workspace' ? [] : [x]))
    if (sub === 'pane' && targets.includes(env.leadPane)) return hit(`close pane ${env.leadPane}`)
    if (sub === 'tab' && env.leadTab && targets.includes(env.leadTab)) return hit(`close tab ${env.leadTab}`)
    if (sub === 'workspace' && env.leadWorkspace && targets.includes(env.leadWorkspace)) return hit(`close workspace ${env.leadWorkspace}`)
  }
  return null
}

const MAYBE = /\b(dori|sess\.ts|kill|pkill|killall|herdr)\b/
export function checkCommand(cmd: string, env: GuardEnv | (() => GuardEnv)): Verdict {
  if (!MAYBE.test(cmd)) return null
  const e = typeof env === 'function' ? env() : env
  for (const argv of segments(cmd)) {
    const v = checkChannel(argv, e) ?? checkKill(argv, e)
    if (v) return v
  }
  return null
}

export function logBlock(v: NonNullable<Verdict>, cmd: string, where: string) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(`${LOG_DIR}/dori-guard.log`, `${new Date().toISOString()} BLOCK ${v.kind} [${where}] ${cmd.replace(/\s+/g, ' ').slice(0, 300)}\n`)
  } catch {}
}

if (import.meta.main) {
  const [sub, cmd] = process.argv.slice(2)
  if (sub !== 'check' || !cmd) { console.error('usage: dori-guard.ts check "<command>"'); process.exit(2) }
  const v = checkCommand(cmd, () => liveEnv(process.ppid))
  if (v) { logBlock(v, cmd, 'cli'); console.log(`BLOCK ${v.reason}`); process.exit(3) }
  console.log('ALLOW')
}

