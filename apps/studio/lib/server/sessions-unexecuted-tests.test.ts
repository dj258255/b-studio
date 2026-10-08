import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * BE-commerce 세션(pay-2-5b640fd3) 실측(도그푸딩 마찰 152)을 가장 작은 재현으로 옮긴 것: R12(방송 특가 한정
 * 수량 초과 판매 방지)의 핵심 동시성 테스트(`LiveOrderConcurrencyTest`, `@Tag("integration")` + `@Testcontainers`)는
 * 게이트의 기본 test 태스크가 제외해 한 번도 실행되지 않았는데도, 같은 요구사항의 다른(단위) 테스트가 통과해
 * R12는 "검증됨"이 됐고 화면 어디에도 "그 핵심 테스트는 안 돌았다"는 사실이 보이지 않았다.
 *
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 세션 전체 수명(createSession→runSessionTests→getSessionRequirements).
 * 가짜로 바꾸는 것: 샌드박스(Docker) exec — 보고서를 모으는 `sh -c` 명령에 미리 만든 JUnit XML을 돌려주되,
 * `@Tag("integration")`가 붙은 테스트 케이스는 그 XML에 아예 없게 해(진짜 Gradle이 excludeTags로 거른 것과 같은
 * 모양) "발견은 됐지만 보고서엔 없다"를 재현한다. 실제 Docker·Testcontainers·GitHub·모델 호출은 전혀 없다.
 */
const fake = vi.hoisted(() => ({ root: '' }));

// LiveOrderServiceTest(단위)만 보고서에 있고, LiveOrderConcurrencyTest(@Tag("integration"))는 없다 —
// 기본 test 태스크가 integration 태그를 제외하도록 설정된 build.gradle을 흉내 낸 것이다.
const CANNED_JUNIT_XML = `
<testsuite name="com.example.api.LiveOrderServiceTest" tests="1" failures="0" errors="0" skipped="0">
  <testcase name="R12: 재고가 음수가 되지 않는다" classname="com.example.api.LiveOrderServiceTest" time="0.01"/>
</testsuite>
`;

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-unexecuted-tests-fake',
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
    // 보고서 수거 명령(sh -c ...)에만 미리 만든 XML을 돌려준다 — 실제 테스트 실행 명령(./gradlew test 등)은
    // 그냥 성공으로 본다. 이 테스트가 보는 건 "보고서에 없는 발견된 테스트가 어떻게 보이는지"이지 Gradle 실행 자체가 아니다.
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
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
workflow:
  tests:
    - { name: unit, service: api, command: [./gradlew, test] }
`;
}

const liveOrderServiceTestJava = `package com.example.api;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class LiveOrderServiceTest {
    @Test
    @DisplayName("R12: 재고가 음수가 되지 않는다")
    void stockNeverNegative() {}
}
`;

const liveOrderConcurrencyTestJava = `package com.example.api;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Testcontainers;

@Tag("integration")
@Testcontainers
class LiveOrderConcurrencyTest {
    @Test
    @DisplayName("R12: 방송 특가 한정 수량 초과 판매 방지")
    void doesNotOversell() {}
}
`;

const requirementsMarkdown = `# 요구사항

## R12. 방송 특가 한정 수량 초과 판매 방지

- 종류: api · 우선순위: must
- 인수 조건:
  - 동시 주문이 몰려도 재고를 초과해 팔지 않는다
`;

async function setupRepo(): Promise<void> {
  const remote = path.join(root, 'orders.git');
  const source = path.join(root, 'project');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await mkdir(path.join(source, 'api', 'src', 'test', 'java', 'com', 'example', 'api'), { recursive: true });
  await mkdir(path.join(source, 'docs'), { recursive: true });
  await writeFile(path.join(source, 'studio.yaml'), studioYaml());
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(source, 'api', 'src', 'test', 'java', 'com', 'example', 'api', 'LiveOrderServiceTest.java'), liveOrderServiceTestJava);
  await writeFile(path.join(source, 'api', 'src', 'test', 'java', 'com', 'example', 'api', 'LiveOrderConcurrencyTest.java'), liveOrderConcurrencyTestJava);
  await writeFile(path.join(source, 'docs', 'requirements.md'), requirementsMarkdown);
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  fake.root = source;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-unexecuted-tests-'));
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

describe('발견은 됐지만 게이트 실행 결과가 없는 테스트가 요구사항 근거에 보인다(다그푸딩 마찰 152)', () => {
  it('"전체 실행" 뒤 @Tag("integration") 테스트는 "테스트" 탭에 not-run으로 보인다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    await runSessionTests(id, { service: 'api' });

    const snapshot = await getSessionTests(id);
    const api = snapshot.services.find((service) => service.service === 'api')!;
    const concurrencyRow = api.rows.find((row) => row.displayName === 'R12: 방송 특가 한정 수량 초과 판매 방지');
    expect(concurrencyRow?.status).toBe('not-run');
    expect(concurrencyRow?.envConditionalReasons).toEqual(['@Tag("integration")', '@Testcontainers']);

    const unitRow = api.rows.find((row) => row.displayName === 'R12: 재고가 음수가 되지 않는다');
    expect(unitRow?.status).toBe('pass');

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('같은 요구사항의 다른 테스트가 통과해 "검증됨"이어도, 실행 기록 없는 테스트는 상태를 바꾸지 않고 근거에만 남는다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    await runSessionTests(id, { service: 'api' });

    const snapshot = await getSessionRequirements(id);
    const r12 = snapshot.requirements.find((requirement) => requirement.id === 'R12')!;
    expect(r12.status).toBe('검증됨');
    expect(r12.evidence.unexecutedTests).toEqual([
      { file: 'src/test/java/com/example/api/LiveOrderConcurrencyTest.java', name: 'R12: 방송 특가 한정 수량 초과 판매 방지', reason: '@Tag("integration")·@Testcontainers' },
    ]);

    await stopSession(id).catch(() => {});
  }, 20_000);
});
