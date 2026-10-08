import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * includes(studio.yaml, ADR-139)가 가리키는 서비스 폴더 밖 경로의 테스트가 실제 sessions.ts 코드 전체(발견 →
 * 보고서 수거 → 매칭 → 요구사항 증거)를 거쳐 "테스트" 탭·요구사항 평가에 나타나는지 본다(다그푸딩 마찰 140).
 * 고친 전: `discoverServiceTestRows`가 `spec.path`만 훑어 `extra/`의 테스트를 전혀 몰랐다 — 보고서 수거
 * (`extraReportRootsFor`)는 `extra/`의 결과까지 이미 모아 왔지만, `attachResults`가 발견한 행에만 결과를
 * 붙이므로 그 결과는 어디에도 나타나지 않고 조용히 버려졌다. BE-commerce 세션에서 실측한 증상(요구사항 id만
 * 단 테스트가 includes 경로에만 있으면 통과해도 "작업 중"에 머문다)을 가장 작은 재현으로 옮긴 것이다.
 *
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 세션 전체 수명(createSession→runSessionTests→getSessionTests/
 * getSessionRequirements). 가짜로 바꾸는 것: 샌드박스(Docker) exec — 실제 Gradle을 돌리지 않고, 보고서를
 * 모으는 `sh -c` 명령에만 미리 만들어 둔 JUnit XML을 돌려준다(실제 테스트 실행 자체는 보지 않는다).
 */
const fake = vi.hoisted(() => ({ root: '' }));

const CANNED_JUNIT_XML = `
<testsuite name="com.example.api.ApiControllerTest" tests="1" failures="0" errors="0" skipped="0">
  <testcase name="R1: 주문 생성은 201을 반환한다" classname="com.example.api.ApiControllerTest" time="0.01"/>
</testsuite>
<testsuite name="com.example.extra.ExtraServiceTest" tests="1" failures="0" errors="0" skipped="0">
  <testcase name="R9: 보조 모듈 테스트" classname="com.example.extra.ExtraServiceTest" time="0.01"/>
</testsuite>
`;

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-test-results-includes-fake',
    name: 'fake',
    async start(options?: { onStatus?: (event: { service: string; phase: string; endpoint?: unknown }) => void; services?: readonly string[] }) {
      for (const service of options?.services ?? []) {
        options?.onStatus?.({ service, phase: 'ready', endpoint: { service, containerPort: 8080, url: 'http://127.0.0.1:1' } });
      }
      return [];
    },
    async restart(service: string) {
      return { service, containerPort: 8080, url: 'http://127.0.0.1:1' };
    },
    async sync() {
      return { elapsedMs: 0, checks: 1 };
    },
    async endpoint(service: string) {
      return { service, containerPort: 8080, url: 'http://127.0.0.1:1' };
    },
    async state() {
      return 'running';
    },
    async stats() {
      return [];
    },
    async *logs() {},
    // 보고서 수거 명령(sh -c ...)에만 미리 만든 XML을 돌려준다. 실제 테스트 실행 명령(./gradlew test 등)은
    // 그냥 성공으로 본다 — 이 테스트가 보는 것은 "수거한 결과가 어디로 가는지"이지 Gradle 실행 자체가 아니다.
    async exec(_service: string, command: string[]) {
      if (command[0] === 'sh') return { exitCode: 0, stdout: CANNED_JUNIT_XML, stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async execToFile() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async execFromFile() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    redact: (text: string) => text,
    findSecrets: () => [],
    async callExternal() {
      return { decision: 'deny' as const, status: 404, body: '', masked: 0 };
    },
    async destroy() {},
  } as unknown as Sandbox;
  return { ...actual, providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox }) };
});

vi.mock('./projects', () => ({
  findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root),
}));

import { createSession, getSessionRequirements, getSessionTests, getSnapshot, runSessionTests, stopSession } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  return stdout.trim();
}

function studioYaml(): string {
  return `version: 1
name: verifyproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi, includes: [extra] }
workflow:
  tests:
    - { name: unit, service: api, command: [./gradlew, test] }
`;
}

