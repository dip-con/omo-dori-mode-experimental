// Question parsing and Discord button layout for the lead.
//
// Ported from kihyunnn/omo-discord-question-patch (MIT License, Copyright (c) kihyunnn):
//   src/questions.ts   -> fromJson / dedupeQuestions / parsePaneQuestions / parseSessionQuestionCalls
//   src/discord.ts     -> row packing (5 buttons per row) and message chunking (5 rows per message)
//   src/session-log.ts / src/session-lookup.ts -> agent-dir resolution, cwd slug, bounded tail read
// Changes for Dori:
//   - the open question is the newest ask_user_question call WITHOUT a matching toolResult
//     (the repo used "newest call"; OMO logs the result, so answered/cancelled is known exactly)
//   - options keep their description; custom_id carries our question id (`oq|<id>|<qi>|<choice>`)
//   - a parser for OMO's own question screen (`Ask user ·` block) as the fallback source
//   - answered questions keep their rows but are disabled one question at a time (repo rule)
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type QuestionOption = { label: string; value: string; description?: string }
export type PaneQuestion = { text: string; header?: string; options: QuestionOption[]; multiSelect: boolean }
export type ParsedQuestions = { questions: PaneQuestion[]; raw: string }


// The ask-user UI marks the focused option with a cursor glyph (`→ 1. Left`). Without allowing that
// leading marker the first choice was dropped (a real bug in the source repo).
const OPTION = /^\s*(?:[→❯▶▸»>●○]\s*)?(?:[-*•]|\[\s*[ xX]?\s*\]|\(?\d+[.)]|[A-Za-z][.)])\s+(.+?)\s*$/u
const QUESTION = /^\s*(?:[→❯▶▸»>]\s*)?(?:\?|(?:question|질문)\s*[:：]|\d+[.)])\s*(.+?)\s*$/iu

const clean = (value: string): string => value.replace(/\s+/g, ' ').trim()
const option = (value: string): QuestionOption | null => {
  const label = clean(value)
  return label === '' ? null : { label: label.slice(0, 80), value: label }
}

function fromJson(value: unknown): PaneQuestion[] {
  if (!value || typeof value !== 'object') return []
  const root = value as { questions?: unknown }
  const list = Array.isArray(root.questions) ? root.questions : [value]
  return list.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as { question?: unknown; text?: unknown; prompt?: unknown; header?: unknown; options?: unknown; choices?: unknown; multiSelect?: unknown; multi_select?: unknown; multiple?: unknown }
    const rawOptions = Array.isArray(row.options) ? row.options : Array.isArray(row.choices) ? row.choices : []
    const options = rawOptions.flatMap((entry): QuestionOption[] => {
      if (typeof entry === 'string') return option(entry) ? [option(entry)!] : []
      if (!entry || typeof entry !== 'object') return []
      const e = entry as { label?: unknown; text?: unknown; value?: unknown; name?: unknown; description?: unknown }
      const label = typeof e.label === 'string' ? e.label : typeof e.text === 'string' ? e.text : typeof e.name === 'string' ? e.name : ''
      const parsed = option(label)
      if (!parsed) return []
      return [{ ...parsed, value: typeof e.value === 'string' ? e.value : parsed.value, ...(typeof e.description === 'string' && e.description.trim() ? { description: clean(e.description).slice(0, 200) } : {}) }]
    })
    const text = typeof row.question === 'string' ? row.question : typeof row.text === 'string' ? row.text : typeof row.prompt === 'string' ? row.prompt : ''
    if (!text.trim() || options.length === 0) return []
    return [{
      text: clean(text).slice(0, 1000),
      ...(typeof row.header === 'string' && row.header.trim() ? { header: clean(row.header).slice(0, 40) } : {}),
      options,
      multiSelect: row.multiSelect === true || row.multi_select === true || row.multiple === true,
    }]
  })
}

// A session log keeps every retried call, so identical questions collapse to one.
const signature = (q: PaneQuestion): string => `${q.text}\u0000${q.options.map((c) => `${c.label}\u0001${c.value}`).join('\u0002')}`

