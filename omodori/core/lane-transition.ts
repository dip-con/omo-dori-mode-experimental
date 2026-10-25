// Lane transition (redesign S8): the one path for reset, quota moves, GPT fallback,
// Claude return and migrate. The lane keeps its key; it gets a FRESH session (new durable id) seeded with a handoff artifact.
//   bun lane-transition.ts <key> --fresh [--account A | --model M [--thinking T]] [--reason quota|reset|manual]
//                          [--profile P] [--dry] [--force] [--settle-timeout SECONDS]
//   bun lane-transition.ts --resume <opId>          continue a crashed/failed op after its last done step
// Steps (each recorded in DORI_HOME/ops/<opId>.json as `step` = last done step, plus history):
//    1 lease        lane lifecycle lease (registry.ts format, op 'transition'); a live holder -> exit 4 lease_held
//    2 preconds     children known and none running (else exit 4 children_unknown / children_running, --force skips);
//                   reason != quota: settled wait (rpc wait + recheck, max --settle-timeout, default 2 h) -> exit 4 not_settled
//    3 admission    the lease pauses each source's admission (the source checks it); wait <= 120 s until no enabled
//                   source reports an in-flight batch for this lane (source transition hook inflight())
//    4 inventory    old transcript: delivery with a successful assistant entry after it = processed, else carried;
//                   each enabled source's transition hook inventory() settles what it handed over (inventory.sources).
//                   One line per op in DORI_HOME/lane-transitions.jsonl
//    5 artifact     ~/.dori/state/handoffs/<key>/g<N>.md (brief + checkpoint + carried list + claim rule unless noClaim);
//                   then the profile's beforeClose hooks
//    6 close        herdr tab close of the recorded old tab (CAS on the registry tab); processes still carrying the old
//                   session id afterwards are recorded (lane.old_session_alive)
//    7 open         new tab + `omo ... --session-id <new> [-e ..] [--tools ..] [--claude-account A] @<artifact> '<seed tag>'`:
//                   the brief goes in as an attached file, never as typed text
//    8 verify       the pane process argv has the requested --claude-account (or none for GPT) and the new session id
//    9 rebind       patchLane(key, g -> g+1): session, tab, pane, profile, model, accountRequested, seed {state: pending}
//   10 seed         seed id receipt (user message carrying [dori-msg:seed:<key>:<N>]) -> seed.state applied; one fallback
//                   send with the same id; still unconfirmed -> last 80 screen lines kept, new tab closed, lane closed,
//                   lease released, ask lane.empty_after_handoff (exit 1)
//   11 carry        carried transcript deliveries re-sent in order as <id>:g<N>; lane-migrations.jsonl; lease released
//   after the lease: the account binding sidecar is checked once (lane.account_bound / lane.account_mismatch)
// Source batches are never re-sent here: carried batches stay in the source's queue and the source sends them (same
// batch id) once seed.state is applied and the lease is gone.
// Exit codes: 0 done, 1 failed (op kept; --resume continues it), 2 usage, 4 refused (nothing changed or op ended cleanly).
// OMODORI_HOME (default ~/.omodori) roots map, leases, ops, queue, ledgers, and (when set) handoffs; tests use a temp tree.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkPane, isOmoProcess, tagFor, type Proc } from './deliver'
import { GPT_FALLBACK } from './lane-classify'
import { acquireDirLock, addLineage, appendEvent, type Entry, type Held, LANE_KEY_RE, paths, patchLane, readMap, RegistryError, updateDoriLane } from './registry'
import { receipt } from './rpc'
import { cfg, doriHome, installHome, coreRef } from './config'
import { loadEnabled, profileDirs, type SourceModule } from './sources'

const HOME = process.env.HOME!
export const DEFAULT_MODEL = 'anthropic-subscription/claude-opus-5-5'
export const DEFAULT_THINKING = 'medium'
const CLAUDE = 'anthropic-subscription/'
export const STEP_NAMES = ['', 'lease', 'preconds', 'admission', 'inventory', 'artifact', 'close', 'open', 'verify', 'rebind', 'seed', 'carry'] as const
export const LAST_STEP = 11

export type Profile = {
  name: string; ext: string[]; tools: string | null; model?: string | null; thinking?: string | null
  modelFile?: string; modelDefault?: string; thinkingFile?: string; thinkingDefault?: string
  noClaim: boolean; briefPath?: string | null; label?: string; cwd?: string; thread?: string | null
  checkpointOnReset?: boolean; busyFiles?: string[]; beforeClose?: string[][]
}
export type Reason = 'quota' | 'reset' | 'manual'
export type Args = { key: string; account?: string; model?: string; thinking?: string; reason: Reason; profile?: string; force?: boolean; settleTimeoutMs?: number }
export type Delivered = { id: string; text: string; ts: string }
export type Inventory = {
  oldSessionPath: string | null
  processed: string[]
  carried: Delivered[]
  /** Per enabled source: what its transition hook settled (persisted / carried / queued batch ids). */
  sources: Record<string, unknown>
}
export type TransitionHook = { name: string; hook: NonNullable<SourceModule['transition']> }
export async function enabledTransitionHooks(): Promise<TransitionHook[]> {
  return (await loadEnabled()).flatMap(({ manifest, mod }) => (mod?.transition ? [{ name: manifest.name, hook: mod.transition }] : []))
}
export type Op = {
  v: 1; opId: string; key: string; args: Args; status: 'running' | 'done' | 'failed' | 'refused'; step: number
  history: { step: number; run: number; at: string }[]; runs: number
  g: number; createdAt: string; updatedAt: string
  from: { durableId: string; sessionPath: string | null; tab: string; pane: string; status: string; account: string | null; model: string | null } | null
  lane: { label: string; cwd: string; thread: string | null }
  profile: string; model: string; thinking: string; account: string | null
  newSessionId: string; seedId: string; argv?: string[]; artifact?: string
  inventory?: Inventory; opened?: { workspace: string; tab: string; pane: string; ranAt?: string }
  newSessionPath?: string | null; seedFallbackAt?: string; carriedSent?: Record<string, string>
  oldProcs?: { pid: number; cmd: string }[]; screen?: string[]; error?: string; refusal?: string; accountCheck?: string
}

