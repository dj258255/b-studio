# `studio.yaml` 설정

`studio.yaml`은 실행 자체를 새 DSL로 대체하지 않습니다. 컨테이너 구성은 `compose.yaml`, API 계약은 OpenAPI에 맡기고, b-studio에 필요한 작업 범위·미리보기·검증·보안 정책만 선언합니다.

## 최상위 구조

```yaml
version: 1
name: orders
compose: compose.yaml
services: {}
databases: {}
resources: {}
network: {}
secrets: {}
deploy: {}
workflow: {}
repository: {}
design: {}
```

| 필드 | 필수 | 설명 |
|---|---:|---|
| `version` | 예 | 현재 `1`만 지원 |
| `name` | 예 | 소문자로 시작하는 영문·숫자·하이픈 이름 |
| `compose` | 아니요 | compose 파일 경로, 기본 `compose.yaml` |
| `services` | 예 | managed 또는 external 서비스, 최소 1개 |
| `databases` | 아니요 | 체크포인트와 함께 저장할 PostgreSQL |
| `resources` | 아니요 | compose 서비스별 메모리·CPU 상한 |
| `network` | 아니요 | 기본 저장소 외 외부 HTTP(S) 허용 목록 |
| `secrets` | 아니요 | 서버에서 읽어 서비스에 주입할 시크릿 선언 |
| `deploy` | 아니요 | 운영 Dockerfile과 공개 포트 |
| `workflow` | 아니요 | 에이전트 작업 단계·도구·보호 경로·승인·릴리스 조건 |
| `repository` | 아니요 | 모노레포 하위 프로젝트 처리 |
| `design` | 아니요 | Figma 디자인 파일 URL(에이전트 도구·시각 비교 기준) |

## managed 서비스

b-studio가 코드를 읽고 바꾸며 샌드박스에서 실행하는 서비스입니다.

```yaml
services:
  api:
    source: managed
    template: spring-boot
    path: api
    port: 8080
    preview: openapi
    ready:
      path: /actuator/health/readiness
      expectStatus: 200
      timeoutSeconds: 900
    contract:
      extract: /v3/api-docs
```

| 필드 | 설명 |
|---|---|
| `template` | 에이전트가 참고할 템플릿 이름 |
| `path` | 프로젝트 루트 기준 서비스 폴더 |
| `port` | 컨테이너 내부 포트 |
| `preview` | `browser`, `openapi`, `logs` 중 하나 |
| `ready` | 재시작 후 준비 완료를 판정할 HTTP 요청 |
| `contract.extract` | 실행 중인 서비스에서 OpenAPI를 읽을 경로 |
| `snapshots` | 입력 파일 해시로 재사용할 compose 볼륨 |
| `systemPackages` | 생성 Dockerfile이 빌드 때 설치할 OS 패키지 |
| `includes` | 서비스 폴더 밖이지만 같은 빌드에 포함되는 경로(프로젝트 루트 기준) |

`ready.path`와 `contract.extract`는 `/`로 시작해야 하며 `//`로 시작할 수 없습니다.

### 시스템 패키지

샌드박스는 실행 중에는 egress 허용 목록 밖의 호스트(패키지 저장소 등)를 막으므로, 서비스 컨테이너 안에서 직접 돌리는 `apt-get install`은 항상 실패합니다(도그푸딩 마찰 113). 숏폼 변환에 ffmpeg가 필요한 것처럼 OS 패키지가 필요하면 서비스에 선언하세요.

```yaml
services:
  commerce:
    source: managed
    template: spring-boot
    path: commerce
    port: 8080
    preview: openapi
    systemPackages: [ffmpeg]
```

"생성 파일 다시 만들기"(ADR-101)나 세션 재시작이 생성 Dockerfile(Dockerfile.b-studio)의 `FROM` 줄 바로 뒤에 설치 명령을 넣습니다. `docker build`는 egress 허용 목록이 적용되는 샌드박스 네트워크가 아니라 호스트 Docker 데몬이 보는 네트워크로 돌기 때문에 빌드 때는 설치할 수 있습니다(런타임 격리는 그대로입니다). 이름은 영문 소문자·숫자로 시작하고 그 뒤로 영문 소문자·숫자·`.`·`+`·`-`만 받습니다(최대 20개). 베이스 이미지가 Debian·Ubuntu(apt) 또는 Alpine(apk) 계열이 아니면 그 자리에서 오류를 냅니다(ADR-137).

### 서비스 폴더 밖 경로 (`includes`)

Gradle 멀티 모듈처럼 서비스 폴더(`path`) 밖에 있지만 같은 빌드에 포함되는 경로가 있으면 선언하세요(도그푸딩 마찰 119). 예를 들어 `commerce/settings.gradle`이 `include(':media')`로 서비스 폴더 밖 형제 폴더(`../media`)를 서브모듈로 포함하면, `media/`의 변경도 commerce 서비스와 같이 재시작·게이트 재확인 대상이 되어야 합니다.

```yaml
services:
  commerce:
    source: managed
    template: spring-boot
    path: commerce
    port: 8080
    preview: openapi
    includes: [media]
```

폴더 열기 감지가 `settings.gradle(.kts)`의 `include`+`projectDir` 오버라이드, Maven `pom.xml`의 `<modules>`를 읽어 서비스 폴더 밖을 가리키는 서브모듈만 자동으로 채웁니다(폴더 안을 가리키면 이미 `path`로 잡히므로 넣지 않습니다). 감지가 놓친 경로는 직접 추가해도 됩니다. 두 서비스가 같은 경로를 선언하면(공유 라이브러리 폴더 등) 그 경로가 바뀌었을 때 둘 다 재시작 대상이 됩니다(ADR-139).

### 스냅샷

설치 결과나 빌드 도구 상태를 다른 세션의 출발점으로 재사용할 수 있습니다. 실제 전체 기동 시간이 줄어드는지 측정한 볼륨에만 사용하세요.

```yaml
snapshots:
  - volume: api-gradle-project
    key:
      - build.gradle
      - settings.gradle
      - gradle.properties
      - gradle/wrapper/gradle-wrapper.properties
```

## external 서비스

이미 운영 중인 API를 코드 생성 대상이 아닌 정책 프록시 대상으로 등록합니다.

```yaml
services:
  customers:
    source: external
    baseUrl: https://customers.internal.example.com
    preview: openapi
    contract:
      url: https://customers.internal.example.com/openapi.json
    policy:
      allow:
        - callers: [api, studio]
          methods: [GET]
          paths: [/api/customers/**]
      mask: [residentNumber, phone]
      maskPatterns: [email, card]
      auth:
        header: Authorization
        secret: CUSTOMERS_TOKEN
        prefix: "Bearer "
```

