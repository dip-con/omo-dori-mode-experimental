// Nightly review: work the owner asked for that never got finished (dori-improve nightreview).
//   bun daily-review.ts [--date YYYY-MM-DD] [--no-discord] [--now ISO]   write heartbeat/daily-review-<date>.md, print one line
//   bun daily-review.ts --loop MIN [--at HH:MM]                         after HH:MM KST (default 23:30) print the line once per day
// Output line: DAILY_REVIEW <date> open=<n> path=<file>
// Sources: ledger.json (requests/promises), inbox.jsonl (owner Discord), Discord REST (read-only GET, bot replies),
//          lane session files (~/.omo/agent/sessions): last assistant turn, [REPORT] lines, and messenger sends (each enabled source's transcriptSend pattern).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRequest, type Ledger, load, redact } from './ledger'
import { doriHome, cfg } from './config'
import { transcriptSends } from './sources'

const HOME = process.env.HOME!
const DORI_HOME = `${doriHome()}`
const OUT_DIR = process.env.DORI_REVIEW_DIR ?? `${DORI_HOME}/heartbeat`
const SESSIONS = process.env.DORI_SESSIONS ?? `${HOME}/.omo/agent/sessions`
const INBOX = process.env.DORI_INBOX ?? `${DORI_HOME}/inbox.jsonl`
const MAP = process.env.DORI_SESSIONS_MAP ?? `${DORI_HOME}/sessions-map.json`
const H = 3600_000

export type Msg = { src: string; room: string; at: number; text: string; id?: string }
export type Report = { key: string; kind: string; text: string; at: number }
export type SessionInfo = { file: string; id: string; parent?: string; activeInDay: boolean; last: { ts: number; stopReason?: string; error?: string } | null; reports: Report[]; says: Msg[] }
export type Req = { id: string; channel: string; text: string; at: number; status: string }

export const dayRange = (date: string): [number, number] => { const s = Date.parse(`${date}T00:00:00+09:00`); return [s, s + 24 * H] }
export const kstLabel = (ms: number) => new Date(ms + 9 * H).toISOString().slice(5, 16).replace('T', ' ') + ' KST'
export const mask = (s: string) =>
  redact(s)
    .replace(/\b(sk-[\w-]{10,}|gh[pousr]_\w{16,}|glpat-[\w-]{10,}|xox[abp]-[\w-]{10,})/g, '***')
    .replace(/\b[\w-]{20,}\.[\w-]{6,}\.[\w-]{20,}\b/g, '***')
    .replace(/(Bearer|Bot)\s+[\w.-]{16,}/g, '$1 ***')
const one = (s: string, n = 140) => mask(s.replace(/\s+/g, ' ').trim()).slice(0, n)

const DONE = /(완료|끝났|끝냈|끝이야|(?<![가-힣])끝(?![가-힣])|마무리|마쳤|머지했|머지됐|머지 끝|배포했|배포됐|배포 끝|반영했|반영됐|올렸|해결했|수정했|만들었|됐어|되었|\bdone\b|merged|deployed)/i
const START = /(시작했|시작할게|시작함|작업 시작|착수|진행할게|진행 중|하는 중|돌리는 중|할게|해볼게|확인해볼게)/
export const isStartOnly = (t: string) => START.test(t) && !DONE.test(t)
export const isCompletion = (t: string) => DONE.test(t) && !START.test(t)

