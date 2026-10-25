// Promise + request ledger (dori-improve 4, 5). State: ~/.omodori/ledger.json.
//   Promises: Bot messages (lead and lanes) with a timed commitment ("15시 재시작 때", "내일 아침", "13:50 이후")
//             are logged with a due time; at the due time a PROMISE_DUE line wakes the lead (once).
//   Requests: every owner (is_owner) Discord message is an open request; a later bot message in the same
//             channel/thread marks it "responded"; it stays open until the lead marks it done.
//   bun ledger.ts sweep [--loop MIN]                 ingest inbox + bot messages, fire due promises
//   bun ledger.ts list [promises|requests] [--all]   open items (default both)
//   bun ledger.ts promise done|drop <id>   |  bun ledger.ts promise add "<text>" --due <ISO|HH:MM>
//   bun ledger.ts request done|drop <id|all-responded>   |  bun ledger.ts brief   (morning lines: requests open > 24h, due promises)
// Every write goes through withLedger: <ledger>.lock (registry.ts acquireDirLock) + fresh re-read + apply + tmp+rename.
// The sweep does its Discord reads on an unlocked snapshot and applies the result to a fresh copy under the lock.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { acquireDirLock, doriHome } from './registry'
import { cfg, coreRef } from './config'

const HOME = process.env.HOME!
const DORI_HOME = doriHome()
const LEDGER = process.env.DORI_LEDGER ?? `${DORI_HOME}/ledger.json`
const INBOX = `${DORI_HOME}/inbox.jsonl`
const GENERAL = cfg.discord.generalChannel
const H = 3600_000

export type Promise_ = { id: string; msgId: string; channel: string; text: string; phrase: string; due: number; status: 'open' | 'done' | 'dropped'; fired?: boolean; createdAt: number }
export type Request_ = { id: string; channel: string; text: string; at: number; status: 'open' | 'responded' | 'done' | 'dropped'; respondedAt?: number; respondMsgId?: string }
export type Ledger = { since: number; cursors: Record<string, string>; promises: Promise_[]; requests: Request_[] }

const k = (ms: number) => new Date(ms + 9 * H)
const fromKst = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo, d, h, mi) - 9 * H
const kstLabel = (ms: number) => k(ms).toISOString().slice(5, 16).replace('T', ' ') + ' KST'

const PART: Record<string, number> = { 새벽: 5, 아침: 9, 오전: 10, 점심: 12, 오후: 15, 저녁: 19, 밤: 22 }
const PM = new Set(['오후', '저녁', '밤'])
const CUE_NEXT = /^\s*(까지|이후|전에|재시작 때|때)/
const CUE_VERB = /(할게|하겠|드릴|볼게|알려|보고할|확인할|재시작|다시|예정|진행할|시작할|맞춰|끝낼|올릴)/
const TIMED = /(?:(\d{1,2})[/.](\d{1,2})(?:\([^)]*\))?\s*|(\d{1,2})월\s*(\d{1,2})일\s*)?(오늘|내일|모레)?\s*(새벽|아침|오전|점심|오후|저녁|밤)?\s*(?:(\d{1,2}):(\d{2})|(\d{1,2})시(?!간)(?:\s*(\d{1,2})분|\s*(반))?)/g
const DAYPART = /(오늘|내일|모레)\s*(새벽|아침|오전|점심|오후|저녁|밤)/g
const RELATIVE = /(\d{1,3})\s*(분|시간)\s*(?:뒤|후)/g

