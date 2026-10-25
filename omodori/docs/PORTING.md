# 새 Mac에 도리 런타임 옮기기

이 폴더(`omodori/`)는 Discord·카카오톡 도리 런타임(supervisor, listener, lane 관리, 카톡 큐, 결정함, heartbeat)이다.
lane을 띄우고 닫는 `dori` CLI와 스킬은 저장소 루트의 `skills/dori-mode`에 있다. 둘 다 설치한다.

기기마다 달라지는 값은 전부 `$OMOCAT_HOME/config.json` 하나와 그 옆의 데이터 파일 몇 개에 모여 있다.
코드에는 기본값만 들어 있다. 기본 설치 위치는 `~/.omocat`이고, `OMOCAT_HOME`으로 바꿀 수 있다.

## 1. 준비물

| 도구 | 확인 | 용도 |
|---|---|---|
| bun 1.3+ | `bun --version` | 전체 런타임 |
| omo | `omo --version` | lane 에이전트 세션 |
| herdr | `herdr --version` | lane이 도는 터미널 |
| sqlite3, jq | 기본 macOS + `brew install jq` | 카톡 큐, 설정 검사 |
| gh | `gh auth status` | PR·이슈 완료 확인 |
| agent-messenger | `bun install` 이 설치 | Discord 봇, 카톡 LOCO |

`install.sh`가 bun, omo, herdr, sqlite3, jq, plutil, launchctl을 확인하고 없으면 멈춘다.

## 2. 비밀값 (저장소에 절대 넣지 않음)

- `~/.config/agent-messenger/discordbot-credentials.json`: `{"bots":{"omocat":{"token":"..."}}}` 형식의 Discord 봇 토큰
- `~/.config/agent-messenger/kakaotalk-credentials.json`: 카톡 서브기기 로그인 결과 (`agent-messenger` 로그인 절차로 생성)
- `~/.config/omomeow/typesafe.env`: 카톡 wake-filter 분류기 키 (카톡을 안 쓰면 필요 없음)
- `$OMOCAT_HOME/prb-admin-key.txt`: 버튼 relay(`discord.relayUrl`)를 쓸 때만

`.env.example`에 환경변수로 덮어쓸 수 있는 값이 정리돼 있다.

## 3. 설치

```sh
git clone https://github.com/dip-con/omo-dori-mode-experimental.git
cd omo-dori-mode-experimental/omodori
./install.sh            # dry run: 바뀌는 것 없음, 할 일만 출력
$EDITOR ~/.omocat/config.json   # --apply 가 example 에서 만들어 준 뒤 값 채우기
./install.sh --apply --no-load  # 코드 복사, config/데이터 파일 생성, bun install, plist 작성
./install.sh --apply            # 값 확인 끝나면 LaunchAgent 등록
```

마지막 줄은 `INSTALL_DRY_RUN_OK`, `INSTALL_OK` 또는 `INSTALL_FAILED <이유>`다.
이미 있는 `config.json`과 데이터 파일은 덮어쓰지 않는다.

## 4. config.json 체크리스트

`bun ~/.omocat/config.ts --check`가 형식을 검사한다(`CONFIG_OK` / `CONFIG_ERROR ...`).

- [ ] `discord.guildId`, `discord.ownerId`: 서버 ID와 주인 계정 ID (Discord 개발자 모드 > ID 복사)
- [ ] `discord.generalChannel`, `inboxChannel`: 일반 채널, 결정함 채널
- [ ] `discord.ceoThread`, `buildThread`, `wakeStatsThread`: 주간 브리핑, 빌드 보고, wake-filter 집계 스레드 (안 쓰면 비워 둠)
- [ ] `kakao.healthChatId`: kakao-health가 살아있는지 보는 방 ID
- [ ] `kakao.ragChatIds`: 문서검색 lane이 답할 수 있는 방 ID
- [ ] `kakao.ownerRoom`: kakao-owner lane이 쓰는 방 이름(kakao-rooms.json의 `name`)
- [ ] `kakao.archiveRoot`: 카톡 아카이브(kka) 폴더. 답장 원문을 여기서 찾는다
- [ ] `kakao.requestsLedger`: 비서 lane의 요청 장부 JSON 경로 (없으면 비워 둠)
- [ ] `launchd.prefix`: LaunchAgent 이름 앞부분 (예: `com.yourname.dori`)
- [ ] `launchd.services`: 설치할 서비스. 목록은 `launchagents/services.json`
- [ ] `claudeAccounts`: lane 계정 전환에 쓰는 omo Claude 계정 이름
- [ ] `paths.disks`: heartbeat가 여유 공간을 볼 디스크 (`/`, 외장 SSD 등)
- [ ] `paths.genericCwds`: lane-reaper가 "프로젝트 폴더 아님"으로 볼 경로
- [ ] `paths.memoryRepo`, `git.*`: git-sync를 켤 때만

## 5. 데이터 파일 ($OMOCAT_HOME, 저장소에 올리지 않음)

| 파일 | 예시 | 내용 |
|---|---|---|
| `channels.json` | `examples/channels.json` | Discord 프로젝트 채널 -> 저장소 경로 |
| `kakao-rooms.json` | `examples/kakao-rooms.json` | 카톡 방 ID -> lane, 주인 ID, 규칙 |
| `seo-sites.json` | `examples/seo-sites.json` | watch.ts 주간 SEO 점검 사이트 |
| `repo-patrol.json` | `examples/repo-patrol.json` | 매일 볼 저장소 목록 |
| `owner-profile.md` | `examples/owner-profile.md` | 주인 프로필 |
| `kakao-owner-brief.md` 등 | `examples/briefs/` | lane 상시 지침 |

`lane-profiles/*.json`은 lane 종류별 실행 설정이다. 카톡 lane 이름을 바꾸면 `kakao-rooms.json`의 `lane`과 맞춘다.

## 6. 설치 후 확인

```sh
launchctl list | grep "$(jq -r .launchd.prefix ~/.omocat/config.json)"
tail -f ~/Library/Logs/dandori-supervisor/supervisor.log
cd ~/.omocat && bun test
```

lead 세션(herdr 안의 omo)에서 `monitors.json`의 상시 모니터를 등록하고, `bun monitors-check.ts`가 `MONITOR_MISSING` 없이 끝나는지 본다.
omo 확장 `dori-guard`를 쓰려면 `omo-extensions/dori-guard.shim.txt`의 경로를 새 `$OMOCAT_HOME`으로 바꿔 omo 확장 폴더에 넣는다.

## 7. 이 이식판에 없는 것

원래 Mac에서 쓰던 고객사·지인 전용 lane(특정 회사 문서·견적 도구, 게임 클랜 통계, 개인 알림, 메일·클라우드 감시 스크립트)과
운영 기록(결정 로그, 설계 문서, 증거 파일, 브리프 원본)은 개인정보 때문에 뺐다. 필요하면 `kakao-lane-ext.ts`에 도구를 추가하고
`lane-profiles/`에 프로필을 만들어 붙인다.
NAS·Tailscale 주소는 코드 어디에서도 쓰지 않아 설정 항목이 없다.
