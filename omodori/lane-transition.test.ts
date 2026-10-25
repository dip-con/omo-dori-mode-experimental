import { expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 's8-env-'))
process.env.REPLY_REFS_FILE = join(SCRATCH, 'reply-refs.json')
process.env.OWNER_FIX_FILE = join(SCRATCH, 'owner-fix.json')
process.env.WAKE_FILTER_LOG = join(SCRATCH, 'wake-filter.ndjson')
process.env.KKA_ARCHIVE_ROOT = join(SCRATCH, 'no-archive')
const T = await import('./lane-transition')
const { Queue } = await import('./kakao-queue')
const { acquireDirLock, readMap } = await import('./registry')
const P = await import('./kakao-push')

const FX = join(import.meta.dir, 'fixtures', 'transition')
const PROFILES = join(import.meta.dir, 'lane-profiles')
const OLD_ARGV: Record<string, { argv: string[]; env: Record<string, string> }> = JSON.parse(readFileSync(join(FX, 'old-argv.json'), 'utf8'))
const OLD = '0ld00000-0000-4000-8000-000000000001'
const KEY = 's8-test-a'
const GPT = 'chatgpt-subscription/gpt-6-astra'

const isSubsequence = (small: string[], big: string[]) => { let i = 0; for (const t of big) if (t === small[i]) i++; return i === small.length }
const profile = (n: string) => T.loadProfile(n, PROFILES)

function shellTokens(line: string): string[] {
  const out: string[] = []
  let cur = '', q = false, any = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (q) { if (c === "'") q = false; else cur += c; continue }
    if (c === "'") { q = true; any = true; continue }
    if (c === '\\' && line[i + 1] === "'") { cur += "'"; i++; continue }
    if (c === ' ') { if (cur || any) out.push(cur); cur = ''; any = false; continue }
    cur += c
  }
  if (cur || any) out.push(cur)
  return out
}

