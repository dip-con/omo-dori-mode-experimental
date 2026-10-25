// Half-open LOCO guard for kakao-loco.ts (2026-10-24: four hangs, socket ESTABLISHED but the peer never answered).
// agent-messenger times each packet out at 15 s but never treats that as a dead session: executeWithReconnect only
// reconnects when the session object changed, and its own 20 s PING swallows failures. So every API call failed slowly
// forever until kakao-health restarted the process (~3 min). This bounds API calls and turns dead PINGs into an exit.

export class LocoTimeout extends Error {}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LocoTimeout(`${what} timed out after ${ms}ms`)), ms) })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

// 10-25: the session went half-open again but probes failed only every other time (1/2, ok, 1/2) and /messages timed
// out 4x in 2.5 h, so the consecutive-failure rule never fired and Kakao was deaf for 3.6 h. Any timeout (API or
// probe) is now also counted in a sliding window; maxInWindow of them within windowMs is treated as a dead session.
export class TroubleWindow {
  private at: number[] = []
  constructor(private readonly o: { windowMs: number; maxInWindow: number }, private readonly onDead: (why: string) => void, private readonly now: () => number = Date.now) {}
  record(what: string) {
    const t = this.now()
    this.at = this.at.filter((x) => t - x < this.o.windowMs)
    this.at.push(t)
    if (this.at.length >= this.o.maxInWindow) this.onDead(`${this.at.length} LOCO timeouts within ${Math.round(this.o.windowMs / 60000)} min (last: ${what})`)
  }
}

export async function boundedResponse(run: () => Promise<Response>, ms: number, what: string, log: (...a: unknown[]) => void = console.error, trouble?: TroubleWindow): Promise<Response> {
  try {
    return await withTimeout(run(), ms, what)
  } catch (e) {
    if (!(e instanceof LocoTimeout)) throw e
    log(new Date().toISOString(), 'api timeout:', e.message)
    trouble?.record(e.message)
    return Response.json({ error: e.message }, { status: 504 })
  }
}

export type WatchdogOptions = { intervalMs: number; timeoutMs: number; maxFails: number }

// Probes the LOCO session periodically; maxFails consecutive failures call onDead (kakao-loco exits, launchd restarts
// it after ThrottleInterval 5 s, and the startup catch-up replays what was missed). It stays disarmed until a probe has
// succeeded once, so a server that never answered the probe cannot cause a restart loop.
export function startLocoWatchdog(probe: () => Promise<unknown>, onDead: (why: string) => void, o: WatchdogOptions, log: (...a: unknown[]) => void = console.error, trouble?: TroubleWindow) {
  let armed = false, fails = 0, busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      await withTimeout(probe(), o.timeoutMs, 'LOCO probe')
      if (!armed) log(new Date().toISOString(), 'loco watchdog armed')
      armed = true
      fails = 0
    } catch (e) {
      if (!armed) { log(new Date().toISOString(), 'loco probe failed before first success (watchdog not armed):', (e as Error).message); return }
      fails++
      log(new Date().toISOString(), `loco probe failed ${fails}/${o.maxFails}:`, (e as Error).message)
      if (fails >= o.maxFails) onDead(`loco probe failed ${fails}x in a row (half-open connection)`)
      else trouble?.record(`probe: ${(e as Error).message}`)
    } finally {
      busy = false
    }
  }
  const timer = setInterval(tick, o.intervalMs)
  return { tick, stop: () => clearInterval(timer) }
}
