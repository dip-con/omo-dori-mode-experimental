import { expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kakaoLogs } from './settings'


const SCRATCH = mkdtempSync(join(tmpdir(), 'kp-env-'))
process.env.REPLY_REFS_FILE = join(SCRATCH, 'reply-refs.json')
process.env.OWNER_FIX_FILE = join(SCRATCH, 'owner-fix.json')
process.env.WAKE_FILTER_LOG = join(SCRATCH, 'wake-filter.ndjson')
process.env.KKA_ARCHIVE_ROOT = join(SCRATCH, 'no-archive')
const P = await import('./kakao-push')
const { CrashError, Queue } = await import('./kakao-queue')
const { roomName } = await import('./kakao-lane-ext')
const { createWakeFilter } = await import('./kakao-wake-filter')

const FX = join(import.meta.dir, 'fixtures', 'kakao')
const FX_ROOMS: Record<string, any> = JSON.parse(readFileSync(join(FX, 'rooms.json'), 'utf8'))
const A = '18000000000000001', B = '480000000000001', PIN = '18000000000000003'
const LANE: Record<string, string> = { [A]: 'kakao-fx-a', [B]: 'kakao-fx-b', [PIN]: 'kakao-fx-p' }
let logSeq = 3946370721884362755n
const msg = (chat: string, text: string) => {
  const log = String(logSeq++)
  return { log, raw: `{"chat_id":${chat},"is_from_me":false,"log_id":${log},"message_type":1,"sender":"fx","sender_id":9007199254740993123,"text":${JSON.stringify(text)},"timestamp":"2026-10-23T08:00:00Z","type":"message"}` }
}

