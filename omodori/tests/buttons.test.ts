import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Deps, type Interaction, GENERAL_CHANNEL, OWNER_ID, Store, handleInteraction, handleOwnerText, newAsk, pollRelayOnce, publish, syncPaneQuestion } from '../buttons'
import { sessionDirSlug } from '../questions'

const fx = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')
const IDLE_SCREEN = ' ANSWER: done\n\n─────────────────────────────────────────\n❯\n─────────────────────────────────────────\n/private/tmp • status\n'

type Call = { method: string; path: string; body: any }
let dir: string
let calls: Call[]
let keys: string[][]
let texts: string[]
let screen: string
let events: Record<string, unknown>[]
let onKeys: (k: string[]) => void
let deps: Deps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omocat-buttons-test-'))
  calls = []; keys = []; texts = []; events = []; screen = IDLE_SCREEN; onKeys = () => {}
  let next = 100
  deps = {
    store: new Store(join(dir, 'b.db')),
    discord: async (method, path, body) => {
      calls.push({ method, path, body })
      return { ok: true, status: 200, json: method === 'POST' && path.endsWith('/messages') ? { id: String(next++) } : null }
    },
    herdr: {
      read: async () => screen,
      keys: async (_pane, ...k) => { keys.push(k); onKeys(k) },
      text: async (_pane, t) => { texts.push(t) },
    },
    emit: (p) => events.push(p),
    sleep: async () => {},
  }
})
afterEach(() => { deps.store.db.close(); rmSync(dir, { recursive: true, force: true }) })

const press = (customId: string, user = OWNER_ID, message = '100'): Interaction => ({
  id: 'i1', token: 'tok', type: 'INTERACTION_CREATE', channel_id: 'ch',
  member: { user: { id: user, username: 'u' } }, message: { id: message, channel_id: 'ch' }, data: { custom_id: customId, component_type: 2 },
})

function sessionLog(questions: unknown[]) {
  const root = join(dir, 'sessions')
  const cwd = mkdtempSync(join(tmpdir(), 'omocat-pane-'))
  mkdirSync(join(root, sessionDirSlug(cwd)), { recursive: true })
  const path = join(root, sessionDirSlug(cwd), '2026-10-02T00-00-00-000Z_sess-1.jsonl')
  writeFileSync(path, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'toolu_open', name: 'ask_user_question', arguments: { questions } }] } }) + '\n')
  const resolve = (status: string, text: string) => appendFileSync(path, JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'toolu_open', toolName: 'ask_user_question', content: [{ type: 'text', text }], details: { status } } }) + '\n')
  return { root, cwd, path, resolve, cleanup: () => rmSync(cwd, { recursive: true, force: true }) }
}
const SINGLE = [{ header: '확인', question: '진행할까요?', multiSelect: false, options: [{ label: '예' }, { label: '아니오' }] }]

test('a non-owner press is refused ephemerally and nothing is injected', async () => {
  const a = await publish(newAsk({ kind: 'pane', channel: 'ch', pane: 'wX:p1', questions: [{ text: '진행할까요?', options: [{ label: '예', value: '예' }], multiSelect: false }] }), deps)
  calls = []
  expect(await handleInteraction(press(`oq|${a.id}|0|0`, '123'), deps)).toBe(true)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.path).toBe('/interactions/i1/tok/callback')
  expect(calls[0]!.body).toMatchObject({ type: 4, data: { flags: 64 } })
  expect(keys).toHaveLength(0)
  expect(deps.store.get(a.id)!.answers).toEqual({})
  expect(events[0]).toMatchObject({ event: 'rejected' })
})

test('a press that is not ours (no oq| prefix or not a button) is ignored', async () => {
  expect(await handleInteraction({ ...press('q|0|1') }, deps)).toBe(false)
  expect(await handleInteraction({ ...press('oq|abc|0|1'), data: { custom_id: 'oq|abc|0|1', component_type: 3 } }, deps)).toBe(false)
  expect(calls).toHaveLength(0)
})

test('session question: post from the log, press acks first, injects the digit, verifies via the log, edits ✅', async () => {
  const log = sessionLog(SINGLE)
  screen = fx('omo-screen-single.txt')
  const r = await syncPaneQuestion({ pane: 'wX:p1', cwd: log.cwd, session: null }, screen, deps, log.root)
  expect(r.posted?.channel).toBe(GENERAL_CHANNEL)
  expect(r.posted?.callId).toBe('toolu_open')
  const post = calls.find((c) => c.method === 'POST')!
  expect(post.body.components[0].components.map((b: any) => b.label)).toEqual(['예', '아니오', '직접 입력'])

  calls = []
  onKeys = (k) => { if (k[0] === '1') { log.resolve('answered', '확인: 예'); screen = IDLE_SCREEN } }
  await handleInteraction(press(post.body.components[0].components[0].custom_id, OWNER_ID, r.posted!.messageIds[0]), deps)
  expect(calls[0]).toMatchObject({ path: '/interactions/i1/tok/callback', body: { type: 6 } })
  expect(keys).toEqual([['1']])
  const final = calls.filter((c) => c.method === 'PATCH').at(-1)!
  expect(final.body.content).toContain('선택: 예')
  expect(final.body.content).toContain('세션에 반영됨: 확인: 예')
  expect(final.body.components.flatMap((row: any) => row.components).every((b: any) => b.disabled)).toBe(true)
  expect(events.at(-1)).toMatchObject({ event: 'answer', injected: true, pane: 'wX:p1', label: '예', channel: 'ch' })
  expect(deps.store.get(r.posted!.id)!.status).toBe('answered')
  log.cleanup()
})

