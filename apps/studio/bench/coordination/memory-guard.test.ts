import { describe, expect, it } from 'vitest';
import {
  EDGE_MEMORY_MB,
  evaluateMemoryGuard,
  memoryGuardMessage,
  parseComposeMemoryMb,
  parseDockerMemTotalMb,
  parseDockerStatsMemUsage,
  perRunMemoryMb,
  sumDockerStatsMb,
} from './memory-guard';

describe('parseComposeMemoryMb', () => {
  it('k, m, g 단위를 MB로 바꾼다', () => {
    expect(parseComposeMemoryMb('2048m')).toBe(2048);
    expect(parseComposeMemoryMb('1g')).toBe(1024);
    expect(parseComposeMemoryMb('1.5g')).toBe(1536);
    expect(parseComposeMemoryMb('256m')).toBe(256);
    expect(parseComposeMemoryMb('1024k')).toBe(1);
  });

  it('알 수 없는 표기는 거부한다', () => {
    expect(() => parseComposeMemoryMb('2GB')).toThrow(/메모리 표기를 알 수 없습니다/);
    expect(() => parseComposeMemoryMb('many')).toThrow(/메모리 표기를 알 수 없습니다/);
  });
});

describe('perRunMemoryMb', () => {
  it('examples/orders/studio.yaml의 resources 합 + edge 오버헤드를 낸다', () => {
    const resources = { api: { memory: '2048m' }, web: { memory: '1g' }, db: { memory: '256m' } };
    expect(perRunMemoryMb(resources)).toBe(2048 + 1024 + 256 + EDGE_MEMORY_MB);
  });

  it('메모리 표기가 없는 서비스는 0으로 친다', () => {
    expect(perRunMemoryMb({ api: {} })).toBe(EDGE_MEMORY_MB);
  });
});

describe('parseDockerMemTotalMb', () => {
  it('docker info의 바이트 문자열을 MB로 바꾼다', () => {
    expect(parseDockerMemTotalMb(String(16 * 1024 * 1024 * 1024))).toBeCloseTo(16 * 1024, 3);
  });

  it('숫자가 아니면 거부한다', () => {
    expect(() => parseDockerMemTotalMb('알 수 없음')).toThrow(/Docker 전체 메모리를 읽지 못했습니다/);
    expect(() => parseDockerMemTotalMb('0')).toThrow();
  });
});

describe('parseDockerStatsMemUsage / sumDockerStatsMb', () => {
  it('MiB·GiB 단위 한 줄을 MB로 바꾼다', () => {
    expect(parseDockerStatsMemUsage('123.4MiB / 1.944GiB')).toBeCloseTo(123.4, 3);
    expect(parseDockerStatsMemUsage('1.5GiB / 4GiB')).toBeCloseTo(1536, 3);
  });

  it('여러 컨테이너의 줄을 더한다', () => {
    const output = '100MiB / 2GiB\n200MiB / 2GiB\n\n1GiB / 4GiB\n';
    expect(sumDockerStatsMb(output)).toBeCloseTo(100 + 200 + 1024, 3);
  });

  it('빈 출력은 0이다(도는 컨테이너 없음)', () => {
    expect(sumDockerStatsMb('')).toBe(0);
  });
});

describe('evaluateMemoryGuard', () => {
  it('남은 메모리가 필요량 + 여유보다 크면 통과한다', () => {
    const result = evaluateMemoryGuard({ concurrency: 2, perRunMb: 3456, totalMb: 16 * 1024, usedMb: 0, marginMb: 2048 });
    expect(result.ok).toBe(true);
    expect(result.neededMb).toBe(6912);
    expect(result.availableMb).toBe(16 * 1024);
  });

  it('모자라면 막고 낮출 N을 제안한다', () => {
    const result = evaluateMemoryGuard({ concurrency: 5, perRunMb: 3456, totalMb: 16 * 1024, usedMb: 0, marginMb: 2048 });
    expect(result.ok).toBe(false);
    expect(result.suggestedConcurrency).toBeLessThan(5);
    expect(result.suggestedConcurrency).toBeGreaterThanOrEqual(1);
  });

  it('이미 도는 컨테이너가 쓰는 메모리를 뺀다', () => {
    const withUsage = evaluateMemoryGuard({ concurrency: 2, perRunMb: 3456, totalMb: 16 * 1024, usedMb: 8 * 1024, marginMb: 2048 });
    const withoutUsage = evaluateMemoryGuard({ concurrency: 2, perRunMb: 3456, totalMb: 16 * 1024, usedMb: 0, marginMb: 2048 });
    expect(withUsage.availableMb).toBeLessThan(withoutUsage.availableMb);
    expect(withUsage.ok).toBe(false);
    expect(withoutUsage.ok).toBe(true);
  });

  it('제안 N은 최소 1이다', () => {
    const result = evaluateMemoryGuard({ concurrency: 10, perRunMb: 100_000, totalMb: 1024, usedMb: 0 });
    expect(result.suggestedConcurrency).toBe(1);
  });
});

describe('memoryGuardMessage', () => {
  it('필요·남은 메모리와 --force 안내를 한국어로 담는다', () => {
    const result = evaluateMemoryGuard({ concurrency: 5, perRunMb: 3456, totalMb: 16 * 1024, usedMb: 0, marginMb: 2048 });
    const message = memoryGuardMessage(result, 5);
    expect(message).toContain('--concurrency 5');
    expect(message).toContain('colima');
    expect(message).toContain('--force');
  });
});
