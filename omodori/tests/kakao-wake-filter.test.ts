import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { BOT_ID, BURST, createBurstBuffer, looksUnfinished, waitsForMore, createWakeFilter, DOCS_QUESTIONS, MODEL, openRequests, QUESTIONS, THRESHOLD, type FilterRoom, type LedgerReq } from '../kakao-wake-filter'
import { CONTEXT_NOTE, judge, judgeBurst, ROOMS, route, settleBatch } from '../kakao-push'
import { SECRETARY_ID } from '../kakao-secretary-gate'

const group: FilterRoom = { name: 'group', lane: 'kakao-friend', owner: ['1'] }
const docs: FilterRoom = { name: 'docs', lane: 'kakao-acme-docs', owner: ['1'] }
const sudden: FilterRoom = { name: 'sudden', lane: 'kakao-family', owner: ['1'] }
const direct: FilterRoom = { name: 'direct', lane: 'kakao-owner', owner: ['1'], ownerOnly: true }

let seq = 0
const raw = (text: string, o: { sender?: number; me?: boolean; type?: number; photo?: boolean; mention?: string; reply?: string; at?: number } = {}) =>
  `{"chat_id":77,"is_from_me":${!!o.me},"log_id":${++seq},"message_type":${o.type ?? 1},"sender_id":${o.sender ?? 5},` +
  `${o.photo ? '"photo_url":"https://x/p.jpg",' : ''}${o.mention ? `"mentioned_user_ids":["${o.mention}"],` : ''}` +
  `${o.reply ? `"reply_to_user_id":"${o.reply}",` : ''}"text":${JSON.stringify(text)},"timestamp":"${new Date(o.at ?? 1_800_000_000_000).toISOString()}"}`

const answer = (scores: Record<string, number>) =>
  new Response(JSON.stringify({ model: MODEL, answers: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { noul: v }])) }))

function setup(reply: (body: any) => Response | Promise<Response> = () => answer({ seeks_bot: 0.9 }), key: string | null = 'k') {
  const calls: any[] = []
  const logs: Record<string, unknown>[] = []
  const filter = createWakeFilter({
    apiKey: () => key ?? undefined, log: (r) => logs.push(r), timeoutMs: 30,
    fetch: (async (_url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); calls.push(body); return reply(body) }) as any,
  })
  const run = (room: FilterRoom, text: string, o = {}) => filter.decide(filter.observe(raw(text, o), room)!)
  return { filter, calls, logs, run }
}

for (const [room, text, o, reason] of [
  [direct, '오늘 뭐해', {}, 'direct_room'],
  [group, '이거 봐줘', { mention: BOT_ID }, 'mention'],
  [group, '응 그거', { reply: BOT_ID }, 'reply_to_bot'],
  [group, '장도리야 이거 봐', {}, 'name_call'],
  [sudden, '단도리 있어?', {}, 'name_call'],
  [docs, '비서야 문서 고쳐줘', {}, 'name_call'],
  [sudden, '전적 홍길동', {}, 'command'],
  [sudden, '{"feedType":4}', { type: 0 }, 'feed'],
] as const) {
  test(`hard rule wakes without calling Jev: ${reason} (${room.lane})`, async () => {
    const s = setup()
    expect(await s.run(room, text, o)).toMatchObject({ decision: 'hard-wake', reason })
    expect(s.calls).toHaveLength(0)
  })
}

test('bot names are per room: 도리 is not a name call in the secretary room', async () => {
  const s = setup()
  expect((await s.run(docs, '도리 얘기 들었어?')).decision).toBe('wake')
  expect(s.calls).toHaveLength(1)
})

test('a photo from someone who just woke the bot wakes; a stranger photo goes to Jev', async () => {
  const s = setup(() => answer({ seeks_bot: 0.1 }))
  await s.run(group, '장도리야 이거 봐', { sender: 9 })
  expect(await s.run(group, '', { sender: 9, photo: true })).toMatchObject({ decision: 'hard-wake', reason: 'photo_by_engaged' })
  expect((await s.run(group, '', { sender: 8, photo: true })).decision).toBe('skip')
  expect(s.calls).toHaveLength(1)
})

