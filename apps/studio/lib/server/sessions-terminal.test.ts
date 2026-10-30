import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 세션 터미널(이슈 #673)을 누가 어디에 열 수 있는지를 실제 sessions.ts로 본다. 샌드박스(Docker)와 터미널의 컨테이너만 가짜다.
 */
const fake = vi.hoisted(() => ({ root: '', disposed: [] as Array<[string, string]> }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-terminal-fake',
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
    redact: (text: string) => text,
    findSecrets: () => [],
    async destroy() {},
  } as unknown as Sandbox;
  return { ...actual, providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox }) };
});

// 계정 테스트(#885)가 codex 세션을 만든다. 진짜 codex CLI를 부르지 않게 로그인 확인만 바꾼다
vi.mock('@b-studio/agent', async (importOriginal) => ({ ...(await importOriginal<typeof import('@b-studio/agent')>()), preflightCodex: async () => ({ ok: true }) }));

vi.mock('./projects', () => ({ findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root) }));
vi.mock('./session-terminal', () => ({
  disposeSessionTerminal: async (sessionId: string, sandboxId: string) => {
    fake.disposed.push([sessionId, sandboxId]);
  },
  noteSessionTerminalCli: () => {},
  sessionTerminalMode: () => 'container',
}));

import { createSession, getSnapshot, sessionTerminalAllowed, sessionTerminalTarget, stopSession } from './sessions';

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR, experimental: process.env.B_STUDIO_EXPERIMENTAL };

