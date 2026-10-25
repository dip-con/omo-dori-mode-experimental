// Daily wake-filter tally (주인 10-21 "집계도 잘 해놔"). Reads wake-filter.ndjson (ids, decisions, scores only; no
// message text exists there) and posts yesterday's numbers to the wake-filter Discord thread.
// usage: bun wake-filter-stats.ts [--since YYYY-MM-DD] [--days N] [--dry-run] [--log FILE]
import { readFileSync } from 'node:fs'
import { DECISION_LOG } from './kakao-wake-filter'
import { cfg } from '../../core/config'

export const THREAD = cfg.discord.wakeStatsThread
const JEV_USD_PER_MTOK = 0.042
const FALLBACK_TOKENS = 1723
const MISS_WINDOW_MS = 10 * 60_000
const MISS_HARD = new Set(['name_call', 'reply_to_bot', 'mention'])

export type Row = { at: string; room: string; chat: string; log_id?: string; decision?: string; reason?: string; ms?: number; tokens?: number | null; event?: string; lines?: number; triage?: string; follower?: boolean }
type Tally = {
  messages: number; hard: number; jevWake: number; skip: number; reaction: number; collect: number; failOpen: Record<string, number>
  held: number; jevCalls: number; tokens: number; latencies: number[]; missed: number
}
export type Summary = { start: Date; end: Date; total: Tally; rooms: Record<string, Tally> }

const empty = (): Tally => ({ messages: 0, hard: 0, jevWake: 0, skip: 0, reaction: 0, collect: 0, failOpen: {}, held: 0, jevCalls: 0, tokens: 0, latencies: [], missed: 0 })

export function parseRows(text: string): Row[] {
  return text.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Row] } catch { return [] } })
}

// Days are Korean days (UTC+9, no DST), whatever TZ the process runs in. Default window is yesterday; --since alone
// runs to now; --days counts back from today when no --since.
const KST_MS = 9 * 3600_000
const DAY_MS = 24 * 3600_000
const kstMidnight = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d) - KST_MS)
export function windowOf(args: string[], now = new Date()): { start: Date; end: Date } {
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
  const k = new Date(now.getTime() + KST_MS)
  const today = kstMidnight(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate())
  const since = get('--since')
  const days = get('--days') ? Number(get('--days')) : undefined
  if (since) {
    const [y, m, d] = since.split('-').map(Number)
    const start = kstMidnight(y!, m! - 1, d!)
    return { start, end: days ? new Date(start.getTime() + days * DAY_MS) : now }
  }
  return { start: new Date(today.getTime() - (days ?? 1) * DAY_MS), end: today }
}

export function summarize(rows: Row[], start: Date, end: Date): Summary {
  const inside = (r: Row) => { const t = Date.parse(r.at); return t >= start.getTime() && t < end.getTime() }
  const total = empty()
  const rooms: Record<string, Tally> = {}
  const add = (room: string, f: (t: Tally) => void) => { f(total); f((rooms[room] ??= empty())) }
  for (const r of rows.filter(inside)) {
    if (r.event === 'held') { add(r.room, (t) => t.held++); continue }
    if (r.event) continue
    add(r.room, (t) => {
      t.messages++
      if (r.decision === 'hard-wake') t.hard++
      else if (r.decision === 'wake') t.jevWake++
      else if (r.decision === 'skip') { t.skip++; if (r.reason === 'reaction') t.reaction++; if (r.triage === 'collect') t.collect++ }
      else if (r.decision === 'fail-open') t.failOpen[r.reason ?? '?'] = (t.failOpen[r.reason ?? '?'] ?? 0) + 1
      // A [작업] 문서방 burst is one Jev call logged on every line; only its first line counts the call.
      const called = !r.follower && (r.reason === 'jev' || r.reason === 'followup' || (r.decision === 'fail-open' && r.reason !== 'no-key'))
      if (called) { t.jevCalls++; t.tokens += r.tokens ?? FALLBACK_TOKENS }
      if (called && (r.reason === 'jev' || r.reason === 'followup') && typeof r.ms === 'number') t.latencies.push(r.ms)
    })
  }
  // A Jev skip followed within 10 minutes by someone calling the bot in the same room is a possible miss. Reaction
  // skips are left out: they never reach Jev and a call after laughter is usually a new topic.
  const hardAt = rows.filter((r) => r.decision === 'hard-wake' && MISS_HARD.has(r.reason ?? '')).map((r) => ({ chat: r.chat, t: Date.parse(r.at) }))
  for (const r of rows.filter((x) => inside(x) && x.decision === 'skip' && x.reason === 'jev')) {
    const t = Date.parse(r.at)
    if (hardAt.some((h) => h.chat === r.chat && h.t > t && h.t - t <= MISS_WINDOW_MS)) add(r.room, (x) => x.missed++)
  }
  return { start, end, total, rooms }
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '0%')
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : 0 }
const failCount = (t: Tally) => Object.values(t.failOpen).reduce((a, b) => a + b, 0)
const day = (d: Date) => { const k = new Date(d.getTime() + KST_MS); return `${String(k.getUTCMonth() + 1).padStart(2, '0')}-${String(k.getUTCDate()).padStart(2, '0')}` }

