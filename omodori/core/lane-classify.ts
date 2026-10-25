// Lane quota/stall classifier (redesign S8 "quota/stall 모델"); replaces lane-health.ts
// assess() for the supervisor (S9). Pure functions over the transcript tail, the supervisor snapshot row, usage and auth.
// Axes are kept apart: progress (did the lane answer its input), credential (the last error with no success after it),
// provider (whose quota it is) and per-account state (present in auth.json, usage fresh, full).
//   bun lane-classify.ts <key> [--json]      read-only: classify one open lane now
//   bun lane-classify.ts --all [--json]      every open lane
// Rules (each one has a fixture in lane-classify.test.ts):
//   - an account missing from auth.json, or whose usage entry is older than 30 min (or has no updatedAt), is never a
//     candidate; a stale one also yields lane.usage_stale
//   - missing/stale usage never reads as "all accounts free": with no fresh candidate and not every account known full,
//     the verdict is 'unknown' (ask), never quota_all
//   - quota_all only when every Claude account is present, fresh and full (resetAt = the soonest reset)
//   - a non-Claude lane (chatgpt-subscription, ...) hitting 429/credit is provider_error: no Claude account is proposed
//   - an error is current only when no successful assistant entry follows it (a running lane's old error is ignored)
//   - an error before any successful assistant entry is a pre-assistant failure: credential_error (ask) unless it is a quota text
//   - one blocked account is not a stall: the lane on it moves to a free account; lanes on other accounts stay ok
import { existsSync, readFileSync } from 'node:fs'
import { cfg, isLeadKey } from './config'

export const CLAUDE_PROVIDER = 'anthropic-subscription'
export const CLAUDE_ACCOUNTS = cfg.claudeAccounts
export const GPT_FALLBACK = { model: 'chatgpt-subscription/gpt-6-astra', thinking: 'high' }
export const USAGE_FRESH_MS = 30 * 60_000
export const FIRST_INPUT_ASK_MS = 10 * 60_000

const QUOTA = /usage limit|session limit|weekly limit|rate.?limit|all claude accounts|no credential slots|\b429\b|credit|quota|exhausted/i
const CREDENTIAL = /auth|credential|api key|\b401\b|\b403\b|unauthori[sz]ed|forbidden|oauth|token (?:expired|invalid)/i
const OVERLOAD = /overload|\b529\b|\b503\b|try again later/i

export type Progress = 'no_input' | 'first_input_pending' | 'turn_running' | 'idle_ok' | 'no_progress'
export type Credential = 'ok' | 'quota' | 'credential_error' | 'overload' | 'other_error'
export type AccountState = { name: string; present: boolean; usageFresh: boolean; full: boolean; score: number; resetAt?: number; updatedAt?: number }
export type Verdict = 'ok' | 'quota' | 'quota_all' | 'unknown' | 'provider_error' | 'credential_error' | 'first_input_pending' | 'stalled'
export type Classification = {
  verdict: Verdict; action: 'none' | 'act' | 'ask'; progress: Progress; credential: Credential; provider: string | null
  account: string | null; target?: string; resetAt?: number; detail: string; events: { kind: string; severity: 'info' | 'ask' | 'act'; data?: unknown }[]
  accounts: AccountState[]
}

/** Snapshot status vocabulary: the supervisor says running where herdr said working. */
export const normStatus = (s: string | null | undefined) => (s === 'working' ? 'running' : s ?? 'unknown')

type Entry = { ts: number; kind: 'delivery' | 'assistant'; ok?: boolean; error?: string; provider?: string }

/** Delivery entries (admission custom_message, or a herdr user message carrying a dori tag) and assistant entries. */
export function transcriptEntries(text: string): Entry[] {
  const out: Entry[] = []
  for (const l of text.split('\n')) {
    if (!l.includes('"custom_message"') && !l.includes('"role":"assistant"') && !l.includes('[dori-msg:')) continue
    let j: any
    try { j = JSON.parse(l) } catch { continue }
    const ts = Date.parse(j.timestamp)
    if (j.type === 'custom_message' && j.customType === 'session_control_delivery') out.push({ ts, kind: 'delivery' })
    else if (j.type === 'message' && j.message?.role === 'user' && JSON.stringify(j.message.content ?? '').includes('[dori-msg:')) out.push({ ts, kind: 'delivery' })
    else if (j.type === 'message' && j.message?.role === 'assistant') {
      const err = j.message.stopReason === 'error'
      out.push({ ts, kind: 'assistant', ok: !err && j.message.stopReason !== 'aborted', error: err ? String(j.message.errorMessage ?? 'error') : undefined, provider: j.message.provider })
    }
  }
  return out
}