async function setup(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-terminal-session-'));
  const project = path.join(root, 'project');
  await mkdir(path.join(project, 'api/src'), { recursive: true });
  await writeFile(path.join(project, 'studio.yaml'), 'version: 1\nname: termproj\nservices:\n  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }\n');
  await writeFile(path.join(project, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(project, 'api/src/Order.java'), 'class Order {}\n');
  const git = (...args: string[]) => execFileAsync('git', ['-C', project, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  await git('init', '-q', '-b', 'main');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  fake.root = project;
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
}

async function waitFor(id: string, wanted: string): Promise<void> {
  const started = Date.now();
  while (getSnapshot(id)?.status !== wanted) {
    if (Date.now() - started > 10_000) throw new Error(`세션이 ${wanted}가 되지 않았습니다 (${getSnapshot(id)?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(() => {
  fake.disposed = [];
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_EXPERIMENTAL = '1';
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'verify', GIT_AUTHOR_EMAIL: 'verify@example.com', GIT_COMMITTER_NAME: 'verify', GIT_COMMITTER_EMAIL: 'verify@example.com' });
});

afterAll(() => {
  for (const [key, value] of [['B_STUDIO_MODE', saved.mode], ['B_STUDIO_AUTH', saved.auth], ['B_STUDIO_SESSIONS_DIR', saved.sessions], ['B_STUDIO_EXPERIMENTAL', saved.experimental]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('세션 터미널을 열 수 있는 자리 (이슈 #673)', () => {
  it('실험 기능을 켠 개인 PC 모드에서만 연다. 화면에 싣는 표시도 같은 판정이다', async () => {
    await setup();
    const id = (await createSession('termproj', 'kim', 'copy')).id;
    await waitFor(id, 'ready');
    expect(sessionTerminalAllowed()).toBe(true);
    expect(getSnapshot(id)?.terminal).toBe(true);

    const target = sessionTerminalTarget(id);
    expect(target.sandboxId).toBe('studio-terminal-fake');
    expect(target.projectId).toBe('termproj');
    // 붙이는 폴더는 원본이 아니라 세션의 작업 복사본이다
    expect(target.root).not.toBe(fake.root);
    expect(target.root).toContain(process.env.B_STUDIO_SESSIONS_DIR!);

    delete process.env.B_STUDIO_EXPERIMENTAL;
    expect(sessionTerminalAllowed()).toBe(false);
    expect(() => sessionTerminalTarget(id)).toThrow('실험 기능을 켠 개인 PC 모드에서만');

    process.env.B_STUDIO_EXPERIMENTAL = '1';
    process.env.B_STUDIO_AUTH = 'proxy';
    expect(sessionTerminalAllowed()).toBe(false);
    expect(() => sessionTerminalTarget(id)).toThrow('실험 기능을 켠 개인 PC 모드에서만');
    process.env.B_STUDIO_AUTH = 'none';
    await stopSession(id);
  }, 20_000);

  it('세션을 멈추면 터미널과 그 컨테이너를 정리하고, 멈춘 세션에서는 열지 않는다', async () => {
    await setup();
    const id = (await createSession('termproj', 'kim', 'copy')).id;
    await waitFor(id, 'ready');
    const target = sessionTerminalTarget(id);
    expect(target.alive()).toBe(true);
    // 멈추기 시작한 순간부터 받지 않는다. 상태가 stopped로 바뀌는 것은 정리가 끝난 뒤다
    const stopping = stopSession(id);
    expect(getSnapshot(id)?.status).toBe('ready');
    expect(target.alive()).toBe(false);
    expect(() => sessionTerminalTarget(id)).toThrow('멈춘 세션에서는 터미널을 열 수 없습니다');
    await stopping;
    expect(fake.disposed).toEqual([[id, 'studio-terminal-fake']]);
    expect(() => sessionTerminalTarget(id)).toThrow('멈춘 세션에서는 터미널을 열 수 없습니다');
  }, 20_000);
});

describe('세션의 AI 계정(#885)', () => {
  it('고른 계정을 세션 기록에 남기고, 터미널은 열 때마다 그 계정의 설정 폴더를 찾는다', async () => {
    await setup();
    const { addAiAccount, removeAiAccount } = await import('./ai-accounts');
    const home = await mkdtemp(path.join(tmpdir(), 'b-studio-session-account-'));
    const savedEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, B_STUDIO_BACKENDS: process.env.B_STUDIO_BACKENDS };
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, 'xdg');
    process.env.B_STUDIO_BACKENDS = 'codex,claude-code';
    try {
      const account = await addAiAccount({ name: '마르코', backend: 'codex', configDir: '~/.codex-marco' });
      // 다른 CLI의 계정이나 목록에 없는 계정은 받지 않는다
      await expect(createSession('termproj', 'kim', 'copy', { backend: 'claude-code', accountId: account.id })).rejects.toMatchObject({ status: 400 });
      await expect(createSession('termproj', 'kim', 'copy', { backend: 'codex', accountId: 'acct-00000000' })).rejects.toMatchObject({ status: 400 });

      const id = (await createSession('termproj', 'kim', 'copy', { backend: 'codex', accountId: account.id })).id;
      await waitFor(id, 'ready');
      expect(getSnapshot(id)?.accountId).toBe(account.id);
      expect(await sessionTerminalTarget(id).accountDir()).toBe(path.join(home, '.codex-marco'));

      // 계정을 지우면 다른 계정으로 띄우지 않고 까닭을 알린다
      await removeAiAccount(account.id);
      await expect(sessionTerminalTarget(id).accountDir()).rejects.toThrow('계정 목록에 없습니다');
      await stopSession(id);

      // 기본 계정은 기록에 남기지 않는다(지금과 같다)
      const plain = (await createSession('termproj', 'kim', 'copy', { backend: 'codex', accountId: 'codex' })).id;
      await waitFor(plain, 'ready');
      expect(getSnapshot(plain)?.accountId).toBeUndefined();
      expect(await sessionTerminalTarget(plain).accountDir()).toBeUndefined();
      await stopSession(plain);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('라우팅이 고른 모델을 터미널 CLI에 넘긴다(#988)', () => {
  it('CLI 백엔드 세션의 모델을 터미널 대상에 싣고, API 세션의 모델 id나 모델 없음은 싣지 않는다', async () => {
    await setup();
    const saved = process.env.B_STUDIO_BACKENDS;
    process.env.B_STUDIO_BACKENDS = 'codex,claude-code';
    try {
      const codex = (await createSession('termproj', 'kim', 'copy', { backend: 'codex', modelId: 'gpt-5.5' })).id;
      await waitFor(codex, 'ready');
      expect(sessionTerminalTarget(codex).model).toBe('gpt-5.5');
      await stopSession(codex);

      const plain = (await createSession('termproj', 'kim', 'copy', { backend: 'codex' })).id;
      await waitFor(plain, 'ready');
      expect(sessionTerminalTarget(plain).model).toBeUndefined();
      await stopSession(plain);

      // API 세션의 터미널은 claude를 띄운다. API 모델 id(레지스트리)는 claude가 모르는 이름이라 넘기지 않는다
      const api = (await createSession('termproj', 'kim', 'copy', { modelId: 'anthropic-default' })).id;
      await waitFor(api, 'ready');
      expect(sessionTerminalTarget(api).model).toBeUndefined();
      await stopSession(api);
    } finally {
      if (saved === undefined) delete process.env.B_STUDIO_BACKENDS;
      else process.env.B_STUDIO_BACKENDS = saved;
    }
  }, 30_000);
});
