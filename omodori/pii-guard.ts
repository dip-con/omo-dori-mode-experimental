// TypeScript port of the RAG policy screen_text plus a sanitizer for the
// external wake-classifier state.  Detection runs on a normalized copy that is
// never returned; results carry only a fixed reason code.  An allowed result
// does not prove that personal or financial data is absent.

export type TextReason =
  | "allowed"
  | "empty_input"
  | "invalid_input"
  | "pii_label"
  | "finance_label"
  | "resident_number";

export interface TextDecision {
  readonly allowed: boolean;
  readonly reason: TextReason;
}

export const REDACTED = "(가림)";

// Unicode Default_Ignorable_Code_Point ranges, plus every Cf character.
const IGNORABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160],
  [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfff8], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];
const DASHES = new Set("\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u2043\ufe58\ufe63\uff0d\u30fc\u2e3a\u2e3b");

const CF = /^\p{Cf}$/u;
const PD = /^\p{Pd}$/u;
const ND = /^\p{Nd}$/u;
// Python str.isspace(): JS \s plus the separators \x1c-\x1f and NEL.
const SPACE = /^[\s\x1c-\x1f\x85]$/u;

function ignorable(ch: string): boolean {
  if (CF.test(ch)) return true;
  const cp = ch.codePointAt(0) ?? 0;
  return IGNORABLE_RANGES.some(([lo, hi]) => lo <= cp && cp <= hi);
}

// Nd characters are encoded in contiguous ascending 0..9 runs, so the digit
// value is the offset from the start of the run, mod 10.
function decimalValue(cp: number): number {
  let start = cp;
  while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start -= 1;
  return (cp - start) % 10;
}

function foldChar(ch: string): string {
  if (DASHES.has(ch) || (ch !== "-" && PD.test(ch))) return "-";
  const cp = ch.codePointAt(0) ?? 0;
  if (cp > 0x7f && ND.test(ch)) return String(decimalValue(cp));
  return ch;
}

// Python str.casefold() differs from toLowerCase() mainly in full folds.
const CASEFOLD_EXTRA: Readonly<Record<string, string>> = { "ß": "ss", "ẞ": "ss", "ς": "σ" };

function casefold(s: string): string {
  let out = "";
  for (const ch of s.toLowerCase()) out += CASEFOLD_EXTRA[ch] ?? ch;
  return out;
}

function strip(text: string, keepSpace: boolean): string {
  let out = "";
  for (const ch of text) {
    if (ignorable(ch) || ch === "\x00") continue;
    if (SPACE.test(ch)) {
      if (keepSpace) out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

function normalize(text: string, keepSpace: boolean): string {
  let s = strip(text, keepSpace);
  s = s.normalize("NFC").normalize("NFKC");
  s = strip(s, keepSpace);
  let folded = "";
  for (const ch of s) folded += foldChar(ch);
  s = casefold(folded).normalize("NFKC");
  if (keepSpace) s = s.replace(/ +/g, " ");
  return s;
}

const PII_LABEL = new RegExp(
  "주민등록|주민번호|생년월일|외국인등록|여권번호|운전면허번호|신용카드번호|카드번호|" +
    "residentregistration|dateofbirth|birthdate|passportno|passportnumber|socialsecurity",
  "u",
);
const FINANCE_LABEL = new RegExp(
  "계좌|예금주|통장|송금|입금|출금|이체|금융거래|납부확인|영수증|잔액|잔고|미수금|" +
    "거래명세|세금계산서|매입매출|급여|임금|월급|연봉|" +
    "accountno|accountnumber|bankaccount|routingnumber|iban|swiftcode|payroll|salary|" +
    "remittance|wiretransfer|banktransfer",
  "u",
);
// YYMMDD + gender/century digit + six digits; masked tails are still rejected.
const RESIDENT = new RegExp(
  "(?<!\\p{Nd})\\p{Nd}{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\p{Nd}|3[01])" +
    " ?[-.]? ?[1-8](?:\\p{Nd}{6}|[*x●○■□#]{6})(?!\\p{Nd})",
  "u",
);

function textReason(text: string): TextReason | null {
  const compact = normalize(text, false);
  const spaced = normalize(text, true);
  if (PII_LABEL.test(compact)) return "pii_label";
  if (RESIDENT.test(compact) || RESIDENT.test(spaced)) return "resident_number";
  if (FINANCE_LABEL.test(compact)) return "finance_label";
  return null;
}

export function screenText(text: string): TextDecision {
  if (typeof text !== "string") return { allowed: false, reason: "invalid_input" };
  if (!normalize(text, false)) return { allowed: false, reason: "empty_input" };
  const reason = textReason(text);
  if (reason !== null) return { allowed: false, reason };
  return { allowed: true, reason: "allowed" };
}

const MAX_DEPTH = 20;

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitize(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (typeof value === "string") {
    // Empty/blank strings carry no content; every other rejection is redacted.
    const decision = screenText(value);
    return decision.allowed || decision.reason === "empty_input" ? value : REDACTED;
  }
  if (typeof value !== "object" || value === null) return value;
  // Fail closed: containers past the depth limit or on a cycle are not copied.
  if (depth >= MAX_DEPTH || ancestors.has(value)) return REDACTED;
  if (Array.isArray(value)) {
    ancestors.add(value);
    const out = value.map((item) => sanitize(item, depth + 1, ancestors));
    ancestors.delete(value);
    return out;
  }
  if (!isPlainObject(value)) return value;
  ancestors.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = sanitize(item, depth + 1, ancestors);
  ancestors.delete(value);
  return out;
}

/** Deep copy of `state` with every screen-rejected string replaced by REDACTED. */
export function sanitizeJevState<T>(state: T): T {
  return sanitize(state, 0, new Set()) as T;
}
