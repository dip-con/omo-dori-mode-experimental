// startOmo readiness against a fake `herdr` (child process with PATH pointing at it, so the real herdr is never
// called): a ready-looking screen is not enough without a live session holder for that exact session id
// (synthesis #6: a hung cold start shows UI but never holds the session).
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionDirSlug } from './questions'

const dir = mkdtempSync(join(tmpdir(), 'sess-startup-'))
const root = join(dir, 'sessions')
const cwd = join(dir, 'work')
const FIX = join(import.meta.dir, 'tests', 'fixtures')
mkdirSync(join(dir, 'bin'), { recursive: true })
mkdirSync(cwd, { recursive: true })
writeFileSync(join(dir, 'bin', 'herdr'), `#!/bin/sh
case "$1 $2" in
  "pane read") cat "${FIX}/omo-input-ready.txt" ;;
  "pane process-info") printf '{"result":{"process_info":{"foreground_processes":%s}}}' "$(cat "${FIX}/omo-procs.json")" ;;
  "pane run") : ;;
  *) echo "fake herdr: unexpected $*" >&2; exit 1 ;;
esac
`)
chmodSync(join(dir, 'bin', 'herdr'), 0o755)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const holder = (sid: string, pid: number) => {
  const d = join(root, sessionDirSlug(cwd), 'session-holders', sid)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `${pid}.json`), JSON.stringify({ pid }))
}

const start = async (sid: string, timeoutMs: number) => {
  const code = `import { startOmo } from ${JSON.stringify(join(import.meta.dir, 'sess.ts'))}
try { await startOmo('w:p1', ${JSON.stringify(sid)}, 'borrow-test-x', ${JSON.stringify(cwd)}, { timeoutMs: ${timeoutMs}, pollMs: 50, root: ${JSON.stringify(root)} }); console.log('READY') }
catch (e) { console.log('ERR ' + e.message) }`
  const p = Bun.spawn(['bun', '-e', code], { env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe' })
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited])
  return out.trim()
}

test('ready screen + omo process but no session holder: startOmo rejects instead of reporting ready', async () => {
  expect(await start('sid-no-holder', 300)).toMatch(/^ERR .*no live session holder/)
}, 15_000)

test('a stale holder (dead pid) is not evidence', async () => {
  const dead = Bun.spawn(['true']); await dead.exited
  holder('sid-stale', dead.pid)
  expect(await start('sid-stale', 300)).toMatch(/^ERR .*no live session holder/)
}, 15_000)

test('a live holder for the session id: startOmo resolves', async () => {
  holder('sid-live', process.pid)
  expect(await start('sid-live', 3000)).toBe('READY')
}, 15_000)
