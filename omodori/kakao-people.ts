// Builds per-person chat-habit notes for the 장도리 group rooms from the last 400 messages of each room.
// kakao-push.ts attaches the note of everyone in a batch, so 장도리 answers each person in their own way.
// Run by jangdori-restart.sh (05:00 / 15:00) before the lane restarts; `bun kakao-people.ts` refreshes by hand.
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { cfg } from './config'

type Room = { name: string; owner: string[]; ownerOnly?: boolean; pinned?: boolean }
type Person = { name: string; note: string; seenAt: string }
const HOME = process.env.HOME!
const OUT = `${HOME}/.omocat/sa-cache/kakao-people.json`
const ROOMS: Record<string, Room> = JSON.parse(readFileSync(`${HOME}/.omocat/kakao-rooms.json`, 'utf8'))
const BOTS = new Set(['오픈채팅봇'])
const kst = (t: string) => new Date(Date.parse(t) + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')

const lines: string[] = []
const counts = new Map<string, { name: string; n: number }>()
const owners = new Set(Object.values(ROOMS).flatMap((r) => r.owner))
for (const [chat, room] of Object.entries(ROOMS)) {
  if (room.ownerOnly || room.pinned) continue
  const ms = (await (await fetch(`http://127.0.0.1:${cfg.kakao.locoPort}/messages?chat=${chat}&count=400`, { signal: AbortSignal.timeout(30_000) })).json()) as any[]
  lines.push(`## ${room.name}`)
  for (const m of [...ms].reverse()) {
    const name = m.is_from_me ? '장도리' : owners.has(m.sender_id) ? '주인(주인)' : (m.sender ?? m.sender_id)
    lines.push(`${kst(m.timestamp)} ${name}: ${m.photo_url ? '[사진]' : String(m.text ?? '').replace(/\n/g, ' / ').slice(0, 200)}`)
    if (m.is_from_me || owners.has(m.sender_id) || BOTS.has(name)) continue
    const c = counts.get(m.sender_id) ?? { name, n: 0 }
    c.n++
    counts.set(m.sender_id, c)
  }
}
const targets = [...counts.entries()].filter(([, c]) => c.n >= 3)
if (!targets.length) process.exit(0)

const prompt = `아래는 카카오톡 단톡방 대화 기록이다. 각 사람의 대화 패턴을 메모해라.
대상(아이디: 닉네임): ${targets.map(([id, c]) => `${id}: ${c.name}`).join(', ')}
사람마다 한국어 한두 문장, 100자 이내로 그 사람에 대한 사실만: 말투, 자주 쓰는 말이나 드립, 관심사(게임·취미 등), 장도리(봇)를 대하는 태도(놀리는지, 자주 부르는지, 뭘 시키는지, 호칭을 바꾸라고 했는지).
장도리가 어떻게 말해야 한다는 조언(존댓말, 정중하게, 따뜻하게, 맞춰주기 등)은 쓰지 마라. 장도리 말투는 따로 정해져 있다.
대화에서 보이는 것만 쓰고 추측하지 마라. 실명, 주소, 연락처, 직장, 나이, 건강, 가족, 결혼·연애 같은 사생활은 쓰지 마라.
출력은 JSON 하나만: {"<아이디>": "<메모>", ...}

${lines.join('\n')}`

const p = Bun.spawn(['omo', '-p', prompt, '--model', 'chatgpt-subscription/gpt-6-luna-fast', '--thinking', 'off', '--no-session'], { cwd: '/tmp', stdout: 'pipe', stderr: 'pipe' })
const timer = setTimeout(() => p.kill(), 180_000)
const out = await new Response(p.stdout).text()
await p.exited
clearTimeout(timer)
const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)
const notes: Record<string, string> = JSON.parse(json)

let prev: Record<string, Person> = {}
try { prev = JSON.parse(readFileSync(OUT, 'utf8')) } catch {}
const now = new Date().toISOString()
for (const [id, c] of targets) {
  if (typeof notes[id] === 'string' && notes[id].trim()) prev[id] = { name: c.name, note: notes[id].trim().slice(0, 160), seenAt: now }
}
writeFileSync(`${OUT}.tmp`, JSON.stringify(prev, null, 1))
renameSync(`${OUT}.tmp`, OUT)
console.log(new Date().toISOString(), 'people notes', Object.keys(notes).length, 'of', targets.length)
