import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 테스트 탭 실행 결과 사이드카(.git/b-studio/test-results.json, 다그푸딩 불편 55)를 실제 sessions.ts 코드로 끝까지
 * 돌려 본다. requirements-draft.json(ADR-097 개정)과 같은 자리(.git/ 아래)에 남겨 스튜디오 서버가 재시작해도
 * (이 테스트에서는 세션을 멈추고 다시 이어서 작업하는 resumeSession으로 흉내 낸다 — 세션 객체를 통째로 새로 만든다)
 * "올리기 전 점검"·요구사항 증거로 치던 실행 결과가 사라지지 않는지 본다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 사이드카 파일, 세션을 멈추고 이어서 작업하기(resumeSession).
 * 가짜로 바꾸는 것: 샌드박스(Docker) exec — 실제 vitest를 돌리지 않고 빈 보고서를 돌려준다(이 테스트가 보는 것은
 * "실행 결과가 사이드카에 남고 복원되는지"이지 파서 자체는 test-results.ts 쪽 단위 테스트가 이미 본다).
 */
const fake = vi.hoisted(() => ({
  root: '',
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-test-results-fake',
    name: 'fake',
    async start(options?: { onStatus?: (event: { service: string; phase: string; endpoint?: unknown }) => void; services?: readonly string[] }) {
      // 실제 Docker 기동 없이 "테스트" 탭이 서비스 실행을 받으려면 필요한 ready 상태를 바로 알린다
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
    async exec() {
      // 빈 결과: 실제 vitest를 돌리지 않고 "보고서가 비었다"로 처리한다 — 그래도 실행 자체는 기록·저장된다
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async execToFile() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async execFromFile() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    redact: (text: string) => text,
    findSecrets: (text: string) => (text.includes('sk_live_') ? ['FAKE_TOKEN'] : []),
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

import { buildChecklistTestEvidence, createSession, getSessionTests, getSnapshot, resumeSession, runSessionTests, stopSession } from './sessions';

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
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  fake.root = source;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-test-results-'));
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

describe('테스트 탭 실행 결과 사이드카(.git/b-studio/test-results.json, 다그푸딩 불편 55)', () => {
  it('"전체 실행"을 돌리면 체크포인트 sha와 함께 사이드카 파일에 남긴다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;
    const sha = getSnapshot(id)!.checkpoints[0]!.sha;

    await runSessionTests(id, { service: 'web' });

    const file = path.join(workDir, '.git', 'b-studio', 'test-results.json');
    const persisted = JSON.parse(await readFile(file, 'utf8')) as { version: number; results: Record<string, { sha?: string; source: string }> };
    expect(persisted.version).toBe(1);
    expect(persisted.results.web).toMatchObject({ source: 'run', sha });

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('세션을 멈췄다가 이어서 작업해도(세션 객체를 통째로 새로 만들어도) 저장해 둔 실행 결과를 복원해 보여준다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const sha = getSnapshot(id)!.checkpoints[0]!.sha;
    await runSessionTests(id, { service: 'web' });

    await stopSession(id);
    await resumeSession(id);
    expect(await waitForReady(id)).toBe('ready');

    // 이어서 작업해도 아무것도 바꾸지 않았으면 체크포인트는 그대로다 — 복원한 실행이 지금 체크포인트와 같은 sha여야 한다
    expect(getSnapshot(id)!.checkpoints[0]!.sha).toBe(sha);

    const snapshot = await getSessionTests(id);
    const web = snapshot.services.find((service) => service.service === 'web');
    expect(web?.lastRunSha).toBe(sha);
    expect(web?.lastRunSource).toBe('run');
    expect(web?.lastRunAt).toBeDefined();

    // 복원한 실행이 지금 체크포인트와 같은 sha이므로("올리기 전 점검"의 증거 규칙) 증거로 센다
    const evidence = buildChecklistTestEvidence(snapshot.services, sha, 0);
    expect(evidence.find((entry) => entry.service === 'web')?.matchesHead).toBe(true);

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('이어서 작업하는 사이에 체크포인트가 바뀌면(sha 불일치) 복원한 실행을 증거로 치지 않는다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;
    const oldSha = getSnapshot(id)!.checkpoints[0]!.sha;
    await runSessionTests(id, { service: 'web' });

    await stopSession(id);
    // 세션 밖에서(혹은 다른 체크포인트로) 코드가 바뀌어 체크포인트 sha가 달라진 상황을 흉내 낸다
    await writeFile(path.join(workDir, 'web/src/App.tsx'), 'export default function App() { return <div />; }\n');
    await git(workDir, 'add', '-A');
    await git(workDir, 'commit', '-q', '-m', 'App 수정');
    const newSha = await git(workDir, 'rev-parse', 'HEAD');
    expect(newSha).not.toBe(oldSha);

    await resumeSession(id);
    expect(await waitForReady(id)).toBe('ready');
    expect(getSnapshot(id)!.checkpoints[0]!.sha).toBe(newSha);

    const snapshot = await getSessionTests(id);
    const web = snapshot.services.find((service) => service.service === 'web');
    // 사이드카에서 복원한 실행은 여전히 (이제는 낡은) 예전 sha를 들고 있다 — 테스트 탭에는 "이전 실행"으로 그대로 보인다
    expect(web?.lastRunSha).toBe(oldSha);

    const evidence = buildChecklistTestEvidence(snapshot.services, newSha, 0);
    expect(evidence.find((entry) => entry.service === 'web')?.matchesHead).toBe(false);

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('사이드카 파일이 깨져 있으면 조용히 무시하고(테스트 탭이 그대로 뜬다) 로그만 남긴다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;
    const file = path.join(workDir, '.git', 'b-studio', 'test-results.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{이것은 깨진 JSON입니다');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const snapshot = await getSessionTests(id);

    const web = snapshot.services.find((service) => service.service === 'web');
    expect(web?.lastRunSha).toBeUndefined();
    expect(web?.lastRunAt).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();

    await stopSession(id).catch(() => {});
  }, 20_000);
});
