// KakaoTalk live.ndjson -> lane delivery (redesign S7). State lives in kakao-queue.sqlite
// (kakao-queue.ts): the cursor, every intake line, each room's pending/held/burst and every batch, so a restart resumes
// where it stopped instead of at the end of the log.
//   bun kakao-push.ts            run (launchd com.example.dori.kakao-push); single instance via DORI_HOME/.locks/kakao-push.lock
//   bun kakao-push.ts --check    open the queue, report cursor/rooms/batches, take and release the lock, send nothing
// Rules kept from before: QUIET 2.5 s / HOLD 8 s per room, wake-filter bursts 20/30/45 s, [호출][이어짐][문맥][rN] tags,
// HELD_MAX 12 context lines, Jev fail-open. New:
//   - a woken batch with more than 30 request lines is split into parts (own batch id each, header "[kakao-new 30개 (1/2)]");
//     context lines go only into part 1 and are trimmed first, marked "[문맥 N줄 생략]"
//   - one batch = one delivery id `kakao:<chat>:<seq>`; retries reuse it and look for its disk receipt first
//   - workers per lane when DORI_HOME/kakao-queue.json has {"workers":{"parallel":true}}; otherwise one global worker (as before)
//   - no sends to a lane under a lifecycle lease (lane-leases/<lane>/) or with registry seed.state 'pending', and none at all
//     while DORI_HOME/flags/kakao.pause-admission exists; intake and batching continue
//   - the room a lane answers in: sa-cache/room.<lane> holds its chat id (kakao-lane-ext.ts reads it with OMODORI_LANE_KEY);
//     the legacy sa-cache/active-room is still written while workers are serial
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSecretaryGate } from './kakao-secretary-gate'
import { BURST, createWakeFilter, DECISION_LOG, waitsForMore, wakes } from './kakao-wake-filter'
// 주인 10-22 [작업] 문서방 방의 [문서검색] 자기 답변은 외부 분류기·레인 문맥에 넣지 않는다.
import { isRagSelfAnswer } from './kakao-rag-guard' // local copy of rag/integration/kakao-push-rag-guard.ts (lead 10-22: no Data dependency)
import { replyQuoteLine } from './kakao-reply-quote'
import { CrashError, type Batch, type BurstItem, type Crash, type HeldLine, type PLine, Queue, queuePath, type RoomState, type SentTo } from './kakao-queue'
import { acquireDirLock, appendEvent, leaseActive, readMap } from './registry'
import { doriHome, cfg, kakaoLogs, botForLane, callPattern } from './config'

const HOME = process.env.HOME!
const DORI_HOME = doriHome()
const LOG = process.env.KAKAO_LIVE_LOG ?? `${kakaoLogs()}/live.ndjson`
// gate: the room uses the call gate + burst triage (kakao-secretary-gate.ts); replyRefs: lines get [rN] refs for replies.
export type Room = {
  name: string; lane: string; owner: string[]; ownerOnly?: boolean; pinned?: boolean; ownerFix?: boolean; note?: string; names?: Record<string, string>; wakeFilter?: boolean
  gate?: boolean; replyRefs?: boolean; noJev?: boolean; maskPii?: boolean; stripSelf?: boolean
}
export const ROOMS: Record<string, Room> = (() => {
  try { return JSON.parse(readFileSync(`${doriHome()}/kakao-rooms.json`, 'utf8')) } catch { return {} }
})()
const CHAT = /"chat_id"\s*:\s*(\d+)/
const SENDER = /"sender_id"\s*:\s*(\d+)/
const LOGID = /"log_id"\s*:\s*(\d+)/
const MTYPE = /"message_type"\s*:\s*(\d+)/
// 주인 10-14: the bot answers someone with KakaoTalk's reply (답장). Each line in a replyRefs room gets a short ref [rN];
// kakao_send(reply_to: "rN") looks it up here. Ids stay strings: log/user ids exceed 2^53.
const REPLY_REFS = process.env.REPLY_REFS_FILE ?? `${doriHome()}/sa-cache/reply-refs.json`
function mentionRef(chat: string, userId: string, nick: string) {
  let st: { next: number; refs: Record<string, unknown> }
  try { st = JSON.parse(readFileSync(REPLY_REFS, 'utf8')) } catch { st = { next: 1, refs: {} } }
  const ref = `m${st.next++}`
  st.refs[ref] = { chat, mention_id: userId, nick, at: Date.now() }
  writeFileSync(REPLY_REFS, JSON.stringify(st))
  return ref
}
function replyRef(chat: string, line: string, text: string) {
  let st: { next: number; refs: Record<string, { chat: string; log_id: string; author_id: string; message: string; type: number; at: number }> }
  try { st = JSON.parse(readFileSync(REPLY_REFS, 'utf8')) } catch { st = { next: 1, refs: {} } }
  const ref = `r${st.next++}`
  st.refs[ref] = { chat, log_id: line.match(LOGID)?.[1] ?? '', author_id: line.match(SENDER)?.[1] ?? '', message: text, type: Number(line.match(MTYPE)?.[1] ?? 1), at: Date.now() }
  const keys = Object.keys(st.refs); for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete st.refs[k]
  writeFileSync(REPLY_REFS, JSON.stringify(st))
  return ref
}
// A name call is one of the room bot's call words (config.json bots[].calls); a bot without calls is never name-called.
const callOf = (room: Room) => callPattern(botForLane(room.lane))
const nickCache = new Map<string, string>()

