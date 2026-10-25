// Connects a messenger source to an installed core, or disconnects it. Runs after install.sh (`omodori onboard`).
//   omodori onboard [<source>] [--dry-run] [--set key=value]... [--agents a,b] [--bot "name=call1,call2"]...
//                   [--data <file>=<path>]... [--no-load]
//     1 pick the source (asked when omitted; `omodori sources` lists them)
//     2 settings from manifest.json: --set > current config.json > answer > default (re-onboarding prefills the current values)
//     3 credentials: each file the manifest names is checked; a missing one prints how to create it
//     4 data files (e.g. the room list): --data copies a prepared file, else rows are asked for, else the example is copied
//     5 bots (sources with usesBots, only while bots[] is empty): --bot or asked
//     6 config check (core + every source), then config.json is written (a .bak-<time> copy first)
//     7 only this source's LaunchAgents are rendered, linted and loaded (--no-load: written, not loaded)
//     8 the manifest's healthCheck runs
//   --dry-run does 1-6 in memory, renders the plists to a temp folder and prints what would change; nothing is written.
//   omodori offboard <source> [--dry-run]   unload + delete the source's plists, drop it from config.json (data files stay)
// Last line: ONBOARD_OK | ONBOARD_DRY_RUN_OK | ONBOARD_HEALTH_FAILED | ONBOARD_FAILED <reason> (OFFBOARD_* for offboard).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkConfig, configPath, doriHome, installHome, label, loadConfig, type Bot, type DoriConfig, type SourceEntry } from './config'
import { agentsOf, availableSources, checkSetting, checkSources, manifestOf, SOURCES_DIR, type Manifest, type Setting } from './sources'
import { coreServices, renderJobs, sourceJobs } from './launchagents/render'

export type Io = { tty: boolean; ask(question: string, def?: string): Promise<string>; say(line: string): void }
export type Env = {
  configPath: string; dataHome: string; installHome: string; launchAgentsDir: string; bun: string; sourcesRoot: string
  run(cmd: string[], env?: Record<string, string>): Promise<{ code: number; out: string }>
  now(): Date
}
export type Opts = { source?: string; dryRun: boolean; set: Record<string, string>; agents?: string[]; bots: string[]; data: Record<string, string>; load: boolean }

const HOME = process.env.HOME ?? ''
const expand = (p: string) => p.replace(/^~(?=\/|$)/, HOME)
const UID = process.getuid?.() ?? 0

export const liveEnv = (): Env => ({
  configPath: configPath(), dataHome: doriHome(), installHome: installHome(), launchAgentsDir: `${HOME}/Library/LaunchAgents`,
  bun: process.execPath, sourcesRoot: SOURCES_DIR, now: () => new Date(),
  run: async (cmd, env) => {
    const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...(env ?? {}) }, timeout: 120_000 })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out: (out + err).trim() }
  },
})

const readRaw = (f: string): Record<string, any> => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {})
const parseValue = (s: Setting, v: string): unknown =>
  s.kind === 'port' ? Number(v) : s.kind === 'ids' || s.kind === 'strings' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v.trim()
const show = (v: unknown) => (Array.isArray(v) ? v.join(',') : v === undefined || v === null ? '' : String(v))

