/**
 * 동시 실행(--concurrency N) 오케스트레이터.
 *
 * 이 프로세스는 실행을 직접 돌리지 않는다. run.ts가 하던 일(작업 하나: 과제 하나 · 전략 하나 · 반복 하나)을
 * 스스로(run.ts)를 자식 프로세스로 띄워 시키고, 최대 N개까지 동시에 돈다. 이렇게 하면
 *  - 자식마다 process.env가 따로라 B_STUDIO_SESSIONS_DIR·B_STUDIO_PROJECTS_DIR 같은 전역 환경 변수가 섞이지 않는다
 *    (sessions.ts·task-plans.ts가 이 값을 함수를 부를 때마다 process.env에서 읽어, 같은 프로세스에서 두 실행을
 *    동시에 돌리면 어느 쪽 값이 적용될지 경합이 생긴다 — 자식 프로세스로 쪼개면 이 문제 자체가 없다)
 *  - workRoot(mkdtemp)·프로젝트 복사본·프록시 포트(0으로 열어 OS가 빈 포트를 고른다)가 자식마다 이미 따로다
 *  - 샌드박스 compose 프로젝트 이름(studio-<PROJECT_ID>-<hex>)도 자식마다 B_STUDIO_BENCH_PROJECT_ID로 고유하다
 *
 * 부모는 자식의 결과 폴더(results.jsonl 한 줄)를 읽어 모으고, order로 정렬해 summary.md·meta.json을 하나로 합친다.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Backend, BenchVerify, ContractsSource, EscalationChoice, PlanExecuteChoice, RateLimitPolicy } from './backends';
import type { Args } from './args';
import { handoffChoiceOf, handoffTestFor, unknownHandoff, type HandoffChoice } from './handoff';
import { runPool } from './pool';
import { redact } from './redact';
import { summarize, type BenchRow } from './summary';
import type { BenchTask, LaneBackends, Strategy } from './tasks';
import type { SelfCheckMode, Topology } from '@b-studio/agent';

export interface PlannedUnit {
  /** 계획한 전체 순번(1부터). 직렬 실행이었다면 같은 인자로 record()가 매겼을 order와 같다 */
  order: number;
  repeat: number;
  task: BenchTask;
  strategy: Strategy;
}

/**
 * (반복 × 과제 × 전략)을 직렬 실행의 중첩 루프와 같은 순서로 늘어놓는다(반복마다 전략 순서를 뒤집는 것까지 그대로).
 * order를 같은 인자라면 직렬 실행이 매겼을 값과 같게 하려고 순서를 그대로 흉내 낸다(요청 3: order = 계획한 순서).
 */
export function planUnits(tasks: readonly BenchTask[], strategies: readonly Strategy[], repeats: number): PlannedUnit[] {
  const units: PlannedUnit[] = [];
  let order = 0;
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const ordered = repeat % 2 === 1 ? strategies : [...strategies].reverse();
    for (const task of tasks) {
      for (const strategy of ordered) {
        order += 1;
        units.push({ order, repeat, task, strategy });
      }
    }
  }
  return units;
}

/** order 필드로 오름차순 정렬한 새 배열을 돌려준다(원본은 바꾸지 않는다). 완료 순서와 무관하게 요약을 결정적으로 만든다 */
export function sortByOrder<T extends { order: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.order - b.order);
}

/** 사용 한도에 걸렸거나 남은 컨테이너가 있으면 더 새 작업을 시작하지 않는다(이미 시작한 작업은 끝까지 돈다) */
export function shouldStopDispatch(row: Pick<BenchRow, 'category' | 'leftoverContainers'>): boolean {
  return row.category === 'rate_limited' || row.leftoverContainers.length > 0;
}

/**
 * `Args`를 다시 argv 배열로 만든다(자식 프로세스에 그대로 넘기려고). `--concurrency`는 뺀다 —
 * 자식이 그대로 받으면 자식도 풀을 띄우려 든다. 동시성 표시값은 buildChildArgv가 `--child-concurrency`로 따로 준다.
 */
