import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { availableSources, checkSources, manifestOf } from '../../../core/sources'
import { cfg } from '../../../core/config'
import { heartbeat, inbound } from '../source'

test('inbound: a live.ndjson line becomes the common event, ids stay exact past 2^53, own lines are not inbound', () => {
  const [first] = readFileSync(join(import.meta.dir, '..', 'fixtures', 'kakao', 'big-ids.ndjson'), 'utf8').split('\n')
  expect(inbound(first)).toEqual({ source: 'kakao', room: '18000000000000001', id: '3946370721884362755', sender: '9007199254740993123', text: '첫 줄', at: '2026-10-23T08:00:00Z', lane: 'kakao-docs', isOwner: false })
  expect(inbound(first!.replace('"is_from_me":false', '"is_from_me":true'))).toBeNull()
  expect(inbound('not json')).toBeNull()
})

test('the manifest is complete and the test config passes the source check', () => {
  const m = manifestOf('kakao')!
  expect(availableSources().map((x) => x.name)).toContain('kakao')
  expect(Object.keys(m.launchAgents!)).toEqual(['kakao-live', 'kakao-push', 'kakao-health', 'wake-filter-stats'])
  expect(m.defaultAgents!.every((a) => a in m.launchAgents!)).toBe(true)
  expect(checkSources(cfg).errors).toEqual([])
  expect(heartbeat.dependent!('lane:kakao-chat')).toBe(true)
  expect(heartbeat.dependent!('disk:/')).toBe(false)
})
