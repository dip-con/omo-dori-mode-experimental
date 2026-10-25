// The lane transition with the KakaoTalk source enabled: its lane profiles and its transition hook (kakao-queue).
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 's8-env-'))
process.env.REPLY_REFS_FILE = join(SCRATCH, 'reply-refs.json')
process.env.OWNER_FIX_FILE = join(SCRATCH, 'owner-fix.json')
process.env.WAKE_FILTER_LOG = join(SCRATCH, 'wake-filter.ndjson')
process.env.KKA_ARCHIVE_ROOT = join(SCRATCH, 'no-archive')
const { GPT, KEY, OLD, T, args, count, harness } = await import('../../../core/tests/transition-harness')
const { readMap } = await import('../../../core/registry')
const { Queue } = await import('../kakao-queue')
const P = await import('../kakao-push')

const PROFILES = join(import.meta.dir, '..', 'lane-profiles')
const DIRS = [join(import.meta.dir, '..', '..', '..', 'core', 'lane-profiles'), PROFILES]
const profile = (n: string) => T.loadProfile(n, DIRS)
const kh = (o?: Parameters<typeof harness>[0]) => { const h = harness(o); h.deps.profilesDir = DIRS; return h }

test('inventory: kakao uncertain w/o receipt -> carried, queued kept, receipt -> persisted (source transition hook)', async () => {
  const h = kh()
  writeFileSync(h.oldPath, readFileSync(h.oldPath, 'utf8').replaceAll('src:1:1', 'kakao:1:1'))
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
  expect(op.inventory!.sources.kakao).toEqual({ persisted: ['kakao:1:1'], carried: ['kakao:1:2'], queued: ['kakao:1:3'] })
  const q2 = Queue.open(join(h.home, 'kakao-queue.sqlite'), { readonly: true })
  expect(q2.batch('kakao:1:1')!.state).toBe('persisted')
  expect(q2.batch('kakao:1:2')!.state).toBe('carried')
  expect(q2.batch('kakao:1:3')!.state).toBe('queued')
  q2.close()
  const ledger = readFileSync(join(h.home, 'lane-transitions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  expect(ledger[0].sources.kakao).toEqual({ persisted: ['kakao:1:1'], carried: ['kakao:1:2'], queued: ['kakao:1:3'] })
})

test('argv: the example kakao profiles expand {install}/{home}, keep their tool allowlist, add --claude-account only when asked', () => {
  for (const key of ['kakao-chat', 'kakao-docs']) {
    const prof = profile(key)
    for (const account of [undefined, 'alt']) {
      const argv = T.buildArgv({ key, sessionId: 'SID-1', ...T.sessionSpec(prof, undefined, { account }), profile: prof })
      expect(argv.join(' ')).not.toMatch(/\{(home|install)\}/)
      expect(argv.join(' ')).toMatch(/-e \S*\/kakao-lane-ext\.ts/)
      expect(argv[argv.indexOf('--tools') + 1]).toBe(prof.tools!)
      if (account) expect(argv.slice(argv.indexOf('--claude-account'), argv.indexOf('--claude-account') + 2)).toEqual(['--claude-account', 'alt'])
      else expect(argv).not.toContain('--claude-account')
    }
    expect(prof.noClaim).toBe(true)
  }
})

test('argv: GPT fallback has OMODORI_MODEL=chatgpt-subscription/gpt-6-astra, thinking high, no --claude-account', () => {
  const prof = profile('kakao-chat')
  const spec = T.sessionSpec(prof, { model: 'anthropic-subscription/claude-opus-5-5' } as any, { model: GPT, thinking: 'high' })
  const argv = T.buildArgv({ key: 'kakao-chat', sessionId: 'S', ...spec, profile: prof })
  expect(argv).toContain(`OMODORI_MODEL=${GPT}`)
  expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', GPT])
  expect(argv[argv.indexOf('--thinking') + 1]).toBe('high')
  expect(argv).not.toContain('--claude-account')
  expect(T.sessionSpec(prof, undefined, { model: GPT }).thinking).toBe('high')
  expect(() => T.sessionSpec(prof, undefined, { model: GPT, account: 'alt' })).toThrow()
})

test('argv: Claude return (lane on GPT, --account default) has --claude-account and the profile model', () => {
  const prof = profile('kakao-docs')
  const spec = T.sessionSpec(prof, { model: GPT, thinking: 'high' } as any, { account: 'default' })
  const argv = T.buildArgv({ key: 'kakao-docs', sessionId: 'S', ...spec, profile: prof })
  expect(spec.model).toBe(prof.model!)
  expect(argv.slice(argv.indexOf('--claude-account'), argv.indexOf('--claude-account') + 2)).toEqual(['--claude-account', 'default'])
  expect(argv[argv.indexOf('--thinking') + 1]).toBe('medium')
  const def = T.sessionSpec(profile('default'), { model: GPT } as any, { account: 'alt' })
  expect(def.model).toBe(T.DEFAULT_MODEL)
})

test('seed.state stays pending until the seed id is persisted, and the kakao worker sends nothing meanwhile', async () => {
  const h = kh({ seed: 'manual' })
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

test('kakao profile on a temp lane: profile argv, noClaim artifact, beforeClose hook before the close', async () => {
  const h = kh({ profileKey: 's8-test-k' })
  const dir = mkdtempSync(join(tmpdir(), 's8-profiles-'))
  writeFileSync(join(dir, 'kakao-hooked.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(PROFILES, 'kakao-docs.json'), 'utf8')), beforeClose: [['python3', '/tmp/index.py']] }))
  h.deps.profilesDir = dir
  const r = await T.startTransition(h.deps, { key: 's8-test-k', reason: 'quota', profile: 'kakao-hooked', account: 'alt' })
  expect(r.exit).toBe(0)
  const argv = (r.out.argv as string[]).join(' ')
  expect(argv).toContain('--claude-account alt')
  expect(argv).toMatch(/kakao-lane-ext\.ts/)
  const op = T.readOp(h.home, r.out.opId as string)
  expect(readFileSync(op.artifact!, 'utf8')).not.toContain('dori claim-done')
  const hook = h.calls.findIndex((c) => c.startsWith('hook python3'))
  expect(hook).toBeGreaterThanOrEqual(0)
  expect(hook).toBeLessThan(h.calls.indexOf('tab close t-old'))
  expect(readMap(h.home)['s8-test-k']!.profile).toBe('kakao-hooked')
})

test('lane missing from the registry opens fresh from the profile (first run)', async () => {
  const h = kh({ noEntry: true, profileKey: 'kakao-docs' })
  const r = await T.startTransition(h.deps, { key: 'kakao-docs', reason: 'reset', profile: 'kakao-docs', settleTimeoutMs: 0 })
  expect(r.exit).toBe(0)
  expect(count(h.calls, /^tab close/)).toBe(0)
  const e = readMap(h.home)['kakao-docs']!
  expect([e.generation, e.label, (e.seed as any).state]).toEqual([1, 'kakao-docs', 'applied'])
})