export class TransitionCrash extends Error { constructor(readonly point: string) { super(`crash at ${point}`) } }
class Refused extends Error { constructor(readonly code: string, readonly detail?: unknown) { super(code) } }

export type TransitionDeps = {
  home: string
  handoffsDir: string
  briefsDir: string
  profilesDir: string | string[]
  /** Source transition hooks; defaults to the enabled sources' (config.json sources[]). */
  transitionHooks?: () => Promise<TransitionHook[]>
  herdr: (...args: string[]) => Promise<any>
  herdrText: (...args: string[]) => Promise<string>
  workspaceFor: (cwd: string) => Promise<string>
  children: (key: string) => Promise<{ state: string; running: number; reasons?: string[] }>
  status: (key: string) => Promise<{ settled: boolean; status: string }>
  waitIdle: (key: string, ms: number) => Promise<void>
  findSession: (durableId: string, cwd: string | null) => string | null
  send: (e: Entry, text: string, id: string) => Promise<{ status: string; reason?: string }>
  sessionProcs: (durableId: string) => Promise<{ pid: number; cmd: string }[]>
  runHook: (argv: string[]) => Promise<number>
  sleep: (ms: number) => Promise<void>
  now: () => number
  newId: () => string
  log: (line: string) => void
  crash?: (point: string) => void
  onSeedWait?: () => Promise<void>
  readyTimeoutMs?: number
  receiptWaitMs?: number
  inflightWaitMs?: number
  oldProcWaitMs?: number
  accountWaitMs?: number
}

// Profile paths may start with ~, {home} (the data folder: config.json paths.dataDir / OMODORI_HOME) or {install}
// (the folder with the code: OMODORI_HOME / ~/.omodori).
const expand = (p: string) => p.replace(/^\{home\}(?=\/|$)/, doriHome()).replace(/^\{install\}(?=\/|$)/, installHome()).replace(/^~(?=\/|$)/, HOME)
const readTrim = (p: string) => { try { return readFileSync(expand(p), 'utf8').trim() || null } catch { return null } }
const iso = (ms: number) => new Date(ms).toISOString()

const dirsOf = (dir: string | string[]) => (Array.isArray(dir) ? dir : [dir])
const profileFile = (name: string, dir: string | string[]) => dirsOf(dir).map((d) => join(d, `${name}.json`)).find((f) => existsSync(f)) ?? null
export function profileName(key: string, explicit: string | undefined, entry: Entry | undefined, dir: string | string[]): string {
  if (explicit) return explicit
  if (typeof entry?.profile === 'string') return entry.profile
  return profileFile(key, dir) ? key : 'default'
}
export function loadProfile(name: string, dir: string | string[]): Profile {
  if (!LANE_KEY_RE.test(name)) throw new Refused('bad_profile', name)
  const f = profileFile(name, dir)
  if (!f) throw new Refused('unknown_profile', join(dirsOf(dir)[0]!, `${name}.json`))
  const p = JSON.parse(readFileSync(f, 'utf8'))
  return { name, ext: p.ext ?? [], tools: p.tools ?? null, noClaim: !!p.noClaim, ...p }
}

/** Model/thinking/account of the new session: explicit flags > profile > registry entry > Opus 5.5 medium. */
export function sessionSpec(profile: Profile, entry: Entry | undefined, a: Pick<Args, 'account' | 'model' | 'thinking'>) {
  if (a.account && a.model && !a.model.startsWith(CLAUDE)) throw new Refused('account_needs_claude_model', a.model)
  const profModel = profile.model ?? (profile.modelFile ? readTrim(profile.modelFile) ?? profile.modelDefault ?? null : null)
  const profThinking = profile.thinking ?? (profile.thinkingFile ? readTrim(profile.thinkingFile) ?? profile.thinkingDefault ?? null : null)
  const entryModel = typeof entry?.model === 'string' ? entry.model : null
  const entryThinking = typeof entry?.thinking === 'string' ? entry.thinking : null
  let model = a.model ?? profModel ?? entryModel ?? DEFAULT_MODEL
  if (a.account && !a.model && !model.startsWith(CLAUDE)) model = profModel?.startsWith(CLAUDE) ? profModel : DEFAULT_MODEL
  const thinking = a.thinking ?? (a.model && !a.model.startsWith(CLAUDE) ? GPT_FALLBACK.thinking : profThinking ?? entryThinking ?? DEFAULT_THINKING)
  return { model, thinking, account: model.startsWith(CLAUDE) ? a.account ?? null : null }
}

