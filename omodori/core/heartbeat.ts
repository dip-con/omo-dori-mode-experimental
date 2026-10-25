// Dori self-heal heartbeat (LaunchAgent com.example.dori.heartbeat, every 5 min).
// Watches mail watchers, open lanes (dead pane / auth failure / working-but-silent), disk space, and whatever each
// enabled messenger source adds through its heartbeat hook (core/sources.ts): its own checks, and an "off on purpose"
// probe that pauses the source's dependent alerts and restarts until it is back.
//   bun heartbeat.ts run [--dry] [--to <channel>]   one sweep; alerts only on state change
//   bun heartbeat.ts morning                         one line: what was auto-recovered since the last morning line
//   bun heartbeat.ts status                          print the current state
// Recovery rules: LaunchAgent kickstart is automatic. Lane restarts go through lane-restart.sh and stay dry-run
// unless HEARTBEAT_LANE_RESTART=1 (lead approval); a source's standing lanes are never restarted unless
// HEARTBEAT_RESTART_SOURCE_LANES=1.
// A lane that is working is never quit. Recovered problems are logged for the morning line, not posted.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DORI, GENERAL, HOME, SESSIONS_ROOT, type Lane, ageMin, appendJsonl, flag, kst, mtime, openLanes, opt, post, readJson, readJsonl, writeJson } from './dori-lib'
import { cfg } from './config'
import { loadEnabled, standingLane, type Check, type Manifest, type SourceModule } from './sources'

const DIR = process.env.HEARTBEAT_DIR ?? `${DORI}/heartbeat`
const STATE = `${DIR}/state.json`
export const EVENTS = `${DIR}/events.jsonl`
const ARGV = `${DIR}/lane-argv.json`
const UID = process.getuid!()
const LIMITS = { mailMin: 15, laneSilentMin: 20, diskFreeGb: 50, diskPct: 90 }

export type { Check }
type Entry = { ok: boolean; detail: string; since: string; attempted?: string; alerted?: boolean }
type State = { checks: Record<string, Entry>; zeleAt?: number; zeleOk?: boolean; zeleErr?: string; sourceOff?: Record<string, { reason: string; since: string }> }
export const offFlag = (source: string) => `${DIR}/${source}-off`
export type HbEvent = { at: string; id: string; kind: 'detected' | 'recover_try' | 'recovered' | 'alerted' | 'resolved' | 'dry_run'; detail: string }

const run = async (cmd: string[], timeoutMs = 20_000) => {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL', env: { ...process.env, PATH: `${HOME}/.local/bin:${HOME}/.bun/bin:${HOME}/.local/node-current/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` } })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { out, err, code }
}
const agentLoaded = async (label: string) => (await run(['launchctl', 'print', `gui/${UID}/${label}`])).code === 0

async function checkMail(state: State): Promise<Check[]> {
  const gmailState = ageMin(mtime(`${DORI}/watch-state.json`))
  const daumState = ageMin(mtime(`${DORI}/daum-watch-state.json`))
  // Gmail token expiry does not stop watch.ts (it still saves state), so probe zele itself every 15 min.
  if (!state.zeleAt || Date.now() - state.zeleAt >= LIMITS.mailMin * 60_000) {
    const r = await run(['zele', 'mail', 'list', '--limit', '1'], 60_000)
    state.zeleAt = Date.now()
    state.zeleOk = r.code === 0
    state.zeleErr = r.code === 0 ? '' : (r.err || r.out).trim().split('\n').slice(-1)[0]!.slice(0, 120)
  }
  return [
    { id: 'mail-gmail', ok: gmailState <= LIMITS.mailMin && !!state.zeleOk, detail: gmailState > LIMITS.mailMin ? `Gmail 감시(watch.ts) ${gmailState}분째 멈춤` : state.zeleOk ? `Gmail 정상 (감시 ${gmailState}분 전)` : `Gmail 조회 실패: ${state.zeleErr}` },
    { id: 'mail-daum', ok: daumState <= LIMITS.mailMin, detail: daumState <= LIMITS.mailMin ? `Daum 감시 ${daumState}분 전` : `Daum 메일 감시 ${daumState}분째 멈춤` },
  ]
}

const sessionFile = (l: Lane, argv: string[] | null) => {
  const i = argv?.indexOf('--session') ?? -1
  if (argv && i >= 0 && argv[i + 1]?.includes('/')) return argv[i + 1]!
  for (const dir of readdirSync(SESSIONS_ROOT)) {
    const f = readdirSync(`${SESSIONS_ROOT}/${dir}`).find((n) => n.endsWith(`_${l.sessionId}.jsonl`))
    if (f) return `${SESSIONS_ROOT}/${dir}/${f}`
  }
  return null
}

