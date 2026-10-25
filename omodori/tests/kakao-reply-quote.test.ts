import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { addressingFields } from '../kakao-secretary-gate'
import { formatQuote, replyQuoteLine } from '../kakao-reply-quote'
import { route } from '../kakao-push'

const CHAT = '18000000000000001'
const ORIG = '3955694400810162178'
const REPLY = '3955694974752643074'
const full = '이사님, 당사에서 AI 에이전트를 자체 구축 및 운영할 경우, 임직원별 사용 이력과 업무 데이터를 통합 관리하고, 이를 AI 학습 및 성능 개선에 반영하여 전사적으로 일관된 답변과 품질을 유지할 수 있나요?'
const quoted = full.slice(0, 60)

const db = `${mkdtempSync(`${tmpdir()}/reply-quote-`)}/archive.db`
{
  const d = new Database(db)
  d.run(`create table messages (chat_id text, log_id text, author_name text, display text, sent_at integer, attachment text, deleted integer)`)
  const add = d.prepare('insert into messages values (?, ?, ?, ?, ?, ?, 0)')
  add.run(CHAT, ORIG, '김민재', full, 1792492700, '{}')
  add.run(CHAT, REPLY, '동료A', '이건 확인해보고 알려줄께', 1792492787,
    `{"src_logId":${ORIG},"src_userId":9020314425847786365,"src_message":${JSON.stringify(quoted)},"src_type":1}`)
  d.close()
}
const names = (id: string) => (id === '42' ? '이름표' : null)

test('receiver keeps the quoted log id and text', () => {
  expect(addressingFields({ src_userId: '7', src_logId: ORIG, src_message: quoted }, String))
    .toEqual({ reply_to_user_id: '7', reply_to_log_id: ORIG, reply_to_text: quoted })
})

test('truncated quote is replaced by the archived original with sender and KST time', async () => {
  const q = await replyQuoteLine({ message_type: 26, reply_to_log_id: ORIG, reply_to_user_id: '42', reply_to_text: quoted }, CHAT, '9', names, db)
  expect(q).toBe(`답장 대상: 김민재, 2026-10-20 19:38 KST, ${full}`)
})

test('an id that lost precision as a JS number still finds the original when the text agrees', async () => {
  const lossy = String(Number(ORIG))
  expect(lossy).not.toBe(ORIG)
  expect(await replyQuoteLine({ reply_to_log_id: lossy, reply_to_text: quoted }, CHAT, '9', names, db)).toContain(full)
  expect(await replyQuoteLine({ reply_to_log_id: lossy, reply_to_text: '전혀 다른 글' }, CHAT, '9', names, db))
    .toBe('답장 대상: ?, 시각 미상, 전혀 다른 글')
})

test('original missing from the archive falls back to the quoted text and the known name', async () => {
  expect(await replyQuoteLine({ reply_to_log_id: '1', reply_to_user_id: '42', reply_to_text: '줄\n바꿈 원문' }, CHAT, '9', names, db))
    .toBe('답장 대상: 이름표, 시각 미상, 줄 바꿈 원문')
  expect(await replyQuoteLine({ reply_to_log_id: '1', reply_to_text: 'x' }, CHAT, '9', names, `${db}.missing/none.db`))
    .toBe('답장 대상: ?, 시각 미상, x')
})

test('a reply line logged before the new fields is resolved through its own archived row', async () => {
  expect(await replyQuoteLine({ message_type: 26, reply_to_user_id: '9020314425847786000' }, CHAT, REPLY, names, db))
    .toBe(`답장 대상: 김민재, 2026-10-20 19:38 KST, ${full}`)
})

test('non-replies add nothing and long originals are cut at 300 chars', async () => {
  expect(await replyQuoteLine({ message_type: 1 }, CHAT, REPLY, names, db)).toBe('')
  const line = formatQuote({ name: 'a', at: null, text: '가'.repeat(400) }, null)
  expect(line).toBe(`답장 대상: a, 시각 미상, ${'가'.repeat(300)}…`)
})

test('route puts the quote line under the reply in the lane payload', async () => {
  const line = JSON.stringify({ chat_id: 'C', sender_id: 'S', sender: 'test', message_type: 26, timestamp: '2026-10-23T00:00:00Z',
    log_id: 'L', reply_to_log_id: '1', reply_to_text: '견적서 초안입니다', text: '강비서 이거 PDF로' })
    .replace('"C"', CHAT).replace('"S"', '777001').replace('"L"', '1')
  expect((await route(line))?.text).toBe('[호출] test: 강비서 이거 PDF로\n답장 대상: ?, 시각 미상, 견적서 초안입니다')
})
