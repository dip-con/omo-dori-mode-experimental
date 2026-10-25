// Lane registry (redesign S3).
// sessions-map.json is written only through patchLane: map lock (mkdir) + re-read + per-key patch + tmp+rename, with an
// optional generation CAS. Lifecycle work (open/close/reopen/transition/reap) runs inside withLaneLease(key, op), which
// refuses a second taker at once (lease_held) instead of queueing it.
// Locks and leases are directories holding owner.json = {pid, bootAtMs, processStartedAtMs, at, nonce, ...}. One is
// reclaimed only when its process is gone (dead pid, other boot, or a reused pid whose start time differs); age alone
// never reclaims a lock whose process is alive. ~/.dori/state/lanes/<key>.json uses the same per-key protocol
// (<lanesDir>/<key>.lock/), implemented again in dori-mode src/registry.ts; registry.test.ts runs the two side by side.
//   bun registry.ts get <key>
//   bun registry.ts rollback-fields --fields a,b,c     strip v2 fields from every entry, under the map lock
//   bun registry.ts unlock --if-dead                   remove the map lock only when its holder is gone
// OMODORI_HOME (default ~/.omodori) roots the map, lock, leases and events; tests point it at a temp tree.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { dirname, join } from 'node:path'
import { doriHome } from './config'

export { doriHome }
export const paths = (home = doriHome()) => ({
  home,
  map: join(home, 'sessions-map.json'),
  mapLock: join(home, 'sessions-map.lock'),
  leases: join(home, 'lane-leases'),
  events: join(home, 'events', 'registry.ndjson'),
  doriLanes: process.env.DORI_LANES_DIR ?? (process.env.OMODORI_HOME ? join(home, 'dori-lanes') : `${process.env.HOME}/.dori/state/lanes`),
})

export class RegistryError extends Error {
  constructor(readonly code: string, message?: string, readonly detail?: unknown) { super(message ?? code) }
}

export const LANE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/
const checkKey = (key: string) => { if (!LANE_KEY_RE.test(key)) throw new RegistryError('bad_key', `bad lane key ${JSON.stringify(key)}`) }

export type Identity = { pid: number; bootAtMs: number; processStartedAtMs: number }
const START_TOLERANCE_MS = 3_000
const BOOT_TOLERANCE_MS = 120_000
const floorSec = (ms: number) => Math.floor(ms / 1000) * 1000
const OWN_START = floorSec(Date.now() - process.uptime() * 1000)
export const bootAtMs = () => Math.round((Date.now() - uptime() * 1000) / 1000) * 1000
export const ownIdentity = (): Identity => ({ pid: process.pid, bootAtMs: bootAtMs(), processStartedAtMs: OWN_START })

export const pidAlive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

/** When the process now wearing `pid` started, from ps etime (elapsed, so no timezone parsing); undefined when unknown. */
export async function processStartMs(pid: number): Promise<number | undefined> {
  const p = Bun.spawn(['ps', '-o', 'etime=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' })
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited])
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(out)
  if (!m) return undefined
  const secs = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4])
  return floorSec(Date.now()) - secs * 1000
}

/** True while the process that wrote `h` is still running (not dead, not another boot, not a reused pid). */
export async function identityLive(h: Partial<Identity> | null | undefined): Promise<boolean> {
  if (!h || typeof h.pid !== 'number') return false
  if (typeof h.bootAtMs === 'number' && Math.abs(h.bootAtMs - bootAtMs()) > BOOT_TOLERANCE_MS) return false
  if (h.pid === process.pid) return typeof h.processStartedAtMs !== 'number' || Math.abs(h.processStartedAtMs - OWN_START) <= START_TOLERANCE_MS
  if (!pidAlive(h.pid)) return false
  if (typeof h.processStartedAtMs !== 'number') return true
  const seen = await processStartMs(h.pid)
  return seen === undefined || Math.abs(seen - h.processStartedAtMs) <= START_TOLERANCE_MS
}

const OWNER = 'owner.json'
const UNREADABLE_STALE_MS = 30_000 // a lock dir without a readable owner: a crash between mkdir and write
export type Held = { dir: string; mine: string; release: () => void }
type LockState = { state: 'free' } | { state: 'held'; owner?: any } | { state: 'stale'; raw?: string }

const readText = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return undefined } }

export async function lockState(dir: string): Promise<LockState> {
  const raw = readText(join(dir, OWNER))
  let owner: any
  try { owner = raw === undefined ? undefined : JSON.parse(raw) } catch { owner = undefined }
  if (!owner) {
    let age: number
    try { age = Date.now() - statSync(dir).mtimeMs } catch { return { state: 'free' } }
    return age > UNREADABLE_STALE_MS ? { state: 'stale', raw } : { state: 'held' }
  }
  return (await identityLive(owner)) ? { state: 'held', owner } : { state: 'stale', raw }
}

