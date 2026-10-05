import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** 가짜 제공자·프로젝트가 쓰는 상태. vi.mock 팩토리에서 쓰려고 hoisted로 둔다 */
const fake = vi.hoisted(() => ({ root: '' }));

// 샌드박스(Docker)를 띄우지 않는다. providerFromEnv만 가짜로 바꾸고 나머지는 그대로 쓴다(세션 만들기·중지·체크포인트는 실제 코드가 돈다)
vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-delete-fake',
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
  return { ...actual, providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox }) };
});

// 프로젝트 탐색만 임시 폴더의 studio.yaml로 바꾼다(작업 복사본·체크포인트·기동 흐름은 실제 코드가 돈다)
vi.mock('./projects', () => ({
  findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root),
}));

import { createSession, deleteSession, getSnapshot, stopSession } from './sessions';

let root: string;
const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR };

async function makeProject(projectDir: string, name: string): Promise<void> {
  await mkdir(path.join(projectDir, 'api', 'src'), { recursive: true });
  await writeFile(
    path.join(projectDir, 'studio.yaml'),
    `version: 1
name: ${name}
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
`,
  );
  await writeFile(path.join(projectDir, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(projectDir, 'api', 'src', 'Order.java'), 'class Order {}\n');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-delete-session-'));
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'del', GIT_AUTHOR_EMAIL: 'del@example.com', GIT_COMMITTER_NAME: 'del', GIT_COMMITTER_EMAIL: 'del@example.com' });
});

afterAll(() => {
  for (const [key, value] of [['B_STUDIO_MODE', saved.mode], ['B_STUDIO_AUTH', saved.auth], ['B_STUDIO_SESSIONS_DIR', saved.sessions]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

describe('세션 기록 지우기', () => {
  it('작업 복사본 세션은 중지한 뒤에만 지울 수 있고, 지우면 작업 복사본 폴더가 사라진다', async () => {
    const projectDir = path.join(root, 'project');
    await makeProject(projectDir, 'delproj');
    fake.root = projectDir;

    const created = await createSession('delproj', 'kim', 'copy');
    expect(await exists(created.workDir)).toBe(true);

    // 실행 중(샌드박스가 떠 있음)에는 지울 수 없다
    await expect(deleteSession(created.id)).rejects.toThrow(/먼저 샌드박스를 중지/);
    expect(await exists(created.workDir)).toBe(true);

    await stopSession(created.id);
    await deleteSession(created.id);

    expect(getSnapshot(created.id)).toBeUndefined();
    expect(await exists(created.workDir)).toBe(false);
    // 이미 지운 세션을 다시 지우려 하면 찾을 수 없다고 알린다
    await expect(deleteSession(created.id)).rejects.toThrow(/찾을 수 없습니다/);
  });

  it('내 폴더 세션은 상태 폴더만 지우고 사용자의 폴더는 절대 건드리지 않는다', async () => {
    const projectDir = path.join(root, 'my-project');
    await makeProject(projectDir, 'localproj');
    fake.root = projectDir;

    const created = await createSession('localproj', 'kim', 'local');
    expect(created.workDir).toBe(projectDir);
    expect(created.stateDir).toBeDefined();
    expect(await exists(created.stateDir!)).toBe(true);

    await stopSession(created.id);
    await deleteSession(created.id);

    expect(getSnapshot(created.id)).toBeUndefined();
    // 상태 폴더(b-studio 기록)는 지워졌다
    expect(await exists(created.stateDir!)).toBe(false);
    // 사용자의 실제 폴더와 그 안의 파일은 그대로 남아 있다
    expect(await exists(created.workDir)).toBe(true);
    expect(await readFile(path.join(created.workDir, 'studio.yaml'), 'utf8')).toContain('name: localproj');
  });
});
