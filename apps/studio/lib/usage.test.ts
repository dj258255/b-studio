import { describe, expect, it } from 'vitest';
import {
  addTokens,
  currentPhase,
  describeTokens,
  describeWindow,
  endedReason,
  formatBytes,
  formatTokenCount,
  hasTokens,
  memoryRatio,
  parseTokenLimit,
  parseUsageWindow,
  parseUserTokenLimit,
  periodKey,
  subtractTokens,
  totalTokens,
} from './usage';

const log = (service: string, text: string) => ({ service, text, at: '' });

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

describe('currentPhase', () => {
  it('서비스별로 가장 최근 단계를 로그에서 찾는다', () => {
    const logs = [
      log('api', 'To honour the JVM settings for this build a single-use Daemon process will be forked.'),
      log('web', 'Progress: resolved 354, reused 354, downloaded 0, added 120'),
      log('api', '> Task :compileJava FROM-CACHE'),
      log('web', 'Done in 3.1s using pnpm v10.29.3'),
      log('api', 'some unrelated line'),
    ];
    expect(currentPhase(logs, 'api')).toBe('Gradle compileJava');
    expect(currentPhase(logs, 'web')).toBe('의존성 설치 완료');
    expect(currentPhase(logs, 'db')).toBeUndefined();
  });

  it('기동이 끝났거나 빌드가 실패하면 그 사실을 단계로 보여 준다', () => {
    expect(currentPhase([log('api', '> Task :bootRun'), log('api', 'Started ApiApplication in 2.3 seconds')], 'api')).toBe('앱 기동 완료');
    expect(currentPhase([log('api', '> Task :processResources FAILED'), log('api', 'BUILD FAILED in 4s')], 'api')).toBe('빌드 실패');
  });
});

describe('사용량 표기', () => {
  it('한도 대비 사용률과 종료 이유를 만든다', () => {
    expect(memoryRatio({ service: 'api', state: 'running', memoryBytes: 768 * 1024 ** 2, memoryLimitBytes: 1536 * 1024 ** 2, oomKilled: false })).toBe(0.5);
    expect(memoryRatio({ service: 'db', state: 'running', memoryBytes: 48 * 1024 ** 2, oomKilled: false })).toBeUndefined();
    expect(endedReason({ service: 'api', state: 'exited', exitCode: 137, oomKilled: true })).toBe('메모리 한도를 넘어 종료 (종료 코드 137)');
    expect(endedReason({ service: 'api', state: 'running', oomKilled: false })).toBeUndefined();
    expect(formatBytes(726 * 1024 ** 2)).toBe('726MiB');
  });

  it('토큰은 한국어 단위로 줄이고 쓴 캐시만 붙인다', () => {
    const usage = { inputTokens: 12_345, outputTokens: 850, cacheReadTokens: 1_234_567, cacheWriteTokens: 0 };
    expect(describeTokens(usage)).toBe('입력 1.2만, 출력 850, 캐시 읽기 123.5만 토큰');
    expect(addTokens(usage, usage)).toEqual({ inputTokens: 24_690, outputTokens: 1_700, cacheReadTokens: 2_469_134, cacheWriteTokens: 0 });
    expect(addTokens(undefined, usage)).toEqual(usage);
    expect(hasTokens(usage)).toBe(true);
    expect(hasTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(false);
    expect(hasTokens(undefined)).toBe(false);
  });

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
