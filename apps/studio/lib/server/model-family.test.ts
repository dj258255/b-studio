import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ modelById: vi.fn() }));
vi.mock('./model-registry', () => ({ modelById: mocks.modelById }));

import { modelFamily } from './model-family';

describe('modelFamily', () => {
  it('claude-code 백엔드는 항상 claude 계열이다', () => {
    expect(modelFamily('claude-code')).toBe('claude');
  });

  it('codex·commandcode·opencode는 각자 계열이다', () => {
    expect(modelFamily('codex')).toBe('openai');
    expect(modelFamily('commandcode')).toBe('commandcode');
    expect(modelFamily('opencode')).toBe('opencode');
  });

  it('api 백엔드는 모델 레지스트리의 provider로 계열을 가린다', () => {
    mocks.modelById.mockReturnValue({ provider: 'anthropic' });
    expect(modelFamily('api', 'anthropic-default')).toBe('claude');
    mocks.modelById.mockReturnValue({ provider: 'openai' });
    expect(modelFamily('api', 'gpt')).toBe('openai');
    mocks.modelById.mockReturnValue({ provider: 'google' });
    expect(modelFamily('api', 'gemini')).toBe('google');
  });

  it('api인데 modelId가 없거나 레지스트리에 없으면 unknown이다', () => {
    expect(modelFamily('api')).toBe('unknown');
    mocks.modelById.mockImplementation(() => {
      throw new Error('없음');
    });
    expect(modelFamily('api', 'ghost')).toBe('unknown');
  });

  it('demo 백엔드는 모델 호출이 없어 unknown이다', () => {
    expect(modelFamily('demo')).toBe('unknown');
  });
});
