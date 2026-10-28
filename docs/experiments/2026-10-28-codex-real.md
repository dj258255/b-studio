# Codex 러너를 실제 ChatGPT 구독으로 돌려 본 실측

- 날짜: 2026-10-28
- 관련 이슈: [#54](https://github.com/dj258255/b-studio/issues/54)(실제 실행 확인), [#48](https://github.com/dj258255/b-studio/issues/48), 고친 것 [#976](https://github.com/dj258255/b-studio/issues/976)·[#977](https://github.com/dj258255/b-studio/issues/977)·[#979](https://github.com/dj258255/b-studio/issues/979)
- 환경: b-studio에 묶인 `@openai/codex-sdk` 0.157.0(CLI 0.157.0, darwin-arm64), 범수 님의 ChatGPT 구독 로그인, 계정 기본 모델. 이 컴퓨터에 깔린 `codex`는 0.160.1이지만 러너는 묶인 판을 쓴다.
- 방법: 러너와 같은 방식으로 빈 임시 CODEX_HOME에 로그인 파일 링크 하나만 두고 `codex exec --json`을 직접 돌려 이벤트와 세션 기록(`sessions/…/rollout-*.jsonl`)을 봤다. 고친 뒤에는 `runCodexAgent`를 진짜 SDK와 가짜 샌드박스(`test-helpers`의 `fakeSandbox`)로 돌렸다. Docker VM 메모리가 모자라 실제 샌드박스는 쓰지 않았다(아래 "하지 못한 것").
- 모델 호출: 직접 실행 5번, 러너 실행 6번. 로그인 파일 내용은 읽거나 남기지 않았다.

## #54의 확인 항목

| 항목 | 결과 |
|---|---|
| 빈 CODEX_HOME에서 로그인 유지 | 된다. 링크한 로그인 파일만으로 실행됐다 |
| `turn.completed.usage`가 턴별인가 누적인가 | **스레드 누적이다.** 같은 스레드를 이어 가면(SDK는 턴마다 `codex exec resume`) 첫 턴 input 17,280, 둘째 턴 29,759였고 세션 기록의 둘째 턴 호출은 12,479였다(17,280 + 12,479 = 29,759) |
| `input_tokens`에 캐시가 들어 있는가 | **들어 있다.** 세션 기록에서 `total_tokens = input_tokens + output_tokens`이다(input 13,674, cached 13,440, output 39, total 13,713) |
| 셸 끔 + 읽기 전용에서 노출 도구 | **64개였다.** 앱 커넥터(로그인한 ChatGPT 계정의 커넥터) 52개, 웹 실행, 이미지 생성, 목표, 플러그인 설치, MCP 자원, `apply_patch`와, 이것들을 자바스크립트로 부르는 코드 모드 `exec`. 사소한 요청 하나의 입력이 81,386토큰이었다 |
| 도구 밖 파일 변경 | 0건. 바뀐 파일은 b-studio `edit_file`로 고친 `api/src/Order.java` 하나였다 |
| 사용 한도 오류 모양 | 보지 못했다. 한도에 닿지 않았다 |

## 실측에서 나온 문제와 고친 것

1. **러너가 b-studio 도구를 하나도 부르지 못했다([#979](https://github.com/dj258255/b-studio/issues/979)).** 고치기 전 러너에 "파일을 읽고 오타를 고쳐"를 보내자 도구 호출 0번으로 "도구 승인 정책으로 읽기가 차단되었다"고 끝났고 상태는 `done`이었다. 0.157은 승인 없음(`approvalPolicy: never`)이면 MCP 도구 호출을 거절한다. b-studio MCP 서버에 `default_tools_approval_mode = "approve"`를 준다. 값은 `auto`·`prompt`·`writes`·`approve` 넷이다(틀린 값을 넣었을 때 Codex가 알려 준 목록).
2. **관문 밖 내장 기능이 켜져 있었다([#976](https://github.com/dj258255/b-studio/issues/976)).** `codex features list`에서 기본으로 켜진 것 가운데 도구를 주는 기능을 모두 끄고 `web_search = "disabled"`를 준다. 끈 뒤 러너의 에이전트가 본 도구는 b-studio 도구 13개, `apply_patch`, `clock__curr_time`, MCP 자원 읽기 셋(`list_mcp_resources`·`list_mcp_resource_templates`·`read_mcp_resource`)이다. 입력도 81,386토큰에서 17,280토큰으로 줄었다.
   - 코드 모드(`code_mode_host`)는 끄지 않는다. 끄면 b-studio 도구가 사라졌다("b-studio 파일 도구에 접근할 수 없다"). 코드 모드의 자바스크립트는 전역이 `tools`, `ALL_TOOLS`, 타이머, 출력·저장 함수뿐이고 `fetch`·`require`·`process`·`WebSocket`이 없으며, `import`는 `node:fs`·URL·`data:` 모두 "unsupported import in exec"였다. 그래서 다른 기능을 끄면 코드 모드로 닿는 것도 위 도구뿐이다.
3. **토큰을 겹쳐 셌다([#977](https://github.com/dj258255/b-studio/issues/977)).** 러너는 턴마다 `turn.completed.usage`를 더하고 캐시 읽기를 입력과 따로 더했다. 앞 턴 누적값과의 차이를 그 턴 몫으로 쓰고, 입력에서 캐시 몫을 뺀다. 고친 뒤 두 턴 실행(가짜 샌드박스가 첫 검사를 실패시킴)에서 둘째 턴은 입력 2,469, 캐시 읽기 75,264, 문맥 77,733으로 잡혔다.

4. **끄는 목록만으로는 새 판의 기능을 막지 못한다([#980](https://github.com/dj258255/b-studio/issues/980)).** 실행 전에 같은 끄기 설정으로 `codex features list`를 읽고, 켜진 기능이 확인한 목록(끌 수 없거나 도구를 주지 않는 14개와 removed 9개)에 모두 있을 때만 모델을 부른다. 0.157.0에서는 `unified_exec`가 `-c`와 `--disable`을 무시하고 켜진 채 남았다. 셸 도구의 구현 방식이라 `shell_tool`을 끄면 `exec_command`가 생기지 않아(도구 목록 실측) 확인한 목록에 넣었다. 데스크톱 앱용 기능(`in_app_*`, `daemon_auto_start`, `realtime_conversation`, `hooks` 등)은 꺼져서 끄는 목록에 더했다. 더 끈 뒤에도 실제 Codex가 b-studio 도구로 파일을 고쳤다.

## 하지 못한 것

- [#55](https://github.com/dj258255/b-studio/issues/55)(E1을 Codex로 재현)와 [#820](https://github.com/dj258255/b-studio/issues/820)의 마지막 항목(Claude와 Codex에 규칙표로 나눠 보내 실행 기록 확인)은 실제 샌드박스가 필요하다. 기본 Docker VM 9.69GiB 가운데 다른 프로젝트의 kind 클러스터가 6.4GiB를 써서, 벤치 메모리 검사(실행당 약 5.5GiB)를 넘지 못한다. 그 클러스터는 건드리지 않았다.
- 사용 한도 오류의 모양.
- 이 컴퓨터 방식 세션 터미널의 Codex(`codex` 0.160.1, 훅 관문)는 이번 범위가 아니다. 세션 기록의 `token_count`에 `model_context_window`(258,400)와 호출별 `last_token_usage`가 있어, 터미널 Codex의 문맥 %를 이 기록에서 읽을 수 있다(따로 다룬다).
