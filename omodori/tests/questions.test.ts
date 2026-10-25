// Parser regression tests. The first block is ported from kihyunnn/omo-discord-question-patch
// (tests/questions.test.ts, MIT); the rest uses real OMO screens and session-log lines captured
// from a /tmp OMO session on 2026-10-02.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  chunkRows, dedupeQuestions, parseCustomId, parseOmoScreen, parsePaneQuestions, parseSessionQuestionCalls,
  questionResult, questionRows, questionUiAtBottom, sessionDirSlug, sessionRoot,
} from '../questions'

const fx = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')
const call = (name: string, questions: unknown, id = 'toolu_x') => JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: { questions } }] } })
const result = (id: string, status: string, text: string) => JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: 'ask_user_question', content: [{ type: 'text', text }], details: { status } } })

test('[repo] human-readable pane text with numbered choices', () => {
  const parsed = parsePaneQuestions('Question: which environment?\n1. staging\n2. production\n')!
  expect(parsed.questions[0]!.text).toBe('which environment?')
  expect(parsed.questions[0]!.options.map((c) => c.value)).toEqual(['staging', 'production'])
})

test('[repo] JSON questions keep multi-select', () => {
  const parsed = parsePaneQuestions(JSON.stringify({ questions: [{ question: 'pick one?', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], multiSelect: true }] }))!
  expect(parsed.questions[0]!.multiSelect).toBe(true)
  expect(parsed.questions[0]!.options.map((c) => c.value)).toEqual(['a', 'b'])
})

test('[repo] a cursor-marked first option is kept, not dropped', () => {
  expect(parsePaneQuestions('Question: which side?\n→ 1. left\n   2. right\n')!.questions[0]!.options.map((c) => c.label)).toEqual(['left', 'right'])
  expect(parsePaneQuestions('which side?\n→ 1. left\n→ 2. right\n')!.questions[0]!.options.map((c) => c.label)).toEqual(['left', 'right'])
})

test('[repo] parses the tool call out of a session log line', () => {
  const parsed = parseSessionQuestionCalls(call('request_user_input', [{ question: 'which option?', options: [{ label: 'first' }, { label: 'second' }] }]))!
  expect(parsed.questions[0]!.text).toBe('which option?')
  expect(parsed.questions[0]!.options.map((c) => c.value)).toEqual(['first', 'second'])
})

test('[repo] only the newest question call is used', () => {
  const log = [call('ask_user_question', [{ question: 'round one?', options: [{ label: 'A' }, { label: 'B' }] }], 'a'), call('ask_user_question', [{ question: 'round two?', options: [{ label: 'C' }, { label: 'D' }] }], 'b')].join('\n')
  const parsed = parseSessionQuestionCalls(log)!
  expect(parsed.questions.map((q) => q.text)).toEqual(['round two?'])
})

test('[repo] a retried question collapses to one', () => {
  const line = call('request_user_input', [{ question: 'which way?', options: [{ label: 'left' }, { label: 'right' }] }])
  const parsed = parseSessionQuestionCalls([line, line, line].join('\n'))!
  expect(parsed.questions).toHaveLength(1)
  expect(dedupeQuestions([parsed.questions[0]!, { ...parsed.questions[0]!, options: [...parsed.questions[0]!.options] }])).toHaveLength(1)
})

test('[repo] a multi-question call keeps every question whole', () => {
  const parsed = parseSessionQuestionCalls(call('ask_user_question', [1, 2, 3].map((n) => ({ question: `q${n}?`, options: [{ label: `A${n}` }, { label: `B${n}` }] }))))!
  expect(parsed.questions.map((q) => q.text)).toEqual(['q1?', 'q2?', 'q3?'])
})

test('[repo] CRLF parses like LF', () => {
  const line = call('ask_user_question', [{ question: 'crlf?', options: [{ label: 'A' }, { label: 'B' }] }])
  expect(parseSessionQuestionCalls(`${line}\r\n`)?.questions[0]?.text).toBe('crlf?')
  expect(parsePaneQuestions('Question: which side?\r\n→ 1. left\r\n   2. right\r\n')!.questions[0]!.options.map((c) => c.label)).toEqual(['left', 'right'])
})

test('[repo] Korean question text survives and a plain "select" is not multi-select', () => {
  expect(parsePaneQuestions('질문: 어느 쪽으로 할까요?\n1. 왼쪽\n2. 오른쪽\n')!.questions[0]!.text).toBe('어느 쪽으로 할까요?')
  expect(parsePaneQuestions('Question: select the right answer\n1. A\n2. B\n')!.questions[0]!.multiSelect).toBe(false)
  expect(parsePaneQuestions('Question: 여러 개를 고르세요\n1. A\n2. B\n')!.questions[0]!.multiSelect).toBe(true)
})

test('[repo] rows pack 5 buttons; sets split into messages of <=5 rows without losing a question', () => {
  for (const n of [1, 3, 4, 6]) {
    const qs = Array.from({ length: n }, (_, i) => ({ text: `q${i}?`, options: Array.from({ length: 6 }, (_, j) => ({ label: `o${j}`, value: `o${j}` })), multiSelect: false }))
    const rows = questionRows('abc', qs, {}, {}, { other: true })
    expect(rows.every((r) => r.row.components.length <= 5)).toBe(true)
    const chunks = chunkRows(rows)
    expect(chunks.every((c) => c.length <= 5)).toBe(true)
    expect(new Set(chunks.flat().map((r) => r.questionIndex)).size).toBe(n)
    expect(chunks.flat().flatMap((r) => r.row.components).length).toBe(n * 7)
  }
})

