// Tools for a KakaoTalk lane (the bot named in config.json bots[]). The lane is started with
// `--tools kakao_send,kakao_recent,web_search` so these are its only ways to act:
// it can talk in its one room and search the web, but cannot run commands or touch files.
// kakao-push.ts records which room the lane's latest batch came from; every send and read goes to that room.
import { cfg, doriHome, botForLane } from './config'
const ROOM_CONFIG: Record<string, { name: string }> = (() => { try { return JSON.parse(require('node:fs').readFileSync(`${doriHome()}/kakao-rooms.json`, 'utf8')) } catch { return {} } })()
const CHAT_IDS: Record<string, string> = Object.fromEntries(Object.entries(ROOM_CONFIG).map(([id, r]) => [r.name, id]))
const ROOMS = Object.keys(CHAT_IDS)
// Redesign S7: with OMODORI_LANE_KEY the room is the lane's own sa-cache/room.<lane> (a chat id kakao-push writes once),
// so a late kakao_send still goes to this lane's room after another lane got a batch. Without it: the shared legacy file.
export function roomName(env: Record<string, string | undefined> = process.env, dir = `${env.OMODORI_HOME ?? doriHome()}/sa-cache`, config: Record<string, { name: string }> = ROOM_CONFIG): string | undefined {
  const names = Object.values(config).map((r) => r.name)
  if (env.OMODORI_ROOM) return env.OMODORI_ROOM
  const fs = require('node:fs')
  const lane = env.OMODORI_LANE_KEY
  if (lane && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(lane)) {
    try { const id = fs.readFileSync(`${dir}/room.${lane}`, 'utf8').trim(); if (config[id]) return config[id]!.name } catch {}
  }
  try { const r = fs.readFileSync(`${dir}/active-room`, 'utf8').trim(); if (names.includes(r)) return r } catch {}
  return names[0]
}
const room = () => roomName()!

const LOCO = process.env.OMODORI_LOCO ?? `http://127.0.0.1:${cfg.kakao.locoPort}`
const BOT = cfg.kakao.botUserId
const SELF = `${botForLane(process.env.OMODORI_LANE_KEY ?? '').name}(나)`

// Kakao goes through kakao-loco.ts (the one LOCO session); args keep the kakaocli shape: send <room> <text> | messages ... --chat <room> --limit <n>.
async function run(args: string[]) {
  try {
    const opt = (k: string) => args[args.indexOf(k) + 1]
    const r = args[0] === 'send'
      ? await fetch(`${LOCO}/send`, { method: 'POST', body: JSON.stringify({ chat: CHAT_IDS[args[1]!], text: args[2], ...(args[3] ? { reply: JSON.parse(args[3]) } : {}), ...(args[4] ? { mention: JSON.parse(args[4]) } : {}) }), signal: AbortSignal.timeout(20_000) })
      : await fetch(`${LOCO}/messages?chat=${CHAT_IDS[opt('--chat')!]}&count=${opt('--limit')}`, { signal: AbortSignal.timeout(20_000) })
    return { code: r.ok ? 0 : 1, text: (await r.text()).trim() }
  } catch (e) {
    return { code: -1, text: `kakao-loco unreachable: ${(e as Error).message}` }
  }
}

const IMG_DIR = '/tmp/omodori-img'
const REPLY_REFS = `${doriHome()}/sa-cache/reply-refs.json`

const sentFiles = new Map<string, number>()

const recentSends: { text: string; at: number }[] = []
let sendChain: Promise<unknown> = Promise.resolve()

async function sh(cmd: string[], ms: number) {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => p.kill(), ms)
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  clearTimeout(timer)
  return { code, text: (out + err).trim() }
}

