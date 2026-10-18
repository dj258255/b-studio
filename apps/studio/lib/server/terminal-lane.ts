import type { AgentUsage, RunMetrics } from '@b-studio/agent';
import type { StudioEvent } from '@/lib/studio-events';
import { terminalPasteText } from '@/lib/terminal';
import { openSessionTerminal, sessionTerminalCliAlive, writeSessionTerminal } from './session-terminal';
import { getSnapshot, sessionHistory, sessionTerminalTarget, setTerminalTaskContext, subscribe } from './sessions';
import type { TaskCardDone } from './task-cards';

/**
 * 작업 카드의 한 작업을 세션 터미널에서 돌린다(#B6a). 카드를 레인으로 묶은 실행기가 이 모듈을 부른다:
 * 세션 터미널을 열고(open은 실행기가 한다) → CLI가 뜨기를 기다리고 → 요청을 붙여 넣고 →
 * 그 실행의 run_finished를 기다린다. 게이트·사용량·한도는 지금의 터미널 실행(sessions.ts) 그대로 적용된다.
 *
 * deps는 테스트가 바꿔 끼우는 자리다(터미널·세션 시계를 가짜로 둔다). 실제 값이 기본이다.
 */
export interface TerminalLaneDriver {
  /** 세션 터미널을 연다(크기 120×32). 이미 열려 있으면 크기만 맞춘다 */
  open(sessionId: string): Promise<void>;
  /** 터미널 안에 CLI가 떠 있는가 */
  cliAlive(sessionId: string): boolean;
  /** 터미널에 키 입력(바이트)을 보낸다 */
  write(sessionId: string, data: string): void;
}

export interface TerminalTaskOptions {
  /** 이 카드가 쓸 수 있는 경로(작업 복사본 기준 상대). 터미널 실행의 쓰기 범위로 건다 */
  writableScope: readonly string[];
  /** 이 카드의 완료 검사. 이 실행 동안만 게이트의 test 단계에 더한다 */
  doneTests: readonly TaskCardDone[];
  /** 지금 무엇을 기다리는지 화면에 알린다(없으면 undefined). CLI를 기다리는 동안만 값이 있다 */
  onWaiting?: (note: string | undefined) => void;
}

export interface TerminalTaskDeps {
  driver: TerminalLaneDriver;
  subscribe: (sessionId: string, listener: (event: StudioEvent) => void) => () => void;
  readEvents: (sessionId: string) => StudioEvent[];
  setTaskContext: (sessionId: string, context: { writableScope: readonly string[]; doneTests: readonly TaskCardDone[] } | undefined) => void;
  /** 세션이 아직 살아 있는가를 알기 위한 상태 읽기 */
  status: (sessionId: string) => string | undefined;
  /** CLI가 뜨기를 기다리는 상한 */
  cliTimeoutMs: number;
  /** 붙여 넣은 요청이 실행으로 이어지기를 기다리는 상한(Enter를 한 번 더 보낸 뒤 이 시간을 또 기다린다) */
  submitTimeoutMs: number;
  /** 그 실행의 run_finished를 기다리는 상한 */
  runTimeoutMs: number;
  /** run_finished 뒤 늦게 오는 텔레메트리를 더 기다리는 시간(#726) */
  usageGraceMs: number;
  /** 기다리는 동안 다시 확인하는 주기 */
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
}

/** 이 모듈 안 기본 driver. 실행기(task-plans)가 터미널을 열 때도 이것을 쓴다 */
export const terminalLaneDriver: TerminalLaneDriver = {
  open: (sessionId) => openSessionTerminal(sessionId, sessionTerminalTarget(sessionId), { cols: 120, rows: 32 }),
  cliAlive: (sessionId) => sessionTerminalCliAlive(sessionId),
  write: (sessionId, data) => writeSessionTerminal(sessionId, data),
};

// 세션 작업 복사본은 Git 저장소라, claude가 새 세션 폴더마다 폴더 신뢰를 묻는다(상위 폴더의 신뢰는 일반 폴더에는
// 이어지지만 Git 저장소인 하위 폴더에는 이어지지 않는다 — claude 2.1.302 실측). b-studio가 신뢰를 대신 골라 주는
// 길은 만들지 않는다. 사람이 격자에서 그 칸을 열어 확인해야 한다
const WAIT_CLI_NOTE =
  '터미널의 claude가 뜨기를 기다립니다. 새 세션 폴더마다 claude가 폴더 신뢰를 묻습니다 — 격자에서 그 칸을 열어 "Yes, I trust this folder"를 고르세요.';

