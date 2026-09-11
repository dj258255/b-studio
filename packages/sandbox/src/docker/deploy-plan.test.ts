import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import type { ComposeModel } from '../kubernetes/compose-model';
import {
  buildArgsFor,
  buildCaddyfile,
  deployNames,
  newReleaseId,
  planBaseCompose,
  planReleaseCompose,
  releasesToRetire,
  summarizeBuildOutput,
  trimRecords,
  type DeployRelease,
} from './deploy-plan';

const project = {
  spec: { name: 'orders' },
  managed: [
    ['web', { port: 3000 }],
    ['api', { port: 8080 }],
  ],
  databases: [['db', { engine: 'postgres', database: 'app', user: 'app', dependents: ['api'] }]],
  secrets: [['PAYMENT_API_KEY', { services: ['api'] }]],
  resources: { api: { memory: '1536m', cpus: 2 }, db: { memory: '256m' } },
} as unknown as LoadedProject;

/** `docker compose config --format json`이 정규화한 orders 예제 (필요한 필드만) */
const config: ComposeModel = {
  services: {
    web: {
      build: { context: '/p/orders/web', dockerfile: 'Dockerfile.dev' },
      environment: { API_BASE_URL: 'http://api:8080' },
      volumes: [
        { type: 'bind', source: '/p/orders/web', target: '/app' },
        { type: 'volume', source: 'web-node-modules', target: '/app/node_modules' },
      ],
    },
    api: {
      build: { context: '/p/orders/api', dockerfile: 'Dockerfile.dev' },
      environment: { DATABASE_URL: 'jdbc:postgresql://db:5432/app', DATABASE_PASSWORD: 'pa$$word' },
      depends_on: { db: { condition: 'service_healthy' } },
    },
    db: {
      image: 'postgres:17-alpine',
      environment: { POSTGRES_PASSWORD: 'app' },
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -U app -d app'], interval: '2s' },
    },
  },
  volumes: { 'web-node-modules': { name: 'orders_web-node-modules' }, 'pnpm-store': { external: true, name: 'b-studio-cache-pnpm' } },
};

describe('planBaseCompose', () => {
  it('부가 서비스만 담고 데이터베이스 폴더를 이름 붙인 볼륨에 둔다', () => {
    expect(planBaseCompose(config, project)).toEqual({
      services: {
        db: {
          image: 'postgres:17-alpine',
          environment: { POSTGRES_PASSWORD: 'app' },
          volumes: [{ type: 'volume', source: 'db-data', target: '/var/lib/postgresql/data' }],
          healthcheck: { test: ['CMD-SHELL', 'pg_isready -U app -d app'], interval: '2s' },
          restart: 'unless-stopped',
          labels: { 'b-studio.deploy': 'orders', 'b-studio.service': 'db' },
        },
      },
      volumes: { 'db-data': {} },
    });
    expect(planBaseCompose({ services: { web: config.services.web! } }, project)).toBeUndefined();
  });
});

describe('planReleaseCompose', () => {
  it('운영 이미지와 환경만 쓰고 개발용 마운트는 버리며, 시크릿은 값 자리만 남긴다', () => {
    const plan = planReleaseCompose(config, project, { releaseId: 'r20260912001500', images: { web: 'b-studio-deploy/orders-web:r1', api: 'b-studio-deploy/orders-api:r1' } });

    expect(plan.services.web).toEqual({
      image: 'b-studio-deploy/orders-web:r1',
      environment: { API_BASE_URL: 'http://api:8080' },
      ports: ['127.0.0.1::3000'],
      restart: 'unless-stopped',
      labels: { 'b-studio.deploy': 'orders', 'b-studio.release': 'r20260912001500', 'b-studio.service': 'web' },
    });
    expect(plan.services.api).toMatchObject({
      // compose가 다시 치환하지 않도록 $를 $$로 적는다
      environment: { DATABASE_URL: 'jdbc:postgresql://db:5432/app', DATABASE_PASSWORD: 'pa$$$$word', PAYMENT_API_KEY: null },
      deploy: { resources: { limits: { memory: '1536m', cpus: '2' } } },
    });
    // 기반 스택의 db는 릴리스 네트워크에 붙이므로 depends_on으로 기다리지 않는다
    expect(plan.services.api).not.toHaveProperty('depends_on');
    expect(plan.services.web).not.toHaveProperty('volumes');
  });
});