export function buildArgv(o: { key: string; sessionId: string; model: string; thinking: string; account: string | null; profile: Profile; attach?: { file: string; message: string } }): string[] {
  return [
    `OMODORI_LANE_KEY=${o.key}`, `OMODORI_MODEL=${o.model}`, `OMODORI_THINKING=${o.thinking}`,
    'omo', '--model', o.model, '--thinking', o.thinking, '--session-id', o.sessionId,
    ...o.profile.ext.flatMap((e) => ['-e', expand(e)]),
    ...(o.profile.tools ? ['--tools', o.profile.tools] : []),
    ...(o.account ? ['--claude-account', o.account] : []),
    ...(o.attach ? [`@${o.attach.file}`, o.attach.message] : []),
  ]
}
export const shellLine = (argv: string[]) => argv.map((t) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(t) ? t : `'${t.replace(/'/g, `'\\''`)}'`)).join(' ')
export const seedMessage = (key: string, g: number, id: string) => `Handoff brief for lane ${key} (generation ${g}) is attached above. Read it fully and follow it. ${tagFor(id)}`

/** Session argv value of --session-id/--session in the pane's OMO process, null when no OMO process runs there. */
export function paneSession(procs: Proc[]): { argv: string[]; sessionId: string | null } | null {
  const omo = procs.filter((p) => isOmoProcess([p]))
  const main = omo.find((p) => (p.argv ?? []).some((a) => a === '--session-id' || a === '--session')) ?? omo[0]
  if (!main) return null
  const argv = main.argv ?? []
  const i = argv.findIndex((a) => a === '--session-id' || a === '--session')
  return { argv, sessionId: i >= 0 ? argv[i + 1] ?? null : null }
}

export function verifyArgv(argv: string[], want: { sessionId: string; model: string; account: string | null }): string | null {
  const after = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
  if (after('--session-id') !== want.sessionId) return `session-id ${after('--session-id') ?? 'missing'} != ${want.sessionId}`
  if (after('--model') !== want.model) return `model ${after('--model') ?? 'missing'} != ${want.model}`
  if (want.account && after('--claude-account') !== want.account) return `claude-account ${after('--claude-account') ?? 'missing'} != ${want.account}`
  if (!want.account && argv.includes('--claude-account')) return `unexpected --claude-account ${after('--claude-account')}`
  return null
}

const deliveryText = (content: unknown): string => {
  const t = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('') : ''
  return t.replace(/\s*\[dori-msg:[^\]]+\]\s*$/, '').trim()
}
/** Deliveries of a transcript, each processed when a successful (not error/aborted) assistant entry follows it. */
export function transcriptInventory(text: string): { processed: Delivered[]; unprocessed: Delivered[] } {
  type Row = { kind: 'delivery'; d: Delivered } | { kind: 'assistant'; ok: boolean }
  const rows: Row[] = []
  for (const l of text.split('\n')) {
    if (!l.trim()) continue
    let j: any
    try { j = JSON.parse(l) } catch { continue }
    if (j.type === 'custom_message' && j.customType === 'session_control_delivery' && typeof j.details?.delivery_id === 'string') {
      rows.push({ kind: 'delivery', d: { id: j.details.delivery_id, text: deliveryText(j.content), ts: j.timestamp } })
    } else if (j.type === 'message' && j.message?.role === 'user') {
      const m = /\[dori-msg:([^\]]+)\]/.exec(JSON.stringify(j.message.content ?? ''))
      if (m) rows.push({ kind: 'delivery', d: { id: m[1]!, text: deliveryText(j.message.content), ts: j.timestamp } })
    } else if (j.type === 'message' && j.message?.role === 'assistant') {
      rows.push({ kind: 'assistant', ok: j.message.stopReason !== 'error' && j.message.stopReason !== 'aborted' })
    }
  }
  const processed: Delivered[] = [], unprocessed: Delivered[] = []
  rows.forEach((r, i) => {
    if (r.kind !== 'delivery') return
    const done = rows.slice(i + 1).some((x) => x.kind === 'assistant' && x.ok)
    ;(done ? processed : unprocessed).push(r.d)
  })
  return { processed, unprocessed }
}

const claimRule = (key: string) =>
  `[${cfg.lead.name} 규칙] 끝났다고 판단되면 근거와 함께 \`dori claim-done ${key} --evidence "<머지 SHA, 닫힌 이슈, 배포 SHA, 결과 파일>"\`로 완료를 주장해. ${cfg.lead.name}가 5분 안에 근거를 직접 확인해서 닫거나(dori close), 이유와 함께 not-done으로 돌려보내. 커밋·푸시 안 된 작업이 있으면 닫히지 않아. 중간 보고는 \`[REPORT] ${key} | <milestone|blocker|question|done> | <내용>\` 형식으로 ${cfg.lead.name} 창에 보내.`

type Msg = { role: string; text: string; ts: string }
function checkpointOf(text: string, key: string): { reports: string[]; recent: string[] } {
  const msgs: Msg[] = text.split('\n').flatMap((l) => {
    let j: any
    try { j = JSON.parse(l) } catch { return [] }
    if (j.type === 'custom_message' && j.customType === 'session_control_delivery') return [{ role: 'delivery', text: deliveryText(j.content), ts: j.timestamp }]
    if (j.type !== 'message' || (j.message?.role !== 'user' && j.message?.role !== 'assistant')) return []
    const t = deliveryText(j.message.content)
    return t ? [{ role: j.message.role, text: t, ts: j.timestamp }] : []
  })
  const reports = msgs.filter((m) => m.role === 'assistant').flatMap((m) => m.text.split('\n').filter((l) => l.includes(`[REPORT] ${key}`))).slice(-8)
  const recent = msgs.slice(-12).map((m) => `- (${String(m.ts).slice(0, 16)} ${m.role}) ${m.text.replace(/\s+/g, ' ').slice(0, 700)}`)
  return { reports, recent }
}

const opsDir = (home: string) => join(home, 'ops')
const opFile = (home: string, opId: string) => join(opsDir(home), `${opId}.json`)
export const readOp = (home: string, opId: string): Op => JSON.parse(readFileSync(opFile(home, opId), 'utf8'))
function saveOp(deps: TransitionDeps, op: Op) {
  mkdirSync(opsDir(deps.home), { recursive: true, mode: 0o700 })
  op.updatedAt = iso(deps.now())
  const f = opFile(deps.home, op.opId)
  const tmp = `${f}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(op, null, 1), { mode: 0o600 })
  renameSync(tmp, f)
}
export function pendingOps(home: string, key: string): Op[] {
  let files: string[] = []
  try { files = readdirSync(opsDir(home)).filter((f) => f.endsWith('.json')) } catch { return [] }
  return files.flatMap((f) => { try { const o = JSON.parse(readFileSync(join(opsDir(home), f), 'utf8')) as Op; return o.key === key && (o.status === 'running' || o.status === 'failed') ? [o] : [] } catch { return [] } })
}
const appendLedger = (file: string, opId: string, rec: Record<string, unknown>) => {
  if (existsSync(file) && readFileSync(file, 'utf8').includes(`"opId":${JSON.stringify(opId)}`)) return
  appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 })
}

async function takeLease(deps: TransitionDeps, key: string, extra: Record<string, unknown>): Promise<Held> {
  const dir = paths(deps.home).leases
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  try {
    return await acquireDirLock(join(dir, key), { waitMs: 0, extra: { key, op: 'transition', startedAt: iso(deps.now()), ...extra } })
  } catch (e) {
    if (e instanceof RegistryError && e.code === 'lock_wait') { const o = e.detail as any; throw new Refused('lease_held', { pid: o?.pid ?? null, op: o?.op ?? null, opId: o?.opId ?? null }) }
    throw e
  }
}

async function hooksOf(deps: TransitionDeps): Promise<TransitionHook[]> {
  return deps.transitionHooks ? await deps.transitionHooks() : await enabledTransitionHooks()
}
async function sourceInventory(deps: TransitionDeps, lane: string, oldPath: string | null, write: boolean): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const { name, hook } of await hooksOf(deps)) out[name] = hook.inventory(deps.home, lane, oldPath, write)
  return out
}
async function inflight(deps: TransitionDeps, lane: string): Promise<number> {
  let n = 0
  for (const { hook } of await hooksOf(deps)) n += hook.inflight(deps.home, lane)
  return n
}

const busyFile = (profile: Profile, now: number) => (profile.busyFiles ?? []).some((f) => { try { return now - statSync(expand(f)).mtimeMs < 2 * 60_000 } catch { return false } })

function resolveBrief(deps: TransitionDeps, key: string, profile: Profile, oldText: string): string {
  const candidates = [profile.briefPath ? expand(profile.briefPath) : null, join(deps.briefsDir, `${key}.md`), join(deps.handoffsDir, key, 'brief.md')]
  for (const c of candidates) { const t = c ? readTrim(c) : null; if (t) return t }
  const first = transcriptInventory(oldText)
  const d = [...first.processed, ...first.unprocessed].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))[0]
  return d?.text || '(brief not found)'
}

function artifactText(op: Op, profile: Profile, brief: string, oldText: string): string {
  const inv = op.inventory!
  const g = op.g + 1
  const checkpoint = op.args.reason !== 'reset' || profile.checkpointOnReset !== false
  const cp = checkpoint ? checkpointOf(oldText, op.key) : null
  const why = op.args.reason === 'reset' ? '정기 리셋(컨텍스트를 작게 유지)' : op.args.reason === 'quota' ? `계정 한도 (${op.from?.account ?? 'unknown'} -> ${op.account ?? op.model})` : `수동 전환 (${op.account ? `account ${op.account}` : op.model})`
  const parts = [
    `# 레인 이어받기: ${op.key} (generation ${g})`,
    '',
    `너는 레인 \`${op.key}\`의 새 세션이다. 이유: ${why}.${inv.oldSessionPath ? ` 옛 세션 기록: ${inv.oldSessionPath} (필요할 때만 참고).` : ''} 이미 처리된 일은 다시 하지 마라.`,
    '',
    '## 브리프',
    brief.trim(),
  ]
  if (cp) {
    parts.push('', '## 진행 노트 (옛 세션의 [REPORT] 최근 8줄)', cp.reports.length ? cp.reports.map((r) => `- ${r.slice(r.indexOf('[REPORT]'))}`).join('\n') : '- (없음)')
    parts.push('', '## 최근 대화 (마지막 12개, 참고용)', cp.recent.length ? cp.recent.join('\n') : '- (없음)')
  }
  parts.push('', `## 이어받은 미처리 요청 (${inv.carried.length}개)`, inv.carried.length
    ? `${inv.carried.map((d) => `- ${d.id}: ${d.text.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')}\n(이 요청들은 이 브리프 바로 뒤에 [이어받음] 표시로 다시 전달된다. 그때 처리해라.)`
    : '- (없음)')
  if (!profile.noClaim) parts.push('', claimRule(op.key))
  return `${parts.join('\n')}\n`
}

const DEFAULTS = { readyTimeoutMs: 90_000, receiptWaitMs: 120_000, inflightWaitMs: 120_000, oldProcWaitMs: 15_000, accountWaitMs: 120_000 }
const ms = (deps: TransitionDeps, k: keyof typeof DEFAULTS) => deps[k] ?? DEFAULTS[k]

export type Result = { exit: number; out: Record<string, unknown> }

async function waitReceipt(deps: TransitionDeps, op: Op, budgetMs: number): Promise<string | null> {
  const until = deps.now() + budgetMs
  for (;;) {
    const p = deps.findSession(op.newSessionId, op.lane.cwd)
    if (p && receipt(p, op.seedId) === 'persisted') return p
    if (deps.now() >= until) return null
    await deps.sleep(1000)
  }
}

async function paneProcs(deps: TransitionDeps, pane: string): Promise<Proc[]> {
  return ((await deps.herdr('pane', 'process-info', '--pane', pane))?.result?.process_info?.foreground_processes ?? []) as Proc[]
}

async function step(deps: TransitionDeps, op: Op, n: number, profile: Profile): Promise<void> {
  const key = op.key
  const map = () => readMap(deps.home)
  switch (n) {
    case 2: {
      if (!op.from) return
      const c = await deps.children(key)
      if (c.state !== 'known' && !op.args.force) throw new Refused('children_unknown', c)
      if (c.running > 0 && !op.args.force) throw new Refused('children_running', c)
      if (op.args.reason === 'quota' || op.from.status !== 'open') return
      const deadline = deps.now() + (op.args.settleTimeoutMs ?? 2 * 3600_000)
      for (;;) {
        const st = await deps.status(key)
        const busy = !st.settled || busyFile(profile, deps.now())
        if (!busy) return
        if (deps.now() >= deadline) throw new Refused('not_settled', { status: st.status, waitedMin: Math.round((op.args.settleTimeoutMs ?? 7_200_000) / 60_000) })
        deps.log(`lane ${key} busy (${st.status}${st.settled ? ', busy file' : ''}), waiting`)
        const t0 = deps.now()
        await deps.waitIdle(key, Math.min(300_000, Math.max(1000, deadline - deps.now())))
        if (deps.now() - t0 < 5000) await deps.sleep(60_000)
      }
    }
    case 3: {
      const until = deps.now() + ms(deps, 'inflightWaitMs')
      while ((await inflight(deps, key)) && deps.now() < until) await deps.sleep(2000)
      return
    }
    case 4: {
      const oldPath = op.from ? op.from.sessionPath ?? deps.findSession(op.from.durableId, op.lane.cwd) : null
      const text = oldPath && existsSync(oldPath) ? readFileSync(oldPath, 'utf8') : ''
      const t = transcriptInventory(text)
      op.inventory = {
        oldSessionPath: oldPath,
        processed: t.processed.map((d) => d.id),
        carried: t.unprocessed.filter((d) => !d.id.startsWith('seed:')),
        sources: await sourceInventory(deps, key, oldPath, true),
      }
      appendLedger(join(deps.home, 'lane-transitions.jsonl'), op.opId, {
        key, opId: op.opId, g: op.g + 1, reason: op.args.reason, from: op.from ? { durableId: op.from.durableId, sessionPath: oldPath } : null,
        carried: op.inventory.carried.map((d) => d.id), persistedUnprocessed: op.inventory.carried.map((d) => d.id),
        processed: op.inventory.processed.length, sources: op.inventory.sources, at: iso(deps.now()),
      })
      return
    }
    case 5: {
      const oldPath = op.inventory?.oldSessionPath ?? null
      const text = oldPath && existsSync(oldPath) ? readFileSync(oldPath, 'utf8') : ''
      const brief = resolveBrief(deps, key, profile, text)
      const dir = join(deps.handoffsDir, key)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, 'brief.md'), `${brief.trim()}\n`, { mode: 0o600 })
      const file = join(dir, `g${op.g + 1}.md`)
      writeFileSync(file, artifactText(op, profile, brief, text), { mode: 0o600 })
      op.artifact = file
      for (const h of profile.beforeClose ?? []) {
        const code = await deps.runHook(h.map(expand))
        deps.log(`beforeClose ${h.join(' ')} exit ${code}`)
      }
      return
    }
    case 6: {
      if (!op.from || op.from.status !== 'open') return
      deps.crash?.('before-close')
      const cur = map()[key]
      if (cur && cur.tab !== op.from.tab) throw new Refused('tab_moved', { expected: op.from.tab, actual: cur.tab })
      await deps.herdr('tab', 'close', op.from.tab).catch((e: Error) => deps.log(`old tab already gone: ${e.message}`))
      const until = deps.now() + ms(deps, 'oldProcWaitMs')
      let left = await deps.sessionProcs(op.from.durableId)
      while (left.length && deps.now() < until) { await deps.sleep(1000); left = await deps.sessionProcs(op.from.durableId) }
      op.oldProcs = left
      if (left.length) appendEvent({ id: `lane.old_session_alive:${key}:${op.g + 1}`, kind: 'lane.old_session_alive', severity: 'ask', lane: key, durableId: op.from.durableId, pids: left.map((p) => p.pid), op: op.opId }, deps.home)
      return
    }
    case 7: {
      if (!op.opened) {
        const workspace = await deps.workspaceFor(op.lane.cwd)
        const created = (await deps.herdr('tab', 'create', '--workspace', workspace, '--cwd', op.lane.cwd, '--label', op.lane.label, '--no-focus')).result
        op.opened = { workspace, tab: created.tab.tab_id, pane: created.root_pane.pane_id }
        saveOp(deps, op)
      }
      if (!op.opened.ranAt) {
        op.argv = buildArgv({ key, sessionId: op.newSessionId, model: op.model, thinking: op.thinking, account: op.account, profile, attach: { file: op.artifact!, message: seedMessage(key, op.g + 1, op.seedId) } })
        op.opened.ranAt = iso(deps.now())
        saveOp(deps, op)
        await deps.herdr('pane', 'run', op.opened.pane, shellLine(op.argv))
        deps.crash?.('after-seed-send')
      }
      const until = deps.now() + ms(deps, 'readyTimeoutMs')
      for (;;) {
        await deps.sleep(2000)
        const screen = await deps.herdrText('pane', 'read', op.opened.pane, '--source', 'visible', '--lines', '40')
        if (/Init-deep/.test(screen) && /Skip this time/.test(screen)) {
          await deps.herdr('pane', 'send-keys', op.opened.pane, 'down')
          await deps.herdr('pane', 'send-keys', op.opened.pane, 'enter')
          continue
        }
        const procs = await paneProcs(deps, op.opened.pane).catch(() => [] as Proc[])
        const ps = paneSession(procs)
        const path = deps.findSession(op.newSessionId, op.lane.cwd)
        if (ps?.sessionId === op.newSessionId && (checkPane(procs, screen).ok || (path && receipt(path, op.seedId) === 'persisted'))) return
        if (deps.now() >= until) { deps.log(`new pane ${op.opened.pane} not ready in ${ms(deps, 'readyTimeoutMs') / 1000}s; the seed receipt decides`); return }
      }
    }
    case 8: {
      const ps = paneSession(await paneProcs(deps, op.opened!.pane))
      const bad = ps ? verifyArgv(ps.argv, { sessionId: op.newSessionId, model: op.model, account: op.account }) : 'no OMO process in the new pane'
      if (bad) throw new Error(`argv_mismatch: ${bad}`)
      return
    }
    case 9: {
      const cur = map()[key]
      if (cur?.sessionId === op.newSessionId && cur.generation === op.g + 1) return
      const prev = cur
      op.newSessionPath = deps.findSession(op.newSessionId, op.lane.cwd)
      await patchLane(key, op.g, {
        key, label: prev?.label ?? op.lane.label, cwd: prev?.cwd ?? op.lane.cwd, thread: prev ? prev.thread : op.lane.thread,
        workspace: op.opened!.workspace, tab: op.opened!.tab, pane: op.opened!.pane, sessionId: op.newSessionId, status: 'open',
        openedAt: prev?.openedAt ?? iso(deps.now()), closedAt: undefined, generation: op.g + 1, sessionVia: 'transition',
        sessionPath: op.newSessionPath ?? undefined, endpoint: undefined, account: undefined, accountRequested: op.account,
        model: op.model, thinking: op.thinking, profile: op.profile,
        lineage: prev?.sessionId && prev.sessionId !== op.newSessionId ? addLineage(prev.lineage, prev.sessionId) : prev?.lineage,
        seed: { state: 'pending', id: op.seedId, generation: op.g + 1 },
      }, { home: deps.home })
      return
    }
    case 10: {
      await deps.onSeedWait?.()
      let path = await waitReceipt(deps, op, ms(deps, 'receiptWaitMs'))
      if (!path && !op.seedFallbackAt) {
        op.seedFallbackAt = iso(deps.now())
        saveOp(deps, op)
        const e = map()[key]!
        const text = readFileSync(op.artifact!, 'utf8')
        const r = await deps.send(e, `${text}`, op.seedId).catch((err: Error) => ({ status: 'error', reason: err.message }))
        deps.log(`seed fallback send ${op.seedId}: ${r.status}${r.reason ? ` ${r.reason}` : ''}`)
        path = await waitReceipt(deps, op, ms(deps, 'receiptWaitMs'))
      }
      if (!path) {
        const screen = await deps.herdrText('pane', 'read', op.opened!.pane, '--source', 'visible', '--lines', '80').catch(() => '')
        op.screen = screen.split('\n').slice(-80)
        await deps.herdr('tab', 'close', op.opened!.tab).catch((err: Error) => deps.log(`new tab close: ${err.message}`))
        await patchLane(key, op.g + 1, { status: 'closed', closedAt: iso(deps.now()), generation: op.g + 2, seed: { state: 'failed', id: op.seedId, generation: op.g + 1 } }, { home: deps.home })
        appendEvent({ id: `lane.empty_after_handoff:${key}:${op.g + 1}`, kind: 'lane.empty_after_handoff', severity: 'ask', lane: key, durableId: op.newSessionId, generation: op.g + 1, op: op.opId }, deps.home)
        throw new Refused('seed_unconfirmed', { seedId: op.seedId, screenLines: op.screen.length })
      }
      op.newSessionPath = path
      await patchLane(key, op.g + 1, { sessionPath: path, seed: { state: 'applied', id: op.seedId, generation: op.g + 1 } }, { home: deps.home })
      appendEvent({ id: `lane.seed_applied:${key}:${op.g + 1}`, kind: 'lane.seed_applied', severity: 'info', lane: key, durableId: op.newSessionId, generation: op.g + 1, op: op.opId }, deps.home)
      return
    }
    case 11: {
      op.carriedSent ??= {}
      const e = map()[key]!
      for (const d of op.inventory?.carried ?? []) {
        const id = `${d.id}:g${op.g + 1}`
        if (op.carriedSent[id] === 'delivered' || receipt(op.newSessionPath ?? null, id) === 'persisted') { op.carriedSent[id] = 'delivered'; continue }
        const r = await deps.send(e, `[이어받음: 이전 세션에서 미처리]\n${d.text}`, id).catch((err: Error) => ({ status: 'error', reason: err.message }))
        op.carriedSent[id] = r.status
        saveOp(deps, op)
      }
      if (!profile.noClaim) {
        await updateDoriLane(key, (l) => l && {
          ...l, pane: op.opened!.pane, tab: op.opened!.tab, session: op.newSessionId, status: 'working',
          history: [...(l.history ?? []), { at: iso(deps.now()), status: 'working', note: `lane transition g${op.g + 1} (${op.args.reason})` }],
        }, { dir: paths(deps.home).doriLanes })
      }
      const gpt = !op.model.startsWith(CLAUDE)
      appendLedger(join(deps.home, 'lane-migrations.jsonl'), op.opId, {
        at: iso(deps.now()), key, newKey: key, opId: op.opId, generation: op.g + 1, reason: op.args.reason, from: op.from?.account ?? 'unknown',
        to: op.account ?? op.model, ...(gpt ? { fallback: 'gpt' } : {}), handoff: op.artifact, via: 'lane-transition',
      })
      appendEvent({ id: `lane.transition:${key}:${op.g + 1}`, kind: 'lane.transition', severity: 'act', lane: key, durableId: op.newSessionId, generation: op.g + 1, op: op.opId, data: { reason: op.args.reason, account: op.account, model: op.model, carried: op.inventory?.carried.length ?? 0 } }, deps.home)
      return
    }
  }
}

