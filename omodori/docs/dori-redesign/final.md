# Dandori 레인 제어 재설계 (최종): Herdr 키입력·화면읽기 → OMO RPC

작성 2026-10-23. `design.md`(초안)와 `review.md`(적대적 검토 19건, 판정 REJECT)를 합쳐 만든 최종본이다. 설계 문서만 작성했고 코드는 바꾸지 않았다. 검토의 모든 번호(1~19)는 §6 검토 반영표에 "수정" 또는 "기각(사유)"으로 적었다. 구현 단계는 `plan.json`이 원본이고 §3은 그 요약이다.

입력: `design.md`, `review.md`, `h-{rpc,tools,state,kakao,desktop,agents}.md`. 검토가 인용한 소스는 이번 개정에서 직접 다시 읽었다(부록 A). 다시 읽지 못한 것은 `(미재확인)`으로 표기했다.

경로 약어:
- `OMOCAT = ~/.omocat` (= `~/.omodori`, git)
- `DORI = ~/.dori/src/skills/dori-mode/scripts/src`
- `RT = ~/.omo/agent/runtime/bf255b915f51dd21-a2b6a51d8fc0/dist` (실사용 senpi 런타임)
- `DOC = ~/.bun/install/global/node_modules/@code-yeongyu/senpi/docs/rpc.md`
- `OMO = ~/.bun/install/global/node_modules/omo-ai`
- `AGENT = ~/.omo/agent`

초안 대비 바뀐 핵심 다섯 가지(검토 blocker 1·2·4·6 + major 7):
1. **전달 성공의 정의**: "응답 받음"이 아니라 **정확한 delivery id가 그 세션의 JSONL에 `custom_message` 엔트리로 영속된 것**만 `delivered`다. `duplicate:true`는 증거가 아니다(§2.1).
2. **폴백 금지 원칙**: Herdr 키입력 폴백은 "RPC로 아무 바이트도 보내지 않았음이 증명될 때"만. 전송 후 응답 유실은 `uncertain`으로 고정하고 같은 id의 영수증부터 찾는다. 한 논리 메시지는 한 전송 경로에 고정된다(§2.1).
3. **수명주기 lease**: 레지스트리 파일 잠금(짧은 임계구역)과 별도로, open/close/reopen/migrate/restart 전체를 덮는 **레인별 lease + generation CAS**를 둔다. 자동 경로는 같은 transcript를 재개하지 않고 항상 FRESH 세션 + handoff artifact로 간다(§2.2, §2.8).
4. **전환 장벽(transition barrier)**: reset/quota/handoff 복구/migrate는 전부 `lane-transition.ts` 한 절차로 통일한다. 새 입력은 계속 영속 수집하되 admission만 멈추고, 구세션의 persisted/미처리/uncertain 요청을 원장에 적은 뒤 새 세션으로 넘긴다. quota에서는 "배출 대기"가 아니라 즉시 전환이다(§2.8).
5. **Kakao 파이프라인 재정의**: 원본 메시지를 `(chat_id, log_id)` 문자열 키로 먼저 영속 수집하고, 커서·배치·burst/held 상태를 `bun:sqlite` 트랜잭션으로 묶는다. 30줄 절단은 "분할"로 바꾼다(§2.7).

---

## 1. 현재 구조와 실패 지점 (근거 경로)

### 1.1 현재 구조

```
주인(Discord/Kakao) ──► 리드 LLM (Herdr wW:p6, dandori-lead-20261018)
                          │  monitor 1개가 11개 루프의 stdout을 광역 필터로 구독 (monitors.json "dori-sweeps")
                          │  + monitor "herdr"가 herdr-watch.ts의 OMOCAT_HERDR 줄을 리드에 직접 전달
   dori-monitors.sh ──────┤ dori watch / dead-panes / guard / freshness / lane-health / monitors-check /
   (11 루프, 1 stdout)    │ ledger / kakao-stall / lane-reaper / daily-review / release-watch
   herdr-watch.ts ────────┤ `herdr agent list` + 화면 60줄 → turn_done/gone/question
   리드/루프 → sess.ts send ─► deliver.ts: 화면 40줄 검사 → `herdr pane run <pane> <text>` → JSONL `user` 태그 영수증
   kakao-push.ts ──────────┘  (`sess.ts send`를 최대 200회×3s 재시도, 메모리 offset, slice(-30))

   레인 = Herdr 탭 1개 = `omo --session-id <uuid>` 프로세스 1개 (sess.ts:79)
   레지스트리 3벌: sessions-map.json (sess.ts save: 잠금·tmp+rename 없음), ~/.dori/state/lanes/*.json, Herdr pane 상태
```

런타임 쪽 사실(설계가 기대는 것; 이번 개정에서 소스로 재확인한 항목은 ✔):
- Herdr 레인은 각자 `tui` 제어 엔드포인트를 여는 독립 프로세스다. 소켓 `AGENT/rpc/tui/t-<16hex>.sock` + 32바이트 `.secret`, 레코드 `AGENT/rpc-host-daemon/<16hex>/endpoint.json`(`DOC:1769-1791`; h-rpc §7 실측: tui 20개 명령 `get_protocol_info, list_sessions, get_state, get_messages, set_session_name, subscribe, wake, extension_ui_response, get_available_models, get_available_thinking_levels, set_model, set_thinking_level, interrupt, open_session, subscribe_sessions, unsubscribe_sessions, steer, follow_up, prompt, get_effect_status`). `get_protocol_info`는 `instanceId`(프로세스 인스턴스마다 다름)와 `generation`을 준다(h-rpc §7 실측).
- ✔ tui로 보낸 `steer/follow_up/prompt`의 admission(`RT/modes/interactive/session-control-rpc-commands.js` `admitInput`): `clientMessageId`가 곧 `delivery_id`(없으면 `tui-rpc-<uuid>` 자동 생성); `expected_turn_id`를 생략하면 **현재 epoch로 채운다**(따라서 `turn_conflict`는 값을 명시했을 때만 난다); `images/thinkingLevel/...`는 `unsupported_field` 거절; 빈 문자열은 `invalid_message`.
- ✔ `RT/core/external-admission.js` `admit()`: id가 `pending`·`emitted`·**`failed`** 중 하나에만 있어도 `already_admitted`를 돌려주고, 핸들러는 이를 `{disposition:"queued", duplicate:true}`로 바꾼다. `failed`는 transcript 쓰기 거절(`observeRefused`)로 채워지고 `observeRunSettled`에서 비워진다(= 같은 id가 나중에 **다시 admit될 수 있다**). `turnEpochValue`는 생성 시 0이고 프로세스 메모리에만 있다. `pending/emitted/failed`도 메모리 집합이며 `observePersisted`(엔트리가 실제로 기록될 때)로만 채워진다.
- ✔ 영속 형식: `RT/core/session-manager.js` `appendCustomMessageEntry`가 `{type:"custom_message", customType, content, display, details, id, parentId, timestamp}`를 쓴다. admission이 만드는 메시지는 `role:"custom"`, `customType: SESSION_CONTROL_DELIVERY_TYPE`(문서상 `"session_control_delivery"`), `details:{delivery_id, source:"session_control", deliverAs, sender?, display_text?}`(`external-admission.js` `deliveryMessage`). **`user` 메시지가 아니고 `type`도 `custom`이 아니라 `custom_message`다.** 초안 §1.1·§2.1-7·부록 B의 "custom" 표기는 오류였다.
- ✔ `RT/modes/rpc/session-registry.js` `list()`: 행마다 `sessionId`(라우팅 핸들)와 `durableSessionId`(JSONL 헤더 id)를 **따로** 준다. tui 엔드포인트에서는 둘이 같지만(h-rpc §7 실측) 호스트에서는 다를 수 있다.
- ✔ `RT/modes/rpc/session-status-subscriptions.js`: `subscribe_sessions`의 `include_workers` 기본값은 `childrenOf`일 때만 true, `sessions:"all"`에서는 **false**이고 `subscriptionMatches`가 worker 행을 걸러낸다.
- ✔ `RT/core/session-holders.js`: holder 레코드는 `<sessionDir>/session-holders/<encodedId>/<pid>.json` = `{pid, bootAtMs, processStartedAtMs, cwd?, ...endpoint}`(terminal lease 형식 재사용; pid 재사용은 start time으로 구분). `holdSessionFile`은 **다른 holder가 있어도 거절하지 않고** 자기 레코드를 발행한다(move.lock만 검사). 외부 holder 거절은 RPC 경로(`session-held.js`)에만 있고, 대화형 재개는 경고만 한다(`foreign-session-holders.js:50-62`).
- 내구 전달 계층(`omo thread send` → `AGENT/gateway/gateway.sqlite` `deliveries/receipts/session_meta`)은 존재하지만, 이 설계에서는 **Dandori의 기계적 전달에 쓰지 않는다**(§2.1 전송 경로 고정 원칙, §5-3).

### 1.2 실패 지점 → 원인 코드 → 최종 설계에서 바뀌는 것

