// Renders LaunchAgent plists: the core services config.json launchd.services lists (services.json), and the agents of
// each enabled messenger source (sources/<name>/manifest.json launchAgents, picked by sources[].agents).
//   bun core/launchagents/render.ts --out <dir> [--bun <path>] [--config <config.json the services read>]
//                                   [--only core | --source <name>]
// writes <label>.plist files and prints one "RENDERED <label> <file>" per plist (--only core: core services only,
// --source <name>: that source's agents only, even before config.json lists it).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cfg, label, doriHome, logDir, installHome } from '../config'
import { agentsOf, entryOf, enabledSources, manifestOf, type Manifest, type Service } from '../sources'

export type { Service }

const HOME = process.env.HOME!
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const str = (s: string) => `<string>${esc(s)}</string>`

// o.home = data folder (OMODORI_HOME), o.dir = the folder holding the script (core/ or sources/<name>/, also the working
// directory), o.logs = that module's log folder ({logdir}/core or {logdir}/<source>), o.config = config.json.
export function renderPlist(name: string, s: Service, o: { bun: string; home: string; path: string; dir: string; logs: string; config?: string }): string {
  const sub = (v: string) => v.replaceAll('{bun}', o.bun).replaceAll('{home}', o.home).replaceAll('{logs}', o.logs).replaceAll('{logdir}', logDir()).replaceAll('{dir}', o.dir).replace(/^~(?=\/)/, HOME)
  const env = { PATH: o.path, HOME, OMODORI_HOME: o.home, ...(o.config ? { DORI_PORTABLE_CONFIG: o.config } : {}), ...(s.env ?? {}) }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${str(label(name))}`,
    `  <key>ProgramArguments</key><array>${s.args.map((a) => str(sub(a))).join('')}</array>`,
    `  <key>WorkingDirectory</key>${str(o.dir)}`,
    `  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${esc(k)}</key>${str(v)}`).join('')}</dict>`,
    '  <key>RunAtLoad</key><true/>',
    s.keepAlive ? '  <key>KeepAlive</key><true/>' : '',
    s.throttle ? `  <key>ThrottleInterval</key><integer>${s.throttle}</integer>` : '',
    s.interval ? `  <key>StartInterval</key><integer>${s.interval}</integer>` : '',
    s.calendar ? `  <key>StartCalendarInterval</key><dict>${Object.entries(s.calendar).map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`).join('')}</dict>` : '',
    `  <key>StandardOutPath</key>${str(sub(s.out))}`,
    `  <key>StandardErrorPath</key>${str(sub(s.err ?? s.out))}`,
    '</dict>',
    '</plist>',
    '',
  ]
  return lines.filter((l) => l !== '').join('\n') + '\n'
}

export type Job = { name: string; service: Service | undefined; dir: string; logs: string; module: string }
export const coreServices = (): Record<string, Service> => JSON.parse(readFileSync(join(import.meta.dir, 'services.json'), 'utf8'))
/** The installed folders: plists point at OMODORI_HOME/core and OMODORI_HOME/sources/<name>, not at this checkout. */
export function coreJobs(names = cfg.launchd.services): Job[] {
  const s = coreServices()
  return names.map((name) => ({ name, service: s[name], dir: join(installHome(), 'core'), logs: `${logDir()}/core`, module: 'core' }))
}
export function sourceJobs(m: Manifest, agents = agentsOf(m, entryOf(m.name))): Job[] {
  return agents.map((name) => ({ name, service: m.launchAgents?.[name], dir: join(installHome(), 'sources', m.name), logs: `${logDir()}/${m.name}`, module: m.name }))
}

export function renderJobs(jobs: Job[], out: string, o: { bun: string; config?: string }): { lines: string[]; bad: number } {
  const path = [`${HOME}/.local/bin`, `${HOME}/.bun/bin`, join(o.bun, '..'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter((p, i, a) => a.indexOf(p) === i).join(':')
  mkdirSync(out, { recursive: true })
  const lines: string[] = []
  let bad = 0
  for (const j of jobs) {
    if (!j.service) { lines.push(`UNKNOWN_SERVICE ${j.module}/${j.name}`); bad++; continue }
    const file = join(out, `${label(j.name)}.plist`)
    writeFileSync(file, renderPlist(j.name, j.service, { bun: o.bun, home: doriHome(), path, dir: j.dir, logs: j.logs, config: o.config }))
    lines.push(`RENDERED ${label(j.name)} ${file} ${j.logs}`)
  }
  return { lines, bad }
}

if (import.meta.main) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined }
  const out = arg('--out')
  if (!out) { console.error('usage: render.ts --out <dir> [--bun <path>] [--config <file>] [--only core | --source <name>]'); process.exit(2) }
  const only = arg('--only'), src = arg('--source')
  let jobs: Job[]
  if (src) {
    const m = manifestOf(src)
    if (!m) { console.log(`UNKNOWN_SOURCE ${src}`); process.exit(1) }
    jobs = sourceJobs(m)
  } else jobs = [...coreJobs(), ...(only === 'core' ? [] : enabledSources().flatMap((m) => sourceJobs(m)))]
  const r = renderJobs(jobs, out, { bun: arg('--bun') ?? process.execPath, config: arg('--config') })
  for (const l of r.lines) console.log(l)
  process.exit(r.bad ? 1 : 0)
}
