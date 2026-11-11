# 실측: 준비 확인·모르는 프로세스 검사·인프라 복구를 Rust로 옮긴 뒤 실제 Docker로 돌려 보기 (ADR-195 4f A4c-3a)

- 날짜: 2026-11-12
- 관련: 이슈 #1185, 브랜치 `feat/4f-a4c3a-readiness`
- 모델 호출: 인프라 복구와 모르는 프로세스 검사를 보려고 실제 Claude(claude-code 백엔드) 실행 한 번. 나머지는 모델 없이 API(`POST /api/projects/open`, `/api/sessions`, `/boot`)와 네이티브 함수 직접 호출만 썼다
- 환경: macOS, Colima의 Docker, `docker compose` v2. 이미지는 busybox:1.37 하나. 모두 한 번 잰 값이다

## 방법

- A4c-3a worktree에서 `pnpm build:native`·`pnpm build:server` 뒤 `pnpm studio launch --mode local --port 3923`. 등록 목록·세션 폴더는 실측 폴더 `~/.cache/b-studio/real4`이다. PATH 맨 앞에 [A4c-2 실측](2026-11-12-a4c2-sync-relay-port.md)의 docker 감싸개를 두어 호출 순서를 기록했다(이번에는 아무 호출도 꾸미지 않았다).
- 실측 프로젝트(모두 `ok`를 복사해 한 곳만 바꿨다. 서비스 `web`은 busybox httpd, `ready: { path: /README.md }`):
  - `rp`: httpd에 `-vv`를 붙여 받은 요청의 경로를 컨테이너 로그에 남긴다.
  - `wr`: `ready: { path: /no-such-a4c3a, timeoutSeconds: 8 }`(없는 경로).
  - `tr`: 처음 한 번은 `Error: ETXTBSY: text file busy`를 찍고 종료 코드 1로 죽고, 두 번째부터 httpd를 띄운다(작업 폴더의 표시 파일로 구분).
  - `bs`: `ready: { path: "/\\example.com/" }`(스펙 거절 확인용).

## 결과

### 0. 실측에서 찾아 고친 결함 — 본문의 줄바꿈을 응답 머리의 것으로 읽음

- 처음 띄운 빌드로 `wr` 세션을 켜자 `8초 안에 준비되지 않았습니다 (마지막 확인: HPE_INVALID_HEADER_TOKEN, 컨테이너 running)`로 실패했다. 옛 코드라면 `마지막 확인: HTTP 404`였을 자리다.
- edge 포트로 같은 요청을 직접 보내 보니 busybox httpd의 404는 머리와 HTML 본문을 한 번에 보냈다(`…Content-type: text/html\r\n\r\n<HTML><HEAD>…\n<BODY>…`). `probe_http`가 "줄 끝은 CRLF여야 한다" 검사를 **읽은 버퍼 전체**에 해서, 머리와 함께 읽힌 본문의 낱개 LF를 머리 오류로 봤다. 200(`/README.md`)은 머리와 본문이 따로 도착해 이번에는 통과했지만, 한 번에 오면 같은 이유로 실패한다.
- 고침: 줄 끝 검사를 머리(빈 줄까지)에만 한다. Rust 시험 `본문의_낱개_줄바꿈은_머리의_오류가_아니다`가 고치기 전 코드에서 `left: Err("HPE_INVALID_HEADER_TOKEN") right: Ok(404)`로 실패하고 고친 뒤 통과한다. 차등 시험에도 머리와 본문을 한 번에 보내는 응답(200, 기대 404, 기대와 다른 404) 시나리오 세 개를 더했다. 시험 서버가 늘 `Content-Length: 0`으로 본문 없이 답해서 차등 시험이 이 차이를 잡지 못했다.
- 고친 빌드로 다시 켠 `wr`은 **10.2초 만에** `8초 안에 준비되지 않았습니다 (마지막 확인: HTTP 404, 컨테이너 running)`로 실패했다(옛 글과 같은 모양). 그동안 `compose port b-studio-edge 20000` 한 번과 `ps --all --format json web` 아홉 번이 불렸다.

### 1. 준비 확인이 `ready`가 되는 것

- `rp` 세션을 켜자 6초 만에 `ready`가 됐다(`web` → `http://127.0.0.1:32777`, 실제 edge 컨테이너의 공개 포트 `127.0.0.1:32777->20000/tcp`와 같다).

### 2. `ready.path`가 다른 호스트로 가지 않는 것(트러블슈팅 192)

