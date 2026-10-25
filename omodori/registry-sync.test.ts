import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMap } from './registry'
import { argvSession, reconcile, type SyncDeps } from './registry-sync'

const ROOT = process.env.OMOCAT_HOME ?? mkdtempSync(join(tmpdir(), 'omocat-s3-sync-'))
let n = 0
const home = () => { const d = join(ROOT, `sync${++n}-${process.pid}`); mkdirSync(d, { recursive: true }); return d }
const AGENT_ARGV = (id?: string) => ['/x/bun.exe', '/x/@code-yeongyu/senpi/dist/bundle/cli.js', '--extension', '/x/plugin', ...(id ? ['--session', id] : [])]
const lane = (key: string, extra: Record<string, unknown> = {}) => ({
  key, label: key, cwd: '/tmp/x', thread: null, workspace: 'w1', tab: 'w1:t1', pane: `w1:${key}`, sessionId: 'map-id', status: 'open', openedAt: 'now', generation: 2, ...extra,
})
const seed = (h: string, m: Record<string, unknown>) => writeFileSync(join(h, 'sessions-map.json'), JSON.stringify(m, null, 2))
const events = (h: string) => existsSync(join(h, 'events', 'registry.ndjson'))
  ? readFileSync(join(h, 'events', 'registry.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

const deps = (h: string, over: Partial<SyncDeps> = {}): SyncDeps => ({
  home: h, doriLanesDir: join(h, 'dori-lanes'),
  paneProcs: async () => [{ pid: 4242, argv: AGENT_ARGV('argv-id') }],
  endpoints: async () => [], listSessions: async () => null,
  findSession: (id) => `/s/2026_${id}.jsonl`, startTimeIds: async () => [], accountOf: () => undefined,
  ...over,
})

test('argv id != map id: drift 1; --write rebinds, keeps the generation, appends the old id to lineage.sessions, mirrors the dori lane', async () => {
  const h = home()
  seed(h, { a: lane('a'), lead: lane('dandori-lead-1', { key: 'dandori-lead-1' }) })
  mkdirSync(join(h, 'dori-lanes'), { recursive: true })
  writeFileSync(join(h, 'dori-lanes', 'a.json'), JSON.stringify({ key: 'a', session: 'map-id' }))
  const dry = await reconcile(deps(h), { write: false })
  expect(dry).toEqual({ drift: 1, lines: ['DRIFT a pane=w1:a map=map-id live=argv-id via=reconcile-argv'] })
  expect(readMap(h).a!.sessionId).toBe('map-id')
  const wrote = await reconcile(deps(h), { write: true })
  expect(wrote.lines[1]).toBe('REGISTRY_RECONCILED a map-id -> argv-id via=reconcile-argv')
  const e = readMap(h).a!
  expect([e.sessionId, e.sessionVia, e.sessionPath, e.generation, e.lineage?.sessions]).toEqual(['argv-id', 'reconcile-argv', '/s/2026_argv-id.jsonl', 2, ['map-id']])
  expect(JSON.parse(readFileSync(join(h, 'dori-lanes', 'a.json'), 'utf8')).session).toBe('argv-id')
  expect(events(h).map((x) => [x.kind, x.lane, x.from, x.to])).toEqual([['registry.reconciled', 'a', 'map-id', 'argv-id']])
  expect((await reconcile(deps(h), { write: true })).drift).toBe(0)
  expect(events(h).length).toBe(1)
})

test('the endpoint answer wins over a stale argv (in-process session replacement): no drift, only the cache is filled', async () => {
  const h = home()
  seed(h, { a: lane('a') })
  const d = deps(h, {
    endpoints: async () => [{ pid: 4242, socket: '/rpc/tui/t-1.sock', instanceId: 'inst-1', kind: 'tui' }],
    listSessions: async () => ['map-id'],
    accountOf: () => 'alt',
  })
  expect(await reconcile(d, { write: false })).toEqual({ drift: 0, lines: [] })
  expect(await reconcile(d, { write: true })).toEqual({ drift: 0, lines: [] })
  const e = readMap(h).a!
  expect([e.sessionId, e.sessionPath, e.endpoint?.socket, e.endpoint?.instanceId, e.account, e.generation]).toEqual(['map-id', '/s/2026_map-id.jsonl', '/rpc/tui/t-1.sock', 'inst-1', 'alt', 2])
  const raw = readFileSync(join(h, 'sessions-map.json'), 'utf8')
  await reconcile(d, { write: true })
  expect(readFileSync(join(h, 'sessions-map.json'), 'utf8')).toBe(raw)
  expect(events(h)).toEqual([])
})

test('an endpoint that answers another single id rebinds with via=reconcile-endpoint', async () => {
  const h = home()
  seed(h, { a: lane('a') })
  const d = deps(h, { endpoints: async () => [{ pid: 4242, socket: '/rpc/tui/t-2.sock', instanceId: 'i2', kind: 'tui' }], listSessions: async () => ['ep-id'] })
  expect((await reconcile(d, { write: true })).lines[0]).toBe('DRIFT a pane=w1:a map=map-id live=ep-id via=reconcile-endpoint')
  expect([readMap(h).a!.sessionId, readMap(h).a!.endpoint?.socket]).toEqual(['ep-id', '/rpc/tui/t-2.sock'])
})

test('start-time-only evidence is reported and never written', async () => {
  const h = home()
  seed(h, { a: lane('a') })
  const before = readFileSync(join(h, 'sessions-map.json'), 'utf8')
  const d = deps(h, { paneProcs: async () => [{ pid: 4242, argv: AGENT_ARGV() }], startTimeIds: async () => ['guess-id'] })
  const r = await reconcile(d, { write: true })
  expect(r).toEqual({ drift: 0, lines: ['UNCONFIRMED a pane=w1:a map=map-id start-time=guess-id (report only, no write)'] })
  expect(readFileSync(join(h, 'sessions-map.json'), 'utf8')).toBe(before)
})

test('a lane inside a lifecycle lease, a closed lane and a gone pane are left alone', async () => {
  const h = home()
  seed(h, { a: lane('a'), b: lane('b', { status: 'closed' }), c: lane('c') })
  mkdirSync(join(h, 'lane-leases', 'a'), { recursive: true })
  const d = deps(h, { paneProcs: async (pane) => (pane === 'w1:c' ? null : [{ pid: 1, argv: AGENT_ARGV('argv-id') }]) })
  expect(await reconcile(d, { write: true })).toEqual({ drift: 0, lines: [] })
  expect(Object.values(readMap(h)).map((e) => e.sessionId)).toEqual(['map-id', 'map-id', 'map-id'])
})

test('argvSession: --session <jsonl path> (resume after omo update) yields the durable id, not the path', () => {
  const id = '617e402e-ad2a-4be4-a618-93eef9c136b0'
  expect(argvSession(['omo', '--session', `/u/.omo/agent/sessions/--x--/2026-10-24T12-20-29-047Z_${id}.jsonl`])).toBe(id)
  expect(argvSession(['omo', '--session-id', id])).toBe(id)
})
