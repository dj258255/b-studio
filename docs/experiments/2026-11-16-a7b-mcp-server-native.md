# 실측: MCP 도구 서버를 Rust로 옮긴 뒤 desk 세션 터미널의 실제 Claude Code가 b-studio 도구를 부르기 (A7b)

- 날짜: 2026-11-16(02:06~02:08 KST)
- 관련: 이슈 #1241(추적 #1238), 브랜치 `feat/a7b-mcp-server-native`, [ADR-201](../decisions.md#adr-201-훅mcp-서버의-전송은-rust가-하고-처리는-ts-콜백에-둔다-http-머리는-직접-읽고-본문-해석은-b단계까지-ts에-남긴다)
- 모델: 이 컴퓨터에 로그인한 Claude Code v2.1.325(Claude Max, Sonnet 5.5). 규칙표는 기본값 하나(claude-code, sonnet)
- 환경: macOS arm64, 로컬 Docker(Colima)
  - 이 브랜치의 worktree에서 `B_STUDIO_EXPERIMENTAL`·`B_STUDIO_TERMINAL`을 지운 셸로 `pnpm studio launch --mode local --port 3923`을 실행했다. health는 `{"terminal":true,"experimental":false}`였다.
  - 장치는 [A7a 실측](2026-11-16-a7a-hook-server-native.md)과 같다(desk PTY 170x48, `/api/agents` 1초 기록).
- 한 번 잰 값이다.

## 무엇을 보려 했나

이 컴퓨터 방식 세션 터미널의 CLI는 `--mcp-config`(type http, Authorization 머리)로 세션의 MCP 도구 서버에 붙어 b-studio의 샌드박스 도구(`run_in_service`·`service_logs`·`http_request` 등)를 부른다. 이 브랜치에서 그 서버의 전송과 프로토콜을 `node:http` + MCP SDK에서 Rust(`crates/bstudio-io/src/mcp_server.rs`)로 바꿨다. 실제 Claude Code가 새 서버로 도구 목록을 읽고, 도구를 부르고, 결과(성공과 실패)를 받고, 그 뒤 게이트와 체크포인트까지 가는지 본다.

## 결과

- **새 서버를 지난다는 확인**
  - 세션이 뜬 뒤 스튜디오의 Node 프로세스가 연 루프백 포트 두 개(훅·MCP)에 토큰 없는 `POST /mcp`를 한 번씩 보냈다. 둘 다 401이었다.
  - 응답 머리는 둘 다 `content-type`·`content-length`·`connection: close`뿐이었다. 새 전송의 모양이다.
  - MCP 포트의 본문은 옛 서버와 같은 `{"jsonrpc":"2.0","error":{"code":-40100,"message":"unauthorized"},"id":null}`이었다.
  - [A7a 실측](2026-11-16-a7a-hook-server-native.md) 때는 같은 MCP 포트가 Node `http`의 머리(`Date`, `Keep-Alive`, chunked)로 답했다.
- **첫 요청(실패 결과):** desk 새 요청으로 `vf3`에 "b-studio의 http_request 도구로 web 서비스의 /order.json을 GET 해서 total 값을 확인한 뒤, README.md 끝에 … 한 줄을 Edit 도구로 더해 줘"를 보냈다. 세션은 `e61b0d70`이었고, 폴더 신뢰 창에서는 실측 세션 폴더에만 "Yes"로 답했다.
  - Claude Code가 b-studio 서버에서 도구 스키마를 읽었고("called b-studio"), `http_request`를 불렀다.
  - 호출은 Rust 서버를 지나 TS `executeTool`까지 갔다. vf3의 `policy.allowedTools`에 `http_request`가 없어서 `isError` 결과가 돌아왔다. 결과 글은 `blocked by execution policy: tool 'http_request' is not in the allowed tool list`였다.
  - Claude Code는 이 결과를 읽고 다른 길로 돌아가지 않고 멈춰 사용자에게 물었다. README는 고치지 않았다.
  - 턴 끝 훅의 답은 "검증 통과 — 남길 변경이 없어 체크포인트는 만들지 않았습니다"였다.
- **두 번째 요청(성공 결과):** 같은 칸에 "b-studio의 service_logs 도구로 web 서비스 로그 마지막 20줄을 본 뒤, README.md 끝에 \"서비스 로그 확인 실측 A7b(Rust MCP 서버)\" 한 줄을 Edit 도구로 더해 줘"를 보냈다.
  - `service_logs` 결과는 `ok: true`, `(no logs)`였다. 이어서 Edit을 했다.
  - 상태: `working` → `verifying` → `passed` → `idle`
  - 체크포인트는 `58401ea`, `Workflow-Passed: run, contract_check, browser_check, review`였다.
  - 세션 이벤트에 `tool_call` 셋(`http_request`·`service_logs`·`Edit`)과 `tool_result` 둘(`http_request` `ok:false`, `service_logs` `ok:true`)이 남았다.
- **정리:** 세션 `DELETE`는 200이었다. 하네스와 상태 기록기를 끄고 `pnpm studio stop`을 실행했다. 실측이 만든 컨테이너는 남지 않았다.

## 보지 못한 것

- 이미지가 든 도구 결과, 인자 검사 실패(모델이 스키마에 맞게 불러 생기지 않았다), 도구 목록이 바뀌는 경우. 차등 시험과 SDK Client 시험으로만 확인했다.
- stream-json 러너(`/messages`)가 띄우는 도구 서버, Codex 세션 터미널, 컨테이너 방식(실험 기능)
- 15초 SSE keepalive가 실제 CLI와의 긴 연결에서 어떻게 보이는지
