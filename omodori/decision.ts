// Decision inbox CLI (store: decisions-lib.ts). LaunchAgent com.example.dori.decisions runs `tick` every 5 min.
//   add --q <질문> --opt <A> --opt <B> [--opt <C>] [--due YYYY-MM-DD] [--default <A|보류>] [--cat reversible|money|contract|customer|other] [--reversible] --source <lane> [--context <text>]
//   list [--all] | show <id> | resolve <id> <answer> | cancel <id>
//   sync                      pull button answers from buttons.db, apply due defaults
//   digest [--dry] [--to ch]  post every open decision as buttons (oc.ts ask style) + the heartbeat morning line at 08:30
//   tick [--to ch]            sync, then digest when the 08:30 / 21:00 KST slot is due (once per slot)
import { type Ask, Store, discordRest, herdrCli, newAsk, publish, refresh } from './buttons'
import { answerLabel } from './questions'
import { CATEGORIES, type Category, type Decision, HOLD, add, ageDays, autoDefaultAllowed, line, load, mutate, resolve } from './decisions-lib'
import { DORI, INBOX, flag, kst, opt, post, readJson, writeJson } from './dori-lib'
import { morning, morningAck } from './heartbeat'
import { brief as ledgerBrief, load as loadLedger } from './ledger'
import { cfg } from './config'

const STATE = `${DORI}/heartbeat/decisions-state.json`
const SLOTS = [{ h: 8, m: 30, name: 'am' }, { h: 21, m: 0, name: 'pm' }] as const
type DState = { sent: Record<string, string> }

const opts = (name: string) => process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] ? [process.argv[i + 1]!] : []))
const deps = () => ({ store: new Store(), discord: discordRest(), herdr: herdrCli, emit: () => {} })

async function sync(): Promise<string[]> {
  const store = new Store()
  const today = kst().date
  return mutate((list) => {
    const notes: string[] = []
    for (const d of list) {
      if (d.status !== 'open') continue
      const a = d.askId ? store.get(d.askId) : null
      const ans = a?.status === 'answered' ? a.answers[0] : undefined
      if (a && ans) {
        const label = answerLabel(a.questions[0]!, ans)
        d.askId = undefined
        d.updated = new Date().toISOString()
        if (label === HOLD) { d.held = true; notes.push(`${d.id} ${cfg.owner.title} 보류`); continue }
        d.status = 'resolved'; d.answer = label; d.resolvedBy = 'owner'; d.resolvedAt = d.updated
        notes.push(`${d.id} → ${label}`)
        continue
      }
      if (d.due < today && !d.held) {
        d.updated = new Date().toISOString()
        if (autoDefaultAllowed(d) && d.default !== HOLD) {
          d.status = 'defaulted'; d.answer = d.default; d.resolvedBy = 'default'; d.resolvedAt = d.updated
          notes.push(`${d.id} 기한 지나 기본값 적용: ${d.default}`)
        } else {
          d.held = true
          notes.push(`${d.id} 기한 지나 보류로 둠(${autoDefaultAllowed(d) ? '기본값 보류' : '돈·계약·고객 건이라 자동 적용 안 함'})`)
        }
      }
    }
    return notes
  })
}

const askOptions = (d: Decision) => [...d.options, ...(d.options.includes(HOLD) ? [] : [HOLD])]

// false = the old ask was answered meanwhile: keep it, the next sync reads the answer, do not re-ask.
async function closeOldAsk(d: Decision, dep: ReturnType<typeof deps>): Promise<boolean> {
  const a = d.askId ? dep.store.get(d.askId) : null
  if (!a) return true
  if (!dep.store.claim(a.id, 'open', 'closed')) return dep.store.get(a.id)?.status === 'closed'
  const closed: Ask = { ...a, status: 'closed', note: '다음 묶음으로 옮김 (아래 새 버튼에서 답해 주세요)' }
  dep.store.save(closed)
  await refresh(closed, dep).catch(() => undefined)
  return true
}

