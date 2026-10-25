// 답장(reply) context for the lanes (lead 10-23): a reply like "이거 PDF로" must say which message it answers.
// kakao-loco.ts writes reply_to_log_id / reply_to_text (addressingFields). Kakao truncates the quoted text and the
// ids it hands over may have lost precision (JS numbers above 2^53), so the original is looked up in the local kka
// archive (read-only) by chat + log id, falling back to the quoted text when the archive does not have it.
import { Database } from 'bun:sqlite'
import { cfg } from './config'

export const ARCHIVE_DB = `${process.env.KKA_ARCHIVE_ROOT ?? cfg.kakao.archiveRoot}/.index/archive.db`
const MAX = 300
// A double near 4e18 is off by at most 512 from the real id.
const NEAR = 2048n

type Row = { log_id: string; author_name: string; display: string; sent_at: number; attachment: string }
export type Original = { name: string | null; at: number | null; text: string }

const dbs = new Map<string, Database | null>()
function open(path: string): Database | null {
  if (dbs.has(path)) return dbs.get(path)!
  let db: Database | null = null
  try { db = new Database(path, { readonly: true }) } catch (e) { console.error(new Date().toISOString(), 'reply-quote archive unavailable', (e as Error)?.message) }
  dbs.set(path, db)
  return db
}
function query<T>(path: string, sql: string, ...args: (string | bigint)[]): T | null {
  const db = open(path)
  if (!db) return null
  try { return (db.query(sql).get(...args) as T) ?? null } catch (e) {
    // Volume unmounted or archive replaced (kka sync --full): reopen next time.
    console.error(new Date().toISOString(), 'reply-quote lookup failed', (e as Error)?.message)
    dbs.delete(path)
    return null
  }
}

// Raw attachment JSON from the archive: ids are bare 64-bit numbers, so read them as text.
function srcOf(attachment: string): { logId?: string; userId?: string; text?: string } {
  const big = (k: string) => attachment.match(new RegExp(`"${k}"\\s*:\\s*"?(\\d+)`))?.[1]
  let text: string | undefined
  try { const v = JSON.parse(attachment)?.src_message; if (typeof v === 'string') text = v } catch {}
  return { logId: big('src_logId'), userId: big('src_userId'), text }
}

const SELECT = 'select log_id, author_name, display, sent_at, attachment from messages where chat_id = ?'
function findOriginal(db: string, chat: string, logId: string, quoted?: string): Row | null {
  const exact = query<Row>(db, `${SELECT} and log_id = ? and deleted = 0`, chat, logId)
  if (exact) return exact
  let id: bigint
  try { id = BigInt(logId) } catch { return null }
  const near = query<Row>(db, `${SELECT} and deleted = 0 and cast(log_id as integer) between ? and ? order by abs(cast(log_id as integer) - ?) limit 1`, chat, id - NEAR, id + NEAR, id)
  if (!near) return null
  // Only trust an approximate id hit when it agrees with the quoted text (when there is one).
  const head = quoted?.trim().slice(0, 20)
  return !head || near.display.startsWith(head) ? near : null
}

// The reply line's own fields; for lines written before kakao-loco carried them, the reply row in the archive.
export function replySource(m: { message_type?: number; reply_to_log_id?: string; reply_to_user_id?: string; reply_to_text?: string }, chat: string, logId: string, db = ARCHIVE_DB) {
  if (m.reply_to_log_id || m.reply_to_text) return { logId: m.reply_to_log_id, userId: m.reply_to_user_id, text: m.reply_to_text }
  if (Number(m.message_type) !== 26 || !logId) return null
  const self = query<Row>(db, `${SELECT} and log_id = ?`, chat, logId)
  return self ? srcOf(self.attachment) : m.reply_to_user_id ? { userId: m.reply_to_user_id } : null
}

export function lookupOriginal(chat: string, src: { logId?: string; text?: string }, db = ARCHIVE_DB): Original | null {
  const row = src.logId ? findOriginal(db, chat, src.logId, src.text) : null
  if (row && row.display) return { name: row.author_name || null, at: row.sent_at * 1000, text: row.display }
  return src.text ? { name: null, at: null, text: src.text } : null
}

export function kst(ms: number) {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') + ' KST'
}

export function formatQuote(o: Original, fallbackName: string | null) {
  const flat = o.text.replace(/\s+/g, ' ').trim()
  const text = [...flat].length > MAX ? [...flat].slice(0, MAX).join('') + '…' : flat
  return `답장 대상: ${o.name ?? fallbackName ?? '?'}, ${o.at ? kst(o.at) : '시각 미상'}, ${text}`
}

export async function replyQuoteLine(
  m: Parameters<typeof replySource>[0], chat: string, logId: string,
  nameOf: (userId: string) => string | null | Promise<string | null>, db = ARCHIVE_DB,
): Promise<string> {
  const src = replySource(m, chat, logId, db)
  if (!src) return ''
  const o = lookupOriginal(chat, src, db)
  if (!o) return ''
  return formatQuote(o, o.name ? null : src.userId ? await nameOf(src.userId) : null)
}
