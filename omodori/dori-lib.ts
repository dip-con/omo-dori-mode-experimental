// Shared helpers for the Dori build modules (heartbeat, decision inbox, CEO weekly).
// Discord posts go through the omocat bot (same credentials as oc.ts / buttons.ts).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { redactSecrets } from './redact'
import { cfg, omocatHome } from './config'

export const HOME = process.env.HOME!
export const DORI = omocatHome()
export const GENERAL = cfg.discord.generalChannel // #일반
export const INBOX = cfg.discord.inboxChannel // #인박스 (decision inbox)
export const CEO_THREAD = cfg.discord.ceoThread // #일반 > CEO 주간 브리핑
export const BUILD_THREAD = cfg.discord.buildThread // dori-build lead thread (first-run results go here)
export const SESSIONS_MAP = `${DORI}/sessions-map.json`
export const SESSIONS_ROOT = `${HOME}/.omo/agent/sessions`

export type Lane = { key: string; label: string; cwd: string; thread: string | null; pane: string; sessionId: string; status: 'open' | 'closed' }
export const openLanes = (): Lane[] =>
  existsSync(SESSIONS_MAP) ? (Object.values(JSON.parse(readFileSync(SESSIONS_MAP, 'utf8'))) as Lane[]).filter((l) => l.status === 'open') : []

// KST wall-clock parts regardless of the host TZ.
export const kst = (d = new Date()) => {
  const k = new Date(d.getTime() + 9 * 3600_000)
  return { y: k.getUTCFullYear(), mo: k.getUTCMonth() + 1, d: k.getUTCDate(), h: k.getUTCHours(), mi: k.getUTCMinutes(), dow: k.getUTCDay(), date: k.toISOString().slice(0, 10), hm: k.toISOString().slice(11, 16) }
}
export const ageMin = (ms: number) => Math.round((Date.now() - ms) / 60_000)
export const mtime = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0)

export const readJson = <T>(p: string, fallback: T): T => {
  try { return JSON.parse(readFileSync(p, 'utf8')) as T } catch { return fallback }
}
export const writeJson = (p: string, v: unknown) => {
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(v, null, 1))
  renameSync(tmp, p)
}
export const readJsonl = <T>(p: string): T[] =>
  existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l) as T] } catch { return [] } }) : []
export const appendJsonl = (p: string, v: unknown) => appendFileSync(p, `${JSON.stringify(v)}\n`)

// Exclusive lock by mkdir (atomic); stale locks older than 60 s are broken.
export async function withLock<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const dir = `${DORI}/.locks`
  mkdirSync(dir, { recursive: true })
  const lock = `${dir}/${name}.lock`
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break } catch {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 60_000) { rmSync(lock, { recursive: true, force: true }); continue }
      if (i > 100) throw new Error(`lock ${name} busy`)
      await Bun.sleep(100)
    }
  }
  try { return await fn() } finally { rmSync(lock, { recursive: true, force: true }) }
}

const token = () => JSON.parse(readFileSync(`${HOME}/.config/agent-messenger/discordbot-credentials.json`, 'utf8')).bots.omocat.token as string
const DISCORD_LIMIT = 2000
const FENCE = /^\s*(```+|~~~+)/
// The fence opener still open after `text` (given the one open before it), or undefined when balanced.
const openFence = (text: string, open: string | undefined) => {
  let cur = open
  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line)?.[1]
    if (!marker) continue
    if (cur === undefined) cur = line.trim()
    else if (marker.startsWith(cur.slice(0, 3))) cur = undefined
  }
  return cur
}
// Chunks of <= limit chars cut at the last newline, else the last space, else hard (never inside a surrogate pair).
// A code fence open at a cut is closed at the chunk end and reopened (with its language) in the next chunk.
// adapted from dev-bokdong/dori-mode (MIT) src/messenger/discord.ts splitDiscordMessage
export function splitDiscord(text: string, limit = DISCORD_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  let fence: string | undefined
  for (;;) {
    const prefix = fence === undefined ? '' : `${fence}\n`
    if (prefix.length + rest.length <= limit) { chunks.push(prefix + rest); return chunks }
    const budget = Math.max(1, limit - prefix.length - 4) // room for a closing "\n```"
    const window = rest.slice(0, budget + 1)
    let cut = window.lastIndexOf('\n', budget)
    let skip = 1
    if (cut <= 0) cut = window.lastIndexOf(' ', budget)
    if (cut <= 0) {
      cut = budget
      skip = 0
      const c = rest.charCodeAt(cut - 1)
      if (c >= 0xd800 && c <= 0xdbff && cut > 1) cut--
    }
    const piece = rest.slice(0, cut)
    rest = rest.slice(cut + skip)
    const after = openFence(piece, fence)
    chunks.push(prefix + piece + (after === undefined ? '' : '\n```'))
    fence = after
  }
}

const ATTEMPTS = 4
export const postBackoff = { baseMs: 1000 } // tests set 0
// Post plain text (secrets redacted, split for Discord). Returns message ids; throws on a failed send.
// Each chunk has one nonce with enforce_nonce, reused across its retries, so Discord dedupes a replay: that makes
// retrying 5xx and network errors safe. 429 is retried after retry_after; any other 4xx throws at once.
export async function post(channel: string, text: string): Promise<string[]> {
  const ids: string[] = []
  for (const content of splitDiscord(redactSecrets(text))) {
    const body = JSON.stringify({ content, allowed_mentions: { parse: [] }, nonce: crypto.randomUUID().replace(/-/g, '').slice(0, 25), enforce_nonce: true })
    for (let attempt = 1; ; attempt++) {
      let status = 0
      let j: { id?: string; message?: string; retry_after?: number } = {}
      try {
        const res = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${token()}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (omocat, 1.0)' },
          body,
        })
        status = res.status
        j = (await res.json().catch(() => ({}))) as typeof j
        if (res.ok && j.id) { ids.push(j.id); break }
      } catch (e) {
        if (attempt >= ATTEMPTS) throw e
      }
      const retryable = status === 0 || status === 429 || status >= 500
      if (!retryable || attempt >= ATTEMPTS) throw new Error(`discord post ${status} ${j.message ?? ''}`)
      const waitMs = typeof j.retry_after === 'number' ? j.retry_after * 1000 : postBackoff.baseMs * 2 ** (attempt - 1)
      await Bun.sleep(Math.min(30_000, waitMs))
    }
  }
  return ids
}

export const flag = (name: string) => process.argv.includes(name)
export const opt = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
