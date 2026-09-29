import type { CommandCodeModel, OpenCodeModel } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import { BACKENDS, freeOnlyViolation } from './agent';

function model(id: string, free: boolean): CommandCodeModel {
  return { id, description: '설명', group: 'Open Source', free, isDefault: false };
}

function openCodeModel(id: string, overrides: Partial<OpenCodeModel> = {}): OpenCodeModel {
  const name = id.slice(id.indexOf('/') + 1);
  const free = /free/i.test(name);
  const gated = id.startsWith('opencode/') && free;
  return { id, name, provider: id.slice(0, id.indexOf('/')), free, usable: !gated, ...(gated ? { reason: '무료 Zen 티어는 b-studio 구성(내장 도구 끔)을 거절합니다' } : {}), ...overrides };
}

describe('CLI 로컬 CLI 백엔드 인자', () => {
  it('BACKENDS에 commandcode·opencode가 있다', () => {
    expect(BACKENDS).toContain('commandcode');
    expect(BACKENDS).toContain('opencode');
  });

  it('freeOnlyViolation은 무료만 모드에서 무료가 아닌 모델을 거부한다', () => {
    const models = [model('poolside/laguna-s-2.1-free', true), model('deepseek/deepseek-v4-flash', false)];
    expect(freeOnlyViolation('poolside/laguna-s-2.1-free', models)).toBeUndefined();
    expect(freeOnlyViolation('deepseek/deepseek-v4-flash', models)).toContain('무료 모델이 아닙니다');
    // 목록에 없어 무료 여부를 확인할 수 없으면 통과시킨다
    expect(freeOnlyViolation('unknown/model', models)).toBeUndefined();
  });

  it('freeOnlyViolation은 opencode 모델에서 usable까지 본다', () => {
    const models = [openCodeModel('opencode/mimo-v2.6-flash-free'), openCodeModel('opencode/big-pickle'), openCodeModel('openrouter/some-model:free')];
    // 무료지만 쓸 수 없는(무료 Zen) 모델은 거부하고 이유를 붙인다
    const gated = freeOnlyViolation('opencode/mimo-v2.6-flash-free', models);
    expect(gated).toContain('쓸 수 없습니다');
    expect(gated).toContain('무료 Zen 티어');
    // 무료가 아니면 거부한다
    expect(freeOnlyViolation('opencode/big-pickle', models)).toContain('무료 모델이 아닙니다');
    // 다른 제공자의 무료 모델은 통과한다
    expect(freeOnlyViolation('openrouter/some-model:free', models)).toBeUndefined();
  });
});
