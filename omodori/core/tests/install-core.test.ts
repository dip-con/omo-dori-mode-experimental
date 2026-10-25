// install.sh installs the core only: in a clean HOME (no config, no source connected) the dry run passes, renders only
// core LaunchAgents, writes nothing; and core code never names a messenger source (each one is reached through
// config.json sources[] and its manifest.json; core docs and examples included). Discord is the exception: it is also the lead's ops channel (config.json
// discord.*), which core posts to directly.
import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const OMODORI = join(import.meta.dir, '..', '..')
const OPS_CHANNEL = 'discord'

function cleanEnv() {
  const t = mkdtempSync(join(tmpdir(), 'install-core-'))
  const bin = join(t, 'bin'), home = join(t, 'home')
  mkdirSync(bin); mkdirSync(home)
  for (const b of ['jq', 'plutil']) symlinkSync(Bun.which(b)!, join(bin, b))
  symlinkSync(process.execPath, join(bin, 'bun'))
  for (const b of ['omo', 'herdr', 'sqlite3', 'launchctl']) { writeFileSync(join(bin, b), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, b), 0o755) }
  return { t, home, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: t } }
}

test('install.sh --dry-run in a clean HOME: core only, INSTALL_DRY_RUN_OK, nothing written', () => {
  const { home, env } = cleanEnv()
  const p = Bun.spawnSync(['bash', join(OMODORI, 'install.sh'), '--dry-run'], { env, stdout: 'pipe', stderr: 'pipe' })
  const out = p.stdout.toString()
  expect(p.exitCode).toBe(0)
  expect(out.trim().split('\n').pop()).toBe('INSTALL_DRY_RUN_OK')
  const labels = out.split('\n').filter((l) => l.startsWith('RENDERED ')).map((l) => l.split(' ')[1])
  expect(labels).toEqual(['supervisor', 'heartbeat', 'decisions', 'ceo-weekly', 'repo-patrol'].map((n) => `com.example.dori.${n}`))
  expect(out).toContain('omodori onboard')
  for (const n of readdirSync(join(OMODORI, 'sources')).filter((x) => x !== OPS_CHANNEL)) expect(out.toLowerCase()).not.toContain(n)
  expect(walk(home).map((f) => relative(home, f)).filter((f) => !f.startsWith('Library/Caches/bun/'))).toEqual([])
  const dir = /plists +rendered to (\S+)/.exec(out)![1]!
  const plist = readFileSync(join(dir, 'com.example.dori.supervisor.plist'), 'utf8')
  expect(plist).toContain(`<key>WorkingDirectory</key><string>${home}/.omodori/core</string>`)
  expect(plist).toContain('<string>dori-supervisor.ts</string>')
})

test('the core alone passes its config check (sources: [])', () => {
  const { env } = cleanEnv()
  const p = Bun.spawnSync([process.execPath, join(OMODORI, 'core', 'config.ts'), '--check'], { env: { ...env, DORI_PORTABLE_CONFIG: join(OMODORI, 'examples', 'config.example.json') }, stdout: 'pipe' })
  expect(p.exitCode).toBe(0)
  expect(p.stdout.toString()).toContain('CONFIG_OK')
  expect(JSON.parse(readFileSync(join(OMODORI, 'examples', 'config.example.json'), 'utf8')).sources).toEqual([])
})

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : [p] })
const CORE_CODE = [
  ...walk(join(OMODORI, 'core')), ...walk(join(OMODORI, 'examples')), ...walk(join(OMODORI, 'omo-extensions')),
  ...['install.sh', 'package.json', 'bunfig.toml', 'tsconfig.json', '.gitignore', '.env.example'].map((f) => join(OMODORI, f)),
].filter((f) => existsSync(f))

test('core names no messenger source: every source folder name except the ops channel appears 0 times in core/, examples/ and the root files (code and docs, any case)', () => {
  const names = readdirSync(join(OMODORI, 'sources')).filter((n) => n !== OPS_CHANNEL && existsSync(join(OMODORI, 'sources', n, 'manifest.json')))
  expect(names.length).toBeGreaterThan(0)
  const re = new RegExp(names.join('|'), 'i')
  const hits = CORE_CODE.flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((l, i) => (re.test(l) ? [`${relative(OMODORI, f)}:${i + 1}`] : [])))
  expect(hits).toEqual([])
  expect(CORE_CODE.length).toBeGreaterThan(60)
})
