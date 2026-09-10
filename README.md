# b-studio

> 사내 API와 정책 위에서 **프론트엔드와 백엔드를 함께 만들고, 바로 실행해 확인하는 AI 앱 빌더**

`studio.yaml` 한 파일로 서비스를 정의하면, `pnpm studio up` 한 번으로 **Next.js 16 + Spring Boot 4.1 + PostgreSQL 17**이 격리된 샌드박스에서 함께 뜹니다. 준비 상태 판정, 로그 스트리밍, 미리보기 URL과 OpenAPI 계약 주소 안내, 종료 시 정리까지 CLI가 처리합니다.

`pnpm studio agent`는 요청을 Claude에게 맡깁니다. 에이전트가 "끝났다"고 해도 **스튜디오가 직접 바뀐 서비스를 재시작하고, 준비 상태와 API 계약을 확인해 통과해야만** 완료로 봅니다. API 키가 없어도 **본인 PC의 `claude` CLI에 로그인한 계정으로** 같은 흐름을 실행할 수 있습니다(개인 PC 전용).

![에이전트가 넣은 컴파일 에러를 검증 게이트가 로그와 함께 되돌려 보내고, 수정 후 통과해 미리보기에 주문 화면이 뜬 모습](docs/images/studio-gate-retry.png)

| 단계 | 상태 |
|---|---|
| 1. 런타임 코어 (프로젝트 명세 · 샌드박스 · 템플릿 · CLI) | ✅ 완료 |
| 2. 에이전트 루프 (Plan → Code → Run → Verify) | ✅ 구현 · 스크립트 모델과 실제 모델(로컬 로그인 계정)로 실제 Docker에서 검증 (API 키 경로는 인증 정보 필요) |
| 3. 웹 스튜디오 (대화 · 미리보기 · API 탐색기 · 로그) | ✅ 구현 · 데모 모드와 로컬 로그인 계정 모드로 실제 브라우저에서 검증 |
| 4. 세션 체크포인트 (통과한 변경만 남기기 · 되돌리기) | ✅ 구현 · 데모 모드로 실제 브라우저에서 검증 |
| 5. 로컬 로그인 계정으로 실행 (API 키 없이 개인 PC에서) | ✅ 구현 · CLI와 웹 스튜디오에서 실제 모델로 검증 |
| 6. 원격 저장소 연동 (세션 브랜치 · 덮어쓰지 않는 푸시 · PR) | ✅ 구현 · 실제 git 원격과 Gitea PR API로 브라우저에서 검증 (GitHub·GitLab API는 가짜 서버 테스트) |
| 7. DB 브랜치 · 정책 프록시 · 격리 강화 | 📋 계획 |

---

## 왜 만들었나

