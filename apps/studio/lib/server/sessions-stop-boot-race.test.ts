import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/** 멈추는 중에 끝난 켜기(트러블슈팅 213). 가짜 샌드박스의 start·destroy가 끝나는 때를 시험이 정한다 */
const fake = vi.hoisted(() => ({
  root: '',
  startCalls: 0,
  /** start가 이 약속이 풀릴 때 끝난다(중지 신호는 무시한다: 신호를 보고 던지는 샌드박스는 이 경주를 만들지 않는다) */
  startGate: undefined as Promise<void> | undefined,
  startFailure: undefined as string | undefined,
  destroyCalls: 0,
  destroyGate: undefined as Promise<void> | undefined,
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-race-fake-abcdef',
    name: 'fake',
    async start() {
      fake.startCalls += 1;
      await fake.startGate;
      if (fake.startFailure) throw new Error(fake.startFailure);
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
    async *logs() {
      // 끝나지 않는 구독(중지 신호가 와야 끝난다)
      await new Promise(() => {});
    },
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
    async destroy() {
      fake.destroyCalls += 1;
      await fake.destroyGate;
    },
  } as unknown as Sandbox;
  return { ...actual, providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox }) };
});

vi.mock('./projects', () => ({
  findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root),
}));

import { bootSession, createSession, getSnapshot, stopSession, subscribe } from './sessions';

interface Internals {
  fileWatcher?: unknown;
  usageTimer?: NodeJS.Timeout;
  logFollower?: AbortController;
}

let root: string;
const saved = { mode: process.env.B_STUDIO_MODE, backend: process.env.B_STUDIO_BACKENDS, sessions: process.env.B_STUDIO_SESSIONS_DIR };
const opened: (() => void)[] = [];

function internals(id: string): Internals {
  return (globalThis as { __bStudio?: { sessions: Map<string, Internals> } }).__bStudio!.sessions.get(id)!;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function until(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`기다린 조건이 되지 않았습니다: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-stop-boot-race-'));
  await mkdir(path.join(root, 'project', 'api'), { recursive: true });
  await writeFile(
    path.join(root, 'project', 'studio.yaml'),
    `version: 1
name: raceproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
`,
  );
  await writeFile(path.join(root, 'project', 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  fake.root = path.join(root, 'project');
  fake.startCalls = 0;
  fake.startGate = undefined;
  fake.startFailure = undefined;
  fake.destroyCalls = 0;
  fake.destroyGate = undefined;
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  delete process.env.B_STUDIO_BACKENDS;
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'race', GIT_AUTHOR_EMAIL: 'race@example.com', GIT_COMMITTER_NAME: 'race', GIT_COMMITTER_EMAIL: 'race@example.com' });
});

afterEach(() => {
  for (const close of opened.splice(0)) close();
});

afterAll(() => {
  for (const [key, value] of [['B_STUDIO_MODE', saved.mode], ['B_STUDIO_BACKENDS', saved.backend], ['B_STUDIO_SESSIONS_DIR', saved.sessions]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** 켜는 중인 세션을 만들고, 멈추기를 시작해 destroy에서 붙잡아 둔 채 돌려준다 */
async function stopWhileBooting(options: { boot?: 'eager' | 'on-demand' } = {}) {
  const startGate = deferred();
  const destroyGate = deferred();
  fake.startGate = startGate.promise;
  fake.destroyGate = destroyGate.promise;
  const events: StudioEvent[] = [];
  const created = await createSession('raceproj', 'kim', 'copy', options.boot ? { boot: options.boot } : {});
  const id = created.id;
  opened.push(subscribe(id, (event) => events.push(event)));
  let bootDone: Promise<unknown> | undefined;
  if (options.boot === 'on-demand') bootDone = bootSession(id).catch((error: unknown) => error);
  await until(() => fake.startCalls === 1, 'start 호출');
  const mark = events.length;
  const stopped = stopSession(id);
  await until(() => fake.destroyCalls === 1, 'destroy 호출(멈추기가 여기서 기다린다)');
  return { id, events, mark, startGate, destroyGate, stopped, bootDone };
}

describe('멈추는 중에 끝난 켜기', () => {
  it('멈추기가 시작된 뒤에 켜기가 끝나도 ready 상태 이벤트를 내지 않는다', async () => {
    const run = await stopWhileBooting();
    run.startGate.resolve();
    await settle();
    run.destroyGate.resolve();
    const snapshot = await run.stopped;
    await settle();

    expect(run.events.slice(run.mark).filter((event) => event.type === 'status')).toEqual([{ type: 'status', status: 'stopped', error: undefined }]);
    expect(snapshot.status).toBe('stopped');
    expect(getSnapshot(run.id)?.status).toBe('stopped');
  });

  it('멈춘 세션에 사용량·파일·로그 감시가 다시 살아 있지 않다', async () => {
    const run = await stopWhileBooting();
    run.startGate.resolve();
    await settle();
    run.destroyGate.resolve();
    await run.stopped;
    await settle();

    const session = internals(run.id);
    expect(session.usageTimer, '사용량 타이머가 살아 있다').toBeUndefined();
    expect(session.fileWatcher, '파일 감시가 살아 있다').toBeUndefined();
    expect(session.logFollower === undefined || session.logFollower.signal.aborted, '로그 구독이 살아 있다').toBe(true);
  });

  it('멈추는 중에 켜기가 실패해도 failed를 내지 않고 stopped로 끝난다', async () => {
    const run = await stopWhileBooting();
    fake.startFailure = '멈추는 중에 난 실패';
    run.startGate.resolve();
    await settle();
    run.destroyGate.resolve();
    const snapshot = await run.stopped;
    await settle();

    expect(run.events.slice(run.mark).filter((event) => event.type === 'status')).toEqual([{ type: 'status', status: 'stopped', error: undefined }]);
    expect(snapshot.status).toBe('stopped');
    expect(snapshot.error).toBeUndefined();
  });

  it('멈추는 중에 끝난 켜기를 기다리던 호출은 켜지 못했다는 오류를 받는다(ready로 돌아가지 않는다)', async () => {
    const run = await stopWhileBooting({ boot: 'on-demand' });
    run.startGate.resolve();
    await settle();
    run.destroyGate.resolve();
    await run.stopped;
    expect(await run.bootDone).toBeInstanceOf(Error);
    expect(getSnapshot(run.id)?.status).toBe('stopped');
  });
});
