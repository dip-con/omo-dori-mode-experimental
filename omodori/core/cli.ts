#!/usr/bin/env bun
// The omodori command (install.sh links it into ~/.local/bin).
//   omodori sources                      every messenger source folder, on/off in config.json
//   omodori onboard [<source>] [...]     connect a source (see core/onboard.ts for the options)
//   omodori offboard <source> [--dry-run]
//   omodori check                        config check: core + every connected source
import { availableSources, entryOf } from './sources'
import { liveEnv, offboard, onboard, parseArgs, ttyIo } from './onboard'

const [cmd, ...rest] = process.argv.slice(2)
switch (cmd) {
  case 'sources':
    for (const m of availableSources()) console.log(`${entryOf(m.name) ? 'on ' : 'off'} ${m.name}${m.description ? `  ${m.description}` : ''}`)
    break
  case 'onboard':
  case 'offboard': {
    let o
    try { o = parseArgs(rest) } catch (e) { console.log(`${cmd.toUpperCase()}_FAILED ${(e as Error).message}`); process.exit(2) }
    process.exitCode = await (cmd === 'onboard' ? onboard : offboard)(o, ttyIo(), liveEnv())
    break
  }
  case 'check': {
    const p = Bun.spawn([process.execPath, `${import.meta.dir}/config.ts`, '--check'], { stdout: 'inherit', stderr: 'inherit' })
    process.exitCode = await p.exited
    break
  }
  default:
    console.error('usage: omodori sources | onboard [<source>] [--dry-run] [--set k=v]... | offboard <source> [--dry-run] | check')
    process.exit(2)
}
