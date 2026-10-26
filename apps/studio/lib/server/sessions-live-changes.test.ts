import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * desk의 지금 변경 화면(#924)이 받는 작업 사본의 변경을 실제 sessions.ts 코드로 본다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 체크포인트.
 * 가짜로 바꾸는 것: 샌드박스(Docker)와 findProject. 가림은 SECRET 값 하나만 가리는 가짜 redact다.
 */
const SECRET = 'sk_test_ABCDEFGHIJKLMNOP';
const fake = vi.hoisted(() => ({
  root: '',
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-live-changes-fake',
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
    redact: (text: string) => text.replaceAll('sk_test_ABCDEFGHIJKLMNOP', '[KEY 가림]'),
    // 시크릿 거부 경로를 확인할 수 있게 "sk_live_"로 시작하는 텍스트를 시크릿으로 본다
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

import { createSession, getSnapshot, liveChanges, stopSession } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  return stdout.trim();
}

async function setupRepo(): Promise<void> {
  const source = path.join(root, 'project');
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await mkdir(path.join(source, 'api/src'), { recursive: true });
  await writeFile(
    path.join(source, 'studio.yaml'),
    `version: 1
name: redactproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
workflow:
  required: [plan, implement, run, checkpoint]
  releaseRequires: [checkpoint]
review:
  auto: false
`,
  );
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(source, 'api/src/Order.java'), 'class Order {}\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  fake.root = source;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-live-changes-'));
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

describe('지금 변경(#924)', () => {
  it('고친 파일·새 파일·지운 파일을 diff와 줄 수로 주고, 새 파일 내용도 가린다', async () => {
    await setupRepo();
    const id = (await createSession('redactproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const work = getSnapshot(id)!.workDir;
    await writeFile(path.join(work, 'api/src/Order.java'), 'class Order {\n  int total;\n}\n');
    await writeFile(path.join(work, 'api/src/Note.txt'), `첫 줄\n키: ${SECRET}\n`);
    await rm(path.join(work, 'compose.yaml'));

    const changes = await liveChanges(id);
    const byFile = Object.fromEntries(changes.files.map((file) => [file.file, file]));
    expect(byFile['api/src/Order.java']).toMatchObject({ change: 'modified', added: 3, removed: 1 });
    expect(byFile['api/src/Order.java']!.patch).toContain('+  int total;');
    expect(byFile['compose.yaml']).toMatchObject({ change: 'deleted', removed: 2 });
    const note = byFile['api/src/Note.txt']!;
    expect(note).toMatchObject({ change: 'added', added: 2, removed: 0 });
    expect(note.patch).toContain('+++ b/api/src/Note.txt');
    expect(note.patch).toContain('+키: [KEY 가림]');
    expect(note.patch).not.toContain(SECRET);
    expect(changes.truncated).toBe(false);
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('바이너리는 내용 없이 표시하고, 비밀 파일은 빼고, 큰 새 파일은 자른다', async () => {
    await setupRepo();
    const id = (await createSession('redactproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const work = getSnapshot(id)!.workDir;
    await writeFile(path.join(work, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    await writeFile(path.join(work, '.env'), 'TOKEN=abc\n');
    await writeFile(path.join(work, 'big.txt'), `${'가'.repeat(80)}\n`.repeat(4_000));

    const changes = await liveChanges(id);
    const files = changes.files.map((file) => file.file);
    expect(files).not.toContain('.env');
    expect(changes.files.find((file) => file.file === 'logo.png')).toMatchObject({ change: 'added', binary: true });
    expect(changes.files.find((file) => file.file === 'logo.png')!.patch).toBeUndefined();
    const big = changes.files.find((file) => file.file === 'big.txt')!;
    expect(big.truncated).toBe(true);
    expect(big.patch!.length).toBeLessThan(120_000);
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('바뀐 것이 없으면 빈 목록이다', async () => {
    await setupRepo();
    const id = (await createSession('redactproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const changes = await liveChanges(id);
    expect(changes.files).toEqual([]);
    expect(changes.head).toMatch(/^[0-9a-f]{7,}$/);
    await stopSession(id).catch(() => {});
  }, 20_000);
});