/** Move a stale lock aside; one that changed since it was judged (someone took it meanwhile) is put back. */
function breakStale(dir: string, raw: string | undefined) {
  const aside = `${dir}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.broken`
  try { renameSync(dir, aside) } catch { return }
  if (readText(join(aside, OWNER)) !== raw) { try { renameSync(aside, dir); return } catch { /* a new lock exists: the moved one is lost */ } }
  rmSync(aside, { recursive: true, force: true })
}

export async function acquireDirLock(dir: string, opts: { waitMs?: number; pollMs?: number; extra?: Record<string, unknown> } = {}): Promise<Held> {
  const mine = JSON.stringify({ ...ownIdentity(), at: new Date().toISOString(), nonce: crypto.randomUUID(), ...opts.extra })
  const deadline = Date.now() + (opts.waitMs ?? 30_000)
  for (;;) {
    try {
      mkdirSync(dir, { mode: 0o700 })
      writeFileSync(join(dir, OWNER), mine)
      const release = () => { if (readText(join(dir, OWNER)) === mine) rmSync(dir, { recursive: true, force: true }) }
      return { dir, mine, release }
    } catch (e: any) { if (e?.code !== 'EEXIST') throw e }
    const st = await lockState(dir)
    if (st.state === 'stale') { breakStale(dir, st.raw); continue }
    if (st.state === 'free') continue
    if (Date.now() >= deadline) throw new RegistryError('lock_wait', `lock_wait ${dir} held by pid ${st.owner?.pid ?? '?'}`, st.owner)
    await Bun.sleep(opts.pollMs ?? 50)
  }
}

export function appendEvent(ev: { id?: string; kind: string; [k: string]: unknown }, home = doriHome()): boolean {
  const file = paths(home).events
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  if (ev.id && (readText(file) ?? '').split('\n').some((l) => l.includes(`"id":${JSON.stringify(ev.id)}`))) return false
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...ev })}\n`, { mode: 0o600 })
  return true
}

export type Entry = {
  key: string; label: string; cwd: string; thread: string | null
  workspace: string; tab: string; pane: string; sessionId: string
  status: 'open' | 'closed'; openedAt: string; closedAt?: string
  generation?: number; sessionPath?: string; sessionVia?: string
  lineage?: { parentKey?: string; childKeys?: string[]; sessions?: string[] }
  endpoint?: { kind: string; socket: string; instanceId: string; seenAt: string }
  account?: string | null
  [k: string]: unknown
}
export type LaneMap = Record<string, Entry>

export const readMap = (home = doriHome()): LaneMap => {
  const f = paths(home).map
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}
}
const writeMap = (file: string, m: LaneMap) => {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`
  writeFileSync(tmp, JSON.stringify(m, null, 2))
  renameSync(tmp, file)
}

export async function withMapLock<T>(fn: () => T | Promise<T>, opts: { home?: string; waitMs?: number } = {}): Promise<T> {
  const p = paths(opts.home)
  mkdirSync(p.home, { recursive: true })
  const held = await acquireDirLock(p.mapLock, { waitMs: opts.waitMs })
  try { return await fn() } finally { held.release() }
}

export type Patch = Partial<Entry> | Record<string, unknown>
/**
 * The one writer of sessions-map.json. Re-reads the file under the map lock and changes only `key`; a key set to
 * undefined in the patch is removed. With `expectGeneration`, a different stored generation (missing = 0) refuses
 * with generation_conflict and writes nothing.
 */
export async function patchLane(key: string, expectGeneration: number | undefined, patch: Patch | ((cur: Entry | undefined) => Patch),
  opts: { home?: string; waitMs?: number } = {}): Promise<Entry> {
  checkKey(key)
  const p = paths(opts.home)
  let conflict: { expected: number; found: number } | null = null
  const out = await withMapLock(() => {
    const m = readMap(p.home)
    const cur = m[key]
    const g = cur?.generation ?? 0
    if (expectGeneration !== undefined && g !== expectGeneration) { conflict = { expected: expectGeneration, found: g }; return null }
    const d = typeof patch === 'function' ? patch(cur) : patch
    const next: Record<string, unknown> = { ...(cur ?? { key }) }
    for (const [k, v] of Object.entries(d)) { if (v === undefined) delete next[k]; else next[k] = v }
    m[key] = next as Entry
    writeMap(p.map, m)
    return next as Entry
  }, opts)
  if (!out) {
    const c = conflict as unknown as { expected: number; found: number }
    appendEvent({ kind: 'registry.generation_conflict', lane: key, ...c }, p.home)
    throw new RegistryError('generation_conflict', `generation_conflict ${key} expected ${c.expected} found ${c.found}`, c)
  }
  return out
}

