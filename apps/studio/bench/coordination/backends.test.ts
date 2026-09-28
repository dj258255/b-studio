import { describe, expect, it } from 'vitest';
import { planModelId, resolveBackend, resolveEscalation, resolveRateLimitPolicy } from './backends';

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

  it('--model은 claude-code 또는 codex에서만 쓸 수 있다', () => {
    expect(resolveBackend({ dry: false, backend: 'openai' })).toEqual({ backend: 'openai' });
    expect(() => resolveBackend({ dry: false, backend: 'openai', model: 'sonnet' })).toThrow(/claude-code 또는 codex에서만/);
  });
});

describe('planModelId', () => {
  it('로컬 CLI 백엔드는 따로 표시하고, openai는 상류 모델 id를 쓴다', () => {
    expect(planModelId('claude-code', 'sonnet', 'bench-coordination')).toBe('local-cli:sonnet');
    expect(planModelId('codex', 'gpt-5-codex', 'bench-coordination')).toBe('local-cli-chatgpt:gpt-5-codex');
    expect(planModelId('openai', 'dry', 'bench-coordination')).toBe('bench-coordination');
  });

  it('codex에 모델이 없으면 default로 적는다', () => {
    expect(planModelId('codex', '', 'bench-coordination')).toBe('local-cli-chatgpt:default');
  });
});

describe('resolveEscalation', () => {
  it('--escalate-to를 주지 않으면 기본 임계치만 두고 승격하지 않는다', () => {
    expect(resolveEscalation({ backend: 'claude-code' })).toEqual({ after: 2 });
    expect(resolveEscalation({ backend: 'claude-code', escalateAfter: 3 })).toEqual({ after: 3 });
  });

  it('claude-code 백엔드에서만 --escalate-to를 받는다', () => {
    expect(resolveEscalation({ backend: 'claude-code', escalateTo: 'sonnet' })).toEqual({ to: 'sonnet', after: 2 });
    expect(resolveEscalation({ backend: 'claude-code', escalateTo: ' sonnet ', escalateAfter: 4 })).toEqual({ to: 'sonnet', after: 4 });
  });

  it('승격을 지원하지 않는 백엔드에 --escalate-to를 주면 시작 전에 오류를 낸다', () => {
    expect(() => resolveEscalation({ backend: 'openai', escalateTo: 'sonnet' })).toThrow(/--escalate-to는 --backend claude-code에서만/);
    expect(() => resolveEscalation({ backend: 'codex', escalateTo: 'sonnet' })).toThrow(/--escalate-to는 --backend claude-code에서만/);
  });

  it('--escalate-after는 1 이상의 정수여야 한다', () => {
    expect(() => resolveEscalation({ backend: 'claude-code', escalateAfter: 0 })).toThrow(/--escalate-after는 1 이상의 정수/);
    expect(() => resolveEscalation({ backend: 'claude-code', escalateTo: 'sonnet', escalateAfter: 1.5 })).toThrow(/--escalate-after는 1 이상의 정수/);
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
