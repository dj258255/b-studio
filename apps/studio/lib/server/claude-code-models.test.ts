import type { ModelInfo } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import { createClaudeCodeModelsCache } from './claude-code-models';

const MODELS: ModelInfo[] = [
  { value: '', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
];

describe('createClaudeCodeModelsCache', () => {
  it('ttl 안에서는 다시 부르지 않고, 지나면 다시 부른다', async () => {
    let clock = 0;
    let calls = 0;
    const cache = createClaudeCodeModelsCache({
      ttlMs: 1_000,
      now: () => clock,
      load: async () => {
        calls += 1;
        return MODELS;
      },
    });

    expect(await cache.list()).toEqual(MODELS);
    expect(await cache.list()).toEqual(MODELS);
    expect(calls).toBe(1);

    clock = 1_001;
    expect(await cache.list()).toEqual(MODELS);
    expect(calls).toBe(2);
  });

  it('실패는 캐시하지 않아 다음 요청에서 다시 시도한다', async () => {
    let calls = 0;
    const cache = createClaudeCodeModelsCache({
      now: () => 0,
      load: async () => {
        calls += 1;
        if (calls === 1) throw new Error('로그인이 필요합니다');
        return MODELS;
      },
    });

    await expect(cache.list()).rejects.toThrow('로그인이 필요합니다');
    expect(await cache.list()).toEqual(MODELS);
    expect(calls).toBe(2);
  });

  it('캐시가 비어 있는 동안 동시에 들어온 요청은 진행 중인 호출 하나를 함께 기다린다(CLI를 두 번 부르지 않는다)', async () => {
    let calls = 0;
    let resolveLoad: (models: ModelInfo[]) => void = () => {};
    const cache = createClaudeCodeModelsCache({
      now: () => 0,
      load: () =>
        new Promise((resolve) => {
          calls += 1;
          resolveLoad = resolve;
        }),
    });

    const first = cache.list();
    const second = cache.list();
    resolveLoad(MODELS);

    expect(await first).toEqual(MODELS);
    expect(await second).toEqual(MODELS);
    expect(calls).toBe(1);
  });
});
