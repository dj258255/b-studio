import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { formatVerifyTrailer } from '@b-studio/agent';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 문서만 담은 체크포인트(Workflow-Verify: docs, ADR-096)가 생겨도 이미 쌓인 테스트 근거가 닫히지 않아야 한다(ADR-156).
 * 근거는 "실행이 찍힌 체크포인트 sha === 근거 기준 체크포인트 sha"일 때만 인정되는데, 문서 체크포인트가 가장 앞
 * (checkpoints[0])에 놓이면 코드는 그대로인데 모든 요구사항의 "검증됨"이 "작업 중"으로 떨어지던 버그를 실제
 * sessions.ts 코드로 재현한다. 임시 git 저장소 + 가짜 샌드박스만 쓰고 모델·GitHub·네트워크 호출은 없다.
 */
const fake = vi.hoisted(() => ({ root: '' }));

// 시나리오 R12.1의 테스트가 보고서에서 통과한 상태를 흉내 낸다.
const CANNED_JUNIT_XML = `
<testsuite name="com.example.api.LiveOrderServiceTest" tests="2" failures="0" errors="0" skipped="0">
  <testcase name="R12: 재고가 음수가 되지 않는다" classname="com.example.api.LiveOrderServiceTest" time="0.01"/>
  <testcase name="R12.1: 재고가 0이면 주문을 거절한다" classname="com.example.api.LiveOrderServiceTest" time="0.01"/>
</testsuite>
`;

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-evidence-during-run-fake',
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

import { createSession, commitWorkingCopyDocs, evidenceBaseCheckpoint, getSessionRequirements, getSessionTests, getSnapshot, runSessionTests, stopSession, markRequirementManualVerification, submissionReport } from './sessions';

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

    @Test
    @DisplayName("R12.1: 재고가 0이면 주문을 거절한다")
    void rejectsWhenSoldOut() {}
}
`;

const requirementsMarkdown = `# 요구사항

## R12. 방송 특가 한정 수량 초과 판매 방지
- 종류: api · 우선순위: must
- 시나리오:
  - R12.1: (Given) 재고가 0이다 (When) 주문한다 (Then) 거절된다
- 인수 조건:
  - 재고가 음수가 되지 않는다

## R13. 방송 지연 시간
- 종류: nonfunctional · 우선순위: should
- 인수 조건:
  - 지연이 3초 이내다
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
  await writeFile(path.join(source, 'docs', 'requirements.md'), requirementsMarkdown);
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  fake.root = source;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-evidence-during-run-'));
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

interface TestSessionInternals {
  run?: unknown;
  snapshot: { running: boolean; checkpoints: Array<{ sha: string; shortSha: string; verify?: string }> };
  project: { root: string };
  checkpoints: { commit(message: string, body?: string, options?: { trailers?: string[] }): Promise<{ sha: string; shortSha: string; verify?: string } | undefined> };
}

function internals(id: string): TestSessionInternals {
  const store = (globalThis as { __bStudio?: { sessions: Map<string, TestSessionInternals> } }).__bStudio;
  const session = store?.sessions.get(id);
  if (!session) throw new Error('세션을 찾을 수 없습니다');
  return session;
}

async function readyVerifiedSession(): Promise<string> {
  await setupRepo();
  const id = (await createSession('verifyproj', 'kim', 'copy')).id;
  expect(await waitForReady(id)).toBe('ready');
  await runSessionTests(id, { service: 'api' });
  return id;
}

/** 문서만 바꿔 문서 체크포인트를 실제 경로(commitWorkingCopyDocs)로 만든다 */
async function makeDocsCheckpoint(id: string, name: string) {
  await writeFile(path.join(internals(id).project.root, 'docs', name), `# ${name}\n${Date.now()}\n`);
  const checkpoint = await commitWorkingCopyDocs(id, [`docs/${name}`], `docs: ${name}`);
  expect(checkpoint?.verify).toBe('docs');
  return checkpoint!;
}

/** 코드를 바꾼 체크포인트(가볍게 확인)를 만든다 — 테스트를 안 돌린 코드 변경 */
async function makeLightCodeCheckpoint(id: string) {
  const session = internals(id);
  await writeFile(path.join(session.project.root, 'api', 'src', `code-${Date.now()}.txt`), 'changed\n');
  const checkpoint = await session.checkpoints.commit('요청: 코드를 바꾼다', undefined, { trailers: [formatVerifyTrailer('light')] });
  expect(checkpoint?.verify).toBe('light');
  session.snapshot.checkpoints = [checkpoint!, ...session.snapshot.checkpoints];
  return checkpoint!;
}

async function r12Status(id: string) {
  const snapshot = await getSessionRequirements(id);
  return { r12: snapshot.requirements.find((requirement) => requirement.id === 'R12')!, snapshot };
}

function testsItem(report: Awaited<ReturnType<typeof submissionReport>>) {
  return report.items.find((item) => item.id === 'tests')!;
}