| # | 오늘 본 문제 | 원인(경로) | 최종 설계 |
|---|---|---|---|
| P1 | 키입력 전달 20분 거절 | `deliver.ts:22-33` 화면 40줄의 `❯` 박스 검사; 거절을 `kakao-push.ts:168-174`가 200회×3s 새 id로 재시도. push.log 최장 399연속(20.4분, h-tools §5) | admission 응답(`started/queued/held_draft/turn_conflict`)과 `get_state`가 "보낼 수 있나"를 답한다. 화면 파싱 제거. 거절은 outbox 상태로 드러나고 10분이면 `ask`(§2.1, §2.7) |
| P2 | 거짓 `gone` | `herdr-watch.ts:12-17` 1회 누락 = gone(오늘 `GONE_MISS_LIMIT=2`로 완화); 질문/폴백 감지는 화면 60줄 | `subscribe_sessions` `session_status` + tui `subscribe` + 소켓 EOF + 레지스트리 재스캔 2회로 `gone` 확정(§2.3) |
| P3 | `/handoff` 후 빈 세션, `ctx is stale after session replacement` | `/handoff`는 런타임 명령(`handoff-hint/index.js`)이고 세션을 교체; 오류 문자열은 `goal/stale-context.js:13`; 던진 확장 미확인 | 근본 원인은 못 고친다. `/handoff`를 쓰지 않고 `lane-transition.ts`(handoff artifact + FRESH)로 통일; 교체가 감지되면 seed id 영수증으로 복구하고 실패는 `ask`(§2.8) |
| P4 | sessions-map sessionId 드리프트 | map을 쓰는 코드는 `sess.ts`뿐, `/handoff`·`lane-restart.sh`는 map을 안 건드림; `dori sync`는 루프에 없음; 드리프트 레인은 `lane-health.ts:185-186`에서 조용히 skip | 정합 루프(`registry-sync.ts`) + `generation` + `LANE_UNRESOLVED` 노출(§2.2) |
| P5 | 채널 id가 스레드로 쓰여 채널 개명 | `dori-hook.ts:19` → `oc.ts:34-44` `PATCH /channels/<id>{name,archived}`; 숫자 15~25자리면 통과 | PATCH 직전 `GET /channels/<id>` 타입 검사(10/11/12만) + 레지스트리 `threadKind`(§3 S2) |
| P6 | 리드 LLM이 기계 이벤트마다 깨어남 | 11 루프 1 stdout + 광역 필터; herdr monitor도 리드 직결; 중복 제거 제각각 | 단일 토폴로지 supervisor → events 파일 → `event-router.ts`(dori-monitors.sh 안) → 리드 필터 `^(DORI_ASK\|DORI_DIGEST) `; herdr monitor 폐지(§2.3) |
| P7 | 서브에이전트/DAG 불가시 | DAG 상태는 `AGENT/herdr-dag/<hex>.json`(부모 sessionId 기준); 읽는 dori 도구 없음; 바쁨 판정은 화면 정규식 | `subscribe_sessions{include_workers:true, include_context:true}`의 `context.parent/root_session_id` 그룹 + herdr-dag 감시; `children.state=unknown`이면 settled 아님·파괴 조치 fail closed(§2.5) |
| P8 | quota로 하루 멈춘 레인 | `lane-health.ts`는 map의 open+sessionId+파일 존재만; 마지막 assistant가 error일 때만 quota; busy 비교 어휘 `working`; 누락 계정/usage를 가용·0점 취급 | 분류기 재작성(`lane-classify.ts`): 진전 없음·credential 오류·usage freshness·계정 존재·provider 분리 모델링(§2.3 quota 모델) |
| P9 | Kakao 유실/중복 | offset 메모리, `pending.delete` 후 크래시, `slice(-30)`, 200회 포기, `pending`(exit 3) 재시도 중복 | `bun:sqlite` intake/cursor/batches/room_state 트랜잭션, 배치 분할, 같은 id 멱등 재시도 + 디스크 영수증 우선(§2.7) |
| P10 | 15:00 두 reset LaunchAgent 동시 reopen → map lost update | `sess.ts`가 시작 때 map 전체를 메모리에 읽고 `startOmo`(≤90s) 뒤 통째로 `writeFileSync`(`:23,:99,:112,:131,:158`); 같은 분에 두 restart 스크립트 실행 | `patchLane`(잠금+재읽기+키 단위 패치+tmp+rename) **그리고** `withLaneLease`(레인별, 작업 전체) + generation CAS(§2.2). :05 분산은 보조 수단 |

키입력·화면읽기 호출부 전체(교체 대상): `deliver.ts:91-92` · `sess.ts:79,:83,:85-86` · `herdr-watch.ts:34` · `DORI/panes.ts:50-51`(`send-text`+`send-keys enter`; done-flow/freshness가 사용) · `lane-restart.sh:97,:104,:107` · `dandori-docs-restart.sh`, `acme-docs-restart.sh`의 `busy()`(`herdr agent list` + `• Working` 화면 정규식) · `lane-health.ts` `paneFooter`(화면 5줄) · `kakao-lane-ext.ts:551`, `kakao-health.sh:77-79`(리드 pane 직접 타이핑).

---

## 2. 목표 구조

### 2.0 설계 대안 비교와 선택

**(가) 전체 구조** — 초안과 같다.

| | A. 얇은 어댑터 + 감독 데몬 + JSON 레지스트리(투영형) | B. SQLite 단일 원장 + 레지스트리 데몬(h-state §5) | C. 게이트웨이 전면 위임(`omo thread send/bind`) |
|---|---|---|---|
| 결합도 | 런타임 RPC v1에만 결합; 기존 CLI 진입점 유지 | dori-mode `registry.ts`와 `sess.ts` writer 전면 교체 | Discord 소비자·`bindings`(현재 0행) 미검증 |
| 테스트 | 어댑터·상태기계·분류기는 순수 함수 | 스키마 마이그레이션 테스트 추가 | 라이브 Discord 없이는 검증 불가 |
| 마이그레이션 | 단계당 수십~수백 줄, 파일 플래그 킬스위치 | 이중 쓰기 기간 + 투영 생성기 + 두 리포 | 보고/질문 파이프라인 교체 |
| 실패 모드 | 정합 루프 사망 → 드리프트 재발(단 `LANE_UNRESOLVED`로 보임) | 데몬 사망 → 모든 도구 정지 | 런타임 업데이트에 동작 종속 |

**선택: A** (이유는 초안과 같다: 문제는 입력원과 정합 루프 부재이지 레지스트리 *형식*이 아니다). 단, 검토 4·5·6이 지적한 대로 A에는 "파일 잠금"만으로는 부족한 **수명주기 상호 배제**가 필요하므로 아래 (다)를 추가한다. B로의 승격 조건은 §5-4.

**(나) 전달 경로(내구 메시지)** — 초안의 "평소 자체 outbox, 오프라인이면 gateway"(§5-3 (c))를 **기각**하고 한 경로로 고정한다.

| | R1. RPC 어댑터(tui admission) + JSONL `custom_message` 영수증 + 자체 outbox | R2. `omo thread send` + gateway `deliveries/receipts` |
|---|---|---|
| 영수증 | `details.delivery_id === id` 정확 비교, 파일에서 직접 읽음 | gateway 테이블(`applied`)과 세션 엔트리의 대응을 **아직 검증 못 함** |
| 오프라인 | outbox가 보관(레인 전환 절차가 넘겨줌) | `queued_offline` + `wake` 재전달 |
| 중복 위험 | 한 id, 한 경로 → 디스크 영수증 우선 조회로 억제 | 같은 id를 두 경로로 보내면 ID 대응 미검증 → 중복 가능(검토 2) |
| 결정 | **채택** | 리드의 `thread_send` 도구 용도로만 남김. Dandori 기계 전달에는 금지(§5-3) |

**(다) 수명주기 상호 배제**

| | L1. 전역 map 잠금만(초안 Step 3) | L2. map 잠금 + 레인별 lease + generation CAS(채택) | L3. 레지스트리 데몬(단일 writer) |
|---|---|---|---|
| 같은 키 reopen/reopen | 둘 다 통과 → 세션 2개(검토 4) | 두 번째는 `lease_held`로 즉시 거절 | 데몬이 직렬화 |
| close/reopen 교차 | 읽어 둔 tab을 늦게 닫음 | close는 lease 안에서 `expected.tab` CAS | 동일 |
| 데스크톱 재개 경쟁 | 막지 못함 | 자동 경로는 same-transcript resume 금지(FRESH만); 수동 reopen은 lease 안에서 holder 사전·사후 검사 + 충돌 시 `ask` | 런타임 배타 open 계약이 없어 L3도 완전하지 않음 |
| 비용 | 작음 | 작음(`mkdir` lease 디렉터리 + JSON 레코드) | 큼(B와 함께 감) |

**(라) Kakao 큐 저장소**

| | K1. NDJSON 여러 파일 + 커서 JSON(초안 Step 7) | K2. `bun:sqlite` 한 파일(WAL), 단일 writer(채택) |
|---|---|---|
| 크래시 경계 | append와 cursor 사이의 모든 지점을 수동으로 복구해야 함(검토 7) | 트랜잭션 1개 = 경계 1개 |
| 부분 기록 | 부분 NDJSON 복구 코드 필요 | 없음 |
| 중복 제거 | 파일 전체 스캔 | PK `(chat_id, log_id)` |
| 의존성 | 없음 | bun 내장(설치 없음) |
| 관측 | `jq`로 읽음 | `sqlite3`로 읽음(이미 h-desktop 조사에서 사용) |

### 2.1 RPC 어댑터 (`OMOCAT/rpc.ts`, 신규)

역할: "레인 키 → durable id → 라이브 엔드포인트(라우팅 id)"를 풀고, 보내고, 상태를 읽고, **영속 영수증**을 확인한다. 모듈(함수) + CLI.

```
resolve(target)  → { key?, durableId, sessionPath, pane?,
                     routing: { sessionId, socket, kind:'tui'|'rpc_host', instanceId, generation } | null,
                     holders: [{pid, inPane:boolean, alive:boolean}], managed: 'lane'|'child'|'lead'|'unmanaged',
                     fallback: 'herdr'|null }
state(target)    → get_state (status, isStreaming, turn_epoch, blocking_question, editor_has_draft, model, messageCount, pendingQueue)
send(target, text, {id, mode, childOk, expectedTurn}) → DeliveryResult(아래 상태기계)
receipt(sessionPath, id) → 'persisted'|'absent'          // JSONL만 읽는다. 세션이 죽어 있어도 동작
wait(target, until, timeoutMs) → tui subscribe(completion/question) + subscribe_sessions(session_status) 이벤트 대기(폴링 없음)
children(target) → 하위 세션/태스크/DAG 요약(§2.5)
```

**식별자 계약(검토 15).** `durableId`(JSONL 헤더 id = `--session-id` = gateway `session_meta.durable_id`)만 레지스트리와 outbox에 저장한다. `routing.sessionId`는 요청 직전에 해당 엔드포인트의 `list_sessions`에서 `durableSessionId === durableId`인 행으로 **매번** 얻는다(tui는 자기 행 1개). 캐시 키는 `(socket, instanceId, generation)`이며 `transport_gone`·`host_superseded`·`session_replaced`·`unknown_session` 오류에서 폐기하고 1회 재해결한다. 어떤 파일에도 `routing.sessionId`를 영속하지 않는다.

**관리 대상 허용 목록(검토 16).** `resolve().managed`가 `'lane'`(sessions-map `status:'open'`이고 `durableId`가 그 키의 현재 `sessionId` 또는 `lineage.sessions[]`에 있음)일 때만 `send/interrupt/set_*`가 허용된다. `'child'`(`context.parent_session_id`/`root_session_id`가 관리 레인의 durableId)는 `--child-ok`가 있어야 한다. `'lead'`(`dandori-lead*`)와 `'unmanaged'`(데스크톱이 연 세션, 다른 작업 세션)는 기본 거절 `unmanaged_target`이다. 관측(`state/children/receipt`)은 전체 허용. 관리 대상 편입은 `dori adopt <key> --session <durableId>`(명시적 등록) 한 경로다. `.secret`은 메모리에만 읽고 어떤 로그·이벤트·스냅샷·argv에도 쓰지 않는다. 어댑터가 만드는 디렉터리/파일(`OMOCAT/events`, `OMOCAT/lane-leases`, `OMOCAT/kakao-queue.sqlite*`, `OMOCAT/ops`)은 `0700/0600`.

**전달 상태기계(검토 1·2·3).** 한 논리 메시지 = 한 `id`(호출자가 주거나 어댑터가 발급) = 한 `transport`(전송 전에 확정, outbox에 기록).

