# 트러블슈팅

문제마다 **실제 실행에서 발견한 것**인지 **설계 중에 미리 대비한 것**인지 구분해 적었습니다.

- [1. Ctrl+C 한 번에 신호가 여러 번 들어와 정리가 중간에 끊길 수 있음](#1-ctrlc-한-번에-신호가-여러-번-들어와-정리가-중간에-끊길-수-있음)
- [2. Next dev 첫 요청이 준비 확인 시간을 넘김](#2-next-dev-첫-요청이-준비-확인-시간을-넘김)
- [3. 공유 캐시를 써도 두 번째 기동이 크게 빨라지지 않음](#3-공유-캐시를-써도-두-번째-기동이-크게-빨라지지-않음)
- [4. create-next-app이 "application path is not writable"로 실패](#4-create-next-app이-application-path-is-not-writable로-실패)
- [5. 검증 게이트가 컴파일 에러가 있는 코드를 "준비 완료"로 통과시킴](#5-검증-게이트가-컴파일-에러가-있는-코드를-준비-완료로-통과시킴)
- [6. 설계 중 대비한 문제들](#6-설계-중-대비한-문제들)

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

## 5. 검증 게이트가 컴파일 에러가 있는 코드를 "준비 완료"로 통과시킴

**구분:** 에이전트 e2e 실행에서 발견 → 원인을 실측으로 확인 → 수정 후 재검증

### 현상
e2e 시나리오 A는 **일부러 오타를 넣은 코드**(`return customerNam;`)를 쓰고 턴을 끝냅니다. 기대한 흐름은 "api 컴파일 실패 → 게이트 실패 → 수정 → 통과"였습니다. 그런데 결과는 이랬습니다.

```
▶ A. 주문 목록 API와 화면 (컴파일 에러 → 게이트 실패 → 수정 → 통과)
  게이트: 5개 파일 → 재시작·계약 비교
    검증 통과
    - web: 재시작 후 준비 완료
    - api: 재시작 후 준비 완료
    - api 계약:
        계약 변경 없음
  결과: done · 2턴 · 게이트 실패 0회 · 11.2s
  ✗ 게이트 [실패, 통과] (실제: true)
  ✗ API 응답에 시드 데이터 ({"timestamp":"2026-09-10T12:45:05.694Z","status":404,"error":"Not Found","path":)
```

- 게이트 전체가 11초 만에 끝났고, 새 API를 추가했는데도 계약이 "변경 없음"이었으며, `/api/orders`는 404였습니다. **새 코드가 아니라 옛 코드가 떠 있었다**는 뜻입니다.
- 몇 분 뒤 시나리오 B에서 api를 재시작하자 **A의 오타가 그제서야** 컴파일 에러로 드러났습니다.

```
/app/src/main/java/com/example/api/orders/CustomerOrder.java:32: error: cannot find symbol
        return customerNam;
               ^
```

게이트가 틀린 결과를 통과시키는 것은 게이트가 없는 것보다 위험합니다. 시나리오에 **"실패해야 하는 경우"**를 넣어 두지 않았다면 발견하지 못했을 버그입니다.

### 가설
colima의 기본 마운트는 sshfs이고, Lima 문서에 따르면 sshfs 캐시는 기본으로 켜져 있으며 호스트 변경이 제때 반영되지 않을 수 있습니다. 게이트는 파일을 쓰고 1초도 안 돼 서비스를 재시작했습니다. 그래서 빌드 도구가 **새 폴더와 파일이 반영되기 전의 소스 목록**을 보고, 이전에 컴파일해 둔 클래스(`api-build` 볼륨)로 앱을 띄웠다고 추정했습니다.

### 측정: 추측으로 고치지 않고 먼저 확인
호스트에서 파일을 바꾼 뒤, **같은 VM 마운트를 붙인 새 busybox 컨테이너**에서 반영될 때까지 0.5초 간격으로 확인했습니다.

**1차: 경로로 파일을 직접 열어 내용 확인**

| 경우 | 반영까지 |
|---|---|
| 기존 파일 수정 (크기 변경) | 1.7초 |
| 기존 파일 수정 (같은 크기) | 0.2초 |
| 기존 폴더에 새 파일 | 0.2초 |
| 새 폴더에 새 파일 | 0.2초 |

이 결과만 보면 지연이 짧아서 11초 동안 옛 코드가 돈 이유를 설명하지 못합니다. 그런데 빌드 도구는 파일을 경로로 여는 게 아니라 **디렉터리 목록과 파일 속성**으로 변경을 감지합니다.

**2차: 빌드 도구처럼 목록과 속성 확인 (직전에 한 번 읽어 캐시를 채운 상태)**

| 경우 | 반영까지 |
|---|---|
| 기존 폴더에 새 파일 → `ls` 목록 | **21.6초** |
| 새 폴더 → 상위 폴더 `ls` 목록 | **20.2초** |
| 기존 파일 크기 변경 → `stat` 크기 | **21.8초** |
| 새 파일 → `find` 재귀 탐색 | **20.9초** |

목록과 속성은 **약 20초 동안 옛 상태**로 보였습니다. 파일을 쓴 직후 재시작한 서비스가 옛 소스 목록을 볼 수 있는 조건이 실제로 존재한다는 뜻입니다.

### 해결
재시작 전에 **샌드박스 쪽에서 바뀐 파일이 보일 때까지 기다리는 동기화 지점** `Sandbox.sync(files)`을 추가했습니다([ADR-014](decisions.md#adr-014-재시작-전에-샌드박스가-바뀐-파일을-보는지-확인한다)).
- 디렉터리 목록에 이름이 보이는지와 내용 sha256이 호스트와 같은지를 함께 확인합니다. 1차 측정처럼 경로로 직접 여는 확인만으로는 이 버그를 막지 못합니다.
- 검증 게이트와 `restart_service` 도구가 재시작 전에 호출합니다.
- 반영이 60초 안에 확인되지 않으면 재시작하지 않고 게이트 실패로 처리합니다.

### 수정 후 검증
같은 e2e를 다시 실행했습니다.

```
▶ A. 주문 목록 API와 화면 (컴파일 에러 → 게이트 실패 → 수정 → 통과)
  게이트: 5개 파일 → 재시작·계약 비교
    검증 실패
    - 샌드박스 파일 반영 확인: 15.9초
    - web: 재시작 후 준비 완료
    - api: 준비 실패 — 컨테이너가 종료됐습니다 (마지막 확인: ECONNRESET, 컨테이너 exited)
      마지막 로그:
        > Task :compileJava FAILED
        /app/src/main/java/com/example/api/orders/CustomerOrder.java:29: error: cannot find symbol
                return customerNam;
  게이트: 4개 파일 → 재시작·계약 비교
    검증 통과
    - 샌드박스 파일 반영 확인: 0.7초
    - api: 재시작 후 준비 완료
    - api 계약:
        ＋ operation-added GET /api/orders
        ＋ schema-added OrderResponse
  결과: done · 4턴 · 게이트 실패 1회 · 33.5s
```

- 첫 게이트는 반영을 **15.9초** 기다린 뒤 재시작했고, 이번에는 컴파일 에러를 정확히 잡아 로그와 함께 돌려줬습니다. 2차 측정의 약 20초 지연과 같은 규모입니다.
- 두 번째 게이트는 **지난 게이트 이후 바뀐 파일과 실패했던 api만** 다시 확인했고, 이미 통과한 web은 재시작하지 않았습니다.
- 캐시가 이미 새 상태일 때는 확인이 0.2~3.0초 만에 끝났습니다(시나리오 B 3.0초, C 0.2초). 지연이 없는 환경에서는 비용이 작습니다.
- 시나리오 A~C의 확인 항목이 모두 통과했습니다.

### 배운 점
- **1차 측정에서 멈췄다면 "지연은 1~2초뿐"이라는 틀린 결론을 냈을 것입니다.** 문제를 재현하려면 빌드 도구가 파일을 *어떻게* 보는지(목록과 속성)를 그대로 흉내 내야 했습니다.
- colima를 virtiofs 마운트로 바꾸는 방법도 있지만 직접 검증하지 않았고, 사용자 환경을 강제할 수도 없습니다. 그래서 환경과 무관하게 동작하는 동기화 지점을 기본으로 두었습니다.

---

## 6. 설계 중 대비한 문제들

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