- `bs`를 열자 `studio.yaml 형식이 올바르지 않습니다 - services.web.ready.path: 역슬래시와 제어 문자(탭·줄바꿈 포함)는 쓸 수 없습니다. 퍼센트 인코딩해서 적으세요`로 거절됐다.
- 스펙을 거치지 않는 경우도 보려고, 켜 둔 `rp` 세션의 compose 프로젝트에 네이티브 함수 `awaitReadyOnce`를 직접 불렀다. 세션 작업 폴더에 `\example.com/a4c3a-marker.txt` 파일을 만들어 두었다.
  - `ready.path = "/\example.com/a4c3a-marker.txt"`, 기대 200: 결과 `ready`(포트 32777), 확인 한 번 `[200, running]`. web 컨테이너의 httpd 로그에 `[::ffff:172.28.0.2]:56476: url:/\example.com/a4c3a-marker.txt`가 남았다. 172.28.0.2는 이 세션의 edge다. 같은 입력을 옛 코드처럼 `new URL(path, "http://127.0.0.1:32777")`로 해석하면 `http://example.com/a4c3a-marker.txt`다.
  - `ready.path = "/<탭>/example.com/"`, 기대 200: 4초 동안 `404, running`이 여덟 번이고 `failed`. httpd 로그에 `url:/<탭>/example.com/`이 여덟 번 남았다. 옛 해석은 `http://example.com/`이다.
- 확인한 파일은 바로 지웠다.

### 3. 인프라 복구(`ensureInfra`)와 모르는 프로세스 검사(`strayProcesses`)

- `rp` 세션이 `ready`인 상태에서 두 가지를 해 두었다: `docker exec <web> sh -c 'setsid sleep 600 … &'`(PID 38, 세션 38 — PID 1과 세션이 다른 프로세스), 이 세션의 edge 컨테이너를 `docker rm -f`로 지움.
- 메시지 "README.md 파일 끝에 a4c3a 라는 단어가 든 줄 하나를 더해 주세요"를 보냈다. 실행은 약 25초 안에 끝났고 `README.md`에 `a4c3a` 줄이 더해졌다.
- 세션 기록:
  - 알림 `세션 상태는 준비됨이었지만 컨테이너가 없어 이 세션 범위에서 다시 올렸습니다: b-studio-edge`.
  - 검토 기록 `background-processes`(ok): `검사 전에 서비스 안에 남은 백그라운드 프로세스가 있어 그 서비스를 다시 띄웠습니다(…) — web: sleep 600`.
  - `verify_result`: `{"ok":true,"sync":{"elapsedMs":182},"restarted":[{"service":"web","ready":true}], …}`. 시험 `readme-has-shop` 통과.
- 감싸개 기록의 순서(`inspect`·`stats` 생략): `ps --all --format json b-studio-edge web`(인프라 확인) → `up --no-start --no-deps b-studio-edge` → `start <id>`(복구의 `up`이 만들기 반복을 지났다) → `ps --all --format json b-studio-edge`(다시 확인) → … → `ps --all --format json web` → `exec -T web sh -c <찾기 스크립트>`(모르는 프로세스 검사) → `up --no-start --build --no-deps --force-recreate web` → `start <id>` → `port b-studio-edge 20000` → `ps --all --format json web` 두 번(준비 확인) → `exec -T web sh -c <찾기 스크립트>`(새 기준선) → 시험.

### 4. 일시 오류 뒤 한 번 다시 만들기(트러블슈팅 #90)

- `tr` 세션을 켜자 `ready`가 됐다. 감싸개 기록: `up --no-start --remove-orphans --no-deps b-studio-edge web` → `start <edge> <web>` → `port b-studio-edge 20000` → (확인 중 web이 exited) → `logs --no-color --timestamps --tail 60 web` → `up --no-start --build --no-deps --force-recreate web` → `start <web>` → `port b-studio-edge 20000` → `ready`.
- 다시 만들기의 `up`이 TS의 기존 경로(만들기 반복)를 지났다. edge 로그(egress 기록)는 읽지 않았다(재시도로 끝나 실패 이유를 만들지 않으므로 맞다).

## 보지 못한 것

- 컨테이너가 죽어 실패하는 경로(앱 로그·egress 기록이 이유에 붙는 것), 두 번째 시도도 일시 오류로 죽는 경로, 확인 중 취소는 실제로 만들지 않았다(가짜 docker 시험만).
- 컨테이너 상태를 읽지 못하는(`unknown`) 경우는 실제 Docker에서 만들지 못했다.
- `sh`가 없는 이미지의 프로세스 검사, 서비스가 여럿인 프로젝트, Docker Desktop은 돌리지 않았다.
- 바깥으로 연결이 나가지 않았다는 것은 "요청이 이 세션의 edge를 거쳐 web에 도착했다"로 봤다. 호스트의 네트워크를 따로 감시하지는 않았다(연결 대상은 코드에서 `127.0.0.1`로 고정이다).

## 정리

- 세 세션 모두 `DELETE /api/sessions/:id`로 멈춘 뒤 `POST …/delete`로 지웠다. 실측 컨테이너·네트워크가 남지 않았음을 확인했고 `pnpm studio stop`.
- 고친 네이티브 모듈을 같은 자리에 덮어쓴 뒤 시험 프로세스가 그 모듈을 불러오다 SIGKILL로 죽었다(macOS가 같은 파일의 서명 정보를 기억해 둔 탓으로 보인다. 확인한 것은 아니다). 파일을 지우고 새로 복사하자 정상으로 돌았다.
