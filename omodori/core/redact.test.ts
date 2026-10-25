// Ported from dev-bokdong/dori-mode (MIT) test/outbound-safety.test.ts:125-194 (guardText cases run on redactSecrets).
import { expect, test } from 'bun:test'
import { redactSecrets } from './redact'

const secrets: Record<string, string> = {
  // Joined at runtime so secret scanners do not take the fake fixtures for real tokens.
  discord: ['MTA1NjY3ODkwMTIzNDU2Nzg5MA', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.'),
  slack: ['xoxb', '1234567890', 'abcdefghijkl'].join('-'),
  telegram: ['123456789', 'AAEhBOweik6ad9r_QXMENQjcrTu-oq3hGsW'].join(':'),
  ghp: ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_'),
  gho: ['gho', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_'),
  pat: ['github', 'pat', '11ABCDEFG0abcdefghijklmnop', 'qrstuvwxyz'].join('_'),
  gitlab: ['glpat', 'abcdefghijklmnopqrst'].join('-'),
  openai: ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-'),
  anthropic: ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz', '0123456789'].join('-'),
  aws: ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
  bearer: 'abcdefghijklmnop.qrstuvwx.yz0123',
}

test('masks every listed secret kind', () => {
  for (const [kind, secret] of Object.entries(secrets)) {
    const out = redactSecrets(kind === 'bearer' ? `Authorization: Bearer ${secret}` : `value ${secret} end`)
    expect(out).not.toContain(secret)
    expect(out).toContain('[REDACTED]')
  }
})

test('masks assignments and PEM blocks but keeps the key names', () => {
  expect(redactSecrets('password=hunter2 ok')).toBe('password=[REDACTED] ok')
  expect(redactSecrets('token: abc123xyz')).toBe('token: [REDACTED]')
  expect(redactSecrets('API_KEY="a b c"')).toBe('API_KEY=[REDACTED]')
  expect(redactSecrets('pwd: 123456')).toBe('pwd: [REDACTED]')
  expect(redactSecrets('token: abcdefghijklmnopqrstuvwx')).toBe('token: [REDACTED]')
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAbCd\n-----END RSA PRIVATE KEY-----'
  expect(redactSecrets(`before\n${pem}\nafter`)).toBe('before\n[REDACTED PRIVATE KEY]\nafter')
})

test('leaves ordinary text untouched', () => {
  const plain = [
    'Deploy finished at 12:30 for lane build-7; 3 tests passed.',
    'See https://example.com/a/b?x=1 and PR #42, sk-learn is a library.',
    'the token budget is large; password policy docs updated',
    'commit 3676533abc and ratio 10:20',
    '한국어 메시지도 그대로 둡니다.',
  ]
  for (const t of plain) expect(redactSecrets(t)).toBe(t)
})

test('preserves ordinary English and Korean assignment values', () => {
  const plain = [
    'token: 3 left',
    'secret: plan',
    'secret: 계획',
    'token: 3개 남음',
    'secret: 다음계획을확인하세요',
    'token: remaining',
    'secret: "plan"',
    'password=policy',
    'api_key: documentation',
  ]
  for (const text of plain) expect(redactSecrets(text)).toBe(text)
})

test('keeps Dori message shapes: Discord ids, session ids, KST times', () => {
  const plain = [
    '[하트비트] ⚠️ lane dori-improve(1000000000000000006) 무응답 42분 — 세션 019a1b2c-3d4e',
    '[결정 인박스] 미결 3건 · 가장 오래된 것 d-20261023-01 2일째',
    '<#1000000000000000002> 10:30 KST',
  ]
  for (const t of plain) expect(redactSecrets(t)).toBe(t)
})
