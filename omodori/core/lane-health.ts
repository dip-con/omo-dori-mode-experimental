// Lane stall + quota watcher (dori-improve 2). Emits one line per state change for the lead's monitor:
//   LANE_QUOTA <key> ...        last turn ended on a usage-limit/429/credit error; proposes the account to move to
//   LANE_QUOTA_ALL <key> ...    all three Claude accounts are full; proposes GPT Astra high until the soonest reset
//   LANE_QUOTA_RESET <key> ...  a lane moved to GPT can go back to Claude
//   LANE_STALLED <key> ...      overloaded/other error, or "working" with no session write for --stall-min minutes
//   LANE_CONTEXT <key> pane=<p> ctx=<N>K/<pct>% -> propose: ...  lane context passed LANE_CTX_PCT (default 40) of LANE_CTX_WINDOW (default 1000000);
//                               fires once, re-arms only after the lane drops back under the threshold. Proposal only, never acts.
//   bun lane-health.ts [--loop MIN] [--stall-min 20]   (default: one sweep, events only)
//   bun lane-health.ts --once --all                    print every lane's state (read-only check: no state write, no migration)
//   LANE_UNRESOLVED <key> ...   an open lane whose sessionId has no session file (map drift; registry-sync.ts --dry explains it)
//   bun lane-health.ts --replay <session.jsonl> --at <iso> [--status idle] [--account NAME]
//   bun lane-health.ts --simulate quota <key> --to <account>   (rpc-smoke / s9-test-* only) write DORI_HOME/state/quota-sim/<key>.json
//                               so the supervisor quota policy treats the lane as quota-stopped (live check of S9)
// Proposal only (redesign S9): the executor moved to dori-supervisor.ts (quota policy, per-episode approval
// flags/auto-migrate.<key>). Targets use quota headroom (policy-lib.ts); the reset proposal needs N consecutive clear checks.
// Rollback: remove the lane-health line from dori-monitors.sh (backup dori-monitors.sh.bak-20261023-improve).
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cfg, doriHome, isLeadKey, coreRef } from './config'
import { accountCheck, accountHeadroom, CLAUDE_PROVIDER, openToolCall, pickAccount, switchBackStep } from './policy-lib'

const HOME = process.env.HOME!
const DORI_HOME = doriHome()
const SESSIONS = `${HOME}/.omo/agent/sessions`
const USAGE = `${HOME}/.omo/agent/subscription-usage.json`
const AUTH = `${HOME}/.omo/agent/auth.json`
const STATE = `${DORI_HOME}/lane-health-state.json`
const MIGRATIONS = `${DORI_HOME}/lane-migrations.jsonl`
const SIM_DIR = `${process.env.OMODORI_HOME ?? DORI_HOME}/state/quota-sim`
export const CLAUDE_ACCOUNTS = cfg.claudeAccounts
export const GPT_FALLBACK = { model: 'chatgpt-subscription/gpt-6-astra', thinking: 'high' }
const REMIND_MS = 30 * 60_000
const CTX_PCT = Number(process.env.LANE_CTX_PCT ?? 40)
const CTX_WINDOW = Number(process.env.LANE_CTX_WINDOW ?? 1_000_000)

// Context size = totalTokens of the newest assistant turn that carries usage (matches the pane footer "NNNK/1M").
export function contextTokens(text: string): number | null {
  let last: number | null = null
  for (const l of text.split('\n')) {
    if (!l.includes('"role":"assistant"') || !l.includes('"totalTokens"')) continue
    try { const t = JSON.parse(l).message?.usage?.totalTokens; if (typeof t === 'number' && t > 0) last = t } catch {}
  }
  return last
}

// Footer text "177K/1M (17.7%)" -> tokens + window.
export function parseFooter(text: string): { tokens: number; window: number } | null {
  const m = /(\d+(?:\.\d+)?)([KM])\/(\d+(?:\.\d+)?)([KM]) \(\d+(?:\.\d+)?%\)/.exec(text)
  if (!m) return null
  const mul = (u: string) => (u === 'M' ? 1_000_000 : 1000)
  return { tokens: Number(m[1]) * mul(m[2]!), window: Number(m[3]) * mul(m[4]!) }
}