`allow`를 생략하면 모든 호출자에게 `GET`과 `HEAD`만 허용합니다. `*`는 경로 한 구간, `**`는 여러 구간과 일치합니다. `mask`는 JSON 필드 이름을, `maskPatterns`는 자유 텍스트 안의 전화번호·이메일·주민등록번호·카드번호 형태를 가립니다.

## 데이터베이스 체크포인트

```yaml
databases:
  db:
    engine: postgres
    database: app
    user: app
```

키는 `compose.yaml`의 서비스 이름과 같아야 합니다. 현재 PostgreSQL만 지원하며, 지정한 사용자는 복원 과정에서 데이터베이스를 다시 만들 권한이 있어야 합니다.

## 자원 한도

```yaml
resources:
  web: { memory: 1g, cpus: 2 }
  api: { memory: 1536m, cpus: 2 }
  db: { memory: 256m }
```

`memory`는 `512m`, `1.5g` 같은 Docker 표기를 사용합니다. `cpus`는 0보다 크고 64 이하여야 합니다.

## 외부 네트워크

샌드박스는 기본 패키지 저장소 외의 외부 통신을 차단합니다. 추가 호스트는 명시적으로 허용합니다.

```yaml
network:
  egress:
    - api.slack.com
    - "*.internal-mirror.example.com"
    - host: detectportal.firefox.com
      methods: [GET]
      paths: [/success.txt]
```

문자열 규칙은 해당 호스트의 HTTP(S)를 허용합니다. 객체 규칙은 평문 HTTP 요청의 메서드와 경로까지 제한합니다. IP 주소는 허용 목록에 쓸 수 없습니다.

## 시크릿

```yaml
secrets:
  PAYMENT_API_KEY:
    services: [api]
    description: 결제 대행사 테스트 키
  CUSTOMERS_TOKEN:
    services: []
    description: external API 인증 전용
```

값은 `studio.yaml`에 적지 않습니다. 서버의 같은 이름 환경 변수, `B_STUDIO_SECRET_<NAME>`, 또는 `B_STUDIO_SECRETS_FILE`이 가리키는 파일에서 읽습니다. external API 인증에만 쓰는 값은 `services`를 비워 edge에만 전달하세요.

## 운영 배포

```yaml
deploy:
  services:
    web: { dockerfile: Dockerfile, port: 8300 }
    api: { dockerfile: Dockerfile, port: 8301 }
```

Dockerfile은 compose `build.context` 기준 경로입니다. 포트를 생략하면 첫 배포 때 루프백의 빈 포트를 선택하고 이후 릴리스에서도 유지합니다.

`deploy` 절을 적지 않으면(로컬 폴더 모드 기본값) 개발 화면 실행 탭에서 "배포" 하위 탭 자체가 보이지 않습니다. 같은 PC의 Docker에만 배포하는 기능이라, 다른 호스트에 배포하는 프로젝트는 이 절을 적지 마세요.

## 내 환경 관찰

개발 화면 실행 탭의 "내 환경" 하위 탭은 **관찰 전용**입니다. b-studio가 띄운 샌드박스(로그·리소스 하위 탭)와는 별개로, 이 프로젝트 폴더에서 사용자가 `docker compose up`으로 직접 띄운 컨테이너와, studio.yaml이 선언한 포트에서 호스트가 직접 뜬 프로세스(`gradle bootRun`, `next dev` 등)를 찾아 보여줍니다. b-studio는 이 화면에서 아무것도 재시작·중지·삭제하지 않고, 검증 게이트·체크포인트와도 무관합니다.

**docker compose 프로젝트 자동 감지**: Compose가 컨테이너에 자동으로 붙이는 `com.docker.compose.project.working_dir` 레이블이 이 프로젝트 폴더(또는 그 하위 폴더)를 가리키는 컨테이너만 모읍니다. 설정할 것은 없습니다 — 같은 폴더에서 `docker compose up -d`를 실행하면 다음에 탭을 열 때 바로 보입니다.

**호스트 프로세스와 Actuator 로그**: studio.yaml의 managed 서비스가 선언한 포트에서 듣고 있는 프로세스를 PID·CPU·메모리와 함께 보여줍니다. 로그는 자동으로 가져올 수 없으므로, Spring Boot 앱이라면 Actuator의 `health`·`logfile` 엔드포인트를 열어 두면 됩니다.

```yaml
# application.yml (호스트에서 gradle bootRun으로 띄우는 Spring Boot 서비스)
management:
  endpoints:
    web:
      exposure:
        include: health,logfile
logging:
  file:
    name: logs/app.log
```

이 설정이 없으면 "내 환경" 탭이 포트·PID·리소스까지는 보여주되, 로그 자리에는 설정 방법을 안내하는 문구만 남깁니다.

## 팀 워크플로

모델 하네스가 Pi·Claude·API 중 무엇이든 같은 실행 기준을 적용합니다. 프롬프트 파일은 에이전트를 안내하지만, 아래 정책은 Tool Gateway가 다시 검사합니다.

```yaml
workflow:
  required: [plan, implement, run, browser_check, contract_check, test, review, checkpoint]
  tests:
    - { name: web-lint, service: web, command: [pnpm, lint] }
    - { name: api-unit, service: api, command: [./gradlew, test], maxAttempts: 2 }
  pageChecks:
    - { service: web, path: /orders, expectStatus: 200, expectText: 주문 목록 }
    - service: web
      path: /orders
      expectFromApi: { service: api, path: /api/orders, jsonPath: "$[0].customerName" }
    - { service: web, path: /dashboard, expectStatus: 200, expectAnyText: ["45000", "45,000"] }
    - { service: web, path: /, mode: browser, expectText: 주문, viewport: { width: 390, height: 844 }, noHorizontalScroll: true }
    - service: web
      path: /orders
      mode: browser
      steps:
        - { click: "[data-testid=refresh]" }
        - { fill: { selector: "#q", text: 김토스 } }
        - { press: Enter }
        - { waitFor: "text=김토스" }
      expectText: 김토스
    - service: web
      path: /orders
      mode: browser
      viewport: mobile
      maxLoadMs: 2500
      compare:
        reference: design/list.png
        maxDiffRatio: 0.15
        masks:
          - { x: 0, y: 240, width: 375, height: 120 }
  concurrencyChecks:
    - name: stock-race
      service: api
      method: POST
      path: /api/products/1/orders
      body: '{"qty":1}'
      headers: { content-type: application/json }
      concurrent: 10
      expect:
        successCount: { exactly: 1 }
        then: { method: GET, path: /api/products/1, jsonPath: "$.stock", equals: 0 }
  allowedTools: [list_files, read_file, write_file, edit_file, delete_file, run_in_service, restart_service, service_logs, service_stats, http_request, get_contract]
  deniedCommands: [npm publish, git push, terraform apply]
  requireApprovalFor: [restart_service]
  protectedPaths: [.env, .github/workflows, infra, migrations]
  maxChangedFiles: 20
  releaseRequires: [contract_check, test, review, checkpoint]
```

