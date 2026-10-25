// Mask credential shapes in outbound Discord text. Ordinary text (including Korean) is returned unchanged.
// adapted from dev-bokdong/dori-mode (MIT) src/redact.ts
const MASK = '[REDACTED]'

// Order matters: block/prefixed forms first, generic assignments last.
const RULES: readonly (readonly [RegExp, string | ((...m: string[]) => string)])[] = [
  [/-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '[REDACTED PRIVATE KEY]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, MASK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bxapp-[A-Za-z0-9-]{10,}/g, MASK],
  // Telegram bot token: <bot id>:<35 chars>.
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}/g, MASK],
  // Discord bot token: three base64url segments, the first a base64 snowflake (M/N/O).
  [/\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/g, MASK],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, (_m, p) => `${p}${MASK}`],
  [/\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&]+)/gi, (match, prefix, raw) => {
    const value = /^["']/.test(raw) ? raw.slice(1, -1) : raw
    // Masked: 16+ chars, a 4+ digit password (PIN), or 5+ chars mixing letters and non-letters. Counts and words stay.
    const long = value.length >= 16
    const pin = /^(?:password|passwd|pwd)/i.test(prefix) && /^\d{4,}$/.test(value)
    const mixed = value.length >= 5 && /\p{L}/u.test(value) && /[^\p{L}]/u.test(value)
    return long || pin || mixed ? `${prefix}${MASK}` : match
  }],
]

export const redactSecrets = (text: string): string => {
  let out = text
  for (const [re, to] of RULES) out = out.replace(re, to as never)
  return out
}
