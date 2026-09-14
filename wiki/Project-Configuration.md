# 프로젝트 설정

`studio.yaml`은 compose와 OpenAPI 위에 b-studio 전용 작업·검증·정책 정보를 추가합니다.

## 최소 예시

```yaml
version: 1
name: orders

services:
  web:
    source: managed
    template: nextjs
    path: web
    port: 3000
    preview: browser
    ready: { path: /, timeoutSeconds: 300 }

  api:
    source: managed
    template: spring-boot
    path: api
    port: 8080
    preview: openapi
    ready: { path: /actuator/health/readiness, timeoutSeconds: 900 }
    contract: { extract: /v3/api-docs }

databases:
  db: { engine: postgres, database: app, user: app }

resources:
  web: { memory: 1g, cpus: 2 }
  api: { memory: 1536m, cpus: 2 }
  db: { memory: 256m }
```

## 서비스 종류

`managed`는 b-studio가 코드를 바꾸고 샌드박스에서 실행하는 서비스입니다. `browser`, `openapi`, `logs` 미리보기와 readiness, OpenAPI 추출 경로, 재사용할 스냅샷 볼륨을 설정할 수 있습니다.

`external`은 이미 운영 중인 API입니다. 에이전트가 코드를 바꾸지 않으며 edge 정책 프록시를 통해서만 호출합니다.

```yaml
services:
  customers:
    source: external
    baseUrl: https://customers.internal.example.com
    policy:
      allow:
        - callers: [api, studio]
          methods: [GET]
          paths: [/api/customers/**]
      mask: [phone]
      maskPatterns: [email, card]
      auth:
        header: Authorization
        secret: CUSTOMERS_TOKEN
        prefix: "Bearer "
```

## 네트워크와 시크릿

```yaml
network:
  egress:
    - api.slack.com
    - "*.internal-mirror.example.com"
    - { host: detectportal.firefox.com, methods: [GET], paths: [/success.txt] }

secrets:
  PAYMENT_API_KEY: { services: [api] }
  CUSTOMERS_TOKEN: { services: [] }
```

시크릿 값은 파일에 적지 않고 서버 환경이나 `B_STUDIO_SECRETS_FILE`에서 읽습니다. external API 인증 전용 값은 `services`를 비워 edge에만 둡니다.

## 배포와 모노레포

```yaml
deploy:
  services:
    web: { dockerfile: Dockerfile, port: 8300 }
    api: { dockerfile: Dockerfile, port: 8301 }

repository:
  monorepo: true
```

모든 필드, 제약, 스냅샷 예시는 [전체 설정 레퍼런스](https://github.com/dj258255/b-studio/blob/main/docs/configuration.md), 실행 가능한 구성은 [orders 예제](https://github.com/dj258255/b-studio/tree/main/examples/orders)를 참고하세요.
