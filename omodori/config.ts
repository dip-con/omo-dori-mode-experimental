// One place for everything that differs between machines. Values come from $OMODORI_HOME/config.json
// (or the file named by DORI_PORTABLE_CONFIG); every field is optional and falls back to the defaults below.
// See examples/config.example.json and docs/PORTING.md.
import { existsSync, readFileSync } from 'node:fs'

// One chat bot. A lane uses the first bot whose lanes list it, else the first bot, else NEUTRAL_BOT. calls are the
// words that count as calling it by name (no default: a bot without calls is only reached by mention, reply or DM).
// about is the one-line description the wake filter's classifier reads. commands: regexes (after an optional call word)
// that always wake. Per-room behaviour (gate, replyRefs, noJev, maskPii, stripSelf) lives in kakao-rooms.json.
export type Bot = { name: string; calls: string[]; about: string; lanes: string[]; commands?: string[] }

export type DoriConfig = {
  owner: { title: string }
  lead: { name: string; keyPrefix: string }
  bots: Bot[]
  voice: { initialPrompt: string }
  discord: {
    botName: string
    guildId: string
    ownerId: string
    generalChannel: string
    inboxChannel: string
    ceoThread: string
    buildThread: string
    wakeStatsThread: string
    relayUrl: string
  }
  kakao: {
    locoPort: number
    healthChatId: string
    ragChatIds: string[]
    archiveRoot: string
    requestsLedger: string
    ownerRoom: string
    botUserId: string
    generatedImagesDir: string
    docOutDir: string
    issueRefRooms: string[]
  }
  launchd: { prefix: string; kakaoArchiveSync: string; services: string[] }
  claudeAccounts: string[]
  paths: { dataDir: string; logDir: string; memoryRepo: string; disks: string[]; genericCwds: string[] }
  git: { name: string; email: string; memoryRemote: string }
}

const HOME = process.env.HOME!
// The install folder (code + config.json). Data lives in paths.dataDir, which defaults to this same folder.
export const installHome = () => process.env.OMODORI_HOME ?? `${process.env.HOME}/.omodori`

export const NEUTRAL_BOT: Bot = { name: 'assistant', calls: [], about: '', lanes: [] }

export const DEFAULTS: DoriConfig = {
  owner: { title: 'owner' },
  lead: { name: 'lead', keyPrefix: 'dori-lead' },
  bots: [],
  voice: { initialPrompt: '' },
  discord: { botName: 'assistant', guildId: '', ownerId: '', generalChannel: '', inboxChannel: '', ceoThread: '', buildThread: '', wakeStatsThread: '', relayUrl: '' },
  kakao: { locoPort: 8397, healthChatId: '', ragChatIds: [], archiveRoot: `${HOME}/KakaoArchive`, requestsLedger: '', ownerRoom: '', botUserId: '', generatedImagesDir: `${HOME}/generated-images/`, docOutDir: '', issueRefRooms: [] },
  launchd: { prefix: 'com.example.dori', kakaoArchiveSync: 'com.example.kakao-archive.sync', services: ['supervisor', 'heartbeat', 'decisions'] },
  claudeAccounts: ['default'],
  paths: { dataDir: '', logDir: `${HOME}/Library/Logs/omodori`, memoryRepo: '', disks: ['/'], genericCwds: ['/', '/Users', HOME, '/Volumes', '/tmp', '/private/tmp'] },
  git: { name: '', email: '', memoryRemote: '' },
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
function merge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) if (!k.startsWith('//')) out[k] = merge((base as Record<string, unknown>)[k], v)
  return out as T
}
const expandHome = (v: unknown): unknown =>
  typeof v === 'string' ? v.replace(/^~(?=\/|$)/, HOME) : Array.isArray(v) ? v.map(expandHome) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandHome(x)])) : v

export const configPath = () => process.env.DORI_PORTABLE_CONFIG ?? `${installHome()}/config.json`

export function loadConfig(path = configPath()): DoriConfig {
  if (!existsSync(path)) return DEFAULTS
  return expandHome(merge(DEFAULTS, JSON.parse(readFileSync(path, 'utf8')))) as DoriConfig
}

export const cfg = loadConfig()
export const label = (name: string) => `${cfg.launchd.prefix}.${name}`

