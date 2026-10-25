import { readFileSync } from 'node:fs'
import { doriHome, cfg } from './config'

const creds = JSON.parse(
  readFileSync(`${process.env.HOME}/.config/agent-messenger/discordbot-credentials.json`, 'utf8'),
)
const headers = {
  Authorization: `Bot ${creds.bots[cfg.discord.botName].token}`,
  'Content-Type': 'application/json',
  'User-Agent': 'DiscordBot (omodori, 1.0)',
}
const api = (path: string, body?: unknown) =>
  fetch(`https://discord.com/api/v10${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

// Guard: PATCH only real threads (types 10/11/12). Fail closed when the type cannot be read.
export type ThreadCheck = { ok: true; type: number } | { ok: false; refused: 'not_a_thread'; type: number } | { ok: false; refused: 'channel_type_unknown' }
export const THREAD_TYPES = [10, 11, 12]
export async function checkThread(id: string, doFetch: typeof fetch = fetch): Promise<ThreadCheck> {
  try {
    const res = await doFetch(`https://discord.com/api/v10/channels/${id}`, { headers })
    if (!res.ok) return { ok: false, refused: 'channel_type_unknown' }
    const type = ((await res.json()) as { type?: unknown }).type
    if (typeof type !== 'number') return { ok: false, refused: 'channel_type_unknown' }
    return THREAD_TYPES.includes(type) ? { ok: true, type } : { ok: false, refused: 'not_a_thread', type }
  } catch {
    return { ok: false, refused: 'channel_type_unknown' }
  }
}
const guardThread = async (id: string) => {
  const c = await checkThread(id)
  if (c.ok) return
  const { ok: _ok, ...out } = c
  console.error(`oc.ts: refused before PATCH ${id}: ${c.refused}`)
  console.log(JSON.stringify(out))
  process.exit(4)
}

if (import.meta.main) {
const [cmd, ...args] = process.argv.slice(2)
switch (cmd) {
  case 'check-thread': {
    // check-thread <id>: exit 0 if a thread, 4 (refused) otherwise. No writes.
    await guardThread(args[0])
    console.log(JSON.stringify({ ok: true }))
    break
  }
  case 'create-channel': {
    // create-channel <guild> <name> [topic]
    const res = await api(`/guilds/${args[0]}/channels`, { name: args[1], type: 0, topic: args[2] })
    const j = await res.json()
    console.log(res.status, j.id)
    break
  }
  case 'working': {
    // working <channel> <message>: 👀 on the message. Typing is shown only right before a send (`typing`).
    const [ch, msg] = args
    const res = await fetch(`https://discord.com/api/v10/channels/${ch}/messages/${msg}/reactions/%F0%9F%91%80/@me`, { method: 'PUT', headers })
    console.log('working', res.status)
    break
  }
  case 'close-thread':
  case 'reopen-thread': {
    // close-thread <thread> <name>: rename (e.g. '[done] 작업') and archive. reopen-thread <thread> <name>: unarchive and rename (e.g. '[working] 작업').
    const [thread, name] = args
    await guardThread(thread)
    const archived = cmd === 'close-thread'
    const patch = (body: unknown) => fetch(`https://discord.com/api/v10/channels/${thread}`, { method: 'PATCH', headers, body: JSON.stringify(body) })
    const res = archived ? await patch({ name, archived: true }) : await patch({ archived: false, name })
    const body = (await res.json()) as { name?: string; thread_metadata?: { archived?: boolean }; message?: string }
    console.log(JSON.stringify({ status: res.status, name: body.name, archived: body.thread_metadata?.archived, error: body.message }))
    if (!res.ok) process.exit(1)
    break
  }
  case 'done': {
    // done <channel> <message>: remove the 👀 reaction (and stop any leftover typing loop from older versions).
    const [ch, msg] = args
    const { existsSync, readFileSync, rmSync } = await import('node:fs')
    const pidFile = `${doriHome()}/typing/${ch}.pid`
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8'))) } catch { /* already gone */ }
      rmSync(pidFile, { force: true })
    }
    const res = await fetch(`https://discord.com/api/v10/channels/${ch}/messages/${msg}/reactions/%F0%9F%91%80/@me`, { method: 'DELETE', headers })
    console.log('done', res.status)
    break
  }
  case 'rename': {
    // rename <thread-or-channel> <name>: e.g. mark a work thread's status in its name.
    await guardThread(args[0])
    const res = await fetch(`https://discord.com/api/v10/channels/${args[0]}`, { method: 'PATCH', headers, body: JSON.stringify({ name: args[1] }) })
    console.log(res.status)
    break
  }
  case 'delete-message': {
    // delete-message <channel> <message>
    const res = await fetch(`https://discord.com/api/v10/channels/${args[0]}/messages/${args[1]}`, { method: 'DELETE', headers })
    console.log(res.status)
    break
  }
  case 'delete-channel': {
    const res = await fetch(`https://discord.com/api/v10/channels/${args[0]}`, { method: 'DELETE', headers })
    console.log(res.status)
    break
  }
  case 'typing': {
    const res = await api(`/channels/${args[0]}/typing`)
    console.log(JSON.stringify({ ok: res.ok, status: res.status }))
    break
  }
  case 'thread': {
    const [channelId, messageId, name] = args
    const res = await api(`/channels/${channelId}/messages/${messageId}/threads`, {
      name: name.slice(0, 100),
      auto_archive_duration: 1440,
    })
    const body = (await res.json()) as { id?: string; message?: string }
    console.log(JSON.stringify(res.ok ? { thread_id: body.id } : { error: body.message, status: res.status }))
    if (!res.ok) process.exit(1)
    break
  }
  case 'say': {
    // say <text...>: speak in the voice call via the bridge (voice/bridge.mjs). Prints once playback starts.
    const text = args.join(' ').trim()
    if (!text) {
      console.error('usage: oc.ts say <text...>')
      process.exit(2)
    }
    const res = await fetch(`http://127.0.0.1:${process.env.OMODORI_VOICE_PORT ?? 47820}/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: text,
    })
    console.log(res.status, (await res.text()).trim())
    if (!res.ok) process.exit(1)
    break
  }
  case 'ask': {
    // ask <channel> <question> <option...> [--multi] [--other]: buttons; presses arrive as OMODORI_BUTTON from listener.ts.
    const { Store, discordRest, herdrCli, newAsk, publish } = await import('./buttons')
    const flags = new Set(args.filter((a) => a === '--multi' || a === '--other'))
    const [channel, question, ...labels] = args.filter((a) => a !== '--multi' && a !== '--other')
    if (!channel || !question || labels.length === 0) {
      console.error('usage: oc.ts ask <channel> <question> <option...> [--multi] [--other]')
      process.exit(2)
    }
    const deps = { store: new Store(), discord: discordRest(), herdr: herdrCli, emit: () => {} }
    const ask = newAsk({
      kind: 'ask', channel, other: flags.has('--other'),
      questions: [{ text: question, multiSelect: flags.has('--multi'), options: labels.map((l) => ({ label: l.slice(0, 80), value: l })) }],
    })
    await publish(ask, deps)
    console.log(JSON.stringify({ id: ask.id, channel, messages: ask.messageIds }))
    break
  }
  default:
    console.error('usage: oc.ts ask <channel> <question> <option...> [--multi] [--other] | typing <channel> | thread <channel> <message> <name> | say <text...>')
    process.exit(2)
}
}
