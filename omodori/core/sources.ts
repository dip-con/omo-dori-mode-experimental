// The one contract between core and a messenger source (sources/<name>/). Core never names a source: everything it
// knows about one comes from config.json sources[] and the source's manifest.json.
//
// A source folder holds:
//   manifest.json   name, settings (keys onboarding asks for and checkSources validates), credentials (files to check),
//                   dataFiles (files created in the data folder from the source's examples), launchAgents (same shape as
//                   core/launchagents/services.json) + defaultAgents, healthCheck (argv onboarding runs), and optional
//                   hooks: lanePrefix (standing lanes), laneProfiles, eventRules, monitors, transcriptSend
//   source.ts       the module: inbound(raw) -> InboundEvent (the common queue event, core/source-queue.ts) and
//                   send(target, text) -> SendResult; optional heartbeat and transition hooks (see SourceModule)
//
//   bun core/sources.ts list               every source folder and whether config.json enables it
//   bun core/sources.ts monitors           one "<argv...>" line per monitor command of the enabled sources (dori-monitors.sh)
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cfg, installHome, logDir, type Bot, type DoriConfig, type SourceEntry } from './config'

export const SOURCES_DIR = process.env.OMODORI_SOURCES_DIR ?? join(import.meta.dir, '..', 'sources')

export type SettingKind = 'id' | 'ids' | 'port' | 'string' | 'strings' | 'path' | 'label'
export type Setting = { key: string; kind: SettingKind; required?: boolean; default?: unknown; prompt?: string }
/** A LaunchAgent template. {bun} {home} {logdir} {logs} (= {logdir}/<source>) {dir} (= the source folder) are filled in. */
export type Service = { args: string[]; keepAlive?: boolean; throttle?: number; interval?: number; calendar?: Record<string, number>; env?: Record<string, string>; out: string; err?: string }
/** A data file onboarding creates from the source's example. entries: ask for keyed rows (e.g. one per chat room). */
export type DataFile = {
  file: string; example: string; what?: string
  entries?: { keyPrompt: string; keyKind?: SettingKind; fields: { key: string; prompt: string; default?: string; list?: boolean }[] }
}
export type Manifest = {
  name: string; title?: string; description?: string; module?: string
  settings?: Setting[]
  credentials?: { file: string; how: string }[]
  dataFiles?: DataFile[]
  usesBots?: boolean
  launchAgents?: Record<string, Service>
  defaultAgents?: string[]
  healthCheck?: string[]
  lanePrefix?: string
  laneProfiles?: string
  eventRules?: string
  monitors?: string[][]
  transcriptSend?: string
  dir: string
}

/** One received message in the shape every source hands to core (the common queue row). */
export type InboundEvent = { source: string; room: string; id: string; sender: string; text: string; at: string; lane?: string | null; isOwner?: boolean }
export type SendResult = { ok: boolean; id?: string | null; error?: string }
export type Check = { id: string; ok: boolean; detail: string; recover?: { kind: 'kickstart'; label: string } | { kind: 'lane'; key: string; pane: string } }
export type SourceModule = {
  /** A raw received message (a log line, a gateway event) -> the common event, or null for lines that are not messages. */
  inbound(raw: unknown): InboundEvent | null
  send(target: string, text: string): Promise<SendResult>
  heartbeat?: {
    checks(): Promise<Check[]>
    /** '' = verifiably on, a reason = off on purpose (pause dependent alerts), null = the probe failed (keep the last state). */
    offReason?(prev: string | undefined): Promise<string | null>
    /** Checks that make no sense while the source is off. */
    dependent?(checkId: string): boolean
    /** Stop/start the source's agents while it is off (dry unless the source's opt-in env is set). */
    pause?(action: 'bootout' | 'bootstrap', dry: boolean, reason: string): Promise<string | null>
  }
  transition?: {
    /** Batches of this lane the source has handed over but not yet seen settle. A lane transition waits for 0. */
    inflight(home: string, lane: string): number
    /** What the source still owes the old session; write=true settles receipts (persisted/carried). */
    inventory(home: string, lane: string, oldPath: string | null, write: boolean): unknown
  }
}

const readManifest = (dir: string): Manifest | null => {
  const f = join(dir, 'manifest.json')
  if (!existsSync(f)) return null
  return { ...(JSON.parse(readFileSync(f, 'utf8')) as Omit<Manifest, 'dir'>), dir }
}

export function availableSources(root = SOURCES_DIR): Manifest[] {
  let names: string[] = []
  try { names = readdirSync(root).sort() } catch { return [] }
  return names.flatMap((n) => { const m = readManifest(join(root, n)); return m ? [m] : [] })
}
export const manifestOf = (name: string, root = SOURCES_DIR): Manifest | null => (/^[a-z0-9-]+$/.test(name) ? readManifest(join(root, name)) : null)
export const entryOf = (name: string, c: DoriConfig = cfg): SourceEntry | undefined => (c.sources ?? []).find((s) => s.name === name)
/** The manifests of the sources config.json lists (unknown names are skipped; checkSources reports them). */
export function enabledSources(c: DoriConfig = cfg, root = SOURCES_DIR): Manifest[] {
  return (c.sources ?? []).flatMap((s) => { const m = manifestOf(s.name, root); return m ? [m] : [] })
}

const HOME = process.env.HOME ?? ''
const expand = (v: unknown): unknown => (typeof v === 'string' ? v.replace(/^~(?=\/|$)/, HOME) : Array.isArray(v) ? v.map(expand) : v)

