// Lane tools for the decision inbox: decision_add (ask 주인 through the 08:30 / 21:00 button digest instead of
// ask_user_question, which gets buried in the pane) and decision_check (read the answer later).
// Wiring (the lead does it; see docs/decision-inbox.md):
//   in a lane ext:  import { registerDecisionTools } from './decision-tools'; registerDecisionTools(pi, '<lane-key>')
//   or standalone:  omo ... -e ~/.omocat/decision-tools.ts  with DORI_LANE_KEY=<lane-key> in the env
// and add decision_add,decision_check to the lane's --tools list when it has one.
import { CATEGORIES, type Category, HOLD, add, line, load } from './decisions-lib'

const text = (t: string) => ({ content: [{ type: 'text', text: t }], details: {} })

export function registerDecisionTools(pi: any, lane: string) {
  pi.registerTool({
    name: 'decision_add',
    label: 'Decision inbox: ask 주인',
    description: `주인(형)에게 결정을 받아야 할 때 쓴다. 질문은 한 줄, 선택지 2~3개, 기한, 무응답 시 기본값을 붙인다. 하루 두 번(08:30, 21:00) #인박스 채널에 버튼으로 몰아서 나가고, 형이 누르면 decision_check 로 답을 확인한다. 돈·계약·고객에게 보내는 메시지에 관한 결정은 category 를 money/contract/customer 로 두면 기본값이 항상 "${HOLD}"가 된다. 되돌릴 수 있는 결정(reversible=true)만 기한이 지나면 기본값이 자동 적용된다. 급한 건(오늘 안에 답이 필요)은 이 도구 대신 리드에게 바로 알린다.`,
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '형이 3초 안에 이해할 질문 한 줄' },
        options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3, description: '선택지 2~3개, 각 80자 이하' },
        due: { type: 'string', description: '기한 YYYY-MM-DD (없으면 3일 뒤)' },
        default: { type: 'string', description: `무응답 시 기본값: 선택지 중 하나 또는 "${HOLD}"` },
        category: { type: 'string', enum: [...CATEGORIES], description: 'money/contract/customer 면 기본값은 항상 보류' },
        reversible: { type: 'boolean', description: '나중에 되돌릴 수 있는 결정이면 true' },
        context: { type: 'string', description: '판단에 필요한 배경 2~3줄 (근거 경로·링크)' },
      },
      required: ['question', 'options'],
    },
    async execute(_id: string, p: Record<string, any>) {
      try {
        const d = await add({ question: p.question, options: p.options, due: p.due, default: p.default, category: p.category as Category | undefined, reversible: !!p.reversible, context: p.context, source: lane })
        return text(`등록됨: ${line(d)}\n다음 묶음(08:30/21:00)에 형에게 버튼으로 나간다. 답은 decision_check id=${d.id} 로 확인.`)
      } catch (err) {
        return text(`등록 실패: ${(err as Error).message}`)
      }
    },
  })
  pi.registerTool({
    name: 'decision_check',
    label: 'Decision inbox: read answers',
    description: '내가 decision_add 로 올린 결정의 상태와 형의 답을 본다. id 를 주면 그 건만, 없으면 이 레인이 올린 전부.',
    parameters: { type: 'object', properties: { id: { type: 'string' } } },
    async execute(_id: string, p: Record<string, any>) {
      const mine = load().filter((d) => (p.id ? d.id === p.id : d.source === lane))
      return text(mine.length ? mine.map(line).join('\n') : '해당 결정 없음')
    },
  })
}

export default function (pi: any) {
  registerDecisionTools(pi, process.env.DORI_LANE_KEY ?? 'unknown-lane')
}
