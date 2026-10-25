import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:net'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createRpc, lineProvesDelivery, receiptIn, type MapEntry, type RpcDeps } from './rpc'
import type { Deps as HerdrDeps, Proc } from './deliver'

const FIX = join(import.meta.dir, 'fixtures/rpc')
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8')
const PROTOCOL = JSON.parse(fixture('protocol-info-tui.json'))
const HOST_DURABLE = '11111111-2222-4333-8444-555555555555'
const CHILD_DURABLE = '99999999-2222-4333-8444-555555555555'
const OMO_PROCS: Proc[] = [{ argv: ['bun', '/x/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js'] }]
const SHELL_PROCS: Proc[] = [{ argv: ['-zsh'] }]

type Behavior = {
  kind: 'tui' | 'rpc_host'
  commands?: string[]
  steer?: (frame: any) => any | 'close'
  /** Question surface: get_state.blocking_question, get_messages, and the ids extension_ui_response can settle. */
  ui?: { blocking?: boolean; messages?: any[]; pending: string[] }
}
type Fake = { dir: string; server: Server; frames: any[]; sessionPath: string; childPath: string }

const roots: string[] = []
const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function workspace() {
  const root = `/tmp/omocat/rt-${randomBytes(4).toString('hex')}`
  mkdirSync(`${root}/endpoints`, { recursive: true }); mkdirSync(`${root}/sessions/s`, { recursive: true })
  roots.push(root)
  return root
}

async function fakeEndpoint(root: string, b: Behavior, opts: { wrongSecretFile?: boolean } = {}): Promise<Fake> {
  const dir = join(root, 'endpoints', randomBytes(8).toString('hex')); mkdirSync(dir)
  const socket = join(root, `${b.kind[0]}.sock`)
  const secret = randomBytes(32)
  writeFileSync(`${socket}.secret`, opts.wrongSecretFile ? randomBytes(32) : secret)
  writeFileSync(join(dir, 'endpoint.json'), JSON.stringify({ layout: 2, registry_version: 1, endpoint_kind: b.kind, socket, created_at: '2026-10-23T00:00:00Z' }))
  const sessionPath = join(root, 'sessions/s', `2026-10-23T00-00-00-000Z_${HOST_DURABLE}.jsonl`)
  const childPath = join(root, 'sessions/s', `2026-10-23T00-00-00-000Z_${CHILD_DURABLE}.jsonl`)
  writeFileSync(sessionPath, `${JSON.stringify({ type: 'session', version: 3, id: HOST_DURABLE })}\n`)
  writeFileSync(childPath, `${JSON.stringify({ type: 'session', version: 3, id: CHILD_DURABLE })}\n`)
  const hostRows = JSON.parse(fixture('list-sessions-host.json').replace('__SESSION_PATH__', sessionPath).replace('__CHILD_PATH__', childPath)).sessions
  const rows = b.kind === 'rpc_host' ? hostRows : [{ sessionId: HOST_DURABLE, sessionPath, kind: 'interactive', surface: 'tui', attachments: 1 }]
  const frames: any[] = []
  const server = createServer((c) => {
    let authed = false; let buf = Buffer.alloc(0)
    c.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      if (!authed) {
        if (buf.length < 32) return
        if (!buf.subarray(0, 32).equals(secret)) { c.destroy(); return }
        authed = true; buf = buf.subarray(32)
      }
      let i: number
      while ((i = buf.indexOf(10)) >= 0) {
        const f = JSON.parse(buf.subarray(0, i).toString()); buf = buf.subarray(i + 1)
        frames.push(f)
        const ok = (data: any) => c.write(`${JSON.stringify({ id: f.id, type: 'response', command: f.type, success: true, data })}\n`)
        if (f.type === 'get_protocol_info') ok({ ...PROTOCOL, mode: b.kind, endpoint_kind: b.kind, instanceId: `inst-${b.kind}`, commands: b.commands ?? PROTOCOL.commands })
        else if (f.type === 'list_sessions') ok({ sessions: rows })
        else if (f.type === 'get_state') ok({ isStreaming: true, blocking_question: b.ui?.blocking ?? false })
        else if (f.type === 'get_messages') ok({ messages: b.ui?.messages ?? [] })
        else if (f.type === 'subscribe') { (c as any).subscribed = true; ok({ cursor: 0 }) }
        else if (f.type === 'extension_ui_response') {
          const ui = b.ui!; const at = ui.pending.indexOf(f.uiRequestId)
          if (at < 0) { c.write(`${JSON.stringify({ id: f.id, type: 'response', command: f.type, success: false, error: 'unknown_request' })}\n`); continue }
          ui.pending.splice(at, 1)
          ok(undefined)
          if ((c as any).subscribed) c.write(`${JSON.stringify({ type: 'session_control_event', seq: 1, kind: 'question', data: { pending: [...ui.pending] } })}\n`)
        }
        else if (['steer', 'follow_up', 'prompt'].includes(f.type)) {
          const r = b.steer ? b.steer(f) : { success: true, data: { disposition: 'started' } }
          if (r === 'close') { c.destroy(); return }
          c.write(`${JSON.stringify({ id: f.id, type: 'response', command: f.type, ...r })}\n`)
        }
      }
    })
    c.on('error', () => {})
  })
  await new Promise<void>((res) => server.listen(socket, res))
  servers.push(server)
  return { dir, server, frames, sessionPath, childPath }
}

