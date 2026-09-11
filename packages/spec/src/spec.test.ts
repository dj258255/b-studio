import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject, parseSpec, SpecError } from './load';

const ORDERS_SPEC = `
version: 1
name: orders
services:
  web:
    source: managed
    template: nextjs
    path: web
    port: 3000
    preview: browser
    ready: { path: / }
  api:
    source: managed
    template: spring-boot
    path: api
    port: 8080
    preview: openapi
    ready: { path: /actuator/health, timeoutSeconds: 600 }
    contract: { extract: /v3/api-docs }
  legacy-users:
    source: external
    baseUrl: https://users.internal.example.com
`;

describe('parseSpec', () => {
  it('managed와 external 서비스를 함께 읽고 기본값을 채운다', () => {
    const spec = parseSpec(ORDERS_SPEC);

    expect(spec.compose).toBe('compose.yaml');
    expect(spec.services.web).toMatchObject({ source: 'managed', port: 3000 });
    expect(spec.services.api).toMatchObject({ ready: { expectStatus: 200, timeoutSeconds: 600 } });
    expect(spec.services['legacy-users']).toMatchObject({ source: 'external', preview: 'openapi' });
  });

  it('external 서비스에는 browser 미리보기를 쓸 수 없다', () => {
    const source = `
version: 1
name: x
services:
  users: { source: external, baseUrl: https://a.example.com, preview: browser }
`;
    expect(() => parseSpec(source)).toThrow(SpecError);
  });

  it('다른 호스트를 가리킬 수 있는 "//" 경로를 거부한다', () => {
    const source = `
version: 1
name: x
services:
  api: { source: managed, template: fastapi, path: api, port: 8000, preview: openapi, contract: { extract: //evil.example/openapi.json } }
`;
    const error = captureError(() => parseSpec(source));
    expect(error.issues.some((issue) => issue.startsWith('services.api.contract.extract'))).toBe(true);
  });

  it('문제가 있는 필드 경로를 알려준다', () => {
    const source = `
version: 1
name: x
services:
  web: { source: managed, template: nextjs, path: web, preview: browser }
`;
    const error = captureError(() => parseSpec(source));
    expect(error.issues.some((issue) => issue.startsWith('services.web.port'))).toBe(true);
  });
});

