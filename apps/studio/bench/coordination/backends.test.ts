import { describe, expect, it } from 'vitest';
import { planModelId, resolveBackend, resolveRateLimitPolicy } from './backends';

describe('resolveBackend', () => {
  it('--dry는 --backend·--model과 함께 쓸 수 없고 항상 openai다', () => {
    expect(resolveBackend({ dry: true })).toEqual({ backend: 'openai' });
    expect(() => resolveBackend({ dry: true, backend: 'openai' })).toThrow(/--backend와 함께/);
    expect(() => resolveBackend({ dry: true, model: 'sonnet' })).toThrow(/--model과 함께/);
  });

  it('--dry가 아니면 --backend가 필수다', () => {
    expect(() => resolveBackend({ dry: false })).toThrow(/--backend가 필요합니다/);
    expect(() => resolveBackend({ dry: false, backend: 'anthropic' })).toThrow(/알 수 없는 백엔드/);
  });

  it('claude-code는 모델을 받거나 sonnet을 기본으로 쓴다', () => {
    expect(resolveBackend({ dry: false, backend: 'claude-code' })).toEqual({ backend: 'claude-code', model: 'sonnet' });
    expect(resolveBackend({ dry: false, backend: 'claude-code', model: ' opus ' })).toEqual({ backend: 'claude-code', model: 'opus' });
  });

  it('commandcode는 모델을 고정할 수도, 계정 기본 모델을 쓰게 둘 수도 있다', () => {
    expect(resolveBackend({ dry: false, backend: 'commandcode' })).toEqual({ backend: 'commandcode' });
    expect(resolveBackend({ dry: false, backend: 'commandcode', model: ' poolside/laguna-s-2.1-free ' })).toEqual({ backend: 'commandcode', model: 'poolside/laguna-s-2.1-free' });
  });

  it('--model은 claude-code 또는 commandcode에서만 쓸 수 있다', () => {
    expect(resolveBackend({ dry: false, backend: 'openai' })).toEqual({ backend: 'openai' });
    expect(() => resolveBackend({ dry: false, backend: 'openai', model: 'sonnet' })).toThrow(/claude-code 또는 commandcode에서만/);
  });
});

describe('planModelId', () => {
  it('로컬 CLI 백엔드는 따로 표시하고, openai는 상류 모델 id를 쓴다', () => {
    expect(planModelId('claude-code', 'sonnet', 'bench-coordination')).toBe('local-cli:sonnet');
    expect(planModelId('commandcode', 'poolside/laguna-s-2.1-free', 'bench-coordination')).toBe('local-cli-commandcode:poolside/laguna-s-2.1-free');
    expect(planModelId('openai', 'dry', 'bench-coordination')).toBe('bench-coordination');
  });

  it('commandcode에 모델이 없으면 default로 적는다', () => {
    expect(planModelId('commandcode', '', 'bench-coordination')).toBe('local-cli-commandcode:default');
  });
});

describe('resolveRateLimitPolicy', () => {
  it('기본은 stop, 30분이다', () => {
    expect(resolveRateLimitPolicy(undefined, undefined)).toEqual({ policy: 'stop', waitMinutes: 30 });
  });

  it('wait과 기다릴 분을 받는다', () => {
    expect(resolveRateLimitPolicy('wait', 5)).toEqual({ policy: 'wait', waitMinutes: 5 });
  });

  it('모르는 값과 0 이하의 분은 거부한다', () => {
    expect(() => resolveRateLimitPolicy('continue', undefined)).toThrow(/stop 또는 wait/);
    expect(() => resolveRateLimitPolicy('wait', 0)).toThrow(/0보다 큰/);
  });
});
