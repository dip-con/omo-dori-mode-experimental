// Only rooms with "gate": true in kakao-rooms.json use this gate. IDs stay strings, including open-chat IDs.
// A line is addressed to the bot when it starts with one of the bot's call words (config.json bots[].calls).
import { callSource, cfg, type Bot } from './config'
export const SECRETARY_ID = cfg.kakao.botUserId
const FOLLOWUP_MS = 5 * 60_000
const addressOf = (bot: Bot) => { const s = callSource(bot); return s ? new RegExp(`^\\s*@?(?:${s})(?:님|야|아|씨)?(?=$|[\\s,!?~.:])`) : null }
type Addressing = {
  readonly mentioned_user_ids?: readonly string[]
  readonly reply_to_user_id?: string
  readonly reply_to_log_id?: string
  readonly reply_to_text?: string
}
export function addressingFields(
  attachment: Record<string, unknown> | null | undefined,
  idOf: (value: unknown) => string,
): Addressing {
  const mentions = Array.isArray(attachment?.mentions) ? attachment.mentions : []
  const ids: string[] = []
  for (const entry of mentions) {
    if (entry && typeof entry === 'object' && 'user_id' in entry) ids.push(idOf(entry.user_id))
  }
  return {
    ...(ids.length ? { mentioned_user_ids: ids } : {}),
    ...(attachment?.src_userId != null ? { reply_to_user_id: idOf(attachment.src_userId) } : {}),
    ...(attachment?.src_logId != null ? { reply_to_log_id: idOf(attachment.src_logId) } : {}),
    ...(typeof attachment?.src_message === 'string' && attachment.src_message ? { reply_to_text: attachment.src_message } : {}),
  }
}

export function createSecretaryGate(bot: Bot) {
  const ADDRESS = addressOf(bot)
  const engaged = new Map<string, number>()
  return (message: Addressing & {
    readonly chat: string; readonly sender: string; readonly text: string; readonly at: number
  }): 'called' | 'continued' | null => {
    const key = `${message.chat}:${message.sender}`
    if (ADDRESS?.test(message.text) || message.mentioned_user_ids?.includes(SECRETARY_ID)
      || message.reply_to_user_id === SECRETARY_ID) {
      engaged.set(key, message.at)
      return 'called'
    }
    // Explicitly addressing someone else ends this sender's follow-up window.
    if (message.mentioned_user_ids?.length || message.reply_to_user_id || /^\s*@\S/.test(message.text)) {
      engaged.delete(key)
      return null
    }
    const since = engaged.get(key)
    if (since !== undefined && message.at >= since && message.at - since <= FOLLOWUP_MS) {
      // A candidate, not a mandate to answer. Do not extend the window on ordinary chat.
      return 'continued'
    }
    engaged.delete(key)
    return null
  }
}
