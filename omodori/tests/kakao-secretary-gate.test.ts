import { expect, test } from 'bun:test'
import { addressingFields, createSecretaryGate, SECRETARY_ID } from '../kakao-secretary-gate'
import { route } from '../kakao-push'
import { botForLane } from '../config'

const DOCS_BOT = botForLane('kakao-docs')

const base = { chat: 'room', sender: 'user', at: 1000, text: '' }
for (const text of ['루루 도와줘', '문서봇아 확인해줘', '@루루 번역해줘', '문서봇']) {
  test(`direct address opens the gate: ${text}`, () => {
    const gate = createSecretaryGate(DOCS_BOT)
    expect(gate({ ...base, text })).toBe('called')
  })
}
for (const text of ['오늘 점심 뭐 먹지?', '루루가 만든 문서야', '문서봇은 아직 작업 중이야', 'ㅋㅋ', '문서.xlsx']) {
  test(`ordinary conversation stays silent: ${text}`, () => {
    expect(createSecretaryGate(DOCS_BOT)({ ...base, text })).toBeNull()
  })
}
test('native mention and bot reply work independently of nickname and elapsed time', () => {
  const gate = createSecretaryGate(DOCS_BOT)
  expect(gate({ ...base, text: '@다른별칭 확인', mentioned_user_ids: [SECRETARY_ID] })).toBe('called')
  expect(gate({ ...base, at: 9_000_000, text: '확인했어요', reply_to_user_id: SECRETARY_ID })).toBe('called')
})
test('follow-up is sender and room scoped, bounded, and does not extend itself', () => {
  const gate = createSecretaryGate(DOCS_BOT)
  gate({ ...base, text: '루루 확인해줘' })
  expect(gate({ ...base, at: 2000, text: '첨부.xlsx' })).toBe('continued')
  expect(gate({ ...base, sender: 'other', at: 2000, text: '맞아' })).toBeNull()
  expect(gate({ ...base, chat: 'other', at: 2000, text: '맞아' })).toBeNull()
  expect(gate({ ...base, at: 301000, text: '추가자료' })).toBe('continued')
  expect(gate({ ...base, at: 301001, text: '추가자료' })).toBeNull()
})
for (const target of [
  { mentioned_user_ids: ['5400000000000000001'] },
  { reply_to_user_id: '5400000000000000001' },
  { text: '@다른사람 점심 먹자' },
]) {
  test(`addressing another person closes follow-up: ${JSON.stringify(target)}`, () => {
    const gate = createSecretaryGate(DOCS_BOT)
    gate({ ...base, text: '루루 확인해줘' })
    expect(gate({ ...base, at: 2000, ...target })).toBeNull()
    expect(gate({ ...base, at: 3000, text: '응' })).toBeNull()
  })
}
test('receiver keeps native mention and reply IDs as strings', () => {
  const fields = addressingFields({ mentions: [{ user_id: SECRETARY_ID }], src_userId: '5400000000000000001' }, String)
  expect(fields).toEqual({ mentioned_user_ids: [SECRETARY_ID], reply_to_user_id: '5400000000000000001' })
  expect(addressingFields(null, String)).toEqual({})
})
test('real route gates only the secretary room, including feeds and another person', async () => {
  const line = (text: string, extra = {}) => JSON.stringify({
    chat_id: 18000000000000001n.toString(), sender_id: '888888', sender: 'test',
    message_type: 1, timestamp: '2026-10-19T00:00:00Z', text, ...extra,
  }).replace('"18000000000000001"', '18000000000000001').replace('"888888"', '888888')
  expect(await route(line('점심 뭐 먹지?'))).toBeNull()
  const called = await route(line('다른 표시명', addressingFields({ mentions: [{ user_id: SECRETARY_ID }] }, String)))
  expect(called?.text).toContain('[호출]')
  expect((await route(line('추가 자료입니다')))?.text).toContain('[후속후보]')
  expect(await route(line('다른 사람에게 답장', { reply_to_user_id: '777777' }))).toBeNull()
  expect(await route(line('그렇지'))).toBeNull()
  expect(await route(line('루루', { is_from_me: true }))).toBeNull()
  expect(await route(line('{"feedType":4,"members":[{"nickName":"test"}]}', { message_type: 0 }))).toBeNull()
  expect(await route(line('ordinary room').replace('18000000000000001', '480000000000001'))).not.toBeNull()
})
