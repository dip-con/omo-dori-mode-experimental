// bun test lane-health.test.ts
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOwnState } from './lane-health'

const dir = () => mkdtempSync(join(tmpdir(), 'lane-health-'))

describe('lane-health own state file (borrowed rule: corrupt state quarantine)', () => {
  test('a state file that does not parse is moved to <file>.corrupt-<ms>, reported in one line, and the sweep continues empty', () => {
    const d = dir(), p = join(d, 'lane-health-state.json')
    writeFileSync(p, '{"rpc-smoke": {"sig": "quota:alt"')
    const r = readOwnState(p, true, 1_700_000_000_000)
    expect(r.state).toEqual({})
    expect(existsSync(p)).toBe(false)
    expect(readdirSync(d)).toEqual(['lane-health-state.json.corrupt-1700000000000'])
    expect(readFileSync(join(d, 'lane-health-state.json.corrupt-1700000000000'), 'utf8')).toBe('{"rpc-smoke": {"sig": "quota:alt"')
    expect(r.line).toStartWith('LANE_HEALTH_STATE_CORRUPT ')
    const again = readOwnState(p, true, 1_700_000_000_001)
    expect(again).toEqual({ state: {}, line: null })
  })

  test('valid JSON that is not an object (null, array) is corrupt too', () => {
    for (const body of ['null', '[]']) {
      const d = dir(), p = join(d, 's.json')
      writeFileSync(p, body)
      expect(readOwnState(p, true, 5).state).toEqual({})
      expect(readdirSync(d)).toEqual(['s.json.corrupt-5'])
    }
  })

  test('missing file -> empty state, no line; a good file is read as is', () => {
    const d = dir(), p = join(d, 's.json')
    expect(readOwnState(p, true)).toEqual({ state: {}, line: null })
    writeFileSync(p, JSON.stringify({ a: { sig: 'stalled:', at: 1 } }))
    expect(readOwnState(p, true)).toEqual({ state: { a: { sig: 'stalled:', at: 1 } }, line: null })
  })

  test('read-only mode (--once) reports but never moves the file', () => {
    const d = dir(), p = join(d, 's.json')
    writeFileSync(p, 'garbage')
    const r = readOwnState(p, false, 7)
    expect(r.state).toEqual({})
    expect(r.line).toStartWith('LANE_HEALTH_STATE_CORRUPT ')
    expect(readdirSync(d)).toEqual(['s.json'])
  })
})
