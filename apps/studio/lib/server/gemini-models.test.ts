import { describe, expect, it } from 'vitest';
import { geminiMode, resolveGeminiModel } from './gemini-models';

describe('geminiMode', () => {
  it('B_STUDIO_MODE가 gemini일 때만 참이다', () => {
    expect(geminiMode({ B_STUDIO_MODE: 'gemini' })).toBe(true);
    expect(geminiMode({ B_STUDIO_MODE: 'api' })).toBe(false);
    expect(geminiMode({})).toBe(false);
  });
});

describe('resolveGeminiModel', () => {
  it('세션에서 고른 모델 → B_STUDIO_GEMINI_MODEL → 없음 순서다', () => {
    expect(resolveGeminiModel('gemini-2.5-flash', 'gemini-2.5-pro')).toBe('gemini-2.5-flash');
    expect(resolveGeminiModel(undefined, 'gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(resolveGeminiModel('  ', ' gemini-2.5-pro ')).toBe('gemini-2.5-pro');
    expect(resolveGeminiModel(undefined, undefined)).toBeUndefined();
  });
});