| 키 | 적용 방식 |
|---|---|
| `required` | 순서대로 확인할 단계. 이 중 `run`·`browser_check`·`contract_check`·`test`·`concurrency_check`·`review`는 게이트가 직접 실행해 판정하며, 통과 기록이 없으면 완료로 인정하지 않습니다. 생략하면 `plan → implement → run → contract_check → review → checkpoint`에 선언한 `pageChecks`·`tests`·`concurrencyChecks` 단계를 더합니다 |
| `tests` | `test` 단계에서 서비스 컨테이너 안에서 실행할 명령. 종료 코드 0이어야 통과하고, 실패 시 출력 끝 30줄(시크릿 가림)을 모델에게 돌려줍니다. 한 명령당 10분 제한 |
| `pageChecks` | `browser_check` 단계에서 재시작한 서비스의 화면을 확인합니다. `mode: http`(기본)는 응답 상태 코드와 본문 문구만 봅니다. `mode: browser`는 헤드리스 Chromium으로 렌더링하고 클라이언트 스크립트를 실행한 뒤 렌더링된 문구, 잡히지 않은 스크립트 예외, `console.error`, 실패한 요청(4xx·5xx·연결 실패, 브라우저가 스스로 여는 `/favicon.ico` 제외)을 실패로 봅니다. `viewport`로 창 크기를 정하고 `noHorizontalScroll: true`면 가로 넘침도 실패로 봅니다. `allowConsoleErrors: true`는 콘솔 오류와 실패한 요청을 허용합니다. `steps`는 `mode: browser`에서만 쓸 수 있고, 페이지를 연 뒤 순서대로 실행할 상호작용을 최대 10개까지 적습니다. 각 단계는 `click`(선택자 클릭)·`fill`(`{ selector, text }` 입력)·`press`(키 입력, 예: `Enter`)·`waitFor`(선택자 대기) 중 정확히 하나를 가지며, 임의 스크립트는 실행하지 않습니다. 단계가 실패하면 그 자리에서 멈추고 몇 번째 단계였는지 알립니다. `expectText`는 단계를 모두 마친 뒤의 화면을 봅니다. `expectAnyText`는 그중 **하나라도 있으면 통과**하는 문구 목록(1~5개)입니다(같은 값의 표기가 갈릴 때, 예: `45000`/`45,000`). `expectAllText`는 **모두 있어야 통과**하는 문구 목록(1~5개)이고, 실패하면 빠진 문구만 알립니다(한 화면에 여러 값이 함께 보여야 할 때, 예: 샘플 주문 세 건의 고객 이름). `compare`를 적으면 마지막 화면을 디자인 기준 이미지와 픽셀 차이 비율로 비교합니다(아래 '디자인 비교'). `maxLoadMs`를 적으면 워밍업 뒤 첫 이동의 `load`까지 걸린 시간이 예산(ms)을 넘을 때 실패합니다(재지 못해도 통과로 보지 않습니다). 로드 시간은 예산을 적은 확인만 재어 결과에 남깁니다(재려면 페이지를 한 번 더 열어야 하기 때문입니다). 브라우저 전용 옵션을 `http`에 쓰면 불러올 때 거부합니다. `expectFromApi`를 적으면 api를 먼저 불러 그 값이 화면 글자에 있는지 확인합니다(아래 'api 값 확인') |
| `concurrencyChecks` | `concurrency_check` 단계에서 같은 요청을 `concurrent`(2~20)개 동시에 보내 결과 불변식을 확인합니다. k6 같은 부하 도구 없이 서버에서 `Promise.all`로 보내고, 요청마다 타임아웃을 겁니다. **세션 서비스의 출처로만** 요청합니다. `expect`에는 `successCount`(`exactly`/`atMost`), `allStatusIn`(허용 상태 코드), `then`(동시 요청 뒤 `GET`으로 JSON 값을 확인: `jsonPath`는 `$.stock` 같은 단순 경로, `equals`는 숫자나 문자열) 중 최소 하나를 적습니다. 통과해도 성공 건수·상태 분포·`then` 값을 결과에 남기고, 실패하면 원인을 추정하지 않고 숫자만 돌려줍니다 |
| `autoPageChecks` | **이번 실행에서 바뀐 Next.js 페이지(와 바뀐 컴포넌트·유틸을 쓰는 페이지)를 게이트가 스스로 찾아 열어 봅니다**(선택, 기본 없음). `service`는 `source: managed`이면서 템플릿이 `nextjs`여야 합니다. 아래 '바뀐 페이지 자동 확인' |
| `allowedTools` · `deniedCommands` · `requireApprovalFor` | 도구 호출이 샌드박스에 닿기 전에 실행기가 막습니다. `allowedTools`를 적으면 **목록에 없는 도구는 모델에게 보이지도 않습니다.** 플랫폼이 상황에 따라 더하는 도구(되묻기 `ask_user`, 조율 게시판 `post_note`·`read_notes`, 디자인 `design_frames`·`design_frame`)도 쓰려면 목록에 넣어야 합니다 |
| `protectedPaths` | 쓰기 도구 호출을 막고, `review` 단계에서 전체 변경 파일을 한 번 더 확인합니다. `.env`처럼 점으로 시작하는 경로는 `.env.local` 같은 변형도 막습니다 |
| `maxChangedFiles` | `review` 단계에서 한 요청의 변경 파일 수 상한을 확인합니다 |
| `maxTurns` | 한 요청 안에서 모델이 쓸 수 있는 턴(모델 호출) 상한(1~300). 생략하면 각 실행기의 기본값(60)을 그대로 씁니다. 요청 옵션(`maxTurns`)이 있으면 이 값보다 우선합니다. 아래 '턴 상한' |
| `releaseRequires` | 배포할 체크포인트의 `Workflow-Passed` 트레일러에 있어야 하는 단계. 스튜디오 밖에서 바꾼 체크포인트처럼 기록이 없으면 `checkpoint` 외 조건을 채우지 못해 배포가 거부됩니다. 생략하면 `[checkpoint]`로 모든 체크포인트를 배포할 수 있습니다 |

