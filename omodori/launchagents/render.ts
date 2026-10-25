// Renders the LaunchAgent plists listed in config.json launchd.services from services.json.
//   bun launchagents/render.ts --out <dir> [--bun <path>] [--config <config.json the services read>]   writes <label>.plist files, prints one "RENDERED <label> <file>" per plist
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cfg, label, doriHome, kakaoLogs, logDir, installHome } from '../config'

type Service = { args: string[]; keepAlive?: boolean; throttle?: number; interval?: number; calendar?: Record<string, number>; env?: Record<string, string>; out: string; err?: string }

const HOME = process.env.HOME!
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const str = (s: string) => `<string>${esc(s)}</string>`

// o.home = data folder (OMODORI_HOME), o.cwd = install folder with the code (defaults to o.home), o.config = config.json.
export function renderPlist(name: string, s: Service, o: { bun: string; home: string; path: string; cwd?: string; config?: string }): string {
  const sub = (v: string) => v.replaceAll('{bun}', o.bun).replaceAll('{home}', o.home).replaceAll('{logs}', kakaoLogs()).replaceAll('{logdir}', logDir()).replace(/^~(?=\/)/, HOME)
  const env = { PATH: o.path, HOME, OMODORI_HOME: o.home, ...(o.config ? { DORI_PORTABLE_CONFIG: o.config } : {}), ...(s.env ?? {}) }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${str(label(name))}`,
    `  <key>ProgramArguments</key><array>${s.args.map((a) => str(sub(a))).join('')}</array>`,
    `  <key>WorkingDirectory</key>${str(o.cwd ?? o.home)}`,
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

if (import.meta.main) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined }
  const out = arg('--out')
  if (!out) { console.error('usage: render.ts --out <dir> [--bun <path>]'); process.exit(2) }
  const services: Record<string, Service> = JSON.parse(readFileSync(join(import.meta.dir, 'services.json'), 'utf8'))
  const bun = arg('--bun') ?? process.execPath
  const path = [`${HOME}/.local/bin`, `${HOME}/.bun/bin`, join(bun, '..'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter((p, i, a) => a.indexOf(p) === i).join(':')
  mkdirSync(out, { recursive: true })
  let bad = 0
  for (const name of cfg.launchd.services) {
    const s = services[name]
    if (!s) { console.log(`UNKNOWN_SERVICE ${name}`); bad++; continue }
    const file = join(out, `${label(name)}.plist`)
    writeFileSync(file, renderPlist(name, s, { bun, home: doriHome(), path, cwd: installHome(), config: arg('--config') }))
    console.log(`RENDERED ${label(name)} ${file}`)
  }
  process.exit(bad ? 1 : 0)
}
