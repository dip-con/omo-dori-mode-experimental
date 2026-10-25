// Wake filter (주인 10-21): decides whether a KakaoTalk line should wake its lane. Built from the experiment in
// docs/wake-filter-lab-20261021/RESULT.md: hard rules first, reaction-only lines dropped, then Jev v3 (7 Noul
// questions in one request, jev-1.13.0, threshold 0.38). Any Jev failure wakes (fail-open), so a dead filter
// behaves like no filter. The decision log keeps ids, scores and latency only, never message text.
import { appendFileSync, readFileSync } from 'node:fs'
// Per-room switches from kakao-rooms.json: maskPii masks personal/financial lines before the external Jev call
// (replay 809: 12 states changed, must-wake misses +0; pii-guard.ts is a copy of rag/integration/pii-guard.ts).
// noJev never calls Jev (the owner's non-reaction lines always wake). stripSelf removes the bot's own lines and ledger
// titles before the Jev call; text a user writes stays (it is the message).
import { sanitizeJevState } from './pii-guard'
import { botForLane, callSource, cfg, kakaoLogs, type Bot } from './config'
export function withoutSelf(state: Record<string, unknown>): Record<string, unknown> {
  const lines = Array.isArray(state.previous_lines) ? (state.previous_lines as { is_bot?: boolean }[]).filter((l) => !l.is_bot) : state.previous_lines
  const out: Record<string, unknown> = { ...state, previous_lines: lines, bot_recent_replies: [] }
  if (Array.isArray(state.open_requests)) out.open_requests = (state.open_requests as OpenRequest[]).map((q) => ({ requester: q.requester, status: q.status }))
  if (Array.isArray(state.bot_recent_work)) out.bot_recent_work = (state.bot_recent_work as { requester: string; minutes_ago: number }[]).map((q) => ({ requester: q.requester, minutes_ago: q.minutes_ago }))
  return out
}

export const MODEL = 'jev-1.13.0'
export const THRESHOLD = 0.38
export const TIMEOUT_MS = 1000
export const BOT_ID = cfg.kakao.botUserId
const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const KEY_FILE = `${process.env.HOME}/.config/omodori/typesafe.env`
export const DECISION_LOG = process.env.WAKE_FILTER_LOG ?? `${kakaoLogs()}/wake-filter.ndjson`

// Bot names, call words and descriptions come from config.json bots[] (the Jev state carries name and about).
type BotRules = { name: string; about: string; call: RegExp | null; command: RegExp | null }
export function botRules(bot: Bot): BotRules {
  const calls = callSource(bot)
  const command = bot.commands?.length ? new RegExp(`^\\s*(?:(?:${calls ?? '(?!)'})\\s*)?(?:${bot.commands.join('|')})`) : null
  return { name: bot.name, about: bot.about, call: calls ? new RegExp(calls) : null, command }
}
export const REACTION = /^[\sㅋㅎㅠㅜ.!?~^]*$/
const POSITIVE = ['seeks_bot', 'addressed_to_bot', 'continues_bot_thread', 'adds_to_bot_task', 'work_request'] as const

// v3 from docs/wake-filter-lab-20261021/scripts/prompts.ts, copied verbatim (the threshold was tuned on this text).
export const QUESTIONS = {
  seeks_bot: { type: 'noul', instructions: 'Is the author of `message` calling for the bot or asking the bot to answer or do something?' },
  addressed_to_bot: { type: 'noul', instructions: 'Is `message` said to the bot, rather than to other people in the room?' },
  continues_bot_thread: { type: 'noul', instructions: 'Is `message` the author\'s next turn in a conversation they were having with the bot just before?' },
  adds_to_bot_task: { type: 'noul', instructions: 'Does `message` give the bot material for a task the bot is doing or was asked to do, such as a file, photo, link, new version, correction or extra detail?' },
  work_request: {
    type: 'noul',
    instructions: 'Is `message` an instruction, request, decision or question about the work that `bot.about` says the bot does in this room?',
    criteria: {
      true: 'Asks for or steers the bot\'s work: "진행해", "고쳐", "올려", "1번으로 가자", "~해줘", "알려줘", a status question, or a choice the bot asked for. The bot\'s name does not need to appear.',
      false: 'Small talk, laughter, thanks, or talk between people that does not ask the bot for anything.',
    },
  },
  only_reaction: { type: 'noul', instructions: 'Is `message` only a reaction, such as laughter, an emoji, "ㅇㅋ", "오케이", "네 알겠습니다" or thanks, with no request, question or new information?' },
  to_other_person: { type: 'noul', instructions: 'Is `message` meant for a person in the room other than the bot?' },
}

