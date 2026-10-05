import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, type Args } from './args';
import { buildChildArgv, planUnits, readChildRow, serializeArgv, shouldStopDispatch, sortByOrder, synthesizeCrashRow, type RunConcurrentOptions } from './concurrent-run';
import { runPool } from './pool';
import { BENCH_TASKS } from './tasks';

const [orders, detail, summary] = BENCH_TASKS;

describe('planUnits', () => {
  it('반복 → 과제 → 전략 순서로 번호를 매긴다(직렬 실행의 중첩 루프와 같다)', () => {
    const units = planUnits([orders!, detail!], ['S0', 'S1'], 2);
    // 1반복: S0, S1 그대로. 2반복: 전략을 뒤집는다(직렬 실행과 같은 규칙)
    expect(units.map((unit) => [unit.order, unit.repeat, unit.task.id, unit.strategy])).toEqual([
      [1, 1, 'orders-list', 'S0'],
      [2, 1, 'orders-list', 'S1'],
      [3, 1, 'order-detail', 'S0'],
      [4, 1, 'order-detail', 'S1'],
      [5, 2, 'orders-list', 'S1'],
      [6, 2, 'orders-list', 'S0'],
      [7, 2, 'order-detail', 'S1'],
      [8, 2, 'order-detail', 'S0'],
    ]);
  });

  it('과제·전략이 하나씩, 반복 1이면 단위 하나다', () => {
    const units = planUnits([orders!], ['S0'], 1);
    expect(units).toEqual([{ order: 1, repeat: 1, task: orders, strategy: 'S0' }]);
  });

  it('과제가 없으면 빈 계획이다', () => {
    expect(planUnits([], ['S0'], 3)).toEqual([]);
  });
});

describe('sortByOrder', () => {
  it('완료 순서와 무관하게 order로 정렬한다', () => {
    const rows = [{ order: 3, v: 'c' }, { order: 1, v: 'a' }, { order: 2, v: 'b' }];
    expect(sortByOrder(rows).map((row) => row.v)).toEqual(['a', 'b', 'c']);
  });

  it('원본 배열을 바꾸지 않는다', () => {
    const rows = [{ order: 2 }, { order: 1 }];
    const sorted = sortByOrder(rows);
    expect(rows.map((row) => row.order)).toEqual([2, 1]);
    expect(sorted.map((row) => row.order)).toEqual([1, 2]);
  });
});

describe('shouldStopDispatch', () => {
  it('사용 한도에 걸리면 멈춘다', () => {
    expect(shouldStopDispatch({ category: 'rate_limited', leftoverContainers: [] })).toBe(true);
  });

  it('남은 컨테이너가 있으면 멈춘다', () => {
    expect(shouldStopDispatch({ category: 'none', leftoverContainers: ['studio-bench-orders-1-abc123'] })).toBe(true);
  });

  it('둘 다 아니면 계속한다', () => {
    expect(shouldStopDispatch({ category: 'none', leftoverContainers: [] })).toBe(false);
    expect(shouldStopDispatch({ category: 'acceptance', leftoverContainers: [] })).toBe(false);
  });
});

describe('runPool + shouldStopDispatch(사용 한도 정지 동작)', () => {
  it('사용 한도에 걸린 실행 뒤로는 아직 시작하지 않은 실행을 새로 띄우지 않고, 이미 도는 실행은 끝까지 돈다', async () => {
    const units = planUnits([orders!], ['S0', 'S1'], 3); // 3개 단위: order 1(정상) · 2(사용 한도) · 3(정상이었을 것)
    const started: number[] = [];
    let unblockRateLimited: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (unblockRateLimited = resolve));

    const jobs = units.map((unit) => ({
      run: async () => {
        started.push(unit.order);
        if (unit.order === 2) await gate; // 두 번째 실행이 끝나는 시점을 테스트가 조종한다
        return { order: unit.order, category: unit.order === 2 ? ('rate_limited' as const) : ('none' as const), leftoverContainers: [] as string[] };
      },
    }));

    const promise = runPool(jobs, { concurrency: 1, shouldAbort: (row) => shouldStopDispatch(row) });
    await new Promise((resolve) => setImmediate(resolve));
    // 1번(정상)이 동기로 바로 끝나고, 이어서 2번(사용 한도)이 시작해 gate로 막혀 있다
    expect(started).toEqual([1, 2]);

    unblockRateLimited!();
    const outcome = await promise;
    // 2번(사용 한도)이 끝난 뒤로는 3번을 새로 시작하지 않는다
    expect(started).toEqual([1, 2]);
    expect(outcome.aborted).toBe(true);
    expect(outcome.results[2]).toBeUndefined();
  });
});

describe('serializeArgv ↔ parseArgs 왕복', () => {
  it('설정한 값을 그대로 되돌려 받는다(자식에게 넘길 전체 인자 구성)', () => {
    const args: Args = {
      dry: false,
      force: true,
      taskIds: ['orders-list', 'order-detail'],
      strategies: ['S0', 'S1'],
      repeats: 3,
      out: '/tmp/out',
      backend: 'claude-code',
      model: 'sonnet',
      onRateLimit: 'wait',
      rateLimitWaitMinutes: 15,
      contextClearing: 'on',
      topology: 'star',
      integrationChecks: true,
      verify: 'light',
      selfCheck: 'lean',
      contracts: 'model',
      escalateTo: 'opus',
      escalateAfter: 2,
      escalateAfterFailures: 3,
      escalateRetryBudget: 1,
      laneBackends: ['api=claude-code:sonnet', 'web=commandcode'],
      prices: '/tmp/prices.json',
      planModel: 'opus',
      executeModel: 'haiku',
      planAlways: true,
    };
    const roundtripped = parseArgs(serializeArgv(args));
    expect(roundtripped).toEqual(args);
  });

  it('아무것도 안 준 기본 인자도 왕복한다', () => {
    const args: Args = { dry: true, force: false };
    expect(parseArgs(serializeArgv(args))).toEqual(args);
  });

  it('--concurrency·--child-concurrency·--repeat-index·--order-start는 내보내지 않는다(자식이 직접 이걸로 다시 풀을 띄우면 안 된다)', () => {
    const args: Args = { dry: false, force: false, backend: 'claude-code', concurrency: 4, childConcurrency: 4, repeatIndex: 2, orderStart: 5 };
    const argv = serializeArgv(args);
    expect(argv).not.toContain('--concurrency');
    expect(argv).not.toContain('--child-concurrency');
    expect(argv).not.toContain('--repeat-index');
    expect(argv).not.toContain('--order-start');
  });
});

