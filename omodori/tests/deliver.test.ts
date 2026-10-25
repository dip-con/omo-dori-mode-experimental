import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { type Deps, type Proc, checkPane, deliver, inputReady, recordHasTag, tagMessage } from '../deliver'

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8')
const READY = fx('omo-input-ready.txt')
const OMO: Proc[] = JSON.parse(fx('omo-procs.json'))
const SHELL: Proc[] = [{ argv: ['-zsh'], name: 'zsh' }]
const record = (text: string, role = 'user') => JSON.stringify({ type: 'message', message: { role, content: [{ type: 'text', text }] } })

describe('checkPane', () => {
  test('a live OMO with its input box is ready', () => {
    expect(inputReady(READY)).toBe(true)
    expect(checkPane(OMO, READY)).toEqual({ ok: true })
  })
  test('refuses a shell', () => {
    expect(checkPane(SHELL, READY)).toMatchObject({ ok: false, reason: expect.stringContaining('no live OMO') })
  })
  test('refuses an open question UI', () => {
    expect(checkPane(OMO, fx('omo-screen-single.txt'))).toMatchObject({ ok: false, reason: expect.stringContaining('question') })
  })
  test('refuses the init-deep startup screen', () => {
    expect(checkPane(OMO, 'Init-deep\n Skip this time\n')).toMatchObject({ ok: false, reason: expect.stringContaining('startup') })
  })
  test('refuses when the input box is not on screen', () => {
    expect(checkPane(OMO, 'some program output\n$ ')).toMatchObject({ ok: false, reason: expect.stringContaining('input box') })
  })
})

describe('recordHasTag', () => {
  test('matches only a user message that carries the exact tag', () => {
    const msg = tagMessage('hello', 'abc')
    expect(recordHasTag(record(msg), 'abc')).toBe(true)
    expect(recordHasTag(record(msg, 'assistant'), 'abc')).toBe(false)
    expect(recordHasTag(record(tagMessage('hello', 'abd')), 'abc')).toBe(false)
    expect(recordHasTag('{"type":"message"', 'abc')).toBe(false)
  })
})

const fakeDeps = (over: Partial<Deps> & { log?: string[] }): Deps & { sent: string[] } => {
  const sent: string[] = []
  return {
    processes: async () => OMO, screen: async () => READY,
    submit: async (_p, t) => { sent.push(t) }, records: () => [], sleep: async () => {}, newId: () => 'id1', ...over, sent,
  } as Deps & { sent: string[] }
}
const target = { pane: 'w1:p1', cwd: '/tmp/x', sessionId: 's1' }

describe('deliver', () => {
  test('refused sends nothing', async () => {
    const d = fakeDeps({ processes: async () => SHELL })
    const r = await deliver(d, target, 'hi')
    expect(r.status).toBe('refused')
    expect(d.sent).toEqual([])
  })
  test('delivered only after the session record shows the tagged message', async () => {
    let calls = 0
    const d = fakeDeps({ records: () => (++calls < 3 ? [] : [record(tagMessage('hi', 'id1'))]) })
    const r = await deliver(d, target, 'hi', { timeoutMs: 10, pollMs: 1 })
    expect(r).toMatchObject({ status: 'delivered', id: 'id1' })
    expect(d.sent).toEqual([tagMessage('hi', 'id1')])
  })
  test('no record within the window is pending and is submitted exactly once', async () => {
    const d = fakeDeps({})
    const r = await deliver(d, target, 'hi', { timeoutMs: 5, pollMs: 1 })
    expect(r.status).toBe('pending')
    expect(r.reason).toContain('do not resend')
    expect(d.sent.length).toBe(1)
  })
})
