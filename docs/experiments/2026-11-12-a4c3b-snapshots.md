# 실측: 의존성 스냅샷·공유 볼륨·stats를 Rust로 옮긴 뒤 실제 Docker로 돌려 보기 (ADR-195 4f A4c-3b)

- 날짜: 2026-11-12
- 관련: 이슈 #1189, 브랜치 `feat/4f-a4c3b-snapshots`
- 모델 호출: 없음. API(`POST /api/projects/open`, `/api/sessions`, `/boot`)와 세션 이벤트 흐름(`GET /api/sessions/:id/events`)만 썼다
- 환경: macOS, Colima의 Docker, `docker compose` v2. 이미지는 busybox:1.37 하나. 모두 한 번 잰 값이다

## 방법

- A4c-3b worktree에서 `pnpm build:native`·`pnpm build:server` 뒤 `pnpm studio launch --mode local --port 3923`. 등록 목록·세션 폴더는 실측 폴더 `~/.cache/b-studio/real4`이다. PATH 맨 앞에 [A4c-2 실측](2026-11-12-a4c2-sync-relay-port.md)의 docker 감싸개를 두어 docker 호출을 기록했다(이번에는 아무 호출도 꾸미지 않았다).
- 실측 프로젝트 `sn`: 서비스 `web`(busybox httpd) 하나.
  - `snapshots: [{ volume: deps, key: [lock.txt] }]`.
  - 컨테이너는 `/deps/installed`가 없으면 `installing`을 찍고 2초 쉰 뒤 `lock.txt`를 `/deps/installed`에 복사한다(설치 흉내). 있으면 건너뛴다.
  - external 볼륨 `shared`(이름 `b-studio-a4c3b-shared`)를 마운트한다(`#ensureSharedVolumes` 확인용).
- 스냅샷 이벤트는 세션 기록에 남지 않고 로그 이벤트(`[b-studio] …`)로만 흐르므로, 두 번째 세션부터는 기동 전에 이벤트 흐름을 열어 받았다.
- 실측 전에 docker 볼륨 목록(37개, 다른 프로젝트의 `b-studio-snapshot-*` 10개 포함)을 저장해 두고 끝나고 견줬다.

## 결과

### 1. 첫 기동: 공유 볼륨 만들기 → 스냅샷 없음 → 설치 → 저장

- 세션 `44729058`이 8초 만에 `ready`가 됐다. 컨테이너 로그 첫 줄이 `installing`이다.
- docker 호출(감싸개 기록, 볼륨·복사만):
  1. `volume create --label b-studio.cache=true b-studio-a4c3b-shared`
  2. `volume inspect b-studio-snapshot-c31176ce700eaad0cc1f9344`(없음)
  3. (`up`, 준비 확인)
  4. `volume inspect b-studio-snapshot-c31176ce700eaad0cc1f9344`(그사이 다른 세션이 만들었는지)
  5. `volume create --label b-studio.snapshot=true --label b-studio.snapshot.slot=sn/web/deps b-studio-snapshot-c31176ce700eaad0cc1f9344`
  6. `run --rm --network none --volume studio-sn-a4fcc0_deps:/from:ro --volume b-studio-snapshot-c31176ce700eaad0cc1f9344:/to busybox:1.37 sh -c 'cp -a /from/. /to/ && touch /to/.b-studio-snapshot-complete'`
  7. `volume ls --quiet --filter label=b-studio.snapshot.slot=sn/web/deps`(하나뿐이라 정리하지 않음)
- 스냅샷 볼륨 안: `.b-studio-snapshot-complete`, `installed`(`v1`), `origin`(`fresh`).
- 세션 기록에 `boot_network`(`web` rx 4980 / tx 1430 바이트)가 남았다. 이것은 서비스가 준비된 직후 `stats()`를 한 번 불러 만든 값이라, `stats()`(Rust `read_stats`)가 실제 docker에서 돈 것이다.

