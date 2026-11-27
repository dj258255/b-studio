import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armModClock, disarmModClock, modLoadTimeoutMs, noteModReloading, noteModStarted } from './session-terminal-mod';

/**
 * Command Code의 mod가 불러와졌다는 신호(session-start)를 기다리는 시계(보안 검토, ADR-233). 가짜 시계만 쓴다.
 * 설정이 `--mod`로 준 mod를 꺼도 CLI는 그냥 돈다. 그때 훅이 하나도 없다는 것은 신호가 오지 않는 것으로만 보인다.
 */
describe('mod 시계', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.B_STUDIO_COMMANDCODE_MOD_TIMEOUT_MS;
  });
  afterEach(() => {
    disarmModClock('s1');
    disarmModClock('s2');
    vi.useRealTimers();
    delete process.env.B_STUDIO_COMMANDCODE_MOD_TIMEOUT_MS;
  });

  it('기본 상한은 90초이고, 환경 변수로는 낮추기만 한다(높이거나 이상한 값은 무시한다)', () => {
    expect(modLoadTimeoutMs({})).toBe(90_000);
    expect(modLoadTimeoutMs({ B_STUDIO_COMMANDCODE_MOD_TIMEOUT_MS: '250' })).toBe(250);
    for (const value of ['999999999', '0', '-5', 'abc', '', 'NaN', 'Infinity']) expect(modLoadTimeoutMs({ B_STUDIO_COMMANDCODE_MOD_TIMEOUT_MS: value }), value).toBe(90_000);
  });

  it('session-start가 시간 안에 오지 않으면 부른다. 한 번만 부른다', () => {
    const calls: string[] = [];
    armModClock('s1', (reason) => calls.push(reason), 1000);
    vi.advanceTimersByTime(999);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('session-start');
    vi.advanceTimersByTime(10_000);
    expect(calls).toHaveLength(1);
  });

  it('session-start가 오면 시계가 선다(대조)', () => {
    const calls: string[] = [];
    armModClock('s1', (reason) => calls.push(reason), 1000);
    vi.advanceTimersByTime(500);
    noteModStarted('s1');
    vi.advanceTimersByTime(10_000);
    expect(calls).toEqual([]);
  });

  it('reload로 끝났다는 알림이 오면 시계를 다시 건다: 새 session-start가 오지 않으면 부르고, 오면 부르지 않는다', () => {
    const calls: string[] = [];
    armModClock('s1', (reason) => calls.push(reason), 1000);
    noteModStarted('s1');
    noteModReloading('s1');
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('reload');

    const ok: string[] = [];
    armModClock('s2', (reason) => ok.push(reason), 1000);
    noteModStarted('s2');
    noteModReloading('s2');
    vi.advanceTimersByTime(400);
    noteModStarted('s2');
    vi.advanceTimersByTime(10_000);
    expect(ok).toEqual([]);
  });

  it('시계가 걸리지 않은 세션(commandcode가 아니거나 터미널이 닫힘)은 알림이 와도 아무 일도 하지 않는다. 풀면 부르지 않는다', () => {
    const calls: string[] = [];
    noteModReloading('s1');
    noteModStarted('s1');
    armModClock('s1', (reason) => calls.push(reason), 1000);
    disarmModClock('s1');
    noteModReloading('s1');
    vi.advanceTimersByTime(10_000);
    expect(calls).toEqual([]);
  });

  it('같은 세션에 다시 걸면 앞의 시계는 선다(터미널을 다시 연 경우)', () => {
    const first: string[] = [];
    const second: string[] = [];
    armModClock('s1', (reason) => first.push(reason), 1000);
    armModClock('s1', (reason) => second.push(reason), 1000);
    vi.advanceTimersByTime(1000);
    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
  });
});
