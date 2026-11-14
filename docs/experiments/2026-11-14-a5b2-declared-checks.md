# 실측: 게이트의 선언한 검사 실행을 Rust로 옮긴 뒤 실제 Claude Code 세션으로 돌려 보기 (ADR-195 4f A5b-2)

- 날짜: 2026-11-14
- 관련: 이슈 #1202, 브랜치 `feat/4f-a5b2-declared-checks`
- 모델: 이 컴퓨터에 로그인한 Claude Code(Claude Max). 아래 "본 것"의 사정으로 세션 도중부터는 기본 모델(Opus 5.5)로 돌았다
- 환경: macOS, 로컬 Docker(Colima). 이 브랜치의 worktree에서 `pnpm studio launch --mode local --port 3923`(`B_STUDIO_TERMINAL=host`, `B_STUDIO_EXPERIMENTAL=1`, 등록 목록·세션 폴더는 실측 전용 폴더). desk를 PTY(170x48)로 띄우고 `@xterm/headless`로 화면을 글로 찍었다. 세션 상태는 1초마다 `/api/agents`로 기록했고, 검사 결과는 세션 이벤트(`workflow_check`)에서 읽었다
- 모두 한 번 잰 값이다

## 무엇을 보려 했나

이 브랜치에서는 게이트가 선언한 검사(테스트·동시 요청·부하·작업 그래프)를 Rust(`crates/bstudio-io/src/gate_declared.rs`)로 조율한다. 실제 세션에서 테스트 재시도, 테스트 실패, 동시 요청 확인의 통과와 실패가 옛 동작대로 나오는지 본다.

## 프로젝트

A5a·A5b-1 실측 프로젝트를 복사해 선언 검사를 더했다(`vf2`). busybox:1.37 httpd 하나(`/work`를 내줌), 준비 경로 `/README.md`(30초), 계약 `contract: { extract: /openapi.json }`.

- 테스트 `readme-has-shop`: `grep -q shop /work/README.md`
- 테스트 `flaky-once`(`maxAttempts: 2`): 컨테이너의 `/tmp/flaky-once`가 없으면 만들고 실패, 있으면 통과. 컨테이너가 새로 뜬 뒤 첫 시도만 실패한다
- 동시 요청 확인 `readme-concurrent`: `GET /README.md` 4개를 동시에, `successCount: { exactly: 4 }`, `allStatusIn: [200]`, `then: GET /openapi.json`의 `$.openapi`가 `"3.0.3"`
- `required`에 `concurrency_check`를 넣었다

## 결과

desk에서 폴더를 열고 한 세션(`94d5272f`)에 요청 넷을 차례로 보냈다. 폴더 신뢰는 실측 세션 폴더에만 했다.

