# 실측: 파일 반영 확인·변경 알림·포트 충돌 재시도를 Rust로 옮긴 뒤 실제 Docker로 돌려 보기 (ADR-195 4f A4c-2)

- 날짜: 2026-11-12
- 관련: 이슈 #1183, 브랜치 `feat/4f-a4c2-sync-relay-port`(커밋 f44e182·6fca746)
- 모델 호출: 파일 반영 확인을 보려고 실제 Claude(claude-code 백엔드) 실행 한 번. 포트 재시도와 변경 알림은 모델 없이 API(`POST /api/sessions`, `/boot`)와 파일 만들기만 썼다
- 환경: macOS, Colima의 Docker, `docker compose` v2. 이미지는 busybox:1.37 하나. 모두 한 번 잰 값이다

## 방법

- A4c-2 worktree에서 `pnpm build:native`·`pnpm build:server` 뒤 `pnpm studio launch --mode local --port 3923`. 등록 목록·세션 폴더는 실측 폴더 `~/.cache/b-studio/real4`([A4c-1 실측](2026-11-12-a4c1-up-loop.md)과 같은 프로젝트 `ok`, 새 프로젝트 `pp`).
- studio를 띄울 때 PATH 맨 앞에 **docker 감싸개**를 두었다. 감싸개는 모든 호출을 기록하고 실제 `docker`를 그대로 부른다. 정해 둔 표시 파일이 있을 때만, 처음 받은 `start` 호출 한 번을 실제 Docker가 내는 글(`Bind for 127.0.0.1:41999 failed: port is already allocated`)로 실패시키고 표시 파일을 지운다.
  - 까닭: 미리 고르는 포트는 40000~59999에서 무작위라 VM 안에서 진짜 충돌을 정해진 대로 만들 방법이 없다. 그래서 **충돌 한 번만 꾸미고**, 그 뒤의 포트 다시 뽑기·override 다시 쓰기·정리·다시 만들기는 실제 Docker로 돌렸다.
- `pp`: `ok`와 같은 busybox httpd에 `environment: { SELF_URL: ${b-studio:services.web.publicUrl} }`를 더한 프로젝트. 자기 공개 주소를 참조하므로 web의 호스트 포트를 미리 고른다(`publicUrlRefs`).

## 결과

### 1. 포트 충돌 재시도

- 표시 파일을 만든 뒤 `pp` 세션을 켜자 **`ready`**가 됐다.
- 감싸개 기록의 순서(`ps`·`inspect` 생략): `compose build web` → `config` → `up --no-start --remove-orphans --no-deps b-studio-edge web` → `config` → `ps` → **`start <id> <id>`(꾸민 충돌)** → **`compose rm --stop --force --volumes`** → `config` → `up --no-start …` → `config` → `ps` → `start <id> <id>`(성공) → 준비 확인. `down`은 부르지 않았다.
- 충돌 순간의 override는 edge 포트가 `127.0.0.1:57443:20000`, web의 `SELF_URL`이 `http://127.0.0.1:57443`이었다. 다시 쓴 override는 `127.0.0.1:46717:20000`과 `http://127.0.0.1:46717`이다. 실제 edge 컨테이너는 `127.0.0.1:46717->20000/tcp`로 공개했고, web 컨테이너의 환경 변수도 `SELF_URL=http://127.0.0.1:46717`이었다.
- 다시 쓴 override에도 `.git` 마스크 두 자리(`/work/.git`, `/work/.git/b-studio`, 모두 `read_only`)가 있었다. 다시 만들어진 web 컨테이너의 실제 마운트도 `/work` rw=true, `/work/.git`·`/work/.git/b-studio` rw=false였다.
- 같은 방법으로 한 번 더 켰을 때(처음 시도, override를 남기기 전)도 순서가 같았고 `ready`가 됐다.

### 2. 변경 알림 (`relayChanges`)

- `ok`를 `workspace: 'local'` 세션으로 켜고(`ready`), 프로젝트 폴더에 `relay-top.txt`와 `relaydir/a.txt`를 만들었다.
- 약 3초 안에 `compose … exec -T web sh -c <RELAY_SCRIPT> sh n:/work m:/work/relaydir` 한 번이 불렸다. 새 파일은 부모 폴더를 다시 읽게 하고(`n:`), 새 폴더는 옮겨 알린다(`m:`). web 컨테이너의 `/work`에서 두 항목이 보였다.
- 이어서 `relay-top.txt`를 지우고 `relaydir/sub/b.txt`를 만들자 `n:/work m:/work/relaydir/sub`가 불렸다. `compose config --format json`은 두 번을 합쳐 **한 번만** 읽었다(세션 동안 캐시).
- 알린 경로 목록(함수의 반환값)은 밖에서 볼 수 없어 확인하지 않았다.

### 3. 파일 반영 확인 (`sync`)

- `ok` 복사본 세션에 "README.md 파일 끝에 shop 이라는 단어가 든 줄 하나를 더해 주세요"를 보냈다. 실행은 약 35초 안에 끝났고 `README.md`에 줄이 하나 더해졌다.
- 게이트의 확인에서 `docker run --rm --network none --volume <작업 복사본>:/project:ro busybox:1.37 sh -c <SYNC_SCRIPT> sh README.md`가 **한 번** 불렸다.
- 세션 기록의 `verify_result`: `{"ok":true,"sync":{"elapsedMs":151},"restarted":[{"service":"web","ready":true}], …}`, 화면 글 "샌드박스 파일 반영 확인: 0.2초".

## 보지 못한 것

- 진짜 포트 충돌(VM 안의 다른 컨테이너가 그 포트를 쓰고 있는 경우)은 만들지 못했다. 충돌 한 번은 감싸개가 꾸몄다. 세 번 모두 충돌해 포기하는 경로, 포트를 다시 뽑지 못하는 경로, override를 다시 쓰지 못하는 경로는 가짜 docker 시험으로만 확인했다.
- `sync`가 반영을 **기다리는** 경로(첫 확인에서 해시가 달라 다시 보는 경우)와 시간 초과는 실제로 나지 않았다(이번에는 첫 확인에서 같았다). 같은 파일의 줄이 둘이거나 모양을 모르는 줄이 오는 경우(트러블슈팅 191)도 실제 컨테이너에서는 만들지 않았다.
- 지운 파일과 함께 사라진 폴더를 기다리는 경로, 서비스가 여럿인 프로젝트의 알림, Docker Desktop은 돌리지 않았다.

## 정리

- 세 세션 모두 `DELETE /api/sessions/:id`로 멈춘 뒤 `POST …/delete`로 지웠다. 실측 컨테이너·네트워크가 남지 않았음을 확인했고, `ok` 폴더는 만든 파일을 지워 `git status`가 깨끗했다. `pnpm studio stop`.
