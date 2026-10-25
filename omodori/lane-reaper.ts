// Lane reaper (dori-improve 2): proposes cleanup of finished work lanes and their leftovers. Proposal-only by default.
//   LANE_REAP_TAB <key> tab=<tab> age=<h>h        approved/closed lane whose Herdr tab still exists >2h after approval
//   LANE_HOLD_EXPIRED <key> age=<h>h              dori "hold" with no lane activity for 24h
//   LANE_LEFTOVER <key> pids=<a,b> cmd=<short> [age=..]  closed lane left dev servers/chrome/playwright running
//   LANE_EMPTY_TAB <tab> age=<h>h                 plain-shell tab with nothing running for >24h
//   bun lane-reaper.ts                  one pass, prints the proposals (or nothing)
//   bun lane-reaper.ts --loop MIN       repeat; prints a line only when it newly appears (state change)
//   bun lane-reaper.ts --apply          herdr tab close / SIGTERM leftovers; refuses the lead pane and its ancestors
//   bun lane-reaper.ts --apply-tab <tab>  (redesign S9, used by the supervisor reap policy under the lane lease) re-plan now
//                                       and close <tab> only if LANE_EMPTY_TAB <tab> is still proposed; exit 0 done, 1 not
// Read-only inputs: ~/.dori/state/{lanes,approvals}, ~/.omodori/sessions-map.json, `herdr pane list`, ps, lsof.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { liveEnv, type GuardEnv } from './dori-guard'
import { cfg, doriHome } from './config'

const HOME = process.env.HOME!
const H = 3_600_000
export const REAP_AFTER = 2 * H
export const HOLD_AFTER = 24 * H
export const EMPTY_AFTER = 24 * H

export type Lane = { key: string; status?: string; pane?: string; tab?: string; cwd?: string; history?: { at: string; status: string }[]; closedAt?: string; lastNudgeAt?: number; stateMtime?: number; live?: boolean }
export type Approval = { mtime: number; text: string }
export type Pane = { pane_id: string; tab_id: string; workspace_id?: string; cwd?: string; agent_status?: string; terminal_title?: string }
export type Proc = { pid: number; ppid: number; etimeMs: number; cmd: string; cwd?: string }
export type ShellInfo = { shellPid: number; plain: boolean; ageMs: number; idle: boolean }
export type Lead = { pane: string; tab?: string; workspace?: string; protectedPids: Set<number> }
export type Snapshot = {
  now: number
  lanes: Lane[]
  mapTabs?: Record<string, { tab?: string; pane?: string; status?: string; cwd?: string }>
  approvals: Record<string, Approval>
  panes: Pane[]
  procs: Proc[]
  shells: Record<string, ShellInfo>
  paneTreePids?: Record<string, number[]>
  lead: Lead
}

const GENERIC_CWD = new Set(cfg.paths.genericCwds)
const OPEN_STATUS = (s?: string) => !!s && s !== 'closed' && s !== 'approved' && s !== 'hold'
const hours = (ms: number) => `${Math.floor(ms / H)}h`
const ts = (s?: string) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : 0 }

export const LEFTOVER_RE = [
  /(chrom(e|ium)|headless_shell|Chrome for Testing).*(--headless|ms-playwright|--remote-debugging|puppeteer)/i,
  /playwright/i,
  /\b(node|bun)\b.*\b(vite|next|webpack|astro|nuxt|http-server|live-server|serve|dev)\b/i,
  /python[\d.]*\s.*(-m\s+http\.server|SimpleHTTPServer)/i,
]
const IGNORE_RE = /lane-reaper|\bherdr\b|senpi|omo-ai|dori-guard|\bclaude\b/i
export const isLeftoverCmd = (cmd: string) => !IGNORE_RE.test(cmd) && LEFTOVER_RE.some((r) => r.test(cmd))
const shortCmd = (cmd: string) => cmd.replace(/\/[^\s]*\//g, '').replace(/\s+/g, ' ').slice(0, 60)
const under = (child: string, parent: string) => child === parent || child.startsWith(parent.replace(/\/$/, '') + '/')

export function parseEtime(s: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim())
  if (!m) return 0
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60_000 + Number(m[4]) * 1000
}

