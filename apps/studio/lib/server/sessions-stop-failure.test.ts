import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/**
 * 멈추기(`stopSession`)의 단계가 실패했을 때 옛 코드가 어떻게 끝나는지를 고정한다(ADR-205, 4f B2b). 실패를 삼키던 단계(관문·샌드박스·미리보기 프록시)는 삼키고,
 * 던지던 단계는 던지며 그 뒤 단계는 하지 않는다. 상태는 던진 단계가 상태를 바꾸기 전이면 그대로고 바꾼 뒤면 `stopped`다. 다시 멈추면 끝난다.
 * 이 시험은 수명 코어로 옮기기 전과 뒤가 같아야 한다(고치지 않고 통과).
 */
const fake = vi.hoisted(() => ({
  root: '',
  startCalls: 0,
  /** start가 이 약속이 풀릴 때 끝난다(중지 신호는 무시한다: 신호를 보고 던지는 샌드박스는 이 경주를 만들지 않는다) */
  destroyCalls: 0,
  destroyFails: false,
  disposeFails: false,
  disposeCalls: 0,
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-race-fake-abcdef',
    name: 'fake',
    async start() {
      fake.startCalls += 1;
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
      if (fake.destroyFails) throw new Error('샌드박스 정리 실패');
    },
  } as unknown as Sandbox;
  return { ...actual, providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox }) };
});

vi.mock('./session-terminal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session-terminal')>();
  return {
    ...actual,
    disposeSessionTerminal: async (...args: Parameters<typeof actual.disposeSessionTerminal>) => {
      fake.disposeCalls += 1;
      if (fake.disposeFails) throw new Error('터미널 정리 실패');
      return actual.disposeSessionTerminal(...args);
    },
  };
});

vi.mock('./projects', () => ({
  findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root),
}));

import { createSession, getSnapshot, stopSession, subscribe } from './sessions';

interface Internals {
  stop: AbortController;
}

let root: string;
const saved = { mode: process.env.B_STUDIO_MODE, backend: process.env.B_STUDIO_BACKENDS, sessions: process.env.B_STUDIO_SESSIONS_DIR };
const opened: (() => void)[] = [];

function internals(id: string): Internals {
  return (globalThis as { __bStudio?: { sessions: Map<string, Internals> } }).__bStudio!.sessions.get(id)!;
}

async function until(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`기다린 조건이 되지 않았습니다: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-stop-failure-'));
  await mkdir(path.join(root, 'project', 'api'), { recursive: true });
  await writeFile(
    path.join(root, 'project', 'studio.yaml'),
    `version: 1
name: failproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
`,
  );
  await writeFile(path.join(root, 'project', 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  fake.root = path.join(root, 'project');
  fake.startCalls = 0;
  fake.destroyCalls = 0;
  fake.destroyFails = false;
  fake.disposeFails = false;
  fake.disposeCalls = 0;
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  delete process.env.B_STUDIO_BACKENDS;
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'fail', GIT_AUTHOR_EMAIL: 'fail@example.com', GIT_COMMITTER_NAME: 'fail', GIT_COMMITTER_EMAIL: 'fail@example.com' });
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

/** 준비된 세션을 만든다. 구독자는 `armed`가 참인 동안 `throwOn`이 참인 이벤트에서 던진다(이벤트를 내보내는 자리의 예외) */
async function readySession(throwOn: (event: StudioEvent) => boolean = () => false) {
  const id = (await createSession('failproj', 'kim', 'copy')).id;
  await until(() => getSnapshot(id)?.status === 'ready', 'ready');
  const armed = { value: false };
  opened.push(
    subscribe(id, (event) => {
      if (armed.value && throwOn(event)) throw new Error(`구독자가 던졌습니다(${event.type})`);
    }),
  );
  return { id, armed };
}

describe('멈추기 단계의 실패(옛 코드와 같아야 한다)', () => {
  it('삼키던 단계(샌드박스 정리)가 실패해도 멈추기는 끝난다', async () => {
    const { id } = await readySession();
    fake.destroyFails = true;
    const snapshot = await stopSession(id);
    expect(snapshot.status).toBe('stopped');
    expect(fake.destroyCalls).toBe(1);
  });

  it('던지던 단계(터미널 정리)가 실패하면 던지고, 뒤 단계(샌드박스 정리)는 하지 않으며, 상태는 그대로다. 다시 멈추면 끝난다', async () => {
    const { id } = await readySession();
    fake.disposeFails = true;
    await expect(stopSession(id)).rejects.toThrow('터미널 정리 실패');
    expect(fake.destroyCalls).toBe(0);
    // 상태는 바뀌지 않았고(멈추는 중으로 영영 남지 않는다) 중지 신호만 올라가 있다
    expect(getSnapshot(id)?.status).toBe('ready');
    expect(internals(id).stop.signal.aborted).toBe(true);

    fake.disposeFails = false;
    const snapshot = await stopSession(id);
    expect(snapshot.status).toBe('stopped');
    expect(fake.destroyCalls).toBe(1);
  });

  it('던지던 단계(서비스를 멈춘 표시의 이벤트)가 실패하면 던지고, 샌드박스는 이미 지웠으며, 상태는 그대로다. 다시 멈추면 끝난다', async () => {
    const { id, armed } = await readySession((event) => event.type === 'service');
    armed.value = true;
    await expect(stopSession(id)).rejects.toThrow('구독자가 던졌습니다(service)');
    expect(fake.destroyCalls).toBe(1);
    expect(getSnapshot(id)?.status).toBe('ready');

    armed.value = false;
    const snapshot = await stopSession(id);
    expect(snapshot.status).toBe('stopped');
  });

  it('던지던 단계(상태 이벤트)가 실패하면 던지지만 상태는 이미 stopped다. 다시 멈추면 이미 멈춘 세션이다', async () => {
    const { id, armed } = await readySession((event) => event.type === 'status' && event.status === 'stopped');
    armed.value = true;
    await expect(stopSession(id)).rejects.toThrow('구독자가 던졌습니다(status)');
    expect(getSnapshot(id)?.status).toBe('stopped');
    expect(fake.destroyCalls).toBe(1);

    armed.value = false;
    const calls = fake.destroyCalls;
    expect((await stopSession(id)).status).toBe('stopped');
    expect(fake.destroyCalls).toBe(calls);
  });
});
