import { describe, expect, it } from 'vitest';
import { LoginThrottle, type ThrottlePolicy } from './login-throttle';

const POLICY: ThrottlePolicy = { freeFailures: 3, baseLockMs: 5_000, maxLockMs: 60_000, forgetAfterMs: 3_600_000, maxEntries: 3 };

describe('LoginThrottle', () => {
  it('정해진 횟수까지는 잠그지 않고, 그 뒤로는 실패할 때마다 잠금 시간을 두 배로 늘리되 상한을 넘기지 않는다', () => {
    const throttle = new LoginThrottle(POLICY);
    const locks: number[] = [];
    for (let i = 0; i < 8; i++) {
      // 잠금이 풀린 뒤에 다시 시도한다
      const now = i * 100_000;
      expect(throttle.check('alice', now)).toEqual({ allowed: true });
      locks.push(throttle.fail('alice', now));
    }
    expect(locks).toEqual([0, 0, 0, 5_000, 10_000, 20_000, 40_000, 60_000]);
  });

  it('잠긴 동안은 남은 시간을 알려 주고, 다른 계정은 막지 않으며, 성공하거나 오래 실패가 없으면 처음부터 센다', () => {
    const throttle = new LoginThrottle(POLICY);
    for (let i = 0; i < 4; i++) throttle.fail('alice', 0);
    expect(throttle.check('alice', 1_000)).toEqual({ allowed: false, retryAfterMs: 4_000 });
    expect(throttle.check('bob', 1_000)).toEqual({ allowed: true });
    expect(throttle.check('alice', 5_000)).toEqual({ allowed: true });
    throttle.succeed('alice');
    expect(throttle.fail('alice', 6_000)).toBe(0);

    const idle = new LoginThrottle(POLICY);
    for (let i = 0; i < 3; i++) idle.fail('alice', 0);
    expect(idle.fail('alice', 3_600_001)).toBe(0);
  });

  it('기록 수에 상한을 두고 가장 오래 실패가 없던 이름부터 지운다', () => {
    const throttle = new LoginThrottle(POLICY);
    for (const name of ['a', 'b', 'c', 'd']) for (let i = 0; i < 4; i++) throttle.fail(name, 0);
    expect(throttle.check('a', 1_000)).toEqual({ allowed: true });
    expect(throttle.check('d', 1_000).allowed).toBe(false);
  });
});
