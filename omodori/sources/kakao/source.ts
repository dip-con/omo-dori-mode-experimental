// KakaoTalk source module (the core/sources.ts contract). The live pipeline itself runs in this folder's LaunchAgents
// (kakao-loco -> live.ndjson -> kakao-push with its own delivery queue); this module is how core talks to it.
//   inbound    one live.ndjson line -> InboundEvent
//   send       POST to kakao-loco's local API (/send)
//   heartbeat  kka archive sync, kakao-health / kakao-loco liveness, "KakaoTalk is off" detection and agent pause
//   transition kakao-queue batches of a lane during a lane transition (inflight wait + receipt inventory)
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { doriHome, label } from '../../core/config'
import { receipt } from '../../core/rpc'
import type { Check, InboundEvent, SendResult, SourceModule } from '../../core/sources'
import { idsOf, Queue, queuePath, type SentTo } from './kakao-queue'
import { kakao, kakaoLogs } from './settings'

const HOME = process.env.HOME ?? ''
const UID = process.getuid?.() ?? 0

let rooms: Record<string, { lane?: string; owner?: string[] }> | null = null
const roomsOf = () => (rooms ??= (() => { try { return JSON.parse(readFileSync(join(doriHome(), 'kakao-rooms.json'), 'utf8')) } catch { return {} } })())

export function inbound(raw: unknown): InboundEvent | null {
  if (typeof raw !== 'string' || !raw.trim().startsWith('{')) return null
  let m: any
  try { m = JSON.parse(raw) } catch { return null }
  if (m.is_from_me || typeof m.text !== 'string') return null
  const { chat, log } = idsOf(raw)
  if (!chat) return null
  const sender = /"sender_id"\s*:\s*"?(\d+)/.exec(raw)?.[1] ?? String(m.sender_id ?? '')
  const room = roomsOf()[chat]
  return { source: 'kakao', room: chat, id: log, sender, text: m.text, at: m.timestamp ?? new Date().toISOString(), lane: room?.lane ?? null, isOwner: !!room?.owner?.includes(sender) }
}

