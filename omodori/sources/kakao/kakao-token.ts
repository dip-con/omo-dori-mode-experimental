// Access-token refresh for the bot's KakaoTalk account (10-22, 주인 승인).
// The LOCO server ends a session every 72 h; kakao-loco then exits and logs in again, and that LOGINLIST fails with -950
// once the access token has expired (10-14, 10-22: a token 4.6 days old reconnected, 7.6 days old did not).
// agent-messenger ships refreshKakaoOAuthToken but never calls it. This module renews the token with the saved refresh
// token and writes both into the shared credentials file, which the agent-kakaotalk CLI reads too.
// No password is stored or sent: when the refresh itself fails, only 주인's manual login fixes it, so it writes AUTH_STATE
// (kakao-health reads it) and kakao-loco retries once a minute instead of crash-looping every 5 s.
// Never log tokens: messages carry error codes and server/http statuses only.
// Manual run: `bun kakao-token.ts refresh` (prints the new lifetime only).
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { KakaoCredentialManager, KakaoOAuthRefreshError, refreshKakaoOAuthToken } from 'agent-messenger/kakaotalk'
import { kakaoLogs } from './settings'


const LOGS = kakaoLogs()
export const AUTH_RETRY_MS = 60_000
// Without a known lifetime (token from a password login), refresh once it is 2 days old: 4.6 days still worked.
const DEFAULT_REFRESH_AFTER_MS = 2 * 86_400_000

export type Deps = {
  configDir?: string
  logsDir?: string
  fetchImpl?: typeof fetch
  now?: () => number
  log?: (line: string) => void
}
export interface LoginClient {
  login(credentials?: unknown, accountId?: string): Promise<unknown>
  acquireSession(): Promise<unknown>
  getCredentials(): { oauthToken: string }
}
// Refresh failed (or the refreshed token was refused too): a manual `agent-kakaotalk auth login` is needed.
export class ReloginRequired extends Error {}

const paths = (d: Deps) => ({ auth: `${d.logsDir ?? LOGS}/auth.state`, token: `${d.logsDir ?? LOGS}/token.state` })
const stamp = (d: Deps) => new Date((d.now ?? Date.now)()).toISOString()
const logOf = (d: Deps) => d.log ?? ((line: string) => console.error(new Date().toISOString(), line))

export const isTokenError = (e: unknown) => {
  const x = e as { code?: string; serverStatus?: number; message?: string } | null
  return x?.code === 'invalid_access_token' || x?.serverStatus === -950 || /status -950/.test(String(x?.message ?? ''))
}
export const describe = (e: unknown) =>
  e instanceof KakaoOAuthRefreshError
    ? `${e.code}${e.serverStatus !== undefined ? ` server=${e.serverStatus}` : ''}${e.httpStatus !== undefined ? ` http=${e.httpStatus}` : ''}`
    : (e as Error)?.message ?? String(e)

export async function refreshAccount(accountId: string, why: string, d: Deps = {}) {
  const mgr = new KakaoCredentialManager(d.configDir)
  const config = await mgr.load()
  const acc = config.accounts[accountId]
  if (!acc) throw new ReloginRequired(`no saved credentials for account ${accountId}`)
  const r = await refreshKakaoOAuthToken({ accessToken: acc.oauth_token, refreshToken: acc.refresh_token ?? '', deviceUuid: acc.device_uuid }, { fetchImpl: d.fetchImpl })
  const file = `${d.configDir || process.env.AGENT_MESSENGER_CONFIG_DIR || `${process.env.HOME}/.config/agent-messenger`}/kakaotalk-credentials.json`
  copyFileSync(file, `${file}.prev`)
  chmodSync(`${file}.prev`, 0o600)
  const at = stamp(d)
  config.accounts[accountId] = { ...acc, oauth_token: r.accessToken, refresh_token: r.refreshToken, updated_at: at }
  await mgr.save(config)
  const p = paths(d)
  mkdirSync(d.logsDir ?? LOGS, { recursive: true })
  writeFileSync(p.token, JSON.stringify({ refreshed_at: at, expires_in: r.expiresIn ?? null, why }) + '\n')
  logOf(d)(`kakao token refreshed (${why}), expires_in ${r.expiresIn ?? 'unknown'}s, refresh token ${r.refreshToken === acc.refresh_token ? 'kept' : 'rotated'}`)
  return { expiresIn: r.expiresIn }
}

