import { describe, expect, test } from 'bun:test'
import { applyLine, eventKey, isLeftoverCmd, parseEtime, plan, type Snapshot } from '../lane-reaper'

const H = 3_600_000
const NOW = Date.UTC(2026, 9, 23, 12)
const iso = (ago: number) => new Date(NOW - ago).toISOString()

const base = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: NOW,
  lanes: [],
  approvals: {},
  panes: [{ pane_id: 'wW:p6', tab_id: 'wW:t6', terminal_title: 'OmO' }],
  procs: [],
  shells: {},
  lead: { pane: 'wW:p6', tab: 'wW:t6', protectedPids: new Set([111]) },
  ...over,
})

describe('plan', () => {
  test('closed lane with a tab alive 3h after approval is proposed; 1h is not', () => {
    const lane = (ago: number) => ({ key: 'a', status: 'closed', pane: 'w1:p1', tab: 'w1:t1', cwd: '/x' })
    const panes = [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }]
    expect(plan(base({ lanes: [lane(0)], panes, approvals: { a: { mtime: NOW - 3 * H, text: 'approved a' } } }))).toEqual(['LANE_REAP_TAB a tab=w1:t1 age=3h'])
    expect(plan(base({ lanes: [lane(0)], panes, approvals: { a: { mtime: NOW - 1 * H, text: 'approved a' } } }))).toEqual([])
  })

  test('live lane (sessions-map open) overrides stale closed dori state and old approval', () => {
    const lanes = [{ key: 'k', status: 'open', live: true, pane: 'w1:p1', tab: 'w1:t1', cwd: '/x' }]
    const approvals = { k: { mtime: NOW - 99 * H, text: 'approved: standing bot' } }
    expect(plan(base({ lanes, approvals, panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }] }))).toEqual([])
  })

  test('closed lane whose tab is gone proposes nothing', () => {
    const lanes = [{ key: 'a', status: 'closed', tab: 'w1:t1', closedAt: iso(5 * H) }]
    expect(plan(base({ lanes }))).toEqual([])
  })

  test('tab shared with an open lane is not reaped', () => {
    const lanes = [
      { key: 'a', status: 'closed', tab: 'w1:t1', closedAt: iso(5 * H) },
      { key: 'b', status: 'working', tab: 'w1:t1' },
    ]
    expect(plan(base({ lanes, panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }] }))).toEqual([])
  })

  test('lead tab is never proposed even when its lane is closed', () => {
    const lanes = [{ key: 'lead', status: 'closed', pane: 'wW:p6', closedAt: iso(9 * H) }]
    expect(plan(base({ lanes }))).toEqual([])
  })

  test('hold expires after 24h without activity', () => {
    const held = (ago: number) => [{ key: 'h', status: 'hold', history: [{ at: iso(ago), status: 'hold' }], stateMtime: NOW - ago }]
    expect(plan(base({ lanes: held(30 * H) }))).toEqual(['LANE_HOLD_EXPIRED h age=30h'])
    expect(plan(base({ lanes: held(5 * H) }))).toEqual([])
  })

  test('hold recorded in the approval file counts', () => {
    const lanes = [{ key: 'h', status: 'working', stateMtime: NOW - 40 * H }]
    expect(plan(base({ lanes, approvals: { h: { mtime: NOW - 40 * H, text: 'hold until client answers' } } }))).toEqual(['LANE_HOLD_EXPIRED h age=40h'])
  })

  test('leftover dev server under a closed lane cwd is reported, protected pids and open-lane cwds are not', () => {
    const lanes = [{ key: 'c', status: 'closed', cwd: '/Volumes/Data/Outsourcing/app', closedAt: iso(H) }]
    const procs = [
      { pid: 500, ppid: 1, etimeMs: 7 * H, cmd: '/usr/bin/node /x/node_modules/.bin/vite --port 5173', cwd: '/Volumes/Data/Outsourcing/app/web' },
      { pid: 501, ppid: 1, etimeMs: H, cmd: 'node vite', cwd: '/elsewhere' },
      { pid: 111, ppid: 1, etimeMs: H, cmd: 'node vite', cwd: '/Volumes/Data/Outsourcing/app' },
    ]
    expect(plan(base({ lanes, procs }))).toEqual(['LANE_LEFTOVER c pids=500 cmd=node vite --port 5173 age=7h'])
    const withOpen = [...lanes, { key: 'o', status: 'working', cwd: '/Volumes/Data/Outsourcing/app/web' }]
    expect(plan(base({ lanes: withOpen, procs }))).toEqual([])
  })

  test('generic cwd never matches leftovers by cwd', () => {
    const lanes = [{ key: 'c', status: 'closed', cwd: '/Volumes/Data', closedAt: iso(H) }]
    const procs = [{ pid: 500, ppid: 1, etimeMs: H, cmd: 'node vite', cwd: '/Volumes/Data/other' }]
    expect(plan(base({ lanes, procs }))).toEqual([])
  })

  test('pane-tree descendants of a closed lane pane are reported', () => {
    const lanes = [{ key: 'c', status: 'closed', pane: 'w1:p1', closedAt: iso(H) }]
    const procs = [{ pid: 600, ppid: 599, etimeMs: H, cmd: 'python3 -m http.server 8000' }]
    const panes = [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }]
    expect(plan(base({ lanes, procs, panes, paneTreePids: { 'w1:p1': [600] } }))).toContain('LANE_LEFTOVER c pids=600 cmd=python3 -m http.server 8000 age=1h')
  })

  test('empty plain-shell tab older than 24h is proposed, younger or busy or known tabs are not', () => {
    const panes = [
      { pane_id: 'w2:p1', tab_id: 'w2:t1' },
      { pane_id: 'w3:p1', tab_id: 'w3:t1' },
      { pane_id: 'w4:p1', tab_id: 'w4:t1' },
      { pane_id: 'w5:p1', tab_id: 'w5:t1' },
    ]
    const shells = {
      'w2:p1': { shellPid: 1, plain: true, ageMs: 30 * H, idle: true },
      'w3:p1': { shellPid: 2, plain: true, ageMs: 2 * H, idle: true },
      'w4:p1': { shellPid: 3, plain: true, ageMs: 30 * H, idle: false },
      'w5:p1': { shellPid: 4, plain: true, ageMs: 30 * H, idle: true },
    }
    const lanes = [{ key: 'k', status: 'working', tab: 'w5:t1' }]
    expect(plan(base({ panes, shells, lanes }))).toEqual(['LANE_EMPTY_TAB w2:t1 age=30h'])
  })

  test('lead tab is never an empty-tab proposal', () => {
    const shells = { 'wW:p6': { shellPid: 1, plain: true, ageMs: 99 * H, idle: true } }
    expect(plan(base({ shells }))).toEqual([])
  })
})