const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out))
  return out
}
const REPORT_RE = /\[REPORT\]\s+([\w.-]+)\s*\|\s*(milestone|blocker|question|done)\s*\|\s*([^\n"`]+)/g

const SENDS = transcriptSends()

export function parseSession(file: string, text: string, [from, to]: [number, number]): SessionInfo {
  const info: SessionInfo = { file, id: /_([0-9a-f-]{36})\.jsonl$/.exec(file)?.[1] ?? '', activeInDay: false, last: null, reports: [], says: [] }
  const seen = new Set<string>()
  for (const l of text.split('\n')) {
    if (!l) continue
    const isAsst = l.includes('"role":"assistant"')
    if (!isAsst && !l.includes('[REPORT]') && !l.includes('"type":"session"')) continue
    let j: any
    try { j = JSON.parse(l) } catch { continue }
    if (j.type === 'session') { info.id = j.id ?? info.id; if (j.parentSession) info.parent = /_([0-9a-f-]{36})\.jsonl$/.exec(j.parentSession)?.[1] ?? j.parentSession; continue }
    const ts = Date.parse(j.timestamp)
    const strs = strings(j.message?.content ?? j)
    for (const s of strs) for (const m of s.matchAll(REPORT_RE)) {
      const key = `${m[1]}|${m[2]}|${m[3]}`
      if (!seen.has(key)) { seen.add(key); info.reports.push({ key: m[1]!, kind: m[2]!, text: m[3]!.trim(), at: ts }) }
    }
    if (!isAsst || j.message?.role !== 'assistant') continue
    if (ts >= from && ts < to) info.activeInDay = true
    info.last = { ts, stopReason: j.message.stopReason, error: j.message.errorMessage }
    for (const c of j.message.content ?? []) {
      if (c.type !== 'toolCall') continue
      for (const s of strings(c.arguments)) for (const { source, re } of SENDS) for (const m of s.matchAll(re)) info.says.push({ src: source, room: m[1]!, at: ts, text: m[2]! })
    }
  }
  return info
}

export type Review = { date: string; unanswered: Req[]; pastDue: Ledger['promises']; stopped: { lane: string; detail: string; at: number }[]; started: Msg[] }

export function build(o: { date: string; now: number; ledger: Ledger; inbox: Req[]; bot: Msg[]; sessions: SessionInfo[]; laneKeys?: Record<string, string> }): Review {
  const [from, to] = dayRange(o.date)
  const reqs = new Map<string, Req>()
  for (const r of o.ledger.requests) if (r.at >= from && r.at < to) reqs.set(r.id, { id: r.id, channel: r.channel, text: r.text, at: r.at, status: r.status })
  for (const r of o.inbox) if (r.at >= from && r.at < to && isRequest(r.text) && !reqs.has(r.id)) reqs.set(r.id, r)
  const discordBot = o.bot.filter((m) => m.src === 'discord' && m.id)
  const answered = (r: Req) => ['responded', 'done', 'dropped'].includes(r.status) || discordBot.some((m) => m.room === r.channel && BigInt(m.id!) > BigInt(r.id))
  const unanswered = [...reqs.values()].filter((r) => !answered(r)).sort((a, b) => a.at - b.at)

  const pastDue = o.ledger.promises.filter((p) => p.status === 'open' && p.due <= o.now && p.createdAt >= from && p.createdAt < to)

  const byId = new Map(o.sessions.map((s) => [s.id, s]))
  const childOf = new Map<string, SessionInfo>()
  for (const s of o.sessions) if (s.parent) childOf.set(s.parent, s)
  const label = (s: SessionInfo) => {
    for (let c: SessionInfo | undefined = s; c; c = childOf.get(c.id)) if (o.laneKeys?.[c.id]) return o.laneKeys[c.id]!
    return s.id.slice(0, 8) || s.file.split('/').pop()!
  }
  const stopped: Review['stopped'] = []
  for (const s of o.sessions) {
    if (!s.activeInDay || !s.last || s.last.stopReason !== 'error') continue
    const succ = childOf.get(s.id)
    stopped.push({ lane: label(s), at: s.last.ts, detail: `last turn ended in error: ${one(s.last.error ?? 'unknown', 90)}${succ ? ' (a successor session exists)' : ''}` })
  }
  const reps = new Map<string, Report>()
  for (const s of o.sessions) for (const r of s.reports.sort((a, b) => a.at - b.at)) if (r.at >= from) reps.set(r.key, r.at >= (reps.get(r.key)?.at ?? 0) ? r : reps.get(r.key)!)
  for (const r of reps.values()) if ((r.kind === 'blocker' || r.kind === 'question') && r.at >= from && r.at < to)
    stopped.push({ lane: r.key, at: r.at, detail: `last [REPORT] is ${r.kind}, no later done: ${one(r.text, 100)}` })
  void byId

  const cutoff = Math.min(to, o.now)
  const all = [...o.bot, ...o.sessions.flatMap((s) => s.says)].sort((a, b) => a.at - b.at)
  const started = all.filter((m, i) => m.at >= from && m.at < to && isStartOnly(m.text) &&
    !all.slice(i + 1).some((n) => n.at <= cutoff && n.src === m.src && n.room === m.room && isCompletion(n.text)))
  return { date: o.date, unanswered, pastDue, stopped, started }
}

export const openCount = (r: Review) => r.unanswered.length + r.pastDue.length + r.stopped.length + r.started.length

export function render(r: Review): string {
  const sec = (title: string, rows: string[]) => `## ${title} (${rows.length})\n${rows.length ? rows.map((x) => `- ${x}`).join('\n') : '- none'}\n`
  return [
    `# Daily review ${r.date} (KST)\n`,
    sec('Unanswered requests', r.unanswered.map((q) => `${kstLabel(q.at)} ch=${q.channel} "${one(q.text, 120)}"`)),
    sec('Promises past due', r.pastDue.map((p) => `due ${kstLabel(p.due)} "${p.phrase}" ch=${p.channel} | ${one(p.text, 120)}`)),
    sec('Lanes stopped mid-task', r.stopped.map((s) => `${kstLabel(s.at)} ${s.lane}: ${s.detail}`)),
    sec('Started but never completed', r.started.map((m) => `${kstLabel(m.at)} ${m.src}:${m.room} "${one(m.text, 120)}"`)),
  ].join('\n')
}

function inboxOwner(): Req[] {
  if (!existsSync(INBOX)) return []
  return readFileSync(INBOX, 'utf8').split('\n').flatMap((line) => {
    try {
      const j = JSON.parse(line)
      return j.kind === 'MSG' && j.is_owner ? [{ id: String(j.id), channel: String(j.channel_id), text: String(j.content ?? ''), at: Date.parse(j.at), status: 'open' }] : []
    } catch { return [] }
  })
}

async function discordBot(channels: string[], from: number): Promise<Msg[]> {
  const out: Msg[] = []
  try {
    const c = JSON.parse(readFileSync(`${HOME}/.config/agent-messenger/discordbot-credentials.json`, 'utf8'))
    const headers = { Authorization: `Bot ${c.bots[cfg.discord.botName].token}`, 'User-Agent': 'DiscordBot (omodori-daily-review, 1.0)' }
    const get = async (p: string): Promise<any> => {
      const r = await fetch(`https://discord.com/api/v10${p}`, { headers, signal: AbortSignal.timeout(15_000) })
      if (r.status === 429) { await Bun.sleep(((await r.json()) as any).retry_after * 1000 + 100); return get(p) }
      if (!r.ok) throw new Error(`${p} -> ${r.status}`)
      return r.json()
    }
    const me = await get('/users/@me')
    const after = ((BigInt(from) - 1420070400000n) << 22n).toString()
    for (const ch of channels) {
      try {
        for (const m of (await get(`/channels/${ch}/messages?limit=100&after=${after}`)) as any[])
          if (m.author?.id === me.id) out.push({ src: 'discord', room: ch, at: Date.parse(m.timestamp), text: String(m.content ?? ''), id: m.id })
      } catch (e) { console.error(`DAILY_REVIEW_WARN ${ch}: ${(e as Error).message}`) }
    }
  } catch (e) { console.error(`DAILY_REVIEW_WARN discord: ${(e as Error).message}`) }
  return out
}

function loadSessions(range: [number, number]): SessionInfo[] {
  const out: SessionInfo[] = []
  for (const d of existsSync(SESSIONS) ? readdirSync(SESSIONS) : []) {
    let files: string[] = []
    try { files = readdirSync(join(SESSIONS, d)) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const p = join(SESSIONS, d, f)
      try { if (statSync(p).mtimeMs < range[0]) continue; out.push(parseSession(p, readFileSync(p, 'utf8'), range)) } catch {}
    }
  }
  return out
}

export async function run(date: string, o: { discord: boolean; now: number }): Promise<{ review: Review; path: string }> {
  const range = dayRange(date)
  const ledger = load()
  const inbox = inboxOwner()
  const sessions = loadSessions(range)
  const channels = [...new Set([...ledger.requests, ...inbox].filter((r) => r.at >= range[0] && r.at < range[1]).map((r) => r.channel))]
  const bot = o.discord ? await discordBot(channels, range[0]) : []
  const laneKeys: Record<string, string> = {}
  try { for (const [k, v] of Object.entries<any>(JSON.parse(readFileSync(MAP, 'utf8')))) if (v?.sessionId) laneKeys[v.sessionId] = k } catch {}
  const review = build({ date, now: o.now, ledger, inbox, bot, sessions, laneKeys })
  mkdirSync(OUT_DIR, { recursive: true })
  const path = `${OUT_DIR}/daily-review-${date}.md`
  writeFileSync(`${path}.tmp`, render(review)); renameSync(`${path}.tmp`, path)
  return { review, path }
}

const kstDate = (ms: number) => new Date(ms + 9 * H).toISOString().slice(0, 10)
const line = (date: string, r: Review, path: string) => `DAILY_REVIEW ${date} open=${openCount(r)} path=${path}`

if (import.meta.main) {
  const opt = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
  const discord = !process.argv.includes('--no-discord')
  const loop = opt('--loop')
  if (loop) {
    const at = opt('--at') ?? '23:30'
    const stateFile = `${OUT_DIR}/daily-review-state.json`
    for (;;) {
      const now = Date.now()
      const date = kstDate(now)
      const hhmm = new Date(now + 9 * H).toISOString().slice(11, 16)
      let last = ''
      try { last = JSON.parse(readFileSync(stateFile, 'utf8')).last } catch {}
      if (hhmm >= at && last !== date) {
        try {
          const { review, path } = await run(date, { discord, now })
          mkdirSync(OUT_DIR, { recursive: true }); writeFileSync(stateFile, JSON.stringify({ last: date }))
          console.log(line(date, review, path))
        } catch (e) { console.log(`DAILY_REVIEW_WARN ${(e as Error).message}`) }
      }
      await Bun.sleep(Number(loop) * 60_000)
    }
  } else {
    const now = opt('--now') ? Date.parse(opt('--now')!) : Date.now()
    const date = opt('--date') ?? kstDate(now)
    const { review, path } = await run(date, { discord, now })
    console.log(line(date, review, path))
    for (const [t, n] of [['Unanswered requests', review.unanswered.length], ['Promises past due', review.pastDue.length], ['Lanes stopped mid-task', review.stopped.length], ['Started but never completed', review.started.length]] as const) console.log(`## ${t}: ${n}`)
  }
}
