// Regression tests for the "gone" event: on 2026-10-23T04:07Z herdr-watch fired
// OMOCAT_HERDR {"event":"gone","pane":"w1W:p3","session":"dori-improve"} while the pane was alive
// and working. `herdr agent list` only lists panes whose agent it has detected, so a single poll
// can omit a live pane (agent restarting / not yet re-detected); gone must be confirmed by two
// consecutive successful listings that both miss the pane.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// herdr-watch opens the buttons DB at import time; keep it out of the live database.
const dir = mkdtempSync(`${tmpdir()}/omocat-herdr-watch-`)
const prevDb = process.env.OMOCAT_BUTTONS_DB
process.env.OMOCAT_BUTTONS_DB = `${dir}/buttons.db`
const { confirmGone, GONE_MISS_LIMIT } = await import('../herdr-watch')
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  if (prevDb === undefined) delete process.env.OMOCAT_BUTTONS_DB
  else process.env.OMOCAT_BUTTONS_DB = prevDb
})

const lane = [{ key: 'dori-improve', pane: 'w1W:p3' }]

// Replays a series of `herdr agent list` snapshots exactly as the loop consumes them: panes in a
// snapshot are recorded in `last`, then confirmGone decides. '' = a successful listing with no panes.
const replay = (snapshots: string[]): string[] => {
  const state = { last: new Map<string, string>(), misses: new Map<string, number>() }
  const events: string[] = []
  snapshots.forEach((snap, i) => {
    const panes = new Set(snap === '' ? [] : snap.split(','))
    for (const pane of panes) state.last.set(pane, 'working')
    for (const hit of confirmGone(lane, (pane) => panes.has(pane), state, i === 0)) events.push(hit.pane)
  })
  return events
}

describe('herdr-watch gone confirmation', () => {
  test('requires two consecutive misses', () => {
    expect(GONE_MISS_LIMIT).toBe(2)
  })

  test('one missed listing then the pane reappears emits nothing', () => {
    expect(replay(['w1W:p3', '', 'w1W:p3'])).toEqual([])
  })

  test('misses separated by a hit never accumulate', () => {
    expect(replay(['w1W:p3', '', 'w1W:p3', ''])).toEqual([])
  })

  test('two consecutive misses emit gone exactly once', () => {
    expect(replay(['w1W:p3', '', '', '', ''])).toEqual(['w1W:p3'])
  })

  test('gone carries the session key, and a second victim only fires after its own two misses', () => {
    const state = { last: new Map([['w1W:p3', 'working'], ['w1X:p2', 'working']]), misses: new Map<string, number>() }
    const both = [{ key: 'dori-improve', pane: 'w1W:p3' }, { key: 'other', pane: 'w1X:p2' }]
    const miss = () => confirmGone(both, () => false, state, false)
    expect(miss()).toEqual([])
    expect(miss()).toEqual([{ pane: 'w1W:p3', session: 'dori-improve' }, { pane: 'w1X:p2', session: 'other' }])
    expect(miss()).toEqual([])
  })

  test('a pane the watcher never saw alive is not reported gone (startup / new lane)', () => {
    expect(replay(['', '', ''])).toEqual([])
  })
})
