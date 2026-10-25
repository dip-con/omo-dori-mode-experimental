// post() regression tests: fake HOME (fake bot credentials) + fake fetch, so nothing reaches Discord.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

type Sent = { url: string; body: { content: string; nonce?: string; enforce_nonce?: boolean; allowed_mentions?: unknown } }
type Reply = { status: number; body: unknown } | Error

const realFetch = globalThis.fetch
const realHome = process.env.HOME
const home = mkdtempSync(`${tmpdir()}/dori-lib-test-`)
let sent: Sent[] = []
let replies: Reply[] = []
let post: (channel: string, text: string) => Promise<string[]>

beforeAll(async () => {
  mkdirSync(`${home}/.config/agent-messenger`, { recursive: true })
  writeFileSync(`${home}/.config/agent-messenger/discordbot-credentials.json`, JSON.stringify({ bots: { omocat: { token: 'fake-test-token' } } }))
  process.env.HOME = home
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) })
    const r = replies.shift() ?? { status: 200, body: { id: `m${sent.length}` } }
    if (r instanceof Error) throw r
    return new Response(JSON.stringify(r.body), { status: r.status })
  }) as typeof fetch
  const lib = await import('./dori-lib')
  lib.postBackoff.baseMs = 0
  post = lib.post
})
afterAll(() => {
  globalThis.fetch = realFetch
  process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})
beforeEach(() => { sent = []; replies = [] })

const contents = () => sent.map((s) => s.body.content)
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

test('short text is one message with mentions disabled', async () => {
  expect(await post('C1', 'hello')).toEqual(['m1'])
  expect(sent).toHaveLength(1)
  expect(sent[0].url).toBe('https://discord.com/api/v10/channels/C1/messages')
  expect(sent[0].body.content).toBe('hello')
  expect(sent[0].body.allowed_mentions).toEqual({ parse: [] })
})

test('a single line longer than the limit is split into <=2000-char, non-empty chunks that rejoin losslessly', async () => {
  const text = `${'a'.repeat(4500)}\nshort tail`
  await post('C1', text)
  for (const c of contents()) { expect(c.length).toBeGreaterThan(0); expect(c.length).toBeLessThanOrEqual(2000) }
  expect(contents().join('').replace(/\n/g, '')).toBe(text.replace(/\n/g, ''))
})

test('long words split at a space, not mid-word', async () => {
  const text = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ')
  await post('C1', text)
  expect(sent.length).toBeGreaterThan(1)
  for (const c of contents()) { expect(c.length).toBeLessThanOrEqual(2000); expect(c.startsWith(' ')).toBe(false) }
  expect(contents().join(' ')).toBe(text)
})

test('a code fence cut by a split is closed and reopened with its language', async () => {
  const body = Array.from({ length: 300 }, (_, i) => `const line${i} = ${i}`).join('\n')
  await post('C1', `log:\n\`\`\`ts\n${body}\n\`\`\`\nend`)
  expect(sent.length).toBeGreaterThan(1)
  for (const c of contents()) {
    expect(c.length).toBeLessThanOrEqual(2000)
    expect((c.match(/^```/gm) ?? []).length % 2).toBe(0)
  }
  expect(contents()[1].startsWith('```ts\n')).toBe(true)
})

test('a hard split never cuts a surrogate pair', async () => {
  await post('C1', '😀'.repeat(1500))
  expect(sent.length).toBeGreaterThan(1)
  for (const c of contents()) { expect(c.length).toBeLessThanOrEqual(2000); expect(LONE_SURROGATE.test(c)).toBe(false) }
  expect(contents().join('')).toBe('😀'.repeat(1500))
})

test('every chunk carries its own nonce with enforce_nonce', async () => {
  await post('C1', 'x'.repeat(4500))
  const nonces = sent.map((s) => s.body.nonce)
  for (const s of sent) { expect(s.body.enforce_nonce).toBe(true); expect(String(s.body.nonce).length).toBeLessThanOrEqual(25) }
  expect(new Set(nonces).size).toBe(sent.length)
})

test('429 is retried with the same nonce', async () => {
  replies = [{ status: 429, body: { message: 'rate limited', retry_after: 0 } }]
  expect(await post('C1', 'hi')).toEqual(['m2'])
  expect(sent).toHaveLength(2)
  expect(sent[1].body.nonce).toBe(sent[0].body.nonce)
})

test('5xx and a thrown fetch are retried (nonce makes the replay safe)', async () => {
  replies = [{ status: 502, body: { message: 'bad gateway' } }, new Error('socket hang up')]
  expect(await post('C1', 'hi')).toEqual(['m3'])
  expect(sent).toHaveLength(3)
  expect(new Set(sent.map((s) => s.body.nonce)).size).toBe(1)
})

test('4xx other than 429 is not retried and throws', async () => {
  replies = [{ status: 403, body: { message: 'Missing Access' } }]
  await expect(post('C1', 'hi')).rejects.toThrow('discord post 403 Missing Access')
  expect(sent).toHaveLength(1)
})

test('retries are bounded', async () => {
  replies = Array.from({ length: 10 }, () => ({ status: 500, body: { message: 'boom' } }))
  await expect(post('C1', 'hi')).rejects.toThrow('discord post 500')
  expect(sent.length).toBeLessThanOrEqual(4)
})

test('secrets are redacted before send', async () => {
  const ghp = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')
  await post('C1', `leak ${ghp} 비밀번호 확인`)
  expect(sent[0].body.content).toBe('leak [REDACTED] 비밀번호 확인')
})
