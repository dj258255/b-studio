# 실측: 컨테이너 사후 확인과 시작을 Rust로 옮긴 뒤 실제 Docker로 켜 보기 (ADR-195 4f A4b)

- 날짜: 2026-11-11
- 관련: 이슈 #1174, 커밋 58c974f(브랜치 `feat/4f-a4b-verify-containers`)
- 모델 호출: 없음. 세션을 만들고 "지금 켜기"(`POST /api/sessions/:id/boot`)만 불렀다. 그래서 이 확인 단계에 닿는 것은 샌드박스 기동뿐이다
- 환경: macOS, Colima의 Docker. 이미지는 busybox:1.37 하나. 한 번 잰 값이다

## 방법

- A4b worktree에서 `pnpm build:native`·`pnpm build:server`를 돌린 뒤 `pnpm studio launch --mode local --port 3923`으로 띄웠다(그때 떠 있던 다른 스튜디오는 없었다). 등록 목록·세션 폴더·규칙표는 모두 실측 폴더 `~/.cache/b-studio/real4` 안에 두었다.
- 프로젝트 둘. 둘 다 busybox httpd가 프로젝트 폴더를 `/work`로 마운트해 내준다.
  - `ok`: 그대로.
  - `bad`: 같은 compose에 `privileged: true` 한 줄만 더했다. 이 설정은 정적 검사가 없고 만든 컨테이너를 시작하기 전에 확인하는 단계만 막는다.
- `/api/projects/open`(apply)으로 등록하고 `/api/sessions`로 세션을 만든 뒤 boot를 불렀다. `bad`는 `docker events --filter type=container`를 함께 켜 두었다.

## 결과

| 세션 | boot 뒤 | 컨테이너 |
|---|---|---|
| ok | 약 5초 만에 `ready` | web·edge 모두 `Up`. web의 마운트: `/work` rw=true, `/work/.git` rw=false, `/work/.git/b-studio` rw=false(빈 폴더 `.git/b-studio-empty`) |
| bad | 약 1초 만에 `failed` | 이벤트: edge `create`, web `create`, web `destroy`. **web의 `start` 이벤트는 없다.** edge는 `Created`로 남았다(시작하지 않음) |

`bad`의 오류 글(세션의 `error`):

```
컨테이너에 샌드박스 격리를 벗어나는 설정이 있어 시작하지 않았습니다 (studio-bad-b98f50)
web: privileged, security_opt: label=disable
```

- 플랫폼 실패가 아니라 compose 문제로 표시된다(에이전트가 고칠 수 있는 원인). 옛 TS와 같은 글이다.
- edge가 `Created`로 남는 것은 옛 TS와 같다. 옛 코드도 위반이 있는 컨테이너만 `rm --force`했다(`verify-containers-legacy.ts`의 `remove`). 그 세션을 지우자 edge도 함께 지워졌다.

## 보지 못한 것

- `.git` 가림이 빠진 컨테이너(가림 실패 경로)는 실제로 만들지 못했다. override를 스튜디오가 쓰므로 정상 compose로는 그 상태가 되지 않는다. 그 경로는 가짜 docker로 돈 차등 시험 62개가 옛 TS와 같은 결과를 낸다는 것으로만 확인했다.
- 서비스가 여럿인 프로젝트의 의존 순서 기동(`service_healthy` 기다림)은 이번에 돌리지 않았다. 차등 시험으로만 확인했다.
- 시작한 뒤 확인(`started` 단계)에서 지우는 경로는 보지 않았다.
- Docker Desktop(`/host_mnt/…` 접두어)은 이 기기에 없어 돌리지 않았다.

## 정리

- `bad` 세션은 API로 지웠다(edge 포함). `ok` 세션은 실행 중이라 API가 지우지 않았고, 스튜디오를 먼저 내렸으므로 실측에서 만든 compose 프로젝트 `studio-ok-1f96c5`만 이름으로 지정해 `docker compose -p studio-ok-1f96c5 down --remove-orphans`로 내렸다. 남은 컨테이너·네트워크는 없음을 확인했다.
