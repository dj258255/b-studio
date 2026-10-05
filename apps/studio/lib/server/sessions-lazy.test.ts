import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** 가짜 제공자·프로젝트가 쓰는 상태. vi.mock 팩토리에서 쓰려고 hoisted로 둔다 */
const fake = vi.hoisted(() => ({
  root: '',
  startCalls: 0,
  startError: undefined as string | undefined,
}));

// 샌드박스(Docker)를 띄우지 않는다. providerFromEnv만 가짜로 바꾸고 나머지는 그대로 쓴다
vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-lazy-fake',
    name: 'fake',
    async start() {
      fake.startCalls += 1;
      if (fake.startError) throw new Error(fake.startError);
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

import { bootSession, createSession, getSnapshot, sendMessage, stopSession, subscribe } from './sessions';

let root: string;
const saved = { mode: process.env.B_STUDIO_MODE, backend: process.env.B_STUDIO_BACKENDS, sessions: process.env.B_STUDIO_SESSIONS_DIR };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-lazy-session-'));
  await mkdir(path.join(root, 'project', 'api'), { recursive: true });
  await writeFile(
    path.join(root, 'project', 'studio.yaml'),
    `version: 1
name: lazyproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
`,
  );
  await writeFile(path.join(root, 'project', 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  fake.root = path.join(root, 'project');
  fake.startCalls = 0;
  fake.startError = undefined;
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  delete process.env.B_STUDIO_BACKENDS;
  // 체크포인트를 남기는 git 커밋이 서명 없이도 되게 한다
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'lazy', GIT_AUTHOR_EMAIL: 'lazy@example.com', GIT_COMMITTER_NAME: 'lazy', GIT_COMMITTER_EMAIL: 'lazy@example.com' });
});

afterAll(() => {
  for (const [key, value] of [['B_STUDIO_MODE', saved.mode], ['B_STUDIO_BACKENDS', saved.backend], ['B_STUDIO_SESSIONS_DIR', saved.sessions]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

describe('샌드박스 지연 기동', () => {
  it('on-demand로 만들면 샌드박스를 켜지 않고 idle로 시작한다(서비스도 꺼짐)', async () => {
    const snapshot = await createSession('lazyproj', 'kim', 'copy', { boot: 'on-demand' });
    const created = snapshot.id;

    expect(snapshot.status).toBe('idle');
    expect(fake.startCalls).toBe(0);
    expect(snapshot.services.every((service) => service.state === 'stopped')).toBe(true);
    // 잠깐 기다려도 켜지지 않는다(지연 기동)
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(getSnapshot(created)?.status).toBe('idle');
    await stopSession(created).catch(() => {});
  });

  it('boot API로 켜면 ready가 되고, 동시에 두 번 불러도 한 번만 켠다', async () => {
    const created = (await createSession('lazyproj', 'kim', 'copy', { boot: 'on-demand' })).id;

    const [first, second] = await Promise.all([bootSession(created), bootSession(created)]);

    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
    expect(fake.startCalls).toBe(1);
    expect(getSnapshot(created)?.status).toBe('ready');
    await stopSession(created).catch(() => {});
  });

  it('기본(eager)은 지금처럼 만들 때 켠다', async () => {
    const created = (await createSession('lazyproj', 'kim', 'copy')).id;

    expect(await waitForReady(created)).toBe('ready');
    expect(fake.startCalls).toBe(1);
    await stopSession(created).catch(() => {});
  });

  it('켜기 실패는 세션을 failed로 두고, 다시 켜려 하면 이유와 함께 거부한다', async () => {
    fake.startError = '이미지 빌드 실패';
    const created = (await createSession('lazyproj', 'kim', 'copy', { boot: 'on-demand' })).id;

    await expect(bootSession(created)).rejects.toThrow(/이미지 빌드 실패/);
    expect(getSnapshot(created)?.status).toBe('failed');
    // 이미 실패한 세션은 다시 시도하지 않고 이유를 그대로 알린다
    await expect(bootSession(created)).rejects.toThrow(/이미지 빌드 실패/);
    expect(fake.startCalls).toBe(1);
    await stopSession(created).catch(() => {});
  });

  it('idle 세션에 읽기만 하는 요청을 보내면 샌드박스를 켜지 않고 끝난다', async () => {
    const created = (await createSession('lazyproj', 'kim', 'copy', { boot: 'on-demand' })).id;
    const finished = new Promise<string>((resolve) => {
      const unsubscribe = subscribe(created, (event) => {
        if (event.type === 'run_finished') {
          unsubscribe();
          resolve(event.status);
        }
      });
    });

    // 대본 모델로 도구 없이 답만 한다(파일도 샌드박스도 건드리지 않는다)
    sendMessage(created, '이 프로젝트는 뭐야?', { allowBreaking: false, intent: 'ask', scriptedTurns: [{ text: '주문 API 프로젝트입니다.' }] });

    expect(await finished).toBe('done');
    expect(fake.startCalls).toBe(0);
    expect(getSnapshot(created)?.status).toBe('idle');
    await stopSession(created).catch(() => {});
  });

  it('만들기 요청이라도 파일을 바꾸지 않으면 샌드박스 없이 끝난다(체크포인트도 새로 만들지 않는다)', async () => {
    const created = (await createSession('lazyproj', 'kim', 'copy', { boot: 'on-demand' })).id;
    const finished = new Promise<string>((resolve) => {
      const unsubscribe = subscribe(created, (event) => {
        if (event.type === 'run_finished') {
          unsubscribe();
          resolve(event.status);
        }
      });
    });

    // 도구는 작업 공간만 읽고(read_file) 턴을 끝낸다 → 게이트도 샌드박스도 필요 없다
    sendMessage(created, '구조만 훑어보고 알려줘', {
      allowBreaking: false,
      scriptedTurns: [{ toolCalls: [{ name: 'read_file', input: { path: 'api/src/Order.java' } }] }, { text: '구조를 확인했습니다.' }],
    });

    expect(await finished).toBe('done');
    expect(fake.startCalls).toBe(0);
    expect(getSnapshot(created)?.status).toBe('idle');
    // 세션 시작 체크포인트 하나뿐이다(바뀐 것이 없어 체크포인트를 만들지 않았다)
    expect(getSnapshot(created)?.checkpoints).toHaveLength(1);
    await stopSession(created).catch(() => {});
  });
});