const defaultDeps: TerminalTaskDeps = {
  driver: terminalLaneDriver,
  subscribe,
  readEvents: sessionHistory,
  setTaskContext: setTerminalTaskContext,
  status: (sessionId) => getSnapshot(sessionId)?.status,
  cliTimeoutMs: 10 * 60_000,
  submitTimeoutMs: 30_000,
  runTimeoutMs: 30 * 60_000,
  usageGraceMs: 2_000,
  pollMs: 500,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface TerminalTaskResult {
  runId: string;
  status: string;
  summary: string;
  usage?: AgentUsage;
  metrics?: RunMetrics;
  durationMs?: number;
  /** CLI가 텔레메트리로 알려 온 이 실행의 비용 합(달러). 하나도 없으면 없다(0으로 채우지 않는다) */
  costUsd?: number;
}

/**
 * 카드의 한 작업을 세션 터미널에서 돌린다.
 *  1. 카드 맥락(쓰기 범위·완료 검사)을 세션에 건다 — 게이트와 쓰기 검사가 이 값을 본다
 *  2. CLI가 뜰 때까지 기다린다(폴더 신뢰 확인을 사람이 눌러 줘야 할 수 있다)
 *  3. 이벤트를 구독한 뒤 요청을 붙여 넣는다(bracketed paste + Enter)
 *  4. run_started가 오지 않으면 Enter를 한 번 더 보낸다
 *  5. 그 runId의 run_finished를 기다리고, 늦게 온 텔레메트리까지 더해 사용량을 만든다
 *  6. 끝나면(성공·실패 둘 다) 맥락을 지우고 구독을 푼다
 */
export async function runTerminalTask(
  sessionId: string,
  request: string,
  options: TerminalTaskOptions,
  overrides?: Partial<TerminalTaskDeps>,
): Promise<TerminalTaskResult> {
  const deps: TerminalTaskDeps = { ...defaultDeps, ...overrides };
  deps.setTaskContext(sessionId, { writableScope: options.writableScope, doneTests: options.doneTests });
  let unsubscribe: (() => void) | undefined;
  try {
    // 1·2. CLI가 뜰 때까지 기다린다
    options.onWaiting?.(WAIT_CLI_NOTE);
    await waitForCli(sessionId, deps);
    options.onWaiting?.(undefined);

    const pasted = terminalPasteText(request);
    if (!pasted) throw new Error('붙여 넣을 요청 글이 비어 있습니다');

    // 3. 이벤트를 구독한 뒤 붙여 넣는다. 이미 있던 실행(앞 작업 등)은 건너뛴다
    const box: { started?: Extract<StudioEvent, { type: 'run_started' }>; finished?: Extract<StudioEvent, { type: 'run_finished' }> } = {};
    const usages: Array<{ runId: string; usage: AgentUsage; costUsd?: number }> = [];
    const seen = new Set(deps.readEvents(sessionId).flatMap((event) => (event.type === 'run_started' ? [event.runId] : [])));
    unsubscribe = deps.subscribe(sessionId, (event) => {
      if (event.type === 'run_started' && event.via === 'terminal' && !seen.has(event.runId) && box.started === undefined) box.started = event;
      else if (event.type === 'run_usage') usages.push({ runId: event.runId, usage: event.usage, ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}) });
      else if (event.type === 'run_finished' && box.started !== undefined && event.runId === box.started.runId) box.finished = event;
    });
    deps.driver.write(sessionId, `\x1b[200~${pasted}\x1b[201~`);
    deps.driver.write(sessionId, '\r');

    // 4. 요청이 실행으로 이어졌는가. 안 되면 Enter를 한 번 더 보낸다
    let started = await waitFor(sessionId, deps, deps.submitTimeoutMs, () => box.started);
    if (!started) {
      deps.driver.write(sessionId, '\r');
      started = await waitFor(sessionId, deps, deps.submitTimeoutMs, () => box.started);
    }
    if (!started) throw new Error('요청이 터미널의 claude에 들어가지 않았습니다(입력 줄에 글이 남아 있으면 그 칸에서 Enter를 누르세요)');

    // 5. 그 실행의 끝을 기다린다
    const finished = await waitFor(sessionId, deps, deps.runTimeoutMs, () => box.finished);
    if (!finished) throw new Error(`터미널 실행이 ${Math.round(deps.runTimeoutMs / 60_000)}분 안에 끝나지 않았습니다`);
    await deps.sleep(deps.usageGraceMs);
    const ofRun = usages.filter((entry) => entry.runId === started!.runId);
    const usage = ofRun.length > 0 ? sumUsage(ofRun.map((entry) => entry.usage)) : finished.usage;
    // 비용은 하나라도 알려 온 것이 있을 때만 싣는다(없으면 필드를 두지 않는다 — 0과 모름을 구분한다)
    let costUsd: number | undefined;
    for (const entry of ofRun) if (entry.costUsd !== undefined) costUsd = (costUsd ?? 0) + entry.costUsd;
    return {
      runId: started.runId,
      status: finished.status,
      summary: finished.summary,
      ...(usage ? { usage } : {}),
      ...(finished.metrics ? { metrics: finished.metrics } : {}),
      ...(finished.durationMs !== undefined ? { durationMs: finished.durationMs } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  } finally {
    options.onWaiting?.(undefined);
    deps.setTaskContext(sessionId, undefined);
    unsubscribe?.();
  }
}

async function waitForCli(sessionId: string, deps: TerminalTaskDeps): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (deps.driver.cliAlive(sessionId)) return;
    assertAlive(sessionId, deps);
    if (Date.now() - started > deps.cliTimeoutMs) throw new Error(`${WAIT_CLI_NOTE}\n시간 안에 뜨지 않았습니다`);
    await deps.sleep(deps.pollMs);
  }
}

/** 조건이 참이 될 때까지 기다린다. 상한을 넘으면 undefined. 기다리는 사이 세션이 멈추면 던진다 */
async function waitFor<T>(sessionId: string, deps: TerminalTaskDeps, timeoutMs: number, get: () => T | undefined): Promise<T | undefined> {
  const started = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    assertAlive(sessionId, deps);
    if (Date.now() - started > timeoutMs) return undefined;
    await deps.sleep(deps.pollMs);
  }
}

function assertAlive(sessionId: string, deps: TerminalTaskDeps): void {
  const status = deps.status(sessionId);
  if (status === 'stopped' || status === 'failed') throw new Error(`세션 ${sessionId}이 멈춰 요청을 기다리지 못했습니다 (${status})`);
}

function sumUsage(list: readonly AgentUsage[]): AgentUsage {
  return list.reduce<AgentUsage>(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
}
