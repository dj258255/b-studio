import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_ENV_FAILURES, envFailureAbortMessage, envFailuresExceeded, nextEnvFailureStreak, resolveMaxEnvFailures } from './env-guard';

describe('resolveMaxEnvFailures', () => {
  it('주지 않으면 기본값(2)을 쓴다', () => {
    expect(resolveMaxEnvFailures(undefined)).toBe(DEFAULT_MAX_ENV_FAILURES);
  });

  it('1 이상의 정수는 그대로 쓴다', () => {
    expect(resolveMaxEnvFailures(5)).toBe(5);
    expect(resolveMaxEnvFailures(1)).toBe(1);
  });

  it('0 이하거나 정수가 아니면 거부한다', () => {
    expect(() => resolveMaxEnvFailures(0)).toThrow(/--max-env-failures/);
    expect(() => resolveMaxEnvFailures(-1)).toThrow(/--max-env-failures/);
    expect(() => resolveMaxEnvFailures(1.5)).toThrow(/--max-env-failures/);
  });
});

describe('nextEnvFailureStreak', () => {
  it('environment가 이어지면 늘어난다', () => {
    let streak = 0;
    streak = nextEnvFailureStreak(streak, 'environment');
    expect(streak).toBe(1);
    streak = nextEnvFailureStreak(streak, 'environment');
    expect(streak).toBe(2);
  });

  it('environment가 아닌 결과(성공·다른 실패 분류)가 끼면 끊긴다', () => {
    expect(nextEnvFailureStreak(3, 'none')).toBe(0);
    expect(nextEnvFailureStreak(3, 'rate_limited')).toBe(0);
    expect(nextEnvFailureStreak(3, 'acceptance')).toBe(0);
  });
});

describe('envFailuresExceeded', () => {
  it('연속 횟수가 한도 이상이면 멈춘다', () => {
    expect(envFailuresExceeded(2, 2)).toBe(true);
    expect(envFailuresExceeded(3, 2)).toBe(true);
    expect(envFailuresExceeded(1, 2)).toBe(false);
  });
});

describe('18회 중 14회가 environment였던 실험(E10)을 가짜 결과로 재현한다', () => {
  it('기본 한도(2)면 두 번째 연속 environment에서 멈춰 16번을 아낀다', () => {
    // 실측 순서를 단순화: environment, environment, (여기서 멈췄어야 함), ... 나머지도 같은 이유로 environment
    const categories: Array<'environment' | 'none'> = ['environment', 'environment', 'none', 'environment', 'environment'];
    const max = resolveMaxEnvFailures(undefined);
    let streak = 0;
    let stoppedAt = -1;
    for (const [index, category] of categories.entries()) {
      streak = nextEnvFailureStreak(streak, category);
      if (envFailuresExceeded(streak, max)) {
        stoppedAt = index;
        break;
      }
    }
    expect(stoppedAt).toBe(1); // 0-indexed 두 번째 실행(세 번째가 아니라)에서 멈춘다
    expect(envFailureAbortMessage(streak, max)).toContain('environment 실패가 연달아 2번');
    expect(envFailureAbortMessage(streak, max)).toContain('--max-env-failures');
  });

  it('environment 사이에 성공이나 다른 실패가 끼면 한도까지 가도 멈추지 않는다', () => {
    const categories: Array<'environment' | 'none'> = ['environment', 'none', 'environment', 'none', 'environment'];
    const max = resolveMaxEnvFailures(undefined);
    let streak = 0;
    let stopped = false;
    for (const category of categories) {
      streak = nextEnvFailureStreak(streak, category);
      if (envFailuresExceeded(streak, max)) stopped = true;
    }
    expect(stopped).toBe(false);
  });
});
