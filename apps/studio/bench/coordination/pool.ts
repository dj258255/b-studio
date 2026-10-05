/**
 * 동시 실행 작은 작업 풀.
 *
 * 입력 순서(인덱스)는 그대로 두고, 한 번에 최대 concurrency개까지만 돈다.
 * 작업 하나가 끝날 때마다 onSettled를 부르고(도착 순서), shouldAbort가 true를 돌려주면
 * 아직 시작하지 않은 작업은 더 시작하지 않는다(이미 시작한 작업은 끝까지 돈다) — 사용 한도·남은 컨테이너처럼
 * "더 늘리면 안 되는" 신호를 부모 프로세스가 즉시 반영하게 한다.
 * AbortSignal을 주면 신호가 끊겼을 때도 같은 방식으로 새 작업을 멈춘다(Ctrl-C).
 */

export interface PoolJob<T> {
  run: () => Promise<T>;
}

export interface PoolOptions<T> {
  concurrency: number;
  /** 작업 하나가 끝날 때마다(도착 순서) 부른다. 결과를 즉시 기록하는 데 쓴다 */
  onSettled?: (result: T, index: number) => void | Promise<void>;
  /** true를 돌려주면 아직 시작하지 않은 작업을 더 시작하지 않는다 */
  shouldAbort?: (result: T, index: number) => boolean;
  /** 끊기면 새 작업을 더 시작하지 않는다(이미 시작한 작업은 끝까지 돈다) */
  signal?: AbortSignal;
}

export interface PoolOutcome<T> {
  /** 입력 배열과 같은 인덱스. 시작하지 못한 자리는 undefined */
  results: (T | undefined)[];
  /** shouldAbort나 signal로 새 작업 시작을 멈췄는지 */
  aborted: boolean;
}

export async function runPool<T>(jobs: ReadonlyArray<PoolJob<T>>, options: PoolOptions<T>): Promise<PoolOutcome<T>> {
  const { concurrency } = options;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`concurrency는 1 이상의 정수여야 합니다 (지금 값: ${concurrency})`);
  const results: (T | undefined)[] = new Array(jobs.length);
  let cursor = 0;
  let aborted = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (aborted || options.signal?.aborted) return;
      const index = cursor;
      if (index >= jobs.length) return;
      cursor += 1;
      const result = await jobs[index]!.run();
      results[index] = result;
      await options.onSettled?.(result, index);
      if (options.shouldAbort?.(result, index)) aborted = true;
    }
  };

  const workerCount = Math.max(0, Math.min(concurrency, jobs.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { results, aborted: aborted || Boolean(options.signal?.aborted) };
}
