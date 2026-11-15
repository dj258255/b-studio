# 실측: 실험 기능을 끈 스튜디오에서 desk 세션 터미널로 실제 Claude Code 요청을 게이트까지 보내기 (ADR-200)

- 날짜: 2026-11-15
- 관련: 이슈 #1234, 브랜치 `docs/adr-200-support-path`
- 모델: 이 컴퓨터에 로그인한 Claude Code(Claude Max, Sonnet 5.5). 규칙표는 기본값 하나(claude-code, sonnet)
- 환경: macOS arm64, 로컬 Docker(Colima)
  - 이 브랜치의 worktree에서 `pnpm studio launch --mode local --port 3923`으로 띄웠다. **`B_STUDIO_EXPERIMENTAL`과 `B_STUDIO_TERMINAL`을 지운 셸**에서 띄웠고, 앞단(`bstudio-server`)과 Node 자식 프로세스의 환경에 두 변수가 없는 것을 `ps eww`로 확인했다. 등록 목록·세션 폴더는 실측 전용 폴더를 썼다.
  - desk를 PTY(170x48)로 띄우고 `@xterm/headless`로 화면을 글로 찍었다. 세션 상태는 1초마다 `/api/agents`로, 브라우저 프로필은 `--user-data-dir` 인자로 기록했다([A6c-3 실측](2026-11-15-a6c3-native-runner-gate.md)과 같은 장치).
- 한 번 잰 값이다

## 무엇을 보려 했나

이 브랜치에서는 세션 터미널의 판정(`sessionTerminalAllowed`)이 "개인 PC 모드 + (이 컴퓨터 방식 또는 실험 기능)"이다. 이전에는 실험 기능이 꺼져 있으면 방식과 상관없이 닫혔다. 실험 기능이 꺼진 서버에서 지원 경로(desk + 이 컴퓨터 방식 세션 터미널)가 처음부터 끝까지 도는지 본다.

## 결과

- `/api/health`: `{"status":"ok","app":"b-studio","terminal":true,"apiVersion":1}`. 고치기 전 코드에서는 같은 환경에서 `terminal`이 `false`다(`route.test.ts`의 고치기 전 실패로 확인).
- 세션 스냅샷: `"experimental":false`, `"terminal":true`
- desk에서 새 요청(Ctrl-b n)으로 `vf3` 프로젝트에 "README.md 끝에 \"shop 화면 확인 실측 ADR-200(실험 기능 끔)\" 한 줄을 Edit 도구로 더해 줘"를 보냈다.
  - 세션 `e2cde6a2`가 만들어지고 칸에 Claude Code가 떴다. 새 작업 복사본이라 폴더 신뢰 창에서 멈췄고, 실측 세션 폴더에만 "Yes"로 답했다.
  - 상태: `dormant` → `booting` → `working` → `verifying` → `passed` → `idle`(체크포인트 1개)
  - 체크포인트 `c95a3fc`, `passedStages: run, contract_check, browser_check, review`, 바뀐 파일 `README.md`
  - 브라우저 모드 `web /index.html (browser)`의 근거 넷은 [A6c-3 실측](2026-11-15-a6c3-native-runner-gate.md)의 통과 요청과 글자까지 같다.
    - `HTTP 200 (기대 200)`
    - `'shop 화면', '주문 합계' 화면에 모두 있음`
    - `web의 $.total 값 '12000' 화면에 있음`
    - `스크립트 예외 0건 · console.error 0건 · 실패한 요청 0건 · 미디어 오류 0건`
  - 화면 확인 브라우저는 한 번 떴고 Rust 러너의 프로필(`b-studio-cdp-<pid>-…`)이었다.
  - desk 사이드바의 끝 표시는 "검증 통과"였다.
- 정리: 세션 `DELETE` 200, `pnpm studio stop`. 실측이 만든 컨테이너·네트워크·볼륨은 남지 않았다(다른 프로젝트의 컨테이너 하나는 그대로 둠). 세션 작업 폴더는 지난 실측들처럼 남았다.

## 덧붙임: desk의 실험 화면 숨김

위 실측 뒤에 같은 PR에서 desk가 health의 `experimental`을 읽어 실험 화면을 숨기게 했다. 같은 방법(스위치를 지운 셸에서 `launch`)으로 다시 띄워 확인했다. 모델은 부르지 않았다.

- health: `{"status":"ok","app":"b-studio","terminal":true,"experimental":false,"apiVersion":1}`
- desk에서 `Ctrl-b t`: 아래 줄에 `작업 나누기는 실험 기능입니다(B_STUDIO_EXPERIMENTAL=1로 띄우세요)`만 보이고 작업 나누기 화면은 열리지 않았다
- `Ctrl-b f`: `여러 AI 비교는 실험 기능입니다(B_STUDIO_EXPERIMENTAL=1로 띄우세요)`
- 정리: 하네스 종료, `pnpm studio stop`. 새로 만든 세션은 없다

## 본 것

- 실험 기능 없이 띄운 서버에서 지원 경로가 요청 → 터미널의 CLI → 훅 → 게이트 → 체크포인트까지 돈다.
- `pnpm studio`(명령 없이)는 여전히 `B_STUDIO_EXPERIMENTAL=1`을 넣어 띄운다(desk의 실험 화면을 보이게 하려고). 이 실측은 그 경로가 아니라 `launch`로 띄워 스위치 없는 경우만 봤다.

## 보지 못한 것

- 실패·소진·되돌리기 요청(이 판정 변경은 게이트에 닿지 않아 통과 요청 하나만 보냈다)
- 실험 기능을 끈 서버에서 컨테이너 방식(`B_STUDIO_TERMINAL=container`)이 닫히는 것. 단위 시험(`sessions-terminal.test.ts`, `route.test.ts`)으로만 확인했다
- 인증을 켠 서버에서 닫히는 것(단위 시험만)
- Codex 세션 터미널