// Auth failure after the last good assistant turn: the 10-16 failure mode (lane alive, every turn errors).
const authBroken = (jsonl: string) => {
  const lines = readFileSync(jsonl, 'utf8').slice(-200_000).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!
    if (/No API key found|authentication_error|invalid x-api-key|OAuth token has expired/i.test(l)) return true
    if (l.includes('"role":"assistant"') && !l.includes('"stopReason":"error"')) return false
  }
  return false
}

async function checkLanes(): Promise<Check[]> {
  const list = await run(['herdr', 'agent', 'list'])
  if (list.code !== 0) return [{ id: 'herdr', ok: false, detail: 'herdr agent list 실패' }]
  const agents = new Map((JSON.parse(list.out).result.agents as { pane_id: string; agent_status: string }[]).map((a) => [a.pane_id, a.agent_status]))
  const saved = readJson<Record<string, string[]>>(ARGV, {})
  const out: Check[] = []
  for (const l of openLanes()) {
    const id = `lane:${l.key}`
    try {
    const info = await run(['herdr', 'pane', 'process-info', '--pane', l.pane])
    // 10-25 01:28: process-info failed under load 238 for 3 live panes and they were reported gone; a pane still in
    // `herdr agent list` is alive, so only a pane missing from that list counts as gone.
    if (info.code !== 0) { if (!agents.has(l.pane)) out.push({ id, ok: false, detail: `레인 ${l.key}(${l.label}) pane ${l.pane} 사라짐 — sess.ts reopen 필요` }); continue }
    const procs = (JSON.parse(info.out).result.process_info.foreground_processes ?? []) as { pid: number; argv?: string[] }[]
    const cliProcs = procs.filter((p): p is { pid: number; argv: string[] } => !!p.argv?.some((a) => a.endsWith('/cli.js'))).sort((a, b) => a.pid - b.pid)
    // OMO also runs child cli.js processes (e.g. `... mcp`); the lane itself is the one carrying its session flag.
    const agentProc = cliProcs.find((p) => p.argv.includes('--session') || p.argv.includes('--session-id')) ?? cliProcs[0]
    if (agentProc) saved[l.key] = agentProc.argv
    const jsonl = sessionFile(l, agentProc?.argv ?? saved[l.key] ?? null)
    const status = agents.get(l.pane) ?? 'none'
    if (!agentProc) {
      out.push({ id, ok: false, detail: `레인 ${l.key}(${l.label}) 에이전트 종료됨(pane ${l.pane}은 셸만 남음)`, recover: { kind: 'lane', key: l.key, pane: l.pane } })
      continue
    }
    if (jsonl && existsSync(jsonl) && status !== 'working' && ageMin(mtime(jsonl)) >= 5 && authBroken(jsonl)) {
      out.push({ id, ok: false, detail: `레인 ${l.key}(${l.label}) 인증 실패 상태`, recover: { kind: 'lane', key: l.key, pane: l.pane } })
      continue
    }
    if (!jsonl || !existsSync(jsonl)) { out.push({ id, ok: true, detail: `${status}, 세션 기록 파일 못 찾음(침묵 판정 생략)` }); continue }
    const silent = ageMin(mtime(jsonl))
    if (status === 'working' && silent >= LIMITS.laneSilentMin) {
      out.push({ id, ok: false, detail: `레인 ${l.key}(${l.label}) 작업 중인데 ${silent}분째 출력 없음 (끄지 않음, 확인 필요)` })
      continue
    }
    out.push({ id, ok: true, detail: `${status}, 마지막 기록 ${silent}분 전` })
    } catch (err) {
      out.push({ id, ok: false, detail: `레인 ${l.key} 점검 실패: ${(err as Error).message.slice(0, 100)}` })
    }
  }
  writeJson(ARGV, saved)
  return out
}

async function checkDisk(): Promise<Check[]> {
  const r = await run(['df', '-k', ...cfg.paths.disks])
  return r.out.trim().split('\n').slice(1).map((row) => {
    const c = row.split(/\s+/)
    const freeGb = Math.round(Number(c[3]) / 1024 / 1024)
    const pct = Number(c[4]!.replace('%', ''))
    const mount = c.slice(8).join(' ') || c[c.length - 1]!
    const ok = freeGb >= LIMITS.diskFreeGb && pct < LIMITS.diskPct
    return { id: `disk:${mount}`, ok, detail: `${mount} 여유 ${freeGb}GB (${pct}% 사용)` }
  })
}