1. **통과(재시도 포함).** "README.md 끝에 \"shop 선언 검사 실측 1\" 한 줄을 Edit 도구로 더해 줘". 체크포인트 `5002111`. `workflow_check` 이벤트를 보면 `flaky-once`는 `attempts: 2`로 통과했고 근거 두 줄(`web에서 \`sh -c …\` 종료 코드 0`, `걸린 시간 0.1초`)이 붙었다. `readme-concurrent`는 `ok: true`, `detail: "성공 4/4 (기대: 정확히 4, 상태 200) · 상태 200:4 · $.openapi = \"3.0.3\""`였다. 끝 줄은 `Workflow-Passed: run, contract_check, test, concurrency_check, review`였다.
2. **에이전트가 틀리게 보고한 턴(통과가 맞음).** "README.md에서 shop이라는 글자를 Edit 도구로 모두 지워 줘". Claude는 "세 군데를 모두 지웠다"고 보고했다. 하지만 실제 파일에는 `계약 확인 실측용 프로젝트입니다. shop 선언 검사 실측 1`로 `shop`이 하나 남아 있었다. 게이트는 실제 파일로 `readme-has-shop`을 돌려 통과했다(체크포인트 `b5e86ca`). 게이트가 에이전트의 말이 아니라 실제 결과를 보는 경우다.
3. **테스트 실패 → 소진.** "README.md 전체 내용을 Write 도구로 \"# vf2\" 한 줄로 바꿔 줘. 게이트가 막으면 … 멈춰". 세 번 모두 `readme-has-shop`이 `ok: false, attempts: 1, detail: "종료 코드 1\n"`이었다. 첫 안내는 실패를 앞에 쓰고(`- [test] readme-has-shop (시도 1회)` / `종료 코드 1`) 서비스 확인 통과를 뒤에 붙였다(#1155). 같은 세 번 동안 `flaky-once`는 첫 시도만 `attempts: 2`이고 그 뒤는 `attempts: 1`이었다(컨테이너를 다시 띄우지 않아 `/tmp` 표시가 남음). 세 번째 실패 뒤 "되돌릴 변경은 없었고 문서 1개(README.md)는 되돌리지 않고 체크포인트로 남겼습니다"로 끝났다(문서를 지키는 기존 정책, 세션 git `9f1e157 지키기: …`).
4. **동시 요청 확인 실패 → 소진·되돌리기.** "README.md를 \"# shop\" 한 줄로 바꾸고, openapi.json의 \"openapi\" 값을 \"3.0.2\"로 바꿔 줘". 테스트는 통과했고 계약은 "계약 변경 없음"이었다. `readme-concurrent`만 `성공 4/4 (기대: 정확히 4, 상태 200) · 상태 200:4 · $.openapi = "3.0.2"` / `$.openapi 값이 "3.0.2" (기대: "3.0.3")`로 세 번 실패했다. 소진 뒤 "바뀐 파일 1개를 되돌렸습니다 … 문서 1개(README.md)는 되돌리지 않고 체크포인트로 남겼습니다"가 나왔고, `openapi.json`은 `"3.0.3"`으로 돌아왔다.

## 본 것

- 첫 요청을 보낸 뒤 Claude의 폴더 신뢰 창이 떴다. 이미 열려 있던 칸에 칸 번호(`1`)와 Enter를 보내는 바람에 Enter가 "No, exit"를 골라 Claude가 종료됐다(실측하는 내 키 입력 실수다). 칸 셸의 안내대로 `claude`를 다시 띄워 이어 갔다. 그래서 그 뒤의 Claude는 규칙표의 sonnet이 아니라 이 컴퓨터의 기본 모델(Opus 5.5)이었다. 게이트 동작에는 영향이 없다.
- 2번처럼 에이전트의 요약이 실제 변경과 다를 수 있다. 체크포인트 커밋에는 에이전트 요약이 그대로 실리므로, 요약만 읽으면 "shop을 모두 지웠다"로 오해할 수 있다(이 조각과 무관한 기존 동작이라 따로 고치지 않았다).

## 보지 못한 것

- 부하 확인(`loadChecks`), 화면 확인(`pageChecks`·자동 페이지, A5c에서 옮김), OOM으로 죽은 컨테이너 되살리기, 테스트 시간 상한, 동시 요청의 출처 밖 경로, 취소는 실제로 재지 않았다(차등 시험 65개와 Rust 단위 시험으로만).
- 다른 러너(codex 등)와 Kubernetes 제공자는 재지 않았다.

## 정리

실측 세션은 `DELETE /api/sessions/94d5272f`로 샌드박스를 멈췄고, 컨테이너·네트워크·볼륨이 남지 않은 것을 `docker ps -a`·`network ls`·`volume ls`로 확인했다. desk 하네스·상태 기록기와 스튜디오(PID 68465)도 멈췄다. 다른 프로젝트의 컨테이너는 건드리지 않았다. 하네스와 원자료(화면·상태 기록·세션 이벤트·세션 git 기록)는 저장소 밖(`~/.cache/b-studio-ship/real4/h5`의 `a5b2-*`, `c*-events.txt`)에 있다.
