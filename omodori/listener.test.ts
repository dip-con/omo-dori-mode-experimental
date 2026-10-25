import { describe, expect, test } from 'bun:test'
import { type CatchUpState, CursorBook, catchUpChannel, collectMissed } from './listener'

// A fake Discord channel: GET /messages returns newest-first, at most `limit`, optionally only ids after `after`.
const fakeChannel = (ids: number[]) => {
  const calls: { limit: number; after?: string }[] = []
  const fetchPage = async (q: { limit: number; after?: string }) => {
    calls.push(q)
    const all = ids.map((n) => ({ id: String(n) })).sort((a, b) => Number(b.id) - Number(a.id))
    if (q.after === undefined) return all.slice(0, q.limit)
    // Discord's after= returns the `limit` messages immediately after the id (still newest-first).
    return all.filter((m) => BigInt(m.id) > BigInt(q.after!)).slice(-q.limit)
  }
  return { fetchPage, calls }
}
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

describe('collectMissed', () => {
  test('a gap larger than one page is paged in full, oldest first, never silently skipped', async () => {
    const ch = fakeChannel(range(900, 1300))
    const { messages, resumeAfter } = await collectMissed(ch.fetchPage, 1000n)
    expect(messages.map((m) => Number(m.id))).toEqual(range(1001, 1300))
    expect(resumeAfter).toBeNull()
  })

  test('a gap beyond the page bound returns the contiguous oldest part and where to resume', async () => {
    const ch = fakeChannel(range(1001, 2000))
    const { messages, resumeAfter } = await collectMissed(ch.fetchPage, 1000n, { maxPages: 3 })
    expect(messages.map((m) => Number(m.id))).toEqual(range(1001, 1300))
    expect(resumeAfter).toBe('1300')
  })

  test('the cursor inside the latest page needs one request', async () => {
    const ch = fakeChannel(range(990, 1010))
    const { messages, resumeAfter } = await collectMissed(ch.fetchPage, 1000n)
    expect(messages.map((m) => Number(m.id))).toEqual(range(1001, 1010))
    expect(resumeAfter).toBeNull()
    expect(ch.calls).toHaveLength(1)
  })

  test('a channel without a cursor only replays its latest page (first sight)', async () => {
    const ch = fakeChannel(range(1, 300))
    const { messages, resumeAfter } = await collectMissed(ch.fetchPage, null)
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.at(-1)!.id).toBe('300')
    expect(resumeAfter).toBeNull()
    expect(ch.calls).toHaveLength(1)
  })
})

describe('catchUpChannel', () => {
  // The verifier's repro: the owner's last message is 1000, then 600 bot messages. Bot messages are skipped by the
  // handler and never committed, so the book's cursor stays at 1000 for every periodic run.
  test('bot-only traffic past the page bound moves the catch-up forward and reports the gap once', async () => {
    const ch = fakeChannel(range(1000, 1600))
    const states = new Map<string, CatchUpState>()
    const gaps: string[] = []
    const requests: number[] = []
    for (let run = 0; run < 4; run++) {
      const before = ch.calls.length
      await catchUpChannel(ch.fetchPage, 1000n, states, 'c', async () => 'done', (gap) => gaps.push(gap))
      requests.push(ch.calls.length - before)
    }
    expect(gaps).toHaveLength(1)
    expect(states.get('c')!.seen).toBe(1600n)
    expect(requests.at(-1)).toBe(1)
  })

  test('a failed emit holds the position before it, and the next run retries it', async () => {
    const ch = fakeChannel(range(1001, 1010))
    const states = new Map<string, CatchUpState>()
    let failOnce = true
    const handled: number[] = []
    const handle = async (m: { id: string }) => {
      if (m.id === '1005' && failOnce) { failOnce = false; throw new Error('emit failed') }
      handled.push(Number(m.id))
      return 'done' as const
    }
    await expect(catchUpChannel(ch.fetchPage, 1000n, states, 'c', handle, () => {})).rejects.toThrow('emit failed')
    expect(states.get('c')!.seen).toBe(1004n)
    await catchUpChannel(ch.fetchPage, 1000n, states, 'c', handle, () => {})
    expect(handled).toEqual(range(1001, 1010))
    expect(states.get('c')!.seen).toBe(1010n)
  })

  test('a message left to the gateway is not passed over', async () => {
    const ch = fakeChannel(range(1001, 1010))
    const states = new Map<string, CatchUpState>()
    await catchUpChannel(ch.fetchPage, 1000n, states, 'c', async (m) => (Number(m.id) >= 1008 ? 'later' : 'done'), () => {})
    expect(states.get('c')!.seen).toBe(1007n)
  })

  test('a gap whose emit keeps failing is reported once, not every run', async () => {
    const ch = fakeChannel(range(1001, 1700))
    const states = new Map<string, CatchUpState>()
    const gaps: string[] = []
    const handle = async (m: { id: string }) => {
      if (m.id === '1001') throw new Error('emit failed')
      return 'done' as const
    }
    for (let run = 0; run < 3; run++) {
      await catchUpChannel(ch.fetchPage, 1000n, states, 'c', handle, (gap) => gaps.push(gap), { maxPages: 2 }).catch(() => {})
    }
    expect(gaps).toHaveLength(1)
    expect(states.get('c')!.seen).toBe(1000n)
  })
})

describe('CursorBook', () => {
  test('a live message committed mid catch-up does not drop older missed messages', () => {
    const book = new CursorBook(new Map([['c', 100n]]))
    expect(book.claim('c', '101')).toBe(true)
    book.commit('c', '101')
    // the gateway delivers 105 while catch-up is still emitting 102..104
    expect(book.claim('c', '105')).toBe(true)
    book.commit('c', '105')
    expect(book.claim('c', '102')).toBe(true)
    expect(book.cursors.get('c')).toBe(105n)
  })

  test('the cursor advances only after a successful emit; a failed emit can be retried', () => {
    const book = new CursorBook(new Map([['c', 100n]]))
    expect(book.claim('c', '101')).toBe(true)
    expect(book.cursors.get('c')).toBe(100n)
    book.release('101')
    expect(book.claim('c', '101')).toBe(true)
    book.commit('c', '101')
    expect(book.cursors.get('c')).toBe(101n)
  })

  test('duplicates and ids already emitted by an earlier run are rejected', () => {
    const book = new CursorBook(new Map([['c', 100n]]))
    expect(book.claim('c', '99')).toBe(false)
    expect(book.claim('c', '100')).toBe(false)
    expect(book.claim('c', '101')).toBe(true)
    expect(book.claim('c', '101')).toBe(false)
  })
})