for (const text of ['ㅋㅋㅋㅋ', 'ㅎㅎ', '?!', '']) {
  test(`reaction-only line is skipped without Jev: "${text}"`, async () => {
    const s = setup()
    expect(await s.run(group, text)).toMatchObject({ decision: 'skip', reason: 'reaction' })
    expect(s.calls).toHaveLength(0)
  })
}

test('threshold: the max of the five positive questions decides at 0.38', async () => {
  for (const [scores, decision] of [
    [{ seeks_bot: 0.1, work_request: THRESHOLD }, 'wake'],
    [{ seeks_bot: 0.1, adds_to_bot_task: 0.379 }, 'skip'],
    [{ seeks_bot: 0.2, to_other_person: 0.99 }, 'skip'],
    [{ seeks_bot: 0.95, only_reaction: 0.95, work_request: 0.2 }, 'skip'],
    [{ seeks_bot: 0.95, only_reaction: 0.95, work_request: 0.6 }, 'wake'],
  ] as const) {
    const s = setup(() => answer(scores))
    expect((await s.run(group, '이거 어떻게 생각해')).decision).toBe(decision)
  }
})

test('request carries v3 questions, the pinned model and the dataset state shape', async () => {
  const s = setup()
  s.filter.observe(raw('안녕', { sender: 1 }), group)
  s.filter.observe(raw('네 말씀하세요', { me: true }), group)
  for (let i = 0; i < 14; i++) s.filter.observe(raw(`줄${i}`), group)
  await s.run(group, '그럼 진행해')
  const body = s.calls[0]
  expect(body.model).toBe(MODEL)
  expect(Object.keys(body.questions)).toEqual(Object.keys(QUESTIONS))
  expect(body.state.previous_lines).toHaveLength(12)
  expect(body.state.previous_lines.at(-1).text).toBe('줄13')
  expect(body.state.message).toMatchObject({ text: '그럼 진행해', is_bot: false, has_photo: false })
  expect(body.state.bot_recent_replies[0]).toMatchObject({ bot_said: '네 말씀하세요', answering: '주인', answering_text: '안녕' })
  expect(body.state.room).toEqual({ name: 'group', kind: '단톡' })
})

for (const [name, reply, key, reason] of [
  ['server error', () => new Response('x', { status: 500 }), 'k', 'http-500'],
  ['rate limit', () => new Response('x', { status: 429 }), 'k', 'http-429'],
  ['network error', () => { throw new TypeError('fetch failed') }, 'k', 'network'],
  ['bad json', () => new Response('not json'), 'k', 'bad-json'],
  ['no key', () => answer({ seeks_bot: 0 }), null, 'no-key'],
] as const) {
  test(`fail-open wakes on ${name}`, async () => {
    const s = setup(reply as any, key)
    expect(await s.run(group, '오늘 점심 뭐 먹지')).toMatchObject({ decision: 'fail-open', reason })
  })
}

test('fail-open wakes when Jev does not answer within the timeout', async () => {
  const filter = createWakeFilter({
    apiKey: () => 'k', log: () => {}, timeoutMs: 30,
    fetch: ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as any,
  })
  expect(await filter.decide(filter.observe(raw('오늘 점심 뭐 먹지'), group)!)).toMatchObject({ decision: 'fail-open', reason: 'timeout' })
})

test('decision log keeps ids, decision, scores and latency but no message text', async () => {
  const s = setup(() => answer({ seeks_bot: 0.2 }))
  await s.run(group, '비밀스러운 대화 내용')
  await s.run(group, 'ㅋㅋ')
  expect(s.logs.map((l) => l.decision)).toEqual(['skip', 'skip'])
  expect(s.logs[0]).toMatchObject({ room: 'group', chat: '77', score: 0.2, model: MODEL })
  expect(typeof s.logs[0]!.ms).toBe('number')
  expect(JSON.stringify(s.logs)).not.toContain('비밀')
})