test('[repo trap] answering one question disables only that question', () => {
  const qs = [0, 1, 2].map((i) => ({ text: `q${i}?`, options: [{ label: 'A', value: 'A' }, { label: 'B', value: 'B' }], multiSelect: false }))
  const rows = questionRows('abc', qs, { 0: { kind: 'option', index: 1 } }, {}, { other: true })
  expect(rows.filter((r) => r.questionIndex === 0).flatMap((r) => r.row.components).every((b) => b.disabled)).toBe(true)
  expect(rows.filter((r) => r.questionIndex > 0).flatMap((r) => r.row.components).some((b) => b.disabled)).toBe(false)
})

test('custom_id round-trips and rejects foreign ids', () => {
  expect(parseCustomId('oq|ab12|1|3')).toEqual({ id: 'ab12', qi: 1, choice: 3 })
  expect(parseCustomId('oq|ab12|0|w')?.choice).toBe('w')
  expect(parseCustomId('q|0|1')).toBeNull()
  expect(parseCustomId('oq|a b|0|1')).toBeNull()
})

test('real OMO session log: answered and cancelled calls are not open; results decode', () => {
  const log = fx('omo-session-questions.jsonl')
  expect(parseSessionQuestionCalls(log)).toBeNull()
  const ids = log.split('\n').filter((l) => l.includes('"toolCall"')).map((l) => JSON.parse(l).message.content[0].id as string)
  expect(ids).toHaveLength(3)
  expect(questionResult(log, ids[0]!)).toMatchObject({ status: 'answered', text: '색: 보라색 직접입력\n과일: 사과, 포도' })
  expect(questionResult(log, ids[2]!)?.status).toBe('cancelled')
})

test('real OMO session log: the newest call without a result is the open one, with descriptions', () => {
  const lines = fx('omo-session-questions.jsonl').trim().split('\n')
  const open = parseSessionQuestionCalls(lines.slice(0, -1).join('\n'))!
  expect(open.callId).toBe(JSON.parse(lines.at(-2)!).message.content[0].id)
  expect(open.questions.map((q) => q.header)).toEqual(['모드', '알림'])
  expect(open.questions[0]!.options[0]).toMatchObject({ label: '스테이징', description: '먼저 dev 에서 확인' })
  expect(open.questions[1]!.multiSelect).toBe(true)
})

test('real OMO question screens are detected and parsed', () => {
  const single = parseOmoScreen(fx('omo-screen-single.txt'))!
  expect(single).toMatchObject({ tabs: ['확인'], answered: 0, total: 1, review: false })
  expect(single.current).toMatchObject({ text: '진행할까요?', multiSelect: false })
  expect(single.current!.options.map((o) => o.label)).toEqual(['예', '아니오'])

  const q1 = parseOmoScreen(fx('omo-screen-multi-q1.txt'))!
  expect(q1.tabs).toEqual(['모드', '알림'])
  expect(q1.current!.text).toBe('어떤 모드로 배포할까요? 긴 설명이 붙은 질문이 줄바꿈될 때 파서가 잘 버티는지 보려고 일부러 길게 씁니다. 정말 긴 문장입니다.')
  expect(q1.current!.options.map((o) => o.label)).toEqual(['스테이징', '프로덕션'])

  const q2 = parseOmoScreen(fx('omo-screen-multi-q2.txt'))!
  expect(q2).toMatchObject({ answered: 1, total: 2 })
  expect(q2.current).toMatchObject({ text: '누구에게 알릴까요?', multiSelect: true })

  expect(parseOmoScreen(fx('omo-screen-review.txt'))).toMatchObject({ review: true, current: null })
})

test('false positive: a pane that only SHOWS the question-UI strings is not asking', () => {
  // OmOMeow reported herdr-watch firing on a pane whose screen showed questions.ts source code.
  expect(questionUiAtBottom(fx('code-on-screen.txt'))).toBe(false)
  expect(parseOmoScreen(fx('code-on-screen.txt'))).toBeNull()
  // The real UI copied higher up a scrolled screen (not at the bottom) is not asking either.
  expect(questionUiAtBottom(`${fx('omo-screen-single.txt')}\n ANSWER: 확인: 예\n\n more output\n ❯\n${'x\n'.repeat(8)}`)).toBe(false)
  for (const f of ['omo-screen-single.txt', 'omo-screen-multi-q1.txt', 'omo-screen-multi-q2.txt', 'omo-screen-review.txt']) expect(questionUiAtBottom(fx(f))).toBe(true)
})

test('session dir slug resolves /tmp to /private/tmp and the agent dir env wins', () => {
  expect(sessionDirSlug('/tmp')).toBe('--private-tmp--')
  expect(sessionDirSlug('/Users/owner/.omocat')).toBe('--Users-owner-.omocat--')
  expect(sessionRoot({ OMO_CODING_AGENT_DIR: '/x/agent', HOME: '/h' })).toBe('/x/agent/sessions')
  expect(sessionRoot({ HOME: '/h' })).toBe('/h/.omo/agent/sessions')
})
