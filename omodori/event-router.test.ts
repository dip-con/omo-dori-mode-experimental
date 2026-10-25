import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Router, classifyEvent, classifyLegacy, digestEveryMs, loadCursor, loadRules } from './event-router'

const DIR = import.meta.dir
const ROUTER = join(DIR, 'event-router.ts')
const rules = loadRules(join(DIR, 'event-rules.json'))
const root = mkdtempSync(join(tmpdir(), 'event-router-test-'))
let n = 0
const fresh = () => { const d = join(root, `case-${++n}`); mkdirSync(d, { recursive: true }); return d }
afterAll(() => Bun.spawnSync(['rm', '-rf', root]))

const ev = (i: number, kind = 'lane.question', extra: object = {}) =>
  JSON.stringify({ v: 2, at: `2026-10-23T08:00:0${i}.000Z`, id: `${kind}:dur-${i}:inst:${i}`, kind, severity: 'info', lane: `lane-${i}`, pane: `w1:p${i}`, thread: null, source: 'supervisor', data: {}, ...extra })
const idOf = (line: string) => JSON.parse(line.slice(line.indexOf(' ') + 1)).id

function collect() {
  const lines: string[] = []
  return { lines, out: (l: string) => lines.push(l) }
}

describe('rule table', () => {
  test('maps event kinds to ask/act/info', () => {
    expect(classifyEvent({ kind: 'lane.question' }, rules)).toBe('ask')
    expect(classifyEvent({ kind: 'lane.quota_all' }, rules)).toBe('ask')
    expect(classifyEvent({ kind: 'lane.quota' }, rules)).toBe('act')
    expect(classifyEvent({ kind: 'lane.transition' }, rules)).toBe('act')
    expect(classifyEvent({ kind: 'lane.turn_done' }, rules)).toBe('info')
    expect(classifyEvent({ kind: 'lane.gone', data: { children: { state: 'known', running: 0 } } }, rules)).toBe('info')
    expect(classifyEvent({ kind: 'lane.gone', data: { children: { state: 'unknown' } } }, rules)).toBe('ask')
    expect(classifyEvent({ kind: 'lane.gone', data: { children: { state: 'known', running: 2 } } }, rules)).toBe('ask')
    // a kind missing from the table falls back to its own severity, then to act (shown in the digest, never hidden)
    expect(classifyEvent({ kind: 'lane.brand_new', severity: 'ask' }, rules)).toBe('ask')
    expect(classifyEvent({ kind: 'lane.brand_new' }, rules)).toBe('act')
  })

  test('every kind in the design list gets a route', () => {
    const kinds = 'lane.opened, lane.session_replaced, lane.turn_done, lane.question, lane.question_closed, lane.blocked, lane.offline, lane.gone, lane.stalled, lane.quota, lane.quota_all, lane.quota_reset, lane.provider_error, lane.usage_stale, lane.context_high, lane.children_changed, lane.dag_run, lane.transition, lane.seed_applied, lane.empty_after_handoff, lane.holder_conflict, lane.account_bound, lane.account_mismatch, lane.closed, delivery.sent, delivery.persisted, delivery.uncertain, delivery.refused, delivery.stuck, kakao.batch, kakao.split, kakao.stuck, kakao.recovered, registry.drift, registry.reconciled, registry.generation_conflict, host.superseded, host.unreachable, digest'.split(', ')
    for (const k of kinds) expect(rules.events.some((r) => r.kind === k)).toBe(true)
  })

  test('legacy sweep lines are classified by the same table', () => {
    expect(classifyLegacy('LANE_QUOTA_ALL k reset=unknown', rules)).toEqual({ route: 'ask', kind: 'lane.quota_all' })
    expect(classifyLegacy('LANE_QUOTA k --to alt', rules)).toEqual({ route: 'act', kind: 'lane.quota' })
    expect(classifyLegacy('NUDGED x', rules).route).toBe('act')
    expect(classifyLegacy('KAKAO_STALL push', rules).route).toBe('info')
    expect(classifyLegacy('KAKAO_STALL live no message for 40 min', rules).route).toBe('ask')
    expect(classifyLegacy('MONITOR_DRIFT dori-sweeps [drift] ...', rules).route).toBe('ask')
    expect(classifyLegacy('LANE_MIGRATED k exit=1 boom', rules).route).toBe('fail')
    expect(classifyLegacy('LANE_MIGRATED k exit=0 ok', rules).route).toBe('act')
    expect(classifyLegacy('REGISTRY_ERROR lock', rules).route).toBe('fail')
    // unknown line that the pre-S6 filter showed: digest, not dropped; plain noise: dropped as before
    expect(classifyLegacy('LANE_SOMETHING_NEW k', rules).route).toBe('act')
    expect(classifyLegacy('random chatter from a sweep', rules).route).toBe('drop')
    expect(classifyLegacy('MONITOR_OK discord running', rules).route).toBe('drop')
  })
})

