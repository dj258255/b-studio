import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProject } from '@b-studio/spec';
import { workflowStages } from '@b-studio/agent';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProject, GENERATED_COMPOSE, generateFiles, sanitize } from './project-detect';
import { excludeFromGit, projectIdFor, readRegistry, registerFolder, unregisterProject } from './project-registry';
import { readServiceSelection } from './service-selection';

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

  it('Gradle 서비스는 테스트 명령이 있으면 Mockito를 -javaagent로 붙이는 init 스크립트를 compose configs:로 심는다(도그푸딩 마찰 106, ADR-134): 샌드박스의 colima 공유 폴더 마운트에서는 Mockito의 inline mock maker가 쓰는 JVM self-attach가 항상 실패한다', async () => {
    const root = await repo({ 'backend/build.gradle': springGradle, 'backend/gradlew': '#!/bin/sh' });

    const [service] = (await detectProject(root)).services;

    expect(service!.testCommand).toBeDefined();
    expect(service!.mockitoAgentInit).toBe(true);
    expect(service!.notes.join(' ')).toContain('self-attach');

    const compose = generateFiles(await detectProject(root)).find((file) => file.path === GENERATED_COMPOSE)!.content;
    // 서비스 블록이 공유 config를 가리킨다
    expect(compose).toContain('configs:\n      - source: b_studio_mockito_agent_init\n        target: /gradle-home/init.d/b-studio-mockito-agent.gradle');
    // 최상위 configs:에 내용이 한 번만 들어간다(여러 서비스가 공유)
    expect(compose).toContain('configs:\n  b_studio_mockito_agent_init:\n    content: |');
    expect(compose).toContain('-javaagent:');
    expect(compose).toContain('mockito-core');
    // compose가 ${...}를 환경 변수로 치환하지 않게 Groovy 보간의 $는 $$로 적는다. 하나라도 그대로 남으면
    // "invalid interpolation format"으로 compose 전체가 뜨지 않는다(docker compose config로 확인)
    expect(compose).toContain('-javaagent:$${jar.absolutePath}');
    expect(compose).not.toMatch(/(^|[^$])\$\{/m);
    // 이미 javaagent가 붙어 있으면 다시 붙이지 않는다(중복 방지)
    expect(compose).toContain("it.startsWith('-javaagent:') && it.contains('mockito-core')");
  });

  it('프론트엔드(Next.js·Vite)는 JVM이 아니라 Mockito init 스크립트를 넣지 않는다', async () => {
    const root = await repo({ 'package.json': nextPackage, 'pnpm-lock.yaml': '' });

    const [service] = (await detectProject(root)).services;

    expect(service!.mockitoAgentInit).toBeUndefined();
    expect(service!.testMemoryInit).toBeUndefined();
    const compose = generateFiles(await detectProject(root)).find((file) => file.path === GENERATED_COMPOSE)!.content;
    expect(compose).not.toContain('configs:');
  });

  it('Gradle 서비스는 테스트 명령이 있으면 테스트 JVM 힙·메타스페이스 상한을 거는 init 스크립트도 compose configs:로 심는다(도그푸딩 마찰 116, ADR-138): 컨테이너에 메모리 한도가 없으면 테스트 JVM의 기본 힙이 VM 전체 메모리 기준으로 잡혀, 개발 서버와 같은 컨테이너에서 돌면 메모리 한도를 넘는다', async () => {
    const root = await repo({ 'backend/build.gradle': springGradle, 'backend/gradlew': '#!/bin/sh' });

    const [service] = (await detectProject(root)).services;

    expect(service!.testCommand).toBeDefined();
    expect(service!.testMemoryInit).toBe(true);
    expect(service!.notes.join(' ')).toContain('512m');

    const compose = generateFiles(await detectProject(root)).find((file) => file.path === GENERATED_COMPOSE)!.content;
    // 서비스 블록이 공유 config를 가리킨다(Mockito init과 같은 서비스에 나란히)
    expect(compose).toContain('configs:\n      - source: b_studio_mockito_agent_init\n        target: /gradle-home/init.d/b-studio-mockito-agent.gradle\n      - source: b_studio_test_memory_init\n        target: /gradle-home/init.d/b-studio-test-memory.gradle');
    // 최상위 configs:에 내용이 한 번만 들어간다(여러 Gradle 서비스가 공유, Mockito init 다음에 이어진다)
    expect(compose).toContain('  b_studio_test_memory_init:\n    content: |');
    expect(compose).toContain("t.maxHeapSize = '512m'");
    expect(compose).toContain('-XX:MaxMetaspaceSize=256m');
    // 사용자가 이미 정한 값은 덮어쓰지 않는다(중복 방지, Mockito 스크립트와 같은 원칙)
    expect(compose).toContain('if (!t.maxHeapSize)');
  });

  it('spring-boot-docker-compose가 있으면 샌드박스에서 끈다(부가 서비스가 없어도)', async () => {
    const root = await repo({
      'backend/build.gradle': `${springGradle}\ndependencies { developmentOnly 'org.springframework.boot:spring-boot-docker-compose' }\n`,
      'backend/gradlew': '#!/bin/sh',
    });

    const [service] = (await detectProject(root)).services;

    expect(service!.environment).toMatchObject({ SPRING_DOCKER_COMPOSE_ENABLED: 'false' });
    expect(service!.notes.join(' ')).toContain('spring-boot-docker-compose');
    const compose = generateFiles(await detectProject(root)).find((file) => file.path === 'compose.b-studio.yaml')!.content;
    expect(compose).toContain('SPRING_DOCKER_COMPOSE_ENABLED');
  });

  it('spring-boot-docker-compose가 없으면 환경 변수를 넣지 않는다', async () => {
    const root = await repo({ 'backend/build.gradle': springGradle, 'backend/gradlew': '#!/bin/sh' });

    const [service] = (await detectProject(root)).services;

    expect(service!.environment.SPRING_DOCKER_COMPOSE_ENABLED).toBeUndefined();
  });

  it('Vite 앱(Vue·React 등)을 5173 포트로 찾는다. Next가 있으면 Next로 본다', async () => {
    const root = await repo({
      'frontend/package.json': JSON.stringify({ dependencies: { vue: '3.5.0' }, devDependencies: { vite: '7.0.0' } }),
      'frontend/package-lock.json': '{}',
    });

    const [service] = (await detectProject(root)).services;

    expect(service).toMatchObject({ name: 'frontend', template: 'vite', port: 5173, preview: 'browser' });
    expect(service!.dockerfile).toContain('npm ci && exec npx vite --host 0.0.0.0 --port 5173 --strictPort');
    // 볼륨은 이 서비스의 working_dir(/workspace/frontend) 기준 상대 경로로 남긴다(ADR-088). 실제 컨테이너 경로는 composeYaml이 붙인다
    expect(service!.volumes).toEqual({ 'node-modules': 'node_modules' });
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

describe('detectProject: 컨테이너 마운트는 프로젝트 루트 전체를 쓴다(ADR-088)', () => {
  it('폴더 바로 아래 앱(path: .)은 워크스페이스 루트에서 바로 일한다', async () => {
    const root = await repo({ 'package.json': nextPackage, 'pnpm-lock.yaml': '' });
    const detection = await detectProject(root);

    const [service] = detection.services;
    expect(service!.dockerfile).toContain('WORKDIR /workspace');
    expect(service!.volumes).toEqual({ 'node-modules': 'node_modules', next: '.next', 'pnpm-store': '/cache/pnpm' });

    const compose = generateFiles(detection).find((file) => file.path === GENERATED_COMPOSE)!.content;
    expect(compose).toContain('working_dir: /workspace');
    expect(compose).toContain('- .:/workspace');
    expect(compose).toContain('web-node-modules:/workspace/node_modules');
    expect(compose).toContain('web-next:/workspace/.next');
    // 의존성 캐시(pnpm 스토어)는 워크스페이스 밖 절대 경로 그대로 둔다
    expect(compose).toContain('web-pnpm-store:/cache/pnpm');

    const project = await writeAndLoad(root, generateFiles(detection));
    expect(project.managed[0]![1].path).toBe('.');
  });

  it('하위 폴더 서비스는 working_dir로 자기 폴더에서 일하고, Gradle 캐시도 그 폴더 기준 경로로 옮긴다', async () => {
    const root = await repo({ 'backend/build.gradle': springGradle, 'backend/gradlew': '#!/bin/sh' });
    const detection = await detectProject(root);

    const [service] = detection.services;
    expect(service!.dockerfile).toContain('WORKDIR /workspace');
    expect(service!.volumes).toEqual({ 'gradle-home': '/gradle-home', 'gradle-project': '.gradle', build: 'build' });

    const compose = generateFiles(detection).find((file) => file.path === GENERATED_COMPOSE)!.content;
    expect(compose).toContain('working_dir: /workspace/backend');
    expect(compose).toContain('- .:/workspace');
    expect(compose).toContain('backend-gradle-project:/workspace/backend/.gradle');
    expect(compose).toContain('backend-build:/workspace/backend/build');
    // 의존성 캐시(Gradle 홈)는 서비스 폴더와 무관하게 그대로 둔다
    expect(compose).toContain('backend-gradle-home:/gradle-home');

    await writeAndLoad(root, generateFiles(detection));
  });

  it('pay 복제본처럼 서비스 폴더 밖(형제 폴더)을 참조하는 빌드가 루트를 마운트해 열린다: $rootDir/../docs가 이제 보인다', async () => {
    // 실제 버그: ./commerce만 /app으로 마운트하면 commerce/build.gradle의 $rootDir/../docs가 컨테이너 안 /docs를 가리켜(없음) 테스트가 깨졌다.
    // 루트를 통째로 마운트하면 같은 참조가 /workspace/docs를 가리켜(있음) 문제가 없다
    const root = await repo({
      'commerce/build.gradle': springGradle,
      'commerce/gradlew': '#!/bin/sh',
      'docs/README.md': '# 사이드카 문서\n',
    });
    const detection = await detectProject(root);
    const compose = generateFiles(detection).find((file) => file.path === GENERATED_COMPOSE)!.content;
    expect(compose).toContain('working_dir: /workspace/commerce');
    expect(compose).toContain('- .:/workspace');
    // docs/는 commerce 폴더 밖이지만 루트 마운트 덕에 /workspace/docs로 컨테이너 안에서 보인다
  });

  it('루트 settings.gradle이 서비스 폴더를 서브프로젝트로 포함하면(진짜 멀티 모듈 빌드), 실패할 수 있다고 확인 메모를 남긴다', async () => {
    const root = await repo({
      'settings.gradle': "rootProject.name = 'pay'\ninclude 'commerce'\n",
      'commerce/build.gradle': springGradle,
      // commerce 자신은 gradlew·settings.gradle이 없다 — 루트에만 있는 진짜 멀티 모듈 구조
    });

    const detection = await detectProject(root);
    const [service] = detection.services;

    expect(service!.notes.some((note) => note.includes('서브프로젝트'))).toBe(true);
    const spec = generateFiles(detection).find((file) => file.path === 'studio.yaml')!.content;
    expect(spec).toContain('# 확인:');
    expect(spec.toLowerCase()).toContain('서브프로젝트'.toLowerCase());
  });

  it('pnpm 워크스페이스(pnpm-workspace.yaml) 구성원은 설치를 저장소 루트에서 하고 개발 서버는 자기 폴더에서 띄운다', async () => {
    const root = await repo({
      'pnpm-workspace.yaml': "packages:\n  - 'frontend'\n",
      'package.json': JSON.stringify({ name: 'monorepo', private: true, workspaces: ['frontend'] }),
      'pnpm-lock.yaml': '',
      'frontend/package.json': nextPackage,
    });

    const detection = await detectProject(root);
    const [service] = detection.services;

    expect(service!.notes.some((note) => note.includes('워크스페이스'))).toBe(true);
    expect(service!.dockerfile).toContain('cd /workspace && pnpm install --frozen-lockfile && cd /workspace/frontend && exec pnpm exec next dev');

    await writeAndLoad(root, generateFiles(detection));
  });
});

/** 만든 파일을 실제로 디스크에 쓰고 loadProject로 읽는다(실제 파싱 검증) */
async function writeAndLoad(root: string, files: ReturnType<typeof generateFiles>) {
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await writeFile(path.join(root, file.path), file.content);
  }
  return loadProject(root);
}

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
        // 일부러 'app'과 다른 이름·비밀번호를 써서, 지어낸 고정값이 아니라 실제 compose 값을 읽었는지 확인한다
        '      POSTGRES_DB: shop',
        '      POSTGRES_USER: shopuser',
        '      POSTGRES_PASSWORD: shopsecret',
        '    healthcheck:',
        '      test: ["CMD-SHELL", "pg_isready -U shopuser -d shop"]',
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
    // compose의 실제 POSTGRES_DB/USER/PASSWORD(shop/shopuser/shopsecret)로 채워야 한다 — 'app'/'app' 같은 지어낸 값이면 안 된다
    expect(service.environment).toEqual({
      SPRING_DATASOURCE_URL: 'jdbc:postgresql://db:5432/shop',
      SPRING_DATASOURCE_USERNAME: 'shopuser',
      SPRING_DATASOURCE_PASSWORD: 'shopsecret',
      SPRING_DATA_REDIS_HOST: 'cache',
    });
    expect(service.dependsOn.sort()).toEqual(['cache', 'db']);
    expect(service.notes.some((note) => note.includes('환경 변수에서 그대로 가져왔습니다'))).toBe(true);

    const files = generateFiles(detection);
    const compose = files.find((file) => file.path === GENERATED_COMPOSE)!.content;
    expect(compose).toContain('# compose.yaml에서 가져왔습니다');
    // 콜론·슬래시가 있는 값은 따옴표로 감싼다(yamlString)
    expect(compose).toContain('SPRING_DATASOURCE_URL: "jdbc:postgresql://db:5432/shop"');
    expect(compose).toContain('SPRING_DATASOURCE_USERNAME: shopuser');
    // db는 원래 healthcheck가 있었고, cache(redis)는 없었지만 기본 healthcheck(redis-cli ping)를 붙여 둘 다 service_healthy를 쓴다
    expect(compose).toContain('db: { condition: service_healthy }');
    expect(compose).toContain('cache: { condition: service_healthy }');
    expect(compose).toContain("test: [\"CMD\",\"redis-cli\",\"ping\"]");

    const spec = files.find((file) => file.path === 'studio.yaml')!.content;
    expect(spec).toContain('databases:');
    expect(spec).toContain('db: { engine: postgres, database: shop, user: shopuser }');

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

  it('defaultInfra(ADR-083)는 앱이 기대는 부가 서비스만 담고, 아무도 참조하지 않는 부가 서비스는 뺀다', async () => {
    const root = await repo({
      'build.gradle': springJpaGradle,
      'src/main/resources/application.properties': 'spring.datasource.url=jdbc:postgresql://localhost:5432/app\n',
      'compose.yaml': ['services:', '  db:', '    image: postgres:17-alpine', '    environment:', '      POSTGRES_DB: app', '      POSTGRES_USER: app', '  cache:', '    image: redis:7-alpine', ''].join(
        '\n',
      ),
    });

    const detection = await detectProject(root);

    expect(detection.infra.map((service) => service.name).sort()).toEqual(['cache', 'db']);
    expect(detection.defaultInfra).toEqual(['db']);
  });

  it('build가 있는 서비스(앱 자신)와 profiles가 있는 서비스는 가져오지 않는다', async () => {
    const root = await repo({
      'package.json': nextPackage,
      'compose.yaml': ['services:', '  db:', '    image: postgres:17-alpine', '  web:', '    build: { context: . }', '  metrics:', '    image: prom/prometheus:v2.54.1', '    profiles: ["monitoring"]', ''].join('\n'),
    });

    const { infra } = await detectProject(root);

    expect(infra.map((service) => service.name)).toEqual(['db']);
  });

  it('pay를 본뜬 mysql·kafka 픽스처: 지어낸 app/app이 아니라 실제 MYSQL_*·Kafka 광고 리스너 값으로 채운다(읽기 전용으로 확인한 실제 저장소 값)', async () => {
    const root = await repo({
      'build.gradle': `plugins { id 'org.springframework.boot' version '3.5.0' }\ndependencies {\n  implementation 'org.springframework.boot:spring-boot-starter-data-jpa'\n  runtimeOnly 'com.mysql:mysql-connector-j'\n}`,
      'src/main/resources/application.properties': ['spring.datasource.url=jdbc:mysql://localhost:3306/becommerce', 'spring.kafka.bootstrap-servers=localhost:9092', ''].join('\n'),
      'compose.yaml': [
        'services:',
        '  mysql:',
        '    image: mysql:8.4',
        '    ports: ["3306:3306"]',
        '    environment:',
        '      MYSQL_DATABASE: becommerce',
        '      MYSQL_USER: becommerce',
        '      MYSQL_PASSWORD: becommerce',
        '      MYSQL_ROOT_PASSWORD: root',
        '  kafka:',
        '    image: apache/kafka:3.8.0',
        '    ports: ["9092:9092"]',
        '    environment:',
        '      KAFKA_ADVERTISED_LISTENERS: "PLAINTEXT://localhost:9092,INTERNAL://kafka:29092"',
        '  app:',
        '    profiles: ["app"]',
        '    build: { context: . }',
        '    depends_on: [mysql, kafka]',
        '',
      ].join('\n'),
    });

    const detection = await detectProject(root);
    const service = detection.services[0]!;

    expect(service.environment).toEqual({
      SPRING_DATASOURCE_URL: 'jdbc:mysql://mysql:3306/becommerce',
      SPRING_DATASOURCE_USERNAME: 'becommerce',
      SPRING_DATASOURCE_PASSWORD: 'becommerce',
      // kafka:29092(INTERNAL)가 컨테이너 사이 주소다. kafka:9092로 추측하면 광고된 listener(localhost:9092, PLAINTEXT)로 리다이렉트돼 접속에 실패한다
      SPRING_KAFKA_BOOTSTRAP_SERVERS: 'kafka:29092',
    });

    // mysql은 healthcheck가 없었지만 기본값(mysqladmin ping)을 붙여 service_healthy를 쓰고, kafka는 기본 healthcheck 대상이 아니라 service_started를 쓴다
    // — 둘 다 맵 문법이라 목록·맵이 섞이는 잘못된 YAML이 되지 않는다
    const compose = generateFiles(detection).find((file) => file.path === GENERATED_COMPOSE)!.content;
    expect(compose).toContain('mysql: { condition: service_healthy }');
    expect(compose).toContain('kafka: { condition: service_started }');
    expect(compose).toContain('test: ["CMD","mysqladmin","ping","-h","localhost","-ubecommerce","-pbecommerce"]');
  });

  const edumeetCompose = [
    'services:',
    '  mysql:',
    '    image: mysql:8.0',
    '    container_name: edumeet-mysql',
    // 실제 edumeet은 자격 증명을 environment가 아니라 env_file(.env)로만 받는다 — 이 버그의 핵심
    '    env_file: .env',
    '    ports: ["3306:3306"]',
    '  redis:',
    '    image: redis:7-alpine',
    '    container_name: edumeet-redis',
    '    command: redis-server --appendonly yes',
    '  app:',
    '    image: ${DOCKER_HUB_REPO}:${IMAGE_TAG:-latest}',
    '    env_file: .env',
    '    depends_on: [mysql, redis]',
    '',
  ].join('\n');

  it('edumeet을 본뜬 픽스처: mysql이 env_file(.env)로만 자격 증명을 받고 저장소에 .env가 없으면, 개발용 값(app/app/app, root)을 채우고 확인 메모를 남긴다', async () => {
    const root = await repo({
      'build.gradle': `plugins { id 'org.springframework.boot' version '3.5.0' }\ndependencies {\n  implementation 'org.springframework.boot:spring-boot-starter-data-jpa'\n  runtimeOnly 'com.mysql:mysql-connector-j'\n}`,
      'src/main/resources/application.properties': 'spring.datasource.url=jdbc:mysql://localhost:3306/edumeet\nspring.data.redis.host=localhost\n',
      'compose.yaml': edumeetCompose,
    });

    const detection = await detectProject(root);

    const mysql = detection.infra.find((service) => service.name === 'mysql')!;
    expect(mysql.environment).toEqual({ MYSQL_DATABASE: 'app', MYSQL_USER: 'app', MYSQL_PASSWORD: 'app', MYSQL_ROOT_PASSWORD: 'root' });
    expect(mysql.notes).toEqual(['원래 compose는 env_file(.env)로 받는데 저장소에 없어 개발용 값을 넣었습니다']);
    // healthcheck가 없었으니 기본값(mysqladmin ping)을 붙여 depends_on이 service_healthy를 쓸 수 있게 한다
    expect(mysql.healthcheck).toEqual({ test: ['CMD', 'mysqladmin', 'ping', '-h', 'localhost', '-uapp', '-papp'], interval: '5s', timeout: '3s', retries: 10 });

    const redis = detection.infra.find((service) => service.name === 'redis')!;
    expect(redis.healthcheck).toEqual({ test: ['CMD', 'redis-cli', 'ping'], interval: '2s', timeout: '3s', retries: 10 });

    // 앱 서비스는 (지어낸 것이 아니라) mysql에 채운 개발용 기본값과 같은 값으로 배선되고, 그 값이 기본값이라는 확인 메모가 남는다
    const service = detection.services[0]!;
    expect(service.environment).toEqual({
      SPRING_DATASOURCE_URL: 'jdbc:mysql://mysql:3306/app',
      SPRING_DATASOURCE_USERNAME: 'app',
      SPRING_DATASOURCE_PASSWORD: 'app',
      SPRING_DATA_REDIS_HOST: 'redis',
    });
    expect(service.notes.some((note) => note.includes('개발용 기본값'))).toBe(true);

    const files = generateFiles(detection);
    const compose = files.find((file) => file.path === GENERATED_COMPOSE)!.content;
    expect(compose).toContain('# 확인: 원래 compose는 env_file(.env)로 받는데 저장소에 없어 개발용 값을 넣었습니다');
    expect(compose).toContain('mysql: { condition: service_healthy }');
    expect(compose).toContain('redis: { condition: service_healthy }');

    // 실제로 파싱되는지도 확인한다(healthcheck·환경 변수가 유효한 YAML인지)
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
      await writeFile(path.join(root, file.path), file.content);
    }
    await expect(loadProject(root)).resolves.toBeDefined();
  });

  it('edumeet을 본뜬 픽스처: .env가 저장소에 있어도 내용을 읽지 않고, 메모 문구만 "샌드박스 복사본에는 담기지 않는다"로 바뀐다', async () => {
    const root = await repo({
      'build.gradle': `plugins { id 'org.springframework.boot' version '3.5.0' }\ndependencies {\n  implementation 'org.springframework.boot:spring-boot-starter-data-jpa'\n  runtimeOnly 'com.mysql:mysql-connector-j'\n}`,
      'src/main/resources/application.properties': 'spring.datasource.url=jdbc:mysql://localhost:3306/edumeet\n',
      'compose.yaml': edumeetCompose,
      // 실제 비밀값이 든 것처럼 꾸민 .env — 절대 읽거나 생성 파일에 담기지 않아야 한다
      '.env': 'MYSQL_ROOT_PASSWORD=super-secret-value\nMYSQL_DATABASE=real_db\n',
    });

    const detection = await detectProject(root);
    const mysql = detection.infra.find((service) => service.name === 'mysql')!;

    expect(mysql.notes).toEqual(['원래 compose는 env_file(.env)로 받는데, 샌드박스 복사본에는 .env가 들어가지 않아 개발용 값을 넣었습니다']);
    // .env가 있어도 내용은 여전히 읽지 않는다 — 개발용 기본값(app)을 그대로 쓴다
    expect(mysql.environment).toEqual({ MYSQL_DATABASE: 'app', MYSQL_USER: 'app', MYSQL_PASSWORD: 'app', MYSQL_ROOT_PASSWORD: 'root' });

    const compose = generateFiles(detection).find((file) => file.path === GENERATED_COMPOSE)!.content;
    expect(compose).not.toContain('super-secret-value');
    expect(compose).not.toContain('real_db');
    expect(compose).toContain('샌드박스 복사본에는 .env가 들어가지 않아');
  });
});

