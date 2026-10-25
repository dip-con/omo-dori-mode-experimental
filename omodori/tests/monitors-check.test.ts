import { expect, test } from 'bun:test'
import { evaluate, lines, type MonitorDef, registrations } from '../monitors-check'

const defs: MonitorDef[] = [
  { name: 'herdr', match: 'bun herdr-watch.ts', description: 'Herdr', command: 'cd ~/.omocat && exec bun herdr-watch.ts 2>&1', filter: '^OMOCAT_HERDR ' },
  { name: 'sweeps', match: 'dori-monitors.sh', description: 'sweeps', command: 'bash ~/.omocat/dori-monitors.sh', filter: '^(LANE_|MONITOR_)' },
]
const call = (ts: string, code: string) => JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'assistant', content: [{ type: 'toolCall', name: 'eval', arguments: { code } }] } })

test('registrations come only from real persistent tool.monitor calls, latest wins', () => {
  const text = [
    call('2026-10-18T08:00:00Z', `await tool.monitor({description:'Herdr',command:'cd ~/.omocat && exec bun herdr-watch.ts 2>&1',filter:'^OMOCAT_HERDR ',persistent:true}); await tool.monitor({command:'bash ~/.omocat/dori-monitors.sh',filter:'^(LANE_)',persistent:true})`),
    call('2026-10-23T04:00:00Z', `const brief = "mentions dori-monitors.sh and persistent monitors"`),
  ].join('\n')
  const r = registrations(text, defs)
  expect(r.get('herdr')).toEqual({ at: Date.parse('2026-10-18T08:00:00Z'), filter: '^OMOCAT_HERDR ' })
  expect(r.get('sweeps')?.filter).toBe('^(LANE_)')
})

test('missing, day-6 expiring and filter drift are reported with a paste-ready re-register call', () => {
  const regs = new Map([['herdr', { at: Date.parse('2026-10-18T08:00:00Z'), filter: '^OMOCAT_HERDR ' }], ['sweeps', { at: Date.parse('2026-10-22T08:00:00Z'), filter: '^(LANE_)' }]])
  const st = evaluate(defs, new Set(['sweeps']), regs, Date.parse('2026-10-24T09:00:00Z'))
  expect(st[0]!.problems).toEqual(['missing', 'expiring'])
  expect(st[1]!.problems).toEqual(['drift'])
  const ls = lines(st)
  expect(ls[0]).toStartWith('MONITOR_MISSING herdr')
  expect(ls[0]).toContain('tool.monitor({ description: "Herdr"')
  expect(ls[1]).toStartWith('MONITOR_DRIFT sweeps')
})
