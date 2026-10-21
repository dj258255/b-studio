import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import type { StudioEvent } from '@/lib/studio-events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 내 폴더 세션에서 요청 사이에 쌓인 변경은 다음 요청을 시작할 때 "직접 수정" 체크포인트로 남는다. 검증 게이트를 거치지 않은
 * 체크포인트라 releaseRequires를 적지 않은 기본 설정에서도 배포하지 않는다(#772).
 * 진짜로 하는 것: 내 폴더 git 저장소, 체크포인트, 배포 조건 판정. 가짜로 바꾸는 것: 샌드박스(Docker), 모델(대본), 배포기.
 */
const fake = vi.hoisted(() => ({ root: '', deployed: 0 }));

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

// 배포가 막히지 않았을 때 실제 이미지를 빌드하지 않게 한다. 불렸는지만 센다
vi.mock('@b-studio/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/agent')>();
  return {
    ...actual,
    DockerDeployer: class {
      async deploy(): Promise<never> {
        fake.deployed += 1;
        throw new Error('테스트에서는 배포하지 않습니다');
      }
    },
  };
});

import { createSession, deploySession, getSnapshot, sendMessage, stopSession, subscribe } from './sessions';

let root: string;
const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR };

async function makeProject(projectDir: string, releaseRequires?: string): Promise<void> {
  await mkdir(path.join(projectDir, 'api', 'src'), { recursive: true });
  await writeFile(
    path.join(projectDir, 'studio.yaml'),
    `version: 1
name: localedits
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
${releaseRequires ? `workflow:\n  releaseRequires: ${releaseRequires}\n` : ''}review:
  auto: false
`,
  );
  await writeFile(path.join(projectDir, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(projectDir, 'api', 'src', 'Order.java'), 'class Order {}\n');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-local-edits-release-'));
  fake.deployed = 0;
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'local',
    GIT_AUTHOR_EMAIL: 'local@example.com',
    GIT_COMMITTER_NAME: 'local',
    GIT_COMMITTER_EMAIL: 'local@example.com',
    B_STUDIO_GIT_AUTHOR_NAME: 'local',
    B_STUDIO_GIT_AUTHOR_EMAIL: 'local@example.com',
  });
});

afterAll(() => {
  for (const [key, value] of [['B_STUDIO_MODE', saved.mode], ['B_STUDIO_AUTH', saved.auth], ['B_STUDIO_SESSIONS_DIR', saved.sessions]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('기대한 상태가 되지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 사람이 IDE에서 파일을 고친 뒤 다음 요청을 보낸다. 요청은 파일을 바꾸지 않고 끝나 직접 수정 체크포인트가 맨 위에 남는다 */
async function editThenAsk(releaseRequires?: string): Promise<string> {
  const projectDir = path.join(root, 'my-project');
  await makeProject(projectDir, releaseRequires);
  fake.root = projectDir;
  const id = (await createSession('localedits', 'kim', 'local')).id;
  await waitFor(() => (getSnapshot(id)?.status === 'ready' ? true : undefined));

  await writeFile(path.join(projectDir, 'api', 'src', 'Order.java'), 'class Order { String memo; }\n');
  const events: StudioEvent[] = [];
  const unsubscribe = subscribe(id, (event) => events.push(event));
  sendMessage(id, '설명만 해 주세요', { allowBreaking: false, scriptedTurns: [{ text: '바꾼 것이 없습니다.' }] });
  await waitFor(() => events.find((event) => event.type === 'run_finished'));
  unsubscribe();
  return id;
}

describe('직접 수정 체크포인트의 배포(#772)', () => {
  it('releaseRequires를 적지 않으면 직접 수정 체크포인트를 배포하지 않고 이유를 알린다', async () => {
    const id = await editThenAsk();
    const latest = getSnapshot(id)!.checkpoints[0]!;
    expect(latest.message).toMatch(/^직접 수정/);
    expect(latest.verify).toBe('unverified');

    expect(() => deploySession(id, { by: 'kim' })).toThrow(/검증 게이트를 거치지 않은 직접 수정 체크포인트/);
    expect(fake.deployed).toBe(0);
    await stopSession(id).catch(() => {});
  }, 60_000);

  it('releaseRequires: [checkpoint]를 직접 적은 프로젝트는 지금처럼 배포를 시작한다', async () => {
    const id = await editThenAsk('[checkpoint]');
    expect(getSnapshot(id)!.checkpoints[0]!.verify).toBe('unverified');

    expect(() => deploySession(id, { by: 'kim' })).not.toThrow();
    // 거절하지 않고 배포 작업을 시작했다(실제 빌드는 가짜 배포기가 막는다)
    expect(getSnapshot(id)!.deploying).toBeDefined();
    await stopSession(id).catch(() => {});
  }, 60_000);
});
