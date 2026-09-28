import type { CommandCodeModel } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import { BACKENDS, freeOnlyViolation } from './agent';

function model(id: string, free: boolean): CommandCodeModel {
  return { id, description: '설명', group: 'Open Source', free, isDefault: false };
}

describe('CLI commandcode 인자', () => {
  it('BACKENDS에 commandcode가 있다', () => {
    expect(BACKENDS).toContain('commandcode');
  });

  it('freeOnlyViolation은 무료만 모드에서 무료가 아닌 모델을 거부한다', () => {
    const models = [model('poolside/laguna-s-2.1-free', true), model('deepseek/deepseek-v4-flash', false)];
    expect(freeOnlyViolation('poolside/laguna-s-2.1-free', models)).toBeUndefined();
    expect(freeOnlyViolation('deepseek/deepseek-v4-flash', models)).toContain('무료 모델이 아닙니다');
    // 목록에 없어 무료 여부를 확인할 수 없으면 통과시킨다
    expect(freeOnlyViolation('unknown/model', models)).toBeUndefined();
  });
});