export function contextEvent(key: string, pane: string, tokens: number, window: number): string {
  const pct = (tokens / window) * 100
  const cmd = `bun ${coreRef()}/lane-transition.ts ${key} --fresh --reason manual (after its turn)`
  return `LANE_CONTEXT ${key} pane=${pane} ctx=${Math.round(tokens / 1000)}K/${pct.toFixed(1)}% -> propose: ${cmd}`
}

// One event per upward crossing; `over` is the persisted flag, cleared when the lane drops back under the threshold.
export function contextStep(over: boolean, tokens: number, window: number, thresholdPct = CTX_PCT): { over: boolean; fire: boolean } {
  const now = (tokens / window) * 100 > thresholdPct
  return { over: now, fire: now && !over }
}

async function paneFooter(pane: string): Promise<{ tokens: number; window: number } | null> {
  const p = Bun.spawn(['herdr', 'pane', 'read', pane, '--lines', '5'], { stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  return code === 0 ? parseFooter(out) : null
}

export type LastTurn = { ts: number; stopReason?: string; error?: string; provider?: string }
export type AccountState = { name: string; full: boolean; score: number; resetAt?: number }
export type Assessment = { state: 'ok' | 'quota' | 'quota_all' | 'stalled'; detail: string; target?: string; resetAt?: number }

const QUOTA = /usage limit|session limit|weekly limit|rate.?limit|all claude accounts|no credential slots|\b429\b|credit|quota|exhausted/i
const OVERLOAD = /overload|\b529\b|\b503\b|try again later/i

export function accountStates(usage: any, auth: any, now: number): AccountState[] {
  const slots: any[] = auth?.['anthropic-subscription']?.accounts ?? []
  return CLAUDE_ACCOUNTS.map((name) => {
    const wins: any[] = usage?.accounts?.[`anthropic-subscription/${name}`]?.windows ?? []
    const core = wins.filter((w) => w.label === '5h' || w.label === '7d')
    const resetOf = (w: any) => (w.resetsAt ? Date.parse(w.resetsAt) : undefined)
    const fullWins = core.filter((w) => w.usedPercent >= 100 && (resetOf(w) === undefined || resetOf(w)! > now))
    const slot = slots.find((s) => s.name === name)
    const blocked = slot?.blockedUntil && slot.blockedUntil > now ? slot.blockedUntil : undefined
    const resets = [...fullWins.map(resetOf).filter((x): x is number => x !== undefined), ...(blocked ? [blocked] : [])]
    return { name, full: fullWins.length > 0 || !!blocked, score: Math.max(0, ...core.map((w) => w.usedPercent ?? 0)), resetAt: resets.length ? Math.max(...resets) : undefined }
  })
}

export function assess(i: {
  status: string; mtime: number; last: LastTurn | null; account?: string; accounts: AccountState[]; now: number; stallMin: number
  /** Headroom pick (policy-lib pickAccount): undefined = legacy usedPercent order, null = no fresh candidate. */
  pick?: string | null
  openTool?: { since: number; name: string } | null
}): Assessment {
  const { last, now } = i
  const errored = last?.stopReason === 'error' && (i.status !== 'working' || now - i.mtime > 3 * 60_000)
  if (errored && QUOTA.test(last!.error ?? '')) {
    const short = (last!.error ?? '').split('\n')[0]!.slice(0, 120)
    if (last!.provider && last!.provider !== CLAUDE_PROVIDER) return { state: 'stalled', detail: `provider_error ${last!.provider}: "${short}" (no Claude account rotation)` }
    const allBlocked = /all claude accounts/i.test(last!.error ?? '')
    const free = allBlocked ? [] : i.accounts.filter((a) => !a.full && a.name !== i.account).sort((a, b) => a.score - b.score)
    if (!allBlocked && i.pick) return { state: 'quota', detail: `account=${i.account ?? 'unknown'} err="${short}"`, target: i.pick }
    if (!allBlocked && i.pick === null && free.length) return { state: 'stalled', detail: `quota on ${i.account ?? 'unknown'}, but no account has fresh usage headroom (usage stale/missing): "${short}"` }
    if (free.length && i.pick === undefined) return { state: 'quota', detail: `account=${i.account ?? 'unknown'} err="${short}"`, target: free[0]!.name }
    const resets = i.accounts.map((a) => a.resetAt).filter((x): x is number => x !== undefined)
    const retry = /Soonest automatic retry: (\S+)/.exec(last!.error ?? '')?.[1]
    const resetAt = retry ? Date.parse(retry) : resets.length ? Math.min(...resets) : undefined
    return { state: 'quota_all', detail: `account=${i.account ?? 'unknown'} err="${short}"`, resetAt }
  }
  if (errored) return { state: 'stalled', detail: `${OVERLOAD.test(last!.error ?? '') ? 'overloaded' : 'error'}: "${(last!.error ?? '').split('\n')[0]!.slice(0, 120)}"` }
  if (i.status === 'working' && now - i.mtime > i.stallMin * 60_000) {
    const t = i.openTool
    return { state: 'stalled', detail: t ? `working, one tool (${t.name}) running for ${Math.round((now - t.since) / 60_000)}m` : `working, silent: no session write for ${Math.round((now - i.mtime) / 60_000)}m` }
  }
  return { state: 'ok', detail: i.status }
}

const kstHm = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ') + ' KST'

export function eventLine(key: string, pane: string, a: Assessment): string | null {
  const how = 'propose (lead approval)'
  if (a.state === 'quota') {
    return `LANE_QUOTA ${key} pane=${pane} ${a.detail} -> ${how}: bun ${coreRef()}/lane-transition.ts ${key} --fresh --account ${a.target} --reason quota`
  }
  if (a.state === 'quota_all') {
    const when = a.resetAt ? ` (soonest Claude reset ${kstHm(a.resetAt)})` : ''
    return `LANE_QUOTA_ALL ${key} pane=${pane} ${a.detail}: all 3 Claude accounts full${when} -> ${how}: bun ${coreRef()}/lane-transition.ts ${key} --fresh --model ${GPT_FALLBACK.model} --thinking ${GPT_FALLBACK.thinking} --reason quota`
  }
  if (a.state === 'stalled') return `LANE_STALLED ${key} pane=${pane} ${a.detail}`
  return null
}

export function sessionIndex(root = SESSIONS): Map<string, string> {
  const m = new Map<string, string>()
  for (const d of existsSync(root) ? readdirSync(root) : []) {
    let files: string[] = []
    try { files = readdirSync(join(root, d)) } catch { continue }
    for (const f of files) {
      const id = /_([0-9a-f-]{36})\.jsonl$/.exec(f)?.[1]
      if (id) m.set(id, join(root, d, f))
    }
  }
  return m
}

function tail(path: string, bytes = 400_000): string {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally { closeSync(fd) }
}

export function lastTurn(text: string, atMs = Infinity): LastTurn | null {
  let last: LastTurn | null = null
  for (const l of text.split('\n')) {
    if (!l.includes('"role":"assistant"')) continue
    try {
      const j = JSON.parse(l)
      const ts = Date.parse(j.timestamp)
      if (j.message?.role !== 'assistant' || ts > atMs) continue
      last = { ts, stopReason: j.message.stopReason, error: j.message.errorMessage, provider: j.message.provider }
    } catch {}
  }
  return last
}

export function accountOf(sessionFile: string): string | undefined {
  try { return JSON.parse(readFileSync(`${sessionFile}.claude-sdk-oauth-binding.json`, 'utf8')).accountName } catch { return undefined }
}

const readJson = (p: string, fb: any) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fb } }
// Own state file only (idea from bokdong dori-mode src/waits.ts load(), MIT): a file that does not parse to an object is
// moved to <file>.corrupt-<ms> (evidence kept, not overwritten by the next write) and reported in one line; the sweep
// continues with empty state. The rename makes the report happen once. quarantine=false (--once) reports and moves nothing.
export function readOwnState(p: string, quarantine: boolean, now = Date.now()): { state: Record<string, { sig: string; at: number }>; line: string | null } {
  let raw: string
  try { raw = readFileSync(p, 'utf8') } catch { return { state: {}, line: null } }
  let why: string
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === 'object' && !Array.isArray(v)) return { state: v, line: null }
    why = `not an object (${Array.isArray(v) ? 'array' : String(v)})`
  } catch (e) { why = (e as Error).message }
  if (!quarantine) return { state: {}, line: `LANE_HEALTH_STATE_CORRUPT ${p}: ${why}; read-only run, file left in place, using empty state` }
  const aside = `${p}.corrupt-${now}`
  renameSync(p, aside)
  return { state: {}, line: `LANE_HEALTH_STATE_CORRUPT moved ${p} to ${aside}: ${why}; continuing with empty state (reminders/ctx/switch-back counters reset)` }
}
const writeJson = (p: string, v: unknown) => { const t = `${p}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(v, null, 1)); renameSync(t, p) }
const log = (line: string) => { try { mkdirSync(`${DORI_HOME}/logs`, { recursive: true }); appendFileSync(`${DORI_HOME}/logs/lane-health.log`, `${new Date().toISOString()} ${line}\n`) } catch {} }

async function agentStatuses(): Promise<Map<string, string>> {
  const p = Bun.spawn(['herdr', 'agent', 'list'], { stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  if (code !== 0) return new Map()
  try { return new Map((JSON.parse(out).result.agents as any[]).map((a) => [a.pane_id, a.agent_status])) } catch { return new Map() }
}

async function sweep(stallMin: number, all: boolean, once = false) {
  const now = Date.now()
  const map = readJson(`${DORI_HOME}/sessions-map.json`, {})
  const lanes = Object.values<any>(map).filter((e) => e?.status === 'open' && e.sessionId && !isLeadKey(String(e.key)))
  const idx = sessionIndex()
  const statuses = await agentStatuses()
  const usage = readJson(USAGE, {}), auth = readJson(AUTH, {})
  const accounts = accountStates(usage, auth, now)
  const { state, line: corrupt } = readOwnState(STATE, !once)
  if (corrupt) { console.log(corrupt); if (!once) log(corrupt) }
  for (const e of lanes) {
    const file = idx.get(e.sessionId)
    const uk = `unresolved:${e.key}`
    if (!file) {
      if (once || !state[uk] || now - state[uk]!.at >= REMIND_MS) {
        const line = `LANE_UNRESOLVED ${e.key} pane=${e.pane} session=${e.sessionId}: no session file -> check: bun ${coreRef()}/registry-sync.ts --dry`
        console.log(line)
        if (!once) { log(line); state[uk] = { sig: 'unresolved', at: now } }
      }
      continue
    }
    delete state[uk]
    const text = tail(file)
    const account = accountOf(file)
    const a = assess({
      status: statuses.get(e.pane) ?? 'unknown', mtime: statSync(file).mtimeMs, last: lastTurn(text), account, accounts, now, stallMin,
      pick: pickAccount(CLAUDE_ACCOUNTS, account ?? null, usage, auth, now)?.name ?? null, openTool: openToolCall(text),
    })
    const ctx = contextTokens(tail(file)) !== null ? { tokens: contextTokens(tail(file))!, window: CTX_WINDOW } : await paneFooter(e.pane)
    if (ctx) {
      const ck = `ctx:${e.key}`
      const step = contextStep(state[ck] !== undefined, ctx.tokens, ctx.window)
      if (step.over) state[ck] = state[ck] ?? { sig: 'over', at: now }; else delete state[ck]
      if (all) console.log(`LANE_CTX_STATE ${e.key} pane=${e.pane} ${Math.round(ctx.tokens / 1000)}K/${((ctx.tokens / ctx.window) * 100).toFixed(1)}%`)
      if (step.fire) { const l = contextEvent(e.key, e.pane, ctx.tokens, ctx.window); console.log(l); log(l) }
    }
    if (all) console.log(`LANE_STATE ${e.key} pane=${e.pane} ${a.state} ${a.detail}${a.target ? ` target=${a.target}` : ''}`)
    const sig = `${a.state}:${a.target ?? ''}`
    const prev = state[e.key]
    if (a.state === 'ok') { if (prev) delete state[e.key]; continue }
    if (prev?.sig === sig && now - prev.at < REMIND_MS) continue
    const line = eventLine(e.key, e.pane, a)
    state[e.key] = { sig, at: now }
    if (!line) continue
    console.log(line); if (!once) log(line)
  }
  for (const m of readJsonlSafe(MIGRATIONS)) {
    if (m.fallback !== 'gpt' || m.resetNotified) continue
    const lane = map[m.newKey]
    const sig = `reset:${m.newKey}`
    if (lane?.status !== 'open' || state[sig]?.sig === 'fired') continue
    // Back to Claude only after N consecutive clear checks (unreadable usage does not count, one blocked check resets).
    const names = CLAUDE_ACCOUNTS.includes(m.from) ? [m.from] : CLAUDE_ACCOUNTS
    const hs = names.map((n) => accountHeadroom(n, usage, auth, now))
    const checks = hs.map(accountCheck)
    const check = checks.includes('clear') ? 'clear' : checks.includes('unreadable') ? 'unreadable' : 'blocked'
    const step = switchBackStep(Number(state[sig]?.sig ?? 0), check)
    state[sig] = { sig: String(step.count), at: now }
    if (!step.fire) continue
    const best = hs.filter((h) => accountCheck(h) === 'clear').sort((x, y) => y.score! - x.score!)[0]!
    const line = `LANE_QUOTA_RESET ${m.newKey} account ${best.name} is available again (${step.count} clear checks) -> propose: bun ${coreRef()}/lane-transition.ts ${m.newKey} --fresh --account ${best.name} --reason manual`
    console.log(line); log(line); state[sig] = { sig: 'fired', at: now }
  }
  if (!once) writeJson(STATE, state)
}

const readJsonlSafe = (p: string): any[] => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } }) : []

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const stallMin = Number(opt('--stall-min') ?? 20)
  const replay = opt('--replay')
  const simulate = opt('--simulate')
  if (simulate) {
    const key = argv[argv.indexOf('--simulate') + 2]
    const to = opt('--to')
    if (simulate !== 'quota' || !key || !to || !CLAUDE_ACCOUNTS.includes(to)) { console.log('usage: lane-health.ts --simulate quota <key> --to <default|86|work>'); process.exit(2) }
    if (key !== 'rpc-smoke' && !key.startsWith('s9-test-')) { console.log(`LANE_SIMULATE_REFUSED ${key}: only rpc-smoke and s9-test-* lanes`); process.exit(4) }
    const e = readJson(`${process.env.OMODORI_HOME ?? DORI_HOME}/sessions-map.json`, {})[key]
    if (!e || e.status !== 'open') { console.log(`LANE_SIMULATE_REFUSED ${key}: not open`); process.exit(4) }
    const sim = { episode: `sim:${key}:${e.sessionId}:${Date.now()}`, target: to, durableId: e.sessionId, at: new Date().toISOString() }
    mkdirSync(SIM_DIR, { recursive: true })
    writeJson(`${SIM_DIR}/${key}.json`, sim)
    console.log(`LANE_QUOTA_SIMULATED ${key} target=${to} episode=${sim.episode} (the supervisor quota policy acts on its next tick when flags/policy.quota covers ${key})`)
    process.exit(0)
  }
  if (replay) {
    const at = Date.parse(opt('--at') ?? new Date().toISOString())
    const last = lastTurn(readFileSync(replay, 'utf8'), at)
    const accounts = accountStates(readJson(opt('--usage') ?? USAGE, {}), opt('--usage') ? {} : readJson(AUTH, {}), at)
    const a = assess({ status: opt('--status') ?? 'idle', mtime: last?.ts ?? at, last, account: opt('--account') ?? accountOf(replay), accounts, now: at + 60_000, stallMin })
    const line = eventLine(`replay:${replay.split('/').pop()!.slice(0, 32)}`, 'replay', a) ?? `LANE_STATE ok ${a.detail}`
    console.log(line); log(`[replay] ${line}`)
  } else {
    const loop = opt('--loop')
    do {
      try { await sweep(stallMin, argv.includes('--all'), argv.includes('--once') && !loop) } catch (err) { console.log(`LANE_HEALTH_ERROR ${(err as Error).message}`) }
      if (loop) await Bun.sleep(Number(loop) * 60_000)
    } while (loop)
  }
}
