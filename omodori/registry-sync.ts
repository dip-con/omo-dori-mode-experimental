// Registry reconciler (redesign S3, docs/dori-redesign/final.md §2.2 rule 4).
// For every open lane (dandori-lead* excluded) it finds the session the pane's agent really serves and compares it
// with sessions-map.json. Evidence, strongest first:
//   1. endpoint: the agent pid's control endpoint (omo host status) answers list_sessions with a durable id
//   2. argv: the agent's --session / --session-id (stale after an in-process session replacement, so only used when
//      no endpoint answers)
//   3. start-time: a session file created right after the agent started (report only, never written)
// --write patches only sessionId/sessionPath/sessionVia/endpoint/account through patchLane (generation CAS) and appends
// the replaced id to lineage.sessions; lanes inside a lifecycle lease are skipped.
//   bun registry-sync.ts --dry                 one DRIFT line per mismatched open lane, nothing else
//   bun registry-sync.ts --write [--loop MIN]  reconcile (loop: each DRIFT/REGISTRY_* line printed once per change)
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Conn } from './rpc'
import { sessionDirSlug, sessionRoot } from './questions'
import { addLineage, appendEvent, leaseActive, patchLane, readMap, RegistryError, updateDoriLane } from './registry'
import { findSessionFile } from './sess'

export type Proc = { pid: number; argv: string[] }
export type Endpoint = { pid: number; socket: string; instanceId: string; kind: 'tui' | 'rpc_host' }
export type SyncDeps = {
  home?: string
  doriLanesDir?: string
  paneProcs: (pane: string) => Promise<Proc[] | null>
  endpoints: () => Promise<Endpoint[]>
  listSessions: (ep: Endpoint) => Promise<string[] | null>
  findSession: (durableId: string, cwd: string | null) => string | null
  startTimeIds: (agent: Proc, cwd: string) => Promise<string[]>
  accountOf: (sessionPath: string) => string | undefined
}
export type Via = 'reconcile-endpoint' | 'reconcile-argv'

const AGENT = /senpi\/dist\/bundle\/cli\.js|(^|\/)omo$/
export const agentOf = (procs: Proc[]) => procs.find((p) => p.argv.some((a) => AGENT.test(a)) && !p.argv.includes('mcp'))
export const argvSession = (argv: string[]) => {
  // `--session <path>` (resume after an omo update) names the jsonl; the durable id is its trailing _<uuid>.jsonl.
  for (const flag of ['--session', '--session-id']) { const i = argv.indexOf(flag); const v = argv[i + 1]; if (i >= 0 && v) return v.match(/_([0-9a-f-]{36})\.jsonl$/)?.[1] ?? v }
  return undefined
}

export async function reconcile(deps: SyncDeps, opts: { write: boolean }): Promise<{ lines: string[]; drift: number }> {
  const lines: string[] = []
  let drift = 0
  const map = readMap(deps.home)
  const lanes = Object.values(map).filter((e) => e?.status === 'open' && e.sessionId && e.pane && !String(e.key).startsWith('dandori-lead'))
  const eps = lanes.length ? await deps.endpoints().catch(() => [] as Endpoint[]) : []
  for (const e of lanes) {
    if (leaseActive(e.key, deps.home)) continue
    const procs = await deps.paneProcs(e.pane).catch(() => null)
    const agent = procs ? agentOf(procs) : undefined
    if (!agent) continue
    const ep = eps.find((x) => x.pid === agent.pid)
    const ids = ep ? await deps.listSessions(ep).catch(() => null) : null
    let live: { id: string; via: Via } | null = null
    if (ids?.length) {
      if (ids.includes(e.sessionId)) live = { id: e.sessionId, via: 'reconcile-endpoint' }
      else if (ids.length === 1) live = { id: ids[0]!, via: 'reconcile-endpoint' }
    } else {
      const fromArgv = argvSession(agent.argv)
      if (fromArgv) live = { id: fromArgv, via: 'reconcile-argv' }
    }
    if (!live) {
      const guesses = (await deps.startTimeIds(agent, e.cwd).catch(() => [] as string[])).filter((id) => id !== e.sessionId)
      if (guesses.length && !(ids?.length)) lines.push(`UNCONFIRMED ${e.key} pane=${e.pane} map=${e.sessionId} start-time=${guesses[0]} (report only, no write)`)
      continue
    }
    const sessionPath = deps.findSession(live.id, e.cwd) ?? undefined
    const endpoint = ep ? { kind: ep.kind, socket: ep.socket, instanceId: ep.instanceId } : undefined
    const account = sessionPath ? deps.accountOf(sessionPath) : undefined
    if (live.id !== e.sessionId) {
      drift++
      lines.push(`DRIFT ${e.key} pane=${e.pane} map=${e.sessionId} live=${live.id} via=${live.via}`)
      if (!opts.write) continue
      try {
        await patchLane(e.key, e.generation ?? 0, (cur) => ({
          sessionId: live!.id, sessionVia: live!.via, sessionPath,
          lineage: addLineage(cur?.lineage, cur?.sessionId),
          ...(endpoint ? { endpoint: { ...endpoint, seenAt: new Date().toISOString() } } : {}),
          ...(account ? { account } : {}),
        }), { home: deps.home })
        appendEvent({ kind: 'registry.reconciled', lane: e.key, from: e.sessionId, to: live.id, via: live.via, generation: e.generation ?? 0 }, deps.home)
        await updateDoriLane(e.key, (l) => (l && l.session !== live!.id ? { ...l, session: live!.id, sessionVia: live!.via } : null), { dir: deps.doriLanesDir })
        lines.push(`REGISTRY_RECONCILED ${e.key} ${e.sessionId} -> ${live.id} via=${live.via}`)
      } catch (err) {
        lines.push(`REGISTRY_ERROR ${e.key} ${err instanceof RegistryError ? err.code : (err as Error).message}`)
      }
      continue
    }
    if (!opts.write) continue
    const cache: Record<string, unknown> = {}
    if (sessionPath && e.sessionPath !== sessionPath) cache.sessionPath = sessionPath
    if (endpoint && (e.endpoint?.socket !== endpoint.socket || e.endpoint?.instanceId !== endpoint.instanceId)) cache.endpoint = { ...endpoint, seenAt: new Date().toISOString() }
    if (account && e.account !== account) cache.account = account
    if (!Object.keys(cache).length) continue
    try { await patchLane(e.key, e.generation ?? 0, cache, { home: deps.home }) } catch (err) {
      lines.push(`REGISTRY_ERROR ${e.key} ${err instanceof RegistryError ? err.code : (err as Error).message}`)
    }
  }
  return { lines, drift }
}

