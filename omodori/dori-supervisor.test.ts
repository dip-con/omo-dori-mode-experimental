// OMOCAT_HOME=$(mktemp -d) bun test dori-supervisor.test.ts
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DAG_STALE_MS, GONE_MISS_GAP_MS, OpsLedger, Policies, RESTART_STORM_MAX, RESTART_STORM_WINDOW_MS, Supervisor, WATCHDOG_ALERT_MS,
  WATCHDOG_STALL_MS, Watchdog, adoptReplacement, policyPaths, readTaskRecords, settleLateReceipts, supPaths,
  type AdoptCtx, type PolicyDeps, type SupDeps, type TaskRec,
} from './dori-supervisor'
import { accountHeadroom, openToolCall, pickAccount, stallDetail, switchBackStep, windowHeadroom } from './policy-lib'
import { paths as regPaths, readMap } from './registry'
import type { DagFile, Endpoint, Link, OpenResult } from './supervisor-sources'
import { receipt } from './rpc'

const FIX = join(import.meta.dir, 'fixtures', 'supervisor')
const load = (f: string) => readFileSync(join(FIX, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const recorded = load('rpc-smoke-turn.recorded.ndjson')
const SNAPSHOT: any[] = recorded[0].data.snapshot
const FEED_CURSOR: number = recorded[1].data.cursor
const EPOCH_BEFORE: number = recorded[2].data.turn_epoch
const EPOCH_AFTER: number = recorded[recorded.length - 1].data.turn_epoch
const LIVE: any[] = recorded.filter((r) => r.type !== 'response')
const LANE_ID: string = SNAPSHOT[0].durableSessionId
const TUI = '/fixture/rpc/tui/t-smoke.sock'
const HOST = '/fixture/rpc/rpc.sock'
const INST = 'inst-A'

type HostSpec = {
  kind: 'tui' | 'rpc_host'; state: 'up' | 'dead' | 'unreachable'; instanceId: string; snapshot: any[]; epoch: number; cursor?: number; replayOnSubscribe?: any[]
  /** Extra fields of the subscribe_sessions answer (e.g. a host reporting include_workers:false). */
  subscribeExtra?: Record<string, unknown>
}
const allSubscribeRequests: any[] = []

class MockLink implements Link {
  requests: any[] = []
  private ev: ((r: any) => void)[] = []
  private cl: ((w: string) => void)[] = []
  closed = false
  constructor(readonly spec: HostSpec) {}
  request(cmd: Record<string, unknown>): Promise<any> {
    this.requests.push(cmd)
    if (cmd.type === 'subscribe_sessions') allSubscribeRequests.push(cmd)
    const ok = (data: unknown) => Promise.resolve({ type: 'response', command: cmd.type, success: true, data })
    switch (cmd.type) {
      case 'get_protocol_info': return ok({ instanceId: this.spec.instanceId, generation: 0, endpoint_kind: this.spec.kind, protocolVersion: 1 })
      case 'subscribe_sessions': return ok({ subscriptionId: `sub-${this.requests.length}`, seq: 0, snapshot: structuredClone(this.spec.snapshot), ...this.spec.subscribeExtra })
      case 'unsubscribe_sessions': return ok({})
      case 'subscribe': {
        for (const r of this.spec.replayOnSubscribe ?? []) this.push(r)
        return ok({ cursor: this.spec.cursor ?? 0 })
      }
      case 'get_state': return ok({ turn_epoch: this.spec.epoch, isStreaming: false, blocking_question: false, editor_has_draft: false })
      default: return ok({})
    }
  }
  onEvent(fn: (r: any) => void) { this.ev.push(fn) }
  onClose(fn: (w: string) => void) { this.cl.push(fn) }
  close() { this.closed = true }
  push(rec: any) { for (const f of this.ev) f(structuredClone(rec)) }
  drop(why = 'closed') { this.closed = true; for (const f of this.cl) f(why) }
}

function world(home: string, specs: Record<string, HostSpec>, opts: { panes?: string[]; endpointCache?: string } = {}) {
  const clock = { t: Date.parse('2026-10-23T08:00:00Z') }
  const dags = new Map<string, DagFile>()
  const tasks: TaskRec[] = []
  const links: Record<string, MockLink[]> = {}
  const registry = { endpoints: Object.entries(specs).map(([socket, s]) => ({ socket, kind: s.kind } as Endpoint)) }
  const map = {
    'rpc-smoke': {
      key: 'rpc-smoke', label: 'rpc-smoke', cwd: '/tmp/omocat/rpc-smoke', thread: null, workspace: 'w21', tab: 'w21:t4', pane: 'w21:p4',
      sessionId: LANE_ID, status: 'open', openedAt: '2026-10-23T07:07:47.150Z', generation: 4,
      ...(opts.endpointCache ? { endpoint: { kind: 'tui', socket: opts.endpointCache, instanceId: INST, seenAt: '' } } : {}),
    },
    'dandori-lead-x': { key: 'dandori-lead-x', sessionId: 'lead-id', status: 'open', pane: 'wW:p6' },
  } as any
  const deps: SupDeps = {
    home, now: () => clock.t,
    openLink: async (socket): Promise<OpenResult> => {
      const s = specs[socket]
      if (!s || s.state === 'dead') return { ok: false, state: 'dead', code: 'ENOENT' }
      if (s.state === 'unreachable') return { ok: false, state: 'unreachable', code: 'connect_timeout' }
      const l = new MockLink(s)
      ;(links[socket] ??= []).push(l)
      return { ok: true, link: l }
    },
    scanEndpoints: () => registry.endpoints,
    hostStatus: async () => null,
    panesAlive: async () => new Set(opts.panes ?? []),
    dagRuns: () => new Map(dags),
    taskRecords: () => tasks.map((t) => ({ ...t })),
    loadMap: () => map,
    connectTimeoutMs: 100, requestTimeoutMs: 100, write: true, log: () => {},
  }
  return { deps, clock, links, registry, specs, dags, tasks, last: (s: string) => links[s]![links[s]!.length - 1]! }
}

const tuiSpec = (over: Partial<HostSpec> = {}): HostSpec => ({ kind: 'tui', state: 'up', instanceId: INST, snapshot: SNAPSHOT, epoch: EPOCH_BEFORE, cursor: FEED_CURSOR, ...over })
const fileEvents = (home: string) => (existsSync(supPaths(home).events) ? readFileSync(supPaths(home).events, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const kinds = (home: string, kind: string) => fileEvents(home).filter((e) => e.kind === kind)

const base = process.env.OMOCAT_HOME ?? mkdtempSync(join(tmpdir(), 'sup-test-'))
let n = 0
let home = ''
beforeEach(() => { home = join(base, `case-${++n}`); mkdirSync(home, { recursive: true }) })
afterAll(() => { if (!process.env.OMOCAT_HOME) rmSync(base, { recursive: true, force: true }) })

async function replay(sup: Supervisor, link: MockLink, records: any[], epochAfterIdle?: number) {
  for (const r of records) {
    if (epochAfterIdle !== undefined && r.type === 'session_status' && r.status === 'idle') link.spec.epoch = epochAfterIdle
    link.push(r)
    await sup.flush()
  }
}

describe('turn_done from recorded session_status sequences', () => {
  test('running -> idle emits lane.turn_done exactly once with id lane.turn_done:<durableId>:<instanceId>:<epoch>', async () => {
    const w = world(home, { [TUI]: tuiSpec() }, { panes: ['w21:p4'] })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    expect(kinds(home, 'lane.turn_done')).toHaveLength(0)
    const link = w.last(TUI)
    await replay(sup, link, LIVE, EPOCH_AFTER)
    await replay(sup, link, LIVE.filter((r) => r.type === 'session_status' && r.status === 'idle'))
    await sup.rescan()
    const done = kinds(home, 'lane.turn_done')
    expect(done).toHaveLength(1)
    expect(done[0].id).toBe(`lane.turn_done:${LANE_ID}:${INST}:${EPOCH_AFTER}`)
    expect(done[0].lane).toBe('rpc-smoke')
    expect(done[0].data.turn_epoch).toBe(EPOCH_AFTER)
    expect(done[0].v).toBe(2)
  })

  test('idle with children.running > 0 emits nothing; the child finishing settles the lane once', async () => {
    const w = world(home, { [TUI]: tuiSpec(), [HOST]: { kind: 'rpc_host', state: 'up', instanceId: 'host-1', snapshot: [], epoch: 0 } }, { panes: ['w21:p4'] })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    const [laneRunning, childRunning, laneIdle, completion, childIdle] = load('child-running.ndjson')
    const tui = w.last(TUI), host = w.last(HOST)
    await replay(sup, tui, [laneRunning])
    await replay(sup, host, [childRunning])
    await replay(sup, tui, [laneIdle, completion], EPOCH_AFTER)
    expect(sup.children(sup.lanes.get('rpc-smoke')!).running).toBe(1)
    expect(kinds(home, 'lane.turn_done')).toHaveLength(0)
    await replay(sup, host, [childIdle])
    expect(kinds(home, 'lane.turn_done')).toHaveLength(1)
  })
})

describe('children (S5)', () => {
  const child = (id: string, status: string, ctx: Record<string, unknown>, kind = 'worker') => ({
    sessionId: `route-${id}`, durableSessionId: id, status, kind, cwd: '/tmp/omocat/rpc-smoke', context: ctx,
  })
  const hostWith = (snapshot: any[], over: Partial<HostSpec> = {}): HostSpec => ({ kind: 'rpc_host', state: 'up', instanceId: 'host-1', snapshot, epoch: 0, ...over })
  const laneOf = (sup: Supervisor) => (sup.snapshot() as any).lanes['rpc-smoke']
  const task = (id: string, status: string, over: Partial<TaskRec> = {}): TaskRec => ({ id, status, parent: LANE_ID, root: LANE_ID, childSessionId: null, updatedAt: '2026-10-23T08:00:00Z', ...over })

  test('session_status rows grouped per lane by context.parent_session_id / root_session_id into running/done/failed', async () => {
    const rows = [
      child('c-run', 'running', { parent_session_id: LANE_ID, root_session_id: LANE_ID, task_id: 'st_a' }),
      child('c-idle', 'idle', { root_session_id: LANE_ID }),
      child('c-closed', 'closed', { parent_session_id: LANE_ID }),
      child('c-err', 'error', { parent_session_id: LANE_ID }),
      child('other', 'running', { parent_session_id: 'some-other-session' }),
    ]
    const w = world(home, { [TUI]: tuiSpec(), [HOST]: hostWith(rows) })
    w.tasks.push(task('st_a', 'running'))                 // the same child as c-run: not counted twice
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    const l = laneOf(sup)
    expect(l.children).toEqual({ state: 'known', running: 1, done: 2, failed: 1, dagRuns: [] })
    expect(l.childrenIds.sort()).toEqual(['c-closed', 'c-err', 'c-idle', 'c-run'])
    expect(l.status).toBe('idle')
    expect(l.settled).toBe(false)
    expect((sup.snapshot() as any).unmanaged).toEqual([])
  })

  test('worker rows count only because include_workers was sent; a host reporting workers hidden -> unknown', async () => {
    const shown = world(home, { [TUI]: tuiSpec(), [HOST]: hostWith([child('c-run', 'running', { parent_session_id: LANE_ID })]) })
    const a = new Supervisor(shown.deps)
    await a.rescan()
    expect(laneOf(a).children).toMatchObject({ state: 'known', running: 1 })
    expect(shown.last(HOST).requests.find((r) => r.type === 'subscribe_sessions')).toMatchObject({ include_workers: true })

    home = join(base, `case-${++n}`); mkdirSync(home, { recursive: true })
    const hidden = world(home, { [TUI]: tuiSpec(), [HOST]: hostWith([], { subscribeExtra: { include_workers: false } }) })
    const b = new Supervisor(hidden.deps)
    await b.rescan()
    const l = laneOf(b)
    expect(l.children.state).toBe('unknown')
    expect(l.children.reasons).toContain('workers_hidden')
    expect(l.settled).toBe(false)
  })

  test('herdr-dag: a running run -> settled false; a running file older than 10 min -> unknown; completed -> settled', async () => {
    const w = world(home, { [TUI]: tuiSpec(), [HOST]: hostWith([]) })
    const run = (status: string) => ({ id: 'dag_1', status, nodes: [{ id: 'n1', state: status, taskId: 'st_n1' }] })
    w.dags.set(LANE_ID, { sessionId: LANE_ID, runs: [run('running')], mtimeMs: w.clock.t - 60_000 })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    expect(laneOf(sup).children).toEqual({ state: 'known', running: 0, done: 0, failed: 0, dagRuns: [{ id: 'dag_1', status: 'running', nodes: 1 }] })
    expect(laneOf(sup).settled).toBe(false)

    w.dags.set(LANE_ID, { sessionId: LANE_ID, runs: [run('running')], mtimeMs: w.clock.t - DAG_STALE_MS - 1 })
    await sup.rescan()
    expect(laneOf(sup).children.state).toBe('unknown')
    expect(laneOf(sup).children.reasons).toEqual(['dag_stale'])
    expect(laneOf(sup).settled).toBe(false)

    w.dags.set(LANE_ID, { sessionId: LANE_ID, runs: [run('completed')], mtimeMs: w.clock.t - DAG_STALE_MS - 1 })
    await sup.rescan()
    expect(laneOf(sup).children.state).toBe('known')
    expect(laneOf(sup).settled).toBe(true)
  })

  test('host disconnected -> children unknown, settled false', async () => {
    const w = world(home, { [TUI]: tuiSpec(), [HOST]: hostWith([]) })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    expect(laneOf(sup).settled).toBe(true)
    w.last(HOST).drop()
    const l = laneOf(sup)
    expect(l.children.state).toBe('unknown')
    expect(l.children.reasons).toContain('host_disconnected')
    expect(l.settled).toBe(false)
  })

  test('task store (in-process subagent): turn_done waits until the task record leaves running', async () => {
    const w = world(home, { [TUI]: tuiSpec(), [HOST]: hostWith([]) }, { panes: ['w21:p4'] })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    const tui = w.last(TUI)
    const [laneRunning, , laneIdle, completion] = load('child-running.ndjson')
    await replay(sup, tui, [laneRunning])
    w.tasks.push(task('st_inproc', 'running'))
    w.clock.t += 5_000                                     // past LOCAL_TTL_MS: the idle transition re-reads the store
    await replay(sup, tui, [laneIdle, completion], EPOCH_AFTER)
    expect(laneOf(sup).children).toMatchObject({ state: 'known', running: 1 })
    expect(kinds(home, 'lane.turn_done')).toHaveLength(0)
    w.tasks[0]!.status = 'completed'
    await sup.rescan()
    expect(laneOf(sup).children).toMatchObject({ state: 'known', running: 0, done: 1 })
    const done = kinds(home, 'lane.turn_done')
    expect(done).toHaveLength(1)
    expect(done[0].data.children).toEqual({ state: 'known', running: 0 })
  })

  test('flags/supervisor.no-children: the snapshot omits children and settled = status idle', async () => {
    mkdirSync(join(home, 'flags'), { recursive: true })
    writeFileSync(supPaths(home).noChildrenFlag, '')
    const w = world(home, { [TUI]: tuiSpec(), [HOST]: hostWith([child('c-run', 'running', { parent_session_id: LANE_ID })]) })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    const l = laneOf(sup)
    expect('children' in l).toBe(false)
    expect('childrenIds' in l).toBe(false)
    expect(l.settled).toBe(l.status === 'idle')
  })

  test('readTaskRecords reads the global store, agent/projects/* stores, <cwd> stores and children/<st_id>/; absence is tolerated', () => {
    const fake = join(home, 'fakehome'), cwd = join(home, 'lanecwd')
    for (const d of [join(fake, '.omo/senpi-task/tasks'), join(cwd, '.omo/senpi-task/tasks'), join(fake, '.omo/senpi-task/children/st_c'), join(fake, '.omo/agent/projects/rpc-smoke-x/senpi-task/tasks')]) mkdirSync(d, { recursive: true })
    const rec = (task_id: string, status: string, updated_at: string) => JSON.stringify({ task_id, status, parent_session_id: LANE_ID, root_session_id: LANE_ID, updated_at })
    writeFileSync(join(fake, '.omo/senpi-task/tasks/st_g.json'), rec('st_g', 'running', '2026-10-23T08:00:00Z'))
    writeFileSync(join(cwd, '.omo/senpi-task/tasks/st_g.json'), rec('st_g', 'completed', '2026-10-23T08:05:00Z'))
    writeFileSync(join(fake, '.omo/senpi-task/children/st_c/task.json'), rec('st_c', 'failed', '2026-10-23T08:01:00Z'))
    writeFileSync(join(fake, '.omo/agent/projects/rpc-smoke-x/senpi-task/tasks/st_p.json'), rec('st_p', 'running', '2026-10-23T08:02:00Z'))
    writeFileSync(join(fake, '.omo/senpi-task/tasks/garbage.json'), '{not json')
    const got = readTaskRecords([cwd, join(home, 'missing')], fake).sort((a, b) => a.id.localeCompare(b.id))
    expect(got.map((t) => [t.id, t.status])).toEqual([['st_c', 'failed'], ['st_g', 'completed'], ['st_p', 'running']])
    expect(readTaskRecords([], join(home, 'nothing-here'))).toEqual([])
  })
})

describe('offline / gone', () => {
  test('transport_gone + one rescan -> lane.offline only; a second rescan >= 20 s later -> lane.gone once', async () => {
    const w = world(home, { [TUI]: tuiSpec() })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    w.last(TUI).drop('closed')
    w.registry.endpoints = []
    w.clock.t += 10_000
    await sup.rescan()
    expect(sup.lanes.get('rpc-smoke')!.status).toBe('offline')
    expect(kinds(home, 'lane.offline')).toHaveLength(1)
    expect(kinds(home, 'lane.gone')).toHaveLength(0)
    w.clock.t += 5_000
    await sup.rescan()
    expect(kinds(home, 'lane.gone')).toHaveLength(0)
    w.clock.t += GONE_MISS_GAP_MS
    await sup.rescan()
    w.clock.t += GONE_MISS_GAP_MS
    await sup.rescan()
    expect(kinds(home, 'lane.gone')).toHaveLength(1)
    expect(kinds(home, 'lane.offline')).toHaveLength(1)
    expect(sup.lanes.get('rpc-smoke')!.status).toBe('gone')
  })

  test('sess.ts close (registry status closed) still ends in exactly one lane.gone, and the lane leaves .lanes at once', async () => {
    const w = world(home, { [TUI]: tuiSpec() }, { panes: ['w21:p4'] })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    const map = w.deps.loadMap() as any
    map['rpc-smoke'].status = 'closed'
    w.last(TUI).drop('closed')
    w.registry.endpoints = []
    w.deps.panesAlive = async () => new Set()
    await sup.rescan()
    expect(Object.keys((sup.snapshot() as any).lanes)).toEqual([])
    w.clock.t += GONE_MISS_GAP_MS
    await sup.rescan()
    w.clock.t += GONE_MISS_GAP_MS
    await sup.rescan()
    expect(kinds(home, 'lane.gone')).toHaveLength(1)
    // a lane the lead closed on purpose is information, not a question (children are unknown once the link is gone)
    expect((kinds(home, 'lane.gone')[0] as any).severity).toBe('info')
    expect((kinds(home, 'lane.gone')[0] as any).data.closedByLead).toBe(true)
    expect(sup.lanes.has('rpc-smoke')).toBe(false)
  })

  test('a live pane keeps the lane offline, never gone', async () => {
    const w = world(home, { [TUI]: tuiSpec() }, { panes: ['w21:p4'] })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    w.last(TUI).drop('closed')
    w.registry.endpoints = []
    for (let i = 0; i < 4; i++) { w.clock.t += GONE_MISS_GAP_MS; await sup.rescan() }
    expect(kinds(home, 'lane.gone')).toHaveLength(0)
    expect(sup.lanes.get('rpc-smoke')!.status).toBe('offline')
  })
})

describe('registry rebind onto an already-linked host', () => {
  test('lane rebound to a session whose endpoint was linked before the rebind binds on the next rescan (no status event needed)', async () => {
    const w = world(home, { [TUI]: tuiSpec() }, { panes: ['w21:p4'] })
    const entry = (w.deps.loadMap() as any)['rpc-smoke']
    entry.sessionId = 'old-session-id'
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    expect((sup.snapshot().lanes as any)['rpc-smoke'].endpoint).toBeNull()
    entry.sessionId = LANE_ID
    entry.sessionVia = 'transition'
    await sup.rescan()
    const lane = (sup.snapshot().lanes as any)['rpc-smoke']
    expect(lane.endpoint?.socket).toBe(TUI)
    expect(lane.endpoint?.instanceId).toBe(INST)
    expect(lane.status).toBe(SNAPSHOT[0].status)
  })
})

describe('subscriptions', () => {
  test('host_superseded -> exactly one resubscribe call', async () => {
    const [sup0] = load('host-superseded.ndjson')
    const successor = sup0.successor.socket
    const w = world(home, { [TUI]: tuiSpec(), [HOST]: { kind: 'rpc_host', state: 'up', instanceId: 'OLD', snapshot: [], epoch: 0 }, [successor]: { kind: 'rpc_host', state: 'up', instanceId: 'NEW', snapshot: [], epoch: 0 } })
    w.registry.endpoints = w.registry.endpoints.filter((e) => e.socket !== successor)
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    const old = w.last(HOST)
    old.push(sup0)
    old.push(sup0)
    await sup.flush()
    old.drop('closed')
    await sup.flush()
    const subs = (w.links[successor] ?? []).flatMap((l) => l.requests.filter((r) => r.type === 'subscribe_sessions'))
    expect(subs).toHaveLength(1)
    expect(w.links[successor]).toHaveLength(1)
    expect(sup.hosts.get(successor)!.instanceId).toBe('NEW')
    expect(kinds(home, 'lane.offline')).toHaveLength(0)
  })

  test('resync_required -> snapshot re-request on the same link, no events replayed', async () => {
    const w = world(home, { [TUI]: tuiSpec() })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    const link = w.last(TUI)
    await replay(sup, link, load('resync-required.ndjson'))
    expect(link.requests.filter((r) => r.type === 'subscribe_sessions')).toHaveLength(2)
    expect(fileEvents(home)).toHaveLength(0)
  })

  test('tui feed: a persisted cursor behind the 256-record ring triggers a resync', async () => {
    const p = supPaths(home)
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(p.state, JSON.stringify({ v: 1, lanes: {}, cursors: { [TUI]: { instanceId: INST, cursor: 3 } } }))
    const w = world(home, { [TUI]: tuiSpec({ cursor: 400, replayOnSubscribe: [{ type: 'session_control_event', seq: 145, kind: 'state', data: {} }] }) })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    const link = w.last(TUI)
    expect(link.requests.find((r) => r.type === 'subscribe')).toEqual({ type: 'subscribe', cursor: 3 })
    expect(link.requests.filter((r) => r.type === 'subscribe_sessions')).toHaveLength(2)
  })

  test('census incomplete -> children.state unknown for lanes on the missing host', async () => {
    const w = world(home, { [TUI]: tuiSpec({ state: 'unreachable' }) }, { endpointCache: TUI, panes: ['w21:p4'] })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    const snap = sup.snapshot() as any
    expect(snap.census.complete).toBe(false)
    expect(snap.census.hostsUnreachable).toEqual([TUI])
    expect(snap.lanes['rpc-smoke'].children.state).toBe('unknown')
    expect(snap.lanes['rpc-smoke'].settled).toBe(false)
    expect(kinds(home, 'lane.gone')).toHaveLength(0)
  })

  test('an unreachable multi-session host makes every lane\'s children unknown', async () => {
    const w = world(home, { [TUI]: tuiSpec(), [HOST]: { kind: 'rpc_host', state: 'unreachable', instanceId: 'h', snapshot: [], epoch: 0 } })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    expect((sup.snapshot() as any).lanes['rpc-smoke'].children.state).toBe('unknown')
  })

  test('dead endpoints keep the census complete; the lead lane is not a lane', async () => {
    const w = world(home, { [TUI]: tuiSpec(), '/fixture/dead.sock': { kind: 'rpc_host', state: 'dead', instanceId: '', snapshot: [], epoch: 0 } })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    const snap = sup.snapshot() as any
    expect(snap.census.complete).toBe(true)
    expect(Object.keys(snap.lanes)).toEqual(['rpc-smoke'])
  })
})

describe('restart boundary', () => {
  const seed = (instanceId: string, epoch: number) => {
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(supPaths(home).state, JSON.stringify({ v: 1, lanes: { [LANE_ID]: { key: 'rpc-smoke', instanceId, epoch, at: '' } }, cursors: {} }))
  }
  const running = LIVE.find((r) => r.type === 'session_status' && r.status === 'running')
  const idle = LIVE.find((r) => r.type === 'session_status' && r.status === 'idle')

  test('state (instanceId, epoch): the same epoch re-emits 0 events, epoch+1 emits', async () => {
    seed(INST, 5)
    const w = world(home, { [TUI]: tuiSpec({ epoch: 5 }) })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    const link = w.last(TUI)
    await replay(sup, link, [running, idle], 5)
    expect(kinds(home, 'lane.turn_done')).toHaveLength(0)
    await replay(sup, link, [running, idle], 6)
    const done = kinds(home, 'lane.turn_done')
    expect(done).toHaveLength(1)
    expect(done[0].id).toBe(`lane.turn_done:${LANE_ID}:${INST}:6`)
    const sup2 = new Supervisor(w.deps)
    await sup2.rescan()
    await replay(sup2, w.last(TUI), [running, idle], 6)
    expect(kinds(home, 'lane.turn_done')).toHaveLength(1)
    expect(JSON.parse(readFileSync(supPaths(home).state, 'utf8')).lanes[LANE_ID]).toMatchObject({ instanceId: INST, epoch: 6 })
  })

  test('a snapshot that is already a newer epoch of the same incarnation emits the missed turn once', async () => {
    seed(INST, 5)
    const w = world(home, { [TUI]: tuiSpec({ epoch: 7 }) })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    await sup.rescan()
    expect(kinds(home, 'lane.turn_done').map((e) => e.id)).toEqual([`lane.turn_done:${LANE_ID}:${INST}:7`])
  })

  test('a new instanceId with epoch 0 emits (an epoch restart is not deduped away)', async () => {
    seed(INST, 5)
    const w = world(home, { [TUI]: tuiSpec({ instanceId: 'inst-B', epoch: 0, snapshot: [{ ...SNAPSHOT[0], status: 'running' }] }) })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    await replay(sup, w.last(TUI), [idle], 0)
    const done = kinds(home, 'lane.turn_done')
    expect(done).toHaveLength(1)
    expect(done[0].id).toBe(`lane.turn_done:${LANE_ID}:inst-B:0`)
  })
})

describe('observe-only contract', () => {
  test('every subscribe_sessions request sent had include_workers === true and include_context === true', () => {
    expect(allSubscribeRequests.length).toBeGreaterThan(5)
    for (const r of allSubscribeRequests) {
      expect(r.include_workers).toBe(true)
      expect(r.include_context).toBe(true)
    }
  })

  test('the supervisor sends no input, lifecycle or mutation command to any endpoint', async () => {
    const w = world(home, { [TUI]: tuiSpec(), [HOST]: { kind: 'rpc_host', state: 'up', instanceId: 'h', snapshot: [], epoch: 0 } })
    const sup = new Supervisor(w.deps)
    await sup.rescan()
    await replay(sup, w.last(TUI), LIVE, EPOCH_AFTER)
    const allowed = new Set(['get_protocol_info', 'subscribe_sessions', 'unsubscribe_sessions', 'subscribe', 'get_state'])
    const sent = Object.values(w.links).flat().flatMap((l) => l.requests.map((r) => r.type))
    expect(sent.filter((t) => !allowed.has(t))).toEqual([])
    const hostReads = w.last(HOST).requests.filter((r) => r.type === 'get_protocol_info' || r.type === 'get_state')
    for (const r of hostReads) expect(r.observe).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// S9 policies (fixtures). Every case runs in its own OMOCAT_HOME tree; nothing reaches a live lane.

const T0 = Date.parse('2026-10-23T08:00:00Z')
const MIN = 60_000
const NEW_ID = '11111111-2222-4333-8444-555555555555'
const usageAt = (t: number, over: Record<string, any> = {}) => ({
  accounts: {
    'anthropic-subscription/default': { updatedAt: t, nextAt: t + 5 * MIN, windows: [{ label: '5h', usedPercent: 100, windowMinutes: 300, resetsAt: new Date(t + 2 * 3600_000).toISOString() }, { label: '7d', usedPercent: 60, windowMinutes: 10080, resetsAt: new Date(t + 3 * 86400_000).toISOString() }] },
    'anthropic-subscription/alt': { updatedAt: t, nextAt: t + 5 * MIN, windows: [{ label: '5h', usedPercent: 5, windowMinutes: 300, resetsAt: new Date(t + 4 * 3600_000).toISOString() }, { label: '7d', usedPercent: 10, windowMinutes: 10080, resetsAt: new Date(t + 6 * 86400_000).toISOString() }] },
    'anthropic-subscription/work': { updatedAt: t, nextAt: t + 5 * MIN, windows: [{ label: '5h', usedPercent: 70, windowMinutes: 300, resetsAt: new Date(t + 4 * 3600_000).toISOString() }, { label: '7d', usedPercent: 50, windowMinutes: 10080, resetsAt: new Date(t + 6 * 86400_000).toISOString() }] },
    ...over,
  },
})
const AUTH = { 'anthropic-subscription': { accounts: [{ name: 'default' }, { name: 'alt' }, { name: 'work' }] } }
const CLAUDE = 'anthropic-subscription/claude-opus-5-5'

function writeMapFile(h: string, over: Record<string, unknown> = {}) {
  const m = {
    'rpc-smoke': {
      key: 'rpc-smoke', label: 'rpc-smoke', cwd: '/tmp/omocat/rpc-smoke', thread: null, workspace: 'w21', tab: 'w21:t4', pane: 'w21:p4',
      sessionId: LANE_ID, status: 'open', openedAt: '2026-10-23T07:07:47.150Z', generation: 4, model: CLAUDE, ...over,
    },
  }
  mkdirSync(h, { recursive: true })
  writeFileSync(regPaths(h).map, JSON.stringify(m, null, 2))
}
const patchMapFile = (h: string, key: string, patch: Record<string, unknown>) => {
  const m = JSON.parse(readFileSync(regPaths(h).map, 'utf8'))
  m[key] = { ...m[key], ...patch }
  writeFileSync(regPaths(h).map, JSON.stringify(m, null, 2))
}
const flag = (h: string, name: string, content = '') => { mkdirSync(join(h, 'flags'), { recursive: true }); writeFileSync(join(h, 'flags', name), content) }
const policyOps = (h: string) => new OpsLedger(h, () => 0).all()

type Calls = { transition: string[][]; send: { key: string; text: string; id: string }[]; reap: string[]; leaseDuringReap: boolean[] }
function policyWorld(h: string, over: Partial<PolicyDeps> = {}) {
  writeMapFile(h)
  const w = world(h, { [TUI]: tuiSpec() }, { panes: ['w21:p4'] })
  w.deps.loadMap = () => readMap(h)
  const calls: Calls = { transition: [], send: [], reap: [], leaseDuringReap: [] }
  const persisted = new Set<string>()
  const deps: PolicyDeps = {
    transition: async (argv) => { calls.transition.push(argv); return { exit: 0, out: { ok: true } } },
    send: async (key, text, id) => { calls.send.push({ key, text, id }); persisted.add(id); return { status: 'delivered' } },
    receipt: (_k, _d, id) => (persisted.has(id) ? 'persisted' : 'absent'),
    quotaInput: async () => null,
    usage: () => usageAt(w.clock.t), auth: () => AUTH, migrations: () => [], doriLanes: () => [],
    markNudged: async () => {}, nudgeAfterMs: 15 * MIN,
    reaperLines: async () => [],
    reapApply: async (tab) => { calls.reap.push(tab); calls.leaseDuringReap.push(existsSync(join(regPaths(h).leases, 'rpc-smoke')) || existsSync(join(regPaths(h).leases, `reap-${tab.replace(/[^A-Za-z0-9._-]/g, '_')}`))); return { code: 0, out: 'LANE_REAP_DONE' } },
    tabsAlive: async () => new Set(['w21:t9']),
    ...over,
  }
  const sup = new Supervisor(w.deps)
  const pol = new Policies(sup, deps)
  return { w, sup, pol, calls, persisted, deps }
}
const quotaHit = async () => ({ verdict: 'quota', detail: 'account=default err="usage limit"', model: CLAUDE, account: 'default' })

describe('S9 quota policy', () => {
  test('quota classification with the AUTO flag -> exactly one lane-transition invocation and one ops record (verified by read-back)', async () => {
    const x = policyWorld(home, {
      quotaInput: quotaHit,
      transition: async (argv) => { x.calls.transition.push(argv); patchMapFile(home, 'rpc-smoke', { generation: 5, accountRequested: argv[3] }); return { exit: 0, out: { ok: true, opId: 'op_t1' } } },
    })
    flag(home, 'policy.quota', 'rpc-smoke')
    flag(home, 'auto-migrate.rpc-smoke')
    await x.sup.rescan()
    await x.pol.tick()
    x.w.clock.t += MIN
    await x.pol.tick()
    expect(x.calls.transition).toEqual([['rpc-smoke', '--fresh', '--account', 'alt', '--reason', 'quota']])
    const ops = policyOps(home)
    expect(ops).toHaveLength(1)
    expect(ops[0]!.policy).toBe('quota')
    expect(ops[0]!.history.map((s) => s.state)).toEqual(['planned', 'attempted', 'verified'])
    const episode = `quota:rpc-smoke:${LANE_ID}`
    expect(readFileSync(policyPaths(home).autoMigrate('rpc-smoke'), 'utf8').trim()).toBe(episode)
    expect(kinds(home, 'lane.quota')).toHaveLength(1)
    expect(kinds(home, 'policy.quota_proposal')).toHaveLength(0)
  })

  test('without the AUTO flag -> one DORI_ASK (policy.quota_proposal, severity ask) and no invocation, no ops record', async () => {
    const x = policyWorld(home, { quotaInput: quotaHit })
    flag(home, 'policy.quota', 'rpc-smoke')
    await x.sup.rescan()
    await x.pol.tick()
    x.w.clock.t += MIN
    await x.pol.tick()
    expect(x.calls.transition).toEqual([])
    const asks = kinds(home, 'policy.quota_proposal')
    expect(asks).toHaveLength(1)
    expect(asks[0].severity).toBe('ask')
    expect(asks[0].data.target).toBe('alt')
    expect(policyOps(home)).toHaveLength(0)
  })

  test('an AUTO flag naming another episode is not an approval (per-episode, not permanent)', async () => {
    const x = policyWorld(home, { quotaInput: quotaHit })
    flag(home, 'policy.quota', 'rpc-smoke')
    flag(home, 'auto-migrate.rpc-smoke', 'quota:rpc-smoke:some-older-session\n')
    await x.sup.rescan()
    await x.pol.tick()
    expect(x.calls.transition).toEqual([])
    expect(kinds(home, 'policy.quota_proposal')).toHaveLength(1)
  })

  test('policy flag absent -> the supervisor stays silent (legacy LANE_QUOTA proposes); a GPT lane is never rotated', async () => {
    const x = policyWorld(home, { quotaInput: quotaHit })
    await x.sup.rescan()
    await x.pol.tick()
    expect(x.calls.transition).toEqual([])
    expect(fileEvents(home).filter((e) => e.kind.startsWith('policy.'))).toEqual([])
    const y = policyWorld(join(home, 'gpt'), { quotaInput: async () => ({ verdict: 'quota', detail: '429', model: 'chatgpt-subscription/gpt-6-astra', account: null }) })
    flag(join(home, 'gpt'), 'policies.on')
    flag(join(home, 'gpt'), 'auto-migrate.rpc-smoke')
    await y.sup.rescan()
    await y.pol.tick()
    expect(y.calls.transition).toEqual([])
  })

  test('exit 0 without the move visible in the registry is ambiguous: DORI_ASK and never retried', async () => {
    const x = policyWorld(home, { quotaInput: quotaHit })
    flag(home, 'policy.quota', 'rpc-smoke')
    flag(home, 'auto-migrate.rpc-smoke')
    await x.sup.rescan()
    await x.pol.tick()
    x.w.clock.t += 5 * MIN
    await x.pol.tick()
    expect(x.calls.transition).toHaveLength(1)
    expect(policyOps(home)[0]!.state).toBe('ambiguous')
    expect(kinds(home, 'policy.op_ambiguous')).toHaveLength(1)
    expect(kinds(home, 'policy.op_ambiguous')[0].severity).toBe('ask')
  })

  test('supervisor restarted with a quota op attempted: it is read back, never re-invoked (no move visible -> ambiguous)', async () => {
    const x = policyWorld(home)
    const led = new OpsLedger(home, () => x.w.clock.t)
    const op = led.create('quota', 'rpc-smoke', { episode: 'quota:rpc-smoke:z', target: 'alt', g: 4 })
    led.mark(op, 'attempted', 'spawned before the crash', { step: 'transition' })
    await x.sup.rescan()
    await x.pol.tick()
    expect(x.calls.transition).toEqual([])
    expect(led.read(op.opId).state).toBe('ambiguous')
  })
})

describe('S9 session_replaced -> adopt', () => {
  const adoptCtx = (h: string, x: ReturnType<typeof policyWorld>, receiptAt: AdoptCtx['receiptAt'], seen: { seedState?: string }): AdoptCtx => ({
    home: h, ledger: new OpsLedger(h, () => x.w.clock.t),
    send: async (key, text, id) => { seen.seedState = readMap(h)[key]?.seed?.state as string; x.calls.send.push({ key, text, id }); x.persisted.add(id); return { status: 'delivered' } },
    sessionPath: (id) => `/fixture/sessions/${id}.jsonl`, receiptAt, seedText: (key, g) => `seed for ${key} g${g}`,
    now: () => x.w.clock.t, sleep: async (ms) => { x.w.clock.t += ms }, receiptWaitMs: 5_000,
  })

  test('registry rebind (reconcile-endpoint) -> lane.session_replaced, one --adopt-replacement invocation, seed pending then applied on receipt', async () => {
    const seen: { seedState?: string } = {}
    let ctx!: AdoptCtx
    const x = policyWorld(home, {
      transition: async (argv) => { x.calls.transition.push(argv); return adoptReplacement(ctx, argv[argv.indexOf('--op') + 1]!) },
    })
    ctx = adoptCtx(home, x, (_p, id) => (x.persisted.has(id) ? 'persisted' : 'absent'), seen)
    flag(home, 'policy.adopt', 'rpc-smoke')
    await x.sup.rescan()
    patchMapFile(home, 'rpc-smoke', { sessionId: NEW_ID, sessionVia: 'reconcile-endpoint' })
    await x.sup.rescan()
    await x.pol.tick()
    x.w.clock.t += MIN
    await x.sup.rescan()
    await x.pol.tick()
    expect(kinds(home, 'lane.session_replaced')).toHaveLength(1)
    expect(kinds(home, 'lane.session_replaced')[0].data).toMatchObject({ from: LANE_ID, to: NEW_ID, via: 'registry' })
    expect(x.calls.transition.filter((a) => a[0] === '--adopt-replacement')).toHaveLength(1)
    expect(seen.seedState).toBe('pending')
    expect(x.calls.send.map((s) => s.id)).toEqual(['seed:rpc-smoke:5'])
    const e = readMap(home)['rpc-smoke']!
    expect(e.sessionId).toBe(NEW_ID)
    expect(e.generation).toBe(5)
    expect(e.sessionVia).toBe('adopt')
    expect(e.seed).toEqual({ state: 'applied', id: 'seed:rpc-smoke:5', generation: 5 })
    expect(e.lineage?.sessions).toContain(LANE_ID)
    expect(kinds(home, 'lane.seed_applied')).toHaveLength(1)
    expect(policyOps(home).map((o) => o.state)).toEqual(['verified'])
  })

  test('without the adopt flag the replacement is a proposal (DORI_ASK), nothing is rebound or sent', async () => {
    const x = policyWorld(home)
    await x.sup.rescan()
    patchMapFile(home, 'rpc-smoke', { sessionId: NEW_ID, sessionVia: 'reconcile-argv' })
    await x.sup.rescan()
    await x.pol.tick()
    expect(x.calls.transition).toEqual([])
    const asks = kinds(home, 'policy.adopt_proposal')
    expect(asks).toHaveLength(1)
    expect(asks[0].severity).toBe('ask')
    expect(readMap(home)['rpc-smoke']!.generation).toBe(4)
  })

  test('a replacement seen before a supervisor restart is still detected after it (persisted lane ids)', async () => {
    const x = policyWorld(home)
    await x.sup.rescan()
    x.sup.close()
    patchMapFile(home, 'rpc-smoke', { sessionId: NEW_ID, sessionVia: 'reconcile-endpoint' })
    const y = new Supervisor(x.w.deps)
    await y.rescan()
    expect(kinds(home, 'lane.session_replaced')).toHaveLength(1)
  })

  test('restarted with the op at step seed -> resumes the receipt wait, does not resend (and never with a new id)', async () => {
    const x = policyWorld(home)
    patchMapFile(home, 'rpc-smoke', { sessionId: NEW_ID, generation: 5, sessionVia: 'adopt', seed: { state: 'pending', id: 'seed:rpc-smoke:5', generation: 5 } })
    const led = new OpsLedger(home, () => x.w.clock.t)
    const op = led.create('adopt', 'rpc-smoke', { from: LANE_ID, to: NEW_ID, via: 'registry' })
    led.mark(op, 'attempted', 'rebound; seed pending', { step: 'seed', data: { ...op.data, g: 5, seedId: 'seed:rpc-smoke:5', cwd: '/tmp/omocat/rpc-smoke' } })
    const asked: string[] = []
    let n = 0
    const ctx = adoptCtx(home, x, (_p, id) => { asked.push(id); return ++n >= 3 ? 'persisted' : 'absent' }, {})
    const pol = new Policies(new Supervisor(x.w.deps), { ...x.deps, transition: async (argv) => { x.calls.transition.push(argv); return adoptReplacement(ctx, argv[argv.indexOf('--op') + 1]!) } })
    await pol.tick()
    expect(x.calls.send).toEqual([])
    expect(new Set(asked)).toEqual(new Set(['seed:rpc-smoke:5']))
    expect(led.read(op.opId).state).toBe('verified')
    expect(readMap(home)['rpc-smoke']!.seed).toEqual({ state: 'applied', id: 'seed:rpc-smoke:5', generation: 5 })
  })

  test('restarted at step seed and the receipt never comes -> ambiguous + lane.empty_after_handoff ask, no resend on later ticks', async () => {
    const x = policyWorld(home)
    patchMapFile(home, 'rpc-smoke', { sessionId: NEW_ID, generation: 5, seed: { state: 'pending', id: 'seed:rpc-smoke:5', generation: 5 } })
    const led = new OpsLedger(home, () => x.w.clock.t)
    const op = led.create('adopt', 'rpc-smoke', { from: LANE_ID, to: NEW_ID, via: 'registry' })
    led.mark(op, 'attempted', 'rebound', { step: 'seed', data: { ...op.data, g: 5, seedId: 'seed:rpc-smoke:5' } })
    const ctx = adoptCtx(home, x, () => 'absent', {})
    const pol = new Policies(new Supervisor(x.w.deps), { ...x.deps, transition: async (argv) => { x.calls.transition.push(argv); return adoptReplacement(ctx, argv[argv.indexOf('--op') + 1]!) } })
    await pol.tick()
    await pol.tick()
    expect(x.calls.send).toEqual([])
    expect(x.calls.transition).toHaveLength(1)
    expect(led.read(op.opId).state).toBe('ambiguous')
    expect(kinds(home, 'lane.empty_after_handoff')).toHaveLength(1)
  })
})

describe('S9 reap LANE_EMPTY_TAB', () => {
  test('gone with children unknown -> ask, no reap', async () => {
    const x = policyWorld(home, { reaperLines: async () => ['LANE_EMPTY_TAB w21:t4 age=30h'] })
    flag(home, 'policy.reap')
    x.sup.syncLanes()
    const lane = x.sup.lanes.get('rpc-smoke')!
    lane.status = 'gone'
    expect(x.sup.children(lane).state).toBe('unknown')
    await x.pol.tick()
    x.w.clock.t += 25_000
    await x.pol.tick()
    x.w.clock.t += 25_000
    await x.pol.tick()
    expect(x.calls.reap).toEqual([])
    const asks = kinds(home, 'policy.reap_refused')
    expect(asks).toHaveLength(1)
    expect(asks[0].severity).toBe('ask')
    expect(asks[0].data.children.state).toBe('unknown')
  })

  test('--apply only after gone is confirmed (two sightings >= 20 s apart, children known 0) and with the lease held', async () => {
    const x = policyWorld(home, { reaperLines: async () => ['LANE_EMPTY_TAB w21:t4 age=30h', 'LANE_EMPTY_TAB w9:t1 age=40h'] })
    flag(home, 'policy.reap')
    await x.sup.rescan()
    const lane = x.sup.lanes.get('rpc-smoke')!
    lane.status = 'gone'
    expect(x.sup.children(lane)).toMatchObject({ state: 'known', running: 0 })
    await x.pol.tick()
    expect(x.calls.reap).toEqual([])
    x.w.clock.t += 5_000
    await x.pol.tick()
    expect(x.calls.reap).toEqual([])
    x.w.clock.t += 20_000
    await x.pol.tick()
    expect(x.calls.reap.sort()).toEqual(['w21:t4', 'w9:t1'])
    expect(x.calls.leaseDuringReap).toEqual([true, true])
    x.w.clock.t += 25_000
    await x.pol.tick()
    expect(x.calls.reap).toHaveLength(2)
    expect(policyOps(home).map((o) => o.state)).toEqual(['verified', 'verified'])
    expect(existsSync(join(regPaths(home).leases, 'rpc-smoke'))).toBe(false)
  })

  test('a lane still running in that tab is never reaped', async () => {
    const x = policyWorld(home, { reaperLines: async () => ['LANE_EMPTY_TAB w21:t4 age=30h'] })
    flag(home, 'policy.reap')
    await x.sup.rescan()
    for (let i = 0; i < 3; i++) { await x.pol.tick(); x.w.clock.t += 25_000 }
    expect(x.calls.reap).toEqual([])
  })
})

describe('S9 nudge via the adapter', () => {
  const silent = (lastReplyAt?: number) => [{ key: 'rpc-smoke', status: 'working', openedAt: new Date(T0 - 20 * MIN).toISOString(), ...(lastReplyAt ? { lastReplyAt } : {}) }]

  test('nudge id nudge:<key>:<generation>:<n>; the second only after the first persisted and no reply; then ask', async () => {
    let lanes = silent()
    const x = policyWorld(home, { doriLanes: () => lanes })
    flag(home, 'policy.nudge', 'rpc-smoke')
    await x.pol.tick()
    expect(x.calls.send.map((s) => s.id)).toEqual(['nudge:rpc-smoke:4:1'])
    x.w.clock.t += 5 * MIN
    await x.pol.tick()
    expect(x.calls.send).toHaveLength(1)
    x.w.clock.t += 11 * MIN
    await x.pol.tick()
    expect(x.calls.send.map((s) => s.id)).toEqual(['nudge:rpc-smoke:4:1', 'nudge:rpc-smoke:4:2'])
    x.w.clock.t += 16 * MIN
    await x.pol.tick()
    x.w.clock.t += 16 * MIN
    await x.pol.tick()
    expect(x.calls.send).toHaveLength(2)
    expect(kinds(home, 'policy.nudge_unanswered')).toHaveLength(1)
    expect(policyOps(home).map((o) => o.state)).toEqual(['verified', 'verified'])
    lanes = silent(x.w.clock.t)
    x.w.clock.t += 16 * MIN
    await x.pol.tick()
    expect(x.calls.send.map((s) => s.id).at(-1)).toBe('nudge:rpc-smoke:4:3')
  })

  test('a first nudge without receipt is ambiguous: ask, and no second nudge', async () => {
    const x = policyWorld(home, { doriLanes: () => silent(), send: async (key, text, id) => { x.calls.send.push({ key, text, id }); return { status: 'uncertain', reason: 'no_receipt' } } })
    flag(home, 'policy.nudge', 'rpc-smoke')
    await x.pol.tick()
    x.w.clock.t += 16 * MIN
    await x.pol.tick()
    x.w.clock.t += 16 * MIN
    await x.pol.tick()
    expect(x.calls.send.map((s) => s.id)).toEqual(['nudge:rpc-smoke:4:1'])
    expect(policyOps(home)[0]!.state).toBe('ambiguous')
    expect(kinds(home, 'policy.op_ambiguous')).toHaveLength(1)
  })

  test('no nudge flag -> no send (the lead gets NO-NUDGE from dori freshness --no-nudge)', async () => {
    const x = policyWorld(home, { doriLanes: () => silent() })
    await x.pol.tick()
    expect(x.calls.send).toEqual([])
  })
})

describe('S9 additions: headroom, switch back, open tool call', () => {
  const t = T0
  test('(a) headroom = remaining% / remaining-time%, capped at 1000%, a passed reset is fresh, tightest window wins', () => {
    expect(windowHeadroom({ label: '5h', usedPercent: 50, windowMinutes: 300, resetsAt: new Date(t + 150 * MIN).toISOString() }, t)).toBeCloseTo(100)
    expect(windowHeadroom({ label: '5h', usedPercent: 10, windowMinutes: 300, resetsAt: new Date(t + 1 * MIN).toISOString() }, t)).toBe(1000)
    expect(windowHeadroom({ label: '5h', usedPercent: 100, windowMinutes: 300, resetsAt: new Date(t - MIN).toISOString() }, t)).toBe(100)
    expect(windowHeadroom({ label: '5h', usedPercent: 100, windowMinutes: 300, resetsAt: new Date(t + MIN).toISOString() }, t)).toBe(0)
    const h = accountHeadroom('work', usageAt(t), AUTH, t)
    expect(h.score).toBe(Math.min(...h.windows.map((w) => w.score)))
    expect(pickAccount(['default', 'alt', 'work'], 'default', usageAt(t), AUTH, t)?.name).toBe('alt')
  })
  test('(a) usage older than max(3 x poll, 15) min is not used; an account missing from auth is not a candidate', () => {
    expect(pickAccount(['default', 'alt', 'work'], 'default', usageAt(t - 16 * MIN), AUTH, t)).toBeNull()
    expect(pickAccount(['default', 'alt', 'work'], 'default', usageAt(t - 14 * MIN), AUTH, t)?.name).toBe('alt')
    const noEightySix = { 'anthropic-subscription': { accounts: [{ name: 'default' }, { name: 'work' }] } }
    expect(pickAccount(['default', 'alt', 'work'], 'default', usageAt(t), noEightySix, t)?.name).toBe('work')
  })
  test('(b) switch back after N consecutive clear checks; unreadable is not clear; one blocked resets', () => {
    let c = 0, fired = 0
    for (const chk of ['clear', 'clear', 'blocked', 'clear', 'unreadable', 'clear', 'clear'] as const) { const s = switchBackStep(c, chk, 3); c = s.count; if (s.fire) fired++ }
    expect(fired).toBe(1)
    expect(c).toBe(3)
  })
  test('(b) switch-back policy keeps its counter in the supervisor state file and asks once', async () => {
    const x = policyWorld(home, { migrations: () => [{ key: 'rpc-smoke', reason: 'quota', from: 'alt', to: 'work', opId: 'op_m1' }] })
    patchMapFile(home, 'rpc-smoke', { accountRequested: 'work' })
    flag(home, 'policy.quota', 'rpc-smoke')
    for (let i = 0; i < 2; i++) { await x.pol.tick(); x.w.clock.t += MIN }
    expect(kinds(home, 'lane.quota_reset')).toHaveLength(0)
    expect(JSON.parse(readFileSync(supPaths(home).state, 'utf8')).policy.switchBack['rpc-smoke'].count).toBe(2)
    await x.pol.tick()
    await x.pol.tick()
    expect(kinds(home, 'lane.quota_reset')).toHaveLength(1)
    expect(kinds(home, 'lane.quota_reset')[0].severity).toBe('ask')
  })
  test('(d) open tool call clock: one tool running N min vs silent', () => {
    const at = (m: number) => new Date(t + m * MIN).toISOString()
    const lines = [
      { type: 'message', timestamp: at(0), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'bash' }] } },
      { type: 'message', timestamp: at(1), message: { role: 'toolResult', toolCallId: 'a', content: [] } },
      { type: 'message', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'b', name: 'eval' }, { type: 'toolCall', id: 'c', name: 'read' }] } },
      { type: 'message', timestamp: at(2), message: { role: 'toolResult', toolCallId: 'c', content: [] } },
    ].map((l) => JSON.stringify(l)).join('\n')
    expect(openToolCall(lines)).toEqual({ since: t + 2 * MIN, name: 'eval' })
    expect(stallDetail(lines, t + 2 * MIN, t + 42 * MIN)).toEqual({ kind: 'tool_running', minutes: 40, tool: 'eval' })
    const closed = lines + '\n' + JSON.stringify({ type: 'message', timestamp: at(50), message: { role: 'toolResult', toolCallId: 'b', content: [] } })
    expect(openToolCall(closed)).toBeNull()
    expect(stallDetail(closed, t + 50 * MIN, t + 80 * MIN)).toEqual({ kind: 'silent', minutes: 30 })
  })
})

describe('S9 kill switch', () => {
  test('flags/supervisor.no-policies stops every policy, even with policies.on', async () => {
    const x = policyWorld(home, { quotaInput: quotaHit, doriLanes: () => [{ key: 'rpc-smoke', status: 'working', openedAt: new Date(T0 - 60 * MIN).toISOString() }] })
    flag(home, 'policies.on')
    flag(home, 'auto-migrate.rpc-smoke')
    flag(home, 'supervisor.no-policies')
    await x.sup.rescan()
    await x.pol.tick()
    expect(x.calls.transition).toEqual([])
    expect(x.calls.send).toEqual([])
  })
})

describe('progress watchdog (borrowed rule #8: self-exit so launchd KeepAlive restarts a stuck daemon)', () => {
  const world = () => {
    const h = mkdtempSync(join(tmpdir(), 'sup-wd-'))
    let t = T0
    const exits: number[] = []
    const wd = new Watchdog(h, () => t, (c) => { exits.push(c) })
    return { h, wd, exits, at: (ms: number) => { t = T0 + ms }, events: () => fileEvents(h), restarts: () => JSON.parse(readFileSync(join(h, 'state', 'supervisor-restarts.json'), 'utf8')).exits as number[] }
  }
  const never = () => new Promise<void>(() => {})

  test('a tracked task stuck past the alert time is named once; the loop that keeps progressing is not', () => {
    const x = world()
    x.wd.track('policy', never())
    x.at(WATCHDOG_ALERT_MS - 1); x.wd.progress(); x.wd.check()
    expect(x.events()).toEqual([])
    x.at(WATCHDOG_ALERT_MS); x.wd.progress(); x.wd.check(); x.wd.check()
    const ev = x.events()
    expect(ev.map((e) => [e.kind, e.severity, e.data.name])).toEqual([['supervisor.stalled', 'act', 'policy']])
    expect(x.exits).toEqual([])
  })

  test('simulated stall: a loop with no progress past the hard threshold records the restart and exits 1', () => {
    const x = world()
    x.at(WATCHDOG_STALL_MS - 1); x.wd.check()
    expect(x.exits).toEqual([])
    x.at(WATCHDOG_STALL_MS); x.wd.check()
    expect(x.exits).toEqual([1])
    expect(x.restarts()).toEqual([T0 + WATCHDOG_STALL_MS])
    expect(x.events().map((e) => [e.kind, e.data.name])).toEqual([['supervisor.stalled', 'loop'], ['supervisor.watchdog_exit', 'loop']])
  })

  test('a finished task stops counting', async () => {
    const x = world()
    let done!: () => void
    const p = x.wd.track('policy', new Promise<void>((r) => { done = r }))
    done(); await p; await Promise.resolve()
    x.at(WATCHDOG_STALL_MS); x.wd.progress(); x.wd.check()
    expect(x.exits).toEqual([])
    expect(x.events()).toEqual([])
  })

  test('restart storm: after K watchdog exits in M minutes it asks once and does not exit again', () => {
    const x = world()
    const recent = Array.from({ length: RESTART_STORM_MAX }, (_, i) => T0 + i * 60_000)
    mkdirSync(join(x.h, 'state'), { recursive: true })
    writeFileSync(join(x.h, 'state', 'supervisor-restarts.json'), JSON.stringify({ exits: recent }))
    x.at(WATCHDOG_STALL_MS); x.wd.check(); x.wd.check()
    expect(x.exits).toEqual([])
    expect(x.events().filter((e) => e.kind === 'supervisor.restart_storm').map((e) => e.severity)).toEqual(['ask'])
    expect(x.restarts()).toEqual(recent)
  })

  test('a daemon that hangs again after every restart is caught: exits one stall period apart still trip the guard', () => {
    const x = world()
    const gap = WATCHDOG_STALL_MS + 5 * 60_000
    const prior = Array.from({ length: RESTART_STORM_MAX }, (_, i) => T0 - (RESTART_STORM_MAX - i) * gap)
    mkdirSync(join(x.h, 'state'), { recursive: true })
    writeFileSync(join(x.h, 'state', 'supervisor-restarts.json'), JSON.stringify({ exits: prior }))
    x.at(WATCHDOG_STALL_MS); x.wd.check()
    expect(x.exits).toEqual([])
    expect(x.events().filter((e) => e.kind === 'supervisor.restart_storm').map((e) => e.severity)).toEqual(['ask'])
  })

  test('exits older than the storm window do not count', () => {
    const x = world()
    mkdirSync(join(x.h, 'state'), { recursive: true })
    const old = Array.from({ length: RESTART_STORM_MAX }, (_, i) => T0 - RESTART_STORM_WINDOW_MS - i)
    writeFileSync(join(x.h, 'state', 'supervisor-restarts.json'), JSON.stringify({ exits: old }))
    x.at(WATCHDOG_STALL_MS); x.wd.check()
    expect(x.exits).toEqual([1])
    expect(x.restarts()).toEqual([T0 + WATCHDOG_STALL_MS])
  })
})

describe('late receipt: a delivery.uncertain whose message landed later is settled once, nothing re-sent', () => {
  const NOW = Date.parse('2026-10-24T12:00:00Z')
  const SESSION = join(FIX, 'late-receipt.session.jsonl')
  const seed = () => {
    mkdirSync(join(home, 'events'), { recursive: true })
    writeFileSync(supPaths(home).events, readFileSync(join(FIX, 'late-receipt.events.ndjson'), 'utf8'))
  }
  // acme-video is closed but keeps its sessionPath; find() is the fallback and must not be needed here.
  const map = { 'acme-video': { key: 'acme-video', status: 'closed', cwd: '/x', sessionId: 'e22ac0b6-3e87-43a3-b95a-15b4596d9094', sessionPath: SESSION } } as any
  const deps = { map: () => map, find: () => null, receipt }
  const persisted = () => readFileSync(supPaths(home).events, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'delivery.persisted')

  test('only the recent, unsettled, landed id gets a late delivery.persisted', () => {
    seed()
    expect(settleLateReceipts(home, NOW, deps)).toEqual(['a8e93692-ba5'])
    const late = persisted().filter((e) => e.data.late)
    expect(late.map((e) => [e.id, e.lane, e.data.id, e.data.late, e.data.uncertainAt])).toEqual([
      ['delivery.persisted:a8e93692-ba5', 'acme-video', 'a8e93692-ba5', true, '2026-10-24T11:25:56.861Z'],
    ])
  })
  test('idempotent across runs and restarts (the log is the only state)', () => {
    seed()
    settleLateReceipts(home, NOW, deps)
    expect(settleLateReceipts(home, NOW + 60_000, deps)).toEqual([])
    expect(persisted().filter((e) => e.id === 'delivery.persisted:a8e93692-ba5').length).toBe(1)
  })
  test('lane unknown to the registry and no session file: nothing is written', () => {
    seed()
    expect(settleLateReceipts(home, NOW, { map: () => ({}), find: () => null, receipt })).toEqual([])
    expect(persisted().filter((e) => e.data.late)).toEqual([])
  })
  test('a replaced lane falls back to the event durableId session file', () => {
    seed()
    const replaced = { 'acme-video': { ...map['acme-video'], sessionId: 'other', sessionPath: '/nope.jsonl' } }
    expect(settleLateReceipts(home, NOW, { map: () => replaced, find: (id: string) => (id === 'e22ac0b6-3e87-43a3-b95a-15b4596d9094' ? SESSION : null), receipt })).toEqual(['a8e93692-ba5'])
  })
})