// [작업] 문서방 room (주인 10-21): the secretary answers work it was not called for, so each line is triaged into
// respond / collect (context for the next wake only) / discard. Same Noul style as v3, plus the secretary's open
// request titles from its ledger so "is this a follow-up to work it holds" can be judged.
export const LEDGER = process.env.OMODORI_REQUESTS_LEDGER ?? cfg.kakao.requestsLedger
const CLOSED = new Set(['완료', '취소'])
export type OpenRequest = { title: string; requester: string; status: string }
export type LedgerReq = { user_id?: string; title?: string; nick?: string; status?: string; created?: string; updated?: string; log?: { at?: string }[] }
export function readLedger(file = LEDGER): LedgerReq[] {
  try { const j = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(j) ? j : j.requests ?? [] } catch { return [] }
}
const isOpenAt = (q: LedgerReq, at: number) => Date.parse(q.created ?? '') <= at && (!CLOSED.has(q.status ?? '') || Date.parse(q.updated ?? '') > at)
const openOf = (list: LedgerReq[], at: number): OpenRequest[] => list.filter((q) => isOpenAt(q, at)).slice(-15)
  .map((q) => ({ title: String(q.title ?? '').slice(0, 80), requester: String(q.nick ?? ''), status: String(q.status ?? '') }))
export function openRequests(at = Date.now(), file = LEDGER): OpenRequest[] {
  return openOf(readLedger(file), at)
}
// The secretary's own text sends are not echoed into live.ndjson (only its files/photos are), so "the bot just worked
// for this person" comes from the ledger: the latest created/updated/log time of each request, titles only.
export const AUTHOR_WORK_MS = 30 * 60_000
export function ledgerView(list: LedgerReq[], at: number, senderId?: string) {
  const lastWork = (q: LedgerReq) => Math.max(-Infinity, ...[q.created, q.updated, ...(q.log ?? []).map((l) => l.at)].map((x) => Date.parse(x ?? '')).filter((t) => t <= at))
  const mins = (t: number) => Math.round((at - t) / 6000) / 10
  const recent = list.filter((q) => at - lastWork(q) <= 45 * 60_000).slice(-6)
    .map((q) => ({ requester: String(q.nick ?? ''), title: String(q.title ?? '').slice(0, 80), minutes_ago: mins(lastWork(q)) }))
  const mine = senderId ? list.filter((q) => q.user_id === senderId) : []
  const authorLast = Math.max(-Infinity, ...mine.map(lastWork))
  return {
    open_requests: openOf(list, at),
    bot_recent_work: recent,
    author: { has_open_request: mine.some((q) => isOpenAt(q, at)), bot_worked_for_author_minutes_ago: Number.isFinite(authorLast) ? mins(authorLast) : null },
  }
}

