import { mkdir, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 내 폴더 세션의 폴더 점유(트러블슈팅 214, ADR-205). 두 세션이 같은 폴더를 다른 글자(링크로 만든 별칭·끝의 `/`·대소문자만 다른 경로)로 가리켜도 같은 폴더면 둘째를 시작하지 못한다.
 * 같은 폴더인지는 이 기기의 파일 시스템을 기준으로 적지 않고 `stat`으로 먼저 본다. 모든 폴더는 임시 폴더 안에 만든다.
 * 진짜로 하는 것: 내 폴더 git 저장소, 체크포인트, 폴더 점유. 가짜로 바꾸는 것: 샌드박스(Docker).
 */
const fake = vi.hoisted(() => ({ root: '' }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-local-edits-release-fake',
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

vi.mock('./projects', () => ({
  findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root),
}));

import { createSession, getSnapshot, stopSession } from './sessions';

let root: string;
const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR };

async function makeProject(projectDir: string): Promise<void> {
  await mkdir(path.join(projectDir, 'api', 'src'), { recursive: true });
  await writeFile(path.join(projectDir, 'studio.yaml'), `version: 1\nname: claimproj\nservices:\n  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }\nreview:\n  auto: false\n`);
  await writeFile(path.join(projectDir, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(projectDir, 'api', 'src', 'Order.java'), 'class Order {}\n');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-folder-claim-'));
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'claim', GIT_AUTHOR_EMAIL: 'claim@example.com', GIT_COMMITTER_NAME: 'claim', GIT_COMMITTER_EMAIL: 'claim@example.com', B_STUDIO_GIT_AUTHOR_NAME: 'claim', B_STUDIO_GIT_AUTHOR_EMAIL: 'claim@example.com' });
});

afterAll(() => {
  for (const [key, value] of [['B_STUDIO_MODE', saved.mode], ['B_STUDIO_AUTH', saved.auth], ['B_STUDIO_SESSIONS_DIR', saved.sessions]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function sameFolder(a: string, b: string): Promise<boolean> {
  const [first, second] = await Promise.all([stat(a).catch(() => undefined), stat(b).catch(() => undefined)]);
  return first !== undefined && second !== undefined && first.dev === second.dev && first.ino === second.ino;
}

/** 첫 세션이 폴더를 쓰고 있는 채로 둘째를 같은 폴더의 다른 글자로 시작해 본다 */
async function startSecond(alias: string): Promise<{ first: string; second?: string; error?: unknown }> {
  const projectDir = path.join(root, 'my-project');
  await makeProject(projectDir);
  fake.root = projectDir;
  const first = (await createSession('claimproj', 'kim', 'local')).id;
  fake.root = alias;
  try {
    const second = (await createSession('claimproj', 'kim', 'local')).id;
    return { first, second };
  } catch (error) {
    return { first, error };
  } finally {
    fake.root = projectDir;
  }
}

describe('내 폴더 세션의 폴더 점유: 같은 폴더를 다른 글자로 가리켜도 둘째를 시작하지 못한다', () => {
  it('링크로 만든 별칭', async () => {
    const projectDir = path.join(root, 'my-project');
    const alias = path.join(root, 'alias-link');
    await makeProject(projectDir);
    await symlink(projectDir, alias);
    expect(await sameFolder(projectDir, alias)).toBe(true);
    const result = await startSecond(alias);
    expect(result.second, '둘째 세션이 같은 폴더에서 시작됐다').toBeUndefined();
    expect(String(result.error)).toMatch(/이 폴더는 세션 [0-9a-f]+에서 작업하고 있습니다/);
    await stopSession(result.first).catch(() => {});
  }, 60_000);

  it('끝의 /', async () => {
    const projectDir = path.join(root, 'my-project');
    const alias = `${projectDir}/`;
    await makeProject(projectDir);
    expect(await sameFolder(projectDir, alias)).toBe(true);
    const result = await startSecond(alias);
    // loadProject가 끝의 /를 지워 돌려주면 글자가 같아져 옛 검사도 막는다. 막혀야 한다는 것이 이 시험이다
    expect(result.second, '둘째 세션이 같은 폴더에서 시작됐다').toBeUndefined();
    expect(String(result.error)).toMatch(/이 폴더는 세션 [0-9a-f]+에서 작업하고 있습니다/);
    await stopSession(result.first).catch(() => {});
  }, 60_000);

  it('대소문자만 다른 경로는 같은 폴더일 때만 막힌다(기대값은 stat으로 정한다)', async () => {
    const projectDir = path.join(root, 'My-Project');
    const alias = path.join(root, 'my-project');
    await makeProject(projectDir);
    const same = await sameFolder(projectDir, alias);
    fake.root = projectDir;
    const first = (await createSession('claimproj', 'kim', 'local')).id;
    fake.root = alias;
    let second: string | undefined;
    let error: unknown;
    try {
      second = (await createSession('claimproj', 'kim', 'local')).id;
    } catch (caught) {
      error = caught;
    }
    if (same) {
      expect(second, '대소문자만 다른 같은 폴더에서 둘째 세션이 시작됐다').toBeUndefined();
      expect(String(error)).toMatch(/이 폴더는 세션 [0-9a-f]+에서 작업하고 있습니다/);
    } else {
      // 대소문자를 구분하는 볼륨에서 alias는 없는 폴더다: 막지 않고 뒤 단계가 프로젝트를 읽지 못해 거절한다
      expect(String(error)).not.toMatch(/이 폴더는 세션/);
    }
    await stopSession(first).catch(() => {});
    if (second) await stopSession(second).catch(() => {});
  }, 60_000);

  it('다른 폴더는 막지 않는다', async () => {
    const projectDir = path.join(root, 'my-project');
    const other = path.join(root, 'other-project');
    await makeProject(projectDir);
    await makeProject(other);
    expect(await sameFolder(projectDir, other)).toBe(false);
    const result = await startSecond(other);
    expect(result.error).toBeUndefined();
    expect(result.second).toBeDefined();
    expect(getSnapshot(result.second!)?.workDir).toBeDefined();
    await stopSession(result.first).catch(() => {});
    await stopSession(result.second!).catch(() => {});
  }, 60_000);
});
