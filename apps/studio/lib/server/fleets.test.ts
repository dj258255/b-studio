import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

const fake = vi.hoisted(() => ({
  counter: 0,
  /** CLI 로그인 확인에 넘기는 프로젝트 루트 */
  root: '/tmp/orders-project',
  listeners: new Map<string, (event: StudioEvent) => void>(),
  createSession: vi.fn(async (...args: [string, string, 'copy', { modelId?: string; backend?: string; accountId?: string }]) => {
    const projectId = args[0];
    return { id: `session-${++fake.counter}`, projectName: projectId === 'orders' ? 'Orders' : projectId, status: 'ready' };
  }),
  sendMessage: vi.fn((...args: [string, string, { allowBreaking: boolean; by: string }]) => ({ runId: `run-${args[0]}` })),
  getSnapshot: vi.fn(() => undefined),
  stopAndDeleteSession: vi.fn(async (...args: [string]) => {
    fake.stopAndDeleted.push(args[0]);
  }),
  stopAndDeleted: [] as string[],
  /** 터미널 Fleet 시험이 호출 순서를 보는 기록 */
  calls: [] as string[],
  setTerminalCheckChanges: vi.fn((id: string, allow: boolean) => {
    fake.calls.push(`check:${id}:${allow}`);
    return allow;
  }),
  models: [
    {
      id: 'model-a',
      provider: 'anthropic',
      model: 'a',
      label: 'Model A',
      enabled: true,
      configured: true,
      capabilities: ['tools'],
      contextWindow: 100_000,
      pricing: { inputPerMillion: 1, outputPerMillion: 2 },
      baselineQuality: 0.9,
      baselineLatencyMs: 1_000,
    },
    {
      id: 'model-b',
      provider: 'openai',
      model: 'b',
      label: 'Model B',
      enabled: true,
      configured: true,
      capabilities: ['tools'],
      contextWindow: 100_000,
      pricing: { inputPerMillion: 1, outputPerMillion: 2 },
      baselineQuality: 0.8,
      baselineLatencyMs: 800,
    },
  ],
}));

vi.mock('./model-registry', () => ({
  listModelOptions: () => fake.models,
  modelById: (id: string) => fake.models.find((model) => model.id === id),
}));

// 허용 목록·백엔드 확정·로그인 확인은 실제 함수를 쓰고(서버 동작 그대로), 세션 객체만 바꿔 끼운다
vi.mock('./sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessions')>();
  return {
    ...actual,
    createSession: fake.createSession,
    getSnapshot: fake.getSnapshot,
    sendMessage: fake.sendMessage,
    setTerminalCheckChanges: fake.setTerminalCheckChanges,
    stopAndDeleteSession: fake.stopAndDeleteSession,
    subscribe: (id: string, listener: (event: StudioEvent) => void) => {
      fake.listeners.set(id, listener);
      listener({ type: 'snapshot', snapshot: { status: 'ready' } as never });
      return () => fake.listeners.delete(id);
    },
  };
});

vi.mock('./projects', () => ({ findProject: async () => ({ root: fake.root }) }));

// 계정 목록(#885) 대신: acct-pio는 설정 폴더를 둔 Codex 계정, codex는 기본 계정, 그 밖은 목록에 없다
vi.mock('./ai-accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai-accounts')>();
  return {
    ...actual,
    resolveSessionAccount: async (id: string | undefined, backend: string) => {
      if (id === undefined || id === backend) return undefined;
      if (id === 'acct-pio' && backend === 'codex') return { id: 'acct-pio', name: '피오', backend: 'codex', configDir: '/home/me/.b-studio/accounts/codex-1' };
      throw new StudioError(400, `계정이 목록에 없습니다: ${id}`);
    },
  };
});

import { StudioError } from './errors';
import { chooseFleetWinner, createFleet, defaultFleetCandidates, deleteFleet, getFleet, listFleets, setFleetTerminalDepsForTest } from './fleets';
import type { TerminalTaskDeps } from './terminal-lane';

const directory = mkdtempSync(path.join(tmpdir(), 'b-studio-fleets-'));
const saved = {
  mode: process.env.B_STUDIO_MODE,
  backends: process.env.B_STUDIO_BACKENDS,
  dir: process.env.B_STUDIO_FLEETS_DIR,
  terminal: process.env.B_STUDIO_TERMINAL,
  experimental: process.env.B_STUDIO_EXPERIMENTAL,
};

