# 결정 인박스 사용법 (v1, 2026-10-17)

형(주인)에게 받아야 하는 결정을 pane 안의 ask_user_question이나 in-flight.md 텍스트에 두지 않고 한 큐에 모은다.
하루 두 번(08:30, 21:00 KST) **#인박스 채널(1000000000000000002)**에 버튼으로 몰아서 보낸다(형 10-17 지시. 다른 곳으로 보내려면 `--to <채널>`).

## 파일
| 파일 | 역할 |
|---|---|
| `~/.omodori/decisions.jsonl` | 결정 한 건이 한 줄. 필드: id, question, options(2~3), due, default, category, reversible, source(출처 레인), context, status(open/resolved/defaulted/cancelled), held, answer, resolvedBy, askId |
| `~/.omodori/decisions-lib.ts` | 저장·검증·안전 규칙(공통) |
| `~/.omodori/decision.ts` | CLI와 묶음 발송 |
| `~/.omodori/decision-tools.ts` | 레인용 도구 `decision_add`, `decision_check` |
| `~/.omodori/launchagents/com.example.dori.decisions.plist` | 5분마다 `tick`: 버튼 답 반영, 기한 처리, 08:30/21:00 묶음 발송 |

## 안전 규칙 (형 10-17)
- category가 `money`, `contract`, `customer`(고객에게 나가는 메시지)이면 기본값은 **항상 "보류"**다. 넣을 때 다른 값을 줘도 보류로 바뀐다.
- 기한이 지나면 기본값을 자동 적용하는 건 `reversible=true`이면서 위 세 분류가 아닌 결정뿐이다. 나머지는 기한이 지나면 "보류 중"으로 남고, 묶음 머리글에 계속 보인다.
- 버튼에는 항상 "보류"가 들어간다. 형이 보류를 누르면 버튼 질문은 멈추고 머리글의 보류 목록에만 남는다(`decision.ts unhold <id>`로 다시 묻는다).
- 기본값이 적용돼도 도리가 실제 행동(배포, 발송, 결제)을 자동으로 하지는 않는다. 결과는 `status=defaulted`로 기록만 되고, 실행은 출처 레인이 `decision_check`로 확인한 뒤 한다.

## 레인에서 쓰기
레인 브리프에 아래 한 줄을 넣는다.
> 형에게 결정이 필요하면 ask_user_question 대신 `decision_add`를 써라(질문 한 줄, 선택지 2~3개, 기한, 무응답 시 기본값, 돈·계약·고객 건은 category 지정). 오늘 안에 답이 필요한 급한 건만 리드에게 바로 알려라.

### 연결 방법 (리드가 한다. 돌고 있는 레인의 ext 파일은 이번 작업에서 고치지 않았다)
1. 레인 ext가 있으면 두 줄을 넣는다.
   ```ts
   import { registerDecisionTools } from './decision-tools'
   // export default function (pi) { ... 안에서
   registerDecisionTools(pi, '<lane-key>')
   ```
2. ext가 없는 레인은 실행 인자에 `-e ~/.omodori/decision-tools.ts`를 넣고 환경변수 `DORI_LANE_KEY=<lane-key>`를 준다.
3. 레인이 `--tools` 허용 목록을 쓰면 `decision_add,decision_check`를 추가한다.
4. 적용은 다음 재시작 때 `lane-restart.sh <key> --live`로 한다. 작업 중인 레인은 기다린다.

## CLI
```bash
cd ~/.omodori
bun decision.ts add --q "질문" --opt A --opt B [--opt C] [--due 2026-10-20] [--default A|보류] \
  [--cat reversible|money|contract|customer|other] [--reversible] --source <lane> [--context "배경"]
bun decision.ts list [--all]          # 미결(또는 전체)
bun decision.ts show D-1017-01
bun decision.ts resolve D-1017-01 A   # 형이 디스코드 글로 답했을 때 리드가 기록
bun decision.ts cancel D-1017-01      # 더 이상 필요 없음
bun decision.ts unhold D-1017-01      # 보류를 풀고 다시 버튼으로 묻기
bun decision.ts sync                  # 버튼 답 반영과 기한 처리(tick이 5분마다 함)
bun decision.ts digest --dry          # 지금 보낼 묶음 미리 보기
bun decision.ts digest [--to <채널>] [--morning]   # 바로 보내기(--morning은 하트비트 아침 줄 포함)
```

## 흐름
1. 레인이 `decision_add`를 부르거나 리드가 `decision.ts add`로 넣는다. `decisions.jsonl`에 `open`으로 들어간다.
2. 08:30/21:00 tick이 머리글 한 장("미결 N건, 가장 오래된 것", 08:30에는 하트비트 밤사이 복구 한 줄)과 결정별 버튼 메시지를 #인박스에 보낸다. 지난 묶음의 버튼은 "다음 묶음으로 옮김"으로 닫힌다.
3. 형이 버튼을 누르면 listener.ts가 buttons.db에 답을 저장한다. 리드에게도 `OMOCAT_BUTTON`이 간다. 다음 tick(5분 안)이 답을 `resolved`로 옮긴다.
4. 출처 레인은 `decision_check`로 답을 보고 이어서 진행한다.
