// dori hooks -> Discord (threadReply / threadDone). Thread refs look like "discord:<thread id>".
// Text always travels as one argv element; no shell.
import { existsSync, readFileSync } from 'node:fs'
import { doriHome } from './config'
const [cmd, thread = '', text = '', key = ''] = process.argv.slice(2)
const id = thread.replace(/^discord:/, '')
if (!/^\d{15,25}$/.test(id)) { console.log(`skip: no discord thread (${thread})`); process.exit(0) }
const run = async (args: string[]) => {
  const p = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code !== 0) throw new Error(`${args[0]} ${args[1]} failed: ${(err || out).trim().slice(0, 200)}`)
  return out.trim()
}
// Guard first: a non-thread id must never get a message or a PATCH (oc.ts exits 4 and logs 'refused before PATCH').
{
  const g = Bun.spawn(['bun', `${import.meta.dir}/oc.ts`, 'check-thread', id], { stdout: 'pipe', stderr: 'inherit' })
  const [gout, gcode] = await Promise.all([new Response(g.stdout).text(), g.exited])
  if (gcode !== 0) { console.log(gout.trim()); process.exit(gcode === 4 ? 4 : 1) }
}
const lanePath = `${process.env.HOME}/.dori/state/lanes/${key}.json`
const title = key && existsSync(lanePath) ? (JSON.parse(readFileSync(lanePath, 'utf8')).title as string) : key || 'work'
if (cmd === 'reply') {
  await run(['agent-discordbot', 'message', 'send', id, text])
} else if (cmd === 'done') {
  await run(['agent-discordbot', 'message', 'send', id, `done: ${title}${text ? `\n${text}` : ''}`])
  await run(['bun', `${import.meta.dir}/oc.ts`, 'close-thread', id, `[done] ${title}`.slice(0, 100)])
} else { console.error('usage: dori-hook.ts reply|done <thread> <text> [key]'); process.exit(2) }
console.log(`ok ${cmd} ${id}`)