test('switch off wakes exactly as before and never calls Jev', async () => {
  const s = setup(() => answer({ seeks_bot: 0 }))
  const seen = s.filter.observe(raw('오늘 점심 뭐 먹지'), group)
  const room = { ...group, wakeFilter: false } as any
  expect(await judge(room, seen, s.filter)).toBe(true)
  expect(s.calls).toHaveLength(0)
  expect(await judge({ ...room, wakeFilter: true }, seen, s.filter)).toBe(false)
})

test('skipped batches are held and reach the lane as context in the next woken batch', () => {
  expect(settleBatch('c1', ['a: 점심 뭐 먹지'], false)).toBeNull()
  expect(settleBatch('c1', ['b: ㅋㅋ'], false)).toBeNull()
  expect(settleBatch('c2', ['x: 다른 방'], true)).toEqual(['x: 다른 방'])
  expect(settleBatch('c1', ['a: 장도리야 추천해줘'], true)).toEqual([CONTEXT_NOTE, '[문맥] a: 점심 뭐 먹지', '[문맥] b: ㅋㅋ', 'a: 장도리야 추천해줘'])
  expect(settleBatch('c1', ['a: 고마워'], true)).toEqual(['a: 고마워'])
  for (let i = 0; i < 20; i++) settleBatch('c3', [`l${i}`], false)
  expect(settleBatch('c3', ['call'], true)).toHaveLength(14)
})

// [ACME] 테스트 room triage (주인 10-21): respond / collect / discard.
const DOCS_CHAT = '18000000000000001'
const docsRoom: FilterRoom = { name: '[ACME] 테스트', lane: 'kakao-acme-docs', owner: ['1'] }
const docsLine = (text: string, o: { sender?: number; mention?: boolean; file?: string } = {}) =>
  `{"chat_id":${DOCS_CHAT},"is_from_me":false,"log_id":${++seq},"message_type":${o.file ? 18 : 1},"sender_id":${o.sender ?? 700},` +
  `${o.file ? `"file_name":"${o.file}",` : ''}${o.mention ? `"mentioned_user_ids":["${SECRETARY_ID}"],` : ''}` +
  `"text":${JSON.stringify(text)},"timestamp":"${new Date().toISOString()}"}`

const PAST = '2026-10-01T00:00:00Z'
const openReq: LedgerReq = { user_id: '999', title: '위험성평가표 작성', nick: '요청자A', status: '검토대기', created: PAST, updated: PAST }
function docsSetup(scores: Record<string, number> | 'error', ledger: LedgerReq[] = [openReq]) {
  const calls: any[] = []
  const logs: Record<string, unknown>[] = []
  const filter = createWakeFilter({
    apiKey: () => 'k', log: (r) => logs.push(r), timeoutMs: 30, ledger: () => ledger,
    fetch: (async (_u: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return scores === 'error' ? new Response('x', { status: 503 }) : answer(scores) }) as any,
  })
  const routed = async (text: string, o = {}) => { const l = docsLine(text, o); return route(l, filter.observe(l, docsRoom), filter) }
  const send = async (text: string, o = {}) => { const r = await routed(text, o); return r?.burst ? (await judgeBurst([r], filter))[0] ?? null : r }
  const sendBurst = async (lines: [string, object?][]) => {
    const items = []
    for (const [t, o] of lines) { const r = await routed(t, o ?? {}); if (r) items.push(r) }
    return judgeBurst(items, filter)
  }
  return { calls, logs, send, sendBurst }
}
const withDocsFilter = async (on: boolean, fn: () => Promise<void>) => {
  const before = ROOMS[DOCS_CHAT]!.wakeFilter
  ROOMS[DOCS_CHAT]!.wakeFilter = on
  try { await fn() } finally { ROOMS[DOCS_CHAT]!.wakeFilter = before }
}