describe('helpers', () => {
  test('parseEtime handles mm:ss, hh:mm:ss and dd-hh:mm:ss', () => {
    expect(parseEtime('05:10')).toBe(310_000)
    expect(parseEtime('01:00:00')).toBe(H)
    expect(parseEtime('2-01:00:00')).toBe(49 * H)
    expect(parseEtime('junk')).toBe(0)
  })

  test('eventKey drops only the volatile age suffix', () => {
    expect(eventKey('LANE_REAP_TAB a tab=w1:t1 age=3h')).toBe('LANE_REAP_TAB a tab=w1:t1')
  })

  test('leftover command matcher', () => {
    expect(isLeftoverCmd('/Applications/Chromium --headless --remote-debugging-port=0')).toBe(true)
    expect(isLeftoverCmd('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe(false)
    expect(isLeftoverCmd('bun lane-reaper.ts --loop 10')).toBe(false)
    expect(isLeftoverCmd('python3 -m http.server 8000')).toBe(true)
  })
})

describe('applyLine guard', () => {
  test('refuses to close the lead tab and never calls herdr', () => {
    const snap = base()
    expect(applyLine('LANE_REAP_TAB lead tab=wW:t6 age=9h', snap)).toBe('LANE_REAP_REFUSED wW:t6 lead tab')
    expect(applyLine('LANE_EMPTY_TAB wW:t6 age=99h', snap)).toBe('LANE_REAP_REFUSED wW:t6 lead tab')
  })

  test('refuses to kill protected (lead ancestor) pids', () => {
    expect(applyLine('LANE_LEFTOVER c pids=111 cmd=node age=1h', base())).toBe('LANE_REAP_DONE kill c 111:refused')
  })
})
