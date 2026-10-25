// Kakao delivery queue (redesign S7, docs/dori-redesign/final.md §2.7). The one writer is kakao-push.ts; everyone else
// reads with `sqlite3 -readonly`. Crash boundaries are transactions:
//   intake      complete live.ndjson lines + cursor advance in one transaction (a partial last line never moves the cursor)
//   room_state  pending / held / burst per chat, saved on every change and restored on start
//   batches     flush = pending cleared + batch rows inserted + next_seq advanced in one transaction
// Ids (chat_id, log_id) are cut from the raw line with a regex before any JSON.parse: they exceed 2^53.
//   bun kakao-queue.ts init                         create the schema (0600, WAL); reads no log
//   bun kakao-queue.ts status [--json]              batch counts per state, cursor, oldest open batch (read-only)
//   bun kakao-queue.ts replay-legacy [--lane L] [--dry]
//       rollback drain: queued/refused/carried and accepted/uncertain-without-receipt batches go out in order through the
//       old path (`bun sess.ts send <lane> --id <batch id> <body>`), each marked persisted on exit 0. Run it with
//       flags/kakao.pause-admission set and no batch in 'accepted', before reverting kakao-push.ts.
// OMOCAT_HOME (default ~/.omocat) roots the database; tests point it at a temp dir.
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const omocat = () => process.env.OMOCAT_HOME ?? `${process.env.HOME}/.omocat`
export const queuePath = (home = omocat()) => join(home, 'kakao-queue.sqlite')

export type BatchState = 'queued' | 'accepted' | 'uncertain' | 'persisted' | 'refused' | 'carried'
/** Not yet proven delivered. 'refused' = the last attempt sent nothing; it is retried with the same id, never dropped. */
export const OPEN_STATES: BatchState[] = ['queued', 'accepted', 'uncertain', 'refused', 'carried']
export type SentTo = { durableId: string | null; sessionPath: string | null; instanceId?: string | null; generation?: number | null }
export type Batch = {
  id: string; chat_id: string; lane: string; seq: number; part: number; parts: number; members_json: string; body: string
  state: BatchState; transport: 'rpc' | 'herdr' | null; sent_to_json: string | null; attempts: number; last_error: string | null
  created_at: string; persisted_at: string | null
}
export type PLine = { log: string; text: string; sender: string; isOwner: boolean; wake?: boolean }
export type HeldLine = { log: string; text: string }
export type BurstItem = { log: string; raw: string; who: string; text: string; gate: 'called' | 'continued' | null; sender: string; isOwner: boolean }
export type BurstGroup = { items: BurstItem[]; first: number; last: number; unfinished: boolean; now: boolean }
export type RoomState = {
  chat: string; pending: { first: number; last: number; lines: PLine[] } | null; held: HeldLine[]
  bursts: Record<string, BurstGroup>; nextSeq: number
}
export type NewBatch = { lane: string; part: number; parts: number; members: unknown; body: string }

/** Test hook: thrown at a named point to stand in for the process being killed there. */
export class CrashError extends Error { constructor(readonly point: string) { super(`crash at ${point}`) } }
export type Crash = (point: string) => void

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intake(chat_id TEXT, log_id TEXT, raw TEXT, ingested_at TEXT, stage TEXT NOT NULL DEFAULT 'new',
  log_ino INTEGER, log_off INTEGER, PRIMARY KEY(chat_id, log_id));
CREATE TABLE IF NOT EXISTS cursor(id INTEGER PRIMARY KEY CHECK(id=1), log_ino INTEGER, log_offset INTEGER, updated_at TEXT);
CREATE TABLE IF NOT EXISTS room_state(chat_id TEXT PRIMARY KEY, pending_json TEXT, held_json TEXT, burst_json TEXT,
  next_seq INTEGER NOT NULL DEFAULT 1, updated_at TEXT);
CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, chat_id TEXT, lane TEXT, seq INTEGER, part INTEGER, parts INTEGER,
  members_json TEXT, body TEXT,
  state TEXT CHECK(state IN ('queued','accepted','uncertain','persisted','refused','carried')),
  transport TEXT, sent_to_json TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT, persisted_at TEXT);