describe('detectProject: 프론트엔드→백엔드 주소 자동 연결(fix/frontend-backend-url)', () => {
  // 실제 저장소(~/.cache/b-studio/sessions/apr-0e6e4f04, 읽기 전용으로 확인)를 본뜬 조각
  const APR_DOCKER_COMPOSE = [
    'services:',
    '  backend:',
    '    build: { context: ./backend, dockerfile: Dockerfile }',
    '    environment:',
    '      APP_CORS_ALLOWED_ORIGIN_PATTERNS: "${CORS_ALLOWED_ORIGINS:-http://localhost:*,http://127.0.0.1:*}"',
    '  frontend:',
    '    build: { context: ./frontend, dockerfile: Dockerfile }',
    '    environment:',
    '      NEXT_PUBLIC_API_BASE_URL: ${NEXT_PUBLIC_API_BASE_URL:-http://localhost:${BACKEND_PORT:-8080}/api}',
    '',
  ].join('\n');

  it('원본 compose가 선언한 NEXT_PUBLIC_API_BASE_URL을 찾아 자리 표시자로 바꾸고, 백엔드의 CORS 설정도 가져온다', async () => {
    const root = await repo({
      'frontend/package.json': nextPackage,
      'frontend/package-lock.json': '{}',
      'backend/build.gradle': springGradle,
      'backend/gradlew': '#!/bin/sh',
      'docker-compose.yml': APR_DOCKER_COMPOSE,
    });

    const detection = await detectProject(root);

    expect(detection.frontendBackendWiring).toEqual({ frontendService: 'frontend', backendService: 'backend', backendProbePath: '/actuator/health' });
    const frontend = detection.services.find((service) => service.name === 'frontend')!;
    const backend = detection.services.find((service) => service.name === 'backend')!;

    expect(frontend.environment.NEXT_PUBLIC_API_BASE_URL).toBe('${b-studio:services.backend.publicUrl}/api');
    expect(frontend.dependsOn).toContain('backend');
    expect(frontend.notes).toContain('frontend가 backend 주소를 NEXT_PUBLIC_API_BASE_URL로 받습니다 — 샌드박스 주소로 자동 연결합니다');

    expect(backend.environment).toEqual({ APP_CORS_ALLOWED_ORIGIN_PATTERNS: '${CORS_ALLOWED_ORIGINS:-http://localhost:*,http://127.0.0.1:*}' });
    expect(backend.notes.some((note) => note.includes('CORS 허용 출처 설정을'))).toBe(true);

    const files = generateFiles(detection);
    const compose = files.find((file) => file.path === GENERATED_COMPOSE)!.content;
    expect(compose).toContain('NEXT_PUBLIC_API_BASE_URL: "${b-studio:services.backend.publicUrl}/api"');
    expect(compose).toContain('APP_CORS_ALLOWED_ORIGIN_PATTERNS');
    const spec = files.find((file) => file.path === 'studio.yaml')!.content;
    expect(spec).toContain('workflow:');
    expect(spec).toContain('pageChecks:');
    expect(spec).toContain('fallbackProbe: { service: backend, path: /actuator/health }');

    // b-studio 자신이 그 파일을 실제로 읽을 수 있어야 한다(publicUrlRefs 검증 포함)
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
      await writeFile(path.join(root, file.path), file.content);
    }
    const project = await loadProject(root);
    expect(project.publicUrlRefs).toEqual([
      { service: 'frontend', envKey: 'NEXT_PUBLIC_API_BASE_URL', template: '${b-studio:services.backend.publicUrl}/api', targetService: 'backend' },
    ]);
  });

  it('원본 compose가 없으면 프론트엔드 코드(lib/api.ts)의 process.env 폴백에서 추정하고, 추정했다는 메모를 남긴다', async () => {
    const root = await repo({
      'frontend/package.json': nextPackage,
      'frontend/package-lock.json': '{}',
      'frontend/lib/api.ts': [
        'const DEFAULT_BASE_URL = "http://localhost:8080";',
        'export function apiBaseUrl(): string {',
        '  const raw = process.env.NEXT_PUBLIC_API_BASE_URL || process.env.API_BASE_URL || DEFAULT_BASE_URL;',
        '  return raw;',
        '}',
        '',
      ].join('\n'),
      'backend/build.gradle': springGradle,
      'backend/gradlew': '#!/bin/sh',
    });

    const detection = await detectProject(root);

    const frontend = detection.services.find((service) => service.name === 'frontend')!;
    expect(frontend.environment.NEXT_PUBLIC_API_BASE_URL).toBe('${b-studio:services.backend.publicUrl}');
    expect(frontend.notes.some((note) => note.includes('코드에서 추정했습니다'))).toBe(true);
  });

  it('프론트엔드만 있고 다른 앱 서비스가 없으면 아무것도 연결하지 않는다', async () => {
    const root = await repo({ 'package.json': nextPackage, 'pnpm-lock.yaml': '' });

    const detection = await detectProject(root);

    expect(detection.frontendBackendWiring).toBeUndefined();
    const spec = generateFiles(detection).find((file) => file.path === 'studio.yaml')!.content;
    expect(spec).not.toContain('workflow:');
  });
});