export async function send(target: string, text: string): Promise<SendResult> {
  try {
    const res = await fetch(`${process.env.OMODORI_LOCO ?? `http://127.0.0.1:${kakao.locoPort}`}/send`, { method: 'POST', body: JSON.stringify({ chat: target, text }), signal: AbortSignal.timeout(20_000) })
    const body = await res.text()
    return res.ok ? { ok: true, id: (() => { try { return JSON.parse(body).log_id ?? null } catch { return null } })() } : { ok: false, error: `${res.status} ${body.slice(0, 200)}` }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

const run = async (cmd: string[], timeoutMs = 20_000) => {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL' })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { out, err, code }
}
const agentRunning = async (l: string) => (await run(['launchctl', 'print', `gui/${UID}/${l}`])).out.includes('state = running')
const mtime = (f: string) => { try { return Bun.file(f).lastModified } catch { return 0 } }
const ageMin = (ms: number) => (ms ? Math.round((Date.now() - ms) / 60_000) : Infinity)
const KKA_LOG = process.env.HEARTBEAT_KKA_LOG ?? `${HOME}/Library/Logs/kakao-archive/sync.log`
const KKA_MIN = 30
const LOCO_DOWN = 'kakao-loco 로그인 안 됨(토큰/다른 기기 로그인)'

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
  const ok = age <= KKA_MIN
  return { id: 'kka-sync', ok, detail: ok ? `마지막 성공 ${age}분 전` : `kka sync ${lastOk ? `${age}분째` : '기록에'} 성공 없음${lastErr ? ` (최근 오류 ${lastErr})` : ''}`, recover: { kind: 'kickstart', label: kakao.archiveSyncLabel } }
}

async function checkLoco(): Promise<Check[]> {
  // kakao-health (60 s) owns kakao-live/kakao-push restarts; the heartbeat only makes sure kakao-health itself runs.
  const logs = kakaoLogs()
  const healthAge = ageMin(mtime(`${logs}/health.api-fails`))
  const healthProblem = existsSync(`${logs}/health.state`) ? readFileSync(`${logs}/health.state`, 'utf8').trim() : ''
  const live = await agentRunning(label('kakao-live'))
  return [
    { id: 'kakao-health', ok: healthAge <= 5, detail: healthAge <= 5 ? `kakao-health ${healthAge}분 전 실행` : `kakao-health ${healthAge}분째 안 돎`, recover: { kind: 'kickstart', label: label('kakao-health') } },
    { id: 'kakao-loco', ok: live && !healthProblem, detail: !live ? 'kakao-loco(kakao-live) 프로세스 멈춤' : healthProblem ? `kakao-health 보고: ${healthProblem}` : 'kakao-loco 정상' },
  ]
}

// 주인 sometimes quits or logs out of KakaoTalk on purpose. Then every Kakao-dependent alert and restart is pointless
// (kakao-loco crash-loops on the token, kka sync fails every 10 min), so they all pause until Kakao is back.
async function offReason(prev: string | undefined): Promise<string | null> {
  if (process.env.HEARTBEAT_FAKE_KAKAO_OFF !== undefined) return process.env.HEARTBEAT_FAKE_KAKAO_OFF
  // Not `kka doctor`: it reads KakaoTalk's app container, and spawned from a LaunchAgent macOS blames bun and
  // shows the "access data from other apps" prompt every sweep (주인 10-17). pgrep touches no app data.
  const r = await run(['pgrep', '-x', 'KakaoTalk'], 10_000)
  if (r.code !== 0 && r.code !== 1) return null
  if (r.code === 1) return '카톡 앱 꺼짐'
  const err = `${kakaoLogs()}/live.err.log`
  const last = existsSync(err) ? readFileSync(err, 'utf8').trimEnd().split('\n').pop() ?? '' : ''
  const at = Date.parse(last.split(' ')[0] ?? '')
  if (/exit: .*(invalid access token|LOGINLIST|kicked|-950)/.test(last) && at && ageMin(at) <= 10) return LOCO_DOWN
  // A token failure stays latched until kakao-loco logs a fresh successful start; an aging error line is not recovery.
  if (prev === LOCO_DOWN && !(last.includes('listening') && (await agentRunning(label('kakao-live'))))) return LOCO_DOWN
  return ''
}

// Stops kka sync (SOURCE_READ every 10 min) and kakao-live (KeepAlive crash loop) while Kakao is off. Opt-in via
// HEARTBEAT_PAUSE_KAKAO_AGENTS=1 after the lead has seen the dry run. Not used for a kakao-loco token failure: with
// kakao-live booted out nothing could show that it recovered.
async function pause(action: 'bootout' | 'bootstrap', dry: boolean, reason: string): Promise<string | null> {
  if (reason.startsWith('kakao-loco')) return null
  const live = !dry && process.env.HEARTBEAT_PAUSE_KAKAO_AGENTS === '1'
  const done: string[] = []
  for (const l of [kakao.archiveSyncLabel, label('kakao-live')]) {
    const cmd = action === 'bootout' ? ['launchctl', 'bootout', `gui/${UID}/${l}`] : ['launchctl', 'bootstrap', `gui/${UID}`, `${HOME}/Library/LaunchAgents/${l}.plist`]
    if (!live) { done.push(`드라이런: ${cmd.join(' ')}`); continue }
    const r = await run(cmd)
    done.push(`${action} ${l}: ${r.code === 0 ? 'ok' : r.err.trim().slice(0, 80)}`)
  }
  return done.join(' / ')
}

export const heartbeat: NonNullable<SourceModule['heartbeat']> = {
  checks: async () => [checkKka(), ...(await checkLoco())],
  offReason,
  dependent: (id) => id === 'kka-sync' || id === 'kakao-health' || id === 'kakao-loco' || id.startsWith('lane:kakao-'),
  pause,
}

export type KakaoInventory = { persisted: string[]; carried: string[]; queued: string[] }
export const transition: NonNullable<SourceModule['transition']> = {
  inflight(home, lane) {
    const qp = queuePath(home)
    if (!existsSync(qp)) return 0
    const q = Queue.open(qp, { readonly: true })
    try { return q.openBatches(lane).filter((b) => b.state === 'accepted').length } finally { q.close() }
  },
  inventory(home, lane, oldPath, write): KakaoInventory {
    const out: KakaoInventory = { persisted: [], carried: [], queued: [] }
    const qp = queuePath(home)
    if (!existsSync(qp)) return out
    const q = Queue.open(qp, write ? {} : { readonly: true })
    try {
      for (const b of q.openBatches(lane)) {
        if (b.state === 'accepted' || b.state === 'uncertain') {
          const st = b.sent_to_json ? (JSON.parse(b.sent_to_json) as SentTo) : null
          if (receipt(st?.sessionPath ?? oldPath, b.id) === 'persisted') { out.persisted.push(b.id); if (write) q.markPersisted(b.id) }
          else { out.carried.push(b.id); if (write) q.markResult(b.id, 'carried', { error: 'lane transition: no receipt in the old session' }) }
        } else out.queued.push(b.id)
      }
    } finally { q.close() }
    return out
  },
}
