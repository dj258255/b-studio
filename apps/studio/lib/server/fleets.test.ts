import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

const fake = vi.hoisted(() => ({
  counter: 0,
  /** CLI 로그인 확인에 넘기는 프로젝트 루트 */
  root: '/tmp/orders-project',
  listeners: new Map<string, (event: StudioEvent) => void>(),
  createSession: vi.fn(async (...args: [string, string, 'copy', { modelId?: string; backend?: string }]) => {
    const projectId = args[0];
    return { id: `session-${++fake.counter}`, projectName: projectId === 'orders' ? 'Orders' : projectId, status: 'ready' };
  }),
  sendMessage: vi.fn((...args: [string, string, { allowBreaking: boolean; by: string }]) => ({ runId: `run-${args[0]}` })),
  getSnapshot: vi.fn(() => undefined),
  stopAndDeleteSession: vi.fn(async (...args: [string]) => {
    fake.stopAndDeleted.push(args[0]);
  }),
  stopAndDeleted: [] as string[],
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
    stopAndDeleteSession: fake.stopAndDeleteSession,
    subscribe: (id: string, listener: (event: StudioEvent) => void) => {
      fake.listeners.set(id, listener);
      listener({ type: 'snapshot', snapshot: { status: 'ready' } as never });
      return () => fake.listeners.delete(id);
    },
  };
});

vi.mock('./projects', () => ({ findProject: async () => ({ root: fake.root }) }));

import { StudioError } from './errors';
import { chooseFleetWinner, createFleet, defaultFleetCandidates, deleteFleet, getFleet, listFleets } from './fleets';

const directory = mkdtempSync(path.join(tmpdir(), 'b-studio-fleets-'));
const saved = {
  mode: process.env.B_STUDIO_MODE,
  backends: process.env.B_STUDIO_BACKENDS,
  dir: process.env.B_STUDIO_FLEETS_DIR,
};

beforeEach(() => {
  fake.listeners.clear();
  fake.createSession.mockClear();
  fake.sendMessage.mockClear();
  fake.stopAndDeleteSession.mockClear();
  fake.stopAndDeleted = [];
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