function deps(root: string, map: Record<string, MapEntry>, procs: Proc[] = OMO_PROCS): RpcDeps {
  return {
    endpointsRoot: join(root, 'endpoints'), sessionsRoot: join(root, 'sessions'), loadMap: () => map,
    paneProcs: async () => procs, probeTimeoutMs: 500, requestTimeoutMs: 1000, receiptWaitMs: 0, receiptPollMs: 10,
    laneStatus: () => null, agentStatus: async () => null,
  }
}
const lane = (key: string, status = 'open'): Record<string, MapEntry> => ({ [key]: { key, sessionId: HOST_DURABLE, status, pane: 'w:p1', cwd: '/tmp/omocat/rpc-fixture' } })
const steerFrames = (f: Fake) => f.frames.filter((x) => ['steer', 'follow_up', 'prompt'].includes(x.type))

function herdrMock() {
  let submitted = ''
  const calls = { submit: 0 }
  const d: HerdrDeps = {
    processes: async () => OMO_PROCS,
    screen: async () => `${'─'.repeat(20)}\n❯ \n${'─'.repeat(20)}`,
    submit: async (_p, text) => { calls.submit++; submitted = text },
    records: () => (submitted ? [JSON.stringify({ type: 'message', message: { role: 'user', content: submitted } })] : []),
    sleep: async () => {}, newId: () => 'herdr-id',
  }
  return { d, calls }
}

describe('resolve', () => {
  test('host fixture: durableId differs from the routing handle', async () => {
    const root = workspace()
    await fakeEndpoint(root, { kind: 'rpc_host' })
    const r = await createRpc(deps(root, lane('lane-h'))).resolve('lane-h')
    expect(r.durableId).toBe(HOST_DURABLE)
    expect(r.routing).toMatchObject({ sessionId: 'h-route-7f3a', instanceId: 'inst-rpc_host', kind: 'rpc_host' })
    expect(r.durableId).not.toBe(r.routing!.sessionId)
    expect(r.managed).toBe('lane')
    expect(r.sessionPath).toContain(HOST_DURABLE)
  })
  test('tui endpoint: one row, routing id equals durable id', async () => {
    const root = workspace()
    await fakeEndpoint(root, { kind: 'tui' })
    const r = await createRpc(deps(root, lane('lane-t'))).resolve('lane-t')
    expect(r.routing).toMatchObject({ kind: 'tui', sessionId: HOST_DURABLE, instanceId: 'inst-tui' })
    expect(r.fallback).toBeNull()
  })
})

