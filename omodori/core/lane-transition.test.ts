import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireDirLock, readMap } from './registry'
import { FX, KEY, OLD, T, args, count, harness, killLease, occurrences } from './tests/transition-harness'

test('inventory: delivery + successful assistant -> processed; none after / only an error after -> carried, re-sent in order; ledger + artifact', async () => {
  const inv = T.transcriptInventory(readFileSync(join(FX, 'old-session.jsonl'), 'utf8'))
  expect(inv.processed.map((d) => d.id)).toEqual(['d-processed', 'h-user', 'src:1:1'])
  expect(inv.unprocessed.map((d) => d.id)).toEqual(['d-error', 'd-none'])
  expect(inv.unprocessed[0]!.text).toBe('두 번째 요청: 견적서 만들어')

  const h = harness()
  const r = await T.startTransition(h.deps, args(h))
  expect(r.exit).toBe(0)
  const op = T.readOp(h.home, r.out.opId as string)
  expect(op.inventory!.carried.map((d) => d.id)).toEqual(['d-error', 'd-none'])
  expect(h.sends.map((s) => s.id)).toEqual([`d-error:g6`, `d-none:g6`])
  expect(h.sends[0]!.text.startsWith('[이어받음: 이전 세션에서 미처리]')).toBe(true)
  const ledger = readFileSync(join(h.home, 'lane-transitions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  expect(ledger.length).toBe(1)
  expect(ledger[0].key).toBe(KEY)
  expect(ledger[0].carried).toEqual(['d-error', 'd-none'])
  const art = readFileSync(op.artifact!, 'utf8')
  expect(art).toContain('첫 요청: 브리프를 읽어')
  expect(art).toContain('[REPORT] s8-test-a | milestone')
  expect(art).not.toContain(op.seedId)
})

test('happy path: generation +1, transition via, seed applied, old tab closed once, argv verified, lease released', async () => {
  const h = harness()
  const r = await T.startTransition(h.deps, args(h, { account: 'alt' }))
  expect(r.exit).toBe(0)
  const e = readMap(h.home)[KEY]!
  expect([e.generation, (e.seed as any).state, e.sessionVia]).toEqual([6, 'applied', 'transition'])
  expect(e.sessionId).toBe(r.out.sessionId as string)
  expect(e.accountRequested).toBe('alt')
  expect((e.lineage as any).sessions).toContain(OLD)
  expect(count(h.calls, /^tab close t-old$/)).toBe(1)
  expect((r.out.argv as string[]).join(' ')).toContain('--claude-account alt')
  expect(occurrences(h.sessionFile(e.sessionId), `[dori-msg:seed:${KEY}:6]`)).toBe(1)
  expect(existsSync(join(h.home, 'lane-leases', KEY))).toBe(false)
  expect(readFileSync(join(h.home, 'lane-migrations.jsonl'), 'utf8')).toContain(`"newKey":"${KEY}"`)
})

test('quota reason skips the settled wait; reset waits until settled', async () => {
  const hq = harness({ settled: [false] })
  const rq = await T.startTransition(hq.deps, args(hq, { reason: 'quota', account: 'alt' }))
  expect(rq.exit).toBe(0)
  expect(hq.waitIdleCalls).toBe(0)
  expect(hq.statusCalls).toBe(0)
  const hr = harness({ settled: [false, false, true] })
  const rr = await T.startTransition(hr.deps, args(hr, { reason: 'reset' }))
  expect(rr.exit).toBe(0)
  expect(hr.waitIdleCalls).toBe(2)
  const hs = harness({ settled: [false] })
  const rs = await T.startTransition(hs.deps, args(hs, { reason: 'reset', settleTimeoutMs: 0 }))
  expect([rs.exit, rs.out.error]).toEqual([4, 'not_settled'])
  expect(count(hs.calls, /^tab /)).toBe(0)
})

test('children unknown -> exit 4 children_unknown, nothing touched, lease released', async () => {
  const h = harness({ children: { state: 'unknown', running: 0 } })
  const r = await T.startTransition(h.deps, args(h, { reason: 'quota' }))
  expect([r.exit, r.out.error]).toEqual([4, 'children_unknown'])
  expect(count(h.calls, /^tab |^pane run/)).toBe(0)
  expect(existsSync(join(h.home, 'lane-leases', KEY))).toBe(false)
  expect(readMap(h.home)[KEY]!.generation).toBe(5)
  const h2 = harness({ children: { state: 'known', running: 2 } })
  expect((await T.startTransition(h2.deps, args(h2))).out.error).toBe('children_running')
})

test('lease held -> exit 4 lease_held', async () => {
  const h = harness()
  mkdirSync(join(h.home, 'lane-leases'), { recursive: true })
  const held = await acquireDirLock(join(h.home, 'lane-leases', KEY), { waitMs: 0, extra: { key: KEY, op: 'reopen' } })
  const r = await T.startTransition(h.deps, args(h))
  expect([r.exit, r.out.error]).toEqual([4, 'lease_held'])
  expect(count(h.calls, /./)).toBe(0)
  held.release()
})

for (const point of ['after-inventory', 'before-close', 'after-seed-send', 'after-open']) {
  test(`ops ledger: killed at ${point}, --resume continues with no duplicate close/open/seed/send`, async () => {
    const h = harness({ crash: point })
    await expect(T.startTransition(h.deps, args(h, { account: 'alt' }))).rejects.toBeInstanceOf(T.TransitionCrash)
    const opId = T.pendingOps(h.home, KEY)[0]!.opId
    const before = T.readOp(h.home, opId)
    expect(before.status).toBe('running')
    expect(typeof before.step).toBe('number')
    await killLease(h.home, KEY)
    expect((await T.startTransition(h.deps, args(h))).out.error).toBe('op_pending')
    const r = await T.resumeTransition(h.deps, opId)
    expect(r.exit).toBe(0)
    const op = T.readOp(h.home, opId)
    expect(op.status).toBe('done')
    expect(count(h.calls, /^tab close t-old$/)).toBe(1)
    expect(count(h.calls, /^tab create/)).toBe(1)
    expect(count(h.calls, /^pane run/)).toBe(1)
    expect(occurrences(h.sessionFile(op.newSessionId), `[dori-msg:${op.seedId}]`)).toBe(1)
    const ids = h.sends.map((s) => s.id)
    expect(ids).toEqual(['d-error:g6', 'd-none:g6'])
    expect(readFileSync(join(h.home, 'lane-transitions.jsonl'), 'utf8').trim().split('\n').length).toBe(1)
    const e = readMap(h.home)[KEY]!
    expect([e.generation, (e.seed as any).state]).toEqual([6, 'applied'])
    const run2 = op.history.filter((x) => x.run === 2).map((x) => x.step)
    if (point === 'after-open') expect(run2).toEqual([8, 9, 10, 11])
    if (point === 'after-inventory') expect(run2[0]).toBe(5)
    if (point === 'before-close' || point === 'after-seed-send') expect(run2[0]).toBe(point === 'before-close' ? 6 : 7)
    expect(op.history.filter((x) => x.step === 6 || x.step === 7).length).toBe(2)
  })
}

test('seed unconfirmed: new tab closed, lease released, last 80 screen lines kept, lane closed, ask event', async () => {
  const h = harness({ seed: 'never' })
  const r = await T.startTransition(h.deps, args(h))
  expect([r.exit, r.out.error]).toEqual([1, 'seed_unconfirmed'])
  const op = T.readOp(h.home, r.out.opId as string)
  expect(op.status).toBe('failed')
  expect(op.screen!.length).toBe(80)
  expect(count(h.calls, new RegExp(`^tab close ${op.opened!.tab}$`))).toBe(1)
  expect(existsSync(join(h.home, 'lane-leases', KEY))).toBe(false)
  const e = readMap(h.home)[KEY]!
  expect([e.status, (e.seed as any).state]).toEqual(['closed', 'failed'])
  expect(h.sends.filter((s) => s.id === op.seedId).length).toBe(1)
  expect(readFileSync(join(h.home, 'events', 'registry.ndjson'), 'utf8')).toContain('lane.empty_after_handoff')
  expect((await T.resumeTransition(h.deps, op.opId)).exit).toBe(4)
})

test('dry plan reads only: argv for --account alt, no lease, no op, no map change', async () => {
  const h = harness()
  const before = readFileSync(join(h.home, 'sessions-map.json'), 'utf8')
  const r = await T.planTransition(h.deps, args(h, { account: 'alt', profile: 'default' }))
  expect(r.exit).toBe(0)
  const argv = r.out.argv as string[]
  expect(argv[argv.indexOf('--claude-account') + 1]).toBe('alt')
  expect((r.out.inventory as any).carried).toEqual(['d-error', 'd-none'])
  expect(readFileSync(join(h.home, 'sessions-map.json'), 'utf8')).toBe(before)
  expect(existsSync(join(h.home, 'ops'))).toBe(false)
  expect(existsSync(join(h.home, 'lane-leases', KEY))).toBe(false)
  expect(h.calls).toEqual([])
})
