# 실측: 지원 러너의 메시지 루프를 Rust로 옮긴 뒤 stream-json 러너 경로에서 실제 Claude Code 돌리기 (A8b)

- 날짜: 2026-11-16(06:07~06:22 KST)
- 관련: 이슈 #1246(추적 #1243), 브랜치 `feat/a8b-runner-core-native`, [ADR-202](../decisions.md#adr-202-지원-러너의-메시지-루프와-실행-상태는-rust가-쥐고-게이트결과도구-실행은-ts-콜백에-둔다-도구-순서-장부도-rust-객체로-mcp-서버와-나눠-쥔다)
- 모델: 이 컴퓨터에 로그인한 Claude Code CLI 2.1.325(Max 구독). 세션 이벤트의 모델은 `claude-fable-5-2`, effort high였다.
- 환경: macOS arm64, 로컬 Docker(Colima)
  - 이 브랜치의 worktree에서 `B_STUDIO_EXPERIMENTAL`·`B_STUDIO_TERMINAL`을 지운 셸로 `pnpm studio launch --mode local --port 3923`을 실행했다. health는 `{"terminal":true,"experimental":false}`였다.
  - 프로젝트는 `vf3`다. 정적 웹 서비스 하나와 화면 확인 두 개(`expectText: "shop 화면"`, 브라우저 모드 `expectAllText`·`expectFromApi`)로 되어 있다.
  - 하네스는 화면 없이 API만 부른다. `POST /api/sessions {projectId:'vf3', backend:'claude-code', workspace:'copy'}` → `POST /api/sessions/:id/messages`이고, `/api/sessions/:id/events`(SSE)를 모두 파일로 남겼다. F0 하네스(`apps/studio/server/baseline/run-scenario.ts`)와 같은 경로다.
- 요청마다 한 번씩 잰 값이다.

## 무엇을 보려 했나

이 브랜치에서 `runClaudeCodeAgent`의 메시지 루프가 Rust 러너 코어(`cli_runner.rs`)로 옮겨졌다. 코어는 CLI 프로세스를 직접 쥐고, 턴 세기·result 판정·게이트 분기·턴 상한 재확인을 맡는다. 도구 순서 장부(`tool_ledger.rs`)는 MCP 서버와 나눠 쥔다. 실제 Claude Code의 stream-json 출력으로 다음을 본다.

- 통과
- 게이트 실패 뒤 통과
- 턴 상한

## 결과

- **새 경로를 지난다는 확인:** 첫 요청이 도는 동안 스튜디오 Node 프로세스가 연 루프백 포트(러너의 MCP 도구 서버)에 토큰 없이 `POST /mcp`를 보냈다.
  - 응답은 401이었고, 머리는 `content-type`·`content-length`·`connection: close`뿐이었다(Rust 전송, [A7b 실측](2026-11-16-a7b-mcp-server-native.md)과 같다).
  - 실행 중인 `claude`는 `-p --input-format stream-json --output-format stream-json … --max-turns 60` 인자로 떠 있었다.
  - `runClaudeCodeAgent`는 이 브랜치에서 `native.RunnerCore`만 부른다. 옛 루프는 차등 시험에서만 쓴다.
- **통과(세션 `2f993a18`):** "README.md 끝에 \"A8b 실측: Rust 러너 코어 통과\" 한 줄을 더해 줘"
  - 3턴 동안 `read_file`·`edit_file`을 썼다.
  - 게이트 단계 `run` → `contract_check` → `browser_check` → `review`를 거쳐 `checkpoint`로 갔고 결과는 `done`이었다. 전체 37초, 게이트 15.3초였다.