const laneRestartLive = (key: string) => process.env.HEARTBEAT_LANE_RESTART === '1' && (!standingLane(key) || process.env.HEARTBEAT_RESTART_SOURCE_LANES === '1')

async function recover(c: Check, dry: boolean): Promise<string> {
  if (!c.recover) return ''
  if (c.recover.kind === 'kickstart') {
    if (dry) return `드라이런: launchctl kickstart -k ${c.recover.label}`
    if (!(await agentLoaded(c.recover.label))) return `${c.recover.label} 미등록이라 재시작 못 함`
    const r = await run(['launchctl', 'kickstart', '-k', `gui/${UID}/${c.recover.label}`])
    return r.code === 0 ? `kickstart ${c.recover.label}` : `kickstart 실패: ${r.err.trim().slice(0, 100)}`
  }
  const live = !dry && laneRestartLive(c.recover.key)
  const r = await run(['bash', `${import.meta.dir}/lane-restart.sh`, c.recover.key, ...(live ? ['--live'] : [])], 300_000)
  const last = (r.out + r.err).trim().split('\n').slice(-1)[0] ?? ''
  return live ? `lane-restart ${c.recover.key}: ${last}` : `드라이런(레인 재시작 승인 전): ${last}`
}

const titleOf = (m: Manifest) => m.title ?? m.name
async function sourceChecks(sources: Awaited<ReturnType<typeof loadEnabled>>, probe: (name: string, fn: () => Check[] | Promise<Check[]>) => Promise<Check[]>): Promise<Check[]> {
  const out: Check[] = []
  for (const { manifest, mod, error } of sources) {
    if (!mod) { out.push({ id: `probe:${manifest.name}`, ok: false, detail: `${titleOf(manifest)} 소스 모듈 못 읽음: ${(error ?? '').slice(0, 100)}` }); continue }
    const hb = mod.heartbeat
    if (hb) out.push(...(await probe(manifest.name, () => hb.checks())))
  }
  return out
}

