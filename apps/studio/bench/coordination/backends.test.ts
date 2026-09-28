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

  it('codex는 모델을 고정할 수도, 계정 기본 모델을 쓰게 둘 수도 있다', () => {
    expect(resolveBackend({ dry: false, backend: 'codex' })).toEqual({ backend: 'codex' });
    expect(resolveBackend({ dry: false, backend: 'codex', model: ' gpt-5-codex ' })).toEqual({ backend: 'codex', model: 'gpt-5-codex' });
  });

  it('commandcode는 모델을 고정할 수도, 계정 기본 모델을 쓰게 둘 수도 있다', () => {
    expect(resolveBackend({ dry: false, backend: 'commandcode' })).toEqual({ backend: 'commandcode' });
    expect(resolveBackend({ dry: false, backend: 'commandcode', model: ' poolside/laguna-s-2.1-free ' })).toEqual({ backend: 'commandcode', model: 'poolside/laguna-s-2.1-free' });
  });

  it('opencode는 --model이 필수다(기본 모델을 추측하지 않는다)', () => {
    expect(() => resolveBackend({ dry: false, backend: 'opencode' })).toThrow(/--model이 필요합니다/);
    expect(resolveBackend({ dry: false, backend: 'opencode', model: ' opencode/space-bunny-free ' })).toEqual({ backend: 'opencode', model: 'opencode/space-bunny-free' });
  });

  it('--model은 claude-code, codex, commandcode 또는 opencode에서만 쓸 수 있다', () => {
    expect(resolveBackend({ dry: false, backend: 'openai' })).toEqual({ backend: 'openai' });
    expect(() => resolveBackend({ dry: false, backend: 'openai', model: 'sonnet' })).toThrow(/claude-code, codex, commandcode 또는 opencode에서만/);
  });
});

describe('planModelId', () => {
  it('로컬 CLI 백엔드는 따로 표시하고, openai는 상류 모델 id를 쓴다', () => {
    expect(planModelId('claude-code', 'sonnet', 'bench-coordination')).toBe('local-cli:sonnet');
    expect(planModelId('codex', 'gpt-5-codex', 'bench-coordination')).toBe('local-cli-chatgpt:gpt-5-codex');
    expect(planModelId('commandcode', 'poolside/laguna-s-2.1-free', 'bench-coordination')).toBe('local-cli-commandcode:poolside/laguna-s-2.1-free');
    expect(planModelId('opencode', 'opencode/mimo-v2.6-flash-free', 'bench-coordination')).toBe('local-cli-opencode:opencode/mimo-v2.6-flash-free');
    expect(planModelId('openai', 'dry', 'bench-coordination')).toBe('bench-coordination');
  });

  it('codex·commandcode·opencode에 모델이 없으면 default로 적는다', () => {
    expect(planModelId('codex', '', 'bench-coordination')).toBe('local-cli-chatgpt:default');
    expect(planModelId('commandcode', '', 'bench-coordination')).toBe('local-cli-commandcode:default');
    expect(planModelId('opencode', '', 'bench-coordination')).toBe('local-cli-opencode:default');
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