describe('loadProject', () => {
  it('compose에 없는 managed 서비스와 compose에 있는 external 서비스를 잡아낸다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(path.join(dir, 'studio.yaml'), ORDERS_SPEC);
    await writeFile(
      path.join(dir, 'compose.yaml'),
      'services:\n  web: { build: ./web }\n  legacy-users: { image: nginx }\n',
    );

    const error = await loadProject(dir).then(
      () => expect.unreachable(),
      (e: unknown) => e as SpecError,
    );
    expect(error.issues).toHaveLength(2);
    expect(error.issues[0]).toContain('services.api');
    expect(error.issues[1]).toContain('services.legacy-users');
  });

  it('external 볼륨을 샌드박스 공유 캐시 목록으로 모은다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(
      path.join(dir, 'studio.yaml'),
      'version: 1\nname: x\nservices:\n  api: { source: managed, template: fastapi, path: api, port: 8000, preview: openapi }\n',
    );
    await writeFile(
      path.join(dir, 'compose.yaml'),
      'services:\n  api: { build: ./api }\nvolumes:\n  data:\n  uv-cache: { external: true, name: b-studio-cache-uv }\n  shared: { external: true }\n',
    );

    const project = await loadProject(dir);
    expect(project.sharedVolumes).toEqual(['b-studio-cache-uv', 'shared']);
  });

  it('스냅샷 볼륨은 서비스가 마운트하는 샌드박스 전용 볼륨이어야 한다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(
      path.join(dir, 'studio.yaml'),
      `version: 1
name: x
services:
  web:
    source: managed
    template: nextjs
    path: web
    port: 3000
    preview: browser
    snapshots:
      - { volume: web-node-modules, key: [pnpm-lock.yaml] }
      - { volume: pnpm-store, key: [pnpm-lock.yaml] }
      - { volume: missing, key: [pnpm-lock.yaml] }
      - { volume: web-next, key: [package.json] }
`,
    );
    await writeFile(
      path.join(dir, 'compose.yaml'),
      `services:
  web:
    build: ./web
    volumes:
      - ./web:/app
      - web-node-modules:/app/node_modules
      - { type: volume, source: pnpm-store, target: /cache/pnpm }
volumes:
  web-node-modules:
  web-next:
  pnpm-store: { external: true, name: b-studio-cache-pnpm }
`,
    );

    const error = await loadProject(dir).then(
      () => expect.unreachable(),
      (e: unknown) => e as SpecError,
    );
    expect(error.issues).toEqual([
      "services.web.snapshots.1.volume: 샌드박스끼리 공유하는 external 볼륨은 스냅샷으로 만들 수 없습니다",
      "services.web.snapshots.2.volume: compose.yaml의 volumes에 'missing'이 없습니다",
      "services.web.snapshots.3.volume: compose.yaml의 web 서비스가 'web-next' 볼륨을 마운트하지 않습니다",
    ]);
  });

  it('데이터베이스는 compose의 부가 서비스여야 하고, depends_on으로 기대는 서비스를 찾는다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(
      path.join(dir, 'studio.yaml'),
      `version: 1
name: x
services:
  web: { source: managed, template: nextjs, path: web, port: 3000, preview: browser }
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
  worker: { source: managed, template: fastapi, path: worker, port: 8000, preview: logs }
databases:
  db: { engine: postgres, database: app, user: app }
`,
    );
    await writeFile(
      path.join(dir, 'compose.yaml'),
      `services:
  web: { build: ./web, depends_on: [api] }
  api: { build: ./api, depends_on: { db: { condition: service_healthy } } }
  worker: { build: ./worker, depends_on: [db] }
  db: { image: postgres:17-alpine }
`,
    );

    const project = await loadProject(dir);
    expect(project.databases).toEqual([['db', { engine: 'postgres', database: 'app', user: 'app', dependents: ['api', 'worker'] }]]);
  });

  it('자원 한도는 compose 서비스에만 걸 수 있고 docker 메모리 표기를 쓴다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(
      path.join(dir, 'studio.yaml'),
      `version: 1
name: x
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
resources:
  api: { memory: 1536m, cpus: 2 }
  db: { memory: 256m }
  missing: { memory: 1g }
`,
    );
    await writeFile(path.join(dir, 'compose.yaml'), 'services:\n  api: { build: ./api }\n  db: { image: postgres:17-alpine }\n');

    const error = await loadProject(dir).then(
      () => expect.unreachable(),
      (e: unknown) => e as SpecError,
    );
    expect(error.issues).toEqual(['resources.missing: compose.yaml에 같은 이름의 서비스가 없습니다']);

    const bad = captureError(() => parseSpec('version: 1\nname: x\nservices:\n  api: { source: managed, template: t, path: api, port: 1, preview: logs }\nresources:\n  api: { memory: 2GB }\n  db: {}\n'));
    expect(bad.issues.some((issue) => issue.startsWith('resources.api.memory'))).toBe(true);
    expect(bad.issues.some((issue) => issue.startsWith('resources.db'))).toBe(true);
  });

  it('시크릿은 환경 변수 이름으로 적고, 받을 서비스는 compose에 있어야 한다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(
      path.join(dir, 'studio.yaml'),
      `version: 1
name: x
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
secrets:
  PAYMENT_API_KEY: { services: [api], description: 결제 대행사 테스트 키 }
  WEBHOOK_TOKEN: { services: [api, worker] }
`,
    );
    await writeFile(path.join(dir, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');

    const error = await loadProject(dir).then(
      () => expect.unreachable(),
      (e: unknown) => e as SpecError,
    );
    expect(error.issues).toEqual(["secrets.WEBHOOK_TOKEN.services: compose.yaml에 'worker' 서비스가 없습니다"]);

    const bad = captureError(() =>
      parseSpec('version: 1\nname: x\nservices:\n  api: { source: managed, template: t, path: api, port: 1, preview: logs }\nsecrets:\n  payment-key: { services: [api] }\n'),
    );
    expect(bad.issues.some((issue) => issue.startsWith('secrets.payment-key'))).toBe(true);
  });

  it('외부 API 정책의 호출자는 compose 서비스나 studio이고, 인증은 선언한 시크릿을 쓴다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(
      path.join(dir, 'studio.yaml'),
      `version: 1
name: x
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
  legacy-users:
    source: external
    baseUrl: https://users.internal.example.com
    policy:
      allow:
        - { callers: [api, studio], methods: [GET], paths: ["/api/users/*"] }
        - { callers: [worker], methods: [POST] }
      mask: [phone, email]
      auth: { header: Authorization, secret: LEGACY_USERS_TOKEN, prefix: "Bearer " }
  billing:
    source: external
    baseUrl: https://billing.internal.example.com
    policy:
      auth: { header: X-Api-Key, secret: MISSING_TOKEN }
secrets:
  LEGACY_USERS_TOKEN: {}
  UNUSED_TOKEN: {}
`,
    );
    await writeFile(path.join(dir, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');

    const error = await loadProject(dir).then(
      () => expect.unreachable(),
      (e: unknown) => e as SpecError,
    );
    expect(error.issues).toEqual([
      "services.legacy-users.policy.allow.1.callers: 'worker'은(는) compose.yaml의 서비스도 studio도 아닙니다",
      "services.billing.policy.auth.secret: secrets에 'MISSING_TOKEN'이 없습니다",
      'secrets.UNUSED_TOKEN: 받을 서비스(services)나 외부 API 인증(policy.auth)에 쓰이지 않습니다',
    ]);

    expect(parseSpec('version: 1\nname: x\nservices:\n  users: { source: external, baseUrl: "https://users.example.com" }\n').services.users).toMatchObject({
      policy: { mask: [] },
    });
    const ftp = captureError(() => parseSpec('version: 1\nname: x\nservices:\n  users: { source: external, baseUrl: "ftp://users.example.com" }\n'));
    expect(ftp.issues[0]).toMatch(/^services\.users\.baseUrl/);
    const credentials = captureError(() => parseSpec('version: 1\nname: x\nservices:\n  users: { source: external, baseUrl: "https://svc:pw@users.example.com" }\n'));
    expect(credentials.issues).toEqual(['services.users.baseUrl: 주소에 자격 증명을 넣지 말고 policy.auth와 secrets를 쓰세요']);
  });

  it('외부 접속 허용 목록은 호스트 이름만 받는다', () => {
    const spec = parseSpec('version: 1\nname: x\nservices:\n  api: { source: managed, template: t, path: api, port: 1, preview: logs }\nnetwork:\n  egress: [api.slack.com, "*.internal-mirror.example.com"]\n');
    expect(spec.network?.egress).toEqual(['api.slack.com', '*.internal-mirror.example.com']);

    const error = captureError(() =>
      parseSpec('version: 1\nname: x\nservices:\n  api: { source: managed, template: t, path: api, port: 1, preview: logs }\nnetwork:\n  egress: [10.0.0.5, "db.prod:5432"]\n'),
    );
    expect(error.issues.filter((issue) => issue.startsWith('network.egress'))).toHaveLength(2);
  });

  it('SQL에 들어가는 데이터베이스 이름과 사용자는 식별자만 허용한다', () => {
    const source = `
version: 1
name: x
services:
  api: { source: managed, template: fastapi, path: api, port: 8000, preview: openapi }
databases:
  db: { engine: postgres, database: 'app"; DROP DATABASE x; --', user: app }
`;
    const error = captureError(() => parseSpec(source));
    expect(error.issues.some((issue) => issue.startsWith('databases.db.database'))).toBe(true);
  });

  it('스냅샷 키는 서비스 폴더 밖을 가리킬 수 없다', () => {
    const source = `
version: 1
name: x
services:
  web: { source: managed, template: nextjs, path: web, port: 3000, preview: browser, snapshots: [{ volume: nm, key: [../secrets.env, /etc/passwd] }] }
`;
    const error = captureError(() => parseSpec(source));
    expect(error.issues.filter((issue) => issue.startsWith('services.web.snapshots.0.key'))).toHaveLength(2);
  });
});

function captureError(fn: () => unknown): SpecError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SpecError) return error;
    throw error;
  }
  return expect.unreachable('SpecError가 발생해야 합니다');
}