test('the same open question is never posted twice; leaving the UI closes it as cancelled', async () => {
  const log = sessionLog(SINGLE)
  const info = { pane: 'wX:p1', cwd: log.cwd, session: { key: 'btn', thread: 'thread-1' } }
  const first = await syncPaneQuestion(info, fx('omo-screen-single.txt'), deps, log.root)
  const second = await syncPaneQuestion(info, fx('omo-screen-single.txt'), deps, log.root)
  expect(first.posted?.channel).toBe('thread-1')
  expect(second.posted).toBeUndefined()
  expect(second.skipped).toBe('already posted')
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  log.resolve('cancelled', 'The user dismissed the question.')
  const gone = await syncPaneQuestion(info, IDLE_SCREEN, deps, log.root)
  expect(gone.closed[0]!.note).toContain('취소됨')
  const edit = calls.filter((c) => c.method === 'PATCH').at(-1)!
  expect(edit.body.components.flatMap((row: any) => row.components).every((b: any) => b.disabled)).toBe(true)
  expect((await syncPaneQuestion(info, fx('omo-screen-single.txt'), deps, log.root)).posted).toBeUndefined()
  log.cleanup()
})

test('a screen that only shows question strings posts nothing', async () => {
  const r = await syncPaneQuestion({ pane: 'wX:p1', cwd: tmpdir(), session: null }, fx('code-on-screen.txt'), deps, join(dir, 'none'))
  expect(r.posted).toBeUndefined()
  expect(calls).toHaveLength(0)
})

test('no session log at all: a single-question screen is posted from the screen', async () => {
  const r = await syncPaneQuestion({ pane: 'wX:p1', cwd: tmpdir(), session: null }, fx('omo-screen-single.txt'), deps, join(dir, 'none'))
  expect(r.posted).toMatchObject({ callId: null, questions: [{ text: '진행할까요?' }] })
  expect(r.posted!.questions[0]!.options.map((o) => o.label)).toEqual(['예', '아니오'])
})

test('OmOMeow\'s own pane is never posted', async () => {
  const r = await syncPaneQuestion({ pane: 'wW:p6', cwd: tmpdir(), session: null }, fx('omo-screen-single.txt'), deps, join(dir, 'none'))
  expect(r.skipped).toBe('self')
  expect(calls).toHaveLength(0)
})

test('multi-question set: first answer keeps the rest open; multi-select toggles then 선택 완료; then the whole set is injected', async () => {
  const log = sessionLog([
    { header: '모드', question: '어떤 모드로 배포할까요?', multiSelect: false, options: [{ label: '스테이징' }, { label: '프로덕션' }] },
    { header: '알림', question: '누구에게 알릴까요?', multiSelect: true, options: [{ label: '주인' }, { label: '오모냥' }, { label: '아무도' }] },
  ])
  screen = fx('omo-screen-multi-q1.txt').replace('어떤 모드로 배포할까요? 긴 설명이 붙은 질문이 줄바꿈될 때 파서가 잘 버티는지 보려고\n 일부러 길게 씁니다. 정말 긴 문장입니다.', '어떤 모드로 배포할까요?')
  const { posted } = await syncPaneQuestion({ pane: 'wX:p1', cwd: log.cwd, session: null }, screen, deps, log.root)
  const id = posted!.id

  calls = []
  await handleInteraction(press(`oq|${id}|0|1`), deps)
  const partial = calls.find((c) => c.method === 'PATCH')!
  const buttons = partial.body.components.flatMap((row: any) => row.components)
  expect(buttons.filter((b: any) => b.custom_id.startsWith(`oq|${id}|0|`)).every((b: any) => b.disabled)).toBe(true)
  expect(buttons.filter((b: any) => b.custom_id.startsWith(`oq|${id}|1|`)).some((b: any) => b.disabled)).toBe(false)
  expect(keys).toHaveLength(0)

  await handleInteraction(press(`oq|${id}|1|0`), deps)
  await handleInteraction(press(`oq|${id}|1|2`), deps)
  await handleInteraction(press(`oq|${id}|1|2`), deps)
  expect(deps.store.get(id)!.picks[1]).toEqual([0])
  await handleInteraction(press(`oq|${id}|1|1`), deps)
  expect(keys).toHaveLength(0)

  onKeys = (k) => { if (k[0] === 'tab') screen = fx('omo-screen-review.txt'); if (k[0] === 'enter') { log.resolve('answered', '모드: 프로덕션\n알림: 주인, 오모냥'); screen = IDLE_SCREEN } }
  await handleInteraction(press(`oq|${id}|1|c`), deps)
  expect(keys).toEqual([['2'], ['1'], ['2'], ['tab'], ['enter']])
  expect(events.at(-1)).toMatchObject({ event: 'answer', injected: true, answers: [{ answer: '프로덕션' }, { answer: '주인, 오모냥' }] })
  log.cleanup()
})

