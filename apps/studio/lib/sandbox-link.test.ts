import { describe, expect, it } from 'vitest';
import { advanceSandboxLink, newSandboxLinkTracker, sameSandboxLink, type SandboxLinkTracker, type SandboxProbe } from './sandbox-link';

const run = (probes: Array<[SandboxProbe, boolean?]>, start: SandboxLinkTracker = newSandboxLinkTracker()) =>
  probes.reduce((tracker, [probe, ready = true], index) => advanceSandboxLink(tracker, probe, `t${index + 1}`, ready), start);
const ok = (containers: number): SandboxProbe => ({ ok: true, containers });
const fail = (reason = 'Cannot connect to the Docker daemon at unix:///x/docker.sock'): SandboxProbe => ({ ok: false, reason });

describe('샌드박스 연결 상태', () => {
  it('한 번 못 읽은 것으로는 바꾸지 않고, 두 번 연속 못 읽으면 닿지 않음으로 본다(처음 못 읽은 시각부터)', () => {
    expect(run([[fail()]]).link).toBeUndefined();
    expect(run([[fail()], [fail()]]).link).toEqual({ state: 'unreachable', since: 't1', reason: 'Cannot connect to the Docker daemon at unix:///x/docker.sock' });
    expect(run([[fail()], [fail()], [fail('other')]]).link).toMatchObject({ state: 'unreachable', since: 't1', reason: 'other' });
  });

  it('사이에 한 번 읽히면 다시 센다', () => {
    expect(run([[fail()], [ok(3)], [fail()]]).link).toBeUndefined();
  });

  it('닿지 않던 것이 다시 읽히면 바로 문제없음으로 돌아온다', () => {
    const down = run([[fail()], [fail()]]);
    expect(advanceSandboxLink(down, ok(7), 't9', true)).toEqual(newSandboxLinkTracker());
  });

  it('준비됨인 세션에서 컨테이너가 두 번 연속 하나도 없으면 컨테이너 없음으로 본다', () => {
    expect(run([[ok(0)]]).link).toBeUndefined();
    expect(run([[ok(0)], [ok(0)]]).link).toEqual({ state: 'missing', since: 't1', reason: '이 세션의 컨테이너가 하나도 없습니다' });
  });

  it('기동 중이거나 멈춘 세션에서 컨테이너가 없는 것은 문제가 아니다', () => {
    expect(run([[ok(0), false], [ok(0), false], [ok(0), false]]).link).toBeUndefined();
    // 준비됨이 아니게 되면 이미 본 "컨테이너 없음"도 거둔다(다시 올리는 중이다)
    const missing = run([[ok(0)], [ok(0)]]);
    expect(advanceSandboxLink(missing, ok(0), 't9', false).link).toBeUndefined();
  });

  it('닿지 않음은 세션 상태와 무관하게 센다', () => {
    expect(run([[fail(), false], [fail(), false]]).link?.state).toBe('unreachable');
  });

  it('닿지 않다가 답은 오는데 컨테이너가 없으면, 두 번 확인될 때까지는 닿지 않음을 거두고 기다린다', () => {
    const down = run([[fail()], [fail()]]);
    const once = advanceSandboxLink(down, ok(0), 't3', true);
    expect(once.link).toBeUndefined();
    expect(advanceSandboxLink(once, ok(0), 't4', true).link).toEqual({ state: 'missing', since: 't3', reason: '이 세션의 컨테이너가 하나도 없습니다' });
  });

  it('사유는 첫 줄만, 200자까지 남긴다', () => {
    const link = run([[fail(`${'가'.repeat(300)}\n둘째 줄`)], [fail(`${'가'.repeat(300)}\n둘째 줄`)]]).link!;
    expect(link.reason).toHaveLength(200);
    expect(run([[fail('  ')], [fail('  ')]]).link!.reason).toBe('도커가 응답하지 않습니다');
  });

  it('같은 상태면 다시 알리지 않도록 비교한다', () => {
    const a = { state: 'unreachable', since: 't1', reason: 'x' } as const;
    expect(sameSandboxLink(a, { ...a })).toBe(true);
    expect(sameSandboxLink(a, { ...a, reason: 'y' })).toBe(false);
    expect(sameSandboxLink(undefined, undefined)).toBe(true);
    expect(sameSandboxLink(a, undefined)).toBe(false);
  });
});
