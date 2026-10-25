import { expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { offboard, onboard, parseArgs, type Env, type Io } from '../../../core/onboard'

const OMODORI = join(import.meta.dir, '..', '..', '..')

function setup() {
  const t = mkdtempSync(join(tmpdir(), 'onboard-kakao-'))
  const data = join(t, 'data'), agents = join(t, 'LaunchAgents')
  mkdirSync(data); mkdirSync(agents)
  const configPath = join(data, 'config.json')
  copyFileSync(join(OMODORI, 'examples', 'config.example.json'), configPath)
  const ran: string[][] = []
  const env: Env = {
    configPath, dataHome: data, installHome: join(t, 'install'), launchAgentsDir: agents, bun: '/opt/bun', sourcesRoot: join(OMODORI, 'sources'),
    now: () => new Date('2026-10-25T00:00:00Z'),
    run: async (cmd) => { ran.push(cmd); return cmd[0] === 'plutil' ? (Bun.spawnSync(cmd).exitCode === 0 ? { code: 0, out: '' } : { code: 1, out: 'lint' }) : { code: 0, out: 'ok' } },
  }
  const lines: string[] = []
  const io: Io = { tty: false, say: (l) => lines.push(l), ask: async () => { throw new Error('asked without a tty') } }
  return { t, data, agents, configPath, env, io, lines, ran }
}
const ARGS = ['kakao', '--set', 'healthChatId=18000000000000003', '--set', 'ownerRoom=주인 1:1', '--bot', '모모=모모,모모야']

test('onboard kakao --dry-run lists the config entry and the plists it would add, and changes nothing', async () => {
  const s = setup()
  const before = readFileSync(s.configPath, 'utf8')
  expect(await onboard(parseArgs([...ARGS, '--dry-run']), s.io, s.env)).toBe(0)
  expect(s.lines.at(-1)).toBe('ONBOARD_DRY_RUN_OK')
  const entry = JSON.parse(s.lines.find((l) => l.startsWith('entry '))!.slice(6).trim())
  expect(entry).toEqual({ name: 'kakao', agents: ['kakao-live', 'kakao-push', 'kakao-health'], settings: { healthChatId: '18000000000000003', ownerRoom: '주인 1:1' } })
  const rendered = s.lines.filter((l) => l.startsWith('RENDERED ')).map((l) => l.split(' '))
  expect(rendered.map((r) => r[1])).toEqual(['com.example.dori.kakao-live', 'com.example.dori.kakao-push', 'com.example.dori.kakao-health'])
  const live = readFileSync(rendered[0]![2]!, 'utf8')
  expect(live).toContain(`<key>WorkingDirectory</key><string>${s.t}/install/sources/kakao</string>`)
  expect(live).toContain('<string>/opt/bun</string><string>kakao-loco.ts</string>')
  expect(live).toMatch(/Logs\/omodori\/kakao\/live\.ndjson<\/string>/)
  expect(s.lines).toContain(`  would write: ${join(s.data, 'kakao-rooms.json')}`)
  expect(s.lines).toContain(`  would write: ${s.configPath}`)
  expect(s.lines.some((l) => l.startsWith('  would run: /bin/bash') && l.endsWith('/install/sources/kakao/kakao-health.sh'))).toBe(true)
  expect(s.lines.some((l) => l.startsWith('CREDENTIAL_') || l.startsWith('ok   credential'))).toBe(true)
  expect(readFileSync(s.configPath, 'utf8')).toBe(before)
  expect(readdirSync(s.agents)).toEqual([])
  expect(readdirSync(s.data)).toEqual(['config.json'])
  expect(s.ran.filter((c) => c[0] === 'launchctl')).toEqual([])
})

test('onboard kakao applies: config gets the entry and the bot, only the kakao plists are written and loaded, health runs', async () => {
  const s = setup()
  expect(await onboard(parseArgs(ARGS), s.io, s.env)).toBe(0)
  expect(s.lines.at(-1)).toBe('ONBOARD_OK')
  const c = JSON.parse(readFileSync(s.configPath, 'utf8'))
  expect(c.sources).toEqual([{ name: 'kakao', agents: ['kakao-live', 'kakao-push', 'kakao-health'], settings: { healthChatId: '18000000000000003', ownerRoom: '주인 1:1' } }])
  expect(c.bots).toEqual([{ name: '모모', calls: ['모모', '모모야'], about: '', lanes: [] }])
  expect(c.launchd.services).not.toContain('kakao-live')
  expect(readdirSync(s.agents).sort()).toEqual(['com.example.dori.kakao-health.plist', 'com.example.dori.kakao-live.plist', 'com.example.dori.kakao-push.plist'])
  expect(existsSync(join(s.data, 'kakao-rooms.json'))).toBe(true)
  expect(readdirSync(s.data).some((f) => f.startsWith('config.json.bak-'))).toBe(true)
  expect(s.ran.filter((x) => x[1] === 'bootstrap').map((x) => x[3]!.split('/').pop())).toEqual(['com.example.dori.kakao-live.plist', 'com.example.dori.kakao-push.plist', 'com.example.dori.kakao-health.plist'])
  expect(s.ran.at(-1)!.join(' ')).toBe(`/bin/bash ${s.t}/install/sources/kakao/kakao-health.sh`)

  s.lines.length = 0
  expect(await onboard(parseArgs(['kakao', '--set', 'locoPort=9001', '--no-load']), s.io, s.env)).toBe(0)
  expect(s.lines[0]).toContain('already connected')
  const c2 = JSON.parse(readFileSync(s.configPath, 'utf8'))
  expect(c2.sources).toHaveLength(1)
  expect(c2.sources[0].settings).toEqual({ healthChatId: '18000000000000003', ownerRoom: '주인 1:1', locoPort: 9001 })
  expect(c2.bots).toHaveLength(1)

  s.lines.length = 0
  expect(await offboard(parseArgs(['kakao', '--dry-run']), s.io, s.env)).toBe(0)
  expect(s.lines.at(-1)).toBe('OFFBOARD_DRY_RUN_OK')
  expect(JSON.parse(readFileSync(s.configPath, 'utf8')).sources).toHaveLength(1)
  expect(readdirSync(s.agents)).toHaveLength(3)
  expect(await offboard(parseArgs(['kakao']), s.io, s.env)).toBe(0)
  expect(JSON.parse(readFileSync(s.configPath, 'utf8')).sources).toEqual([])
  expect(readdirSync(s.agents)).toEqual([])
  expect(existsSync(join(s.data, 'kakao-rooms.json'))).toBe(true)
})

test('bad settings and unknown sources are refused before anything is written', async () => {
  const s = setup()
  expect(await onboard(parseArgs(['kakao', '--set', 'healthChatId=room-a']), s.io, s.env)).toBe(1)
  expect(s.lines).toContain('SETTING_ERROR kakao.settings.healthChatId "room-a" is not a numeric id')
  expect(s.lines.at(-1)).toBe('ONBOARD_FAILED settings')
  expect(await onboard(parseArgs(['kakao']), s.io, s.env)).toBe(1)
  expect(s.lines).toContain('SETTING_ERROR kakao.settings.healthChatId is required')
  expect(await onboard(parseArgs(['carrier-pigeon']), s.io, s.env)).toBe(1)
  expect(s.lines.at(-1)).toMatch(/^ONBOARD_FAILED unknown source "carrier-pigeon" \(known: .*kakao/)
  expect(await offboard(parseArgs(['kakao']), s.io, s.env)).toBe(1)
  expect(readdirSync(s.data)).toEqual(['config.json'])
  expect(readdirSync(s.agents)).toEqual([])
})
