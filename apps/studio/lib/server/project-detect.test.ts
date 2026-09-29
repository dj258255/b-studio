import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProject } from '@b-studio/spec';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProject, GENERATED_COMPOSE, generateFiles, sanitize } from './project-detect';
import { excludeFromGit, projectIdFor, readRegistry, registerFolder, unregisterProject } from './project-registry';

const made: string[] = [];

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-detect-'));
  made.push(root);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const nextPackage = JSON.stringify({ name: 'shop', dependencies: { next: '16.0.0', react: '19.0.0' } });
const springGradle = `plugins { id 'org.springframework.boot' version '3.5.0' }\njava { toolchain { languageVersion = JavaLanguageVersion.of(17) } }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-actuator' }`;

describe('detectProject', () => {
  it('폴더 바로 아래의 Next.js 앱을 web으로 찾고, 잠금 파일로 패키지 관리자를 고른다', async () => {
    const root = await repo({ 'package.json': nextPackage, 'pnpm-lock.yaml': '' });

    const detection = await detectProject(root);

    expect(detection.hasSpec).toBe(false);
    expect(detection.services).toHaveLength(1);
    expect(detection.services[0]).toMatchObject({ name: 'web', template: 'nextjs', path: '.', port: 3000, preview: 'browser' });
    expect(detection.services[0]!.dockerfile).toContain('pnpm install --frozen-lockfile && exec pnpm exec next dev --hostname 0.0.0.0 --port 3000');
    // pnpm 저장소는 마운트한 소스 폴더 밖(컨테이너 볼륨)에 둔다. 두지 않으면 사용자 폴더에 .pnpm-store가 생긴다(실제 확인에서 발견)
    expect(detection.services[0]!.dockerfile).toContain('npm_config_store_dir=/cache/pnpm');
    expect(detection.services[0]!.volumes).toMatchObject({ 'pnpm-store': '/cache/pnpm' });
  });

  it('하위 폴더의 Next.js와 Spring Boot를 폴더 이름으로 찾고, Java 버전·actuator를 읽는다', async () => {
    const root = await repo({
      'frontend/package.json': nextPackage,
      'frontend/package-lock.json': '{}',
      'backend/build.gradle': springGradle,
      'backend/gradlew': '#!/bin/sh',
      'backend/src/main/resources/application.properties': 'server.port=9090\n',
      'node_modules/next/package.json': nextPackage,
    });

    const { services } = await detectProject(root);

    expect(services.map((service) => [service.name, service.template, service.path])).toEqual([
      ['backend', 'spring-boot', 'backend'],
      ['frontend', 'nextjs', 'frontend'],
    ]);
    const api = services[0]!;
    expect(api).toMatchObject({ port: 9090, ready: { path: '/actuator/health' } });
    expect(api.dockerfile).toContain('FROM eclipse-temurin:17-jdk');
    expect(api.dockerfile).toContain('CMD ["./gradlew", "bootRun"');
    expect(services[1]!.dockerfile).toContain('npm ci && exec npx next dev');
  });

  it('Vite 앱(Vue·React 등)을 5173 포트로 찾는다. Next가 있으면 Next로 본다', async () => {
    const root = await repo({
      'frontend/package.json': JSON.stringify({ dependencies: { vue: '3.5.0' }, devDependencies: { vite: '7.0.0' } }),
      'frontend/package-lock.json': '{}',
    });

    const [service] = (await detectProject(root)).services;

    expect(service).toMatchObject({ name: 'frontend', template: 'vite', port: 5173, preview: 'browser' });
    expect(service!.dockerfile).toContain('npm ci && exec npx vite --host 0.0.0.0 --port 5173 --strictPort');
    expect(service!.volumes).toEqual({ 'node-modules': '/app/node_modules' });
  });

  it('FastAPI 앱 모듈을 찾고, 상태 확인 경로를 모르는 Spring은 추측이라고 알린다', async () => {
    const root = await repo({
      'api/requirements.txt': 'fastapi==0.115\nuvicorn\n',
      'api/app/main.py': 'from fastapi import FastAPI\n\nserver = FastAPI()\n',
      'legacy/pom.xml': '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>',
    });

    const { services } = await detectProject(root);
    const fastapi = services.find((service) => service.template === 'fastapi')!;
    const spring = services.find((service) => service.template === 'spring-boot')!;

    expect(fastapi.dockerfile).toContain('uvicorn app.main:server --reload');
    expect(fastapi).toMatchObject({ port: 8000, preview: 'openapi', contract: '/openapi.json' });
    expect(spring.ready).toEqual({ path: '/', expectStatus: 404 });
    expect(spring.notes.join(' ')).toContain('상태 확인 경로를 몰라');
    // 래퍼가 없으면 도구가 든 이미지를 쓴다
    expect(spring.dockerfile).toContain('FROM maven:3-eclipse-temurin-21');
  });

  it('studio.yaml이 이미 있으면 아무것도 만들지 않고, 스택을 못 찾으면 이유를 알린다', async () => {
    const withSpec = await repo({ 'studio.yaml': 'version: 1\n' });
    expect(await detectProject(withSpec)).toMatchObject({ hasSpec: true, services: [] });
    expect(generateFiles(await detectProject(withSpec))).toEqual([]);

    const empty = await repo({ 'README.md': '# 아무것도 없음' });
    const detection = await detectProject(empty);
    expect(detection.services).toEqual([]);
    expect(detection.warnings[0]).toContain('찾지 못했습니다');
  });

  it('만든 파일을 b-studio가 그대로 읽는다(studio.yaml·compose 서비스 이름이 맞는다)', async () => {
    const root = await repo({ 'web/package.json': nextPackage, 'api/build.gradle': springGradle, 'api/gradlew': '' });
    const files = generateFiles(await detectProject(root));
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
      await writeFile(path.join(root, file.path), file.content);
    }

    expect(files.map((file) => file.path).sort()).toEqual(['api/Dockerfile.b-studio', GENERATED_COMPOSE, 'studio.yaml', 'web/Dockerfile.b-studio'].sort());
    const project = await loadProject(root);
    expect(project.spec.compose).toBe(GENERATED_COMPOSE);
    expect(project.managed.map(([name, service]) => [name, service.path, service.port])).toEqual([
      ['api', 'api', 8080],
      ['web', 'web', 3000],
    ]);
  });
});