type SeedMode = 'persist' | 'manual' | 'never'
type HOpts = { seed?: SeedMode; children?: { state: string; running: number }; settled?: boolean[]; crash?: string; noEntry?: boolean; profileKey?: string }
function harness(o: HOpts = {}) {
  const home = mkdtempSync(join(tmpdir(), 's8-'))
  const sessions = join(home, 'sessions'); mkdirSync(sessions)
  const cwd = join(home, 'cwd'); mkdirSync(cwd)
  const oldPath = join(sessions, `${OLD}.jsonl`)
  copyFileSync(join(FX, 'old-session.jsonl'), oldPath)
  const key = o.profileKey ?? KEY
  if (!o.noEntry) {
    writeFileSync(join(home, 'sessions-map.json'), JSON.stringify({
      [key]: { key, label: 'S8 test', cwd, thread: null, workspace: 'w1', tab: 't-old', pane: 'p-old', sessionId: OLD, status: 'open', openedAt: '2026-10-23T08:00:00Z', generation: 5, sessionPath: oldPath, account: 'default' },
    }))
  }
  const calls: string[] = []
  const sends: { id: string; text: string }[] = []
  const panes = new Map<string, string[]>()
  let n = 0, waitIdleCalls = 0, statusCalls = 0
  const settled = [...(o.settled ?? [true])]
  const h = {
    home, cwd, oldPath, key, calls, sends, panes, crashPlan: o.crash ? [o.crash] : [] as string[], seed: o.seed ?? 'persist',
    get waitIdleCalls() { return waitIdleCalls }, get statusCalls() { return statusCalls },
    sessionFile: (id: string) => join(sessions, `${id}.jsonl`),
    writeSeed(id: string, artifact: string, message: string) {
      const f = h.sessionFile(id)
      const head = existsSync(f) ? '' : `${JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`
      writeFileSync(f, head + JSON.stringify({ type: 'message', id: `u${++n}`, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: `${readFileSync(artifact, 'utf8')}\n${message}` }] } }) + '\n', { flag: 'a' })
    },
    deps: null as any,
  }
  const deps: InstanceType<any> = {
    home, handoffsDir: join(home, 'handoffs'), briefsDir: join(home, 'briefs'), profilesDir: PROFILES,
    herdr: async (...args: string[]) => {
      calls.push(args.join(' '))
      if (args[0] === 'tab' && args[1] === 'create') { n++; return { result: { tab: { tab_id: `t-new${n}` }, root_pane: { pane_id: `p-new${n}` } } } }
      if (args[0] === 'tab' && args[1] === 'close') return null
      if (args[0] === 'pane' && args[1] === 'run') {
        const toks = shellTokens(args[3]!)
        const omo = toks.indexOf('omo')
        panes.set(args[2]!, ['bun', '/x/@code-yeongyu/senpi/dist/bundle/cli.js', '--extension', '/x/omo-ai/plugin', ...toks.slice(omo + 1)])
        const at = toks.find((t) => t.startsWith('@'))
        if (h.seed === 'persist' && at) h.writeSeed(toks[toks.indexOf('--session-id') + 1]!, at.slice(1), toks[toks.indexOf(at) + 1]!)
        return null
      }
      if (args[0] === 'pane' && args[1] === 'process-info') return { result: { process_info: { foreground_processes: panes.has(args[3]!) ? [{ pid: 4242, argv: panes.get(args[3]!) }] : [] } } }
      return null
    },
    herdrText: async (...args: string[]) => {
      calls.push(args.join(' '))
      return `${Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')}\n${'─'.repeat(20)}\n❯ \n${'─'.repeat(20)}\n`
    },
    workspaceFor: async () => 'w1',
    children: async () => o.children ?? { state: 'known', running: 0 },
    status: async () => { statusCalls++; return { settled: settled.length > 1 ? settled.shift()! : settled[0]!, status: 'idle' } },
    waitIdle: async () => { waitIdleCalls++ },
    findSession: (id: string) => (id === OLD ? oldPath : existsSync(h.sessionFile(id)) ? h.sessionFile(id) : null),
    send: async (e: any, text: string, id: string) => {
      sends.push({ id, text })
      if (h.seed === 'never') return { status: 'uncertain', reason: 'no_receipt' }
      const f = h.sessionFile(e.sessionId)
      writeFileSync(f, JSON.stringify({ type: 'custom_message', customType: 'session_control_delivery', content: `${text}\n\n[dandori-msg:${id}]`, details: { delivery_id: id }, timestamp: new Date().toISOString() }) + '\n', { flag: 'a' })
      return { status: 'delivered' }
    },
    sessionProcs: async () => [],
    runHook: async (argv: string[]) => { calls.push(`hook ${argv.join(' ')}`); return 0 },
    sleep: async () => {}, now: () => Date.now(), newId: () => crypto.randomUUID(), log: () => {},
    crash: (p: string) => { if (h.crashPlan[0] === p) { h.crashPlan.shift(); throw new T.TransitionCrash(p) } },
    readyTimeoutMs: 0, receiptWaitMs: 0, inflightWaitMs: 0, oldProcWaitMs: 0, accountWaitMs: 0,
  }
  h.deps = deps
  return h
}
const args = (h: ReturnType<typeof harness>, more: Partial<import('./lane-transition').Args> = {}) => ({ key: h.key, reason: 'manual' as const, profile: 'default', ...more })
const count = (calls: string[], re: RegExp) => calls.filter((c) => re.test(c)).length
const occurrences = (file: string, s: string) => readFileSync(file, 'utf8').split(s).length - 1
async function killLease(home: string, key: string) {
  const p = Bun.spawn(['true']); await p.exited
  const f = join(home, 'lane-leases', key, 'owner.json')
  const o = JSON.parse(readFileSync(f, 'utf8')); o.pid = p.pid
  writeFileSync(f, JSON.stringify(o))
}

test('argv: --account alt on the kakao-dandori-docs profile has --claude-account alt and the profile ext; old script argv is a subset', () => {
  for (const [key, old] of Object.entries(OLD_ARGV)) {
    const prof = profile(key)
    for (const account of [undefined, 'alt']) {
      const spec = T.sessionSpec(prof, undefined, { account })
      const argv = T.buildArgv({ key, sessionId: 'SID-1', ...spec, profile: prof })
      expect(isSubsequence(old.argv.map((t) => (t === '<SID>' ? 'SID-1' : t.replace(/^\/Users\/owner(?=\/)/, process.env.HOME!))), argv)).toBe(true)
      if (account) expect(argv.slice(argv.indexOf('--claude-account'), argv.indexOf('--claude-account') + 2)).toEqual(['--claude-account', 'alt'])
      else expect(argv).not.toContain('--claude-account')
    }
    expect(prof.noClaim).toBe(old.env.OMOMEOW_NO_CLAIM === '1')
  }
  const dd = T.buildArgv({ key: 'kakao-dandori-docs', sessionId: 'S', ...T.sessionSpec(profile('kakao-dandori-docs'), undefined, { account: 'alt' }), profile: profile('kakao-dandori-docs') })
  expect(dd.join(' ')).toMatch(/-e \S*kakao-dandori-docs-ext\.ts/)
  const jd = T.buildArgv({ key: 'kakao-family', sessionId: 'S', ...T.sessionSpec(profile('kakao-family'), undefined, { account: 'alt' }), profile: profile('kakao-family') })
  expect(jd[jd.indexOf('--tools') + 1]).toContain('kakao_send')
})