```
attempting ──(RPC 소켓 연결 실패/ENOENT/핸드셰이크 실패/`unsupported` 명령: 바이트 미전송 증명)──► refused(no_endpoint) ──► [fallback 허용]
attempting ──(요청 바이트 기록)──► sent
sent ──(응답 started|queued|steered|duplicate)──► accepted          // 증거 아님
sent ──(응답 held_draft|turn_conflict|unsupported_field|invalid_message|session_held|unmanaged)──► refused(<code>)   // 아무것도 enqueue 안 됨(런타임 계약), 폴백은 금지
sent ──(응답 없이 소켓 끊김/타임아웃)──► uncertain
accepted ──(receipt(sessionPath,id)==='persisted')──► delivered(persisted)   // 유일한 성공
accepted ──(45 s 안에 영수증 없음)──► uncertain
uncertain ──(receipt 재조회 'persisted')──► delivered
uncertain ──(재시도: 같은 id 재전송 → duplicate면 그대로 uncertain 유지; admit되면 accepted)──► …
```

규칙:
1. **디스크 영수증 우선.** 어떤 재시도도 `receipt(sentTo.sessionPath, id)`를 먼저 호출한다. `persisted`면 전송하지 않는다. (프로세스 재시작으로 런타임 메모리 집합이 비어 있으면 같은 id가 다시 admit될 수 있으므로, 멱등성은 런타임이 아니라 **이 조회**가 보장한다.)
2. **`duplicate:true`는 "런타임이 그 id를 pending/emitted/failed 중 하나로 안다"는 뜻일 뿐**이다. 상태를 `accepted`로만 두고 영수증을 기다린다. 한 run이 settle된 뒤에도 영수증이 없으면(= `failed`였고 비워짐) 같은 id로 다시 보낸다 — transcript에 같은 id가 두 번 생길 수 없는 이유는 규칙 1이다.
3. **영수증 형식**: JSONL 줄이 `type==='custom_message'`이고 `details.delivery_id === id`(정확 동등)이면 persisted. herdr 전송(폴백)에서는 `type==='message' && message.role==='user'`이고 본문에 `[dandori-msg:<id>]`가 있으면 persisted(기존 `recordHasTag`). 두 형식 모두 `rpc.test.ts` 픽스처로 고정하고, S1 라이브 테스트가 실제 줄 1개를 픽스처 파일로 남긴다.
4. **폴백은 "RPC로 아무 바이트도 보내지 않았음"이 증명될 때만**: `refused(no_endpoint)`(엔드포인트 레코드 없음·소켓 ENOENT·연결 거부·핸드셰이크 실패·`get_protocol_info.commands`에 `steer`가 없음)이고 pane의 omo 프로세스가 살아 있을 때(`herdr pane process-info`의 `isOmoProcess`) 기존 `deliver()`를 호출한다. 그 외 모든 거절·`uncertain`은 폴백하지 않는다. `held_draft`에 키입력을 하면 draft 자체를 만들므로 특히 금지.
5. `held_draft`: outbox가 5 s×2^n(상한 60 s) 백오프로 같은 id 재시도. 10분 지속 → `delivery.stuck`(ask).
6. `turn_conflict`: `expected_turn_id`를 명시한 호출에서만 발생. `get_state.turn_epoch`를 다시 읽어 같은 id로 1회 재전송(전송 경로 불변).
7. `session_held`/`unmanaged_target`: 그대로 반환. 폴백 금지(홀더 충돌 경로).
8. 슬래시 명령(`^/`)은 admission이 거절하므로 **어댑터가 받지 않는다**(`invalid_target_text`). 종료는 `sess.ts close`(tab close), 세션 교체는 `lane-transition.ts`(§2.8). `/handoff`·`/compact` 타이핑은 설계에서 제거.
9. 기본 모드 `steer{whenIdle:"start"}`; `--mode follow_up|prompt`. 메시지 끝에 `[dandori-msg:<id>]` 태그를 그대로 붙인다(사람이 pane에서 식별하기 위함; 영수증은 태그가 아니라 `details.delivery_id`).

종료 코드(`sess.ts send`): `0 delivered(persisted)` / `3 uncertain`(구 pending; 호출자는 재전송 대신 같은 id로 `receipt`→재시도) / `4 refused`(아무것도 안 보냄; `reason` 코드 포함) / `6 held_elsewhere`(reopen 전용, §2.6). 출력은 JSON 한 줄 `{status, id, transport, disposition?, reason?, sentTo:{durableId, sessionPath, instanceId}}`.

소켓 클라이언트: 전역 senpi 패키지의 `RpcClient`(`RT/modes/rpc/rpc-client.js` `startSocket`: `readSocketSecret`+`sendSocketHandshake`) import + `get_protocol_info.protocolVersion===1` 가드(§5-2). 가드 실패는 `refused(no_endpoint, reason:'protocol')`이라 규칙 4의 폴백 조건을 만족한다.

`sess.ts` 변경(S1 최소): `sendTo()`가 `rpc.send`를 먼저 호출하고 결과의 `fallback==='herdr'`일 때만 기존 `deliver()`; `case 'status'`, `case 'receipt'` 추가. 전송 선택은 환경변수가 아니라 **파일** `OMOCAT/transport.json {"default":"herdr","rpc":["rpc-smoke"]}`(검토 18: 실행 중인 launchd 자식에 env는 전달되지 않는다). 허용 목록 단계: `rpc-smoke` → `kakao-acme-docs`([ACME] 테스트 방) → 전체.

### 2.2 레인 레지스트리 (sessions-map.json v2) 와 수명주기 보호

진실의 순서: **라이브 엔드포인트가 말하는 durable id > sessionPath > 파일의 값.** 파일은 캐시+의도(어느 키가 어느 스레드/pane/세대를 쓰는가)다.

```jsonc
{
  "example-lane": {
    // 기존 필드 그대로 (sess.ts:17-21; reader 9곳)
    "key": "example-lane", "label": "…", "cwd": "…", "thread": "1562…", "workspace": "w1Y", "tab": "w1Y:t3", "pane": "w1Y:p3",
    "sessionId": "52771367-…", "status": "open", "openedAt": "…", "closedAt": null,
    // v2 추가 (optional; 기존 reader는 무시)
    "generation": 7,                                // 수명주기 작업마다 +1; 모든 patch는 expectGeneration CAS
    "sessionPath": "~/.omo/agent/sessions/--…--/2026-10-23T05-13-50-798Z_52771367-….jsonl",
    "sessionVia": "open" | "transition" | "reconcile-endpoint" | "reconcile-argv" | "adopt",
    "lineage": { "parentKey": "example-lane", "childKeys": ["example-lane-m1"], "sessions": ["c12af751-…", "52771367-…"] },  // 승인된 계보(허용 목록)
    "threadKind": "discord_thread" | "none",        // S2에서 GET /channels 로 확정; 'discord_channel'이면 open·hook 거부
    "threadParent": "1553…",
    "account": "default" | "alt" | "work" | null,   // <jsonl>.claude-sdk-oauth-binding.json 의 accountName (첫 turn 뒤에만 존재)
    "accountRequested": "alt" | null,                // 전환 때 argv로 요청한 계정 (바인딩과 다르면 lane.account_mismatch)
    "model": "anthropic-subscription/claude-opus-5-5",
    "profile": "kakao-dandori-docs",                // OMOCAT/lane-profiles/<name>.json (확장·도구·noClaim·브리프 경로)
    "endpoint": { "kind": "tui", "socket": "…/t-1596….sock", "instanceId": "b56a…", "seenAt": "…" },   // 캐시, 진실 아님
    "seed": { "state": "applied" | "pending", "id": "seed:example-lane:7", "generation": 7 },   // §2.8 교체 복구
    "quiet": true
  }
}
```

쓰기 규칙(검토 4·5·18):
1. **map 쓰기 = `OMOCAT/registry.ts patchLane(key, expectGeneration?, patch)` 하나.** 배타 잠금 `OMOCAT/sessions-map.lock/`(`mkdir` 원자성 + 안에 `{pid, bootAtMs, processStartedAtMs, at}`; 회수는 pid가 죽었거나 start time이 다를 때만 — 30 s 경과는 회수 조건이 아니라 경고 조건) 안에서 파일을 **다시 읽고**, 그 키만 바꾸고, tmp+rename. 임계구역은 수 ms다. `expectGeneration`이 다르면 `generation_conflict`로 거절하고 아무것도 쓰지 않는다.
2. **수명주기 작업 = `withLaneLease(key, op, fn)`.** `OMOCAT/lane-leases/<key>/` 디렉터리(`mkdir` 원자성)에 `{pid, bootAtMs, processStartedAtMs, op:'open|close|reopen|transition|reap', generation, startedAt}`를 쓰고 `fn` 전체(herdr tab create, startOmo 90 s, patchLane, brief 전송)를 그 안에서 실행한다. 다른 프로세스는 `lease_held <pid> <op>`로 **즉시 거절**(대기하지 않는다 — 동시 reopen은 버그이지 큐잉 대상이 아니다). 회수는 pid 사망(start time 비교)일 때만. 적용 대상: `sess.ts open/close/reopen`, `lane-transition.ts`(=migrate/reset/복구), `lane-reaper.ts --apply`, supervisor의 모든 act. `close`는 lease 안에서 map을 다시 읽어 `expected.tab === entry.tab`일 때만 그 tab을 닫는다(읽어 둔 옛 tab을 닫지 않는다).
3. **`~/.dori/state/lanes/<key>.json`의 writer도 같은 규율.** dori-mode의 `Registry.write(lane)`(전체 객체 덮어쓰기)를 `Registry.update(key, fn)`(키별 잠금 `<lanesDir>/<key>.lock/` + 재읽기 + `fn(current) → next` + tmp+rename)으로 바꾸고, `done-flow.ts`(claimDone/objectDone/close)·`freshness.ts`(lastNudgeAt/lastSeenReport/lastAutoReplyAt…)·`launch.ts`(adopt)의 호출부를 전부 `update`로 옮긴다. omocat 쪽(`sess.ts`의 `doriLane`, `registry-sync.ts`의 `session` 미러)은 **같은 키별 잠금 프로토콜**을 `registry.ts`에 구현해 쓴다(두 리포, 20줄짜리 같은 규약; 교차 테스트로 고정). 이 변경은 Step 8이 아니라 **S3에서** 함께 커밋한다(dori 리포 커밋 1개 추가).
4. 정합기(`registry-sync.ts`)는 `sessionId/sessionPath/sessionVia/endpoint/account`만 `patchLane`으로 쓴다. `sessionId`를 바꾸는 조건: 엔드포인트의 `list_sessions`가 다른 durable id를 답하거나, pane 프로세스 argv의 `--session/--session-id`가 다를 때. `start-time` 휴리스틱은 보고만. 바뀐 id는 `lineage.sessions`에 추가(허용 목록 유지).
5. `thread`는 문자열 원값 그대로(`ledger.ts`·`herdr-watch.ts`의 서로 다른 기대 포맷 보존). 종류는 `threadKind`.
6. `sess.ts`는 pane에서 omo를 시작할 때 `OMOMEOW_LANE_KEY=<key>` 환경변수를 붙인다(`herdr pane run <pane> "OMOMEOW_LANE_KEY=<key> omo …"`). Kakao 확장이 방을 레인별로 고정하는 데 쓴다(§2.7).

