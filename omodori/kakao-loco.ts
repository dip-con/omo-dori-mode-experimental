import { Long } from 'bson'
// 장도리 live stream over KakaoTalk's own protocol (agent-messenger, tablet sub-device of the 단도리 account).
// LaunchAgent com.example.dori.kakao-live runs it with stdout -> live.ndjson, one line per message.
import { statSync, readFileSync } from 'node:fs'
import { addressingFields } from './kakao-secretary-gate'
import { boundedResponse, startLocoWatchdog, TroubleWindow } from './kakao-loco-guard'
import { AUTH_RETRY_MS, ReloginRequired, connectWithRefresh, keepTokenFresh, reportReloginRequired } from './kakao-token'
import { KakaoTalkClient, KakaoTalkListener } from 'agent-messenger/kakaotalk'
import { cfg, omocatHome } from './config'

const ME = cfg.kakao.botUserId
const ROOMS = Object.keys(JSON.parse(readFileSync(`${omocatHome()}/kakao-rooms.json`, 'utf8')))
const LOG = `${process.env.HOME}/Library/Logs/dandori-kakao/live.ndjson`

// Kakao ids exceed 2^53: keep them as decimal strings and write them as bare JSON numbers.
const idOf = (v: unknown): string => {
  if (v && typeof v === 'object' && 'low' in v && 'high' in v) {
    const { low, high } = v as { low: number; high: number }
    return BigInt.asIntN(64, (BigInt(high) << 32n) | BigInt(low >>> 0)).toString()
  }
  return String(v)
}

// Photo URLs for the agents. type 2 = one photo (attachment.url); type 27 = a multi-photo message ("사진 2장"), whose
// URLs are in attachment.imageUrls (thumbnailUrls as fallback). Missing 27 made 장도리 see only older photos (10-13).
function photoFields(type: number, a: Record<string, unknown> | null | undefined) {
  if (type === 2 && typeof a?.url === 'string') return { photo_url: a.url }
  if (type === 27) {
    const list = [a?.imageUrls, a?.thumbnailUrls].find((x) => Array.isArray(x) && x.length) as unknown[] | undefined
    const urls = (list ?? []).filter((u): u is string => typeof u === 'string')
    if (urls.length) return { photo_url: urls[0], photo_urls: urls }
  }
  // type 18 = file (PDF/HWP/XLSX ...): show the name so the agents see which document went out.
  // file_url lets the agents download a received document (주인 10-16: 파일 받아서 확인·수정).
  if (type === 18 && typeof a?.name === 'string') return { file_name: a.name, ...(typeof a.size === 'number' ? { file_size: a.size } : {}), ...(typeof a.url === 'string' ? { file_url: a.url } : { file_keys: Object.keys(a ?? {}) }) }
  return {}
}

function emit(m: { chat_id: unknown; log_id: unknown; author_id: unknown; author_name?: string | null; message: string; message_type: number; attachment: Record<string, unknown> | null; sent_at: number }, name: string | null) {
  const sender = idOf(m.author_id)
  const line = JSON.stringify({
    chat_id: '__CHAT__', is_from_me: sender === ME, log_id: '__LOG__', message_type: m.message_type,
    ...photoFields(m.message_type, m.attachment),
    ...addressingFields(m.attachment, idOf),
    ...(name ? { sender: name } : sender === ME ? { sender: '장도리' } : {}),
    sender_id: '__SENDER__', text: m.message ?? '', timestamp: new Date(m.sent_at * 1000).toISOString().replace('.000', ''), type: 'message',
  }).replace('"__CHAT__"', idOf(m.chat_id)).replace('"__LOG__"', idOf(m.log_id)).replace('"__SENDER__"', sender)
  process.stdout.write(line + '\n')
}