export function render(s: Summary): string {
  const t = s.total
  const last = new Date(s.end.getTime() - 1)
  const label = day(s.start) === day(last) ? day(s.start) : `${day(s.start)}~${day(last)}`
  const fail = failCount(t)
  const alerts: string[] = []
  if (t.messages && fail / t.messages > 0.1) alerts.push(`주의: fail-open ${fail}건(${pct(fail, t.messages)}), 원인 ${Object.entries(t.failOpen).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  if (t.missed) alerts.push(`주의: 놓침 후보 ${t.missed}건(${Object.entries(s.rooms).filter(([, r]) => r.missed).map(([n, r]) => `${n} ${r.missed}`).join(', ')})`)
  const lines = [
    ...alerts,
    `카톡 거름망 ${label}`,
    `메시지 ${t.messages}, 깨움 ${t.hard + t.jevWake + fail}(바로 ${t.hard}, Jev ${t.jevWake}, fail-open ${fail}), 버림 ${t.skip}(${pct(t.skip, t.messages)}, 반응어 ${t.reaction}${t.collect ? `, 그중 수집 ${t.collect}` : ''})`,
    `아낀 레인 깨움 ${t.held}회, 놓침 후보 ${t.missed}건`,
    `Jev ${t.jevCalls}회, p50 ${q(t.latencies, 0.5)}ms, p95 ${q(t.latencies, 0.95)}ms, 약 $${((t.tokens * JEV_USD_PER_MTOK) / 1e6).toFixed(4)}`,
  ]
  if (fail && !alerts.some((a) => a.includes('fail-open'))) lines.push(`fail-open 원인: ${Object.entries(t.failOpen).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  const rooms = Object.entries(s.rooms).sort((a, b) => b[1].messages - a[1].messages)
  if (rooms.length) lines.push('방별:')
  for (const [name, r] of rooms) lines.push(`- ${name}: ${r.messages}건, 버림 ${r.skip}(${pct(r.skip, r.messages)}), 아낌 ${r.held}, fail-open ${failCount(r)}, 놓침 ${r.missed}`)
  return lines.join('\n')
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const logArg = args.indexOf('--log')
  const file = logArg >= 0 ? args[logArg + 1]! : DECISION_LOG
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch (e) { console.error(new Date().toISOString(), 'no decision log', file, (e as Error)?.message) }
  const { start, end } = windowOf(args)
  const report = render(summarize(parseRows(text), start, end))
  if (args.includes('--dry-run')) {
    console.log(report)
  } else {
    const p = Bun.spawn(['agent-discordbot', 'message', 'send', THREAD, report], { stdout: 'pipe', stderr: 'pipe' })
    const code = await p.exited
    console.log(new Date().toISOString(), 'wake-filter-stats sent', 'exit', code)
    if (code !== 0) { console.error(await new Response(p.stderr).text()); process.exit(1) }
  }
}
