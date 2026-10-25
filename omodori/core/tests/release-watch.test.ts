import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditCommand, cycle, eventLines, installedVersion, loadState, parseAudit, reposFromChannels, saveState } from '../release-watch'

const tmp = () => mkdtempSync(join(tmpdir(), 'relwatch-'))

const npmV2 = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: { a: { severity: 'critical' }, b: { severity: 'high' }, c: { severity: 'low' } },
  metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 1, critical: 1 } },
})

test('installed version comes from the global package.json, unknown on garbage', () => {
  expect(installedVersion('{"name":"omo-ai","version":"5.1.40"}')).toBe('5.1.40')
  expect(installedVersion('not json')).toBe('unknown')
})

test('audit parsing handles npm v2 metadata, npm v1 advisories and pnpm metadata', () => {
  expect(parseAudit(npmV2)).toEqual({ high: 1, critical: 1 })
  const v1 = JSON.stringify({ advisories: { 1: { severity: 'high' }, 2: { severity: 'critical' }, 3: { severity: 'moderate' } } })
  expect(parseAudit(v1)).toEqual({ high: 1, critical: 1 })
  const pnpm = JSON.stringify({ advisories: { 1: { severity: 'high' } }, metadata: { vulnerabilities: { high: 114, critical: 11 } } })
  expect(parseAudit(pnpm)).toEqual({ high: 114, critical: 11 })
  expect(parseAudit('<html>blocked</html>')).toHaveProperty('error')
})

test('lockfile detection picks the matching audit tool and skips a bare yarn.lock', () => {
  const dir = tmp()
  expect(auditCommand(dir)).toBeNull()
  writeFileSync(join(dir, 'yarn.lock'), '')
  expect(auditCommand(dir)).toBeNull()
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
  expect(auditCommand(dir)?.cmd).toEqual(['pnpm', 'audit', '--json'])
  mkdirSync(join(dir, 'x'))
  const d2 = tmp()
  writeFileSync(join(d2, 'package-lock.json'), '{}')
  expect(auditCommand(d2)?.cmd).toEqual(['npm', 'audit', '--json'])
})

test('channels.json projects select the repo list', () => {
  const text = JSON.stringify({ projects: { a: { key: 'app', path: '/p/app' }, b: { key: 'nopath' } } })
  expect(reposFromChannels(text)).toEqual([{ key: 'app', path: '/p/app' }])
})

const snap = (over: Partial<{ installed: string; latest: string; repos: any[] }> = {}) => ({
  at: '2026-10-23T00:00:00.000Z',
  installed: '5.1.40',
  latest: '5.1.44',
  repos: [{ key: 'app-a', path: '/p/a', high: 2, critical: 1 }, { key: 'work', path: '/p/b', high: 114, critical: 11 }],
  ...over,
})

test('first pass prints one line with totals and per-repo counts', () => {
  const ls = eventLines(null, snap())
  expect(ls).toEqual(['RELEASE_WATCH omo=5.1.40->5.1.44 high=116 critical=12 repos=app-a(h2/c1),work(h114/c11)'])
})

test('a second identical pass prints nothing', () => {
  const dir = tmp()
  const file = join(dir, 'state.json')
  saveState(file, snap())
  expect(eventLines(loadState(file), snap())).toEqual([])
})

test('a new release or a new high finding re-prints; errored repos are excluded from totals', () => {
  const dir = tmp()
  const file = join(dir, 'state.json')
  saveState(file, snap())
  expect(eventLines(loadState(file), snap({ installed: '5.1.44' }))[0]).toStartWith('RELEASE_WATCH omo=5.1.44->5.1.44')

  saveState(file, snap())
  const worse = snap({ repos: [{ key: 'app-a', path: '/p/a', high: 3, critical: 1, error: undefined }, { key: 'work', path: '/p/b', high: 0, critical: 0, error: 'path missing' }] })
  const ls = eventLines(loadState(file), worse)
  expect(ls[0]).toBe('RELEASE_WATCH omo=5.1.40->5.1.44 high=3 critical=1 repos=app-a(h3/c1)')
  expect(ls[1]).toStartWith('RELEASE_WATCH_ERROR repo=work path missing')
})

test('repos without an auditable lockfile are skipped: no total, no error line', () => {
  const repos = [
    { key: 'app-a', path: '/p/a', high: 1, critical: 0 },
    { key: 'app', path: '/p/s', high: 0, critical: 0, skip: true },
  ]
  const ls = eventLines(null, snap({ repos }))
  expect(ls).toEqual(['RELEASE_WATCH omo=5.1.40->5.1.44 high=1 critical=0 repos=app-a(h1/c0)'])
})

test('saved state survives a reload with the same counts', () => {
  const file = join(tmp(), 'state.json')
  saveState(file, snap())
  const st = loadState(file)!
  expect(st.omo).toEqual({ installed: '5.1.40', latest: '5.1.44' })
  expect(st.repos['work']).toEqual({ high: 114, critical: 11 })
  expect(JSON.parse(readFileSync(file, 'utf8')).at).toBe('2026-10-23T00:00:00.000Z')
})

test('cycle prints nothing on an unchanged replay of the same fixtures', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'omo.json'), '{"version":"5.1.40"}')
  writeFileSync(join(dir, 'channels.json'), JSON.stringify({ projects: { a: { key: 'app', path: '/p/app' } } }))
  const audit = async (r: { key: string; path: string }) => ({ ...r, high: 1, critical: 0 })
  const opts = {
    stateFile: join(dir, 'state.json'),
    channelsFile: join(dir, 'channels.json'),
    omoPkg: join(dir, 'omo.json'),
    audit,
    latest: async () => '5.1.44',
  }
  expect(await cycle(opts)).toEqual(['RELEASE_WATCH omo=5.1.40->5.1.44 high=1 critical=0 repos=app(h1/c0)'])
  expect(await cycle(opts)).toEqual([])
  opts.latest = async () => '5.1.45'
  expect(await cycle(opts)).toEqual(['RELEASE_WATCH omo=5.1.40->5.1.45 high=1 critical=0 repos=app(h1/c0)'])
})