export function accountStates(usage: any, auth: any, now: number): AccountState[] {
  const slots: any[] = auth?.[CLAUDE_PROVIDER]?.accounts ?? []
  return CLAUDE_ACCOUNTS.map((name) => {
    const slot = slots.find((s) => s?.name === name)
    const u = usage?.accounts?.[`${CLAUDE_PROVIDER}/${name}`]
    const updatedAt = typeof u?.updatedAt === 'number' ? u.updatedAt : typeof u?.updatedAt === 'string' ? Date.parse(u.updatedAt) : undefined
    const usageFresh = !!u && updatedAt !== undefined && Number.isFinite(updatedAt) && now - updatedAt <= USAGE_FRESH_MS
    const wins: any[] = (u?.windows ?? []).filter((w: any) => w.label === '5h' || w.label === '7d')
    const resetOf = (w: any) => (w.resetsAt ? Date.parse(w.resetsAt) : undefined)
    const fullWins = wins.filter((w) => w.usedPercent >= 100 && (resetOf(w) === undefined || resetOf(w)! > now))
    const blocked = slot?.blockedUntil && slot.blockedUntil > now ? Number(slot.blockedUntil) : undefined
    const resets = [...fullWins.map(resetOf).filter((x): x is number => x !== undefined), ...(blocked ? [blocked] : [])]
    return {
      name, present: !!slot, usageFresh, updatedAt,
      full: fullWins.length > 0 || !!blocked, score: Math.max(0, ...wins.map((w) => w.usedPercent ?? 0)),
      resetAt: resets.length ? Math.max(...resets) : undefined,
    }
  })
}

export type ClassifyInput = {
  transcript: string; status: string | null; model: string | null; account: string | null
  usage: any; auth: any; now: number; stallMin?: number; lastWriteAt?: number
}

