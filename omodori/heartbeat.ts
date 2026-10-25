// Dori self-heal heartbeat (LaunchAgent com.example.dori.heartbeat, every 5 min).
// Watches what kakao-health does not: kka sync, mail watchers, kakao-loco/kakao-health liveness, open lanes
// (dead pane / auth failure / working-but-silent) and disk space.
//   bun heartbeat.ts run [--dry] [--to <channel>]   one sweep; alerts only on state change
//   bun heartbeat.ts morning                         one line: what was auto-recovered since the last morning line
//   bun heartbeat.ts status                          print the current state
// Recovery rules: LaunchAgent kickstart is automatic. Lane restarts go through lane-restart.sh and stay dry-run
// unless HEARTBEAT_LANE_RESTART=1 (lead approval); kakao-* lanes are never restarted unless HEARTBEAT_RESTART_KAKAO=1.
// A lane that is working is never quit. Recovered problems are logged for the morning line, not posted.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DORI, GENERAL, HOME, SESSIONS_ROOT, type Lane, ageMin, appendJsonl, flag, kst, mtime, openLanes, opt, post, readJson, readJsonl, writeJson } from './dori-lib'
import { cfg, label } from './config'

const DIR = process.env.HEARTBEAT_DIR ?? `${DORI}/heartbeat`
const STATE = `${DIR}/state.json`
export const EVENTS = `${DIR}/events.jsonl`
const ARGV = `${DIR}/lane-argv.json`
const UID = process.getuid!()
const KKA_LOG = process.env.HEARTBEAT_KKA_LOG ?? `${HOME}/Library/Logs/kakao-archive/sync.log`
const KAKAO_LOGS = `${HOME}/Library/Logs/dandori-kakao`
const LIMITS = { kkaMin: 30, mailMin: 15, laneSilentMin: 20, diskFreeGb: 50, diskPct: 90 }

export type Check = { id: string; ok: boolean; detail: string; recover?: { kind: 'kickstart'; label: string } | { kind: 'lane'; key: string; pane: string } }
type Entry = { ok: boolean; detail: string; since: string; attempted?: string; alerted?: boolean }
type State = { checks: Record<string, Entry>; zeleAt?: number; zeleOk?: boolean; zeleErr?: string; kakaoOff?: { reason: string; since: string } }
export const KAKAO_OFF_FLAG = `${DIR}/kakao-off`
const KAKAO_DEPENDENT = (id: string) => id === 'kka-sync' || id === 'kakao-health' || id === 'kakao-loco' || id.startsWith('lane:kakao-')
export type HbEvent = { at: string; id: string; kind: 'detected' | 'recover_try' | 'recovered' | 'alerted' | 'resolved' | 'dry_run'; detail: string }

const run = async (cmd: string[], timeoutMs = 20_000) => {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL', env: { ...process.env, PATH: `${HOME}/.local/bin:${HOME}/.bun/bin:${HOME}/.local/node-current/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` } })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { out, err, code }
}
const agentRunning = async (label: string) => (await run(['launchctl', 'print', `gui/${UID}/${label}`])).out.includes('state = running')
const agentLoaded = async (label: string) => (await run(['launchctl', 'print', `gui/${UID}/${label}`])).code === 0

function checkKka(): Check {
  const tail = existsSync(KKA_LOG) ? readFileSync(KKA_LOG, 'utf8').split('\n').slice(-400) : []
  let lastOk = 0
  let lastErr = ''
  for (const line of tail) {
    if (!line.startsWith('{')) continue
    try {
      const j = JSON.parse(line) as { ts: number; ok: boolean; code: string }
      if (j.ok) lastOk = Math.max(lastOk, j.ts * 1000)
      else lastErr = j.code
    } catch { /* partial line */ }
  }
  const age = lastOk ? ageMin(lastOk) : Infinity
  const ok = age <= LIMITS.kkaMin
  return { id: 'kka-sync', ok, detail: ok ? `마지막 성공 ${age}분 전` : `kka sync ${lastOk ? `${age}분째` : '기록에'} 성공 없음${lastErr ? ` (최근 오류 ${lastErr})` : ''}`, recover: { kind: 'kickstart', label: cfg.launchd.kakaoArchiveSync } }
}

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

