// Herdr sessions: one Herdr tab per piece of work, mapped to its Discord thread.
// Text always goes to panes as an argument list (never through a shell string).
//   open <key> <label> <cwd> <brief-file> [thread-id]   new tab + OMO session (--session-id), send brief
//   send <key> <text> [--id X] [--mode m] [--plan]      deliver text: rpc for keys in transport.json, else herdr (Dori rule 18)
//   status <key> [--json]                                rpc get_state of the lane + the registry's endpoint cache
//   receipt <key> <id>                                   persisted | absent from the session JSONL
//   close <key> [--expect-tab T]                         close its tab (session id kept for reopen)
//   reopen <key> [text]                                  new tab resuming the same OMO session (OMODORI_FRESH=1: new session)
//   list                                                 print the map
// Redesign S3: open/close/reopen run inside the lane's lifecycle lease
// (registry.ts withLaneLease) and write the map only through patchLane with a generation CAS.
// Exit codes: 0 ok, 3 sent but no receipt yet, 4 refused (lease_held, tab_moved, rpc refusal), 6 held_elsewhere
// (another live process holds the session file, nothing started).
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { checkPane, liveDeps } from './deliver'
import { receipt, rpc, transportFor } from './rpc'
import { channelSessionAllowed, loadChannels } from './dori-guard'
import { sessionDirSlug, sessionRoot } from './questions'
import { addLineage, appendEvent, type Entry, LANE_KEY_RE, liveHolders, patchLane, paths, readMap, RegistryError, updateDoriLane, withLaneLease } from './registry'
import { homeRef, cfg } from './config'

const MODEL = process.env.OMODORI_MODEL ?? 'anthropic-subscription/claude-opus-5-5'
const THINKING = process.env.OMODORI_THINKING ?? 'medium'

