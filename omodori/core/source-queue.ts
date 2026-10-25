// The common inbound queue of the messenger sources (core/sources.ts contract).
//   source.inbound(raw) -> InboundEvent -> enqueue (one row per source/room/id; a re-read line is ignored)
//   pump(): each queued row with a lane goes to that lane through the given deliver (the live one is rpc.send with the
//           row id as the delivery id, so a retry is never a second message); accepted/delivered -> the row is done,
//           refused -> kept queued with the reason, uncertain -> kept 'sent' (receipt decides, never re-sent blindly)
//   reply(): a lane's answer goes back out through the source's send()
//   bun core/source-queue.ts status        row counts per source and state (read-only)
// $OMODORI_HOME/source-queue.sqlite (0600, WAL). A source with its own delivery queue (receipts, batching) may keep it.
import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { doriHome } from './config'
import type { InboundEvent, SendResult, SourceModule } from './sources'

export type RowState = 'queued' | 'sent' | 'done' | 'refused'
export type Row = InboundEvent & { key: string; state: RowState; attempts: number; last_error: string | null }
export type DeliverFn = (lane: string, text: string, id: string) => Promise<{ status: string; reason?: string }>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events(key TEXT PRIMARY KEY, source TEXT, room TEXT, id TEXT, sender TEXT, text TEXT, at TEXT,
  lane TEXT, is_owner INTEGER, state TEXT CHECK(state IN ('queued','sent','done','refused')) NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS events_state ON events(state);
`
export const sourceQueuePath = (home = doriHome()) => join(home, 'source-queue.sqlite')
export const rowKey = (e: Pick<InboundEvent, 'source' | 'room' | 'id'>) => `${e.source}:${e.room}:${e.id}`
const iso = () => new Date().toISOString()

export class SourceQueue {
  private constructor(readonly db: Database) {}
  static open(path = sourceQueuePath(), opts: { readonly?: boolean } = {}): SourceQueue {
    if (opts.readonly) return new SourceQueue(new Database(path, { readonly: true }))
    mkdirSync(dirname(path), { recursive: true })
    const fresh = !existsSync(path)
    const db = new Database(path, { create: true })
    if (fresh) chmodSync(path, 0o600)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    db.exec(SCHEMA)
    return new SourceQueue(db)
  }
  close() { this.db.close() }

  enqueue(e: InboundEvent): boolean {
    const r = this.db.query('INSERT INTO events(key, source, room, id, sender, text, at, lane, is_owner, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO NOTHING')
      .run(rowKey(e), e.source, e.room, e.id, e.sender, e.text, e.at, e.lane ?? null, e.isOwner ? 1 : 0, iso())
    return r.changes > 0
  }
  ingest(source: Pick<SourceModule, 'inbound'>, raw: unknown): InboundEvent | null {
    const e = source.inbound(raw)
    if (e) this.enqueue(e)
    return e
  }
  rows(state?: RowState): Row[] {
    const q = state ? this.db.query('SELECT * FROM events WHERE state = ? ORDER BY at, key').all(state) : this.db.query('SELECT * FROM events ORDER BY at, key').all()
    return (q as any[]).map((r) => ({ key: r.key, source: r.source, room: r.room, id: r.id, sender: r.sender, text: r.text, at: r.at, lane: r.lane, isOwner: !!r.is_owner, state: r.state, attempts: r.attempts, last_error: r.last_error }))
  }
  private mark(key: string, state: RowState, error: string | null) {
    this.db.query('UPDATE events SET state = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE key = ?').run(state, error, iso(), key)
  }
  counts(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {}
    for (const r of this.db.query('SELECT source, state, COUNT(*) AS n FROM events GROUP BY source, state').all() as { source: string; state: string; n: number }[]) (out[r.source] ??= {})[r.state] = r.n
    return out
  }

  /** Delivers every queued (and previously refused) row that has a lane. Rows without a lane wait for routing. */
  async pump(deliver: DeliverFn): Promise<{ delivered: string[]; refused: string[]; uncertain: string[] }> {
    const res = { delivered: [] as string[], refused: [] as string[], uncertain: [] as string[] }
    for (const r of [...this.rows('queued'), ...this.rows('refused')]) {
      if (!r.lane) continue
      const d = await deliver(r.lane, `[${r.source} ${r.room}] ${r.text}`, r.key)
      if (d.status === 'delivered' || d.status === 'accepted') { this.mark(r.key, 'done', null); res.delivered.push(r.key) }
      else if (d.status === 'refused') { this.mark(r.key, 'refused', d.reason ?? 'refused'); res.refused.push(r.key) }
      else { this.mark(r.key, 'sent', d.reason ?? d.status); res.uncertain.push(r.key) }
    }
    return res
  }
}

export const reply = (source: Pick<SourceModule, 'send'>, room: string, text: string): Promise<SendResult> => source.send(room, text)

if (import.meta.main && process.argv[2] === 'status') {
  const p = sourceQueuePath()
  if (!existsSync(p)) { console.log('{}'); process.exit(0) }
  const q = SourceQueue.open(p, { readonly: true })
  try { console.log(JSON.stringify(q.counts())) } finally { q.close() }
}
