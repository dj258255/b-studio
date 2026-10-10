import { describe, expect, it } from 'vitest';
import { concurrencyLabel, parseArgs, parseTopology, resolveConcurrency, selectStrategies } from './args';

describe('parseArgs', () => {
  it('기본값은 dry·force 모두 꺼짐이고 나머지는 없다', () => {
    expect(parseArgs([])).toEqual({ dry: false, force: false });
  });

  it('플래그와 `--플래그 값`, `--플래그=값` 형식을 모두 받는다', () => {
    expect(parseArgs(['--dry', '--force'])).toEqual({ dry: true, force: true });
    expect(parseArgs(['--backend', 'claude-code', '--model', 'sonnet'])).toEqual({ dry: false, force: false, backend: 'claude-code', model: 'sonnet' });
    expect(parseArgs(['--backend=claude-code', '--model=sonnet'])).toEqual({ dry: false, force: false, backend: 'claude-code', model: 'sonnet' });
  });

  it('--handoff-tests는 값을 받고 --protect-handoff는 플래그다', () => {
    expect(parseArgs(['--handoff-tests', 'correct'])).toEqual({ dry: false, force: false, handoffTests: 'correct' });
    expect(parseArgs(['--handoff-tests=conflict', '--protect-handoff'])).toEqual({ dry: false, force: false, handoffTests: 'conflict', protectHandoff: true });
    expect(() => parseArgs(['--handoff-tests'])).toThrow(/--handoff-tests 뒤에 값이 필요합니다/);
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

  it('--max-env-failures를 `--플래그 값`, `--플래그=값` 형식 모두로 받는다', () => {
    expect(parseArgs(['--max-env-failures', '3'])).toMatchObject({ maxEnvFailures: 3 });
    expect(parseArgs(['--max-env-failures=5'])).toMatchObject({ maxEnvFailures: 5 });
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

describe('selectStrategies', () => {
  it('--dry에서도 S0·S1 안에서는 준 전략을 따른다(동시 실행 자식이 전략 하나만 돌게)', () => {
    expect(selectStrategies(['S1'], true)).toEqual(['S1']);
    expect(selectStrategies(['S0'], true)).toEqual(['S0']);
    expect(selectStrategies(['S2', 'S0'], true)).toEqual(['S0']);
    expect(selectStrategies(['S3'], true)).toEqual(['S0', 'S1']);
    expect(selectStrategies(undefined, true)).toEqual(['S0', 'S1']);
  });

  it('실제 실행은 준 전략을 그대로 쓰고, 없으면 S0·S1이다', () => {
    expect(selectStrategies(['S2', 'S2', 'S0'], false)).toEqual(['S2', 'S0']);
    expect(selectStrategies(undefined, false)).toEqual(['S0', 'S1']);
    expect(() => selectStrategies(['S9' as never], false)).toThrow(/전략은/);
  });
});