function effective(raw: Record<string, any>): DoriConfig {
  const dir = mkdtempSync(join(tmpdir(), 'omodori-onboard-'))
  try { writeFileSync(join(dir, 'config.json'), JSON.stringify(raw)); return loadConfig(join(dir, 'config.json')) } finally { rmSync(dir, { recursive: true, force: true }) }
}
function validate(raw: Record<string, any>, sourcesRoot: string): { errors: string[]; warnings: string[] } {
  const c = effective(raw)
  const core = checkConfig(c, Object.keys(coreServices()).filter((k) => !k.startsWith('//')))
  const src = checkSources(c, sourcesRoot)
  return { errors: [...core.errors, ...src.errors], warnings: [...core.warnings, ...src.warnings] }
}
function writeConfig(env: Env, raw: Record<string, any>, io: Io) {
  if (existsSync(env.configPath)) {
    const bak = `${env.configPath}.bak-${env.now().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(env.configPath, bak)
    io.say(`backup      ${bak}`)
  }
  mkdirSync(dirname(env.configPath), { recursive: true })
  writeFileSync(env.configPath, `${JSON.stringify(raw, null, 2)}\n`)
}

async function pickSource(o: Opts, io: Io, root: string): Promise<Manifest | null> {
  const all = availableSources(root)
  if (o.source) return manifestOf(o.source, root)
  if (!io.tty) return null
  all.forEach((m, i) => io.say(`  ${i + 1}) ${m.name}${m.description ? `  ${m.description}` : ''}`))
  const a = await io.ask('Which source? (number or name)')
  return all[Number(a) - 1] ?? manifestOf(a, root)
}

async function askSettings(m: Manifest, prev: Record<string, unknown>, o: Opts, io: Io): Promise<{ settings: Record<string, unknown>; errors: string[] }> {
  const settings: Record<string, unknown> = {}
  const errors: string[] = []
  for (const s of m.settings ?? []) {
    let v: unknown = o.set[s.key] !== undefined ? parseValue(s, o.set[s.key]!) : prev[s.key]
    if (v === undefined && io.tty) {
      for (;;) {
        const a = await io.ask(`${s.prompt ?? s.key}${s.required ? '' : ' (optional)'}`, show(s.default))
        v = a === '' ? (s.default ?? (s.kind === 'ids' || s.kind === 'strings' ? [] : '')) : parseValue(s, a)
        const err = checkSetting(s, v)
        if (!err) break
        io.say(`  ${s.key} ${err}`)
      }
    }
    if (v === undefined) v = s.default
    const err = checkSetting(s, v)
    if (err) errors.push(`${m.name}.settings.${s.key} ${err}`)
    if (v !== undefined && v !== s.default) settings[s.key] = v
  }
  for (const k of Object.keys(o.set)) if (!(m.settings ?? []).some((s) => s.key === k)) errors.push(`--set ${k}: not a setting of ${m.name} (settings: ${(m.settings ?? []).map((s) => s.key).join(', ')})`)
  return { settings, errors }
}

type DataPlan = { file: string; target: string; action: 'keep' | 'copy' | 'write' | 'example'; from?: string; rows?: Record<string, unknown> }
async function planData(m: Manifest, o: Opts, io: Io, env: Env): Promise<DataPlan[]> {
  const out: DataPlan[] = []
  for (const d of m.dataFiles ?? []) {
    const target = join(env.dataHome, d.file)
    if (o.data[d.file]) { out.push({ file: d.file, target, action: 'copy', from: expand(o.data[d.file]!) }); continue }
    if (existsSync(target)) { out.push({ file: d.file, target, action: 'keep' }); continue }
    const rows: Record<string, unknown> = {}
    if (io.tty && d.entries) {
      io.say(`${d.file}: ${d.what ?? ''}`)
      for (;;) {
        const key = await io.ask(d.entries.keyPrompt)
        if (!key) break
        const err = d.entries.keyKind ? checkSetting({ key: 'key', kind: d.entries.keyKind }, key) : null
        if (err) { io.say(`  ${err}`); continue }
        const row: Record<string, unknown> = {}
        for (const f of d.entries.fields) { const a = await io.ask(`  ${f.prompt}`, f.default); row[f.key] = f.list ? a.split(',').map((x) => x.trim()).filter(Boolean) : a }
        rows[key] = row
      }
    }
    out.push(Object.keys(rows).length ? { file: d.file, target, action: 'write', rows } : { file: d.file, target, action: 'example', from: join(m.dir, d.example) })
  }
  return out
}

async function askBots(m: Manifest, raw: Record<string, any>, o: Opts, io: Io, lanes: string[]): Promise<Bot[]> {
  if (!m.usesBots || (Array.isArray(raw.bots) && raw.bots.length)) return []
  const bots: Bot[] = o.bots.map((b) => { const [name, calls = ''] = b.split('='); return { name: name!.trim(), calls: calls.split(',').map((x) => x.trim()).filter(Boolean), about: '', lanes } })
  if (!bots.length && io.tty) {
    const name = await io.ask('Bot name the rooms call (blank: neutral bot, reached only by mention/reply/1:1)')
    if (name) bots.push({ name, calls: (await io.ask('Call words (comma separated)', name)).split(',').map((x) => x.trim()).filter(Boolean), about: await io.ask('One line about the bot (the wake filter reads it)'), lanes })
  }
  return bots
}

export async function onboard(o: Opts, io: Io, env: Env): Promise<number> {
  const fail = (why: string) => { io.say(`ONBOARD_FAILED ${why}`); return 1 }
  const m = await pickSource(o, io, env.sourcesRoot)
  if (!m) return fail(o.source ? `unknown source "${o.source}" (known: ${availableSources(env.sourcesRoot).map((x) => x.name).join(', ')})` : 'no source given (omodori onboard <source>; omodori sources lists them)')
  const raw = readRaw(env.configPath)
  const sources: SourceEntry[] = Array.isArray(raw.sources) ? raw.sources : []
  const prev = sources.find((s) => s.name === m.name)
  io.say(`source      ${m.name}${prev ? ' (already connected: re-onboarding, current values kept unless changed)' : ''}`)
  io.say(`mode        ${o.dryRun ? 'dry-run' : 'apply'}`)

  const { settings, errors } = await askSettings(m, prev?.settings ?? {}, o, io)
  if (errors.length) { for (const e of errors) io.say(`SETTING_ERROR ${e}`); return fail('settings') }

  for (const c of m.credentials ?? []) {
    io.say(existsSync(expand(c.file)) ? `ok   credential ${c.file}` : `CREDENTIAL_MISSING ${c.file} -> ${c.how}`)
  }

  const data = await planData(m, o, io, env)
  for (const d of data) {
    if (d.action === 'copy' && !existsSync(d.from!)) return fail(`--data ${d.file}: ${d.from} not found`)
    io.say(`data        ${d.file}: ${d.action === 'keep' ? 'exists, kept' : d.action === 'copy' ? `copy from ${d.from}` : d.action === 'write' ? `${Object.keys(d.rows!).length} rows entered` : `missing -> example copied from ${d.from} (edit it before going live)`}`)
  }
  const lanes = [...new Set(data.flatMap((d) => Object.values(d.rows ?? {}).map((r: any) => r.lane).filter(Boolean)))] as string[]
  const bots = await askBots(m, raw, o, io, lanes)

  const agents = o.agents ?? prev?.agents ?? agentsOf(m)
  const entry: SourceEntry = { name: m.name, agents, ...(Object.keys(settings).length ? { settings } : {}) }
  const next = { ...raw, sources: [...sources.filter((s) => s.name !== m.name), entry], ...(bots.length ? { bots } : {}) }
  const { errors: cerr, warnings } = validate(next, env.sourcesRoot)
  for (const w of warnings) io.say(`CONFIG_WARN ${w}`)
  if (cerr.length) { for (const e of cerr) io.say(`CONFIG_ERROR ${e}`); return fail('config check') }
  io.say(`config      ${env.configPath}: sources[] ${prev ? 'entry replaced' : 'entry added'}${bots.length ? `, bots[] += ${bots.map((b) => b.name).join(', ')}` : ''}`)
  io.say(`entry       ${JSON.stringify(entry)}`)

  const outDir = o.dryRun ? mkdtempSync(join(tmpdir(), `omodori-${m.name}-plists-`)) : env.launchAgentsDir
  const jobs = sourceJobs(m, agents).map((j) => ({ ...j, dir: join(env.installHome, 'sources', m.name) }))
  const r = renderJobs(jobs, outDir, { bun: env.bun, config: env.configPath })
  for (const l of r.lines) io.say(l)
  if (r.bad) return fail('render')
  const plists = r.lines.map((l) => l.split(' ')).map(([, lbl, file, logs]) => ({ label: lbl!, file: file!, logs: logs! }))
  for (const p of plists) {
    const lint = await env.run(['plutil', '-lint', '-s', p.file])
    if (lint.code !== 0) return fail(`plist lint ${p.file}: ${lint.out}`)
  }
  const health = (m.healthCheck ?? []).map((a) => a.replaceAll('{bun}', env.bun).replaceAll('{dir}', join(env.installHome, 'sources', m.name)))

  if (o.dryRun) {
    for (const d of data) if (d.action !== 'keep') io.say(`  would write: ${d.target}`)
    io.say(`  would write: ${env.configPath}`)
    for (const p of plists) io.say(`  would run: launchctl bootstrap gui/${UID} ${join(env.launchAgentsDir, `${p.label}.plist`)}`)
    if (health.length) io.say(`  would run: ${health.join(' ')}`)
    io.say(`plists      rendered to ${outDir} (not installed)`)
    io.say('ONBOARD_DRY_RUN_OK')
    return 0
  }

  for (const d of data) {
    if (d.action === 'keep') continue
    mkdirSync(dirname(d.target), { recursive: true })
    if (d.action === 'write') writeFileSync(d.target, `${JSON.stringify(d.rows, null, 2)}\n`)
    else copyFileSync(d.from!, d.target)
  }
  writeConfig(env, next, io)
  for (const p of plists) {
    mkdirSync(p.logs, { recursive: true })
    if (!o.load) continue
    await env.run(['launchctl', 'bootout', `gui/${UID}/${p.label}`])
    const b = await env.run(['launchctl', 'bootstrap', `gui/${UID}`, p.file])
    if (b.code !== 0) return fail(`launchctl bootstrap ${p.label}: ${b.out}`)
    io.say(`loaded      ${p.label}`)
  }
  if (health.length) {
    const h = await env.run(health, { DORI_PORTABLE_CONFIG: env.configPath, OMODORI_HOME: env.dataHome })
    io.say(`health      ${h.code === 0 ? 'ok' : `exit ${h.code}`}${h.out ? `: ${h.out.split('\n').slice(-3).join(' / ')}` : ''}`)
    if (h.code !== 0) { io.say('ONBOARD_HEALTH_FAILED'); return 3 }
  }
  io.say('ONBOARD_OK')
  return 0
}

export async function offboard(o: Opts, io: Io, env: Env): Promise<number> {
  const fail = (why: string) => { io.say(`OFFBOARD_FAILED ${why}`); return 1 }
  if (!o.source) return fail('usage: omodori offboard <source> [--dry-run]')
  const raw = readRaw(env.configPath)
  const sources: SourceEntry[] = Array.isArray(raw.sources) ? raw.sources : []
  const prev = sources.find((s) => s.name === o.source)
  if (!prev) return fail(`${o.source} is not connected (config.json sources[] has no entry)`)
  const m = manifestOf(o.source, env.sourcesRoot)
  const labels = (m ? agentsOf(m, prev) : prev.agents ?? []).map((a) => label(a))
  const next = { ...raw, sources: sources.filter((s) => s.name !== o.source) }
  io.say(`source      ${o.source}`)
  io.say(`mode        ${o.dryRun ? 'dry-run' : 'apply'}`)
  for (const l of labels) {
    const file = join(env.launchAgentsDir, `${l}.plist`)
    if (o.dryRun) { io.say(`  would run: launchctl bootout gui/${UID}/${l}`); io.say(`  would delete: ${file}`); continue }
    await env.run(['launchctl', 'bootout', `gui/${UID}/${l}`])
    rmSync(file, { force: true })
    io.say(`unloaded    ${l}`)
  }
  for (const d of m?.dataFiles ?? []) io.say(`data        ${join(env.dataHome, d.file)} kept`)
  if (o.dryRun) { io.say(`  would write: ${env.configPath} (sources[] without ${o.source})`); io.say('OFFBOARD_DRY_RUN_OK'); return 0 }
  writeConfig(env, next, io)
  io.say('OFFBOARD_OK')
  return 0
}

export function parseArgs(argv: string[]): Opts {
  const o: Opts = { dryRun: false, set: {}, bots: [], data: {}, load: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v }
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--no-load') o.load = false
    else if (a === '--set') { const [k, ...v] = val().split('='); o.set[k!] = v.join('=') }
    else if (a === '--data') { const [k, ...v] = val().split('='); o.data[k!] = v.join('=') }
    else if (a === '--bot') o.bots.push(val())
    else if (a === '--agents') o.agents = val().split(',').map((x) => x.trim()).filter(Boolean)
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else if (!o.source) o.source = a
    else throw new Error(`unexpected argument ${a}`)
  }
  return o
}

export function ttyIo(): Io {
  const tty = !!process.stdin.isTTY
  return {
    tty,
    say: (l) => console.log(l),
    ask: async (q, def) => { const a = prompt(`${q}${def ? ` [${def}]` : ''}:`) ?? ''; return a.trim() === '' ? def ?? '' : a.trim() },
  }
}
