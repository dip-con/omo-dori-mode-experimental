import { expect, test } from 'bun:test'
import { assess, type LiveEvent, filterHandled } from '../kakao-stall'

const H = 3600_000
const now = Date.parse('2026-10-23T05:00:00Z')
const busyWeek = (lastAt: number): LiveEvent[] => {
  const out: LiveEvent[] = []
  for (let d = 1; d <= 7; d++) for (let i = 0; i < 10; i++) out.push({ t: now - d * 24 * H + i * 5 * 60_000, chat: 'x', sender: 's', fromMe: false })
  out.push({ t: lastAt, chat: 'x', sender: 's', fromMe: false })
  return out
}
const rooms = { r1: { owner: ['boss'] } }

test('a busy hour with no live event past the limit is a live stall; a recent event is fine', () => {
  expect(assess(busyWeek(now - 45 * 60_000), [now], now).live).toContain('no kakao-live message event for 45m')
  expect(assess(busyWeek(now - 10 * 60_000), [now], now).live).toBeNull()
})

test('a quiet hour (under 2 events/h over the week) never raises a live stall', () => {
  expect(assess([{ t: now - 5 * H, chat: 'x', sender: 's', fromMe: false }], [], now).live).toBeNull()
})

test('an owner message in a watched room with no push line for 30 min is a push stall; others are ignored', () => {
  const live: LiveEvent[] = [{ t: now - 40 * 60_000, chat: 'r1', sender: 'boss', fromMe: false }, { t: now - 40 * 60_000, chat: 'r1', sender: 'guest', fromMe: false }]
  expect(assess(live, [now - 50 * 60_000], now, { rooms }).push).toContain('1 owner message')
  expect(assess(live, [now - 39 * 60_000], now, { rooms }).push).toBeNull()
  expect(assess([{ t: now - 40 * 60_000, chat: 'other', sender: 'boss', fromMe: false }], [], now, { rooms }).push).toBeNull()
})

test('a stopped launchd job is reported at once', () => {
  expect(assess([], [], now, { running: { live: false, push: true } }).live).toBe('kakao-live launchd job is not running')
})

test('owner message the wake filter judged (even skip) is handled, not a push stall', () => {
  const now = Date.parse('2026-10-23T05:00:00Z')
  const msg = { t: now - 31 * 60_000, chat: '42', sender: 'o', fromMe: false }
  const rooms = { '42': { owner: ['o'] } }
  expect(assess([msg], [now - 40 * 60_000], now, { rooms }).push).toContain('1 owner message')
  const handled = filterHandled('{"at":"' + new Date(msg.t + 2000).toISOString() + '","room":"r","chat":"42","decision":"skip"}')
  expect(handled['42']).toBe(msg.t + 2000)
  expect(assess([msg], [now - 40 * 60_000], now, { rooms, handled }).push).toBeNull()
})
