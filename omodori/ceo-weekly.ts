// Monday 08:30 CEO one-pager (LaunchAgent com.example.dori.ceo-weekly) -> #일반 "CEO 주간 브리핑" thread.
// Text only, no money (주인 10-17: no billing/collection automation, no dashboard).
//   bun ceo-weekly.ts [--dry] [--to <channel>]
import { existsSync, readFileSync } from 'node:fs'
import { load as loadDecisions } from './decisions-lib'
import { CEO_THREAD, DORI, HOME, flag, kst, openLanes, opt, post, readJson, readJsonl } from './dori-lib'
import { EVENTS, type HbEvent } from './heartbeat'
import { summary as patrolSummary } from './repo-patrol'

const DAY = 86400_000
const kstMidnight = (d = new Date()) => { const k = kst(d); return Date.parse(`${k.date}T00:00:00+09:00`) }
const end = kstMidnight()
const start = end - 7 * DAY
const inWeek = (iso: string) => { const t = Date.parse(iso); return t >= start && t < end }
const md = (ms: number) => kst(new Date(ms)).date.slice(5).replace('-', '/')

function incidents(): string[] {
  const ev = readJsonl<HbEvent>(EVENTS).filter((e) => inWeek(e.at))
  const hb = ev.filter((e) => e.id !== 'kakao-off')
  const detected = hb.filter((e) => e.kind === 'detected').length
  const recovered = hb.filter((e) => e.kind === 'recovered').length
  const alerted = hb.filter((e) => e.kind === 'alerted')
  const off = ev.filter((e) => e.id === 'kakao-off' && e.kind === 'detected').length
  const state = readJson<{ checks: Record<string, { ok: boolean; detail: string }> }>(`${DORI}/heartbeat/state.json`, { checks: {} })
  const open = Object.entries(state.checks).filter(([, c]) => !c.ok)
  if (!existsSync(`${DORI}/heartbeat/state.json`)) return ['■ 장애: 하트비트가 아직 안 돎음(LaunchAgent 미등록)']
  return [
    `■ 장애: 발견 ${detected} · 자동 복구 ${recovered} · 형에게 알림 ${alerted.length} · 지금 열린 문제 ${open.length}${off ? ` · 카톡 꺼짐 ${off}회` : ''}`,
    ...alerted.slice(-3).map((e) => `  - ${md(Date.parse(e.at))} ${e.detail.slice(0, 80)}`),
    ...open.slice(0, 3).map(([id, c]) => `  - 열림: ${id} ${c.detail.slice(0, 60)}`),
  ]
}

function decisions(): string[] {
  const all = loadDecisions()
  const open = all.filter((d) => d.status === 'open')
  const oldest = [...open].filter((d) => d.category !== 'money').sort((a, b) => a.created.localeCompare(b.created))[0]
  const done = all.filter((d) => d.resolvedAt && inWeek(d.resolvedAt))
  return [
    `■ 결정 대기 ${open.length}건${open.filter((d) => d.held).length ? `(보류 ${open.filter((d) => d.held).length})` : ''} · 지난주 처리 ${done.length}건(기본값 ${done.filter((d) => d.resolvedBy === 'default').length})`,
    ...(oldest ? [`  - 가장 오래된 것: ${oldest.id} ${Math.floor((Date.now() - Date.parse(oldest.created)) / DAY)}일째 — ${oldest.question.slice(0, 60)}`] : []),
  ]
}

function quota(): string[] {
  type W = { kind: string; percent: number; reset?: number }
  type Snap = { at: number; sections: { id: string; label: string; result?: { windows?: W[]; blocked?: boolean } }[] }
  const p = `${HOME}/.cache/omo-quota/snapshot-v2.json`
  if (!existsSync(p)) return ['■ 쿼터: 캐시 없음']
  const s = JSON.parse(readFileSync(p, 'utf8')) as Snap
  const rows = s.sections.filter((x) => x.result?.windows?.length).map((x) =>
    `${x.label} ${x.result!.windows!.map((w) => `${w.kind === 'week' ? '주' : w.kind} ${Math.round(w.percent)}%`).join('·')}${x.result!.blocked ? '(막힘)' : ''}`)
  return [`■ 쿼터 사용률(/quota 캐시 ${md(s.at)} ${kst(new Date(s.at)).hm}): ${rows.join(' | ')}`]
}

function lanes(): string[] {
  const open = openLanes()
  const kakao = open.filter((l) => l.key.startsWith('kakao-'))
  const work = open.filter((l) => !l.key.startsWith('kakao-'))
  return [
    `■ 열린 레인 ${open.length}개 (카톡 상시 ${kakao.length} · 작업 ${work.length})`,
    ...work.map((l) => `  - ${l.label} (${l.key})`),
  ]
}

function night(): string[] {
  const msgs = readJsonl<{ at: string; kind: string; is_owner?: boolean }>(`${DORI}/inbox.jsonl`).filter((m) => m.kind === 'MSG' && m.is_owner && inWeek(m.at))
  const n = msgs.filter((m) => kst(new Date(m.at)).h < 3).length
  return [`■ 밤 작업: 디스코드 지시 ${msgs.length}건 중 0~3시 ${n}건(${msgs.length ? Math.round((n / msgs.length) * 100) : 0}%)`]
}

function pipeline(): string[] {
  const p = `${DORI}/pipeline.yaml`
  if (!existsSync(p)) return []
  type Lead = { name: string; stage: string; next?: { action?: string; date?: string } }
  const doc = Bun.YAML.parse(readFileSync(p, 'utf8')) as { leads?: Lead[] }
  const leads = doc.leads ?? []
  const stages = ['접촉', '니즈', '제안', '견적', '계약']
  const count = stages.map((s) => `${s} ${leads.filter((l) => l.stage === s).length}`).join(' → ')
  const today = kst().date
  const late = leads.filter((l) => l.next?.date && l.next.date < today && l.stage !== '계약')
  const blank = leads.filter((l) => !l.next?.action || !l.next?.date)
  return [
    `■ 파이프라인: ${count}`,
    ...late.slice(0, 3).map((l) => `  - 기한 지남: ${l.name} — ${l.next!.action} (${l.next!.date})`),
    ...(blank.length ? [`  - 다음 액션·날짜 빈 리드 ${blank.length}건: ${blank.map((l) => l.name).join(', ')}`] : []),
  ]
}

// Free text copied from decisions, patrol and pipeline could carry an amount; such lines are dropped, not masked.
const MONEY = /\d[\d,]*\s*(원|만원|만|억)|₩|VAT|부가세|입금|미수|청구|세금계산서|결제금액|독촉/
export function build(): string {
  return [
    `**CEO 주간 한 장** ${md(start)}~${md(end - DAY)}`,
    ...incidents(), ...decisions(), ...quota(), ...lanes(), ...night(),
    ...`■ ${patrolSummary()}`.split('\n'), ...pipeline(),
  ].filter((l) => !MONEY.test(l)).join('\n')
}

if (import.meta.main) {
  const text = build()
  if (flag('--dry')) console.log(text)
  else { await post(opt('--to') ?? CEO_THREAD, text); console.log(`posted to ${opt('--to') ?? CEO_THREAD}\n${text}`) }
}