### 2. 두 번째 기동: 스냅샷에서 채우기

- 세션 `25797952`가 5초 만에 `ready`가 됐다. 로그 이벤트: `[b-studio] deps 볼륨을 스냅샷에서 채웠습니다 (0.2초)`.
- docker 호출: `volume inspect <스냅샷>`(있음) → `volume create --label com.docker.compose.project=studio-sn-09ac75 --label com.docker.compose.volume=deps studio-sn-09ac75_deps` → `run --rm --network none --volume <스냅샷>:/from:ro --volume studio-sn-09ac75_deps:/to busybox:1.37 sh -c '[ -f /from/.b-studio-snapshot-complete ] || exit 3; …'`.
- 이 세션의 컨테이너 로그는 비어 있다(`installing`을 찍지 않았다). 채운 볼륨 덕에 설치를 건너뛴 것이다. 같은 스냅샷이 있으므로 저장(`volume create` 스냅샷)도 부르지 않았다.

### 3. 키 파일을 바꿔 새 스냅샷과 정리

- `lock.txt`를 `v2`로 바꿔 커밋하고 새 세션(`c39197f8`): `deps 스냅샷이 없어 처음부터 설치합니다` → `deps 볼륨을 다음 기동용 스냅샷으로 저장했습니다 (0.2초)`. 새 스냅샷 `b-studio-snapshot-05bf3436b06b5efcfc59b5df`. 같은 자리 목록이 2개라 정리하지 않았다.
- `v3`으로 바꿔 새 세션(`3f4a036c`): 저장(0.3초) 뒤 목록이 3개가 되어 정리가 돌았다.
  - `volume inspect --format {{.Name}} {{.CreatedAt}} b-studio-snapshot-05bf… b-studio-snapshot-8eb7… b-studio-snapshot-c311…`
  - `volume rm b-studio-snapshot-c31176ce700eaad0cc1f9344` — 가장 오래된 v1 스냅샷 하나만, `--force` 없이.
  - 남은 것: v2(`05bf…`), v3(`8eb7…`) 두 개.
- 실제 docker의 `CreatedAt`은 `2026-11-12T05:44:35+09:00`(시간대 오프셋이 붙은 RFC 3339) 모양이었다. 지금은 JS `Date.parse`가 읽는다. C1에서 Rust가 읽을 때 이 모양을 받아야 한다.

### 4. 다른 프로젝트의 볼륨이 그대로인 것

- 실측 전 목록과 견주면 **사라진 볼륨이 없다.** 새로 생긴 것은 이 실측의 것뿐이었다(공유 볼륨 1, sn 스냅샷 2, 세션 볼륨 `studio-sn-*_deps` 4). 다른 프로젝트의 스냅샷 10개(`orders`·`bench-orders-*`·`deploygate`·`planorders` 자리)는 그대로다. 정리는 `sn/web/deps` 자리의 라벨 필터 결과만 봤다.

### 5. 정리

- 세션 넷을 멈추고 지웠다(`DELETE /api/sessions/:id` → `POST …/delete`). 세션 볼륨 `studio-sn-*_deps` 넷과 컨테이너는 destroy가 지웠다. 그 뒤 이 실측이 만든 `b-studio-a4c3b-shared`와 sn 스냅샷 둘을 이름으로 지웠다. 볼륨 목록이 실측 전과 같아졌다.

## 보지 못한 것

- 채우기 실패 갈래(복사 종료 코드 3, 그 밖의 실패)와 저장 실패 갈래, 공유 볼륨 만들기 실패, stats 시간 초과는 실제 docker로 일으키지 않았다. 차등 시험과 Rust 시험(가짜 docker)으로만 확인했다.
- 두 세션이 같은 스냅샷을 동시에 저장하는 경합(`capturing`)은 재지 않았다.
- 큰 의존성(수백 MB)의 복사 시간은 재지 않았다. 이번 볼륨은 파일 둘이다.
