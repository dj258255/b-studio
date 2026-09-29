import { describe, expect, it, vi } from 'vitest';
import { SteeringQueue } from './steering';

describe('SteeringQueue', () => {
  it('push한 지시를 take로 꺼내면 비워진다', () => {
    const queue = new SteeringQueue();
    expect(queue.take()).toEqual([]);
    queue.push('a');
    queue.push('b');
    expect(queue.take()).toEqual(['a', 'b']);
    expect(queue.take()).toEqual([]);
  });

  it('지시가 들어오면 onPush 구독자에게 알리고, 해제하면 더 알리지 않는다', () => {
    const queue = new SteeringQueue();
    const listener = vi.fn();
    const off = queue.onPush(listener);
    queue.push('a');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    queue.push('b');
    expect(listener).toHaveBeenCalledTimes(1);
    // 해제해도 지시는 남아 take로 꺼낼 수 있다
    expect(queue.take()).toEqual(['a', 'b']);
  });
});
