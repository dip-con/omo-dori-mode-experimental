import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvent, bootAtMs, patchLane, processStartMs, readMap, RegistryError, updateDoriLane, withLaneLease } from './registry'
import { closeLane, type LifecycleDeps, reopenLane } from './sess'

const ROOT = process.env.OMODORI_HOME ?? mkdtempSync(join(tmpdir(), 'omodori-s3-'))
const DORI_REGISTRY = `${process.env.HOME}/.dori/src/skills/dori-mode/scripts/src/registry.ts`
let n = 0
const home = () => { const d = join(ROOT, `t${++n}-${process.pid}`); mkdirSync(d, { recursive: true }); return d }
const children: { kill: () => void }[] = []
afterAll(() => { for (const c of children) c.kill() })

const alive = async () => {
  const p = Bun.spawn(['sleep', '300'])
  children.push(p)
  let start: number | undefined
  for (let i = 0; i < 20 && start === undefined; i++) start = await processStartMs(p.pid)
  return { pid: p.pid, start: start! }
}
const deadPid = async () => { const p = Bun.spawn(['true']); await p.exited; return p.pid }
const seedMap = (h: string, m: Record<string, unknown>) => writeFileSync(join(h, 'sessions-map.json'), JSON.stringify(m, null, 2))
const entry = (key: string, extra: Record<string, unknown> = {}) => ({
  key, label: key, cwd: '/tmp/x', thread: null, workspace: 'w1', tab: 'w1:t1', pane: 'w1:p1', sessionId: 'sess-old', status: 'closed', openedAt: '2026-10-23T00:00:00Z', ...extra,
})
const lockOwner = (dir: string, owner: Record<string, unknown>) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'owner.json'), JSON.stringify(owner)) }
const events = (h: string) => existsSync(join(h, 'events', 'registry.ndjson'))
  ? readFileSync(join(h, 'events', 'registry.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

test('patchLane(keyA) and patchLane(keyB) on one Promise barrier both land; so do two processes patching 30 keys each', async () => {
  const h = home()
  seedMap(h, { keep: entry('keep') })
  let open!: () => void
  const barrier = new Promise<void>((r) => { open = r })
  const a = barrier.then(() => patchLane('keyA', undefined, { label: 'A' }, { home: h }))
  const b = barrier.then(() => patchLane('keyB', undefined, { label: 'B' }, { home: h }))
  open()
  await Promise.all([a, b])
  expect(Object.keys(readMap(h)).sort()).toEqual(['keep', 'keyA', 'keyB'])
  const src = join(import.meta.dir, 'registry.ts')
  const writer = (tag: string) => Bun.spawn(['bun', '-e', `import { patchLane } from ${JSON.stringify(src)}; for (let i = 0; i < 30; i++) await patchLane('${tag}-' + i, undefined, { label: '${tag}' }, { home: ${JSON.stringify(h)} })`], { stdout: 'inherit', stderr: 'inherit' })
  expect(await Promise.all([writer('p').exited, writer('q').exited])).toEqual([0, 0])
  expect(Object.keys(readMap(h)).length).toBe(63)
  expect(existsSync(join(h, 'sessions-map.lock'))).toBe(false)
}, 60_000)

test('patchLane with a stale expectGeneration refuses with generation_conflict and leaves the file byte-identical', async () => {
  const h = home()
  seedMap(h, { a: entry('a', { generation: 3 }) })
  const before = readFileSync(join(h, 'sessions-map.json'), 'utf8')
  const err = await patchLane('a', 2, { label: 'x' }, { home: h }).catch((e) => e)
  expect(err).toBeInstanceOf(RegistryError)
  expect(err.code).toBe('generation_conflict')
  expect(readFileSync(join(h, 'sessions-map.json'), 'utf8')).toBe(before)
  expect(events(h).map((e) => e.kind)).toEqual(['registry.generation_conflict'])
  await patchLane('a', 3, { generation: 4 }, { home: h })
  expect(readMap(h).a!.generation).toBe(4)
})

test('a map lock of a dead pid, or of a live pid with another start time (pid reuse), is reclaimed', async () => {
  const h = home()
  seedMap(h, { a: entry('a') })
  lockOwner(join(h, 'sessions-map.lock'), { pid: await deadPid(), bootAtMs: bootAtMs(), processStartedAtMs: Date.now() - 1000 })
  await patchLane('a', undefined, { label: 'after-dead' }, { home: h, waitMs: 2000 })
  const live = await alive()
  lockOwner(join(h, 'sessions-map.lock'), { pid: live.pid, bootAtMs: bootAtMs(), processStartedAtMs: live.start - 3_600_000 })
  await patchLane('a', undefined, { label: 'after-reuse' }, { home: h, waitMs: 2000 })
  expect(readMap(h).a!.label).toBe('after-reuse')
  expect(existsSync(join(h, 'sessions-map.lock'))).toBe(false)
})

test('a map lock whose pid is alive is never reclaimed: the writer gets lock_wait after 30 s', async () => {
  const h = home()
  seedMap(h, { a: entry('a') })
  const live = await alive()
  lockOwner(join(h, 'sessions-map.lock'), { pid: live.pid, bootAtMs: bootAtMs(), processStartedAtMs: live.start })
  const t0 = Date.now()
  const err = await patchLane('a', undefined, { label: 'never' }, { home: h }).catch((e) => e)
  expect(err.code).toBe('lock_wait')
  expect(Date.now() - t0).toBeGreaterThanOrEqual(30_000)
  expect(JSON.parse(readFileSync(join(h, 'sessions-map.lock', 'owner.json'), 'utf8')).pid).toBe(live.pid)
  expect(readMap(h).a!.label).toBe('a')
}, 45_000)

test('withLaneLease taken twice concurrently: the second gets lease_held at once; the lease dir is 0700 and empty afterwards', async () => {
  const h = home()
  seedMap(h, { a: entry('a') })
  let release!: () => void
  let entered!: () => void
  const inside = new Promise<void>((r) => { entered = r })
  const first = withLaneLease('a', 'reopen', () => new Promise<void>((r) => { release = r; entered() }), { home: h })
  await inside
  const t0 = Date.now()
  const err = await withLaneLease('a', 'close', () => 'ran', { home: h }).catch((e) => e)
  expect(err.code).toBe('lease_held')
  expect(err.message).toBe(`lease_held ${process.pid} reopen`)
  expect(Date.now() - t0).toBeLessThan(1000)
  release()
  await first
  expect(existsSync(join(h, 'lane-leases', 'a'))).toBe(false)
  expect(statSync(join(h, 'lane-leases')).mode & 0o777).toBe(0o700)
}, 10_000)

const sessionsFixture = (h: string, id: string) => {
  const dir = join(h, 'sessions', '--tmp-x--')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `2026-10-23T00-00-00-000Z_${id}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'session', id })}\n`)
  return file
}
const holder = (file: string, id: string, rec: { pid: number; processStartedAtMs: number }) => {
  const dir = join(file, '..', 'session-holders', encodeURIComponent(id))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${rec.pid}.json`), JSON.stringify({ pid: rec.pid, bootAtMs: bootAtMs(), processStartedAtMs: rec.processStartedAtMs, cwd: '/tmp/x' }))
}
const fake = (h: string, file: string | null, over: Partial<LifecycleDeps> = {}) => {
  const calls: string[][] = []
  const logs: string[] = []
  const deps: LifecycleDeps = {
    home: h,
    herdr: async (...a: string[]) => { calls.push(a); return a[0] === 'tab' && a[1] === 'create' ? { result: { tab: { tab_id: 'w9:t9' }, root_pane: { pane_id: 'w9:p9' } } } : null },
    workspaceFor: async () => 'w9', startOmo: async (pane, id) => { calls.push(['startOmo', pane, id]) }, panePids: async () => [],
    findSession: () => file, doriLane: async () => {}, closeDoriLane: async () => {}, send: async () => {}, log: (l) => logs.push(l), newId: () => 'sess-new',
    ...over,
  }
  return { deps, calls, logs }
}

test('close inside the lease with expected.tab != entry.tab is refused tab_moved and never calls herdr', async () => {
  const h = home()
  seedMap(h, { a: entry('a', { status: 'open', tab: 'w1:t2', generation: 5 }) })
  const { deps, calls } = fake(h, null)
  const r = await closeLane(deps, 'a', { tab: 'w1:t1' })
  expect(r.exit).toBe(4)
  expect((r.out as any).error).toBe('tab_moved')
  expect(calls).toEqual([])
  expect(readMap(h).a!.status).toBe('open')
  const ok = await closeLane(deps, 'a', { tab: 'w1:t2' })
  expect(ok.exit).toBe(0)
  expect(calls).toEqual([['tab', 'close', 'w1:t2']])
  expect([readMap(h).a!.status, readMap(h).a!.generation]).toEqual(['closed', 6])
})

test('reopen with a live holder (runtime record format) exits 6 held_elsewhere and starts nothing', async () => {
  const h = home()
  seedMap(h, { a: entry('a') })
  const file = sessionsFixture(h, 'sess-old')
  const live = await alive()
  holder(file, 'sess-old', { pid: live.pid, processStartedAtMs: live.start })
  const { deps, calls } = fake(h, file)
  const r = await reopenLane(deps, { key: 'a', text: '', fresh: false, noClaim: true })
  expect(r.exit).toBe(6)
  expect((r.out as any).error).toBe('held_elsewhere')
  expect((r.out as any).holders).toEqual([live.pid])
  expect(calls).toEqual([])
  expect(readMap(h).a!.status).toBe('closed')
})

test('reopen with the same holder record but a dead pid (or a reused pid) proceeds and bumps the generation', async () => {
  const h = home()
  seedMap(h, { a: entry('a', { generation: 2, endpoint: { kind: 'tui', socket: '/old.sock', instanceId: 'old', seenAt: 'then' } }) })
  const file = sessionsFixture(h, 'sess-old')
  holder(file, 'sess-old', { pid: await deadPid(), processStartedAtMs: Date.now() - 5000 })
  const live = await alive()
  holder(file, 'sess-old', { pid: live.pid, processStartedAtMs: live.start - 3_600_000 })
  const { deps, calls } = fake(h, file)
  const r = await reopenLane(deps, { key: 'a', text: '', fresh: false, noClaim: true })
  expect(r.exit).toBe(0)
  expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['tab create', 'startOmo w9:p9'])
  const e = readMap(h).a!
  expect([e.status, e.tab, e.pane, e.sessionId, e.generation, e.endpoint]).toEqual(['open', 'w9:t9', 'w9:p9', 'sess-old', 3, undefined])
  expect(events(h)).toEqual([])
})

test('a foreign live holder appearing after start raises lane.holder_conflict exactly once', async () => {
  const h = home()
  seedMap(h, { a: entry('a') })
  const file = sessionsFixture(h, 'sess-old')
  const foreign = await alive()
  const { deps, logs } = fake(h, file, {
    startOmo: async () => holder(file, 'sess-old', { pid: foreign.pid, processStartedAtMs: foreign.start }),
    panePids: async () => [process.pid],
  })
  const r = await reopenLane(deps, { key: 'a', text: '', fresh: false, noClaim: true })
  expect(r.exit).toBe(0)
  const conflicts = events(h).filter((e) => e.kind === 'lane.holder_conflict')
  expect(conflicts.length).toBe(1)
  expect(conflicts[0].holders).toEqual([foreign.pid])
  expect(logs.filter((l) => l.startsWith('LANE_HOLDER_CONFLICT')).length).toBe(1)
  expect(appendEvent({ id: conflicts[0].id, kind: 'lane.holder_conflict' }, h)).toBe(false)
  expect(events(h).filter((e) => e.kind === 'lane.holder_conflict').length).toBe(1)
})

test('OMODORI_FRESH reopen takes a new id, skips the holder check and records the old id in lineage.sessions', async () => {
  const h = home()
  seedMap(h, { a: entry('a') })
  const file = sessionsFixture(h, 'sess-old')
  const live = await alive()
  holder(file, 'sess-old', { pid: live.pid, processStartedAtMs: live.start })
  const { deps } = fake(h, file)
  const r = await reopenLane(deps, { key: 'a', text: '', fresh: true, noClaim: true })
  expect(r.exit).toBe(0)
  expect([readMap(h).a!.sessionId, readMap(h).a!.lineage?.sessions]).toEqual(['sess-new', ['sess-old']])
})

test.skipIf(!existsSync(DORI_REGISTRY))('cross-repo: omodori updateDoriLane and dori Registry.update on one lanes/<key>.json keep both fields', async () => {
  const h = home()
  const state = join(h, 'dori-state')
  const lanes = join(state, 'lanes')
  mkdirSync(lanes, { recursive: true })
  writeFileSync(join(lanes, 'xrepo.json'), JSON.stringify({ key: 'xrepo', title: 'x', thread: 'none', brief: 'b', done: 'd', openedAt: 'now' }))
  const src = join(import.meta.dir, 'registry.ts')
  const omodori = Bun.spawn(['bun', '-e', `import { updateDoriLane } from ${JSON.stringify(src)}; for (let i = 0; i < 40; i++) await updateDoriLane('xrepo', (c) => ({ ...c, session: String(Number(c?.session ?? 0) + 1) }), { dir: ${JSON.stringify(lanes)} })`], { stdout: 'inherit', stderr: 'inherit' })
  const dori = Bun.spawn(['bun', '-e', `import { Registry } from ${JSON.stringify(DORI_REGISTRY)}; const r = new Registry(${JSON.stringify(state)}); for (let i = 0; i < 40; i++) await r.update('xrepo', (c) => ({ ...c, lastNudgeAt: (c?.lastNudgeAt ?? 0) + 1 }))`], { stdout: 'inherit', stderr: 'inherit' })
  expect(await Promise.all([omodori.exited, dori.exited])).toEqual([0, 0])
  const got = JSON.parse(readFileSync(join(lanes, 'xrepo.json'), 'utf8'))
  expect([got.session, got.lastNudgeAt]).toEqual(['40', 40])
  expect(await updateDoriLane('xrepo', () => null, { dir: lanes })).toEqual(got)
}, 60_000)

test('rollback-fields strips only the named keys under the lock; unlock --if-dead refuses a live lock', async () => {
  const h = home()
  seedMap(h, { a: entry('a', { generation: 4, lineage: { sessions: ['x'] }, endpoint: { socket: 's' } }), b: entry('b', { generation: 1 }) })
  const cli = (...args: string[]) => Bun.spawn(['bun', join(import.meta.dir, 'registry.ts'), ...args], { env: { ...process.env, OMODORI_HOME: h }, stdout: 'pipe' })
  const p = cli('rollback-fields', '--fields', 'generation,lineage,endpoint')
  expect(await p.exited).toBe(0)
  const m = readMap(h)
  expect(Object.keys(m.a!).sort()).toEqual(Object.keys(entry('a')).sort())
  expect(m.b!.generation).toBeUndefined()
  const live = await alive()
  lockOwner(join(h, 'sessions-map.lock'), { pid: live.pid, bootAtMs: bootAtMs(), processStartedAtMs: live.start })
  expect(await cli('unlock', '--if-dead').exited).toBe(4)
  expect(existsSync(join(h, 'sessions-map.lock'))).toBe(true)
  lockOwner(join(h, 'sessions-map.lock'), { pid: await deadPid(), bootAtMs: bootAtMs(), processStartedAtMs: 0 })
  expect(await cli('unlock', '--if-dead').exited).toBe(0)
  expect(existsSync(join(h, 'sessions-map.lock'))).toBe(false)
}, 20_000)