**같은 transcript 재개 정책(검토 4).** 런타임에 원자적 exclusive-open이 없으므로(§1.1 holder) 완전한 상호 배제는 불가능하다. 따라서:
- **자동 경로(reset, quota, 교체 복구, migrate)는 같은 세션을 재개하지 않는다.** 항상 FRESH durable id + handoff artifact(§2.8). 옛 세션은 읽기 전용 참조로만 남는다.
- **수동 `sess.ts reopen`(FRESH 아님)만** 같은 transcript를 재개하며, lease 안에서 (a) 사전: `<sessionDir>/session-holders/<id>/*.json` 중 살아 있는(pid alive + processStartedAtMs 일치) 레코드가 있으면 `held_elsewhere`(exit 6); (b) 사후: startOmo 뒤 holder 디렉터리에 pane 프로세스 외의 살아 있는 레코드가 생겼으면 `lane.holder_conflict`(ask) — 이 창에서는 두 프로세스가 같은 파일을 쓸 수 있으므로 주인이 한쪽을 닫는다. 사전·사후 사이의 TOCTOU는 남지만 수동 경로 1개로 제한되고 즉시 드러난다.

상태 스냅샷(`OMOCAT/lane-status.json`, supervisor만 쓰고 나머지는 읽기 전용):

```jsonc
{ "at": "…", "v": 2, "census": { "complete": true, "hostsUnreachable": ["…/shards/p-….sock"] },
  "lanes": { "<key>": { "durableId", "generation", "pane", "endpoint": {…, "instanceId"},
                        "status": "opening|idle|running|waiting_input|compacting|offline|gone|unknown",
                        "turn_epoch", "blocking_question", "editor_has_draft", "model", "account", "lastWriteAt",
                        "children": { "state": "known|unknown", "running": 0, "done": 3, "failed": 0, "dagRuns": [{ "id", "status", "nodes" }] },
                        "settled": true, "quiet": false } },
  "unmanaged": [ { "durableId", "name", "cwd", "surface": "desktop|tui|host", "status" } ],
  "hosts": [ { "socket", "kind", "instanceId", "generation", "reachable", "sessions" } ] }
```

`settled = status==='idle' && children.state==='known' && children.running===0 && !dagRuns.some(running)`. `unknown`은 settled가 아니다.

### 2.3 감독 데몬 (`OMOCAT/dori-supervisor.ts`, 신규; launchd KeepAlive, 단일 인스턴스 lock)

입력:
1. 엔드포인트 레지스트리 스캔: `AGENT/rpc-host-daemon/*/endpoint.json` + 15 s마다 `omo host status --json --all --include-workers`.
2. reachable 엔드포인트마다 소켓 1개: `subscribe_sessions { sessions:"all", include_workers:true, include_context:true, effects:true }`(검토 10: `include_workers:true` 명시). tui에는 추가로 `subscribe { cursor }`(completion/question/report; 256개 링이므로 cursor를 `OMOCAT/state/supervisor.json`에 `(socket, instanceId) → cursor`로 저장; `resync_required`면 스냅샷 재요청).
3. `AGENT/herdr-dag/*.json` mtime 감시 → `sessionId`로 레인 매핑.
4. `herdr agent list`/`pane process-info`는 pane↔세션 바인딩에만. 상태 판정에는 쓰지 않는다.
5. `AGENT/subscription-usage.json`(+ `updatedAt` freshness), `<jsonl>.claude-sdk-oauth-binding.json`, `AGENT/auth.json`(계정 이름만).

레인 상태기계: `opening → idle ⇄ running → (waiting_input|compacting) …`; 소켓 EOF/`transport_gone` → `offline`(pane 프로세스 살아 있으면 재구독); 레지스트리 재스캔 2회(≥20 s 간격)에서 엔드포인트도 pane도 없으면 `gone`; 초기 census가 끝나기 전·호스트 단절 중에는 그 호스트에 속한 하위 정보는 `children.state='unknown'`. `turn_done`은 `settled`로 **전이할 때** 1회이고, 이벤트 id는 `lane.turn_done:<durableId>:<instanceId>:<turn_epoch>`(검토 17: epoch는 프로세스마다 0부터 다시 세므로 `instanceId`가 incarnation 역할).

**단일 실행 토폴로지(검토 11).**

```
dori-supervisor.ts (launchd)  ──append──►  OMOCAT/events/supervisor.ndjson   (+ OMOCAT/state/supervisor.json: 구독 cursor, 레인별 마지막 (instanceId, epoch), 미확인 ASK)
                                                      │
dori-monitors.sh (리드 monitor 1개) = { 기존 sweeps… ; tail -F events/supervisor.ndjson ; } | bun event-router.ts
                                                      │   router checkpoint: OMOCAT/state/router-cursor.json {fileIno, offset, lastEventId}
                                                      ▼
리드 세션 monitor filter: ^(DORI_ASK|DORI_DIGEST)␠        (monitors.json "herdr" 모니터는 S6에서 제거; herdr-watch.ts는 --source rpc 라이브러리로만 남김)
```

정책 실행 주체는 **정책당 하나**다. S9에서 같은 커밋으로 옛 실행자를 끈다: `lane-health.ts`의 auto-migrate 분기 삭제(AUTO_FLAG는 supervisor가 읽음), `dori freshness`는 `--no-nudge`(보고만; nudge는 supervisor가 어댑터로), `kakao-health.sh:77-79`·`kakao-lane-ext.ts:551`의 리드 pane 타이핑은 이벤트 파일 append로 교체. `act` = supervisor가 **실행**하고 결과를 `OMOCAT/ops/<opId>.json` 원장에 단계별로 남긴다; router는 **분류·집계만** 한다. 실행자가 없는 실패(예: transition 실패, 미등록 정책)는 전부 `ask`.

**재시작 경계(검토 17).** supervisor 재시작: `state/supervisor.json`의 레인별 `(instanceId, epoch)`보다 새 전이만 이벤트로 낸다; 새 구독 스냅샷은 현재 상태로 **수렴**시키되 부수 효과를 재생하지 않는다; `ops/*.json`에서 비종료 op를 읽어 다음 단계부터 재개하거나(멱등 단계: receipt 조회·patchLane CAS) 재개 불가면 `ask`로 올린다; 미확인 ASK는 `asks` 목록에서 재발행. router 재시작: `router-cursor.json`부터 읽어 같은 `id`를 두 번 내지 않는다(파일 ino가 바뀌면 처음부터, `lastEventId`까지는 건너뜀).

**quota/stall 모델(검토 12; `OMOCAT/lane-classify.ts` 신규, `lane-health.ts`의 `assess` 대체).** 입력은 스냅샷 + transcript 꼬리 + usage/auth:

| 축 | 값 | 근거 |
|---|---|---|
| `progress` | `first_input_pending`(assistant 엔트리 0개, 전달 persisted 있음) / `turn_running` / `idle_ok` / `no_progress`(마지막 persisted 입력 뒤 `stallMin` 동안 assistant 쓰기 없음) | transcript + 스냅샷 `status`(`running` = 구 `working`; 변환표 명시) |
| `credential` | `ok` / `quota`(QUOTA 정규식) / `credential_error`(auth/credential/401/403) / `overload` / `other_error` | 마지막 assistant `stopReason==='error'`인 엔트리 **그리고 그 뒤에 성공 turn이 없을 때만**(running 중의 과거 오류는 무시) |
| `provider` | `anthropic-subscription` / `chatgpt-subscription` / 기타 | 스냅샷 `model.provider` + 오류 엔트리의 provider. GPT의 credit/429는 `lane.provider_error`이지 Claude 계정 순환 대상이 아니다 |
| 계정 상태 | `AccountState{name, present, usageFresh, full, score, resetAt}` | `auth.json`에 없으면 `present=false` → 후보 제외; `subscription-usage.json`의 `updatedAt`이 30분보다 오래면 `usageFresh=false` → 후보 제외 + `lane.usage_stale`(digest) |

판정: `quota`(provider=anthropic, credential=quota, 후보 계정 있음) → act `lane-transition.ts <key> --fresh --account <next>`; `quota_all`(후보 없음) → act GPT 폴백 전환 + ask(리셋 시각); `credential_error`·`first_input_pending` 10분 → ask; `no_progress` → `lane.stalled`(ask). 픽스처: 계정 누락, usage stale, pre-assistant 실패, running 중 과거 오류, 3계정 소진, GPT 429.

기계적 정책표(실행 주체 = supervisor; 모든 act는 ops 원장 + lane lease):

| 조건 | 조치(act) | 실패 시 |
|---|---|---|
| 전달 `held_draft`/`uncertain` 지속 | outbox 백오프(어댑터 규칙 5) | 10분 → `ask delivery.stuck` |
| 레인 `idle`·보고 없음 N분(`config.json nudgeAfterMin`) | nudge를 어댑터로 전송(id `nudge:<key>:<generation>:<n>`) | 2회 무응답 → `ask` |
| quota + 후보 계정 | `lane-transition.ts --fresh --account`(AUTO_FLAG 없으면 제안 = ask) | `transition_failed` → ask |
| quota_all | `lane-transition.ts --fresh --model chatgpt-subscription/gpt-6-astra --thinking high` | ask(리셋 시각 포함) |
| 리셋 후 GPT 폴백 레인 존재 | ask(Claude 복귀는 주인 판단) | — |
| `session_replaced`(pane 프로세스가 다른 durable id) | `lane-transition.ts --adopt-replacement`: 재바인딩 + seed 전달 + 영수증 확인(§2.8) | `ask lane.empty_after_handoff` |
| `gone`인데 `children.running>0` 또는 `children.state==='unknown'` | ask(고아 가능) | — |
| done 주장 | 기존 dori 흐름 | 기존 `LANE_NOT_DONE` |
| 빈 탭/고아 pane | `LANE_EMPTY_TAB`만 `--apply`(스냅샷 `gone` 확정 + children known 0 + lease) | 나머지는 digest |
| Kakao 배치 2분 미전달 | 백오프 + `act kakao.stuck` | 10분 → ask |

### 2.4 이벤트 스키마

```jsonc
{ "v": 2, "at": "2026-10-23T06:10:00.000Z",
  "id": "lane.turn_done:52771367-…:b56a750d-…:41",          // kind:durableId:instanceId:epoch (또는 kind:key:generation:n)
  "kind": "lane.turn_done", "severity": "info" | "act" | "ask",
  "lane": "example-lane", "durableId": "52771367-…", "generation": 7, "pane": "w1Y:p3", "thread": "1562…",
  "source": "supervisor" | "adapter" | "router" | "kakao" | "transition",
  "op": "op_…",                                                // act일 때 ops 원장 id
  "data": { "turn_epoch": 41, "children": { "state": "known", "running": 0 } } }
```