불러올 때 검사하는 규칙:

- `required`에 `test`가 있으면 `tests`가, `browser_check`가 있으면 `pageChecks`가, `concurrency_check`가 있으면 `concurrencyChecks`가 최소 하나 있어야 합니다. 실행할 수단이 없는 필수 단계는 통과처럼 보이기만 하기 때문입니다.
- `tests`·`pageChecks`·`concurrencyChecks`의 `service`는 `source: managed` 서비스여야 합니다. `pageChecks.expectFromApi.service`(값을 꺼낼 api)도 마찬가지입니다.
- `autoPageChecks.service`는 `source: managed`이면서 템플릿이 `nextjs`인 서비스여야 합니다(열어 볼 경로를 app 라우터 구조에서 찾습니다).
- 테스트·동시 요청 확인 이름은 중복될 수 없습니다.
- `concurrencyChecks.headers`는 5개까지이고, JSON 본문(`body`)은 8KB 이하입니다. `Authorization`·`Cookie` 같은 인증 헤더는 비밀 값을 담으므로 거부합니다(studio.yaml은 저장소에 커밋됩니다). 인증이 필요하면 서비스가 `secrets`의 환경 변수를 읽게 하세요.

### 가볍게 확인 (요청 옵션 `verify`)

대화 입력창의 **"가볍게 확인"** 스위치는 요청마다 `verify: light`를 보냅니다(기본 `full`). `full`은 지금과 한 글자도 다르지 않고, `light`는 게이트가 **서비스 재시작·준비 판정·계약 비교(`run`·`contract_check`)만** 실행하고 `test`·`browser_check`·`concurrency_check`·`review`는 건너뜁니다. `workflow.required` 대조는 건너뛴 단계를 "건너뜀"으로만 기록하고 실패로 보지 않습니다.

