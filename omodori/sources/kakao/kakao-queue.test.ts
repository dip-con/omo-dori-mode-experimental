import { expect, test } from 'bun:test'
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CrashError, idsOf, oldestOpen, Queue, replayLegacy, type Batch } from './kakao-queue'
import { queueStall } from './kakao-stall'
import { roomName } from './kakao-lane-ext'

const FX = join(import.meta.dir, 'fixtures', 'kakao')
const tmp = () => mkdtempSync(join(tmpdir(), 'kq-unit-'))
const line = (chat: string, log: string, text: string) =>
  `{"chat_id":${chat},"is_from_me":false,"log_id":${log},"message_type":1,"sender":"fx","sender_id":7,"text":${JSON.stringify(text)},"timestamp":"2026-10-23T08:00:00Z","type":"message"}`

test('schema: the four tables, 0600, WAL', () => {
  const d = tmp(); const p = join(d, 'q.sqlite')
  const q = Queue.open(p)
  const tables = (q.db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
  expect(tables).toEqual(['batches', 'cursor', 'intake', 'room_state'])
  expect((q.db.query('PRAGMA journal_mode').get() as any).journal_mode).toBe('wal')
  q.close()
  expect(statSync(p).mode & 0o777).toBe(0o600)
})

test('(g) chat_id/log_id above 2^53 round-trip as identical strings; a partial last line is not taken', () => {
  const d = tmp(); const log = join(d, 'live.ndjson')
  copyFileSync(join(FX, 'big-ids.ndjson'), log)
  const q = Queue.open(join(d, 'q.sqlite'))
  expect(q.ingest(log, { startAtEnd: false }).inserted).toBe(3)
  const rows = q.newIntake()
  expect(rows.map((r) => [r.chat_id, r.log_id])).toEqual([
    ['18000000000000001', '3946370721884362755'], ['480000000000001', '3946370721884362756'], ['18000000000000001', '9223372036854775807'],
  ])
  expect(Number(rows[0]!.chat_id) > Number.MAX_SAFE_INTEGER).toBe(true)
  const text = readFileSync(log, 'utf8')
  expect(q.cursor()!.offset).toBe(Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)))
  expect(idsOf(rows[2]!.raw)).toEqual({ chat: '18000000000000001', log: '9223372036854775807' })
  const id = q.commitFlush({ chat: rows[0]!.chat_id, pending: null, held: [], bursts: {}, nextSeq: 1 }, [{ lane: 'l', part: 1, parts: 1, members: { logs: [rows[2]!.log_id], context: [], omitted: 0 }, body: 'b' }])[0]!
  expect(id).toBe('kakao:18000000000000001:1')
  expect(JSON.parse(q.batch(id)!.members_json).logs).toEqual(['9223372036854775807'])
  q.close()
})

test('first start puts the cursor at the end; later starts resume from the stored cursor', () => {
  const d = tmp(); const log = join(d, 'live.ndjson'); const p = join(d, 'q.sqlite')
  const half = line('1', '11', 'new')
  writeFileSync(log, `${line('1', '9', 'older')}\n${line('1', '10', 'old')}\n${half.slice(0, 30)}`)
  let q = Queue.open(p)
  expect(q.ingest(log).reset).toBe('first-start-at-end')
  q.close(); q = Queue.open(p)
  expect(q.ingest(log)).toEqual({ inserted: 0, reset: null })
  appendFileSync(log, half.slice(30) + '\n')
  q.close(); q = Queue.open(p)
  expect(q.ingest(log)).toEqual({ inserted: 1, reset: null })
  expect(q.newIntake().map((r) => r.log_id)).toEqual(['11'])
  q.close()
})

test('a crash inside the intake transaction leaves no row and no cursor move', () => {
  const d = tmp(); const log = join(d, 'live.ndjson'); const p = join(d, 'q.sqlite')
  writeFileSync(log, `${line('1', '1', 'a')}\n${line('1', '2', 'b')}\n`)
  let crashed = false
  let q = Queue.open(p, { crash: (pt) => { if (pt === 'intake:inserted' && !crashed) { crashed = true; throw new CrashError(pt) } } })
  expect(() => q.ingest(log, { startAtEnd: false })).toThrow(CrashError)
  expect(q.newIntake()).toEqual([])
  expect(q.cursor()).toBeNull()
  q.close(); q = Queue.open(p)
  expect(q.ingest(log, { startAtEnd: false }).inserted).toBe(2)
  q.close()
})

test('rename+recreate and truncate start the new generation at 0; replayed lines are ignored by the key', () => {
  const d = tmp(); const log = join(d, 'live.ndjson'); const p = join(d, 'q.sqlite')
  writeFileSync(log, `${line('1', '1', 'a')}\n${line('1', '2', 'b')}\n`)
  const q = Queue.open(p)
  q.ingest(log, { startAtEnd: false })
  renameSync(log, `${log}.1`)
  writeFileSync(log, `${line('1', '2', 'b')}\n${line('1', '3', 'c')}\n`)
  expect(q.ingest(log)).toEqual({ inserted: 1, reset: 'inode' })
  writeFileSync(log, `${line('1', '3', 'c')}\n`)
  expect(q.ingest(log)).toEqual({ inserted: 0, reset: 'truncated' })
  appendFileSync(log, `${line('1', '4', 'd')}\n`)
  expect(q.ingest(log).inserted).toBe(1)
  expect(q.newIntake().map((r) => r.log_id)).toEqual(['1', '2', '3', '4'])
  q.close()
})

