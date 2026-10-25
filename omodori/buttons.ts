// Discord buttons for OmOMeow: `oc.ts ask` questions and OMO session questions (auto-posted by
// herdr-watch, answered by an owner press that listener.ts injects into the pane).
// State lives in SQLite so buttons keep working across restarts of either process.
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { cfg } from './config'
import {
  type Answer, type PaneQuestion, answerLabel, callMatchesScreen, chunkRows, parseCustomId, parseOmoScreen,
  parseSessionQuestionCalls, questionResult, questionRows, questionUiAtBottom, readTail, sessionLogCandidates, sessionRoot,
} from './questions'

const HOME = process.env.HOME!
export const OWNER_ID = cfg.discord.ownerId
export const GENERAL_CHANNEL = cfg.discord.generalChannel
export const SELF_PANE: string = (() => { try { return JSON.parse(readFileSync(`${HOME}/.dori/config.json`, 'utf8')).leadPane ?? 'wW:p6' } catch { return 'wW:p6' } })()

export type Status = 'open' | 'injecting' | 'answered' | 'closed'
export type Ask = {
  id: string; kind: 'ask' | 'pane'; channel: string; messageIds: string[]; title: string
  questions: PaneQuestion[]; other: boolean; pane: string | null; session: string | null
  key: string | null; logPath: string | null; callId: string | null
  answers: Record<number, Answer>; picks: Record<number, number[]>; awaiting: number | null
  status: Status; note: string | null; createdAt: string
}