test('argv: GPT fallback has OMOMEOW_MODEL=chatgpt-subscription/gpt-6-astra, thinking high, no --claude-account', () => {
  const prof = profile('kakao-friend')
  const spec = T.sessionSpec(prof, { model: 'anthropic-subscription/claude-opus-5-5' } as any, { model: GPT, thinking: 'high' })
  const argv = T.buildArgv({ key: 'kakao-friend', sessionId: 'S', ...spec, profile: prof })
  expect(argv).toContain(`OMOMEOW_MODEL=${GPT}`)
  expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', GPT])
  expect(argv[argv.indexOf('--thinking') + 1]).toBe('high')
  expect(argv).not.toContain('--claude-account')
  expect(T.sessionSpec(prof, undefined, { model: GPT }).thinking).toBe('high')
  expect(() => T.sessionSpec(prof, undefined, { model: GPT, account: 'alt' })).toThrow()
})

test('argv: Claude return (lane on GPT, --account default) has --claude-account and the profile model', () => {
  const prof = profile('kakao-acme-docs')
  const spec = T.sessionSpec(prof, { model: GPT, thinking: 'high' } as any, { account: 'default' })
  const argv = T.buildArgv({ key: 'kakao-acme-docs', sessionId: 'S', ...spec, profile: prof })
  expect(spec.model).toBe(prof.model!)
  expect(argv.slice(argv.indexOf('--claude-account'), argv.indexOf('--claude-account') + 2)).toEqual(['--claude-account', 'default'])
  expect(argv[argv.indexOf('--thinking') + 1]).toBe('medium')
  const def = T.sessionSpec(profile('default'), { model: GPT } as any, { account: 'alt' })
  expect(def.model).toBe(T.DEFAULT_MODEL)
})

test('inventory: delivery + successful assistant -> processed; none after / only an error after -> carried; kakao uncertain w/o receipt -> carried, queued kept, receipt -> persisted', async () => {
  const inv = T.transcriptInventory(readFileSync(join(FX, 'old-session.jsonl'), 'utf8'))
  expect(inv.processed.map((d) => d.id)).toEqual(['d-processed', 'h-user', 'kakao:1:1'])
  expect(inv.unprocessed.map((d) => d.id)).toEqual(['d-error', 'd-none'])
  expect(inv.unprocessed[0]!.text).toBe('두 번째 요청: 견적서 만들어')

  const h = harness()
  const q = Queue.open(join(h.home, 'kakao-queue.sqlite'))
  const room = { chat: '1', pending: null, held: [], bursts: {}, nextSeq: 1 }
  const ids = q.commitFlush(room as any, [1, 2, 3].map((i) => ({ lane: KEY, part: 1, parts: 1, members: { logs: [`L${i}`], context: [] }, body: `b${i}` })))
  expect(ids).toEqual(['kakao:1:1', 'kakao:1:2', 'kakao:1:3'])
  q.markSending('kakao:1:1', { durableId: OLD, sessionPath: h.oldPath })
  q.markSending('kakao:1:2', { durableId: OLD, sessionPath: h.oldPath })
  q.markResult('kakao:1:2', 'uncertain', { transport: 'rpc', error: 'no_receipt' })
  q.close()
  const r = await T.startTransition(h.deps, args(h))
  expect(r.exit).toBe(0)
  const op = T.readOp(h.home, r.out.opId as string)
  expect(op.inventory!.carried.map((d) => d.id)).toEqual(['d-error', 'd-none'])
  expect(op.inventory!.kakao).toEqual({ persisted: ['kakao:1:1'], carried: ['kakao:1:2'], queued: ['kakao:1:3'] })
  const q2 = Queue.open(join(h.home, 'kakao-queue.sqlite'), { readonly: true })
  expect(q2.batch('kakao:1:1')!.state).toBe('persisted')
  expect(q2.batch('kakao:1:2')!.state).toBe('carried')
  expect(q2.batch('kakao:1:3')!.state).toBe('queued')
  q2.close()
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
  expect(occurrences(h.sessionFile(e.sessionId), `[dandori-msg:seed:${KEY}:6]`)).toBe(1)
  expect(existsSync(join(h.home, 'lane-leases', KEY))).toBe(false)
  expect(readFileSync(join(h.home, 'lane-migrations.jsonl'), 'utf8')).toContain(`"newKey":"${KEY}"`)
})