test('(d) the stored cursor never passes the first member line of a batch that is not persisted', () => {
  const d = tmp(); const log = join(d, 'live.ndjson'); const p = join(d, 'q.sqlite')
  const lines = [line('5', '1', 'a'), line('5', '2', 'b'), line('5', '3', 'c')]
  writeFileSync(log, lines.join('\n') + '\n')
  let q = Queue.open(p)
  q.ingest(log, { startAtEnd: false })
  const id = q.commitFlush({ chat: '5', pending: null, held: [], bursts: {}, nextSeq: 1 }, [{ lane: 'l', part: 1, parts: 1, members: { logs: ['2', '3'], context: [], omitted: 0 }, body: 'x' }])[0]!
  appendFileSync(log, line('5', '4', 'd') + '\n')
  q.ingest(log)
  const off2 = Buffer.byteLength(lines[0]! + '\n')
  expect(q.cursor()!.offset).toBe(off2)
  q.close(); q = Queue.open(p)
  expect(q.ingest(log).inserted).toBe(0)
  q.markPersisted(id)
  q.ingest(log)
  expect(q.cursor()!.offset).toBe(statSync(log).size)
  q.close()
})

test('(j) replay-legacy drains queued/refused/carried/uncertain-without-receipt in order through the old send, exactly once', async () => {
  const d = tmp(); const q = Queue.open(join(d, 'q.sqlite'))
  const mk = (chat: string, lane: string, n: number) => q.commitFlush({ chat, pending: null, held: [], bursts: {}, nextSeq: 1 },
    Array.from({ length: n }, (_, i) => ({ lane, part: i + 1, parts: n, members: { logs: [`${i}`], context: [], omitted: 0 }, body: `${lane} body ${i}` })))
  const a = mk('100', 'kakao-a', 3)
  const b = mk('200', 'kakao-b', 2)
  q.markPersisted(a[0]!)
  q.markResult(a[1]!, 'uncertain', { transport: 'rpc', sentTo: { durableId: 'x', sessionPath: '/s/a' } })
  q.markResult(a[2]!, 'carried')
  q.markResult(b[0]!, 'uncertain', { transport: 'rpc', sentTo: { durableId: 'y', sessionPath: '/s/b' } })
  q.markResult(b[1]!, 'refused', { error: 'turn_conflict' })
  const disk = new Set([b[0]!])
  const calls: string[][] = []
  let refuseOnce = true
  const res = await replayLegacy(q, {
    send: async (lane, body, id) => {
      calls.push(['bun', 'sess.ts', 'send', lane, '--id', id, body])
      if (id === a[2] && refuseOnce) { refuseOnce = false; return 4 }
      disk.add(id); return 0
    },
    receipt: (bt: Batch) => (disk.has(bt.id) ? 'persisted' : 'absent'),
    sleep: async () => {}, log: () => {},
  })
  expect(calls.map((c) => c[5])).toEqual([a[1], a[2], b[1], a[2]])
  expect(calls[0]!.slice(0, 4)).toEqual(['bun', 'sess.ts', 'send', 'kakao-a'])
  expect(res.sent).toEqual([a[1], b[1], a[2]])
  expect(q.openBatches()).toEqual([])
  expect(q.counts()).toEqual({ persisted: 5 })
  q.close()
})

test('replay-legacy waits out a pending (exit 3) send and never repeats it while the receipt can still land', async () => {
  const d = tmp(); const q = Queue.open(join(d, 'q.sqlite'))
  const [id] = q.commitFlush({ chat: '1', pending: null, held: [], bursts: {}, nextSeq: 1 }, [{ lane: 'k', part: 1, parts: 1, members: {}, body: 'b' }])
  let t = 0, sends = 0, landed = false
  await replayLegacy(q, {
    send: async () => { sends++; return 3 },
    receipt: () => (landed ? 'persisted' : 'absent'),
    sleep: async (ms) => { t += ms; if (t > 60_000) landed = true },
    log: () => {}, now: () => t,
  }, { pendingGraceMs: 10 * 60_000 })
  expect(sends).toBe(1)
  expect(q.batch(id!)!.state).toBe('persisted')
  q.close()
})

test('kakao-stall: an open batch older than the limit is a push stall', () => {
  const d = tmp(); const p = join(d, 'q.sqlite'); const q = Queue.open(p)
  expect(oldestOpen(p)).toBeNull()
  q.commitFlush({ chat: '1', pending: null, held: [], bursts: {}, nextSeq: 1 }, [{ lane: 'kakao-x', part: 1, parts: 1, members: {}, body: 'b' }])
  const o = oldestOpen(p)!
  expect(o.id).toBe('kakao:1:1')
  expect(queueStall(o, o.createdAt + 10 * 60_000, 30)).toBeNull()
  expect(queueStall(o, o.createdAt + 31 * 60_000, 30)).toContain('batch kakao:1:1 (kakao-x, queued) not persisted for 31m')
  q.close()
})

test('(h) kakao-lane-ext room(): OMODORI_LANE_KEY + sa-cache/room.<lane> -> that chat; unset -> legacy file; OMODORI_ROOM still wins', () => {
  const d = tmp()
  const rooms = JSON.parse(readFileSync(join(FX, 'rooms.json'), 'utf8'))
  writeFileSync(join(d, 'room.kakao-fx-a'), '18000000000000001\n')
  writeFileSync(join(d, 'active-room'), '[FX] 둘째방')
  expect(roomName({ OMODORI_LANE_KEY: 'kakao-fx-a' }, d, rooms)).toBe('[FX] 큰방')
  expect(roomName({}, d, rooms)).toBe('[FX] 둘째방')
  expect(roomName({ OMODORI_LANE_KEY: 'kakao-fx-b' }, d, rooms)).toBe('[FX] 둘째방')
  expect(roomName({ OMODORI_LANE_KEY: 'kakao-fx-a', OMODORI_ROOM: '[FX] 핀방' }, d, rooms)).toBe('[FX] 핀방')
})