const herdr = async (...args: string[]) => {
  const p = Bun.spawn(['herdr', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code !== 0) throw new Error(`herdr ${args.slice(0, 2).join(' ')} failed: ${err || out}`)
  return out.trim() ? JSON.parse(out) : null
}
const herdrText = async (...args: string[]) => {
  const p = Bun.spawn(['herdr', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  return code === 0 ? out : ''
}
// Every handed-off brief tells the session how to claim done (Dori rule 19a).
const claimRule = (key: string) =>
  `[${cfg.lead.name} 규칙] 끝났다고 판단되면 근거와 함께 \`dori claim-done ${key} --evidence "<머지 SHA, 닫힌 이슈, 배포 SHA, 결과 파일>"\`로 완료를 주장해. ${cfg.lead.name}가 5분 안에 근거를 직접 확인해서 닫거나(dori close), 이유와 함께 not-done으로 돌려보내. 커밋·푸시 안 된 작업이 있으면 닫히지 않아. 중간 보고는 \`[REPORT] ${key} | <milestone|blocker|question|done> | <내용>\` 형식으로 ${cfg.lead.name} 창에 보내.`

// Every sess.ts session is also a dori lane (Done = approved <key>: the lead verifies the claim, writes the approval, closes).
// The lane file is changed only under its per-key lock (registry.ts updateDoriLane, same protocol as dori Registry.update).
const doriLane = async (e: Entry, briefText: string) => {
  const now = new Date().toISOString()
  const thread = e.thread ? `discord:${e.thread}` : 'none'
  const updated = await updateDoriLane(e.key, (l) => l && {
    ...l, pane: e.pane, tab: e.tab, session: e.sessionId, thread, status: 'working', closedAt: undefined, claim: undefined, objection: undefined,
    history: [...(l.history ?? []), { at: now, status: 'working', note: 'reopened by sess.ts' }],
  })
  if (updated) return console.log(`DORI_LANE reopened ${e.key}`)
  const brief = `${process.env.HOME}/.dori/state/briefs/${e.key}.md`
  await Bun.write(brief, briefText)
  const p = Bun.spawn(['dori', 'adopt', e.key, '--pane', e.pane, '--title', e.label, '--brief', brief, '--done', `approved ${e.key}`, '--thread', thread], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  console.log(`DORI_LANE ${(out || err).trim()}`)
}
const closeDoriLane = async (key: string, closedAt: string) => {
  await updateDoriLane(key, (l) => (l && !l.closedAt
    ? { ...l, status: 'closed', closedAt, history: [...(l.history ?? []), { at: closedAt, status: 'closed', note: 'tab closed by sess.ts (idle or done)' }] }
    : null))
}

// Exit codes: 0 delivered, 3 pending/uncertain (sent, no receipt yet: check the receipt of the same id, never resend
// under a new id), 4 refused (nothing sent).
const sendTo = async (e: Entry, text: string, opts: { id?: string; mode?: 'steer' | 'follow_up' | 'prompt' } = {}) => {
  const r = await rpc.dispatch(e, text, { id: opts.id ?? liveDeps.newId(), mode: opts.mode, transport: transportFor(e.key) }, liveDeps)
  console.log(JSON.stringify(r))
  // redesign S9: one delivery.* event per outcome (supervisor events file, the router's input) so nudges/seeds are auditable.
  const kind = r.status === 'delivered' ? 'delivery.persisted' : r.status === 'refused' ? 'delivery.refused' : 'delivery.uncertain'
  try {
    const { appendSupEvent } = await import('./dori-supervisor')
    appendSupEvent(paths().home, { id: `${kind}:${r.id}`, kind, severity: kind === 'delivery.persisted' ? 'info' : 'act', lane: e.key, durableId: e.sessionId, data: { id: r.id, transport: r.transport, ...('reason' in r && r.reason ? { reason: r.reason } : {}) } })
  } catch (err) { console.error(`delivery event not written: ${(err as Error).message}`) }
  if (r.status === 'refused') process.exitCode = 4
  else if (r.status !== 'delivered') process.exitCode = 3
  return r
}
const takeFlag = (a: string[], name: string) => { const i = a.indexOf(name); if (i < 0) return undefined; const v = a[i + 1]; a.splice(i, 2); return v }
const takeBool = (a: string[], name: string) => { const i = a.indexOf(name); if (i < 0) return false; a.splice(i, 1); return true }

async function workspaceFor(cwd: string): Promise<string> {
  const label = basename(cwd)
  const ws = (await herdr('workspace', 'list')).result.workspaces as { workspace_id: string; label: string }[]
  const found = ws.find((w) => w.label === label)
  if (found) return found.workspace_id
  return (await herdr('workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus')).result.workspace.workspace_id
}

// Start OMO in the pane and wait until it is ready for input (skipping the one-time init-deep prompt).
// The lane key rides along in the environment so per-lane extensions (Kakao room binding) know their lane.
// Ready also needs a live session holder for this exact session id (<slug>/session-holders/<id>/<pid>.json): a hung
// cold start can draw the input box without ever holding the session (bokdong synthesis #6).
export async function startOmo(pane: string, sessionId: string, key: string, cwd: string, opts: { timeoutMs?: number; pollMs?: number; root?: string } = {}) {
  if (!LANE_KEY_RE.test(key)) throw new Error(`bad lane key ${key}`)
  await herdr('pane', 'run', pane, `OMODORI_LANE_KEY=${key} omo --model ${MODEL} --thinking ${THINKING} --session-id ${sessionId}${process.env.OMODORI_OMO_ARGS ? ` ${process.env.OMODORI_OMO_ARGS}` : ''}`)
  const timeoutMs = opts.timeoutMs ?? 90_000
  const holderProbe = join(opts.root ?? sessionRoot(), sessionDirSlug(cwd), 'probe')
  const until = Date.now() + timeoutMs
  let uiReady = false
  while (Date.now() < until) {
    await Bun.sleep(opts.pollMs ?? 2000)
    const screen = await herdrText('pane', 'read', pane, '--source', 'visible', '--lines', '40')
    if (/Init-deep/.test(screen) && /Skip this time/.test(screen)) {
      await herdr('pane', 'send-keys', pane, 'down')
      await herdr('pane', 'send-keys', pane, 'enter')
      continue
    }
    const procs = (await herdr('pane', 'process-info', '--pane', pane)).result.process_info.foreground_processes
    uiReady = checkPane(procs, screen).ok
    if (uiReady && (await liveHolders(holderProbe, sessionId)).length) return
  }
  throw new Error(uiReady
    ? `OMO in ${pane} shows the input box but has no live session holder for ${sessionId} after ${timeoutMs / 1000}s (hung cold start?)`
    : `OMO in ${pane} did not become ready in ${timeoutMs / 1000}s`)
}

export function findSessionFile(durableId: string, cwd: string | null, root = sessionRoot()): string | null {
  const suffix = `_${durableId}.jsonl`
  const inDir = (dir: string) => { try { const f = readdirSync(dir).find((x) => x.endsWith(suffix)); return f ? join(dir, f) : null } catch { return null } }
  if (cwd) { const hit = inDir(join(root, sessionDirSlug(cwd))); if (hit) return hit }
  let dirs: string[] = []
  try { dirs = readdirSync(root) } catch { return null }
  for (const d of dirs) { const hit = inDir(join(root, d)); if (hit) return hit }
  return null
}

export type LifecycleDeps = {
  home?: string
  herdr: (...args: string[]) => Promise<any>
  workspaceFor: (cwd: string) => Promise<string>
  startOmo: (pane: string, sessionId: string, key: string, cwd: string) => Promise<void>
  panePids: (pane: string) => Promise<number[]>
  findSession: (durableId: string, cwd: string | null) => string | null
  doriLane: (e: Entry, text: string) => Promise<void>
  closeDoriLane: (key: string, closedAt: string) => Promise<void>
  send: (e: Entry, text: string) => Promise<unknown>
  log: (line: string) => void
  newId: () => string
}
export type Outcome = { exit: number; out?: unknown }

const leaseRefusal = (e: unknown): Outcome | null =>
  e instanceof RegistryError && e.code === 'lease_held' ? { exit: 4, out: e.message } : null

async function holdersBefore(deps: LifecycleDeps, e: Entry, sessionId: string): Promise<{ path: string | null; refusal: Outcome | null }> {
  const path = deps.findSession(sessionId, e.cwd)
  const held = path ? await liveHolders(path, sessionId) : []
  return { path, refusal: held.length ? { exit: 6, out: { error: 'held_elsewhere', key: e.key, sessionId, holders: held.map((h) => h.pid) } } : null }
}

// After start: a live holder outside the pane is a second writer of the same transcript. Reported once per generation.
async function holdersAfter(deps: LifecycleDeps, key: string, generation: number, pane: string, path: string | null, sessionId: string) {
  if (!path) return
  const panePids = await deps.panePids(pane).catch(() => [] as number[])
  const foreign = (await liveHolders(path, sessionId)).filter((h) => !panePids.includes(h.pid))
  if (!foreign.length) return
  const fresh = appendEvent({ id: `lane.holder_conflict:${key}:${generation}`, kind: 'lane.holder_conflict', lane: key, durableId: sessionId, generation, pane, holders: foreign.map((h) => h.pid) }, deps.home)
  if (fresh) deps.log(`LANE_HOLDER_CONFLICT ${key} session=${sessionId} pane=${pane} foreign_pids=${foreign.map((h) => h.pid).join(',')} -> ask: close one of the two writers`)
}

export async function openLane(deps: LifecycleDeps, a: { key: string; label: string; cwd: string; thread: string | null; briefText: string; noClaim: boolean }): Promise<Outcome> {
  try {
    return await withLaneLease(a.key, 'open', async () => {
      const cur = readMap(deps.home)[a.key]
      if (cur?.status === 'open') throw new Error(`${a.key} is already open in ${cur.tab}`)
      const g = cur?.generation ?? 0
      const sessionId = cur?.sessionId ?? deps.newId()
      const pre = cur ? await holdersBefore(deps, cur, sessionId) : { path: null, refusal: null }
      if (pre.refusal) return pre.refusal
      const workspace = await deps.workspaceFor(a.cwd)
      const created = (await deps.herdr('tab', 'create', '--workspace', workspace, '--cwd', a.cwd, '--label', a.label, '--no-focus')).result
      const pane = created.root_pane.pane_id as string
      await deps.startOmo(pane, sessionId, a.key, a.cwd)
      const e = await patchLane(a.key, g, {
        key: a.key, label: a.label, cwd: a.cwd, thread: a.thread, workspace, tab: created.tab.tab_id, pane, sessionId, status: 'open',
        openedAt: new Date().toISOString(), closedAt: undefined, generation: g + 1, sessionVia: 'open', endpoint: undefined,
      }, { home: deps.home })
      deps.log(JSON.stringify(e))
      if (cur) await holdersAfter(deps, a.key, g + 1, pane, pre.path, sessionId)
      const text = `${a.briefText}${a.noClaim ? '' : `\n\n${claimRule(a.key)}`}`
      if (!a.noClaim) await deps.doriLane(e, text)
      await deps.send(e, text)
      return { exit: 0, out: e }
    }, { home: deps.home })
  } catch (e) { const r = leaseRefusal(e); if (r) return r; throw e }
}

export async function closeLane(deps: LifecycleDeps, key: string, expected: { tab?: string } = {}): Promise<Outcome> {
  const before = readMap(deps.home)[key]
  if (!before) throw new Error(`unknown ${key}`)
  const expectTab = expected.tab ?? before.tab
  try {
    return await withLaneLease(key, 'close', async () => {
      const e = readMap(deps.home)[key]!
      if (e.tab !== expectTab) return { exit: 4, out: { error: 'tab_moved', key, expected: expectTab, actual: e.tab } }
      const g = e.generation ?? 0
      if (e.status === 'open') await deps.herdr('tab', 'close', e.tab).catch((err: Error) => deps.log(`tab already gone: ${err.message}`))
      const closedAt = new Date().toISOString()
      await patchLane(key, g, { status: 'closed', closedAt, generation: g + 1 }, { home: deps.home })
      deps.log(`closed ${key}`)
      await deps.closeDoriLane(key, closedAt)
      return { exit: 0 }
    }, { home: deps.home })
  } catch (e) { const r = leaseRefusal(e); if (r) return r; throw e }
}

export async function reopenLane(deps: LifecycleDeps, a: { key: string; text: string; fresh: boolean; noClaim: boolean }): Promise<Outcome> {
  try {
    return await withLaneLease(a.key, 'reopen', async () => {
      const e = readMap(deps.home)[a.key]
      if (!e) throw new Error(`unknown ${a.key}`)
      if (e.status === 'open') throw new Error(`${e.key} is still open in ${e.tab}`)
      const g = e.generation ?? 0
      // OMODORI_FRESH=1 drops the old conversation (a long one slows every turn); the brief must carry the rules.
      const sessionId = a.fresh ? deps.newId() : e.sessionId
      const pre = a.fresh ? { path: null, refusal: null } : await holdersBefore(deps, e, sessionId)
      if (pre.refusal) return pre.refusal
      const workspace = await deps.workspaceFor(e.cwd)
      const created = (await deps.herdr('tab', 'create', '--workspace', workspace, '--cwd', e.cwd, '--label', e.label, '--no-focus')).result
      const pane = created.root_pane.pane_id as string
      await deps.startOmo(pane, sessionId, e.key, e.cwd)
      const next = await patchLane(e.key, g, {
        workspace, tab: created.tab.tab_id, pane, sessionId, status: 'open', closedAt: undefined, generation: g + 1, sessionVia: 'open', endpoint: undefined,
        ...(sessionId !== e.sessionId ? { lineage: addLineage(e.lineage, e.sessionId), sessionPath: undefined } : {}),
      }, { home: deps.home })
      deps.log(JSON.stringify(next))
      if (!a.fresh) await holdersAfter(deps, e.key, g + 1, pane, pre.path, sessionId)
      const text = `${a.text}${a.noClaim ? '' : `\n\n${claimRule(e.key)}`}`
      if (!a.noClaim) await deps.doriLane(next, text)
      if (a.text) await deps.send(next, text)
      return { exit: 0, out: next }
    }, { home: deps.home })
  } catch (e) { const r = leaseRefusal(e); if (r) return r; throw e }
}

const panePids = async (pane: string): Promise<number[]> =>
  ((await herdr('pane', 'process-info', '--pane', pane)).result.process_info.foreground_processes as any[]).map((p) => Number(p.pid)).filter(Number.isFinite)

export const liveLifecycleDeps = (): LifecycleDeps => ({
  herdr, workspaceFor, startOmo, panePids, findSession: (id, cwd) => findSessionFile(id, cwd), doriLane, closeDoriLane,
  send: (e, text) => sendTo(e, text), log: (l) => console.log(l), newId: () => crypto.randomUUID(),
})

const report = (o: Outcome) => {
  if (o.out !== undefined && o.exit !== 0) console.log(typeof o.out === 'string' ? o.out : JSON.stringify(o.out))
  if (o.exit !== 0) process.exitCode = o.exit
}

if (import.meta.main) {
  // KakaoTalk lanes are standing bots, not done-tracked work: no dori lane record (no nudges), and no claim/[REPORT]
  // rule, which they have no herdr access for and would post into the chat room instead.
  const noClaim = process.env.OMODORI_NO_CLAIM === '1'
  const [cmd, ...args] = process.argv.slice(2)
  const map = readMap()
  switch (cmd) {
    case 'open': {
      const [key, label, cwd, briefFile, thread] = args
      const channel = thread && !channelSessionAllowed(thread.replace(/^discord:/, ''), key) && loadChannels().get(thread.replace(/^discord:/, ''))
      if (channel) { console.error(`refused: ${thread} is the channel ${channel}, not a thread. Make a thread first (bun ${homeRef()}/mkthread.ts <channel> <message-id> "<name>").`); process.exit(4) }
      report(await openLane(liveLifecycleDeps(), { key: key!, label: label!, cwd: cwd!, thread: thread ?? null, briefText: readFileSync(briefFile!, 'utf8'), noClaim }))
      break
    }
    case 'send': {
      const a = [...args]
      const id = takeFlag(a, '--id')
      const mode = takeFlag(a, '--mode') as 'steer' | 'follow_up' | 'prompt' | undefined
      const plan = takeBool(a, '--plan')
      const e = map[a[0]!]
      if (!e || e.status !== 'open') throw new Error(`${a[0]} is not open`)
      if (plan) { console.log(JSON.stringify({ key: e.key, transport: transportFor(e.key), sent: false, ...(id ? { id } : {}) })); break }
      await sendTo(e, a.slice(1).join(' '), { id, mode })
      break
    }
    case 'status': {
      const e = map[args[0]!]
      if (!e) throw new Error(`unknown ${args[0]}`)
      const r = await rpc.resolve(e.key)
      const st = await rpc.state(e.key).catch((err: Error) => ({ error: err.message }))
      console.log(JSON.stringify({
        ...st, key: e.key, generation: e.generation ?? 0,
        endpoint: r.routing ? { kind: r.routing.kind, socket: r.routing.socket, instanceId: r.routing.instanceId } : null,
        registryEndpoint: e.endpoint ?? null,
      }))
      break
    }
    case 'receipt': {
      if (!map[args[0]!] || !args[1]) throw new Error('usage: sess.ts receipt <key> <id>')
      const r = await rpc.resolve(args[0]!)
      const st = receipt(r.sessionPath, args[1])
      console.log(JSON.stringify({ key: args[0], id: args[1], sessionPath: r.sessionPath, receipt: st }))
      if (st !== 'persisted') process.exitCode = 3
      break
    }
    case 'close': {
      const a = [...args]
      const tab = takeFlag(a, '--expect-tab')
      report(await closeLane(liveLifecycleDeps(), a[0]!, { tab }))
      break
    }
    case 'reopen':
      report(await reopenLane(liveLifecycleDeps(), { key: args[0]!, text: args.slice(1).join(' '), fresh: process.env.OMODORI_FRESH === '1', noClaim }))
      break
    case 'list':
      console.log(JSON.stringify(map, null, 2))
      break
    default:
      console.log('usage: sess.ts open|send|status|receipt|close|reopen|list ...')
  }
}