const springJpaGradle = `plugins { id 'org.springframework.boot' version '3.5.0' }\ndependencies {\n  implementation 'org.springframework.boot:spring-boot-starter-data-jpa'\n  runtimeOnly 'org.postgresql:postgresql'\n}`;

describe('detectProject: 부가 서비스(ADR-073)', () => {
  it('compose.yaml에서 postgres·redis를 가져오고, Spring 설정에서 참조를 찾아 접속 환경 변수를 채운다', async () => {
    const root = await repo({
      'build.gradle': springJpaGradle,
      'src/main/resources/application.properties': 'spring.datasource.url=jdbc:postgresql://localhost:5432/app\nspring.data.redis.host=localhost\n',
      'compose.yaml': [
        'services:',
        '  db:',
        '    image: postgres:17-alpine',
        '    ports: ["5432:5432"]',
        '    environment:',
        '      POSTGRES_DB: app',
        '      POSTGRES_USER: app',
        '      POSTGRES_PASSWORD: app',
        '    healthcheck:',
        '      test: ["CMD-SHELL", "pg_isready -U app -d app"]',
        '  cache:',
        '    image: redis:7-alpine',
        '  app:',
        '    build: { context: . }',
        '    depends_on: [db, cache]',
        '',
      ].join('\n'),
    });

    const detection = await detectProject(root);

    expect(detection.infra.map((service) => service.name).sort()).toEqual(['cache', 'db']);
    const db = detection.infra.find((service) => service.name === 'db')!;
    expect(db.proposed).toBeUndefined();
    expect('sourceFile' in db && db.sourceFile).toBe('compose.yaml');

    const service = detection.services[0]!;
    expect(service.environment).toMatchObject({ SPRING_DATASOURCE_URL: 'jdbc:postgresql://db:5432/app', SPRING_DATA_REDIS_HOST: 'cache' });
    expect(service.dependsOn.sort()).toEqual(['cache', 'db']);
    expect(service.notes.some((note) => note.includes('POSTGRES_'))).toBe(true);

    const files = generateFiles(detection);
    const compose = files.find((file) => file.path === GENERATED_COMPOSE)!.content;
    expect(compose).toContain('# compose.yaml에서 가져왔습니다');
    // 콜론·슬래시가 있는 값은 따옴표로 감싼다(yamlString)
    expect(compose).toContain('SPRING_DATASOURCE_URL: "jdbc:postgresql://db:5432/app"');
    // db는 healthcheck가 있어 service_healthy, cache는 없어 service_started — 목록·맵 문법이 섞이면 잘못된 YAML이라 모두 맵 문법으로 통일한다
    expect(compose).toContain('db: { condition: service_healthy }');
    expect(compose).toContain('cache: { condition: service_started }');

    const spec = files.find((file) => file.path === 'studio.yaml')!.content;
    expect(spec).toContain('databases:');
    expect(spec).toContain('db: { engine: postgres, database: app, user: app }');

    // 실제로 b-studio가 파싱할 수 있어야 한다(depends_on의 목록·맵 문법이 섞이면 여기서 걸린다)
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
      await writeFile(path.join(root, file.path), file.content);
    }
    await expect(loadProject(root)).resolves.toBeDefined();
  });

  it('compose가 없어도 JPA+postgresql 의존성이 있으면 postgres를 새로 제안한다', async () => {
    const root = await repo({ 'build.gradle': springJpaGradle });

    const detection = await detectProject(root);

    expect(detection.infra).toHaveLength(1);
    const proposed = detection.infra[0]!;
    expect(proposed.proposed).toBe(true);
    expect(proposed.engine).toBe('postgres');
    expect('reason' in proposed && proposed.reason).toContain('postgres');

    const compose = generateFiles(detection).find((file) => file.path === GENERATED_COMPOSE)!.content;
    expect(compose).toContain('# 확인:');
    expect(compose).toContain('image: postgres:17-alpine');
  });

  it('부가 서비스가 있어도 b-studio가 만든 파일을 그대로 읽는다', async () => {
    const root = await repo({
      'build.gradle': springJpaGradle,
      'src/main/resources/application.properties': 'spring.datasource.url=jdbc:postgresql://localhost:5432/app\n',
      'compose.yaml': 'services:\n  db:\n    image: postgres:17-alpine\n    environment:\n      POSTGRES_DB: app\n      POSTGRES_USER: app\n',
    });
    const detection = await detectProject(root);
    const files = generateFiles(detection);
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
      await writeFile(path.join(root, file.path), file.content);
    }

    const project = await loadProject(root);
    expect(project.composeServices).toContain('db');
    expect(project.databases.map(([name]) => name)).toEqual(['db']);
  });

  it('build가 있는 서비스(앱 자신)와 profiles가 있는 서비스는 가져오지 않는다', async () => {
    const root = await repo({
      'package.json': nextPackage,
      'compose.yaml': ['services:', '  db:', '    image: postgres:17-alpine', '  web:', '    build: { context: . }', '  metrics:', '    image: prom/prometheus:v2.54.1', '    profiles: ["monitoring"]', ''].join('\n'),
    });

    const { infra } = await detectProject(root);

    expect(infra.map((service) => service.name)).toEqual(['db']);
  });
});