kind 목록: `lane.opened, lane.session_replaced, lane.turn_done, lane.question, lane.question_closed, lane.blocked, lane.offline, lane.gone, lane.stalled, lane.quota, lane.quota_all, lane.quota_reset, lane.provider_error, lane.usage_stale, lane.context_high, lane.children_changed, lane.dag_run, lane.transition, lane.seed_applied, lane.empty_after_handoff, lane.holder_conflict, lane.account_bound, lane.account_mismatch, lane.closed, delivery.sent, delivery.persisted, delivery.uncertain, delivery.refused, delivery.stuck, kakao.batch, kakao.split, kakao.stuck, kakao.recovered, registry.drift, registry.reconciled, registry.generation_conflict, host.superseded, host.unreachable, digest`.

severity: `ask` = 판단 필요(질문, quota_all 리셋 불명, 전환 실패, seed 실패, 고아/unknown 하위, holder 충돌, 계정 불일치, 데스크톱 세션의 질문); `act` = supervisor가 처리하고 digest에 집계; `info` = 로그만. 중복 제거는 `id` 동등(TTL 없음; 재시작 경계는 §2.3).

리드가 보는 줄: `DORI_ASK <json>`(즉시), `DORI_DIGEST <json>`(15분; 23:30–07:00 KST는 60분; 비어 있으면 생략). 기존 소비자(`buttons.ts` 등)가 기대하는 `OMOCAT_HERDR {event:…}` 모양은 router가 **같은 파이프 안에서** 만들어 낸다(별도 monitor 없음).

### 2.5 계층·서브에이전트 관측

- 하위 세션: reachable 엔드포인트마다 `session_status` 중 `context.parent_session_id`/`root_session_id`가 레인 durableId인 행. **`include_workers:true` 없이는 worker 행이 보이지 않는다**(§1.1 ✔). `context.task_id`로 `st_` id.
- DAG: `AGENT/herdr-dag/<hex>.json` `{sessionId, runs[{id,status,nodes[{id,state,taskId}]}]}`.
- 프로세스 안 하위 에이전트(RPC에 안 보이는 것): Herdr 내장 확장의 `agent_status`(`working`)를 보조 신호로만.
- **unknown 규칙(검토 10)**: 초기 census 미완료, 하위가 속한 호스트 단절, herdr-dag 파일 mtime이 스냅샷보다 오래됨(> 10분이고 run status가 running) → `children.state='unknown'`. unknown이면 settled가 아니며 restart/transition/reap/close의 사전조건에서 **fail closed**(exit 4 `children_unknown`; `--force`는 사람만).
- 소유: 리드는 레인에만 보낸다; 하위 세션 전송은 `--child-ok` + 관리 레인 계보 조건(§2.1). 리드 자신의 하위는 리드가 `monitor({type:"rpc", target:"children"})`로 본다(기존).

### 2.6 데스크톱 공존 (`/Applications/OmO (Alpha).app`, `OmO UI.app`)

사실(h-desktop; 번들 내부는 미재확인, holder·`session-held.js`는 ✔): OmO (Alpha)는 `AGENT/rpc/rpc.sock`을 소유하는 런타임을 띄우고 Herdr 레인 JSONL을 제자리 adopt로 읽는다. 라이브 레인에 데스크톱이 보내면 RPC 경로의 `session_held`로 거절된다. 유일한 실제 손상 경로는 "탭 닫힌 세션을 데스크톱이 열고 Dandori가 같은 세션을 reopen"이며 런타임은 경고만 한다.

규칙:
1. 조인 키는 **세션 헤더 id(durableId)**. 데스크톱 thread id는 키로 쓰지 않는다. 스냅샷 `unmanaged`에 데스크톱/호스트 세션을 올린다.
2. 자동 경로는 same-transcript resume을 하지 않는다(§2.2). 수동 `reopen`은 holder 사전·사후 검사(exit 6 / `lane.holder_conflict` ask).
3. 어댑터는 holder pid가 pane의 omo 프로세스가 아니면 어떤 경우에도 키입력 폴백을 하지 않는다.
4. 라벨 공유: open 직후 `set_session_name "[lane:<key>] <label>"`(§5-7).
5. `host_superseded` → supervisor 재구독, 어댑터 라우팅 캐시 폐기. tui 레인은 영향 없음.
6. 데스크톱이 연 세션에 레인 역할을 주려면 `dori adopt <key> --session <durableId>`(명시적 등록; 그 전에는 unmanaged → 전송 거절).

### 2.7 Kakao 전달 파이프라인 (`OMOCAT/kakao-queue.ts` 신규 + `kakao-push.ts` 재작성)

저장소: `OMOCAT/kakao-queue.sqlite`(`bun:sqlite`, WAL, `0600`; writer는 `kakao-push` 프로세스 하나). 읽기는 `kakao-stall.ts`·supervisor·사람(`sqlite3 -readonly`).

```sql
intake(chat_id TEXT, log_id TEXT, raw TEXT, ingested_at TEXT, PRIMARY KEY(chat_id, log_id))   -- id는 문자열(2^53 초과; JSON.parse 전에 정규식으로 추출)
cursor(id INTEGER PRIMARY KEY CHECK(id=1), log_ino INTEGER, log_offset INTEGER, updated_at TEXT)  -- 완전한 줄 끝의 byte offset만
room_state(chat_id TEXT PRIMARY KEY, pending_json TEXT, held_json TEXT, burst_json TEXT, updated_at TEXT)
batches(id TEXT PRIMARY KEY,            -- 'kakao:<chat_id>:<seq>' ; seq는 chat별 단조 증가(room_state.next_seq)
        chat_id TEXT, lane TEXT, seq INTEGER, part INTEGER, parts INTEGER,
        members_json TEXT,                -- log_id 목록(순서 고정) + [문맥] 원본 참조
        body TEXT, state TEXT CHECK(state IN ('queued','accepted','uncertain','persisted','refused','carried')),
        transport TEXT, sent_to_json TEXT, -- {durableId, sessionPath, instanceId, generation}
        attempts INTEGER, last_error TEXT, created_at TEXT, persisted_at TEXT)
```

크래시 경계 = 트랜잭션(검토 7):
1. **intake**: `live.ndjson`에서 `(cursor.log_ino, cursor.log_offset)`부터 읽어 완전한 줄마다 `INSERT OR IGNORE intake` + `UPDATE cursor` 를 **한 트랜잭션**에. 부분 줄은 커서를 전진시키지 않는다(메모리 carry 없음; 다음 틱에 같은 offset에서 다시 읽음). 로그 세대: `stat.ino`가 다르거나(교체/rename 후 새 파일) `size < offset`(truncate)이면 offset 0부터; 중복은 PK가 막는다(kakao-loco의 자체 replay 500줄도 같은 이유로 안전). 프로세스 시작 시 offset은 파일 끝이 아니라 `cursor` 행이다(최초 1회만 파일 끝).
2. **route/burst/pending/held**: 오늘의 규칙(QUIET 2.5 s / HOLD 8 s / burst 20·30·45 s / `[호출][이어짐][문맥][rN]` / HELD_MAX 12 / Jev fail-open)은 그대로. 다만 각 방의 `pending/held/burst`는 바뀔 때마다 `room_state`에 저장하고, 재시작 시 복원한다(`first` 시각이 HOLD_MS를 넘었으면 즉시 flush). intake에는 있지만 어느 room_state/batch에도 없는 log_id는 재시작 복원 때 다시 route한다(복원 전 크래시 지점 커버).
3. **batch 확정**: flush는 `pending` 삭제 + `batches` INSERT(`queued`) + `room_state.next_seq` 증가를 한 트랜잭션에. skip 배치는 `held_json`으로 이동(같은 트랜잭션). 배치 id는 내용이 아니라 `seq`에서 나오므로 크래시 후 조용 구간이 달라져도 이미 확정된 배치의 id는 바뛀지 않는다.
4. **분할(검토 8)**: 요청 줄(깨운 배치의 원문)이 30줄을 넘으면 순서 고정으로 `part 1..parts`로 나눈다(각각 별도 batch id, 본문 헤더 `[kakao-new 30개 (1/2)]`). `[문맥]` 줄은 맨 앞 배치에만 들어가고, 요청+문맥이 30을 넘으면 문맥을 먼저 줄이되 `[문맥 N줄 생략]` 한 줄로 표시한다. 원본은 intake에 그대로 있다. `kakao.truncated`는 사라지고 `kakao.split`(info)만 남는다.
5. **전송 워커**: 레인별 워커(레인 안 순차, 레인 간 병렬). 한 배치의 전송 = `rpc.send(lane, body, {id: batch.id})` → 결과를 `batches.state/sent_to_json/attempts`에 기록. 성공 조건은 `persisted`뿐. `uncertain`은 `rpc.receipt(sent_to.sessionPath, id)`를 먼저 조회한 뒤 같은 id로 재시도(백오프 3 s×2^n, 상한 60 s; 최대 횟수 없음 — 포기 대신 `kakao.stuck`). `transport`는 처음 전송에서 고정되며 이후 바뀜지 않는다(herdr로 보낸 배치를 RPC로 재전송하지 않고 그 반대도 없다).
6. **방 귀속(검토 9)**: `CURRENT_ROOM`(전역 파일 `sa-cache/jangdori-room`) 대신 레인별 파일 `sa-cache/room.<lane>`에 **불변 chat_id**를 open 시점에 한 번 쓴다(`kakao-rooms.json`의 room→lane이 지금 1:1). `kakao-lane-ext.ts`의 `room()`은 `OMOMEOW_LANE_KEY`가 있으면 `room.<lane>`을, 없으면 종전 파일을 읽는다(호환). `ownerOnly`/`pinned` 예외는 그대로. **병렬 워커는 모든 kakao-* 레인이 `OMOMEOW_LANE_KEY`로 재시작된 뒤에만 켬다**(`kakao-queue.ts`의 `workers.parallel` 플래그; 그 전에는 오늘처럼 직렬). 방 공유 레인이 생기면 envelope 방식(§5-9 (b)).
7. **전환 연동(검토 6)**: 워커는 전송 직전 `OMOCAT/lane-leases/<lane>/`가 있으면(=전환 중) **admission을 멈춘다**(intake·batch 확정은 계속). 전송 중에는 `kakao-queue.sqlite`의 `batches.state='accepted'`가 곱 in-flight 표시다. `lane-transition.ts`는 이 표시가 사라지거나 120 s가 지나면 진행하고, 남은 `accepted/uncertain`은 영수증 최종 조회 후 `persisted` 또는 `carried`로 분류한다(§2.8).
8. **팔백/롤백 경로(검토 18)**: `kakao-queue.ts replay-legacy [--lane L]`는 `queued/carried/uncertain(영수증 없음)` 배치를 순서대로 구버전 경로(`bun sess.ts send <lane> <body>`, herdr)로 내보내고 `persisted`로 표시한다 — 구코드로 되돌리기 전에 실행하는 드레인. 구코드는 파일 끝에서 시작하므로 이 드레인 없이 되돌리면 미전달 배치가 사라진다.
9. `kakao-stall.ts`는 push.log 대신 `batches`의 가장 오래된 비종료 배치 나이로 판정한다(읽기 전용).