export function serializeArgv(args: Omit<Args, 'concurrency' | 'childConcurrency' | 'repeatIndex' | 'orderStart'>): string[] {
  const argv: string[] = [];
  if (args.dry) argv.push('--dry');
  if (args.force) argv.push('--force');
  if (args.integrationChecks) argv.push('--integration-checks');
  if (args.verify) argv.push('--verify', args.verify);
  if (args.selfCheck) argv.push('--self-check', args.selfCheck);
  if (args.handoffTests) argv.push('--handoff-tests', args.handoffTests);
  if (args.protectHandoff) argv.push('--protect-handoff');
  if (args.taskIds && args.taskIds.length > 0) argv.push('--tasks', args.taskIds.join(','));
  if (args.strategies && args.strategies.length > 0) argv.push('--strategies', args.strategies.join(','));
  if (args.repeats !== undefined) argv.push('--repeats', String(args.repeats));
  if (args.out) argv.push('--out', args.out);
  if (args.backend) argv.push('--backend', args.backend);
  if (args.model) argv.push('--model', args.model);
  if (args.freeOnly) argv.push('--free-only');
  if (args.onRateLimit) argv.push('--on-rate-limit', args.onRateLimit);
  if (args.rateLimitWaitMinutes !== undefined) argv.push('--rate-limit-wait-minutes', String(args.rateLimitWaitMinutes));
  if (args.contextClearing) argv.push('--context-clearing', args.contextClearing);
  if (args.topology) argv.push('--topology', args.topology);
  if (args.contracts) argv.push('--contracts', args.contracts);
  if (args.escalateTo) argv.push('--escalate-to', args.escalateTo);
  if (args.escalateAfter !== undefined) argv.push('--escalate-after', String(args.escalateAfter));
  if (args.escalateAfterFailures !== undefined) argv.push('--escalate-after-failures', String(args.escalateAfterFailures));
  if (args.escalateRetryBudget !== undefined) argv.push('--escalate-retry-budget', String(args.escalateRetryBudget));
  for (const laneBackend of args.laneBackends ?? []) argv.push('--lane-backend', laneBackend);
  if (args.prices) argv.push('--prices', args.prices);
  if (args.planModel) argv.push('--plan-model', args.planModel);
  if (args.executeModel) argv.push('--execute-model', args.executeModel);
  if (args.planAlways) argv.push('--plan-always');
  return argv;
}

/** 계획한 작업 하나를 맡길 자식 프로세스의 argv. 과제·전략·반복을 그 하나로 좁히고 내부용 표시 인자를 더한다 */
export function buildChildArgv(args: Args, unit: PlannedUnit, childOut: string, concurrency: number, repeats: number): string[] {
  const base = serializeArgv({ ...args, taskIds: [unit.task.id], strategies: [unit.strategy], repeats, out: childOut });
  return [...base, '--repeat-index', String(unit.repeat), '--order-start', String(unit.order - 1), '--child-concurrency', String(concurrency)];
}

/** 자식 프로세스에 줄 고유 환경. 프로젝트 이름(샌드박스·compose 프로젝트 이름의 바탕)만 겹치지 않게 하면 된다 —
 * workRoot·프록시 포트는 자식이 스스로 새로 고른다(run.ts의 기존 로직 그대로) */
export function childEnv(base: NodeJS.ProcessEnv, projectId: string): NodeJS.ProcessEnv {
  return { ...base, B_STUDIO_BENCH_PROJECT_ID: projectId };
}

