import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 58번 버그: 서버가 다시 뜬 뒤(이 테스트는 resumeSession으로 흉내 낸다) 샌드박스가 아직 기동 중이면
 * buildTestServiceView가 "서비스가 꺼져 있습니다"로 빈 행을 돌려줘, 사이드카(.git/b-studio/test-results.json)에
 * 이미 지금 체크포인트의 실행 결과가 남아 있어도 "테스트" 탭과 요구사항 증거가 몇 분 동안 비어 보였다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 사이드카 파일, 세션 멈추고 이어서 작업하기(resumeSession),
 * getSessionTests·buildRequirementTestRunEvidence.
 * 가짜로 바꾸는 것: 샌드박스(Docker) — start()가 테스트가 신호를 줄 때까지 ready를 미뤄 "기동 중" 구간을 흉내 낸다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  /** true면(기본값) start()가 바로 ready를 알린다. false면 releaseReady를 불러야 한다(기동 중 흉내) */
  autoReady: true,
  releaseReady: undefined as (() => void) | undefined,
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-test-results-offline-fake',
    name: 'fake',
    async start(options?: { onStatus?: (event: { service: string; phase: string; endpoint?: unknown }) => void; services?: readonly string[] }) {
      const fire = () => {
        for (const service of options?.services ?? []) {
          options?.onStatus?.({ service, phase: 'ready', endpoint: { service, containerPort: 8080, url: 'http://127.0.0.1:1' } });
        }
      };
      if (fake.autoReady) fire();
      else fake.releaseReady = fire;
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
    async exec() {
      // vitest --reporter=json 보고서 하나를 흉내 낸다. 테스트 이름에 요구사항 id(R7)를 담아, 서비스가
      // 꺼져 있을 때 되살린 행도 발견 단계와 같은 방식(extractRequirementIds)으로 id를 뽑는지 함께 본다
      const report = JSON.stringify({ testResults: [{ name: 'web/src/App.test.ts', assertionResults: [{ title: '[R7] 메모 필드를 저장한다', status: 'passed' }] }] });
      return { exitCode: 0, stdout: report, stderr: '' };
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

import { buildRequirementTestRunEvidence, createSession, getSessionTests, getSnapshot, resumeSession, runSessionTests, stopSession } from './sessions';

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
  web: { source: managed, template: vite, path: web, port: 5173, preview: browser }
workflow:
  required: [plan, implement, run, contract_check, checkpoint]
  releaseRequires: [checkpoint]
review:
  auto: false
`;
}

async function setupRepo(): Promise<void> {
  const remote = path.join(root, 'orders.git');
  const source = path.join(root, 'project');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await mkdir(path.join(source, 'web/src'), { recursive: true });
  await writeFile(path.join(source, 'studio.yaml'), studioYaml());
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  web: { build: ./web }\n');
  await writeFile(path.join(source, 'web/package.json'), JSON.stringify({ name: 'web', devDependencies: { vitest: '^1.0.0' } }));
  await writeFile(path.join(source, 'web/src/App.tsx'), 'export default function App() { return null; }\n');
  await writeFile(path.join(source, 'web/src/App.test.ts'), "import { test } from 'vitest';\ntest('[R7] 메모 필드를 저장한다', () => {});\n");
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  fake.root = source;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-test-results-offline-'));
  fake.autoReady = true;
  fake.releaseReady = undefined;
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

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > timeoutMs) throw new Error('시간 안에 끝나지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('서비스가 기동 중일 때도 사이드카의 마지막 실행 결과를 보여준다(58번 버그)', () => {
  it('재시작 직후(서비스가 아직 starting) "테스트" 탭은 빈 화면이 아니라 사이드카 결과를 행으로 보여주고, 실행 버튼은 막는다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const sha = getSnapshot(id)!.checkpoints[0]!.sha;
    await runSessionTests(id, { service: 'web' });

    await stopSession(id);

    // 이어서 작업을 시작하되, 샌드박스가 기동을 끝내지 못하게 묶어 둔다(재시작 직후 "기동 중" 구간을 흉내 낸다)
    fake.autoReady = false;
    await resumeSession(id);
    expect(getSnapshot(id)!.services.find((service) => service.name === 'web')?.state).not.toBe('ready');

    const offline = await getSessionTests(id);
    const web = offline.services.find((service) => service.service === 'web');
    expect(web?.error).toBeUndefined();
    expect(web?.notice).toBeDefined();
    // 실행 버튼은 여전히 막는다(서비스가 떠야만 테스트를 돌릴 수 있다)
    expect(web?.supported).toBe(false);
    expect(web?.running).toBe(false);
    // 행은 비지 않는다 — 사이드카의 마지막 실행에서 되살렸다
    expect(web?.rows).toHaveLength(1);
    expect(web?.rows[0]).toMatchObject({ status: 'pass', requirementIds: ['R7'] });
    // 지금 체크포인트와 같은 sha이므로 "올리기 전 점검"·요구사항 증거 규칙(testRunMatchesHead)이 그대로 적용된다
    expect(web?.lastRunSha).toBe(sha);

    const evidence = buildRequirementTestRunEvidence(offline.services, 'R7', { sha, shortSha: sha.slice(0, 7) }, 0);
    expect(evidence).toMatchObject({ passed: 1, failed: 0 });

    // 기동이 끝나면(ready) 평소대로 발견 단계를 거친 행으로 돌아온다
    fake.autoReady = true;
    fake.releaseReady?.();
    expect(await waitForReady(id)).toBe('ready');
    await waitFor(() => getSnapshot(id)!.services.find((service) => service.name === 'web')?.state === 'ready');

    const online = await getSessionTests(id);
    const webOnline = online.services.find((service) => service.service === 'web');
    expect(webOnline?.supported).toBe(true);
    expect(webOnline?.notice).toBeUndefined();

    await stopSession(id).catch(() => {});
  }, 20_000);
});
