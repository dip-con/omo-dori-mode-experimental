import { expect, test } from 'bun:test'
import { boundedResponse, startLocoWatchdog , TroubleWindow} from './kakao-loco-guard'

const quiet = () => {}
const never = () => new Promise<never>(() => {})

const halfOpenClient = { getMessages: (_chat: string, _o: { count: number }) => never() }

test('API call on a half-open LOCO client returns 504 instead of hanging', async () => {
  const res = await boundedResponse(async () => Response.json(await halfOpenClient.getMessages('1', { count: 10 })), 50, 'GET /messages', quiet)
  expect(res.status).toBe(504)
  expect(((await res.json()) as { error: string }).error).toContain('GET /messages timed out after 50ms')
})

test('a healthy API call and a non-timeout error pass through unchanged', async () => {
  expect((await boundedResponse(async () => Response.json([1]), 50, 'x', quiet)).status).toBe(200)
  await expect(boundedResponse(async () => { throw new Error('boom') }, 50, 'x', quiet)).rejects.toThrow('boom')
})

test('watchdog calls onDead after maxFails consecutive dead probes once armed', async () => {
  let alive = true
  const dead: string[] = []
  const wd = startLocoWatchdog(() => (alive ? Promise.resolve() : never()), (why) => dead.push(why), { intervalMs: 3_600_000, timeoutMs: 20, maxFails: 2 }, quiet)
  await wd.tick()
  alive = false
  await wd.tick()
  expect(dead).toEqual([])
  await wd.tick()
  wd.stop()
  expect(dead).toHaveLength(1)
  expect(dead[0]).toContain('2x in a row')
})

test('a successful probe resets the failure count', async () => {
  const results = [true, false, true, false]
  const dead: string[] = []
  const wd = startLocoWatchdog(() => (results.shift() ? Promise.resolve() : never()), (why) => dead.push(why), { intervalMs: 3_600_000, timeoutMs: 20, maxFails: 2 }, quiet)
  for (let i = 0; i < 4; i++) await wd.tick()
  wd.stop()
  expect(dead).toEqual([])
})

test('watchdog never kills a process whose probe has not succeeded once', async () => {
  const dead: string[] = []
  const wd = startLocoWatchdog(never, (why) => dead.push(why), { intervalMs: 3_600_000, timeoutMs: 20, maxFails: 2 }, quiet)
  for (let i = 0; i < 4; i++) await wd.tick()
  wd.stop()
  expect(dead).toEqual([])
})

test('TroubleWindow: 3 timeouts within 30 min (alternating with successes) is a dead session; spread-out ones are not', () => {
  let now = 0
  const dead: string[] = []
  const w = new TroubleWindow({ windowMs: 30 * 60_000, maxInWindow: 3 }, (why) => dead.push(why), () => now)
  w.record('a'); now += 29 * 60_000; w.record('b'); now += 2 * 60_000; w.record('c')
  expect(dead).toEqual([])
  now += 5 * 60_000; w.record('d')
  expect(dead.length).toBe(1)
})
