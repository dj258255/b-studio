import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 묶음(describe) 제목에만 단 시나리오 id(R11.2)도 실행 근거가 되는지 실제 sessions.ts 코드로 본다.
 * 실제 세션 pay-2-5b640fd3에서 에이전트가 describe('R11.2: …') 아래 it('…')을 써서 게이트 web 테스트가 통과했는데도
 * 요구사항 R11이 계속 missingScenarios: ['R11.2']였다 — 보고서 케이스 이름이 it 제목뿐이라 묶음 제목의 id가 사라졌다.
 *
 * 진짜로 하는 것: 임시 폴더의 git 저장소, 세션 수명, 게이트 보고서 수거(collectGateTestReports), 사이드카
 * (.git/b-studio/test-results.json), 테스트 발견, 요구사항 평가(getSessionRequirements).
 * 가짜로 바꾸는 것: 샌드박스 exec — 수거 명령에 vitest JSON 보고서(ancestorTitles 포함)를 돌려준다.
 * 실제 Docker·모델·GitHub·네트워크 호출은 없다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  autoReady: true,
  releaseReady: undefined as (() => void) | undefined,
  report: '',
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-suite-title-ids-fake',
    name: 'fake',
    async start(options?: { onStatus?: (event: { service: string; phase: string; endpoint?: unknown }) => void; services?: readonly string[] }) {
      const fire = () => {
        for (const service of options?.services ?? []) {
          options?.onStatus?.({ service, phase: 'ready', endpoint: { service, containerPort: 5173, url: 'http://127.0.0.1:1' } });
        }
      };
      if (fake.autoReady) fire();
      else fake.releaseReady = fire;
      return [];
    },
    async restart(service: string) {
      return { service, containerPort: 5173, url: 'http://127.0.0.1:1' };
    },
    async sync() {
      return { elapsedMs: 0, checks: 1 };
    },
    async endpoint(service: string) {
      return { service, containerPort: 5173, url: 'http://127.0.0.1:1' };
    },
    async state() {
      return 'running';
    },
    async stats() {
      return [];
    },
    async *logs() {},
    async exec(_service: string, command: string[]) {
      if (command[0] === 'sh' || command[0] === 'cat') return { exitCode: 0, stdout: fake.report, stderr: '' };
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

import { collectGateTestReports, createSession, getSessionRequirements, getSessionTests, getSnapshot, resumeSession, stopSession } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  return stdout.trim();
}

const studioYaml = `version: 1
name: verifyproj
services:
  web: { source: managed, template: vite, path: web, port: 5173, preview: browser }
workflow:
  tests:
    - { name: web-unit, service: web, command: [npx, vitest, run] }
`;

/** 실제 세션의 liveOrder.test.ts 꼴: 시나리오 id는 묶음 제목에만 있고 it 제목에는 없다 */
const liveOrderTest = `import { describe, expect, it } from 'vitest';

describe('R11.1: 결제 승인 응답(200)은 완료 상태가 된다', () => {
  it('paid로 바뀌고 orderNo를 유지한다', () => {});
});

describe('R11.2: 결제 승인 실패(400)는 실패 사유와 함께 재시도 가능한 상태가 된다', () => {
  it('paymentFailed에 서버 message를 그대로 담는다', () => {});
  it('message가 없어도 HTTP 상태를 담은 기본 문구를 쓴다', () => {});
});
`;

const requirementsMarkdown = `# 요구사항

## R11. 결제 승인
- 종류: api · 우선순위: must
- 시나리오:
  - R11.1: (Given) 주문이 있다 (When) 승인 응답이 200이다 (Then) 완료 상태가 된다
  - R11.2: (Given) 주문이 있다 (When) 승인 응답이 400이다 (Then) 실패 사유와 함께 재시도할 수 있다
- 인수 조건:
  - 승인 결과에 따라 상태가 바뀐다
`;

const SUITE_1 = 'R11.1: 결제 승인 응답(200)은 완료 상태가 된다';
const SUITE_2 = 'R11.2: 결제 승인 실패(400)는 실패 사유와 함께 재시도 가능한 상태가 된다';

