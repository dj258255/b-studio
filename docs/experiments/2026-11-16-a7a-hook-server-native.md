# 실측: 훅 서버의 전송을 Rust로 옮긴 뒤 desk 세션 터미널의 실제 Claude Code 요청 (A7a)

- 날짜: 2026-11-16(00:08~00:10 KST)
- 관련: 이슈 #1239(추적 #1238), 브랜치 `feat/a7a-hook-server-native`, [ADR-201](../decisions.md#adr-201-훅mcp-서버의-전송은-rust가-하고-처리는-ts-콜백에-둔다-http-머리는-직접-읽고-본문-해석은-b단계까지-ts에-남긴다)
- 모델: 이 컴퓨터에 로그인한 Claude Code(Claude Max). 규칙표는 기본값 하나(claude-code, sonnet)
- 환경: macOS arm64, 로컬 Docker(Colima)
  - 이 브랜치의 worktree에서 `B_STUDIO_EXPERIMENTAL`·`B_STUDIO_TERMINAL`을 지운 셸로 `pnpm studio launch --mode local --port 3923`을 실행했다. health는 `{"terminal":true,"experimental":false}`였다.
  - 장치는 [ADR-200 실측](2026-11-15-adr200-terminal-without-experimental.md)과 같다. desk를 PTY(170x48)로 띄워 화면을 글로 찍었고, 세션 상태는 1초마다 `/api/agents`로 기록했다.
- 한 번 잰 값이다.

## 무엇을 보려 했나

지원 경로(desk + 이 컴퓨터 방식 세션 터미널)에서는 CLI의 훅이 모두 세션의 훅 서버를 지난다. 대화 시작, 요청 시작(`/prompt`), 쓰기 직전(`/pre-tool`), 턴의 끝(`/stop`), 텔레메트리(`/v1/logs`)가 그렇다. 이 브랜치에서 그 서버의 전송을 `node:http`에서 Rust(`crates/bstudio-io/src/loopback_server.rs`)로 바꿨다. 실제 CLI가 보낸 훅이 새 전송을 지나 게이트와 체크포인트까지 가는지 본다.

## 결과

- **새 전송을 지난다는 확인**
  - 세션이 뜬 뒤 스튜디오의 Node 프로세스는 루프백 포트 두 개를 열었다. 하나는 훅 서버, 하나는 MCP 도구 서버(아직 Node)다.
  - 두 포트에 토큰 없는 `POST /stop`을 한 번씩 보냈다. 둘 다 401이었고, 응답 머리가 달랐다.
    - 훅 포트: `content-type`·`content-length: 24`·`connection: close`만 있었다. 새 전송의 모양이고, 거절한 뒤 연결을 닫는다.
    - MCP 포트: `Date`·`Connection: keep-alive`·`Keep-Alive: timeout=5`·`Transfer-Encoding: chunked`가 있었다. Node `http`의 머리다.
- **요청:** desk 새 요청(Ctrl-b n)으로 `vf3` 프로젝트에 "README.md 끝에 \"shop 화면 확인 실측 A7a(Rust 훅 서버)\" 한 줄을 Edit 도구로 더해 줘"를 보냈다.
  - 세션은 `abe2fbfa`였다. 새 작업 복사본이라 폴더 신뢰 창에서 멈췄고, 실측 세션 폴더에만 "Yes"로 답했다.
  - 상태: `dormant` → `booting` → `working` → `verifying` → `passed` → `idle`(체크포인트 1개)
  - 이벤트에 Edit `tool_call`이 있었다(`file_path`가 세션의 `README.md`). 쓰기 직전 훅의 입력이 Rust를 거쳐 TS의 `JSON.parse`까지 그대로 간 것이다.
  - `run_usage`·`tokens` 이벤트도 있었다. 텔레메트리가 같은 서버를 지났다.
  - 체크포인트는 `c7a0d07`, `Workflow-Passed: run, contract_check, browser_check, review`, 바뀐 파일은 `README.md`(2줄 추가)였다.
  - desk 화면의 끝 표시는 "검증 통과 — 체크포인트 c7a0d07"이었다.
- **정리:** 세션 `DELETE`는 200이었다. 하네스와 상태 기록기를 끄고 `pnpm studio stop`을 실행했다. 실측이 만든 컨테이너는 남지 않았다. 세션 작업 폴더는 지난 실측들처럼 남았다.

## 보지 못한 것

- 게이트가 실패하는 요청, `/stop`이 피드백으로 멈추지 못하게 하는 갈래, `/pre-tool`이 거절하는 갈래. 통과 요청 하나만 보냈다. 전송은 갈래와 상관없이 같지만, 실제 세션에서 확인하지는 않았다.
- 컨테이너 방식 세션 터미널(`host.docker.internal` 이름을 받는 경우, 실험 기능). 차등 시험의 허용 이름 사례로만 확인했다.
- Codex 세션 터미널, 관문 러너(실험 기능)