async function checkAccount(deps: TransitionDeps, op: Op) {
  if (!op.account) { op.accountCheck = 'none'; return }
  const until = deps.now() + ms(deps, 'accountWaitMs')
  for (;;) {
    const path = op.newSessionPath ?? deps.findSession(op.newSessionId, op.lane.cwd)
    let bound: string | undefined
    try { bound = path ? JSON.parse(readFileSync(`${path}.claude-sdk-oauth-binding.json`, 'utf8')).accountName : undefined } catch { bound = undefined }
    if (bound) {
      const okBind = bound === op.account
      op.accountCheck = okBind ? `bound ${bound}` : `mismatch ${bound}`
      appendEvent({ id: `${okBind ? 'lane.account_bound' : 'lane.account_mismatch'}:${op.key}:${op.g + 1}`, kind: okBind ? 'lane.account_bound' : 'lane.account_mismatch', severity: okBind ? 'info' : 'ask', lane: op.key, durableId: op.newSessionId, generation: op.g + 1, data: { requested: op.account, bound } }, deps.home)
      await patchLane(op.key, undefined, (cur) => (cur?.sessionId === op.newSessionId ? { account: bound } : {}), { home: deps.home }).catch(() => {})
      return
    }
    if (deps.now() >= until) { op.accountCheck = 'pending (no binding sidecar yet: verified after the first turn)'; return }
    await deps.sleep(2000)
  }
}

