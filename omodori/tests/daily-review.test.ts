import { expect, test } from 'bun:test'
import { build, dayRange, isCompletion, isStartOnly, mask, openCount, parseSession, render } from '../daily-review'

const kst = (s: string) => Date.parse(`${s}+09:00`)
const range = dayRange('2026-10-22')
const empty = { since: 0, cursors: {}, promises: [], requests: [] }

const asst = (ts: string, extra: object) => JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'assistant', content: [], ...extra } })
const sayCall = (ts: string, cmd: string) => JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'assistant', content: [{ type: 'toolCall', name: 'eval', arguments: { code: cmd } }], stopReason: 'toolUse' } })

test('a kakao "started" message in a session that then hit a quota error is reported as stopped and started-only', () => {
  const text = [
    JSON.stringify({ type: 'session', id: 'aaaa', timestamp: '2026-10-22T12:00:00Z' }),
    sayCall('2026-10-22T12:13:41Z', 'await tool.bash({command: `bun ~/.omocat/kakao-say.ts acme \\"건설정보 자동 수집이랑 관리자 수동 수집 버튼 작업 시작했어\\"`})'),
    asst('2026-10-22T15:16:25Z', { stopReason: 'error', errorMessage: 'No credential slots available' }),
  ].join('\n')
  const s = parseSession('/x/2026_aaaa.jsonl', text, range)
  expect(s.says).toHaveLength(1)
  expect(s.says[0]).toMatchObject({ room: 'acme', text: '건설정보 자동 수집이랑 관리자 수동 수집 버튼 작업 시작했어' })
  const r = build({ date: '2026-10-22', now: kst('2026-10-23T08:00:00'), ledger: empty, inbox: [], bot: [], sessions: [s], laneKeys: { aaaa: 'kakao-acme-chat' } })
  expect(r.stopped[0]).toMatchObject({ lane: 'kakao-acme-chat' })
  expect(r.stopped[0]!.detail).toContain('No credential slots available')
  expect(r.started).toHaveLength(1)
  expect(openCount(r)).toBe(2)
})

test('a later completion message in the same room clears the started item', () => {
  const bot = [
    { src: 'kakao' as const, room: 'acme', at: kst('2026-10-22T10:00:00'), text: '작업 시작했어' },
    { src: 'kakao' as const, room: 'acme', at: kst('2026-10-22T11:00:00'), text: '작업 완료했어' },
  ]
  expect(build({ date: '2026-10-22', now: Date.now(), ledger: empty, inbox: [], bot, sessions: [] }).started).toHaveLength(0)
})

test('a start message containing 머지/배포 nouns is not a completion and does not clear an earlier start', () => {
  expect(isCompletion('건설정보 머지 배포 작업 시작했어')).toBe(false)
  expect(isStartOnly('건설정보 머지 배포 작업 시작했어')).toBe(true)
  expect(isCompletion('머지했어')).toBe(true)
  const bot = [
    { src: 'kakao' as const, room: 'acme', at: kst('2026-10-22T10:00:00'), text: '건설정보 자동 수집 작업 시작했어' },
    { src: 'kakao' as const, room: 'acme', at: kst('2026-10-22T11:00:00'), text: '건설정보 머지 배포 작업 시작했어' },
  ]
  const r = build({ date: '2026-10-22', now: kst('2026-10-23T08:00:00'), ledger: empty, inbox: [], bot, sessions: [] })
  expect(r.started.map((m) => m.text)).toEqual(bot.map((m) => m.text))
})