/** vitest --reporter=json 출력 모양: assertionResults마다 ancestorTitles(묶음 제목들)·title·fullName이 있다 */
const vitestReport = JSON.stringify({
  testResults: [
    {
      name: '/workspace/web/src/liveOrder.test.ts',
      status: 'passed',
      assertionResults: [
        { ancestorTitles: [SUITE_1], fullName: `${SUITE_1} paid로 바뀌고 orderNo를 유지한다`, title: 'paid로 바뀌고 orderNo를 유지한다', status: 'passed', duration: 1 },
        { ancestorTitles: [SUITE_2], fullName: `${SUITE_2} paymentFailed에 서버 message를 그대로 담는다`, title: 'paymentFailed에 서버 message를 그대로 담는다', status: 'passed', duration: 1 },
        { ancestorTitles: [SUITE_2], fullName: `${SUITE_2} message가 없어도 HTTP 상태를 담은 기본 문구를 쓴다`, title: 'message가 없어도 HTTP 상태를 담은 기본 문구를 쓴다', status: 'passed', duration: 1 },
      ],
    },
  ],
});

async function setupRepo(): Promise<void> {
  const remote = path.join(root, 'orders.git');
  const source = path.join(root, 'project');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await mkdir(path.join(source, 'web/src'), { recursive: true });
  await mkdir(path.join(source, 'docs'), { recursive: true });
  await writeFile(path.join(source, 'studio.yaml'), studioYaml);
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  web: { build: ./web }\n');
  await writeFile(path.join(source, 'web/package.json'), JSON.stringify({ name: 'web', devDependencies: { vitest: '^1.0.0' } }));
  await writeFile(path.join(source, 'web/src/liveOrder.test.ts'), liveOrderTest);
  await writeFile(path.join(source, 'docs/requirements.md'), requirementsMarkdown);
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  fake.root = source;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-suite-title-ids-'));
  fake.autoReady = true;
  fake.releaseReady = undefined;
  fake.report = vitestReport;
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

type GateSession = Parameters<typeof collectGateTestReports>[0];

function internals(id: string): GateSession {
  const store = (globalThis as { __bStudio?: { sessions: Map<string, GateSession> } }).__bStudio;
  const session = store?.sessions.get(id);
  if (!session) throw new Error('세션을 찾을 수 없습니다');
  return session;
}

async function gatedSession(): Promise<{ id: string; sha: string }> {
  await setupRepo();
  const id = (await createSession('verifyproj', 'kim', 'copy')).id;
  expect(await waitForReady(id)).toBe('ready');
  const sha = getSnapshot(id)!.checkpoints[0]!.sha;
  await collectGateTestReports(internals(id), sha, [{ stage: 'test', name: 'web-unit', ok: true, attempts: 1 }], [{ name: 'web-unit', service: 'web' }]);
  return { id, sha };
}

async function r11(id: string) {
  const snapshot = await getSessionRequirements(id);
  return snapshot.requirements.find((requirement) => requirement.id === 'R11')!;
}

describe('묶음 제목에만 단 시나리오 id도 실행 근거가 된다', () => {
  it('서비스가 떠 있을 때: describe에만 R11.2를 단 통과 테스트로 R11.2가 확인된 시나리오가 되고 R11이 검증됨이다', async () => {
    const { id, sha } = await gatedSession();

    const tests = await getSessionTests(id);
    const rows = tests.services.find((service) => service.service === 'web')!.rows;
    expect(rows.filter((row) => row.requirementIds.includes('R11.2'))).toHaveLength(2);
    expect(rows.every((row) => row.status === 'pass')).toBe(true);

    const view = await r11(id);
    expect(view.evidence.testRun?.sha).toBe(sha);
    expect(view.evidence.missingScenarios ?? []).toEqual([]);
    expect(view.status).toBe('검증됨');
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('서비스가 꺼져 있어 사이드카 보고서만 있을 때도(재시작 직후) 보고서의 묶음 경로로 R11.2가 확인된다', async () => {
    const { id } = await gatedSession();
    await stopSession(id);
    fake.autoReady = false;
    await resumeSession(id);
    expect(getSnapshot(id)!.services.find((service) => service.name === 'web')?.state).not.toBe('ready');

    const web = (await getSessionTests(id)).services.find((service) => service.service === 'web')!;
    expect(web.notice).toBeDefined();
    expect(web.rows.filter((row) => row.requirementIds.includes('R11.2'))).toHaveLength(2);

    const view = await r11(id);
    expect(view.evidence.missingScenarios ?? []).toEqual([]);
    expect(view.status).toBe('검증됨');
    fake.autoReady = true;
    fake.releaseReady?.();
    await stopSession(id).catch(() => {});
  }, 20_000);
});
