import { describe, expect, it } from 'vitest';
import { concurrencyLabel, parseArgs, parseTopology, resolveConcurrency } from './args';

describe('parseArgs', () => {
  it('기본값은 dry·force 모두 꺼짐이고 나머지는 없다', () => {
    expect(parseArgs([])).toEqual({ dry: false, force: false });
  });

  it('플래그와 `--플래그 값`, `--플래그=값` 형식을 모두 받는다', () => {
    expect(parseArgs(['--dry', '--force'])).toEqual({ dry: true, force: true });
    expect(parseArgs(['--backend', 'claude-code', '--model', 'sonnet'])).toEqual({ dry: false, force: false, backend: 'claude-code', model: 'sonnet' });
    expect(parseArgs(['--backend=claude-code', '--model=sonnet'])).toEqual({ dry: false, force: false, backend: 'claude-code', model: 'sonnet' });
  });

  it('--tasks·--strategies는 콤마로 나누고 앞뒤 공백을 없앤다', () => {
    const args = parseArgs(['--tasks', ' orders-list, order-detail ', '--strategies', 'S0,S1']);
    expect(args.taskIds).toEqual(['orders-list', 'order-detail']);
    expect(args.strategies).toEqual(['S0', 'S1']);
  });

  it('--lane-backend는 반복할 수 있다', () => {
    const args = parseArgs(['--lane-backend', 'api=claude-code', '--lane-backend', 'web=commandcode:sonnet']);
    expect(args.laneBackends).toEqual(['api=claude-code', 'web=commandcode:sonnet']);
  });

  it('값이 필요한 플래그 뒤에 값이 없으면 거부한다', () => {
    expect(() => parseArgs(['--backend'])).toThrow(/--backend 뒤에 값이 필요합니다/);
  });

  it('모르는 인자는 거부한다', () => {
    expect(() => parseArgs(['--unknown-flag'])).toThrow(/알 수 없는 인자입니다/);
  });

  it('--concurrency와 내부용 인자(--child-concurrency·--repeat-index·--order-start)를 받는다', () => {
    expect(parseArgs(['--concurrency', '4'])).toMatchObject({ concurrency: 4 });
    expect(parseArgs(['--concurrency=4'])).toMatchObject({ concurrency: 4 });
    expect(parseArgs(['--child-concurrency', '4', '--repeat-index', '2', '--order-start', '5'])).toMatchObject({
      childConcurrency: 4,
      repeatIndex: 2,
      orderStart: 5,
    });
  });
});

describe('parseTopology', () => {
  it('생략하면 mesh다', () => {
    expect(parseTopology(undefined)).toBe('mesh');
  });

  it('star·hierarchical·mesh만 받는다', () => {
    expect(parseTopology('star')).toBe('star');
    expect(parseTopology('hierarchical')).toBe('hierarchical');
    expect(() => parseTopology('ring')).toThrow(/star, hierarchical, mesh 중 하나여야 합니다/);
  });
});

describe('resolveConcurrency', () => {
  it('생략하면 1이다(오늘과 같은 직렬 실행)', () => {
    expect(resolveConcurrency(undefined)).toBe(1);
  });

  it('1 이상의 정수만 받는다', () => {
    expect(resolveConcurrency(4)).toBe(4);
    expect(() => resolveConcurrency(0)).toThrow(/--concurrency는 1 이상의 정수여야 합니다/);
    expect(() => resolveConcurrency(-1)).toThrow(/--concurrency는 1 이상의 정수여야 합니다/);
    expect(() => resolveConcurrency(1.5)).toThrow(/--concurrency는 1 이상의 정수여야 합니다/);
  });
});

describe('concurrencyLabel', () => {
  it('자식 프로세스면 부모가 준 --child-concurrency를 쓴다', () => {
    expect(concurrencyLabel({ childConcurrency: 4 })).toBe(4);
  });

  it('자식이 아니면 이 프로세스 자신의 --concurrency(없으면 1)를 쓴다', () => {
    expect(concurrencyLabel({})).toBe(1);
    expect(concurrencyLabel({ concurrency: 3 })).toBe(3);
  });
});
