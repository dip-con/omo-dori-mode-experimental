// Shared harness of the lane transition tests (core/lane-transition.test.ts and the source tests that exercise a
// source's transition hook). Fake herdr/rpc/session files in a temp home; nothing real is touched.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as T from '../lane-transition'
export { T }

export const FX = join(import.meta.dir, '..', 'fixtures', 'transition')
export const PROFILES = join(import.meta.dir, '..', 'lane-profiles')
export const OLD = '0ld00000-0000-4000-8000-000000000001'
export const KEY = 's8-test-a'
export const GPT = 'chatgpt-subscription/gpt-6-astra'

export const profile = (n: string) => T.loadProfile(n, PROFILES)

export function shellTokens(line: string): string[] {
  const out: string[] = []
  let cur = '', q = false, any = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (q) { if (c === "'") q = false; else cur += c; continue }
    if (c === "'") { q = true; any = true; continue }
    if (c === '\\' && line[i + 1] === "'") { cur += "'"; i++; continue }
    if (c === ' ') { if (cur || any) out.push(cur); cur = ''; any = false; continue }
    cur += c
  }
  if (cur || any) out.push(cur)
  return out
}

export type SeedMode = 'persist' | 'manual' | 'never'
export type HOpts = { seed?: SeedMode; children?: { state: string; running: number }; settled?: boolean[]; crash?: string; noEntry?: boolean; profileKey?: string }
export function harness(o: HOpts = {}) {
  const home = mkdtempSync(join(tmpdir(), 's8-'))
  const sessions = join(home, 'sessions'); mkdirSync(sessions)
  const cwd = join(home, 'cwd'); mkdirSync(cwd)
  const oldPath = join(sessions, `${OLD}.jsonl`)
  copyFileSync(join(FX, 'old-session.jsonl'), oldPath)
  const key = o.profileKey ?? KEY
  if (!o.noEntry) {
    writeFileSync(join(home, 'sessions-map.json'), JSON.stringify({
      [key]: { key, label: 'S8 test', cwd, thread: null, workspace: 'w1', tab: 't-old', pane: 'p-old', sessionId: OLD, status: 'open', openedAt: '2026-10-23T08:00:00Z', generation: 5, sessionPath: oldPath, account: 'default' },
    }))
  }
  const calls: string[] = []
  const sends: { id: string; text: string }[] = []
  const panes = new Map<string, string[]>()
  let n = 0, waitIdleCalls = 0, statusCalls = 0
  const settled = [...(o.settled ?? [true])]
  const h = {
    home, cwd, oldPath, key, calls, sends, panes, crashPlan: o.crash ? [o.crash] : [] as string[], seed: o.seed ?? 'persist',
    get waitIdleCalls() { return waitIdleCalls }, get statusCalls() { return statusCalls },
    sessionFile: (id: string) => join(sessions, `${id}.jsonl`),
    writeSeed(id: string, artifact: string, message: string) {
      const f = h.sessionFile(id)
      const head = existsSync(f) ? '' : `${JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`
      writeFileSync(f, head + JSON.stringify({ type: 'message', id: `u${++n}`, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: `${readFileSync(artifact, 'utf8')}\n${message}` }] } }) + '\n', { flag: 'a' })
    },
    deps: null as any,
  }
  const deps: InstanceType<any> = {
    home, handoffsDir: join(home, 'handoffs'), briefsDir: join(home, 'briefs'), profilesDir: PROFILES,
    herdr: async (...args: string[]) => {
      calls.push(args.join(' '))
      if (args[0] === 'tab' && args[1] === 'create') { n++; return { result: { tab: { tab_id: `t-new${n}` }, root_pane: { pane_id: `p-new${n}` } } } }
      if (args[0] === 'tab' && args[1] === 'close') return null
      if (args[0] === 'pane' && args[1] === 'run') {
        const toks = shellTokens(args[3]!)
        const omo = toks.indexOf('omo')
        panes.set(args[2]!, ['bun', '/x/@code-yeongyu/senpi/dist/bundle/cli.js', '--extension', '/x/omo-ai/plugin', ...toks.slice(omo + 1)])
        const at = toks.find((t) => t.startsWith('@'))
        if (h.seed === 'persist' && at) h.writeSeed(toks[toks.indexOf('--session-id') + 1]!, at.slice(1), toks[toks.indexOf(at) + 1]!)
        return null
      }
      if (args[0] === 'pane' && args[1] === 'process-info') return { result: { process_info: { foreground_processes: panes.has(args[3]!) ? [{ pid: 4242, argv: panes.get(args[3]!) }] : [] } } }
      return null
    },
    herdrText: async (...args: string[]) => {
      calls.push(args.join(' '))
      return `${Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')}\n${'─'.repeat(20)}\n❯ \n${'─'.repeat(20)}\n`
    },
    workspaceFor: async () => 'w1',
    children: async () => o.children ?? { state: 'known', running: 0 },
    status: async () => { statusCalls++; return { settled: settled.length > 1 ? settled.shift()! : settled[0]!, status: 'idle' } },
    waitIdle: async () => { waitIdleCalls++ },
    findSession: (id: string) => (id === OLD ? oldPath : existsSync(h.sessionFile(id)) ? h.sessionFile(id) : null),
    send: async (e: any, text: string, id: string) => {
      sends.push({ id, text })
      if (h.seed === 'never') return { status: 'uncertain', reason: 'no_receipt' }
      const f = h.sessionFile(e.sessionId)
      writeFileSync(f, JSON.stringify({ type: 'custom_message', customType: 'session_control_delivery', content: `${text}\n\n[dori-msg:${id}]`, details: { delivery_id: id }, timestamp: new Date().toISOString() }) + '\n', { flag: 'a' })
      return { status: 'delivered' }
    },
    sessionProcs: async () => [],
    runHook: async (argv: string[]) => { calls.push(`hook ${argv.join(' ')}`); return 0 },
    sleep: async () => {}, now: () => Date.now(), newId: () => crypto.randomUUID(), log: () => {},
    crash: (p: string) => { if (h.crashPlan[0] === p) { h.crashPlan.shift(); throw new T.TransitionCrash(p) } },
    readyTimeoutMs: 0, receiptWaitMs: 0, inflightWaitMs: 0, oldProcWaitMs: 0, accountWaitMs: 0,
  }
  h.deps = deps
  return h
}
export const args = (h: ReturnType<typeof harness>, more: Partial<import('../lane-transition').Args> = {}) => ({ key: h.key, reason: 'manual' as const, profile: 'default', ...more })
export const count = (calls: string[], re: RegExp) => calls.filter((c) => re.test(c)).length
export const occurrences = (file: string, s: string) => readFileSync(file, 'utf8').split(s).length - 1
export async function killLease(home: string, key: string) {
  const p = Bun.spawn(['true']); await p.exited
  const f = join(home, 'lane-leases', key, 'owner.json')
  const o = JSON.parse(readFileSync(f, 'utf8')); o.pid = p.pid
  writeFileSync(f, JSON.stringify(o))
}

