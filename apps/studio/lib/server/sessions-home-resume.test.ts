import { execFile, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 이어받기는 저장 파일의 작업 폴더가 그 세션을 읽어 온 폴더일 때만 한다(ADR-204, 4f B2a).
 * 옛 구현은 저장 파일의 `workDir`로 `CheckpointStore`를 열어 끝내지 못한 변경을 되돌리는 `git clean`·`reset`을 불렀다.
 * 저장 파일이 다른 폴더를 가리키면 그 폴더의 변경이 버려졌다. 모든 폴더는 임시 폴더 안에 만든다. 가짜로 바꾸는 것은 샌드박스(Docker)뿐이다.
 */
const fake = vi.hoisted(() => ({ root: '' }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-resume-spec-error-fake',
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
    findSecrets: () => [],
    async callExternal() {
      return { decision: 'deny' as const, status: 404, body: '', masked: 0 };
    },
    async destroy() {},
  } as unknown as Sandbox;
  return { ...actual, providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox, cleanup: async () => {} }) };
});

vi.mock('./projects', () => ({
  findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root),
}));

import { getSnapshot, recoverSessions, resumeSession } from './sessions';

let tmp: string;
const saved = { mode: process.env.B_STUDIO_MODE, sessions: process.env.B_STUDIO_SESSIONS_DIR };
const deadPid = spawnSync('true').pid;
const git = (cwd: string, ...args: string[]) =>
  execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);

const YAML = `version: 1
name: homeproj
services:
  web: { source: managed, template: nextjs, path: web, port: 3000, preview: browser }
`;

/** 임시 폴더 안의 git 저장소: 커밋된 프로젝트와 아직 커밋하지 않은 파일(지우면 안 되는 것) */
async function precious(name: string): Promise<{ dir: string; file: string }> {
  const dir = path.join(tmp, name);
  await execFileAsync('git', ['init', '-q', '-b', 'main', dir]);
  await writeFile(path.join(dir, 'studio.yaml'), YAML);
  await mkdir(path.join(dir, 'web'), { recursive: true });
  await writeFile(path.join(dir, 'compose.yaml'), 'services:\n  web: { build: ./web }\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'init');
  const file = path.join(dir, 'precious.txt');
  await writeFile(file, '아직 커밋하지 않은 소중한 파일');
  return { dir, file };
}

function forged(id: string, snapshot: Record<string, unknown>, sandboxId = 'studio-homeproj-abcdef'): string {
  return JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    owner: { pid: deadPid },
    snapshot: { id, projectId: 'p', projectName: 'homeproj', status: 'stopped', mode: 'api', backend: 'api', running: false, services: [], checkpoints: [], ...snapshot },
    history: [],
    conversation: [],
    demoIndex: 0,
    claudeCode: { notes: [] },
    sourceDirtyFiles: 0,
    sandbox: { id: sandboxId, provider: 'fake' },
  });
}

async function sessionFolder(sessions: string, id: string, snapshot: Record<string, unknown>, sandboxId?: string): Promise<string> {
  const dir = path.join(sessions, `p-${id}`);
  await mkdir(path.join(dir, '.git', 'b-studio'), { recursive: true });
  await writeFile(path.join(dir, '.git', 'b-studio', 'session.json'), forged(id, snapshot, sandboxId));
  return dir;
}

const exists = (file: string) => access(file).then(() => true, () => false);

