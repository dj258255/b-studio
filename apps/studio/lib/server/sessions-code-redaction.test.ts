import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 코드 탭 diff와 체크포인트 diff가 시크릿을 가리는지 실제 sessions.ts 코드로 본다(#751).
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
    id: 'studio-code-redaction-fake',
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

import { checkpointPatch, commitWorkingCopyDocs, createSession, getSnapshot, readCodeFile, stopSession } from './sessions';

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
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-code-redaction-'));
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

describe('코드 탭과 체크포인트 diff의 시크릿 가림 (#751)', () => {
  it('코드 탭 diff는 20만 자 경계에 걸친 시크릿의 앞부분도 남기지 않는다', async () => {
    await setupRepo();
    const id = (await createSession('redactproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const file = path.join(getSnapshot(id)!.workDir, 'api/src/Order.java');
    await writeFile(file, `${'a'.repeat(10)}\n`);
    const header = (await readCodeFile(id, 'api/src/Order.java')).patch!.indexOf(`+${'a'.repeat(10)}`) + 1;
    await writeFile(file, `${'a'.repeat(200_000 - header - 6)}${SECRET}\n`);

    const opened = await readCodeFile(id, 'api/src/Order.java');
    expect(opened.patch).toContain('길어서');
    expect(opened.patch).not.toContain(SECRET.slice(0, 6));
    expect(opened.content).toContain('[KEY 가림]');
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('체크포인트 diff도 가린다', async () => {
    await setupRepo();
    const id = (await createSession('redactproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    await mkdir(path.join(getSnapshot(id)!.workDir, 'docs'), { recursive: true });
    await writeFile(path.join(getSnapshot(id)!.workDir, 'docs/notes.md'), `키: ${SECRET}\n`);
    const checkpoint = await commitWorkingCopyDocs(id, ['docs/notes.md'], '문서: 메모');

    const patch = await checkpointPatch(id, checkpoint!.sha);
    expect(patch).toContain('[KEY 가림]');
    expect(patch).not.toContain(SECRET);
    await stopSession(id).catch(() => {});
  }, 20_000);
});