- **게이트 실패 뒤 통과(세션 `d1225198`):** "index.html의 h1 글자를 \"상점\"으로 바꿔 줘. 검증이 실패하면 그 안내를 따라 검사가 통과하도록 고쳐 줘"
  - 2턴에 h1을 `상점`으로 바꿨다. 첫 게이트는 화면 확인에서 실패했다(`gate_done ok:false`).
  - 러너가 피드백을 표준 입력으로 넣었다. 모델은 파일을 다시 읽고 h1을 `상점 shop 화면`으로 고쳤다.
  - 둘째 게이트를 통과해 `checkpoint` → `done`이 됐다(`verifyAttempts: 1`, 6턴, 96초).
- **게이트 소진(세션 `afc7085c`, 계획에 없던 요청):** 처음에는 "h1에 다른 글자는 남기지 마"라고 보냈다.
  - 모델은 게이트 피드백을 받고도 "요청과 검사가 서로 충돌한다"며 고치지 않았다.
  - `ask_user`로 물으려 했지만 vf3의 `allowedTools`에 없어 거절됐다(`ok:false`).
  - 게이트가 3번 실패해 `failed`(`검증 게이트를 3번 통과하지 못했습니다`, `verifyAttempts: 3`, 7턴)로 끝났고, 바뀐 파일은 되돌렸다(`reverted`).
  - 그래서 문구를 바꿔 위의 "게이트 실패 뒤 통과"를 다시 돌렸다.
- **턴 상한, 변경 없음(세션 `1f8e80d9`, `maxTurns: 1`):** 여러 파일을 읽게 했다.
  - 1턴째의 `list_files` 뒤 CLI가 `--max-turns 1`로 스스로 끝내고 `error_max_turns` result를 보냈다.
  - 러너는 게이트를 다시 확인하는 경로(ADR-131)를 탔다. 바뀐 파일이 없어 게이트가 없었고, 결과는 `failed`(`최대 턴 수(1)를 넘었습니다`, `failureReason: max_turns`, 6초)였다.
- **턴 상한, 변경 있음(세션 `a6e9f6b6`, `maxTurns: 2`):** "README를 읽고 한 줄 더한 뒤 나머지 파일도 읽어 요약해 줘"
  - 2턴째 assistant 메시지 하나에 도구 호출 넷(`edit_file` 하나, `read_file` 셋)이 함께 들어 있었다.
  - 장부가 도착 순서대로 하나씩 실행했다(`tool_call`/`tool_result`가 번갈아 넷).
  - 그 뒤 CLI가 `error_max_turns`로 끝냈다. 러너가 게이트를 다시 확인했고 통과했다.
  - 결과는 `done`이었고, `incomplete: max_turns`와 체크포인트가 남았다("최대 턴 수(2)를 넘었습니다. 다만 지금까지의 변경이 검증 게이트를 통과해 체크포인트로 남깁니다").
- **정리:** 세션 다섯 개의 `DELETE`는 모두 200이었다. `pnpm studio stop` 뒤 3923 포트는 닫혔고, 실측이 만든 컨테이너는 남지 않았다.

## 보지 못한 것

- **러너 자신의 턴 상한**(`turn > maxTurns`에서 도구를 닫고 SIGTERM)
  - 두 실측 모두 CLI가 `--max-turns`로 먼저 끝냈다. 러너는 같은 값을 CLI에 넘기므로, 실제 세션에서 이 경로는 CLI가 턴을 다르게 셀 때의 안전장치다.
  - 이 경로는 가짜 CLI 시험으로 확인했다: 차등 시험의 턴 상한 시나리오, 트러블슈팅 206의 다섯 개, Rust `turn_limit_*`.
- 승격(모델 올리기), 네트워크 재시도, 되묻고 멈추기(`ask_user`가 허용된 프로젝트), 실행 중 지시, 이어받기, 문맥 요약. 차등 시험으로만 확인했다.
- desk 세션 터미널은 이 러너를 쓰지 않는다(훅 서버 경로). Codex 등 실험 러너는 장부 없이 `startToolServer`를 그대로 쓰고, 타입 검사와 기존 시험으로만 확인했다.
- 이벤트마다 생기는 스레드 왕복의 비용은 재지 않았다.