async function digest(to: string, dry: boolean, withMorning: boolean) {
  const notes = await sync()
  const open = load().filter((d) => d.status === 'open')
  const asking = open.filter((d) => !d.held)
  const held = open.filter((d) => d.held)
  const oldest = [...open].sort((a, b) => a.created.localeCompare(b.created))[0]
  const mline = withMorning ? morning(true) : ''
  const ledgerLines = withMorning ? ledgerBrief(loadLedger(), Date.now()) : []
  const head = [
    `[결정 인박스] 미결 ${open.length}건${oldest ? ` · 가장 오래된 것 ${oldest.id} ${ageDays(oldest)}일째` : ''}`,
    ...(mline ? [mline] : []),
    ...ledgerLines,
    ...notes.map((n) => `• ${n}`),
    ...(held.length ? [`⏸ 보류 중 ${held.length}건: ${held.map((d) => `${d.id} ${d.question.slice(0, 30)}`).join(' / ')} — 다시 묻고 싶으면 \`decision.ts unhold <id>\``] : []),
    ...(asking.length ? ['아래 버튼으로 골라 주세요. 무응답이면 기한에 기본값(돈·계약·고객 건은 항상 보류).'] : []),
  ].join('\n')
  if (!open.length && !notes.length && !ledgerLines.length && !(mline && (!mline.includes('복구 0건') || mline.includes('아직 문제')))) { console.log('nothing to send'); return }
  if (dry) {
    console.log(`(드라이런 → ${to})\n${head}`)
    for (const d of asking) console.log(`  [버튼] ${d.id} ${d.question} :: ${askOptions(d).join(' | ')} (기본값 ${d.default}, 기한 ${d.due})`)
    return
  }
  await post(to, head)
  if (mline) morningAck()
  const dep = deps()
  for (const d of asking) {
    if (!(await closeOldAsk(d, dep))) continue
    const a = newAsk({
      kind: 'ask', channel: to, other: true,
      title: `**${d.id}** · 출처 ${d.source} · 기한 ${d.due.slice(5)} · 무응답 시 **${d.default}**`,
      questions: [{ text: `${d.question}${d.context ? `\n${d.context.slice(0, 600)}` : ''}`, multiSelect: false, options: askOptions(d).map((l) => ({ label: l.slice(0, 80), value: l })) }],
    })
    await publish(a, dep)
    await mutate((list) => { const x = list.find((y) => y.id === d.id); if (x && x.status === 'open' && x.askId === d.askId) { x.askId = a.id; x.askChannel = to } })
  }
  console.log(`sent: head + ${asking.length} decisions to ${to}`)
}

async function tick(to: string) {
  const notes = await sync()
  if (notes.length) console.log(notes.join('\n'))
  const k = kst()
  const st = readJson<DState>(STATE, { sent: {} })
  for (const s of SLOTS) {
    const key = `${k.date}-${s.name}`
    const due = k.h > s.h || (k.h === s.h && k.mi >= s.m)
    const window = (k.h * 60 + k.mi) - (s.h * 60 + s.m) < 90
    if (!due || !window || st.sent[s.name] === key) continue
    await digest(to, false, s.name === 'am')
    st.sent[s.name] = key
    writeJson(STATE, st)
  }
}

const [cmd, ...rest] = process.argv.slice(2)
switch (cmd) {
  case 'add': {
    const d = await add({
      question: opt('--q') ?? '', options: opts('--opt'), due: opt('--due'), default: opt('--default'),
      category: (opt('--cat') as Category | undefined) ?? 'other', reversible: flag('--reversible'), source: opt('--source') ?? 'lead', context: opt('--context'),
    })
    console.log(`added ${line(d)}`)
    break
  }
  case 'list':
    for (const d of load().filter((d) => flag('--all') || d.status === 'open')) console.log(line(d))
    break
  case 'show':
    console.log(JSON.stringify(load().find((d) => d.id === rest[0]) ?? null, null, 1))
    break
  case 'resolve':
    console.log(`resolved ${line(await resolve(rest[0]!, rest.slice(1).join(' '), 'lead'))}`)
    break
  case 'cancel':
  case 'unhold':
    await mutate((list) => {
      const d = list.find((x) => x.id === rest[0])
      if (!d || d.status !== 'open') throw new Error(`열린 결정 ${rest[0]} 없음`)
      if (cmd === 'cancel') d.status = 'cancelled'
      else {
        d.held = false
        const renewed = kst(new Date(Date.now() + 3 * 86400_000)).date
        if (d.due < renewed) d.due = renewed
      }
      d.updated = new Date().toISOString()
    })
    console.log(`${cmd} ${rest[0]}`)
    break
  case 'sync':
    console.log((await sync()).join('\n') || 'no change')
    break
  case 'digest':
    await digest(opt('--to') ?? INBOX, flag('--dry'), flag('--morning'))
    break
  case 'tick':
    await tick(opt('--to') ?? INBOX)
    break
  default:
    console.error(`usage: decision.ts add|list|show|resolve|cancel|unhold|sync|digest|tick (categories: ${CATEGORIES.join(', ')})`)
    process.exit(2)
}