const ROOMS_FILE = `${omocatHome()}/kakao-rooms.json`
let roomsCache = { mtime: 0, ids: ROOMS }
function liveRooms() {
  try {
    const m = statSync(ROOMS_FILE).mtimeMs
    if (m !== roomsCache.mtime) roomsCache = { mtime: m, ids: Object.keys(JSON.parse(readFileSync(ROOMS_FILE, 'utf8'))) }
  } catch {}
  return roomsCache.ids
}
const client = new KakaoTalkClient()
await client.login(undefined, ME)
// -950 on login = expired access token (10-14, 10-22): refresh it and log in again (kakao-token.ts). If even that fails,
// wait a minute before exiting so launchd retries once a minute, not every 5 s.
try {
  await connectWithRefresh(client, ME)
} catch (e) {
  if (!(e instanceof ReloginRequired)) throw e
  reportReloginRequired(e)
  await Bun.sleep(AUTH_RETRY_MS)
  process.exit(1)
}
setInterval(() => keepTokenFresh(client, ME).catch((e) => console.error(new Date().toISOString(), 'kakao token check failed:', (e as Error).message)), 3_600_000)
const listener = new KakaoTalkListener(client)
const die = (why: string) => { console.error(new Date().toISOString(), 'exit:', why); process.exit(1) }
// 10-25: probe failures that alternate with successes plus slow /messages timeouts never tripped the 2-in-a-row rule.
const trouble = new TroubleWindow({ windowMs: 30 * 60_000, maxInWindow: 3 }, die)
listener.on('message', (ev) => {
  // Re-read the rooms file on change: a room added after start (친구B방 10-14) was silently dropped until a restart.
  if (!liveRooms().includes(idOf(ev.chat_id))) return
  emit(ev, ev.author_name ?? client.lookupAuthorName(idOf(ev.chat_id), Number(idOf(ev.author_id))))
})
listener.on('disconnected', () => die('disconnected'))
listener.on('error', (e) => die(`error ${e.message}`))
client.onSessionEvent((e) => { if (e.type === 'kicked') die(`kicked ${e.reason}`) })
await listener.start()

// Half-open LOCO (10-24, 4 hangs): the socket stays ESTABLISHED, nothing answers and no 'disconnected' ever fires.
// PING (same packet the library sends every 20 s, but its result is checked here) every 30 s; 2 dead probes in a row ->
// exit so launchd restarts in 5 s, instead of kakao-health noticing after ~3 min.
startLocoWatchdog(async () => {
  const res = await (client as any).executeWithReconnect(({ session }: any) => session.connection.sendPacket('PING', {}))
  if (res?.statusCode === -1) throw new Error('connection closed')
}, die, { intervalMs: 30_000, timeoutMs: 20_000, maxFails: 2 }, console.error, trouble)

// Kakao allows one session per device, so a second login (e.g. the agent-kakaotalk CLI) kicks this one:
// the lane sends and reads through this process instead, on loopback only.
const nameOf = (chat: string, sender: string) => (sender === ME ? '장도리' : client.lookupAuthorName(chat, Number(sender)))

