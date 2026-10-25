import { expect, test } from 'bun:test'
import { brief, extractPromises, ingest, isRequest, type Ledger, redact } from '../ledger'

const kst = (s: string) => Date.parse(`${s}+09:00`)
const at = kst('2026-10-23T13:00:00')

test('timed commitments from the brief examples get due times in KST', () => {
  expect(extractPromises('15시 재시작 때 같이 반영할게', at).map((p) => p.due)).toEqual([kst('2026-10-23T15:00:00')])
  expect(extractPromises('내일 아침에 결과 알려줄게', at).map((p) => p.due)).toEqual([kst('2026-10-24T09:00:00')])
  expect(extractPromises('13:50 이후에 다시 확인할게', at).map((p) => p.due)).toEqual([kst('2026-10-23T13:50:00')])
  expect(extractPromises('30분 뒤에 볼게', at).map((p) => p.due)).toEqual([at + 30 * 60_000])
})

test('past times, times without a commitment cue and code blocks are ignored', () => {
  expect(extractPromises('09:12 로그에 오류가 찍힘', at)).toEqual([])
  expect(extractPromises('어제 10시 회의록', at)).toEqual([])
  expect(extractPromises('`15:00 이후` 예시 문자열', at)).toEqual([])
  expect(extractPromises('카톡 실시간 읽기 멈췄어(14:52부터)', kst('2026-10-23T12:00:00'))).toEqual([])
  expect(extractPromises('봇이 보낸 "15시 재시작 때" 같은 약속, 24시간 넘은 건', at)).toEqual([])
  expect(extractPromises('07시 이후 2시간에 5천 개', kst('2026-10-23T09:19:00'))).toEqual([])
  expect(extractPromises('23시쯤 Claude 계정 한도가 다 차서 세션이 멈췄고', kst('2026-10-23T08:00:00'))).toEqual([])
})

test('a promise already past when first seen is logged without waking the lead', () => {
  const l: Ledger = { since: 0, cursors: {}, promises: [], requests: [] }
  expect(ingest(l, [], [{ id: '300', channel: 'c', content: '13:10 이후에 다시 볼게', at }], kst('2026-10-23T14:00:00'))).toEqual([])
  expect(l.promises[0]!.fired).toBe(true)
})

test('owner requests open, a later bot message marks them responded, due promises fire once', () => {
  const l: Ledger = { since: 0, cursors: {}, promises: [], requests: [] }
  const owner = [{ id: '100', channel_id: 'c1', content: '이거 오늘 안에 봐줘', at }, { id: '101', channel_id: 'c1', content: 'ㅇㅋ', at }]
  ingest(l, owner, [], at)
  expect(l.requests.map((r) => [r.id, r.status])).toEqual([['100', 'open']])
  expect(ingest(l, [], [{ id: '200', channel: 'c1', content: '13:30에 다시 확인할게', at: at + 60_000 }], at + 2 * 60_000)).toEqual([])
  expect(l.requests[0]!.status).toBe('responded')
  const ev = ingest(l, [], [], kst('2026-10-23T13:31:00'))
  expect(ev).toHaveLength(1)
  expect(ev[0]).toStartWith('PROMISE_DUE 200.0')
  expect(ingest(l, [], [], kst('2026-10-23T14:00:00'))).toEqual([])
  expect(brief(l, kst('2026-10-24T14:00:00'))[0]).toContain('24시간 넘게 열린 요청 1건')
})

test('secrets in owner text are masked before they reach a brief or list line', () => {
  expect(redact('비밀번호 Abcd1234#99 직접 해')).toBe('비밀번호 *** 직접 해')
  expect(redact('pr 관리자 Xyz98765!ab 로 초기화')).toBe('pr 관리자 *** 로 초기화')
  expect(redact('맥미니 : Qwe12345#0! 그리고')).toBe('맥미니 : *** 그리고')
  expect(redact('맥미니 : Abc12345\n그리고')).toBe('맥미니 : ***\n그리고')
  expect(redact('side-project 레인 다시 띄워줘')).toBe('side-project 레인 다시 띄워줘')
})

test('trivial acknowledgements are not requests', () => {
  expect(isRequest('넵')).toBe(false)
  expect(isRequest('side-project 레인 다시 띄워줘')).toBe(true)
})