test('docs room: a direct call, mention or reply still responds as [호출] without asking Jev', () => withDocsFilter(true, async () => {
  const s = docsSetup({ doc_work_request: 0 })
  expect((await s.send('강비서 견적 검토해줘', { sender: 701 }))).toMatchObject({ judged: 'respond', text: expect.stringContaining('[호출]') })
  expect((await s.send('이거 봐줘', { sender: 702, mention: true }))?.text).toContain('[호출]')
  expect(s.calls).toHaveLength(0)
  expect(s.logs.map((l) => [l.decision, l.reason, l.triage])).toEqual([['hard-wake', 'gate_called', 'respond'], ['hard-wake', 'gate_called', 'respond']])
}))

test('docs room: an uncalled work request responds as [요청판단]; Jev gets the room questions and open request titles', () => withDocsFilter(true, async () => {
  const s = docsSetup({ doc_work_request: 0.9, useful_context: 0.2 })
  const r = await s.send('내일자로 TBM 일지 새로 써줘', { sender: 703 })
  expect(r).toMatchObject({ judged: 'respond' })
  expect(r!.text).toStartWith('[요청판단] ')
  expect(Object.keys(s.calls[0].questions)).toEqual(Object.keys(DOCS_QUESTIONS))
  expect(s.calls[0].state.open_requests).toEqual([{ requester: '요청자A', status: '검토대기' }])
  expect(s.calls[0].state.author).toEqual({ has_open_request: false, bot_worked_for_author_minutes_ago: null })
  expect(s.logs[0]).toMatchObject({ decision: 'wake', reason: 'jev', triage: 'respond', score: 0.9 })
}))

test('docs room: respond threshold is recall-first (0.27) and any of the five respond questions counts', () => withDocsFilter(true, async () => {
  expect((await docsSetup({ follows_open_request: 0.27 }).send('그거 11월 30일로', { sender: 704 }))?.judged).toBe('respond')
  expect((await docsSetup({ question_to_bot: 0.26, useful_context: 0.1 }).send('그거 가능해?', { sender: 705 }))).toBeNull()
}))

test('docs room: useful context is collected as [문맥] and does not wake; a shared file is never discarded', () => withDocsFilter(true, async () => {
  const s = docsSetup({ doc_work_request: 0.1, useful_context: 0.8 })
  const r = await s.send('견적은 내일 항목 적은 걸로 보내기로 했어', { sender: 706 })
  expect(r).toMatchObject({ judged: 'collect' })
  expect(r!.text).toStartWith('[문맥] ')
  expect(s.logs[0]).toMatchObject({ decision: 'skip', reason: 'jev', triage: 'collect' })
  expect((await docsSetup({ doc_work_request: 0.1, useful_context: 0.1 }).send('', { sender: 707, file: '견적.xlsx' }))?.judged).toBe('collect')
}))

test('docs room: chat and reactions are discarded (reactions without asking Jev)', () => withDocsFilter(true, async () => {
  const s = docsSetup({ doc_work_request: 0.05, useful_context: 0.1 })
  expect(await s.send('넵 알겠습니다 이사님', { sender: 708 })).toBeNull()
  expect(await s.send('ㅋㅋㅋ', { sender: 708 })).toBeNull()
  expect(s.calls).toHaveLength(1)
  expect(s.logs.map((l) => l.triage)).toEqual(['discard', 'discard'])
}))

test('docs room fail-open keeps the old gate behavior: a 5-minute follow-up responds as [후속후보], other lines drop', () => withDocsFilter(true, async () => {
  const s = docsSetup('error')
  expect((await s.send('강비서 표 만들어줘', { sender: 709 }))?.text).toContain('[호출]')
  expect((await s.send('첨부 자료 더 줄게', { sender: 709 }))).toMatchObject({ judged: 'respond', text: expect.stringContaining('[후속후보]') })
  expect(await s.send('오늘 점심 뭐 먹지', { sender: 710 })).toBeNull()
  expect(s.logs.slice(1).map((l) => [l.decision, l.reason])).toEqual([['fail-open', 'http-503'], ['fail-open', 'http-503']])
}))

test('docs room with the switch off is exactly the old secretary gate', () => withDocsFilter(false, async () => {
  const s = docsSetup({ doc_work_request: 0.99 })
  expect(await s.send('내일자로 TBM 일지 새로 써줘', { sender: 711 })).toBeNull()
  expect(s.calls).toHaveLength(0)
}))