test('seed.state stays pending until the seed id is persisted, and the kakao worker sends nothing meanwhile', async () => {
  const h = harness({ seed: 'manual' })
  writeFileSync(join(h.home, 'live.ndjson'), '')
  const CHAT = '18000000000000001'
  const pushCalls: string[] = []
  const q = Queue.open(join(h.home, 'kakao-queue.sqlite'))
  let now = 1_000_000
  const push = P.createPush({
    home: h.home, log: join(h.home, 'live.ndjson'), rooms: { [CHAT]: { name: '[FX] 큰방', lane: KEY, owner: ['1'] } }, queue: q,
    sender: {
      transportFor: () => 'rpc', target: () => ({ durableId: 'x', sessionPath: null }), receipt: () => 'absent',
      send: async (_l: string, _b: string, id: string) => { pushCalls.push(id); return { status: 'delivered', transport: 'rpc' } },
    },
    decide: async () => true, out: () => {}, trace: () => {}, decisionLog: join(h.home, 'wf.ndjson'), startAtEnd: false, notes: () => '',
  } as any)
  const tick = async () => { for (let i = 0; i < 6; i++) { now += 3000; await push.step(now); await push.idle() } }
  let checked = false
  h.deps.onSeedWait = async () => {
    const e = readMap(h.home)[KEY]!
    expect((e.seed as any).state).toBe('pending')
    writeFileSync(join(h.home, 'live.ndjson'), `{"chat_id":${CHAT},"is_from_me":false,"log_id":3946370721884399001,"message_type":1,"sender":"fx","sender_id":9,"text":"안녕","timestamp":"2026-10-23T08:00:00Z","type":"message"}\n`)
    await tick()
    expect(pushCalls).toEqual([])
    const op = T.readOp(h.home, T.pendingOps(h.home, KEY)[0]!.opId)
    expect(existsSync(h.sessionFile(op.newSessionId))).toBe(false)
    h.writeSeed(op.newSessionId, op.artifact!, T.seedMessage(KEY, 6, op.seedId))
    checked = true
  }
  const r = await T.startTransition(h.deps, args(h))
  expect(r.exit).toBe(0)
  expect(checked).toBe(true)
  expect((readMap(h.home)[KEY]!.seed as any).state).toBe('applied')
  await tick()
  expect(pushCalls.length).toBe(1)
  q.close()
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
    expect(occurrences(h.sessionFile(op.newSessionId), `[dandori-msg:${op.seedId}]`)).toBe(1)
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

test('kakao profile on a temp lane: profile argv, noClaim artifact, beforeClose hook before the close', async () => {
  const h = harness({ profileKey: 's8-test-k' })
  const r = await T.startTransition(h.deps, { key: 's8-test-k', reason: 'quota', profile: 'kakao-dandori-docs', account: 'alt' })
  expect(r.exit).toBe(0)
  const argv = (r.out.argv as string[]).join(' ')
  expect(argv).toContain('--claude-account alt')
  expect(argv).toMatch(/kakao-dandori-docs-ext\.ts/)
  const op = T.readOp(h.home, r.out.opId as string)
  expect(readFileSync(op.artifact!, 'utf8')).not.toContain('dori claim-done')
  const hook = h.calls.findIndex((c) => c.startsWith('hook python3'))
  expect(hook).toBeGreaterThanOrEqual(0)
  expect(hook).toBeLessThan(h.calls.indexOf('tab close t-old'))
  expect(readMap(h.home)['s8-test-k']!.profile).toBe('kakao-dandori-docs')
})

test('lane missing from the registry opens fresh from the profile (dandori-docs first run)', async () => {
  const h = harness({ noEntry: true, profileKey: 'kakao-dandori-docs' })
  const r = await T.startTransition(h.deps, { key: 'kakao-dandori-docs', reason: 'reset', profile: 'kakao-dandori-docs', settleTimeoutMs: 0 })
  expect(r.exit).toBe(0)
  expect(count(h.calls, /^tab close/)).toBe(0)
  const e = readMap(h.home)['kakao-dandori-docs']!
  expect([e.generation, e.label, (e.seed as any).state]).toEqual([1, '리드방 장도리 문서', 'applied'])
})

test('dry plan reads only: argv for --account alt, no lease, no op, no map change', async () => {
  const h = harness()
  const before = readFileSync(join(h.home, 'sessions-map.json'), 'utf8')
  const r = await T.planTransition(h.deps, args(h, { account: 'alt', profile: 'kakao-dandori-docs' }))
  expect(r.exit).toBe(0)
  const argv = r.out.argv as string[]
  expect(argv[argv.indexOf('--claude-account') + 1]).toBe('alt')
  expect((r.out.inventory as any).carried).toEqual(['d-error', 'd-none'])
  expect(readFileSync(join(h.home, 'sessions-map.json'), 'utf8')).toBe(before)
  expect(existsSync(join(h.home, 'ops'))).toBe(false)
  expect(existsSync(join(h.home, 'lane-leases', KEY))).toBe(false)
  expect(h.calls).toEqual([])
})