// 주인 sometimes quits or logs out of KakaoTalk on purpose. Then every Kakao-dependent alert and restart is pointless
// (kakao-loco crash-loops on the token, kka sync fails every 10 min), so they all pause until Kakao is back.
// Returns the off reason, '' when Kakao is verifiably on, or null when the probe itself failed (keep the last state).
async function kakaoOffReason(prev: string | undefined): Promise<string | null> {
  if (process.env.HEARTBEAT_FAKE_KAKAO_OFF !== undefined) return process.env.HEARTBEAT_FAKE_KAKAO_OFF
  // Not `kka doctor`: it reads KakaoTalk's app container, and spawned from this LaunchAgent macOS blames bun and
  // shows the "access data from other apps" prompt every sweep (주인 10-17). pgrep touches no app data.
  const r = await run(['pgrep', '-x', 'KakaoTalk'], 10_000)
  if (r.code !== 0 && r.code !== 1) return null
  if (r.code === 1) return '카톡 앱 꺼짐'
  const err = `${KAKAO_LOGS}/live.err.log`
  const last = existsSync(err) ? readFileSync(err, 'utf8').trimEnd().split('\n').pop() ?? '' : ''
  const at = Date.parse(last.split(' ')[0] ?? '')
  const LOCO = 'kakao-loco 로그인 안 됨(토큰/다른 기기 로그인)'
  if (/exit: .*(invalid access token|LOGINLIST|kicked|-950)/.test(last) && at && ageMin(at) <= 10) return LOCO
  // A token failure stays latched until kakao-loco logs a fresh successful start; an aging error line is not recovery.
  if (prev === LOCO && !(last.includes('listening') && (await agentRunning(label('kakao-live'))))) return LOCO
  return ''
}

// Stops kka sync (SOURCE_READ every 10 min) and kakao-live (KeepAlive crash loop) while Kakao is off. Opt-in via
// HEARTBEAT_PAUSE_KAKAO_AGENTS=1 after the lead has seen the dry run. Not used for a kakao-loco token failure: with
// kakao-live booted out nothing could show that it recovered.
const PAUSABLE = [cfg.launchd.kakaoArchiveSync, label('kakao-live')]
async function pauseKakaoAgents(action: 'bootout' | 'bootstrap', dry: boolean): Promise<string> {
  const live = !dry && process.env.HEARTBEAT_PAUSE_KAKAO_AGENTS === '1'
  const done: string[] = []
  for (const label of PAUSABLE) {
    const cmd = action === 'bootout' ? ['launchctl', 'bootout', `gui/${UID}/${label}`] : ['launchctl', 'bootstrap', `gui/${UID}`, `${HOME}/Library/LaunchAgents/${label}.plist`]
    if (!live) { done.push(`드라이런: ${cmd.join(' ')}`); continue }
    const r = await run(cmd)
    done.push(`${action} ${label}: ${r.code === 0 ? 'ok' : r.err.trim().slice(0, 80)}`)
  }
  return done.join(' / ')
}