// Fallback when kakao-loco.ts could not name the sender: nicknames exported from the old PC app DB.
const savedNicks: Record<string, string> = (() => {
  try { return JSON.parse(readFileSync(`${doriHome()}/sa-cache/kakao-nicks.json`, 'utf8')) } catch { return {} }
})()
async function nickOf(id: string) {
  return nickCache.get(id) ?? savedNicks[id] ?? '?'
}

// Which lane gets a live.ndjson line, as what text; null = not delivered. Only the owner's own account may reach an
// ownerOnly room's lane (the unrestricted one): anything else there is dropped, not forwarded.
// A follow-up from someone who just called the bot has no call word in it, so the lane used to read it as people
// talking among themselves and stay silent (10-11). A sender who called (or continued) within CONVO_MS is still
// talking to the bot: tag it [이어짐] and extend the window. (The bot's own text sends are not echoed into live.ndjson,
// so "did the bot answer" cannot be part of the rule.)
const CONVO_MS = 5 * 60_000
const engaged = new Map<string, number>()
const gates = new Map<string, ReturnType<typeof createSecretaryGate>>()
const gateOf = (room: Room) => { let g = gates.get(room.lane); if (!g) gates.set(room.lane, (g = createSecretaryGate(botForLane(room.lane)))); return g }
const wakeFilter = createWakeFilter({ nicks: savedNicks })
type Filter = typeof wakeFilter
type Seen = ReturnType<Filter['observe']>
// wakeFilter off (the rollback switch) or an unparsed line: wake exactly as before the filter existed.
export function judge(room: Room, seen: Seen, filter = wakeFilter): Promise<boolean> {
  return room.wakeFilter && seen ? filter.decide(seen).then(wakes) : Promise.resolve(true)
}

type Routed = {
  chat: string; room: Room; text: string; sender: string; isOwner: boolean; judged?: 'respond' | 'collect'; log?: string
  burst?: { who: string; text: string; gate: 'called' | 'continued' | null; seen: NonNullable<Seen> }
}

// [작업] 문서방: one Jev judgment for one author's burst. [호출] = called directly; [요청판단] = not called but judged to
// need an answer (work request, follow-up to work the secretary holds, question to it); [문맥] = kept only as context;
// discarded lines go nowhere. [후속후보] only appears when Jev failed and the old gate decided.
export async function judgeBurst(items: Routed[], filter = wakeFilter): Promise<Routed[]> {
  const res = await filter.triageGroup(items.map((i) => i.burst!.seen), items.map((i) => i.burst!.gate), items[0]!.sender)
  return items.flatMap((it, i): Routed[] => {
    const { kind, via } = res[i]!
    const line = `${it.burst!.who}: ${it.burst!.text}`
    if (kind === 'discard') return []
    if (kind === 'collect') return [{ ...it, burst: undefined, text: `[문맥] ${line}`, judged: 'collect' as const }]
    const tag = via === 'gate' ? '[호출]' : via === 'fail-open' ? '[후속후보]' : '[요청판단]'
    return [{ ...it, burst: undefined, text: `${tag} ${line}`, judged: 'respond' as const }]
  })
}