### 2.8 레인 전환 절차 (`OMOCAT/lane-transition.ts`, 신규) — reset·quota·migrate·교체 복구의 단일 경로

```
lane-transition.ts <key> (--fresh [--account A | --model M --thinking T] [--reason quota|reset|manual] | --adopt-replacement) [--profile P] [--dry]
```

단계(각 단계는 `OMOCAT/ops/<opId>.json`에 `done/failed`로 기록; 재시작 시 마지막 done 다음부터; 멱등이 아닌 단계는 없다):
1. `withLaneLease(key, 'transition')` — 실패하면 `lease_held`로 종료(exit 4). `generation`을 읽고 `g+1`을 예약.
2. 사전조건: `rpc.children`이 known이고 running 0(unknown/`--force` 없으면 exit 4 `children_unknown`); quota 사유가 아니면 `settled` 대기(`rpc.wait --until idle`, 상한 설정; 구 restart 스크립트의 2 h 대기를 대체). **quota 사유는 대기 없음.**
3. admission 정지: lease 존재 자체가 신호(§2.7-7). in-flight 배치가 있으면 최대 120 s 대기.
4. 인벤토리: 구세션 `sessionPath`에서 (a) outbox의 `accepted/uncertain` 배치 → `receipt` 최종 조회; (b) `persisted`인데 **미처리**인 전달 = 그 `custom_message` 엔트리 뒤에 성공한 assistant 엔트리(`stopReason!=='error'`)가 없는 것; (c) 영수증 없는 `accepted/uncertain`; (d) `queued`. (b)(c)는 `carried`로 표시하고 새 id `${id}:g${g+1}`로 재전달 대상에 넣는다(본문 앞에 `[이어받음: 이전 세션에서 미처리]`). 전부 `OMOCAT/lane-transitions.jsonl {key, g, from:{durableId,sessionPath}, carried:[…], persistedUnprocessed:[…], at}`에 기록.
5. handoff artifact `~/.dori/state/handoffs/<key>/g<g+1>.md`: 프로필(`OMOCAT/lane-profiles/<P>.json`: `ext[]`, `tools[]`, `model`, `thinking`, `noClaim`, `briefPath`)의 최신 브리프 + 마지막 reopen 텍스트 + 진행 checkpoint(`[REPORT]` 최근 8줄 + 최근 12 메시지; 파서는 `custom_message` 전달 엔트리도 포함 — 검토 3) + carried 목록 + `claimRule`은 `!noClaim`일 때만(검토 14).
6. 구세션 닫기: `herdr tab close <expected.tab>`(CAS). `--adopt-replacement`에서는 생략(이미 교체됨).
7. 새 세션 열기: `sess.ts open`의 내부 함수를 lease 안에서 호출(새 durable id, `OMOMEOW_LANE_KEY`, 프로필의 `-e …`/`--tools …`에 `--claude-account A`를 **합성**한 argv). `--adopt-replacement`에서는 pane 프로세스 argv/`list_sessions`에서 새 durable id를 읽는다.
8. 검증(검토 13): `herdr pane process-info`의 argv에 요청한 `--claude-account A`가 있어야 `done`. `account` 바인딩은 첫 turn 뒤 생기므로 `accountRequested=A`를 기록하고, supervisor가 바인딩 사이드카 출현 시 `lane.account_bound`/`lane.account_mismatch`(ask)를 낸다.
9. 재바인딩: `patchLane(key, g, {sessionId, sessionPath, generation:g+1, sessionVia:'transition', accountRequested, model, profile, lineage.sessions+=[old], seed:{state:'pending', id:'seed:<key>:g+1'}})`.
10. seed 전달: artifact를 `rpc.send(key, artifact, {id:'seed:<key>:g+1'})` → `persisted` 영수증이 있어야 `seed.state='applied'`. 그 전까지 Kakao 워커는 lease가 없어도 `seed.state!=='applied'`이면 그 레인에 보내지 않는다(외부 admission 보류). 실패 → `ask lane.empty_after_handoff`(검토 14: 판정은 `messageCount===0`이 아니라 seed id 영수증).
11. carried 재전달: 순서대로 새 id로 전송(각각 persisted 확인). `lane-migrations.jsonl` 기록, lease 해제, `lane.transition`(act) 이벤트.

사용처: `lane-migrate.ts`는 이 명령의 얕은 wrapper가 된다(`kakao-*` 거부 삭제 — 프로필이 확장/도구를 알기 때문에 가능). `jangdori-restart.sh`, `friend-restart.sh`, `acme-docs-restart.sh`, `dandori-docs-restart.sh`는 각각 `bun ~/.omocat/lane-transition.ts <key> --fresh --reason reset --profile <P>` 한 줄로 바뀜다(busy 화면 정규식·`OMOMEOW_OMO_ARGS` 덮어쓰기 제거). `lane-restart.sh`(같은 세션 재기동)는 수동 전용으로 남기되 settled 질의와 lease를 쓴다.

---

## 3. 마이그레이션 단계 (원본은 `plan.json`; 여기는 요약)

공통 규칙:
- 단계 = 커밋 1개(`OMOCAT`, 제목 `rpc-N: …`; S3과 S9는 `~/.dori/src` 커밋 1개 추가). 킬스위치는 **파일**(`OMOCAT/transport.json`, `OMOCAT/flags/<name>`)이다 — 환경변수는 실행 중인 launchd/monitor 자식에 닿지 않는다(검토 18). 각 장기 프로세스의 재시작 명령은 plan.json의 `rollback`에 명시.
- 모든 단위 테스트는 `OMOCAT_HOME=<tmp>`(신규 env; registry/queue/events/leases 경로의 루트)로 **격리된 트리**에서 돌고, 롤백 리허설도 거기서 먼저 한다(검토 19). 경쟁 테스트는 `(cmd &)`가 아니라 두 `Bun.spawn`의 `exited`를 `Promise.all`로 기다린다. holder 픽스처는 런타임 형식(`{pid,bootAtMs,processStartedAtMs}`)으로 만들고 pid 재사용(살아 있지만 start time 불일치) 사례를 포함한다.
- 라이브 확인은 상설 테스트 레인 `rpc-smoke`(cwd `/tmp/omocat/rpc-smoke`, 스레드 없음, 브리프 "ping에 pong으로만 답하라")에만 보낸다. 준비: `mkdir -p /tmp/omocat/rpc-smoke && printf 'ping에는 pong으로만 답해라. 다른 일은 하지 마라.\n' > /tmp/omocat/rpc-smoke/brief.md && bun ~/.omocat/sess.ts open rpc-smoke "RPC smoke" /tmp/omocat/rpc-smoke /tmp/omocat/rpc-smoke/brief.md`. 다른 라이브 레인에는 읽기 전용 확인만.
- 대기는 이벤트 구독(`rpc.ts wait`)으로; sleep 루프 금지.

| 단계 | 내용 | 의존 | 병렬 가능 |
|---|---|---|---|
| S1 | RPC 어댑터 `rpc.ts` + `sess.ts send/status/receipt` + `transport.json` 허용 목록(herdr 폴백 유지) | — | S2와 |
| S2 | Discord 채널/스레드 가드(`oc.ts`, `dori-hook.ts`) | — | S1과 |
| S3 | 레지스트리 `registry.ts`(patchLane + withLaneLease + generation) + `registry-sync.ts` + dori `Registry.update` + `sess.ts` 수명주기 재작성(holder 검사, `OMOMEOW_LANE_KEY`) + `LANE_UNRESOLVED` | S1 | — |
| S4 | supervisor v1(구독·상태기계·이벤트 파일·재시작 경계) + `herdr-watch.ts --source rpc` | S1, S3 | S7과 |
| S5 | 하위 작업 관측(`include_workers`, unknown, settled) + `rpc.ts children/--child-ok` + `lane-restart.sh` settled 질의 | S4 | S7과 |
| S6 | `event-router.ts` + checkpoint + `monitors.json`(herdr 모니터 제거, dori-sweeps 필터) + `dori-monitors.sh` 파이프 | S3, S4 | S7과 |
| S7 | Kakao 큐(`kakao-queue.ts` sqlite, `kakao-push.ts` 재작성, 분할, 레인별 방, `kakao-stall.ts`, replay-legacy) | S1, S3 | S4·S5·S6과 |
| S8 | `lane-transition.ts` + `lane-classify.ts` + 프로필 + restart 스크립트 4개 + `lane-migrate.ts` wrapper | S5, S7 | — |
| S9 | supervisor 정책(quota/교체 복구/nudge/reap) + ops 원장 + 옛 실행자 제거(`lane-health.ts` auto, `freshness --no-nudge`, `panes.ts sendVerified(key)`) | S6, S8 | — |
| S10 | 단계적 cutover: `transport.json` 허용 목록 확대 → 기본 rpc; 24 h 관측 지표 | S9 | — |

의존 그래프: `S1 → S3 → S4 → S5 → S8 → S9 → S10`, `S3 → S7 → S8`, `S4 → S6 → S9`, `S2`는 독립. 병렬 집합: {S1, S2}, {S4, S7}, {S5, S6, S7}. 각 단계 뒤 최소 1일 관찰.

---

## 4. RPC로 안 되는 것과 대안

