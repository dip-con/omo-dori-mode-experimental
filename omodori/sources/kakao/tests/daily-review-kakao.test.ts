import { expect, test } from 'bun:test'
import { build, dayRange, openCount, parseSession } from '../../../core/daily-review'

const kst = (s: string) => Date.parse(`${s}+09:00`)
const range = dayRange('2026-10-22')
const empty = { since: 0, cursors: {}, promises: [], requests: [] }
const asst = (ts: string, extra: object) => JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'assistant', content: [], ...extra } })
const sayCall = (ts: string, cmd: string) => JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'assistant', content: [{ type: 'toolCall', name: 'eval', arguments: { code: cmd } }], stopReason: 'toolUse' } })

test('a kakao "started" message in a session that then hit a quota error is reported as stopped and started-only', () => {
  const text = [
    JSON.stringify({ type: 'session', id: 'aaaa', timestamp: '2026-10-22T12:00:00Z' }),
    sayCall('2026-10-22T12:13:41Z', 'await tool.bash({command: `bun ~/.omodori/kakao-say.ts app \\"자동 수집이랑 관리자 수동 수집 버튼 작업 시작했어\\"`})'),
    asst('2026-10-22T15:16:25Z', { stopReason: 'error', errorMessage: 'No credential slots available' }),
  ].join('\n')
  const s = parseSession('/x/2026_aaaa.jsonl', text, range)
  expect(s.says).toHaveLength(1)
  expect(s.says[0]).toMatchObject({ src: 'kakao', room: 'app', text: '자동 수집이랑 관리자 수동 수집 버튼 작업 시작했어' })
  const r = build({ date: '2026-10-22', now: kst('2026-10-23T08:00:00'), ledger: empty, inbox: [], bot: [], sessions: [s], laneKeys: { aaaa: 'kakao-work' } })
  expect(r.stopped[0]).toMatchObject({ lane: 'kakao-work' })
  expect(r.stopped[0]!.detail).toContain('No credential slots available')
  expect(r.started).toHaveLength(1)
  expect(openCount(r)).toBe(2)
})