export async function route(line: string, seen?: Seen, filter = wakeFilter, rooms: Record<string, Room> = ROOMS): Promise<Routed | null> {
  let m: { is_from_me?: boolean; text?: unknown; sender?: string; timestamp?: string; mentioned_user_ids?: string[]; reply_to_user_id?: string; reply_to_log_id?: string; reply_to_text?: string; message_type?: number }
  try { m = JSON.parse(line) } catch { return null }
  const chat = line.match(CHAT)?.[1] ?? ''
  const room = rooms[chat]
  const at = Date.parse(m.timestamp ?? '') || Date.now()
  if (m.is_from_me || !room) return null
  const sender = line.match(SENDER)?.[1] ?? ''
  const isOwner = room.owner.includes(sender)
  if (room.ownerOnly && !isOwner) return null
  if (room.ownerFix && isOwner) recordOwnerFix(at, String(m.text ?? ''))
  // Join/leave feeds (message_type 0, text = feed JSON). 주인 10-14: the bot greeted a member when someone only said they
  // recruited them; greet on the real join instead. feedType 1 invite / 4 open-chat join -> [입장], 2 leave / 6 kick -> [퇴장];
  // other feeds (blind, etc.) are dropped.
  if (Number(line.match(MTYPE)?.[1]) === 0) {
    if (room.gate) return null
    let f: { feedType?: number; members?: { nickName?: string }[] } = {}
    try { f = JSON.parse(String(m.text ?? '')) } catch {}
    const names = (f.members ?? []).map((x) => x.nickName).filter(Boolean).join(', ')
    const kind = f.feedType === 1 || f.feedType === 4 ? '입장' : f.feedType === 2 || f.feedType === 6 ? '퇴장' : ''
    if (!kind || !names) return null
    // 주인 10-14: greet a newcomer with a mention. Store each joiner (user id from the raw line, it exceeds 2^53) as a ref.
    if (kind === '입장' && room.replyRefs) {
      const ids = [...String(line).matchAll(/\\?"userId\\?"\s*:\s*(\d+)/g)].map((x) => x[1]!)
      const refs = (f.members ?? []).map((x, i) => ids[i] && x.nickName ? `[${mentionRef(chat, ids[i]!, x.nickName)}] ${x.nickName}` : x.nickName).join(', ')
      return { chat, room, sender, isOwner: false, text: `[입장] ${refs}` }
    }
    return { chat, room, sender, isOwner: false, text: `[${kind}] ${names}` }
  }
  const who = isOwner ? '주인님(주인)' : room.names?.[sender] ?? m.sender ?? (await nickOf(sender))
  const text = String(m.text ?? '')
  const key = `${chat}:${sender}`
  // lead 10-23: a reply ("이거 PDF로") carries the message it answers as one extra line.
  const quote = await replyQuoteLine(m, chat, line.match(LOGID)?.[1] ?? '', (id) => room.names?.[id] ?? savedNicks[id] ?? nickCache.get(id) ?? null)
    .then((q) => (q ? `\n${q}` : ''), () => '')
  if (room.gate) {
    const decision = gateOf(room)({ ...m, chat, sender, text, at })
    // 주인 10-21: with the filter on, the line waits in its author's burst and judgeBurst decides the whole burst.
    if (room.wakeFilter && seen) return { chat, room, sender, isOwner, text: '', burst: { who, text: text + quote, gate: decision, seen } }
    if (!decision) return null
    const tag = decision === 'called' ? '[호출]' : '[후속후보]'
    return { chat, room, sender, isOwner, text: `${tag} ${who}: ${text}${quote}` }
  }
  const called = callOf(room)?.test(text) ?? false
  const since = engaged.get(key)
  const continued = !called && since !== undefined && at - since >= 0 && at - since <= CONVO_MS
  if (called || continued) engaged.set(key, at)
  const tag = called ? '[호출] ' : continued ? '[이어짐] ' : ''
  const ref = room.replyRefs && line.match(LOGID) ? `[${replyRef(chat, line, text)}] ` : ''
  return { chat, room, sender, isOwner, text: `${ref}${tag}${who}: ${text}${quote}` }
}

// 주인 may ask the restricted group lane to change the bot itself (brief, tool bugs) in an ownerFix room (10-12). The
// lane cannot do that work; its bot_fix_request tool forwards to the lead, and it forwards these recorded owner
// texts verbatim, never the model's own wording, so only messages from the owner's account can ever reach the lead.
export const OWNER_FIX_FILE = process.env.OWNER_FIX_FILE ?? `${doriHome()}/sa-cache/owner-fix-requests.json`
function recordOwnerFix(at: number, text: string) {
  let list: { at: number; text: string; forwarded?: boolean }[] = []
  try { list = JSON.parse(readFileSync(OWNER_FIX_FILE, 'utf8')) } catch {}
  list.push({ at, text })
  writeFileSync(OWNER_FIX_FILE, JSON.stringify(list.slice(-20)))
}

