import { describe, expect, it } from 'vitest';
import { runTaskGraph, TaskGraphError } from './task-graph';

describe('runTaskGraph', () => {
  it('independent tasks run in parallel and a dependent task waits for both', async () => {
    const events: string[] = [];
    const results = await runTaskGraph(
      [
        {
          id: 'search-code',
          run: async () => {
            events.push('search:start');
            await delay(15);
            events.push('search:end');
            return 'files';
          },
        },
        {
          id: 'read-contract',
          run: async () => {
            events.push('contract:start');
            await delay(5);
            events.push('contract:end');
            return 'openapi';
          },
        },
        {
          id: 'plan',
          dependsOn: ['search-code', 'read-contract'],
          run: async () => {
            events.push('plan');
            return 'plan';
          },
        },
      ],
      { concurrency: 2 },
    );

    expect(events.indexOf('contract:start')).toBeLessThan(events.indexOf('search:end'));
    expect(events.indexOf('plan')).toBeGreaterThan(events.indexOf('search:end'));
    expect(results.map((result) => result.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  });

  it('retries a failed task and skips its dependents after the retry budget is exhausted', async () => {
    let attempts = 0;
    const results = await runTaskGraph([
      {
        id: 'flaky',
        maxAttempts: 2,
        run: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary failure');
          return 'ok';
        },
      },
      { id: 'after-flaky', dependsOn: ['flaky'], run: async () => 'done' },
      { id: 'broken', run: async () => { throw new Error('permanent failure'); } },
      { id: 'after-broken', dependsOn: ['broken'], run: async () => 'never' },
    ]);

    expect(results).toMatchObject([
      { id: 'flaky', status: 'succeeded', attempts: 2 },
      { id: 'after-flaky', status: 'succeeded' },
      { id: 'broken', status: 'failed' },
      { id: 'after-broken', status: 'skipped' },
    ]);
  });

  it('rejects missing and cyclic dependencies before work starts', async () => {
    await expect(runTaskGraph([{ id: 'a', dependsOn: ['missing'], run: async () => undefined }])).rejects.toThrow(TaskGraphError);
    await expect(
      runTaskGraph([
        { id: 'a', dependsOn: ['b'], run: async () => undefined },
        { id: 'b', dependsOn: ['a'], run: async () => undefined },
      ]),
    ).rejects.toThrow('순환 의존성');
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