async function checkKakaoLoco(): Promise<Check[]> {
  // kakao-health (60 s) owns kakao-live/kakao-push restarts; the heartbeat only makes sure kakao-health itself runs.
  const healthAge = ageMin(mtime(`${KAKAO_LOGS}/health.api-fails`))
  const healthProblem = existsSync(`${KAKAO_LOGS}/health.state`) ? readFileSync(`${KAKAO_LOGS}/health.state`, 'utf8').trim() : ''
  const live = await agentRunning(label('kakao-live'))
  return [
    { id: 'kakao-health', ok: healthAge <= 5, detail: healthAge <= 5 ? `kakao-health ${healthAge}분 전 실행` : `kakao-health ${healthAge}분째 안 돎`, recover: { kind: 'kickstart', label: label('kakao-health') } },
    { id: 'kakao-loco', ok: live && !healthProblem, detail: !live ? 'kakao-loco(kakao-live) 프로세스 멈춤' : healthProblem ? `kakao-health 보고: ${healthProblem}` : 'kakao-loco 정상' },
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

const laneRestartLive = (key: string) => process.env.HEARTBEAT_LANE_RESTART === '1' && (!key.startsWith('kakao-') || process.env.HEARTBEAT_RESTART_KAKAO === '1')

async function recover(c: Check, dry: boolean): Promise<string> {
  if (!c.recover) return ''
  if (c.recover.kind === 'kickstart') {
    if (dry) return `드라이런: launchctl kickstart -k ${c.recover.label}`
    if (!(await agentLoaded(c.recover.label))) return `${c.recover.label} 미등록이라 재시작 못 함`
    const r = await run(['launchctl', 'kickstart', '-k', `gui/${UID}/${c.recover.label}`])
    return r.code === 0 ? `kickstart ${c.recover.label}` : `kickstart 실패: ${r.err.trim().slice(0, 100)}`
  }
  const live = !dry && laneRestartLive(c.recover.key)
  const r = await run(['bash', `${DORI}/lane-restart.sh`, c.recover.key, ...(live ? ['--live'] : [])], 300_000)
  const last = (r.out + r.err).trim().split('\n').slice(-1)[0] ?? ''
  return live ? `lane-restart ${c.recover.key}: ${last}` : `드라이런(레인 재시작 승인 전): ${last}`
}

async function sweep(dry: boolean, to: string) {
  mkdirSync(DIR, { recursive: true })
  const state = readJson<State>(STATE, { checks: {} })
  const now = new Date().toISOString()
  const ev = (id: string, kind: HbEvent['kind'], detail: string) => { if (!dry) appendJsonl(EVENTS, { at: now, id, kind, detail } satisfies HbEvent) }
  const alerts: string[] = []
  const probed = await kakaoOffReason(state.kakaoOff?.reason)
  const offReason = probed ?? state.kakaoOff?.reason ?? ''
  if (offReason && !state.kakaoOff) {
    state.kakaoOff = { reason: offReason, since: now }
    alerts.push(`📴 카톡 꺼짐(${offReason}) — 다시 켜질 때까지 카톡 관련 경보·자동 재시작 멈춤`)
    ev('kakao-off', 'detected', offReason)
    if (!dry) writeFileSync(KAKAO_OFF_FLAG, `${now} ${offReason}\n`)
    if (!offReason.startsWith('kakao-loco')) ev('kakao-off', 'dry_run', await pauseKakaoAgents('bootout', dry))
  } else if (!offReason && state.kakaoOff) {
    if (!state.kakaoOff.reason.startsWith('kakao-loco')) ev('kakao-off', 'dry_run', await pauseKakaoAgents('bootstrap', dry))
    alerts.push(`📳 카톡 다시 켜짐(${ageMin(Date.parse(state.kakaoOff.since))}분 꺼져 있었음) — 감시 재개`)
    ev('kakao-off', 'resolved', state.kakaoOff.reason)
    delete state.kakaoOff
    if (!dry) rmSync(KAKAO_OFF_FLAG, { force: true })
  }
  const probe = async (name: string, fn: () => Check[] | Promise<Check[]>): Promise<Check[]> => {
    try { return await fn() } catch (err) { return [{ id: `probe:${name}`, ok: false, detail: `${name} 점검 실패: ${(err as Error).message.slice(0, 100)}` }] }
  }
  const all = [
    ...(await probe('kka', () => [checkKka()])), ...(await probe('mail', () => checkMail(state))), ...(await probe('kakao', checkKakaoLoco)),
    ...(await probe('lanes', checkLanes)), ...(await probe('disk', checkDisk)),
  ]
  const checks = state.kakaoOff ? all.filter((c) => !KAKAO_DEPENDENT(c.id)) : all
  if (state.kakaoOff) for (const id of Object.keys(state.checks)) if (KAKAO_DEPENDENT(id)) delete state.checks[id]
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
