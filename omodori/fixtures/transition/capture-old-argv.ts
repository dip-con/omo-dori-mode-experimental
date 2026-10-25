// Captures the omo argv the pre-S8 restart scripts produced, by running each backup (<script>.bak-20261023-S8) with fake
// bun/herdr/python3/perl/find/sleep on PATH. Nothing real runs: the fake bun records env + args of every sess.ts call.
//   bun fixtures/transition/capture-old-argv.ts      writes fixtures/transition/old-argv.json
// The argv is what sess.ts startOmo typed: OMOMEOW_LANE_KEY=<key> omo --model M --thinking T --session-id <SID> ${OMOMEOW_OMO_ARGS}
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.HOME!
const OMOCAT = join(import.meta.dir, '..', '..')
const SCRIPTS: Record<string, string> = {
  'jangdori-restart.sh': 'kakao-family', 'friend-restart.sh': 'kakao-friend',
  'acme-docs-restart.sh': 'kakao-acme-docs', 'dandori-docs-restart.sh': 'kakao-dandori-docs',
}
const out: Record<string, { script: string; argv: string[]; env: Record<string, string>; sessCalls: string[][] }> = {}
for (const [script, key] of Object.entries(SCRIPTS)) {
  const dir = mkdtempSync(join(tmpdir(), 's8-capture-'))
  const bin = join(dir, 'bin'); Bun.spawnSync(['mkdir', '-p', bin])
  const cap = join(dir, 'cap.ndjson')
  const fake = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755) }
  fake('bun', `{ printf '%s\\0' "$@"; printf '\\n--ENV--\\n'; env | grep '^OMOMEOW_' ; printf '\\n--END--\\n'; } >> "${cap}"`)
  fake('herdr', `echo '{"result":{"agents":[]}}'`)
  fake('python3', 'exit 0')
  fake('perl', 'exit 0')
  fake('find', 'exit 0')
  fake('sleep', 'exit 0')
  const src = readFileSync(join(OMOCAT, `${script}.bak-20261023-S8`), 'utf8').replace(/^export PATH=(.*)$/m, `export PATH=${bin}:$1`)
  const sh = join(dir, script); writeFileSync(sh, src)
  const p = Bun.spawnSync(['/bin/bash', sh], { env: { HOME, PATH: `${bin}:/usr/bin:/bin` }, stdout: 'pipe', stderr: 'pipe' })
  const raw = readFileSync(cap, 'utf8')
  const calls = raw.split('--END--\n').filter((c) => c.trim()).map((c) => {
    const [a, e] = c.split('\n--ENV--\n')
    return { args: a!.replace(/^\n/, '').split('\0').filter((x) => x !== '' && x !== '\n'), env: Object.fromEntries((e ?? '').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) }
  })
  const start = calls.find((c) => c.args[0] === 'sess.ts' && (c.args[1] === 'reopen' || c.args[1] === 'open'))
  if (!start) throw new Error(`${script}: no sess.ts reopen/open captured (exit ${p.exitCode}): ${p.stderr}`)
  const env = start.env
  const model = env.OMOMEOW_MODEL ?? 'anthropic-subscription/claude-opus-5-5'
  const thinking = env.OMOMEOW_THINKING ?? 'medium'
  const argv = [`OMOMEOW_LANE_KEY=${key}`, 'omo', '--model', model, '--thinking', thinking, '--session-id', '<SID>', ...(env.OMOMEOW_OMO_ARGS ? env.OMOMEOW_OMO_ARGS.split(' ').filter(Boolean) : [])]
  out[key] = { script, argv, env: Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'OMOMEOW_OMO_ARGS')), sessCalls: calls.map((c) => c.args.slice(0, 3).map((x) => (x.length > 60 ? `${x.slice(0, 20)}…(${x.length} chars)` : x))) }
}
writeFileSync(join(import.meta.dir, 'old-argv.json'), JSON.stringify(out, null, 1) + '\n')
console.log(JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.argv.join(' ')])), null, 1))
