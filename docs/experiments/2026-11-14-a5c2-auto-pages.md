# 실측: 게이트의 자동 화면 고르기를 Rust로 옮긴 뒤 실제 Claude Code 세션의 Next.js 프로젝트에서 돌려 보기 (ADR-195 4f A5c-2)

- 날짜: 2026-11-14
- 관련: 이슈 #1206, 브랜치 `feat/4f-a5c2-auto-pages`, 실측 중에 찾은 기존 결함 #1207
- 모델: 이 컴퓨터에 로그인한 Claude Code(Claude Max). 규칙표는 기본값 하나(claude-code, sonnet)
- 환경: macOS, 로컬 Docker(Colima), 헤드리스 Chromium(이 컴퓨터의 Playwright 캐시). 이 브랜치의 worktree에서 `pnpm studio launch --mode local --port 3923`(`B_STUDIO_TERMINAL=host`, `B_STUDIO_EXPERIMENTAL=1`, 등록 목록·세션 폴더는 실측 전용 폴더). desk를 PTY(170x48)로 띄우고 `@xterm/headless`로 화면을 글로 찍었다. 세션 상태는 1초마다 `/api/agents`로 기록했고, 검사 결과는 세션 이벤트(`workflow_check`)에서 읽었다
- 모두 한 번 잰 값이다

## 무엇을 보려 했나

이 브랜치에서는 게이트가 자동으로 열 화면을 고르는 규칙(`#autoPages` 아래)을 Rust(`crates/bstudio-io/src/gate_auto.rs`)가 정한다. 바뀐 파일 목록, studio.yaml 다시 읽기, 폴더 읽기, import 그래프 읽기는 TS 콜백이다. 실제 세션에서 다음 다섯 가지가 옛 동작대로 나오는지 본다.

- 바뀐 컴포넌트에서 import를 따라가 그것을 쓰는 page를 찾는다
- 동적 경로는 기본 id로 연다
- 선언한 pageChecks와 겹치는 화면은 건너뛴다
- 이름에 바뀐 파일을 적는다
- 자동 확인이 실패하면 게이트가 막는다

## 프로젝트

`examples/orders/web`(Next.js 16.4.3)을 복사해 만든 `nx`다. 서비스는 `web` 하나다(`source: managed`, `template: nextjs`, 준비 경로 `/`, 메모리 1g). 여기에 세 파일을 더했다.

- `web/components/Price.tsx`: 가격 표시 컴포넌트
- `web/app/page.tsx`: `Price`를 쓰고 "shop 첫 화면"을 그린다
- `web/app/orders/[id]/page.tsx`: `Price`를 쓰는 동적 경로

설정은 다음과 같다.

- `pageChecks`: `{ service: web, path: /, mode: http, expectText: "shop 첫 화면" }`
- `autoPageChecks`: 처음에는 `{ service: web }`(HTTP 모드)였다. 아래 1번 때문에 `{ service: web, mode: browser }`로 바꿨다
- `required`에 `browser_check`를 넣었다

## 결과

