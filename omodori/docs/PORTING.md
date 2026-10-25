# 새 Mac에 도리 런타임 옮기기

이 폴더(`omodori/`)는 도리 런타임이다. 두 부분으로 나뉜다.

- `core/`: 어느 PC나 같은 것. 감독 데몬(supervisor), omo RPC 전달, 이벤트 라우터, lane 열기·닫기·인계, 가드, heartbeat,
  호스트 감시, 요청·약속 장부, 결정함, 리드용 Discord 운영 채널.
- `sources/<이름>/`: 메신저 소스. PC마다 다른 대화방 연결은 여기다(`kakao` = 카카오톡, `discord` = Discord 봇 수신).
  소스는 `manifest.json`과 `source.ts` 계약 하나로만 core에 붙고, core는 config.json의 `sources[]`로만 소스를 안다.

순서는 **설치(core) → 온보딩(소스 연결)** 이다. 설치만 해도 core는 소스 0개로 정상 동작하고 테스트가 통과한다.
lane을 띄우고 닫는 `dori` CLI와 스킬은 저장소 루트의 `skills/dori-mode`에 있다. 둘 다 설치한다.

기기마다 달라지는 값은 전부 `$OMODORI_HOME/config.json` 하나와 그 옆의 데이터 파일 몇 개에 모여 있다.
코드에는 기본값만 들어 있다. 기본 설치 위치는 `~/.omodori`이고, `OMODORI_HOME`으로 바꿀 수 있다.

## 1. 준비물

| 도구 | 확인 | 용도 |
|---|---|---|
| bun 1.3+ | `bun --version` | 전체 런타임 |
| omo | `omo --version` | lane 에이전트 세션 |
| herdr | `herdr --version` | lane이 도는 터미널 |
| sqlite3, jq | 기본 macOS + `brew install jq` | 전달 큐, 설정 검사 |
| gh | `gh auth status` | PR·이슈 완료 확인 |
| agent-messenger | `bun install` 이 설치 | Discord 봇, 메신저 소스 |

`install.sh`가 bun, omo, herdr, sqlite3, jq, plutil, launchctl을 확인하고 없으면 멈춘다.

## 2. 비밀값 (저장소에 절대 넣지 않음)

- `~/.config/agent-messenger/discordbot-credentials.json`: `{"bots":{"assistant":{"token":"..."}}}` 형식의 Discord 봇 토큰 (core 운영 채널)
- `$OMODORI_HOME/prb-admin-key.txt`: 버튼 relay(`discord.relayUrl`)를 쓸 때만
- 소스별 자격증명은 그 소스의 `manifest.json` `credentials`에 적혀 있고, 온보딩이 있는지 확인하고 없으면 만드는 방법을 출력한다
  (카톡: `~/.config/agent-messenger/kakaotalk-credentials.json`, wake-filter 분류기 키 `~/.config/omodori/typesafe.env`).

`.env.example`(core)과 `sources/<이름>/.env.example`에 환경변수로 덮어쓸 수 있는 값이 정리돼 있다.

## 3. 설치 (core)

```sh
git clone https://github.com/dip-con/omo-dori-mode-experimental.git
cd omo-dori-mode-experimental/omodori
./install.sh                     # dry run: 바뀌는 것 없음, 할 일만 출력
./install.sh --apply --no-load   # 코드 복사, config/데이터 파일 생성, bun install, core plist 작성, omodori 명령 링크
$EDITOR ~/.omodori/config.json   # 4장 체크리스트대로 값 채우기
omodori check                    # CONFIG_OK 확인
./install.sh --apply             # core LaunchAgent 등록
```

마지막 줄은 `INSTALL_DRY_RUN_OK`, `INSTALL_OK` 또는 `INSTALL_FAILED <이유>`다.
이미 있는 `config.json`과 데이터 파일은 덮어쓰지 않는다. 새 config는 `sources: []`(소스 0개)로 시작한다.
`omodori` 명령은 `~/.local/bin/omodori`에 생긴다(`$OMODORI_HOME/core/cli.ts`를 실행).

## 4. 온보딩 (메신저 소스 연결)

```sh
omodori sources                  # 소스 목록과 연결 여부
omodori onboard kakao --dry-run  # 무엇이 바뀔지만 출력: config 항목, 데이터 파일, 그 소스의 plist 목록
omodori onboard kakao            # 대화형: 설정값 → 자격증명 확인 → 방 목록 → 봇 → config 검사 → plist 등록 → health
```

온보딩 순서:

