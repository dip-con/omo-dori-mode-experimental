import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseRows, render, summarize, windowOf } from '../wake-filter-stats'

const rows = parseRows(readFileSync(`${import.meta.dir}/fixtures/wake-filter-sample.ndjson`, 'utf8'))
const day = { start: new Date('2026-10-20T00:00:00+09:00'), end: new Date('2026-10-21T00:00:00+09:00') }

test('malformed lines are skipped, not fatal', () => {
  expect(rows).toHaveLength(15)
})

test('counts one day per room, with held batches as saved lane wakes', () => {
  const s = summarize(rows, day.start, day.end)
  expect(s.total).toMatchObject({ messages: 11, hard: 4, jevWake: 1, skip: 4, reaction: 1, failOpen: { timeout: 1, 'no-key': 1 }, held: 1 })
  expect(s.rooms['A방']).toMatchObject({ messages: 7, hard: 3, jevWake: 1, skip: 3, held: 1 })
  expect(s.rooms['B방']).toMatchObject({ messages: 4, failOpen: { timeout: 1, 'no-key': 1 }, held: 0 })
})

test('Jev calls include timeouts but not missing keys; latency and cost use jev rows', () => {
  const s = summarize(rows, day.start, day.end)
  expect(s.total.jevCalls).toBe(5)
  expect(s.total.tokens).toBe(1700 + 1800 + 1700 + 1723 + 1600)
  expect(s.total.latencies.sort()).toEqual([160, 180, 200, 220])
})

test('miss candidate: a Jev skip followed within 10 minutes by a name call, reply or mention in the same room', () => {
  const s = summarize(rows, day.start, day.end)
  expect(s.rooms['A방']!.missed).toBe(1)
  expect(s.rooms['B방']!.missed).toBe(1)
  expect(s.total.missed).toBe(2)
})

test('report puts alerts first, has numbers and no message text or emoji', () => {
  const out = render(summarize(rows, day.start, day.end))
  const lines = out.split('\n')
  expect(lines[0]).toStartWith('주의: fail-open 2건(18%)')
  expect(lines[1]).toBe('주의: 놓침 후보 2건(A방 1, B방 1)')
  expect(lines[2]).toBe('카톡 거름망 10-20')
  expect(out).toContain('메시지 11, 깨움 7(바로 4, Jev 1, fail-open 2), 버림 4(36%, 반응어 1)')
  expect(out).toContain('아낀 레인 깨움 1회')
  expect(out).toContain('Jev 5회, p50 200ms, p95 220ms')
  expect(out).not.toMatch(/\p{Extended_Pictographic}/u)
})

test('[작업] 문서방 collected lines are counted inside skips', () => {
  const extra = [{ at: '2026-10-20T15:00:00+09:00', room: 'D방', chat: '3', log_id: '20', decision: 'skip', reason: 'jev', triage: 'collect', ms: 190, tokens: 2400 }]
  const s = summarize([...rows, ...extra], day.start, day.end)
  expect(s.rooms['D방']).toMatchObject({ messages: 1, skip: 1, collect: 1 })
  expect(render(s)).toContain('버림 5(42%, 반응어 1, 그중 수집 1)')
})

test('a clean day has no alert line', () => {
  const clean = rows.filter((r) => r.decision !== 'fail-open' && r.reason !== 'reply_to_bot' && r.log_id !== '6' && r.log_id !== '13')
  const out = render(summarize(clean, day.start, day.end))
  expect(out.split('\n')[0]).toBe('카톡 거름망 10-20')
})

test('window: Korean days; default is yesterday, --days counts back, --since with --days spans that range', () => {
  const kst = (s: string) => new Date(`${s}+09:00`)
  const now = kst('2026-10-21T00:30:00')
  expect(windowOf([], now)).toEqual({ start: kst('2026-10-20T00:00:00'), end: kst('2026-10-21T00:00:00') })
  expect(windowOf(['--days', '7'], now)).toEqual({ start: kst('2026-10-14T00:00:00'), end: kst('2026-10-21T00:00:00') })
  expect(windowOf(['--since', '2026-10-18', '--days', '2'], now)).toEqual({ start: kst('2026-10-18T00:00:00'), end: kst('2026-10-20T00:00:00') })
  expect(windowOf(['--since', '2026-10-18'], now).end).toEqual(now)
})