// 답장 (주인 10-14). agent-messenger's sendMessage({replyTo}) builds the extra without the open-chat link id and with JS
// numbers, so open-chat replies came back with logId 0 and never showed. Build the extra here: ids as raw JSON numbers
// (they exceed 2^53) and src_linkId for open chats (OM).
const toLong = (s: string) => { const b = BigInt(s); return new Long(Number(b & 0xffffffffn), Number((b >> 32n) & 0xffffffffn)) }
const longStr = (v: any) => v == null ? null : typeof v === 'object' && 'high' in v ? ((BigInt(v.high >>> 0) << 32n) | BigInt(v.low >>> 0)).toString() : String(v)
async function sendReply(chat: string, text: string, reply: { log_id: string; author_id: string; message: string; type: number }) {
  return (client as any).executeWithReconnect(async ({ session }: any) => {
    const info = await session.getChannelInfo(toLong(chat))
    const linkId = longStr(info.body?.chatInfo?.li)
    const raw = (JSON as any).rawJSON
    const extra = { attach_only: false, attach_type: reply.type, src_logId: raw(reply.log_id), src_userId: raw(reply.author_id), src_message: reply.message, src_type: reply.type, src_mentions: [], mentions: [], ...(linkId && linkId !== '0' ? { src_linkId: raw(linkId) } : {}) }
    const res = await session.sendReply(toLong(chat), text, extra)
    return { success: res.statusCode === 0 && longStr(res.body?.logId) !== '0', status_code: res.statusCode, chat_id: chat, log_id: longStr(res.body?.logId), link_id: linkId, body_keys: Object.keys(res.body ?? {}) }
  })
}
async function sendMention(chat: string, text: string, mention: { user_id: string; nick: string }) {
  return (client as any).executeWithReconnect(async ({ session }: any) => {
    const body = `@${mention.nick} ${text}`
    const extra = { mentions: [{ user_id: (JSON as any).rawJSON(mention.user_id), at: [1], len: [...mention.nick].length }] }
    const res = await session.sendAttachment(toLong(chat), 1, extra, body)
    return { success: res.statusCode === 0 && longStr(res.body?.logId) !== '0', status_code: res.statusCode, chat_id: chat, log_id: longStr(res.body?.logId) }
  })
}
// Every API call is bounded (504 instead of hanging on a dead LOCO peer); uploads get longer. Bun.serve's default
// idleTimeout (10 s) would cut the connection before the 504, so it is raised above the longest bound.
const API_TIMEOUT_MS = 20_000, UPLOAD_TIMEOUT_MS = 120_000
Bun.serve({
  hostname: '127.0.0.1',
  port: cfg.kakao.locoPort,
  idleTimeout: 130,
  fetch(req) {
    const path = new URL(req.url).pathname
    return boundedResponse(() => route(req), path === '/file' || path === '/photo' ? UPLOAD_TIMEOUT_MS : API_TIMEOUT_MS, `${req.method} ${path}`, console.error, trouble)
  },
})
async function route(req: Request): Promise<Response> {
    const url = new URL(req.url)
    try {
      if (req.method === 'POST' && url.pathname === '/send') {
        const { chat, text, reply, mention } = (await req.json()) as { chat: string; text: string; reply?: { log_id: string; author_id: string; message: string; type: number }; mention?: { user_id: string; nick: string } }
        // Reply (답장): ids go into the extra JSON as raw numbers (JSON.rawJSON) - they exceed 2^53 and a JS number would corrupt them.
        if (reply?.log_id) return Response.json(await sendReply(chat, text, reply))
        // Mention (주인 10-14: greet newcomers with a mention): text starts "@nick", extra.mentions marks it (at = 1st occurrence).
        if (mention?.user_id) return Response.json(await sendMention(chat, text, mention))
        return Response.json(await client.sendMessage(chat, text))
      }
      if (req.method === 'POST' && url.pathname === '/photo') {
        const { chat, path } = (await req.json()) as { chat: string; path: string }
        return Response.json(await client.sendPhoto(chat, Buffer.from(await Bun.file(path).arrayBuffer()), path.split('/').pop()))
      }
      // File (type 18, 주인 10-16: 원본 문서는 카톡 파일 전송으로). agent-messenger's sendFile does SHIP -> POST (f = name) -> COMPLETE;
      // the server registers the chatlog. KakaoTalk caps a file at 300MB; the whole file is read into memory here.
      if (req.method === 'POST' && url.pathname === '/file') {
        const { chat, path, name } = (await req.json()) as { chat: string; path: string; name?: string }
        const f = Bun.file(path)
        if (!(await f.exists())) return Response.json({ error: `file not found: ${path}` }, { status: 400 })
        if (f.size === 0 || f.size > 300 * 1024 * 1024) return Response.json({ error: `file size ${f.size} out of range (1B..300MB)` }, { status: 400 })
        return Response.json(await client.sendFile(chat, new Uint8Array(await f.arrayBuffer()), name || path.split('/').pop()!))
      }
      if (url.pathname === '/members') {
        // Open chats fail the full CHATINFO+GETMEM snapshot ("member snapshot invalid"); MEMBER by ids works there.
        const chat = url.searchParams.get('chat') ?? ''
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean)
        return Response.json(ids.length ? await client.getMembersByIds(chat, ids) : await client.getMembers(chat))
      }
      if (url.pathname === '/chats') {
        const all = url.searchParams.get('all') === '1'
        return Response.json(await client.getChats(all ? { all: true, resolveTitles: true } : undefined))
      }
      if (url.pathname === '/messages') {
        const chat = url.searchParams.get('chat') ?? ''
        const count = Math.min(Number(url.searchParams.get('count') ?? 30), 400)
        const list = (await client.getMessages(chat, { count })) as unknown as Record<string, any>[]
        return Response.json(list.map((m) => {
          const sender = idOf(m.author_id)
          return { id: idOf(m.log_id), chat_id: chat, sender_id: sender, sender: nameOf(chat, sender), is_from_me: sender === ME, type: m.type, text: m.message,
            timestamp: new Date(m.sent_at * 1000).toISOString(), ...photoFields(m.type, m.attachment),
            ...addressingFields(m.attachment, idOf) }
        }).sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)))
      }
      return new Response('not found', { status: 404 })
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 })
    }
}
console.error(new Date().toISOString(), `kakao-loco listening, api 127.0.0.1:${cfg.kakao.locoPort}`)

// Catch up on what arrived while this process was down (launchd restart, reconnect), after the last logged line.
const lastLogged = new Map<string, bigint>()
try {
  for (const l of readFileSync(LOG, 'utf8').split('\n').slice(-500)) {
    const c = l.match(/"chat_id":(\d+)/)?.[1], g = l.match(/"log_id":(\d+)/)?.[1]
    if (c && g && g !== '9223372036854775807') lastLogged.set(c, BigInt(g))
  }
} catch {}
for (const room of ROOMS) {
  const since = lastLogged.get(room)
  if (!since) continue
  const page = (await client.getMessages(room)) as unknown as { log_id: unknown }[]
  for (const m of [...page].sort((a, b) => (BigInt(idOf(a.log_id)) < BigInt(idOf(b.log_id)) ? -1 : 1))) {
    if (BigInt(idOf(m.log_id)) > since) emit({ ...(m as any), chat_id: room, message_type: (m as any).type }, null)
  }
}
