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

`ready.path`와 `contract.extract`는 `/`로 시작해야 하며 `//`로 시작할 수 없습니다.

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
  allowedTools: [list_files, read_file, write_file, edit_file, delete_file, run_in_service, restart_service, service_logs, service_stats, http_request, get_contract]
  deniedCommands: [npm publish, git push, terraform apply]
  requireApprovalFor: [restart_service]
  protectedPaths: [.env, .github/workflows, infra, migrations]
  maxChangedFiles: 20
  releaseRequires: [contract_check, test, review, checkpoint]
```

| 키 | 적용 방식 |
|---|---|
| `required` | 순서대로 확인할 단계. 이 중 `run`·`browser_check`·`contract_check`·`test`·`review`는 게이트가 직접 실행해 판정하며, 통과 기록이 없으면 완료로 인정하지 않습니다. 생략하면 `plan → implement → run → contract_check → review → checkpoint`에 선언한 `pageChecks`·`tests` 단계를 더합니다 |
| `tests` | `test` 단계에서 서비스 컨테이너 안에서 실행할 명령. 종료 코드 0이어야 통과하고, 실패 시 출력 끝 30줄(시크릿 가림)을 모델에게 돌려줍니다. 한 명령당 10분 제한 |
| `pageChecks` | `browser_check` 단계에서 재시작한 서비스의 화면을 확인합니다. `mode: http`(기본)는 응답 상태 코드와 본문 문구만 봅니다. `mode: browser`는 헤드리스 Chromium으로 렌더링하고 클라이언트 스크립트를 실행한 뒤 렌더링된 문구, 잡히지 않은 스크립트 예외, `console.error`, 실패한 요청(4xx·5xx·연결 실패, 브라우저가 스스로 여는 `/favicon.ico` 제외)을 실패로 봅니다. `viewport`로 창 크기를 정하고 `noHorizontalScroll: true`면 가로 넘침도 실패로 봅니다. `allowConsoleErrors: true`는 콘솔 오류와 실패한 요청을 허용합니다. `steps`는 `mode: browser`에서만 쓸 수 있고, 페이지를 연 뒤 순서대로 실행할 상호작용을 최대 10개까지 적습니다. 각 단계는 `click`(선택자 클릭)·`fill`(`{ selector, text }` 입력)·`press`(키 입력, 예: `Enter`)·`waitFor`(선택자 대기) 중 정확히 하나를 가지며, 임의 스크립트는 실행하지 않습니다. 단계가 실패하면 그 자리에서 멈추고 몇 번째 단계였는지 알립니다. `expectText`는 단계를 모두 마친 뒤의 화면을 봅니다. 브라우저 전용 옵션을 `http`에 쓰면 불러올 때 거부합니다 |
| `allowedTools` · `deniedCommands` · `requireApprovalFor` | 도구 호출이 샌드박스에 닿기 전에 실행기가 막습니다 |
| `protectedPaths` | 쓰기 도구 호출을 막고, `review` 단계에서 전체 변경 파일을 한 번 더 확인합니다. `.env`처럼 점으로 시작하는 경로는 `.env.local` 같은 변형도 막습니다 |
| `maxChangedFiles` | `review` 단계에서 한 요청의 변경 파일 수 상한을 확인합니다 |
| `releaseRequires` | 배포할 체크포인트의 `Workflow-Passed` 트레일러에 있어야 하는 단계. 스튜디오 밖에서 바꾼 체크포인트처럼 기록이 없으면 `checkpoint` 외 조건을 채우지 못해 배포가 거부됩니다. 생략하면 `[checkpoint]`로 모든 체크포인트를 배포할 수 있습니다 |

불러올 때 검사하는 규칙:

- `required`에 `test`가 있으면 `tests`가, `browser_check`가 있으면 `pageChecks`가 최소 하나 있어야 합니다. 실행할 수단이 없는 필수 단계는 통과처럼 보이기만 하기 때문입니다.
- `tests`·`pageChecks`의 `service`는 `source: managed` 서비스여야 합니다.
- 테스트 이름은 중복될 수 없습니다.

`studio workflow <프로젝트>`로 실제로 강제할 단계와 검사를 확인할 수 있습니다.

`mode: browser`는 스튜디오 서버가 도는 호스트에서 Chromium을 띄웁니다. Playwright가 내려받은 Chromium을 먼저 쓰고, 없으면 설치된 Chrome을 쓰며, `B_STUDIO_BROWSER_EXECUTABLE`로 실행 파일을 지정할 수 있습니다. 어느 것도 없으면 검사는 통과가 아니라 실패로 끝납니다. 스튜디오를 브라우저가 없는 컨테이너 이미지로 운영한다면 `http` 모드를 쓰거나 이미지에 Chromium을 넣어야 합니다.

## 모노레포

```yaml
repository:
  monorepo: true
```

프로젝트가 Git 저장소의 하위 폴더일 때만 명시적으로 켭니다. b-studio는 상위 저장소 전체를 복제하되 서비스와 게이트 경로는 프로젝트 기준으로 보여 줍니다.

## 전체 예제

실행 가능한 구성은 [`examples/orders/studio.yaml`](../examples/orders/studio.yaml)과 [`examples/orders/compose.yaml`](../examples/orders/compose.yaml)을 함께 참고하세요. 스키마의 최종 기준은 [`packages/spec/src/schema.ts`](../packages/spec/src/schema.ts)입니다.
