import { expect, test } from 'bun:test'
import { accountStates, classify, GPT_FALLBACK, normStatus } from './lane-classify'

const NOW = Date.parse('2026-10-23T09:00:00.000Z')
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()
const delivery = (minAgo: number, id = `d${minAgo}`) =>
  JSON.stringify({ type: 'custom_message', customType: 'session_control_delivery', content: `hi\n\n[dandori-msg:${id}]`, details: { delivery_id: id }, id: `e${id}`, timestamp: at(minAgo) })
const ok = (minAgo: number, provider = 'anthropic-subscription') =>
  JSON.stringify({ type: 'message', timestamp: at(minAgo), message: { role: 'assistant', stopReason: 'stop', provider, content: [{ type: 'text', text: 'done' }] } })
const err = (minAgo: number, text: string, provider = 'anthropic-subscription') =>
  JSON.stringify({ type: 'message', timestamp: at(minAgo), message: { role: 'assistant', stopReason: 'error', provider, errorMessage: text, content: [] } })
const jsonl = (...l: string[]) => l.join('\n') + '\n'

const win = (used: number, resetMin = 120) => [{ label: '5h', usedPercent: used, resetsAt: new Date(NOW + resetMin * 60_000).toISOString() }, { label: '7d', usedPercent: Math.min(used, 50), resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() }]
const usage = (o: Record<string, { used: number; ageMin?: number; resetMin?: number } | undefined>) => ({
  accounts: Object.fromEntries(Object.entries(o).filter(([, v]) => v).map(([k, v]) => [`anthropic-subscription/${k}`, { updatedAt: NOW - (v!.ageMin ?? 1) * 60_000, windows: win(v!.used, v!.resetMin) }])),
})
const auth = (names = ['default', 'alt', 'work']) => ({ 'anthropic-subscription': { accounts: names.map((name) => ({ name })) } })
const QUOTA_ERR = 'You have hit your session limit (429). Resets 11:00'
const base = { status: 'idle', model: 'anthropic-subscription/claude-opus-5-5', account: 'default', now: NOW }

test('account missing from auth.json -> not a candidate', () => {
  const c = classify({ ...base, transcript: jsonl(delivery(30), ok(29), delivery(5), err(4, QUOTA_ERR)), usage: usage({ default: { used: 100 }, alt: { used: 0 }, work: { used: 40 } }), auth: auth(['default', 'work']) })
  expect(c.accounts.find((a) => a.name === 'alt')!.present).toBe(false)
  expect(c.verdict).toBe('quota')
  expect(c.target).toBe('work')
})

test('usage updatedAt 40 min old -> not a candidate + lane.usage_stale', () => {
  const c = classify({ ...base, transcript: jsonl(delivery(30), ok(29), delivery(5), err(4, QUOTA_ERR)), usage: usage({ default: { used: 100 }, alt: { used: 0, ageMin: 40 }, work: { used: 30 } }), auth: auth() })
  expect(c.accounts.find((a) => a.name === 'alt')!.usageFresh).toBe(false)
  expect(c.target).toBe('work')
  expect(c.events.some((e) => e.kind === 'lane.usage_stale' && (e.data as any).account === 'alt')).toBe(true)
})

test('missing usage file -> unknown, never "all accounts free" and never quota_all', () => {
  const c = classify({ ...base, transcript: jsonl(delivery(30), ok(29), delivery(5), err(4, QUOTA_ERR)), usage: null, auth: auth() })
  expect(c.verdict).toBe('unknown')
  expect(c.target).toBeUndefined()
  expect(c.action).toBe('ask')
})

test('all usage stale -> unknown (not quota_all, no target)', () => {
  const c = classify({ ...base, transcript: jsonl(delivery(30), ok(29), delivery(5), err(4, QUOTA_ERR)), usage: usage({ default: { used: 100, ageMin: 50 }, alt: { used: 100, ageMin: 50 }, work: { used: 100, ageMin: 50 } }), auth: auth() })
  expect(c.verdict).toBe('unknown')
  expect(c.events.filter((e) => e.kind === 'lane.usage_stale').length).toBe(3)
})

