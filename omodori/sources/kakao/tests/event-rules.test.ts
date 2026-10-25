import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { classifyEvent, classifyLegacy, loadRules } from '../../../core/event-router'

const CORE = join(import.meta.dir, '..', '..', '..', 'core', 'event-rules.json')
const KAKAO = join(import.meta.dir, '..', 'event-rules.json')

test('the kakao rules join the core table only when the source is enabled', () => {
  const core = loadRules(CORE, [])
  const both = loadRules(CORE, [KAKAO])
  for (const k of ['kakao.batch', 'kakao.split', 'kakao.stuck', 'kakao.recovered']) {
    expect(core.events.some((r) => r.kind === k)).toBe(false)
    expect(both.events.some((r) => r.kind === k)).toBe(true)
  }
  expect(classifyLegacy('KAKAO_STALL push', core).route).toBe('drop')
  expect(classifyLegacy('KAKAO_STALL push', both).route).toBe('info')
  expect(classifyLegacy('KAKAO_STALL live no message for 40 min', both).route).toBe('ask')
  expect(classifyLegacy('KAKAO_STALL_RECOVERED push', both)).toEqual({ route: 'info', kind: 'kakao.recovered' })
  expect(classifyEvent({ kind: 'kakao.stuck' }, both)).toBe('act')
  expect(classifyLegacy('LANE_QUOTA_ALL k reset=unknown', both)).toEqual(classifyLegacy('LANE_QUOTA_ALL k reset=unknown', core))
})

test('the default rules (test config enables every source) carry the kakao rules', () => {
  expect(loadRules(CORE).events.some((r) => r.kind === 'kakao.batch')).toBe(true)
})