// Only images the lane fetched from the public web or generated into IMG_DIR may leave the machine.
async function stageImage(source: string): Promise<string> {
  await sh(['mkdir', '-p', IMG_DIR], 5000)
  let file: string
  if (/^https?:\/\//i.test(source)) {
    const host = new URL(source).hostname
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1|0\.)/i.test(host) || host.endsWith('.ts.net') || host.endsWith('.local')) throw new Error('private address not allowed')
    file = `${IMG_DIR}/dl-${crypto.randomUUID()}`
    const r = await sh(['curl', '-fsSL', '--max-time', '20', '--max-filesize', '15000000', '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', '-o', file, source], 25_000)
    if (r.code !== 0) throw new Error(`download failed: ${r.text.slice(-200)}`)
  } else {
    const r = await sh(['realpath', source], 5000)
    if (r.code !== 0) throw new Error(`file not found: ${source} (use the exact path the image tool reported)`)
    const allowed = ['/private/tmp/omodori-img/', `${IMG_DIR}/`, cfg.kakao.generatedImagesDir, `${doriHome()}/sa-cache/`]
    if (!allowed.some((d) => r.text.startsWith(d))) throw new Error(`only generated images or files in ${IMG_DIR} can be sent`)
    file = r.text
    // Re-sending one local file is how the lane loops on a failed generation; refuse it for 10 minutes.
    const last = sentFiles.get(file)
    if (last && Date.now() - last < 600_000) throw new Error('this exact image was already sent in the last 10 minutes; do not resend it')
    sentFiles.set(file, Date.now())
  }
  const png = `${IMG_DIR}/send-${crypto.randomUUID()}.png`
  await sh(['sips', '-Z', '1600', '-s', 'format', 'png', file, '--out', png], 20_000)
  if (!(await Bun.file(png).exists())) throw new Error('not a readable image')
  return png
}

async function imageBase64(url: string) {
  await sh(['mkdir', '-p', IMG_DIR], 5000)
  const raw = `${IMG_DIR}/view-${crypto.randomUUID()}`
  const dl = await sh(['curl', '-fsSL', '--max-time', '20', '-o', raw, url], 25_000)
  if (dl.code !== 0) throw new Error(`download failed: ${dl.text.slice(-200)}`)
  const jpg = `${raw}.jpg`
  await sh(['sips', '-Z', '1024', '-s', 'format', 'jpeg', raw, '--out', jpg], 20_000)
  return Buffer.from(await Bun.file(jpg).arrayBuffer()).toString('base64')
}

async function sendImage(source: string) {
  try {
    const png = await stageImage(source)
    const res = await fetch(`${LOCO}/photo`, { method: 'POST', body: JSON.stringify({ chat: CHAT_IDS[room()], path: png }), signal: AbortSignal.timeout(60_000) })
    const r = { code: res.ok ? 0 : 1, text: await res.text() }
    return { content: [{ type: 'text', text: r.code === 0 ? 'sent' : `send failed (exit ${r.code}): ${r.text.slice(-300)}` }], details: { code: r.code } }
  } catch (e) {
    return { content: [{ type: 'text', text: `send failed: ${(e as Error).message}` }], details: { code: -1 } }
  }
}

// Original documents (주인 10-16): only files the doc-templates generator wrote under DOC_OUT may leave as a Kakao file message.
const DOC_OUT = cfg.kakao.docOutDir || `${doriHome()}/doc-out/`
async function sendDocFile(path: string, name?: string) {
  try {
    let real: string
    try { real = require('node:fs').realpathSync(path) } catch { throw new Error(`file not found: ${path}`) }
    if (!real.startsWith(DOC_OUT)) throw new Error(`only files under ${DOC_OUT} can be sent`)
    const res = await fetch(`${LOCO}/file`, { method: 'POST', body: JSON.stringify({ chat: CHAT_IDS[room()], path: real, ...(name?.trim() ? { name: name.trim() } : {}) }), signal: AbortSignal.timeout(120_000) })
    const text = await res.text()
    const ok = res.ok && JSON.parse(text).success === true
    return { content: [{ type: 'text', text: ok ? 'sent' : `send failed: ${text.slice(-300)}` }], details: { code: ok ? 0 : 1 } }
  } catch (e) {
    return { content: [{ type: 'text', text: `send failed: ${(e as Error).message}` }], details: { code: -1 } }
  }
}

