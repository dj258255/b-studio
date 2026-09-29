import type { CommandCodeModel } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import {
  checkCommandCodeModelId,
  commandCodeMode,
  createCommandCodeModelsCache,
  filterFreeModels,
  freeOnlyEnabled,
  resolveCommandCodeModel,
} from './commandcode-models';

function model(id: string, overrides: Partial<CommandCodeModel> = {}): CommandCodeModel {
  return { id, description: '설명', group: 'Open Source', free: false, isDefault: false, ...overrides };
}

const MODELS: CommandCodeModel[] = [
  model('deepseek/deepseek-v4-flash', { description: 'fast (default)', isDefault: true }),
  model('poolside/laguna-s-2.1-free', { description: 'FREE open-weight', free: true }),
  model('stealth/space-bunny-alpha', { group: 'Stealth', description: 'FREE stealth', free: true }),
];

describe('freeOnlyEnabled / commandCodeMode', () => {
  it('B_STUDIO_CMD_FREE_ONLY는 1 또는 true일 때만 켠다', () => {
    expect(freeOnlyEnabled({ B_STUDIO_CMD_FREE_ONLY: '1' })).toBe(true);
    expect(freeOnlyEnabled({ B_STUDIO_CMD_FREE_ONLY: 'TRue' })).toBe(true);
    expect(freeOnlyEnabled({ B_STUDIO_CMD_FREE_ONLY: 'yes' })).toBe(false);
    expect(freeOnlyEnabled({})).toBe(false);
  });

  it('commandCodeMode는 B_STUDIO_MODE가 commandcode일 때만 참이다', () => {
    expect(commandCodeMode({ B_STUDIO_MODE: 'commandcode' })).toBe(true);
    expect(commandCodeMode({ B_STUDIO_MODE: 'api' })).toBe(false);
    expect(commandCodeMode({})).toBe(false);
  });
});

describe('filterFreeModels', () => {
  it('무료만 모드면 무료 모델만 남긴다', () => {
    expect(filterFreeModels(MODELS, true).map((item) => item.id)).toEqual(['poolside/laguna-s-2.1-free', 'stealth/space-bunny-alpha']);
  });

  it('무료만 모드가 아니면 그대로 둔다', () => {
    expect(filterFreeModels(MODELS, false)).toEqual(MODELS);
    expect(filterFreeModels(MODELS, false)).not.toBe(MODELS);
  });
});

describe('checkCommandCodeModelId', () => {
  it('고르지 않으면 계정 기본을 쓴다', () => {
    expect(checkCommandCodeModelId({ models: MODELS, freeOnly: false })).toEqual({ ok: true });
    expect(checkCommandCodeModelId({ modelId: '   ', models: MODELS, freeOnly: false })).toEqual({ ok: true });
  });

  it('목록에 있으면 통과한다', () => {
    expect(checkCommandCodeModelId({ modelId: 'deepseek/deepseek-v4-flash', models: MODELS, freeOnly: false })).toEqual({ ok: true, modelId: 'deepseek/deepseek-v4-flash' });
  });

  it('목록에 없으면 거부한다', () => {
    const result = checkCommandCodeModelId({ modelId: 'openai/gpt-9', models: MODELS, freeOnly: false });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('목록에 없는');
  });

  it('무료만 모드에서 무료가 아닌 id는 거부한다', () => {
    const result = checkCommandCodeModelId({ modelId: 'deepseek/deepseek-v4-flash', models: MODELS, freeOnly: true });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toBe('무료 모델만 쓰도록 설정돼 있습니다');
  });

  it('목록을 못 불러오면 id 형식만 보고 경고한다', () => {
    expect(checkCommandCodeModelId({ modelId: 'poolside/laguna-s-2.1-free', models: undefined, freeOnly: false })).toMatchObject({ ok: true, warning: expect.stringContaining('형식만') });
    const bad = checkCommandCodeModelId({ modelId: '모델 이다', models: [], freeOnly: false });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.message).toContain('형식이 올바르지 않습니다');
  });
});

describe('resolveCommandCodeModel', () => {
  it('세션에서 고른 모델 → B_STUDIO_CMD_MODEL → 없음 순서다', () => {
    expect(resolveCommandCodeModel('poolside/laguna-s-2.1-free', 'deepseek/deepseek-v4-flash')).toBe('poolside/laguna-s-2.1-free');
    expect(resolveCommandCodeModel(undefined, 'deepseek/deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash');
    expect(resolveCommandCodeModel('  ', ' deepseek/deepseek-v4-flash ')).toBe('deepseek/deepseek-v4-flash');
    expect(resolveCommandCodeModel(undefined, undefined)).toBeUndefined();
  });
});

describe('createCommandCodeModelsCache', () => {
  it('ttl 안에서는 다시 부르지 않고, 지나면 다시 부른다', async () => {
    let clock = 0;
    let calls = 0;
    const cache = createCommandCodeModelsCache({
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
    const cache = createCommandCodeModelsCache({
      now: () => 0,
      load: async () => {
        calls += 1;
        if (calls === 1) throw new Error('로그인돼 있지 않습니다');
        return MODELS;
      },
    });

    await expect(cache.list()).rejects.toThrow('로그인돼 있지 않습니다');
    expect(await cache.list()).toEqual(MODELS);
    expect(calls).toBe(2);
  });
});