/** 자식 프로세스가 결과 행을 하나도 남기지 못했을 때(설정 단계에서 죽음 등) 쓸 대체 행. 실험이 그 자리를 잃지 않게 한다 */
export function synthesizeCrashRow(
  unit: PlannedUnit,
  backend: string,
  requestedModel: string,
  escalation: EscalationChoice,
  message: string,
  handoff?: HandoffChoice,
): BenchRow {
  const now = new Date().toISOString();
  return {
    order: unit.order,
    repeat: unit.repeat,
    taskId: unit.task.id,
    coupled: unit.task.coupled,
    strategy: unit.strategy,
    model: requestedModel,
    observedModels: [],
    startedAt: now,
    finishedAt: now,
    planStatus: 'failed',
    lanes: [],
    traces: [],
    explore: { filesReadTotal: 0, filesReadUnionAcrossLanes: 0, readCallsTotal: 0 },
    failures: { signaturesTotal: 0, distinctSignatures: 0, repeatedFailures: 0 },
    contextCleared: { count: 0, chars: 0 },
    integrationChecks: false,
    verify: 'full',
    escalation: {
      after: escalation.after,
      retryBudget: escalation.retryBudget,
      ...(escalation.afterFailures === undefined ? {} : { afterFailures: escalation.afterFailures }),
      ...(escalation.to ? { to: escalation.to } : {}),
      escalated: false,
    },
    success: false,
    category: 'unknown',
    detail: `동시 실행 자식 프로세스가 결과를 남기지 못했습니다(${backend}): ${message}`,
    leftoverContainers: [],
    estimatedCostUsd: 0,
    // 테스트를 건넨 실행이면 조건은 남기고 센 값은 모두 unknown이다. 센 적이 없는 값을 0으로 적지 않는다
    ...(handoff ? { handoff: unknownHandoff(handoff, handoffTestFor(unit.task.id)?.file ?? '') } : {}),
  };
}

export interface RunConcurrentOptions {
  args: Args;
  concurrency: number;
  backend: Backend;
  requestedModel: string;
  tasks: BenchTask[];
  strategies: Strategy[];
  repeats: number;
  outRoot: string;
  dockerMemTotal: string;
  commitAtStart: string;
  contextClearing: boolean;
  contractsSource: ContractsSource;
  verify: BenchVerify;
  planExecute: PlanExecuteChoice;
  escalation: EscalationChoice;
  topology: Topology;
  laneBackends: LaneBackends;
  rateLimit: { policy: RateLimitPolicy; waitMinutes: number };
  integrationChecks: boolean;
  selfCheck: SelfCheckMode;
  /** 요약·JSONL을 쓰기 전에 가릴 값(openai 상류 키 등). 자식은 이미 가려 두므로 부모가 만드는 행(충돌 대체 행)에만 적용한다 */
  secrets: string[];
}

const CHILD_KILL_GRACE_MS = 10_000;