let outside: { dir: string; file: string };
let linked: { dir: string; file: string };
let local: { dir: string; file: string };
let cleaned: { dir: string; home: string };

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'b-studio-home-resume-'));
  const sessions = path.join(tmp, 'sessions');
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = sessions;
  Object.assign(process.env, { B_STUDIO_GIT_AUTHOR_NAME: 'verify', B_STUDIO_GIT_AUTHOR_EMAIL: 'verify@example.com' });
  fake.root = path.join(tmp, 'unused');
  await mkdir(sessions, { recursive: true });

  // 1. 작업 복사본 세션의 저장 파일이 저장소 밖의 다른 폴더를 가리킨다
  outside = await precious('outside-project');
  await sessionFolder(sessions, 'cccc0001', { workDir: outside.dir });
  // 2. 세션 폴더 안의 링크를 지나 저장소 밖을 가리킨다
  linked = await precious('linked-project');
  const dir = await sessionFolder(sessions, 'cccc0002', { workDir: '' });
  await symlink(linked.dir, path.join(dir, 'link'));
  await writeFile(path.join(dir, '.git', 'b-studio', 'session.json'), forged('cccc0002', { workDir: path.join(dir, 'link') }));
  // 3. 내 폴더 세션의 상태 폴더가 저장소 밖을 가리킨다(사용자 폴더는 따로 있다)
  local = await precious('user-project');
  const userFolder = path.join(tmp, 'user-folder');
  await mkdir(userFolder, { recursive: true });
  await sessionFolder(sessions, 'cccc0003', { workDir: userFolder, workspace: 'local', stateDir: local.dir });

  // 4. 서버가 멈춰 끝나지 못한 세션(샌드박스를 정리하고 상태를 저장한다). 저장 파일의 stateDir이 저장소 밖을 가리킨다. 샌드박스 id의 꼴을 틀리게 해 터미널(docker) 정리는 건너뛴다
  const stale = path.join(tmp, 'stale-target');
  await mkdir(stale, { recursive: true });
  const staleHome = await sessionFolder(sessions, 'cccc0004', { workDir: userFolder, workspace: 'local', stateDir: stale, status: 'ready' }, 'not-a-b-studio-id');
  cleaned = { dir: stale, home: staleHome };

  await recoverSessions();
});

afterAll(() => {
  if (saved.mode === undefined) delete process.env.B_STUDIO_MODE;
  else process.env.B_STUDIO_MODE = saved.mode;
  if (saved.sessions === undefined) delete process.env.B_STUDIO_SESSIONS_DIR;
  else process.env.B_STUDIO_SESSIONS_DIR = saved.sessions;
});

const attempt = (id: string) => resumeSession(id).then(() => undefined, (error: unknown) => error as { status?: number; message: string });

describe('세션 이어받기는 저장 파일의 폴더가 읽어 온 폴더일 때만 한다', () => {
  it('저장 파일이 다른 폴더를 가리키면 그 폴더의 변경을 버리지 않고 거부한다', async () => {
    const error = await attempt('cccc0001');
    expect(await readFile(outside.file, 'utf8')).toBe('아직 커밋하지 않은 소중한 파일');
    expect(error).toMatchObject({ status: 409, message: expect.stringContaining('이 세션의 폴더와 달라') });
  }, 20_000);

  it('세션 폴더 안의 링크를 지나 저장소 밖을 가리켜도 거부한다', async () => {
    const error = await attempt('cccc0002');
    expect(await readFile(path.join(linked.dir, 'precious.txt'), 'utf8')).toBe('아직 커밋하지 않은 소중한 파일');
    expect(await exists(path.join(linked.dir, '.git', 'b-studio'))).toBe(false);
    expect(error).toMatchObject({ status: 409 });
  }, 20_000);

  it('내 폴더 세션의 상태 폴더가 다른 폴더를 가리키면 그 폴더에 체크포인트를 남기지 않고 거부한다', async () => {
    const error = await attempt('cccc0003');
    expect(await readFile(local.file, 'utf8')).toBe('아직 커밋하지 않은 소중한 파일');
    expect(error).toMatchObject({ status: 409 });
  }, 20_000);
});

describe('복구가 정리한 세션의 저장은 읽어 온 폴더에 한다', () => {
  it('저장 파일의 stateDir이 다른 폴더를 가리켜도 그 폴더에 세션 파일을 쓰지 않는다', async () => {
    // 샌드박스 정리가 끝나면 세션 파일을 다시 쓴다(주인 pid가 이 프로세스로 바뀐다). 쓰는 곳은 읽어 온 폴더여야 한다
    const file = path.join(cleaned.home, '.git', 'b-studio', 'session.json');
    const started = Date.now();
    for (;;) {
      const owner = (JSON.parse(await readFile(file, 'utf8')) as { owner: { pid: number } }).owner.pid;
      if (owner === process.pid) break;
      if (Date.now() - started > 10_000) throw new Error(`정리한 세션이 저장되지 않았습니다(${getSnapshot('cccc0004')?.error ?? ''})`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await exists(path.join(cleaned.dir, '.git'))).toBe(false);
  }, 20_000);
});
