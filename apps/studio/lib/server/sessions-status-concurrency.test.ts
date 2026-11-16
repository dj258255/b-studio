import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/**
 * 세션 상태의 동시 호출(ADR-205, 4f B2b): stopSession 둘, resumeSession 둘, 켜는 중 stopSession, 멈추는 중 bootSession.
 * 가짜 샌드박스의 start·destroy가 끝나는 때를 시험이 정한다.
 */
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

import { bootSession, createSession, getSnapshot, resumeSession, stopSession, subscribe } from './sessions';

let root: string;
const saved = { mode: process.env.B_STUDIO_MODE, backend: process.env.B_STUDIO_BACKENDS, sessions: process.env.B_STUDIO_SESSIONS_DIR };
const opened: (() => void)[] = [];

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
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-status-concurrency-'));
  await mkdir(path.join(root, 'project', 'api'), { recursive: true });
  await writeFile(
    path.join(root, 'project', 'studio.yaml'),
    `version: 1
name: concproj
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
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'conc', GIT_AUTHOR_EMAIL: 'conc@example.com', GIT_COMMITTER_NAME: 'conc', GIT_COMMITTER_EMAIL: 'conc@example.com' });
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

/** 준비된 세션 하나를 만든다 */
async function readySession(options: { boot?: 'eager' | 'on-demand' } = {}): Promise<string> {
  const id = (await createSession('concproj', 'kim', 'copy', options)).id;
  if (options.boot !== 'on-demand') await until(() => getSnapshot(id)?.status === 'ready', 'ready');
  return id;
}

describe('동시 호출', () => {
  it('stopSession 둘을 동시에 부르면 단계를 한 번만 밟고 둘 다 stopped로 끝난다', async () => {
    const id = await readySession();
    const destroyGate = deferred();
    fake.destroyGate = destroyGate.promise;
    const events: StudioEvent[] = [];
    opened.push(subscribe(id, (event) => events.push(event)));
    const mark = events.length;

    const first = stopSession(id);
    const second = stopSession(id);
    await until(() => fake.destroyCalls === 1, 'destroy');
    await settle();
    // 둘째는 첫째가 끝나기를 기다린다(같은 단계를 다시 밟지 않는다)
    expect(fake.destroyCalls).toBe(1);
    destroyGate.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(a.status).toBe('stopped');
    expect(b.status).toBe('stopped');
    expect(fake.destroyCalls).toBe(1);
    expect(events.slice(mark).filter((event) => event.type === 'status')).toEqual([{ type: 'status', status: 'stopped', error: undefined }]);
    // 이미 멈춘 뒤의 stopSession은 아무것도 하지 않는다
    await stopSession(id);
    expect(fake.destroyCalls).toBe(1);
  });

  it('켜는 중인 세션을 멈춰도 상태 이벤트는 stopped 하나뿐이고 ready·failed는 없다', async () => {
    const startGate = deferred();
    fake.startGate = startGate.promise;
    const events: StudioEvent[] = [];
    const id = (await createSession('concproj', 'kim', 'copy')).id;
    opened.push(subscribe(id, (event) => events.push(event)));
    await until(() => fake.startCalls === 1, 'start');
    const stopped = stopSession(id);
    startGate.resolve();
    expect((await stopped).status).toBe('stopped');
    await settle();
    expect(getSnapshot(id)?.status).toBe('stopped');
    expect(events.filter((event) => event.type === 'status').map((event) => (event as { status: string }).status)).toEqual(['stopped']);
  });

  it('멈추는 중에 boot를 부르면 새로 켜지 않고 409로 거절한다(starting 이벤트도 내지 않는다)', async () => {
    const id = await readySession({ boot: 'on-demand' });
    expect(getSnapshot(id)?.status).toBe('idle');
    const destroyGate = deferred();
    fake.destroyGate = destroyGate.promise;
    const events: StudioEvent[] = [];
    opened.push(subscribe(id, (event) => events.push(event)));
    const mark = events.length;

    const stopped = stopSession(id);
    await until(() => fake.destroyCalls === 1, 'destroy');
    await expect(bootSession(id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('중지된 세션입니다') });
    expect(fake.startCalls).toBe(0);
    destroyGate.resolve();
    await stopped;

    expect(events.slice(mark).filter((event) => event.type === 'status')).toEqual([{ type: 'status', status: 'stopped', error: undefined }]);
    expect(fake.startCalls).toBe(0);
  });

  it('멈춘 세션에 boot를 부르면 409다', async () => {
    const id = await readySession();
    await stopSession(id);
    await expect(bootSession(id)).rejects.toMatchObject({ status: 409 });
  });

  it('resumeSession 둘을 동시에 부르면 하나만 이어받고 다른 하나는 409다. 이어받는 중 표시는 끝나면 빠진다', async () => {
    const id = await readySession();
    await stopSession(id);
    const results = await Promise.allSettled([resumeSession(id), resumeSession(id)]);
    const ok = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ status: 409, message: expect.stringContaining('이미 이어서 작업할 준비를 하는 중입니다') });
    await until(() => getSnapshot(id)?.status === 'ready', '이어받은 세션이 ready');

    // 이어받은 세션을 다시 멈추면 또 이어받을 수 있다(이어받는 중 표시가 남지 않았다)
    await stopSession(id);
    await resumeSession(id);
    await until(() => getSnapshot(id)?.status === 'ready', '다시 ready');
    await stopSession(id);
  });

  it('이어받기가 실패해도 이어받는 중 표시가 빠져 다시 시도할 수 있다(옛 finally)', async () => {
    const id = await readySession();
    await stopSession(id);
    // 폴더를 지워 이어받기를 실패시킨다: "작업 복사본이 없어 이어서 작업할 수 없습니다"
    const { workDir } = getSnapshot(id)!;
    const { rename } = await import('node:fs/promises');
    await rename(workDir, `${workDir}.moved`);
    await expect(resumeSession(id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('없어 이어서 작업할 수 없습니다') });
    await expect(resumeSession(id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('없어 이어서 작업할 수 없습니다') });
    await rename(`${workDir}.moved`, workDir);
    await resumeSession(id);
    await until(() => getSnapshot(id)?.status === 'ready', 'ready');
    await stopSession(id);
  });

  it('멈추지 않은 세션을 이어받으려 하면 409다', async () => {
    const id = await readySession();
    await expect(resumeSession(id)).rejects.toMatchObject({ status: 409, message: '샌드박스를 중지한 세션만 이어서 작업할 수 있습니다' });
    await expect(resumeSession('nonexist')).rejects.toMatchObject({ status: 404 });
    await stopSession(id);
  });
});