describe('admission answers', () => {
  for (const [name, data] of [
    ['started', { disposition: 'started' }], ['queued', { disposition: 'queued' }],
    ['steered', { disposition: 'steered' }], ['duplicate', { disposition: 'queued', duplicate: true }],
  ] as const) {
    test(`${name} -> accepted, never delivered`, async () => {
      const root = workspace()
      const f = await fakeEndpoint(root, { kind: 'tui', steer: () => ({ success: true, data }) })
      const d = await createRpc(deps(root, lane('k'))).send('k', 'ping', { id: `id-${name}` })
      expect(d.status).toBe('accepted')
      expect(d.transport).toBe('rpc')
      expect(steerFrames(f)).toHaveLength(1)
      expect(steerFrames(f)[0]).toMatchObject({ type: 'steer', clientMessageId: `id-${name}`, whenIdle: 'start' })
    })
  }
  for (const code of ['held_draft', 'turn_conflict', 'unsupported_field', 'invalid_message', 'session_held']) {
    test(`${code} -> refused, no fallback`, async () => {
      const root = workspace()
      await fakeEndpoint(root, { kind: 'tui', steer: () => ({ success: false, error: `${code}: x`, errorCode: code }) })
      const d = await createRpc(deps(root, lane('k'))).send('k', 'ping', { id: `id-${code}` })
      expect(d).toMatchObject({ status: 'refused', reason: code, fallback: null })
    })
  }
})

describe('no endpoint -> herdr fallback only when nothing was sent', () => {
  test('socket ENOENT', async () => {
    const root = workspace()
    const f = await fakeEndpoint(root, { kind: 'tui' })
    f.server.close(); rmSync(JSON.parse(readFileSync(join(f.dir, 'endpoint.json'), 'utf8')).socket, { force: true })
    const rpc = createRpc(deps(root, lane('k')))
    expect(await rpc.send('k', 'ping', { id: 'e1' })).toMatchObject({ status: 'refused', reason: 'no_endpoint', fallback: 'herdr' })
    const h = herdrMock()
    const r = await rpc.dispatch({ ...lane('k').k!, pane: 'w:p1', cwd: '/tmp' }, 'ping', { id: 'e1', transport: 'rpc' }, h.d)
    expect(r).toMatchObject({ status: 'delivered', transport: 'herdr', rpcRefused: 'no_endpoint' })
    expect(h.calls.submit).toBe(1)
  })
  test('handshake failure (wrong secret)', async () => {
    const root = workspace()
    const f = await fakeEndpoint(root, { kind: 'tui' }, { wrongSecretFile: true })
    const d = await createRpc(deps(root, lane('k'))).send('k', 'ping', { id: 'e2' })
    expect(d).toMatchObject({ status: 'refused', reason: 'no_endpoint', fallback: 'herdr' })
    expect(steerFrames(f)).toHaveLength(0)
  })
  test('commands without steer', async () => {
    const root = workspace()
    const f = await fakeEndpoint(root, { kind: 'tui', commands: ['get_protocol_info', 'list_sessions', 'get_state'] })
    const d = await createRpc(deps(root, lane('k'))).send('k', 'ping', { id: 'e3' })
    expect(d).toMatchObject({ status: 'refused', reason: 'no_endpoint', fallback: 'herdr' })
    expect(steerFrames(f)).toHaveLength(0)
  })
  test('pane is not an omo process -> no fallback', async () => {
    const root = workspace()
    const d = await createRpc(deps(root, lane('k'), SHELL_PROCS)).send('k', 'ping', { id: 'e4' })
    expect(d).toMatchObject({ status: 'refused', reason: 'no_endpoint', fallback: null })
  })
})

