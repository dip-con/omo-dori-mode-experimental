// Move a lane to a fresh session on another Claude account (or GPT Astra high when all three are full) (dori-improve 2).
//   bun lane-migrate.ts <key> --to <default|alt|work> [--live] [--force]
//   bun lane-migrate.ts <key> --model chatgpt-subscription/gpt-6-astra --thinking high [--live] [--force]
// Thin wrapper over the lane transition (redesign S8, final.md §2.8): the lane keeps its key and gets a fresh session with
// a handoff artifact; kakao lanes work too (their profile carries extensions/tools). Without --live it prints the plan
// (--dry, nothing changes). Log: ~/.omocat/lane-migrations.jsonl. Last line: MIGRATE_DONE | MIGRATE_DRY_RUN | MIGRATE_REFUSED.
const argv = process.argv.slice(2)
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const key = argv[0]
const to = opt('--to'), model = opt('--model'), thinking = opt('--thinking')
const live = argv.includes('--live')
if (!key || key.startsWith('--') || (!to && !model)) {
  console.log(`MIGRATE_REFUSED ${key ?? '-'}: usage: lane-migrate.ts <key> (--to <account> | --model M [--thinking T]) [--live] [--force]`)
  process.exit(2)
}
const args = [key, '--fresh', '--reason', 'quota', ...(to ? ['--account', to] : ['--model', model!, ...(thinking ? ['--thinking', thinking] : [])]),
  ...(live ? [] : ['--dry']), ...(argv.includes('--force') ? ['--force'] : [])]
const p = Bun.spawn(['bun', `${import.meta.dir}/lane-transition.ts`, ...args], { stdout: 'pipe', stderr: 'inherit' })
const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
const last = out.trim().split('\n').pop() ?? ''
console.log(last)
let r: any = {}
try { r = JSON.parse(last) } catch { r = { error: last || 'no output' } }
const target = to ? `Claude account ${to}` : `${model} (${thinking ?? 'high'})`
if (code === 0 && r.dry) console.log(`MIGRATE_DRY_RUN ${key} -> ${target}: nothing changed; rerun with --live to apply`)
else if (code === 0) console.log(`MIGRATE_DONE ${key} -> ${target} generation=${r.generation} op=${r.opId}`)
else console.log(`MIGRATE_REFUSED ${key}: ${r.error ?? 'failed'}${r.opId ? ` op=${r.opId}` : ''} (exit ${code})`)
process.exit(code)