const PEOPLE = `${doriHome()}/sa-cache/kakao-people.json`
function peopleNotes(senders: Set<string>) {
  let notes: Record<string, { name: string; note: string }> = {}
  try { notes = JSON.parse(readFileSync(PEOPLE, 'utf8')) } catch { return '' }
  const lines = [...senders].filter((id) => notes[id]).map((id) => `${notes[id]!.name}: ${notes[id]!.note}`)
  return lines.length ? `\n[사람 메모] ${lines.join(' / ')}` : ''
}

const GROUP_NOTE = '지금 보내는 도구는 전부 이 방으로 간다. [호출]이 붙은 말은 꼭 답해라. [이어짐]은 너랑 하던 대화가 이어지는 것인데, 줄마다 다 답할 필요 없다: 묶음 전체를 보고 질문·부탁·너한테 직접 한 말에만 한 번 짧게 답하고, 감탄·리액션(ㅋㅋ, 와, 짱이네)은 넘기거나 한마디로 끝내라. 사람은 한 말을 여러 줄(여러 메시지)로 나눠 쓰는 일이 많다(주인 10-14): 같은 사람의 연속된 줄은 이어서 하나의 말로 읽고 맥락을 보고 답해라. 말이 덜 끝난 것 같으면(문장이 중간에 끊김) 답하지 말고 다음 묶음을 기다려라. 그 사람한테 답할 땐 그 줄 맨 앞 [rN]을 kakao_send 의 reply_to 에 넣어 카톡 답장으로 보내라. [입장] 줄의 [mN]은 새로 온 사람이다: kakao_send 의 mention 에 [mN]을 넣으면 그 사람을 멘션 걸어 인사한다. 둘 다 없으면 사람들끼리 대화다: 드립이나 맞장구 칠 만하면 kakao_send 로 짧게 끼고(여러 명 대화에 끼는 건 reply_to 없이 그냥), 아니면 아무것도 하지 마.'
export function formatBody(room: Room, header: string, lines: string[], notes: string) {
  return room.ownerOnly
    ? `${header}\n${lines.join('\n')}\n(${room.name}. 주인 본계정의 직접 지시다. kakao_send 는 이 1:1 방으로만 간다.)`
    : `${header}\n${lines.join('\n')}${notes}\n(${room.name}. ${room.note ?? GROUP_NOTE})`
}

// People send bursts ("ㅋㅋㅋ와" / "너진짜짱이네" / ...) and the lane answered every line as its own turn (주인 10-14:
// "맥락상 이어쓴거에 대해 모든걸 답할필욘 없어"). Hold a room's lines until it is quiet for QUIET_MS (max HOLD_MS), then
// deliver them as one batch.
export const QUIET_MS = 2500
export const HOLD_MS = 8000
export const MAX_LINES = 30

// A batch the wake filter skipped is not dropped: its lines are held per room and go out, tagged [문맥], ahead of the
// next batch that does wake the lane, so the lane still reads what was said before it was called.
export const HELD_MAX = 12
export const CONTEXT_NOTE = '([문맥] 줄은 너를 깨우지 않은 앞 대화다. 읽고 흐름만 파악해라. 그 줄에 따로 답할 필요는 없다.)'
const held = new Map<string, string[]>()
export function settleBatch(chat: string, lines: string[], woke: boolean): string[] | null {
  if (!woke) {
    held.set(chat, [...(held.get(chat) ?? []), ...lines].slice(-HELD_MAX))
    return null
  }
  const ctx = (l: string) => (l.startsWith('[문맥] ') ? l : `[문맥] ${l}`)
  const out = [...(held.get(chat) ?? []).map(ctx), ...lines]
  held.delete(chat)
  return out.some((l) => l.startsWith('[문맥] ')) ? [CONTEXT_NOTE, ...out] : out
}