export async function connectWithRefresh(client: LoginClient, accountId: string, d: Deps = {}) {
  try {
    await client.acquireSession()
  } catch (e) {
    if (!isTokenError(e)) throw e
    logOf(d)(`login refused: ${describe(e)} - refreshing the access token`)
    try {
      await refreshAccount(accountId, 'login -950', d)
    } catch (r) {
      throw new ReloginRequired(`${describe(e)}; token refresh failed (${describe(r)})`)
    }
    await client.login(undefined, accountId)
    try {
      await client.acquireSession()
    } catch (e2) {
      if (isTokenError(e2)) throw new ReloginRequired(`${describe(e2)} even after a token refresh`)
      throw e2
    }
  }
  rmSync(paths(d).auth, { force: true })
}

// Called by kakao-loco before it waits AUTH_RETRY_MS and exits. The line keeps "exit: ... -950" so heartbeat.ts:84 still
// sees a token outage (카톡 꺼짐) and stops its own alarms.
export function reportReloginRequired(e: ReloginRequired, d: Deps = {}) {
  const p = paths(d)
  mkdirSync(d.logsDir ?? LOGS, { recursive: true })
  writeFileSync(p.auth, `${stamp(d)} ${e.message}\n`)
  logOf(d)(`exit: error ${e.message} - 카톡 재로그인 필요(agent-kakaotalk auth login), ${AUTH_RETRY_MS / 1000}초 뒤 재시도`)
}

// Hourly while connected: refresh before the token expires, and adopt a token another process saved (CLI login, manual
// refresh). client.login(undefined) only reloads the credentials; the live session stays as it is.
export async function keepTokenFresh(client: LoginClient, accountId: string, d: Deps = {}) {
  const mgr = new KakaoCredentialManager(d.configDir)
  const acc = (await mgr.load()).accounts[accountId]
  if (!acc) return 'no-credentials'
  let last: { refreshed_at?: string; expires_in?: number | null } = {}
  const p = paths(d)
  if (existsSync(p.token)) { try { last = JSON.parse(readFileSync(p.token, 'utf8')) } catch {} }
  const issued = Math.max(Date.parse(acc.updated_at) || 0, Date.parse(last.refreshed_at ?? '') || 0)
  const after = last.expires_in && Date.parse(last.refreshed_at ?? '') >= (Date.parse(acc.updated_at) || 0) ? (last.expires_in * 1000) / 2 : DEFAULT_REFRESH_AFTER_MS
  if ((d.now ?? Date.now)() >= issued + after) {
    try {
      await refreshAccount(accountId, 'proactive', d)
    } catch (e) {
      // The session is still alive: log and try again next hour. auth.state is written only when a login fails.
      logOf(d)(`kakao token proactive refresh failed (${describe(e)}), next try in 1 h`)
      return 'refresh-failed'
    }
    await client.login(undefined, accountId)
    return 'refreshed'
  }
  if (client.getCredentials().oauthToken !== acc.oauth_token) {
    await client.login(undefined, accountId)
    return 'reloaded'
  }
  return 'fresh'
}

if (import.meta.main && process.argv[2] === 'refresh') {
  const config = await new KakaoCredentialManager().load()
  if (!config.current_account) throw new Error('no current KakaoTalk account')
  const r = await refreshAccount(config.current_account, 'manual', { log: () => {} })
  console.log(JSON.stringify({ refreshed: true, account: config.current_account, expires_in: r.expiresIn ?? null }))
}
