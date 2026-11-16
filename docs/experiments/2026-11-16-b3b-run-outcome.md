# 실측: 요청 실행의 끝 결정을 Rust 수명 코어로 옮긴 뒤 실제 세션의 통과·턴 상한 실패·취소·질문·켜지 않은 세션 취소 (B3b)

- 날짜: 2026-11-16(20:01~20:02 KST)
- 관련: 이슈 #1269(추적 #1265), 브랜치 `feat/b3b-run-outcome`, [ADR-208](../decisions.md)
- 환경: macOS arm64, 로컬 Docker(Colima)
  - 이 브랜치의 worktree에서 `B_STUDIO_EXPERIMENTAL`·`B_STUDIO_TERMINAL`을 지운 셸로 `pnpm studio launch --mode local --port 3923`을 실행했다(인증 `none`).
  - 세션 폴더는 실측 전용 `B_STUDIO_SESSIONS_DIR`이다. 세션은 프로젝트 `vf3`(정적 웹 서비스 하나)의 작업 복사본이다.
  - 하네스(`~/.cache/b-studio-ship/real4/h5/measure-b3b.mjs`)는 화면 없이 API를 부르고 세션의 SSE에서 `run_finished`·알림을 모은다. 작업 복사본은 `git status --porcelain`으로 직접 본다.
  - 요청은 실제 Claude Code(stream-json 러너, `/messages`)가 처리했다. 요청 다섯이다.
- 한 번씩 잰 값이다.

## 결과

켠 세션 `5b40f9dd`(`ready`)에서 차례로:

| 요청 | 끝 상태 | 체크포인트 | 작업 복사본 |
|---|---|---|---|
| README.md에 한 줄 더하기 | `done` | 1 → 2 | 깨끗함 |
| 턴 상한 1(`maxTurns: 1`) | `failed` "최대 턴 수(1)를 넘었습니다" | 2 → 2 | 깨끗함 |
| 만들기 요청을 6초 뒤 취소(취소 202) | `cancelled` "요청을 취소했습니다. 바뀐 파일은 없었습니다" | 2 → 2 | 깨끗함 |
| 질문(`intent: ask`) | `done` | 2 → 2 | 깨끗함 |

켜지 않은 세션 `bfe7e95d`(`idle`)에서 만들기 요청을 1.5초 뒤 취소: 취소 202, `cancelled` "요청을 취소했습니다. 바뀐 파일은 없었습니다", 상태는 `idle` 그대로, 작업 복사본 깨끗함.

- 켜지 않은 세션의 취소 글은 옛 판에서 "요청을 취소했지만 변경을 되돌리지 못했습니다: undefined"였다(트러블슈팅 224, `sessions-run-outcome.test.ts` "결함 4"가 고치기 전 코드에서 확인). 실제 studio에서 옛 판을 띄워 다시 재지는 않았다.
- 모든 요청 뒤 `running=false`였고(점유가 풀림), 두 세션 모두 멈추기·지우기 200이었다.

## 보지 못한 것

- 바뀐 파일이 있는 채로 끝나 되돌리는 경우(게이트 실패 뒤 되돌리기, 취소 뒤 되돌리기)는 이번 요청에서 생기지 않았다. 턴 상한 1과 6초 뒤 취소가 파일을 바꾸기 전에 끝났다. 되돌리기 경로는 F0 기준 사진(`gate-exhausted-revert`·`cancel-revert`·`staged-mismatch-revert`)과 차등 시험이 고정한다.
- 체크포인트 저장 도중 멈춤(트러블슈팅 223)은 실제 환경에서 시각을 맞출 길이 없어 가짜 샌드박스 시험으로만 확인했다.
- 결함 1·2(켜지 않았거나 `ready`가 아닌 세션의 검증하지 않은 변경)는 지금 러너 경로로 닿지 않아(ADR-208) 실측 대상이 아니다.
