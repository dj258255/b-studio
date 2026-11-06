import { describe, expect, it } from 'vitest';
import { resolveGeminiModel } from './gemini-models';

describe('resolveGeminiModel', () => {
  it('세션에서 고른 모델 → B_STUDIO_GEMINI_MODEL → 없음 순서다', () => {
    expect(resolveGeminiModel('gemini-2.5-flash', 'gemini-2.5-pro')).toBe('gemini-2.5-flash');
    expect(resolveGeminiModel(undefined, 'gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(resolveGeminiModel('  ', ' gemini-2.5-pro ')).toBe('gemini-2.5-pro');
    expect(resolveGeminiModel(undefined, undefined)).toBeUndefined();
  });
});
