import { describe, expect, it } from 'vitest';
import * as legacy from './compose-import-legacy';
import * as current from './compose-import';
import { native } from './native';

/**
 * compose-import의 순수 계산은 Rust(`crates/bstudio-guard/src/compose_import.rs`)로 옮겼다.
 * 옛 TS(`compose-import-legacy.ts`)와 같은 입력에 같은 값·오류 글자를 내는지 견준다.
 */

function makeRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const ENGINES = ['postgres', 'mysql', 'mariadb', 'redis', 'valkey', 'kafka', 'zookeeper', 'rabbitmq', 'mongodb', 'elasticsearch', 'opensearch', 'minio', 'mailpit', 'localstack'];
const SERVICES = ['web', 'api', 'db', 'cache', 'broker', 'a-b', '2', '10', '01', '', '한글'];
const TEMPLATES = ['nextjs', 'vite', 'spring-boot', 'fastapi', 'unknown'];
const URL_VALUES = [
  'http://localhost:8080',
  'http://localhost:8080/api',
  'http://localhost:${BACKEND_PORT:-8080}/api',
  '${NEXT_PUBLIC_API_BASE_URL:-http://localhost:${BACKEND_PORT:-8080}/api}',
  'http://backend:8080/api/v1',
  'https://example.com',
  'postgres://localhost:5432/app',
  'http://localhost:8080/api?x=1',
  '',
];

