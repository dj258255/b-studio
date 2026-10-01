import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import type { StudioEvent } from '@/lib/studio-events';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * "절대 조용히 지우지 않는다"(ADR-0XX)를 실제 sessions.ts 코드로 끝까지 돌려 본다. 중지한 세션을 "이어서
 * 작업"할 때(resumeSession) 끝내지 못한 요청이 남긴 변경을 버리는 경로가, 문서는 체크포인트로 지키고(docs 체크
 * 포인트가 실패해 아직 커밋되지 않은 채였다고 해도) 남은 변경은 버리기 전에 백업해 되살릴 수 있게 하는지 본다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 체크포인트, discard()의 백업·되살리기.
 * 가짜로 바꾸는 것: 샌드박스(Docker)와 findProject(파일을 읽어 그대로 쓴다). 실제 Docker 호출은 없다.
 */
const fake = vi.hoisted(() => ({
  root: '',
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-protect-discard-fake',
    name: 'fake',
    async start() {
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

import { createSession, getSnapshot, resumeSession, restoreDiscardedBackup, stopSession, subscribe } from './sessions';

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
  await mkdir(path.join(source, 'api/src'), { recursive: true });
  await writeFile(path.join(source, 'studio.yaml'), studioYaml());
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(source, 'api/src/Order.java'), 'class Order {}\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  fake.root = source;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-protect-discard-'));
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

async function waitForReady(id: string, timeoutMs = 10_000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const status = getSnapshot(id)?.status ?? 'missing';
    if (status === 'ready' || status === 'failed' || status === 'stopped') return status;
    if (Date.now() - started > timeoutMs) throw new Error(`세션이 준비되지 않았습니다 (${status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('기대한 상태가 되지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('이어서 작업하기가 버리기 전에 지키고 백업한다(ADR-0XX, "절대 조용히 지우지 않는다")', () => {
  it('문서는 체크포인트로 지키고, 남은 변경은 버리기 전에 백업해 되살릴 수 있게 한다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));

    await stopSession(id);
    // 끝내지 못한 요청이 남긴 변경을 흉내 낸다: 문서 체크포인트 커밋이 실패해 아직 커밋되지 않은 문서,
    // 그리고 검증을 통과하지 못한 코드 변경이 함께 작업 복사본에 pending으로 남아 있다
    await mkdir(path.join(workDir, 'docs'), { recursive: true });
    await writeFile(path.join(workDir, 'docs/requirements.md'), '# 요구사항\n\n- R1 로그인\n');
    await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String broken; }\n');

    await resumeSession(id);
    expect(await waitForReady(id)).toBe('ready');

    // 1) 문서는 사라지지 않고 체크포인트로 남았다
    const checkpoints = getSnapshot(id)!.checkpoints;
    expect(checkpoints[0]).toMatchObject({ files: ['docs/requirements.md'], verify: 'docs' });
    expect(await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8')).toBe('# 요구사항\n\n- R1 로그인\n');

    // 2) 문서가 아닌 변경(검증을 통과하지 못한 코드)은 작업 복사본에서는 버려졌지만 백업이 남았다
    expect(await readFile(path.join(workDir, 'api/src/Order.java'), 'utf8')).toBe('class Order {}\n');
    const resumed = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'resumed' }> => event.type === 'resumed'));
    expect(resumed.discarded).toEqual(['api/src/Order.java']);
    expect(resumed.backup).toMatchObject({ files: ['api/src/Order.java'] });

    // 3) 백업을 되살리면 버린 코드 변경이 작업 복사본으로 그대로 돌아온다
    restoreDiscardedBackup(id, resumed.backup!.id);
    const restored = await waitFor(() =>
      events.find((event): event is Extract<StudioEvent, { type: 'backup_restored' }> => event.type === 'backup_restored'),
    );
    expect(restored.files).toEqual(['api/src/Order.java']);
    expect(await readFile(path.join(workDir, 'api/src/Order.java'), 'utf8')).toBe('class Order { String broken; }\n');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('이어서 작업할 때 버릴 변경이 없으면 백업·안내 없이 조용히 이어서 작업한다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));

    await stopSession(id);
    await resumeSession(id);
    expect(await waitForReady(id)).toBe('ready');

    const resumed = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'resumed' }> => event.type === 'resumed'));
    expect(resumed.discarded).toEqual([]);
    expect(resumed.backup).toBeUndefined();

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);
});