export const addLineage = (lineage: Entry['lineage'] | undefined, oldId: string | undefined) => {
  const sessions = [...(lineage?.sessions ?? [])]
  if (oldId && !sessions.includes(oldId)) sessions.push(oldId)
  return { ...(lineage ?? {}), sessions }
}

export type LeaseOp = 'open' | 'close' | 'reopen' | 'transition' | 'reap'
export type Lease = { key: string; op: LeaseOp; generation: number; dir: string }
const heldLeases = new Set<Held>()
let exitHook = false

/** Runs `fn` holding the lane's lifecycle lease. A live holder refuses at once with lease_held (no waiting). */
export async function withLaneLease<T>(key: string, op: LeaseOp, fn: (lease: Lease) => T | Promise<T>, opts: { home?: string } = {}): Promise<T> {
  checkKey(key)
  const p = paths(opts.home)
  mkdirSync(p.leases, { recursive: true, mode: 0o700 })
  chmodSync(p.leases, 0o700)
  const generation = readMap(p.home)[key]?.generation ?? 0
  const dir = join(p.leases, key)
  let held: Held
  try {
    held = await acquireDirLock(dir, { waitMs: 0, extra: { key, op, generation, startedAt: new Date().toISOString() } })
  } catch (e) {
    if (e instanceof RegistryError && e.code === 'lock_wait') {
      const o = e.detail as any
      throw new RegistryError('lease_held', `lease_held ${o?.pid ?? '?'} ${o?.op ?? '?'}`, o)
    }
    throw e
  }
  heldLeases.add(held)
  if (!exitHook) { exitHook = true; process.once('exit', () => { for (const h of heldLeases) h.release() }) }
  try { return await fn({ key, op, generation, dir }) } finally { held.release(); heldLeases.delete(held) }
}

export const leaseActive = (key: string, home = doriHome()) => existsSync(join(paths(home).leases, key))

export async function updateDoriLane(key: string, fn: (cur: any | null) => any | null, opts: { dir?: string; waitMs?: number } = {}): Promise<any | null> {
  checkKey(key)
  const dir = opts.dir ?? paths().doriLanes
  mkdirSync(dir, { recursive: true })
  const held = await acquireDirLock(join(dir, `${key}.lock`), { waitMs: opts.waitMs })
  try {
    const file = join(dir, `${key}.json`)
    const cur = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
    const next = fn(cur)
    if (next === null) return cur
    const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 1))
    renameSync(tmp, file)
    return next
  } finally { held.release() }
}

export async function liveHolders(sessionPath: string, durableId: string): Promise<{ pid: number }[]> {
  const dir = join(dirname(sessionPath), 'session-holders', encodeURIComponent(durableId))
  let files: string[] = []
  try { files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)) } catch { return [] }
  const out: { pid: number }[] = []
  for (const f of files) {
    let rec: any
    try { rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { continue }
    if (await identityLive(rec)) out.push({ pid: rec.pid })
  }
  return out
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const [cmd, arg] = argv
  try {
    switch (cmd) {
      case 'get': console.log(JSON.stringify(readMap()[arg!] ?? null, null, 2)); break
      case 'rollback-fields': {
        const fields = (opt('--fields') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        if (!fields.length) throw new Error('usage: registry.ts rollback-fields --fields a,b,c')
        const n = await withMapLock(() => {
          const m = readMap()
          let stripped = 0
          for (const e of Object.values(m)) for (const f of fields) if (f in e) { delete (e as any)[f]; stripped++ }
          writeMap(paths().map, m)
          return stripped
        })
        console.log(`rollback-fields stripped ${n} field values (${fields.join(',')})`)
        break
      }
      case 'unlock': {
        if (!argv.includes('--if-dead')) throw new Error('usage: registry.ts unlock --if-dead')
        const lock = paths().mapLock
        const st = await lockState(lock)
        if (st.state === 'free') console.log('unlock: no lock')
        else if (st.state === 'held') { console.log(`unlock: refused, holder pid ${(st as any).owner?.pid ?? '?'} is alive`); process.exitCode = 4 }
        else { breakStale(lock, st.raw); console.log('unlock: stale lock removed') }
        break
      }
      default: console.error('usage: registry.ts get <key> | rollback-fields --fields a,b | unlock --if-dead'); process.exitCode = 2
    }
  } catch (e: any) { console.error(e?.message ?? String(e)); process.exitCode = e instanceof RegistryError && e.code === 'lock_wait' ? 5 : 1 }
}
