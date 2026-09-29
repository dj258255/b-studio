import { describe, expect, it } from 'vitest';
import { countDropped, formatMs, percentile, renderTable, summarize } from './metrics';

describe('부하 스모크 계산', () => {
  it('백분위는 정렬한 값에서 가장 가까운 순위를 고른다', () => {
    const values = [40, 10, 30, 20];
    expect(percentile(values, 50)).toBe(20);
    expect(percentile(values, 95)).toBe(40);
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 100)).toBe(40);
    expect(percentile([], 50)).toBe(0);
    expect(() => percentile([1], 101)).toThrow('0~100');
  });

  it('지연 집계는 최소·p50·p95·최대·평균을 낸다', () => {
    expect(summarize([])).toEqual({ count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, meanMs: 0 });
    expect(summarize([10, 20, 30, 40])).toEqual({ count: 4, minMs: 10, p50Ms: 20, p95Ms: 40, maxMs: 40, meanMs: 25 });
  });

  it('떨어진 이벤트 수는 음수가 되지 않는다', () => {
    expect(countDropped(100, 90)).toBe(10);
    expect(countDropped(100, 100)).toBe(0);
    expect(countDropped(100, 120)).toBe(0);
  });

  it('표를 칸 너비에 맞춰 그리고, 밀리초를 소수 한 자리로 적는다', () => {
    expect(formatMs(12.34)).toBe('12.3ms');
    const lines = renderTable(['item', 'value'], [['session p50', '12.0ms'], ['events', '100']]).split('\n');
    expect(lines).toHaveLength(3);
    // 첫 줄은 헤더, 각 줄의 첫 열은 가장 넓은 값(11자)에 맞춰지고 열은 두 칸으로 나뉜다
    expect(lines[0]).toMatch(/^item\s+value$/);
    expect(lines[1]).toBe('session p50  12.0ms');
    expect(lines[2]).toMatch(/^events\s+100$/);
  });
});