describe('문서 체크포인트가 생겨도 테스트 근거가 닫히지 않는다', () => {
  it('문서 체크포인트(commitWorkingCopyDocs)를 남겨도 검증됨이 유지된다', async () => {
    const id = await readyVerifiedSession();
    expect((await r12Status(id)).r12.status).toBe('검증됨');
    const codeSha = getSnapshot(id)!.checkpoints[0]!.sha;

    const docs = await makeDocsCheckpoint(id, 'notes.md');
    expect(getSnapshot(id)!.checkpoints[0]!.sha).toBe(docs.sha);

    const { r12, snapshot } = await r12Status(id);
    expect(r12.status).toBe('검증됨');
    expect(r12.evidence.testRun?.passed).toBeGreaterThan(0);
    // 응답의 기준 sha는 코드 체크포인트를 가리킨다(문서 체크포인트가 아니다)
    expect(codeSha.startsWith(snapshot.evidenceBasis!.shortSha!)).toBe(true);
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('사람 확인 저장(요구사항 문서 체크포인트)이 다른 요구사항의 테스트 근거를 닫지 않는다', async () => {
    const id = await readyVerifiedSession();
    expect((await r12Status(id)).r12.status).toBe('검증됨');

    const before = getSnapshot(id)!.checkpoints.length;
    await markRequirementManualVerification(id, 'R13', { note: '부하 도구로 지연을 쟀다: p99 2.1초' }, 'kim');
    expect(getSnapshot(id)!.checkpoints.length).toBe(before + 1);
    expect(getSnapshot(id)!.checkpoints[0]!.verify).toBe('docs');

    const { r12, snapshot } = await r12Status(id);
    expect(snapshot.requirements.find((requirement) => requirement.id === 'R13')!.status).toBe('검증됨');
    expect(r12.status).toBe('검증됨');
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('문서 체크포인트가 연달아 쌓여도 유지된다', async () => {
    const id = await readyVerifiedSession();
    await makeDocsCheckpoint(id, 'a.md');
    await makeDocsCheckpoint(id, 'b.md');
    await makeDocsCheckpoint(id, 'c.md');
    expect((await r12Status(id)).r12.status).toBe('검증됨');
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('그 사이 코드 체크포인트(가볍게 확인)가 생기면 이전 근거는 닫힌다', async () => {
    const id = await readyVerifiedSession();
    await makeDocsCheckpoint(id, 'a.md');
    await makeLightCodeCheckpoint(id);
    expect((await r12Status(id)).r12.status).not.toBe('검증됨');
    // 그 뒤 문서 체크포인트가 더 쌓여도 다시 열리지 않는다
    await makeDocsCheckpoint(id, 'b.md');
    expect((await r12Status(id)).r12.status).not.toBe('검증됨');
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('문서 체크포인트 뒤에 테스트 탭에서 돌린 실행이 근거로 인정된다(찍는 쪽과 비교하는 쪽이 같은 기준)', async () => {
    const id = await readyVerifiedSession();
    const codeSha = getSnapshot(id)!.checkpoints[0]!.sha;
    await makeDocsCheckpoint(id, 'a.md');

    await runSessionTests(id, { service: 'api' });
    const api = (await getSessionTests(id)).services.find((service) => service.service === 'api');
    expect(api?.lastRunSha).toBe(codeSha);
    expect((await r12Status(id)).r12.status).toBe('검증됨');
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('올리기 전 점검의 테스트 항목도 문서 체크포인트 때문에 달라지지 않는다', async () => {
    const id = await readyVerifiedSession();
    const before = testsItem(await submissionReport(id));
    await makeDocsCheckpoint(id, 'a.md');
    const after = testsItem(await submissionReport(id));
    expect({ status: after.status, reason: after.reason }).toEqual({ status: before.status, reason: before.reason });
    await stopSession(id).catch(() => {});
  }, 30_000);
});

describe('evidenceBaseCheckpoint', () => {
  const cp = (name: string, verify?: string) => ({ name, ...(verify ? { verify } : {}) });

  it('가장 최근의 문서가 아닌 체크포인트를 고른다', () => {
    expect(evidenceBaseCheckpoint([cp('d2', 'docs'), cp('d1', 'docs'), cp('code'), cp('older')])?.name).toBe('code');
  });

  it('문서 체크포인트가 없으면 맨 앞이다', () => {
    expect(evidenceBaseCheckpoint([cp('a'), cp('b')])?.name).toBe('a');
  });

  it('가볍게 확인한 체크포인트는 건너뛰지 않는다', () => {
    expect(evidenceBaseCheckpoint([cp('d', 'docs'), cp('light', 'light'), cp('full')])?.name).toBe('light');
  });

  it('전부 문서 체크포인트면 가장 오래된 것이다(위에 더 쌓여도 기준이 움직이지 않는다)', () => {
    expect(evidenceBaseCheckpoint([cp('d3', 'docs'), cp('d2', 'docs'), cp('d1', 'docs')])?.name).toBe('d1');
    expect(evidenceBaseCheckpoint([cp('d4', 'docs'), cp('d3', 'docs'), cp('d2', 'docs'), cp('d1', 'docs')])?.name).toBe('d1');
  });

  it('체크포인트가 없으면 없다', () => {
    expect(evidenceBaseCheckpoint([])).toBeUndefined();
  });
});
