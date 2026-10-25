// Regression tests for the ledger lost-update race (2026-10-23): CLI "promise done" between a sweep's read and its
// write must survive. Every run uses a temp HOME/OMOCAT_HOME and a fake fetch (preload): no network, no real ledger.
// LEDGER_TS=<path> runs the same tests against another copy (used to show the pre-fix failure).
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LEDGER_TS = process.env.LEDGER_TS ?? join(import.meta.dir, 'ledger.ts')
const ROOT = mkdtempSync(join(tmpdir(), 'omocat-ledger-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
const H = 3600_000
const GENERAL = '1000000000000000001'
const snow = (ms: number) => ((BigInt(ms) - 1420070400000n) << 22n).toString()
let n = 0

function setup(promises: object[]) {
  const home = join(ROOT, `h${++n}`)
  const omocat = join(home, '.omocat')
  mkdirSync(join(home, '.config', 'agent-messenger'), { recursive: true })
  mkdirSync(omocat, { recursive: true })
  writeFileSync(join(home, '.config', 'agent-messenger', 'discordbot-credentials.json'), JSON.stringify({ bots: { omocat: { token: 'fake' } } }))
  const ledger = join(omocat, 'ledger.json')
  writeFileSync(ledger, JSON.stringify({ since: Date.now() - H, cursors: {}, promises, requests: [] }))
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, OMOCAT_HOME: omocat }
  delete env.DORI_LEDGER
  return { home, ledger, env, read: () => JSON.parse(readFileSync(ledger, 'utf8')) }
}

const promise = (id: string, extra: object = {}) =>
  ({ id, msgId: id, channel: GENERAL, text: `t ${id}`, phrase: '10시', due: Date.now() - H, status: 'open', fired: true, createdAt: Date.now() - 2 * H, ...extra })

const cli = async (env: Record<string, string | undefined>, ...args: string[]) => {
  const p = Bun.spawn(['bun', LEDGER_TS, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { stdout, stderr, code }
}

/** Fake Discord: /channels/ fetches announce SNAPSHOT_TAKEN on stderr, then block until a line arrives on stdin. */
function writePreload(home: string, botMsgId: string, botAt: number) {
  const file = join(home, 'fake-fetch.ts')
  writeFileSync(file, `
let gate: Promise<void> | undefined
globalThis.fetch = (async (url: any) => {
  const u = String(url)
  if (u.endsWith('/users/@me')) return Response.json({ id: 'BOT' })
  if (u.includes('/channels/')) {
    console.error('SNAPSHOT_TAKEN')
    gate ??= (async () => { for await (const _ of Bun.stdin.stream()) break })()
    await gate
    if (!u.includes('/channels/${GENERAL}/')) return Response.json([])
    return Response.json([{ id: '${botMsgId}', author: { id: 'BOT' }, content: '내일 10시에 다시 확인할게', timestamp: new Date(${botAt}).toISOString() }])
  }
  throw new Error('unexpected fetch ' + u)
}) as any
`)
  return file
}

async function waitForLine(stream: ReadableStream<Uint8Array>, needle: string, ms: number) {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no ${needle} within ${ms}ms; got: ${buf}`)), ms))
  const read = (async () => {
    while (!buf.includes(needle)) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`stream ended before ${needle}; got: ${buf}`)
      buf += dec.decode(value)
    }
  })()
  await Promise.race([read, timeout])
  reader.releaseLock()
}

test('promise done issued while a sweep is mid-flight survives the sweep write', async () => {
  const s = setup([promise('P1'), promise('P2')])
  const botAt = Date.now()
  const botMsgId = snow(botAt)
  const preload = writePreload(s.home, botMsgId, botAt)
  const sweep = Bun.spawn(['bun', '--preload', preload, LEDGER_TS, 'sweep'], { env: s.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  await waitForLine(sweep.stderr, 'SNAPSHOT_TAKEN', 15_000) // the sweep has read the ledger and is "working"

  const done = await cli(s.env, 'promise', 'done', 'P1')
  expect(done.code).toBe(0)
  expect(s.read().promises.find((p: any) => p.id === 'P1').status).toBe('done')

  sweep.stdin.write('go\n')
  sweep.stdin.end()
  expect(await sweep.exited).toBe(0)

  const after = s.read()
  expect(after.promises.find((p: any) => p.id === 'P1').status).toBe('done') // the lost update
  expect(after.promises.find((p: any) => p.id === 'P2').status).toBe('open')
  expect(after.promises.some((p: any) => p.id === `${botMsgId}.0`)).toBe(true) // the sweep's own change landed too
  expect(after.cursors[GENERAL]).toBe(botMsgId)
}, 30_000)

test('parallel CLI writes all survive', async () => {
  const ids = ['A', 'B', 'C', 'D', 'E', 'F']
  const s = setup(ids.map((id) => promise(id)))
  const res = await Promise.all(ids.map((id) => cli(s.env, 'promise', 'done', id)))
  expect(res.map((r) => r.code)).toEqual(ids.map(() => 0))
  expect(s.read().promises.map((p: any) => p.status)).toEqual(ids.map(() => 'done'))
}, 30_000)

test('--due HH:MM already past today means tomorrow at that time', async () => {
  const s = setup([])
  const now = Date.now()
  const past = new Date(now + 9 * H - 60_000) // one minute ago, KST wall clock
  const hhmm = past.toISOString().slice(11, 16)
  const r = await cli(s.env, 'promise', 'add', 'later', '--due', hhmm)
  expect(r.code).toBe(0)
  const p = s.read().promises[0]
  expect(p.due).toBeGreaterThan(now)
  expect(p.due - now).toBeLessThanOrEqual(24 * H)
  expect(new Date(p.due + 9 * H).toISOString().slice(11, 16)).toBe(hhmm)
  expect(r.stdout).toContain(`${hhmm} KST`)
})

test('--due HH:MM later today stays today', async () => {
  const s = setup([])
  const now = Date.now()
  const soon = new Date(now + 9 * H + 2 * 60_000)
  const hhmm = soon.toISOString().slice(11, 16)
  const r = await cli(s.env, 'promise', 'add', 'soon', '--due', hhmm)
  expect(r.code).toBe(0)
  const p = s.read().promises[0]
  expect(p.due).toBeGreaterThan(now)
  expect(p.due - now).toBeLessThanOrEqual(3 * 60_000)
})

test('invalid --due exits non-zero with a message and writes nothing', async () => {
  const s = setup([])
  for (const bad of ['25:00', '12:61', 'zz', '']) {
    const r = await cli(s.env, 'promise', 'add', 'x', '--due', bad)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('bad --due')
  }
  expect(s.read().promises).toEqual([])
})