describe('compose-import: legacy TS와 Rust가 같다', () => {
  const rand = makeRandom(20_261_121);
  const int = (n: number) => Math.floor(rand() * n);
  const pick = <T,>(items: readonly T[]): T => items[int(items.length)]!;

  it('이미지·파일 이름·정규화·제안이 같다', () => {
    const images = ['postgres:17-alpine', 'quay.io/minio/minio:RELEASE.2025', 'localhost:5000/postgres:16', 'apache/kafka:3.8.0', 'pgvector/pgvector:pg16', 'redis@sha256:abc', '@', '/x/', 'x:y:z', 'cp-kafka', 'mailhog:1', 'NODE:22-A', 'ſpostgres', 'postgres한'];
    for (const image of images) expect(current.engineOfImage(image), image).toEqual(legacy.engineOfImage(image));
    for (const fileName of ['docker-compose.prod.yml', 'compose.yaml', 'docker-compose.production.yml', 'PROD.compose', 'docker-compose.perf.yml', 'xprod', 'prod', 'a.prod.b']) {
      expect(current.isProdComposeFile(fileName), fileName).toBe(legacy.isProdComposeFile(fileName));
    }
    for (const value of ['My-App', '2col', 'a b', '---', '한글', 'A_B', '1bad-name', '', 'a--b--', 'a-', '-a', 'a.b+c']) {
      expect(current.sanitizeServiceName(value), value).toBe(legacy.sanitizeServiceName(value));
      expect(current.sanitizeSqlIdentifier(value), value).toBe(legacy.sanitizeSqlIdentifier(value));
    }
    for (const database of ['My-App', '1bad', 'a b', '한글', '']) {
      for (const serviceName of ['db', 'My-DB', '2']) {
        expect(current.proposePostgresService(database, '이유', serviceName), JSON.stringify({ database, serviceName })).toEqual(
          legacy.proposePostgresService(database, '이유', serviceName),
        );
      }
    }
    for (const template of ['spring-boot', 'fastapi'] as const) {
      for (const text of ['spring-boot-starter-data-jpa\npostgresql', 'psycopg2-binary', 'psycopg2한', 'psycopg', 'sqlalchemy postgres', 'sqlalchemy', 'xpsycopg2', 'POSTGRESQL']) {
        expect(current.suggestsPostgresNeed(template, text), `${template} ${text}`).toBe(legacy.suggestsPostgresNeed(template, text));
      }
    }
    for (const text of ['jdbc:postgresql://x', 'redis한', 'xredis', 'redis2', 'KAFKA_BOOTSTRAP', 'kafka한', 'spring.kafka', 'mysql://x', 'org.postgresql', '']) {
      expect(current.detectEnvReferences(text), text).toEqual(legacy.detectEnvReferences(text));
    }
    for (const value of URL_VALUES) expect(current.suffixFromUrlValue(value), value).toBe(legacy.suffixFromUrlValue(value));
    for (const name of ['NEXT_PUBLIC_API_BASE_URL', 'VITE_BACKEND_URL', 'REACT_APP_SERVER_HOST', 'NEXT_PUBLIC_SITE_NAME', 'PORT', 'NEXT_PUBLIC_한글_API']) {
      expect(native.composeFrontendBackendEnvName(name), name).toBe(legacy.FRONTEND_BACKEND_ENV_NAME.test(name));
    }
  });

  it('접속 정보·개발용 기본값·healthcheck가 같다', () => {
    const environments: Record<string, unknown>[] = [
      {},
      { POSTGRES_USER: 'app' },
      { POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'secret' },
      { POSTGRES_PASSWORD: '${PW}' },
      { POSTGRES_PASSWORD: '${PW:-dev}' },
      { POSTGRES_PASSWORD: '' },
      { MYSQL_DATABASE: 'app', MYSQL_USER: 'app', MYSQL_PASSWORD: 'pw' },
      { MYSQL_DATABASE: 'app', MYSQL_ROOT_PASSWORD: 'root' },
      { MARIADB_DATABASE: 'app', MARIADB_USER: 'app' },
      { MYSQL_DATABASE: '' },
      { MYSQL_DATABASE: null, MYSQL_ROOT_PASSWORD: 0 },
    ];
    for (const engine of ENGINES) {
      for (const environment of environments) {
        const e = environment as Record<string, string>;
        const label = JSON.stringify({ engine, environment });
        expect(current.databaseCredentialsFor(engine as never, e), label).toEqual(legacy.databaseCredentialsFor(engine as never, e));
        for (const service of [{ engine: engine as never, environment: e }]) {
          expect(current.needsDevDefaultCredentials(service), label).toBe(legacy.needsDevDefaultCredentials(service));
        }
      }
    }

    for (let i = 0; i < 2000; i += 1) {
      const engine = pick(ENGINES) as never;
      const environment = Object.fromEntries(
        Array.from({ length: int(5) }, () => [pick(['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'X']), pick(['', 'app', '${X}', '${X:-d}', '0', '한글'])]),
      );
      const base = {
        name: pick(SERVICES),
        engine,
        image: `${String(engine)}:1`,
        environment,
        dependsOn: [],
        volumes: {},
        envFiles: [],
        notes: Array.from({ length: int(2) }, () => '메모'),
        sourceFile: 'compose.yaml',
      };
      const label = JSON.stringify(base);
      expect(current.withDevDefaultCredentials(base, '안내'), label).toEqual(legacy.withDevDefaultCredentials(base, '안내'));
      expect(current.withDefaultHealthcheck(base), label).toEqual(legacy.withDefaultHealthcheck(base));
      expect(current.databaseSpecFor({ engine, environment }), label).toEqual(legacy.databaseSpecFor({ engine, environment }));
      const withHealthcheck = { ...base, healthcheck: pick([null, {}, { test: ['CMD'] }, '', 0]) };
      expect(current.withDefaultHealthcheck(withHealthcheck as never), label).toEqual(legacy.withDefaultHealthcheck(withHealthcheck as never));
    }

    // 옛 코드가 던지던 자리는 새 코드도 던진다(값을 조용히 만들지 않는다)
    const noNotes = { name: 'db', engine: 'mysql', environment: {}, notes: undefined } as unknown as Parameters<typeof legacy.withDevDefaultCredentials>[0];
    expect(() => legacy.withDevDefaultCredentials(noNotes, 'x')).toThrow();
    expect(() => current.withDevDefaultCredentials(noNotes, 'x')).toThrow();
    const nullCommand = [{ name: 'db', engine: 'postgres', environment: {}, command: null }] as unknown as Parameters<typeof legacy.wireAppEnvironment>[2];
    const refs = { postgres: true, mysql: false, redis: false, kafka: false };
    expect(() => legacy.wireAppEnvironment('fastapi', refs, nullCommand)).toThrow();
    expect(() => current.wireAppEnvironment('fastapi', refs, nullCommand)).toThrow();
  });

  it('앱 환경 배선이 같다', () => {
    for (let i = 0; i < 2000; i += 1) {
      const template = pick(TEMPLATES) as never;
      const refs = { postgres: rand() < 0.5, mysql: rand() < 0.5, redis: rand() < 0.5, kafka: rand() < 0.5 };
      const infra = Array.from({ length: int(5) }, () => {
        const engine = pick(ENGINES);
        const environment = Object.fromEntries(
          Array.from({ length: int(3) }, () => [pick(['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'KAFKA_ADVERTISED_LISTENERS']), pick(['app', 'secret', '${X:-d}', 'PLAINTEXT://localhost:9092,INTERNAL://broker:29092', '한글'])]),
        );
        return {
          name: pick(SERVICES),
          engine,
          environment,
          ...(rand() < 0.4 ? { command: pick([['redis-server', '--port', '6380'], ['postgres', '-p', '5433'], ['x', '--port=7000'], 'redis-server --port 6381', ['a', '--port', '12x'], ['a', '--port']]) } : {}),
          ...(rand() < 0.4 ? { notes: Array.from({ length: int(2) }, () => '메모') } : {}),
        };
      });
      const label = JSON.stringify({ template, refs, infra });
      expect(current.wireAppEnvironment(template, refs, infra as never), label).toEqual(legacy.wireAppEnvironment(template, refs, infra as never));
    }
  });

  it('백엔드 주소 감지가 같다', () => {
    const names = ['NEXT_PUBLIC_API_BASE_URL', 'VITE_BACKEND_URL', 'REACT_APP_SERVER_HOST', 'SPRING_API', 'BACKEND_URL', 'DATABASE_URL', 'PORT', 'NEXT_PUBLIC_SITE_NAME', 'API_MODE', 'SPRING_API'];
    for (let i = 0; i < 3000; i += 1) {
      const environment = Object.fromEntries(Array.from({ length: int(4) }, () => [pick(names), pick(URL_VALUES)]));
      expect(current.detectBackendUrlEnvFromEnvironment(environment), JSON.stringify(environment)).toEqual(legacy.detectBackendUrlEnvFromEnvironment(environment));

      const lines = Array.from({ length: int(4) }, () => {
        const name = pick(names);
        const value = pick(URL_VALUES);
        return pick([`const x = process.env.${name};`, `const x = process.env.${name} ?? '${value}';`, `const x = process.env.${name} || "x";`, `const y = 1;`, `process.env.${name} ?? \`${value}\``]);
      });
      const code = lines.join(pick(['\n', '\r\n', '\n\n']));
      expect(current.detectBackendUrlEnvFromCode(code), code).toEqual(legacy.detectBackendUrlEnvFromCode(code));
      expect(current.detectServerBackendUrlEnvFromCode(code), code).toEqual(legacy.detectServerBackendUrlEnvFromCode(code));

      const assignmentPieces = Array.from({ length: int(4) }, () => pick([`${pick(names)}=${pick(['http://localhost:8080', 'https://x/y', 'postgres://x', "'http://a:1/z'", '"http://a:2/"']) }`, 'x=1', 'PORT=3000']));
      const text = assignmentPieces.join(pick([' ', '\n', '"', '\t']));
      expect(current.detectBackendUrlEnvFromAssignments(text), text).toEqual(legacy.detectBackendUrlEnvFromAssignments(text));
    }
    const corsCases: Record<string, string>[] = [{}, { CORS_X: 'a', PORT: '1' }, { cors: 'a', 'X-CORS-Y': 'b' }, { '2': 'x' }];
    for (const cors of corsCases) {
      expect(current.corsEnvironmentFrom(cors), JSON.stringify(cors)).toEqual(legacy.corsEnvironmentFrom(cors));
    }
    // 이름이 맞는 값이 문자열이 아니면 옛 TS도 던진다(값을 조용히 바꾸지 않는다)
    const nonString = { NEXT_PUBLIC_API_URL: 1 } as unknown as Record<string, string>;
    expect(() => legacy.detectBackendUrlEnvFromEnvironment(nonString)).toThrow();
    expect(() => current.detectBackendUrlEnvFromEnvironment(nonString)).toThrow();
    // 맞는 이름이 없으면 값의 종류와 상관없이 undefined다
    const irrelevant = { PORT: 1 } as unknown as Record<string, string>;
    expect(current.detectBackendUrlEnvFromEnvironment(irrelevant)).toEqual(legacy.detectBackendUrlEnvFromEnvironment(irrelevant));
  });

  it('compose 텍스트를 읽는 함수들이 같다', () => {
    const texts = [
      '',
      'not: [valid',
      'name: only\n',
      'services: {}\n',
      'services: []\n',
      'services: 3\n',
      'services: [a, b]\n',
      'services:\n  - image: postgres:17\n',
      'services:\n  2:\n    image: postgres:17\n  1:\n    image: redis:7\n',
      'services:\n  db:\n    image: postgres:17\n  web:\n    build: .\n    environment:\n      A: 1\n      B: true\n      C: null\n',
      'services:\n  db:\n    image: postgres:17\n    environment: [A=1, B, =x, C=, D=1=2, 3]\n',
      'services:\n  db:\n    image: postgres:17\n    depends_on: [a, b, 3]\n  a:\n    image: redis:7\n',
      'services:\n  db:\n    image: postgres:17\n    depends_on: { a: { condition: service_healthy }, b: 1 }\n  a:\n    image: redis:7\n',
      'services:\n  db:\n    image: postgres:17\n    volumes:\n      - data:/var/lib/postgresql/data\n      - ./local:/x\n      - /abs:/y\n      - ~/h:/z\n      - name:/data/db\n      - /target\n      - { source: named, target: /t }\n      - { source: ./bind, target: /t }\n      - { source: 1, target: 2 }\n',
      'services:\n  db:\n    image: postgres:17\n    env_file: .env\n    command: redis-server --port 6380\n    healthcheck: { test: [CMD, x] }\n',
      'services:\n  db:\n    image: postgres:17\n    env_file: [.env, { path: .env.local, required: false }, { path: 1 }, 2]\n    command: [a, b]\n',
      'services:\n  db:\n    image: 42\n  x:\n    image: redis:7\n    profiles: [p]\n  y:\n    profiles: []\n    build: {}\n',
      'services:\n  db:\n    image: postgres:17\n    environment:\n      A: .inf\n      B: .nan\n      C: -0\n',
      'services:\n  frontend:\n    build: { context: ./frontend }\n    environment:\n      NEXT_PUBLIC_API_BASE_URL: ${NEXT_PUBLIC_API_BASE_URL:-http://localhost:${BACKEND_PORT:-8080}/api}\n  backend:\n    build: ./backend\n    environment:\n      APP_CORS_ALLOWED_ORIGIN_PATTERNS: "*"\n',
      'services:\r\n  db:\r\n    image: postgres:17\r\n',
      'services:\n  db:\n    image: postgres:17\n  db:\n    image: redis:7\n',
      '---\nservices:\n  db:\n    image: postgres:17\n---\nservices: {}\n',
      'a: &a {image: postgres:17}\nservices:\n  db:\n    <<: *a\n',
    ];
    for (const text of texts) {
      const label = JSON.stringify(text);
      expect(current.importSupportingServices(text, 'compose.yaml'), label).toEqual(legacy.importSupportingServices(text, 'compose.yaml'));
      for (const service of ['db', 'frontend', 'backend', 'web', 'a', '2', '', 'missing']) {
        expect(current.environmentFromComposeText(text, service), `${label} ${service}`).toEqual(legacy.environmentFromComposeText(text, service));
      }
      for (const path of ['.', './frontend', 'frontend', 'frontend/', './', '../x', '']) {
        for (const name of ['frontend', 'web', 'missing']) {
          expect(current.originalComposeServiceFor(text, path, name), `${label} ${path} ${name}`).toEqual(legacy.originalComposeServiceFor(text, path, name));
        }
      }
    }
  });
});