test('socket closed after the request was written -> uncertain, herdr never submits', async () => {
  const root = workspace()
  const f = await fakeEndpoint(root, { kind: 'tui', steer: () => 'close' })
  const rpc = createRpc(deps(root, lane('k')))
  const h = herdrMock()
  const r = await rpc.dispatch({ ...lane('k').k!, pane: 'w:p1', cwd: '/tmp' }, 'ping', { id: 'u1', transport: 'rpc' }, h.d)
  expect(r.status).toBe('uncertain')
  expect(r.transport).toBe('rpc')
  expect(steerFrames(f)).toHaveLength(1)
  expect(h.calls.submit).toBe(0)
})

describe('receipt parser', () => {
  test('session_control_delivery custom_message line', () => {
    expect(receiptIn(JSON.stringify({ type: 'custom_message', customType: 'session_control_delivery', details: { delivery_id: 'abc-1' } }), 'abc-1')).toBe('persisted')
    const line = fixture('delivery-custom-message.jsonl').trim()
    expect(lineProvesDelivery(line, JSON.parse(line).details.delivery_id)).toBe(true)
  })
  test('user message carrying [dandori-msg:<id>]', () => {
    expect(receiptIn(fixture('herdr-user-tag.jsonl'), 'fixture-id-2')).toBe('persisted')
  })
  test('absent otherwise', () => {
    const line = fixture('delivery-custom-message.jsonl').trim()
    const id = JSON.parse(line).details.delivery_id
    expect(receiptIn(line, `${id}-other`)).toBe('absent')
    expect(receiptIn(JSON.stringify({ type: 'custom_message', customType: 'other', details: { delivery_id: 'abc-1' } }), 'abc-1')).toBe('absent')
    expect(receiptIn(JSON.stringify({ type: 'message', message: { role: 'assistant', content: '[dandori-msg:abc-1]' } }), 'abc-1')).toBe('absent')
    expect(receiptIn('', 'abc-1')).toBe('absent')
  })
})

test('an id already persisted performs no socket write', async () => {
  const root = workspace()
  const f = await fakeEndpoint(root, { kind: 'tui' })
  writeFileSync(f.sessionPath, `${JSON.stringify({ type: 'custom_message', customType: 'session_control_delivery', details: { delivery_id: 'p1' } })}\n`, { flag: 'a' })
  const before = f.frames.length
  const d = await createRpc(deps(root, lane('k'))).send('k', 'ping', { id: 'p1' })
  expect(d).toMatchObject({ status: 'delivered', disposition: 'already_persisted' })
  expect(f.frames.length).toBe(before)
  expect(steerFrames(f)).toHaveLength(0)
})

test('a persisted receipt during the wait -> delivered', async () => {
  const root = workspace()
  let path = ''
  const f = await fakeEndpoint(root, {
    kind: 'tui',
    steer: (fr) => { writeFileSync(path, `${JSON.stringify({ type: 'custom_message', customType: 'session_control_delivery', details: { delivery_id: fr.clientMessageId } })}\n`, { flag: 'a' }); return { success: true, data: { disposition: 'started' } } },
  })
  path = f.sessionPath
  const d = await createRpc({ ...deps(root, lane('k')), receiptWaitMs: 500 }).send('k', 'ping', { id: 'w1' })
  expect(d).toMatchObject({ status: 'delivered', disposition: 'started' })
  expect(d.sentTo.sessionPath).toBe(f.sessionPath)
})

