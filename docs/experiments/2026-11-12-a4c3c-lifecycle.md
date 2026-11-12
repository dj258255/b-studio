# 실측: exec·사내 API 호출·부하 러너·destroy를 Rust로 옮긴 뒤 실제 Docker로 돌려 보기 (ADR-195 4f A4c-3c)

- 날짜: 2026-11-12
- 관련: 이슈 #1191, 브랜치 `feat/4f-a4c3c-exec-destroy`
- 모델 호출: 없음. 스튜디오 서버를 거치지 않고, 이 브랜치의 `LocalDockerProvider`를 작은 스크립트(tsx)에서 바로 불렀다(`create` → `start` → `exec` → `callExternal` → `runLoad` → `destroy`)
- 환경: macOS, Colima의 Docker, `docker compose` v2.31. 이미지는 busybox:1.37과 edge 이미지(부하 러너가 같은 이미지를 쓴다). 모두 한 번 잰 값이다

## 방법

- 실측 프로젝트 `lc`:
  - managed 서비스 `web`: `build: .`(busybox httpd. compose가 이 샌드박스의 이미지 `studio-lc-<6자>-web`을 빌드하므로 destroy의 이미지 지우기를 볼 수 있다).
  - external 서비스 `inner`: `baseUrl: http://web:8080`(가짜 사내 API. edge가 같은 샌드박스 네트워크의 `web`으로 보낸다).
  - 시크릿 `LC_SECRET=lc-secret-value-123`을 넘겨 가림을 본다.
- PATH 맨 앞에 [A4c-2 실측](2026-11-12-a4c2-sync-relay-port.md)의 docker 감싸개를 두어 docker 호출을 기록했다(아무 호출도 꾸미지 않았다).
- 부하는 호스트의 전달 포트가 아니라 샌드박스 네트워크 안의 러너 컨테이너가 보낸다(저장소 규칙). 200건, 동시 4.
- 실측 전에 컨테이너·볼륨·이미지·네트워크 목록과 임시 폴더의 `b-studio-*`를 저장해 두고 끝나고 견줬다.

## 결과

1. `create` → `start`: 샌드박스 `studio-lc-dfe062`가 3.1초 만에 `ready`(`web` → `http://127.0.0.1:32784`). 작업 폴더는 `$TMPDIR/b-studio-0d2e39`(Rust `make_work_dir`).
2. `exec('web', sh -c 'echo hello; echo <시크릿>; echo err >&2; exit 3')`: `{"exitCode":3,"stdout":"hello\n[LC_SECRET 가림]\n","stderr":"err\n"}`. 종료 코드와 가림이 옛 모양 그대로다.
3. `callExternal('inner', GET /ping.json)`: `{"decision":"allow","status":200,"body":"{\"ok\":true}\n","masked":0}`. 등록하지 않은 이름(`nope`)은 `'nope'은(는) 등록한 사내 API가 아닙니다`, `/`로 시작하지 않는 경로는 `경로는 "/"로 시작해야 합니다`로 docker를 부르기 전에 거절했다(감싸개 기록에 그 호출이 없다).
4. `runLoad(200건, 동시 4, 준비 10)`: `docker info --format {{.NCPU}}` 한 번 뒤 `docker run --rm --interactive --pull never --name studio-lc-dfe062-load-973fe756 … --network studio-lc-dfe062_b-studio-sandbox --cpus 1 --memory 512m …`. 결과 200건 모두 200, 91ms, p50 1.1ms / p99 2.3ms(컨테이너 네트워크 안의 값). 정상 종료라 `rm`을 부르지 않았다.
5. 중단: 5천만 건 요청을 1.5초 뒤 `AbortController`로 끊자 `AbortError`가 났고, 그 실행이 만든 이름으로만 `rm --force studio-lc-dfe062-load-9311775c`를 불렀다.
6. `destroy`(10.6초): `compose --project-name studio-lc-dfe062 --project-directory … --file …/compose.yaml --file …/b-studio-0d2e39/compose.override.yaml down --volumes --remove-orphans --rmi local` → `image ls --filter reference=studio-lc-dfe062-* --filter label=com.docker.compose.project=studio-lc-dfe062 --format {{.Repository}}:{{.Tag}}`. 빌드한 이미지는 `down --rmi local`이 이미 지워 목록이 비었고 `image rm`은 부르지 않았다.
7. 실측 전후 비교: 컨테이너·볼륨·이미지·네트워크 목록이 실측 전과 같다(이 샌드박스의 것은 모두 사라지고, 다른 프로젝트의 것은 그대로). 임시 폴더에 `b-studio-*`가 남지 않았다.

### 이미지 라벨 필터(트러블슈팅 194의 고침)

- 이 실측 전에 다른 세션이 남긴 이미지(`studio-bench-orders-6791b1-api`)를 읽기만 해서 확인했다: compose가 빌드한 이미지에 `com.docker.compose.project=studio-bench-orders-6791b1` 라벨이 붙어 있다. `image ls --filter reference=studio-bench-orders-6791b1-* --filter label=com.docker.compose.project=studio-bench-orders-6791b1`은 그 이미지 둘을 돌려주고, 접두사만 겹치는 다른 id(`reference=studio-bench-*`, `label=…=studio-bench`)로는 빈 결과였다(서로 다른 필터는 AND).

## 보지 못한 것

- `cleanup`(스튜디오가 강제 종료된 뒤 이름으로 지우기)은 실제 docker로 돌리지 않았다. 컨테이너가 이미 없어 `--rmi local`이 이미지를 못 찾고 `image ls` → `image rm`이 실제로 지우는 갈래도 실제로는 보지 않았다(필터 동작만 읽기로 확인).
- `create` 실패 뒤 정리, 부하 러너의 시간 초과(상한 수십 초)와 종료 코드 137, 사내 API 거절(`deny`) 갈래는 실제 docker로 일으키지 않았다.
- 스튜디오 세션 경로(세션 API → destroy)로는 이번에 재지 않았다. 세션을 지울 때의 destroy는 A4c-3b 실측에서 옛 코드 그대로의 결과(볼륨이 남지 않음)를 봤지만 그때는 이 조각의 코드가 아니었다.
