// The source contract end to end with a fake source that core has never heard of:
// manifest -> loadSource -> inbound -> common queue -> RPC delivery to the lane (fake omo endpoint, real rpc.ts) ->
// the lane's answer -> the source's send.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRpc, type MapEntry } from '../rpc'
import { SourceQueue } from '../source-queue'
import { checkSources, loadSource, manifestOf, sourceSettings } from '../sources'
import { DEFAULTS, type DoriConfig } from '../config'

const root = mkdtempSync(join(tmpdir(), 'source-contract-'))
const servers: Server[] = []
afterAll(() => { for (const s of servers) s.close(); rmSync(root, { recursive: true, force: true }) })

const SOURCES = join(root, 'sources')
mkdirSync(join(SOURCES, 'pigeon'), { recursive: true })
writeFileSync(join(SOURCES, 'pigeon', 'manifest.json'), JSON.stringify({
  name: 'pigeon', title: 'Pigeon', module: 'source.ts', lanePrefix: 'pigeon-',
  settings: [{ key: 'roost', kind: 'id', required: true }, { key: 'port', kind: 'port', default: 9 }],
  launchAgents: { 'pigeon-live': { args: ['{bun}', 'live.ts'], keepAlive: true, out: '{logs}/live.log' } }, defaultAgents: ['pigeon-live'],
}))
writeFileSync(join(SOURCES, 'pigeon', 'source.ts'), `
export const sent: { target: string; text: string }[] = []
export function inbound(raw: unknown) {
  if (typeof raw !== 'string' || !raw.startsWith('coo ')) return null
  const [, room, id, ...text] = raw.split(' ')
  return { source: 'pigeon', room, id, sender: 'u1', text: text.join(' '), at: '2026-10-25T00:00:0' + id + 'Z', lane: room === 'r1' ? 'pigeon-r1' : null }
}
export async function send(target: string, text: string) { sent.push({ target, text }); return { ok: true, id: 'm' + sent.length } }
`)

const DURABLE = '11111111-2222-4333-8444-555555555555'
const PROTOCOL = JSON.parse(readFileSync(join(import.meta.dir, '..', 'fixtures', 'rpc', 'protocol-info-tui.json'), 'utf8'))

async function fakeLane(): Promise<{ endpoints: string; sessions: string; sessionPath: string; frames: any[] }> {
  const endpoints = join(root, 'endpoints'), sessions = join(root, 'sessions')
  mkdirSync(join(endpoints, 'e1'), { recursive: true }); mkdirSync(join(sessions, 's'), { recursive: true })
  const socket = join(root, 't.sock'), secret = randomBytes(32)
  writeFileSync(`${socket}.secret`, secret)
  writeFileSync(join(endpoints, 'e1', 'endpoint.json'), JSON.stringify({ layout: 2, registry_version: 1, endpoint_kind: 'tui', socket, created_at: '2026-10-25T00:00:00Z' }))
  const sessionPath = join(sessions, 's', `2026-10-25T00-00-00-000Z_${DURABLE}.jsonl`)
  writeFileSync(sessionPath, `${JSON.stringify({ type: 'session', version: 3, id: DURABLE })}\n`)
  const frames: any[] = []
  const server = createServer((c) => {
    let authed = false, buf = Buffer.alloc(0)
    c.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      if (!authed) { if (buf.length < 32) return; if (!buf.subarray(0, 32).equals(secret)) { c.destroy(); return } authed = true; buf = buf.subarray(32) }
      let i: number
      while ((i = buf.indexOf(10)) >= 0) {
        const f = JSON.parse(buf.subarray(0, i).toString()); buf = buf.subarray(i + 1)
        frames.push(f)
        const ok = (data: any) => c.write(`${JSON.stringify({ id: f.id, type: 'response', command: f.type, success: true, data })}\n`)
        if (f.type === 'get_protocol_info') ok({ ...PROTOCOL, mode: 'tui', endpoint_kind: 'tui', instanceId: 'inst-tui' })
        else if (f.type === 'list_sessions') ok({ sessions: [{ sessionId: DURABLE, sessionPath, kind: 'interactive', surface: 'tui', attachments: 1 }] })
        else if (f.type === 'get_state') ok({ isStreaming: false, blocking_question: false })
        else if (['steer', 'follow_up', 'prompt'].includes(f.type)) {
          // The lane persists the delivery the way omo does: a custom_message carrying the delivery id.
          writeFileSync(sessionPath, `${JSON.stringify({ type: 'custom_message', customType: 'session_control_delivery', content: f.message ?? '', details: { delivery_id: f.clientMessageId }, timestamp: new Date().toISOString() })}\n`, { flag: 'a' })
          ok({ disposition: 'started' })
        }
      }
    })
    c.on('error', () => {})
  })
  await new Promise<void>((res) => server.listen(socket, res))
  servers.push(server)
  return { endpoints, sessions, sessionPath, frames }
}