/** 부모 프로세스. 계획한 작업을 최대 concurrency개까지 자식 프로세스로 띄우고 결과를 모은다 */
export async function runConcurrent(options: RunConcurrentOptions): Promise<void> {
  const { args, concurrency, outRoot } = options;
  const startedAt = new Date().toISOString();
  await mkdir(outRoot, { recursive: true });
  const unitsDir = path.join(outRoot, '.units');
  await mkdir(unitsDir, { recursive: true });

  const units = planUnits(options.tasks, options.strategies, options.repeats);
  const resultsPath = path.join(outRoot, 'results.jsonl');
  const rows: BenchRow[] = [];
  const inFlight = new Set<ChildProcess>();
  const controller = new AbortController();
  let abortReason: string | undefined;
  let interrupted = false;

  const sigintHandler = (): void => {
    if (interrupted) return;
    interrupted = true;
    console.error('\nCtrl-C — 새 실행을 더 띄우지 않고, 도는 실행을 취소합니다.');
    controller.abort();
    for (const child of inFlight) child.kill('SIGINT');
    // 자식이 스스로 정리(세션 내리기 등)할 시간을 준 뒤에도 남아 있으면 강제 종료한다
    setTimeout(() => {
      for (const child of inFlight) if (!child.killed) child.kill('SIGKILL');
    }, CHILD_KILL_GRACE_MS).unref();
  };
  process.on('SIGINT', sigintHandler);

  const jobs = units.map((unit) => ({
    run: async (): Promise<BenchRow> => {
      const childOut = path.join(unitsDir, String(unit.order));
      await mkdir(childOut, { recursive: true });
      const projectId = `bench-orders-${unit.order}`;
      const childArgv = buildChildArgv(args, unit, childOut, concurrency, options.repeats);
      console.log(`[${unit.order}] 반복 ${unit.repeat}/${options.repeats} · ${unit.task.id} · ${unit.strategy} (동시 실행, 자식 시작)`);
      const logPath = path.join(childOut, 'child.log');
      const outcome = await spawnChild(childArgv, childEnv(process.env, projectId), logPath, controller.signal, inFlight);
      const row = await readChildRow(childOut, unit, options, outcome, logPath);
      console.log(`    → [${unit.order}] ${row.success ? '성공' : row.category} (계획 ${row.planStatus}${row.detail ? ` · ${row.detail.slice(0, 120)}` : ''})`);
      return row;
    },
  }));

  const poolOutcome = await runPool(jobs, {
    concurrency,
    signal: controller.signal,
    shouldAbort: (row) => shouldStopDispatch(row),
    onSettled: async (row) => {
      rows.push(row);
      const line = redact(JSON.stringify(row), options.secrets);
      await appendFile(resultsPath, `${line}\n`);
      if (shouldStopDispatch(row)) {
        abortReason =
          row.category === 'rate_limited'
            ? options.rateLimit.policy === 'wait'
              ? '다시 시도한 실행도 사용 한도에 걸려 더 새 실행을 띄우지 않습니다.'
              : `사용 한도에 걸려 더 새 실행을 띄우지 않습니다 (--on-rate-limit wait로 기다렸다 다시 시도할 수 있습니다).`
            : `남은 컨테이너가 있어 더 새 실행을 띄우지 않습니다: ${row.leftoverContainers.join(', ')}`;
        console.error(abortReason);
      }
    },
  });

  process.off('SIGINT', sigintHandler);
  if (interrupted) abortReason ??= 'Ctrl-C로 취소했습니다.';
  else if (poolOutcome.aborted && !abortReason) abortReason = '동시 실행이 중단됐습니다.';

  const sortedRows = sortByOrder(rows);
  const observedModels = [...new Set(sortedRows.flatMap((row) => row.observedModels))];
  const finishedAt = new Date().toISOString();

  await writeFile(
    path.join(outRoot, 'summary.md'),
    redact(
      summarize(sortedRows, {
        backend: options.backend,
        requestedModel: options.requestedModel,
        contextClearing: options.contextClearing,
        contracts: options.contractsSource,
        verify: options.verify,
        planModel: options.planExecute.plan,
        executeModel: options.planExecute.execute,
        concurrency,
      }),
      options.secrets,
    ),
  );
  await writeFile(
    path.join(outRoot, 'meta.json'),
    redact(
      JSON.stringify(
        {
          startedAt,
          finishedAt,
          dry: args.dry,
          backend: options.backend,
          requestedModel: options.requestedModel,
          observedModels,
          dockerMemTotal: options.dockerMemTotal,
          gitCommit: options.commitAtStart,
          tasks: options.tasks.map((task) => task.id),
          strategies: options.strategies,
          topology: options.topology,
          laneBackends: Object.fromEntries(options.laneBackends),
          contracts: options.contractsSource,
          escalateTo: options.escalation.to,
          escalateAfter: options.escalation.after,
          escalateAfterFailures: options.escalation.afterFailures,
          escalateRetryBudget: options.escalation.retryBudget,
          planModel: options.planExecute.plan,
          executeModel: options.planExecute.execute,
          pricesPath: args.prices,
          repeats: options.repeats,
          runs: sortedRows.length,
          onRateLimit: options.rateLimit.policy,
          rateLimitWaitMinutes: options.rateLimit.waitMinutes,
          contextClearing: options.contextClearing,
          integrationChecks: options.integrationChecks,
          verify: options.verify,
          selfCheck: options.selfCheck,
          concurrency,
          ...(handoffChoiceOf(args) ? { handoffTests: args.handoffTests, protectHandoff: args.protectHandoff === true } : {}),
          abortReason,
        },
        null,
        2,
      ),
      options.secrets,
    ),
    { mode: 0o600 },
  );

  console.log(`\n결과: ${outRoot}`);
  console.log(`  results.jsonl (${sortedRows.length}줄), summary.md, meta.json · 동시 실행 ${concurrency}`);
  if (abortReason || interrupted) process.exitCode = interrupted ? 130 : 1;
}

