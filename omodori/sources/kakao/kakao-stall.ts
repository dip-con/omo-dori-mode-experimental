// KakaoTalk read/push stall alert (dori-improve 6). Emits on state change only:
//   KAKAO_STALL live ...       kakao-live is not running, or wrote no message event for >= 30 min while this hour is busy
//   KAKAO_STALL push ...       kakao-push is not running, or an owner message in a watched room got no push line in >= 30 min
//   KAKAO_STALL_RECOVERED ...  the stalled side is moving again
// Quiet hours come from the data: hour slots (KST) averaging < 2 events/h over 7 days are skipped, and the idle limit
// stretches to the gap that has < 0.5% chance under that hour's usual rate (Poisson: 60 * ln 200 / rate minutes).
//   bun kakao-stall.ts [--loop MIN] [--min 30]      bun kakao-stall.ts --at <ISO>   (replay against the logs)
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { oldestOpen } from './kakao-queue'
import { label, doriHome, installRef } from '../../core/config'
import { kakao, kakaoLogs } from './settings'

const HOME = process.env.HOME!
const LOGS = kakaoLogs()
const STATE = `${doriHome()}/kakao-stall-state.json`
const MIN = 60_000

export type LiveEvent = { t: number; chat: string; sender: string; fromMe: boolean }
export type Room = { owner: string[] }

export const liveEvents = (ndjson: string): LiveEvent[] => ndjson.split('\n').flatMap((l) => {
  const ts = /"timestamp":"([^"]+)"/.exec(l)?.[1]
  if (!ts) return []
  return [{ t: Date.parse(ts), chat: /"chat_id":(\d+)/.exec(l)?.[1] ?? '', sender: /"sender_id":(\d+)/.exec(l)?.[1] ?? '', fromMe: l.includes('"is_from_me":true') }]
})
export const pushTimes = (log: string) => log.split('\n').flatMap((l) => { const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s/.exec(l); return m ? [Date.parse(m[1]!)] : [] })
// wake-filter.ndjson: every message the filter judged (woken or deliberately skipped) counts as handled for its chat.
export const filterHandled = (ndjson: string): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const l of ndjson.split('\n')) {
    const at = /"at":"([^"]+)"/.exec(l)?.[1]; const chat = /"chat":"?(\d+)/.exec(l)?.[1]
    if (at && chat) out[chat] = Math.max(out[chat] ?? 0, Date.parse(at))
  }
  return out
}

const kstHour = (ms: number) => new Date(ms + 9 * 3600_000).getUTCHours()
export function hourRate(times: number[], now: number): number {
  const h = kstHour(now)
  return times.filter((t) => t < now && now - t <= 7 * 24 * 60 * MIN && kstHour(t) === h).length / 7
}

export type Verdict = { live: string | null; push: string | null }
export function assess(live: LiveEvent[], push: number[], now: number, o: { minutes?: number; rooms?: Record<string, Room>; running?: { live: boolean; push: boolean }; handled?: Record<string, number> } = {}): Verdict {
  const minutes = o.minutes ?? 30
  const seen = live.filter((e) => e.t <= now)
  const lastLive = Math.max(0, ...seen.map((e) => e.t))
  const lastPush = Math.max(0, ...push.filter((t) => t <= now))
  const v: Verdict = { live: null, push: null }
  const rate = hourRate(seen.map((e) => e.t), now)
  const limit = Math.max(minutes, rate > 0 ? (60 * Math.log(200)) / rate : Infinity)
  const idle = (now - lastLive) / MIN
  if (o.running && !o.running.live) v.live = 'kakao-live launchd job is not running'
  else if (rate >= 2 && idle >= limit) v.live = `no kakao-live message event for ${Math.round(idle)}m (last ${kst(lastLive)}; this hour usually ~${rate.toFixed(1)}/h, limit ${Math.round(limit)}m)`
  const rooms = o.rooms ?? {}
  const handled = o.handled ?? {}
  const waiting = seen.filter((e) => e.t > lastPush && e.t > (handled[e.chat] ?? 0) && !e.fromMe && rooms[e.chat]?.owner.includes(e.sender))
  if (o.running && !o.running.push) v.push = 'kakao-push launchd job is not running'
  else if (waiting.length && (now - Math.min(...waiting.map((e) => e.t))) / MIN >= minutes) v.push = `${waiting.length} owner message(s) in watched rooms since ${kst(Math.min(...waiting.map((e) => e.t)))} with no kakao-push line (last ${kst(lastPush)})`
  return v
}
// Redesign S7: a batch in kakao-queue.sqlite that is not persisted after `minutes` is a push stall too (read-only).
export function queueStall(o: { id: string; state: string; lane: string; createdAt: number } | null, now: number, minutes = 30): string | null {
  if (!o || (now - o.createdAt) / MIN < minutes) return null
  return `batch ${o.id} (${o.lane}, ${o.state}) not persisted for ${Math.round((now - o.createdAt) / MIN)}m`
}