export default function (pi: any) {
  pi.registerTool({
    name: 'kakao_view_photo',
    label: 'Kakao view photo',
    description: '방에 올라온 카톡 사진을 직접 본다(이미지로 돌려줌). 누가 사진을 올리고 "이런 식으로", "이거 봐", "이거 뭐야" 하면 먼저 이걸로 사진을 보고 답한다. back=0 이 가장 최근 사진, 1 이 그 전 사진.',
    parameters: { type: 'object', properties: { back: { type: 'number', description: '몇 번째 전 사진인지(기본 0 = 가장 최근)' } } },
    async execute(_id: string, params: { back?: number }) {
      try {
        const r = await run(['messages', '--account', BOT, '--chat', room(), '--limit', '400', '--json'])
        if (r.code !== 0) throw new Error(r.text.slice(-200))
        // A multi-photo message (type 27, "사진 2장") carries photo_urls; count each photo separately, newest message first.
        const photos = (JSON.parse(r.text) as any[]).filter((m) => m.photo_url).flatMap((m) => {
          const urls: string[] = Array.isArray(m.photo_urls) && m.photo_urls.length ? m.photo_urls : [m.photo_url]
          return urls.map((u, i) => ({ ...m, photo_url: u, part: urls.length > 1 ? ` (${urls.length}장 중 ${i + 1}번째)` : '' }))
        })
        const m = photos[Math.max(0, Math.floor(params.back ?? 0))]
        if (!m) return { content: [{ type: 'text', text: '최근 400개 메시지에 사진 없음' }], details: {} }
        const data = await imageBase64(m.photo_url)
        const who = m.is_from_me ? SELF : (m.sender ?? m.sender_id)
        return { content: [{ type: 'text', text: `${who}가 ${m.timestamp}에 올린 사진${m.part}` }, { type: 'image', data, mimeType: 'image/jpeg' }], details: {} }
      } catch (e) {
        return { content: [{ type: 'text', text: `사진 보기 실패: ${(e as Error).message}` }], details: {} }
      }
    },
  })
  // 주인 10-16: 방에 올라온 파일(PDF·HWP·XLSX 등)을 받아서 확인·수정할 수 있게 로컬로 내려받는다. kakao-loco가 type 18의 file_url을 넘겨준다.
  pi.registerTool({
    name: 'kakao_receive_file',
    label: 'Kakao receive file',
    description: '방에 올라온 카톡 파일(PDF·HWP·XLSX·DOCX 등)을 내려받아 로컬 경로를 돌려준다. 누가 파일을 올리고 확인·검토·수정을 부탁하면 먼저 이걸로 받고, 돌려받은 경로를 읽거나 고친 뒤 kakao_send_file로 돌려보낸다. back=0 이 가장 최근 파일, name 을 주면 이름에 그 글자가 들어간 가장 최근 파일.',
    parameters: { type: 'object', properties: { back: { type: 'number', description: '몇 번째 전 파일인지(기본 0 = 가장 최근)' }, name: { type: 'string', description: '파일 이름 일부(선택)' } } },
    async execute(_id: string, params: { back?: number; name?: string }) {
      try {
        const r = await run(['messages', '--account', BOT, '--chat', room(), '--limit', '400', '--json'])
        if (r.code !== 0) throw new Error(r.text.slice(-200))
        let files = (JSON.parse(r.text) as any[]).filter((m) => m.file_name && m.file_url)
        if (params.name) files = files.filter((m) => String(m.file_name).includes(params.name!))
        const m = files[Math.max(0, Math.floor(params.back ?? 0))]
        if (!m) return { content: [{ type: 'text', text: '최근 400개 메시지에 받을 수 있는 파일 없음' }], details: {} }
        const host = new URL(m.file_url).hostname
        if (!/(^|\.)kakaocdn\.net$|(^|\.)kakao\.com$/.test(host)) throw new Error(`unexpected file host ${host}`)
        // Saved under DOC_OUT/received so an edited copy next to it can go back out through kakao_send_file.
        const dir = `${process.env.OMODORI_FILE_DIR ?? `${DOC_OUT}received`}/${room().replace(/[^\w가-힣-]+/g, '_')}`
        await sh(['mkdir', '-p', dir], 5000)
        const safe = String(m.file_name).replace(/[\/\\:\0]/g, '_').slice(-180)
        const file = `${dir}/${m.timestamp.replace(/[:.]/g, '-')}_${safe}`
        const dl = await sh(['curl', '-fsSL', '--max-time', '120', '--max-filesize', String(300 * 1024 * 1024), '-o', file, m.file_url], 130_000)
        if (dl.code !== 0) throw new Error(`download failed: ${dl.text.slice(-200)}`)
        const size = Bun.file(file).size
        const who = m.is_from_me ? SELF : (m.sender ?? m.sender_id)
        return { content: [{ type: 'text', text: `${who}가 ${m.timestamp}에 올린 파일 "${m.file_name}" (${size} bytes)을 받음: ${file}\n원본은 그대로 두고, 수정본은 같은 폴더에 새 이름으로 만든 뒤 kakao_send_file로 보내.` }], details: { path: file, name: m.file_name, size } }
      } catch (e) {
        return { content: [{ type: 'text', text: `파일 받기 실패: ${(e as Error).message}` }], details: {} }
      }
    },
  })
  pi.registerTool({
    name: 'bot_fix_request',
    label: 'Bot fix request',
    description: `주인 본계정(주인님(주인))이 이 방에서 봇 자체를 고치라고 할 때(말투·지침 수정, 봇 도구 버그)만 부른다. 주인의 원래 메시지를 그대로 ${cfg.lead.name}에게 넘긴다. 다른 사람 부탁에는 부르지 마라(어차피 거절됨).`,
    parameters: { type: 'object', properties: {} },
    async execute() {
      // Forward only what kakao-push recorded from the owner's account in this room, verbatim (see recordOwnerFix).
      const file = process.env.OWNER_FIX_FILE ?? `${doriHome()}/sa-cache/owner-fix-requests.json`
      const fs = require('node:fs')
      let list: { at: number; text: string; forwarded?: boolean }[] = []
      try { list = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
      const now = Date.now()
      const fresh = list.filter((e) => !e.forwarded && now - e.at <= 10 * 60_000 && e.at <= now + 60_000)
      if (!fresh.length) return { content: [{ type: 'text', text: '거절: 최근 10분 안에 주인 본계정의 수정 지시가 없음(다른 사람 부탁은 못 넘김)' }], details: { code: 1 } }
      // redesign S9: the lead hears this through the event router (DORI_ASK), never by typing into its pane.
      const msg = `[카톡방 주인 봇 수정요청] ${fresh.map((e) => e.text).join(' / ')}`
      const events = `${doriHome()}/events/supervisor.ndjson`
      try {
        fs.mkdirSync(require('node:path').dirname(events), { recursive: true })
        fs.appendFileSync(events, `${JSON.stringify({ v: 2, at: new Date(now).toISOString(), id: `kakao.owner_fix_request:${now}`, kind: 'kakao.owner_fix_request', severity: 'ask', lane: process.env.OMODORI_LANE_KEY ?? 'kakao', source: 'kakao', data: { text: msg } })}\n`, { mode: 0o600 })
      } catch (e) {
        return { content: [{ type: 'text', text: `전달 실패: ${(e as Error).message.slice(-200)}` }], details: { code: 1 } }
      }
      for (const e of fresh) e.forwarded = true
      fs.writeFileSync(file, JSON.stringify(list))
      return { content: [{ type: 'text', text: `${cfg.lead.name}에게 넘김(${fresh.length}건). 방에는 "접수했어 고치면 알려줄게" 정도 한 줄만` }], details: { code: 0 } }
    },
  })
  pi.registerTool({
    name: 'kakao_profile_photo',
    label: 'Kakao profile photo',
    description: '지금 방 사람의 카톡 프로필 사진(오픈채팅방이면 오픈프로필 사진)을 직접 본다(이미지로 돌려줌). "내 프사 어때", "철수 프사 뭐야" 같은 말에 쓴다. nickname 은 카톡 닉 그대로나 앞부분(예: 철수). 상태메시지도 같이 온다.',
    parameters: { type: 'object', properties: { nickname: { type: 'string', description: '프사를 볼 사람의 카톡 닉네임' } }, required: ['nickname'] },
    async execute(_id: string, params: { nickname: string }) {
      try {
        // Open chats only answer member lookups by user id, so resolve the nickname to an id from the room's recent
        // messages and the saved nickname list first.
        const chat = CHAT_IDS[room()]
        const names = new Map<string, string>()
        try { for (const [id, n] of Object.entries(JSON.parse(require('node:fs').readFileSync(`${doriHome()}/sa-cache/kakao-nicks.json`, 'utf8')) as Record<string, string>)) names.set(id, n) } catch {}
        const recent = (await (await fetch(`${LOCO}/messages?chat=${chat}&count=400`, { signal: AbortSignal.timeout(30_000) })).json()) as { sender?: string | null; sender_id: string | number; is_from_me: boolean }[]
        for (const r of recent) if (!r.is_from_me && r.sender) names.set(String(r.sender_id), r.sender)
        const norm = (s: string) => s.split('/')[0]!.replace(/\s+/g, '').toLowerCase()
        const want = norm(params.nickname)
        const all = [...names.entries()]
        const exact = all.filter(([, n]) => norm(n) === want)
        const hits = exact.length ? exact : all.filter(([, n]) => norm(n).startsWith(want) || norm(n).includes(want))
        if (!hits.length) return { content: [{ type: 'text', text: `"${params.nickname}" 닉을 가진 사람을 못 찾음(최근 대화에 없는 사람일 수 있음)` }], details: {} }
        if (hits.length > 1) return { content: [{ type: 'text', text: `비슷한 닉이 여러 명: ${hits.map(([, n]) => n).join(', ')}. 더 정확한 닉으로 다시` }], details: {} }
        const res = await fetch(`${LOCO}/members?chat=${chat}&ids=${hits[0]![0]}`, { signal: AbortSignal.timeout(30_000) })
        if (!res.ok) throw new Error(`멤버 정보 못 받음 (${res.status}): ${(await res.text()).slice(0, 120)}`)
        const m = ((await res.json()) as { nickname: string; profile_image_url: string | null; full_profile_image_url: string | null; original_profile_image_url: string | null; status_message: string | null }[])[0]
        if (!m) return { content: [{ type: 'text', text: `${hits[0]![1]} 정보를 못 받음(방을 나갔을 수 있음)` }], details: {} }
        const url = m.original_profile_image_url || m.full_profile_image_url || m.profile_image_url
        const status = m.status_message ? ` / 상태메시지: ${m.status_message}` : ''
        if (!url) return { content: [{ type: 'text', text: `${m.nickname}은 프사가 없음(기본 이미지)${status}` }], details: {} }
        return { content: [{ type: 'text', text: `${m.nickname}의 프로필 사진${status}` }, { type: 'image', data: await imageBase64(url), mimeType: 'image/jpeg' }], details: {} }
      } catch (e) {
        return { content: [{ type: 'text', text: `프사 보기 실패: ${(e as Error).message}` }], details: {} }
      }
    },
  })
  pi.registerTool({
    name: 'kakao_send_image',
    label: 'Kakao send image',
    description: `지금 방에 이미지 한 장을 보낸다. source 는 공개 웹 이미지 URL(https://...) 또는 이미지 생성이 알려준 파일 경로 그대로(${cfg.kakao.generatedImagesDir} 안의 파일).`,
    parameters: { type: 'object', properties: { source: { type: 'string', description: '이미지 URL 또는 /tmp/omodori-img/ 안의 파일' } }, required: ['source'] },
    async execute(_id: string, params: { source: string }) {
      // Images and files wait behind queued kakao_send parts so a result never overtakes its summary.
      const job = sendChain.then(() => sendImage(params.source))
      sendChain = job.catch(() => {})
      return job
    },
  })
  pi.registerTool({
    name: 'kakao_send_file',
    label: 'Kakao send file',
    description: `지금 방에 문서 원본 파일(PDF·HWP·XLSX 등) 한 개를 카톡 파일로 보낸다. path 는 ${DOC_OUT} 아래 파일만 된다(그 밖은 거부). name 을 넣으면 그 이름으로 보인다(확장자 포함).`,
    parameters: { type: 'object', properties: { path: { type: 'string', description: `${DOC_OUT} 아래 파일의 절대경로` }, name: { type: 'string', description: '카톡에 보일 파일 이름(선택, 예: TBM회의록_10-16.pdf)' } }, required: ['path'] },
    async execute(_id: string, params: { path: string; name?: string }) {
      const job = sendChain.then(() => sendDocFile(params.path, params.name))
      sendChain = job.catch(() => {})
      return job
    },
  })
  pi.registerTool({
    name: 'kakao_send',
    label: 'Kakao send',
    description: '지금 방에 메시지 한 개를 보낸다. 접두어 없이 보낼 문장만 넣는다. 특정 사람 말에 답할 땐 그 줄 맨 앞 [rN]을 reply_to 로 넣으면 카톡 답장으로 간다(여러 명 대화에 끼는 건 reply_to 없이).',
    parameters: { type: 'object', properties: { text: { type: 'string', description: '보낼 메시지' }, reply_to: { type: 'string', description: '답장할 메시지 번호(예: r12). 없으면 일반 메시지' }, mention: { type: 'string', description: '[입장] 줄의 새로 온 사람 번호(예: m7). 넣으면 첫 말풍선 앞에 @닉네임 멘션' } }, required: ['text'] },
    // The model often fires several kakao_send calls at once; their split parts interleaved in the room (10-11).
    // Queue them so each call's parts go out together, in call order.
    execute(_id: string, params: { text: string; reply_to?: string; mention?: string }) {
      const job = sendChain.then(() => sendOne(params))
      sendChain = job.catch(() => {})
      return job
    },
  })
  async function sendOne(params: { text: string; reply_to?: string; mention?: string }) {
      const now = Date.now()
      if (!params.text.trim()) return { content: [{ type: 'text', text: 'skipped: empty message (nothing to say = do not call kakao_send)' }], details: { code: 0 } }
      if (recentSends.some((s) => s.text === params.text && now - s.at < 180_000)) return { content: [{ type: 'text', text: 'skipped: the same message was already sent in the last 3 minutes' }], details: { code: 0 } }
      // 주인 wants short split messages in group rooms and the model keeps packing two sentences into one bubble:
      // split by line and sentence end there. Data blocks ("[제목] ...") and the 1:1 room stay whole.
      // KakaoTalk turns "#41" into a hashtag that opens a Daum search (주인, 10-13). Write GitLab refs
      // as words (이슈 41, MR 112) in the rooms listed in kakao.issueRefRooms.
      if (cfg.kakao.issueRefRooms.includes(room())) {
        params.text = params.text
          .replace(/(^|[^\w&])#(\d{1,5})\b/g, (_m, pre, n) => `${pre}이슈 ${n}`)
          .replace(/(^|[\s(\[,/])!(\d{1,5})\b/g, (_m, pre, n) => `${pre}MR ${n}`)
      }
      const whole = room() === cfg.kakao.ownerRoom || params.text.trimStart().startsWith('[')
      // Chat-style: break after a sentence end or a ㅋㅋ/ㅎㅎ burst, drop the final period, and pause like typing.
      // A list number at the line start ("1. 소고기 국밥 : ...") is not a sentence end: splitting there sent "1" and the
      // item as two bubbles (10-12).
      const parts = whole ? [params.text] : params.text.split('\n')
        .flatMap((l) => l.split(/(?<!(?:^|\s)\d{1,2}\.)(?<=[.!?~])\s+|(?<=[ㅋㅎ]{2,}|[ㅠㅜ]{2,})\s+(?=\S)/))
        .map((s) => s.trim().replace(/(?<!\.)\.$/, ''))
        .filter(Boolean)
      // Reply (답장, 주인 10-14): only the first bubble is the reply; the rest follow as plain messages.
      let reply = ''
      if (params.reply_to) {
        try {
          const ref = JSON.parse(await Bun.file(REPLY_REFS).text()).refs[params.reply_to.replace(/[\[\]\s]/g, '')]
          if (ref && ref.chat === CHAT_IDS[room()]) reply = JSON.stringify({ log_id: ref.log_id, author_id: ref.author_id, message: ref.message, type: ref.type })
        } catch {}
      }
      // Mention (주인 10-14: greet newcomers with a mention): [mN] from an [입장] line -> first bubble starts with @nick.
      let mention = ''
      if (params.mention) {
        try {
          const ref = JSON.parse(await Bun.file(REPLY_REFS).text()).refs[params.mention.replace(/[\[\]\s]/g, '')]
          if (ref?.mention_id && ref.chat === CHAT_IDS[room()]) mention = JSON.stringify({ user_id: ref.mention_id, nick: ref.nick })
        } catch {}
      }
      let r = { code: 0, text: '' }
      for (const [i, part] of (parts.length ? parts : [params.text]).entries()) {
        if (i) await Bun.sleep(Math.min(1500, 400 + part.length * 40))
        r = await run(['send', room(), part, i === 0 ? reply : '', i === 0 ? mention : ''])
        if (r.code !== 0) break
      }
      if (r.code === 0) recentSends.push({ text: params.text, at: now })
      return { content: [{ type: 'text', text: r.code === 0 ? (parts.length > 1 ? `sent as ${parts.length} messages` : 'sent') : `send failed (exit ${r.code}): ${r.text.slice(-300)}` }], details: { code: r.code } }
  }
  pi.registerTool({
    name: 'kakao_recent',
    label: 'Kakao recent',
    description: '지금 방의 최근 메시지를 오래된 순서로 한 줄씩 읽는다(맥락 확인용, 최대 400개). "아까 뭐라고 했지", "오늘 무슨 얘기 했어" 같은 건 넓게 읽어라.',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: '개수(기본 30, 최대 400)' } } },
    async execute(_id: string, params: { limit?: number }) {
      const limit = String(Math.min(Math.max(Math.floor(params.limit ?? 30), 1), 400))
      const r = await run(['messages', '--account', BOT, '--chat', room(), '--limit', limit, '--json'])
      if (r.code !== 0) return { content: [{ type: 'text', text: `read failed (exit ${r.code}): ${r.text.slice(-300)}` }], details: { code: r.code } }
      // One line per message instead of pretty JSON: 400 messages stay small enough not to slow the lane.
      const kst = (t: string) => new Date(Date.parse(t) + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')
      const lines = (JSON.parse(r.text) as any[]).reverse().map((m) => `${kst(m.timestamp)} ${m.is_from_me ? SELF : (m.sender ?? m.sender_id)}: ${m.photo_url ? '[사진]' : String(m.text ?? '').replace(/\n/g, ' / ')}`)
      return { content: [{ type: 'text', text: lines.join('\n') }], details: { code: 0 } }
    },
  })
}
