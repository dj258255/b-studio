import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

const fake = vi.hoisted(() => ({
  counter: 0,
  listeners: new Map<string, (event: StudioEvent) => void>(),
  createSession: vi.fn(async (...args: [string, string, 'copy', { modelId?: string }]) => {
    const projectId = args[0];
    return { id: `session-${++fake.counter}`, projectName: projectId === 'orders' ? 'Orders' : projectId, status: 'ready' };
  }),
  sendMessage: vi.fn((...args: [string, string, { allowBreaking: boolean; by: string }]) => ({ runId: `run-${args[0]}` })),
  getSnapshot: vi.fn(() => undefined),
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

vi.mock('./sessions', () => ({
  createSession: fake.createSession,
  getSnapshot: fake.getSnapshot,
  sendMessage: fake.sendMessage,
  subscribe: (id: string, listener: (event: StudioEvent) => void) => {
    fake.listeners.set(id, listener);
    listener({ type: 'snapshot', snapshot: { status: 'ready' } as never });
    return () => fake.listeners.delete(id);
  },
}));

import { chooseFleetWinner, createFleet, getFleet } from './fleets';

const directory = mkdtempSync(path.join(tmpdir(), 'b-studio-fleets-'));
const originalMode = process.env.B_STUDIO_MODE;
const originalDirectory = process.env.B_STUDIO_FLEETS_DIR;

beforeEach(() => {
  fake.listeners.clear();
  fake.createSession.mockClear();
  fake.sendMessage.mockClear();
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_FLEETS_DIR = directory;
});

afterAll(() => {
  if (originalMode === undefined) delete process.env.B_STUDIO_MODE;
  else process.env.B_STUDIO_MODE = originalMode;
  if (originalDirectory === undefined) delete process.env.B_STUDIO_FLEETS_DIR;
  else process.env.B_STUDIO_FLEETS_DIR = originalDirectory;
  rmSync(directory, { recursive: true, force: true });
});

describe('Agent Fleet', () => {
  it('모델마다 독립 복사본 세션을 만들고 같은 요청을 한 번씩 보낸다', async () => {
    const fleet = await createFleet({ projectId: 'orders', request: '주문 검색을 추가해줘', modelIds: ['model-a', 'model-b'], owner: 'alice' });

    expect(fleet.members).toHaveLength(2);
    expect(fleet.members.every((member) => member.status === 'running')).toBe(true);
    expect(fake.createSession.mock.calls.map((call) => call[3])).toEqual([{ modelId: 'model-a' }, { modelId: 'model-b' }]);
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
});
