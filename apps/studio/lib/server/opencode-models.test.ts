import type { OpenCodeModel } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import { checkOpenCodeModelId, createOpenCodeModelsCache, filterFreeModels, freeOnlyEnabled, hasUsableModel, openCodeMode, toStudioModel } from './opencode-models';

function model(id: string, overrides: Partial<OpenCodeModel> = {}): OpenCodeModel {
  const name = id.slice(id.indexOf('/') + 1);
  const free = /free/i.test(name);
  // 러너 파서와 같은 규칙: opencode 제공자의 무료 모델은 쓸 수 없다
  const gated = id.startsWith('opencode/') && free;
  return { id, name, provider: id.slice(0, id.indexOf('/')), free, usable: !gated, ...(gated ? { reason: '무료 Zen 티어는 b-studio 구성(내장 도구 끔)을 거절합니다' } : {}), ...overrides };
}

const MODELS: OpenCodeModel[] = [
  model('opencode/big-pickle'),
  model('opencode/mimo-v2.6-flash-free'),
  model('opencode/space-bunny-free'),
  model('anthropic/claude-sonnet-4-6'),
];

describe('freeOnlyEnabled / openCodeMode', () => {
  it('B_STUDIO_OPENCODE_FREE_ONLY는 1 또는 true일 때만 켠다', () => {
    expect(freeOnlyEnabled({})).toBe(false);
    expect(freeOnlyEnabled({ B_STUDIO_OPENCODE_FREE_ONLY: '' })).toBe(false);
    expect(freeOnlyEnabled({ B_STUDIO_OPENCODE_FREE_ONLY: '1' })).toBe(true);
    expect(freeOnlyEnabled({ B_STUDIO_OPENCODE_FREE_ONLY: 'TRue' })).toBe(true);
    expect(freeOnlyEnabled({ B_STUDIO_OPENCODE_FREE_ONLY: '0' })).toBe(false);
  });

  it('openCodeMode는 B_STUDIO_MODE가 opencode일 때만 참이다', () => {
    expect(openCodeMode({ B_STUDIO_MODE: 'opencode' })).toBe(true);
    expect(openCodeMode({ B_STUDIO_MODE: 'api' })).toBe(false);
    expect(openCodeMode({})).toBe(false);
  });
});

describe('toStudioModel / filterFreeModels / hasUsableModel', () => {
  it('러너 모델을 화면 모델로 바꾼다(그룹은 제공자, 기본 표시는 없음, usable·reason을 그대로 넘긴다)', () => {
    expect(toStudioModel(model('opencode/mimo-v2.6-flash-free'))).toEqual({
      id: 'opencode/mimo-v2.6-flash-free',
      description: 'mimo-v2.6-flash-free',
      group: 'opencode',
      free: true,
      isDefault: false,
      usable: false,
      reason: '무료 Zen 티어는 b-studio 구성(내장 도구 끔)을 거절합니다',
    });
    expect(toStudioModel(model('opencode/big-pickle'))).toEqual({ id: 'opencode/big-pickle', description: 'big-pickle', group: 'opencode', free: false, isDefault: false, usable: true });
  });

  it('무료만 모드면 무료 모델만 남긴다', () => {
    const views = MODELS.map(toStudioModel);
    expect(filterFreeModels(views, true).map((item) => item.id)).toEqual(['opencode/mimo-v2.6-flash-free', 'opencode/space-bunny-free']);
    expect(filterFreeModels(views, false)).toEqual(views);
    expect(filterFreeModels(views, false)).not.toBe(views);
  });

  it('쓸 수 있는 모델이 하나도 없으면 hasUsableModel이 거짓이다', () => {
    const onlyGated = MODELS.filter((m) => m.id.includes('free')).map(toStudioModel);
    expect(hasUsableModel(onlyGated)).toBe(false);
    expect(hasUsableModel(MODELS.map(toStudioModel))).toBe(true);
  });
});

describe('checkOpenCodeModelId', () => {
  const views = MODELS.map(toStudioModel);

  it('고르지 않으면 통과한다(세션 모델 미지정)', () => {
    expect(checkOpenCodeModelId({ models: views, freeOnly: false })).toEqual({ ok: true });
    expect(checkOpenCodeModelId({ modelId: '   ', models: views, freeOnly: false })).toEqual({ ok: true });
  });

  it('목록에 있고 쓸 수 있으면 통과한다', () => {
    expect(checkOpenCodeModelId({ modelId: 'opencode/big-pickle', models: views, freeOnly: false })).toEqual({ ok: true, modelId: 'opencode/big-pickle' });
  });

  it('목록에 없으면 거부한다', () => {
    const result = checkOpenCodeModelId({ modelId: 'opencode/does-not-exist', models: views, freeOnly: false });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('목록에 없는');
  });

  it('무료만 모드에서 무료가 아닌 id는 거부한다', () => {
    const result = checkOpenCodeModelId({ modelId: 'opencode/big-pickle', models: views, freeOnly: true });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toBe('무료 모델만 쓰도록 설정돼 있습니다');
  });

  it('쓸 수 없는(무료 Zen) id는 이유와 함께 거부한다', () => {
    const result = checkOpenCodeModelId({ modelId: 'opencode/mimo-v2.6-flash-free', models: views, freeOnly: false });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('무료 Zen 티어');
  });

  it('목록을 못 불러오면 id 형식만 보고 경고한다', () => {
    expect(checkOpenCodeModelId({ modelId: 'opencode/space-bunny-free', models: undefined, freeOnly: false })).toMatchObject({ ok: true, warning: expect.stringContaining('형식만') });
    const bad = checkOpenCodeModelId({ modelId: '모델 이다', models: [], freeOnly: false });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.message).toContain('형식이 올바르지 않습니다');
  });
});

describe('createOpenCodeModelsCache', () => {
  it('ttl 안에서는 다시 부르지 않고, 지나면 다시 부른다', async () => {
    let clock = 0;
    let calls = 0;
    const cache = createOpenCodeModelsCache({
      ttlMs: 1_000,
      now: () => clock,
      load: async () => {
        calls += 1;
        return MODELS;
      },
    });

    expect(await cache.list()).toEqual(MODELS.map(toStudioModel));
    expect(await cache.list()).toEqual(MODELS.map(toStudioModel));
    expect(calls).toBe(1);

    clock = 1_001;
    await cache.list();
    expect(calls).toBe(2);
  });

  it('실패는 캐시하지 않아 다음 요청에서 다시 시도한다', async () => {
    let calls = 0;
    const cache = createOpenCodeModelsCache({
      now: () => 0,
      load: async () => {
        calls += 1;
        if (calls === 1) throw new Error('opencode를 찾지 못했습니다');
        return MODELS;
      },
    });

    await expect(cache.list()).rejects.toThrow('opencode를 찾지 못했습니다');
    expect(await cache.list()).toEqual(MODELS.map(toStudioModel));
    expect(calls).toBe(2);
  });
});
