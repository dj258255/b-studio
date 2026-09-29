import { describe, expect, it } from 'vitest';
import { redact } from './redact';

describe('redact', () => {
  it('길이 8 이상인 비밀 값을 ***로 바꾼다', () => {
    expect(redact('Authorization: Bearer sk-abcdef123456', ['sk-abcdef123456'])).toBe('Authorization: Bearer ***');
  });

  it('여러 번 나와도 모두 바꾼다', () => {
    expect(redact('key=sk-abcdef123456&again=sk-abcdef123456', ['sk-abcdef123456'])).toBe('key=***&again=***');
  });

  it('짧은 값은 건드리지 않는다', () => {
    expect(redact('key=short', ['short'])).toBe('key=short');
  });

  it('여러 비밀 값을 한 번에 바꾼다', () => {
    expect(redact('a=secret-value-1 b=secret-value-2', ['secret-value-1', 'secret-value-2'])).toBe('a=*** b=***');
  });

  it('비밀이 없으면 그대로 돌려준다', () => {
    expect(redact('평범한 문자열', [])).toBe('평범한 문자열');
  });
});