1. 소스 고르기 (생략하면 목록에서 고른다)
2. 설정값: `manifest.json`의 `settings`를 하나씩 묻는다. `--set key=value`로 미리 줄 수 있고, 다시 온보딩하면 지금 값이 기본값이다
3. 자격증명: 파일이 없으면 `CREDENTIAL_MISSING <파일> -> <만드는 방법>`
4. 데이터 파일: 카톡은 `kakao-rooms.json`(방 ID → 이름, lane, 주인 ID). 방을 하나씩 입력하거나 `--data kakao-rooms.json=<파일>`로 준비한 파일을 쓴다. 둘 다 없으면 예시 파일을 복사하고 고치라고 알린다
5. 봇 (카톡처럼 `usesBots` 소스, config의 `bots[]`가 비어 있을 때만): 이름, 호출어, 한 줄 설명. `--bot "이름=호출어1,호출어2"`
6. config 검사(core + 모든 소스). 통과해야 `config.json`을 쓴다(먼저 `config.json.bak-<시각>` 백업)
7. **그 소스의 LaunchAgent만** 만들고 lint하고 등록한다 (`--no-load`면 파일만). `--agents a,b`로 고른다
8. 소스의 `healthCheck` 실행

마지막 줄: `ONBOARD_OK`, `ONBOARD_DRY_RUN_OK`, `ONBOARD_HEALTH_FAILED`, `ONBOARD_FAILED <이유>`.
연결 끊기: `omodori offboard kakao [--dry-run]` (LaunchAgent 내리고 plist 삭제, config의 `sources[]`에서 뺌. 데이터 파일은 남김).

도리 스킬로 진행할 때도 같은 명령을 쓴다: 에이전트가 `--dry-run` 결과를 주인에게 보여 주고, 주인이 답한 값을 `--set`으로 넣는다.

## 5. config.json 체크리스트

`omodori check`(= `bun ~/.omodori/core/config.ts --check`)가 형식을 검사한다(`CONFIG_OK` / `CONFIG_ERROR ...`).

core:

- [ ] `discord.guildId`, `discord.ownerId`: 서버 ID와 주인 계정 ID (Discord 개발자 모드 > ID 복사)
- [ ] `discord.generalChannel`, `inboxChannel`: 일반 채널, 결정함 채널
- [ ] `discord.ceoThread`, `buildThread`, `wakeStatsThread`: 주간 브리핑, 빌드 보고, wake-filter 집계 스레드 (안 쓰면 비워 둠)
- [ ] `discord.botName`: `discordbot-credentials.json`의 `bots.<이름>` (기본 `assistant`)
- [ ] `launchd.prefix`: LaunchAgent 이름 앞부분 (예: `com.yourname.dori`)
- [ ] `launchd.services`: 설치할 core 서비스. 목록은 `core/launchagents/services.json`
- [ ] `claudeAccounts`: lane 계정 전환에 쓰는 omo Claude 계정 이름
- [ ] `paths.disks`: heartbeat가 여유 공간을 볼 디스크 (`/`, 외장 SSD 등)
- [ ] `paths.dataDir`: 큐·레지스트리·sa-cache·events 폴더 (비우면 `$OMODORI_HOME`, 기본 `~/.omodori`)
- [ ] `paths.logDir`: 로그 폴더 (기본 `~/Library/Logs/omodori`, 아래에 `core/`, `supervisor/`, 소스마다 `<소스 이름>/`)
- [ ] `owner.title`: lane 메시지에서 주인을 부르는 호칭 (기본 `owner`)
- [ ] `lead.name`, `lead.keyPrefix`: 리드 이름(lane 규칙 문구), 리드 레지스트리 키 앞부분 (기본 `lead`, `dori-lead`)
- [ ] `bots[]`: 채팅 봇. `name`, `calls`(호출어, 필수: 비우면 이름 호출이 없다), `about`(wake-filter 분류기에 주는 한 줄 설명), `lanes`(이 봇이 답하는 lane), `commands`(늘 깨우는 명령 정규식). lane이 어느 봇에도 없으면 첫 봇, 봇이 없으면 중립 `assistant`. 온보딩이 비어 있을 때 채운다
- [ ] `voice.initialPrompt`: 음성 받아쓰기 힌트 (비우면 봇 이름 + 기본 단어)
- [ ] `paths.genericCwds`: lane-reaper가 "프로젝트 폴더 아님"으로 볼 경로
- [ ] `paths.memoryRepo`, `git.*`: git-sync를 켤 때만

소스 (`sources[]`, 온보딩이 쓴다): `{ "name": "kakao", "agents": [...], "settings": {...} }`.
설정 키와 형식은 각 소스의 `manifest.json` `settings`에 있다. 카톡: `healthChatId`(kakao-health가 보는 방 ID, 필수),
`botUserId`, `ownerRoom`(kakao-owner lane의 방 이름), `ragChatIds`(문서검색 lane이 답할 방), `locoPort`, `archiveRoot`(kka 아카이브),
`archiveSyncLabel`(kka sync LaunchAgent 이름), `requestsLedger`, `generatedImagesDir`, `docOutDir`, `issueRefRooms`.