async function run(deps: TransitionDeps, op: Op, held: Held): Promise<Result> {
  const profile = loadProfile(op.profile, deps.profilesDir)
  op.runs += 1
  op.status = 'running'
  saveOp(deps, op)
  try {
    for (let n = op.step + 1; n <= LAST_STEP; n++) {
      deps.log(`step ${n} ${STEP_NAMES[n]}`)
      await step(deps, op, n, profile)
      op.step = n
      op.history.push({ step: n, run: op.runs, at: iso(deps.now()) })
      saveOp(deps, op)
      if (n === 4) deps.crash?.('after-inventory')
      if (n === 7) deps.crash?.('after-open')
    }
  } catch (e) {
    if (e instanceof TransitionCrash) throw e
    if (e instanceof Refused) {
      op.status = op.step >= 6 ? 'failed' : 'refused'
      op.refusal = e.code
      op.error = `${e.code}${e.detail ? ` ${JSON.stringify(e.detail)}` : ''}`
      if (e.code === 'seed_unconfirmed') op.step = LAST_STEP
    } else {
      op.status = 'failed'
      op.error = (e as Error)?.message ?? String(e)
      appendEvent({ id: `lane.transition_failed:${op.key}:${op.g + 1}:${op.runs}`, kind: 'lane.transition_failed', severity: 'ask', lane: op.key, generation: op.g + 1, op: op.opId, data: { step: op.step + 1, error: op.error } }, deps.home)
    }
    saveOp(deps, op)
    held.release()
    const code = e instanceof Refused && op.status === 'refused' ? 4 : 1
    return { exit: code, out: { error: e instanceof Refused ? e.code : 'transition_failed', key: op.key, opId: op.opId, step: op.step, detail: e instanceof Refused ? e.detail ?? null : op.error, resume: op.status === 'failed' && op.refusal !== 'seed_unconfirmed' ? `bun ${coreRef()}/lane-transition.ts --resume ${op.opId}` : null } }
  }
  op.status = 'done'
  saveOp(deps, op)
  held.release()
  await checkAccount(deps, op)
  saveOp(deps, op)
  return { exit: 0, out: { ok: true, key: op.key, opId: op.opId, generation: op.g + 1, sessionId: op.newSessionId, pane: op.opened?.pane, tab: op.opened?.tab, seed: op.seedId, argv: op.argv, carried: op.inventory?.carried.length ?? 0, sources: op.inventory?.sources, oldProcs: op.oldProcs?.length ?? 0, accountCheck: op.accountCheck } }
}