const apiTestJava = `package com.example.api;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class ApiControllerTest {
    @Test
    @DisplayName("R1: 주문 생성은 201을 반환한다")
    void create() {}
}
`;

const extraTestJava = `package com.example.extra;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class ExtraServiceTest {
    @Test
    @DisplayName("R9: 보조 모듈 테스트")
    void run() {}
}
`;

const requirementsMarkdown = `# 요구사항

## R9. 보조 모듈 동작

- 종류: api · 우선순위: must
- 인수 조건:
  - 보조 모듈이 요청을 처리한다
`;

async function setupRepo(): Promise<void> {
  const remote = path.join(root, 'orders.git');
  const source = path.join(root, 'project');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await mkdir(path.join(source, 'api', 'src', 'test', 'java', 'com', 'example', 'api'), { recursive: true });
  await mkdir(path.join(source, 'extra', 'src', 'test', 'java', 'com', 'example', 'extra'), { recursive: true });
  await mkdir(path.join(source, 'docs'), { recursive: true });
  await writeFile(path.join(source, 'studio.yaml'), studioYaml());
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(source, 'api', 'src', 'test', 'java', 'com', 'example', 'api', 'ApiControllerTest.java'), apiTestJava);
  await writeFile(path.join(source, 'extra', 'src', 'test', 'java', 'com', 'example', 'extra', 'ExtraServiceTest.java'), extraTestJava);
  await writeFile(path.join(source, 'docs', 'requirements.md'), requirementsMarkdown);
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  fake.root = source;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-test-results-includes-'));
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'verify',
    GIT_AUTHOR_EMAIL: 'verify@example.com',
    GIT_COMMITTER_NAME: 'verify',
    GIT_COMMITTER_EMAIL: 'verify@example.com',
    B_STUDIO_GIT_AUTHOR_NAME: 'verify',
    B_STUDIO_GIT_AUTHOR_EMAIL: 'verify@example.com',
  });
});

afterAll(() => {
  if (saved.mode === undefined) delete process.env.B_STUDIO_MODE;
  else process.env.B_STUDIO_MODE = saved.mode;
  if (saved.sessions === undefined) delete process.env.B_STUDIO_SESSIONS_DIR;
  else process.env.B_STUDIO_SESSIONS_DIR = saved.sessions;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function waitForReady(id: string, timeoutMs = 10_000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const status = getSnapshot(id)?.status ?? 'missing';
    if (status === 'ready' || status === 'failed' || status === 'stopped') return status;
    if (Date.now() - started > timeoutMs) throw new Error(`세션이 준비되지 않았습니다 (${status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('includes 경로의 테스트가 "테스트" 탭·요구사항 증거에 나타난다(다그푸딩 마찰 140)', () => {
  it('"전체 실행"을 돌리면 서비스 폴더 밖(includes) 테스트도 발견돼 통과 결과가 붙는다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    await runSessionTests(id, { service: 'api' });

    const snapshot = await getSessionTests(id);
    const api = snapshot.services.find((service) => service.service === 'api')!;
    const extraRow = api.rows.find((row) => row.displayName === 'R9: 보조 모듈 테스트');
    expect(extraRow).toBeDefined();
    expect(extraRow?.file).toBe('extra/src/test/java/com/example/extra/ExtraServiceTest.java');
    expect(extraRow?.status).toBe('pass');
    expect(extraRow?.requirementIds).toEqual(['R9']);

    const ownRow = api.rows.find((row) => row.displayName === 'R1: 주문 생성은 201을 반환한다');
    expect(ownRow?.status).toBe('pass');

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('요구사항 id만 단 통과 테스트가 includes 경로에만 있어도 그 요구사항은 테스트 탭 실행 증거로 검증됨이 된다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    await runSessionTests(id, { service: 'api' });

    const snapshot = await getSessionRequirements(id);
    const r9 = snapshot.requirements.find((requirement) => requirement.id === 'R9')!;
    expect(r9.status).toBe('검증됨');
    expect(r9.evidence.testRun).toMatchObject({ passed: 1, failed: 0 });

    await stopSession(id).catch(() => {});
  }, 20_000);
});
