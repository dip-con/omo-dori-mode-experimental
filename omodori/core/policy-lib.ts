// Shared policy helpers (redesign S9; bokdong-fork-synthesis.md §2 items #3 #4 #7). Pure functions, no I/O.
//   headroom      per window: remaining% / remaining-time% (cap 1000%; a window whose reset has passed is fresh);
//                 account score = the tightest window; usage older than max(3 x poll, 15) min is not used
//   switchBack    return to the original account only after N consecutive unblocked checks; an unreadable check is not
//                 clear (count unchanged), one blocked check resets the count
//   openToolCall  start time of the last assistant toolCall that has no toolResult yet (stall: "one tool running N min"
//                 versus "silent")
export const HEADROOM_CAP = 1000
export const CLAUDE_PROVIDER = 'anthropic-subscription'
export const SWITCH_BACK_N = Number(process.env.DORI_SWITCH_BACK_N ?? 3)
const CORE = new Set(['5h', '7d'])
const LABEL_MIN: Record<string, number> = { '5h': 300, '7d': 10080 }

export type Window = { label: string; usedPercent?: number; windowMinutes?: number; resetsAt?: string }
export type Headroom = { name: string; present: boolean; fresh: boolean; score: number | null; full: boolean; windows: { label: string; score: number }[] }

/** remaining% / remaining-time% of one window, in percent (100 = on pace), capped at HEADROOM_CAP. */
export function windowHeadroom(w: Window, now: number): number {
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  if (Number.isFinite(reset) && reset <= now) return 100
  const used = Math.min(100, Math.max(0, w.usedPercent ?? 0))
  if (used >= 100) return 0
  const lenMs = (w.windowMinutes ?? LABEL_MIN[w.label] ?? 300) * 60_000
  const leftPct = Number.isFinite(reset) ? Math.max(0, Math.min(100, ((reset - now) / lenMs) * 100)) : 100
  if (leftPct <= 0) return HEADROOM_CAP
  return Math.min(HEADROOM_CAP, ((100 - used) / leftPct) * 100)
}

/** Usage entries are fresh for max(3 x their poll interval, 15) min; the poll interval is nextAt - updatedAt (default 5 min). */
export function usageFresh(u: any, now: number): boolean {
  const updated = typeof u?.updatedAt === 'number' ? u.updatedAt : typeof u?.updatedAt === 'string' ? Date.parse(u.updatedAt) : NaN
  if (!Number.isFinite(updated)) return false
  const poll = typeof u?.nextAt === 'number' && u.nextAt > updated ? u.nextAt - updated : 5 * 60_000
  return now - updated <= Math.max(3 * poll, 15 * 60_000)
}

export function accountHeadroom(name: string, usage: any, auth: any, now: number): Headroom {
  const present = ((auth?.[CLAUDE_PROVIDER]?.accounts ?? []) as any[]).some((s) => s?.name === name)
  const u = usage?.accounts?.[`${CLAUDE_PROVIDER}/${name}`]
  const fresh = usageFresh(u, now)
  const wins = ((u?.windows ?? []) as Window[]).filter((w) => CORE.has(w.label)).map((w) => ({ label: w.label, score: windowHeadroom(w, now) }))
  const slot = ((auth?.[CLAUDE_PROVIDER]?.accounts ?? []) as any[]).find((s) => s?.name === name)
  const blocked = !!slot?.blockedUntil && slot.blockedUntil > now
  const score = !fresh || !wins.length ? null : blocked ? 0 : Math.min(...wins.map((w) => w.score))
  return { name, present, fresh, score, full: blocked || (score !== null && score <= 0), windows: wins }
}

/** Highest-headroom Claude account other than `current`; only present, fresh, non-full accounts are candidates. */
export function pickAccount(names: string[], current: string | null, usage: any, auth: any, now: number): Headroom | null {
  const c = names.filter((n) => n !== current).map((n) => accountHeadroom(n, usage, auth, now))
    .filter((h) => h.present && h.fresh && h.score !== null && !h.full)
  c.sort((a, b) => b.score! - a.score!)
  return c[0] ?? null
}

export const isClaudeModel = (model: string | null | undefined) => !!model && model.startsWith(`${CLAUDE_PROVIDER}/`)

export type Check = 'clear' | 'blocked' | 'unreadable'
export const accountCheck = (h: Headroom): Check => (!h.present || !h.fresh || h.score === null ? 'unreadable' : h.full ? 'blocked' : 'clear')

/** One switch-back check. `fire` is true exactly once, on the N-th consecutive clear check. */
export function switchBackStep(count: number, check: Check, n = SWITCH_BACK_N): { count: number; fire: boolean } {
  if (check === 'blocked') return { count: 0, fire: false }
  if (check === 'unreadable') return { count, fire: false }
  return { count: count + 1, fire: count + 1 === n }
}

/** The last assistant entry's toolCall(s) without a toolResult: start time and tool name (null when none is open). */
export function openToolCall(text: string): { since: number; name: string } | null {
  let pending = new Map<string, { since: number; name: string }>()
  for (const l of text.split('\n')) {
    if (!l.includes('"role":"assistant"') && !l.includes('"role":"toolResult"')) continue
    let j: any
    try { j = JSON.parse(l) } catch { continue }
    const m = j?.message
    if (m?.role === 'assistant') {
      const calls = Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === 'toolCall' && typeof c.id === 'string') : []
      pending = new Map(calls.map((c: any) => [c.id, { since: Date.parse(j.timestamp), name: String(c.name ?? '?') }]))
    } else if (m?.role === 'toolResult' && typeof m.toolCallId === 'string') pending.delete(m.toolCallId)
  }
  const open = [...pending.values()].filter((p) => Number.isFinite(p.since))
  return open.length ? open.reduce((a, b) => (b.since > a.since ? b : a)) : null
}

export function stallDetail(text: string, lastWriteMs: number, now: number): { kind: 'tool_running' | 'silent'; minutes: number; tool?: string } {
  const t = openToolCall(text)
  if (t) return { kind: 'tool_running', minutes: Math.round((now - t.since) / 60_000), tool: t.name }
  return { kind: 'silent', minutes: Math.round((now - lastWriteMs) / 60_000) }
}
