import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 에이전트 실행이 도는 동안 "명세" 탭 요구사항이 전부 "작업 중"으로 떨어지던 버그(실측: 세션 5b640fd3, 32개 중 15개
 * 검증됨 -> 실행 시작 뒤 0개)를 실제 sessions.ts 코드로 끝까지 재현한다. 원인은 테스트 근거 판정이 "체크포인트에 없는
 * 변경이 0개"일 때만 근거를 인정해, 에이전트가 작업 중이면(미체크포인트 변경이 항상 있다) 근거가 0이 되던 것이다.
 *
 * 진짜로 하는 것: 임시 폴더의 git 저장소, 세션 수명(createSession -> runSessionTests -> getSessionRequirements).
 * 가짜로 바꾸는 것: 샌드박스 exec(미리 만든 JUnit XML을 돌려준다). 에이전트 실행은 모델을 부르지 않고 세션의
 * run 객체만 세워 "실행 중" 상태를 만든다. 실제 Docker·GitHub·모델·네트워크 호출은 없다.
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

import { createSession, evidencePendingFilesCount, getSessionRequirements, getSessionTests, getSnapshot, runSessionTests, stopSession, submissionReport } from './sessions';

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
  snapshot: { running: boolean };
  project: { root: string };
}

function internals(id: string): TestSessionInternals {
  const store = (globalThis as { __bStudio?: { sessions: Map<string, TestSessionInternals> } }).__bStudio;
  const session = store?.sessions.get(id);
  if (!session) throw new Error('세션을 찾을 수 없습니다');
  return session;
}

/** 에이전트 실행이 진행 중인 상태를 모델 호출 없이 만든다(sendRequest가 세우는 것과 같은 두 값) */
function startFakeAgentRun(id: string): void {
  const session = internals(id);
  session.run = { id: 'fakerun1', startedAt: new Date().toISOString(), cancel: new AbortController() };
  session.snapshot.running = true;
}

function stopFakeAgentRun(id: string): void {
  const session = internals(id);
  session.run = undefined;
  session.snapshot.running = false;
}

/** 에이전트가 작업 중이라 체크포인트에 없는 변경이 생긴 상태 */
async function editWorkingCopy(id: string): Promise<void> {
  await writeFile(path.join(internals(id).project.root, 'api', 'src', 'wip.txt'), 'agent is working\n');
}

async function readyVerifiedSession(): Promise<string> {
  await setupRepo();
  const id = (await createSession('verifyproj', 'kim', 'copy')).id;
  expect(await waitForReady(id)).toBe('ready');
  // 지금 체크포인트(HEAD)에서 테스트 탭 "전체 실행"을 돌려 R12.1 통과 기록을 남긴다
  await runSessionTests(id, { service: 'api' });
  return id;
}

describe('에이전트 실행 중에도 마지막 체크포인트의 테스트 기록이 요구사항 근거로 남는다', () => {
  it('1. HEAD에서 돈 기록이 있고 미체크포인트 변경이 없으면 검증됨이다(기존 동작)', async () => {
    const id = await readyVerifiedSession();
    const snapshot = await getSessionRequirements(id);
    const r12 = snapshot.requirements.find((requirement) => requirement.id === 'R12')!;
    expect(r12.status).toBe('검증됨');
    expect(r12.evidence.testRun?.passed).toBeGreaterThan(0);
    expect(r12.evidence.missingScenarios).toBeUndefined();
    expect(snapshot.evidenceBasis).toMatchObject({ runInProgress: false, pendingChanges: false });
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('2. 에이전트 실행이 진행 중이고 작업 복사본에 변경이 생겨도 검증 상태가 유지된다', async () => {
    const id = await readyVerifiedSession();
    startFakeAgentRun(id);
    await editWorkingCopy(id);

    const snapshot = await getSessionRequirements(id);
    const r12 = snapshot.requirements.find((requirement) => requirement.id === 'R12')!;
    expect(r12.status).toBe('검증됨');
    expect(r12.evidence.testRun?.passed).toBeGreaterThan(0);
    expect(r12.evidence.missingScenarios).toBeUndefined();
    expect(snapshot.evidenceBasis).toMatchObject({ runInProgress: true, pendingChanges: true });
    expect(snapshot.evidenceBasis?.shortSha).toMatch(/^[0-9a-f]{7,}$/);

    stopFakeAgentRun(id);
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('3. 실행 중이 아닌데 미체크포인트 변경이 있으면 근거로 인정하지 않는다(회귀 방지)', async () => {
    const id = await readyVerifiedSession();
    await editWorkingCopy(id);

    const snapshot = await getSessionRequirements(id);
    const r12 = snapshot.requirements.find((requirement) => requirement.id === 'R12')!;
    expect(r12.status).not.toBe('검증됨');
    expect(r12.evidence.testRun).toBeUndefined();
    expect(snapshot.evidenceBasis).toMatchObject({ runInProgress: false, pendingChanges: true });
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('4. 올리기 전 점검의 판정은 실행 중에도 바뀌지 않는다(미체크포인트 변경이 있으면 근거가 아니다)', async () => {
    const id = await readyVerifiedSession();
    await editWorkingCopy(id);
    const idle = await submissionReport(id);

    startFakeAgentRun(id);
    const running = await submissionReport(id);

    const summarize = (report: typeof idle) => report.items.map((item) => ({ id: item.id, status: item.status, reason: item.reason }));
    expect(summarize(running)).toEqual(summarize(idle));

    stopFakeAgentRun(id);
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('에이전트 실행이 걸쳐 있는 동안 돌린 테스트 탭 실행은 작업 복사본이 깨끗해 보여도 sha를 남기지 않는다', async () => {
    const id = await readyVerifiedSession();
    const sha = getSnapshot(id)!.checkpoints[0]!.sha;

    // 에이전트가 아직 파일을 쓰기 전이라 전후 모두 변경이 없지만, 도는 사이에 고쳤다가 되돌렸을 수 있다
    startFakeAgentRun(id);
    await runSessionTests(id, { service: 'api' });
    stopFakeAgentRun(id);
    const overlapped = (await getSessionTests(id)).services.find((service) => service.service === 'api');
    expect(overlapped?.lastRunAt).toBeDefined();
    expect(overlapped?.lastRunSha).toBeUndefined();

    // 실행이 없을 때 깨끗한 상태에서 돌리면 지금 체크포인트의 증거로 남는다(기존 동작)
    await runSessionTests(id, { service: 'api' });
    const clean = (await getSessionTests(id)).services.find((service) => service.service === 'api');
    expect(clean?.lastRunSha).toBe(sha);
  }, 20_000);
});

describe('evidencePendingFilesCount', () => {
  it('에이전트 실행 중이면 미체크포인트 변경이 있어도 0으로 본다', () => {
    expect(evidencePendingFilesCount(5, true)).toBe(0);
  });

  it('실행 중이 아니면 변경 수를 그대로 돌려준다', () => {
    expect(evidencePendingFilesCount(5, false)).toBe(5);
    expect(evidencePendingFilesCount(0, false)).toBe(0);
  });
});
