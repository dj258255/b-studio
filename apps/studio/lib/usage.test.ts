import { describe, expect, it } from 'vitest';
import {
  describeWindow,
  formatTokenCount,
  hasTokens,
  parseTokenLimit,
  parseUsageWindow,
  parseUserTokenLimit,
  periodKey,
  subtractTokens,
  totalTokens,
} from './usage';

describe('사람별 토큰 한도 설정', () => {
  it('사람 한도는 양의 정수만 받고, 밑줄로 끊어 적어도 읽는다', () => {
    expect(parseUserTokenLimit('2_000_000')).toBe(2_000_000);
    expect(parseUserTokenLimit(' 500 ')).toBe(500);
    expect(parseUserTokenLimit('')).toBeUndefined();
    expect(parseUserTokenLimit(undefined)).toBeUndefined();
    expect(() => parseUserTokenLimit('0')).toThrow('B_STUDIO_USER_TOKEN_LIMIT');
    expect(() => parseUserTokenLimit('많이')).toThrow('B_STUDIO_USER_TOKEN_LIMIT');
    // 세션 한도와 사람 한도는 틀린 값을 각자의 이름으로 알린다
    expect(() => parseTokenLimit('-1')).toThrow('B_STUDIO_SESSION_TOKEN_LIMIT');
  });

  it('사람 몫에는 늘어난 만큼만 더하고, 누적값이 줄어들면 음수를 더하지 않는다', () => {
    const first = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 };
    const second = { inputTokens: 180, outputTokens: 45, cacheReadTokens: 5, cacheWriteTokens: 7 };
    expect(subtractTokens(first, undefined)).toEqual(first);
    expect(subtractTokens(second, first)).toEqual({ inputTokens: 80, outputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 7 });
    // 같은 값이 다시 오면 더할 것이 없다
    expect(hasTokens(subtractTokens(second, second))).toBe(false);
    // 누적값이 줄어들어도 빼지 않는다
    expect(subtractTokens(first, second)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('다시 세는 주기는 day와 month만 받는다', () => {
    expect(parseUsageWindow(undefined)).toBe('day');
    expect(parseUsageWindow('')).toBe('day');
    expect(parseUsageWindow('MONTH')).toBe('month');
    expect(() => parseUsageWindow('week')).toThrow('B_STUDIO_USER_TOKEN_WINDOW');
  });

  it('기간 이름은 서버가 있는 곳의 날짜로 끊는다', () => {
    const at = new Date(2026, 8, 12, 23, 30);
    expect(periodKey('day', at)).toBe('2026-09-12');
    expect(periodKey('month', at)).toBe('2026-09');
    expect(periodKey('day', new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(describeWindow('day')).toBe('오늘');
    expect(describeWindow('month')).toBe('이번 달');
  });
});

describe('사용량 표기', () => {
  it('세션 토큰 한도는 화면에 보이는 네 값의 합으로 재고, 잘못 적은 한도는 거부한다', () => {
    expect(totalTokens({ inputTokens: 984, outputTokens: 633, cacheReadTokens: 13_287, cacheWriteTokens: 14_690 })).toBe(29_594);
    expect(totalTokens(undefined)).toBe(0);
    expect(parseTokenLimit(undefined)).toBeUndefined();
    expect(parseTokenLimit('  ')).toBeUndefined();
    expect(parseTokenLimit('200_000')).toBe(200_000);
    expect(() => parseTokenLimit('20만')).toThrow('양의 정수');
    expect(() => parseTokenLimit('0')).toThrow('양의 정수');
    expect(() => parseTokenLimit('-5')).toThrow('양의 정수');
    expect(formatTokenCount(200_000)).toBe('20만');
  });
});