const withPigeon = (settings: Record<string, unknown>): DoriConfig => ({ ...DEFAULTS, sources: [{ name: 'pigeon', settings }] })

test('the manifest alone tells core what the source needs: settings are checked by kind, unknown names are errors', () => {
  expect(manifestOf('pigeon', SOURCES)!.lanePrefix).toBe('pigeon-')
  expect(checkSources(withPigeon({ roost: '1234567' }), SOURCES).errors).toEqual([])
  expect(checkSources(withPigeon({}), SOURCES).errors).toEqual(['sources[0] pigeon.settings.roost is required'])
  expect(checkSources(withPigeon({ roost: 'abc' }), SOURCES).errors[0]).toContain('not a numeric id')
  expect(checkSources({ ...DEFAULTS, sources: [{ name: 'nope' }] }, SOURCES).errors[0]).toContain('no source folder sources/nope')
  expect(sourceSettings('pigeon', { roost: '', port: 9 }, withPigeon({ roost: '1234567' }))).toEqual({ roost: '1234567', port: 9 })
})

test('inbound -> common queue -> RPC delivery with receipt -> answer goes out through the source', async () => {
  const mod = await loadSource(manifestOf('pigeon', SOURCES)!)
  const q = SourceQueue.open(join(root, 'source-queue.sqlite'))
  expect(q.ingest(mod, 'coo r1 1 hello lane')).toMatchObject({ source: 'pigeon', room: 'r1', lane: 'pigeon-r1', text: 'hello lane' })
  expect(q.ingest(mod, 'not a message')).toBeNull()
  q.ingest(mod, 'coo r2 2 nobody routes this room')
  expect(q.ingest(mod, 'coo r1 1 hello lane')).not.toBeNull()
  expect(q.rows().map((r) => r.key)).toEqual(['pigeon:r1:1', 'pigeon:r2:2'])

  const lane = await fakeLane()
  const map: Record<string, MapEntry> = { 'pigeon-r1': { key: 'pigeon-r1', sessionId: DURABLE, status: 'open', pane: 'w:p1', cwd: root } }
  const rpc = createRpc({
    endpointsRoot: lane.endpoints, sessionsRoot: lane.sessions, loadMap: () => map,
    paneProcs: async () => [{ argv: ['bun', '/x/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js'] }],
    probeTimeoutMs: 500, requestTimeoutMs: 1000, receiptWaitMs: 2000, receiptPollMs: 10, laneStatus: () => null, agentStatus: async () => null,
  })
  const r = await q.pump((l, text, id) => rpc.send(l, text, { id }))
  expect(r).toEqual({ delivered: ['pigeon:r1:1'], refused: [], uncertain: [] })
  const steer = lane.frames.filter((f) => f.type === 'steer')
  expect(steer).toHaveLength(1)
  expect(steer[0]).toMatchObject({ clientMessageId: 'pigeon:r1:1' })
  expect(readFileSync(lane.sessionPath, 'utf8')).toContain('"delivery_id":"pigeon:r1:1"')
  expect(q.rows('done').map((x) => x.key)).toEqual(['pigeon:r1:1'])
  expect(q.rows('queued').map((x) => x.key)).toEqual(['pigeon:r2:2'])

  expect(await q.pump((l, text, id) => rpc.send(l, text, { id }))).toEqual({ delivered: [], refused: [], uncertain: [] })
  expect(lane.frames.filter((f) => f.type === 'steer')).toHaveLength(1)

  const { reply } = await import('../source-queue')
  expect(await reply(mod, 'r1', 'pong')).toEqual({ ok: true, id: 'm1' })
  expect((mod as any).sent).toEqual([{ target: 'r1', text: 'pong' }])
  q.close()
})

test('a refused delivery stays in the queue with its reason and is tried again', async () => {
  const mod = await loadSource(manifestOf('pigeon', SOURCES)!)
  const q = SourceQueue.open(join(root, 'refused.sqlite'))
  q.ingest(mod, 'coo r1 3 later')
  expect(await q.pump(async () => ({ status: 'refused', reason: 'turn_conflict' }))).toEqual({ delivered: [], refused: ['pigeon:r1:3'], uncertain: [] })
  expect(q.rows('refused')[0]).toMatchObject({ last_error: 'turn_conflict', attempts: 1 })
  expect((await q.pump(async () => ({ status: 'accepted' }))).delivered).toEqual(['pigeon:r1:3'])
  q.close()
})