describe('sanitize', () => {
  it('studio.yaml 이름 규칙(소문자로 시작, 소문자·숫자·-)에 맞춘다', () => {
    expect(sanitize('My_App 2')).toBe('my-app-2');
    expect(sanitize('123-shop')).toBe('shop');
    expect(sanitize('b-studio-detect-AbC9')).toBe('b-studio-detect-abc9');
    expect(sanitize('한글')).toBe('');
  });
});

describe('폴더 등록', () => {
  it('파일을 쓰고 git 추적에서 뺀 뒤 목록에 올린다. 같은 폴더는 다시 올리지 않는다', async () => {
    const root = await repo({ 'package.json': nextPackage, '.git/info/exclude': '# 기존 줄\n' });
    const registry = path.join(await repo({}), 'projects.json');

    const first = await registerFolder(root, new Set(), registry);
    const again = await registerFolder(root, new Set(), registry);

    expect(first).toMatchObject({ created: true, excluded: true });
    expect(first.written.sort()).toEqual(['Dockerfile.b-studio', GENERATED_COMPOSE, 'studio.yaml'].sort());
    expect(again).toMatchObject({ id: first.id, created: false });
    const exclude = await readFile(path.join(root, '.git/info/exclude'), 'utf8');
    expect(exclude).toContain('# 기존 줄');
    expect(exclude).toContain('/studio.yaml');
    expect(exclude).toContain(`/${GENERATED_COMPOSE}`);
    // 두 번 등록해도 줄이 늘지 않는다
    expect(exclude.match(/\/studio\.yaml/g)).toHaveLength(1);
    expect(await readRegistry(registry)).toEqual([expect.objectContaining({ id: first.id, path: root })]);

    expect(await unregisterProject(first.id, registry)).toBe(true);
    expect(await readRegistry(registry)).toEqual([]);
  });

  it('스택을 못 찾은 폴더는 등록하지 않는다', async () => {
    const root = await repo({ 'README.md': '' });
    const registry = path.join(await repo({}), 'projects.json');

    await expect(registerFolder(root, new Set(), registry)).rejects.toThrow('찾지 못했습니다');
    expect(await readRegistry(registry)).toEqual([]);
  });

  it('id는 폴더 이름으로 만들고 겹치면 번호를 붙인다', () => {
    expect(projectIdFor('/Users/me/Desktop/My App', new Set())).toBe('my-app');
    expect(projectIdFor('/Users/me/orders', new Set(['orders']))).toBe('orders-2');
    expect(projectIdFor('/Users/me/_x', new Set())).toBe('x');
  });

  it('git 저장소가 아니면 빼지 않고 false를 돌려준다', async () => {
    const root = await repo({ 'package.json': nextPackage });
    expect(await excludeFromGit(root, ['studio.yaml'])).toBe(false);
  });
});
