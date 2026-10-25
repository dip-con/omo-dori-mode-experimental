// Discord source module (the core/sources.ts contract). The gateway listener (listener.ts) runs as a lead monitor
// (core/monitors.json) and writes the owner's messages to the inbox; this module is how core talks to Discord.
//   inbound   a gateway MESSAGE_CREATE payload -> InboundEvent (bot messages are not inbound)
//   send      a channel/thread post through the bot (core/dori-lib.ts post)
//   bun sources/discord/source.ts --health   exit 0 when the bot credential for discord.botName is present
import { existsSync, readFileSync } from 'node:fs'
import { cfg } from '../../core/config'
import { post } from '../../core/dori-lib'
import type { InboundEvent, SendResult } from '../../core/sources'

type Gateway = { id: string; channel_id: string; content?: string; timestamp?: string; author: { id: string; bot?: boolean } }

export function inbound(raw: unknown): InboundEvent | null {
  const m = raw as Gateway
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.channel_id !== 'string' || !m.author || m.author.bot) return null
  return { source: 'discord', room: m.channel_id, id: m.id, sender: m.author.id, text: m.content ?? '', at: m.timestamp ?? new Date().toISOString(), isOwner: m.author.id === cfg.discord.ownerId }
}

export async function send(target: string, text: string): Promise<SendResult> {
  try { const ids = await post(target, text); return { ok: true, id: ids[0] ?? null } } catch (e) { return { ok: false, error: (e as Error).message } }
}

if (import.meta.main && process.argv.includes('--health')) {
  const f = `${process.env.HOME}/.config/agent-messenger/discordbot-credentials.json`
  const token = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).bots?.[cfg.discord.botName]?.token : null
  console.log(token ? `discord bot "${cfg.discord.botName}" credential ok` : `no token for bot "${cfg.discord.botName}" in ${f}`)
  process.exit(token ? 0 : 1)
}
