# 공개 전 검사 (2026-10-25, 3차 core/sources 재검사 2026-10-26)

대상: 저장소 전체(`git ls-files --cached --others --exclude-standard`, node_modules 제외) 221개 파일(3차).

| 검사 | 도구 / 방법 | 결과 |
|---|---|---|
| 비밀값 (토큰·키·비밀번호) | gitleaks 8.30.1 `gitleaks dir .` | 0건 |
| 원래 Mac의 실제 Discord·카톡 ID 36개 | 원본 설정에서 뽑은 목록과 숫자 경계 일치 검사 | 0건 |
| 실명·호칭·카톡방 이름·고객사·프로젝트 이름 60개 | 같은 목록, 대소문자 무시 부분 일치 | 0건 |
| 전화번호 | `01[016789]` 형식 | 0건 |
| 이메일 | 주소 형식 (`example.com`, GitHub noreply 제외) | 0건 |
| 사업자번호 | `NNN-NN-NNNNN` | 0건 |
| 주소 | `시/도 + 구/군/시 + 로/길/동` | 0건 |
| 원래 홈 경로·외장 디스크 이름 | 해당 문자열 | 0건 |
| Discord 실 snowflake 범위 | `1(5[5-9]|6x)` + 16자리 | 0건 |

금지 목록 자체는 저장소에 넣지 않았다(목록이 곧 개인정보라서).

## 처리한 것

- 실제 ID는 자릿수가 같은 가짜 값으로 바꿨다(`1000000000000000001`, `18000000000000001` 등). 카톡 ID는 2^53 정밀도 테스트가 의미를 갖도록 크기를 유지했다.
- 테스트·예시의 사람·방 이름은 가상 이름(`주인`, `동료A`, `친구B`, `리드방`, `모임방`, `업무방`)이다. 봇 이름·호출어·설명은 코드에 없고 config.json `bots[]`에만 있다(예시는 가상의 `모모`/`루루`).
- `core/tests/daily-review.test.ts`의 `glpat-...` 문자열은 마스킹을 시험하는 가짜 토큰이라 `gitleaks:allow` 주석을 달았다.
- 테스트는 실제 `~/.omodori`과 `~/.config`를 읽지 않는다. `core/tests/setup-config.ts`가 임시 HOME에 `core/tests/fixtures/dori-home`과 각 소스의 `fixtures/home`을 복사하고 가짜 Discord 토큰 파일을 만든다.
- 메시지 log id 몇 개(`3946...`, `3955...`, `9020...`)는 남겼다. 사람·방을 가리키지 않는 메시지 번호이고, 정밀도 테스트가 그 값을 쓴다.
- 커밋 작성자는 GitHub noreply 주소를 쓴다.

## 다시 돌리기

```sh
gitleaks dir . --no-banner --redact
bun test          # omodori/ 안에서
```
