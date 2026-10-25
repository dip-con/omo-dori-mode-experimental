// Dori rule 18: deliver a message to an agent session safely and prove it arrived.
// 1. Resolve the pane and check it: a live OMO process in the foreground, the input box at the
//    bottom, and no question/approval UI or startup screen. Otherwise refuse (send nothing).
// 2. Tag the message with a unique id and submit it ONCE with `herdr pane run <pane> <text>`
//    (one argument, never a shell string).
// 3. Watch the session's own JSONL record (bounded) for a user message carrying that id.
//    Only that record counts as delivered; exit 0 or echoed input is not proof. On timeout the
//    result is "pending": inspect the screen, never resend or press Enter blindly.
import { readTail, questionUiAtBottom, sessionLogCandidates } from './questions'

export type Proc = { argv?: string[]; name?: string; cmdline?: string }
export type PaneCheck = { ok: true } | { ok: false; reason: string }
export type DeliverResult = { status: 'delivered' | 'pending' | 'refused'; id: string; pane: string; reason?: string; record?: string }

const OMO_ARGV = /@code-yeongyu\/senpi\/dist\/bundle\/cli\.js|omo-ai\/(?:dist|bin)\/|(?:^|\/)omo$/

export function isOmoProcess(procs: Proc[]): boolean {
  return procs.some((p) => (p.argv ?? (p.cmdline ? p.cmdline.split(' ') : [])).some((a) => OMO_ARGV.test(a)))
}

/** The OMO input box: a lone `❯` prompt line between two rules near the bottom of the screen. */
export function inputReady(screen: string): boolean {
  const lines = screen.split('\n').slice(-12)
  return lines.some((l, i) => /^❯/.test(l) && /^─{10,}/.test(lines[i - 1] ?? '') && /^─{10,}/.test(lines[i + 1] ?? ''))
}

export function checkPane(procs: Proc[], screen: string): PaneCheck {
  if (!isOmoProcess(procs)) return { ok: false, reason: 'no live OMO agent in the foreground (shell, exited or other program)' }
  if (/Init-deep/.test(screen) && /Skip this time/.test(screen)) return { ok: false, reason: 'OMO startup screen is open' }
  if (questionUiAtBottom(screen)) return { ok: false, reason: 'a question/approval UI is open in the pane' }
  if (!inputReady(screen)) return { ok: false, reason: 'OMO input box is not visible' }
  return { ok: true }
}

export const tagFor = (id: string) => `[dandori-msg:${id}]`
export const tagMessage = (text: string, id: string) => `${text.replace(/\s+$/, '')}\n\n${tagFor(id)}`

/** True when the session record holds a user message carrying the tag (receiver-side proof). */
export function recordHasTag(jsonl: string, id: string): boolean {
  const tag = tagFor(id)
  for (const line of jsonl.split('\n')) {
    if (!line.includes(tag)) continue
    try {
      const o = JSON.parse(line)
      if (o.type !== 'message' || o.message?.role !== 'user') continue
      const content = o.message.content
      const text = typeof content === 'string' ? content : (content ?? []).map((c: { text?: string }) => c.text ?? '').join('')
      if (text.includes(tag)) return true
    } catch { /* partial line while the session writes */ }
  }
  return false
}

export type Deps = {
  processes: (pane: string) => Promise<Proc[]>
  screen: (pane: string) => Promise<string>
  submit: (pane: string, text: string) => Promise<void>
  records: (cwd: string, sessionId: string) => string[]
  sleep: (ms: number) => Promise<void>
  newId: () => string
}

export async function deliver(
  deps: Deps, target: { pane: string; cwd: string; sessionId: string }, text: string,
  opts: { timeoutMs?: number; pollMs?: number; id?: string } = {},
): Promise<DeliverResult> {
  const id = opts.id ?? deps.newId()
  if (opts.id && deps.records(target.cwd, target.sessionId).some((r) => recordHasTag(r, id))) return { status: 'delivered', id, pane: target.pane, reason: 'already_persisted' }
  const check = checkPane(await deps.processes(target.pane), await deps.screen(target.pane))
  if (!check.ok) return { status: 'refused', id, pane: target.pane, reason: check.reason }
  await deps.submit(target.pane, tagMessage(text, id))
  const timeout = opts.timeoutMs ?? 45_000, poll = opts.pollMs ?? 1000
  for (let waited = 0; waited <= timeout; waited += poll) {
    const hit = deps.records(target.cwd, target.sessionId).find((r) => recordHasTag(r, id))
    if (hit !== undefined) return { status: 'delivered', id, pane: target.pane }
    await deps.sleep(poll)
  }
  const after = await deps.screen(target.pane)
  const hint = questionUiAtBottom(after) ? 'a question UI opened' : /queued|Queued/.test(after) ? 'message looks queued' : 'no session record yet'
  return { status: 'pending', id, pane: target.pane, reason: `${hint}; inspect the pane, do not resend` }
}

const run = async (args: string[]) => {
  const p = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code !== 0) throw new Error(`${args.slice(0, 3).join(' ')} failed: ${(err || out).trim()}`)
  return out
}

export const liveDeps: Deps = {
  processes: async (pane) => JSON.parse(await run(['herdr', 'pane', 'process-info', '--pane', pane])).result.process_info.foreground_processes,
  screen: (pane) => run(['herdr', 'pane', 'read', pane, '--source', 'visible', '--lines', '40']),
  submit: async (pane, text) => { await run(['herdr', 'pane', 'run', pane, text]) },
  records: (cwd, sessionId) => sessionLogCandidates(cwd, sessionId).map((f) => readTail(f)),
  sleep: (ms) => Bun.sleep(ms),
  newId: () => crypto.randomUUID().slice(0, 12),
}