| 안 되는 것 | 근거 | 대안 |
|---|---|---|
| pane에 세션 만들기/붙이기 | `open_session`은 헤드리스 호스트 세션; tui는 `terminal_single_session` | `sess.ts open`의 `herdr tab create` + `pane run omo …` 유지. 준비 대기만 바꾼다: 화면 폴링 → 그 세션의 tui `endpoint.json` 출현 + `get_state` 응답(`rpc.ts wait-endpoint <durableId> 90s`). Init-deep 건너뛰기 키입력은 §5-10 |
| 세션별 Claude 계정 지정/조회 | `open_session`에 계정 파라미터 없음; tui에서 `get_provider_accounts`/`get_subscription_limits`는 `unsupported` | 시작 플래그 `--claude-account`(프로필과 합성, §2.8-7); 계정은 `<jsonl>.claude-sdk-oauth-binding.json`, 사용량은 `subscription-usage.json`(+freshness) |
| 슬래시 명령(`/quit`, `/handoff`, `/compact`) | admission은 슬래시 명령을 안 받음; tui 명령에 `compact/close_session` 없음 | 어댑터는 `^/`를 거절. 종료 = tab close, 교체 = `lane-transition.ts`, compaction은 런타임 자동 설정에 맡김 |
| 세션 종료/언로드를 RPC로 | tui에 없음 | tab close. 호스트 세션(데스크톱)은 Dandori가 건드리지 않음 |
| tui에서 전달 영수증/대기 중 입력 조회 | tui 명령에 `get_pending_inputs`/`get_entries` 없음; `get_effect_status`는 호스트 전달용 | `sessionPath` JSONL을 직접 읽는 `rpc.receipt`(§2.1); 세션이 죽어 있어도 동작 |
| 원자적 exclusive open | `holdSessionFile`은 다른 holder를 거절하지 않음(✔) | 자동 경로는 FRESH만; 수동 reopen은 lease + 사전·사후 holder 검사(§2.2) |
| "이 세션을 요약해 새 세션으로" 핸드오프 | 그런 와이어 명령 없음; `thread_create{fork_from}` 동작 미확인 | `lane-transition.ts`의 handoff artifact(§2.8-5) |
| 레인의 하위 작업 한 번에 조회 | 세션 간 하위 열람 API 없음 | §2.5: 호스트별 구독(`include_workers:true`) + herdr-dag + Herdr 보고; 모르면 unknown |
| 데스크톱에서 Herdr 레인에 보내기 | `session_held` 거절 | 설계상 옳다. 주인이 데스크톱에서 다루려면 pane에서 종료 후 adopt |
| `senpi host session …` CLI로 레인 제어 | tui 소켓은 `unsupported_endpoint_kind` | `RpcClient` import(§5-2) |
| 이미지·thinkingLevel 포함 전달 | `unsupported_field`(✔) | 카카오 사진은 URL 텍스트 — 변경 없음 |
| 런타임 메모리의 admission 집합을 재시작 너머로 믿는 것 | `pending/emitted/failed`는 메모리(✔) | 멱등성은 디스크 영수증 우선 조회로 어댑터가 보장(§2.1 규칙 1) |
| 리드 LLM이 직접 소켓을 다루는 것 | 리드는 `thread_send/thread_list`·`monitor({type:"rpc"})`를 이미 가짐 | 리드 → 레인 지시는 `sess.ts send` 한 경로로 통일(영수증·이벤트 한 곳). `thread_send`를 쓰더라도 같은 메시지를 어댑터로 다시 보내지 않는다(경로 혼용 금지) |

---

## 5. 결정이 필요한 것 (선택지 + 추천; 초안 대비 변경은 ★)

1. **어댑터 기본 전송 모드.** (a) `steer{whenIdle:"start"}` / (b) `follow_up` / (c) `prompt`. **추천 (a)**, 호출별 `--mode`. 카카오는 (a), 리드의 긴 지시는 (b).
2. **소켓 클라이언트.** (a) 전역 senpi `RpcClient` import + `protocolVersion` 가드 / (b) 자체 구현 / (c) `omo thread send`만. **추천 (a)**; 가드 실패는 "미전송 증명" 거절이라 herdr 폴백 조건을 만족.
3. ★ **내구 큐의 위치.** (a) 자체 outbox(sqlite) + 어댑터 직접 전송만 / (b) 모두 gateway / (c) 혼합. **추천 (a)** — 초안의 (c)는 검토 2로 기각(두 경로의 id 대응 미검증 → 중복). gateway 경로는 "두 경로의 영수증 대응을 픽스처로 증명한 뒤"에만 별도 단계로 도입.
4. **레지스트리 형식.** (a) JSON v2 + 정합 루프 + lease / (b) `registry.sqlite`. **추천 (a)**. 승격 조건: S3 이후 30일간 `registry.drift`가 같은 레인 3회 이상 또는 `generation_conflict`가 주 1회 이상 재발, 또는 계보/승인 조회 도구 2개 이상.
5. **리드 wake 예산.** (a) ask 즉시 + digest 15분 / (b) 30분 / (c) act도 즉시. **추천 (a)**; 밤(23:30–07:00 KST) 60분.
6. ★ **`/handoff` 정책.** (a) 금지하고 `lane-transition.ts --fresh`로 통일(handoff artifact + seed 영수증) / (b) 허용 + 교체 복구 의존. **추천 (a)**; `lane-health.ts:50`의 "/handoff 타이핑" 권고는 삭제. (b)는 사람이 pane에서 직접 실행한 경우의 복구 경로로만 남는다.
7. **데스크톱/Herdr 공용 라벨.** `set_session_name "[lane:<key>] <label>"`. **추천 적용**.
8. ★ **감독 데몬 실행 형태.** (a) launchd KeepAlive + 이벤트 파일, router는 `dori-monitors.sh` 안 / (b) 모두 `dori-monitors.sh` 안. **추천 (a)** — 단, 리드로 가는 유일한 입구는 router 하나이고 herdr monitor는 제거(검토 11).
9. ★ **카카오 방 귀속.** (a) 레인별 불변 방 파일 `room.<lane>` + `OMOMEOW_LANE_KEY` / (b) envelope에 방 id. **추천 (a) 지금**(1:1 매핑), 방 공유 레인이 생기면 (b). 초안의 "CURRENT_ROOM 유지"는 검토 9로 기각.
10. **Init-deep 시작 프롬프트.** (a) `send-keys down/enter` 유지 / (b) 런타임 설정으로 끔(키 미확인). **추천 (b) 확인 후, 그 전까지 (a)**.
11. **상설 테스트 레인 `rpc-smoke`.** **추천 상시 유지**, quiet.
12. ★ **kakao 레인의 quota 조치.** (a) supervisor가 `lane-transition.ts <key> --fresh --account <next> --profile <P>` 실행(act; 드레인 대기 없음) / (b) ask만. **추천 (a)**. 초안의 "restart 스크립트에 `OMOMEOW_OMO_ARGS` 주입"은 검토 13으로 기각(스크립트가 덮어쓴다).
13. ★ **레지스트리 동시 쓰기 보호.** (a) 잠금+키 단위 패치만 / (b) + 레인별 lease + generation CAS / (c) 단일 writer 데몬. **추천 (b)**; (c)는 §5-4 승격과 함께. :05 분산은 유지하되 보호로 치지 않는다.
14. ★ **Kakao 큐 저장소(신규).** (a) `bun:sqlite` 한 파일 / (b) NDJSON + 커서 JSON. **추천 (a)**(§2.0 (라)).
15. ★ **전송 전환 단위(신규).** (a) `transport.json` 허용 목록: `rpc-smoke` → `kakao-acme-docs` → 전체 / (b) 전역 `auto`. **추천 (a)**(검토 18).
16. ★ **미처리 전달의 정의(신규).** (a) "persisted 엔트리 뒤에 성공한 assistant 엔트리가 없음" / (b) 레인이 명시적 ack를 보냄(확장 수정). **추천 (a) 지금**, (b)는 오판이 관측되면.

---

## 6. 검토 반영표

판정: **수정** = 설계를 바꿨다 / **기각** = 사유와 함께 그대로 둠 / **부분 수정** = 제안의 일부만 반영(사유 명시). "위치"는 이 문서의 절과 `plan.json` 단계 id.