describe('status / children (S5)', () => {
  const kids = (over: any = {}) => ({ state: 'known', running: 0, done: 2, failed: 0, dagRuns: [], ...over })
  const snapOf = (row: any, at = new Date().toISOString()) => ({ at, lanes: { k: { durableId: HOST_DURABLE, pane: 'w:p1', status: 'idle', settled: true, childrenIds: [], ...row } } })
  const rpcWith = (snap: any, herdr: string | null = 'idle') => createRpc({ ...deps(workspace(), lane('k')), laneStatus: () => snap, agentStatus: async () => herdr })

  test('a fresh snapshot exposes .children.state and settled', async () => {
    const s = await rpcWith(snapOf({ children: kids() })).status('k')
    expect(s).toMatchObject({ key: 'k', durableId: HOST_DURABLE, status: 'idle', settled: true, children: { state: 'known', running: 0 } })
    const c = await rpcWith(snapOf({ children: kids({ running: 1 }), settled: false, childrenIds: ['c1'] })).children('k')
    expect(c).toMatchObject({ state: 'known', running: 1, childrenIds: ['c1'], settled: false })
  })
  test('unknown children are never settled', async () => {
    const s = await rpcWith(snapOf({ children: kids({ state: 'unknown', reasons: ['dag_stale'] }), settled: false })).status('k')
    expect(s.children.state).toBe('unknown')
    expect(s.settled).toBe(false)
  })
  test('fail closed: no snapshot, a stale snapshot, a lane missing, or no children (no-children flag) -> unknown', async () => {
    expect((await rpcWith(null).status('k')).children).toMatchObject({ state: 'unknown', reasons: ['no_snapshot'] })
    const stale = await rpcWith(snapOf({ children: kids() }, new Date(Date.now() - 10 * 60_000).toISOString())).status('k')
    expect(stale.children).toMatchObject({ state: 'unknown', reasons: ['snapshot_stale'] })
    expect(stale.settled).toBe(false)
    expect((await rpcWith({ at: new Date().toISOString(), lanes: {} }).status('k')).children.reasons).toEqual(['lane_not_in_snapshot'])
    const flagged = await rpcWith(snapOf({})).status('k')
    expect(flagged.children).toMatchObject({ state: 'unknown', reasons: ['children_not_observed'] })
    expect(flagged.settled).toBe(false)
  })
  test('herdr working (in-process work RPC cannot see) only ever turns settled false', async () => {
    expect((await rpcWith(snapOf({ children: kids() }), 'working').status('k')).settled).toBe(false)
    expect((await rpcWith(snapOf({ children: kids(), settled: false, status: 'running' }), 'idle').status('k')).settled).toBe(false)
  })
})

describe('managed targets', () => {
  test('unmanaged (closed) and lead keys are refused', async () => {
    const root = workspace()
    const f = await fakeEndpoint(root, { kind: 'tui' })
    expect(await createRpc(deps(root, lane('k', 'closed'))).send('k', 'ping', { id: 'm1' })).toMatchObject({ status: 'refused', reason: 'unmanaged_target' })
    expect(await createRpc(deps(root, lane('dandori-lead-20261018'))).send('dandori-lead-20261018', 'ping', { id: 'm2' })).toMatchObject({ status: 'refused', reason: 'unmanaged_target' })
    expect(steerFrames(f)).toHaveLength(0)
  })
  test('child target needs childOk', async () => {
    const root = workspace()
    const f = await fakeEndpoint(root, { kind: 'rpc_host' })
    const rpc = createRpc(deps(root, lane('parent')))
    expect((await rpc.resolve(CHILD_DURABLE)).managed).toBe('child')
    expect(await rpc.send(CHILD_DURABLE, 'ping', { id: 'c1' })).toMatchObject({ status: 'refused', reason: 'child_target' })
    expect(steerFrames(f)).toHaveLength(0)
    expect(await rpc.send(CHILD_DURABLE, 'ping', { id: 'c2', childOk: true })).toMatchObject({ status: 'accepted' })
    expect(steerFrames(f)[0]).toMatchObject({ sessionId: 'h-route-child' })
  })
  test('--plan: a child listed in the supervisor snapshot is refused child_target; a lane is planned; nothing is written', async () => {
    const root = workspace()
    const f = await fakeEndpoint(root, { kind: 'tui' })
    const SNAP_CHILD = '77777777-2222-4333-8444-555555555555'
    const snap = { at: new Date().toISOString(), lanes: { parent: { durableId: HOST_DURABLE, status: 'idle', settled: true, childrenIds: [SNAP_CHILD], children: { state: 'known', running: 0, done: 1, failed: 0, dagRuns: [] } } } }
    const rpc = createRpc({ ...deps(root, lane('parent')), laneStatus: () => snap })
    expect((await rpc.resolve(SNAP_CHILD)).managed).toBe('child')
    expect(await rpc.send(SNAP_CHILD, 'x', { id: 'pl1', plan: true })).toMatchObject({ status: 'refused', reason: 'child_target' })
    expect(await rpc.send('parent', 'x', { id: 'pl2', plan: true })).toMatchObject({ status: 'planned' })
    expect(steerFrames(f)).toHaveLength(0)
  })
  test('slash commands are not sent', async () => {
    const root = workspace()
    await fakeEndpoint(root, { kind: 'tui' })
    expect(await createRpc(deps(root, lane('k'))).send('k', '/handoff', { id: 's1' })).toMatchObject({ status: 'refused', reason: 'invalid_target_text' })
  })
})