1. **HTTP 모드: 정상 화면을 오류 화면으로 판정했다(기존 결함, #1207).** 세션 `2cdc6743`에 "web/components/Price.tsx에서 원 앞에 공백 하나를 Edit 도구로 넣어 줘"를 보냈다.
   - 자동 화면 고르기는 기대대로였다. `Price.tsx`에서 import를 따라가 `/`와 `/orders/[id]`를 찾았다
     - `/`는 선언한 pageChecks에 있어 `web web/app/page.tsx (자동, 건너뜀)`, 사유 "/은(는) 이미 선언한 pageChecks에 있어 두 번 열지 않았습니다"
     - 동적 경로는 기본 id로 열었다: `web /orders/1 (자동, id 추정 · Price.tsx 변경)`
   - 그런데 `/orders/1`은 HTTP 200으로 정상 화면을 돌려줬는데도 세 번 모두 `자동 페이지 /orders/1: Next.js 오류 화면: 'This page could not be found'`로 실패했다. 소진 뒤 바뀐 파일 1개가 되돌려졌다
   - 응답 HTML(`home.html`, `o1.html`)을 저장해 따로 확인했다. Next 16은 정상 page의 응답에도 기본 404 컴포넌트(`not-found`)를 RSC 페이로드로 싣는다. main의 네이티브 판정 `gateNextErrorMarker`는 그 HTML을 그대로 받으면 표지를 찾는다. 스크립트를 걷어낸 글자(`gateStripHtml` 결과)를 받으면 찾지 않는다
   - HTTP 모드는 원본 HTML을 넘긴다. 이 판정은 A5c-1 전부터 같고 이 브랜치에서도 바뀌지 않았다. 그래서 이 조각의 결함이 아니라 기존 결함으로 #1207에 따로 적었다. 고치는 일은 통과 쪽 변경이라 따로 한다
   - (뒤에 덧붙임) #1207에서 고쳤다. 같은 프로젝트를 HTTP 모드로 다시 재어 통과하는 것을 확인했다(트러블슈팅 199)
2. **브라우저 모드: 통과.** 설정을 `mode: browser`로 바꾸고(세션 시작 체크포인트 `47b0e5e`) 새 세션 `be64a9d0`에 같은 요청을 보냈다. 체크포인트 `5fd9f6b`가 남았고, 끝 줄은 `Workflow-Passed: run, contract_check, browser_check, review`였다.
   - `web /orders/1 (자동, id 추정 · Price.tsx 변경)`: 근거는 셋이었다. 단계 스크린샷 하나(`open /orders/1`)도 저장됐다
     - `HTTP 200 — 추정한 id(1)로 열어 404·500만 실패로 봤습니다`
     - `스크립트 예외 0건 · console.error 0건 · 실패한 요청 0건 · 미디어 오류 0건`
     - `Next.js 오류 화면 표지 없음`
   - `web web/app/page.tsx (자동, 건너뜀)`: 1번과 같은 사유
   - 선언한 `web /`(HTTP 모드): `HTTP 200 (기대 200)`, `'shop 첫 화면' 응답 본문에 있음`
3. **실패 → 소진·되돌리기.** 같은 세션에 요청을 하나 더 보냈다: "web/app/orders/[id]/page.tsx에서 `const { id } = await params;` 다음 줄에 `throw new Error("주문 실측 실패");` 한 줄을 Edit 도구로 넣어 줘. 게이트가 막으면 … 멈춰".
   - 이번에는 page 파일 자체가 바뀌었다. 그래서 자동 화면 이름에 바뀐 파일이 붙지 않았다: `web /orders/1 (자동, id 추정)`
   - 세 번 모두 같은 글로 실패했다: `자동 페이지 /orders/1: 동적 경로를 추정한 id(1)로 열었더니 HTTP 500을 돌려줬습니다 — id가 실제로 없을 수 있습니다. autoPageChecks.sampleParams나 sampleIdFrom으로 실제 값을 알려주면 더 정확히 확인합니다`. 그 뒤에 `스크립트 예외: 주문 실측 실패`가 붙었다
   - 세 번째 실패 뒤 "검증 게이트를 3번 통과하지 못했습니다 바뀐 파일 1개를 되돌렸습니다"로 끝났다. `page.tsx`의 `throw` 줄은 사라졌고, 세션 폴더의 git 작업 트리는 깨끗했다. 체크포인트는 `5fd9f6b` 그대로였다
   - 에이전트는 요청대로 고치지 않고 막힌 이유("/orders/1이 HTTP 500 … 원인은 방금 넣은 throw")를 알린 뒤 멈췄다

## 본 것

- 1번의 HTTP 모드 오탐은 사용자에게 바로 드러나는 결함이다. Next.js 프로젝트에 `autoPageChecks`를 기본값(HTTP 모드)으로 켜면 동적 경로가 있는 화면이 늘 실패한다. 이번 실측의 Next 16.4.3에서는 정적 경로 `/`도 같은 표지를 실었다. `/`는 선언과 겹쳐 건너뛰었기 때문에 드러나지 않았을 뿐이다. 2026-10-10 도그푸딩 때는 Next 버전이 달라 드러나지 않았던 것으로 보이지만, 확인하지는 않았다.

## 보지 못한 것

- 실행 중 표본 값(`sampleParams`·`sampleIdFrom`을 세션 도중 바꾸기), 고정 경로 가림 확인, 밀려난 화면 되살리기, import 상한·깊이 안내, 그래프 읽기 실패, `maxPages`, studio.yaml 읽기 실패는 실제로 재지 않았다. 차등 시험 68개와 Rust 단위 시험으로만 확인했다.
- 다른 러너(codex 등)와 Kubernetes 제공자는 재지 않았다.

## 정리

실측 세션은 `DELETE /api/sessions/be64a9d0`(앞 세션 `2cdc6743`도 같은 방법)으로 샌드박스를 멈췄다. 이 실측의 컨테이너(`studio-nx-*`)·네트워크가 남지 않은 것을 `docker ps -a`·`network ls`로 확인했다. 남은 `b-studio-snapshot-*` 볼륨은 모두 9~10월에 만든 것이라 이번 실측과 관계없다. pnpm 캐시 볼륨(`b-studio-cache-pnpm`)은 원래 있던 외부 볼륨이다. desk 하네스·상태 기록기와 스튜디오(PID 90083)도 멈췄다. 다른 프로젝트의 컨테이너는 건드리지 않았다. 하네스와 원자료(화면·상태 기록·세션 이벤트·응답 HTML)는 저장소 밖 `~/.cache/b-studio-ship/real4/h5`에 있다. 파일은 `a5c2-*`, `e1-events.txt`~`e3-events.txt`, `home.html`, `o1.html`이다.
