import { expect, test } from 'bun:test'
import { contextEvent, contextStep, contextTokens, parseFooter } from '../lane-health'

const turn = (total: number | null) =>
  JSON.stringify({ type: 'message', message: { role: 'assistant', usage: total === null ? {} : { totalTokens: total } } })

test('contextTokens takes the newest assistant turn with usage', () => {
  expect(contextTokens([turn(100), turn(null), turn(179845), '{"message":{"role":"user"}}'].join('\n'))).toBe(179845)
  expect(contextTokens('not json\n')).toBeNull()
})

test('parseFooter reads K/M units', () => {
  expect(parseFooter('x • 177K/1M (17.7%) (auto)')).toEqual({ tokens: 177_000, window: 1_000_000 })
  expect(parseFooter('no footer here')).toBeNull()
})

test('contextEvent proposes a fresh lane-transition for every lane kind', () => {
  expect(contextEvent('acme-rag-build', 'w1V:p3', 410_000, 1_000_000)).toBe(
    'LANE_CONTEXT acme-rag-build pane=w1V:p3 ctx=410K/41.0% -> propose: bun ~/.omocat/lane-transition.ts acme-rag-build --fresh --reason manual (after its turn)',
  )
  expect(contextEvent('kakao-acme-chat', 'wJ:pC', 410_000, 1_000_000)).toBe(
    'LANE_CONTEXT kakao-acme-chat pane=wJ:pC ctx=410K/41.0% -> propose: bun ~/.omocat/lane-transition.ts kakao-acme-chat --fresh --reason manual (after its turn)',
  )
})

test('fires once, then only after dropping under and re-crossing', () => {
  const W = 1_000_000
  let over = false
  const seq = [300_000, 410_000, 450_000, 420_000, 200_000, 430_000].map((t) => {
    const s = contextStep(over, t, W, 40)
    over = s.over
    return s.fire
  })
  expect(seq).toEqual([false, true, false, false, false, true])
})
