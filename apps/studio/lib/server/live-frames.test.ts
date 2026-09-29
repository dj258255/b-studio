import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearFrames, publish, publishBlocked, subscribe, type LiveFrame } from './live-frames';

function frame(data: string): LiveFrame {
  return { source: 'qa', check: 'web /', mime: 'image/jpeg', data, width: 375, height: 812, at: 1 };
}

afterEach(() => {
  clearFrames('session');
  clearFrames('other');
});

describe('live-frames', () => {
  it('구독자에게 프레임을 보내고, 마지막 한 장을 새 구독자에게 곧바로 다시 보낸다', () => {
    const first = vi.fn();
    const off = subscribe('session', first);
    publish('session', frame('a'));
    publish('session', frame('b'));
    expect(first).toHaveBeenCalledTimes(2);
    expect(first.mock.calls.at(-1)?.[0]).toMatchObject({ data: 'b' });

    const second = vi.fn();
    const offSecond = subscribe('session', second);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]?.[0]).toMatchObject({ data: 'b', source: 'qa' });

    off();
    offSecond();
  });

  it('구독을 풀면 더는 받지 않고, 세션 채널이 다르면 섞이지 않는다', () => {
    const listener = vi.fn();
    const off = subscribe('session', listener);
    off();
    publish('session', frame('a'));
    expect(listener).not.toHaveBeenCalled();

    const other = vi.fn();
    const offOther = subscribe('other', other);
    publish('session', frame('b'));
    expect(other).not.toHaveBeenCalled();
    offOther();
  });

  it('채널을 지우면 마지막 프레임도 사라진다', () => {
    publish('session', frame('a'));
    clearFrames('session');
    const listener = vi.fn();
    const off = subscribe('session', listener);
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it('막힌 요청 수를 보내고, 새 구독자에게 마지막 값을 다시 보낸다', () => {
    publishBlocked('session', 3);
    const listener = vi.fn();
    const off = subscribe('session', listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ kind: 'blocked', count: 3 });

    publishBlocked('session', 4);
    expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'blocked', count: 4 });
    off();
  });
});