describe('buildChildArgv', () => {
  it('과제·전략을 단위 하나로 좁히고 반복 번호·순번·동시성 표시값을 내부 인자로 더한다', () => {
    const args: Args = { dry: false, force: false, backend: 'claude-code', model: 'sonnet', taskIds: ['orders-list', 'order-detail'], strategies: ['S0', 'S1'], repeats: 3 };
    const unit = { order: 5, repeat: 2, task: detail!, strategy: 'S1' as const };
    const argv = buildChildArgv(args, unit, '/tmp/out/.units/5', 4, 3);
    const parsed = parseArgs(argv);
    expect(parsed.taskIds).toEqual(['order-detail']);
    expect(parsed.strategies).toEqual(['S1']);
    expect(parsed.repeats).toBe(3);
    expect(parsed.out).toBe('/tmp/out/.units/5');
    expect(parsed.repeatIndex).toBe(2);
    expect(parsed.orderStart).toBe(4);
    expect(parsed.childConcurrency).toBe(4);
    // 부모의 --concurrency는 자식에게 넘어가지 않는다
    expect(parsed.concurrency).toBeUndefined();
  });
});

describe('synthesizeCrashRow', () => {
  it('order·과제·전략을 담아 실패 행을 만든다(자식이 결과를 못 남겨도 실험에서 그 자리를 잃지 않는다)', () => {
    const unit = { order: 7, repeat: 1, task: summary!, strategy: 'S0' as const };
    const row = synthesizeCrashRow(unit, 'claude-code', 'sonnet', { after: 2, retryBudget: 2 }, '종료 코드 1');
    expect(row.order).toBe(7);
    expect(row.taskId).toBe('order-summary');
    expect(row.strategy).toBe('S0');
    expect(row.success).toBe(false);
    expect(row.category).toBe('unknown');
    expect(row.detail).toContain('종료 코드 1');
    expect(row.leftoverContainers).toEqual([]);
  });
});

describe('readChildRow', () => {
  let childOut: string;
  const fakeOptions = { backend: 'claude-code', requestedModel: 'sonnet', escalation: { after: 2, retryBudget: 2 } } as unknown as RunConcurrentOptions;

  beforeEach(async () => {
    childOut = await mkdtemp(path.join(tmpdir(), 'b-studio-concurrent-run-test-'));
  });

  afterEach(async () => {
    await rm(childOut, { recursive: true, force: true });
  });

  it('results.jsonl이 없으면(자식이 설정 단계에서 죽음) 대체 행을 만든다', async () => {
    const unit = { order: 5, repeat: 1, task: orders!, strategy: 'S0' as const };
    const row = await readChildRow(childOut, unit, fakeOptions, { code: 1, signal: null }, path.join(childOut, 'child.log'));
    expect(row.order).toBe(5);
    expect(row.category).toBe('unknown');
    expect(row.detail).toContain('종료 코드 1');
  });

  it('한 줄이면 그 행을 쓰되 order는 부모가 계획한 값으로 맞춘다', async () => {
    const unit = { order: 7, repeat: 2, task: detail!, strategy: 'S1' as const };
    // 자식이 --order-start를 잘못 받았거나 다른 이유로 내부 order가 어긋나도(여기선 일부러 99) 부모가 덮어쓴다
    await writeFile(path.join(childOut, 'results.jsonl'), `${JSON.stringify({ order: 99, taskId: 'order-detail', category: 'none' })}\n`);
    const row = await readChildRow(childOut, unit, fakeOptions, { code: 0, signal: null }, path.join(childOut, 'child.log'));
    expect(row.order).toBe(7);
    expect(row.taskId).toBe('order-detail');
  });

  it('사용 한도 재시도로 두 줄이 남으면 마지막 줄(최종 결과)을 쓰고, order는 겹치지 않게 부모 값으로 맞춘다', async () => {
    const unit = { order: 7, repeat: 1, task: orders!, strategy: 'S0' as const };
    // 자식 안에서: 첫 시도(order=7, 사용 한도) → 재시도(order=8, retryOf=7, 성공). 8은 다음 단위(#8)의 order와 겹칠 수 있어 부모가 7로 되돌린다
    const lines = [
      JSON.stringify({ order: 7, taskId: 'orders-list', category: 'rate_limited', success: false }),
      JSON.stringify({ order: 8, retryOf: 7, taskId: 'orders-list', category: 'none', success: true }),
    ];
    await writeFile(path.join(childOut, 'results.jsonl'), `${lines.join('\n')}\n`);
    const row = await readChildRow(childOut, unit, fakeOptions, { code: 0, signal: null }, path.join(childOut, 'child.log'));
    expect(row.order).toBe(7);
    expect(row.success).toBe(true);
    expect(row.category).toBe('none');
    // retryOf가 order를 덮어쓴 뒤 자기 자신(7)을 가리키게 되므로 없앤다
    expect(row.retryOf).toBeUndefined();
  });
});