test('✍ 직접 입력: the owner\'s next message in that channel is the answer, typed via "Type your own answer"', async () => {
  const log = sessionLog(SINGLE)
  screen = fx('omo-screen-single.txt')
  const { posted } = await syncPaneQuestion({ pane: 'wX:p1', cwd: log.cwd, session: { key: 'k', thread: 'ch' } }, screen, deps, log.root)
  await handleInteraction(press(`oq|${posted!.id}|0|w`), deps)
  expect(events.at(-1)).toMatchObject({ event: 'other' })
  expect(calls.some((c) => c.method === 'POST' && String(c.body?.content).includes('답을 이 스레드에 써 주세요'))).toBe(true)
  expect(await handleOwnerText('other-channel', '보라색', 'm1', deps)).toBe(false)

  onKeys = (k) => { if (k[0] === 'enter' && texts.length > 0) { log.resolve('answered', '확인: 보라색'); screen = IDLE_SCREEN } }
  expect(await handleOwnerText('ch', '보라색', 'm2', deps)).toBe(true)
  expect(keys[0]).toEqual(['down', 'down', 'enter'])
  expect(texts).toEqual(['보라색'])
  expect(events.at(-1)).toMatchObject({ event: 'answer', injected: true, label: '보라색', from_message: 'm2' })
  log.cleanup()
})

test('a pane that already moved on is not typed into; the message says so', async () => {
  const log = sessionLog(SINGLE)
  screen = fx('omo-screen-single.txt')
  const { posted } = await syncPaneQuestion({ pane: 'wX:p1', cwd: log.cwd, session: null }, screen, deps, log.root)
  screen = IDLE_SCREEN
  await handleInteraction(press(`oq|${posted!.id}|0|0`), deps)
  expect(keys).toHaveLength(0)
  expect(events.at(-1)).toMatchObject({ event: 'answer', injected: false })
  expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body.content).toContain('세션에 넣지 못함')
  log.cleanup()
})

test('relay: a press pr-board already acked is handled without a second interaction callback', async () => {
  const a = await publish(newAsk({ kind: 'ask', channel: 'ch', questions: [{ text: '점심?', multiSelect: false, options: [{ label: '국밥', value: '국밥' }, { label: '라면', value: '라면' }] }] }), deps)
  calls = []
  const seen: { url: string; auth: string | null }[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') })
    return new Response(JSON.stringify([{ ...press(`oq|${a.id}|0|0`), type: undefined }]), { status: 200 })
  }) as unknown as typeof fetch
  expect(await pollRelayOnce(deps, { key: 'k-123', waitSeconds: 25, fetcher, url: 'https://relay.test/x' })).toBe(1)
  expect(seen).toEqual([{ url: 'https://relay.test/x?wait=25', auth: 'Bearer k-123' }])
  expect(calls.some((c) => c.path.startsWith('/interactions/'))).toBe(false)
  expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body.content).toContain('선택: 국밥')
  expect(events.at(-1)).toMatchObject({ event: 'answer', label: '국밥', via: 'relay' })
})

test('relay: an HTTP error is thrown so the listener backs off', async () => {
  const fetcher = (async () => new Response('{"error":"unauthorized"}', { status: 401 })) as unknown as typeof fetch
  await expect(pollRelayOnce(deps, { key: 'bad', fetcher })).rejects.toThrow('HTTP 401')
})

test('oc ask: --multi --other buttons, answer edits ✅ and a second press is stale; state survives a reopen of the DB', async () => {
  const a = await publish(newAsk({ kind: 'ask', channel: 'ch', other: true, questions: [{ text: '점심?', multiSelect: false, options: [{ label: '국밥', value: '국밥' }, { label: '라면', value: '라면' }] }] }), deps)
  const reopened: Deps = { ...deps, store: new Store(join(dir, 'b.db')) }
  await handleInteraction(press(`oq|${a.id}|0|1`), reopened)
  expect(events.at(-1)).toMatchObject({ event: 'answer', id: a.id, label: '라면', custom_id: `oq|${a.id}|0|1`, channel: 'ch', message: '100' })
  const edit = calls.filter((c) => c.method === 'PATCH').at(-1)!
  expect(edit.body.content).toContain('선택: 라면')
  expect(edit.body.components.flatMap((r: any) => r.components).every((b: any) => b.disabled)).toBe(true)
  await handleInteraction(press(`oq|${a.id}|0|0`), reopened)
  expect(events.at(-1)).toMatchObject({ event: 'stale' })
  reopened.store.db.close()
})