// Data folder (queue, registry, sa-cache, events, logs/ of the lanes). OMODORI_HOME wins so tests and launchd can pin it.
export const doriHome = () => process.env.OMODORI_HOME ?? (cfg.paths.dataDir || installHome())
/** doriHome() written with ~ for the command hints the lead copies. */
export const homeRef = () => { const h = doriHome(), u = process.env.HOME ?? ''; return u && h.startsWith(`${u}/`) ? `~${h.slice(u.length)}` : h }
export const logDir = () => cfg.paths.logDir
export const kakaoLogs = () => process.env.OMODORI_KAKAO_LOGS || `${logDir()}/kakao`
export const isLeadKey = (key: string) => key.startsWith(cfg.lead.keyPrefix)

export function botForLane(lane: string, bots: Bot[] = cfg.bots): Bot {
  return bots.find((b) => b.lanes.includes(lane)) ?? bots[0] ?? NEUTRAL_BOT
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The bot's call words as one regex source, or null when it has none (then nothing counts as a name call). */
export const callSource = (bot: Bot) => (bot.calls.length ? bot.calls.map(escapeRe).join('|') : null)
export const callPattern = (bot: Bot) => { const s = callSource(bot); return s ? new RegExp(s) : null }

export function checkConfig(c: DoriConfig, services: string[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const id = (where: string, v: string) => { if (v && !/^\d{6,20}$/.test(v)) errors.push(`${where}: "${v}" is not a numeric id`) }
  for (const [k, v] of Object.entries(c.discord)) if (k !== 'relayUrl' && k !== 'botName') id(`discord.${k}`, v as string)
  id('kakao.healthChatId', c.kakao.healthChatId)
  id('kakao.botUserId', c.kakao.botUserId)
  c.kakao.ragChatIds.forEach((v, i) => id(`kakao.ragChatIds[${i}]`, v))
  if (!Number.isInteger(c.kakao.locoPort) || c.kakao.locoPort <= 0) errors.push('kakao.locoPort must be a port number')
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(c.launchd.prefix)) errors.push(`launchd.prefix "${c.launchd.prefix}" is not a reverse-DNS label`)
  for (const s of c.launchd.services) if (!services.includes(s)) errors.push(`launchd.services: unknown service "${s}" (known: ${services.join(', ')})`)
  c.bots.forEach((b, i) => {
    if (!b.name) errors.push(`bots[${i}].name is empty`)
    if (!Array.isArray(b.calls) || !Array.isArray(b.lanes)) errors.push(`bots[${i}] needs calls[] and lanes[]`)
    else if (!b.calls.length) warnings.push(`bots[${i}] "${b.name}" has no calls: only a mention, a reply or a 1:1 room reaches it`)
    for (const r of b.commands ?? []) { try { new RegExp(r) } catch { errors.push(`bots[${i}].commands: "${r}" is not a regex`) } }
  })
  if (!c.lead.keyPrefix) errors.push('lead.keyPrefix is empty')
  if (!c.claudeAccounts.length || c.claudeAccounts.some((a) => !a)) errors.push('claudeAccounts must list at least one account name')
  if (!c.discord.ownerId || !c.discord.generalChannel) warnings.push('discord.ownerId / discord.generalChannel are empty: Discord posts and the owner check stay off')
  if (c.launchd.services.some((s) => s.startsWith('kakao-')) && !c.bots.length) warnings.push('kakao services are on but bots[] is empty: the lanes use the neutral "assistant" bot with no call words')
  if (c.launchd.services.some((s) => s.startsWith('kakao-')) && !c.kakao.healthChatId) warnings.push('kakao services are on but kakao.healthChatId is empty')
  if (/^10{15,}\d{0,3}$/.test(c.discord.generalChannel)) warnings.push('discord ids are still the example values from examples/config.example.json')
  return { errors, warnings }
}

if (import.meta.main && process.argv.includes('--check')) {
  const services = Object.keys(JSON.parse(readFileSync(`${import.meta.dir}/launchagents/services.json`, 'utf8'))).filter((k) => !k.startsWith('//'))
  const { errors, warnings } = checkConfig(cfg, services)
  for (const w of warnings) console.log(`CONFIG_WARN ${w}`)
  for (const e of errors) console.log(`CONFIG_ERROR ${e}`)
  console.log(errors.length ? `CONFIG_INVALID ${configPath()}` : `CONFIG_OK ${configPath()}`)
  process.exit(errors.length ? 1 : 0)
}