export function dedupeQuestions(questions: PaneQuestion[]): PaneQuestion[] {
  const seen = new Set<string>()
  return questions.filter((q) => {
    const key = signature(q)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function parsePaneQuestions(input: string): ParsedQuestions | null {
  const raw = input.trim()
  if (raw === '') return null
  try {
    const parsed = dedupeQuestions(fromJson(JSON.parse(raw)))
    if (parsed.length > 0) return { questions: parsed, raw }
  } catch { /* human-readable text is the normal path */ }
  const lines = raw.split('\n').map(clean).filter(Boolean)
  const questions: PaneQuestion[] = []
  let current: PaneQuestion | null = null
  for (const line of lines) {
    const match = line.match(QUESTION)
    const choice = line.match(OPTION)
    if (match && !choice) {
      if (current && current.options.length > 0) questions.push(current)
      current = { text: clean(match[1]!).slice(0, 1000), options: [], multiSelect: /multi|여러|복수/i.test(line) }
      continue
    }
    if (choice && current) {
      const parsed = option(choice[1]!)
      if (parsed) current.options.push(parsed)
      continue
    }
    if (!current && line.endsWith('?')) current = { text: line.slice(0, 1000), options: [], multiSelect: false }
  }
  if (current && current.options.length > 0) questions.push(current)
  if (questions.length === 0) {
    const optionLines = lines.map((line) => option(line.replace(/^\d+[.)]\s*/u, ''))).filter((x): x is QuestionOption => x !== null)
    const questionLine = lines.find((line) => line.endsWith('?'))
    if (questionLine && optionLines.length > 0) questions.push({ text: questionLine.slice(0, 1000), options: optionLines, multiSelect: false })
  }
  const unique = dedupeQuestions(questions)
  return unique.length > 0 ? { questions: unique, raw } : null
}

const QUESTION_TOOLS = new Set(['ask_user_question', 'request_user_input'])
export type SessionQuestionCall = ParsedQuestions & { callId: string | null }
export type QuestionResult = { callId: string; status: string; text: string }

// The open question is the newest question call that has no toolResult yet. Earlier calls were
// answered (the repo's "only the newest call" rule) and a call with a result is no longer waiting.
export function parseSessionQuestionCalls(input: string): SessionQuestionCall | null {
  let latest: { callId: string | null; questions: PaneQuestion[] } | null = null
  const resolved = new Set<string>()
  for (const line of input.split('\n')) {
    if (!line.includes('ask_user_question') && !line.includes('request_user_input')) continue
    try {
      const row = JSON.parse(line) as { message?: { role?: string; toolCallId?: string; toolName?: string; content?: Array<{ type?: string; id?: string; name?: string; arguments?: unknown }> } }
      const msg = row.message
      if (msg?.role === 'toolResult' && msg.toolName && QUESTION_TOOLS.has(msg.toolName) && msg.toolCallId) {
        resolved.add(msg.toolCallId)
        continue
      }
      const call = msg?.content?.find?.((e) => e.type === 'toolCall' && QUESTION_TOOLS.has(e.name ?? ''))
      const args = call?.arguments as { questions?: unknown[]; question?: unknown; options?: unknown[] } | undefined
      let converted: PaneQuestion[] = []
      if (Array.isArray(args?.questions)) converted = fromJson({ questions: args.questions })
      else if (typeof args?.question === 'string' && Array.isArray(args.options)) converted = fromJson({ question: args.question, options: args.options })
      if (converted.length > 0) latest = { callId: call?.id ?? null, questions: converted }
    } catch { /* malformed line: keep scanning */ }
  }
  if (!latest || (latest.callId && resolved.has(latest.callId))) return null
  const unique = dedupeQuestions(latest.questions)
  return unique.length > 0 ? { questions: unique, raw: input, callId: latest.callId } : null
}

// The result OMO logged for a question call: details.status is "answered" or a cancel/timeout state.
export function questionResult(input: string, callId: string): QuestionResult | null {
  for (const line of input.split('\n')) {
    if (!line.includes(callId) || !line.includes('"toolResult"')) continue
    try {
      const msg = (JSON.parse(line) as { message?: { role?: string; toolCallId?: string; isError?: boolean; content?: Array<{ type?: string; text?: string }>; details?: { status?: string } } }).message
      if (msg?.role !== 'toolResult' || msg.toolCallId !== callId) continue
      const text = (msg.content ?? []).map((c) => c.text ?? '').join('\n').trim()
      return { callId, status: msg.details?.status ?? (msg.isError ? 'error' : 'unknown'), text }
    } catch { /* keep scanning */ }
  }
  return null
}


export type OmoScreen = { tabs: string[]; current: PaneQuestion | null; answered: number; total: number; review: boolean }

// A pane that merely SHOWS these strings (source code, a log) is not asking. The live UI is a block
// at the very bottom: `Ask user · <timer>`, a tabs line ending in `Submit`, ..., a whole-line
// `Submit (n/m answered)`, the key-hint line right under it, then only the separator/status bar.
export function questionUiAtBottom(screen: string): boolean {
  const lines = screen.replace(/\r/g, '').split('\n').map((l) => l.trimEnd())
  let hint = -1
  for (let i = lines.length - 1; i >= 1 && i >= lines.length - 12; i--) {
    if (/^\s*(?:↑↓ move\s|enter (?:submit|save|next)\b)/.test(lines[i]!)) { hint = i; break }
  }
  if (hint < 1 || !/^\s*Submit \(\d+\/\d+ answered\)(?:\s+—\s.*)?$/.test(lines[hint - 1]!)) return false
  let ask = -1
  for (let i = hint - 2; i >= Math.max(0, hint - 40); i--) if (/^\s*Ask user · \S.{0,15}$/.test(lines[i]!)) { ask = i; break }
  if (ask < 0 || !/\sSubmit$/.test(lines[ask + 1] ?? '')) return false
  const after = lines.slice(hint + 1).filter((l) => l.trim())
  return after.length <= 5 && after.some((l) => /^─{10,}/.test(l.trim()))
}

// Reads the `Ask user ·` block OMO draws at the bottom of the pane. Only the question on screen is
// visible; the tabs line names every question by header.
export function parseOmoScreen(screen: string): OmoScreen | null {
  if (!questionUiAtBottom(screen)) return null
  const lines = screen.replace(/\r/g, '').split('\n')
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--) if (/Ask user · /.test(lines[i]!)) { start = i; break }
  if (start < 0) return null
  const block = lines.slice(start + 1)
  const tabs = (block[0] ?? '').replace(/[→✓]/g, ' ').trim().split(/\s{2,}/).map((s) => s.trim()).filter((s) => s && s !== 'Submit')
  const progress = screen.match(/Submit \((\d+)\/(\d+) answered\)/)
  const review = block.some((l) => /Review your answers/.test(l))
  const body = block.slice(1)
  const textLines: string[] = []
  const options: QuestionOption[] = []
  for (const line of body) {
    if (/Type your own answer|Submit \(\d+\/\d+ answered\)|Your answer \(|^\s*! /.test(line)) break
    const m = line.match(/^\s*(?:→\s*)?(\d+)\.\s+(.+?)(?:\s+✓)?\s*$/u)
    if (m && (options.length > 0 || Number(m[1]) === 1)) { options.push({ label: clean(m[2]!).slice(0, 80), value: clean(m[2]!) }); continue }
    if (options.length === 0 && line.trim()) textLines.push(line.trim())
  }
  const multiSelect = /space toggle|Enter toggles/.test(screen)
  const current = !review && textLines.length > 0 && options.length > 0 ? { text: clean(textLines.join(' ')).slice(0, 1000), options, multiSelect } : null
  return { tabs, current, answered: Number(progress?.[1] ?? 0), total: Number(progress?.[2] ?? tabs.length), review }
}


const AGENT_DIR_ENV_NAMES = ['OMO_CODING_AGENT_DIR', 'SENPI_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR'] as const
export function sessionRoot(env: Record<string, string | undefined> = process.env): string {
  for (const name of AGENT_DIR_ENV_NAMES) {
    const configured = env[name]?.trim()
    if (configured) return join(resolve(configured), 'sessions')
  }
  return join(env.HOME || env.USERPROFILE || homedir(), '.omo', 'agent', 'sessions')
}

// omo names a session directory after the project path: separators become "-", wrapped in "--".
// The real path is used (macOS reports /tmp as /private/tmp in the slug).
export function sessionDirSlug(cwd: string): string {
  let real = cwd
  try { real = realpathSync(cwd) } catch { /* keep as given */ }
  const normalized = real.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
  return `--${normalized.replaceAll('/', '-')}--`
}

// Session logs reach tens of MB; the question is at the end, so only the tail is read.
export const QUESTION_LOG_BYTES = 512 * 1024
export function readTail(path: string, bytes = QUESTION_LOG_BYTES): string {
  try {
    const size = statSync(path).size
    const length = Math.min(size, bytes)
    if (length <= 0) return ''
    const buffer = Buffer.alloc(length)
    const fd = openSync(path, 'r')
    try { readSync(fd, buffer, 0, length, size - length) } finally { closeSync(fd) }
    return buffer.toString('utf8')
  } catch { return '' }
}

// Candidate logs for a pane: the mapped session id first, otherwise the newest logs in its cwd dir.
export function sessionLogCandidates(cwd: string, sessionId: string | null, root = sessionRoot(), limit = 8): string[] {
  const dir = join(root, sessionDirSlug(cwd))
  let files: string[]
  try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')) } catch { return [] }
  if (sessionId) {
    const own = files.filter((f) => f.endsWith(`_${sessionId}.jsonl`)).map((f) => join(dir, f))
    if (own.length > 0) return own
  }
  return files
    .map((f) => { try { return { path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs } } catch { return null } })
    .filter((x): x is { path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((x) => x.path)
}

const squash = (s: string) => s.replace(/\s+/g, '')
// Several sessions can share one cwd; the log whose open call matches the screen is the pane's.
export function callMatchesScreen(call: ParsedQuestions, screen: OmoScreen): boolean {
  if (screen.tabs.length > 0 && call.questions.length !== screen.tabs.length) return false
  const flat = squash(screen.current?.text ?? '')
  return call.questions.some((q) => flat !== '' && squash(q.text).startsWith(flat.slice(0, 20))) ||
    (screen.review && call.questions.every((q, i) => !q.header || screen.tabs[i] === q.header))
}


export type Answer = { kind: 'option'; index: number } | { kind: 'multi'; indices: number[] } | { kind: 'text'; text: string }
export type Button = { type: 2; style: 1 | 2 | 3 | 4; label: string; custom_id: string; disabled?: boolean }
export type ActionRow = { type: 1; components: Button[] }
export type QuestionRow = { questionIndex: number; row: ActionRow }
export const OPTIONS_PER_ROW = 5
export const ROWS_PER_MESSAGE = 5

export function answerLabel(q: PaneQuestion, a: Answer): string {
  if (a.kind === 'option') return q.options[a.index]?.label ?? '?'
  if (a.kind === 'multi') return a.indices.map((i) => q.options[i]?.label ?? '?').join(', ') || '(선택 없음)'
  return a.text
}

// One question at a time: an answered question keeps its rows (layout does not shift) but only ITS
// buttons are disabled. There is deliberately no "disable everything" flag (repo-measured trap);
// a closed set simply sends no components.
export function questionRows(id: string, questions: PaneQuestion[], answers: Record<number, Answer>, picks: Record<number, number[]>, opts: { other: boolean }): QuestionRow[] {
  const rows: QuestionRow[] = []
  questions.forEach((q, qi) => {
    const a = answers[qi]
    const done = a !== undefined
    const picked = (oi: number) => (a?.kind === 'option' && a.index === oi) || (a?.kind === 'multi' && a.indices.includes(oi)) || (!done && (picks[qi] ?? []).includes(oi))
    const buttons: Button[] = q.options.map((c, oi) => ({
      type: 2, style: picked(oi) ? 3 : 1,
      label: `${picked(oi) ? '선택: ' : ''}${questions.length > 1 ? `${qi + 1}. ` : ''}${c.label}`.slice(0, 80),
      custom_id: `oq|${id}|${qi}|${oi}`, ...(done ? { disabled: true } : {}),
    }))
    if (q.multiSelect) buttons.push({ type: 2, style: 3, label: '선택 완료', custom_id: `oq|${id}|${qi}|c`, ...(done ? { disabled: true } : {}) })
    if (opts.other) buttons.push({ type: 2, style: 2, label: a?.kind === 'text' ? `선택: ${a.text}`.slice(0, 80) : '직접 입력', custom_id: `oq|${id}|${qi}|w`, ...(done ? { disabled: true } : {}) })
    for (let s = 0; s < buttons.length; s += OPTIONS_PER_ROW) rows.push({ questionIndex: qi, row: { type: 1, components: buttons.slice(s, s + OPTIONS_PER_ROW) } })
  })
  return rows
}

// Discord rejects >5 action rows (50035) and fails the whole message, so rows continue in the next
// message instead of being truncated.
export function chunkRows(rows: QuestionRow[], limit = ROWS_PER_MESSAGE): QuestionRow[][] {
  const chunks: QuestionRow[][] = []
  let current: QuestionRow[] = []
  for (const entry of rows) {
    if (current.length >= limit) { chunks.push(current); current = [] }
    current.push(entry)
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export type Choice = { qi: number; choice: number | 'w' | 'c' }
export function parseCustomId(customId: string): { id: string } & Choice | null {
  const m = customId.match(/^oq\|([A-Za-z0-9]+)\|(\d+)\|(\d+|w|c)$/)
  if (!m) return null
  return { id: m[1]!, qi: Number(m[2]), choice: m[3] === 'w' || m[3] === 'c' ? m[3] : Number(m[3]) }
}