describe('detectProject: 공개 접두사 없는 서버 쪽 백엔드 주소 변수 자동 연결(fix/detect-frontend-backend-env, pay/apps/web 실측)', () => {
  it('서버 컴포넌트가 process.env.SPRING_API ?? "http://localhost:8080"을 읽으면 컨테이너 사이 주소로 바로 채운다(자리 표시자가 아니다)', async () => {
    const root = await repo({
      'frontend/package.json': nextPackage,
      'frontend/package-lock.json': '{}',
      'frontend/lib/api.ts': "export const SPRING_API = process.env.SPRING_API ?? 'http://localhost:8080';\n",
      'backend/build.gradle': springGradle,
      'backend/gradlew': '#!/bin/sh',
    });

    const detection = await detectProject(root);

    expect(detection.frontendBackendWiring).toEqual({ frontendService: 'frontend', backendService: 'backend', backendProbePath: '/actuator/health' });
    const frontend = detection.services.find((service) => service.name === 'frontend')!;
    expect(frontend.environment.SPRING_API).toBe('http://backend:8080');
    expect(frontend.dependsOn).toContain('backend');
    expect(frontend.notes.some((note) => note.includes('컨테이너 사이 주소(http://backend:8080)로 바로 연결합니다'))).toBe(true);
    // 공개 변수가 아니므로 publicUrlRefs(런타임 자리 표시자 치환 대상)에는 들어가지 않는다 — 값이 이미 확정돼 있다
    expect(generateFiles(detection).find((file) => file.path === GENERATED_COMPOSE)!.content).toContain('SPRING_API: "http://backend:8080"');
  });

  it('기본값이 없으면(process.env.SPRING_API만 있고 폴백이 없음) 추정하지 않고 아무것도 연결하지 않는다', async () => {
    const root = await repo({
      'frontend/package.json': nextPackage,
      'frontend/package-lock.json': '{}',
      'frontend/lib/api.ts': 'export const SPRING_API = process.env.SPRING_API;\n',
      'backend/build.gradle': springGradle,
      'backend/gradlew': '#!/bin/sh',
    });

    const detection = await detectProject(root);

    expect(detection.frontendBackendWiring).toBeUndefined();
    const frontend = detection.services.find((service) => service.name === 'frontend')!;
    expect(frontend.environment.SPRING_API).toBeUndefined();
  });

  it('백엔드가 둘이고 포트가 다르면 기본값의 포트로 짝을 맞춘다', async () => {
    const root = await repo({
      'frontend/package.json': nextPackage,
      'frontend/package-lock.json': '{}',
      'frontend/lib/api.ts': "export const SPRING_API = process.env.SPRING_API ?? 'http://localhost:9090';\n",
      'commerce/build.gradle': springGradle,
      'payments/build.gradle': springGradle,
      'payments/src/main/resources/application.properties': 'server.port=9090\n',
    });

    const detection = await detectProject(root);

    const frontend = detection.services.find((service) => service.name === 'frontend')!;
    expect(frontend.environment.SPRING_API).toBe('http://payments:9090');
    expect(detection.frontendBackendWiring?.backendService).toBe('payments');
  });

  it('백엔드가 둘이고 포트가 같아 구분할 수 없으면 채우지 않고 notes에 남긴다', async () => {
    const root = await repo({
      'frontend/package.json': nextPackage,
      'frontend/package-lock.json': '{}',
      'frontend/lib/api.ts': "export const SPRING_API = process.env.SPRING_API ?? 'http://localhost:8080';\n",
      'commerce/build.gradle': springGradle,
      'payments/build.gradle': springGradle,
    });

    const detection = await detectProject(root);

    expect(detection.frontendBackendWiring).toBeUndefined();
    const frontend = detection.services.find((service) => service.name === 'frontend')!;
    expect(frontend.environment.SPRING_API).toBeUndefined();
    expect(frontend.notes).toContain('변수 SPRING_API가 백엔드 주소로 보이지만 어느 서비스인지 몰라 채우지 않았습니다');
  });

  it('NEXT_PUBLIC 변수는(새로 더 본 next.config.ts에서 찾았어도) 그대로 공개 변수라 자리 표시자로 채운다', async () => {
    const root = await repo({
      'frontend/package.json': nextPackage,
      'frontend/package-lock.json': '{}',
      'frontend/next.config.ts': "const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8080';\nexport default {};\n",
      'backend/build.gradle': springGradle,
      'backend/gradlew': '#!/bin/sh',
    });

    const detection = await detectProject(root);

    const frontend = detection.services.find((service) => service.name === 'frontend')!;
    expect(frontend.environment.NEXT_PUBLIC_API_BASE_URL).toBe('${b-studio:services.backend.publicUrl}');
  });

  it('알려진 자리에 없으면 README 코드 블록의 실행 예시(KEY=value)에서 찾는다', async () => {
    const root = await repo({
      'frontend/package.json': nextPackage,
      'frontend/package-lock.json': '{}',
      'frontend/README.md': ['# web', '', '```bash', 'API_MODE=real SPRING_API=http://localhost:8080 npm run dev', '```', ''].join('\n'),
      'backend/build.gradle': springGradle,
      'backend/gradlew': '#!/bin/sh',
    });

    const detection = await detectProject(root);

    const frontend = detection.services.find((service) => service.name === 'frontend')!;
    expect(frontend.environment.SPRING_API).toBe('http://backend:8080');
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

  it('부가 서비스가 있으면 서비스 선택(ADR-083)을 함께 저장한다: 안 고르면 defaultInfra, 고르면 고른 것만', async () => {
    const files = {
      'build.gradle': springJpaGradle,
      'src/main/resources/application.properties': 'spring.datasource.url=jdbc:postgresql://localhost:5432/app\n',
      'compose.yaml': ['services:', '  db:', '    image: postgres:17-alpine', '    environment:', '      POSTGRES_DB: app', '      POSTGRES_USER: app', '  cache:', '    image: redis:7-alpine', ''].join(
        '\n',
      ),
    };
    const registry = path.join(await repo({}), 'projects.json');
    const stateDir = await repo({});

    // registerFolder는 서비스 선택을 기본 상태 폴더(~/.cache/b-studio/projects)에 쓰므로, 테스트는 사용자 홈을 건드리지 않도록 바꿔 끼운다
    const previous = process.env.B_STUDIO_PROJECTS_STATE_DIR;
    process.env.B_STUDIO_PROJECTS_STATE_DIR = stateDir;
    try {
      const root2 = await repo(files);
      const byDefault = await registerFolder(root2, new Set(), registry, {});
      const defaultSelection = await readServiceSelection(byDefault.id, stateDir);
      expect(defaultSelection?.selected).toContain('db');
      expect(defaultSelection?.selected).not.toContain('cache');

      const root3 = await repo(files);
      const withCache = await registerFolder(root3, new Set(), registry, { selectedInfra: ['db', 'cache'] });
      const chosenSelection = await readServiceSelection(withCache.id, stateDir);
      expect(chosenSelection?.selected).toEqual(expect.arrayContaining(['db', 'cache']));
    } finally {
      if (previous === undefined) delete process.env.B_STUDIO_PROJECTS_STATE_DIR;
      else process.env.B_STUDIO_PROJECTS_STATE_DIR = previous;
    }
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

describe('detectProject: Gradle·Maven 래퍼를 상위 폴더까지 거슬러 올라가 찾는다(실 저장소 구조, 1번 문제)', () => {
  it('래퍼가 저장소 루트에만 있고 Gradle 프로젝트 루트는 하위 폴더면, 그 래퍼로 -p를 써서 실행한다', async () => {
    const root = await repo({
      gradlew: '#!/bin/sh',
      'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.12-bin.zip\n',
      'commerce/settings.gradle': "rootProject.name = 'be-commerce'\n",
      'commerce/build.gradle': springGradle,
    });

    const { services } = await detectProject(root);
    const [service] = services;

    expect(service!.path).toBe('commerce');
    // 래퍼를 찾았으니 JDK 이미지면 충분하다(gradle:jdk 이미지가 아니다 — 버전이 래퍼와 어긋날 일이 없다)
    expect(service!.dockerfile).toContain('FROM eclipse-temurin:17-jdk');
    expect(service!.dockerfile).toContain('CMD ["sh", "-c", "cd /workspace && exec ./gradlew -p commerce bootRun --no-daemon --console=plain"]');
    expect(service!.notes.some((note) => note.includes('저장소 루트'))).toBe(true);
  });

  it('Maven도 같은 방식으로 상위 mvnw를 찾아 -f로 서비스 폴더를 가리켜 실행한다', async () => {
    const root = await repo({
      mvnw: '#!/bin/sh',
      'backend/pom.xml': '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>',
    });

    const [service] = (await detectProject(root)).services;

    expect(service!.dockerfile).toContain('FROM eclipse-temurin:21-jdk');
    expect(service!.dockerfile).toContain('CMD ["sh", "-c", "cd /workspace && exec ./mvnw -f backend spring-boot:run -q"]');
    expect(service!.notes.some((note) => note.includes('저장소 루트'))).toBe(true);
  });

  it('이 폴더에도 상위 어디에도 래퍼가 없으면 예전처럼 이미지의 도구로 실행하고, 버전이 다를 수 있다고 알린다', async () => {
    const root = await repo({ 'commerce/build.gradle': springGradle });

    const [service] = (await detectProject(root)).services;

    expect(service!.dockerfile).toContain('FROM gradle:jdk17');
    expect(service!.dockerfile).toContain('CMD ["gradle", "bootRun"');
    expect(service!.notes.some((note) => note.includes('어디에도') && note.includes('래퍼가 없어'))).toBe(true);
  });
});

describe('detectProject: workflow.tests 생성(버그 리포트 104 — studio.yaml에 테스트 명령이 없어 게이트가 test 단계를 건너뜀)', () => {
  it('루트 래퍼 + 하위 Gradle 서비스(pay 구조)는 상위 래퍼로 -p를 가리키고, 개발 서버와 잠금이 부딪히지 않게 테스트 전용 캐시 디렉터리를 쓴다', async () => {
    const root = await repo({
      gradlew: '#!/bin/sh',
      'commerce/settings.gradle': "rootProject.name = 'be-commerce'\n",
      'commerce/build.gradle': springGradle,
    });

    const detection = await detectProject(root);
    const [service] = detection.services;

    expect(service!.testCommand).toEqual({
      command: ['sh', '-c', 'cd /workspace && ./gradlew -p commerce test --no-daemon --console=plain --project-cache-dir /tmp/gradle-test-cache'],
      maxAttempts: 2,
    });
    expect(service!.notes.some((note) => note.includes('게이트가 이 테스트를'))).toBe(true);

    const spec = generateFiles(detection).find((file) => file.path === 'studio.yaml')!.content;
    expect(spec).toContain('workflow:');
    expect(spec).toContain('  tests:');
    expect(spec).toContain(
      '    - { name: commerce-test, service: commerce, command: ["sh","-c","cd /workspace && ./gradlew -p commerce test --no-daemon --console=plain --project-cache-dir /tmp/gradle-test-cache"], maxAttempts: 2 }',
    );

    // studio.yaml에 workflow.required를 적지 않아도, tests가 있으면 게이트가 test 단계를 기본 흐름에 끼워 넣는다
    // (packages/agent/src/workflow.ts의 workflowStages) — 버그 리포트 104가 바로 이 단계가 한 번도 안 돈 문제였다
    const project = await writeAndLoad(root, generateFiles(detection));
    expect(project.spec.workflow?.tests).toHaveLength(1);
    expect(workflowStages(project)).toContain('test');
  });

  it('래퍼가 서비스 폴더 자신에 있으면 cd 없이 그 폴더에서 바로 테스트를 돈다', async () => {
    const root = await repo({ 'backend/build.gradle': springGradle, 'backend/gradlew': '#!/bin/sh' });

    const [service] = (await detectProject(root)).services;

    expect(service!.testCommand).toEqual({
      command: ['./gradlew', 'test', '--no-daemon', '--console=plain', '--project-cache-dir', '/tmp/gradle-test-cache'],
      maxAttempts: 2,
    });
  });

  it('래퍼가 전혀 없으면 이미지에 든 gradle 도구로 테스트를 돈다', async () => {
    const root = await repo({ 'commerce/build.gradle': springGradle });

    const [service] = (await detectProject(root)).services;

    expect(service!.testCommand?.command).toEqual(['gradle', 'test', '--no-daemon', '--console=plain', '--project-cache-dir', '/tmp/gradle-test-cache']);
  });

  it('Maven은 같은 방식으로 상위 mvnw를 찾아 -f로 테스트 명령을 만들고, Gradle과 달리 재시도를 더하지 않는다', async () => {
    const root = await repo({
      mvnw: '#!/bin/sh',
      'backend/pom.xml': '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>',
    });

    const [service] = (await detectProject(root)).services;

    expect(service!.testCommand).toEqual({ command: ['sh', '-c', 'cd /workspace && ./mvnw -f backend test'] });
    // Maven은 Mockito self-attach 수정(ADR-134)의 범위 밖이다 — surefire argLine을 건드리면 사용자 설정을 지울 위험이 있다
    expect(service!.mockitoAgentInit).toBeUndefined();
    // 테스트 JVM 메모리 상한(ADR-138)도 같은 이유로 Maven은 범위 밖이다
    expect(service!.testMemoryInit).toBeUndefined();
  });

  it('package.json에 test 스크립트가 있는 Next.js는 패키지 관리자로 돌리는 테스트 명령을 만들고 watch 모드 위험을 notes에 남긴다', async () => {
    const pkg = JSON.stringify({ name: 'shop', dependencies: { next: '16.0.0' }, scripts: { dev: 'next dev', test: 'vitest run' } });
    const root = await repo({ 'package.json': pkg, 'pnpm-lock.yaml': '' });

    const [service] = (await detectProject(root)).services;

    expect(service!.testCommand).toEqual({ command: ['pnpm', 'run', 'test'] });
    expect(service!.notes.some((note) => note.includes('test 스크립트'))).toBe(true);
  });

  it('package.json에 test 스크립트가 없는 Next.js는 workflow.tests에 아무것도 넣지 않는다', async () => {
    const root = await repo({ 'package.json': nextPackage, 'pnpm-lock.yaml': '' });

    const detection = await detectProject(root);

    expect(detection.services[0]!.testCommand).toBeUndefined();
    const spec = generateFiles(detection).find((file) => file.path === 'studio.yaml')!.content;
    expect(spec).not.toContain('workflow:');
  });

  it('pytest 의존성이 있는 FastAPI는 pytest 명령을 만든다', async () => {
    const root = await repo({ 'requirements.txt': 'fastapi\nuvicorn\npytest\n', 'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n' });

    const [service] = (await detectProject(root)).services;

    expect(service!.testCommand).toEqual({ command: ['pytest'] });
  });

  it('pytest 의존성이 없는 FastAPI는 workflow.tests에 아무것도 넣지 않는다', async () => {
    const root = await repo({ 'requirements.txt': 'fastapi\nuvicorn\n', 'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n' });

    const [service] = (await detectProject(root)).services;

    expect(service!.testCommand).toBeUndefined();
  });

  it('pyproject.toml에 testcontainers 의존성이 있으면 도커-인-도커 위험을 notes에 남긴다', async () => {
    const root = await repo({
      'pyproject.toml': '[project]\ndependencies = ["fastapi", "pytest", "testcontainers"]\n',
      'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    });

    const [service] = (await detectProject(root)).services;

    expect(service!.notes.some((note) => note.includes('Testcontainers'))).toBe(true);
  });

  it('테스트 명령과 pageChecks(프론트엔드→백엔드 자동 연결)가 함께 있으면 workflow: 절 하나로 합친다(YAML 중복 키 방지)', async () => {
    const pkg = JSON.stringify({ name: 'shop', dependencies: { next: '16.0.0' }, scripts: { test: 'vitest run' } });
    const root = await repo({
      'frontend/package.json': pkg,
      'frontend/package-lock.json': '{}',
      'frontend/lib/api.ts': "export const SPRING_API = process.env.SPRING_API ?? 'http://localhost:8080';\n",
      'backend/build.gradle': springGradle,
      'backend/gradlew': '#!/bin/sh',
    });

    const detection = await detectProject(root);
    const spec = generateFiles(detection).find((file) => file.path === 'studio.yaml')!.content;

    expect(spec.split('\n').filter((line) => line === 'workflow:')).toHaveLength(1);
    expect(spec).toContain('  tests:');
    expect(spec).toContain('  pageChecks:');
  });

  it('defaultSelected: false인 서비스(같은 서비스 폴더 하위의 또 다른 빌드, pay의 consumer-app)는 테스트 명령을 찾아도 기본으로 뜨지 않아 workflow.tests에 넣지 않는다', async () => {
    const root = await repo({
      gradlew: '#!/bin/sh',
      'commerce/settings.gradle': "rootProject.name = 'be-commerce'\n",
      'commerce/build.gradle': springGradle,
      'commerce/consumer-app/settings.gradle': "rootProject.name = 'be-commerce-consumer'\n",
      'commerce/consumer-app/build.gradle': springGradle,
    });

    const detection = await detectProject(root);
    const commerce = detection.services.find((service) => service.path === 'commerce')!;
    const consumerApp = detection.services.find((service) => service.path === 'commerce/consumer-app')!;

    // 둘 다 테스트 명령은 찾았지만
    expect(commerce.testCommand).toBeDefined();
    expect(consumerApp.testCommand).toBeDefined();
    expect(consumerApp.defaultSelected).toBe(false);
    expect(consumerApp.notes.some((note) => note.includes('workflow.tests에는 넣지 않았습니다'))).toBe(true);

    // workflow.tests에는 기본으로 뜨는 commerce만 들어간다 — consumer-app을 넣으면 게이트가 없는 컨테이너에 exec해 늘 실패한다
    const spec = generateFiles(detection).find((file) => file.path === 'studio.yaml')!.content;
    expect(spec).toContain('name: commerce-test');
    expect(spec).not.toContain('consumer-app-test');
  });
});

describe('detectProject: 두 단계 탐색(apps/services/packages, 이미 찾은 서비스 하위)과 노이즈 폴더 건너뛰기(2번 문제)', () => {
  it('실 저장소 구조(pay)를 흉내낸 픽스처에서 commerce·apps/web을 찾고, consumer-app은 기본 선택 해제로 더하고, k6·tools·docs·scripts는 건너뛴다', async () => {
    const root = await repo({
      gradlew: '#!/bin/sh',
      'commerce/settings.gradle': "rootProject.name = 'be-commerce'\n",
      'commerce/build.gradle': springGradle,
      'commerce/consumer-app/settings.gradle': "rootProject.name = 'be-commerce-consumer'\n",
      'commerce/consumer-app/build.gradle': springGradle,
      'apps/web/package.json': nextPackage,
      'apps/web/package-lock.json': '{}',
      'k6/bench.js': '// 부하 테스트 스크립트\n',
      'tools/fds/requirements.txt': 'fastapi\n', // 노이즈 폴더 안의 FastAPI 흉내 — 잡히면 안 된다
      'tools/fds/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
      'docs/README.md': '# 문서\n',
      'scripts/deploy.sh': '#!/bin/sh\n',
    });

    const detection = await detectProject(root);

    const commerce = detection.services.find((service) => service.path === 'commerce');
    const web = detection.services.find((service) => service.path === 'apps/web');
    const consumerApp = detection.services.find((service) => service.path === 'commerce/consumer-app');
    expect(commerce).toBeDefined();
    expect(commerce!.defaultSelected).toBeUndefined();
    expect(web).toBeDefined();
    expect(web!.name).toBe('web');
    expect(web!.notes.some((note) => note.includes('apps/'))).toBe(true);
    expect(consumerApp).toBeDefined();
    expect(consumerApp!.defaultSelected).toBe(false);
    expect(consumerApp!.notes.some((note) => note.includes('별도 빌드'))).toBe(true);
    // 노이즈 폴더는 마커 파일이 있어도(tools/fds의 FastAPI) 서비스가 되지 않는다
    expect(detection.services.some((service) => service.path.startsWith('tools'))).toBe(false);
    expect(detection.services.some((service) => service.path.startsWith('docs'))).toBe(false);
    expect(detection.services.some((service) => service.path.startsWith('k6'))).toBe(false);
    expect(detection.services.some((service) => service.path.startsWith('scripts'))).toBe(false);
  });

  it('두 단계 탐색이 찾은 서비스가 많아도 상한(6개)에서 자른다', async () => {
    const files: Record<string, string> = { 'commerce/build.gradle': springGradle, 'commerce/gradlew': '#!/bin/sh' };
    for (let index = 1; index <= 8; index++) {
      files[`apps/svc${index}/package.json`] = JSON.stringify({ dependencies: { next: '16.0.0' } });
      files[`apps/svc${index}/package-lock.json`] = '{}';
    }
    const root = await repo(files);

    const { services } = await detectProject(root);

    expect(services.length).toBe(6);
  });

  it('등록할 때 기본 선택 해제된 서비스는 처음부터 서비스 선택에서 뺀다(부가 서비스가 없어도)', async () => {
    const root = await repo({
      'commerce/settings.gradle': "rootProject.name = 'be-commerce'\n",
      'commerce/build.gradle': springGradle,
      'commerce/gradlew': '#!/bin/sh',
      'commerce/consumer-app/settings.gradle': "rootProject.name = 'be-commerce-consumer'\n",
      'commerce/consumer-app/build.gradle': springGradle,
      'commerce/consumer-app/gradlew': '#!/bin/sh',
    });
    const registry = path.join(await repo({}), 'registry.json');
    const stateDir = await repo({});

    const previous = process.env.B_STUDIO_PROJECTS_STATE_DIR;
    process.env.B_STUDIO_PROJECTS_STATE_DIR = stateDir;
    try {
      const { id } = await registerFolder(root, new Set(), registry);
      const selection = await readServiceSelection(id, stateDir);
      expect(selection?.selected).toEqual(['commerce']);
    } finally {
      if (previous === undefined) delete process.env.B_STUDIO_PROJECTS_STATE_DIR;
      else process.env.B_STUDIO_PROJECTS_STATE_DIR = previous;
    }
  });
});

describe('detectProject: Next.js package.json의 dev 스크립트를 존중한다(3번 문제)', () => {
  it('scripts.dev가 있으면(예: NODE_ENV를 고정하는 scripts/dev.mjs) next를 직접 부르지 않고 그 스크립트를 쓰며, 포트는 PORT 환경 변수로 맞춘다', async () => {
    const root = await repo({
      'package.json': JSON.stringify({ dependencies: { next: '15.0.0' }, scripts: { dev: 'node scripts/dev.mjs', build: 'next build' } }),
      'package-lock.json': '{}',
      'scripts/dev.mjs': '// NODE_ENV=development 고정\n',
    });

    const [service] = (await detectProject(root)).services;

    expect(service!.dockerfile).toContain('CMD ["sh", "-c", "npm ci && exec npm run dev -- --hostname 0.0.0.0 --port 3000"]');
    expect(service!.environment).toEqual({ PORT: '3000' });
    expect(service!.notes.some((note) => note.includes('dev 스크립트'))).toBe(true);
  });
});

describe('generateFiles: 생성 파일에 ADR 번호가 남아 있지 않아야 한다', () => {
  it('studio.yaml·compose.b-studio.yaml·Dockerfile.b-studio 어디에도 ADR-숫자가 없다(부가 서비스 포함)', async () => {
    const root = await repo({
      'frontend/package.json': nextPackage,
      'frontend/package-lock.json': '{}',
      'backend/build.gradle': springJpaGradle,
      'backend/gradlew': '#!/bin/sh',
      'backend/src/main/resources/application.properties': 'spring.datasource.url=jdbc:postgresql://localhost:5432/app\n',
      'compose.yaml': ['services:', '  db:', '    image: postgres:17-alpine', '    environment:', '      POSTGRES_DB: app', '      POSTGRES_USER: app', ''].join('\n'),
      'node_modules/next/package.json': nextPackage,
      'api/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
      'api/requirements.txt': 'fastapi\n',
    });

    const detection = await detectProject(root);
    const files = generateFiles(detection);

    expect(files.length).toBeGreaterThan(0);
    // 부가 서비스 섹션(ADR-073 메모가 있던 자리)이 실제로 생성됐는지 확인해, 이 검사가 그 줄을 비켜가지 않게 한다
    const compose = files.find((file) => file.path === GENERATED_COMPOSE)!.content;
    expect(compose).toContain('부가 서비스');
    for (const file of files) {
      expect(file.content).not.toMatch(/ADR-\d+/);
    }
  });
});
