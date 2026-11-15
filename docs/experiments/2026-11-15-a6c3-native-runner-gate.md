# 실측: 게이트의 화면 확인 기본 러너를 Rust CDP 러너로 바꾼 뒤 실제 Claude Code 세션으로 돌려 보기 (ADR-199 A6c-3)

- 날짜: 2026-11-15
- 관련: 이슈 #1212, 브랜치 `feat/a6c3-gate-native-runner`
- 모델: 이 컴퓨터에 로그인한 Claude Code(Claude Max, Sonnet 5.5). 규칙표는 기본값 하나(claude-code, sonnet)
- 환경: macOS arm64, 로컬 Docker(Colima)
  - 이 브랜치의 worktree에서 `pnpm studio launch --mode local --port 3923`으로 띄웠다(`B_STUDIO_TERMINAL=host`, `B_STUDIO_EXPERIMENTAL=1`). 등록 목록·세션 폴더는 실측 전용 폴더를 썼다.
  - desk를 PTY(170x48)로 띄우고 `@xterm/headless`로 화면을 글로 찍었다.
  - 세션 상태는 1초마다 `/api/agents`로 기록했다. 검사 결과는 세션 이벤트(`workflow_check`)에서 읽었다.
  - 게이트가 어느 러너로 브라우저를 띄웠는지는 0.5초마다 브라우저 프로세스의 `--user-data-dir` 인자로 기록했다. Rust 러너는 임시 폴더 아래 `b-studio-cdp-…`를, Playwright는 `playwright_chromiumdev_profile-…`를 쓴다.
- 모두 한 번 잰 값이다

## 무엇을 보려 했나

이 브랜치에서는 `browserRunner`를 넘기지 않은 게이트가 Rust 러너(`runInBrowserNative`)로 화면을 확인한다. 이전 기본값은 옛 Playwright 러너(`runInBrowser`)였다. 세 가지를 본다.

1. 실제 세션에서 화면 확인의 통과와 실패가 옛 러너 때(A5c-1 실측)와 같게 나오는가
2. 게이트가 실제로 Rust 러너를 썼는가
3. 의도한 차이가 실제 세션에서도 드러나는가: 페이지가 전역을 바꿔 화면 글자를 위조하면 통과하지 못해야 한다

## 프로젝트

[A5c-1 실측](2026-11-14-a5c1-check-page.md)과 같은 `vf3`를 썼다.

- busybox:1.37 httpd 하나, `/index.html`
- `/order.json`의 `total`(12000)을 스크립트로 불러 화면에 그린다
- `pageChecks`
  - HTTP 모드: `expectText: "shop 화면"`
  - 브라우저 모드: `expectAllText: ["shop 화면", "주문 합계"]`, `expectFromApi: { path: /order.json, jsonPath: $.total }`

## 결과

desk에서 새 요청으로 세션 `33b5ef8b`를 열고 요청 셋을 차례로 보냈다. 폴더 신뢰는 실측 세션 폴더에만 했다.

1. **통과.** 요청은 "README.md 끝에 \"shop 화면 확인 실측 A6c-3\" 한 줄을 Edit 도구로 더해 줘"였다.
   - 체크포인트 `28d7a4a`, `passedStages: run, contract_check, browser_check, review`
   - 브라우저 모드 `web /index.html (browser)`의 근거는 아래 넷이다. A5c-1(옛 러너)과 글자까지 같다.
     - `HTTP 200 (기대 200)`
     - `'shop 화면', '주문 합계' 화면에 모두 있음`
     - `web의 $.total 값 '12000' 화면에 있음`
     - `스크립트 예외 0건 · console.error 0건 · 실패한 요청 0건 · 미디어 오류 0건`
   - 단계 스크린샷 하나(`open /index.html`)가 저장됐다.
2. **실패 → 소진·되돌리기.** 요청은 "index.html에서 `<script>` 요소 전체를 Edit 도구로 지워 줘. 게이트가 막으면 … 멈춰"였다.
   - 세 번 모두 HTTP 모드는 통과했고 브라우저 모드만 실패했다. 실패 글은 `web의 $.total 값 '12000'이 /index.html 화면에 없습니다 — 화면이 다른 필드 이름을 읽고 있을 수 있습니다`로 A5c-1과 같다.
   - 세 번째 실패 뒤 "바뀐 파일 1개를 되돌렸습니다"로 끝났고, `index.html`에 `<script>`가 돌아왔다.
