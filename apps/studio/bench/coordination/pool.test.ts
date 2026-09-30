import { describe, expect, it } from 'vitest';
import { runPool, type PoolJob } from './pool';

/** 대기 중인 마이크로태스크를 모두 비운다(타이머 없이 결정적으로 진행 상태를 확인하려고) */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 밖에서 끝내는 시점을 조종할 수 있는 작업. deferred.resolve()를 부르기 전까지 run()이 끝나지 않는다 */
function deferredJob<T>(value: T): { job: PoolJob<T>; resolve: () => void; started: boolean } {
  const state = { started: false };
  let resolve!: () => void;
  const gate = new Promise<void>((r) => (resolve = r));
  return {
    job: {
      run: async () => {
        state.started = true;
        await gate;
        return value;
      },
    },
    resolve,
    get started() {
      return state.started;
    },
  } as { job: PoolJob<T>; resolve: () => void; started: boolean };
}

describe('runPool', () => {
  it('입력 순서대로 결과를 돌려준다(완료 순서가 달라도)', async () => {
    const jobs: PoolJob<number>[] = [
      { run: async () => (await flush(), 0) },
      { run: async () => 1 }, // 가장 먼저 끝난다
      { run: async () => (await flush(), await flush(), 2) },
    ];
    const outcome = await runPool(jobs, { concurrency: 3 });
    expect(outcome.results).toEqual([0, 1, 2]);
    expect(outcome.aborted).toBe(false);
  });

  it('동시에 concurrency개까지만 돈다', async () => {
    const total = 5;
    const concurrency = 2;
    const deferreds = Array.from({ length: total }, (_, index) => deferredJob(index));
    const jobs = deferreds.map((entry) => entry.job);

    const promise = runPool(jobs, { concurrency });
    await flush();
    // 처음 두 개만 시작해 있어야 한다
    expect(deferreds[0]!.started).toBe(true);
    expect(deferreds[1]!.started).toBe(true);
    expect(deferreds[2]!.started).toBe(false);

    deferreds[0]!.resolve();
    await flush();
    expect(deferreds[2]!.started).toBe(true);
    expect(deferreds[3]!.started).toBe(false);

    deferreds[1]!.resolve();
    await flush();
    expect(deferreds[3]!.started).toBe(true);
    expect(deferreds[4]!.started).toBe(false);

    deferreds[2]!.resolve();
    deferreds[3]!.resolve();
    await flush();
    expect(deferreds[4]!.started).toBe(true);
    deferreds[4]!.resolve();

    const outcome = await promise;
    expect(outcome.results).toEqual([0, 1, 2, 3, 4]);
  });

  it('shouldAbort가 true면 아직 시작하지 않은 작업을 새로 시작하지 않는다(이미 시작한 작업은 끝까지 돈다)', async () => {
    const total = 6;
    const concurrency = 2;
    const deferreds = Array.from({ length: total }, (_, index) => deferredJob({ index, stop: index === 1 }));
    const jobs = deferreds.map((entry) => entry.job);

    const promise = runPool(jobs, { concurrency, shouldAbort: (result) => result.stop });
    await flush();
    // 처음 두 개(0·1)만 동시에 시작해 있다
    expect(deferreds[0]!.started).toBe(true);
    expect(deferreds[1]!.started).toBe(true);
    expect(deferreds[2]!.started).toBe(false);

    // index 1이 stop 신호를 내며 먼저 끝난다 — 아직 시작하지 않은 작업(2 이상)을 더 시작하면 안 된다
    deferreds[1]!.resolve();
    await flush();
    expect(deferreds[2]!.started).toBe(false);

    // index 0은 이미 시작했으니 끝까지 돈다. 끝나도 새 작업(2)을 더 시작하지 않는다
    deferreds[0]!.resolve();
    await flush();
    expect(deferreds[2]!.started).toBe(false);

    const outcome = await promise;
    expect(outcome.aborted).toBe(true);
    expect(outcome.results[0]).toEqual({ index: 0, stop: false });
    expect(outcome.results[1]).toEqual({ index: 1, stop: true });
    expect(outcome.results.slice(2)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('onSettled를 완료마다 부른다(도착 순서)', async () => {
    const order: number[] = [];
    const jobs: PoolJob<number>[] = [{ run: async () => (await flush(), await flush(), 0) }, { run: async () => 1 }];
    await runPool(jobs, {
      concurrency: 2,
      onSettled: (_, index) => {
        order.push(index);
      },
    });
    expect(order).toEqual([1, 0]);
  });

  it('이미 끊긴 signal이면 아무 작업도 시작하지 않는다', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const jobs: PoolJob<number>[] = [{ run: async () => (calls += 1, 0) }];
    const outcome = await runPool(jobs, { concurrency: 1, signal: controller.signal });
    expect(calls).toBe(0);
    expect(outcome.aborted).toBe(true);
  });

  it('작업이 없으면 빈 결과를 돌려준다', async () => {
    const outcome = await runPool([], { concurrency: 3 });
    expect(outcome.results).toEqual([]);
    expect(outcome.aborted).toBe(false);
  });

  it('concurrency가 1 미만이면 거부한다', async () => {
    await expect(runPool([], { concurrency: 0 })).rejects.toThrow(/concurrency는 1 이상의 정수여야 합니다/);
  });
});