`kakao-rooms.json`의 방별 스위치: `ownerOnly`(주인 1:1), `pinned`, `ownerFix`, `wakeFilter`, `gate`(호출어 게이트 + 묶음 판정, 문서봇 방),
`replyRefs`(답장용 `[rN]` 번호), `noJev`(분류기 호출 안 함), `maskPii`(분류기 전 개인정보 가림), `stripSelf`(분류기 전 봇 자기 말 제거).

## 6. 데이터 파일 ($OMODORI_HOME, 저장소에 올리지 않음)

| 파일 | 예시 | 내용 |
|---|---|---|
| `channels.json` | `examples/channels.json` | Discord 프로젝트 채널 -> 저장소 경로 |
| `seo-sites.json` | `examples/seo-sites.json` | watch.ts 주간 SEO 점검 사이트 |
| `repo-patrol.json` | `examples/repo-patrol.json` | 매일 볼 저장소 목록 |
| `owner-profile.md` | `examples/owner-profile.md` | 주인 프로필 |
| `lane-brief.md` 등 | `examples/briefs/` | lane 상시 지침 |
| `kakao-rooms.json` | `sources/kakao/examples/kakao-rooms.json` | 카톡 방 ID -> lane, 주인 ID, 규칙 (온보딩이 만든다) |

`core/lane-profiles/*.json`은 lane 종류별 실행 설정이고, 연결된 소스의 `lane-profiles/`도 그다음에 찾는다
(카톡: `sources/kakao/lane-profiles/`). 카톡 lane 이름을 바꾸면 `kakao-rooms.json`의 `lane`과 맞춘다.

## 7. 설치 후 확인

```sh
launchctl list | grep "$(jq -r .launchd.prefix ~/.omodori/config.json)"
tail -f ~/Library/Logs/omodori/supervisor/supervisor.log   # paths.logDir를 바꿨다면 그 아래 supervisor/
omodori sources
cd ~/.omodori && bun test
```

lead 세션(herdr 안의 omo)에서 `core/monitors.json`의 상시 모니터를 등록하고, `bun core/monitors-check.ts`가 `MONITOR_MISSING` 없이 끝나는지 본다.
`core/dori-monitors.sh`는 연결된 소스의 모니터(`manifest.json` `monitors`, 카톡은 kakao-stall)도 같이 돌린다.
omo 확장 `dori-guard`를 쓰려면 install.sh가 만든 `$OMODORI_HOME/omo-extensions/dori-guard.ts`를 omo 확장 폴더에 넣는다.

## 8. 3차(core/sources)로 바뀐 것

- 파일 위치: core 코드는 `core/`, 카톡은 `sources/kakao/`, Discord 수신(`listener.ts`)은 `sources/discord/`. 명령 힌트·모니터 경로도 `~/.omodori/core/...`로 바뀌었다
- config: `kakao` 블록과 `launchd.kakaoArchiveSync`가 `sources[{ name: "kakao", settings }]`(`archiveSyncLabel`)로 옮겨졌다. `launchd.services`에는 core 서비스만 둔다
- core LaunchAgent 로그는 `{logDir}/core/`(전에는 `{logDir}/kakao/`), WorkingDirectory는 `$OMODORI_HOME/core`
- heartbeat 환경변수 `HEARTBEAT_RESTART_KAKAO` → `HEARTBEAT_RESTART_SOURCE_LANES`, 상태 파일의 `kakaoOff` → `sourceOff.<소스>`
- lane 전환 장부(`lane-transitions.jsonl`)와 결과의 `kakao` 필드 → `sources.kakao`
- `watch.ts`의 메일 필터에서 특정 도메인을 뺐다. 필요하면 `DORI_MAIL_FILTER`로 준다

## 9. 이 이식판에 없는 것

특정 설치에만 맞춘 lane 도구·프로필과 운영 기록(결정 로그, 설계 문서, 증거 파일, 브리프 원본)은 넣지 않았다.
`core/lane-profiles/`에는 범용 `default`만, `sources/kakao/lane-profiles/`에는 예시 봇 두 개(`kakao-chat` = 모모, `kakao-docs` = 루루)만 있다.
필요하면 `sources/kakao/kakao-lane-ext.ts`에 도구를 추가하고 프로필을 만들어 붙인다.
NAS·Tailscale 주소는 코드 어디에서도 쓰지 않아 설정 항목이 없다.