describe('answer', () => {
  const ask = (id: string, waitForAnswer: boolean) => ({
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'ask_user_question', arguments: { waitForAnswer, questions: [{ header: 'Pick', question: 'A or B?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] } }],
  })
  const uiFrames = (f: Fake) => f.frames.filter((x) => x.type === 'extension_ui_response')

  test('async question: option B is sent by uiRequestId and the question clears', async () => {
    const root = workspace()
    const f = await fakeEndpoint(root, { kind: 'tui', ui: { messages: [ask('toolu_old', false), ask('toolu_q', false)], pending: ['toolu_q'] } })
    const a = await createRpc(deps(root, lane('k'))).answer('k', { option: 'B' })
    expect(a).toMatchObject({ status: 'answered', requestId: 'toolu_q', questionId: 'q1', cleared: true })
    expect(uiFrames(f)).toEqual([expect.objectContaining({ uiRequestId: 'toolu_q', answers: { q1: { selected: ['B'] } } })])
  })
  test('free text goes in text with no selection', async () => {
    const root = workspace()
    const f = await fakeEndpoint(root, { kind: 'tui', ui: { messages: [ask('toolu_q', false)], pending: ['toolu_q'] } })
    expect(await createRpc(deps(root, lane('k'))).answer('k', { text: 'neither' })).toMatchObject({ status: 'answered' })
    expect(uiFrames(f)[0].answers).toEqual({ q1: { selected: [], text: 'neither' } })
  })
  for (const [name, ui, opts, reason, frames] of [
    ['no question asked', { messages: [], pending: [] }, { option: 'B' }, 'no_pending_question', 0],
    ['already settled', { messages: [ask('toolu_q', false)], pending: [] }, { option: 'B' }, 'no_pending_question', 1],
    ['id mismatch', { messages: [ask('toolu_q', false)], pending: ['toolu_q'] }, { option: 'B', questionId: 'toolu_other' }, 'question_id_mismatch', 0],
    ['unknown option', { messages: [ask('toolu_q', false)], pending: ['toolu_q'] }, { option: 'C' }, 'unknown_option', 0],
    ['blocking (waitForAnswer:true) question', { blocking: true, messages: [ask('toolu_q', true)], pending: [] }, { option: 'B' }, 'blocking_question_unsupported', 0],
  ] as const) {
    test(`${name} -> refused ${reason}`, async () => {
      const root = workspace()
      const f = await fakeEndpoint(root, { kind: 'tui', ui: { ...ui, messages: [...ui.messages], pending: [...ui.pending] } })
      expect(await createRpc(deps(root, lane('k'))).answer('k', opts)).toMatchObject({ status: 'refused', reason })
      expect(uiFrames(f)).toHaveLength(frames)
    })
  }
})