export function laneApprovedAt(l: Lane, a?: Approval): number | null {
  if (l.live) return null
  const text = a?.text.trim() ?? ''
  const approvedByFile = /^(approved|closed)/i.test(text)
  if (l.status !== 'closed' && l.status !== 'approved' && !approvedByFile) return null
  if (a && approvedByFile) return a.mtime
  const h = [...(l.history ?? [])].reverse().find((x) => x.status === 'closed')
  return ts(h?.at) || ts(l.closedAt) || a?.mtime || l.stateMtime || null
}

export function holdState(l: Lane, a?: Approval, mapStatus?: string): number | null {
  const last = l.history?.[l.history.length - 1]
  const held = l.status === 'hold' || last?.status === 'hold' || mapStatus === 'hold' || /^\s*hold\b/i.test(a?.text ?? '')
  if (!held) return null
  return Math.max(l.stateMtime ?? 0, ts(last?.at), l.lastNudgeAt ?? 0, a?.mtime ?? 0)
}

export function plan(s: Snapshot): string[] {
  const out: string[] = []
  const paneTab = new Map(s.panes.map((p) => [p.pane_id, p.tab_id]))
  const tabsAlive = new Set(s.panes.map((p) => p.tab_id))
  const laneTab = (l: Lane) => l.tab ?? s.mapTabs?.[l.key]?.tab ?? (l.pane ? paneTab.get(l.pane) : undefined)
  const leadTab = s.lead.tab ?? paneTab.get(s.lead.pane)
  const leadTabs = new Set([leadTab].filter(Boolean) as string[])

  const isOpen = (l: Lane) => OPEN_STATUS(l.status) && !(laneApprovedAt(l, s.approvals[l.key]) != null) && s.mapTabs?.[l.key]?.status !== 'closed'
  const openLanes = s.lanes.filter(isOpen)
  const openTabs = new Set(openLanes.map(laneTab).filter(Boolean) as string[])
  for (const [k, m] of Object.entries(s.mapTabs ?? {})) if (m.status === 'open' && !s.lanes.some((l) => l.key === k) && m.tab) openTabs.add(m.tab)
  const openCwds = [...openLanes.map((l) => l.cwd), ...Object.values(s.mapTabs ?? {}).filter((m) => m.status === 'open').map((m) => m.cwd)].filter(Boolean) as string[]
  const knownTabs = new Set(s.lanes.map(laneTab).filter(Boolean) as string[])
  for (const m of Object.values(s.mapTabs ?? {})) if (m.tab) knownTabs.add(m.tab)
  const protectedTab = (tab: string) => leadTabs.has(tab) || s.panes.some((p) => p.tab_id === tab && p.pane_id === s.lead.pane)

  for (const l of s.lanes) {
    const a = s.approvals[l.key]
    const appr = laneApprovedAt(l, a)
    const tab = laneTab(l)
    if (appr != null && tab && tabsAlive.has(tab) && !openTabs.has(tab) && !protectedTab(tab) && s.now - appr > REAP_AFTER) {
      out.push(`LANE_REAP_TAB ${l.key} tab=${tab} age=${hours(s.now - appr)}`)
    }
    const act = holdState(l, a, s.mapTabs?.[l.key]?.status)
    if (act != null && s.now - act > HOLD_AFTER) out.push(`LANE_HOLD_EXPIRED ${l.key} age=${hours(s.now - act)}`)
    if (appr != null || l.status === 'closed') {
      const cwd = l.cwd?.replace(/\/$/, '')
      const specific = !!cwd && !GENERIC_CWD.has(cwd) && cwd.split('/').length > 3
      const conflict = !!cwd && openCwds.some((o) => under(o, cwd) || under(cwd, o))
      const fromTree = new Set((l.pane && s.paneTreePids?.[l.pane]) || [])
      const hits = s.procs.filter((p) => !s.lead.protectedPids.has(p.pid) && isLeftoverCmd(p.cmd) &&
        ((specific && !conflict && p.cwd != null && under(p.cwd, cwd!)) || (fromTree.has(p.pid) && !(l.pane && openTabs.has(laneTab(l) ?? '')))))
      if (hits.length) out.push(`LANE_LEFTOVER ${l.key} pids=${hits.map((p) => p.pid).sort((x, y) => x - y).join(',')} cmd=${shortCmd(hits[0]!.cmd)} age=${hours(Math.max(...hits.map((p) => p.etimeMs)))}`)
    }
  }

  const byTab = new Map<string, Pane[]>()
  for (const p of s.panes) byTab.set(p.tab_id, [...(byTab.get(p.tab_id) ?? []), p])
  for (const [tab, ps] of byTab) {
    if (protectedTab(tab) || openTabs.has(tab) || knownTabs.has(tab)) continue
    const infos = ps.map((p) => s.shells[p.pane_id])
    if (infos.some((i) => !i || !i.plain || !i.idle)) continue
    const age = Math.min(...infos.map((i) => i!.ageMs))
    if (age > EMPTY_AFTER) out.push(`LANE_EMPTY_TAB ${tab} age=${hours(age)}`)
  }
  return out
}

