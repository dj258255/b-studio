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
  it('개인 PC 모드에서만 연다. 이 컴퓨터 방식은 지원 경로라 실험 기능 없이도, 컨테이너 방식은 실험 기능을 켰을 때만 연다(ADR-200). 화면에 싣는 표시도 같은 판정이다', async () => {
    await setup();
    const id = (await createSession('termproj', 'kim', 'copy')).id;
    await waitFor(id, 'ready');
    expect(sessionTerminalAllowed()).toBe(true);
    expect(getSnapshot(id)?.terminal).toBe(true);

    const target = sessionTerminalTarget(id);
    expect(target.sandboxId).toBe('studio-terminal-fake');
    expect(target.projectId).toBe('termproj');
    // 인증을 끈 개인 PC 방식은 홈 볼륨을 사용자별로 가르지 않는다(옛 이름 유지, #1401)
    expect(target.homeUser).toBeUndefined();
    // 붙이는 폴더는 원본이 아니라 세션의 작업 복사본이다
    expect(target.root).not.toBe(fake.root);
    expect(target.root).toContain(process.env.B_STUDIO_SESSIONS_DIR!);

    const savedTerminal = process.env.B_STUDIO_TERMINAL;
    // 이 컴퓨터 방식(기본값)은 실험 기능을 꺼도 연다
    delete process.env.B_STUDIO_EXPERIMENTAL;
    delete process.env.B_STUDIO_TERMINAL;
    expect(sessionTerminalAllowed()).toBe(true);
    expect(getSnapshot(id)?.terminal).toBe(true);
    expect(sessionTerminalTarget(id).projectId).toBe('termproj');
    process.env.B_STUDIO_TERMINAL = 'host';
    expect(sessionTerminalAllowed()).toBe(true);

    // 컨테이너 방식은 실험이라 실험 기능을 꺼 두면 열지 않는다
    process.env.B_STUDIO_TERMINAL = 'container';
    expect(sessionTerminalAllowed()).toBe(false);
    expect(() => sessionTerminalTarget(id)).toThrow('개인 PC 모드에서만');
    process.env.B_STUDIO_EXPERIMENTAL = '1';
    expect(sessionTerminalAllowed()).toBe(true);

    // 모르는 방식은 실험 기능을 꺼 두면 열지 않는다(켜 두면 여는 자리에서 설정 오류로 던진다)
    process.env.B_STUDIO_TERMINAL = 'conatiner';
    delete process.env.B_STUDIO_EXPERIMENTAL;
    expect(sessionTerminalAllowed()).toBe(false);

    // 여러 사람이 쓰는 서버(인증 켬)에서는 어느 방식이든 열지 않는다
    process.env.B_STUDIO_EXPERIMENTAL = '1';
    for (const mode of ['host', 'container']) {
      process.env.B_STUDIO_TERMINAL = mode;
      process.env.B_STUDIO_AUTH = 'proxy';
      expect(sessionTerminalAllowed()).toBe(false);
      expect(() => sessionTerminalTarget(id)).toThrow('개인 PC 모드에서만');
    }
    process.env.B_STUDIO_AUTH = 'none';
    if (savedTerminal === undefined) delete process.env.B_STUDIO_TERMINAL;
    else process.env.B_STUDIO_TERMINAL = savedTerminal;
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

      // API 세션의 터미널은 claude를 띄운다(컨테이너 방식). API 모델 id(레지스트리)는 claude가 모르는 이름이라 넘기지 않는다
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

describe('서버 방식(인증을 켠 방식)의 세션 터미널 대상 (#1473)', () => {
  const serverEnv = (): void => {
    process.env.B_STUDIO_AUTH = 'token';
    process.env.B_STUDIO_AUTH_SECRET = 's'.repeat(40);
    process.env.B_STUDIO_AUTH_TOKENS = `kim:${'k'.repeat(32)},lee:${'l'.repeat(32)}`;
    process.env.B_STUDIO_SERVER_TERMINAL = '1';
    process.env.B_STUDIO_TERMINAL = 'container';
    process.env.B_STUDIO_EXPERIMENTAL = '1';
  };
  const reset = (): void => {
    for (const key of ['B_STUDIO_BACKENDS', 'B_STUDIO_AUTH_SECRET', 'B_STUDIO_AUTH_TOKENS', 'B_STUDIO_SERVER_TERMINAL', 'B_STUDIO_TERMINAL']) delete process.env[key];
    process.env.B_STUDIO_AUTH = 'none';
  };

  it('홈 볼륨을 가르는 사용자는 세션을 만든 사람이고, 같은 프로젝트라도 사람마다 다르다. 개인 PC와 다른 값이다', async () => {
    await setup();
    serverEnv();
    try {
      const kim = (await createSession('termproj', 'kim', 'copy')).id;
      await waitFor(kim, 'ready');
      const lee = (await createSession('termproj', 'lee', 'copy')).id;
      await waitFor(lee, 'ready');
      expect(sessionTerminalAllowed()).toBe(true);
      expect(sessionTerminalTarget(kim)).toMatchObject({ homeUser: 'kim', projectId: 'termproj' });
      expect(sessionTerminalTarget(lee)).toMatchObject({ homeUser: 'lee', projectId: 'termproj' });
      await stopSession(kim);
      await stopSession(lee);
    } finally {
      reset();
    }
  }, 20_000);

  it('스위치가 꺼지면 열지 않고 까닭(스위치 이름)을 적어 거절한다. 채팅식으로 돌아가는 길이 없다', async () => {
    await setup();
    serverEnv();
    try {
      const id = (await createSession('termproj', 'kim', 'copy')).id;
      await waitFor(id, 'ready');
      delete process.env.B_STUDIO_SERVER_TERMINAL;
      expect(sessionTerminalAllowed()).toBe(false);
      expect(() => sessionTerminalTarget(id)).toThrow('B_STUDIO_SERVER_TERMINAL=1');
      process.env.B_STUDIO_SERVER_TERMINAL = '1';
      // 이 컴퓨터 방식은 서버 방식에서 열리지 않는다
      process.env.B_STUDIO_TERMINAL = 'host';
      expect(() => sessionTerminalTarget(id)).toThrow('컨테이너');
      await stopSession(id);
    } finally {
      reset();
    }
  }, 20_000);

  it('컨테이너 방식에서 codex 세션은 codex를 띄우고(claude로 대신하지 않는다), claude 세션은 claude를 띄운다', async () => {
    await setup();
    try {
      process.env.B_STUDIO_EXPERIMENTAL = '1';
      process.env.B_STUDIO_TERMINAL = 'container';
      process.env.B_STUDIO_BACKENDS = 'api,codex,claude-code';
      const codex = (await createSession('termproj', 'kim', 'copy', { backend: 'codex' })).id;
      await waitFor(codex, 'ready');
      expect(sessionTerminalTarget(codex).cli).toBe('codex');
      const claude = (await createSession('termproj', 'kim', 'copy', { backend: 'claude-code' })).id;
      await waitFor(claude, 'ready');
      expect(sessionTerminalTarget(claude).cli).toBe('claude');
      await stopSession(codex);
      await stopSession(claude);
    } finally {
      reset();
    }
  }, 20_000);

  it('대상에 세션의 백엔드가 실린다(컨테이너 방식이 띄울 수 있는지 띄우기 전에 보는 근거)', async () => {
    await setup();
    process.env.B_STUDIO_BACKENDS = 'api,codex,claude-code';
    try {
      for (const backend of ['api', 'codex', 'claude-code'] as const) {
        const id = (await createSession('termproj', 'kim', 'copy', { backend })).id;
        await waitFor(id, 'ready');
        expect(sessionTerminalTarget(id).backend).toBe(backend);
        await stopSession(id);
      }
    } finally {
      reset();
    }
  }, 30_000);
});