3. **위조 → 막힘·되돌리기.** 이번 전환으로 달라지는 점을 보려는 요청이다.
   - 요청: "index.html의 `<script>` 요소를 `Object.defineProperty(HTMLElement.prototype, "innerText", { get: function () { return "shop 화면 주문 합계: 12000원"; } … })` 한 줄짜리 스크립트로 바꿔 줘"
   - Claude Code가 그대로 바꿨다(되돌린 패치로 확인).
   - 세 번 모두 브라우저 모드가 2번과 같은 글로 실패했고, 세 번째 뒤 되돌려졌다.
   - **같은 HTML을 옛 러너로 열면 통과했을 것이다.** 세션에 들어간 HTML을 로컬 서버로 내주고 두 러너로 한 번씩 열었다(일회성 스크립트, 커밋하지 않음).
     - 옛 러너가 읽은 화면 글자: `"shop 화면 주문 합계: 12000원"`. 기대 글자 둘과 api 값이 모두 들어 있다.
     - Rust 러너가 읽은 화면 글자: `"shop 화면\n\n주문 합계: 불러오는 중원"`
     - 옛 러너는 페이지와 같은 실행 환경에서 `innerText`를 읽어 바꿔치기된 getter를 부른다. Rust 러너는 격리된 실행 환경에서 읽는다(ADR-199 A6b).
     - 판정 자체는 이 비교에서 돌리지 않았다. 옛 러너의 글자로 게이트가 통과한다는 것은 단위 시험(`gate-default-browser.test.ts`, 고치기 전 실패 출력은 PR에 적음)으로 확인했다.

**어느 러너였나.** 세 요청 동안 브라우저는 7번 떴다(통과 1번, 실패 3번, 위조 3번). 7번 모두 `b-studio-cdp-<pid>-…` 프로필이었고 `playwright_chromiumdev_profile`은 0번이었다.

## 본 것

- 실제 세션에서 옛 러너와 달라진 점은 3번(위조)뿐이었다. 1·2번의 근거와 실패 글은 A5c-1과 같았다.
- 위조를 막은 실패 글은 "api 값이 화면에 없다"였다. 사람이 읽으면 "화면이 다른 필드를 읽는다"로 오해할 수 있다. 위조를 따로 알리는 글은 없다. 격리된 실행 환경에서 읽은 진짜 화면에 값이 없었을 뿐이기 때문이다.

## 보지 못한 것

- 단계(`click`·`fill`·`press`·`waitFor`)가 있는 화면 확인, 첫 화면 글자(`expectInViewport`), 로드 예산(`maxLoadMs`), 가로 넘침, 디자인 비교, 브라우저를 못 띄울 때의 대체 확인, 자동 화면 확인(`autoPageChecks`)은 실제 세션에서 재지 않았다. 차등 시험과 단위 시험으로만 확인했다.
- 시간은 재지 않았다. 호출 시간은 A6c-1의 기계 측정(12회 중앙값)만 있다.
- Linux(CI)·Windows, 시스템 Chrome만 있는 기계는 실제 세션으로 재지 않았다.
- 다른 러너(codex 등)와 Kubernetes 제공자는 재지 않았다.

## 정리

- 실측 세션은 `DELETE /api/sessions/33b5ef8b`로 샌드박스를 멈췄다. 컨테이너·네트워크·볼륨이 남지 않은 것을 `docker ps -a`·`network ls`·`volume ls`로 확인했다.
- desk 하네스·상태 기록기·브라우저 기록기와 스튜디오(PID 60238)도 멈췄다. 다른 프로젝트의 컨테이너는 건드리지 않았다.
- 하네스와 원자료(화면, 상태 기록, 브라우저 기록, 세션 이벤트, 세션 git 기록)는 저장소 밖 `~/.cache/b-studio-ship/real4/h5`의 `a6c3-*`에 있다.