function laneOf(key: string, entry: Entry | undefined, profile: Profile) {
  if (entry) return { label: entry.label, cwd: entry.cwd, thread: entry.thread ?? null }
  if (!profile.cwd || !profile.label) throw new Refused('unknown_lane', `${key} is not in the registry and profile ${profile.name} has no label/cwd`)
  return { label: profile.label, cwd: profile.cwd, thread: profile.thread ?? null }
}

export async function startTransition(deps: TransitionDeps, args: Args): Promise<Result> {
  try {
    if (!LANE_KEY_RE.test(args.key)) throw new Refused('bad_key', args.key)
    const pending = pendingOps(deps.home, args.key)
    if (pending.length) throw new Refused('op_pending', { opId: pending[0]!.opId, status: pending[0]!.status, resume: `bun ${coreRef()}/lane-transition.ts --resume ${pending[0]!.opId}` })
    const opId = `op_${iso(deps.now()).replace(/[-:.]/g, '').slice(0, 15)}_${args.key}_${deps.newId().slice(0, 8)}`
    const entry0 = readMap(deps.home)[args.key]
    const held = await takeLease(deps, args.key, { generation: entry0?.generation ?? 0, opId })
    let op: Op
    try {
      const entry = readMap(deps.home)[args.key]
      const pname = profileName(args.key, args.profile, entry, deps.profilesDir)
      const profile = loadProfile(pname, deps.profilesDir)
      const spec = sessionSpec(profile, entry, args)
      const g = entry?.generation ?? 0
      let account: string | null = null
      try { account = entry?.sessionPath ? JSON.parse(readFileSync(`${entry.sessionPath}.claude-sdk-oauth-binding.json`, 'utf8')).accountName ?? null : null } catch { account = (entry?.account as string | null | undefined) ?? null }
      const now = iso(deps.now())
      op = {
        v: 1, opId, key: args.key, args, status: 'running', step: 1, history: [{ step: 1, run: 1, at: now }], runs: 0, g, createdAt: now, updatedAt: now,
        from: entry ? { durableId: entry.sessionId, sessionPath: entry.sessionPath ?? null, tab: entry.tab, pane: entry.pane, status: entry.status, account, model: (entry.model as string | undefined) ?? null } : null,
        lane: laneOf(args.key, entry, profile), profile: pname, ...spec, newSessionId: deps.newId(), seedId: `seed:${args.key}:${g + 1}`,
      }
      saveOp(deps, op)
    } catch (e) { held.release(); throw e }
    return await run(deps, op, held)
  } catch (e) {
    if (e instanceof Refused) return { exit: 4, out: { error: e.code, key: args.key, detail: e.detail ?? null } }
    throw e
  }
}

