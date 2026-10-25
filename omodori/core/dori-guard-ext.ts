// OMO extension body for dori-guard (loaded by ~/.omo/agent/extensions/dori-guard.ts).
// Fails open: a guard error must never stop a session's tools.
import { checkCommand, liveEnv, logBlock } from './dori-guard'

export default function doriGuard(pi: any) {
  pi.on('tool_call', (event: any) => {
    try {
      if (event?.toolName !== 'bash') return undefined
      const cmd = String(event.input?.command ?? '')
      const v = checkCommand(cmd, () => liveEnv(process.pid))
      if (!v) return undefined
      logBlock(v, cmd, `ext pane=${process.env.HERDR_PANE_ID ?? '-'}`)
      return { block: true, reason: v.reason }
    } catch {
      return undefined
    }
  })
}