/** The settings of one source: manifest defaults, then config.json sources[].settings. A source reads its own with this. */
export function sourceSettings<T extends Record<string, unknown>>(name: string, defaults: T, c: DoriConfig = cfg): T {
  const given = entryOf(name, c)?.settings ?? {}
  const out: Record<string, unknown> = { ...defaults }
  for (const [k, v] of Object.entries(given)) if (!k.startsWith('//')) out[k] = expand(v)
  return out as T
}
export const sourceLogDir = (name: string) => `${logDir()}/${name}`
export const agentsOf = (m: Manifest, e?: SourceEntry) => e?.agents ?? m.defaultAgents ?? Object.keys(m.launchAgents ?? {})

const ID = /^\d{6,20}$/
export function checkSetting(s: Setting, v: unknown): string | null {
  const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
  if (empty) return s.required ? 'is required' : null
  switch (s.kind) {
    case 'id': return typeof v === 'string' && ID.test(v) ? null : `"${v}" is not a numeric id`
    case 'ids': return Array.isArray(v) && v.every((x) => typeof x === 'string' && ID.test(x)) ? null : 'must be a list of numeric ids (strings)'
    case 'port': return Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536 ? null : 'must be a port number'
    case 'strings': return Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'must be a list of strings'
    case 'label': return typeof v === 'string' && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(v) ? null : `"${v}" is not a reverse-DNS label`
    default: return typeof v === 'string' ? null : 'must be a string'
  }
}

export function checkSources(c: DoriConfig, root = SOURCES_DIR): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = []
  const seen = new Set<string>()
  for (const [i, e] of (c.sources ?? []).entries()) {
    const where = `sources[${i}]`
    if (!e || typeof e.name !== 'string') { errors.push(`${where}: needs a name`); continue }
    if (seen.has(e.name)) errors.push(`${where}: "${e.name}" is listed twice`)
    seen.add(e.name)
    const m = manifestOf(e.name, root)
    if (!m) { errors.push(`${where}: no source folder sources/${e.name} with a manifest.json (known: ${availableSources(root).map((x) => x.name).join(', ') || 'none'})`); continue }
    const given = e.settings ?? {}
    for (const s of m.settings ?? []) {
      const err = checkSetting(s, given[s.key] ?? s.default)
      if (err) errors.push(`${where} ${e.name}.settings.${s.key} ${err}`)
    }
    for (const k of Object.keys(given)) if (!k.startsWith('//') && !(m.settings ?? []).some((s) => s.key === k)) warnings.push(`${where} ${e.name}.settings.${k} is not a setting of this source`)
    for (const a of e.agents ?? []) if (!m.launchAgents?.[a]) errors.push(`${where} ${e.name}.agents: unknown agent "${a}" (known: ${Object.keys(m.launchAgents ?? {}).join(', ')})`)
    if (m.usesBots && !c.bots.length) warnings.push(`${e.name} is on but bots[] is empty: its lanes use the neutral "assistant" bot with no call words`)
  }
  return { errors, warnings }
}

/** True for lanes owned by an enabled source (they stand always on: no turn wakes, no automatic restarts). */
export function standingLane(key: string, c: DoriConfig = cfg): boolean {
  return enabledSources(c).some((m) => !!m.lanePrefix && key.startsWith(m.lanePrefix))
}
export function profileDirs(coreDir: string, c: DoriConfig = cfg): string[] {
  return [coreDir, ...enabledSources(c).flatMap((m) => (m.laneProfiles ? [join(m.dir, m.laneProfiles)] : []))]
}
export const eventRuleFiles = (c: DoriConfig = cfg) => enabledSources(c).flatMap((m) => (m.eventRules ? [join(m.dir, m.eventRules)] : []))
/** Regexes (group 1 = room, group 2 = text) that find a source's sends inside a lane transcript. */
export const transcriptSends = (c: DoriConfig = cfg): { source: string; re: RegExp }[] =>
  enabledSources(c).flatMap((m) => (m.transcriptSend ? [{ source: m.name, re: new RegExp(m.transcriptSend, 'gs') }] : []))
export const sourceMonitors = (bun = process.execPath, c: DoriConfig = cfg) =>
  enabledSources(c).flatMap((m) => (m.monitors ?? []).map((argv) => argv.map((a) => a.replaceAll('{bun}', bun).replaceAll('{dir}', m.dir))))

export async function loadSource(m: Manifest): Promise<SourceModule> {
  return (await import(join(m.dir, m.module ?? 'source.ts'))) as SourceModule
}
export async function loadEnabled(c: DoriConfig = cfg): Promise<{ manifest: Manifest; mod: SourceModule | null; error?: string }[]> {
  const out = []
  for (const manifest of enabledSources(c)) {
    try { out.push({ manifest, mod: await loadSource(manifest) }) } catch (e) { out.push({ manifest, mod: null, error: (e as Error).message }) }
  }
  return out
}

export const installedSourceDir = (name: string) => join(installHome(), 'sources', name)
export type { Bot }

if (import.meta.main) {
  const cmd = process.argv[2]
  if (cmd === 'list') {
    for (const m of availableSources()) console.log(`${entryOf(m.name) ? 'on ' : 'off'} ${m.name}${m.description ? `  ${m.description}` : ''}`)
  } else if (cmd === 'monitors') {
    for (const argv of sourceMonitors()) console.log(argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' '))
  } else { console.error('usage: sources.ts list | monitors'); process.exit(2) }
}