토스는 사내 어드민을 AI로 만드는 도구 **TOI studio**를 공개했습니다([AI가 만든 코드가 어드민이 되기까지](https://toss.tech/article/52885)). 반년 만에 프로젝트 439개, 페이지 2,418개가 만들어졌습니다. 핵심은 두 가지였습니다.

1. **정책은 플랫폼이 강제한다.** API를 등록하면 서버 프록시가 마스킹, 감사 로그, 암호화를 자동으로 적용합니다.
2. **화면은 AI가 만들고 브라우저에서 바로 보여 준다.** esbuild-wasm과 가상 파일 시스템으로 첫 화면을 47초에서 1.3초로 줄였습니다.

다만 TOI의 브라우저 런타임은 **클라이언트에서만 도는 React SPA**에 맞춘 구조입니다. 이 프로젝트의 요구사항은 달랐습니다.

| 요구사항 | TOI 방식으로 어려운 이유 |
|---|---|
| Next.js 같은 **서버 런타임이 필요한 프레임워크** 지원 | RSC, SSR, Server Action, Route Handler는 Node 서버와 네이티브 컴파일러(SWC/Turbopack)가 필요함 |
| **백엔드(Spring, Python)까지 생성** | 브라우저에서 JVM과 DB를 돌릴 수 없음 |
| 사내 도구로 **사내망에서 운영** | 외부 SaaS 샌드박스에 코드와 데이터를 보낼 수 없는 환경이 있음 |

그래서 **실제 Linux 환경에서 실제 `next dev`와 `gradlew bootRun`을 실행하는 서버 샌드박스**를 기반으로 설계했습니다. 선택지 비교와 근거는 [설계 결정 기록](docs/decisions.md)에 정리했습니다.

## 아키텍처

```mermaid
flowchart LR
  subgraph Studio["b-studio"]
    UI["apps/studio<br/>웹 스튜디오 (Next.js 16)"]
    CLI["apps/cli<br/>studio up · agent"]
    AG["@b-studio/agent<br/>에이전트 루프 · 검증 게이트"]
    SPEC["@b-studio/spec<br/>studio.yaml 검증"]
    SB["@b-studio/sandbox<br/>Sandbox 인터페이스"]
  end

  subgraph Providers["SandboxProvider 구현"]
    LD["LocalDockerProvider<br/>(구현 완료)"]
    K8S["K8s agent-sandbox + gVisor/Kata<br/>(예정)"]
  end

  subgraph Box["샌드박스 = compose 프로젝트 1개"]
    WEB["web<br/>Next.js 16"]
    API["api<br/>Spring Boot 4.1"]
    DB[("db<br/>PostgreSQL 17")]
  end

  UI --> AG
  CLI --> AG
  UI --> SPEC
  CLI --> SPEC
  AG --> SB
  SB --> LD
  SB -.-> K8S
  LD --> Box
  WEB -- "/api/* rewrite" --> API
  API --> DB
```

### `studio up`이 하는 일

```mermaid
sequenceDiagram
  participant U as 개발자
  participant C as studio CLI
  participant P as LocalDockerProvider
  participant D as Docker Compose

  U->>C: pnpm studio up examples/orders
  C->>C: loadProject() — studio.yaml과 compose.yaml이 서로 맞는지 검증
  C->>P: create(project)
  P->>P: override 파일 생성 (127.0.0.1의 빈 포트 공개, 라벨)
  C->>P: start()
  P->>D: docker volume create (공유 캐시)
  P->>D: compose up --detach --build
  loop 서비스마다 1초 간격
    P->>D: compose ps (컨테이너 상태)
    P->>P: HTTP 확인 → decideReadiness()
  end
  P-->>C: 서비스별 endpoint
  C-->>U: 미리보기 URL · 계약 URL · 실시간 로그
  U->>C: Ctrl+C
  C->>P: destroy() → compose down --volumes
```

## 핵심 설계 결정

| 결정 | 이유 | 기록 |
|---|---|---|
| 브라우저 번들러 대신 **서버 샌드박스** | Next.js 서버 기능과 백엔드까지 로컬과 똑같이 실행하기 위해 | [ADR-001](docs/decisions.md#adr-001-미리보기-런타임-브라우저-번들러-대신-서버-샌드박스) |
| **구조는 통합, 작업 화면은 분리** | 프론트·백엔드·풀스택·기존 API 연동을 하나의 모델로 표현하기 위해 | [ADR-002](docs/decisions.md#adr-002-프로젝트-모델-구조는-통합-작업-화면은-분리) |
| 계약(OpenAPI)은 **코드에서 추출하는 선택 사항** | 백엔드 개발자의 코드 우선 작업 방식과 Next.js 단일 서비스 풀스택을 존중하기 위해 | [ADR-003](docs/decisions.md#adr-003-계약은-코드에서-추출하는-선택-사항) |
| **compose + OpenAPI 표준 위에 얇은 `studio.yaml`** | 도구를 쓰지 않아도 `docker compose up`으로 똑같이 돌아가게 하기 위해 | [ADR-004](docs/decisions.md#adr-004-새-dsl을-만들지-않는다-compose--openapi-위의-얇은-층) |
| **샌드박스 제공자 추상화**, 로컬 Docker부터 | 사내 Kubernetes·강한 격리 런타임으로 구현만 바꾸기 위해 | [ADR-006](docs/decisions.md#adr-006-샌드박스-제공자를-추상화하고-로컬-docker부터-구현) |
| **직접 작성한 루프 + 스튜디오 검증 게이트** | 모델이 "끝났다"고 해도 재시작·준비 판정·계약 비교를 통과해야 완료로 보기 위해 | [ADR-010](docs/decisions.md#adr-010-에이전트-루프-직접-작성한-루프와-스튜디오-검증-게이트) |
| **bash 대신 행동별 도구** | 경로 제한, 덮어쓰기 충돌 방지, 바뀐 파일 기록을 강제하기 위해 | [ADR-011](docs/decisions.md#adr-011-도구-설계-bash-하나-대신-행동별-도구) |
| **계약 호환 깨짐은 기본 차단** | 요청하지 않은 필드 삭제·타입 변경이 운영 중인 화면을 깨뜨리지 않게 하기 위해 | [ADR-013](docs/decisions.md#adr-013-계약-호환-정책-기본은-차단-요청이-명시할-때만-허용) |
| **재시작 전 파일 반영 확인** | 파일 공유 캐시 때문에 게이트가 옛 코드를 검증하는 일을 막기 위해 | [ADR-014](docs/decisions.md#adr-014-재시작-전에-샌드박스가-바뀐-파일을-보는지-확인한다) |
| **Next.js 단일 앱 + Server-Sent Events** | 오래 걸리는 샌드박스·에이전트 작업의 진행 상황을 한 프로세스에서 실시간으로 보내기 위해 | [ADR-015](docs/decisions.md#adr-015-스튜디오-서버-nextjs-단일-앱과-server-sent-events) |
| **작업 복사본을 Git 체크포인트로 관리** | "완료로 인정하지 않음"을 넘어 실패한 변경이 실제로 남지 않게 하기 위해 | [ADR-018](docs/decisions.md#adr-018-세션-체크포인트-검증을-통과한-변경만-남긴다) |
| **로컬 로그인 계정 모드는 명시적으로 켜고, 기본 도구를 모두 끔** | 로그인 흐름 없이 본인 PC에서만 쓰고, 모델이 샌드박스와 작업 공간 규칙을 우회하지 못하게 하기 위해 | [ADR-019](docs/decisions.md#adr-019-로컬-로그인-계정으로-실행-api-키-없이-개인-pc에서만) |
| **원본 저장소를 복제한 세션 브랜치 + 마지막으로 올린 커밋 기준 lease 푸시** | 체크포인트를 그대로 PR로 넘기고, 되돌린 기록은 반영하되 리뷰어 커밋은 덮어쓰지 않기 위해 | [ADR-020](docs/decisions.md#adr-020-원격-저장소-연동-세션-브랜치와-덮어쓰지-않는-푸시) |

## 프로젝트 구조

```
b-studio/
├─ packages/
│  ├─ spec/           studio.yaml 스키마(zod 4)와 로더. compose 파일과 서로 맞는지 검증
│  ├─ sandbox/        Sandbox/SandboxProvider 인터페이스, 준비 판정, 파일 반영 확인, LocalDockerProvider
│  └─ agent/          에이전트 루프, 도구, 작업 공간 안전장치, 검증 게이트, 계약 비교, Claude·스크립트 클라이언트, 로컬 CLI 실행기, 체크포인트·원격 저장소 연동
├─ apps/
│  ├─ cli/            studio up · studio agent — 샌드박스 수명 주기, 에이전트 실행, 로그 스트리밍
│  └─ studio/         웹 스튜디오 (Next.js 16) — 세션 관리자, SSE, 대화 · 미리보기 · API 탐색기 · 로그
├─ templates/         새 서비스의 원본 (각각 개발용 Dockerfile과 lockfile 포함)
│  ├─ nextjs-web/     Next.js 16.3 · React 19 · Tailwind 4
│  ├─ spring-boot-api/ Spring Boot 4.1 · Java 25 · JPA · Flyway · springdoc 3.1
│  └─ fastapi-api/    FastAPI 0.141 · Python 3.14 · SQLAlchemy · uv
├─ examples/
│  └─ orders/         web + api + db 예제 프로젝트
└─ docs/
   ├─ decisions.md    설계 결정 기록 (ADR)
   └─ troubleshooting.md  실행하며 발견하고 해결한 문제
```

## 실행 방법

**필요한 것:** Node.js 22 이상, pnpm 10, Docker (Compose v2)

```bash
pnpm install
pnpm test                          # 단위 테스트
pnpm typecheck                     # 패키지 전체 타입 체크
pnpm studio up examples/orders     # 샌드박스 기동 (Ctrl+C로 종료하면 정리)
pnpm e2e:agent                     # 스크립트 모델로 에이전트 루프 전체를 실제 Docker에서 검증 (API 키 불필요)
pnpm studio:demo                   # 웹 스튜디오를 데모 모드로 실행 (http://127.0.0.1:3000, API 키 불필요)

# Claude API 인증 정보가 있을 때
export ANTHROPIC_API_KEY=...
pnpm studio agent examples/orders "주문에 배송 메모 필드 추가해줘"
pnpm studio agent examples/orders "메모 필드를 응답에서 제거해줘" --allow-breaking   # 호환 깨짐을 명시적으로 허용

# API 키 없이, 이 PC의 claude CLI에 로그인한 계정으로 (개인 PC 전용)
pnpm studio agent examples/orders "현재 서버 시각을 돌려주는 GET /api/time 엔드포인트를 추가해줘" --backend claude-code
pnpm studio:local                  # 웹 스튜디오를 로컬 로그인 계정 모드로 실행
```

**원본 프로젝트가 Git 저장소면** 세션이 커밋된 상태를 복제해 `b-studio/<프로젝트>-<세션>` 브랜치에서 시작합니다. 기록 탭에서 체크포인트를 원격 브랜치로 올리고 PR을 만들 수 있습니다.

```bash
export B_STUDIO_PROJECTS_DIR=~/work/projects   # 프로젝트 폴더들이 있는 곳. 각 폴더가 Git 저장소면 원격 연동이 켜짐
export B_STUDIO_GITHUB_TOKEN=...               # PR을 API로 만들 때. GitLab은 B_STUDIO_GITLAB_TOKEN, Gitea는 B_STUDIO_GITEA_TOKEN
export B_STUDIO_GIT_PROVIDER=gitlab            # 사내 호스트는 주소만으로 종류를 알 수 없으므로 지정 (github | gitlab | gitea)
export B_STUDIO_GIT_AUTHOR_NAME=... B_STUDIO_GIT_AUTHOR_EMAIL=...   # 저장소가 커밋 작성자를 검사할 때
```

푸시는 스튜디오 서버의 git 인증(SSH 에이전트, credential helper)을 그대로 씁니다. 토큰이 없으면 PR 작성 페이지 링크만 보여 줍니다. 설계 근거는 [ADR-020](docs/decisions.md#adr-020-원격-저장소-연동-세션-브랜치와-덮어쓰지-않는-푸시)에 있습니다.

로컬 로그인 계정 모드는 **사내 공유 서버에 배포하는 용도가 아닙니다.** Agent SDK 정책상 제3자 제품이 claude.ai 로그인을 제공할 수 없으므로, 스튜디오는 로그인 화면을 만들지 않고 이미 로그인된 본인 PC의 CLI만 사용합니다. 여러 사람이 쓰는 서버에서는 조직의 API 키로 기본(`api`) 모드를 쓰세요. 근거는 [ADR-019](docs/decisions.md#adr-019-로컬-로그인-계정으로-실행-api-키-없이-개인-pc에서만)에 있습니다.

실제 출력 (일부):

```
studio │ orders 샌드박스를 시작합니다 (studio-orders-9fbfc3)
web    │ 이미지를 빌드하고 시작합니다
api    │ 이미지를 빌드하고 시작합니다
web    │ 준비 확인: UND_ERR_SOCKET (컨테이너 running)
web    │ 준비 확인: HTTP 200 (컨테이너 running)
web    │ 준비 완료 → http://127.0.0.1:32768
api    │ ... Started ApiApplication in 2.402 seconds
api    │ 준비 확인: HTTP 200 (컨테이너 running)
api    │ 준비 완료 → http://127.0.0.1:32769

  web          browser  http://127.0.0.1:32768
  api          openapi  http://127.0.0.1:32769  계약: http://127.0.0.1:32769/v3/api-docs

studio │ Ctrl+C로 종료합니다
```

## 스튜디오 화면

`pnpm studio:demo`로 웹 스튜디오를 열면 프로젝트마다 샌드박스 세션을 시작할 수 있습니다. 왼쪽에는 샌드박스에서 실제로 돌고 있는 서비스가, 오른쪽에는 에이전트와의 대화가 보입니다.

| 영역 | 하는 일 |
|---|---|
| 화면 (web) | 샌드박스의 Next.js 앱을 iframe으로 보여 줍니다. 서비스가 재시작돼 포트가 바뀌어도 입력한 경로를 유지한 채 새 주소를 따라갑니다 |
| API (api) | 실행 중인 서버에서 추출한 OpenAPI로 엔드포인트와 스키마를 보여 주고, 스튜디오 서버를 거쳐 요청을 보냅니다 |
| 기록 | 검증을 통과한 요청마다 남은 체크포인트와 변경 내역을 보고, 이전 시점으로 되돌립니다 |
| 로그 | web, api, db 로그를 서비스별로 걸러 봅니다 |
| 대화 | 요청, 에이전트 답변, 도구 사용 기록, **검증 게이트** 결과가 순서대로 쌓입니다 |

![배송 메모 필드를 추가한 뒤 미리보기에 새 열이 보이고, 검증 게이트가 계약에 memo 필드가 추가됐다고 알려 주는 화면](docs/images/studio-memo-field.png)

![요청하지 않은 필드 삭제를 검증 게이트가 호환 깨짐으로 막은 화면](docs/images/studio-breaking-blocked.png)

위 화면은 체크포인트 기능을 넣기 전의 모습입니다. 게이트가 호환 깨짐을 막았는데도 변경이 남아 있어서 미리보기의 배송 메모가 비어 보였습니다. 지금은 **게이트를 통과하지 못한 변경을 자동으로 되돌리고, 바뀐 서비스를 이전 상태로 재시작합니다**([ADR-018](docs/decisions.md#adr-018-세션-체크포인트-검증을-통과한-변경만-남긴다)).

![검증을 통과한 요청마다 남은 체크포인트 목록과 변경 내역, 이전 시점으로 되돌리기 전에 한 번 더 확인받는 화면](docs/images/studio-checkpoint-restore.png)

> 데모 모드는 Claude API 대신 미리 적어 둔 스크립트로 실행합니다. 준비된 요청만 순서대로 실행하고, 다른 요청은 거절합니다.

## `studio.yaml`

실행 방법은 표준 `compose.yaml`에 두고, `studio.yaml`에는 스튜디오에만 필요한 정보만 적습니다.

```yaml
version: 1
name: orders

services:
  web:
    source: managed        # 스튜디오가 코드를 만들고 샌드박스에서 실행
    template: nextjs
    path: web
    port: 3000
    preview: browser       # iframe 미리보기
    ready: { path: /, timeoutSeconds: 300 }

  api:
    source: managed
    template: spring-boot
    path: api
    port: 8080
    preview: openapi       # API 탐색기
    ready: { path: /actuator/health/readiness, timeoutSeconds: 900 }
    contract: { extract: /v3/api-docs }   # 실행 중인 서버에서 OpenAPI 추출

  # 이미 운영 중인 API는 등록만 한다 (TOI 방식)
  # legacy-users:
  #   source: external
  #   baseUrl: https://users.internal.example.com
```

`loadProject()`는 명세만 검사하지 않고 **두 파일이 서로 맞는지도** 검증합니다. managed 서비스가 compose에 없거나, external 서비스가 compose에 들어 있으면 필드 경로와 함께 에러를 알려 줍니다.

## 검증 결과

로컬 환경(macOS, colima, Docker 27)에서 직접 실행해 확인한 내용입니다.

| 항목 | 결과 |
|---|---|
| 웹 `/` | HTTP 200 |
| 웹 `/api/ping` → Next rewrite → Spring | `{"message":"pong"}` |
| API readiness | `{"status":"UP"}` |
| OpenAPI 계약 추출 | `/v3/api-docs`에서 OpenAPI 3.1.0, `paths: ['/api/ping']` |
| 포트 공개 범위 | `127.0.0.1`의 빈 포트에만 공개 (같은 네트워크에서 접근 불가) |
| Ctrl+C 신호가 여러 번 들어올 때 | 정리가 끝까지 완료됨 (tsx와 node에 SIGINT를 동시에 보내 재현) |
| 종료 후 정리 | 컨테이너 0개, 샌드박스 볼륨 0개. 공유 캐시 볼륨(Gradle, pnpm)은 유지 |
| 두 번째 기동 | 늦어도 43초 안에 두 서비스 모두 준비 완료 |
| 단위 테스트 / 타입 체크 | 97개 통과 / 패키지 5개 통과 |

### 에이전트 루프 (`pnpm e2e:agent`, 실제 Docker 샌드박스)

모델 대신 **미리 적어 둔 턴을 돌려주는 스크립트 모델**로 실행했습니다. 이 검증은 도구, 파일 변경, 서비스 재시작, 준비 판정, 계약 비교, 피드백이 실제로 맞물리는지를 확인합니다. Claude가 코드를 얼마나 잘 쓰는지는 이 검증의 범위가 아닙니다.

| 시나리오 | 결과 |
|---|---|
| A. 주문 목록 API와 화면. **일부러 오타를 넣어 컴파일 에러** | 게이트 1차 **실패**(컴파일 에러 로그 전달) → 수정 → 2차 통과. 계약에 `GET /api/orders`, `OrderResponse` 추가. `/orders` 화면에 시드 데이터 렌더링 (4턴, 33.5초) |
| B. 배송 메모 필드 추가 (Flyway V2 + 엔티티 + 응답 + 화면) | 한 번에 통과. 계약 변경은 `OrderResponse.memo` 추가 하나. 화면에 메모 렌더링 (2턴, 14.0초) |
| C. 요청하지 않은 필드 삭제 | api는 정상 기동했지만 `OrderResponse.memo` 삭제를 **호환 깨짐으로 차단** (2턴, 10.0초) |

### 웹 스튜디오 (데모 모드, Playwright로 실제 브라우저 조작)

| 확인 항목 | 결과 |
|---|---|
| 세션 시작 → 준비 | 두 서비스 모두 10초 안에 준비 (의존성 캐시가 채워진 상태) |
| A. 주문 목록 | 게이트 실패(api 컴파일 에러 로그 포함) → 수정 → 통과, 미리보기 `/orders`에 주문 표 렌더링 |
| B. 배송 메모 | 게이트 통과, 계약에 `OrderResponse.memo` 추가, 미리보기에 배송 메모 열 렌더링 |
| C. 필드 삭제 | 게이트가 호환 깨짐으로 차단, "완료하지 못함" 표시 |
| API 탐색기 | `GET /api/orders` HTTP 200, 재시작 후 계약을 다시 불러와 스키마에 `memo` 반영 |
| 재시작 중 미리보기 | 포트가 32796에서 32799로 바뀐 뒤에도 입력한 경로 `/orders` 유지 |
| 미리보기 HMR | WebSocket 핸드셰이크 `101 Switching Protocols`, 준비 후 브라우저 콘솔 에러 0개 |
| 프록시 입력 검증 | `//` 경로 400, 허용하지 않은 메서드 400, 없는 서비스 404, 데모 순서 위반 409 |
| 세션 중지 | 컨테이너 0개, 볼륨 0개. 공유 캐시와 작업 복사본은 유지 |

### 세션 체크포인트 (데모 모드, 실제 브라우저 · Git · 샌드박스 확인)

| 확인 항목 | 결과 |
|---|---|
| 세션 시작 | `5c79494 세션 시작` 체크포인트 (파일 37개). 샌드박스가 만든 `node_modules` 등은 기록에 들어가지 않음 |
| A. 주문 목록 (게이트 1회 실패 후 통과) | `f6c3cb7` 커밋, 남은 변경 0개 |
| B. 배송 메모 | `668fb7d` 커밋, 미리보기에 배송 메모 표시 |
| C. 필드 삭제 (게이트 차단) | **새 커밋 없음.** `OrderController.java` 변경을 되돌리고 api 재시작 → 미리보기 배송 메모와 계약의 `memo` 유지 |
| "세션 시작"으로 되돌리기 | 9초. 주문 관련 파일 삭제, web·api 재시작, `/orders` 404, 계약은 `/api/ping`만 남음, 데모 다음 요청이 첫 요청으로 돌아감 |
| 사용자 전역 커밋 훅 | 모든 커밋을 거부하는 전역 훅이 있어도 체크포인트 커밋이 남음 (단위 테스트) |
| 다시 연결 | 새로고침해도 체크포인트 목록이 중복되지 않고 콘솔 에러 0개 (버그 수정 후) |

### 로컬 로그인 계정 모드 (실제 모델 · 실제 Docker · 실제 브라우저)

본인 PC의 `claude` CLI(2.1.267, Claude Max 구독)로 실행했습니다. 모델은 계정 기본값인 Claude Opus 5였습니다.

![로컬 로그인 계정 모드에서 두 번째 요청이 이전 대화를 이어받아 부제목을 넣고, 검증 게이트를 통과해 체크포인트로 저장된 모습](docs/images/studio-local-agent.png)

| 확인 항목 | 결과 |
|---|---|
| 사전 확인 | 프롬프트를 보내지 않고 약 4초 만에 로그인 확인. 화면과 로그에는 구독 종류만 남기고 이메일·조직은 남기지 않음 |
| CLI: `GET /api/time` 추가 | 6턴. 모델은 b-studio 도구(`list_files`, `get_contract`, `read_file`, `write_file`, `restart_service`, `http_request`)만 호출. 바뀐 파일은 `TimeController.java` 하나, 게이트 통과, 계약 변경은 `GET /api/time` 추가 하나. SDK 추정 토큰: 입력 949 · 출력 1,542 · 캐시 읽기 19,881 · 캐시 쓰기 5,318. 종료 후 컨테이너·볼륨 0개 |
| 스튜디오: 첫 화면에 제목 추가 | 5턴, web 재시작 후 게이트 통과, 체크포인트 `de7393d` |
| 스튜디오: "방금 추가한 제목" 아래 부제목 + 에이전트가 앞서 물어본 예시 제목 삭제 | 5턴, 이전 대화를 이어받아 두 가지를 모두 처리, 체크포인트 `80ce2d9`. 미리보기 HTML에 제목과 부제목이 있고 예시 제목은 없음 |
| 대화 이어받기 | 로컬 세션 파일 2개. 두 번째 파일에 첫 요청 기록이 들어 있고, 첫 파일에는 두 번째 요청이 없음 (실행마다 갈라서 이어받음) |
| 실행 환경 표시 | 헤더 "로컬 Claude Agent", 대화에 "로컬 Claude Agent (CLI 2.1.267)에서 claude-opus-5 모델로 실행합니다 (Claude Max 구독)" |
| 첫 화면 안내 문구 | 모드별 문구 표시. 검증 중 로컬 모드에도 "API 키가 있어야 합니다"가 남아 있던 것을 발견해 수정 |
| 브라우저 콘솔 | 에러 10개, 모두 web 재시작 전 포트로 미리보기 앱이 HMR을 다시 연결하려던 것. 스튜디오 코드의 에러는 0개 ([트러블슈팅 11](docs/troubleshooting.md#11-서비스를-재시작할-때마다-브라우저-콘솔에-hmr-연결-실패가-쌓임)) |

### 원격 저장소 연동 (데모 모드 · 실제 git 원격 · 실제 브라우저)

`examples/orders`를 Git 저장소로 만들고, 로컬에 띄운 Gitea 1.27.3을 `origin`으로 두고 확인했습니다. Gitea는 GitHub와 같은 모양의 PR API를 제공해서 실제 HTTP 호출과 PR 화면까지 확인할 수 있습니다.

![기록 탭에서 세션 브랜치를 올리고 PR을 만든 뒤, 원격 브랜치가 최신 체크포인트와 같다고 표시된 모습](docs/images/studio-remote-export.png)

| 확인 항목 | 결과 |
|---|---|
| 세션 시작 | 원본 `main`의 `d5e09aa`에서 `b-studio/orders-b7575d1f` 브랜치 생성, 23초 만에 준비. 체크포인트 목록은 "세션 시작 (main 브랜치)"에서 끝남 |
| 자격 증명 노출 | 원본 `origin` 주소에 토큰을 넣었지만 화면에는 `127.0.0.1:3300/dev/orders`만 표시. 세션 스냅샷 JSON과 스튜디오 서버 로그에서 토큰 문자열 0건 |
| 체크포인트 커밋 본문 | 시나리오 A에 게이트 결과(연산·스키마 추가), "검증 게이트 재시도: 1회", 에이전트 요약. 호환 깨짐으로 차단된 C는 커밋 없음 |
| 올리고 PR 만들기 | 1.7초. 원격 세션 브랜치가 `60f3c90`이 되고 PR #1 생성. 제목 "[b-studio] 주문 목록 API와 화면을 만들어줘 외 1건", 본문에 요청별 커밋·파일·검증 결과 |
| 되돌린 뒤 다시 올리기 | A로 되돌리자(13초) "원격 브랜치와 기록이 다릅니다" 안내. 올리기 0.6초, 원격 브랜치와 PR #1의 head가 `30f8bd4`로 바뀌고 PR은 열린 상태 유지 |
| 리뷰어가 같은 브랜치에 올린 뒤 올리기 | HTTP 409와 "덮어쓰지 않았습니다" 안내. 원격 브랜치는 리뷰어 커밋 `80a2123` 그대로 |
| 단위 테스트 | 실제 git으로 복제·올리기·lease 거부·origin 없는 원본·세션 이전 기록 거부, 가짜 서버로 GitHub·GitLab·Gitea PR API |

### 아직 검증하지 못한 것과 알려진 한계

- **API 키 경로의 실제 실행**: 실제 모델 실행은 로컬 로그인 계정 모드로만 확인했습니다. `AnthropicModelClient`로 API를 직접 호출하는 경로는 API 키가 없어서, 샌드박스를 띄우기 전에 안내 메시지를 내고 멈추는 것까지만 확인했습니다.
- **로컬 로그인 계정 모드는 개인 PC 전용**: 공유 서버 배포용이 아니며, 대화 기록이 로컬 CLI의 세션 파일(`~/.claude/projects/` 아래)에 남습니다. 로그인하지 않은 상태의 안내 문구는 가짜 SDK로만 확인했습니다.
- **CLI는 자동 되돌리기를 하지 않음**: 체크포인트는 스튜디오 세션의 작업 복사본에만 적용합니다. `studio agent`는 사용자 프로젝트 폴더를 직접 다루므로 `reset`을 실행하지 않습니다.
- **실제 GitHub·GitLab에서 PR 생성은 검증하지 않음**: 실제 서버로는 Gitea만 확인했습니다. GitHub·GitLab API는 요청 형태와 응답 처리를 가짜 서버 테스트로 확인했습니다.
- **리뷰어 커밋과 갈라졌을 때 해결 기능 없음**: 스튜디오는 덮어쓰지 않고 멈추며, 원격 커밋을 세션으로 가져오거나 리베이스하는 기능은 아직 없습니다.
- **모노레포 하위 폴더 프로젝트는 원격 연동이 꺼짐**: Git 저장소 루트에 있는 프로젝트만 세션 브랜치로 시작합니다.
- **세션은 서버 메모리에만 있음**: 스튜디오 서버를 재시작하면 세션 목록이 사라집니다. 띄워 둔 샌드박스는 종료 신호를 받을 때 정리합니다.
- **원격 미리보기**: 서비스 포트가 루프백에만 열려 있어, 다른 PC의 브라우저에서는 미리보기를 열 수 없습니다.

## 트러블슈팅

실행하면서 발견한 문제와 해결 과정은 [docs/troubleshooting.md](docs/troubleshooting.md)에 정리했습니다.

- **검증 게이트가 컴파일 에러가 있는 코드를 통과시킨 문제**: colima sshfs에서 디렉터리 목록과 파일 속성이 약 20초 늦게 반영되는 것을 실측으로 확인하고, 재시작 전 동기화 지점으로 해결
- **"//"로 시작하는 경로가 다른 호스트를 가리키는 문제**: 에이전트 도구, API 탐색기 프록시, `studio.yaml` 경로에서 origin 비교로 차단
- **미리보기 HMR 연결이 계속 실패한 문제**: Next.js 16의 개발용 요청 출처 제한을 문서로 확인하고 `allowedDevOrigins`로 해결
- **Ctrl+C 한 번에 신호가 여러 번 들어와 정리가 중간에 끊길 수 있는 문제**: `process.once` 대신 멱등한 정리 함수로 해결
- **Next dev 첫 요청 컴파일 때문에 준비 확인이 시간 초과되는 현상**: 기동 중 에러와 진짜 실패를 구분하는 판정 규칙으로 해결
- **캐시를 공유해도 두 번째 기동이 크게 빨라지지 않는 이유**: 샌드박스 전용 `node_modules` 볼륨이 원인이며, lockfile 해시 기반 스냅샷을 다음 과제로 정함
- **재시작할 때마다 콘솔에 HMR 연결 실패가 쌓이는 현상**: 에러의 origin을 확인해 스튜디오가 아니라 이전 포트에 남은 미리보기 앱의 재연결임을 확인

## 로드맵

- [x] **런타임 코어**: 프로젝트 명세, 샌드박스 추상화, 로컬 Docker 제공자, 템플릿 3종, CLI
- [x] **에이전트 루프**: "필드 하나 추가해줘" → Flyway 마이그레이션, 엔티티, API, 화면을 한 번에 수정 → 재시작 → OpenAPI 대조 검증 (스크립트 모델로 Docker 검증 완료, Claude API 실행 확인은 인증 정보 필요)
- [x] **웹 스튜디오**: 대화, 미리보기 iframe, API 탐색기, 로그 (데모 모드로 브라우저 검증 완료)
- [x] **세션 체크포인트와 되돌리기**: 게이트를 통과한 변경만 커밋하고, 실패한 변경은 되돌리고, 이전 시점으로 복원
- [x] **로컬 로그인 계정으로 실행**: API 키 없이 본인 PC의 `claude` CLI 계정으로 같은 게이트를 거쳐 실행 (CLI와 웹 스튜디오에서 실제 모델로 검증)
- [x] **원격 저장소 연동**: 세션 브랜치로 올리기, 덮어쓰지 않는 푸시, GitHub·GitLab·Gitea PR (Gitea로 브라우저 검증)
- [ ] **데이터**: 세션별 DB 브랜치, 운영 DB 접근 차단, 시크릿 주입
- [ ] **정책 프록시**: 사내 API 등록, 마스킹, 감사 로그, 서비스 단위 권한
- [ ] **격리 강화**: Kubernetes agent-sandbox + gVisor/Kata 제공자
- [ ] **기동 최적화**: lockfile 해시별로 의존성 설치가 끝난 스냅샷 재사용

## 기술 스택

| 영역 | 사용 기술 |
|---|---|
| 스튜디오 코어 | TypeScript, Node.js 22, pnpm workspace, zod 4, yaml, Vitest 5, tsx |
| AI | Claude Opus 5 (`claude-opus-5`), Anthropic TypeScript SDK 0.124 — adaptive thinking, 스트리밍, 프롬프트 캐시, strict 도구, server-side fallback |
| 로컬 실행 | Claude Agent SDK 0.3.267 — 프로세스 안 MCP 서버로 b-studio 도구 제공, 기본 도구·사용자 설정 비활성화, 스트리밍 입력, 세션 fork |
| 저장소 연동 | Git (clone, `--force-with-lease`), GitHub REST API, GitLab REST API, Gitea API |
| 웹 스튜디오 | Next.js 16 App Router, React 19, Tailwind CSS 4, Server-Sent Events, IBM Plex Sans KR |
| 샌드박스 | Docker Compose v2 (override 파일, external 볼륨, 루프백 포트 공개) |
| 템플릿 | Next.js 16.3, React 19, Tailwind 4 / Spring Boot 4.1, Java 25, Gradle 9, Flyway, springdoc-openapi 3.1 / FastAPI, Python 3.14, uv |
| 데이터 | PostgreSQL 17 |

## 참고 자료

- [AI가 만든 코드가 어드민이 되기까지 — 토스 테크](https://toss.tech/article/52885)
- [WebContainers 상용 라이선스](https://webcontainers.io/enterprise) · [Next.js Turbopack wasm 바인딩 이슈 #70522](https://github.com/vercel/next.js/issues/70522)
- [Sandpack/Nodebox FAQ](https://sandpack.codesandbox.io/docs/resources/faq)
- [Replit 개발/운영 DB 분리](https://docs.replit.com/features/data-and-storage/development-and-production)
- [Kubernetes agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
- [Vercel Sandbox](https://vercel.com/docs/sandbox)