// 주인 10-21: people split one message over several lines. Lines from one person in one room are held until they go
// quiet (longer when the last line looks unfinished), capped so an answer is never held past BURST.maxMs; a direct
// call flushes the group at once.
export const BURST = { quietMs: 20_000, unfinishedMs: 30_000, maxMs: 45_000 }
const UNFINISHED = /(?:[,，:…]|\.\.|고|서|며|면|는데|은데|인데|한데|지만|거나|든지|그리고|그래서|근데|그런데|및|랑|이랑|하고|을|를|의|에|에서)$/
export const looksUnfinished = (text: string) => UNFINISHED.test(text.trim())
// A file or photo is usually followed by what to do with it, so it waits as long as an unfinished sentence.
export const waitsForMore = (line: { text: string; has_photo: boolean }) => line.has_photo || line.text.startsWith('[파일]') || looksUnfinished(line.text)
export function createBurstBuffer<T>(cfg = BURST) {
  const groups = new Map<string, { items: T[]; first: number; last: number; unfinished: boolean; now: boolean }>()
  return {
    add(key: string, item: T, at: number, unfinished: boolean, immediate = false) {
      const g = groups.get(key) ?? { items: [], first: at, last: at, unfinished: false, now: false }
      g.items.push(item)
      g.last = at
      g.unfinished = unfinished
      g.now ||= immediate
      groups.set(key, g)
    },
    due(at: number): { key: string; items: T[] }[] {
      const out: { key: string; items: T[] }[] = []
      for (const [key, g] of groups) {
        if (g.now || at - g.last >= (g.unfinished ? cfg.unfinishedMs : cfg.quietMs) || at - g.first >= cfg.maxMs) {
          out.push({ key, items: g.items })
          groups.delete(key)
        }
      }
      return out
    },
    size: () => groups.size,
  }
}
export const DOCS_QUESTIONS = {
  doc_work_request: {
    type: 'noul',
    instructions: 'Does `message` ask for document work of the kind `bot.about` describes, even if the bot is not named?',
    criteria: {
      true: 'Asks to find or pull out a form, fill it in, review, edit, convert, translate, make an estimate or quote, a work plan, a risk assessment, meeting minutes or a similar document, or changes how such a document should be made.',
      false: 'Talk between people, notices about the service, greetings, thanks, reactions, or opinions that ask for no document.',
    },
  },
  follows_open_request: {
    type: 'noul',
    instructions: 'Is `message` an answer, file, photo, link, correction, extra instruction or status question for one of `open_requests`, or for something the bot asked or delivered in `previous_lines` or `bot_recent_replies`?',
  },
  question_to_bot: { type: 'noul', instructions: 'Is `message` a question meant for the bot rather than for a person in the room?' },
  seeks_bot: QUESTIONS.seeks_bot,
  addressed_to_bot: QUESTIONS.addressed_to_bot,
  useful_context: {
    type: 'noul',
    instructions: 'Does `message` share site information, a schedule, a file, or a decision that later document work in this room would need, even though it asks the bot for nothing now?',
    criteria: {
      true: 'Site or project facts, dates and plans for upcoming document work, a shared file or photo, or a decision about what the bot should or should not do.',
      false: 'Greetings, thanks, reactions, notices about the service being down or how to call the bot, and chat with nothing later document work would use.',
    },
  },
  only_reaction: QUESTIONS.only_reaction,
  to_other_person: QUESTIONS.to_other_person,
}
// Tuned in docs/wake-filter-lab-20261021/scripts/docs3.ts (results/docs3-summary.json): highest respond threshold with
// tune-half respond recall >= 98%; collect threshold best separating collect from discard on the tune half.
export const DOCS_RESPOND_AT = 0.27
export const DOCS_COLLECT_AT = 0.71
export const DOCS_RESPOND_KEYS = ['doc_work_request', 'follows_open_request', 'question_to_bot', 'seeks_bot', 'addressed_to_bot'] as const
export type Triage = 'respond' | 'collect' | 'discard'
export function triageOf(scores: Record<string, number>, hasMaterial: boolean, respondAt: number, collectAt: number): Triage {
  const respond = Math.max(...DOCS_RESPOND_KEYS.map((k) => scores[k] ?? 0))
  const vetoed = (scores.only_reaction ?? 0) >= 0.9 && (scores.doc_work_request ?? 1) < 0.5
  if (!vetoed && respond >= respondAt) return 'respond'
  // A shared file or photo is never thrown away: at worst it is kept as context.
  return hasMaterial || (scores.useful_context ?? 0) >= collectAt ? 'collect' : 'discard'
}

export type FilterRoom = {
  name: string; lane: string; owner: string[]; ownerOnly?: boolean; names?: Record<string, string>
  noJev?: boolean; maskPii?: boolean; stripSelf?: boolean
}
type Line = { author: string; is_bot: boolean; is_creator: boolean; text: string; has_photo: boolean; reply_to?: string; mentions?: string[] }
type Entry = { t: number; sid: string; logId: string; isBot: boolean; feed: boolean; line: Line; mentions: string[]; replyTo: string }
export type State = {
  room: { name: string; kind: string }
  bot: { name: string; about: string }
  previous_lines: Line[]
  bot_recent_replies: { minutes_ago: number; bot_said: string; answering: string | null; answering_text: string | null }[]
  message: Line
}
export type Decision = { decision: 'wake' | 'skip' | 'hard-wake' | 'fail-open'; reason: string; score?: number; scores?: Record<string, number>; ms?: number; tokens?: number }
export type Observed = { entry: Entry; state: State; chat: string; room: FilterRoom }

const ids = (line: string, key: string) => line.match(new RegExp(`"${key}"\\s*:\\s*"?(\\d+)`))?.[1] ?? ''