type Opts = { parallel?: boolean; decide?: (room: any, seen: any) => Promise<boolean>; rooms?: Record<string, any>; transport?: 'rpc' | 'herdr'; filter?: any }
function harness(o: Opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'kp-'))
  const log = join(home, 'live.ndjson')
  writeFileSync(log, '')
  if (o.parallel !== undefined) writeFileSync(join(home, 'kakao-queue.json'), JSON.stringify({ workers: { parallel: o.parallel } }))
  const rooms = o.rooms ?? FX_ROOMS
  const sessions = new Map<string, Set<string>>()
  const sent: { lane: string; id: string; body: string }[] = []
  const calls: string[] = []
  const refusing = new Set<string>()
  const h = {
    home, log, sent, calls, refusing, sessions, crashes: 0, now: 1_000_000, outs: [] as string[],
    crashPlan: [] as string[],
    uncertain: new Map<string, boolean>(),
    sender: {
      transportFor: () => o.transport ?? 'rpc',
      target: (lane: string) => ({ durableId: `d-${lane}`, sessionPath: `/fake/${lane}.jsonl` }),
      receipt: (path: string | null, id: string) => (sessions.get(path ?? '')?.has(id) ? 'persisted' as const : 'absent' as const),
      send: async (lane: string, body: string, id: string, transport: 'rpc' | 'herdr') => {
        calls.push(id)
        if (refusing.has(lane)) return { status: 'refused' as const, transport, reason: 'turn_conflict' }
        const path = `/fake/${lane}.jsonl`
        const s = sessions.get(path) ?? new Set<string>(); sessions.set(path, s)
        const u = h.uncertain.get(id)
        if (u !== undefined) h.uncertain.delete(id)
        if (u === false) return { status: 'uncertain' as const, transport, reason: 'no_receipt' }
        if (!s.has(id)) { s.add(id); sent.push({ lane, id, body }) }
        return u === true ? { status: 'uncertain' as const, transport, reason: 'no_receipt' } : { status: 'delivered' as const, transport }
      },
    },
    q: null as any, push: null as any,
    start() {
      h.q = Queue.open(join(home, 'kakao-queue.sqlite'), { crash: h.crash })
      h.push = P.createPush({
        home, log, rooms, queue: h.q, sender: h.sender, crash: h.crash, decide: o.decide ?? (async () => true), filter: o.filter,
        out: (l: string) => h.outs.push(l), trace: () => {}, decisionLog: join(home, 'wf.ndjson'), startAtEnd: false, notes: () => '',
      })
    },
    restart() { h.q.close(); h.start() },
    crash(point: string) { if (h.crashPlan[0] === point) { h.crashPlan.shift(); throw new CrashError(point) } },
    append(lines: string[]) { appendFileSync(log, lines.map((l) => l + '\n').join('')) },
    async step(dt = 3000) {
      h.now += dt
      try { await h.push.step(h.now); await h.push.idle() } catch (e) {
        if (!(e instanceof CrashError)) throw e
        h.crashes++; h.restart()
      }
    },
    busy() {
      return h.q.openBatches().length > 0 || h.q.newIntake().length > 0 || [...h.push.rooms.values()].some((s: any) => s.pending || Object.keys(s.bursts).length)
    },
    async drain(max = 400, dt = 3000) { let i = 0; do await h.step(dt); while (++i < max && h.busy()); expect(h.busy()).toBe(false) },
    delivered() {
      const out: Record<string, string[]> = {}
      for (const s of sent) (out[s.lane] ??= []).push(...JSON.parse(h.q.batch(s.id).members_json).logs)
      return out
    },
  }
  h.start()
  return h
}
const expectOnce = (h: ReturnType<typeof harness>) => {
  const ids = h.sent.map((s) => s.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(new Set(h.calls).size).toBe(h.calls.length)
}

test('(a) crash matrix: killed at each point, restarted: every log_id delivered exactly once in per-room order', async () => {
  const plans: string[][] = [['intake:inserted'], ['batch:inserted'], ['send:accepted'], ['send:accepted', 'receipt:found']]
  for (const plan of plans) {
    const h = harness()
    h.crashPlan = [...plan]
    const a1 = [msg(A, 'a1'), msg(A, 'a2'), msg(A, 'a3')], b1 = [msg(B, 'b1'), msg(B, 'b2')]
    h.append([a1[0]!.raw, b1[0]!.raw, a1[1]!.raw, a1[2]!.raw, b1[1]!.raw])
    await h.step(100)
    await h.step(3000)
    const a2 = [msg(A, 'a4'), msg(A, 'a5')], b2 = [msg(B, 'b3')]
    h.append([a2[0]!.raw, b2[0]!.raw, a2[1]!.raw])
    await h.drain()
    expect(h.crashes).toBe(plan.length)
    expect(h.delivered()).toEqual({ [LANE[A]!]: [...a1, ...a2].map((m) => m.log), [LANE[B]!]: [...b1, ...b2].map((m) => m.log) })
    expectOnce(h)
  }
})

test('(a) crash while a partial last line sits in live.ndjson', async () => {
  const h = harness()
  const m = [msg(A, 'p1'), msg(A, 'p2'), msg(A, 'p3')]
  h.append([m[0]!.raw])
  appendFileSync(h.log, m[1]!.raw.slice(0, 40))
  h.crashPlan = ['intake:inserted']
  await h.step(100)
  expect(h.crashes).toBe(1)
  await h.step(100)
  expect(h.q.newIntake().length + h.push.rooms.get(A)?.pending?.lines.length).toBe(1)
  appendFileSync(h.log, m[1]!.raw.slice(40) + '\n' + m[2]!.raw + '\n')
  await h.drain()
  expect(h.delivered()).toEqual({ [LANE[A]!]: m.map((x) => x.log) })
  expectOnce(h)
})

test('(a) crash right after live.ndjson is renamed and recreated, and right after it is truncated (kakao-loco replays its tail)', async () => {
  for (const kind of ['rename', 'truncate', 'rename-regrown', 'truncate-regrown'] as const) {
    const h = harness()
    const m = Array.from({ length: 8 }, (_, i) => msg(i % 2 ? B : A, `${kind}${i}`))
    h.append(m.slice(0, 4).map((x) => x.raw))
    await h.step(100)
    await h.step(3000)
    h.append(m.slice(4, 6).map((x) => x.raw))
    if (kind.startsWith('rename')) renameSync(h.log, `${h.log}.1`)
    writeFileSync(h.log, '')
    if (kind.endsWith('regrown')) h.append(m.slice(2, 8).map((x) => x.raw))
    h.restart()
    await h.step(100)
    if (!kind.endsWith('regrown')) h.append(m.slice(2, 8).map((x) => x.raw))
    await h.drain()
    expect(h.delivered()).toEqual({ [LANE[A]!]: m.filter((_, i) => i % 2 === 0).map((x) => x.log), [LANE[B]!]: m.filter((_, i) => i % 2).map((x) => x.log) })
    expectOnce(h)
  }
})

test('(b) a batch whose id is already persisted is not sent again: rpc uncertain retries look at the receipt first', async () => {
  const h = harness()
  const m = msg(A, 'once')
  h.append([m.raw])
  await h.step(100)
  const id = `kakao:${A}:1`
  h.uncertain.set(id, true)
  await h.drain()
  expect(h.calls).toEqual([id])
  expect(h.q.batch(id).state).toBe('persisted')
  expect(h.outs).toContain(`batch ${id} persisted (receipt)`)
})

test('rpc uncertain without a receipt retries with the same id after backoff; herdr uncertain is never typed again', async () => {
  const h = harness()
  h.append([msg(A, 'r').raw])
  await h.step(100)
  h.uncertain.set(`kakao:${A}:1`, false)
  await h.drain()
  expect(h.calls).toEqual([`kakao:${A}:1`, `kakao:${A}:1`])
  expect(h.sent.length).toBe(1)

  const g = harness({ transport: 'herdr' })
  g.append([msg(A, 'h').raw])
  await g.step(100)
  const id = `kakao:${A}:1`
  g.uncertain.set(id, false)
  for (let i = 0; i < 40; i++) await g.step(5000)
  expect(g.calls).toEqual([id])
  expect(g.q.batch(id).state).toBe('uncertain')
  g.sessions.set(`/fake/${LANE[A]}.jsonl`, new Set([id]))
  await g.drain()
  expect(g.calls).toEqual([id])
  expect(g.q.batch(id).state).toBe('persisted')
})

test('(c) workers.parallel=true: a lane-A refusal does not delay lane B; false: global order as today', async () => {
  const par = harness({ parallel: true })
  par.refusing.add(LANE[A]!)
  par.append([msg(A, 'a').raw, msg(B, 'b').raw])
  for (let i = 0; i < 4; i++) await par.step(3000)
  expect(par.sent.map((s) => s.lane)).toEqual([LANE[B]])
  par.refusing.clear()
  await par.drain(400, 10_000)
  expect(par.sent.map((s) => s.lane)).toEqual([LANE[B], LANE[A]])

  const ser = harness({ parallel: false })
  ser.refusing.add(LANE[A]!)
  ser.append([msg(A, 'a').raw, msg(B, 'b').raw])
  for (let i = 0; i < 8; i++) await ser.step(3000)
  expect(ser.sent).toEqual([])
  expect(ser.calls.every((c) => c === `kakao:${A}:1`)).toBe(true)
  ser.refusing.clear()
  await ser.drain(400, 10_000)
  expect(ser.sent.map((s) => s.lane)).toEqual([LANE[A], LANE[B]])
  expect(new Set(ser.sent.map((s) => s.id)).size).toBe(2)
})

test('(d) after restart cursor.log_offset <= offset of the first log line of any non-persisted batch', async () => {
  const h = harness()
  h.refusing.add(LANE[A]!)
  const m = [msg(B, 'x'), msg(A, 'first-a'), msg(A, 'second-a'), msg(B, 'y')]
  h.append(m.map((x) => x.raw))
  for (let i = 0; i < 4; i++) await h.step(3000)
  h.append([msg(B, 'z').raw])
  await h.step(3000)
  h.restart()
  const text = readFileSync(h.log, 'utf8')
  const firstA = Buffer.byteLength(text.slice(0, text.indexOf(m[1]!.raw)))
  expect(h.q.openBatches().map((b: any) => b.lane)).toEqual([LANE[A]])
  expect(h.q.cursor().offset).toBeLessThanOrEqual(firstA)
  h.refusing.clear()
  await h.drain(400, 10_000)
  expect(h.delivered()[LANE[A]!]).toEqual([m[1]!.log, m[2]!.log])
  await h.step(100)
  expect(h.q.cursor().offset).toBe(Buffer.byteLength(readFileSync(h.log, 'utf8')))
})

test('(e) 31 request lines -> 2 batches "[kakao-new 30개 (1/2)]" and "[kakao-new 1개 (2/2)]", all delivered in order', async () => {
  const h = harness()
  const m = Array.from({ length: 31 }, (_, i) => msg(A, `req ${i}`))
  h.append(m.map((x) => x.raw))
  await h.drain()
  expect(h.sent.map((s) => s.body.split('\n')[0])).toEqual(['[kakao-new 30개 (1/2)]', '[kakao-new 1개 (2/2)]'])
  expect(h.sent.map((s) => s.id)).toEqual([`kakao:${A}:1`, `kakao:${A}:2`])
  expect(h.delivered()[LANE[A]!]).toEqual(m.map((x) => x.log))
  expect(h.outs.some((l) => l.startsWith('kakao.split'))).toBe(true)
})

test('(f) 12 held context lines + 25 request lines -> context trimmed with "[문맥 N줄 생략]", all 25 delivered', async () => {
  let wake = false
  const f = harness({ decide: async () => wake })
  const ctx = Array.from({ length: 12 }, (_, i) => msg(A, `ctx ${i}`))
  f.append(ctx.map((x) => x.raw))
  await f.step(100)
  await f.step(3000)
  expect(f.push.rooms.get(A).held.length).toBe(12)
  expect(f.sent).toEqual([])
  wake = true
  const req = Array.from({ length: 25 }, (_, i) => msg(A, `req ${i}`))
  f.append(req.map((x) => x.raw))
  await f.drain()
  expect(f.sent.length).toBe(1)
  const lines = f.sent[0]!.body.split('\n')
  expect(lines[0]).toBe('[kakao-new 30개]')
  expect(lines[1]).toBe(P.CONTEXT_NOTE)
  expect(lines[2]).toBe('[문맥 7줄 생략]')
  expect(lines.slice(3, 8)).toEqual(ctx.slice(7).map((_, i) => `[문맥] fx: ctx ${i + 7}`))
  expect(lines.slice(8, 33)).toEqual(req.map((_, i) => `fx: req ${i}`))
  expect(JSON.parse(f.q.batch(f.sent[0]!.id).members_json)).toEqual({ logs: req.map((x) => x.log), context: ctx.slice(7).map((x) => x.log), omitted: 7 })
})

test('(g)(i) per-lane room files hold the exact chat id; A deliver -> B deliver -> a late A kakao_send still resolves A', async () => {
  const h = harness()
  h.append([msg(A, 'to a').raw])
  await h.drain()
  h.append([msg(B, 'to b').raw])
  await h.drain()
  const dir = join(h.home, 'sa-cache')
  expect(readFileSync(join(dir, `room.${LANE[A]}`), 'utf8')).toBe(A)
  expect(readFileSync(join(dir, `room.${LANE[B]}`), 'utf8')).toBe(B)
  expect(readFileSync(join(dir, 'active-room'), 'utf8')).toBe(FX_ROOMS[B].name)
  expect(roomName({ OMODORI_LANE_KEY: LANE[A] }, dir, FX_ROOMS)).toBe(FX_ROOMS[A].name)
  expect(roomName({}, dir, FX_ROOMS)).toBe(FX_ROOMS[B].name)
  h.append([msg(PIN, 'pinned').raw])
  await h.drain()
  expect(readFileSync(join(dir, 'active-room'), 'utf8')).toBe(FX_ROOMS[B].name)
  expect(h.sent.map((s) => s.id)).toEqual([`kakao:${A}:1`, `kakao:${B}:1`, `kakao:${PIN}:1`])
})

test('(k) a lane whose lease dir exists is not sent to; intake continues', async () => {
  const h = harness()
  const lease = join(h.home, 'lane-leases', LANE[A]!)
  mkdirSync(lease, { recursive: true })
  h.append([msg(A, 'one').raw, msg(B, 'other').raw])
  for (let i = 0; i < 5; i++) await h.step(3000)
  h.append([msg(A, 'two').raw])
  for (let i = 0; i < 5; i++) await h.step(3000)
  expect(h.sent.map((s) => s.lane)).toEqual([LANE[B]])
  expect(h.q.openBatches().map((b: any) => b.lane)).toEqual([LANE[A], LANE[A]])
  expect(h.calls.some((c) => c.startsWith(`kakao:${A}:`))).toBe(false)
  rmSync(lease, { recursive: true })
  await h.drain()
  expect(h.delivered()[LANE[A]!]?.length).toBe(2)
  expectOnce(h)
})

test('(l) a lane whose registry seed.state is pending is not sent to; pause flag stops every send', async () => {
  const h = harness()
  const map = join(h.home, 'sessions-map.json')
  writeFileSync(map, JSON.stringify({ [LANE[A]!]: { key: LANE[A], status: 'open', seed: { state: 'pending', id: 'seed:x:2' } } }))
  h.append([msg(A, 'one').raw])
  for (let i = 0; i < 5; i++) await h.step(3000)
  expect(h.calls).toEqual([])
  writeFileSync(map, JSON.stringify({ [LANE[A]!]: { key: LANE[A], status: 'open', seed: { state: 'applied', id: 'seed:x:2' } } }))
  mkdirSync(join(h.home, 'flags'), { recursive: true })
  writeFileSync(join(h.home, 'flags', 'kakao.pause-admission'), '')
  h.append([msg(B, 'two').raw])
  for (let i = 0; i < 5; i++) await h.step(3000)
  expect(h.calls).toEqual([])
  expect(h.q.openBatches().length).toBe(2)
  rmSync(join(h.home, 'flags', 'kakao.pause-admission'))
  await h.drain()
  expect(h.sent.map((s) => s.lane)).toEqual([LANE[A], LANE[B]])
})

test('replay of the real live.ndjson tail (copy, fake sender, Jev stubbed): crash at every point repeatedly == no-crash run', async () => {
  const src = `${kakaoLogs()}/live.ndjson`
  if (!existsSync(src)) { console.log('live.ndjson absent: replay skipped'); return }
  const tail = readFileSync(src, 'utf8').split('\n').filter((l) => l.trim()).slice(-400)
  const wf = createWakeFilter({ nicks: {} })
  const filter = { observe: wf.observe, decide: async () => ({ decision: 'wake', reason: 'test' }), triageGroup: async (obs: unknown[]) => obs.map(() => ({ kind: 'respond', via: 'gate' })) }
  const run = async (crashEvery: number) => {
    const h = harness({ rooms: P.ROOMS, filter, decide: async () => true })
    const points = ['intake:inserted', 'batch:inserted', 'send:accepted', 'receipt:found']
    let k = 0
    for (let i = 0; i < tail.length; i += 9) {
      if (crashEvery && (i / 9) % crashEvery === 0) h.crashPlan = [points[k++ % points.length]!]
      h.append(tail.slice(i, i + 9))
      await h.step(4000)
    }
    h.crashPlan = []
    await h.drain(400, 20_000)
    expectOnce(h)
    return { delivered: h.delivered(), crashes: h.crashes, intake: h.q.db.query('SELECT count(*) AS n FROM intake').get().n }
  }
  const base = await run(0)
  const crashed = await run(3)
  expect(crashed.crashes).toBeGreaterThan(3)
  expect(crashed.intake).toBe(base.intake)
  // The docs room groups lines into per-sender bursts whose flush time a restart shifts, so only its set is fixed.
  const norm = (d: Record<string, string[]>) => Object.fromEntries(Object.entries(d).map(([lane, logs]) => [lane, lane === 'kakao-docs' ? [...logs].sort() : logs]))
  expect(norm(crashed.delivered)).toEqual(norm(base.delivered))
  expect(Object.values(base.delivered).flat().length).toBeGreaterThan(0)
}, 60_000)
