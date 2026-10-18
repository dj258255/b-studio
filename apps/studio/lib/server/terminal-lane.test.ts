import { describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';
import type { TaskCardDone } from './task-cards';

vi.mock('./sessions', () => ({
  getSnapshot: () => undefined,
  sessionHistory: () => [],
  sessionTerminalTarget: () => ({}),
  setTerminalTaskContext: () => {},
  subscribe: () => () => {},
  openTerminalRunId: () => undefined,
  cancelRun: () => {},
}));
vi.mock('./session-terminal', () => ({
  openSessionTerminal: async () => {},
  sessionTerminalCliAlive: () => false,
  writeSessionTerminal: () => {},
}));

import { runTerminalTask, type TerminalTaskDeps, type TerminalTaskOptions } from './terminal-lane';

const options = (overrides: Partial<TerminalTaskOptions> = {}): TerminalTaskOptions => ({ writableScope: ['api/src'], doneTests: [], ...overrides });

async function until(check: () => boolean, message: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 2_000) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function harness(
  config: {
    alive?: boolean | (() => boolean);
    startOnEnter?: number;
    runTimeoutMs?: number;
    closeTimeoutMs?: number;
    submitTimeoutMs?: number;
    /** 붙여 넣기 전에 열려 있는 실행 id */
    preOpen?: string;
    /** 첫 Enter에서 다른 요청의 run_started를 먼저 보낸다 */
    foreignFirst?: boolean;
    /** run_started.request를 <pasted_content>로 감싼다 */
    wrap?: boolean;
  } = {},
) {
  const writes: string[] = [];
  const contexts: Array<{ writableScope: readonly string[]; doneTests: readonly TaskCardDone[] } | undefined> = [];
  /** 가짜 세션 상태·열린 실행. 테스트가 바꿔 멈춤·늦은 종료·다른 실행을 흉내 낸다 */
  const state = { status: 'ready' as string, open: config.preOpen as string | undefined, cancels: [] as string[] };
  let listener: ((event: StudioEvent) => void) | undefined;
  let pastedText = '';
  let enters = 0;
  let runs = 0;
  let lastRunId = '';
  const startOnEnter = config.startOnEnter ?? 1;
  const alive = () => (typeof config.alive === 'function' ? config.alive() : (config.alive ?? true));

  const emit = (event: StudioEvent): void => listener?.(event);
  const driver = {
    open: async () => {},
    cliAlive: () => alive(),
    write: (_sessionId: string, data: string) => {
      writes.push(data);
      // bracketed paste로 들어온 우리 글을 기억한다 — run_started의 request와 견줄 때 쓴다
      if (data.startsWith('\x1b[200~')) {
        pastedText = data.slice('\x1b[200~'.length, -'\x1b[201~'.length);
        return;
      }
      if (data !== '\r') return;
      enters += 1;
      if (enters !== startOnEnter) return;
      if (config.foreignFirst) emit({ type: 'run_started', runId: 'foreign-1', request: '사람이 그 사이 친 다른 요청', via: 'terminal' });
      lastRunId = `run-${++runs}`;
      state.open = lastRunId;
      const requestText = config.wrap ? `<pasted_content id="x">\n${pastedText}\n</pasted_content id="x">` : pastedText;
      emit({ type: 'run_started', runId: lastRunId, request: requestText, via: 'terminal' });
    },
  };

  const deps: Partial<TerminalTaskDeps> = {
    driver,
    subscribe: (_sessionId, next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    readEvents: () => [],
    setTaskContext: (_sessionId, context) => {
      contexts.push(context);
    },
    status: () => state.status,
    openRunId: () => state.open,
    cancelRun: (_sessionId, runId) => {
      state.cancels.push(runId);
    },
    cliTimeoutMs: 200,
    submitTimeoutMs: config.submitTimeoutMs ?? 60,
    runTimeoutMs: config.runTimeoutMs ?? 400,
    closeTimeoutMs: config.closeTimeoutMs ?? 200,
    usageGraceMs: 0,
    pollMs: 2,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  return { writes, deps, contexts, emit, state, startedRunId: () => lastRunId };
}

describe('터미널 레인의 한 작업', () => {
  it('CLI가 뜬 뒤 요청을 붙여 넣고, run_started·run_finished를 기다려 결과를 돌려준다', async () => {
    const h = harness();
    const waiting: Array<string | undefined> = [];
    const running = runTerminalTask('s1', 'do it', options({ onWaiting: (note) => waiting.push(note) }), h.deps);

    await until(() => h.writes.length >= 2, '붙여 넣지 않았습니다');
    expect(h.writes[0]).toBe('\x1b[200~do it\x1b[201~');
    expect(h.writes[1]).toBe('\r');

    h.emit({ type: 'run_finished', runId: h.startedRunId(), status: 'done', summary: '끝냈습니다', durationMs: 11, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 } });

    const result = await running;
    expect(result).toEqual({ runId: 'run-1', status: 'done', summary: '끝냈습니다', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 }, durationMs: 11 });
    // 기다리는 안내가 켜졌다가 꺼진다
    expect(waiting[0]).toContain('터미널의 claude가 뜨기를 기다립니다');
    expect(waiting.at(-1)).toBeUndefined();
    // 맥락을 걸고(쓰기 범위·완료 검사) 끝나면 지운다
    expect(h.contexts).toEqual([{ writableScope: ['api/src'], doneTests: [] }, undefined]);
  });

  it('CLI가 늦게 떠도 기다렸다가 진행하고, 기다리는 동안 무엇을 기다리는지 알린다', async () => {
    let checks = 0;
    const h = harness({ alive: () => (checks += 1) > 3 });
    const waiting: Array<string | undefined> = [];
    const running = runTerminalTask('s1', 'do it', options({ onWaiting: (note) => waiting.push(note) }), h.deps);

    await until(() => h.writes.length >= 2, '붙여 넣지 않았습니다');
    // 폴더 신뢰를 사람이 격자에서 고르라고 알린다(상위 폴더 신뢰가 Git 저장소 하위 폴더에는 이어지지 않는다 — 수정 2-2)
    expect(waiting[0]).toContain('터미널의 claude가 뜨기를 기다립니다');
    expect(waiting[0]).toContain('새 세션 폴더마다 claude가 폴더 신뢰를 묻습니다');
    expect(waiting[0]).toContain('Yes, I trust this folder');
    h.emit({ type: 'run_finished', runId: h.startedRunId(), status: 'done', summary: '끝' });
    await running;
    expect(waiting.at(-1)).toBeUndefined();
  });

  it('CLI가 끝내 뜨지 않으면 던진다', async () => {
    const h = harness({ alive: false });
    await expect(runTerminalTask('s1', 'do it', options(), h.deps)).rejects.toThrow('시간 안에 뜨지 않았습니다');
    expect(h.contexts.at(-1)).toBeUndefined();
  });

  it('첫 Enter가 먹지 않으면 한 번 더 보내고, 그래도 run_started가 오면 성공한다', async () => {
    const h = harness({ startOnEnter: 2 });
    const running = runTerminalTask('s1', 'do it', options(), h.deps);

    await until(() => h.writes.filter((data) => data === '\r').length >= 2, '두 번째 Enter를 보내지 않았습니다');
    expect(h.writes).toEqual(['\x1b[200~do it\x1b[201~', '\r', '\r']);
    h.emit({ type: 'run_finished', runId: h.startedRunId(), status: 'done', summary: '끝' });
    await expect(running).resolves.toMatchObject({ status: 'done' });
  });

  it('Enter를 두 번 보내도 실행이 시작되지 않으면 던진다', async () => {
    const h = harness({ startOnEnter: 99 });
    await expect(runTerminalTask('s1', 'do it', options(), h.deps)).rejects.toThrow('요청이 터미널의 claude에 들어가지 않았습니다');
    expect(h.writes.filter((data) => data === '\r')).toHaveLength(2);
  });

  it('run_finished 뒤 늦게 온 run_usage까지 더해 사용량을 만든다(캐시 토큰 포함)', async () => {
    const h = harness();
    const running = runTerminalTask('s1', 'do it', options(), h.deps);
    await until(() => h.writes.length >= 2, '붙여 넣지 않았습니다');

    h.emit({ type: 'run_finished', runId: h.startedRunId(), status: 'done', summary: '끝', usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    h.emit({ type: 'run_usage', runId: h.startedRunId(), model: 'm', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 } });
    h.emit({ type: 'run_usage', runId: h.startedRunId(), model: 'm', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } });

    const result = await running;
    expect(result.usage).toEqual({ inputTokens: 101, outputTokens: 52, cacheReadTokens: 13, cacheWriteTokens: 9 });
  });

  it('붙여 넣는 글의 제어 문자(붙여 넣기 끝 표시 포함)를 지우고 구간 표시를 씌운다', async () => {
    const h = harness();
    const request = 'do\u0000it\x1b[201~ more\u0007';
    const running = runTerminalTask('s1', request, options(), h.deps);
    await until(() => h.writes.length >= 2, '붙여 넣지 않았습니다');

    const body = h.writes[0]!.slice('\x1b[200~'.length, -'\x1b[201~'.length);
    expect(body).not.toContain('\x1b');
    expect(body).toBe('doit[201~ more');

    h.emit({ type: 'run_finished', runId: h.startedRunId(), status: 'done', summary: '끝' });
    await running;
  });

  it('붙여 넣을 글이 제어 문자뿐이면 던진다', async () => {
    const h = harness();
    await expect(runTerminalTask('s1', '\u0000\u0001', options(), h.deps)).rejects.toThrow('붙여 넣을 요청 글이 비어 있습니다');
  });

  it('기다리는 사이 세션이 멈추면 바로 던지고 맥락을 지운다', async () => {
    const h = harness({ alive: false });
    h.deps.status = () => 'stopped';
    await expect(runTerminalTask('s1', 'do it', options(), h.deps)).rejects.toThrow('멈춰 요청을 기다리지 못했습니다');
    expect(h.contexts.at(-1)).toBeUndefined();
  });

  it('완료 검사를 넘겨받으면 세션 맥락에 그대로 싣는다', async () => {
    const h = harness();
    const doneTests: TaskCardDone[] = [{ name: 'done-card-1', service: 'api', command: ['sh', '-c', 'true'] }];
    const running = runTerminalTask('s1', 'do it', options({ doneTests }), h.deps);
    await until(() => h.writes.length >= 2, '붙여 넣지 않았습니다');
    expect(h.contexts[0]).toEqual({ writableScope: ['api/src'], doneTests });

    h.emit({ type: 'run_finished', runId: h.startedRunId(), status: 'done', summary: '끝' });
    await running;
  });

  it('CLI가 알려 온 비용(run_usage.costUsd)을 더해 싣고, 없으면 필드를 두지 않는다', async () => {
    const h = harness();
    const running = runTerminalTask('s1', 'do it', options(), h.deps);
    await until(() => h.writes.length >= 2, '붙여 넣지 않았습니다');
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    h.emit({ type: 'run_finished', runId: h.startedRunId(), status: 'done', summary: '끝' });
    h.emit({ type: 'run_usage', runId: h.startedRunId(), model: 'm', usage, costUsd: 0.02 });
    h.emit({ type: 'run_usage', runId: h.startedRunId(), model: 'm', usage, costUsd: 0.03 });
    expect((await running).costUsd).toBeCloseTo(0.05);

    // 비용을 안 알려 왔으면 필드를 두지 않는다(0으로 채우지 않는다)
    const h2 = harness();
    const running2 = runTerminalTask('s2', 'do it', options(), h2.deps);
    await until(() => h2.writes.length >= 2, '붙여 넣지 않았습니다');
    h2.emit({ type: 'run_finished', runId: h2.startedRunId(), status: 'done', summary: '끝', usage });
    expect((await running2).costUsd).toBeUndefined();
  });
});

describe('비정상 종료 뒤 맥락은 우리 실행의 run_finished 또는 세션 멈춤에서만 지운다 (수정 4·5)', () => {
  /** 던진 오류를 값으로 받아, 처리하지 않은 rejection이 되지 않게 한다 */
  const settle = <T>(promise: Promise<T>): Promise<{ value?: T; error?: Error }> =>
    promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error: error as Error }),
    );

  it('실행 시간 초과면 열린 실행을 취소하고, 실행이 바뀌면 그것도 취소하며, 맥락은 남긴다 (수정 4 (a) 갱신 · 5 (a))', async () => {
    const h = harness({ runTimeoutMs: 60, closeTimeoutMs: 400 });
    const running = settle(runTerminalTask('s1', 'do it', options(), h.deps));

    await until(() => h.state.cancels.length >= 1, '실행을 취소하지 않았습니다');
    expect(h.state.cancels).toEqual(['run-1']);
    expect(h.contexts.at(-1)).toBeDefined();

    // 열린 실행이 다른 id로 바뀌면 닫힘으로 보지 않고 그 실행도 취소한다
    h.state.open = 'run-2';
    await until(() => h.state.cancels.length >= 2, '바뀐 실행을 취소하지 않았습니다');
    expect(h.state.cancels).toEqual(['run-1', 'run-2']);

    // 열린 실행이 없어져도 우리 실행의 run_finished를 받지 않았으므로 맥락은 남는다
    h.state.open = undefined;
    const outcome = await running;
    expect(outcome.error?.message).toContain('끝나지 않았습니다');
    expect(outcome.error?.message).toContain('카드의 쓰기 범위가 그 세션에 남아 있습니다');
    expect(h.contexts.at(-1)).toBeDefined();
  });

  it('취소해도 상한 안에 닫히지 않으면 맥락을 지우지 않고 안내를 덧붙여 던진다 (수정 4 (b))', async () => {
    const h = harness({ runTimeoutMs: 40, closeTimeoutMs: 40 });
    const outcome = await settle(runTerminalTask('s1', 'do it', options(), h.deps));

    expect(h.state.cancels).toEqual(['run-1']);
    expect(outcome.error?.message).toContain('카드의 쓰기 범위가 그 세션에 남아 있습니다');
    // 맥락을 지우지 않았다(setTaskContext(undefined)가 불리지 않았다)
    expect(h.contexts.at(-1)).toBeDefined();
  });

  it('붙여 넣은 뒤 우리 run_started가 오지 않으면 맥락을 남기고, 세션이 멈추면 지운다 (수정 5 (b))', async () => {
    // 남긴다: 붙여 넣은 글이 나중에 들어갈 수 있다
    const h = harness({ startOnEnter: 99 });
    const outcome = await settle(runTerminalTask('s1', 'do it', options(), h.deps));
    expect(outcome.error?.message).toContain('들어가지 않았습니다');
    expect(outcome.error?.message).toContain('붙여 넣은 요청이 나중에 들어갈 수 있어');
    expect(h.contexts.at(-1)).toBeDefined();

    // 세션이 멈추면 지운다
    const h2 = harness({ startOnEnter: 99 });
    const running = settle(runTerminalTask('s2', 'do it', options(), h2.deps));
    await until(() => h2.writes.length >= 2, '붙여 넣지 않았습니다');
    h2.state.status = 'stopped';
    const stopped = await running;
    expect(stopped.error?.message).toContain('멈춰');
    expect(h2.contexts.at(-1)).toBeUndefined();
  });

  it('다른 요청의 run_started가 먼저 와도 무시하고, 우리 실행의 run_finished로 정상 종료한다 (수정 5 (c))', async () => {
    const h = harness({ foreignFirst: true });
    const running = settle(runTerminalTask('s1', 'do it', options(), h.deps));
    await until(() => h.writes.length >= 2, '붙여 넣지 않았습니다');

    h.emit({ type: 'run_finished', runId: h.startedRunId(), status: 'done', summary: '끝', durationMs: 5 });
    const outcome = await running;
    expect(outcome.value).toMatchObject({ runId: 'run-1', status: 'done' });
    // 우리 실행이 끝났으니 맥락을 지웠다
    expect(h.contexts.at(-1)).toBeUndefined();
  });

  it('붙여 넣은 요청이 <pasted_content>로 감싸져 와도 우리 실행으로 잡는다 (수정 5 (d))', async () => {
    const h = harness({ wrap: true });
    const running = settle(runTerminalTask('s1', 'do it', options(), h.deps));
    await until(() => h.writes.length >= 2, '붙여 넣지 않았습니다');

    h.emit({ type: 'run_finished', runId: h.startedRunId(), status: 'done', summary: '끝' });
    const outcome = await running;
    expect(outcome.value).toMatchObject({ runId: 'run-1', status: 'done' });
    expect(h.contexts.at(-1)).toBeUndefined();
  });

  it('붙여 넣기 전에 열린 실행이 있으면 닫히기를 기다렸다가 붙여 넣는다 (수정 5 (e))', async () => {
    const h = harness({ preOpen: 'run-pre', submitTimeoutMs: 300 });
    const running = settle(runTerminalTask('s1', 'do it', options(), h.deps));

    // 앞선 실행이 열려 있는 동안에는 붙여 넣지 않는다
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.writes).toEqual([]);
    expect(h.state.cancels).toEqual([]);

    h.state.open = undefined;
    await until(() => h.writes.length >= 2, '붙여 넣지 않았습니다');
    h.emit({ type: 'run_finished', runId: h.startedRunId(), status: 'done', summary: '끝' });
    const outcome = await running;
    expect(outcome.value).toMatchObject({ status: 'done' });
    expect(h.contexts.at(-1)).toBeUndefined();
  });

  it('붙여 넣기 전에 열린 실행이 상한 안에 닫히지 않으면 붙여 넣지 않고 던지며 맥락을 지운다 (수정 5 (e))', async () => {
    const h = harness({ preOpen: 'run-pre', submitTimeoutMs: 40 });
    await expect(runTerminalTask('s1', 'do it', options(), h.deps)).rejects.toThrow('앞선 실행이 남아 있어');

    expect(h.writes).toEqual([]);
    expect(h.state.cancels).toEqual([]);
    expect(h.contexts.at(-1)).toBeUndefined();
  });
});