CREATE INDEX IF NOT EXISTS intake_stage ON intake(stage);
CREATE INDEX IF NOT EXISTS batches_state ON batches(state);
`
const CHAT = /"chat_id"\s*:\s*"?(\d+)/
const LOGID = /"log_id"\s*:\s*"?(\d+)/
export const idsOf = (line: string) => ({
  chat: CHAT.exec(line)?.[1] ?? '',
  log: LOGID.exec(line)?.[1] ?? `h:${createHash('sha1').update(line).digest('hex').slice(0, 20)}`,
})
const iso = () => new Date().toISOString()

export class Queue {
  private readPos: { ino: number; offset: number } | null = null
  private constructor(readonly db: Database, readonly path: string, private crash: Crash) {}

  static open(path = queuePath(), opts: { crash?: Crash; readonly?: boolean } = {}): Queue {
    if (opts.readonly) return new Queue(new Database(path, { readonly: true }), path, () => {})
    mkdirSync(dirname(path), { recursive: true })
    const fresh = !existsSync(path)
    const db = new Database(path, { create: true })
    if (fresh) chmodSync(path, 0o600)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;')
    db.exec(SCHEMA)
    return new Queue(db, path, opts.crash ?? (() => {}))
  }
  close() { this.db.close() }

  cursor(): { ino: number; offset: number } | null {
    const r = this.db.query('SELECT log_ino, log_offset FROM cursor WHERE id=1').get() as { log_ino: number; log_offset: number } | null
    return r ? { ino: r.log_ino, offset: r.log_offset } : null
  }
  private setCursor(ino: number, offset: number) {
    this.db.query('INSERT INTO cursor(id, log_ino, log_offset, updated_at) VALUES(1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET log_ino=excluded.log_ino, log_offset=excluded.log_offset, updated_at=excluded.updated_at')
      .run(ino, offset, iso())
  }

  /**
   * Reads complete lines from the read position on. No cursor row yet: the cursor is put at the current end (first start
   * only), unless startAtEnd is false. Another inode or a file shorter than the position starts the new generation at 0;
   * lines seen before are ignored by the primary key. The stored cursor never passes the first log line of a batch that
   * is not persisted (in this log generation), so a restart re-reads from there; the re-read rows are ignored.
   */
  ingest(log: string, opts: { startAtEnd?: boolean } = {}): { inserted: number; reset: string | null } {
    if (!existsSync(log)) return { inserted: 0, reset: null }
    const fd = openSync(log, 'r')
    try {
      const st = fstatSync(fd)
      const ino = Number(st.ino), size = st.size
      const cur = this.cursor()
      if (!cur && opts.startAtEnd !== false) {
        // Anchor at the end of the last complete line, and record that line (stage pre-start, never delivered) so the
        // rewrite check below recognises this position on the next start.
        const len = Math.min(size, 64 * 1024)
        const tail = Buffer.alloc(len)
        if (len) readSync(fd, tail, 0, len, size - len)
        const end = tail.lastIndexOf(0x0a)
        const anchor = end < 0 ? (len < size ? size : 0) : size - len + end + 1
        this.db.transaction(() => {
          if (end >= 0) {
            const start = tail.lastIndexOf(0x0a, end - 1) + 1
            const text = tail.subarray(start, end).toString('utf8')
            const { chat, log: id } = idsOf(text)
            this.db.query("INSERT INTO intake(chat_id, log_id, raw, ingested_at, stage, log_ino, log_off) VALUES(?, ?, ?, ?, 'pre-start', ?, ?) ON CONFLICT(chat_id, log_id) DO UPDATE SET log_ino=excluded.log_ino, log_off=excluded.log_off")
              .run(chat, id, text, iso(), ino, size - len + start)
          }
          this.setCursor(ino, anchor)
        })()
        this.readPos = { ino, offset: anchor }
        return { inserted: 0, reset: 'first-start-at-end' }
      }
      const pos = this.readPos?.ino === ino ? this.readPos : cur ? { ino: cur.ino, offset: cur.offset } : { ino, offset: 0 }
      let offset = 0, reset: string | null = null
      if (pos.ino !== ino) reset = 'inode'
      else if (size < pos.offset) reset = 'truncated'
      else if (!this.lineBeforeKnown(fd, ino, pos.offset)) reset = 'rewritten'
      else offset = pos.offset
      const buf = Buffer.alloc(Math.max(0, size - offset))
      if (buf.length) readSync(fd, buf, 0, buf.length, offset)
      const end = buf.lastIndexOf(0x0a)
      const next = end < 0 ? offset : offset + end + 1
      const lines: { text: string; off: number }[] = []
      if (end >= 0) {
        let start = 0
        for (const text of buf.subarray(0, end).toString('utf8').split('\n')) {
          lines.push({ text, off: offset + start })
          start += Buffer.byteLength(text) + 1
        }
      }
      const ins = this.db.query("INSERT OR IGNORE INTO intake(chat_id, log_id, raw, ingested_at, stage, log_ino, log_off) VALUES(?, ?, ?, ?, 'new', ?, ?)")
      const moved = this.db.query('UPDATE intake SET log_ino=?, log_off=? WHERE chat_id=? AND log_id=?')
      let inserted = 0
      this.db.transaction(() => {
        const at = iso()
        for (const l of lines) {
          if (!l.text.trim()) continue
          const { chat, log: id } = idsOf(l.text)
          const n = ins.run(chat, id, l.text, at, ino, l.off).changes
          if (n) inserted += n
          else moved.run(ino, l.off, chat, id)
        }
        if (lines.length) this.crash('intake:inserted')
        const safe = Math.min(next, this.firstOpenOffset(ino) ?? next)
        if (!cur || cur.ino !== ino || cur.offset !== safe) this.setCursor(ino, safe)
      })()
      this.readPos = { ino, offset: next }
      return { inserted, reset }
    } finally { closeSync(fd) }
  }

  // A file truncated and regrown past the cursor between two reads keeps its inode and is not shorter: the line that
  // ends at the cursor must still be the intake row recorded at that offset, or the generation is new.
  private lineBeforeKnown(fd: number, ino: number, offset: number): boolean {
    if (offset <= 0) return true
    const len = Math.min(offset, 64 * 1024)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, offset - len)
    if (buf[len - 1] !== 0x0a) return false
    const start = buf.lastIndexOf(0x0a, len - 2) + 1
    if (start === 0 && len < offset) return true
    const text = buf.subarray(start, len - 1).toString('utf8')
    if (!text.trim()) return true
    const { chat, log } = idsOf(text)
    const r = this.db.query('SELECT log_ino, log_off FROM intake WHERE chat_id=? AND log_id=?').get(chat, log) as { log_ino: number; log_off: number } | null
    return !!r && r.log_ino === ino && r.log_off === offset - len + start
  }

  /** Byte offset (in log generation `ino`) of the earliest member line of any batch not yet persisted. */
  firstOpenOffset(ino: number): number | null {
    const off = this.db.query('SELECT log_off FROM intake WHERE chat_id=? AND log_id=? AND log_ino=?')
    let min: number | null = null
    for (const b of this.openBatches()) {
      const m = JSON.parse(b.members_json) as { logs?: string[]; context?: string[] }
      for (const id of [...(m.logs ?? []), ...(m.context ?? [])]) {
        const r = off.get(b.chat_id, id, ino) as { log_off: number } | null
        if (r && (min === null || r.log_off < min)) min = r.log_off
      }
    }
    return min
  }

  newIntake(): { chat_id: string; log_id: string; raw: string }[] {
    return this.db.query("SELECT chat_id, log_id, raw FROM intake WHERE stage='new' ORDER BY rowid").all() as any
  }
  recentRaw(limit: number): string[] {
    return (this.db.query("SELECT raw FROM intake WHERE stage!='new' ORDER BY rowid DESC LIMIT ?").all(limit) as { raw: string }[]).map((r) => r.raw).reverse()
  }

  loadRooms(): Map<string, RoomState> {
    const out = new Map<string, RoomState>()
    for (const r of this.db.query('SELECT * FROM room_state').all() as any[]) {
      out.set(r.chat_id, { chat: r.chat_id, pending: JSON.parse(r.pending_json ?? 'null'), held: JSON.parse(r.held_json ?? '[]'), bursts: JSON.parse(r.burst_json ?? '{}'), nextSeq: r.next_seq })
    }
    return out
  }
  private writeRoom(s: RoomState) {
    this.db.query('INSERT INTO room_state(chat_id, pending_json, held_json, burst_json, next_seq, updated_at) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET pending_json=excluded.pending_json, held_json=excluded.held_json, burst_json=excluded.burst_json, next_seq=excluded.next_seq, updated_at=excluded.updated_at')
      .run(s.chat, JSON.stringify(s.pending), JSON.stringify(s.held), JSON.stringify(s.bursts), s.nextSeq, iso())
  }
  saveRoom(s: RoomState) { this.writeRoom(s) }
  /** One routed intake row: its stage and (when it landed in a room) that room's state, in one transaction. */
  routed(row: { chat_id: string; log_id: string }, stage: 'pending' | 'burst' | 'dropped', room?: RoomState) {
    this.db.transaction(() => {
      this.db.query('UPDATE intake SET stage=? WHERE chat_id=? AND log_id=?').run(stage, row.chat_id, row.log_id)
      if (room) this.writeRoom(room)
    })()
  }

  /** Flush: the room's new state (pending cleared, held consumed) and its batches, ids from next_seq, in one transaction. */
  commitFlush(room: RoomState, batches: NewBatch[]): string[] {
    const next = structuredClone(room)
    const ids: string[] = []
    this.db.transaction(() => {
      const at = iso()
      for (const b of batches) {
        const seq = next.nextSeq++
        const id = `kakao:${room.chat}:${seq}`
        this.db.query("INSERT INTO batches(id, chat_id, lane, seq, part, parts, members_json, body, state, attempts, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)")
          .run(id, room.chat, b.lane, seq, b.part, b.parts, JSON.stringify(b.members), b.body, at)
        ids.push(id)
        this.crash('batch:inserted')
      }
      this.writeRoom(next)
    })()
    Object.assign(room, next)
    return ids
  }

  batch(id: string): Batch | null { return this.db.query('SELECT * FROM batches WHERE id=?').get(id) as Batch | null }
  openBatches(lane?: string): Batch[] {
    const q = `SELECT * FROM batches WHERE state IN (${OPEN_STATES.map(() => '?').join(',')})${lane ? ' AND lane=?' : ''} ORDER BY rowid`
    return this.db.query(q).all(...OPEN_STATES, ...(lane ? [lane] : [])) as Batch[]
  }
  /** The oldest open batch of every lane, in global (rowid) order. A lane's later batch never goes before its head. */
  heads(): Batch[] {
    const seen = new Set<string>()
    return this.openBatches().filter((b) => (seen.has(b.lane) ? false : (seen.add(b.lane), true)))
  }
  markSending(id: string, sentTo: SentTo) {
    this.db.query("UPDATE batches SET state='accepted', sent_to_json=?, attempts=attempts+1 WHERE id=?").run(JSON.stringify(sentTo), id)
  }
  markResult(id: string, state: Exclude<BatchState, 'persisted'>, o: { transport?: string | null; error?: string | null; sentTo?: SentTo } = {}) {
    this.db.query('UPDATE batches SET state=?, transport=COALESCE(transport, ?), last_error=?, sent_to_json=COALESCE(?, sent_to_json) WHERE id=?')
      .run(state, o.transport ?? null, o.error ?? null, o.sentTo ? JSON.stringify(o.sentTo) : null, id)
  }
  markPersisted(id: string, o: { transport?: string | null; sentTo?: SentTo } = {}) {
    this.db.query("UPDATE batches SET state='persisted', persisted_at=?, transport=COALESCE(transport, ?), sent_to_json=COALESCE(?, sent_to_json), last_error=NULL WHERE id=?")
      .run(iso(), o.transport ?? null, o.sentTo ? JSON.stringify(o.sentTo) : null, id)
  }
  counts(): Record<string, number> {
    return Object.fromEntries((this.db.query('SELECT state, count(*) AS n FROM batches GROUP BY state').all() as { state: string; n: number }[]).map((r) => [r.state, r.n]))
  }
}

/** kakao-stall.ts and status: the oldest batch not yet persisted (read-only). */
export function oldestOpen(path = queuePath()): { id: string; state: string; lane: string; createdAt: number } | null {
  if (!existsSync(path)) return null
  const db = new Database(path, { readonly: true })
  try {
    const r = db.query(`SELECT id, state, lane, created_at FROM batches WHERE state IN (${OPEN_STATES.map((s) => `'${s}'`).join(',')}) ORDER BY rowid LIMIT 1`).get() as any
    return r ? { id: r.id, state: r.state, lane: r.lane, createdAt: Date.parse(r.created_at) } : null
  } finally { db.close() }
}

export type LegacyDeps = {
  /** The old path: `bun sess.ts send <lane> --id <id> <body>`; resolves to its exit code (0 delivered, 3 pending, 4 refused). */
  send: (lane: string, body: string, id: string) => Promise<number>
  /** Disk receipt of the batch id in the session it went to (or the lane's current session). */
  receipt: (b: Batch) => 'persisted' | 'absent'
  sleep: (ms: number) => Promise<void>
  log: (l: string) => void
  now?: () => number
}

/**
 * Rollback drain. Every open batch goes out once, in rowid order, lane order kept (a lane's later batch waits for its
 * earlier one). accepted/uncertain are checked for a receipt first and never sent when one exists. A pending (exit 3)
 * send is not repeated until its receipt has been absent for `pendingGraceMs`; the same id is reused so the old
 * deliver path's own receipt check still stops a double send.
 */
export async function replayLegacy(q: Queue, deps: LegacyDeps, opts: { lane?: string; dry?: boolean; pendingGraceMs?: number; retryMs?: number } = {}) {
  const now = deps.now ?? Date.now
  const grace = opts.pendingGraceMs ?? 10 * 60_000, retry = opts.retryMs ?? 3000
  const pendingSince = new Map<string, number>()
  const sent: string[] = []
  for (;;) {
    const open = q.openBatches(opts.lane)
    if (!open.length) break
    if (opts.dry) { for (const b of open) deps.log(`would replay ${b.id} lane=${b.lane} state=${b.state}`); return { sent, dry: open.map((b) => b.id) } }
    const blocked = new Set<string>()
    let progressed = false
    for (const b of open) {
      if (blocked.has(b.lane)) continue
      blocked.add(b.lane)
      if (b.state === 'accepted' || b.state === 'uncertain' || pendingSince.has(b.id)) {
        if (deps.receipt(b) === 'persisted') { q.markPersisted(b.id); deps.log(`replay ${b.id} persisted (receipt, not sent)`); progressed = true; continue }
        const since = pendingSince.get(b.id)
        if (since !== undefined && now() - since < grace) continue
      }
      const code = await deps.send(b.lane, b.body, b.id)
      deps.log(`replay ${b.id} lane=${b.lane} exit ${code}`)
      if (code === 0) { q.markPersisted(b.id, { transport: b.transport ?? 'herdr' }); sent.push(b.id); pendingSince.delete(b.id); progressed = true }
      else if (code === 3) { q.markResult(b.id, 'uncertain', { transport: 'herdr', error: 'replay pending' }); pendingSince.set(b.id, now()) }
      else q.markResult(b.id, 'refused', { error: `replay exit ${code}` })
    }
    if (!progressed) await deps.sleep(retry)
  }
  return { sent }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const cmd = argv[0]
  const path = queuePath()
  if (cmd === 'init') {
    const q = Queue.open(path); q.close(); chmodSync(path, 0o600)
    console.log(JSON.stringify({ ok: true, path }))
  } else if (cmd === 'status') {
    if (!existsSync(path)) { console.log(JSON.stringify({ path, exists: false })); process.exit(0) }
    const q = Queue.open(path, { readonly: true })
    console.log(JSON.stringify({ path, cursor: q.cursor(), batches: q.counts(), oldestOpen: oldestOpen(path) }))
    q.close()
  } else if (cmd === 'replay-legacy') {
    const { receipt } = await import('./rpc')
    const { readMap } = await import('./registry')
    const { findSessionFile } = await import('./sess')
    const q = Queue.open(path)
    const home = omocat()
    const res = await replayLegacy(q, {
      send: async (lane, body, id) => {
        const p = Bun.spawn(['bun', 'sess.ts', 'send', lane, '--id', id, body], { cwd: home, stdout: 'inherit', stderr: 'inherit' })
        return await p.exited
      },
      receipt: (b) => {
        const st = b.sent_to_json ? (JSON.parse(b.sent_to_json) as SentTo) : null
        if (st?.sessionPath && receipt(st.sessionPath, b.id) === 'persisted') return 'persisted'
        const e = readMap(home)[b.lane]
        return e ? receipt(findSessionFile(e.sessionId, e.cwd ?? null), b.id) : 'absent'
      },
      sleep: (ms) => Bun.sleep(ms),
      log: (l) => console.log(new Date().toISOString(), l),
    }, { lane: flag('--lane'), dry: argv.includes('--dry') })
    console.log(JSON.stringify({ replayed: res.sent.length, ...(res.dry ? { dry: res.dry } : {}), batches: q.counts() }))
    q.close()
  } else {
    console.error('usage: kakao-queue.ts init | status [--json] | replay-legacy [--lane L] [--dry]')
    process.exitCode = 2
  }
}
