import { $ } from 'bun'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const STATE_PATH = `${process.env.HOME}/.omocat/watch-state.json`
const MAIL_FILTER = 'is:unread newer_than:2d (is:important OR category:primary OR from:kakaoimpact.org) -from:tradingview.com'
const SOON_MINUTES = 15
const TRAVEL_LEAD_MINUTES = 60
const BRIEF_AT = { hour: 8, minute: 30 }

type Item = Record<string, unknown> & { id: string }
type State = { mailSeen: string[]; calSeen: string[]; calAlerted: string[]; lastBrief: string; seoDue?: Record<string, string> }
type SeoSite = { key: string; url: string; weekday: number; hour: number; paused?: string }
const SEO_SITES_PATH = `${process.env.HOME}/.omocat/seo-sites.json`

const today = () => new Date().toLocaleDateString('sv-SE')
const isBaseline = !existsSync(STATE_PATH)
const state: State = isBaseline
  ? { mailSeen: [], calSeen: [], calAlerted: [], lastBrief: today() }
  : JSON.parse(readFileSync(STATE_PATH, 'utf8'))
const saveState = () => {
  state.mailSeen = state.mailSeen.slice(-2000)
  state.calSeen = state.calSeen.slice(-2000)
  state.calAlerted = state.calAlerted.slice(-500)
  writeFileSync(STATE_PATH, JSON.stringify(state))
}

const emit = (kind: string, payload: unknown) => console.log(`OMOCAT_${kind} ${JSON.stringify(payload)}`)

const zeleItems = async (args: string[]): Promise<Item[] | null> => {
  const res = await $`zele ${args}`.quiet().nothrow()
  if (res.exitCode !== 0) {
    emit('WATCH_ERROR', { args, stderr: res.stderr.toString().trim().slice(0, 300) })
    return null
  }
  const parsed = Bun.YAML.parse(res.stdout.toString()) as { items?: Item[] } | null
  return parsed?.items ?? []
}

const checkMail = async (silent: boolean) => {
  const items = await zeleItems(['mail', 'list', '--filter', MAIL_FILTER, '--limit', '30'])
  if (!items) return
  for (const item of items) {
    if (state.mailSeen.includes(item.id)) continue
    state.mailSeen.push(item.id)
    if (!silent) {
      emit('MAIL', { id: item.id, account: item.account, from: item.from, subject: item.subject, snippet: String(item.snippet ?? '').slice(0, 280), date: item.date })
    }
  }
}

const checkCalendarNew = async (silent: boolean) => {
  const items = await zeleItems(['cal', 'events', '--all', '--days', '14', '--limit', '100'])
  if (!items) return
  for (const item of items) {
    if (state.calSeen.includes(item.id)) continue
    state.calSeen.push(item.id)
    if (!silent) emit('CAL_NEW', item)
  }
}

const ONLINE_LOCATION = /^(온라인|online|https?:\/\/|zoom|meet\.google|teams\.microsoft|webex)|zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com|온라인/i

export const hasPhysicalLocation = (item: Record<string, unknown>): boolean => {
  const loc = typeof item.location === 'string' ? item.location.trim() : ''
  return loc !== '' && !ONLINE_LOCATION.test(loc)
}

export const calendarLeadMinutes = (item: Record<string, unknown>, baseLead = SOON_MINUTES): number =>
  hasPhysicalLocation(item) ? Math.max(baseLead, TRAVEL_LEAD_MINUTES) : baseLead

const checkCalendarSoon = async () => {
  const from = new Date().toISOString()
  const maxLead = Math.max(SOON_MINUTES, TRAVEL_LEAD_MINUTES)
  const items = await zeleItems(['cal', 'events', '--all', '--from', from, '--to', `+${maxLead}m`, '--limit', '50'])
  if (!items) return
  const soon = new Set(((await zeleItems(['cal', 'events', '--all', '--from', from, '--to', `+${SOON_MINUTES}m`, '--limit', '20'])) ?? []).map((i) => i.id))
  for (const item of items) {
    const travel = calendarLeadMinutes(item) > SOON_MINUTES
    if (!soon.has(item.id) && !travel) continue
    if (state.calAlerted.includes(item.id)) continue
    state.calAlerted.push(item.id)
    emit('CAL_SOON', travel ? { ...item, leadMinutes: calendarLeadMinutes(item), note: '이동 시간 고려' } : item)
  }
}

const checkBrief = () => {
  const now = new Date()
  const due = now.getHours() > BRIEF_AT.hour || (now.getHours() === BRIEF_AT.hour && now.getMinutes() >= BRIEF_AT.minute)
  if (!due || state.lastBrief === today()) return
  state.lastBrief = today()
  emit('BRIEF', { date: state.lastBrief })
}

const checkSeoDue = () => {
  if (!existsSync(SEO_SITES_PATH)) return
  const { sites } = JSON.parse(readFileSync(SEO_SITES_PATH, 'utf8')) as { sites: SeoSite[] }
  const now = new Date()
  const weekday = (now.getDay() + 6) % 7
  state.seoDue ??= {}
  for (const site of sites) {
    if (site.paused || weekday !== site.weekday || now.getHours() < site.hour || state.seoDue[site.key] === today()) continue
    state.seoDue[site.key] = today()
    emit('SEO_DUE', { key: site.key, url: site.url, date: today() })
  }
}

let tick = 0
const run = async () => {
  const silent = isBaseline && tick === 0
  await checkMail(silent)
  if (tick % 5 === 0) {
    await checkCalendarNew(silent)
    await checkCalendarSoon()
  }
  checkBrief()
  checkSeoDue()
  saveState()
  if (tick === 0) emit('WATCH_READY', { baseline: isBaseline, mailSeen: state.mailSeen.length, calSeen: state.calSeen.length })
  tick += 1
}

if (import.meta.main) {
  await run()
  setInterval(() => {
    run().catch((err) => emit('WATCH_ERROR', { message: String(err) }))
  }, 60_000)
}