async function sweep(dry: boolean, to: string) {
  mkdirSync(DIR, { recursive: true })
  const state = readJson<State>(STATE, { checks: {} })
  const now = new Date().toISOString()
  const ev = (id: string, kind: HbEvent['kind'], detail: string) => { if (!dry) appendJsonl(EVENTS, { at: now, id, kind, detail } satisfies HbEvent) }
  const alerts: string[] = []
  const sources = await loadEnabled()
  state.sourceOff ??= {}
  const off = new Map<string, NonNullable<SourceModule['heartbeat']>>()
  for (const { manifest, mod } of sources) {
    const hb = mod?.heartbeat
    if (!hb?.offReason) continue
    const name = manifest.name, title = titleOf(manifest), was = state.sourceOff[name]
    let probed: string | null
    try { probed = await hb.offReason(was?.reason) } catch { probed = null }
    const reason = probed ?? was?.reason ?? ''
    if (reason && !was) {
      state.sourceOff[name] = { reason, since: now }
      alerts.push(`📴 ${title} 꺼짐(${reason}) — 다시 켜질 때까지 ${title} 관련 경보·자동 재시작 멈춤`)
      ev(`${name}-off`, 'detected', reason)
      if (!dry) writeFileSync(offFlag(name), `${now} ${reason}\n`)
      const paused = await hb.pause?.('bootout', dry, reason)
      if (paused) ev(`${name}-off`, 'dry_run', paused)
    } else if (!reason && was) {
      const resumed = await hb.pause?.('bootstrap', dry, was.reason)
      if (resumed) ev(`${name}-off`, 'dry_run', resumed)
      alerts.push(`📳 ${title} 다시 켜짐(${ageMin(Date.parse(was.since))}분 꺼져 있었음) — 감시 재개`)
      ev(`${name}-off`, 'resolved', was.reason)
      delete state.sourceOff[name]
      if (!dry) rmSync(offFlag(name), { force: true })
    }
    if (state.sourceOff[name]) off.set(name, hb)
  }
  const probe = async (name: string, fn: () => Check[] | Promise<Check[]>): Promise<Check[]> => {
    try { return await fn() } catch (err) { return [{ id: `probe:${name}`, ok: false, detail: `${name} 점검 실패: ${(err as Error).message.slice(0, 100)}` }] }
  }
  const all = [
    ...(await probe('mail', () => checkMail(state))),
    ...(await sourceChecks(sources, probe)),
    ...(await probe('lanes', checkLanes)), ...(await probe('disk', checkDisk)),
  ]
  const paused = (id: string) => [...off.values()].some((hb) => hb.dependent?.(id) ?? false)
  const checks = all.filter((c) => !paused(c.id))
  for (const id of Object.keys(state.checks)) if (paused(id)) delete state.checks[id]
  const seen = new Set<string>()
  for (const c of checks) {
    seen.add(c.id)
    const prev = state.checks[c.id]
    if (c.ok) {
      if (prev && !prev.ok) {
        if (prev.alerted) { alerts.push(`✅ 해결: ${c.id} — ${c.detail}`); ev(c.id, 'resolved', c.detail) }
        else ev(c.id, 'recovered', `${prev.detail} → ${c.detail}${prev.attempted ? ` (${prev.attempted})` : ''}`)
      }
      state.checks[c.id] = { ok: true, detail: c.detail, since: prev?.ok ? prev.since : now }
      continue
    }
    if (!prev || prev.ok) {
      ev(c.id, 'detected', c.detail)
      // First sighting: try the safe recovery and stay quiet; the next sweep decides recovered vs alert.
      if (c.recover) {
        const how = await recover(c, dry)
        ev(c.id, how.startsWith('드라이런') ? 'dry_run' : 'recover_try', how)
        const lanePending = c.recover.kind === 'lane' && !laneRestartLive(c.recover.key)
        state.checks[c.id] = { ok: false, detail: c.detail, since: now, attempted: how, alerted: lanePending || dry }
        if (lanePending || dry) alerts.push(`⚠️ ${c.detail}${how ? ` — ${how}` : ''}`)
        continue
      }
      state.checks[c.id] = { ok: false, detail: c.detail, since: now, alerted: true }
      alerts.push(`⚠️ ${c.detail}`)
      ev(c.id, 'alerted', c.detail)
      continue
    }
    if (!prev.alerted) {
      alerts.push(`⚠️ ${c.detail}${prev.attempted ? ` — 자동 복구 시도했지만 안 됨(${prev.attempted})` : ''}`)
      ev(c.id, 'alerted', c.detail)
    }
    state.checks[c.id] = { ...prev, detail: c.detail, alerted: true }
  }
  for (const id of Object.keys(state.checks)) if (!seen.has(id)) delete state.checks[id] // lane closed by the lead
  const line = alerts.length ? `[하트비트] ${alerts.join(' / ')}` : ''
  // Send first, save after: a failed post leaves the old state so the next sweep alerts again.
  if (line && !flag('--quiet')) {
    if (dry && !opt('--to')) console.log(`(드라이런: 보내지 않음 → ${to})`)
    else await post(to, line.slice(0, 1900))
  }
  if (!dry) writeJson(STATE, state)
  const bad = checks.filter((c) => !c.ok)
  if (dry || flag('--verbose')) console.log(JSON.stringify({ at: now, dry, alerts, checks: checks.map((c) => `${c.ok ? 'OK ' : 'BAD'} ${c.id}: ${c.detail}`) }, null, 1))
  else console.log(`${now} ok=${checks.length - bad.length} bad=${bad.length}${bad.length ? ` [${bad.map((c) => c.id).join(', ')}]` : ''} alerts=${alerts.length}`)
}

// The morning watermark lives in its own file so a running sweep never overwrites it with an older snapshot.
const MORNING = `${DIR}/morning.json`
function morningAck() { writeJson(MORNING, { lastMorning: new Date().toISOString() }) }
function morning(peek = flag('--peek')) {
  const state = readJson<State>(STATE, { checks: {} })
  const since = readJson<{ lastMorning?: string }>(MORNING, {}).lastMorning ?? new Date(Date.now() - 24 * 3600_000).toISOString()
  const rec = readJsonl<HbEvent>(EVENTS).filter((e) => e.at > since && e.kind === 'recovered')
  const open = Object.entries(state.checks).filter(([, e]) => !e.ok)
  if (!peek) morningAck()
  const parts = [rec.length ? `밤사이 자동 복구 ${rec.length}건(${[...new Set(rec.map((e) => e.id))].join(', ')})` : '밤사이 자동 복구 0건']
  if (open.length) parts.push(`아직 문제 ${open.length}건(${open.map(([id]) => id).join(', ')})`)
  return `[하트비트] ${parts.join(' · ')}`
}

if (import.meta.main) {
  const cmd = process.argv[2]
  if (cmd === 'run') await sweep(flag('--dry'), opt('--to') ?? GENERAL)
  else if (cmd === 'morning') console.log(morning())
  else if (cmd === 'status') console.log(JSON.stringify(readJson<State>(STATE, { checks: {} }), null, 1))
  else { console.error('usage: heartbeat.ts run [--dry] [--to <channel>] [--quiet] | morning [--peek] | status'); process.exit(2) }
  void kst
}

export { morning, morningAck }