export async function resumeTransition(deps: TransitionDeps, opId: string): Promise<Result> {
  if (!/^op_[A-Za-z0-9._-]+$/.test(opId) || !existsSync(opFile(deps.home, opId))) return { exit: 2, out: { error: 'unknown_op', opId } }
  const op = readOp(deps.home, opId)
  if (op.status === 'done' || op.status === 'refused' || op.refusal === 'seed_unconfirmed') return { exit: op.status === 'done' ? 0 : 4, out: { ok: op.status === 'done', opId, status: op.status, step: op.step, error: op.error ?? null } }
  let held: Held
  try { held = await takeLease(deps, op.key, { generation: op.g, opId, resumed: true }) } catch (e) {
    if (e instanceof Refused) return { exit: 4, out: { error: e.code, key: op.key, opId, detail: e.detail ?? null } }
    throw e
  }
  deps.log(`resume ${opId} after step ${op.step} (${STEP_NAMES[op.step]})`)
  return run(deps, op, held)
}

/** --dry: the plan from the registry, profile, queue and transcript as they are now. Reads only. */
export async function planTransition(deps: TransitionDeps, args: Args): Promise<Result> {
  try {
    const entry = readMap(deps.home)[args.key]
    const pname = profileName(args.key, args.profile, entry, deps.profilesDir)
    const profile = loadProfile(pname, deps.profilesDir)
    const spec = sessionSpec(profile, entry, args)
    const lane = laneOf(args.key, entry, profile)
    const g = entry?.generation ?? 0
    const newSessionId = '<new-session-id>'
    const artifact = join(deps.handoffsDir, args.key, `g${g + 1}.md`)
    const seedId = `seed:${args.key}:${g + 1}`
    const argv = buildArgv({ key: args.key, sessionId: newSessionId, ...spec, profile, attach: { file: artifact, message: seedMessage(args.key, g + 1, seedId) } })
    const oldPath = entry ? entry.sessionPath ?? deps.findSession(entry.sessionId, entry.cwd) : null
    const t = transcriptInventory(oldPath && existsSync(oldPath) ? readFileSync(oldPath, 'utf8') : '')
    const children = entry ? await deps.children(args.key).catch((e: Error) => ({ state: 'unknown', running: 0, reasons: [e.message] })) : null
    const st = entry && args.reason !== 'quota' ? await deps.status(args.key).catch(() => null) : null
    return {
      exit: 0, out: {
        dry: true, key: args.key, profile: pname, reason: args.reason, generation: g + 1, ...spec, lane, argv, command: shellLine(argv), artifact, seedId,
        from: entry ? { sessionId: entry.sessionId, tab: entry.tab, pane: entry.pane, status: entry.status } : null,
        preconditions: { children, settled: st ? st.settled || false : null, settleWait: args.reason !== 'quota', busyFile: busyFile(profile, deps.now()), lease: existsSync(join(paths(deps.home).leases, args.key)), pendingOps: pendingOps(deps.home, args.key).map((o) => o.opId) },
        inventory: { carried: t.unprocessed.filter((d) => !d.id.startsWith('seed:')).map((d) => d.id), processed: t.processed.length, sources: await sourceInventory(deps, args.key, oldPath, false) },
        beforeClose: profile.beforeClose ?? [],
      },
    }
  } catch (e) {
    if (e instanceof Refused) return { exit: 4, out: { error: e.code, key: args.key, detail: e.detail ?? null } }
    throw e
  }
}

