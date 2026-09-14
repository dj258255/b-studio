# Orders Web

b-studio의 `examples/orders`에 포함된 Next.js 프런트엔드입니다. Spring Boot API와 PostgreSQL을 함께 띄우는 전체 샌드박스 시나리오의 일부입니다.

## b-studio로 실행

저장소 루트에서 실행하세요.

```bash
pnpm studio up examples/orders
```

b-studio가 web, api, db를 함께 시작하고 이 서비스의 미리보기 주소를 출력합니다. `/api/*` 요청은 샌드박스 안의 API 서비스로 전달됩니다.

## 단독 개발

```bash
cd examples/orders/web
corepack enable
pnpm install
pnpm dev
```

단독으로 실행하면 API rewrite 대상이 따로 필요할 수 있습니다. 전체 연동을 확인할 때는 b-studio 실행 방식을 사용하세요.

## 관련 파일

- 프로젝트 명세: [`../studio.yaml`](../studio.yaml)
- compose 구성: [`../compose.yaml`](../compose.yaml)
- API 서비스: [`../api`](../api)
- 저장소 시작 가이드: [`../../../docs/getting-started.md`](../../../docs/getting-started.md)