export class Store {
  readonly db: Database
  constructor(path = process.env.OMOCAT_BUTTONS_DB ?? `${HOME}/.omocat/buttons.db`) {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA busy_timeout=5000')
    this.db.exec('CREATE TABLE IF NOT EXISTS asks(id TEXT PRIMARY KEY, key TEXT UNIQUE, pane TEXT, channel TEXT NOT NULL, status TEXT NOT NULL, awaiting INTEGER, data TEXT NOT NULL, created_at TEXT NOT NULL)')
  }
  private row(r: { data: string } | null): Ask | null { return r ? (JSON.parse(r.data) as Ask) : null }
  get(id: string): Ask | null { return this.row(this.db.query('SELECT data FROM asks WHERE id=?').get(id) as { data: string } | null) }
  byKey(key: string): Ask | null { return this.row(this.db.query('SELECT data FROM asks WHERE key=?').get(key) as { data: string } | null) }
  openForPane(pane: string): Ask[] {
    return (this.db.query("SELECT data FROM asks WHERE pane=? AND status='open'").all(pane) as { data: string }[]).map((r) => JSON.parse(r.data) as Ask)
  }
  awaitingIn(channel: string): Ask | null {
    return this.row(this.db.query("SELECT data FROM asks WHERE channel=? AND status='open' AND awaiting IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(channel) as { data: string } | null)
  }
  save(a: Ask): void {
    this.db.query('INSERT OR REPLACE INTO asks(id,key,pane,channel,status,awaiting,data,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(a.id, a.key, a.pane, a.channel, a.status, a.awaiting, JSON.stringify(a), a.createdAt)
  }
  // Atomic status transition: only one process wins an open question (listener vs herdr-watch).
  claim(id: string, from: Status, to: Status): Ask | null {
    const a = this.get(id)
    if (!a || a.status !== from) return null
    const changed = this.db.query('UPDATE asks SET status=?, data=json_set(data, "$.status", ?) WHERE id=? AND status=?').run(to, to, id, from).changes
    return changed === 1 ? { ...a, status: to } : null
  }
}

export type Discord = (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status: number; json: any }>
export function discordRest(fetcher: typeof fetch = fetch): Discord {
  let auth: string | null = null
  return async (method, path, body) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (omocat, 1.0)' }
    if (!path.startsWith('/interactions/')) {
      auth ??= `Bot ${JSON.parse(readFileSync(`${HOME}/.config/agent-messenger/discordbot-credentials.json`, 'utf8')).bots.omocat.token}`
      headers.Authorization = auth
    }
    const res = await fetcher(`https://discord.com/api/v10${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    let json: any = null
    try { json = text ? JSON.parse(text) : null } catch { json = { raw: text.slice(0, 200) } }
    return { ok: res.ok, status: res.status, json }
  }
}

export type Herdr = { read(pane: string): Promise<string>; keys(pane: string, ...keys: string[]): Promise<void>; text(pane: string, text: string): Promise<void> }
const run = async (args: string[]) => {
  const p = Bun.spawn(['herdr', ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 15_000, killSignal: 'SIGKILL' })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code !== 0) throw new Error(`herdr ${args.slice(0, 2).join(' ')} failed: ${(err || out).slice(0, 200)}`)
  return out
}
export const herdrCli: Herdr = {
  read: (pane) => run(['pane', 'read', pane, '--source', 'visible', '--lines', '60']),
  keys: async (pane, ...keys) => { await run(['pane', 'send-keys', pane, ...keys]) },
  text: async (pane, text) => { await run(['pane', 'send-text', pane, text]) },
}

export type Emit = (payload: Record<string, unknown>) => void
export type Deps = { store: Store; discord: Discord; herdr: Herdr; emit: Emit; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void }
const pause = (deps: Deps, ms: number) => (deps.sleep ?? Bun.sleep)(ms)

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
export function newAsk(input: Partial<Ask> & Pick<Ask, 'kind' | 'channel' | 'questions'>): Ask {
  return {
    id: newId(), messageIds: [], title: '', other: false, pane: null, session: null, key: null, logPath: null, callId: null,
    answers: {}, picks: {}, awaiting: null, status: 'open', note: null, createdAt: new Date().toISOString(), ...input,
  }
}

export function renderContent(a: Ask): string {
  const head = a.kind === 'pane' ? `**세션 질문** · \`${a.pane}\`${a.session ? ` · ${a.session}` : ''}` : `${a.title || '질문'}`
  const body = a.questions.map((q, qi) => {
    const title = `**${a.questions.length > 1 ? `${qi + 1}. ` : ''}${q.header ? `[${q.header}] ` : ''}${q.text}**${q.multiSelect ? ' _(여러 개 선택 후 "선택 완료")_' : ''}`
    const opts = q.options.filter((o) => o.description).map((o) => `• ${o.label} — ${o.description}`)
    const ans = a.answers[qi]
    const state = ans ? `→ 선택: ${answerLabel(q, ans)}` : a.awaiting === qi ? '→ 답을 이 스레드에 써 주세요' : ''
    return [title, ...opts, state].filter(Boolean).join('\n')
  })
  return [head, ...body, a.note ?? ''].filter(Boolean).join('\n\n').slice(0, 2000)
}

function components(a: Ask): unknown[][] {
  const chunks = chunkRows(questionRows(a.id, a.questions, a.answers, a.picks, { other: a.other }))
  const closed = a.status !== 'open'
  return chunks.map((chunk) => chunk.map(({ row }) => (closed ? { ...row, components: row.components.map((b) => ({ ...b, disabled: true })) } : row)))
}

export async function publish(a: Ask, deps: Deps): Promise<Ask> {
  const chunks = components(a)
  const ids: string[] = []
  for (const [i, rows] of chunks.entries()) {
    const res = await deps.discord('POST', `/channels/${a.channel}/messages`, { content: i === 0 ? renderContent(a) : '⏸ (계속)', components: rows })
    if (!res.ok || !res.json?.id) throw new Error(`discord send ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`)
    ids.push(res.json.id)
  }
  a.messageIds = ids
  deps.store.save(a)
  return a
}

export async function refresh(a: Ask, deps: Deps): Promise<void> {
  const chunks = components(a)
  for (const [i, id] of a.messageIds.entries()) {
    const res = await deps.discord('PATCH', `/channels/${a.channel}/messages/${id}`, { content: i === 0 ? renderContent(a) : '⏸ (계속)', components: chunks[i] ?? [] })
    if (!res.ok) deps.log?.(`omocat-buttons edit failed ${res.status}`)
  }
}

const allAnswered = (a: Ask) => a.questions.every((_, qi) => a.answers[qi] !== undefined)


export type Interaction = {
  id: string; token: string; channel_id?: string; type?: unknown
  member?: { user?: { id?: string; username?: string } }; user?: { id?: string; username?: string }
  message?: { id?: string; channel_id?: string }
  data?: { custom_id?: string; component_type?: number | string }
}
// The gateway listener overwrites `type` with the event name, so a component press is recognised by
// data.component_type (2 = button), never by the numeric interaction type.
export const isButton = (ev: Interaction) => String(ev.data?.component_type) === '2' && (ev.data?.custom_id ?? '').startsWith('oq|')

// `acked`: the press came through pr-board's relay, which already answered Discord (type 6).
export async function handleInteraction(ev: Interaction, deps: Deps, opts: { acked?: boolean } = {}): Promise<boolean> {
  if (!isButton(ev)) return false
  const user = ev.member?.user ?? ev.user ?? {}
  const base = { custom_id: ev.data!.custom_id!, channel: ev.message?.channel_id ?? ev.channel_id ?? null, message: ev.message?.id ?? null, interaction: ev.id, ...(opts.acked ? { via: 'relay' } : {}) }
  if (user.id !== OWNER_ID) {
    if (!opts.acked) await deps.discord('POST', `/interactions/${ev.id}/${ev.token}/callback`, { type: 4, data: { content: '이 버튼은 주인만 누를 수 있어요.', flags: 64 } })
    deps.emit({ event: 'rejected', ...base, user: { id: user.id ?? null, username: user.username ?? null } })
    return true
  }
  // Ack first: Discord's window is 3 seconds and the injection below takes longer.
  if (!opts.acked) {
    const ack = await deps.discord('POST', `/interactions/${ev.id}/${ev.token}/callback`, { type: 6 })
    if (!ack.ok) deps.log?.(`omocat-buttons ack failed ${ack.status}`)
  }
  const parsed = parseCustomId(base.custom_id)
  const a = parsed ? deps.store.get(parsed.id) : null
  if (!parsed || !a) { deps.emit({ event: 'stale', ...base, reason: 'unknown question' }); return true }
  const q = a.questions[parsed.qi]
  const payload = { ...base, id: a.id, kind: a.kind, pane: a.pane, question: q?.text ?? null }
  if (a.status !== 'open' || !q || a.answers[parsed.qi] !== undefined) {
    deps.emit({ event: 'stale', ...payload, label: null, reason: `question is ${a.status}` })
    return true
  }
  if (parsed.choice === 'w') {
    a.awaiting = parsed.qi
    deps.store.save(a)
    await refresh(a, deps)
    await deps.discord('POST', `/channels/${a.channel}/messages`, { content: `답을 이 스레드에 써 주세요: ${q.text}`.slice(0, 2000), message_reference: { message_id: a.messageIds[0], fail_if_not_exists: false } })
    deps.emit({ event: 'other', ...payload, label: '직접 입력' })
    return true
  }
  if (typeof parsed.choice === 'number') {
    if (!q.options[parsed.choice]) { deps.emit({ event: 'stale', ...payload, reason: 'unknown option' }); return true }
    if (q.multiSelect) {
      const cur = new Set(a.picks[parsed.qi] ?? [])
      if (cur.has(parsed.choice)) cur.delete(parsed.choice)
      else cur.add(parsed.choice)
      a.picks[parsed.qi] = [...cur].sort((x, y) => x - y)
      deps.store.save(a)
      await refresh(a, deps)
      deps.emit({ event: 'toggle', ...payload, label: q.options[parsed.choice]!.label, picked: a.picks[parsed.qi]!.map((i) => q.options[i]!.label) })
      return true
    }
    a.answers[parsed.qi] = { kind: 'option', index: parsed.choice }
  } else {
    a.answers[parsed.qi] = { kind: 'multi', indices: a.picks[parsed.qi] ?? [] }
  }
  a.awaiting = null
  await recordAnswer(a, parsed.qi, deps, payload)
  return true
}

export const RELAY_URL = cfg.discord.relayUrl

// One long poll of pr-board's relay; every press it returns is handled without a second ack.
export async function pollRelayOnce(deps: Deps, opts: { key: string; waitSeconds?: number; fetcher?: typeof fetch; url?: string }): Promise<number> {
  const res = await (opts.fetcher ?? fetch)(`${opts.url ?? RELAY_URL}?wait=${opts.waitSeconds ?? 25}`, {
    headers: { Authorization: `Bearer ${opts.key}` },
    signal: AbortSignal.timeout(((opts.waitSeconds ?? 25) + 15) * 1000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const items = (await res.json()) as Interaction[]
  for (const ev of items) {
    await handleInteraction(ev, deps, { acked: true }).catch((err: Error) => deps.log?.(`OMOCAT_ERROR relay handling failed: ${err.message}`))
  }
  return items.length
}

// An owner message in a channel where "직접 입력" is pending is the answer, not a new request.
export async function handleOwnerText(channel: string, text: string, messageId: string, deps: Deps): Promise<boolean> {
  const a = deps.store.awaitingIn(channel)
  if (!a || a.awaiting === null || !text.trim()) return false
  const qi = a.awaiting
  a.answers[qi] = { kind: 'text', text: text.trim() }
  a.awaiting = null
  await recordAnswer(a, qi, deps, { channel, message: a.messageIds[0] ?? null, from_message: messageId, id: a.id, kind: a.kind, pane: a.pane, question: a.questions[qi]!.text, custom_id: `oq|${a.id}|${qi}|w` })
  return true
}

async function recordAnswer(a: Ask, qi: number, deps: Deps, payload: Record<string, unknown>): Promise<void> {
  const label = answerLabel(a.questions[qi]!, a.answers[qi]!)
  if (!allAnswered(a)) {
    deps.store.save(a)
    await refresh(a, deps)
    deps.emit({ event: 'answer', ...payload, label, remaining: a.questions.length - Object.keys(a.answers).length })
    return
  }
  if (a.kind === 'ask') {
    a.status = 'answered'
    deps.store.save(a)
    await refresh(a, deps)
    deps.emit({ event: 'answer', ...payload, label, answers: summary(a) })
    return
  }
  deps.store.save(a)
  if (!deps.store.claim(a.id, 'open', 'injecting')) { deps.emit({ event: 'stale', ...payload, label, reason: 'already handled' }); return }
  a.status = 'injecting'
  a.note = '⏳ 세션에 답 넣는 중…'
  await refresh(a, deps)
  const result = await injectAnswers(a, deps)
  a.status = result.ok ? 'answered' : 'closed'
  a.note = result.ok ? `세션에 반영됨${result.text ? `: ${result.text.replace(/\n/g, ' / ').slice(0, 300)}` : ''}` : `세션에 넣지 못함: ${result.reason}. pane \`${a.pane}\` 에서 직접 답해 주세요`
  deps.store.save(a)
  await refresh(a, deps)
  deps.emit({ event: 'answer', ...payload, label, answers: summary(a), injected: result.ok, pane: a.pane, ...(result.ok ? {} : { reason: result.reason }) })
}

const summary = (a: Ask) => a.questions.map((q, qi) => ({ question: q.text, answer: a.answers[qi] ? answerLabel(q, a.answers[qi]!) : null }))

// Measured on OMO's ask_user_question UI: digit N picks option N (single-select: picks and moves on;
// a lone question submits at once); multi-select digits toggle and Tab moves on; "Type your own
// answer..." sits after the options (Down x option-count from the first option, Enter, text, Enter);
// after the last question a "Review your answers" tab is submitted with Enter.

const squash = (s: string) => s.replace(/\s+/g, '')
export async function injectAnswers(a: Ask, deps: Deps): Promise<{ ok: boolean; reason?: string; text?: string }> {
  const pane = a.pane!
  if (pane === SELF_PANE) return { ok: false, reason: 'OmOMeow 자신의 pane' }
  const before = await deps.herdr.read(pane).catch(() => '')
  const screen = parseOmoScreen(before)
  if (!screen) return { ok: false, reason: '질문 화면이 아님(이미 답했거나 취소됨)' }
  if (screen.answered !== 0 || screen.total !== a.questions.length || !screen.current || !squash(a.questions[0]!.text).startsWith(squash(screen.current.text).slice(0, 20))) {
    return { ok: false, reason: `pane 상태가 달라짐(${screen.answered}/${screen.total} answered)` }
  }
  for (const [qi, q] of a.questions.entries()) {
    const ans = a.answers[qi]!
    if (ans.kind === 'option') {
      if (ans.index > 8) return { ok: false, reason: '선택지 10번 이상은 자동 입력 불가' }
      await deps.herdr.keys(pane, String(ans.index + 1))
    } else if (ans.kind === 'multi') {
      if (ans.indices.some((i) => i > 8)) return { ok: false, reason: '선택지 10번 이상은 자동 입력 불가' }
      for (const i of ans.indices) { await deps.herdr.keys(pane, String(i + 1)); await pause(deps, 150) }
      await deps.herdr.keys(pane, 'tab')
    } else {
      await deps.herdr.keys(pane, ...Array(q.options.length).fill('down'), 'enter')
      await pause(deps, 300)
      await deps.herdr.text(pane, ans.text.replace(/[\u0000-\u001f\u007f]+/g, ' '))
      await pause(deps, 300)
      await deps.herdr.keys(pane, 'enter')
    }
    await pause(deps, 500)
  }
  let after = await deps.herdr.read(pane).catch(() => '')
  if (parseOmoScreen(after)?.review) { await deps.herdr.keys(pane, 'enter'); await pause(deps, 500) }
  for (let i = 0; i < 16; i++) {
    const res = a.logPath && a.callId ? questionResult(readTail(a.logPath), a.callId) : null
    if (res) return res.status === 'answered' ? { ok: true, text: res.text } : { ok: false, reason: `세션 기록 상태 ${res.status}` }
    after = await deps.herdr.read(pane).catch(() => '')
    if (!a.callId && !questionUiAtBottom(after)) return { ok: true }
    await pause(deps, 500)
  }
  return { ok: false, reason: questionUiAtBottom(after) ? '입력 후에도 질문 화면이 그대로임' : '세션 기록에서 결과를 확인하지 못함' }
}


export type PaneInfo = { pane: string; cwd: string; session: { key: string; thread: string | null; sessionId?: string } | null }
export type SyncResult = { posted?: Ask; closed: Ask[]; skipped?: string }

export async function syncPaneQuestion(info: PaneInfo, screenText: string, deps: Deps, root = sessionRoot()): Promise<SyncResult> {
  const closed: Ask[] = []
  if (info.pane === SELF_PANE) return { closed, skipped: 'self' }
  const screen = parseOmoScreen(screenText)
  const open = deps.store.openForPane(info.pane)
  if (!screen) {
    for (const a of open) closed.push(await closeAsk(a, deps))
    return { closed }
  }
  let found: { questions: PaneQuestion[]; callId: string | null; logPath: string | null } | null = null
  const candidates = sessionLogCandidates(info.cwd, info.session?.sessionId ?? null, root)
  for (const path of candidates) {
    const call = parseSessionQuestionCalls(readTail(path))
    if (call && (info.session?.sessionId && path.endsWith(`_${info.session.sessionId}.jsonl`) || callMatchesScreen(call, screen))) {
      found = { questions: call.questions, callId: call.callId, logPath: path }
      break
    }
  }
  if (!found && candidates.length > 0) return { closed, skipped: 'no open question call in the session log yet' }
  if (!found && screen.current && screen.tabs.length <= 1) found = { questions: [screen.current], callId: null, logPath: null }
  if (!found) return { closed, skipped: 'question not parsed (multi-question screen without a matching session log)' }
  const key = found.callId ? `${info.pane}|${found.callId}` : `${info.pane}|screen|${squash(found.questions[0]!.text)}|${found.questions[0]!.options.map((o) => o.label).join('/')}`
  if (deps.store.byKey(key)) return { closed, skipped: 'already posted' }
  for (const a of open) closed.push(await closeAsk(a, deps))
  const a = newAsk({ kind: 'pane', channel: info.session?.thread ?? GENERAL_CHANNEL, questions: found.questions, other: true, pane: info.pane, session: info.session?.key ?? null, key, logPath: found.logPath, callId: found.callId })
  return { posted: await publish(a, deps), closed }
}

async function closeAsk(a: Ask, deps: Deps): Promise<Ask> {
  if (!deps.store.claim(a.id, 'open', 'closed')) return a
  const res = a.logPath && a.callId ? questionResult(readTail(a.logPath), a.callId) : null
  a.status = 'closed'
  a.awaiting = null
  a.note = res?.status === 'answered' ? `응답됨 (pane 에서 직접): ${res.text.replace(/\n/g, ' / ').slice(0, 300)}` : res ? `취소됨 (${res.status})` : '질문 종료 (pane 에서 응답됐거나 취소됨)'
  // A screen-parsed question has no call id; freeing its key lets the same question be posted again later.
  if (!a.callId) a.key = null
  deps.store.save(a)
  await refresh(a, deps)
  return a
}
