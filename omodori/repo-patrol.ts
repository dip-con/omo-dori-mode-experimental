// Repo patrol (LaunchAgent com.example.dori.repo-patrol, daily 09:30). Read-only: never comments, labels or pushes.
// GitLab projects 주인 is a member of + local repos in repo-patrol.json -> up to 5 things 주인 should look at,
// posted to the CEO briefing thread only when something changed since the last patrol. Issues that need his
// decision go to the decision inbox instead (deduped against open decisions by "<alias> ... #<iid>").
//   bun repo-patrol.ts run [--dry] [--to <channel>]      bun repo-patrol.ts summary   (one block for the CEO weekly)
import { existsSync, statSync } from 'node:fs'
import { type AddInput, add, load as loadDecisions } from './decisions-lib'
import { CEO_THREAD, DORI, ageMin, flag, kst, opt, post, readJson, writeJson } from './dori-lib'

type Cfg = { gitlabActiveDays: number; skipProjects: string[]; aliases: Record<string, string>; staleIssueDays: number; localRepos: string[]; uncommittedDays: number; oldWorktreeDays: number }
type Item = { key: string; sig: string; prio: number; text: string; why: string; next: string }
type PState = { lastRun?: string; seen: Record<string, string>; lastItems: Item[]; decisionsAdded: Record<string, string> }

const CFG = readJson<Cfg>(`${DORI}/repo-patrol.json`, null as unknown as Cfg)
export const STATE = `${DORI}/heartbeat/patrol-state.json`
const DECISION_TITLE = /\[(결정 필요|확인 필요|확인 요청)\]|개발\s*승인/
const PARKED_TITLE = /^\[(참고자료|추후확인)\]/
const days = (iso: string) => (Date.now() - Date.parse(iso)) / 86400_000

const sh = async (cmd: string[], cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { out: out.trim(), err: err.trim(), code }
}
const glab = async <T>(path: string): Promise<T> => {
  let r = await sh(['glab', 'api', path])
  for (let i = 0; r.code !== 0 && i < 2; i++) { await Bun.sleep(2000 * (i + 1)); r = await sh(['glab', 'api', path]) }
  if (r.code !== 0) throw new Error(`glab api ${path} failed: ${r.err.slice(0, 160)}`)
  return JSON.parse(r.out) as T
}
export const failed: string[] = []

type Project = { id: number; path_with_namespace: string; path: string; last_activity_at: string; archived?: boolean; web_url: string }
type Issue = { iid: number; title: string; labels: string[]; updated_at: string; created_at: string; web_url: string }
type MR = { iid: number; title: string; draft: boolean; has_conflicts: boolean; detailed_merge_status: string; updated_at: string; created_at: string; web_url: string; head_pipeline?: { status: string } | null }

async function gitlabItems(state: PState, decisions: { key: string; input: AddInput }[]): Promise<Item[]> {
  const items: Item[] = []
  const projects = (await glab<Project[]>('projects?membership=true&per_page=100&simple=true'))
    .filter((p) => !p.archived && !CFG.skipProjects.includes(p.path_with_namespace) && days(p.last_activity_at) <= CFG.gitlabActiveDays)
  const openDecisions = loadDecisions().filter((d) => d.status === 'open')
  for (const p of projects) {
    try { items.push(...(await projectItems(p, state, decisions, openDecisions))) } catch (err) {
      failed.push(p.path)
      console.error(`patrol: ${p.path_with_namespace} skipped: ${(err as Error).message}`)
    }
  }
  return items
}

