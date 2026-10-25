// "Search before saying I don't know" helper (dori-improve 7): one query over memory, session records and logs.
//   bun recall.ts "<words>" [--days 7] [--max 8]     every word must appear (case-insensitive) in a hit
// Sources: lead memory repo (md), OMO session records modified in the last --days (user/assistant text only),
// ~/.omocat logs/docs/briefs/decisions/inbox and ~/Library/Logs/dandori-kakao. Secrets are masked in snippets.
// Last line: RECALL_SUMMARY memory=N sessions=N logs=N (all zero = it is really not on record).
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from './ledger'
import { cfg } from './config'

const HOME = process.env.HOME!
const MEMORY = cfg.paths.memoryRepo
const SESSIONS = `${HOME}/.omo/agent/sessions`
const LOG_PATHS = [`${HOME}/.omocat/logs`, `${HOME}/.omocat/docs`, `${HOME}/.omocat/briefs`, `${HOME}/.omocat/heartbeat`, `${HOME}/.omocat/decisions.jsonl`, `${HOME}/.omocat/inbox.jsonl`, `${HOME}/Library/Logs/dandori-kakao`]

export function snippet(text: string, terms: string[], width = 110): string {
  const flat = text.replace(/\s+/g, ' ')
  const i = Math.max(0, flat.toLowerCase().indexOf(terms[0]!.toLowerCase()))
  return redact(`${i > width ? '…' : ''}${flat.slice(Math.max(0, i - width), i + width)}${i + width < flat.length ? '…' : ''}`)
}
export const hasAll = (text: string, terms: string[]) => { const t = text.toLowerCase(); return terms.every((w) => t.includes(w.toLowerCase())) }

function rg(args: string[]): string[] {
  const p = Bun.spawnSync(['rg', '-i', '-F', '--no-heading', '-n', ...args], { stdout: 'pipe', stderr: 'pipe', maxBuffer: 256 * 1024 * 1024 })
  return p.stdout.toString().split('\n').filter(Boolean)
}
const split = (line: string) => { const m = /^(.*?):(\d+):(.*)$/s.exec(line); return m ? { file: m[1]!, line: Number(m[2]), text: m[3]! } : null }

export function messageText(jsonLine: string): { role: string; ts: string; text: string } | null {
  try {
    const j = JSON.parse(jsonLine)
    const role = j.message?.role
    if (j.type !== 'message' || (role !== 'user' && role !== 'assistant')) return null
    const c = j.message.content
    const text = typeof c === 'string' ? c : (c ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
    return text ? { role, ts: String(j.timestamp ?? ''), text } : null
  } catch { return null }
}

function recentSessionFiles(days: number): string[] {
  const cutoff = Date.now() - days * 86_400_000
  const out: string[] = []
  for (const d of existsSync(SESSIONS) ? readdirSync(SESSIONS) : []) {
    let files: string[] = []
    try { files = readdirSync(join(SESSIONS, d)) } catch { continue }
    for (const f of files) if (f.endsWith('.jsonl')) { const p = join(SESSIONS, d, f); if (statSync(p).mtimeMs >= cutoff) out.push(p) }
  }
  return out
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const opt = (n: string, d: number) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d }
  const query = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')).join(' ').trim()
  if (!query) { console.error('usage: recall.ts "<words>" [--days 7] [--max 8]'); process.exit(2) }
  const terms = query.split(/\s+/).sort((a, b) => b.length - a.length)
  const max = opt('--max', 8)

  const mem = rg(['--glob', '*.md', '--max-count', '5', terms[0]!, MEMORY]).map(split).filter((h) => h && hasAll(h.text, terms)).slice(0, max)
  console.log(`== memory (${mem.length})`)
  for (const h of mem) console.log(`${h!.file.replace(MEMORY + '/', '')}:${h!.line}  ${snippet(h!.text, terms)}`)

  const files = recentSessionFiles(opt('--days', 7))
  const sess: string[] = []
  for (let i = 0; i < files.length && sess.length < max; i += 200) {
    for (const raw of rg(['--max-count', '20', terms[0]!, ...files.slice(i, i + 200)])) {
      const h = split(raw)
      const m = h && messageText(h.text)
      if (!m || !hasAll(m.text, terms)) continue
      sess.push(`${m.ts.slice(0, 16).replace('T', ' ')}Z ${h!.file.split('/').pop()!.slice(-44, -6)} ${m.role}: ${snippet(m.text, terms)}`)
      if (sess.length >= max) break
    }
  }
  sess.sort().reverse()
  console.log(`== sessions, last ${opt('--days', 7)}d (${sess.length})`)
  for (const s of sess) console.log(s)

  const logs = rg(['--max-count', '5', '--max-columns', '4000', terms[0]!, ...LOG_PATHS.filter(existsSync)]).map(split).filter((h) => h && hasAll(h.text, terms)).slice(-max)
  console.log(`== logs (${logs.length})`)
  for (const h of logs) console.log(`${h!.file.replace(HOME, '~')}:${h!.line}  ${snippet(h!.text, terms)}`)

  console.log(`RECALL_SUMMARY memory=${mem.length} sessions=${sess.length} logs=${logs.length}${mem.length + sess.length + logs.length === 0 ? ' (not on record: now it is fine to say so)' : ''}`)
}