beforeEach(() => {
  fake.listeners.clear();
  fake.createSession.mockClear();
  fake.sendMessage.mockClear();
  fake.stopAndDeleteSession.mockClear();
  fake.stopAndDeleted = [];
  fake.calls = [];
  fake.setTerminalCheckChanges.mockClear();
  setFleetTerminalDepsForTest(undefined);
  delete process.env.B_STUDIO_TERMINAL;
  delete process.env.B_STUDIO_EXPERIMENTAL;
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_FLEETS_DIR = directory;
  // 허용 목록은 서버 모드 하나뿐이다. 넓히는 테스트만 직접 세운다
  delete process.env.B_STUDIO_BACKENDS;
});

afterAll(() => {
  for (const [key, value] of [
    ['B_STUDIO_MODE', saved.mode],
    ['B_STUDIO_BACKENDS', saved.backends],
    ['B_STUDIO_FLEETS_DIR', saved.dir],
    ['B_STUDIO_TERMINAL', saved.terminal],
    ['B_STUDIO_EXPERIMENTAL', saved.experimental],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

describe('defaultFleetCandidates', () => {
  it('허용 백엔드가 하나면 같은 백엔드로 두 번, 둘 이상이면 백엔드마다 하나', () => {
    // 모델이 하나여도 독립 시도 두 개를 비교하는 것이 Fleet의 원래 뜻이다
    expect(defaultFleetCandidates(['api'])).toEqual([{ backend: 'api' }, { backend: 'api' }]);
    expect(defaultFleetCandidates(['claude-code', 'claude-code'])).toEqual([{ backend: 'claude-code' }, { backend: 'claude-code' }]);
    expect(defaultFleetCandidates(['api', 'codex'])).toEqual([{ backend: 'api' }, { backend: 'codex' }]);
  });
});

describe('Agent Fleet', () => {
  it('모델마다 독립 복사본 세션을 만들고 같은 요청을 한 번씩 보낸다', async () => {
    const fleet = await createFleet({ projectId: 'orders', request: '주문 검색을 추가해줘', modelIds: ['model-a', 'model-b'], owner: 'alice' });

    expect(fleet.members).toHaveLength(2);
    expect(fleet.members.every((member) => member.status === 'running')).toBe(true);
    // 기존 API 입력(모델 id 목록)은 {backend:'api', model:<id>} 후보와 같다
    expect(fake.createSession.mock.calls.map((call) => call[3])).toEqual([{ backend: 'api', modelId: 'model-a' }, { backend: 'api', modelId: 'model-b' }]);
    expect(fleet.members.map((member) => [member.backend, member.modelId, member.label])).toEqual([
      ['api', 'model-a', 'Model A'],
      ['api', 'model-b', 'Model B'],
    ]);
    expect(fake.sendMessage.mock.calls.map((call) => [call[0], call[1]])).toEqual(
      fleet.members.map((member) => [member.sessionId, '주문 검색을 추가해줘']),
    );
  });

  it('게이트를 통과한 후보만 선택하고 실행이 끝나면 구독을 해제한다', async () => {
    const fleet = await createFleet({ projectId: 'orders', request: '검색을 추가해줘', modelIds: ['model-a', 'model-b'], owner: 'bob' });
    const member = fleet.members[0]!;
    fake.listeners.get(member.sessionId)?.({
      type: 'run_finished',
      runId: member.runId!,
      status: 'done',
      summary: '검증 통과',
      turns: 2,
      usage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });

    const chosen = chooseFleetWinner(fleet.id, member.sessionId, 'bob');
    expect(chosen.winnerSessionId).toBe(member.sessionId);
    expect(chosen.members[0]).toMatchObject({ status: 'done', turns: 2, costUsd: 0.002 });
    expect(fake.listeners.has(member.sessionId)).toBe(false);
    expect(() => chooseFleetWinner(fleet.id, fleet.members[1]!.sessionId, 'bob')).toThrow('검증을 통과한 결과만');
    expect(() => getFleet(fleet.id, 'mallory')).toThrow('볼 수 없습니다');
  });

  it('CLI 후보는 그 백엔드로 멤버 세션을 만들고, 만들기 전에 로그인을 한 번 확인한다', async () => {
    process.env.B_STUDIO_BACKENDS = 'claude-code';
    const preflights = { claudeCode: vi.fn(async () => ({ ok: true as const })) };

    const fleet = await createFleet({
      projectId: 'orders',
      request: '구독으로 비교해줘',
      candidates: [{ backend: 'claude-code', model: 'sonnet' }, { backend: 'claude-code' }],
      owner: 'dora',
      preflights,
    });

    expect(fleet.members).toHaveLength(2);
    // 같은 CLI 백엔드는 한 번만 확인한다(멤버 수만큼 부르지 않는다)
    expect(preflights.claudeCode).toHaveBeenCalledTimes(1);
    // 멤버 세션은 레인과 같은 방식으로 backend·model을 싣는다(모델이 없으면 그 CLI의 계정 기본)
    expect(fake.createSession.mock.calls.map((call) => call[3])).toEqual([{ backend: 'claude-code', modelId: 'sonnet' }, { backend: 'claude-code' }]);
    expect(fleet.members.map((member) => [member.backend, member.modelId, member.label, member.provider])).toEqual([
      ['claude-code', 'sonnet', 'sonnet', 'claude-code'],
      ['claude-code', undefined, '계정 기본', 'claude-code'],
    ]);
  });

  it('CLI 후보에 계정을 고르면 그 계정의 설정 폴더로 로그인을 확인하고 멤버 세션에 계정을 싣는다', async () => {
    process.env.B_STUDIO_BACKENDS = 'codex';
    const codex = vi.fn<(options?: { env?: NodeJS.ProcessEnv }) => Promise<{ ok: true }>>(async () => ({ ok: true }));

    const fleet = await createFleet({
      projectId: 'orders',
      request: '계정마다 비교해줘',
      candidates: [{ backend: 'codex', accountId: 'acct-pio' }, { backend: 'codex', accountId: 'acct-pio', model: 'gpt-5' }, { backend: 'codex' }],
      owner: 'jun',
      preflights: { codex },
    });

    // 같은 백엔드·같은 계정은 한 번만, 다른 계정(기본)은 따로 확인한다
    expect(codex).toHaveBeenCalledTimes(2);
    expect(codex.mock.calls.map((call) => call[0]?.env?.CODEX_HOME)).toEqual(['/home/me/.b-studio/accounts/codex-1', undefined]);
    expect(fake.createSession.mock.calls.map((call) => call[3])).toEqual([
      { backend: 'codex', accountId: 'acct-pio' },
      { backend: 'codex', modelId: 'gpt-5', accountId: 'acct-pio' },
      { backend: 'codex' },
    ]);
    expect(fleet.members.map((member) => [member.accountId, member.label])).toEqual([
      ['acct-pio', '피오'],
      ['acct-pio', '피오 · gpt-5'],
      [undefined, '계정 기본'],
    ]);
  });

  it('목록에 없는 계정이나 api 후보의 계정은 세션을 만들기 전에 거부한다', async () => {
    process.env.B_STUDIO_BACKENDS = 'codex';
    const preflights = { codex: async () => ({ ok: true as const }) };

    await expect(createFleet({ projectId: 'orders', request: '요청', candidates: [{ backend: 'codex', accountId: 'acct-none' }, { backend: 'codex' }], owner: 'kyle', preflights })).rejects.toMatchObject({ status: 400 });
    await expect(createFleet({ projectId: 'orders', request: '요청', candidates: [{ backend: 'api', model: 'model-a', accountId: 'acct-pio' }, { backend: 'codex' }], owner: 'kyle', preflights })).rejects.toMatchObject({ status: 400 });
    expect(fake.createSession).not.toHaveBeenCalled();
    expect(listFleets('kyle')).toEqual([]);
  });

  it('허용 목록 밖 백엔드 후보는 세션을 만들기 전에 거부한다', async () => {
    const error = await createFleet({ projectId: 'orders', request: '요청', candidates: [{ backend: 'codex' }, { backend: 'codex' }], owner: 'eve' }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(StudioError);
    expect((error as StudioError).status).toBe(400);
    expect((error as StudioError).message).toContain('쓸 수 없는 백엔드');
    expect(fake.createSession).not.toHaveBeenCalled();
  });

  it('CLI 로그인 확인에 실패하면 Fleet을 만들지 않는다(절반만 뜬 비교를 남기지 않는다)', async () => {
    process.env.B_STUDIO_BACKENDS = 'claude-code';
    const error = await createFleet({
      projectId: 'orders',
      request: '요청',
      candidates: [{ backend: 'claude-code' }, { backend: 'api', model: 'model-a' }],
      owner: 'fred',
      preflights: { claudeCode: async () => ({ ok: false as const, reason: '로그인이 필요합니다' }) },
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect((error as Error).message).toContain('로그인이 필요합니다');
    expect(fake.createSession).not.toHaveBeenCalled();
    expect(listFleets('fred')).toEqual([]);
  });

  it('후보를 주지 않으면 허용 백엔드가 하나일 때 같은 백엔드로 두 번 만든다', async () => {
    const fleet = await createFleet({ projectId: 'orders', request: '기본 후보', owner: 'gina' });

    // 같은 백엔드로 독립 시도 두 개. 모델은 고르지 않으므로 요청마다 라우터가 고른다
    expect(fleet.members).toHaveLength(2);
    expect(fleet.members.map((member) => [member.backend, member.modelId, member.label])).toEqual([
      ['api', undefined, '서버 기본 모델'],
      ['api', undefined, '서버 기본 모델'],
    ]);
    expect(fake.createSession.mock.calls.map((call) => call[3])).toEqual([{ backend: 'api' }, { backend: 'api' }]);
  });

  it('후보를 주지 않으면 허용 백엔드마다 하나씩 만든다', async () => {
    process.env.B_STUDIO_BACKENDS = 'claude-code,codex';

    const fleet = await createFleet({
      projectId: 'orders',
      request: '백엔드마다 하나',
      owner: 'gina',
      preflights: { claudeCode: async () => ({ ok: true as const }), codex: async () => ({ ok: true as const }) },
    });

    expect(fleet.members.map((member) => member.backend).sort()).toEqual(['api', 'claude-code', 'codex']);
  });

  it('데모 모드에서는 여러 후보 비교를 만들지 않는다', async () => {
    process.env.B_STUDIO_MODE = 'demo';

    await expect(createFleet({ projectId: 'orders', request: '요청', modelIds: ['model-a', 'model-b'], owner: 'iris' })).rejects.toThrow(/데모가 아닌 모드/);
    expect(fake.createSession).not.toHaveBeenCalled();
  });

  it('실행이 모델을 바꿔 돌았으면 모델별 사용량을 멤버에 남긴다', async () => {
    const fleet = await createFleet({ projectId: 'orders', request: '승격 실행', modelIds: ['model-a', 'model-b'], owner: 'hana' });
    const member = fleet.members[0]!;
    const usageByModel = {
      'model-a': { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      'model-b': { inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };

    fake.listeners.get(member.sessionId)?.({
      type: 'run_finished',
      runId: member.runId!,
      status: 'done',
      summary: '검증 통과',
      turns: 2,
      usage: { inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      metrics: { modelCalls: 3, maxContextTokens: 100, modelMs: 1, toolMs: 1, gateMs: 1, usageByModel },
    });

    expect(getFleet(fleet.id, 'hana').members[0]!.usageByModel).toEqual(usageByModel);
  });

  // Fleet은 메모리의 객체가 원본이고 persist는 그 객체 전체를 쓴다. 두 멤버가 동시에 끝나도 한쪽 결과가 저장에서 빠지면 안 된다
  it('여러 멤버의 결과가 동시에 들어와도 저장 파일에 모두 남는다', async () => {
    const fleet = await createFleet({ projectId: 'orders', request: '검색을 추가해줘', modelIds: ['model-a', 'model-b'], owner: 'carol' });
    const [first, second] = fleet.members;
    const finish = (member: typeof first) =>
      fake.listeners.get(member.sessionId)!({
        type: 'run_finished',
        runId: member.runId!,
        status: 'done',
        summary: `${member.label} 완료`,
        turns: 3,
        usage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });
    await Promise.all([Promise.resolve().then(() => finish(first!)), Promise.resolve().then(() => finish(second!))]);

    const saved = JSON.parse(readFileSync(path.join(directory, `${fleet.id}.json`), 'utf8')) as { members: Array<{ status: string; turns?: number }> };
    expect(saved.members.map((member) => member.status)).toEqual(['done', 'done']);
    expect(saved.members.map((member) => member.turns)).toEqual([3, 3]);
  });
});

describe('deleteFleet', () => {
  it('진행 중인 참가자가 있으면 지우지 않는다', async () => {
    const fleet = await createFleet({ projectId: 'orders', request: '요청', modelIds: ['model-a', 'model-b'], owner: 'kay' });
    // 멤버가 아직 running 상태다(끝나는 이벤트를 보내지 않았다)

    await expect(deleteFleet(fleet.id, 'kay')).rejects.toThrow(/진행 중인 참가자/);
    expect(fake.stopAndDeleteSession).not.toHaveBeenCalled();
    expect(getFleet(fleet.id, 'kay')).toMatchObject({ id: fleet.id });
  });

  it('내가 만든 Fleet이 아니면 지울 수 없다', async () => {
    const fleet = await createFleet({ projectId: 'orders', request: '요청', modelIds: ['model-a', 'model-b'], owner: 'kay' });

    await expect(deleteFleet(fleet.id, 'mallory')).rejects.toThrow(/지울 수 없습니다/);
  });

  it('없는 Fleet은 404로 알린다', async () => {
    await expect(deleteFleet('nope', 'kay')).rejects.toThrow(/찾을 수 없습니다/);
  });

  it('모든 참가자가 끝나면 지우고, 끝난 참가자의 세션도 함께 지운다', async () => {
    const fleet = await createFleet({ projectId: 'orders', request: '요청', modelIds: ['model-a', 'model-b'], owner: 'kay' });
    for (const member of fleet.members) {
      fake.listeners.get(member.sessionId)?.({ type: 'run_finished', runId: member.runId!, status: 'done', summary: '끝', turns: 1 });
    }

    await deleteFleet(fleet.id, 'kay');

    expect(fake.stopAndDeleteSession).toHaveBeenCalledTimes(2);
    expect(fake.stopAndDeleteSession.mock.calls.map((call) => call[0]).sort()).toEqual(fleet.members.map((member) => member.sessionId).sort());
    expect(() => getFleet(fleet.id, 'kay')).toThrow('찾을 수 없습니다');
    expect(() => readFileSync(path.join(directory, `${fleet.id}.json`), 'utf8')).toThrow();
  });

  it('세션을 만들지 못해 실패한 참가자(`failed-`)는 지우기를 부르지 않는다', async () => {
    fake.createSession.mockImplementationOnce(async () => {
      throw new Error('샌드박스를 켜지 못했습니다');
    });
    const fleet = await createFleet({ projectId: 'orders', request: '요청', modelIds: ['model-a', 'model-b'], owner: 'kay' });
    expect(fleet.members[0]!.status).toBe('error');
    fake.listeners.get(fleet.members[1]!.sessionId)?.({ type: 'run_finished', runId: fleet.members[1]!.runId!, status: 'done', summary: '끝', turns: 1 });

    await deleteFleet(fleet.id, 'kay');

    expect(fake.stopAndDeleteSession).toHaveBeenCalledTimes(1);
    expect(fake.stopAndDeleteSession).toHaveBeenCalledWith(fleet.members[1]!.sessionId);
  });
});

/**
 * 터미널 Fleet 시험의 가짜 터미널. 세션마다 붙여 넣은 글을 기억했다가 Enter가 오면 그 글로 run_started를 흘린다.
 * 이벤트는 Fleet의 구독(fake.listeners)과 runTerminalTask의 구독 양쪽에 간다(실제 세션의 subscribe가 둘 다에 알리는 것과 같다)
 */
function terminalHarness(config: { openFails?: (sessionId: string) => boolean } = {}) {
  const pasted = new Map<string, string>();
  const lane = new Map<string, (event: StudioEvent) => void>();
  const state = { status: 'ready' as string, cliUp: true };
  const emit = (sessionId: string, event: StudioEvent): void => {
    lane.get(sessionId)?.(event);
    fake.listeners.get(sessionId)?.(event);
  };
  const deps: Partial<TerminalTaskDeps> = {
    driver: {
      open: async (sessionId) => {
        fake.calls.push(`open:${sessionId}`);
        if (config.openFails?.(sessionId)) throw new Error('터미널을 열지 못했습니다');
      },
      cliAlive: () => state.cliUp,
      write: (sessionId, data) => {
        if (data.startsWith('\x1b[200~')) {
          fake.calls.push(`paste:${sessionId}`);
          pasted.set(sessionId, data.slice('\x1b[200~'.length, -'\x1b[201~'.length));
          return;
        }
        emit(sessionId, { type: 'run_started', runId: `trun-${sessionId}`, request: pasted.get(sessionId) ?? '', via: 'terminal' } as StudioEvent);
      },
    },
    subscribe: (sessionId, listener) => {
      lane.set(sessionId, listener);
      return () => lane.delete(sessionId);
    },
    readEvents: () => [],
    setTaskContext: (sessionId, context) => {
      fake.calls.push(`context:${sessionId}:${context === undefined ? 'clear' : context.writableScope.join(',')}`);
    },
    status: () => state.status,
    attention: () => undefined,
    openRunId: () => undefined,
    cancelRun: () => {},
    trustFailure: () => undefined,
    closeTimeoutMs: 50,
    cliTimeoutMs: 200,
    submitTimeoutMs: 200,
    runTimeoutMs: 2_000,
    usageGraceMs: 0,
    pollMs: 2,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  setFleetTerminalDepsForTest(deps);
  return { emit, state };
}

async function until(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

const USAGE = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('터미널 Fleet', () => {
  async function terminalFleet(overrides: { allowBreaking?: boolean; owner?: string } = {}) {
    process.env.B_STUDIO_BACKENDS = 'claude-code';
    return createFleet({
      projectId: 'orders',
      request: '검색을 추가해줘',
      candidates: [{ backend: 'claude-code', model: 'sonnet' }, { backend: 'claude-code' }],
      owner: overrides.owner ?? 'tess',
      runner: 'terminal',
      ...(overrides.allowBreaking ? { allowBreaking: true } : {}),
      preflights: { claudeCode: async () => ({ ok: true as const }) },
    });
  }

  it('두 멤버가 세션 터미널에서 끝까지 돌고 각자의 runId·결과·비용이 남는다(채팅 sendMessage는 부르지 않는다)', async () => {
    const harness = terminalHarness();
    const created = await terminalFleet();
    expect(created.runner).toBe('terminal');
    const [first, second] = created.members;

    await until(() => getFleet(created.id, 'tess').members.every((member) => member.status === 'running'), '멤버가 running이 되지 않았습니다');
    expect(getFleet(created.id, 'tess').members.map((member) => member.runId)).toEqual([`trun-${first!.sessionId}`, `trun-${second!.sessionId}`]);
    // 실행이 시작된 뒤의 체크포인트는 Fleet의 구독이 그 runId로 받는다
    harness.emit(first!.sessionId, { type: 'checkpoint', runId: `trun-${first!.sessionId}`, checkpoint: { sha: 'abcdef123456', shortSha: 'abcdef1', files: ['a.ts'] } } as StudioEvent);

    for (const [index, member] of created.members.entries()) {
      const runId = `trun-${member.sessionId}`;
      harness.emit(member.sessionId, { type: 'run_usage', runId, usage: USAGE, costUsd: 0.25 * (index + 1) } as StudioEvent);
      harness.emit(member.sessionId, { type: 'run_finished', runId, status: 'done', summary: `${index}번 끝`, turns: 9, usage: { ...USAGE, inputTokens: 999 } } as StudioEvent);
    }
    await until(() => getFleet(created.id, 'tess').members.every((member) => member.status === 'done'), '멤버가 끝나지 않았습니다');

    const members = getFleet(created.id, 'tess').members;
    expect(members.map((member) => [member.runId, member.status, member.summary, member.costUsd])).toEqual([
      [`trun-${first!.sessionId}`, 'done', '0번 끝', 0.25],
      [`trun-${second!.sessionId}`, 'done', '1번 끝', 0.5],
    ]);
    // 사용량은 run_usage(텔레메트리)를 더한 값, 턴 수는 알 수 없어 두지 않는다
    expect(members[0]!.usage).toEqual(USAGE);
    expect(members[0]!.turns).toBeUndefined();
    expect(members[0]!.checkpoint).toEqual({ sha: 'abcdef123456', shortSha: 'abcdef1', files: ['a.ts'] });
    expect(members.every((member) => member.waiting === undefined && member.finishedAt)).toBe(true);
    expect(fake.sendMessage).not.toHaveBeenCalled();
    // 끝난 멤버의 구독은 풀린다
    expect(fake.listeners.has(first!.sessionId)).toBe(false);
    // 쓰기 범위를 걸지 않는다: 카드 범위가 빈 목록이면 어디에도 못 쓰는 뜻이라 Fleet이 일하지 못한다
    expect(fake.calls.filter((call) => call.startsWith('context:') && !call.endsWith(':clear'))).toEqual([]);
    const saved = JSON.parse(readFileSync(path.join(directory, `${created.id}.json`), 'utf8')) as { runner: string; members: Array<{ status: string }> };
    expect(saved.runner).toBe('terminal');
    expect(saved.members.map((member) => member.status)).toEqual(['done', 'done']);
  });

  it('runner를 주지 않으면 chat이고, 모르는 값은 세션을 만들기 전에 거절한다', async () => {
    const fleet = await createFleet({ projectId: 'orders', request: '요청', modelIds: ['model-a', 'model-b'], owner: 'tess' });
    expect(fleet.runner).toBe('chat');
    expect(fake.sendMessage).toHaveBeenCalledTimes(2);
    fake.createSession.mockClear();
    await expect(createFleet({ projectId: 'orders', request: '요청', modelIds: ['model-a', 'model-b'], owner: 'tess', runner: 'pty' as never })).rejects.toMatchObject({ status: 400 });
    expect(fake.createSession).not.toHaveBeenCalled();
  });

  it.each([
    ['api 후보', { backends: 'api', terminal: undefined, experimental: undefined, candidates: [{ backend: 'api' as const, model: 'model-a' }, { backend: 'api' as const, model: 'model-b' }], message: '아직 터미널에서 띄우지 못하는 백엔드입니다: api' }],
    ['컨테이너 방식의 codex', { backends: 'codex', terminal: 'container', experimental: '1', candidates: [{ backend: 'codex' as const }, { backend: 'codex' as const }], message: '아직 터미널에서 띄우지 못하는 백엔드입니다: codex' }],
    ['터미널을 쓸 수 없는 서버', { backends: 'claude-code', terminal: 'container', experimental: undefined, candidates: [{ backend: 'claude-code' as const }, { backend: 'claude-code' as const }], message: '세션 터미널' }],
  ])('%s는 400으로 거절하고 세션을 만들지 않는다', async (_name, setup) => {
    process.env.B_STUDIO_BACKENDS = setup.backends;
    if (setup.terminal) process.env.B_STUDIO_TERMINAL = setup.terminal;
    if (setup.experimental) process.env.B_STUDIO_EXPERIMENTAL = setup.experimental;
    const error = await createFleet({
      projectId: 'orders',
      request: '요청',
      candidates: setup.candidates,
      owner: 'rejected-owner',
      runner: 'terminal',
      preflights: { claudeCode: async () => ({ ok: true as const }), codex: async () => ({ ok: true as const }) },
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(StudioError);
    expect((error as StudioError).status).toBe(400);
    expect((error as StudioError).message).toContain(setup.message);
    expect(fake.createSession).not.toHaveBeenCalled();
    expect(listFleets('rejected-owner')).toEqual([]);
  });

  it('이 컴퓨터 방식이면 codex 후보도 받는다', async () => {
    terminalHarness();
    process.env.B_STUDIO_BACKENDS = 'codex';
    const fleet = await createFleet({
      projectId: 'orders',
      request: '요청',
      candidates: [{ backend: 'codex' }, { backend: 'codex' }],
      owner: 'tess',
      runner: 'terminal',
      preflights: { codex: async () => ({ ok: true as const }) },
    });
    expect(fleet.members).toHaveLength(2);
    expect(fake.createSession).toHaveBeenCalledTimes(2);
  });

  it('터미널 방식은 호환성을 깨는 변경 허용(allowBreaking)을 받지 못해 세션을 만들기 전에 400으로 거절한다(다른 허용으로 바꿔 켜지 않는다)', async () => {
    terminalHarness();
    const error = await terminalFleet({ allowBreaking: true }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(StudioError);
    expect((error as StudioError).status).toBe(400);
    expect(fake.createSession).not.toHaveBeenCalled();
    expect(fake.setTerminalCheckChanges).not.toHaveBeenCalled();
  });

  it('터미널 멤버를 돌릴 때 확인 선언 변경 허용을 켜지 않는다', async () => {
    terminalHarness();
    const created = await terminalFleet();
    await until(() => getFleet(created.id, 'tess').members.every((member) => member.status === 'running'), '멤버가 running이 되지 않았습니다');
    expect(fake.setTerminalCheckChanges).not.toHaveBeenCalled();
  });

  it('실행이 던지면 그 멤버만 error가 되고, 이미 끝난 멤버는 덮어쓰지 않는다', async () => {
    // 두 번째로 여는 터미널(둘째 멤버)만 열리지 않는다
    let opens = 0;
    const harness = terminalHarness({ openFails: () => (opens += 1) === 2 });
    const created = await terminalFleet();
    const [firstId] = created.members.map((member) => member.sessionId) as [string, string];
    await until(() => getFleet(created.id, 'tess').members[1]!.status === 'error', '던진 멤버가 error가 되지 않았습니다');
    expect(getFleet(created.id, 'tess').members[1]).toMatchObject({ status: 'error', summary: '터미널을 열지 못했습니다' });
    expect(getFleet(created.id, 'tess').members[0]!.status).not.toBe('error');

    // 첫 멤버는 실행 중 샌드박스가 멈춰 Fleet이 먼저 닫는다. 그 뒤 runTerminalTask가 던져도 덮어쓰지 않는다
    await until(() => getFleet(created.id, 'tess').members[0]!.status === 'running', '첫 멤버가 running이 되지 않았습니다');
    harness.state.status = 'stopped';
    harness.emit(firstId, { type: 'status', status: 'stopped' } as StudioEvent);
    await until(() => getFleet(created.id, 'tess').members[0]!.status === 'error', '멈춘 멤버가 error가 되지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(getFleet(created.id, 'tess').members[0]!.summary).toBe('샌드박스가 중지됐습니다');
  });

  it('Fleet이 먼저 닫은 멤버는, 실행이 뒤늦게 done으로 끝나도 덮어쓰지 않는다', async () => {
    const harness = terminalHarness();
    const created = await terminalFleet();
    await until(() => getFleet(created.id, 'tess').members.every((member) => member.status === 'running'), '멤버가 running이 되지 않았습니다');
    const member = created.members[0]!;

    // 세션 상태는 그대로 두고 Fleet만 멈춤 이벤트를 받는다(실행은 계속 돈다)
    harness.emit(member.sessionId, { type: 'status', status: 'stopped' } as StudioEvent);
    expect(getFleet(created.id, 'tess').members[0]).toMatchObject({ status: 'error', summary: '샌드박스가 중지됐습니다' });
    harness.emit(member.sessionId, { type: 'run_finished', runId: `trun-${member.sessionId}`, status: 'done', summary: '뒤늦은 완료', usage: USAGE } as StudioEvent);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(getFleet(created.id, 'tess').members[0]).toMatchObject({ status: 'error', summary: '샌드박스가 중지됐습니다' });
  });

  it('CLI가 뜨기를 기다리는 동안 멤버에 기다리는 안내를 남기고, 뜨면 지운다', async () => {
    const harness = terminalHarness();
    harness.state.cliUp = false;
    const created = await terminalFleet();
    await until(() => getFleet(created.id, 'tess').members.every((member) => member.waiting?.includes('claude가 뜨기를 기다립니다')), '기다리는 안내가 남지 않았습니다');

    harness.state.cliUp = true;
    await until(() => getFleet(created.id, 'tess').members.every((member) => member.status === 'running'), '멤버가 running이 되지 않았습니다');
    expect(getFleet(created.id, 'tess').members.every((member) => member.waiting === undefined)).toBe(true);
  });

  it('서버를 다시 켜면 끝나지 않은 터미널 멤버는 세션이 살아 있어도 이어받지 못함으로 닫고, 채팅 멤버는 이어받는다', async () => {
    const globals = globalThis as typeof globalThis & { __bStudioFleets?: { fleets: Map<string, unknown>; subscribed: Set<string>; loaded: boolean } };
    const store = globals.__bStudioFleets!;
    const restartDir = mkdtempSync(path.join(tmpdir(), 'b-studio-fleets-restart-'));
    const previousDir = process.env.B_STUDIO_FLEETS_DIR;
    const member = (sessionId: string) => ({ sessionId, backend: 'claude-code', label: 'x', provider: 'claude-code', status: 'running', runId: 'r1' });
    const base = { owner: 'tess', projectId: 'orders', projectName: 'Orders', request: '요청', allowBreaking: false, createdAt: new Date().toISOString() };
    try {
      process.env.B_STUDIO_FLEETS_DIR = restartDir;
      writeFileSync(path.join(restartDir, 'term0001.json'), JSON.stringify({ ...base, id: 'term0001', runner: 'terminal', members: [member('s-term')] }));
      writeFileSync(path.join(restartDir, 'chat0001.json'), JSON.stringify({ ...base, id: 'chat0001', members: [member('s-chat')] }));
      fake.getSnapshot.mockImplementation((() => ({ status: 'ready' })) as never);
      store.fleets.clear();
      store.subscribed.clear();
      store.loaded = false;

      expect(getFleet('term0001', 'tess').members[0]).toMatchObject({ status: 'error', summary: 'Studio가 다시 시작되어 진행 상태를 이어받지 못했습니다. 세션을 열어 기록을 확인하세요.' });
      // 옛 기록(runner 없음)은 chat이고, 세션이 살아 있으면 지금처럼 이어받는다
      expect(getFleet('chat0001', 'tess')).toMatchObject({ runner: 'chat' });
      expect(getFleet('chat0001', 'tess').members[0]!.status).toBe('running');
    } finally {
      fake.getSnapshot.mockImplementation((() => undefined) as never);
      store.fleets.clear();
      store.subscribed.clear();
      process.env.B_STUDIO_FLEETS_DIR = previousDir;
      rmSync(restartDir, { recursive: true, force: true });
    }
  });
});