export function parseArgs(argv: string[]): { resume?: string; dry: boolean; args?: Args; error?: string } {
  const a = [...argv]
  const take = (n: string) => { const i = a.indexOf(n); if (i < 0) return undefined; const v = a[i + 1]; a.splice(i, 2); return v }
  const flag = (n: string) => { const i = a.indexOf(n); if (i < 0) return false; a.splice(i, 1); return true }
  const resume = take('--resume')
  const dry = flag('--dry')
  if (resume) return { resume, dry }
  const fresh = flag('--fresh')
  const force = flag('--force')
  const account = take('--account'), model = take('--model'), thinking = take('--thinking'), profile = take('--profile')
  const reason = (take('--reason') ?? 'manual') as Reason
  const settle = take('--settle-timeout')
  const key = a.find((x) => !x.startsWith('--'))
  if (!key || !fresh) return { dry, error: 'usage: lane-transition.ts <key> --fresh [--account A | --model M [--thinking T]] [--reason quota|reset|manual] [--profile P] [--dry] [--force] | --resume <opId>' }
  if (!['quota', 'reset', 'manual'].includes(reason)) return { dry, error: `bad --reason ${reason}` }
  if (account && !cfg.claudeAccounts.includes(account)) return { dry, error: `unknown account ${account}` }
  return { dry, args: { key, account, model, thinking, reason, profile, force, ...(settle ? { settleTimeoutMs: Number(settle) * 1000 } : {}) } }
}

export async function liveDeps(): Promise<TransitionDeps> {
  const { rpc, transportFor } = await import('./rpc')
  const { liveDeps: herdrDeps } = await import('./deliver')
  const { findSessionFile } = await import('./sess')
  const home = paths().home
  const herdr = async (...args: string[]) => {
    const p = Bun.spawn(['herdr', ...args], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    if (code !== 0) throw new Error(`herdr ${args.slice(0, 2).join(' ')} failed: ${(err || out).trim().slice(0, 300)}`)
    return out.trim() ? JSON.parse(out) : null
  }
  const herdrText = async (...args: string[]) => {
    const p = Bun.spawn(['herdr', ...args], { stdout: 'pipe', stderr: 'pipe' })
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
    return code === 0 ? out : ''
  }
  return {
    home,
    handoffsDir: process.env.OMODORI_HOME ? join(home, 'handoffs') : `${HOME}/.dori/state/handoffs`,
    briefsDir: process.env.OMODORI_HOME ? join(home, 'briefs-dori') : `${HOME}/.dori/state/briefs`,
    profilesDir: profileDirs(join(import.meta.dir, 'lane-profiles')),
    herdr, herdrText,
    workspaceFor: async (cwd) => {
      const label = cwd.split('/').filter(Boolean).pop() ?? cwd
      const ws = (await herdr('workspace', 'list')).result.workspaces as { workspace_id: string; label: string }[]
      return ws.find((w) => w.label === label)?.workspace_id ?? (await herdr('workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus')).result.workspace.workspace_id
    },
    children: async (key) => rpc.children(key),
    status: async (key) => rpc.status(key),
    waitIdle: async (key, wait) => { await rpc.wait(key, 'idle', wait).catch(() => undefined) },
    findSession: (id, cwd) => findSessionFile(id, cwd),
    send: async (e, text, id) => rpc.dispatch(e as any, text, { id, transport: transportFor(e.key) }, herdrDeps) as any,
    sessionProcs: async (id) => {
      const p = Bun.spawn(['ps', '-axeww', '-o', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore' })
      const [out] = await Promise.all([new Response(p.stdout).text(), p.exited])
      return out.split('\n').flatMap((l) => {
        const m = /^\s*(\d+)\s+(.*)$/.exec(l)
        if (!m || Number(m[1]) === process.pid || Number(m[1]) === p.pid || !m[2]!.includes(id)) return []
        const cmd = m[2]!
        return /(?:--session(?:-id)?[ =]|PI_SESSION_ID=)/.test(cmd) ? [{ pid: Number(m[1]), cmd: cmd.replace(/\s[A-Z_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z_]*=\S+/g, ' <redacted>').slice(0, 300) }] : []
      })
    },
    runHook: async (argv) => { const p = Bun.spawn(argv, { stdout: 'inherit', stderr: 'inherit' }); return p.exited },
    sleep: (t) => Bun.sleep(t), now: () => Date.now(), newId: () => crypto.randomUUID(),
    log: (l) => console.error(`${new Date().toISOString()} ${l}`),
  }
}

if (import.meta.main) {
  const p = parseArgs(process.argv.slice(2))
  if (p.error) { console.log(JSON.stringify({ error: 'usage', detail: p.error })); process.exit(2) }
  const deps = await liveDeps()
  const r = p.resume ? await resumeTransition(deps, p.resume) : p.dry ? await planTransition(deps, p.args!) : await startTransition(deps, p.args!)
  console.log(JSON.stringify(r.out))
  process.exit(r.exit)
}