| # | 심각도 | 판정 | 반영 내용 | 위치 | 수용 테스트(요약) |
|---|---|---|---|---|---|
| 1 | blocker | **수정** | `duplicate:true`는 `accepted`로만 취급. 성공 = `custom_message`의 `details.delivery_id === id` 영속 영수증뿐. 상태를 `attempting/sent/accepted/persisted/refused/uncertain`로 분리; outbox 완료 조건은 `persisted` + `sent_to.sessionPath` 기록. `failed`가 settle 뒤 비워져 같은 id가 다시 admit될 수 있음을 소스로 확인하고(§1.1 ✔) 디스크 영수증 우선 조회로 다줄 | §2.1 상태기계 규칙 1·2·3; S1, S7 | 큐에만 있는 duplicate → 재시작 후 영수증 없음 → 재전송 1회만; 기록 실패(failed) duplicate → settle 후 재전송 → transcript에 id 1개 |
| 2 | blocker | **수정** | 폴백은 "RPC로 바이트 미전송이 증명된 거절(`no_endpoint`: ENOENT/연결 거부/핸드셰이크 실패/`steer` 미지원/protocol 가드)"에서만. 전송 후 연결 오류는 `uncertain` 고정 + 같은 id 영수증 조회. 한 id는 한 transport에 고정(outbox `transport` 열). RPC→gateway 전환 금지(어댑터에서 gateway 경로 제거). `deliver.ts`는 외부 id를 받도록 옵션 추가(`newId` 주입 유지) | §2.0 (나), §2.1 규칙 4·7, §5-3; S1 | "적용 후 응답 유실" 모의: 소켓이 응답 전 끊김 → `uncertain`, herdr 호출 0회, 영수증 발견 시 delivered |
| 3 | major | **수정** | 영수증 형식을 `type:"custom_message"` + `details.delivery_id` 정확 동등으로 명시(§1.1 ✔, `session-manager.js` `appendCustomMessageEntry`). herdr 폴백은 `user` 태그. `lane-migrate.ts` 파서(→ `lane-transition.ts`)에 `custom_message` 전달 포함. "세션 단위 exactly-once 보장" 표현 삭제; 멱등성은 어댑터의 디스크 조회가 담당 | §1.1, §2.1 규칙 1·3, §2.8-5; S1, S8 | 같은 세션 재개 후 동일 id 재시도 → 영수증이 있으므로 미전송; compaction 후도 동일 |
| 4 | blocker | **수정** | 전역 map 잠금과 별도로 `withLaneLease(key, op)`를 open/close/reopen/transition/reap 전체에; `generation` CAS; close는 `expected.tab` CAS. 자동 경로는 same-transcript resume 금지(FRESH + handoff), 수동 reopen만 허용하되 holder 사전·사후 검사 후 충돌은 `ask`. 런타임 exclusive-open 계약 부재를 소스로 확인(✔) | §2.0 (다), §2.2 쓰기 규칙 2·재개 정책, §2.6; S3 | reopen/reopen 동시 → 한쪽 `lease_held`; close/reopen 교차 → 세션 1개; desktop holder 픽스처/reopen → exit 6; 사후 holder 출현 → `lane.holder_conflict` 1건 |
| 5 | major | **수정** | dori-mode `Registry.write(lane)` → `Registry.update(key, fn)`(키별 잠금 + 재읽기 + tmp+rename); `done-flow.ts`/`freshness.ts`/`launch.ts` 호출부 전환; omocat 미러는 같은 키별 잠금 프로토콜. **S3에서** dori 리포 커밋 포함(Step 8로 미루지 않음). 투영 파일 분리안은 채택하지 않음(읽는 곳 5곳이 `session`을 lane 파일에서 기대) | §2.2 쓰기 규칙 3; S3 | 정합기 session 패치와 freshness `lastNudgeAt` 패치를 동시 실행 → 두 필드 모두 남음(교차 리포 테스트) |
| 6 | blocker | **수정** | `outbox-drained` 게이트 삭제. 레인별 전환 장벽 = lease(존재 자체가 admission 정지 신호) + in-flight 120 s + 인벤토리(persisted/미처리/uncertain/queued) + `lane-transitions.jsonl` 원장 + carried 재전달. quota는 대기 없이 전환. restart 스크립트 4개(jangdori/friend/acme-docs/dandori-docs) + `lane-restart.sh`를 변경 파일에 명시 | §2.7-7, §2.8; S7, S8 | 전환 중 메시지 유입 → intake된 뒤 새 세션으로 전달; quota 상태의 비어 있지 않은 outbox → 전환 진행 + carried 재전달 |
| 7 | major | **수정** | `(chat_id, log_id)` 문자열 PK intake 우선; 커서는 완전한 줄 끝 offset + `log_ino`; burst/pending/held/batch membership을 `room_state`/`batches`에 영속; 배치 id는 내용이 아니라 `seq`; 전부 `bun:sqlite` 트랜잭션. Kakao ID를 Number로 다루지 않음 | §2.0 (라), §2.7-1·2·3; S7 | append↔cursor 사이 모든 크래시 지점, 부분 UTF-8/줄, rename/truncate/교체 픽스처 → 유실 0·중복 0 |
| 8 | major | **수정** | `slice(-30)` 삭제. 요청은 순서 고정 분할(각 배치 고유 id, `(n/m)` 헤더). 문맥만 줄이되 원본은 intake 보존 + `[문맥 N줄 생략]` 명시 | §2.7-4; S7 | 31줄 → 2배치 31줄 전달; held 문맥+요청 혼합 → 요청 보존 |
| 9 | major | **수정** | 레인별 불변 방 파일 `room.<lane>` + `OMOMEOW_LANE_KEY`; `kakao-lane-ext.ts room()` 분기; ownerOnly/pinned 예외 유지; 병렬 워커는 모든 kakao 레인 재시작 후에만. envelope 방식은 방 공유 레인 생기면 | §2.7-6, §5-9; S3(env), S7 | A 전달 → B 전달 → A 지연 `kakao_send` → A 방 |
| 10 | major | **수정** | 모든 구독·census에 `include_workers:true` 명시(기본값 false를 소스로 확인 ✔). `children.state='unknown'`(census 미완료/호스트 단절/오래된 DAG 스냅샷) 시 settled 아님 + 파괴 조치 fail closed | §2.3 입력 2, §2.5; S4, S5 | 초기 스냅샷 전/일부 호스트 단절/worker-only 실행 → `turn_done` 없음, restart exit 4 |
| 11 | major | **수정** | 단일 토폴로지: supervisor → `events/supervisor.ndjson` → `tail -F \| event-router.ts`(dori-monitors.sh 안, checkpoint) → 리드 필터 1개. herdr monitor 제거. 정책당 실행자 1개(supervisor; 옛 실행자는 같은 단계에서 끔). `act`=실행+ops 원장, router=분류만, 실행자 없는 실패는 ASK | §2.3 토폴로지; S6, S9 | 전체 파이프 통과로 질문 1회·nudge 1회·전환 1회 |
| 12 | major | **수정** | `lane-classify.ts`: progress/credential/provider/계정 축 분리; `running`↔`working` 변환표; running 중 과거 오류 무시; pre-assistant 실패·진전 없음 모델링; `present=false`/`usageFresh=false` 계정은 후보 제외; GPT credit/429는 `provider_error` | §2.3 quota 모델; S8 | 계정 누락, usage stale, pre-assistant 실패, running 과거 오류, 전체 소진, GPT 429 픽스처 |
| 13 | major | **수정** | restart 스크립트의 `OMOMEOW_OMO_ARGS` 덮어쓰기 확인(✔). 프로필 파일(ext/tools/model/noClaim)과 `--account`를 `lane-transition.ts`가 합성; argv 확인 후 done, 바인딩은 `accountRequested` vs `account`로 사후 검증(`lane.account_mismatch` ask). `lane-migrate.ts`의 kakao 거부 삭제. 스크립트 4개를 변경 파일에 포함 | §2.8-7·8, §5-12; S8 | account 전환/GPT fallback/Claude 복귀 각각 생성 argv 테스트 |
| 14 | major | **수정** | 교체 전 handoff artifact(최신 브리프+checkpoint+미처리 요청+프로필+noClaim) 영속; `claimRule`은 `!noClaim`일 때만; 복구 판정은 `messageCount` 대신 seed id 영수증; seed 적용 전 외부 admission 보류(워커가 `seed.state` 확인). close+FRESH reopen 대신 한 명령 | §2.8-5·9·10, §5-6; S8, S9 | `/handoff` 수동 실행 후 seed 영수증 1개, 그 전 kakao 배치 보류 |
| 15 | major | **수정** | `resolve()`가 `{durableId, sessionPath, routing:{sessionId, socket, kind, instanceId, generation}}`를 분리; 라우팅 id는 요청마다 `list_sessions`에서 재취득, 어떤 파일에도 영속 금지; 캐시 폐기 조건 명시 | §2.1 식별자 계약; S1 | durableId ≠ sessionId 픽스처; host generation 교체 후 재해결 1회 |
| 16 | major | **수정** | mutation은 `managed==='lane'`(현재 sessionId 또는 `lineage.sessions`)만; child는 `--child-ok`+계보; lead/unmanaged 거절; adopt는 명시 등록; secret 비노출; 신규 디렉터리/파일 0700/0600 | §2.1 허용 목록; S1 | 세션 id만 아는 호출로 unmanaged 전송 → `unmanaged_target` |
| 17 | major | **수정** | 이벤트 id = `kind:durableId:instanceId:epoch`; supervisor 상태 파일(구독 cursor, 레인별 마지막 (instanceId, epoch), 미확인 ASK); router checkpoint; `ops/<opId>.json` 단계 상태; 스냅샷은 수렴만. 30분 TTL dedupe 삭제 | §2.3 재시작 경계, §2.4; S4, S6, S9 | 이벤트 기록 전후·조치 전후 데몬·router 각각 재시작 → 중복 이벤트 0, 중복 act 0 |
| 18 | major | **수정** | 롤백은 writer quiesce(lease) 후 v2 필드만 제거(`registry.ts rollback-fields`), 살아 있는 lock 제거 금지(`unlock --if-dead`); Kakao는 intake 유지 + admission 정지 + `replay-legacy` 드레인 후 되돌림; 플래그는 파일(`transport.json`, `flags/`)이고 각 launchd/monitor 프로세스의 재시작 명령 명시; S1은 `rpc-smoke` 허용 목록부터 | §2.1 마지다, §2.7-8, §3 공통 규칙, §5-15; 모든 단계의 `rollback` | 격리 트리에서 롤백 리허설: 미전달 배치가 구경로로 정확히 1회, 다른 레인 binding 보존 |
| 19 | minor | **수정** | 경쟁 테스트는 `Promise.all(spawn.exited)`; holder 픽스처는 런타임 식별자 형식 + pid 재사용 사례; `sendVerified(run, clock, pane, text, key)` 시그니처와 `done-flow.ts`/`freshness.ts` 호출부 변경 명시; smoke 준비 명령(brief 생성) 추가; `OMOCAT_HOME` 격리 트리 | §3 공통 규칙; S3, S9 | plan.json 각 `acceptance` |

기각한 제안(부분): 검토 5의 대안 "투영 파일 분리"는 선택하지 않았다(위 5번 사유). 그 외 기각 없음. 검토의 최종 조건("1·2·4·6 해결 + worker 관측·정책 단일 실행·재시작·롤백을 수용 테스트로 닫기 전에는 기본 `auto`·자동 조치 금지")은 그대로 채택: 기본 전송은 S10까지 `herdr`, 자동 조치는 S9까지 제안(ask)만.

---

## 부록 A. 이번 개정에서 다시 읽은 소스 (검토 인용 검증)

- `RT/core/external-admission.js` 전체: `admit()`의 `already_admitted` 조건, `held_draft`/`turn_conflict`, `pending/emitted/failed` 메모리 집합, `observePersisted/observeRefused/observeRunSettled`, `deliveryMessage()`의 `role:"custom"`/`details.delivery_id`, `turnEpochValue=0`.
- `RT/modes/interactive/session-control-rpc-commands.js:100-210`: `admitInput()`의 `clientMessageId → delivery_id`, `expected_turn_id` 기본값, `UNSERVED_INPUT_FIELDS`, `already_admitted → {disposition:"queued", duplicate:true}`.
- `RT/core/session-manager.js:1570-1590` `appendCustomMessageEntry` (`type:"custom_message"`).
- `RT/core/session-holders.js:1-160`: `identityRecord`, `holdSessionFile`(배타 아님), `activeMover`, `pidAlive`.
- `RT/modes/rpc/session-status-subscriptions.js:55-105`: `includeWorkers ?? selector.kind==='childrenOf'`, `subscriptionMatches`.
- `RT/modes/rpc/session-registry.js:246-262` `list()`: `sessionId`/`durableSessionId` 분리.
- `OMOCAT/sess.ts` 전체, `OMOCAT/deliver.ts` 전체, `OMOCAT/kakao-push.ts:150-290`, `OMOCAT/lane-migrate.ts` 전체, `OMOCAT/lane-health.ts:15-125,165-250`, `OMOCAT/dandori-docs-restart.sh`, `OMOCAT/acme-docs-restart.sh`, `OMOCAT/jangdori-restart.sh`, `OMOCAT/dori-monitors.sh`, `OMOCAT/monitors.json`.
- `DORI/registry.ts:55-95`(`write` tmp+rename 전체 덮어쓰기), `DORI/freshness.ts` 전체, `DORI/panes.ts:40-65`(`sendVerified`), `DORI/done-flow.ts:18-43`(`claimDone/objectDone`).

## 부록 B. 미확인·입력 문서에만 기대는 것

- `/handoff` 실패 시 어떤 확장이 `stale ctx`를 던졌는지(스택 없음). 설계는 `/handoff`를 쓰지 않는 쪽으로 대응.
- `SESSION_CONTROL_DELIVERY_TYPE`의 문자열 값(`"session_control_delivery"`로 문서화; `session-control-types.js` 미재확인) — S1은 상수를 import하거나 라이브 줄을 픽스처로 고정.
- 세션 로드 시 런타임이 transcript의 기존 전달 id를 `emitted`에 다시 채우는지 — 채우지 않는다고 가정하고 디스크 영수즜 우선 조회로 대응(보수적).
- `sendSocketHandshake`의 바이트 형식(§5-2 (b) 선택 시만 필요).
- 데스크톱 번들 내부(h-desktop 인용). 설계가 의존하는 부분(같은 `rpc.sock`, `session_held`, holder 형식)은 `ps`와 소스로 확인.
- Init-deep 프롬프트를 끄는 런타임 설정 키(§5-10).
- `friend-restart.sh`의 정확한 내용(h-tools 인용; 미재확인) — S8에서 읽고 같은 방식으로 바꾼다.
