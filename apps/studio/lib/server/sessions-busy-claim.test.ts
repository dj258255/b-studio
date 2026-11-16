import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/**
 * 세션이 "바쁜지"를 코어의 점유가 정한다(ADR-207, 4f B3a). 옛 코드가 `snapshot.running`·`session.run`으로 정하던 때의 틈을 시험으로 고정한다.
 * 샌드박스(Docker)·CLI 러너·로그인 확인은 가짜이고, 러너와 샌드박스 내리기·체크포인트 지문 계산은 시험이 붙잡았다 푼다(실제 모델·docker·네트워크 없음).
 */
const fake = vi.hoisted(() => ({
  root: '',
  destroyCalls: 0,
  destroyGate: undefined as Promise<void> | undefined,
  /** 러너가 시작된 횟수와 그때 받은 중지 신호·풀 수 있는 문 */
  runs: [] as Array<{ signal: AbortSignal; release: () => void }>,
  /** 러너가 중지 신호를 보면 던지는가(false면 신호를 무시하고 문이 열릴 때까지 기다린다) */
  honorAbort: true,
  /** 러너가 시작하자마자 이 토큰 사용량을 알린다(토큰 한도 취소를 만든다) */
  reportTokens: undefined as number | undefined,
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-busy-fake-abcdef',
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
    async *logs() {
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

const done = { status: 'done', summary: '설명했습니다.', changedFiles: [], verifyAttempts: 0, turns: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
vi.mock('@b-studio/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@b-studio/agent')>()),
  preflightClaudeCode: async () => ({ ok: true as const, account: {} }),
  runClaudeCodeAgent: (options: { signal: AbortSignal; onEvent?: (event: unknown) => void }) =>
    new Promise((resolve, reject) => {
      const entry = { signal: options.signal, release: () => resolve(done) };
      fake.runs.push(entry);
      if (fake.reportTokens !== undefined) options.onEvent?.({ type: 'tokens', usage: { inputTokens: fake.reportTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
      options.signal.addEventListener('abort', () => {
        if (fake.honorAbort) reject(options.signal.reason ?? new Error('중단'));
      });
    }),
}));

import { cancelRun, createSession, deleteSession, getSnapshot, runReviewRound, sendMessage, setSessionModel, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';

interface Internals {
  checkpoints: { baseStatus: unknown; repository: unknown; pendingFingerprint: unknown };
  snapshot: { repository?: unknown; running: boolean };
  git?: unknown;
  run?: { id: string; terminal?: unknown };
}

let root: string;
const saved = { mode: process.env.B_STUDIO_MODE, backend: process.env.B_STUDIO_BACKENDS, sessions: process.env.B_STUDIO_SESSIONS_DIR, usage: process.env.B_STUDIO_USAGE_DIR };
const opened: Array<() => void> = [];
const ids: string[] = [];

function internals(id: string): Internals {
  return (globalThis as { __bStudio?: { sessions: Map<string, Internals> } }).__bStudio!.sessions.get(id)!;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function until(condition: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`기다린 조건이 되지 않았습니다: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

async function sessionFolders(): Promise<string[]> {
  return (await readdir(path.join(root, 'sessions')).catch(() => [])).filter((name) => name.startsWith('busyproj-'));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-busy-claim-'));
  await mkdir(path.join(root, 'project', 'api'), { recursive: true });
  await writeFile(
    path.join(root, 'project', 'studio.yaml'),
    `version: 1
name: busyproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
review:
  auto: false
`,
  );
  await writeFile(path.join(root, 'project', 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  fake.root = path.join(root, 'project');
  fake.destroyCalls = 0;
  fake.destroyGate = undefined;
  fake.runs = [];
  fake.honorAbort = true;
  fake.reportTokens = undefined;
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_BACKENDS = 'claude-code';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  // 사람별 토큰 사용량도 이 시험의 임시 폴더에만 쓴다
  process.env.B_STUDIO_USAGE_DIR = path.join(root, 'usage');
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'busy', GIT_AUTHOR_EMAIL: 'busy@example.com', GIT_COMMITTER_NAME: 'busy', GIT_COMMITTER_EMAIL: 'busy@example.com' });
});

afterEach(async () => {
  for (const run of fake.runs) run.release();
  for (const close of opened.splice(0)) close();
  for (const id of ids.splice(0)) await stopSession(id).catch(() => {});
});

afterAll(() => {
  for (const [key, value] of [['B_STUDIO_MODE', saved.mode], ['B_STUDIO_BACKENDS', saved.backend], ['B_STUDIO_SESSIONS_DIR', saved.sessions], ['B_STUDIO_USAGE_DIR', saved.usage]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function open(boot: 'on-demand' | 'eager'): Promise<{ id: string; events: StudioEvent[] }> {
  const id = (await createSession('busyproj', 'kim', 'copy', { backend: 'claude-code', boot })).id;
  ids.push(id);
  await until(() => getSnapshot(id)?.status === (boot === 'eager' ? 'ready' : 'idle'), `상태 ${boot}`);
  const events: StudioEvent[] = [];
  opened.push(subscribe(id, (event) => events.push(event)));
  return { id, events };
}

const ask = (id: string, text = '구조를 설명해 줘') => sendMessage(id, text, { allowBreaking: false, intent: 'ask', steering: true });

const STOP_TEXT = '중지된 세션입니다. 이어서 작업하면 새 샌드박스를 띄웁니다';

describe('결함 1: 지연 기동(idle) 세션이 요청을 처리하는 동안에는 지울 수 없다', () => {
  it('실행 중에 지우면 409이고 폴더·세션이 그대로이며 러너는 멈춤 신호를 받지 않는다', async () => {
    const { id } = await open('on-demand');
    const { runId } = ask(id);
    await until(() => fake.runs.length === 1, '러너 시작');
    expect(getSnapshot(id)?.status).toBe('idle');
    expect(await sessionFolders()).toHaveLength(1);

    await expect(deleteSession(id)).rejects.toMatchObject({ status: 409, message: '실행 중인 세션은 지울 수 없습니다. 먼저 샌드박스를 중지한 뒤 지우세요' });
    expect(await sessionFolders()).toHaveLength(1);
    expect(getSnapshot(id)).toBeDefined();
    expect(fake.runs[0]!.signal.aborted).toBe(false);

    // 실행이 끝나면(점유가 풀리면) 지울 수 있다
    fake.runs[0]!.release();
    await until(() => getSnapshot(id)?.running === false, '실행 끝');
    expect(runId).toBeTruthy();
    await deleteSession(id);
    expect(await sessionFolders()).toHaveLength(0);
  });

  it('멈춘 뒤에는 지울 수 있다: 멈추기가 idle 세션의 실행을 멈춘다', async () => {
    const { id } = await open('on-demand');
    ask(id);
    await until(() => fake.runs.length === 1, '러너 시작');
    await stopSession(id);
    expect(fake.runs[0]!.signal.aborted).toBe(true);
    expect(getSnapshot(id)?.status).toBe('stopped');
    expect(getSnapshot(id)?.running).toBe(false);
    await settle();
    await deleteSession(id);
    await settle();
    // 지운 폴더에 저장 파일이 다시 생기지 않는다
    expect(await sessionFolders()).toHaveLength(0);
  });

  it('러너가 멈춤 신호를 무시해도(끝나지 않는 await) 멈춘 세션의 점유는 남지 않아 지울 수 있고, 늦게 끝난 러너가 폴더를 되살리지 않는다', async () => {
    fake.honorAbort = false;
    const { id } = await open('on-demand');
    ask(id);
    await until(() => fake.runs.length === 1, '러너 시작');
    await stopSession(id);
    expect(getSnapshot(id)?.running).toBe(false);
    await deleteSession(id);
    fake.runs[0]!.release();
    await settle();
    await settle();
    expect(await sessionFolders()).toHaveLength(0);
  });
});

describe('결함 2: 멈추는 중에는 요청을 받지 않는다', () => {
  it('샌드박스를 내리는 중에 보낸 요청은 409이고 러너가 시작되지 않는다', async () => {
    const { id } = await open('eager');
    const gate = deferred();
    fake.destroyGate = gate.promise;
    const stopping = stopSession(id);
    try {
      await until(() => fake.destroyCalls === 1, '샌드박스 내리기 시작');
      expect(getSnapshot(id)?.status).toBe('ready');

      expect(() => ask(id)).toThrowError(expect.objectContaining({ status: 409, message: STOP_TEXT }));
      await settle();
      expect(fake.runs).toHaveLength(0);
      expect(getSnapshot(id)?.running).toBe(false);
    } finally {
      gate.resolve();
    }
    await stopping;
    expect(getSnapshot(id)?.status).toBe('stopped');
    expect(fake.runs).toHaveLength(0);
  });

  it('멈추는 중에는 보조 작업(되돌리기 따위)도 시작하지 않는다', async () => {
    const { id } = await open('eager');
    const gate = deferred();
    fake.destroyGate = gate.promise;
    const stopping = stopSession(id);
    try {
      await until(() => fake.destroyCalls === 1, '샌드박스 내리기 시작');
      const { restoreDiscardedBackup } = await import('./sessions');
      expect(() => restoreDiscardedBackup(id, 'nope')).toThrowError(expect.objectContaining({ status: 409, message: STOP_TEXT }));
      expect(getSnapshot(id)?.running).toBe(false);
    } finally {
      gate.resolve();
    }
    await stopping;
  });
});

describe('결함 3: 기준 브랜치 따라잡기는 확인한 뒤 기다리기 전에 잡는다', () => {
  it('따라잡기가 `await`하는 사이 시작한 요청의 점유를 끝에서 풀지 못하고, 그 사이의 요청은 받지 않는다', async () => {
    const { id } = await open('eager');
    const session = internals(id);
    const gate = deferred();
    let baseStatusCalls = 0;
    // 따라잡기를 켜는 조건을 만든다: 저장소가 있고, 기억한 Git 상태가 있고, 기준 브랜치가 앞서 있다
    session.snapshot.repository = { base: 'main' };
    session.git = { branch: 'x', head: 'y' };
    session.checkpoints.baseStatus = async () => {
      baseStatusCalls += 1;
      await gate.promise;
      return { base: 'main', behind: 1, ahead: 0 };
    };
    let repositoryCalls = 0;
    session.checkpoints.repository = async () => {
      repositoryCalls += 1;
      if (repositoryCalls > 1) throw new Error('리뷰 시작 뒤는 이 시험의 관심 밖');
      return { pullRequestUrl: 'https://example.invalid/pr/1' };
    };

    const review = runReviewRound(id).catch(() => {});
    await until(() => baseStatusCalls === 1, '따라잡기 확인 시작');
    // 따라잡기가 기다리는 사이에 요청이 들어온다
    let second: { runId: string } | undefined;
    let secondError: unknown;
    try {
      second = ask(id);
    } catch (error) {
      secondError = error;
    }
    gate.resolve();
    await review;
    await settle();

    // 따라잡기가 기다리기 전에 점유했으므로 그 사이의 요청은 받지 않는다(옛 코드는 받았고, 끝에서 그 요청의 `running`을 풀었다)
    expect(second).toBeUndefined();
    expect(secondError).toMatchObject({ status: 409, message: '이전 요청을 처리하는 중입니다' });
    expect(fake.runs).toHaveLength(0);
    // 따라잡기가 끝나면 점유가 풀려 새 요청을 받는다
    expect(getSnapshot(id)?.running).toBe(false);
    ask(id);
    await until(() => fake.runs.length === 1, '러너 시작');
    expect(getSnapshot(id)?.running).toBe(true);
    expect(() => ask(id)).toThrowError(expect.objectContaining({ status: 409, message: '이전 요청을 처리하는 중입니다' }));
  });
});

describe('결함 4: 읽기 전용 터미널 실행은 지문을 기다리기 전에 잡는다', () => {
  it('지문을 기다리는 사이 시작한 대화 창의 요청이 있으면 터미널 실행은 시작하지 않고, 요청의 실행을 덮어쓰지 않는다', async () => {
    const { id } = await open('eager');
    const session = internals(id);
    const gate = deferred();
    const original = (session.checkpoints.pendingFingerprint as () => Promise<string>).bind(session.checkpoints);
    let held = 0;
    session.checkpoints.pendingFingerprint = async () => {
      if (new Error().stack?.includes('beginTerminalRun')) {
        held += 1;
        await gate.promise;
      }
      return original();
    };
    const gateway = terminalGatewayHandlersForTest(id);
    const prompting = gateway.prompt({ prompt: '[읽기만] 구조를 알려줘' });
    await until(() => held === 1, '지문 계산 시작');

    let chat: { runId: string } | undefined;
    let chatError: unknown;
    try {
      chat = ask(id, '대화 창 요청');
    } catch (error) {
      chatError = error;
    }
    gate.resolve();
    const answer = await prompting;
    await settle();

    // 터미널 실행이 지문을 기다리기 전에 점유했으므로 그 사이의 대화 창 요청은 받지 않는다(옛 코드는 받았고, 터미널 실행이 그 실행을 덮어썼다)
    expect(chat).toBeUndefined();
    expect(chatError).toMatchObject({ status: 409, message: '이전 요청을 처리하는 중입니다' });
    expect(answer.blocked).toBeUndefined();
    expect(session.run?.terminal).toBeDefined();
    expect(getSnapshot(id)?.running).toBe(true);
    expect(fake.runs).toHaveLength(0);
  });
});

describe('결함 4의 곁: 멈춘 세션은 터미널 실행을 열지 않는다', () => {
  it('지문을 기다리는 사이 세션이 멈추면 실행을 열지 않고 점유도 남지 않는다', async () => {
    const { id } = await open('eager');
    const session = internals(id);
    const gate = deferred();
    const original = (session.checkpoints.pendingFingerprint as () => Promise<string>).bind(session.checkpoints);
    let held = 0;
    session.checkpoints.pendingFingerprint = async () => {
      if (new Error().stack?.includes('beginTerminalRun')) {
        held += 1;
        await gate.promise;
      }
      return original();
    };
    const prompting = terminalGatewayHandlersForTest(id).prompt({ prompt: '[읽기만] 구조를 알려줘' });
    await until(() => held === 1, '지문 계산 시작');
    await stopSession(id);
    gate.resolve();
    const answer = await prompting;
    expect(answer.blocked).toContain('중지');
    expect(session.run).toBeUndefined();
    expect(getSnapshot(id)?.running).toBe(false);
  });
});

describe('실행 점유의 판정(옛 코드와 같은 글)', () => {
  it('실행 중 두 번째 요청은 409, 취소는 한 번만 받고 두 번째는 조용히 돌아오며, 끝난 뒤의 취소는 409', async () => {
    fake.honorAbort = false;
    const { id } = await open('eager');
    const { runId } = ask(id);
    await until(() => fake.runs.length === 1, '러너 시작');
    expect(() => ask(id)).toThrowError(expect.objectContaining({ status: 409, message: '이전 요청을 처리하는 중입니다' }));
    expect(() => cancelRun(id, 'other')).toThrowError(expect.objectContaining({ status: 409 }));
    cancelRun(id, runId);
    expect(getSnapshot(id)?.cancelling).toBe('user');
    expect(fake.runs[0]!.signal.aborted).toBe(true);
    // 이미 취소 중이면 조용히 돌아온다
    expect(() => cancelRun(id, runId)).not.toThrow();
    // 취소 중에도 새 요청은 받지 않는다
    expect(() => ask(id)).toThrowError(expect.objectContaining({ status: 409 }));
    await expect(setSessionModel(id, '', undefined)).rejects.toMatchObject({ status: 409, message: '요청을 처리하는 동안에는 모델을 바꿀 수 없습니다' });
    fake.runs[0]!.release();
    await until(() => getSnapshot(id)?.running === false, '실행 끝');
    expect(getSnapshot(id)?.cancelling).toBeUndefined();
    expect(() => cancelRun(id, runId)).toThrowError(expect.objectContaining({ status: 409, message: '취소할 수 있는 요청이 없습니다. 이미 끝났거나 결과를 저장하는 중입니다' }));
  });

  it('토큰 한도로 멈춘 실행도 취소 중이다: 사용자 취소는 조용히 돌아오고 취소 이유를 바꾸지 않는다', async () => {
    fake.honorAbort = false;
    fake.reportTokens = 5_000;
    process.env.B_STUDIO_SESSION_TOKEN_LIMIT = '1000';
    try {
      const { id } = await open('eager');
      const { runId } = ask(id);
      await until(() => fake.runs.length === 1, '러너 시작');
      await until(() => getSnapshot(id)?.cancelling === 'budget', '한도로 취소 중');
      expect(fake.runs[0]!.signal.aborted).toBe(true);
      expect(() => cancelRun(id, runId)).not.toThrow();
      expect(getSnapshot(id)?.cancelling).toBe('budget');
      fake.runs[0]!.release();
      await until(() => getSnapshot(id)?.running === false, '실행 끝');
    } finally {
      delete process.env.B_STUDIO_SESSION_TOKEN_LIMIT;
    }
  });
});
