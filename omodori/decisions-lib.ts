// Decision inbox store: ~/.omocat/decisions.jsonl, one decision per line, rewritten under a lock.
// Used by decision.ts (CLI, digest, LaunchAgent tick) and decision-tools.ts (the lane tool decision_add).
// Safety rule (주인 10-17): money / contract / customer-facing decisions always default to "보류";
// a default is auto-applied only to reversible decisions.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { DORI, kst, withLock } from './dori-lib'

export const FILE = process.env.DECISIONS_FILE ?? `${DORI}/decisions.jsonl`
export const HOLD = '보류'
export const CATEGORIES = ['reversible', 'money', 'contract', 'customer', 'other'] as const
export type Category = (typeof CATEGORIES)[number]
export type Status = 'open' | 'resolved' | 'defaulted' | 'cancelled'

export type Decision = {
  id: string; question: string; options: string[]; due: string; default: string
  category: Category; reversible: boolean; source: string; context: string
  status: Status; held: boolean; created: string; updated: string
  answer?: string; resolvedBy?: 'owner' | 'default' | 'lead'; resolvedAt?: string
  askId?: string; askChannel?: string
}

export const load = (): Decision[] =>
  existsSync(FILE) ? readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Decision) : []
const save = (list: Decision[]) => {
  const tmp = `${FILE}.${process.pid}.tmp`
  writeFileSync(tmp, list.map((d) => `${JSON.stringify(d)}\n`).join(''))
  renameSync(tmp, FILE)
}
export const mutate = <T>(fn: (list: Decision[]) => T) => withLock('decisions', () => { const list = load(); const r = fn(list); save(list); return r })

export const isSensitive = (c: Category) => c === 'money' || c === 'contract' || c === 'customer'
export const autoDefaultAllowed = (d: Pick<Decision, 'category' | 'reversible'>) => d.reversible && !isSensitive(d.category)

export type AddInput = { question: string; options: string[]; due?: string; default?: string; category?: Category; reversible?: boolean; source: string; context?: string }

export function validate(input: AddInput): string | null {
  if (!input.question?.trim()) return 'question 이 필요'
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 3) return '선택지는 2~3개'
  if (input.options.some((o) => !o.trim() || o.length > 80)) return '선택지는 비어 있지 않고 80자 이하'
  if (input.category && !CATEGORIES.includes(input.category)) return `category 는 ${CATEGORIES.join('|')}`
  if (input.due && !/^\d{4}-\d{2}-\d{2}$/.test(input.due)) return 'due 는 YYYY-MM-DD'
  if (input.default && input.default !== HOLD && !input.options.includes(input.default)) return 'default 는 선택지 중 하나 또는 "보류"'
  if (!input.source?.trim()) return 'source(출처 레인) 가 필요'
  return null
}

export async function add(input: AddInput): Promise<Decision> {
  const err = validate(input)
  if (err) throw new Error(err)
  const category = input.category ?? 'other'
  const reversible = isSensitive(category) ? false : input.reversible ?? false
  const now = new Date().toISOString()
  const due = input.due ?? kst(new Date(Date.now() + 3 * 86400_000)).date
  return mutate((list) => {
    const day = kst().date.slice(5).replace('-', '')
    const n = list.filter((d) => d.id.startsWith(`D-${day}-`)).length + 1
    const d: Decision = {
      id: `D-${day}-${String(n).padStart(2, '0')}`, question: input.question.trim(), options: input.options.map((o) => o.trim()),
      due, default: autoDefaultAllowed({ category, reversible }) ? input.default ?? HOLD : HOLD,
      category, reversible, source: input.source.trim(), context: (input.context ?? '').trim(),
      status: 'open', held: false, created: now, updated: now,
    }
    list.push(d)
    return d
  })
}

export async function resolve(id: string, answer: string, by: Decision['resolvedBy'] = 'lead'): Promise<Decision> {
  return mutate((list) => {
    const d = list.find((x) => x.id === id)
    if (!d) throw new Error(`없는 결정 ${id}`)
    if (d.status !== 'open') throw new Error(`${id} 는 이미 ${d.status} (${d.answer})`)
    d.status = by === 'default' ? 'defaulted' : 'resolved'
    d.answer = answer
    d.resolvedBy = by
    d.resolvedAt = d.updated = new Date().toISOString()
    return d
  })
}

export const ageDays = (d: Decision, now = Date.now()) => Math.floor((now - Date.parse(d.created)) / 86400_000)
export const overdue = (d: Decision) => d.due < kst().date
export const line = (d: Decision) =>
  `${d.id} | ${d.status}${d.held ? '(보류중)' : ''} | ${d.question} | [${d.options.join(' / ')}] | 기한 ${d.due} | 기본값 ${d.default} | ${d.category}${d.reversible ? ',되돌림가능' : ''} | 출처 ${d.source}${d.answer ? ` | 답 ${d.answer}` : ''}`