async function projectItems(p: Project, state: PState, decisions: { key: string; input: AddInput }[], openDecisions: ReturnType<typeof loadDecisions>): Promise<Item[]> {
  const items: Item[] = []
  {
    const alias = CFG.aliases[p.path] ?? p.path
    const inInbox = (iid: number) => openDecisions.some((d) => d.question.includes(alias) && new RegExp(`#${iid}(?!\\d)`).test(`${d.question} ${d.context}`))
    const issues = await glab<Issue[]>(`projects/${p.id}/issues?state=opened&per_page=100`)
    const stale: Issue[] = []
    const fresh: Issue[] = []
    for (const i of issues) {
      if (DECISION_TITLE.test(i.title)) {
        const key = `gl:${p.path_with_namespace}#${i.iid}`
        if (!inInbox(i.iid) && !state.decisionsAdded[key]) {
          decisions.push({ key, input: {
            question: `${alias} #${i.iid} ${i.title.replace(/^\[[^\]]+\]\s*/, '').slice(0, 90)} — 어떻게 할까?`,
            options: ['도리가 진행', '고객에게 확인', '이슈 닫기'], category: 'customer', source: 'repo-patrol',
            context: `GitLab ${p.path_with_namespace} 이슈 #${i.iid} "${i.title.slice(0, 120)}" (마지막 활동 ${i.updated_at.slice(0, 10)}) ${i.web_url}`,
          } })
        }
        continue
      }
      if (PARKED_TITLE.test(i.title) || i.labels.includes('추후확인')) continue
      if (state.lastRun && i.created_at > state.lastRun) fresh.push(i)
      else if (days(i.updated_at) >= CFG.staleIssueDays) stale.push(i)
    }
    if (fresh.length) items.push({ key: `gl:${p.path}:new`, sig: fresh.map((i) => i.iid).join(','), prio: 3,
      text: `${alias} 새 이슈 ${fresh.length}건 (${fresh.slice(0, 4).map((i) => `#${i.iid} ${i.title.slice(0, 30)}`).join(' / ')})`,
      why: '지난 순찰 뒤에 새로 올라옴', next: '담당 레인 배정 또는 우선순위 표시' })
    if (stale.length) items.push({ key: `gl:${p.path}:stale`, sig: stale.map((i) => i.iid).join(','), prio: 4,
      text: `${alias} ${CFG.staleIssueDays}일+ 멈춘 이슈 ${stale.length}건 (${stale.slice(0, 4).map((i) => `#${i.iid}`).join(', ')})`,
      why: `가장 오래된 것 ${Math.floor(Math.max(...stale.map((i) => days(i.updated_at))))}일째 활동 없음`, next: '진행할 것/닫을 것 골라 주기' })
    for (const m of await glab<MR[]>(`projects/${p.id}/merge_requests?state=opened&per_page=50`)) {
      const full = await glab<MR>(`projects/${p.id}/merge_requests/${m.iid}`)
      const pipe = full.head_pipeline?.status
      const key = `gl:${p.path}!${m.iid}`
      if (m.has_conflicts || m.detailed_merge_status === 'need_rebase' || m.detailed_merge_status === 'conflict') {
        items.push({ key, sig: `conflict:${m.updated_at}`, prio: 1, text: `${alias} MR !${m.iid} 충돌 — ${m.title.slice(0, 50)}`, why: '머지 불가 상태', next: '담당 레인에 리베이스 지시' })
      } else if (pipe === 'failed') {
        items.push({ key, sig: `failed:${m.updated_at}`, prio: 1, text: `${alias} MR !${m.iid} 파이프라인 실패 — ${m.title.slice(0, 50)}`, why: 'CI 실패로 막힘', next: '실패 로그 확인 후 수정 지시' })
      } else if (!m.draft && days(m.updated_at) >= 1) {
        items.push({ key, sig: `wait:${m.detailed_merge_status}`, prio: 2, text: `${alias} MR !${m.iid} 머지 대기 ${Math.floor(days(m.created_at))}일 — ${m.title.slice(0, 50)}`, why: `상태 ${m.detailed_merge_status}`, next: '승인·머지 또는 닫기' })
      }
    }
  }
  return items
}