test('collected lines reach the lane as [문맥] once, with the context note, in the batch that wakes', () => {
  expect(settleBatch('d1', ['[문맥] a: 일정 공유'], false)).toBeNull()
  expect(settleBatch('d1', ['[문맥] b: 결정 사항', '[요청판단] a: 진행해줘'], true)).toEqual([CONTEXT_NOTE, '[문맥] a: 일정 공유', '[문맥] b: 결정 사항', '[요청판단] a: 진행해줘'])
})

test('openRequests keeps titles of requests open at that time, never their details', () => {
  const file = `${tmpdir()}/ledger-${Date.now()}.json`
  writeFileSync(file, JSON.stringify([
    { title: '열린 요청', nick: 'a', status: '검토대기', detail: 'SECRET', created: '2026-10-20T00:00:00Z', updated: '2026-10-20T01:00:00Z' },
    { title: '끝난 요청', nick: 'b', status: '완료', created: '2026-10-19T00:00:00Z', updated: '2026-10-19T05:00:00Z' },
    { title: '나중 요청', nick: 'c', status: '검토대기', created: '2026-10-22T00:00:00Z', updated: '2026-10-22T00:00:00Z' },
  ]))
  expect(openRequests(Date.parse('2026-10-21T00:00:00Z'), file)).toEqual([{ title: '열린 요청', requester: 'a', status: '검토대기' }])
  expect(openRequests(Date.parse('2026-10-19T03:00:00Z'), file).map((q) => q.title)).toEqual(['끝난 요청'])
  expect(JSON.stringify(openRequests(Date.now(), file))).not.toContain('SECRET')
  expect(openRequests(Date.now(), '/nonexistent/ledger.json')).toEqual([])
})

test('burst buffer: one person\'s lines wait for quiet, longer when unfinished, never past the cap, and a call flushes', () => {
  const b = createBurstBuffer<string>()
  b.add('r:a', 'l1', 0, true)
  b.add('r:a', 'l2', 10_000, false)
  b.add('r:b', 'x1', 5_000, false)
  expect(b.due(5_000 + BURST.quietMs - 1).map((g) => g.key)).toEqual([])
  expect(b.due(5_000 + BURST.quietMs).map((g) => g.items)).toEqual([['x1']])
  expect(b.due(10_000 + BURST.quietMs - 1)).toEqual([])
  expect(b.due(10_000 + BURST.quietMs)).toEqual([{ key: 'r:a', items: ['l1', 'l2'] }])
  b.add('r:a', 'u1', 0, true)
  expect(b.due(BURST.quietMs)).toEqual([])
  expect(b.due(BURST.unfinishedMs)).toEqual([{ key: 'r:a', items: ['u1'] }])
  for (let t = 0; t <= 40_000; t += 10_000) b.add('r:c', `c${t}`, t, false)
  expect(b.due(BURST.maxMs - 1)).toEqual([])
  expect(b.due(BURST.maxMs)[0]!.items).toHaveLength(5)
  b.add('r:d', 'd1', 0, false)
  b.add('r:d', 'd2', 1_000, false, true)
  expect(b.due(1_000)).toEqual([{ key: 'r:d', items: ['d1', 'd2'] }])
})

test('unfinished: trailing connectives, commas, files and photos wait longer; finished sentences do not', () => {
  for (const t of ['현장은 음성이고', '작업기간은,', '그리고', '어제 보낸 파일에서']) expect(looksUnfinished(t)).toBe(true)
  for (const t of ['내일자로 채워줘', '가능해?', '확인했습니다.', '진행해']) expect(looksUnfinished(t)).toBe(false)
  expect(waitsForMore({ text: '[파일] 계획서.pdf', has_photo: false })).toBe(true)
  expect(waitsForMore({ text: '', has_photo: true })).toBe(true)
  expect(waitsForMore({ text: '진행해', has_photo: false })).toBe(false)
})

