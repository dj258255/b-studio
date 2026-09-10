# 트러블슈팅

문제마다 **실제 실행에서 발견한 것**인지 **설계 중에 미리 대비한 것**인지 구분해 적었습니다.

- [1. Ctrl+C 한 번에 신호가 여러 번 들어와 정리가 중간에 끊길 수 있음](#1-ctrlc-한-번에-신호가-여러-번-들어와-정리가-중간에-끊길-수-있음)
- [2. Next dev 첫 요청이 준비 확인 시간을 넘김](#2-next-dev-첫-요청이-준비-확인-시간을-넘김)
- [3. 공유 캐시를 써도 두 번째 기동이 크게 빨라지지 않음](#3-공유-캐시를-써도-두-번째-기동이-크게-빨라지지-않음)
- [4. create-next-app이 "application path is not writable"로 실패](#4-create-next-app이-application-path-is-not-writable로-실패)
- [5. 설계 중 대비한 문제들](#5-설계-중-대비한-문제들)

---

## 1. Ctrl+C 한 번에 신호가 여러 번 들어와 정리가 중간에 끊길 수 있음

**구분:** 첫 실행 뒤 프로세스 구조를 확인하다가 발견 → 수정 후 재현 테스트로 검증

### 현상
`pnpm studio up`은 프로세스가 `pnpm → tsx → node` 순서로 이어져 있습니다.

```
50124  node .../tsx/dist/cli.mjs apps/cli/src/main.ts up examples/orders
50130  node --require .../tsx/dist/preflight.cjs --import ... apps/cli/src/main.ts ...
```

터미널에서 Ctrl+C를 누르면 SIGINT가 프로세스 그룹 전체에 전달되고, tsx도 받은 신호를 자식 node에 다시 전달합니다. 그래서 **실제 CLI 프로세스는 SIGINT를 두 번 이상 받을 수 있습니다.**

처음 코드는 신호 처리기를 `process.once`로 등록했습니다.

```ts
process.once('SIGINT', () => void cleanup());
```

`once`는 첫 신호를 처리한 뒤 처리기를 지웁니다. 그 상태에서 두 번째 SIGINT가 오면 Node의 기본 동작(즉시 종료)이 실행돼, **`docker compose down`이 끝나기 전에 프로세스가 죽고 컨테이너와 볼륨이 남을 수 있습니다.**

### 해결
정리 함수 자체를 **멱등하게** 만들고, 신호 처리기는 계속 등록해 둡니다.

```ts
/** 여러 번 호출돼도 한 번만 실행하고 같은 Promise를 돌려준다 */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | undefined;
  return () => (result ??= fn());
}

const cleanup = once(async () => { /* abort + sandbox.destroy() */ });
const onSignal = () => void cleanup();
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
```

### 검증
샌드박스가 준비된 상태에서 **tsx 부모와 node 자식 양쪽에 SIGINT를 보내** 중복 신호를 재현했습니다.

```
== SIGINT -> node child=52941, tsx parent=52935
studio │ 샌드박스를 정리합니다 (studio-orders-2b242c)
containers left: 0
sandbox volumes left: 0
shared caches: b-studio-cache-gradle b-studio-cache-pnpm
```

### 배운 점
이 버그는 단위 테스트로는 잡을 수 없었습니다. **실제 프로세스 트리를 띄워 보고 나서야** 신호가 어떤 경로로 전달되는지 보였습니다.

---

## 2. Next dev 첫 요청이 준비 확인 시간을 넘김

**구분:** 실제 실행에서 발견

### 현상
준비 확인 로그가 이렇게 바뀌었습니다.

```
web │ 준비 확인: UND_ERR_SOCKET (컨테이너 running)
web │ 준비 확인: The operation was aborted due to timeout (컨테이너 running)
web │ 준비 확인: HTTP 200 (컨테이너 running)
```

Next.js dev 서버는 **페이지를 처음 요청받을 때 컴파일**합니다. 그래서 첫 요청이 확인 요청의 제한 시간(2초)을 넘깁니다. 포트는 열렸지만 서버가 아직 요청을 처리하지 못하는 동안에는 `UND_ERR_SOCKET`도 발생합니다.

### 해결
1. **판정 규칙**: 연결 에러와 타임아웃은 "실패"가 아니라 "기동 중"으로 보고, 서비스별 `timeoutSeconds`까지 기다립니다. 반대로 컨테이너가 죽었을 때는 즉시 실패로 봅니다. ([ADR-007](decisions.md#adr-007-서비스-준비-판정-규칙))
2. **로그 정리**: `AbortSignal.timeout`이 던지는 `DOMException(TimeoutError)`을 `TIMEOUT`으로 짧게 표시합니다. `instanceof Error`보다 먼저 `name`으로 확인하도록 했습니다.

수정 후 로그:

```
web │ 준비 확인: UND_ERR_SOCKET (컨테이너 running)
web │ 준비 확인: TIMEOUT (컨테이너 running)
web │ 준비 확인: HTTP 200 (컨테이너 running)
web │ 준비 완료 → http://127.0.0.1:32770
```

---

## 3. 공유 캐시를 써도 두 번째 기동이 크게 빨라지지 않음

**구분:** 실제 실행에서 발견 (아직 해결 안 함, 다음 과제)

### 현상
Gradle과 pnpm 캐시를 공유 볼륨으로 유지했는데도, 두 번째 기동은 **늦어도 43초 안에** 준비되는 수준이었습니다(첫 확인 시점 기준 상한값). 극적인 차이는 없었습니다.

### 원인
| 단계 | 공유 캐시 효과 |
|---|---|
| Gradle 배포판과 Maven 의존성 다운로드 | ✅ 사라짐 (첫 컴파일 때 `gradle-9.7.1-bin.zip`을 받았고, 이후에는 받지 않음) |
| `pnpm install` | ⚠️ 다운로드는 저장소에서 가져오지만, `node_modules`는 **샌드박스 전용 볼륨이라 매번 새로 만듦** (패키지 354개 연결) |
| Next dev 첫 컴파일, Spring 기동 | ❌ 캐시와 무관 |

### 다음 계획
토스 TOI의 `packageSetHash`처럼 **lockfile 해시를 키로 "설치가 끝난 상태"를 재사용**할 계획입니다.
- 로컬 Docker: lockfile 해시별로 설치가 끝난 이미지 레이어나 볼륨을 만들어 두고 재사용
- microVM 제공자: lockfile 해시별 스냅샷에서 시작

---

## 4. create-next-app이 "application path is not writable"로 실패

**구분:** 실제 실행에서 발견

### 현상
```
$ pnpm create next-app@16.3.4 templates/nextjs-web --yes --skip-install --disable-git --use-pnpm
The application path is not writable, please check folder permissions and try again.
```

### 원인과 해결
권한 문제가 아니었습니다. 대상 경로의 **상위 폴더 `templates/`가 아직 없었습니다.** `mkdir -p templates`로 상위 폴더를 만든 뒤 같은 명령이 성공했습니다. 에러 메시지만 보고 권한을 바꾸려 했다면 엉뚱한 곳을 고칠 뻔했습니다.

---

## 5. 설계 중 대비한 문제들

실행 전에 도구의 동작 방식을 확인하고 코드에 반영한 부분입니다.

| 문제 | 대비 |
|---|---|
| 소스를 마운트하는 개발 이미지는 이미지가 그대로라 `compose up --build`로는 컨테이너가 교체되지 않음 | `restart()`에서 `--force-recreate`를 사용 |
| compose는 `external: true` 볼륨을 만들어 주지 않음 | 로더가 external 볼륨 목록을 모으고, 제공자가 기동 전에 `docker volume create` 실행 |
| `docker compose ps --format json` 출력이 버전에 따라 줄 단위 JSON 또는 배열 | 두 형식을 모두 파싱하고 테스트로 고정 |
| `compose logs --timestamps`는 나노초 정밀도라 `Date`가 다루지 못함 | 밀리초까지만 남기고 파싱 |
| 서비스 이름에 하이픈이 들어가면(`order-api-1`) 컨테이너 번호와 구분이 어려움 | 정규식에서 마지막 `-숫자`만 번호로 인식하고 테스트로 고정 |
| Spring Initializr 기본 테스트(`contextLoads`)는 DB가 있어야 통과 | 템플릿에서 제거. DB 없이 도는 슬라이스 테스트는 에이전트 검증 단계에서 추가 예정 |
| 사용자의 compose 파일에 스튜디오 설정을 넣으면 표준 파일이 오염됨 | 임시 디렉터리의 override 파일로 덧씌우고 `destroy()` 때 삭제 |
| 실행 경로에서 셸을 거치면 명령 주입 위험 | `child_process.execFile`/`spawn`에 인자를 배열로 전달해 셸을 거치지 않음 |
