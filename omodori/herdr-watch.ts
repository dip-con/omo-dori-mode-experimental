// Watches Herdr for sessions that turn blocked (approval/question UI) and for mapped
// OmOMeow sessions that finish a turn or disappear. Emits OMOCAT_HERDR lines.
//   bun herdr-watch.ts                          default source: herdr agent list + screen reads (unchanged)
//   bun herdr-watch.ts --source rpc [--once] [--since-min N]
//       reads the supervisor's events/supervisor.ndjson (redesign S4) and prints the same OMOCAT_HERDR shapes for
//       turn_done / gone / question; --once prints the last N (default 15) minutes and exits, otherwise follows the file.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { type Deps as ButtonDeps, SELF_PANE, Store, discordRest, herdrCli, syncPaneQuestion } from './buttons'
import { questionUiAtBottom } from './questions'

const MAP = `${process.env.HOME}/.omocat/sessions-map.json`
const SELF = process.env.HERDR_PANE_ID ?? SELF_PANE
const last = new Map<string, string>()
let first = true

const agents = async () => {
  const p = Bun.spawn(['herdr', 'agent', 'list'], { stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  if (code !== 0) throw new Error('herdr agent list failed')
  return JSON.parse(out).result.agents as { pane_id: string; agent: string; agent_status: string; cwd: string }[]
}
// Herdr does not flag OMO's question UI as blocked (it reports those panes as idle),
// so also look at the screen for the ask-user prompt (the real UI block at the bottom of the
// pane, not merely its strings: a pane showing source code used to trigger this).
const buttons: ButtonDeps = {
  store: new Store(),
  discord: discordRest(),
  herdr: herdrCli,
  emit: () => {},
  log: (line) => console.log(line),
}
const asking = new Set<string>()
const PROGRESS_EVERY_MS = 15 * 60_000
const progressAt = new Map<string, number>()
const fallbackSeen = new Map<string, string>()
const FALLBACK_RE = /fallback:\s*([\w./:-]+)/
const screenOf = async (pane: string) => {
  const p = Bun.spawn(['herdr', 'pane', 'read', pane, '--source', 'visible', '--lines', '60'], { stdout: 'pipe', stderr: 'ignore' })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  return code === 0 ? out : ''
}
type Mapped = { key: string; pane: string; status: string; thread: string | null; sessionId?: string }
const DORI_LANES = `${process.env.HOME}/.dori/state/lanes`
const mapped = (): Record<string, Mapped> => {
  const out: Record<string, Mapped> = existsSync(MAP) ? JSON.parse(readFileSync(MAP, 'utf8')) : {}
  // dori lanes (the registry of record since Dandori moved to dori-mode); thread refs are "discord:<id>"
  if (existsSync(DORI_LANES)) for (const f of readdirSync(DORI_LANES)) {
    if (!f.endsWith('.json')) continue
    try {
      const l = JSON.parse(readFileSync(`${DORI_LANES}/${f}`, 'utf8'))
      if (!l.pane) continue
      const thread = typeof l.thread === 'string' && l.thread.startsWith('discord:') ? l.thread.slice(8) : null
      out[`lane:${l.key}`] = { key: l.key, pane: l.pane, status: l.closedAt || l.status === 'closed' ? 'closed' : 'open', thread, sessionId: l.session }
    } catch { /* half-written lane file */ }
  }
  return out
}

// Always-on lanes that report on their own (kakao-push mirrors every Kakao send to Discord): no turn/progress wakes for the lead.
const QUIET = new Set(['kakao-family', 'kakao-owner', 'kakao-friend', 'kakao-acme-chat'])

// "gone" is confirmed, not guessed. `herdr agent list` only lists panes whose agent it has
// detected, so one poll can miss a live pane while its agent restarts or is re-detected; the old
// code woke the lead on the first miss (dori-improve w1W:p3, 2026-10-23T04:07Z, pane still working).
// A pane is gone only after GONE_MISS_LIMIT consecutive successful listings omit it.
export const GONE_MISS_LIMIT = 2
export type GoneState = { last: Map<string, string>; misses: Map<string, number> }
export type GoneHit = { pane: string; session: string }
export function confirmGone(
  sessions: { key: string; pane: string }[],
  hasPane: (pane: string) => boolean,
  state: GoneState,
  first: boolean,
): GoneHit[] {
  const hits: GoneHit[] = []
  for (const s of sessions) {
    if (hasPane(s.pane)) {
      state.misses.delete(s.pane)
      continue
    }
    if (first || !state.last.has(s.pane)) continue
    const n = (state.misses.get(s.pane) ?? 0) + 1
    state.misses.set(s.pane, n)
    if (n < GONE_MISS_LIMIT) continue
    hits.push({ pane: s.pane, session: s.key })
    state.misses.delete(s.pane)
    state.last.delete(s.pane)
  }
  return hits
}
const goneState: GoneState = { last, misses: new Map<string, number>() }

export async function runWatcher(): Promise<void> {
console.log('OMOCAT_HERDR_READY')
while (true) {
  try {
    const list = await agents()
    const byPane = new Map(list.map((a) => [a.pane_id, a]))
    const sessions = Object.values(mapped()).filter((s) => s.status === 'open')
    for (const a of list) {
      if (a.pane_id === SELF || a.pane_id === SELF_PANE) continue
      const prev = last.get(a.pane_id)
      const session = sessions.find((s) => s.pane === a.pane_id)
      if (!first && prev !== a.agent_status) {
        if (a.agent_status === 'blocked') {
          console.log(`OMOCAT_HERDR ${JSON.stringify({ event: 'blocked', pane: a.pane_id, agent: a.agent, cwd: a.cwd, session: session?.key ?? null })}`)
        } else if (session && !QUIET.has(session.key) && prev === 'working' && (a.agent_status === 'done' || a.agent_status === 'idle')) {
          console.log(`OMOCAT_HERDR ${JSON.stringify({ event: 'turn_done', pane: a.pane_id, session: session.key, thread: session.thread })}`)
        }
      }
      last.set(a.pane_id, a.agent_status)
      if (a.agent === 'omp' || a.agent === 'claude' || a.agent === 'pi') {
        const screen = await screenOf(a.pane_id)
        const isAsking = questionUiAtBottom(screen)
        if (isAsking && !asking.has(a.pane_id) && !first) {
          console.log(`OMOCAT_HERDR ${JSON.stringify({ event: 'question', pane: a.pane_id, agent: a.agent, cwd: a.cwd, session: session?.key ?? null })}`)
        }
        if (isAsking || asking.has(a.pane_id) || buttons.store.openForPane(a.pane_id).length > 0) {
          try {
            const info = { pane: a.pane_id, cwd: a.cwd, session: session ? { key: session.key, thread: session.thread, sessionId: session.sessionId } : null }
            const r = await syncPaneQuestion(info, screen, buttons)
            if (r.posted) console.log(`OMOCAT_HERDR ${JSON.stringify({ event: 'question_posted', pane: a.pane_id, session: session?.key ?? null, ask: r.posted.id, channel: r.posted.channel, messages: r.posted.messageIds, questions: r.posted.questions.map((q) => q.text) })}`)
            for (const c of r.closed) console.log(`OMOCAT_HERDR ${JSON.stringify({ event: 'question_closed', pane: a.pane_id, ask: c.id, status: c.status, note: c.note })}`)
          } catch (err) {
            console.log(`omomeow-herdr-watch buttons error: ${(err as Error).message}`)
          }
        }
        if (isAsking) asking.add(a.pane_id)
        else asking.delete(a.pane_id)
        const fb = screen.split('\n').slice(-6).join('\n').match(FALLBACK_RE)?.[1] ?? ''
        if (fb && fb !== fallbackSeen.get(a.pane_id) && !first) {
          console.log(`OMOCAT_HERDR ${JSON.stringify({ event: 'fallback', pane: a.pane_id, model: fb, session: session?.key ?? null, thread: session?.thread ?? null })}`)
        }
        fallbackSeen.set(a.pane_id, fb)
      }
    }
    for (const s of sessions) {
      if (s.thread && byPane.get(s.pane)?.agent_status === 'working' && !QUIET.has(s.key)) {
        const due = progressAt.get(s.key) ?? Date.now() + PROGRESS_EVERY_MS
        if (Date.now() >= due) {
          console.log(`OMOCAT_HERDR ${JSON.stringify({ event: 'progress_due', session: s.key, pane: s.pane, thread: s.thread })}`)
          progressAt.set(s.key, Date.now() + PROGRESS_EVERY_MS)
        } else if (!progressAt.has(s.key)) progressAt.set(s.key, due)
      }
    }
    for (const g of confirmGone(sessions, (pane) => byPane.has(pane), goneState, first)) {
      console.log(`OMOCAT_HERDR ${JSON.stringify({ event: 'gone', pane: g.pane, session: g.session })}`)
    }
    first = false
  } catch (err) {
    console.log(`omomeow-herdr-watch error: ${(err as Error).message}`)
  }
  await Bun.sleep(10_000)
}
}

/** One supervisor event as the OMOCAT_HERDR line herdr-source consumers already parse; null for kinds they never saw. */
export function rpcEventLine(ev: any): string | null {
  if (!ev || typeof ev.lane !== 'string') return null
  switch (ev.kind) {
    case 'lane.turn_done':
      if (QUIET.has(ev.lane)) return null
      return `OMOCAT_HERDR ${JSON.stringify({ event: 'turn_done', pane: ev.pane, session: ev.lane, thread: ev.thread ?? null, source: 'rpc', id: ev.id, turn_epoch: ev.data?.turn_epoch ?? null })}`
    case 'lane.gone':
      return `OMOCAT_HERDR ${JSON.stringify({ event: 'gone', pane: ev.pane, session: ev.lane, source: 'rpc', id: ev.id })}`
    case 'lane.question':
      return `OMOCAT_HERDR ${JSON.stringify({ event: 'question', pane: ev.pane, agent: null, cwd: null, session: ev.lane, source: 'rpc', id: ev.id })}`
    default: return null
  }
}

const SUPERVISOR_EVENTS = `${process.env.OMOCAT_HOME ?? `${process.env.HOME}/.omocat`}/events/supervisor.ndjson`
const printRpc = (line: string) => {
  let ev: any
  try { ev = JSON.parse(line) } catch { return }
  const out = rpcEventLine(ev)
  if (out) console.log(out)
}

export async function runRpcWatcher(opts: { once: boolean; sinceMin: number }): Promise<void> {
  if (opts.once) {
    const cutoff = Date.now() - opts.sinceMin * 60_000
    const text = existsSync(SUPERVISOR_EVENTS) ? readFileSync(SUPERVISOR_EVENTS, 'utf8') : ''
    for (const line of text.split('\n')) {
      if (!line) continue
      const at = Date.parse(/"at":"([^"]+)"/.exec(line)?.[1] ?? '')
      if (at >= cutoff) printRpc(line)
    }
    return
  }
  console.log('OMOCAT_HERDR_READY')
  const p = Bun.spawn(['tail', '-n', '0', '-F', SUPERVISOR_EVENTS], { stdout: 'pipe', stderr: 'ignore' })
  let buf = ''
  for await (const chunk of p.stdout.pipeThrough(new TextDecoderStream())) {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) { printRpc(buf.slice(0, i)); buf = buf.slice(i + 1) }
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--source')
  const source = i >= 0 ? argv[i + 1] : 'herdr'
  if (source === 'rpc') {
    const s = argv.indexOf('--since-min')
    await runRpcWatcher({ once: argv.includes('--once'), sinceMin: s >= 0 ? Number(argv[s + 1]) : 15 })
  } else await runWatcher()
}