test('error entry before any assistant success (pre-assistant) -> credential_error / ask', () => {
  const c = classify({ ...base, transcript: jsonl(delivery(15), err(14, 'Request failed: fetch failed')), usage: usage({ default: { used: 10 }, alt: { used: 0 }, work: { used: 0 } }), auth: auth() })
  expect(c.verdict).toBe('credential_error')
  expect(c.action).toBe('ask')
  expect(c.detail).toContain('pre-assistant')
})

test('running lane with an old error entry followed by a success -> ok', () => {
  const c = classify({ ...base, status: 'running', lastWriteAt: NOW - 30_000, transcript: jsonl(delivery(60), ok(59), delivery(40), err(39, QUOTA_ERR), delivery(10), ok(1)), usage: usage({ default: { used: 100 }, alt: { used: 0 }, work: { used: 0 } }), auth: auth() })
  expect(c.credential).toBe('ok')
  expect(c.verdict).toBe('ok')
  expect(c.progress).toBe('turn_running')
})

test('herdr "working" reads as the snapshot\'s running', () => {
  expect(normStatus('working')).toBe('running')
  expect(normStatus(null)).toBe('unknown')
})

test('all three accounts full -> quota_all with resetAt (soonest reset)', () => {
  const c = classify({ ...base, transcript: jsonl(delivery(30), ok(29), delivery(5), err(4, QUOTA_ERR)), usage: usage({ default: { used: 100, resetMin: 300 }, alt: { used: 100, resetMin: 90 }, work: { used: 100, resetMin: 200 } }), auth: auth() })
  expect(c.verdict).toBe('quota_all')
  expect(c.resetAt).toBe(NOW + 90 * 60_000)
  expect(c.target).toBe(GPT_FALLBACK.model)
})

test('chatgpt-subscription 429 -> provider_error, no Claude rotation', () => {
  const c = classify({ ...base, model: 'chatgpt-subscription/gpt-6-astra', account: null, transcript: jsonl(delivery(30), ok(29, 'chatgpt-subscription'), delivery(5), err(4, 'HTTP 429 insufficient credit', 'chatgpt-subscription')), usage: usage({ default: { used: 0 }, alt: { used: 0 }, work: { used: 0 } }), auth: auth() })
  expect(c.verdict).toBe('provider_error')
  expect(c.target).toBeUndefined()
  expect(c.provider).toBe('chatgpt-subscription')
})

test('only one Claude account blocked -> not a stall: the lane on it moves, a lane on another account stays ok', () => {
  const u = usage({ default: { used: 100 }, alt: { used: 5 }, work: { used: 60 } })
  const onBlocked = classify({ ...base, transcript: jsonl(delivery(30), ok(29), delivery(5), err(4, QUOTA_ERR)), usage: u, auth: auth() })
  expect(onBlocked.verdict).toBe('quota')
  expect(onBlocked.target).toBe('alt')
  const other = classify({ ...base, account: 'alt', transcript: jsonl(delivery(30), ok(29)), usage: u, auth: auth() })
  expect(other.verdict).toBe('ok')
})

test('auth blockedUntil counts as full', () => {
  const a = accountStates(usage({ default: { used: 0 }, alt: { used: 0 }, work: { used: 0 } }), { 'anthropic-subscription': { accounts: [{ name: 'default', blockedUntil: NOW + 3_600_000 }, { name: 'alt' }, { name: 'work' }] } }, NOW)
  expect(a.find((x) => x.name === 'default')!.full).toBe(true)
  expect(a.find((x) => x.name === 'default')!.resetAt).toBe(NOW + 3_600_000)
})

test('first input with no assistant entry for 10+ min -> first_input_pending / ask; idle lane with unanswered delivery past stallMin -> stalled', () => {
  const p = classify({ ...base, transcript: jsonl(delivery(12)), usage: usage({ default: { used: 0 } }), auth: auth() })
  expect(p.verdict).toBe('first_input_pending')
  const s = classify({ ...base, transcript: jsonl(delivery(60), ok(59), delivery(30)), usage: usage({ default: { used: 0 } }), auth: auth() })
  expect(s.verdict).toBe('stalled')
  expect(s.progress).toBe('no_progress')
})
