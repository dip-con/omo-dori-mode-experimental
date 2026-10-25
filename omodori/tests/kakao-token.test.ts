import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type LoginClient, ReloginRequired, connectWithRefresh, keepTokenFresh, reportReloginRequired } from '../kakao-token'

const ID = '400000001'
const OLD = { at: 'OLD_ACCESS_TOKEN_x', rt: 'OLD_REFRESH_TOKEN_x' }
const NEW = { at: 'NEW_ACCESS_TOKEN_y', rt: 'NEW_REFRESH_TOKEN_y' }
let dir: string, cfg: string, logs: string, lines: string[], calls: { url: string; body: any }[]

const credsFile = () => join(cfg, 'kakaotalk-credentials.json')
const saved = () => JSON.parse(readFileSync(credsFile(), 'utf8')).accounts[ID]
function writeCreds(updatedAt: string, token = OLD.at) {
  const acc = { account_id: ID, oauth_token: token, user_id: ID, refresh_token: OLD.rt, device_uuid: 'a'.repeat(64), device_type: 'tablet', auth_method: 'login', created_at: updatedAt, updated_at: updatedAt }
  writeFileSync(credsFile(), JSON.stringify({ current_account: ID, accounts: { [ID]: acc } }), { mode: 0o600 })
}
const fetchReturning = (body: object, status = 200) => (async (url: string, init: RequestInit) => {
  calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
  return new Response(JSON.stringify(body), { status })
}) as unknown as typeof fetch
const tokenError = () => Object.assign(new Error('KakaoTalk LOGINLIST invalid access token (status -950)'), { code: 'invalid_access_token', serverStatus: -950 })

function fakeClient(failures: unknown[]) {
  const c = { logins: 0, connects: 0, token: OLD.at } as { logins: number; connects: number; token: string } & LoginClient
  c.acquireSession = async () => { c.connects++; const f = failures.shift(); if (f) throw f }
  c.login = async () => { c.logins++; c.token = saved().oauth_token }
  c.getCredentials = () => ({ oauthToken: c.token })
  return c
}
const deps = (fetchImpl: typeof fetch, now = Date.now()) => ({ configDir: cfg, logsDir: logs, fetchImpl, now: () => now, log: (l: string) => lines.push(l) })
const noSecrets = () => { for (const s of [OLD.at, OLD.rt, NEW.at, NEW.rt]) expect(lines.join('\n')).not.toContain(s) }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kakao-token-'))
  cfg = join(dir, 'cfg'); logs = join(dir, 'logs')
  for (const d of [cfg, logs]) mkdirSync(d)
  lines = []; calls = []
  writeCreds(new Date().toISOString())
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('connectWithRefresh', () => {
  test('-950 on login: refreshes, saves the new tokens, logs in again and clears auth.state', async () => {
    writeFileSync(join(logs, 'auth.state'), 'old failure\n')
    const client = fakeClient([tokenError()])
    await connectWithRefresh(client, ID, deps(fetchReturning({ status: 0, access_token: NEW.at, refresh_token: NEW.rt, expires_in: 43_200 })))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('oauth2_token.json')
    expect(calls[0]!.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: OLD.rt })
    expect(saved()).toMatchObject({ oauth_token: NEW.at, refresh_token: NEW.rt })
    expect(statSync(credsFile()).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(`${credsFile()}.prev`, 'utf8')).accounts[ID].oauth_token).toBe(OLD.at)
    expect(client).toMatchObject({ logins: 1, connects: 2, token: NEW.at })
    expect(JSON.parse(readFileSync(join(logs, 'token.state'), 'utf8')).expires_in).toBe(43_200)
    expect(existsSync(join(logs, 'auth.state'))).toBe(false)
    noSecrets()
  })

  test('refresh rejected: ReloginRequired, credentials untouched, auth.state + heartbeat-visible log line', async () => {
    const client = fakeClient([tokenError()])
    const err = await connectWithRefresh(client, ID, deps(fetchReturning({ status: -500 }))).catch((e) => e)
    expect(err).toBeInstanceOf(ReloginRequired)
    expect(saved().oauth_token).toBe(OLD.at)
    expect(client.logins).toBe(0)
    reportReloginRequired(err, deps(fetchReturning({})))
    const state = readFileSync(join(logs, 'auth.state'), 'utf8')
    expect(state).toContain('refresh_rejected server=-500')
    expect(state).toContain('-950')
    expect(lines.at(-1)).toMatch(/exit: .*(invalid access token|LOGINLIST|kicked|-950)/)
    noSecrets()
  })

  test('refreshed token refused too: ReloginRequired', async () => {
    const client = fakeClient([tokenError(), tokenError()])
    const err = await connectWithRefresh(client, ID, deps(fetchReturning({ status: 0, access_token: NEW.at }))).catch((e) => e)
    expect(err).toBeInstanceOf(ReloginRequired)
    expect(err.message).toContain('even after a token refresh')
  })

  test('other login errors are rethrown without a refresh', async () => {
    const boom = new Error('network down')
    const err = await connectWithRefresh(fakeClient([boom]), ID, deps(fetchReturning({}))).catch((e) => e)
    expect(err).toBe(boom)
    expect(calls).toHaveLength(0)
  })
})

describe('keepTokenFresh', () => {
  test('a token 3 days old is refreshed and loaded into the client', async () => {
    const now = Date.now()
    writeCreds(new Date(now - 3 * 86_400_000).toISOString())
    const client = fakeClient([])
    expect(await keepTokenFresh(client, ID, deps(fetchReturning({ status: 0, access_token: NEW.at }), now))).toBe('refreshed')
    expect(client.token).toBe(NEW.at)
    expect(saved().refresh_token).toBe(OLD.rt)
    noSecrets()
  })

  test('half the known lifetime decides, then a fresh token is left alone', async () => {
    const now = Date.now()
    const client = fakeClient([])
    await connectWithRefresh(fakeClient([tokenError()]), ID, deps(fetchReturning({ status: 0, access_token: NEW.at, expires_in: 3600 }), now))
    client.token = NEW.at
    expect(await keepTokenFresh(client, ID, deps(fetchReturning({ status: 0, access_token: 'X' }), now + 1000))).toBe('fresh')
    expect(await keepTokenFresh(client, ID, deps(fetchReturning({ status: 0, access_token: 'X' }), now + 1_801_000))).toBe('refreshed')
  })

  test('a token saved by another process (CLI login) is adopted without a refresh', async () => {
    const client = fakeClient([])
    writeCreds(new Date().toISOString(), 'CLI_TOKEN')
    expect(await keepTokenFresh(client, ID, deps(fetchReturning({})))).toBe('reloaded')
    expect(client.token).toBe('CLI_TOKEN')
    expect(calls).toHaveLength(0)
  })

  test('a failed proactive refresh only logs; the session keeps running', async () => {
    writeCreds(new Date(Date.now() - 3 * 86_400_000).toISOString())
    expect(await keepTokenFresh(fakeClient([]), ID, deps(fetchReturning({ status: -500 })))).toBe('refresh-failed')
    expect(existsSync(join(logs, 'auth.state'))).toBe(false)
    expect(lines.at(-1)).toContain('refresh_rejected')
  })
})