test('a completion after the review cutoff (end of day, or --now if earlier) does not clear a started item', () => {
  const bot = [
    { src: 'kakao' as const, room: 'acme', at: kst('2026-10-22T10:00:00'), text: '작업 시작했어' },
    { src: 'kakao' as const, room: 'acme', at: kst('2026-10-23T09:00:00'), text: '작업 완료했어' },
  ]
  expect(build({ date: '2026-10-22', now: kst('2026-10-24T00:00:00'), ledger: empty, inbox: [], bot, sessions: [] }).started).toHaveLength(1)
  const same = [bot[0]!, { src: 'kakao' as const, room: 'acme', at: kst('2026-10-22T20:00:00'), text: '작업 완료했어' }]
  expect(build({ date: '2026-10-22', now: kst('2026-10-22T15:00:00'), ledger: empty, inbox: [], bot: same, sessions: [] }).started).toHaveLength(1)
  expect(build({ date: '2026-10-22', now: kst('2026-10-23T00:00:00'), ledger: empty, inbox: [], bot: same, sessions: [] }).started).toHaveLength(0)
})

test('open requests and past-due promises of the day are listed; responded and other-day ones are not', () => {
  const ledger = {
    ...empty,
    requests: [
      { id: '1', channel: 'c', text: '배포 해줘 부탁해', at: kst('2026-10-22T09:00:00'), status: 'open' as const },
      { id: '2', channel: 'c', text: '답 받은 요청이야', at: kst('2026-10-22T09:05:00'), status: 'responded' as const },
      { id: '3', channel: 'c', text: '다른 날 요청이야', at: kst('2026-10-21T09:00:00'), status: 'open' as const },
    ],
    promises: [
      { id: 'p1', msgId: 'p1', channel: 'c', text: '15시에 알려줄게', phrase: '15시', due: kst('2026-10-22T15:00:00'), status: 'open' as const, createdAt: kst('2026-10-22T13:00:00') },
      { id: 'p2', msgId: 'p2', channel: 'c', text: '끝난 약속', phrase: '16시', due: kst('2026-10-22T16:00:00'), status: 'done' as const, createdAt: kst('2026-10-22T13:00:00') },
    ],
  }
  const r = build({ date: '2026-10-22', now: kst('2026-10-23T00:00:00'), ledger, inbox: [], bot: [], sessions: [] })
  expect(r.unanswered.map((q) => q.id)).toEqual(['1'])
  expect(r.pastDue.map((p) => p.id)).toEqual(['p1'])
})

test('a discord bot message after the request counts as an answer; [REPORT] blocker without done is a stopped lane', () => {
  const ledger = { ...empty, requests: [{ id: '1000', channel: 'c', text: '이거 해줘 지금', at: kst('2026-10-22T09:00:00'), status: 'open' as const }] }
  const bot = [{ src: 'discord' as const, room: 'c', at: kst('2026-10-22T09:01:00'), text: '확인', id: '2000' }]
  const rep = parseSession('/x/_b.jsonl', JSON.stringify({ type: 'message', timestamp: '2026-10-22T05:00:00Z', message: { role: 'user', content: [{ type: 'text', text: '[REPORT] lane-x | blocker | 권한이 없어서 막힘' }] } }), range)
  const r = build({ date: '2026-10-22', now: Date.now(), ledger, inbox: [], bot, sessions: [rep] })
  expect(r.unanswered).toHaveLength(0)
  expect(r.stopped[0]).toMatchObject({ lane: 'lane-x' })
})

test('secrets are masked and the report has the four headings with counts', () => {
  expect(mask('토큰 abc123 그리고 glpat-abcdefghij1234567890 와 Bearer abcdefghijklmnopqrstuvwxyz')).not.toMatch(/glpat-abc|abcdefghijklmnop|abc123/) // gitleaks:allow (fake token for the masker)
  expect(isStartOnly('작업 시작했어')).toBe(true)
  expect(isStartOnly('배포 끝났어')).toBe(false)
  const md = render(build({ date: '2026-10-22', now: Date.now(), ledger: empty, inbox: [], bot: [], sessions: [] }))
  for (const h of ['## Unanswered requests (0)', '## Promises past due (0)', '## Lanes stopped mid-task (0)', '## Started but never completed (0)']) expect(md).toContain(h)
})
