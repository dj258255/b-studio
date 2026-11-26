import { describe, expect, it } from 'vitest';
import { advanceStage, limitPercent, pickTokenLimitView, stageOf, tokenLimitView, userUsedTokens, type StageMemory } from './token-limit-stages';

describe('limitPercent·stageOf', () => {
  it('50%·80%·100%의 경계를 가른다', () => {
    expect([0, 49.9, 50, 79.9, 80, 99.9, 100, 250].map((p) => stageOf(p))).toEqual([0, 0, 50, 50, 80, 80, 100, 100]);
  });
  it('한도나 사용량을 모르면 0%가 아니라 모름이다', () => {
    expect(limitPercent(undefined, 100)).toBeUndefined();
    expect(limitPercent(10, undefined)).toBeUndefined();
    expect(limitPercent(10, 0)).toBeUndefined();
    expect(limitPercent(-1, 100)).toBeUndefined();
    expect(limitPercent(Number.NaN, 100)).toBeUndefined();
    expect(stageOf(undefined)).toBeUndefined();
  });
});

describe('advanceStage', () => {
  const walk = (key: string, steps: Array<number | undefined>, limit = 100) => {
    let memory: StageMemory | undefined;
    const alerts: Array<number | undefined> = [];
    for (const used of steps) {
      const step = advanceStage(memory, key, used, limit);
      memory = step.memory;
      alerts.push(step.alert);
    }
    return { alerts, memory };
  };

  it('50%·80%를 처음 넘을 때 한 번씩만 알린다', () => {
    expect(walk('a', [10, 49, 50, 60, 79, 80, 90, 99]).alerts).toEqual([undefined, undefined, 50, undefined, undefined, 80, undefined, undefined]);
  });
  it('한 번에 두 단계를 넘으면 높은 단계만 알린다', () => {
    expect(walk('a', [10, 85]).alerts).toEqual([undefined, 80]);
    expect(walk('a', [85, 90]).alerts).toEqual([80, undefined]);
  });
  it('한도에 닿거나 넘으면 알리지 않는다(막는 쪽이 알린다). 그 뒤 80%대로 내려와도 다시 알리지 않는다', () => {
    expect(walk('a', [10, 120]).alerts).toEqual([undefined, undefined]);
    expect(walk('a', [100, 100]).alerts).toEqual([undefined, undefined]);
  });
  it('사용량을 모르면 기억도 알림도 그대로다', () => {
    const { alerts, memory } = walk('a', [60, undefined, 70]);
    expect(alerts).toEqual([50, undefined, undefined]);
    expect(memory).toEqual({ key: 'a', stage: 50 });
    const unknownFirst = advanceStage(undefined, 'a', undefined, 100);
    expect(unknownFirst).toEqual({ memory: undefined });
  });
  it('한도(key)가 바뀌면 앞의 기억을 버리고 지금 단계를 새로 알린다', () => {
    const first = advanceStage(undefined, 'limit:100', 85, 100);
    expect(first.alert).toBe(80);
    // 같은 사용량이 한도 200 앞에서는 42%라 알리지 않고, 한도 120 앞에서는 70%라 50을 알린다
    expect(advanceStage(first.memory, 'limit:200', 85, 200)).toEqual({ memory: { key: 'limit:200', stage: 0 } });
    expect(advanceStage(first.memory, 'limit:120', 85, 120).alert).toBe(50);
  });
  it('사용량이 초기화돼 단계가 내려가면 기억도 내려가 다시 넘을 때 다시 알린다', () => {
    expect(walk('a', [85, 5, 55, 85]).alerts).toEqual([80, undefined, 50, 80]);
  });
  it('쓸 수 없는 한도는 조용하다', () => {
    expect(advanceStage(undefined, 'a', 50, 0)).toEqual({ memory: undefined });
  });
});

describe('userUsedTokens', () => {
  it('파일 합계 − 저장한 몫 + 누적이다(음수가 되지 않는다)', () => {
    expect(userUsedTokens(100, { accum: 30, saved: 20 })).toBe(110);
    expect(userUsedTokens(10, { accum: 5, saved: 20 })).toBe(5);
    expect(userUsedTokens(40, undefined)).toBe(40);
  });
  it('읽을 수 없는 값이 있으면 모름이다', () => {
    expect(userUsedTokens(Number.NaN, undefined)).toBeUndefined();
    expect(userUsedTokens(1, { accum: -1, saved: 0 })).toBeUndefined();
  });
});

describe('desk에 보일 한도 값', () => {
  it('사용량을 읽지 못했으면 %를 싣지 않는다', () => {
    expect(tokenLimitView('user', 1000, undefined)).toEqual({ kind: 'user', limit: 1000 });
    expect(tokenLimitView('session', 1000, 250)).toEqual({ kind: 'session', limit: 1000, used: 250, percent: 25 });
  });
  it('아는 값 가운데 가장 높은 %를 고르고, 80% 아래라면 모르는 한도를 가리지 않는다', () => {
    const session = tokenLimitView('session', 1000, 250);
    const user = tokenLimitView('user', 100, 90);
    const unknownUser = tokenLimitView('user', 100, undefined);
    expect(pickTokenLimitView([session, user])?.kind).toBe('user');
    // 읽은 쪽이 80% 아래이면 읽지 못한 한도를 보인다. 80% 이상이면 읽은 쪽이 먼저다
    expect(pickTokenLimitView([session, unknownUser])).toBe(unknownUser);
    expect(pickTokenLimitView([tokenLimitView('session', 100, 85), unknownUser])?.percent).toBe(85);
    expect(pickTokenLimitView([undefined, unknownUser])).toBe(unknownUser);
    expect(pickTokenLimitView([undefined, undefined])).toBeUndefined();
  });
});