describe('router', () => {
  test('same event id twice -> emitted once', () => {
    const c = collect()
    const r = new Router({ rules, out: c.out })
    r.line(ev(1)); r.line(ev(1)); r.line(ev(1, 'lane.question', { at: 'other' }))
    expect(c.lines.length).toBe(1)
    expect(c.lines[0]!.startsWith('DORI_ASK ')).toBe(true)
  })

  test('act failures are forced into the digest fail list', () => {
    const c = collect()
    const r = new Router({ rules, out: c.out })
    r.line(ev(1, 'lane.transition', { data: { ok: false } }))
    r.line(ev(2, 'lane.turn_done'))
    expect(r.flush(true)).toBe(true)
    const d = JSON.parse(c.lines[0]!.slice('DORI_DIGEST '.length))
    expect(d.fail.length).toBe(1)
    expect(d.info.length).toBe(1)
    expect(d.info[0].herdr.event).toBe('turn_done')
  })

  test('digest is due after 15 min by day and 60 min at night (KST)', () => {
    const day = Date.parse('2026-10-23T03:00:00Z') // 12:00 KST
    const night = Date.parse('2026-10-23T16:00:00Z') // 01:00 KST
    expect(digestEveryMs(rules, day)).toBe(15 * 60_000)
    expect(digestEveryMs(rules, night)).toBe(60 * 60_000)
    let t = day
    const c = collect()
    const r = new Router({ rules, out: c.out, now: () => t })
    r.line('NUDGED x')
    expect(r.flush()).toBe(false)
    t += 15 * 60_000
    expect(r.flush()).toBe(true)
    expect(r.flush()).toBe(false) // empty digest is omitted
    expect(c.lines.length).toBe(1)
  })

  test('events file replaced mid-stream (new inode): replay from 0 skips ids through lastEventId', () => {
    const d = fresh()
    const file = join(d, 'supervisor.ndjson')
    const all = [1, 2, 3, 4, 5].map((i) => ev(i))
    writeFileSync(file, `${all.join('\n')}\n`)
    const c = collect()
    const r = new Router({ rules, out: c.out, eventsPath: file, cursorPath: join(d, 'cursor.json') })
    for (const l of all.slice(0, 3)) r.line(l)
    const ino1 = statSync(file).ino
    writeFileSync(`${file}.new`, `${all.join('\n')}\n`)
    renameSync(`${file}.new`, file)
    expect(statSync(file).ino).not.toBe(ino1)
    for (const l of all) r.line(l) // tail -F replays the replacement from line 1
    expect(c.lines.map(idOf)).toEqual([1, 2, 3, 4, 5].map((i) => `lane.question:dur-${i}:inst:${i}`))
    const cur = loadCursor(join(d, 'cursor.json'))
    expect(cur.fileIno).toBe(Number(statSync(file).ino))
    expect(cur.lastEventId).toBe(`lane.question:dur-5:inst:5`)
  })

  test('restart on a replaced file (new inode): offset 0, ids <= lastEventId skipped, new ids emitted', () => {
    const d = fresh()
    const file = join(d, 'supervisor.ndjson')
    const cursorPath = join(d, 'cursor.json')
    const all = [1, 2, 3, 4, 5].map((i) => ev(i))
    writeFileSync(file, `${all.slice(0, 3).join('\n')}\n`)
    const c1 = collect()
    const r1 = new Router({ rules, out: c1.out, eventsPath: file, cursorPath })
    for (const l of all.slice(0, 3)) r1.line(l)
    expect(c1.lines.length).toBe(3)
    // rotated: the new file (new inode) keeps the old lines and grows by two
    writeFileSync(`${file}.new`, `${all.join('\n')}\n`)
    renameSync(`${file}.new`, file)
    const c2 = collect()
    const r2 = new Router({ rules, out: c2.out, eventsPath: file, cursorPath, cursor: loadCursor(cursorPath) })
    for (const l of all) r2.line(l)
    expect(c2.lines.map(idOf)).toEqual([`lane.question:dur-4:inst:4`, `lane.question:dur-5:inst:5`])
    // a fresh file without lastEventId: everything new is emitted, already-seen ids still are not
    const next = [6, 7].map((i) => ev(i))
    writeFileSync(`${file}.new`, `${[all[0], ...next].join('\n')}\n`)
    renameSync(`${file}.new`, file)
    const c3 = collect()
    const r3 = new Router({ rules, out: c3.out, eventsPath: file, cursorPath, cursor: loadCursor(cursorPath) })
    for (const l of [all[0]!, ...next]) r3.line(l)
    expect(c3.lines.map(idOf)).toEqual([`lane.question:dur-6:inst:6`, `lane.question:dur-7:inst:7`])
  })
})