export const eventKey = (line: string) => line.replace(/ age=\S+$/, '')

const run = (args: string[]) => {
  const p = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' })
  return p.exitCode === 0 ? p.stdout.toString() : null
}
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }

function loadLanes(): { lanes: Lane[]; approvals: Record<string, Approval>; mapTabs: Record<string, any> } {
  const dir = `${HOME}/.dori/state`
  const lanes: Lane[] = []
  for (const f of existsSync(`${dir}/lanes`) ? readdirSync(`${dir}/lanes`) : []) {
    if (!f.endsWith('.json')) continue
    const j = readJson(`${dir}/lanes/${f}`)
    if (!j?.key) continue
    lanes.push({ key: j.key, status: j.status, pane: j.pane, tab: j.tab, cwd: j.cwd, history: j.history, closedAt: j.closedAt, lastNudgeAt: j.lastNudgeAt, stateMtime: statSync(`${dir}/lanes/${f}`).mtimeMs })
  }
  const approvals: Record<string, Approval> = {}
  for (const f of existsSync(`${dir}/approvals`) ? readdirSync(`${dir}/approvals`) : []) {
    try { approvals[f] = { mtime: statSync(`${dir}/approvals/${f}`).mtimeMs, text: readFileSync(`${dir}/approvals/${f}`, 'utf8').slice(0, 400) } } catch {}
  }
  const map = readJson(`${doriHome()}/sessions-map.json`) ?? {}
  const mapTabs: Record<string, any> = {}
  for (const [k, v] of Object.entries<any>(map)) {
    mapTabs[k] = { tab: v.tab, pane: v.pane, status: v.status, cwd: v.cwd }
    const known = lanes.find((l) => l.key === k)
    if (known && v.status === 'open') Object.assign(known, { live: true, status: 'open', pane: v.pane ?? known.pane, tab: v.tab ?? known.tab, cwd: v.cwd ?? known.cwd })
    if (!known) lanes.push({ key: k, status: v.status, pane: v.pane, tab: v.tab, cwd: v.cwd, closedAt: v.closedAt })
  }
  return { lanes, approvals, mapTabs }
}

function listProcs(): Proc[] {
  const raw = run(['ps', '-axo', 'pid=,ppid=,etime=,command=']) ?? ''
  const procs: Proc[] = []
  for (const line of raw.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (m && isLeftoverCmd(m[4]!)) procs.push({ pid: +m[1]!, ppid: +m[2]!, etimeMs: parseEtime(m[3]!), cmd: m[4]! })
  }
  if (procs.length) {
    const l = run(['lsof', '-a', '-d', 'cwd', '-Fpn', '-p', procs.map((p) => p.pid).join(',')]) ?? ''
    let cur = 0
    for (const x of l.split('\n')) {
      if (x[0] === 'p') cur = Number(x.slice(1))
      else if (x[0] === 'n') { const p = procs.find((q) => q.pid === cur); if (p) p.cwd = x.slice(1) }
    }
  }
  return procs
}

function descendants(root: number): number[] {
  const raw = run(['ps', '-axo', 'pid=,ppid=']) ?? ''
  const kids = new Map<number, number[]>()
  for (const line of raw.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line)
    if (m) kids.set(+m[2]!, [...(kids.get(+m[2]!) ?? []), +m[1]!])
  }
  const out: number[] = []
  const q = [root]
  while (q.length) for (const k of kids.get(q.pop()!) ?? []) { out.push(k); q.push(k) }
  return out
}