export type Part = { header: string; lines: string[]; members: { logs: string[]; context: string[]; omitted: number } }
// Review 8: nothing is cut any more. Requests split into parts of MAX_LINES in order; held context rides only in part 1
// and gives way first, leaving one "[문맥 N줄 생략]" line (the originals stay in intake).
export function splitBatch(requests: { log: string; text: string }[], context: HeldLine[], max = MAX_LINES): Part[] {
  const chunks: { log: string; text: string }[][] = []
  for (let i = 0; i < requests.length; i += max) chunks.push(requests.slice(i, i + max))
  if (!chunks.length) chunks.push([])
  const room = Math.max(0, max - chunks[0]!.length)
  const keep = room ? context.slice(-room) : []
  const omitted = context.length - keep.length
  const ctx = (l: string) => (l.startsWith('[문맥] ') ? l : `[문맥] ${l}`)
  return chunks.map((c, i) => {
    const kept = i === 0 ? keep : []
    const lines = [...(i === 0 && omitted ? [`[문맥 ${omitted}줄 생략]`] : []), ...kept.map((h) => ctx(h.text)), ...c.map((r) => r.text)]
    const header = `[kakao-new ${kept.length + c.length}개${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''}]`
    return {
      header,
      lines: lines.some((l) => l.startsWith('[문맥] ')) ? [CONTEXT_NOTE, ...lines] : lines,
      members: { logs: c.map((r) => r.log), context: kept.map((h) => h.log), omitted: i === 0 ? omitted : 0 },
    }
  })
}

export type SendResult = { status: 'delivered' | 'uncertain' | 'refused'; transport: 'rpc' | 'herdr'; reason?: string; sentTo?: SentTo }
export type Sender = {
  transportFor: (lane: string) => 'rpc' | 'herdr'
  /** The lane's current session; throws when the lane is not open. */
  target: (lane: string) => SentTo
  receipt: (sessionPath: string | null, id: string) => 'persisted' | 'absent'
  send: (lane: string, body: string, id: string, transport: 'rpc' | 'herdr') => Promise<SendResult>
}
export type PushCfg = {
  home: string; log: string; rooms: Record<string, Room>; queue: Queue; sender: Sender
  filter?: Filter; decide?: (room: Room, seen: Seen) => Promise<boolean>
  crash?: Crash; out?: (line: string) => void; decisionLog?: string; startAtEnd?: boolean
  notes?: (senders: Set<string>) => string; stuckMs?: number; trace?: (line: string) => void
}

const pauseFlag = (home: string) => join(home, 'flags', 'kakao.pause-admission')
export function parallelWorkers(home: string): boolean {
  try { return JSON.parse(readFileSync(join(home, 'kakao-queue.json'), 'utf8'))?.workers?.parallel === true } catch { return false }
}
export const backoffMs = (attempts: number) => Math.min(60_000, 3000 * 2 ** Math.max(0, attempts - 1))
const writeAtomic = (file: string, text: string) => {
  try { if (readFileSync(file, 'utf8') === text) return } catch {}
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text); renameSync(tmp, file)
}