test('docs burst: split lines are judged once and all go to the lane when any part responds', () => withDocsFilter(true, async () => {
  const s = docsSetup({ doc_work_request: 0.8 })
  const out = await s.sendBurst([['고소작업대 작업계획서', { sender: 720 }], ['기간만', { sender: 720 }], ['11월 30일까지로 바꿔줘', { sender: 720 }]])
  expect(s.calls).toHaveLength(1)
  expect(s.calls[0].state.message.text).toBe('고소작업대 작업계획서\n기간만\n11월 30일까지로 바꿔줘')
  expect(s.calls[0].state.lines_in_message).toBe(3)
  expect(out.map((r) => r.text.split(' ')[0])).toEqual(['[요청판단]', '[요청판단]', '[요청판단]'])
  expect(s.logs.map((l) => [l.group, l.follower ?? false])).toEqual([[3, false], [3, true], [3, true]])
}))

test('docs burst: a direct call anywhere in the burst makes the whole burst respond without Jev', () => withDocsFilter(true, async () => {
  const s = docsSetup({ doc_work_request: 0 })
  const out = await s.sendBurst([['어제 받은 파일 말인데', { sender: 721 }], ['강비서 이거 엑셀로 바꿔줘', { sender: 721 }]])
  expect(s.calls).toHaveLength(0)
  expect(out.map((r) => r.text.split(' ')[0])).toEqual(['[요청판단]', '[호출]'])
}))

test('follow-up: someone with an open request or recent ledger work keeps getting answers without calling', () => withDocsFilter(true, async () => {
  const now = new Date().toISOString()
  const low = { doc_work_request: 0.1, follows_open_request: 0.15, useful_context: 0.2, only_reaction: 0.1, to_other_person: 0.1 }
  const mine: LedgerReq = { user_id: '730', title: '수시위험성평가표 기간 연장', nick: '요청자B', status: '검토대기', created: PAST, updated: now }
  const s = docsSetup(low, [mine])
  expect((await s.send('글씨 크기는 원본대로 해줘', { sender: 730 }))).toMatchObject({ judged: 'respond', text: expect.stringContaining('[요청판단]') })
  expect(s.calls[0].state.author).toEqual({ has_open_request: true, bot_worked_for_author_minutes_ago: 0 })
  expect(s.calls[0].state.bot_recent_work).toEqual([{ requester: '요청자B', minutes_ago: 0 }])
  expect(s.logs[0]).toMatchObject({ decision: 'wake', reason: 'followup', via: 'followup' })
  const done: LedgerReq = { ...mine, status: '완료', updated: now }
  expect((await docsSetup(low, [done]).send('이것도 같이 바꿔줘', { sender: 730 }))?.judged).toBe('respond')
  expect(await docsSetup(low, [{ ...done, updated: PAST }]).send('이것도 같이 바꿔줘', { sender: 730 })).toBeNull()
}))

test('follow-up does not answer bare reactions or talk aimed at someone else', () => withDocsFilter(true, async () => {
  const mine: LedgerReq = { user_id: '731', title: '견적 검토', nick: '요청자C', status: '검토대기', created: PAST, updated: PAST }
  expect(await docsSetup({ doc_work_request: 0.1, only_reaction: 0.95 }, [mine]).send('네 감사합니다', { sender: 731 })).toBeNull()
  expect(await docsSetup({ doc_work_request: 0.1, to_other_person: 0.8 }, [mine]).send('이사님 내일 뵐게요', { sender: 731 })).toBeNull()
}))

test('follow-up after the secretary was woken for the same person in the last 15 minutes', () => withDocsFilter(true, async () => {
  const s = docsSetup({ doc_work_request: 0.1, useful_context: 0.1, only_reaction: 0.1, to_other_person: 0.1 }, [])
  expect((await s.send('강비서 회의록 양식 만들어줘', { sender: 732 }))?.judged).toBe('respond')
  expect((await s.send('참석자 칸도 넣어줘', { sender: 733 }))).toBeNull()
  expect((await s.send('참석자 칸도 넣어줘', { sender: 732 }))?.judged).toBe('respond')
}))