function gather(guard: GuardEnv): Snapshot {
  const { lanes, approvals, mapTabs } = loadLanes()
  const panes: Pane[] = JSON.parse(run(['herdr', 'pane', 'list']) ?? '{"result":{"panes":[]}}').result.panes
  const lead: Lead = { pane: guard.leadPane, tab: guard.leadTab, workspace: guard.leadWorkspace, protectedPids: guard.protectedPids }
  const procs = listProcs()
  const paneTreePids: Record<string, number[]> = {}
  const shells: Record<string, ShellInfo> = {}
  const closedPanes = new Set(lanes.filter((l) => l.status === 'closed' || l.status === 'approved').map((l) => l.pane).filter(Boolean) as string[])
  for (const p of panes) {
    const plainTitle = /^[\w.-]+@[\w.-]+:/.test(p.terminal_title ?? '') && (p.agent_status ?? 'unknown') === 'unknown'
    if (!plainTitle && !closedPanes.has(p.pane_id)) continue
    const info = run(['herdr', 'pane', 'process-info', '--pane', p.pane_id])
    if (!info) continue
    let pi: any
    try { pi = JSON.parse(info).result.process_info } catch { continue }
    if (closedPanes.has(p.pane_id) && pi.shell_pid) paneTreePids[p.pane_id] = descendants(pi.shell_pid)
    if (!plainTitle || !pi.shell_pid) continue
    const fg: any[] = pi.foreground_processes ?? []
    const plain = fg.length > 0 && fg.every((f) => f.pid === pi.shell_pid && /^-?(zsh|bash|fish|sh)$/.test(f.argv0 ?? f.name ?? ''))
    const age = parseEtime((run(['ps', '-o', 'etime=', '-p', String(pi.shell_pid)]) ?? '').trim())
    shells[p.pane_id] = { shellPid: pi.shell_pid, plain, ageMs: age, idle: descendants(pi.shell_pid).length === 0 }
  }
  return { now: Date.now(), lanes, mapTabs, approvals, panes, procs, shells, paneTreePids, lead }
}

export function applyLine(line: string, snap: Snapshot): string {
  const [prefix, id, ...rest] = line.split(' ')
  const lead = snap.lead
  const leadTab = lead.tab ?? snap.panes.find((p) => p.pane_id === lead.pane)?.tab_id
  if (prefix === 'LANE_REAP_TAB' || prefix === 'LANE_EMPTY_TAB') {
    const tab = prefix === 'LANE_EMPTY_TAB' ? id! : /tab=(\S+)/.exec(rest.join(' '))![1]!
    if (tab === leadTab || snap.panes.some((p) => p.tab_id === tab && p.pane_id === lead.pane)) return `LANE_REAP_REFUSED ${tab} lead tab`
    return run(['herdr', 'tab', 'close', tab]) != null ? `LANE_REAP_DONE close ${tab}` : `LANE_REAP_FAILED close ${tab}`
  }
  if (prefix === 'LANE_LEFTOVER') {
    const pids = (/pids=(\S+)/.exec(rest.join(' '))?.[1] ?? '').split(',').map(Number).filter(Boolean)
    const res = pids.map((pid) => {
      if (lead.protectedPids.has(pid)) return `${pid}:refused`
      try { process.kill(pid, 'SIGTERM'); return `${pid}:killed` } catch { return `${pid}:gone` }
    })
    return `LANE_REAP_DONE kill ${id} ${res.join(',')}`
  }
  return `LANE_REAP_SKIP ${prefix} ${id}`
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const apply = argv.includes('--apply')
  const loop = opt('--loop')
  const applyTab = opt('--apply-tab')
  if (applyTab) {
    const snap = gather(liveEnv())
    const line = plan(snap).find((l) => l.startsWith(`LANE_EMPTY_TAB ${applyTab} `))
    if (!line) { console.log(`LANE_REAP_SKIP LANE_EMPTY_TAB ${applyTab} no longer proposed`); process.exit(1) }
    const res = applyLine(line, snap)
    console.log(res)
    process.exit(res.startsWith('LANE_REAP_DONE') ? 0 : 1)
  }
  const seen = new Set<string>()
  do {
    try {
      const snap = gather(liveEnv())
      const lines = plan(snap)
      const keys = new Set(lines.map(eventKey))
      for (const k of [...seen]) if (!keys.has(k)) seen.delete(k)
      for (const l of lines) {
        const k = eventKey(l)
        if (loop && seen.has(k)) continue
        seen.add(k)
        console.log(l)
        if (apply) console.log(applyLine(l, snap))
      }
    } catch (err) { console.log(`LANE_REAPER_ERROR ${(err as Error).message}`) }
    if (loop) await Bun.sleep(Number(loop) * 60_000)
  } while (loop)
}