export function createPush(cfg: PushCfg) {
  const q = cfg.queue
  const filter = cfg.filter ?? wakeFilter
  const decide = cfg.decide ?? ((room: Room, seen: Seen) => judge(room, seen, filter))
  const crash = cfg.crash ?? (() => {})
  const out = cfg.out ?? ((l: string) => console.log(new Date().toISOString(), l))
  const notes = cfg.notes ?? peopleNotes
  const stuckMs = cfg.stuckMs ?? 10 * 60_000
  const rooms = q.loadRooms()
  const wakeP = new Map<string, Promise<boolean>>()
  const seenCache = new Map<string, NonNullable<Seen>>()
  const nextTry = new Map<string, number>()
  const inflight = new Map<string, Promise<void>>()
  const sacache = join(cfg.home, 'sa-cache')

  const roomState = (chat: string): RoomState => {
    let s = rooms.get(chat)
    if (!s) { s = { chat, pending: null, held: [], bursts: {}, nextSeq: 1 }; rooms.set(chat, s) }
    return s
  }
  const addLine = (s: RoomState, room: Room, line: PLine, seen: Seen, now: number) => {
    s.pending ??= { first: now, last: now, lines: [] }
    s.pending.lines.push(line)
    s.pending.last = now
    // Started now so Jev runs while the batch waits for quiet; flush awaits the answers.
    if (line.wake === undefined) {
      const p = decide(room, seen).catch(() => true)
      wakeP.set(line.log, p)
      p.then((w) => { line.wake = w })
    }
  }

  // The filter's context is in memory; refill it from the intake rows already routed, so the first judged line after a
  // restart still has its previous lines.
  function prime() {
    for (const raw of q.recentRaw(2000)) {
      if (isRagSelfAnswer(raw)) continue
      const room = cfg.rooms[raw.match(CHAT)?.[1] ?? '']
      if (room) filter.observe(raw, room)
    }
  }

  async function intake(now: number) {
    const r = q.ingest(cfg.log, { startAtEnd: cfg.startAtEnd })
    if (r.reset && r.reset !== 'first-start-at-end') out(`intake log ${r.reset}: reading the new generation from 0`)
    const rows = q.newIntake()
    // Not ISO-prefixed: kakao-stall counts ISO lines as deliveries; this only keeps push.log's mtime moving for kakao-health.
    if (rows.length) (cfg.trace ?? console.log)(`intake ${new Date(now).toISOString()} ${rows.length} line(s)`)
    for (const row of rows) {
      const raw = row.raw
      const room = cfg.rooms[row.chat_id]
      if (isRagSelfAnswer(raw) || !room) { q.routed(row, 'dropped'); continue }
      const seen = filter.observe(raw, room)
      const r = await route(raw, seen, filter, cfg.rooms)
      if (!r) { q.routed(row, 'dropped'); continue }
      const s = roomState(r.chat)
      if (r.burst) {
        const g = s.bursts[r.sender] ?? { items: [], first: now, last: now, unfinished: false, now: false }
        g.items.push({ log: row.log_id, raw, who: r.burst.who, text: r.burst.text, gate: r.burst.gate, sender: r.sender, isOwner: r.isOwner })
        g.last = now
        g.unfinished = waitsForMore(r.burst.seen.entry.line)
        g.now ||= r.burst.gate === 'called'
        s.bursts[r.sender] = g
        seenCache.set(row.log_id, r.burst.seen)
        q.routed(row, 'burst', s)
        continue
      }
      addLine(s, r.room, { log: row.log_id, text: r.text, sender: r.sender, isOwner: r.isOwner, ...(r.judged ? { wake: r.judged === 'respond' } : {}) }, seen, now)
      q.routed(row, 'pending', s)
    }
  }

  async function flushBursts(now: number) {
    for (const s of rooms.values()) {
      const room = cfg.rooms[s.chat]
      for (const [key, g] of Object.entries(s.bursts)) {
        if (!(g.now || now - g.last >= (g.unfinished ? BURST.unfinishedMs : BURST.quietMs) || now - g.first >= BURST.maxMs)) continue
        let routed: { item: BurstItem; text: string; judged: 'respond' | 'collect' }[]
        const seen = g.items.map((it) => seenCache.get(it.log) ?? (room ? filter.observe(it.raw, room) : null))
        if (room && seen.every(Boolean)) {
          const items: Routed[] = g.items.map((it, i) => ({ chat: s.chat, room, sender: it.sender, isOwner: it.isOwner, text: '', log: it.log, burst: { who: it.who, text: it.text, gate: it.gate, seen: seen[i]! } }))
          const res = await judgeBurst(items, filter)
          routed = res.map((r) => ({ item: g.items.find((it) => it.log === r.log)!, text: r.text, judged: r.judged! }))
        } else {
          // Restored without a parsed line: fail open, as Jev failures do.
          routed = g.items.map((it) => ({ item: it, text: `[후속후보] ${it.who}: ${it.text}`, judged: 'respond' as const }))
        }
        delete s.bursts[key]
        for (const r of routed) if (room) addLine(s, room, { log: r.item.log, text: r.text, sender: r.item.sender, isOwner: r.item.isOwner, wake: r.judged === 'respond' }, null, now)
        for (const it of g.items) seenCache.delete(it.log)
        q.saveRoom(s)
      }
    }
  }

  async function flush(now: number) {
    for (const s of rooms.values()) {
      const p = s.pending
      if (!p || (now - p.last < QUIET_MS && now - p.first < HOLD_MS)) continue
      const room = cfg.rooms[s.chat]
      // A restored line without a stored decision wakes (fail-open): a lost Jev answer must not lose a request.
      const woke = (await Promise.all(p.lines.map((l) => (l.wake !== undefined ? l.wake : wakeP.get(l.log) ?? true)))).some(Boolean)
      for (const l of p.lines) wakeP.delete(l.log)
      if (!room) { out(`room ${s.chat} left kakao-rooms.json: ${p.lines.length} pending line(s) kept in intake only`); s.pending = null; q.saveRoom(s); continue }
      if (!woke) {
        s.held = [...s.held, ...p.lines.map((l) => ({ log: l.log, text: l.text }))].slice(-HELD_MAX)
        s.pending = null
        q.saveRoom(s)
        out(`held ${p.lines.length} for ${room.name}`)
        // One row per lane wake the filter saved; wake-filter-stats.ts counts these.
        try { appendFileSync(cfg.decisionLog ?? DECISION_LOG, JSON.stringify({ at: new Date().toISOString(), room: room.name, chat: s.chat, event: 'held', lines: p.lines.length }) + '\n') } catch (e) { out(`held log failed ${(e as Error)?.message}`) }
        continue
      }
      const senders = new Set(p.lines.filter((l) => !l.isOwner).map((l) => l.sender))
      const extra = room.ownerOnly || room.pinned ? '' : notes(senders)
      const parts = splitBatch(p.lines, s.held)
      const next: RoomState = { ...s, pending: null, held: [] }
      const ids = q.commitFlush(next, parts.map((x, i) => ({ lane: room.lane, part: i + 1, parts: parts.length, members: x.members, body: formatBody(room, x.header, x.lines, extra) })))
      Object.assign(s, next)
      if (parts.length > 1) out(`kakao.split ${room.name} ${p.lines.length} request lines -> ${parts.length} batches ${ids.join(' ')}`)
      for (const id of ids) out(`batch ${id} queued for ${room.lane}`)
    }
  }

  const blocked = (lane: string, map: Record<string, any>) =>
    existsSync(pauseFlag(cfg.home)) ? 'paused' : leaseActive(lane, cfg.home) ? 'lease' : map[lane]?.seed?.state === 'pending' ? 'seed' : null

  function roomFiles(b: Batch, parallel: boolean) {
    const room = cfg.rooms[b.chat_id]
    try {
      mkdirSync(sacache, { recursive: true })
      writeAtomic(join(sacache, `room.${b.lane}`), b.chat_id)
      // A pinned room's lane sends via its own extension; writing the legacy file would redirect the shared group lane.
      if (!parallel && room && !room.ownerOnly && !room.pinned) writeAtomic(join(sacache, 'active-room'), room.name)
    } catch (e) { out(`room file write failed ${(e as Error)?.message}`) }
  }

  const stuckSeen = new Set<string>()
  function stuck(b: Batch, now: number) {
    if (stuckSeen.has(b.id) || now - Date.parse(b.created_at) < stuckMs) return
    stuckSeen.add(b.id)
    out(`kakao.stuck batch ${b.id} lane ${b.lane} state ${b.state} attempts ${b.attempts}`)
    try { appendEvent({ id: `kakao.stuck:${b.id}`, kind: 'kakao.stuck', lane: b.lane, batch: b.id, state: b.state }, cfg.home) } catch (e) { out(`kakao.stuck event write failed ${(e as Error)?.message}`) }
  }

  async function attempt(b: Batch, parallel: boolean, now: number) {
    const sent = b.sent_to_json ? (JSON.parse(b.sent_to_json) as SentTo) : null
    if (b.state === 'accepted' || b.state === 'uncertain') {
      let path = sent?.sessionPath ?? null
      if (!path) try { path = cfg.sender.target(b.lane).sessionPath } catch {}
      if (cfg.sender.receipt(path, b.id) === 'persisted') {
        crash('receipt:found')
        q.markPersisted(b.id)
        out(`batch ${b.id} persisted (receipt)`)
        return
      }
      // A herdr message may still sit in the pane's queue; typing it again would answer twice. Only its receipt ends it.
      if (b.transport === 'herdr' && b.state === 'uncertain') { nextTry.set(b.id, now + backoffMs(b.attempts)); stuck(b, now); return }
    }
    let target: SentTo
    try { target = cfg.sender.target(b.lane) } catch (e) {
      q.markResult(b.id, 'refused', { error: `no_target: ${(e as Error).message}` })
      nextTry.set(b.id, now + backoffMs(b.attempts + 1)); stuck(b, now)
      out(`batch ${b.id} attempt ${b.attempts + 1} refused no_target`)
      return
    }
    const transport = b.transport ?? cfg.sender.transportFor(b.lane)
    roomFiles(b, parallel)
    q.markSending(b.id, target)
    let res: SendResult
    try { res = await cfg.sender.send(b.lane, b.body, b.id, transport) } catch (e) { res = { status: 'uncertain', transport, reason: `send threw: ${(e as Error).message}` } }
    crash('send:accepted')
    const attempts = b.attempts + 1
    if (res.status === 'delivered') {
      q.markPersisted(b.id, { transport: res.transport, sentTo: res.sentTo })
      nextTry.delete(b.id)
      out(`batch ${b.id} persisted via ${res.transport} attempt ${attempts}`)
      return
    }
    q.markResult(b.id, res.status, { transport: res.status === 'refused' ? null : res.transport, error: res.reason ?? null, sentTo: res.sentTo })
    nextTry.set(b.id, now + backoffMs(attempts))
    stuck(b, now)
    out(`batch ${b.id} attempt ${attempts} ${res.status}${res.reason ? ` ${res.reason}` : ''}`)
  }

  function work(now: number) {
    const parallel = parallelWorkers(cfg.home)
    let map: Record<string, any> = {}
    try { map = readMap(cfg.home) } catch (e) { out(`registry unreadable, seed gate skipped this tick: ${(e as Error)?.message}`) }
    for (const b of q.heads()) {
      if (!parallel && inflight.size) break
      if (inflight.has(b.lane) || blocked(b.lane, map)) continue
      const due = nextTry.get(b.id) ?? 0
      if (now < due) {
        // Serial workers keep today's global order: a refused head holds everything behind it. A lane waiting for a
        // receipt holds only itself.
        if (!parallel && b.state === 'refused') break
        continue
      }
      const p = attempt(b, parallel, now)
        .catch((e) => { if (e instanceof CrashError) throw e; out(`batch ${b.id} attempt failed ${(e as Error)?.message ?? e}`); nextTry.set(b.id, now + backoffMs(b.attempts + 1)) })
        .finally(() => inflight.delete(b.lane))
      inflight.set(b.lane, p)
      if (!parallel) break
    }
  }

  return {
    prime, intake, flushBursts, flush, work,
    async step(now: number) {
      await intake(now)
      await flushBursts(now)
      await flush(now)
      work(now)
    },
    /** Waits for the attempts started so far (tests; the main loop does not wait). */
    idle: () => Promise.all([...inflight.values()]).then(() => undefined),
    rooms,
  }
}