async function readLines(stream: ReadableStream<Uint8Array>, want: number, timeoutMs = 10_000): Promise<string[]> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const lines: string[] = []
  const timer = setTimeout(() => reader.cancel(), timeoutMs)
  try {
    while (lines.length < want) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1) }
    }
  } finally { clearTimeout(timer); reader.releaseLock() }
  return lines
}

describe('router process', () => {
  test('killed after consuming 3 of 5 events, restarted with router-cursor.json -> only the remaining 2', async () => {
    const home = fresh()
    const file = join(home, 'events', 'supervisor.ndjson')
    mkdirSync(join(home, 'events'), { recursive: true })
    const all = [1, 2, 3, 4, 5].map((i) => ev(i))
    writeFileSync(file, `${all.join('\n')}\n`)
    const env = { ...process.env, OMOCAT_HOME: home }
    const p1 = Bun.spawn(['bun', ROUTER, '--events', file], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
    p1.stdin.write(`${all.slice(0, 3).join('\n')}\n`)
    await p1.stdin.flush()
    const first = await readLines(p1.stdout, 3)
    expect(first.map(idOf)).toEqual([1, 2, 3].map((i) => `lane.question:dur-${i}:inst:${i}`))
    p1.kill('SIGKILL')
    await p1.exited
    const cur = JSON.parse(readFileSync(join(home, 'state', 'router-cursor.json'), 'utf8'))
    expect(cur.lastEventId).toBe('lane.question:dur-3:inst:3')
    // restart: `tail -n +1 -F` replays the whole file
    const p2 = Bun.spawn(['bun', ROUTER, '--events', file], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
    p2.stdin.write(`${all.join('\n')}\n`)
    await p2.stdin.end()
    const out = (await new Response(p2.stdout).text()).split('\n').filter((l) => l.startsWith('DORI_'))
    await p2.exited
    expect(out.map(idOf)).toEqual([4, 5].map((i) => `lane.question:dur-${i}:inst:${i}`))
  })

  test('--now: legacy sweep lines -> 1 DORI_ASK + 1 DORI_DIGEST (act 2, info 1)', async () => {
    const p = Bun.spawn(['bun', ROUTER, '--now'], { env: { ...process.env, OMOCAT_HOME: fresh() }, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
    p.stdin.write('NUDGED x\nLANE_QUOTA_ALL k reset=unknown\nKAKAO_STALL push\nLANE_QUOTA k --to alt\n')
    await p.stdin.end()
    const lines = (await new Response(p.stdout).text()).split('\n').filter(Boolean)
    expect(await p.exited).toBe(0)
    const dori = lines.filter((l) => l.startsWith('DORI_'))
    expect(dori.length).toBe(2)
    expect(dori.filter((l) => l.startsWith('DORI_ASK ')).map((l) => JSON.parse(l.slice(9)).kind)).toEqual(['lane.quota_all'])
    const dg = dori.filter((l) => l.startsWith('DORI_DIGEST '))
    expect(dg.length).toBe(1)
    const d = JSON.parse(dg[0]!.slice('DORI_DIGEST '.length))
    expect(d.act.length).toBe(2)
    expect(d.info.length).toBe(1)
  })
})

describe('monitors-check survives lead session replacement', () => {
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-')
  const defs = JSON.parse(readFileSync(join(DIR, 'monitors.json'), 'utf8'))
  function fixture(opts: { newAgeMin: number; monitorsAlive: boolean }) {
    const home = fresh()
    const sessions = join(home, 'sessions', '--Users-owner--')
    const bin = join(home, 'bin')
    mkdirSync(sessions, { recursive: true }); mkdirSync(bin, { recursive: true })
    const now = Date.now()
    const oldAt = now - 2 * 86_400_000
    const newAt = now - opts.newAgeMin * 60_000
    const code = defs.monitors.map((d: any) => `await tool.monitor({ description: ${JSON.stringify(d.description)}, command: ${JSON.stringify(d.command)}, filter: ${JSON.stringify(d.filter)}, persistent: true })`).join('\n')
    const reg = { type: 'message', timestamp: new Date(oldAt + 60_000).toISOString(), message: { role: 'assistant', content: [{ type: 'toolCall', name: 'eval', arguments: { code } }] } }
    writeFileSync(join(sessions, `${stamp(oldAt)}_aaaa-1111.jsonl`), `${JSON.stringify(reg)}\n`)
    writeFileSync(join(sessions, `${stamp(newAt)}_bbbb-2222.jsonl`), `${JSON.stringify({ type: 'session', timestamp: new Date(newAt).toISOString() })}\n`)
    writeFileSync(join(home, 'sessions-map.json'), JSON.stringify({
      'dandori-lead-old': { key: 'dandori-lead-old', status: 'closed', sessionId: 'aaaa-1111', pane: 'wW:p6' },
      'dandori-lead-new': { key: 'dandori-lead-new', status: 'open', sessionId: 'bbbb-2222', pane: 'wW:p6' },
    }))
    copyFileSync(join(DIR, 'monitors.json'), join(home, 'monitors.json'))
    // the lead pane's foreground process is the replacement session; the monitors still hang off the previous session's process
    const pi = { result: { process_info: { foreground_process_group_id: 2000, foreground_processes: [{ pid: 2000, argv: ['bun', 'cli.js', '--session', 'bbbb-2222'] }] } } }
    writeFileSync(join(bin, 'herdr'), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(pi)}\nEOF\n`)
    const ps = ['2000 1 bun cli.js --session bbbb-2222', '1000 1 bun cli.js --session aaaa-1111']
    if (opts.monitorsAlive) defs.monitors.forEach((d: any, i: number) => ps.push(`${1100 + i} 1000 /bin/bash -c ${d.match} x`))
    writeFileSync(join(bin, 'ps'), `#!/bin/sh\ncat <<'EOF'\n${ps.join('\n')}\nEOF\n`)
    chmodSync(join(bin, 'herdr'), 0o755); chmodSync(join(bin, 'ps'), 0o755)
    return { OMOCAT_HOME: home, OMO_SESSIONS_DIR: join(home, 'sessions'), PATH: `${bin}:${process.env.PATH}` }
  }
  const run = (env: Record<string, string>) => {
    const p = Bun.spawnSync(['bun', join(DIR, 'monitors-check.ts'), '--once'], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
    return p.stdout.toString().trim().split('\n')
  }

  test('two lead jsonl files, replaced 30 min ago, monitors alive -> no MONITOR_MISSING, registrations found', () => {
    const out = run(fixture({ newAgeMin: 30, monitorsAlive: true }))
    expect(out.length).toBe(defs.monitors.length)
    for (const l of out) expect(l.startsWith('MONITOR_OK ')).toBe(true)
  })

  test('replaced 30 min ago, monitors not restored yet -> MONITOR_PENDING, not MISSING', () => {
    const out = run(fixture({ newAgeMin: 30, monitorsAlive: false }))
    expect(out.some((l) => l.startsWith('MONITOR_MISSING'))).toBe(false)
    for (const l of out) expect(l.startsWith('MONITOR_PENDING ')).toBe(true)
  })

  test('replaced 2 h ago and still not running -> MONITOR_MISSING (true positive kept)', () => {
    const out = run(fixture({ newAgeMin: 120, monitorsAlive: false }))
    for (const l of out) expect(l.startsWith('MONITOR_MISSING ')).toBe(true)
  })
})