const spawnText = async (args: string[]) => {
  const p = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  return code === 0 ? out : null
}

const START_FILE = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z_([0-9a-f-]{36})\.jsonl$/

export const liveSyncDeps = (): SyncDeps => ({
  paneProcs: async (pane) => {
    const out = await spawnText(['herdr', 'pane', 'process-info', '--pane', pane])
    if (!out) return null
    return (JSON.parse(out).result.process_info.foreground_processes as any[]).map((p) => ({ pid: Number(p.pid), argv: p.argv ?? [] }))
  },
  endpoints: async () => {
    const out = await spawnText(['omo', 'host', 'status', '--json', '--all'])
    if (!out) return []
    return (JSON.parse(out).endpoints as any[]).filter((x) => x.reachable && typeof x.pid === 'number').map((x) => ({
      pid: x.pid, socket: x.socket, instanceId: x.instanceId ?? '', kind: String(x.socket).includes('/rpc/tui/') ? 'tui' as const : 'rpc_host' as const,
    }))
  },
  listSessions: async (ep) => {
    const c = await Conn.open(ep.socket, 1500)
    try {
      const r = await c.request(ep.kind === 'rpc_host' ? { type: 'list_sessions', observe: true } : { type: 'list_sessions' }, 3000)
      return r?.success ? (r.data?.sessions ?? []).map((s: any) => String(s.durableSessionId ?? s.sessionId)) : null
    } finally { c.close() }
  },
  findSession: (id, cwd) => findSessionFile(id, cwd),
  startTimeIds: async (agent, cwd) => {
    const started = Date.parse((await spawnText(['ps', '-o', 'lstart=', '-p', String(agent.pid)]))?.trim() ?? '')
    if (!Number.isFinite(started)) return []
    let names: string[] = []
    try { names = readdirSync(join(sessionRoot(), sessionDirSlug(cwd))) } catch { return [] }
    return names.flatMap((n) => {
      const m = START_FILE.exec(n)
      const at = m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : NaN
      return m && at >= started - 5_000 && at <= started + 180_000 ? [m[5]!] : []
    })
  },
  accountOf: (p) => { try { return JSON.parse(readFileSync(`${p}.claude-sdk-oauth-binding.json`, 'utf8')).accountName } catch { return undefined } },
})

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const write = argv.includes('--write')
  const loopAt = argv.indexOf('--loop')
  const loopMin = loopAt >= 0 ? Number(argv[loopAt + 1]) : 0
  const deps = liveSyncDeps()
  const printed = new Set<string>()
  do {
    try {
      const { lines } = await reconcile(deps, { write })
      for (const l of lines) {
        if (loopMin && printed.has(l)) continue
        printed.add(l)
        console.log(l)
      }
    } catch (err) { console.log(`REGISTRY_ERROR sweep ${(err as Error).message}`) }
    if (loopMin) await Bun.sleep(loopMin * 60_000)
  } while (loopMin)
}