export function extractPromises(raw: string, sentAt: number): { phrase: string; due: number }[] {
  const text = raw.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
  const now = k(sentAt)
  const [Y, M, D] = [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()]
  const out: { phrase: string; due: number; at: number }[] = []
  const cueAfter = (end: number) => CUE_NEXT.test(text.slice(end, end + 8)) || CUE_VERB.test(text.slice(end, end + 20))
  for (const m of text.matchAll(TIMED)) {
    const end = m.index! + m[0].length
    const start = m.index! + (m[0].length - m[0].trimStart().length)
    if (!cueAfter(end) || /["'“‘]$/.test(text.slice(Math.max(0, start - 1), start))) continue
    const [, md1, md2, mo1, mo2, day, part, hh, mm, h2, m2, half] = m
    let h = Number(hh ?? h2)
    const mi = Number(mm ?? m2 ?? (half ? 30 : 0))
    if (h > 24 || mi > 59) continue
    if (part && PM.has(part) && h < 12) h += 12
    const month = md1 ? Number(md1) - 1 : mo1 ? Number(mo1) - 1 : M
    const date = md1 ? Number(md2) : mo1 ? Number(mo2) : D + (day === '내일' ? 1 : day === '모레' ? 2 : 0)
    let due = fromKst(Y, month, date, h, mi)
    const explicit = !!(md1 || mo1 || day)
    const zeroPadded = (hh ?? h2 ?? '').startsWith('0')
    if (!explicit && !part && !hh && !zeroPadded && due < sentAt - 5 * 60_000 && h < 12) due += 12 * H
    if (due < sentAt - 5 * 60_000) continue
    out.push({ phrase: m[0].trim(), due, at: m.index! })
  }
  for (const m of text.matchAll(DAYPART)) {
    if (out.some((o) => Math.abs(o.at - m.index!) < 4) || !cueAfter(m.index! + m[0].length)) continue
    const off = m[1] === '내일' ? 1 : m[1] === '모레' ? 2 : 0
    const due = fromKst(Y, M, D + off, PART[m[2]!]!, 0)
    if (due >= sentAt - 5 * 60_000) out.push({ phrase: m[0], due, at: m.index! })
  }
  for (const m of text.matchAll(RELATIVE)) out.push({ phrase: m[0], due: sentAt + Number(m[1]) * (m[2] === '분' ? 60_000 : H), at: m.index! })
  return out.map(({ phrase, due }) => ({ phrase, due }))
}

const TRIVIAL = /^(ㅇㅋ|ㅇㅇ|ok|okay|오케이|ㄱㄱ|고마워|고맙|굿|넵|네|응|좋아|ㅋ+|ㅎ+|👍|thx|thanks)[\s!.~]*$/i
export const isRequest = (content: string) => content.trim().length >= 4 && !TRIVIAL.test(content.trim())

const snow = (ms: number) => ((BigInt(ms) - 1420070400000n) << 22n).toString()
const later = (a: string, b: string) => BigInt(a) > BigInt(b)

export function load(): Ledger {
  if (existsSync(LEDGER)) return JSON.parse(readFileSync(LEDGER, 'utf8'))
  return { since: Date.now() - 24 * H, cursors: {}, promises: [], requests: [] }
}
const save = (l: Ledger) => { const t = `${LEDGER}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(l, null, 1)); renameSync(t, LEDGER) }

export async function withLedger<T>(fn: (l: Ledger) => T): Promise<T> {
  const held = await acquireDirLock(`${LEDGER}.lock`)
  try {
    const l = load()
    const out = fn(l)
    save(l)
    return out
  } finally { held.release() }
}

/** --due: ISO, or HH:MM in KST (an HH:MM already past today means tomorrow at that time). */
export function resolveDue(s: string, now: number): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (m) {
    const [h, mi] = [Number(m[1]), Number(m[2])]
    if (h > 23 || mi > 59) return undefined
    const d = k(now)
    const today = fromKst(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, mi)
    return today <= now ? today + 24 * H : today
  }
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : t
}

export type BotMsg = { id: string; channel: string; content: string; at: number }

export function ingest(l: Ledger, owner: { id: string; channel_id: string; content: string; at: number }[], bot: BotMsg[], now: number): string[] {
  const events: string[] = []
  for (const o of owner) {
    if (o.at < l.since || l.requests.some((r) => r.id === o.id) || !isRequest(o.content)) continue
    l.requests.push({ id: o.id, channel: o.channel_id, text: o.content.slice(0, 300), at: o.at, status: 'open' })
  }
  for (const b of bot) {
    for (const r of l.requests) {
      if (r.status === 'open' && r.channel === b.channel && later(b.id, r.id)) Object.assign(r, { status: 'responded', respondedAt: b.at, respondMsgId: b.id })
    }
    extractPromises(b.content, b.at).forEach((p, i) => {
      const id = `${b.id}.${i}`
      if (!l.promises.some((x) => x.id === id)) l.promises.push({ id, msgId: b.id, channel: b.channel, text: b.content.replace(/\s+/g, ' ').slice(0, 200), phrase: p.phrase, due: p.due, status: 'open', createdAt: b.at, ...(p.due <= now ? { fired: true } : {}) })
    })
  }
  for (const p of l.promises) {
    if (p.status !== 'open' || p.fired || p.due > now) continue
    p.fired = true
    events.push(`PROMISE_DUE ${p.id} due ${kstLabel(p.due)} ch=${p.channel} "${p.phrase}" in: "${redact(p.text).slice(0, 140)}" -> bun ${coreRef()}/ledger.ts promise done ${p.id} (or drop ${p.id})`)
  }
  return events
}

export const redact = (s: string) =>
  s.replace(/((?:비밀번호|비번|패스워드|password|passwd|pw|토큰|token|key)\s*[:=]?\s*)\S+/gi, '$1***')
    .replace(/(?<![\w#!@$%^&*.-])(?=[\w#!@$%^&*.-]*[A-Za-z])(?=[\w#!@$%^&*.-]*\d)[\w#!@$%^&*.-]{8,}(?![\w#!@$%^&*.-])/g, '***')

export function brief(l: Ledger, now: number): string[] {
  const old = l.requests.filter((r) => (r.status === 'open' || r.status === 'responded') && now - r.at > 24 * H)
  const due = l.promises.filter((p) => p.status === 'open' && p.due <= now)
  const out: string[] = []
  if (old.length) out.push(`[요청 장부] 24시간 넘게 열린 요청 ${old.length}건: ${old.slice(0, 6).map((r) => `${r.status === 'responded' ? '(답함)' : '(미답)'} "${redact(r.text.replace(/\s+/g, ' ')).slice(0, 40)}" ${kstLabel(r.at)}`).join(' / ')}${old.length > 6 ? ' …' : ''}`)
  if (due.length) out.push(`[약속 장부] 기한 지난 약속 ${due.length}건: ${due.slice(0, 6).map((p) => `"${p.phrase}" (${kstLabel(p.due)})`).join(' / ')}`)
  return out
}

function creds() {
  const c = JSON.parse(readFileSync(`${HOME}/.config/agent-messenger/discordbot-credentials.json`, 'utf8'))
  return { Authorization: `Bot ${c.bots[cfg.discord.botName].token}`, 'User-Agent': 'DiscordBot (omodori-ledger, 1.0)' }
}
async function api(path: string): Promise<any> {
  const r = await fetch(`https://discord.com/api/v10${path}`, { headers: creds() })
  if (r.status === 429) { await Bun.sleep(((await r.json()) as any).retry_after * 1000 + 100); return api(path) }
  if (!r.ok) throw new Error(`${path} -> ${r.status}`)
  return r.json()
}

function inboxOwner(since: number) {
  if (!existsSync(INBOX)) return []
  return readFileSync(INBOX, 'utf8').split('\n').flatMap((line) => {
    try {
      const j = JSON.parse(line)
      return j.kind === 'MSG' && j.is_owner && Date.parse(j.at) >= since ? [{ id: j.id as string, channel_id: j.channel_id as string, content: String(j.content ?? ''), at: Date.parse(j.at) }] : []
    } catch { return [] }
  })
}

async function sweep(): Promise<string[]> {
  const l = load() // read-only snapshot for the fetch plan; never saved
  const now = Date.now()
  const owner = inboxOwner(l.since)
  const map = existsSync(`${DORI_HOME}/sessions-map.json`) ? JSON.parse(readFileSync(`${DORI_HOME}/sessions-map.json`, 'utf8')) : {}
  const channels = new Set<string>([GENERAL, ...owner.filter((o) => now - o.at < 72 * H).map((o) => o.channel_id),
    ...Object.values<any>(map).filter((e) => e?.status === 'open' && e.thread).map((e) => String(e.thread)),
    ...l.requests.filter((r) => r.status === 'open').map((r) => r.channel)])
  const me = await api('/users/@me')
  const bot: BotMsg[] = []
  const cursors: Record<string, string> = {}
  for (const ch of [...channels].slice(0, 30)) {
    try {
      const msgs: any[] = await api(`/channels/${ch}/messages?limit=100&after=${l.cursors[ch] ?? snow(l.since)}`)
      for (const m of msgs) if (m.author?.id === me.id) bot.push({ id: m.id, channel: ch, content: String(m.content ?? ''), at: Date.parse(m.timestamp) })
      const newest = msgs.map((m) => m.id).sort((a, b) => (later(a, b) ? -1 : 1))[0]
      if (newest) cursors[ch] = newest
    } catch (err) { console.log(`LEDGER_WARN ${ch}: ${(err as Error).message}`) }
  }
  bot.sort((a, b) => (later(a.id, b.id) ? 1 : -1))
  return withLedger((fresh) => {
    for (const [ch, id] of Object.entries(cursors)) if (!fresh.cursors[ch] || later(id, fresh.cursors[ch]!)) fresh.cursors[ch] = id
    return ingest(fresh, inboxOwner(fresh.since), bot, Date.now())
  })
}

if (import.meta.main) {
  const [cmd, a1, a2] = process.argv.slice(2)
  const l = load()
  const flag = (n: string) => process.argv.includes(n)
  const opt = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
  if (cmd === 'sweep') {
    const loop = opt('--loop')
    do {
      try { for (const e of await sweep()) console.log(e) } catch (err) { console.log(`LEDGER_WARN sweep: ${(err as Error).message}`) }
      if (loop) await Bun.sleep(Number(loop) * 60_000)
    } while (loop)
  } else if (cmd === 'list') {
    const all = flag('--all')
    if (a1 !== 'requests') for (const p of l.promises.filter((p) => all || p.status === 'open')) console.log(`P ${p.id} ${p.status}${p.fired ? '(fired)' : ''} due ${kstLabel(p.due)} "${p.phrase}" | ${redact(p.text).slice(0, 100)}`)
    if (a1 !== 'promises') for (const r of l.requests.filter((r) => all || r.status === 'open' || r.status === 'responded')) console.log(`R ${r.id} ${r.status} ${kstLabel(r.at)} ch=${r.channel} | ${redact(r.text.replace(/\s+/g, ' ')).slice(0, 100)}`)
  } else if ((cmd === 'promise' || cmd === 'request') && (a1 === 'done' || a1 === 'drop') && a2) {
    const n = await withLedger((fresh) => {
      const items: any[] = cmd === 'promise' ? fresh.promises : fresh.requests
      const hits = a2 === 'all-responded' ? items.filter((x) => x.status === 'responded') : items.filter((x) => x.id === a2 || x.id.startsWith(`${a2}.`))
      for (const x of hits) x.status = a1 === 'done' ? 'done' : 'dropped'
      return hits.length
    })
    if (!n) { console.error(`no ${cmd} ${a2}`); process.exit(1) }
    console.log(`${cmd} ${a2} -> ${a1}`)
  } else if (cmd === 'promise' && a1 === 'add' && a2) {
    const due = opt('--due') ?? ''
    const now = Date.now()
    const t = resolveDue(due, now)
    if (t === undefined) { console.error(`bad --due ${JSON.stringify(due)}: use HH:MM (KST; already past today = tomorrow) or an ISO time`); process.exit(1) }
    const id = `manual-${now}`
    await withLedger((fresh) => { fresh.promises.push({ id, msgId: id, channel: '-', text: a2, phrase: due, due: t, status: 'open', createdAt: now }) })
    console.log(`promise ${id} due ${kstLabel(t)}${/^\d{1,2}:\d{2}$/.test(due) && k(t).getUTCDate() !== k(now).getUTCDate() ? ' (tomorrow)' : ''}`)
  } else if (cmd === 'brief') {
    for (const line of brief(l, Date.now())) console.log(line)
  } else {
    console.error('usage: ledger.ts sweep [--loop MIN] | list [promises|requests] [--all] | promise done|drop|add ... | request done|drop <id> | brief')
    process.exit(2)
  }
}
