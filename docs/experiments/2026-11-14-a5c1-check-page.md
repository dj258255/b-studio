# 실측: 게이트의 화면 확인 판정을 Rust로 옮긴 뒤 실제 Claude Code 세션과 실제 브라우저로 돌려 보기 (ADR-195 4f A5c-1)

- 날짜: 2026-11-14
- 관련: 이슈 #1204, 브랜치 `feat/4f-a5c1-check-page`
- 모델: 이 컴퓨터에 로그인한 Claude Code(Claude Max). 규칙표는 기본값 하나(claude-code, sonnet)
- 환경: macOS, 로컬 Docker(Colima), 헤드리스 Chromium(이 컴퓨터의 Playwright 캐시, `chromium_headless_shell-1243`). 이 브랜치의 worktree에서 `pnpm studio launch --mode local --port 3923`(`B_STUDIO_TERMINAL=host`, `B_STUDIO_EXPERIMENTAL=1`, 등록 목록·세션 폴더는 실측 전용 폴더). desk를 PTY(170x48)로 띄우고 `@xterm/headless`로 화면을 글로 찍었다. 세션 상태는 1초마다 `/api/agents`로 기록했고, 검사 결과는 세션 이벤트(`workflow_check`)에서 읽었다
- 모두 한 번 잰 값이다

## 무엇을 보려 했나

이 브랜치에서는 게이트의 화면 확인(`#checkPage`·`#apiValue`·`#checkFallbackProbe`)을 Rust(`crates/bstudio-io/src/gate_page.rs`)가 판정한다. 브라우저 러너(Playwright)와 페이지 요청은 TS 콜백이다. 실제 세션과 실제 브라우저에서 HTTP 모드·브라우저 모드의 통과와 실패가 옛 동작대로 나오는지 본다.

## 프로젝트

A5a 실측 프로젝트를 복사해 화면을 더했다(`vf3`). busybox:1.37 httpd 하나(`/work`를 내줌), 준비 경로 `/README.md`, 계약 `contract: { extract: /openapi.json }`.

- `index.html`: `<h1>shop 화면</h1>`, `주문 합계: <span id="total">불러오는 중</span>원`, 그리고 `/order.json`을 불러 `total`을 `toLocaleString('ko-KR')`로 채우는 스크립트
- `order.json`: `{ "total": 12000 }`
- `pageChecks`
  - `{ path: /index.html, mode: http, expectText: "shop 화면" }`
  - `{ path: /index.html, mode: browser, expectAllText: ["shop 화면", "주문 합계"], expectFromApi: { path: /order.json, jsonPath: $.total } }`
- `required`에 `browser_check`를 넣었다

## 결과

desk에서 폴더를 열고 한 세션(`67222868`)에 요청 둘을 차례로 보냈다. 폴더 신뢰는 실측 세션 폴더에만 했다.

1. **통과.** "README.md 끝에 \"shop 화면 확인 실측 1\" 한 줄을 Edit 도구로 더해 줘". 체크포인트 `d2ee086`, 끝 줄은 `Workflow-Passed: run, contract_check, browser_check, review`였다.
   - HTTP 모드 `web /index.html`: 근거 `HTTP 200 (기대 200)`, `'shop 화면' 응답 본문에 있음`, `HTTP 확인이라 자바스크립트를 실행하지 않았습니다 — …`
   - 브라우저 모드 `web /index.html (browser)`: 근거 `HTTP 200 (기대 200)`, `'shop 화면', '주문 합계' 화면에 모두 있음`, `web의 $.total 값 '12000' 화면에 있음`, `스크립트 예외 0건 · console.error 0건 · 실패한 요청 0건 · 미디어 오류 0건`. 화면에는 `12,000`으로 그려졌고, 천 단위 표기를 같은 값으로 인정했다. 단계 스크린샷 하나(`open /index.html`)가 저장됐다
2. **실패 → 소진·되돌리기.** "index.html에서 `<script>` 요소 전체를 Edit 도구로 지워 줘. 게이트가 막으면 … 멈춰".
   - 세 번 모두 HTTP 모드는 통과했고, 브라우저 모드만 `web의 $.total 값 '12000'이 /index.html 화면에 없습니다 — 화면이 다른 필드 이름을 읽고 있을 수 있습니다`로 실패했다. 실패한 확인에도 단계 스크린샷이 남았다
   - 안내는 실패를 앞에 쓰고(`- [browser_check] web /index.html (browser) (시도 1회)`) 서비스 확인 통과를 뒤에 붙였다(#1155)
   - 세 번째 실패 뒤 "바뀐 파일 1개를 되돌렸습니다"로 끝났고, `index.html`에 `<script>`가 돌아왔다

## 본 것

- 2번에서 화면에는 `주문 합계: 불러오는 중원`이 남았지만 "로딩 상태에서 멈춘 화면" 판정은 나오지 않았다. 나는 함께 잡힐 것으로 예상했는데 틀렸다. 그 판정(`stuck_loading.rs`)은 **로딩 문구만 있는 줄**을 찾는다. 이 줄은 앞뒤 글자가 붙어 있어 해당하지 않는다. 판정 자체는 이 조각 전부터 Rust였고, 바뀌지 않았다.

## 보지 못한 것

- 브라우저를 못 띄울 때의 `fallbackProbe`, 디자인 비교(`compare`), 첫 화면 글자(`expectInViewport`), 로드 예산(`maxLoadMs`), 가로 넘침, 콘솔 오류·실패한 요청·미디어 오류, 추정 id로 연 동적 경로, 자동 페이지(`autoPageChecks`, A5c-2에서 옮김)는 실제로 재지 않았다(차등 시험 189개와 Rust 단위 시험으로만).
- 다른 러너(codex 등)와 Kubernetes 제공자는 재지 않았다.

## 정리

실측 세션은 `DELETE /api/sessions/67222868`로 샌드박스를 멈췄고, 컨테이너·네트워크·볼륨이 남지 않은 것을 `docker ps -a`·`network ls`·`volume ls`로 확인했다. desk 하네스·상태 기록기와 스튜디오(PID 85599)도 멈췄다. 다른 프로젝트의 컨테이너는 건드리지 않았다. 하네스와 원자료(화면·상태 기록·세션 이벤트·세션 git 기록)는 저장소 밖(`~/.cache/b-studio-ship/real4/h5`의 `a5c1-*`, `d1-events.txt`)에 있다.
