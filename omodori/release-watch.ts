// Weekly OMO release + dependency security watch for the Dandori lead (dori-improve 2).
//   bun release-watch.ts            one pass; prints only what changed since the last pass
//   bun release-watch.ts --loop 60  one pass every 60 minutes (wire into dori-monitors.sh)
// Event prefix: RELEASE_WATCH (state change) / RELEASE_WATCH_ERROR (newly failing audit).
// Read-only: never installs, upgrades or writes into the watched repos.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.HOME!
export const OMO_PKG = join(HOME, '.bun/install/global/node_modules/omo-ai/package.json')
export const CHANNELS = join(HOME, '.omocat/channels.json')
export const STATE = join(HOME, '.omocat/release-watch-state.json')

export type RepoAudit = { key: string; path: string; high: number; critical: number; error?: string; skip?: boolean }
export type Snapshot = { at: string; installed: string; latest: string; repos: RepoAudit[] }
export type State = { at: string; omo: { installed: string; latest: string }; repos: Record<string, { high: number; critical: number; error?: string }> }

export const installedVersion = (text: string): string => {
  try { return String(JSON.parse(text).version ?? 'unknown') } catch { return 'unknown' }
}

// package-lock/pnpm-lock/bun.lock are auditable in place; a bare yarn.lock is not (needs node_modules).
const RUNNERS = [
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
] as const

export function auditCommand(dir: string): { lock: string; cmd: string[] } | null {
  for (const [lock, tool] of RUNNERS) if (existsSync(join(dir, lock))) return { lock, cmd: [tool, 'audit', '--json'] }
  return null
}

export function parseAudit(text: string): { high: number; critical: number } | { error: string } {
  let j: any
  try { j = JSON.parse(text) } catch { return { error: 'unparsable audit output' } }
  const meta = j?.metadata?.vulnerabilities
  if (meta) return { high: Number(meta.high ?? 0), critical: Number(meta.critical ?? 0) }
  const count = (map: any) =>
    Object.values(map ?? {}).reduce(
      (a: { high: number; critical: number }, v: any) => {
        if (v?.severity === 'high') a.high++
        else if (v?.severity === 'critical') a.critical++
        return a
      },
      { high: 0, critical: 0 },
    )
  if (j && typeof j === 'object' && (j.vulnerabilities || j.advisories)) return count(j.vulnerabilities ?? j.advisories)
  return { error: 'no vulnerability summary in audit output' }
}

export function reposFromChannels(text: string): { key: string; path: string }[] {
  const j = JSON.parse(text)
  return Object.values(j.projects ?? {}).flatMap((p: any) =>
    typeof p?.path === 'string' && typeof p?.key === 'string' ? [{ key: p.key, path: p.path }] : [],
  )
}

export function loadState(file: string): State | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

export function saveState(file: string, s: Snapshot): void {
  const next: State = { at: s.at, omo: { installed: s.installed, latest: s.latest }, repos: {} }
  for (const r of s.repos) {
    if (r.skip) continue
    next.repos[r.key] = r.error ? { high: 0, critical: 0, error: r.error } : { high: r.high, critical: r.critical }
  }
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameSync(tmp, file)
}

const repoTag = (r: RepoAudit) => `${r.key}(h${r.high}/c${r.critical})`

export function eventLines(prev: State | null, now: Snapshot): string[] {
  const out: string[] = []
  const watched = now.repos.filter((r) => !r.skip)
  const prevRepo = (k: string) => prev?.repos?.[k]
  const omoChanged = !prev || prev.omo?.installed !== now.installed || prev.omo?.latest !== now.latest
  const repoChanged =
    watched.some((r) => {
      const p = prevRepo(r.key)
      return !p || p.high !== r.high || p.critical !== r.critical || (p.error ?? '') !== (r.error ?? '')
    }) || Object.keys(prev?.repos ?? {}).some((k) => !watched.some((r) => r.key === k))
  if (prev && !omoChanged && !repoChanged) return out
  const audited = watched.filter((r) => !r.error)
  const high = audited.reduce((n, r) => n + r.high, 0)
  const critical = audited.reduce((n, r) => n + r.critical, 0)
  if (omoChanged || repoChanged) {
    out.push(
      `RELEASE_WATCH omo=${now.installed}->${now.latest} high=${high} critical=${critical} repos=${audited.map(repoTag).join(',') || 'none'}`,
    )
  }
  for (const r of watched) {
    if (!r.error) continue
    const p = prevRepo(r.key)
    if (p?.error === r.error) continue
    out.push(`RELEASE_WATCH_ERROR repo=${r.key} ${r.error.replace(/\s+/g, ' ').slice(0, 200)}`)
  }
  return out
}

async function sh(cmd: string[], cwd: string, timeoutMs = 180_000): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => p.kill(), timeoutMs)
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const code = await p.exited
  clearTimeout(timer)
  return { code, out, err }
}

export async function fetchLatest(): Promise<string> {
  const r = await sh(['npm', 'view', 'omo-ai', 'version'], HOME, 120_000)
  const v = r.out.trim().split('\n').pop()?.trim() ?? ''
  if (r.code !== 0 || !v) throw new Error(`npm view omo-ai version failed: ${r.err.trim().slice(0, 200) || `exit ${r.code}`}`)
  return v
}

export async function auditRepo(r: { key: string; path: string }): Promise<RepoAudit> {
  const base = { key: r.key, path: r.path, high: 0, critical: 0 }
  // A missing mount (external SSD asleep) is an error, not a clean repo.
  if (!existsSync(r.path)) return { ...base, error: 'path missing' }
  const runnable = auditCommand(r.path)
  if (!runnable) return { ...base, skip: true }
  const res = await sh(runnable.cmd, r.path)
  const parsed = parseAudit(res.out)
  if ('error' in parsed) {
    const why = res.err.trim() || (res.code !== 0 ? `exit ${res.code}` : parsed.error)
    return { ...base, error: `${runnable.lock}: ${why}` }
  }
  return { ...base, ...parsed }
}

export async function cycle(opts: {
  stateFile: string
  channelsFile: string
  omoPkg: string
  audit?: (r: { key: string; path: string }) => Promise<RepoAudit>
  latest?: () => Promise<string>
}): Promise<string[]> {
  const installed = installedVersion(readFileSync(opts.omoPkg, 'utf8'))
  let latest: string
  try { latest = await (opts.latest ?? fetchLatest)() } catch { latest = 'unknown' }
  const audit = opts.audit ?? auditRepo
  const repos = await Promise.all(reposFromChannels(readFileSync(opts.channelsFile, 'utf8')).map(audit))
  const snap: Snapshot = { at: new Date().toISOString(), installed, latest, repos }
  const prev = loadState(opts.stateFile)
  const lines = eventLines(prev, snap)
  if (lines.length) saveState(opts.stateFile, snap)
  return lines
}

function parseArgs(argv: string[]) {
  const out = { stateFile: STATE, channelsFile: CHANNELS, omoPkg: OMO_PKG, loopMin: 0 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--state') out.stateFile = argv[++i]!
    else if (a === '--channels') out.channelsFile = argv[++i]!
    else if (a === '--omo-pkg') out.omoPkg = argv[++i]!
    else if (a === '--loop') out.loopMin = Math.max(1, Number(argv[++i] ?? 60) || 60)
  }
  return out
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2))
  const pass = async () => {
    for (const l of await cycle(args)) console.log(l)
  }
  await pass()
  while (args.loopMin > 0) {
    await Bun.sleep(args.loopMin * 60_000)
    await pass()
  }
}