async function liveSender(home: string): Promise<Sender> {
  const { receipt, rpc, transportFor } = await import('./rpc')
  const { liveDeps } = await import('./deliver')
  const { findSessionFile } = await import('./sess')
  const entry = (lane: string) => {
    const e = readMap(home)[lane]
    if (!e || e.status !== 'open') throw new Error(`${lane} is not open`)
    return e
  }
  return {
    transportFor: (lane) => transportFor(lane),
    target: (lane) => { const e = entry(lane); return { durableId: e.sessionId, sessionPath: (e.sessionPath as string | undefined) ?? findSessionFile(e.sessionId, e.cwd ?? null) } },
    receipt: (path, id) => receipt(path, id),
    async send(lane, body, id, transport) {
      const e = entry(lane)
      const r: any = await rpc.dispatch(e as any, body, { id, transport }, liveDeps)
      const sentTo: SentTo | undefined = r.sentTo ?? undefined
      const status = r.status === 'delivered' ? 'delivered' : r.status === 'refused' ? 'refused' : 'uncertain'
      return { status, transport: r.transport, reason: r.reason ?? r.disposition, sentTo }
    },
  }
}

if (import.meta.main) {
  const check = process.argv.includes('--check')
  mkdirSync(join(DORI_HOME, '.locks'), { recursive: true })
  let lock: { release: () => void }
  try { lock = await acquireDirLock(join(DORI_HOME, '.locks', 'kakao-push.lock'), { waitMs: 0 }) } catch (e) {
    console.error(new Date().toISOString(), 'kakao-push: another instance holds the lock, exiting', (e as Error)?.message)
    process.exit(check ? 1 : 0)
  }
  const release = () => { try { lock.release() } catch {} }
  process.once('exit', release)
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { release(); process.exit(0) })
  const q = Queue.open(queuePath(DORI_HOME))
  const push = createPush({ home: DORI_HOME, log: LOG, rooms: ROOMS, queue: q, sender: await liveSender(DORI_HOME) })
  const summary = { db: q.path, cursor: q.cursor(), log: LOG, logExists: existsSync(LOG), rooms: Object.keys(ROOMS).length, parallel: parallelWorkers(DORI_HOME), batches: q.counts(), restoredRooms: push.rooms.size }
  if (check) {
    console.log(JSON.stringify({ ok: true, check: true, ...summary }))
    q.close(); release(); process.exit(0)
  }
  console.log(new Date().toISOString(), 'kakao-push start', JSON.stringify(summary))
  try { push.prime() } catch (e) { console.error(new Date().toISOString(), 'wake-filter prime failed', (e as Error)?.message) }
  console.log(new Date().toISOString(), 'wake-filter rooms', Object.values(ROOMS).filter((x) => x.wakeFilter).map((x) => x.name).join(', ') || 'none')
  while (true) {
    await push.step(Date.now()).catch((e) => console.error(new Date().toISOString(), 'step failed', e?.message ?? e))
    await Bun.sleep(500)
  }
}
