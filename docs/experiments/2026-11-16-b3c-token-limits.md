# 실측: 토큰 한도 판정을 하나로 합치고 사람별 사용량 파일을 Rust로 옮긴 뒤 실제 세션의 한도 멈춤·시작 거절·깨진 사용량 파일 (B3c)

- 날짜: 2026-11-16(20:11 KST)
- 관련: 이슈 #1270(추적 #1265), 브랜치 `feat/b3c-token-limits`, [ADR-209](../decisions.md)
- 환경: macOS arm64, 로컬 Docker(Colima)
  - 이 브랜치의 worktree에서 `B_STUDIO_EXPERIMENTAL`·`B_STUDIO_TERMINAL`을 지운 셸로 `pnpm studio launch --mode local --port 3923`을 실행했다(인증 `none`이라 요청을 보낸 사람은 `local`).
  - `B_STUDIO_USER_TOKEN_LIMIT=2000`(기간은 기본값 `day`), 사용량 폴더는 실측 전용 `B_STUDIO_USAGE_DIR`(비어 있는 새 폴더)이다.
  - 세션 폴더는 실측 전용 `B_STUDIO_SESSIONS_DIR`이다. 세션은 프로젝트 `vf3`(정적 웹 서비스 하나)의 작업 복사본이다.
  - 하네스(`~/.cache/b-studio-ship/real4/h5/measure-b3c.mjs`)는 화면 없이 API를 부르고 세션의 SSE를 모은다. `tokens.json`은 직접 읽는다.
  - 요청은 실제 Claude Code(stream-json 러너, `/messages`)가 처리했다.
- 한 번씩 잰 값이다.

## 결과

켜지 않은 세션 `94925be6`(`idle`)에서 차례로:

| 단계 | 결과 |
|---|---|
| README.md에 한 줄 더하는 만들기 요청 | 202 → `run_cancelling`(이유 `budget`) → `cancelled` "오늘 쓸 수 있는 토큰 한도(2천)에 도달해 요청을 멈췄습니다. 되돌릴 변경은 없었고 문서 1개(README.md)는 되돌리지 않고 체크포인트로 남겼습니다" |
| 합계 | 세션 21071, `tokens.json`의 `local` 합계 21071(같음, 겹쳐 세지 않음) |
| 같은 세션에 다음 요청 | 409 "오늘 쓸 수 있는 토큰 한도(2천)에 도달해 새 요청을 받지 않습니다. 기간이 바뀐 뒤에 다시 요청하세요" |
| `tokens.json`을 `{"version":1,"periods":`로 망가뜨린 뒤 요청 | 500 "…tokens.json을(를) 읽지 못했습니다: JSON이 아닙니다", 파일은 망가진 내용 그대로(덮어쓰지 않음) |

- 깨진 파일 단계는 하네스가 원래 파일을 백업한 뒤 바꾸고, 끝나면 되돌렸다.
- 세션은 멈추기·지우기 200이었다.

## 본 것: 한도는 query 하나가 끝난 뒤에야 판정된다

이벤트 순서는 `turn`·`turn_usage` → `read_file` → `turn`·`turn_usage` → `edit_file` → … → `tokens`(한 번) → `run_cancelling` → `run_finished`였다. 한도 판정을 부르는 `tokens` 이벤트는 러너가 result 줄의 `modelUsage`를 받을 때만 낸다. 그래서 2000 한도에서 query 하나(21071)를 다 쓰고, README.md를 고친 뒤에 멈췄다. 이 동작은 B3c 전에도 같았다(판정을 부르는 자리는 바꾸지 않았다). 턴마다 오는 `turn_usage`로 판정하는 일은 #1272로 따로 연다.

README.md가 되돌려지지 않은 것은 문서 변경을 되돌리지 않고 체크포인트로 남기는 기존 규칙이다.

#1272에서 고침(트러블슈팅 229): 대화 실행이 `turn_usage`의 합계로도 한도를 판정한다. 이 기록의 실측은 고치기 전 값이고, 고친 뒤의 실제 세션 실측은 따로 한다.

## 보지 못한 것

- 실행 도중 사용량 파일이 깨져 `usage_unreadable`로 멈추는 경우는 실제 환경에서 시각을 맞출 길이 없어 `sessions-token-limits.test.ts`로만 확인했다.
- 프로세스 둘이 같은 파일에 동시에 더하는 경우(트러블슈팅 226)는 `usage-state-processes.test.ts`(자식 프로세스 둘)로만 확인했다. studio 둘을 함께 띄우지 않았다.
- 세션 한도(`B_STUDIO_SESSION_TOKEN_LIMIT`)와 터미널 경로의 한도는 실제로 재지 않았다. 같은 판정 함수를 쓰고 단위 시험이 고정한다.