- **체크포인트 표기**: `full`은 통과한 단계를 `Workflow-Passed` 트레일러로 남깁니다. `light`는 실제로 통과한 단계만 적고 `Workflow-Verify: light`를 더합니다. 다시 켜서 읽어도 같은 값입니다.
- **배포는 자연히 막힙니다**: `releaseRequires`는 건너뛴 단계를 채우지 못하므로, `light` 체크포인트는 `test`·`review` 같은 조건이 있으면 배포가 거부됩니다. 배포 화면은 "가볍게 확인한 체크포인트는 전체 검증 뒤 배포할 수 있습니다"라고 안내합니다. 전체 검증(`full`)을 한 번 더 통과해 새 체크포인트를 만들면 배포할 수 있습니다.
- **쓰이는 곳**: 사람이 보낸 단일 세션 요청과 벤치(`--verify light`, [#182](https://github.com/dj258255/b-studio/pull/182))에서 쓰입니다. 작업 분해 레인·Fleet·CLI 경로는 `full` 그대로입니다.
- **효과는 시간이지 토큰이 아닙니다**: E5([보고서](experiments/2026-09-29-e5-light-verify.md))에서 종단 시간은 15%, 게이트 시간은 53% 줄었지만 토큰은 줄지 않았습니다. 건너뛰는 단계는 b-studio 코드가 실행하고 모델을 부르지 않기 때문입니다. 작은 과제 3개 × 3회에서 잰 결과이며, 큰 변경이나 계약이 얽힌 작업에서는 `full`로 확인하세요.

### 턴 상한 (`workflow.maxTurns`·요청 옵션 `maxTurns`)

한 요청 안에서 모델이 쓸 수 있는 턴(모델 호출) 상한입니다(ADR-131). 생략하면 모든 실행기(API 루프, Claude Code, Codex, Command Code, OpenCode, Gemini)가 기본값 60을 그대로 씁니다.

- **studio.yaml**: `workflow.maxTurns`(1~300 정수). 복잡한 요청이 많은 프로젝트는 올리고, 빠른 피드백이 중요한 프로젝트는 낮출 수 있습니다.
- **요청 옵션**: `POST /api/sessions/[id]/messages`의 `maxTurns` 필드(1~300 정수)가 studio.yaml보다 우선합니다. 둘 다 생략하면 각 실행기의 기본값(60)입니다.
- **턴 상한에 걸리면**: 바로 실패로 끝내지 않고, 지금까지의 변경이 검증 게이트를 통과하는지 한 번 더 봅니다. 통과하면 체크포인트로 남기고("턴 상한에 걸렸지만 지금까지의 변경이 게이트를 통과해 체크포인트로 남깁니다" — 요청의 일부만 끝났을 수 있습니다), 통과하지 못하면 실패로 끝내 아래 '실행 실패·중단으로 되돌릴 때'와 같은 경로를 탑니다. 턴 상한이 아닌 다른 실패 사유(모델 오류·사용자 중지)에는 이 재확인을 하지 않습니다.

### 실행 실패·중단으로 되돌릴 때

실행이 턴 상한·모델 오류·네트워크 끊김·게이트 실패 뒤 포기·사용자 중지로 끝나 작업 트리를 되돌리면(ADR-099·ADR-131), 그 실행이 바꾼 파일을 조용히 버리지 않습니다.

- **보관**: 되돌리기 전에 바뀐 파일을 백업합니다. 대화에 "검증을 통과하지 못한 변경을 되돌렸습니다: 파일 N개"와 함께 되돌린 변경을 볼 수 있는 보기, 백업이 있으면 **되살리기** 버튼이 남습니다.
- **되살리기**: 되살리면 작업 트리로 그대로 돌아오지만 체크포인트가 아니라 **미검증 상태**입니다(아직 git에 커밋되지 않은 pending 변경). 다음 요청이 그 변경 위에서 이어서 작업하고 검증 게이트를 통과해야 비로소 체크포인트로 남습니다.
- **데이터베이스**: `databases`를 선언한 프로젝트는 파일과 함께 데이터베이스도 마지막 체크포인트 시점으로 되돌립니다(파일만 되돌리면 이미 적용된 마이그레이션이 DB에 남아 서비스가 기동하지 못합니다). 되살린 백업의 DB는 되돌리지 않고, 다음 요청의 검증 게이트가 서비스를 다시 띄울 때 마이그레이션을 다시 적용하게 둡니다.
- **지금 체크포인트로 되돌리기**: 체크포인트 기록 화면의 "되돌리기"는 지금(head) 체크포인트를 가리켜도 거부하지 않습니다. 파일은 움직일 게 없지만, 데이터베이스가 그 체크포인트 이후 어긋났을 수 있어(위 상황이 드물게 새나갔을 때) **데이터베이스만 다시 맞추는** 안전한 경로로 씁니다. 데이터베이스를 선언하지 않은 프로젝트는 지금 체크포인트를 가리키면 정말 할 일이 없어 그대로 거부합니다.

### 자가 확인 범위 (`B_STUDIO_SELF_CHECK`)

기본은 `lean`입니다(ADR-064). 에이전트가 게이트가 어차피 하는 확인을 되풀이하지 않게 합니다. `B_STUDIO_SELF_CHECK=full`이면 이전 동작(한 글자도 다르지 않음)입니다. 모르는 값은 조용히 떨어뜨리지 않고 설정 오류로 알립니다.

- **프롬프트**: `run_in_service`는 필요한 명령만 돌리고 전체 빌드·테스트를 확인용으로 돌리지 말라고, `restart_service`·`http_request`는 무엇을 쓸지 정하려고 동작을 볼 때만 쓰고 끝난 변경을 확인하는 데 쓰지 말라고 안내합니다. 턴을 끝내면 게이트가 재시작·준비·계약과 워크플로의 확인을 돌려 실패를 돌려준다는 설명은 같습니다.
- **명령 출력**: 성공한(종료 코드 0) `run_in_service` 출력은 800자(`LEAN_SUCCESS_OUTPUT_BUDGET`)만 돌려줍니다. 실패한 명령은 원인을 봐야 하므로 기본 예산(6,000자) 그대로입니다.
- **왜**: E6([보고서](experiments/2026-09-30-e6-token-breakdown.md))에서 b-studio의 모델 호출은 그냥 Claude Code의 3.4배였고, 문맥 합의 61%가 도구 결과를 다시 읽은 양, 그중 `run_in_service`가 32.7%였습니다. 고정 문맥(시스템 프롬프트·도구 설명)은 오히려 b-studio가 작았습니다.
- **쓰이는 곳**: 모든 러너(API 루프, Claude Code, Codex, Command Code, OpenCode)와 모든 세션(일반·레인·통합·Fleet). 벤치는 앞선 실험과 비교하려고 기본이 `full`이고, `--self-check lean`으로 켭니다.
- **효과**: E7([보고서](experiments/2026-09-30-e7-lean-self-check.md))에서 성공 9/9 대 9/9, 게이트 실패 0건 대 0건, 성공 1건당 토큰 −41.4%(짝지은 비교 p = 0.164), `run_in_service` 재읽기 −77%였습니다.
- **한계**: 레인 게이트 시간은 +64%(에이전트가 하지 않은 재시작을 게이트가 맡음). 작은 과제 3개 × 9회에서 잰 결과이고, 과제가 커지면 게이트 재시도가 늘 수 있습니다. 그때는 `full`로 되돌리세요.

### 로컬 CLI 러너의 대화 압축 기준 (`B_STUDIO_CLAUDE_CODE_COMPACT_WINDOW`)

로컬 CLI 러너는 요청마다 이전 대화를 이어받으므로 기준이 없으면 대화가 모델 창 끝까지 자랍니다. 이어받은 대화가 이 크기(토큰)에 닿으면 SDK가 앞부분을 요약하게 합니다(ADR-151). 서버 환경 변수로 정합니다.

| 값 | 동작 |
|---|---|
| 비움 | 기본값 200,000 토큰 |
| 숫자(50,000 이상 정수) | 그 토큰 수 |
| `0` 또는 `off` | 넘기지 않음 — SDK 기본 동작(이전과 같음) |
| 그 밖(숫자가 아니거나 50,000 미만) | 기본값을 쓰고, 무시한 값을 실행 시작에 경고로 알림 |

프로세스 환경에 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`를 직접 줬다면 그 값이 먼저이고 덮어쓰지 않습니다. 압축이 일어나면 대화에 "대화가 길어져 앞부분을 요약했습니다 · 전 → 후 토큰" 한 줄이 남습니다.

### 바뀐 페이지 자동 확인 (`autoPageChecks`)

E1~E4 내내 반복된 원인 하나: 게이트의 화면 확인은 `pageChecks`에 적어 둔 페이지만 열어서, **이번 실행이 새로 만든 페이지가 500을 내도 게이트는 통과**했습니다(E2의 order-summary). `autoPageChecks`를 켜면 게이트가 이번 실행에서 바뀐 파일에서 Next.js 페이지를 찾아 스스로 열어 봅니다.

```yaml
workflow:
  autoPageChecks:
    service: web            # 필수. source: managed이고 템플릿이 nextjs인 서비스
    mode: http              # http(기본) | browser
    expectStatus: 200       # 기본 200
    maxPages: 5             # 1~10, 기본 5
    # 동적 세그먼트 [id]에 넣을 값. 값이 없는 세그먼트가 있는 라우트는 건너뜁니다. 실행 중에 고쳐도 같은 실행에서 바로 반영됩니다
    sampleParams: { id: "1" }
    # browser 모드에서만
    viewport: { width: 390, height: 844 }
    # 바뀐 컴포넌트·유틸·layout을 import하는 page도 엽니다(기본 켬). false면 바뀐 page 파일만 봅니다
    followImports: true
```

**찾는 규칙** (서비스 폴더 기준)

- `app/**/page.tsx|jsx|ts|js|mdx`와 `src/app/**/page.*`를 찾습니다.
- 라우트 그룹 `(marketing)`은 주소에서 빼고, 동적 세그먼트 `[id]`는 `sampleParams` 값으로 채워 엽니다(`encodeURIComponent`).
- 같은 경로를 만드는 파일이 여럿이면 하나만 열고, 경로 순으로 정렬해 `maxPages`까지만 엽니다.
- `pageChecks`에 **이미 선언한 `service`+`path`는 두 번 열지 않습니다**(건너뜀 check로 남습니다).
- **바뀐 파일이 page가 아니어도 찾습니다**(`followImports`, 기본 켬, ADR-154). `components/OrderSummary.tsx`나 `lib/format.ts`처럼 page가 아닌 소스(ts·tsx·js·jsx·mjs·mdx)가 바뀌면, 서비스 폴더의 소스를 읽어 import를 거꾸로 따라가 그 파일을 (직접 또는 몇 단계 거쳐) 쓰는 page를 엽니다. check 이름에 `web /orders/1 (자동, id 추정 · OrderSummary.tsx 변경)`처럼 어떤 파일의 변경 때문에 열었는지 붙습니다.
  - import는 상대 경로, 서비스 `tsconfig.json`/`jsconfig.json`의 `paths`·`baseUrl`(못 읽으면 `@/`를 서비스 루트와 `src/`로 시도), 재수출, 정적·동적 `import('…')`를 따라갑니다. 주석·문자열 안의 가짜 import는 무시하고, `node_modules`·`.next`·빌드 산출물과 테스트·스토리 파일은 읽지 않으며, 서비스 폴더 밖으로 나가는 경로는 따라가지 않습니다.
  - `layout`·`template`·`loading`·`error`·`not-found`가 바뀌면(또는 바뀐 파일이 그 파일에 닿으면) 그 폴더 아래의 모든 page가 후보입니다.
  - 고르는 순서: 바뀐 page 자체 → 바뀐 파일을 직접 import하는 page → 거리가 먼 page. `maxPages`를 넘으면 가까운 것부터 열고, 못 연 경로는 건너뜀 check에 적습니다.
  - 상한: 역추적 깊이 5단계, 읽는 소스 800개, 훑는 폴더 400개, 전체 10초. 넘으면 거기까지 만든 그래프로 계속하고 이유(읽은 파일 수·걸린 시간 포함)를 건너뜀 check로 남깁니다.
  - 한계: 정규식 기반 근사라 변수로 만든 동적 import·번들러 전용 별칭은 따라가지 못하고, css·json import와 `pages/` 라우터는 보지 않습니다.

**실행 중에 바뀐 값** (ADR-160): `autoPageChecks.sampleParams`와 `autoPageChecks.sampleIdFrom`은 **같은 실행에서 바로 반영됩니다.** 실패 사유가 "실제 값을 알려 달라"고 안내하면 `studio.yaml`에 넣은 직후 다음 검증이 그 값으로 엽니다(새 키는 채우고 같은 키는 새 값으로 바꿉니다). 어느 화면을 여는지는 바뀐 파일이 정하고 이 값은 어떤 id로 여는지만 정하므로 확인이 줄지 않기 때문입니다. `sampleIdFrom.service`는 관리형 서비스여야 하고, 반영한 값은 `web studio.yaml (자동, 건너뜀)` check에 적힙니다. `sampleParams`로 연 화면은 추정한 id가 아니므로 `expectStatus`대로 엄격하게 판정합니다. **그 밖의 설정**(`service`, `mode`, `maxPages`, `followImports`, `dynamicRouteProbe`, `expectStatus`, 선언한 `pageChecks`·`tests` 등)은 실행을 시작할 때의 값으로 고정되어 다음 요청부터 적용됩니다. `studio.yaml`을 다시 읽지 못하면(형식 오류 등) 시작 때의 값으로 계속하고 그 사실이 같은 check에 남습니다.

**건너뛰는 경우** (조용히 사라지지 않고 `ok`인 check로 이유가 남습니다)

| 대상 | 이유 |
|---|---|
| `[...slug]`·`[[...slug]]` | catch-all은 열어 볼 값을 정할 수 없습니다 |
| `@modal`(병렬 라우트) | 같은 주소를 여러 파일이 나눠 그려 경로를 하나로 정할 수 없습니다 |
| `(.)`·`(..)`(인터셉트 라우트) | 화면 주소가 아닙니다 |
| `sampleParams`에 값이 없는 `[id]` | `동적 세그먼트 'id'의 값이 없습니다 — autoPageChecks.sampleParams에 넣으세요` |
| `maxPages`를 넘은 페이지 | 상한(N개)을 넘었습니다 |
| import 역추적 중 상한에 걸린 경우 | 깊이(5단계)·파일 수·폴더 수·시간 상한에서 멈췄고, 그 너머의 페이지는 확인하지 못했습니다 |
| `maxPages`를 넘은 import 역추적 후보 | 바뀐 파일마다 한 줄로 묶어 못 연 경로를 적습니다 |

**무엇을 확인하나**

- `expectStatus`(기본 200)와, `mode: browser`면 렌더링 뒤 문구·스크립트 예외·`console.error`·실패한 요청까지 `pageChecks`와 같은 규칙으로 봅니다.
- 자동으로 연 페이지에만 **Next.js 오류 화면 표지**를 추가로 봅니다. 상태 코드가 200이어도 본문에 아래 문구가 있으면 실패입니다.
  - `Application error: a server-side exception has occurred` (서버 컴포넌트 예외)
  - `Unhandled Runtime Error` (클라이언트 예외, 개발 오버레이)
  - `This page could not be found` (Next.js 404 화면. `expectStatus: 404`일 때는 실패로 보지 않습니다)
- 실패하면 `자동 페이지 /orders: HTTP 500 (기대 200)`처럼 경로를 앞에 붙입니다. 그래서 실패 서명이 선언한 `pageChecks`의 실패와 갈리고, 조율(S5) 게시판에서도 어느 페이지였는지 보입니다.

**한계**

- **작업 분해의 레인 게이트에서 켜면 통과하기 어렵습니다.** 레인은 자기 샌드박스만 보므로, web 레인이 자기 샌드박스에 없는 api를 부르는 페이지를 열면 실패합니다(전체 스택은 통합 게이트에만 있습니다). 전체 스택이 있는 **일반 세션과 통합 게이트용**입니다.
- `page` 파일만 봅니다. 같은 폴더의 `layout`·`loading`·`error`만 바뀐 경우는 열지 않습니다(그 폴더에 페이지가 있는지 작업 공간에서 싸게 알 방법이 없고, 그런 변경은 대개 `page`도 함께 바뀝니다).
- `app` 라우터만 봅니다. `pages` 라우터는 다루지 않습니다.
- **예제 `examples/orders`에는 켜지 않았습니다.** E1~E4와 같은 조건에서 비교할 수 없게 되기 때문입니다.

### api 값 확인 (`expectFromApi`)

`pageChecks` 항목에 `expectFromApi`를 적으면, 게이트가 **api를 먼저 불러** `jsonPath` 값(문자열·숫자)을 꺼내고, 그 값이 화면 글자에 있는지 확인합니다. 화면이 다른 필드 이름·모양을 읽고 있는 불일치를, 사람이 값을 미리 적지 않고도 잡습니다(E2에서 레인 경계의 필드 이름 불일치가 통합 게이트를 그대로 통과한 것을 보강, [#124](https://github.com/dj258255/b-studio/issues/124)).

**필드 이름을 정한 계약이 있을 때 씁니다.** 요구가 필드 이름을 정하지 않아 api와 화면이 일관되게 다른 이름을 써도 정상인 경우에는, `expectText`·`expectAnyText`로 화면에 보이는 샘플 값을 확인하는 편이 맞습니다(`expectFromApi`는 그 이름의 값이 없으면 실패합니다).

```yaml
pageChecks:
  - service: web
    path: /orders
    expectFromApi: { service: api, path: /api/orders, jsonPath: "$[0].customerName" }
```

- `service`(필수) — 값을 꺼낼 api 서비스. 모호함을 없애려고 생략을 두지 않습니다. `source: managed` 서비스여야 합니다.
- `path`(필수) — 그 api의 경로(페이지 경로가 아님). `ready.path`와 같은 규칙으로 `//host`를 거부합니다.
- `jsonPath`(필수) — 응답 JSON에서 꺼낼 값. **`$.a.b`와 `$[0].a`, `$.items[0].qty` 정도만** 지원합니다(필터·와일드카드·함수 없음).
- `mode`의 `http`·`browser` **둘 다**에서 씁니다. `http`는 응답 본문에서, `browser`는 렌더링된 글자에서 값을 찾습니다(`expectText`를 보는 같은 위치).

게이트는 이 순서로 확인합니다: ① api 호출 → ② 값 꺼내기 → ③ 페이지 열기 → ④ 값 포함 확인. ②까지 실패하면 페이지를 열지 않습니다. 실패 문구는 에이전트가 그대로 보고 고칠 수 있게 구체적으로 남깁니다.

- api가 2xx가 아님: `api GET /api/orders가 HTTP 500을 돌려줬습니다`
- 응답에 값이 없음: `api 응답에 $[0].customerName이 없습니다. 응답 앞부분: {…}`
- 값이 객체·배열·빈 문자열(확인 설정 오류): `$[0].statusCounts는 배열입니다. 화면에 그려질 문자열·숫자 값을 가리키세요`
- 화면에 없음: `api의 $[0].customerName 값 '홍길동'이 /orders 화면에 없습니다 — 화면이 다른 필드 이름을 읽고 있을 수 있습니다`

숫자는 원문과 천 단위 구분 표기(`12,000`)를 둘 다 인정합니다. 실패는 `browser_check` 단계 실패로 기록되고, 실패 서명도 확인 종류(api 상태·화면에 없음 등)별로 구분됩니다.

한계:

- **값 하나만 봅니다.** `jsonPath`가 가리키는 값 하나만 확인하므로, 목록의 다른 항목이나 다른 필드가 어긋나는 것은 잡지 못합니다.
- **`jsonPath` 범위가 좁습니다.** 필터·와일드카드·함수는 없습니다. 정확한 경로를 적어야 합니다.
- **캐시된 화면은 잡지 못합니다.** 확인은 지금 요청의 응답/렌더링만 봅니다. 페이지나 api가 캐시·CDN에 오래 남아 있으면 확인 시점의 결과를 봅니다.

### 디자인 비교 (`compare`)

`mode: browser` 화면 확인에 `compare`를 적으면, 마지막 단계 뒤의 **뷰포트 화면**을 디자인 기준 이미지와 픽셀 단위로 비교합니다. 운영자가 Figma 등에서 뽑은 기준 이미지를 프로젝트 안에 `.png`로 두고, `reference`에 프로젝트 루트 기준 상대 경로로 적습니다(추출은 제품 밖의 일입니다).

```yaml
pageChecks:
  - service: web
    path: /orders
    mode: browser
    viewport: mobile
    compare:
      reference: design/list.png
      maxDiffRatio: 0.15
      masks:
        - { x: 0, y: 240, width: 375, height: 120 }   # 항상 달라지는 동적 영역
      threshold: 0.1
```

| 키 | 설명 |
|---|---|
| `reference` | 프로젝트 안의 `.png` 상대 경로. `..`이나 절대 경로는 거부합니다 |
| `maxDiffRatio` | 허용하는 최대 차이 비율(0~1). 넘으면 확인 실패입니다 |
| `masks` | 비교에서 빼는 사각형(픽셀, 최대 20개). 두 이미지 모두 같은 색으로 칠해 동적 데이터·시각 요소를 가립니다 |
| `threshold` | pixelmatch의 색 차이 민감도(0~1, 기본 0.1). 클수록 관대합니다 |

- 기준 이미지와 실제 화면의 **너비가 다르면 자동으로 맞추지 않고 실패**합니다(뷰포트를 디자인 프레임 너비에 맞추라는 안내). 높이가 다르면 겹치는 위쪽만 비교합니다.
- 기준 이미지가 없거나 읽지 못하면 건너뛰지 않고 확인 실패로 처리합니다("검사 안 함"이 통과로 보이지 않게).
- 실패하면 `디자인 차이 12.4% (허용 10.0%, 비교 375×812)` 형태로 알리고, 디자인·실제·차이 이미지를 세션 산출물로 남겨 QA 보기에서 나란히 볼 수 있습니다.

`studio workflow <프로젝트>`로 실제로 강제할 단계와 검사를 확인할 수 있습니다.

`mode: browser`는 스튜디오 서버가 도는 호스트에서 Chromium을 띄웁니다. Playwright가 내려받은 Chromium을 먼저 쓰고, 없으면 설치된 Chrome을 쓰며, `B_STUDIO_BROWSER_EXECUTABLE`로 실행 파일을 지정할 수 있습니다. 어느 것도 없으면 검사는 통과가 아니라 실패로 끝납니다. 스튜디오를 브라우저가 없는 컨테이너 이미지로 운영한다면 `http` 모드를 쓰거나 이미지에 Chromium을 넣어야 합니다.

## 디자인 (Figma)

Figma 파일 URL을 두면 에이전트가 `design_frames`·`design_frame` 도구로 프레임 목록과 구조·스타일 요약을 볼 수 있고, 화면의 "디자인" 패널에서 고른 프레임을 PNG로 가져와 시각 비교(`pageChecks.compare`)의 기준 이미지로 쓸 수 있습니다.

```yaml
design:
  figma:
    fileUrl: https://www.figma.com/design/<파일 키>/<이름>
```

| 필드 | 설명 |
|---|---|
| `figma.fileUrl` | `https://www.figma.com/design/<key>/...` 또는 `/file/<key>/...`. 파일 키는 여기서 뽑아 검증하고, 형식이 아니면 불러올 때 거부합니다 |

- 토큰은 `studio.yaml`이 아니라 **서버 환경 변수 `FIGMA_TOKEN`**에서만 읽습니다. 값은 로그·오류·화면·모델 어디에도 넣지 않습니다.
- 스튜디오는 `studio.yaml`을 고치지 않습니다. 화면의 "디자인" 패널에서 **세션 단위로** URL을 저장할 수 있고(세션 설정이 `studio.yaml`보다 우선), 팀과 공유하려면 패널이 보여 주는 줄을 사람이 커밋합니다.
- `.fig` 파일은 Figma에 한 번 Import해야 파일 키가 생깁니다.
- 토큰 발급 방법과 운영 주의는 [운영 문서](operations.md)의 "Figma 연동"을 보세요.

## 계획-실행 분리 (ADR-075)

```yaml
models:
  plan: opus
  execute: sonnet
```

| 필드 | 설명 |
|---|---|
| `models.plan` | 계획을 쓰는 모델. claude-code 백엔드는 Claude Code에 넘기는 모델 이름(예: `opus`), api 백엔드는 모델 레지스트리 id입니다 |
| `models.execute` | 실행을 맡는 모델(뜻은 `plan`과 같은 규칙). 생략하면 세션이 원래 쓰던 모델을 그대로 씁니다 |

절 자체를 생략하거나 두 필드를 모두 비우면 환경 변수(`B_STUDIO_PLAN_MODEL`·`B_STUDIO_EXECUTE_MODEL`)를 보고, 그것도 없으면 계획 호출 없이 지금과 같이 실행만 합니다. 이 절이 있으면 환경 변수보다 우선합니다. 자세한 동작은 [운영 문서](operations.md)의 "계획-실행 분리"를 보세요.

## 체크포인트 커밋 제목 (ADR-080)

```yaml
checkpoints:
  conventionalCommits: false
```

| 필드 | 설명 |
|---|---|
| `checkpoints.conventionalCommits` | 기본 `true`. 체크포인트 커밋 제목을 요청 글과 바뀐 파일에서 conventional commit 형식(`feat`/`fix`/`test`/`docs`/`refactor`/`chore` 접두어 + 72자 이내 한국어 요약)으로 만듭니다. `false`로 끄면 예전처럼 `요청: <요청 글>` 형식을 그대로 씁니다 |

사내 저장소가 이미 다른 커밋 메시지 규칙을 강제한다면 꺼서 기존 형식을 유지할 수 있습니다. "제출 준비" 탭(개발 화면)이 이 제목 규칙을 포함해 커밋 기록·요구사항·테스트·README·시드·비밀 값을 점검합니다.

## 폴더 열기가 만드는 workflow.tests (ADR-133)

폴더 열기(ADR-067)가 서비스를 감지할 때, 서비스 폴더에서 테스트 명령도 함께 찾아 생성 `studio.yaml`의 `workflow.tests`에 기본으로 넣습니다. 넣을지 말지는 템플릿마다 다릅니다:

| 템플릿 | 찾는 조건 | 만드는 명령 |
|---|---|---|
| Spring Boot(Gradle) | 항상 | 래퍼가 서비스 폴더 자신에 있으면 `./gradlew test --no-daemon --console=plain --project-cache-dir /tmp/gradle-test-cache`(`maxAttempts: 2`). 래퍼가 저장소 루트 같은 상위 폴더에 있으면(실제 저장소에서 흔한 구조, ADR-128) 그 폴더로 `cd`한 뒤 `-p`로 서비스 폴더를 가리킵니다. 래퍼가 전혀 없으면 이미지에 든 `gradle` 도구를 씁니다 |
| Spring Boot(Maven) | 항상 | 같은 래퍼 경로 규칙으로 `./mvnw test`(상위 래퍼면 `-f`로 가리킴). Gradle과 달리 캐시 잠금 문제가 보고되지 않아 재시도를 더하지 않습니다 |
| Next.js·Vite | `package.json`에 `test` 스크립트가 있을 때만 | `{pnpm|yarn|npm} run test` |
| FastAPI | `requirements.txt`·`pyproject.toml`에 `pytest` 의존성이 있을 때만 | `pytest` |

Gradle 테스트가 `--project-cache-dir`로 별도 캐시를 쓰는 이유는 개발 서버(`bootRun`)가 기본 프로젝트 캐시(`.gradle`)를 계속 쓰고 있어, 같은 캐시를 테스트가 또 열면 잠금이 부딪히기 때문입니다([`examples/orders/studio.yaml`](../examples/orders/studio.yaml)의 `api-unit`과 같은 생각입니다).

테스트 명령을 넣을 때마다 그 서비스의 `# 확인:` 메모에 "게이트가 이 테스트를 test 단계에서 돌립니다. 너무 느리거나 외부 의존(Testcontainers 등)이 있으면 studio.yaml의 workflow.tests에서 좁히거나 지우세요"가 함께 남습니다. 실제로 테스트가 Testcontainers처럼 도커를 더 띄우려 하면(도커-인-도커) 샌드박스 안에는 도커 소켓이 없어 실패할 수 있습니다 — 통합 테스트를 JUnit 태그나 별도 소스셋으로 분리해 기본 `test`/`pytest` 태스크에서 빠지게 해 두면(흔한 Gradle·Spring 관례) 이 문제를 피할 수 있습니다. 느리거나 외부 의존이 있는 테스트는 생성된 `workflow.tests` 항목을 직접 지우거나 명령을 좁혀서 쓰세요.

찾은 테스트 명령이 하나도 없으면(예: `test` 스크립트가 없는 Next.js 단일 서비스 프로젝트) `workflow.tests` 자체를 만들지 않고, `required`를 선언하지 않은 한 게이트는 `test` 단계를 건너뜁니다(위 '팀 워크플로'의 `workflowStages()` 규칙과 같습니다). "생성 파일 다시 만들기"(ADR-101)를 돌리면 이 규칙으로 `workflow.tests`를 다시 계산합니다.

기본 서비스 선택(ADR-083)에서 빠진 서비스(`defaultSelected: false`, 같은 서비스 폴더 하위의 또 다른 빌드 — 예: pay의 `commerce/consumer-app`)는 테스트 명령을 찾아도 `workflow.tests`에는 넣지 않습니다. 그 서비스의 컨테이너 자체가 기본으로 뜨지 않아, 넣으면 게이트가 뜨지도 않은 컨테이너에 `exec`해 test 단계가 항상 실패하기 때문입니다. 서비스를 선택에서 켰다면 그 서비스의 `# 확인:` 메모에 적힌 명령을 `workflow.tests`에 직접 추가하세요.

## 모노레포

```yaml
repository:
  monorepo: true
```

프로젝트가 Git 저장소의 하위 폴더일 때만 명시적으로 켭니다. b-studio는 상위 저장소 전체를 복제하되 서비스와 게이트 경로는 프로젝트 기준으로 보여 줍니다.

## 전체 예제

실행 가능한 구성은 [`examples/orders/studio.yaml`](../examples/orders/studio.yaml)과 [`examples/orders/compose.yaml`](../examples/orders/compose.yaml)을 함께 참고하세요. 스키마의 최종 기준은 [`packages/spec/src/schema.ts`](../packages/spec/src/schema.ts)입니다.