const kst = (ms: number) => (ms ? new Date(ms + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ') + ' KST' : 'never')

function running(): { live: boolean; push: boolean } {
  const out = Bun.spawnSync(['launchctl', 'list'], { stdout: 'pipe' }).stdout.toString()
  const pid = (label: string) => /^(\S+)\t/.exec(out.split('\n').find((l) => l.endsWith(`\t${label}`)) ?? '')?.[1]
  const up = (label: string) => { const p = pid(label); return !!p && p !== '-' }
  return { live: up(label('kakao-live')), push: up(label('kakao-push')) }
}

async function serverNewest(): Promise<number | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${kakao.locoPort}/chats?count=50`, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) return null
    const chats = (await r.json()) as { last_message?: { sent_at?: number } }[]
    return Math.max(0, ...chats.map((c) => (c.last_message?.sent_at ?? 0) * 1000))
  } catch { return null }
}

async function tick(now: number, minutes: number, replay: boolean): Promise<string[]> {
  const live = existsSync(`${LOGS}/live.ndjson`) ? liveEvents(readFileSync(`${LOGS}/live.ndjson`, 'utf8')) : []
  const push = existsSync(`${LOGS}/push.log`) ? pushTimes(readFileSync(`${LOGS}/push.log`, 'utf8')) : []
  const handled = existsSync(`${LOGS}/wake-filter.ndjson`) ? filterHandled(readFileSync(`${LOGS}/wake-filter.ndjson`, 'utf8')) : {}
  const rooms = JSON.parse(readFileSync(`${doriHome()}/kakao-rooms.json`, 'utf8'))
  const v = assess(live, push, now, { minutes, rooms, handled, running: replay ? undefined : running() })
  // A quiet hour is not a stall: if the server's newest message in any chat is not newer than our last logged event, nothing was missed.
  if (v.live && !replay && !v.live.includes('not running')) {
    const newest = await serverNewest()
    const lastLive = Math.max(0, ...live.map((e) => e.t))
    if (newest !== null && newest <= lastLive + 60_000) v.live = null
  }
  if (!replay && !v.push) {
    v.push = queueStall(oldestOpen(`${doriHome()}/kakao-queue.sqlite`), now, minutes)
  }
  if (replay) return [`KAKAO_REPLAY at ${kst(now)} live=${v.live ?? 'ok'} push=${v.push ?? 'ok'}`]
  const prev: Verdict = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { live: null, push: null }
  const out: string[] = []
  for (const side of ['live', 'push'] as const) {
    if (v[side] && !prev[side]) out.push(`KAKAO_STALL ${side} ${v[side]} -> check: bash ${installRef()}/sources/kakao/kakao-health.sh; tail ${kakaoLogs()}/${side === 'live' ? 'live.err.log' : 'push.log'}`)
    if (!v[side] && prev[side]) out.push(`KAKAO_STALL_RECOVERED ${side}`)
  }
  const tmp = `${STATE}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(v)); renameSync(tmp, STATE)
  return out
}

if (import.meta.main) {
  const opt = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
  const minutes = Number(opt('--min') ?? 30)
  const at = opt('--at')
  const loop = opt('--loop')
  do {
    try { for (const l of await tick(at ? Date.parse(at) : Date.now(), minutes, !!at)) console.log(l) } catch (err) { console.log(`KAKAO_STALL_ERROR ${(err as Error).message}`) }
    if (loop) await Bun.sleep(Number(loop) * MIN)
  } while (loop && !at)
}