export function readKey(file = KEY_FILE): string | undefined {
  try {
    const l = readFileSync(file, 'utf8').split('\n').find((x) => x.startsWith('TYPESAFE_API_KEY='))
    return l?.slice('TYPESAFE_API_KEY='.length).trim().replace(/^["']|["']$/g, '') || undefined
  } catch { return undefined }
}

export function createWakeFilter(opts: {
  fetch?: typeof fetch; apiKey?: () => string | undefined; log?: (rec: Record<string, unknown>) => void
  nicks?: Record<string, string>; now?: () => number; timeoutMs?: number; ledger?: () => LedgerReq[]
} = {}) {
  const doFetch = opts.fetch ?? fetch
  const apiKey = opts.apiKey ?? (() => readKey())
  const log = opts.log ?? ((rec) => appendFileSync(DECISION_LOG, JSON.stringify(rec) + '\n'))
  const nicks = opts.nicks ?? {}
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  const history = new Map<string, Entry[]>()
  const lastWake = new Map<string, number>()

  const rules = new Map<string, BotRules>()
  const botOf = (room: FilterRoom) => { let r = rules.get(room.lane); if (!r) rules.set(room.lane, (r = botRules(botForLane(room.lane)))); return r }
  const nameOf = (room: FilterRoom, sid: string, isBot: boolean, sender?: string) =>
    isBot ? botOf(room).name : room.owner.includes(sid) ? '주인' : room.names?.[sid] ?? sender ?? nicks[sid] ?? `user${sid.slice(-4)}`

  // Records every line of a registered room (bot lines included) and returns the Jev state as it stood before it.
  function observe(raw: string, room: FilterRoom): Observed | null {
    let m: { is_from_me?: boolean; text?: unknown; sender?: string; timestamp?: string; photo_url?: string; file_name?: string; message_type?: number }
    try { m = JSON.parse(raw) } catch { return null }
    const chat = ids(raw, 'chat_id')
    const sid = ids(raw, 'sender_id')
    const isBot = !!m.is_from_me
    const t = Date.parse(m.timestamp ?? '') || (opts.now ?? Date.now)()
    const mentions = raw.includes('"mentioned_user_ids"') ? [...(raw.split('"mentioned_user_ids":')[1]!.split(']')[0]!.matchAll(/\d+/g))].map((x) => x[0]) : []
    const replyTo = ids(raw, 'reply_to_user_id')
    const bot = botOf(room)
    const kind = m.photo_url ? 'photo' : m.file_name ? 'file' : 'text'
    const line: Line = {
      author: nameOf(room, sid, isBot, m.sender), is_bot: isBot, is_creator: room.owner.includes(sid),
      text: (kind === 'file' ? `[파일] ${m.file_name}` : String(m.text ?? '')).slice(0, 300), has_photo: kind === 'photo',
    }
    if (replyTo) line.reply_to = replyTo === BOT_ID ? bot.name : room.owner.includes(replyTo) ? '주인' : 'someone'
    if (mentions.length) line.mentions = mentions.map((x) => (x === BOT_ID ? bot.name : 'someone'))
    const entry: Entry = { t, sid, logId: ids(raw, 'log_id'), isBot, feed: Number(m.message_type) === 0, line, mentions, replyTo }
    const rs = history.get(chat) ?? []
    const prev = rs.filter((x) => !x.feed).slice(-12)
    const recent: State['bot_recent_replies'] = []
    rs.forEach((b, j) => {
      if (!b.isBot || t - b.t > 45 * 60_000) return
      const asked = rs.slice(0, j).reverse().find((x) => !x.isBot && !x.feed)
      recent.push({ minutes_ago: Math.round((t - b.t) / 6000) / 10, bot_said: b.line.text.slice(0, 120), answering: asked?.line.author ?? null, answering_text: asked?.line.text.slice(0, 120) ?? null })
    })
    rs.push(entry)
    history.set(chat, rs.slice(-200))
    const state: State = {
      room: { name: room.name, kind: room.ownerOnly ? '1:1' : '단톡' },
      bot: { name: bot.name, about: bot.about },
      previous_lines: prev.map((x) => x.line),
      bot_recent_replies: recent.slice(-6),
      message: line,
    }
    return { entry, state, chat, room }
  }

  function hardReason(o: Observed): string | null {
    const { entry: e, room } = o
    if (e.feed) return 'feed'
    if (room.ownerOnly) return 'direct_room'
    if (e.mentions.includes(BOT_ID)) return 'mention'
    if (e.replyTo === BOT_ID) return 'reply_to_bot'
    if (botOf(room).call?.test(e.line.text)) return 'name_call'
    if (botOf(room).command?.test(e.line.text)) return 'command'
    if (e.line.has_photo) {
      const woke = lastWake.get(`${o.chat}:${e.sid}`)
      if (woke !== undefined && e.t - woke <= 45 * 60_000) return 'photo_by_engaged'
      const rs = history.get(o.chat) ?? []
      const engaged = rs.some((b) => b.isBot && e.t - b.t <= 45 * 60_000 && rs.some((x) => !x.isBot && x.sid === e.sid && x.t <= b.t && b.t - x.t <= 5 * 60_000))
      if (engaged) return 'photo_by_engaged'
    }
    return null
  }

  async function callJev(room: FilterRoom, state: unknown, questions: unknown): Promise<{ scores: Record<string, number>; tokens?: number } | { error: string }> {
    if (room.noJev) return { error: 'no-jev-room' }
    const key = apiKey()
    if (!key) return { error: 'no-key' }
    const own = room.stripSelf ? withoutSelf(state as Record<string, unknown>) : state
    let res: Response
    try {
      res = await doFetch(JEV_URL, {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, state: room.maskPii ? sanitizeJevState(own) : own, questions }),
      })
    } catch (e) {
      const name = (e as Error)?.name
      return { error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' }
    }
    if (!res.ok) return { error: `http-${res.status}` }
    let scores: Record<string, number>
    let tokens: number | undefined
    try {
      const data = (await res.json()) as { answers?: Record<string, { noul?: number }>; usage?: { input_tokens?: number } }
      tokens = data.usage?.input_tokens
      scores = Object.fromEntries(Object.entries(data.answers ?? {}).map(([k, v]) => [k, Number(v?.noul)]))
    } catch { return { error: 'bad-json' } }
    if (!Object.values(scores).some(Number.isFinite)) return { error: 'no-answers' }
    return { scores, tokens }
  }

  async function ask(room: FilterRoom, state: State): Promise<{ score: number; scores: Record<string, number>; tokens?: number } | { error: string }> {
    const r = await callJev(room, state, QUESTIONS)
    if ('error' in r) return r
    const { scores, tokens } = r
    const pos = POSITIVE.map((k) => scores[k]).filter((x): x is number => Number.isFinite(x))
    if (!pos.length) return { error: 'no-answers' }
    // RESULT.md combine rule: max of the five positive questions; vetoed when it is only a reaction and no work request.
    const vetoed = (scores.only_reaction ?? 0) >= 0.9 && (scores.work_request ?? 1) < 0.5
    return { score: vetoed ? 0 : Math.max(...pos), scores, tokens }
  }

  async function decide(o: Observed): Promise<Decision> {
    const t0 = performance.now()
    let d: Decision
    const hard = hardReason(o)
    if (hard) d = { decision: 'hard-wake', reason: hard }
    else if (!o.entry.line.has_photo && REACTION.test(o.entry.line.text)) d = { decision: 'skip', reason: 'reaction' }
    else if (o.room.noJev) d = o.entry.line.is_creator ? { decision: 'wake', reason: 'owner_room' } : { decision: 'skip', reason: 'not_owner' }
    else {
      const r = await ask(o.room, o.state)
      if ('error' in r) d = { decision: 'fail-open', reason: r.error }
      else d = { decision: r.score >= THRESHOLD ? 'wake' : 'skip', reason: 'jev', score: Math.round(r.score * 1000) / 1000, scores: round(r.scores), tokens: r.tokens }
    }
    d.ms = Math.round(performance.now() - t0)
    if (d.decision === 'hard-wake' || d.decision === 'wake') lastWake.set(`${o.chat}:${o.entry.sid}`, o.entry.t)
    record(o, d)
    return d
  }

  const round = (s: Record<string, number>) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Math.round(v * 1000) / 1000]))
  function record(o: Observed, d: Decision, triage?: Triage, extra: Record<string, unknown> = {}) {
    try {
      log({ at: new Date().toISOString(), room: o.room.name, chat: o.chat, log_id: o.entry.logId, decision: d.decision, reason: d.reason, score: d.score ?? null, scores: d.scores ?? null, ms: d.ms, model: d.reason === 'jev' || d.reason === 'followup' ? MODEL : null, tokens: d.tokens ?? null, ...(triage ? { triage } : {}), ...extra })
    } catch (e) { console.error(new Date().toISOString(), 'wake-filter log failed', (e as Error)?.message) }
  }

  // [작업] 문서방 room: one judgment per burst (one person's lines held by createBurstBuffer). The secretary gate's
  // direct call / mention / reply makes the whole burst respond. A person the secretary is working for (open request,
  // ledger work in the last 30 min, or a respond in this room in the last 15 min) is treated as following up: their
  // lines respond unless Jev sees a bare reaction or talk to someone else. On a Jev failure each line falls back to
  // exactly what the gate alone did before: a 5-minute follow-up responds, anything else is dropped.
  const lastRespond = new Map<string, number>()
  type Via = 'gate' | 'group' | 'jev' | 'followup' | 'fail-open' | 'reaction'
  async function triageGroup(obs: Observed[], gates: ('called' | 'continued' | null)[], senderId: string): Promise<{ kind: Triage; via: Via }[]> {
    const t0 = performance.now()
    const first = obs[0]!, last = obs.at(-1)!
    const lines = obs.map((o) => o.entry.line)
    const finish = (each: { kind: Triage; via: Via }[], d: Decision, extra: Record<string, unknown> = {}) => {
      d.ms = Math.round(performance.now() - t0)
      obs.forEach((o, i) => record(o, i === 0 ? d : { ...d, tokens: undefined }, each[i]!.kind, { via: each[i]!.via, group: obs.length, ...extra, ...(i ? { follower: true } : {}) }))
      if (each.some((x) => x.kind === 'respond')) lastRespond.set(`${first.chat}:${senderId}`, last.entry.t)
      return each
    }
    const all = (kind: Triage, via: Via) => obs.map(() => ({ kind, via }))
    if (gates.includes('called')) return finish(gates.map((g) => ({ kind: 'respond', via: g === 'called' ? 'gate' : 'group' })), { decision: 'hard-wake', reason: 'gate_called' })
    const material = lines.some((l) => l.has_photo || l.text.startsWith('[파일]'))
    if (!material && lines.every((l) => REACTION.test(l.text))) return finish(all('discard', 'reaction'), { decision: 'skip', reason: 'reaction' })
    if (first.room.noJev) {
      const owner = first.entry.line.is_creator
      return finish(all(owner ? 'respond' : 'discard', 'gate'), owner ? { decision: 'wake', reason: 'owner_room' } : { decision: 'skip', reason: 'not_owner' })
    }
    const ledger = ledgerView((opts.ledger ?? readLedger)(), last.entry.t, senderId)
    const responded = lastRespond.get(`${first.chat}:${senderId}`)
    const engaged = ledger.author.has_open_request || (ledger.author.bot_worked_for_author_minutes_ago ?? Infinity) * 60_000 <= AUTHOR_WORK_MS
      || (responded !== undefined && last.entry.t - responded <= 15 * 60_000)
    const message = { ...last.entry.line, text: lines.map((l) => l.text).filter(Boolean).join('\n').slice(0, 600), has_photo: lines.some((l) => l.has_photo) }
    const state = { ...first.state, bot_recent_replies: last.state.bot_recent_replies, message, lines_in_message: lines.length, ...ledger }
    const r = await callJev(first.room, state, DOCS_QUESTIONS)
    if ('error' in r) return finish(gates.map((g) => ({ kind: g === 'continued' ? 'respond' : 'discard', via: 'fail-open' })), { decision: 'fail-open', reason: r.error }, { engaged })
    let kind = triageOf(r.scores, material, DOCS_RESPOND_AT, DOCS_COLLECT_AT)
    let reason = 'jev'
    if (kind !== 'respond' && engaged && (r.scores.only_reaction ?? 0) < 0.9 && (r.scores.to_other_person ?? 0) < 0.6) { kind = 'respond'; reason = 'followup' }
    const score = Math.max(...DOCS_RESPOND_KEYS.map((k) => r.scores[k] ?? 0))
    return finish(all(kind, reason === 'followup' ? 'followup' : 'jev'), { decision: kind === 'respond' ? 'wake' : 'skip', reason, score: Math.round(score * 1000) / 1000, scores: round(r.scores), tokens: r.tokens }, { engaged })
  }

  return { observe, decide, triageGroup }
}

export const wakes = (d: Decision) => d.decision !== 'skip'