/** 자식 프로세스 하나를 띄우고 끝날 때까지 기다린다. signal이 끊기면 자식은 부모의 SIGINT 핸들러가 정리한다(여기서는 기다리기만 한다) */
function spawnChild(
  argv: string[],
  env: NodeJS.ProcessEnv,
  logPath: string,
  signal: AbortSignal,
  inFlight: Set<ChildProcess>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve({ code: null, signal: null });
      return;
    }
    // 자식마다 로그를 파일로 연다(부모 터미널에 N개가 뒤섞이지 않게). child_process는 넘긴 fd를 닫지 않으므로
    // 자식이 끝나면(정상 종료든 오류든) 직접 닫는다 — 안 닫으면 실행이 많을 때 fd가 새어 나간다
    const logFd = openSync(logPath, 'a');
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...argv], { env, stdio: ['ignore', logFd, logFd] });
    inFlight.add(child);
    child.once('error', (error) => {
      inFlight.delete(child);
      closeSync(logFd);
      reject(error);
    });
    child.once('exit', (code, exitSignal) => {
      inFlight.delete(child);
      closeSync(logFd);
      resolve({ code, signal: exitSignal });
    });
  });
}

/**
 * 자식의 결과 폴더에서 이 단위의 최종 행을 읽는다.
 *
 * 자식은 단위 하나(과제 하나 · 전략 하나 · 반복 하나)만 맡지만, 그 안에서 사용 한도 재시도(`--on-rate-limit wait`)가
 * 일어나면 results.jsonl에 두 줄(원래 시도 + 재시도)이 남을 수 있다 — 이때는 **마지막 줄**(최종 결과)을 쓴다.
 * 또한 자식이 내부에서 매긴 order(재시도면 +1씩 늘어난다)는 부모의 전체 계획 순서와 다를 수 있어(다음 단위의 order와 겹칠 수도 있다)
 * 항상 부모가 계획한 unit.order로 덮어써 겹치지 않게 한다. retryOf가 그 결과 자기 자신을 가리키게 되면(같은 값) 지운다.
 */
export async function readChildRow(
  childOut: string,
  unit: PlannedUnit,
  options: RunConcurrentOptions,
  outcome: { code: number | null; signal: NodeJS.Signals | null },
  logPath: string,
): Promise<BenchRow> {
  const resultsFile = path.join(childOut, 'results.jsonl');
  try {
    const text = await readFile(resultsFile, 'utf8');
    const lines = text.split('\n').filter((candidate) => candidate.trim().length > 0);
    const lastLine = lines.at(-1);
    if (lastLine) {
      const row = JSON.parse(lastLine) as BenchRow;
      const normalized: BenchRow = { ...row, order: unit.order };
      if (normalized.retryOf === unit.order) delete normalized.retryOf;
      return normalized;
    }
  } catch {
    // 자식이 results.jsonl을 아예 만들지 못했다(설정 단계에서 죽음 등) — 아래에서 대체 행을 만든다
  }
  const tail = readLogTail(logPath);
  const reason = outcome.signal ? `신호 ${outcome.signal}로 끝났습니다` : `종료 코드 ${outcome.code}`;
  return synthesizeCrashRow(unit, options.backend, options.requestedModel, options.escalation, `${reason}${tail ? ` · ${tail}` : ''}`, handoffChoiceOf(options.args));
}

function readLogTail(logPath: string): string {
  try {
    const text = readFileSync(logPath, 'utf8');
    return text.trim().split('\n').slice(-5).join(' / ').slice(0, 500);
  } catch {
    return '';
  }
}
