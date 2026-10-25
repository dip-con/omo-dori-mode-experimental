import { cfg } from './config'
const creds = JSON.parse(await Bun.file(`${process.env.HOME}/.config/agent-messenger/discordbot-credentials.json`).text())
const H = { Authorization: `Bot ${creds.bots[cfg.discord.botName].token}`, 'Content-Type': 'application/json' }
const [ch, msg, name] = process.argv.slice(2)
const r = await fetch(`https://discord.com/api/v10/channels/${ch}/messages/${msg}/threads`, { method: 'POST', headers: H, body: JSON.stringify({ name, auto_archive_duration: 10080 }) })
const j: any = await r.json(); console.log(r.status, j.id ?? JSON.stringify(j).slice(0,200))