export function classify(i: ClassifyInput): Classification {
  const now = i.now
  const status = normStatus(i.status)
  const entries = transcriptEntries(i.transcript)
  const accounts = accountStates(i.usage, i.auth, now)
  const events: Classification['events'] = []
  for (const a of accounts) if (a.present && !a.usageFresh) events.push({ kind: 'lane.usage_stale', severity: 'info', data: { account: a.name, updatedAt: a.updatedAt ?? null } })

  const assistants = entries.filter((e) => e.kind === 'assistant')
  const lastOkIdx = entries.map((e) => e.kind === 'assistant' && e.ok).lastIndexOf(true)
  const lastErr = [...entries].reverse().find((e) => e.kind === 'assistant' && !e.ok && e.error)
  const lastErrIdx = lastErr ? entries.lastIndexOf(lastErr) : -1
  const current = lastErr && lastErrIdx > lastOkIdx ? lastErr : null
  const preAssistant = !!current && lastOkIdx < 0
  const provider = (i.model?.split('/')[0] ?? null) || current?.provider || [...assistants].reverse().find((a) => a.provider)?.provider || null

  const deliveries = entries.filter((e) => e.kind === 'delivery')
  const lastDelivery = deliveries.at(-1)
  const lastAssistantTs = assistants.at(-1)?.ts ?? -Infinity
  const stallMs = (i.stallMin ?? 20) * 60_000
  let progress: Progress
  if (!deliveries.length && !assistants.length) progress = 'no_input'
  else if (!assistants.length) progress = 'first_input_pending'
  else if (status === 'running') progress = now - (i.lastWriteAt ?? lastAssistantTs) > stallMs ? 'no_progress' : 'turn_running'
  else if (lastDelivery && lastDelivery.ts > lastAssistantTs && now - lastDelivery.ts > stallMs) progress = 'no_progress'
  else progress = 'idle_ok'

  let credential: Credential = 'ok'
  if (current) credential = QUOTA.test(current.error!) ? 'quota' : CREDENTIAL.test(current.error!) || preAssistant ? 'credential_error' : OVERLOAD.test(current.error!) ? 'overload' : 'other_error'
  const short = (current?.error ?? '').split('\n')[0]!.slice(0, 120)
  const base = { progress, credential, provider, account: i.account, events, accounts }

  if (credential === 'quota') {
    if (provider !== CLAUDE_PROVIDER) return { ...base, verdict: 'provider_error', action: 'ask', detail: `${provider ?? 'unknown provider'} quota/429: "${short}" (no Claude account rotation)` }
    const allBlocked = /all claude accounts/i.test(current!.error!)
    const candidates = allBlocked ? [] : accounts.filter((a) => a.present && a.usageFresh && !a.full && a.name !== i.account).sort((a, b) => a.score - b.score)
    if (candidates.length) return { ...base, verdict: 'quota', action: 'act', target: candidates[0]!.name, detail: `account=${i.account ?? 'unknown'} err="${short}" -> ${candidates[0]!.name}` }
    const others = accounts.filter((a) => a.name !== i.account)
    const known = allBlocked || others.every((a) => a.present && a.usageFresh && a.full)
    if (!known) return { ...base, verdict: 'unknown', action: 'ask', detail: `account=${i.account ?? 'unknown'} err="${short}": no fresh free account, usage missing/stale for ${others.filter((a) => !a.present || !a.usageFresh).map((a) => a.name).join(',') || '-'}` }
    const retry = /Soonest automatic retry: (\S+)/.exec(current!.error!)?.[1]
    const resets = accounts.map((a) => a.resetAt).filter((x): x is number => x !== undefined)
    const resetAt = retry ? Date.parse(retry) : resets.length ? Math.min(...resets) : undefined
    return { ...base, verdict: 'quota_all', action: 'act', resetAt, target: GPT_FALLBACK.model, detail: `all ${CLAUDE_ACCOUNTS.length} Claude accounts full err="${short}"` }
  }
  if (credential === 'credential_error') return { ...base, verdict: 'credential_error', action: 'ask', detail: `${preAssistant ? 'pre-assistant failure' : 'credential error'}: "${short}"` }
  if (credential === 'overload' || credential === 'other_error') return { ...base, verdict: 'stalled', action: 'ask', detail: `${credential}: "${short}"` }
  if (progress === 'first_input_pending' && deliveries[0] && now - deliveries[0].ts > FIRST_INPUT_ASK_MS) return { ...base, verdict: 'first_input_pending', action: 'ask', detail: `no assistant entry ${Math.round((now - deliveries[0].ts) / 60_000)}m after the first input` }
  if (progress === 'no_progress') return { ...base, verdict: 'stalled', action: 'ask', detail: `no assistant write for ${Math.round((now - Math.max(lastAssistantTs, lastDelivery?.ts ?? -Infinity)) / 60_000)}m (${status})` }
  return { ...base, verdict: 'ok', action: 'none', detail: status }
}

if (import.meta.main) {
  const HOME = process.env.HOME!
  const { readMap } = await import('./registry')
  const { readLaneStatus } = await import('./rpc')
  const { findSessionFile } = await import('./sess')
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
  const usage = readJson(`${HOME}/.omo/agent/subscription-usage.json`)
  const auth = readJson(`${HOME}/.omo/agent/auth.json`)
  const snap = readLaneStatus()
  const map = readMap()
  const keys = argv.includes('--all') ? Object.values(map).filter((e) => e.status === 'open' && !isLeadKey(e.key)).map((e) => e.key) : argv.filter((a) => !a.startsWith('--'))
  if (!keys.length) { console.error('usage: lane-classify.ts <key> | --all [--json]'); process.exit(2) }
  for (const key of keys) {
    const e = map[key]
    if (!e) { console.log(JSON.stringify({ key, error: 'unknown lane' })); process.exitCode = 2; continue }
    const path = e.sessionPath && existsSync(e.sessionPath) ? e.sessionPath : findSessionFile(e.sessionId, e.cwd)
    const text = path ? readFileSync(path, 'utf8').slice(-400_000) : ''
    let account: string | null = null
    try { account = path ? JSON.parse(readFileSync(`${path}.claude-sdk-oauth-binding.json`, 'utf8')).accountName ?? null : null } catch { account = (e.account as string | null) ?? null }
    const row = snap?.lanes?.[key]
    const c = classify({ transcript: text, status: row?.status ?? null, model: row?.model ?? (e.model as string | undefined) ?? null, account, usage, auth, now: Date.now() })
    console.log(json ? JSON.stringify({ key, ...c }) : `LANE_CLASS ${key} ${c.verdict}${c.target ? ` target=${c.target}` : ''} ${c.detail}${c.events.length ? ` events=${c.events.map((x) => x.kind).join(',')}` : ''}`)
  }
}
