/**
 * 토큰 로그인의 실패 제한. 실패는 요청을 보낸 주소가 아니라 계정(이름)에 붙여 센다.
 * 주소를 바꿔 가며 대입해도 같은 계정의 잠금이 풀리지 않게 하기 위해서다(OWASP Authentication Cheat Sheet)
 */
export interface ThrottlePolicy {
  /** 잠그지 않고 허용하는 연속 실패 수 */
  freeFailures: number;
  /** 허용 수를 넘긴 첫 실패의 잠금 시간. 실패할 때마다 두 배로 늘린다 */
  baseLockMs: number;
  maxLockMs: number;
  /** 마지막 실패 뒤 이만큼 지나면 실패 수를 처음부터 센다 */
  forgetAfterMs: number;
  /** 기록할 이름 수의 상한. 넘으면 가장 오래 실패가 없던 이름부터 지운다 */
  maxEntries: number;
}

export const LOGIN_THROTTLE: ThrottlePolicy = {
  freeFailures: 3,
  baseLockMs: 5_000,
  maxLockMs: 15 * 60_000,
  forgetAfterMs: 60 * 60_000,
  maxEntries: 10_000,
};

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

interface Entry {
  failures: number;
  lastFailure: number;
  lockedUntil: number;
}

export class LoginThrottle {
  readonly #policy: ThrottlePolicy;
  /** Map의 순서를 마지막 실패 순서로 유지한다 */
  readonly #entries = new Map<string, Entry>();

  constructor(policy: ThrottlePolicy = LOGIN_THROTTLE) {
    this.#policy = policy;
  }

  /** 잠긴 동안에는 토큰을 확인하지 않도록 먼저 부른다 */
  check(key: string, now: number): ThrottleDecision {
    const entry = this.#current(key, now);
    return entry && entry.lockedUntil > now ? { allowed: false, retryAfterMs: entry.lockedUntil - now } : { allowed: true };
  }

  /** 실패를 기록하고 새로 건 잠금 시간을 돌려준다 (허용 범위 안이면 0) */
  fail(key: string, now: number): number {
    const entry = this.#current(key, now) ?? { failures: 0, lastFailure: now, lockedUntil: 0 };
    entry.failures += 1;
    entry.lastFailure = now;
    const over = entry.failures - this.#policy.freeFailures;
    const lockMs = over > 0 ? Math.min(this.#policy.maxLockMs, this.#policy.baseLockMs * 2 ** (over - 1)) : 0;
    entry.lockedUntil = now + lockMs;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#policy.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return lockMs;
  }

  succeed(key: string): void {
    this.#entries.delete(key);
  }

  #current(key: string, now: number): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry && entry.lockedUntil <= now && now - entry.lastFailure > this.#policy.forgetAfterMs) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