describe('buildArgsFor', () => {
  it('Dockerfile이 ARG로 선언한 환경 변수와 compose build.args만 넘긴다', () => {
    const dockerfile = 'FROM node\nARG API_BASE_URL\n  arg NODE_OPTIONS=--max-old-space-size=512\nRUN pnpm build\n';
    expect(buildArgsFor(dockerfile, { args: { BUILD_ID: 'x', EMPTY: null } }, { API_BASE_URL: 'http://api:8080', DATABASE_PASSWORD: 'secret', NODE_OPTIONS: null })).toEqual({
      API_BASE_URL: 'http://api:8080',
      BUILD_ID: 'x',
    });
  });
});

describe('summarizeBuildOutput', () => {
  it('BuildKit 출력에서 캐시·전송 줄을 버리고 컴파일 에러 줄만 남긴다', () => {
    const output = [
      '#8 [build 3/7] COPY gradlew settings.gradle build.gradle gradle.properties ./',
      '#8 CACHED',
      '#13 12.40 > Task :compileJava FAILED',
      '#13 12.41 /app/src/main/java/com/example/api/orders/OrderController.java:21: error: \')\' expected',
      '#13 12.60 FAILURE: Build failed with an exception.',
      '#13 ERROR: process "/bin/sh -c ./gradlew bootJar" did not complete successfully: exit code: 1',
      '#13 DONE 0.0s',
    ].join('\n');

    expect(summarizeBuildOutput(output).split('\n')).toEqual([
      '> Task :compileJava FAILED',
      "/app/src/main/java/com/example/api/orders/OrderController.java:21: error: ')' expected",
      'FAILURE: Build failed with an exception.',
      '#13 ERROR: process "/bin/sh -c ./gradlew bootJar" did not complete successfully: exit code: 1',
    ]);
    expect(summarizeBuildOutput('a\nb\nc', 2)).toBe('b\nc');
  });
});

describe('운영 프록시와 기록', () => {
  it('서비스마다 한 포트에서 릴리스 컨테이너로 넘기는 Caddyfile을 만든다', () => {
    const names = deployNames('orders');
    expect(buildCaddyfile([{ listen: 10000, upstream: `${names.container(names.release('r1'), 'web')}:3000` }])).toBe(
      '{\n\tauto_https off\n}\n\n:10000 {\n\treverse_proxy bsd-orders-r1-web-1:3000\n}\n',
    );
    expect(newReleaseId(new Date('2026-09-12T00:15:07Z'))).toBe('r20260912001507');
  });

  it('최근 이전 릴리스만 남기고 나머지는 정리 대상으로 고르며, 기록을 줄여도 운영 중인 릴리스는 남긴다', () => {
    const release = (id: string, status: DeployRelease['status']): DeployRelease => ({ id, createdAt: '', source: { label: id }, status, images: {}, baseServices: [] });
    const releases = [release('r5', 'active'), release('r4', 'failed'), release('r3', 'previous'), release('r2', 'previous'), release('r1', 'previous')];

    expect(releasesToRetire(releases, 2).map((entry) => entry.id)).toEqual(['r1']);
    const many = Array.from({ length: 25 }, (_, index) => release(`n${index}`, 'retired'));
    const trimmed = trimRecords([...many, release('old-active', 'active')], 'old-active');
    expect(trimmed).toHaveLength(20);
    expect(trimmed.at(-1)?.id).toBe('old-active');
  });
});
