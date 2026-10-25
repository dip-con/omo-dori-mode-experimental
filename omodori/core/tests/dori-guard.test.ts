import { describe, expect, test } from 'bun:test'
import { checkCommand, type GuardEnv } from '../dori-guard'

const env = (pgrep: GuardEnv['pgrep'] = () => []): GuardEnv => ({
  channels: new Map([['1000000000000000001', '#일반'], ['1000000000000000012', '#app']]),
  leadPane: 'wW:p6', leadTab: 'wW:t2', leadWorkspace: 'wW',
  protectedPids: new Set([90395, 19430, 500]),
  pgrep,
})

describe('channel guard', () => {
  test('dori launch with #일반 is blocked', () => {
    expect(checkCommand('dori launch x --title T --brief b.md --done "d" --thread discord:1000000000000000001', env())?.kind).toBe('channel')
  })
  test('dori launch with a project channel via --thread= is blocked', () => {
    expect(checkCommand('cd /tmp && dori launch x --thread=1000000000000000012', env())?.kind).toBe('channel')
  })
  test('sess.ts open with a project channel as thread is blocked', () => {
    expect(checkCommand('bun ~/.omodori/sess.ts open k "L" /tmp brief.md 1000000000000000012', env())?.kind).toBe('channel')
  })
  test('the channel-bound side-project session (and its migrations) may open in #사이드', () => {
    const e = env(); e.channels.set('1000000000000000011', '#side-project')
    expect(checkCommand('bun ~/.omodori/sess.ts open side-project-m1 "L" /tmp h.md 1000000000000000011', e)).toBeNull()
    expect(checkCommand('bun ~/.omodori/sess.ts open other "L" /tmp h.md 1000000000000000011', e)?.kind).toBe('channel')
  })
  test('a real thread id passes', () => {
    expect(checkCommand('dori launch x --thread discord:1000000000000000006', env())).toBeNull()
    expect(checkCommand('bun ~/.omodori/sess.ts open k "L" /tmp brief.md 1000000000000000006', env())).toBeNull()
  })
})

describe('kill guard', () => {
  test('kill of the lead pid is blocked, with or without a signal', () => {
    expect(checkCommand('kill 90395', env())?.kind).toBe('kill')
    expect(checkCommand('kill -9 90395', env())?.kind).toBe('kill')
    expect(checkCommand('echo hi; kill -s TERM 19430', env())?.kind).toBe('kill')
  })
  test('kill of self refs and process groups is blocked', () => {
    expect(checkCommand('kill $PPID', env())?.kind).toBe('kill')
    expect(checkCommand('kill -9 -1', env())?.kind).toBe('kill')
  })
  test('kill of an unrelated pid passes', () => {
    expect(checkCommand('kill -9 12345', env())).toBeNull()
  })
  test('pkill matching a protected pid is blocked, a harmless one passes', () => {
    expect(checkCommand('pkill -f senpi', env(() => [90395, 777]))?.kind).toBe('kill')
    expect(checkCommand('pkill -f chat-push', env(() => [777]))).toBeNull()
  })
  test('herdr close of the lead pane, tab or workspace is blocked', () => {
    expect(checkCommand('herdr pane close wW:p6', env())?.kind).toBe('kill')
    expect(checkCommand('herdr tab close wW:t2', env())?.kind).toBe('kill')
    expect(checkCommand('herdr pane close wW:p9', env())).toBeNull()
  })
  test('unrelated commands are not evaluated', () => {
    let called = false
    expect(checkCommand('ls -la', () => { called = true; return env() })).toBeNull()
    expect(called).toBe(false)
  })
})