async function localItems(): Promise<Item[]> {
  const items: Item[] = []
  for (const repo of CFG.localRepos) {
    if (!existsSync(`${repo}/.git`)) continue
    const name = repo.split('/').slice(-2).join('/')
    const st = await sh(['git', 'status', '--porcelain'], repo)
    const files = st.out ? st.out.split('\n').map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()!) : []
    if (files.length) {
      const newest = Math.max(...files.map((f) => { try { return statSync(`${repo}/${f}`).mtimeMs } catch { return 0 } }))
      const age = newest ? ageMin(newest) / 1440 : 0
      if (age >= CFG.uncommittedDays) items.push({ key: `local:${name}:dirty`, sig: `${files.length}`, prio: 3,
        text: `${name} 커밋 안 된 변경 ${files.length}개 (마지막 수정 ${Math.floor(age)}일 전)`, why: '작업이 저장소 밖에만 있음(유실 위험)', next: '커밋할지 버릴지 정하기' })
    }
    const ahead = await sh(['git', 'rev-list', '--count', '@{u}..HEAD'], repo)
    if (ahead.code === 0 && Number(ahead.out) > 0) items.push({ key: `local:${name}:ahead`, sig: ahead.out, prio: 2,
      text: `${name} push 안 된 커밋 ${ahead.out}개`, why: '원격에 없음', next: 'push 또는 정리' })
    const wt = await sh(['git', 'worktree', 'list', '--porcelain'], repo)
    const paths = wt.out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).filter((w) => w !== repo)
    const old: string[] = []
    for (const w of paths) {
      if (!existsSync(w)) { old.push(`${w.split('/').pop()}(경로 없음)`); continue }
      const last = await sh(['git', 'log', '-1', '--format=%cI'], w)
      if (last.code === 0 && days(last.out) >= CFG.oldWorktreeDays) old.push(w.split('/').pop()!)
    }
    if (old.length) items.push({ key: `local:${name}:worktrees`, sig: old.join(','), prio: 5,
      text: `${name} 오래된 워크트리 ${old.length}개 (${old.slice(0, 4).join(', ')})`, why: `${CFG.oldWorktreeDays}일+ 커밋 없음`, next: '머지됐으면 정리' })
  }
  return items
}

const render = (items: Item[], added: string[], total: number) => [
  `[저장소 순찰 ${kst().date}] 형이 볼 것 ${items.length}건${total > items.length ? ` (바뀐 것 ${total}건 중 우선 5)` : ''}`,
  ...items.map((it, n) => `${n + 1}. ${it.text}\n   왜: ${it.why} · 다음: ${it.next}`),
  ...(added.length ? [`결정 필요 ${added.length}건은 결정 인박스로 넣음(${added.join(', ')}) — 08:30/21:00 버튼으로 나감`] : []),
].join('\n')

async function run(dry: boolean, to: string) {
  const state = readJson<PState>(STATE, { seen: {}, lastItems: [], decisionsAdded: {} })
  state.decisionsAdded ??= {}
  const decisions: { key: string; input: AddInput }[] = []
  const all = [...(await gitlabItems(state, decisions)), ...(await localItems())].sort((a, b) => a.prio - b.prio)
  const changed = all.filter((it) => state.seen[it.key] !== it.sig)
  const top = changed.slice(0, 5)
  const added: string[] = []
  for (const d of decisions) {
    if (dry) { added.push(`(드라이런) ${d.input.question.slice(0, 40)}`); continue }
    const rec = await add(d.input)
    state.decisionsAdded[d.key] = rec.id
    added.push(rec.id)
  }
  const text = top.length || added.length ? render(top, added, changed.length) : ''
  if (dry) { console.log(text || '(바뀐 것 없음: 보내지 않음)'); console.log(`\n전체 후보 ${all.length}건, 바뀐 것 ${changed.length}건`); return }
  if (text) await post(to, text)
  // Only what was shown (or did not change) counts as seen: changed items beyond the top 5 stay pending for next time.
  const kept = Object.entries(state.seen).filter(([k]) => failed.some((f) => k.startsWith(`gl:${f}`)))
  const shown = new Set(top.map((it) => it.key))
  const nextSeen = all.flatMap((it): [string, string][] => (shown.has(it.key) || state.seen[it.key] === it.sig ? [[it.key, it.sig]] : state.seen[it.key] ? [[it.key, state.seen[it.key]!]] : []))
  state.seen = Object.fromEntries([...kept, ...nextSeen])
  state.lastItems = all.slice(0, 5)
  state.lastRun = new Date().toISOString()
  writeJson(STATE, state)
  console.log(text || `${state.lastRun} no change`)
}

export function summary(): string {
  const s = readJson<PState>(STATE, { seen: {}, lastItems: [], decisionsAdded: {} })
  if (!s.lastRun) return '저장소 순찰: 아직 실행 기록 없음'
  return [`저장소 순찰(${kst(new Date(s.lastRun)).date.slice(5)} 기준) 열린 신호 ${Object.keys(s.seen).length}건, 우선:`, ...s.lastItems.slice(0, 3).map((it) => `  - ${it.text}`)].join('\n')
}

if (import.meta.main) {
  const cmd = process.argv[2]
  if (cmd === 'run') await run(flag('--dry'), opt('--to') ?? CEO_THREAD)
  else if (cmd === 'summary') console.log(summary())
  else { console.error('usage: repo-patrol.ts run [--dry] [--to <channel>] | summary'); process.exit(2) }
}
