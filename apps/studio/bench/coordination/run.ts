/**
 * 협업 벤치마크 실행기.
 *
 * 작업 분해의 두 전략(S0 직렬화 / S1 격리 병렬)을 같은 과제·같은 모델로 반복 실행해 원자료를 남긴다.
 * 운영 코드(apps/studio/lib, packages)는 고치지 않고, e2e처럼 환경 변수를 세운 뒤 서버 내부 함수를 dynamic import로 부른다.
 * 사람 승인 게이트는 그대로 지난다(approveTaskPlan을 직접 부른다). 새 HTTP 라우트나 우회 경로를 만들지 않는다.
 *
 * 백엔드(--backend, --dry가 아니면 필수):
 *   openai      유료 API. BENCH_UPSTREAM_* 환경 변수와 로컬 프록시를 쓴다. --dry는 이 백엔드의 가짜 상류다
 *   claude-code 본인 PC에 로그인된 Claude 구독 CLI. 프록시·상류를 띄우지 않고, 계획도 모델에게 받지 않는다(presetPlan)
 *   codex       본인 PC에 ChatGPT로 로그인된 Codex CLI. claude-code와 같지만 모델은 계정 기본값을 쓸 수 있다
 *   commandcode 본인 PC에 로그인된 Command Code CLI. claude-code와 같지만 모델을 고를 수 있고 무료 모델로 비용 없이 돌릴 수 있다
 *
 *   pnpm bench:coordination --dry
 *   BENCH_UPSTREAM_BASE_URL=... BENCH_UPSTREAM_API_KEY=... BENCH_UPSTREAM_MODEL=... pnpm bench:coordination --backend openai
 *   pnpm bench:coordination --backend claude-code --model sonnet
 *   pnpm bench:coordination --backend codex
 *   pnpm bench:coordination --backend commandcode --model poolside/laguna-s-2.1-free --free-only
 */
import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { runAcceptance, type AcceptanceResult } from './acceptance';
import {
  assertContractsBackend,
  assertContractsStrategy,
  assertPlainBaselineBackend,
  planModelId,
  resolveBackend,
  resolveContextClearing,
  resolveContractsSource,
  resolveEscalation,
  resolveRateLimitPolicy,
  type Backend,
  type ContractsSource,
} from './backends';
import { classify } from './classify';
import { claudeCodeContractAsk } from './contracts';
import { startDryProvider } from './dry-provider';
import { runPlainBaseline, type PlainBaselineResult } from './plain-baseline';
import { startProxy, type ProxyHandle } from './proxy';
import { redact } from './redact';
import { summarize, type BenchEscalation, type BenchLaneRow, type BenchRow } from './summary';
import { BENCH_TASKS, integrationChecksFor, missingCoordinationTools, planFor, STRATEGIES, STRATEGY_LABELS, type BenchTask, type PlannedPlan, type Strategy } from './tasks';
import { loadProject } from '@b-studio/spec';
import { contractAskFromClient, planLanes, requestLaneContracts, type ContractAsk, type LaneContractsResult } from '@b-studio/agent';
import { signatureKey, traceFromEvents, type LaneTrace } from './trace';
import type { AgentUsage, Topology } from '@b-studio/agent';
import { costForUsageByModel, parsePriceTable, type TokenPrices } from '../../lib/token-types';
import type { SessionSnapshot, StudioEvent } from '../../lib/studio-events';
import type { TaskPlanMetrics } from '../../lib/task-plan-metrics';
import type { TaskPlanView } from '../../lib/task-plan-types';

type TaskPlansModule = typeof import('../../lib/server/task-plans');
type SessionsModule = typeof import('../../lib/server/sessions');

const PROJECT_ID = 'bench-orders';
/** openai 백엔드가 모델 레지스트리에 등록하는 id */
const MODEL_ID = 'bench-coordination';
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 40 * 60_000;
/** P0에서 세션(샌드박스)이 준비될 때까지 기다리는 시간 */
const BOOT_TIMEOUT_MS = 20 * 60_000;
const POLL_MS = 2_000;
/** 생성물 폴더. 프로젝트 복사본을 만들 때 뺀다 */
const GENERATED_FILES = /[/\\](node_modules|\.next|build|\.gradle)([/\\]|$)/;

interface Args {
  dry: boolean;
  force: boolean;
  taskIds?: string[];
  strategies?: Strategy[];
  repeats?: number;
  out?: string;
  backend?: string;
  model?: string;
  freeOnly?: boolean;
  onRateLimit?: string;
  rateLimitWaitMinutes?: number;
  /** 컨텍스트 비우기(on|off). 기본 off */
  contextClearing?: string;
  topology?: string;
  /** 통합 게이트에 api 값 확인을 덧붙일지. 기본 꺼짐 */
  integrationChecks?: boolean;
  /** 레인 사이 계약의 출처(human|model). 기본 human. model은 S2에서만 */
  contracts?: string;
  escalateTo?: string;
  escalateAfter?: number;
  /** 모델 이름 일부 → 단가 표 JSON 파일. 모델별 API 환산 비용을 계산한다 */
  prices?: string;
}

/** S3의 읽기 범위. 기본 mesh. 다른 전략에는 영향이 없다 */
function parseTopology(value: string | undefined): Topology {
  if (value === undefined) return 'mesh';
  if (value === 'star' || value === 'hierarchical' || value === 'mesh') return value;
  throw new Error(`전략 topology는 star, hierarchical, mesh 중 하나여야 합니다 (지금 값: ${value})`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dry: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--dry') args.dry = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--integration-checks') args.integrationChecks = true;
    else if (arg === '--tasks') args.taskIds = split(next(argv, index++, '--tasks'));
    else if (arg === '--strategies') args.strategies = split(next(argv, index++, '--strategies')) as Strategy[];
    else if (arg === '--repeats') args.repeats = Number(next(argv, index++, '--repeats'));
    else if (arg === '--out') args.out = next(argv, index++, '--out');
    else if (arg === '--backend') args.backend = next(argv, index++, '--backend');
    else if (arg === '--model') args.model = next(argv, index++, '--model');
    else if (arg === '--free-only') args.freeOnly = true;
    else if (arg === '--on-rate-limit') args.onRateLimit = next(argv, index++, '--on-rate-limit');
    else if (arg === '--rate-limit-wait-minutes') args.rateLimitWaitMinutes = Number(next(argv, index++, '--rate-limit-wait-minutes'));
    else if (arg === '--topology') args.topology = next(argv, index++, '--topology');
    else if (arg === '--contracts') args.contracts = next(argv, index++, '--contracts');
    else if (arg === '--context-clearing') args.contextClearing = next(argv, index++, '--context-clearing');
    else if (arg === '--escalate-to') args.escalateTo = next(argv, index++, '--escalate-to');
    else if (arg === '--escalate-after') args.escalateAfter = Number(next(argv, index++, '--escalate-after'));
    else if (arg === '--prices') args.prices = next(argv, index++, '--prices');
    else if (arg.startsWith('--tasks=')) args.taskIds = split(arg.slice('--tasks='.length));
    else if (arg.startsWith('--strategies=')) args.strategies = split(arg.slice('--strategies='.length)) as Strategy[];
    else if (arg.startsWith('--repeats=')) args.repeats = Number(arg.slice('--repeats='.length));
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else if (arg.startsWith('--backend=')) args.backend = arg.slice('--backend='.length);
    else if (arg.startsWith('--model=')) args.model = arg.slice('--model='.length);
    else if (arg.startsWith('--on-rate-limit=')) args.onRateLimit = arg.slice('--on-rate-limit='.length);
    else if (arg.startsWith('--rate-limit-wait-minutes=')) args.rateLimitWaitMinutes = Number(arg.slice('--rate-limit-wait-minutes='.length));
    else if (arg.startsWith('--topology=')) args.topology = arg.slice('--topology='.length);
    else if (arg.startsWith('--contracts=')) args.contracts = arg.slice('--contracts='.length);
    else if (arg.startsWith('--context-clearing=')) args.contextClearing = arg.slice('--context-clearing='.length);
    else if (arg.startsWith('--escalate-to=')) args.escalateTo = arg.slice('--escalate-to='.length);
    else if (arg.startsWith('--escalate-after=')) args.escalateAfter = Number(arg.slice('--escalate-after='.length));
    else if (arg.startsWith('--prices=')) args.prices = arg.slice('--prices='.length);
    else throw new Error(`알 수 없는 인자입니다: ${arg}`);
  }
  return args;
}

function next(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} 뒤에 값이 필요합니다`);
  return value;
}

function split(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function selectTasks(taskIds: string[] | undefined, dry: boolean): BenchTask[] {
  const ids = dry ? ['orders-list'] : taskIds;
  if (!ids || ids.length === 0) return BENCH_TASKS;
  return ids.map((id) => {
    const task = BENCH_TASKS.find((candidate) => candidate.id === id);
    if (!task) throw new Error(`알 수 없는 과제입니다: ${id} (가능: ${BENCH_TASKS.map((candidate) => candidate.id).join(', ')})`);
    return task;
  });
}

function selectStrategies(strategies: Strategy[] | undefined, dry: boolean): Strategy[] {
  // --dry의 가짜 제공자는 S2~S5의 조율과 P0(로컬 Claude Code)을 모른다. 기준선 S0·S1만 돈다
  const values: Strategy[] | undefined = dry ? ['S0', 'S1'] : strategies;
  if (!values || values.length === 0) return ['S0', 'S1'];
  for (const value of values) if (!STRATEGIES.includes(value)) throw new Error(`전략은 ${STRATEGIES.join(', ')} 중 하나여야 합니다: ${value}`);
  return [...new Set(values)];
}

/** 사전 확인(원칙 5). 다른 프로젝트 컨테이너가 있으면 --force 없이는 종료 코드 2로 멈춘다 */
function preflight(force: boolean): string {
  const ps = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
  if (ps.error || ps.status !== 0) {
    throw new Error(`Docker를 쓸 수 없습니다. Docker Desktop이나 Colima를 먼저 실행하세요 (${ps.error?.message ?? ps.stderr?.trim() ?? `docker ps 종료 코드 ${ps.status}`})`);
  }
  const foreign = ps.stdout.split('\n').map((line) => line.trim()).filter((name) => name && !name.startsWith('studio-'));
  if (foreign.length > 0 && !force) {
    console.error('다른 프로젝트 컨테이너가 떠 있습니다. 메모리를 나눠 쓰면 다른 프로젝트 DB가 OOM으로 죽을 수 있습니다:');
    for (const name of foreign) console.error(`  - ${name}`);
    console.error('계속하려면 --force를 주세요.');
    process.exit(2);
  }
  if (foreign.length > 0) console.warn(`경고: --force로 진행합니다. 다른 컨테이너 ${foreign.length}개가 떠 있습니다.`);

  const info = spawnSync('docker', ['info', '--format', '{{.MemTotal}}'], { encoding: 'utf8' });
  return info.status === 0 ? info.stdout.trim() || '알 수 없음' : '알 수 없음';
}

function gitCommit(): string {
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  return git.status === 0 ? git.stdout.trim() : '알 수 없음';
}

function runningContainers(prefix: string): string[] {
  const ps = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
  if (ps.status !== 0) return [];
  return ps.stdout.split('\n').map((line) => line.trim()).filter((name) => name.startsWith(prefix));
}

function price(name: string): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    console.warn(`경고: ${name}이(가) 없어 0으로 둡니다. 추정 비용이 실제와 다를 수 있습니다.`);
    return 0;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name}은 0 이상의 숫자여야 합니다 (지금 값: ${raw})`);
  return value;
}

/** 단가 파일(모델 이름 일부 → 단가 JSON)을 읽어 검증한다. 값을 코드에 적지 않는다 */
async function loadPriceTable(file: string): Promise<Record<string, TokenPrices>> {
  const resolved = path.resolve(file);
  let text: string;
  try {
    text = await readFile(resolved, 'utf8');
  } catch (error) {
    throw new Error(`단가 파일을 읽지 못했습니다(${resolved}): ${describe(error)}`);
  }
  try {
    return parsePriceTable(JSON.parse(text));
  } catch (error) {
    throw new Error(`단가 파일이 올바르지 않습니다(${resolved}): ${describe(error)}`);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`openai 백엔드에는 ${name} 환경 변수가 필요합니다`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** 사용량을 다른 곳에 더한다 */
function addUsage(target: AgentUsage, source: AgentUsage): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
}

/** --free-only는 commandcode에서만, 무료가 아닌 --model이면 오류다. 모델 목록을 못 불러오면 확인할 수 없어 통과시킨다 */
async function assertFreeOnlyModel(backend: Backend, model: string | undefined): Promise<void> {
  if (backend !== 'commandcode') throw new Error('--free-only는 --backend commandcode에서만 쓸 수 있습니다');
  if (!model) return;
  const { listCommandCodeModels } = await import('@b-studio/agent');
  const models = await listCommandCodeModels().catch(() => []);
  const found = models.find((candidate) => candidate.id === model);
  if (found && !found.free) throw new Error(`--free-only: ${model}은(는) 무료 모델이 아닙니다`);
}

interface RunContext {
  taskPlans: TaskPlansModule;
  sessions: SessionsModule;
  localUser: string;
  backend: Backend;
  /** openai 백엔드에서만 있다 */
  proxy?: ProxyHandle;
  priceInput: number;
  priceOutput: number;
  requestedModel: string;
  planModelId: string;
  /** S3의 읽기 범위. 다른 전략에는 영향이 없다 */
  topology: Topology;
  /** 통합 게이트에 api 값 확인을 덧붙이는지. 행마다 기록한다 */
  integrationChecks: boolean;
  /** 레인 사이 계약의 출처(--contracts). S2에서만 뜻이 있다 */
  contractsSource: ContractsSource;
  /** --escalate-to. 없으면 승격을 설정하지 않은 실행 */
  escalateTo?: string;
  /** --escalate-after */
  escalateAfter: number;
  /** --prices 단가 표(모델 이름 일부 → 단가). 없으면 모델별 API 환산 비용을 계산하지 않는다 */
  prices?: Record<string, TokenPrices>;

  /** 벤치가 만든 프로젝트 복사본. P0는 이 폴더에서 Claude Code를 돌린다 */
  projectDir: string;
  /** P0 실행마다 복사본을 처음 상태로 되돌린다(반복이 서로 영향을 주지 않게) */
  resetProject: () => Promise<void>;
  /** 모델이 쓴 계약 원문을 결과 폴더에 남긴다(나중에 불일치 원인을 보기 위해). 이름은 실행마다 다르다 */
  saveContracts: (name: string, payload: unknown) => Promise<void>;
}

async function runOnce(context: RunContext, task: BenchTask, strategy: Strategy, order: number, repeat: number, activeSessions: Set<string>): Promise<BenchRow> {
  // P0는 작업 분해를 쓰지 않는다. 복사본에서 Claude Code를 돌린 뒤 세션만 띄워 인수 검사한다
  if (strategy === 'P0') return runPlainOnce(context, task, order, repeat, activeSessions);

  const startedAt = new Date().toISOString();
  const { taskPlans, sessions, localUser } = context;
  const planJson = planFor(task, strategy, context.topology);
  // --integration-checks일 때만 엮인 과제의 통합 게이트에 확인을 더한다(독립 과제는 없다)
  const integrationChecks = context.integrationChecks ? integrationChecksFor(task) : undefined;
  // 계약의 출처. S2에서만 뜻이 있다(다른 전략은 계약을 쓰지 않는다)
  let contracts: BenchRow['contracts'] =
    strategy === 'S2' ? { source: context.contractsSource, count: planJson.coordination?.contracts?.length ?? 0 } : undefined;
  let coordination = planJson.coordination;
  let plan: TaskPlanView = { id: '', owner: localUser, projectId: PROJECT_ID, request: '', modelId: context.planModelId, status: 'failed', createdAt: startedAt, lanes: [] };
  let planId: string | undefined;
  let acceptance: AcceptanceResult[] | undefined;
  let harnessError: string | undefined;

  try {
    // openai 백엔드는 프록시가 계획 요청에 이 JSON을 돌려준다. 로컬 CLI 백엔드는 계획을 서버 안에서 넘긴다
    if (context.backend === 'openai' && context.proxy) context.proxy.setPlan(planJson);
    // 모델 계약: 고정 계획은 그대로 두고 계약만 계획 모델에게 받아 coordination.contracts로 넘긴다.
    // 실패하면 계약 없이 돌리지 않고 이 실행을 실패로 남긴다(계약 없이 돌면 S1을 S2라고 적는 셈이다)
    if (strategy === 'S2' && context.contractsSource === 'model') {
      const asked = await askModelContracts(context, task, planJson, `${task.id}-r${repeat}-${order}`);
      contracts = { source: 'model', count: asked.contracts.length, usage: asked.usage, durationMs: asked.durationMs };
      coordination = { ...planJson.coordination!, contracts: asked.contracts };
    }
    const created = await taskPlans.createTaskPlan({
      projectId: PROJECT_ID,
      request: task.request,
      modelId: context.planModelId,
      owner: localUser,
      ...(context.backend === 'openai' ? {} : { presetPlan: planJson }),
      // S2~S5의 조율 설정은 서버 안에서만 넘긴다. S0·S1은 없다
      ...(coordination ? { coordination } : {}),
      // 통합 게이트 전용 확인도 서버 안에서만 넘긴다(--integration-checks)
      ...(integrationChecks ? { integrationChecks } : {}),
    });
    planId = created.id;
    plan = await waitForPlan(taskPlans, created.id, localUser, ['awaiting_approval', 'failed'], APPROVAL_TIMEOUT_MS, '계획이 승인 대기에 이르지 않았습니다', activeSessions);
    if (plan.status === 'awaiting_approval') {
      taskPlans.approveTaskPlan(created.id, localUser);
      plan = await waitForPlan(taskPlans, created.id, localUser, ['done', 'failed'], RUN_TIMEOUT_MS, '작업 분해가 끝나지 않았습니다', activeSessions);
    }

    const integrationId = plan.integration?.sessionId;
    if (plan.status === 'done' && integrationId) {
      const snapshot = sessions.getSnapshot(integrationId);
      const urls = { api: serviceUrl(snapshot, 'api'), web: serviceUrl(snapshot, 'web') };
      acceptance = await runAcceptance(task.acceptance, urls);
    }
  } catch (error) {
    harnessError = describe(error);
    if (planId) {
      try {
        plan = taskPlans.getTaskPlan(planId, localUser);
      } catch {
        // 계획을 다시 읽지 못하면 마지막으로 본 상태를 그대로 쓴다
      }
    }
  }

  const laneSessionIds = plan.lanes.flatMap((lane) => (lane.sessionId ? [lane.sessionId] : []));
  const integrationSessionId = plan.integration?.sessionId;
  const sessionIds = [...laneSessionIds, ...(integrationSessionId ? [integrationSessionId] : [])];
  // 세션을 내리기 전에 기록에서 실제로 쓴 모델 이름과 탐색·실패 흔적을 읽는다. 읽기 실패는 실행 결과를 바꾸지 않는다
  const observedModels = readObservedModels(sessions, sessionIds);
  const sessionEvents = readSessionEvents(sessions, sessionIds);
  // 승격은 세션 기록의 model_escalated 이벤트로 확인한다. 설정하지 않았으면 escalated=false
  const escalation = readEscalation(sessionEvents, context.escalateTo, context.escalateAfter);
  // trace 계산이 실패해도 실행 결과(성공·분류)는 바뀌지 않게, 그 세션의 trace만 생략하고 경고를 남긴다
  const traces: LaneTrace[] = [];
  for (const id of laneSessionIds) {
    const events = sessionEvents.get(id);
    if (!events) continue;
    try {
      traces.push(traceFromEvents(id, events));
    } catch (error) {
      console.warn(`세션 ${id}의 탐색·실패 기록을 계산하지 못했습니다: ${describe(error)}`);
    }
  }
  const integrationEvents = integrationSessionId ? sessionEvents.get(integrationSessionId) : undefined;
  let integrationTrace: LaneTrace | undefined;
  if (integrationSessionId && integrationEvents) {
    try {
      integrationTrace = traceFromEvents(integrationSessionId, integrationEvents);
    } catch (error) {
      console.warn(`세션 ${integrationSessionId}의 탐색·실패 기록을 계산하지 못했습니다: ${describe(error)}`);
    }
  }

  const explore = { filesReadTotal: 0, filesReadUnionAcrossLanes: 0, readCallsTotal: 0 };
  const failures = { signaturesTotal: 0, distinctSignatures: 0, repeatedFailures: 0 };
  try {
    // 탐색 합계는 레인만 센다. 통합 세션은 모델 없이 스크립트 턴으로 돌아 탐색이 아니다
    const failureSignatures = [...traces.flatMap((trace) => trace.failureSignatures), ...(integrationTrace?.failureSignatures ?? [])];
    explore.filesReadTotal = traces.reduce((sum, trace) => sum + trace.filesRead.length, 0);
    explore.filesReadUnionAcrossLanes = new Set(traces.flatMap((trace) => trace.filesRead)).size;
    explore.readCallsTotal = traces.reduce((sum, trace) => sum + (trace.toolCalls.read_file ?? 0), 0);
    failures.signaturesTotal = failureSignatures.length;
    failures.distinctSignatures = new Set(failureSignatures.map(signatureKey)).size;
    failures.repeatedFailures = traces.reduce((sum, trace) => sum + trace.repeatedFailures, 0) + (integrationTrace?.repeatedFailures ?? 0);
  } catch (error) {
    console.warn(`탐색·실패 합계를 계산하지 못했습니다: ${describe(error)}`);
  }

  // 오래된 도구 결과를 비운 합계. 세션 기록의 context_cleared 이벤트를 센다(레인·통합 모두).
  // --context-clearing off(기본)면 이벤트가 없어 0이다
  const contextCleared = { count: 0, chars: 0 };
  for (const events of sessionEvents.values()) {
    for (const event of events) {
      if (event.type !== 'agent' || event.event.type !== 'context_cleared') continue;
      contextCleared.count += event.event.clearedCount;
      contextCleared.chars += event.event.clearedChars;
    }
  }

  // 세션을 모두 내린다. 실패·시간 초과로 끝났어도 남기지 않는다.
  // stopSession이 실패하면 activeSessions에 남겨, 남은 컨테이너가 있을 때 다시 시도한다
  for (const id of sessionIds) {
    try {
      await sessions.stopSession(id);
      activeSessions.delete(id);
    } catch (error) {
      console.warn(`세션 ${id}을 내리지 못했습니다: ${describe(error)}`);
    }
  }

  let leftoverContainers = runningContainers(`studio-${PROJECT_ID}-`);
  if (leftoverContainers.length > 0) {
    // 남은 컨테이너가 있으면 못 내린 세션을 한 번 더 시도하고 다시 확인한다
    for (const id of [...activeSessions]) {
      try {
        await sessions.stopSession(id);
        activeSessions.delete(id);
      } catch (error) {
        console.warn(`세션 ${id}을 다시 내리지 못했습니다: ${describe(error)}`);
      }
    }
    leftoverContainers = runningContainers(`studio-${PROJECT_ID}-`);
  }
  const success = !harnessError && plan.status === 'done' && Boolean(acceptance) && acceptance!.every((result) => result.ok);
  const classification = classify(plan, acceptance, harnessError);
  const proxyStats = context.proxy?.takeStats();
  const metrics = plan.metrics;
  const estimatedCostUsd =
    (context.priceInput * ((metrics?.usage.inputTokens ?? 0) + (metrics?.usage.cacheReadTokens ?? 0) + (metrics?.usage.cacheWriteTokens ?? 0)) +
      context.priceOutput * (metrics?.usage.outputTokens ?? 0)) /
    1_000_000;

  // 모델별 API 환산 비용. 계획 호출(P0)도 같은 방식으로 그 모델(openai는 상류 모델)의 사용량에 더한다
  const usageByModel: Record<string, AgentUsage> = {};
  for (const [model, usage] of Object.entries(metrics?.usageByModel ?? {})) usageByModel[model] = { ...usage };
  if (plan.planning && context.backend === 'openai') addUsage((usageByModel[context.requestedModel] ??= emptyUsage()), plan.planning.usage);
  const cost = context.prices ? costForUsageByModel(usageByModel, context.prices) : {};

  return {
    order,
    repeat,
    taskId: task.id,
    coupled: task.coupled,
    strategy,
    integrationChecks: context.integrationChecks,
    model: context.requestedModel,
    observedModels,
    startedAt,
    finishedAt: new Date().toISOString(),
    planId,
    planStatus: plan.status,
    planError: plan.error,
    lanes: plan.lanes.map(
      (lane): BenchLaneRow => ({
        id: lane.id,
        sessionId: lane.sessionId,
        status: lane.status,
        bootMs: lane.bootMs,
        error: lane.error,
        tasks: lane.tasks.map((item) => ({ id: item.id, status: item.status, run: item.run })),
      }),
    ),
    integration: plan.integration
      ? {
          status: plan.integration.status,
          bootMs: plan.integration.bootMs,
          run: plan.integration.run,
          error: plan.integration.error,
          // S4 수리 여부. 전에는 행에 옮기지 않아 E4 첫 묶음에서 수리 4회가 요약에 보이지 않았다(통합 세션 도구 기록으로 되찾음)
          ...(plan.integration.repair ? { repair: { attempted: plan.integration.repair.attempted, status: plan.integration.repair.status } } : {}),
        }
      : undefined,
    traces,
    integrationTrace,
    explore,
    failures,
    contextCleared,
    escalation,
    metrics,
    coordination: plan.metrics?.coordination,
    contracts,
    acceptance,
    success,
    category: classification.category,
    detail: classification.detail,
    proxy: proxyStats,
    leftoverContainers,
    estimatedCostUsd,
    ...(cost.costUsd !== undefined ? { costUsd: cost.costUsd } : {}),
    ...(cost.costNote ? { costNote: cost.costNote } : {}),
  };
}

/**
 * 고정 계획의 레인으로 계약을 받아 온다(--contracts model). 제품(studio)과 같은 함수·프롬프트를 쓴다.
 * 원문은 결과 폴더에 남긴다(요약·JSONL에는 수치만 넣는다 — 나중에 불일치 원인을 보려고).
 * 실패(형식 오류·사용 한도·연결 실패)는 삼키지 않는다: 계약 없이 돌리면 그 행은 S1을 S2라고 적는 것이 된다.
 */
async function askModelContracts(context: RunContext, task: BenchTask, planJson: PlannedPlan, name: string): Promise<LaneContractsResult> {
  const lanes = planLanes(planJson);
  const project = await loadProject(context.projectDir);
  const asked = await requestLaneContracts(await contractAskFor(context), project, task.request, lanes);
  await context.saveContracts(name, {
    taskId: task.id,
    strategy: 'S2',
    source: 'model',
    model: context.requestedModel,
    lanes: lanes.map((lane) => lane.id),
    contracts: asked.contracts,
    usage: asked.usage,
    durationMs: asked.durationMs,
  });
  return asked;
}

/** 백엔드별 계약 호출. openai는 실행기와 같은 ModelClient 경로(프록시 경유), claude-code는 SDK 한 번 호출 */
async function contractAskFor(context: RunContext): Promise<ContractAsk> {
  if (context.backend === 'openai') {
    const { clientForModel, modelById } = await import('../../lib/server/model-registry');
    return contractAskFromClient(clientForModel(modelById(MODEL_ID)));
  }
  if (context.backend === 'claude-code') return claudeCodeContractAsk({ cwd: context.projectDir, model: context.requestedModel });
  // 시작 전에 막히지만(assertContractsBackend), 여기서도 조용히 다른 경로로 가지 않는다
  throw new Error(`--contracts model은 --backend openai 또는 claude-code에서만 쓸 수 있습니다 (지금 백엔드: ${context.backend})`);
}

/**
 * P0 기준선 실행. 다른 전략과 달리 작업 계획을 만들지 않는다.
 * ① 새 프로젝트 복사본 → ② `runPlainBaseline`(Claude Code가 과제 전체를 직접 고침) →
 * ③ 그 복사본으로 세션만 만들어 샌드박스를 띄우고(에이전트 요청 없음) 서비스가 준비되면 `runAcceptance`로 인수 검사 →
 * ④ 세션·샌드박스를 다른 전략과 같은 경로로 정리(남은 컨테이너 검사 포함).
 * 세션을 띄우는 방법은 작업 분해를 만들기 전 경로(스튜디오 서버의 createSession)를 그대로 따른다.
 */
async function runPlainOnce(context: RunContext, task: BenchTask, order: number, repeat: number, activeSessions: Set<string>): Promise<BenchRow> {
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const { sessions, localUser } = context;
  let baseline: PlainBaselineResult | undefined;
  let acceptance: AcceptanceResult[] | undefined;
  let harnessError: string | undefined;
  let bootMs: number | undefined;
  let bootRxBytes: number | undefined;
  let sessionId: string | undefined;

  try {
    // ① 복사본을 처음 상태로 되돌린다(반복이 서로 영향을 주지 않게). 스튜디오가 프로젝트로 알아보는 폴더다
    await context.resetProject();
    // ② Claude Code가 복사본을 직접 고친다. Bash가 없어 스스로 실행해 확인하지는 못한다
    baseline = await runPlainBaseline({ projectDir: context.projectDir, task, model: context.requestedModel });
    // ③ 작업 분해 없이 세션만 만들어 샌드박스를 띄운다(에이전트 요청은 보내지 않는다)
    const bootStarted = performance.now();
    const created = await sessions.createSession(PROJECT_ID, localUser);
    sessionId = created.id;
    activeSessions.add(sessionId);
    const snapshot = await waitForSession(sessions, sessionId, ['ready', 'failed', 'stopped'], BOOT_TIMEOUT_MS, '샌드박스가 준비되지 않았습니다');
    bootMs = Math.round(performance.now() - bootStarted);
    // 기동 중 받은 바이트(#94). 다른 전략의 기동 수신 열과 같은 기준으로 비교한다
    bootRxBytes = (snapshot.bootNetwork ?? []).reduce((sum, entry) => sum + entry.rxBytes, 0);
    if (snapshot.status === 'ready') {
      acceptance = await runAcceptance(task.acceptance, { api: serviceUrl(snapshot, 'api'), web: serviceUrl(snapshot, 'web') });
    } else {
      harnessError = snapshot.error ?? `샌드박스 상태 ${snapshot.status}`;
    }
  } catch (error) {
    harnessError = describe(error);
  }

  // ④ 세션을 내리고, 못 내리면 남은 컨테이너를 다시 확인한다(다른 전략과 같은 정리 경로)
  if (sessionId) await closeSession(sessions, sessionId, activeSessions);
  let leftoverContainers = runningContainers(`studio-${PROJECT_ID}-`);
  if (leftoverContainers.length > 0) {
    for (const id of [...activeSessions]) await closeSession(sessions, id, activeSessions);
    leftoverContainers = runningContainers(`studio-${PROJECT_ID}-`);
  }
  // ⑤ 복사본을 다시 처음 상태로 되돌린다. P0는 복사본을 직접 고치므로, 되돌리지 않으면 뒤따르는 다른 전략의 세션이
  // 이미 구현된 프로젝트에서 시작한다(E3 첫 묶음에서 S0가 "바꾼 파일 없음"으로 실패한 원인). 실패하면 이 행을 오류로 남긴다
  try {
    await context.resetProject();
  } catch (error) {
    harnessError ??= `프로젝트 복사본을 되돌리지 못했습니다: ${describe(error)}`;
  }

  const plan = plainPlan(context, task, startedAt, baseline);
  const classification = classify(plan, acceptance, harnessError);
  const usage = baseline?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const metrics: TaskPlanMetrics = {
    endToEndMs: Math.round(performance.now() - startedMs),
    usage,
    modelCalls: baseline?.modelCalls ?? 0,
    maxContextTokens: baseline?.maxContextTokens ?? 0,
    bootMsTotal: bootMs ?? 0,
    bootMsMax: bootMs ?? 0,
    bootRxBytesTotal: bootRxBytes ?? 0,
    modelMs: 0,
    toolMs: 0,
    gateMs: 0,
    sessions: sessionId ? 1 : 0,
    ...(baseline && Object.keys(baseline.usageByModel).length > 0 ? { usageByModel: baseline.usageByModel } : {}),
  };
  // P0도 S0와 같은 규칙으로 모델별 단가를 곱한다(비교할 두 행의 비용 계산이 달라지면 안 된다)
  const cost = context.prices ? costForUsageByModel(metrics.usageByModel ?? {}, context.prices) : {};
  const success = !harnessError && baseline?.status === 'done' && Boolean(acceptance) && acceptance!.every((result) => result.ok);
  const estimatedCostUsd =
    (context.priceInput * (usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) + context.priceOutput * usage.outputTokens) / 1_000_000;

  return {
    order,
    repeat,
    taskId: task.id,
    coupled: task.coupled,
    strategy: 'P0',
    integrationChecks: context.integrationChecks,
    model: context.requestedModel,
    observedModels: baseline ? Object.keys(baseline.usageByModel).sort() : [],
    startedAt,
    finishedAt: new Date().toISOString(),
    planStatus: plan.status,
    lanes: [],
    traces: [],
    explore: { filesReadTotal: 0, filesReadUnionAcrossLanes: 0, readCallsTotal: 0 },
    failures: { signaturesTotal: 0, distinctSignatures: 0, repeatedFailures: 0 },
    // P0는 b-studio 러너를 쓰지 않으므로 오래된 도구 결과 비우기와 무관하다
    contextCleared: { count: 0, chars: 0 },
    // P0는 b-studio 게이트가 없어 승격 판정이 일어나지 않는다. 설정값만 남기고 승격은 없음으로 적는다
    escalation: { after: context.escalateAfter, escalated: false },
    metrics,
    acceptance,
    success,
    category: classification.category,
    detail: classification.detail,
    leftoverContainers,
    estimatedCostUsd,
    ...(cost.costUsd !== undefined ? { costUsd: cost.costUsd } : {}),
    ...(cost.costNote ? { costNote: cost.costNote } : {}),
  };
}

/** P0의 분류용 최소 계획. TaskPlanView가 없어 classify에 넘길 모양만 만든다 */
function plainPlan(context: RunContext, task: BenchTask, startedAt: string, baseline: PlainBaselineResult | undefined): TaskPlanView {
  const done = baseline?.status === 'done';
  return {
    id: '',
    owner: context.localUser,
    projectId: PROJECT_ID,
    request: task.request,
    modelId: context.planModelId,
    status: done ? 'done' : 'failed',
    createdAt: startedAt,
    // 승인 개념이 없다. 실패를 plan_rejected로 잘못 분류하지 않도록 승인 시각을 채운다
    ...(done ? {} : { approvedAt: startedAt }),
    ...(baseline && baseline.status !== 'done' ? { error: baseline.summary || '기준선 실행이 실패했습니다' } : {}),
    lanes: [],
  };
}

async function waitForSession(sessions: SessionsModule, id: string, statuses: string[], timeoutMs: number, message: string): Promise<SessionSnapshot> {
  const started = Date.now();
  for (;;) {
    const snapshot = sessions.getSnapshot(id);
    if (!snapshot) throw new Error(`세션 ${id}을(를) 찾을 수 없습니다`);
    if (statuses.includes(snapshot.status)) return snapshot;
    if (Date.now() - started > timeoutMs) throw new Error(`시간 초과: ${message}`);
    await delay(POLL_MS);
  }
}

/** 세션 하나를 내린다. 실패해도 멈추지 않고 activeSessions에 남겨 남은 컨테이너 검사에서 다시 시도한다 */
async function closeSession(sessions: SessionsModule, id: string, activeSessions: Set<string>): Promise<void> {
  try {
    await sessions.stopSession(id);
    activeSessions.delete(id);
  } catch (error) {
    console.warn(`세션 ${id}을 내리지 못했습니다: ${describe(error)}`);
  }
}

/**
 * 세션 기록을 다시 보내 주는 subscribe를 등록→즉시 해제해 실제로 쓴 모델 이름을 읽는다.
 * 모델은 `{ type: 'agent', event: { type: 'session', model } }` 이벤트에 있다. 실패는 빈 배열로 둔다.
 */
function readObservedModels(sessions: SessionsModule, sessionIds: string[]): string[] {
  const models = new Set<string>();
  for (const id of sessionIds) {
    try {
      const unsubscribe = sessions.subscribe(id, (event) => {
        if (event.type === 'agent' && event.event.type === 'session') models.add(event.event.model);
      });
      unsubscribe();
    } catch {
      // 없는 세션이거나 기록을 읽지 못하면 넘어간다
    }
  }
  return [...models];
}

/** 세션 기록에서 승격 이벤트를 찾는다. 승격은 한 실행에 한 번이므로 첫 이벤트만 본다 */
function readEscalation(eventsBySession: Map<string, StudioEvent[]>, to: string | undefined, after: number): BenchEscalation {
  const result: BenchEscalation = { ...(to ? { to } : {}), after, escalated: false };
  if (!to) return result;
  for (const events of eventsBySession.values()) {
    for (const event of events) {
      if (event.type === 'agent' && event.event.type === 'model_escalated') return { ...result, escalated: true, attempt: event.event.attempt };
    }
  }
  return result;
}

/** 세션 기록을 통째로 다시 받아 온다. 읽기 실패는 빈 결과로 두고 실행을 막지 않는다 */
function readSessionEvents(sessions: SessionsModule, sessionIds: string[]): Map<string, StudioEvent[]> {
  const collected = new Map<string, StudioEvent[]>();
  for (const id of sessionIds) {
    try {
      const events: StudioEvent[] = [];
      const unsubscribe = sessions.subscribe(id, (event) => events.push(event));
      unsubscribe();
      collected.set(id, events);
    } catch {
      // 없는 세션이거나 기록을 읽지 못하면 그 세션의 trace를 생략한다
    }
  }
  return collected;
}

async function waitForPlan(
  taskPlans: TaskPlansModule,
  id: string,
  owner: string,
  statuses: string[],
  timeoutMs: number,
  message: string,
  activeSessions: Set<string>,
): Promise<TaskPlanView> {
  const started = Date.now();
  for (;;) {
    const plan = taskPlans.getTaskPlan(id, owner);
    // 진행 중인 세션을 기록해 두면 Ctrl+C·예외 때 모두 내릴 수 있다
    for (const lane of plan.lanes) if (lane.sessionId) activeSessions.add(lane.sessionId);
    if (plan.integration?.sessionId) activeSessions.add(plan.integration.sessionId);
    if (statuses.includes(plan.status)) return plan;
    if (Date.now() - started > timeoutMs) throw new Error(`시간 초과: ${message}`);
    await delay(POLL_MS);
  }
}

function serviceUrl(snapshot: { services: Array<{ name: string; url?: string }> } | undefined, name: string): string | undefined {
  return snapshot?.services.find((service) => service.name === name)?.url;
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // 백엔드와 사용 한도 정책은 Docker를 건드리기 전에 확정한다(모델 경로를 조용히 고르지 않는다)
  const choice = resolveBackend({ dry: args.dry, backend: args.backend, model: args.model });
  const backend = choice.backend;
  if (args.freeOnly) await assertFreeOnlyModel(backend, choice.model);
  const rateLimit = resolveRateLimitPolicy(args.onRateLimit, args.rateLimitWaitMinutes);
  // 오래된 도구 결과 비우기. 기본은 끔이고, API 루프(openai)에서만 뜻이 있다 — 로컬 CLI는 각자 자체 압축을 한다
  const contextClearing = resolveContextClearing(args.contextClearing);
  if (contextClearing && backend !== 'openai') throw new Error('--context-clearing은 --backend openai(API 루프)에서만 쓸 수 있습니다. 로컬 CLI 러너는 대화를 직접 다루지 않습니다');
  // 승격 설정도 시작 전에 확정한다. claude-code가 아니면 --escalate-to는 여기서 오류를 낸다
  const escalation = resolveEscalation({ backend, escalateTo: args.escalateTo, escalateAfter: args.escalateAfter });
  // 단가 표도 시작 전에 읽는다. 값은 파일로만 받고 코드에 적지 않는다(잘못된 파일이면 Docker를 건드리기 전에 멈춘다)
  const prices = args.prices ? await loadPriceTable(args.prices) : undefined;
  const dry = args.dry;
  const repeats = args.repeats ?? (dry ? 1 : 3);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error(`--repeats는 1 이상의 정수여야 합니다 (지금 값: ${args.repeats})`);
  const tasks = selectTasks(args.taskIds, dry);
  const strategies = selectStrategies(args.strategies, dry);
  const topology = parseTopology(args.topology);
  // P0는 로컬 Claude Code 전용이다. Docker·모델을 건드리기 전에 백엔드를 확인한다
  assertPlainBaselineBackend(backend, strategies);
  // 계약 출처도 시작 전에 확정한다. model 계약을 계약을 쓰지 않는 전략과 함께 돌리면 무엇을 잰 것인지 알 수 없다
  const contractsSource = resolveContractsSource(args.contracts);
  assertContractsStrategy(contractsSource, strategies);
  assertContractsBackend(contractsSource, backend);

  // 1. 사전 확인 — 다른 프로젝트 컨테이너가 있으면 여기서 멈춘다
  const dockerMemTotal = preflight(args.force);

  // 2. 백엔드별 준비
  const requestedModel = backend === 'claude-code' ? choice.model! : backend === 'codex' || backend === 'commandcode' ? choice.model ?? 'default' : dry ? 'dry' : requiredEnv('BENCH_UPSTREAM_MODEL');
  const priceInput = price('BENCH_PRICE_INPUT_PER_M');
  const priceOutput = price('BENCH_PRICE_OUTPUT_PER_M');

  let proxy: ProxyHandle | undefined;
  let upstream: { baseUrl: string; close(): Promise<void> } | undefined;
  let secrets: string[] = [];
  if (backend === 'openai') {
    const upstreamApiKey = dry ? 'dry' : requiredEnv('BENCH_UPSTREAM_API_KEY');
    upstream = dry ? await startDryProvider() : { baseUrl: requiredEnv('BENCH_UPSTREAM_BASE_URL'), close: async () => {} };
    proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl, upstreamApiKey });
    secrets = dry ? [] : [upstreamApiKey].filter((value) => value.length >= 8);
  }

  const outRoot = args.out ? path.resolve(args.out) : path.join(homedir(), '.cache/b-studio/bench/coordination', timestamp());
  await mkdir(outRoot, { recursive: true });
  const workRoot = await mkdtemp(path.join(homedir(), '.cache/b-studio/bench-work-'));
  const activeSessions = new Set<string>();
  const startedAt = new Date().toISOString();
  // 실행 중에 작업 트리가 바뀌어도(병합·pull) 이미 올라간 코드는 시작 시점의 것이다. 그래서 커밋은 시작할 때 읽는다
  const commitAtStart = gitCommit();

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    const { stopSession } = await import('../../lib/server/sessions');
    for (const id of activeSessions) await stopSession(id).catch(() => {});
    activeSessions.clear();
    await proxy?.close().catch(() => {});
    await upstream?.close().catch(() => {});
    await rm(workRoot, { recursive: true, force: true }).catch(() => {});
  };
  process.on('SIGINT', () => {
    void cleanup().finally(() => process.exit(130));
  });

  const rows: BenchRow[] = [];
  let abortReason: string | undefined;

  try {
    // 3. 임시 루트에 프로젝트 복사와 환경 변수 준비 (e2e와 같은 방식)
    const projectsDir = path.join(workRoot, 'projects');
    const projectDir = path.join(projectsDir, PROJECT_ID);
    const examplesDir = path.resolve(import.meta.dirname, '../../../../examples/orders');
    // P0는 실행마다 이 복사본을 처음 상태로 되돌려 Claude Code가 과제를 직접 고치게 한다
    const resetProject = async (): Promise<void> => {
      await rm(projectDir, { recursive: true, force: true });
      await cp(examplesDir, projectDir, { recursive: true, filter: (source) => !GENERATED_FILES.test(source) });
      const specFile = path.join(projectDir, 'studio.yaml');
      await writeFile(specFile, (await readFile(specFile, 'utf8')).replace(/^name: orders$/m, `name: ${PROJECT_ID}`));
    };
    await resetProject();
    // 조율 도구가 허용 목록에 없으면 S2·S3·S5가 S1과 같아진다. 결과를 모으기 전에 멈춘다
    const allowedTools = (await loadProject(projectDir)).spec.workflow?.allowedTools;
    const missing = strategies.flatMap((strategy) => missingCoordinationTools(strategy, allowedTools).map((name) => `${strategy}: ${name}`));
    if (missing.length > 0) {
      throw new Error(`조율 도구가 프로젝트 허용 목록(workflow.allowedTools)에 없어 전략이 동작하지 않습니다: ${missing.join(', ')}`);
    }

    await mkdir(path.join(workRoot, 'sessions'), { recursive: true });
    const benchEnv: Record<string, string> = {
      B_STUDIO_AUTH: 'none',
      B_STUDIO_PROJECTS_DIR: projectsDir,
      B_STUDIO_SESSIONS_DIR: path.join(workRoot, 'sessions'),
      B_STUDIO_TASK_PLANS_DIR: path.join(workRoot, 'task-plans'),
      B_STUDIO_MODEL_OBSERVATIONS_FILE: path.join(workRoot, 'model-observations.json'),
    };
    if (backend === 'openai') {
      const registryFile = path.join(workRoot, 'models.json');
      await writeFile(
        registryFile,
        JSON.stringify([
          {
            id: MODEL_ID,
            provider: 'openai',
            model: requestedModel,
            label: 'Bench upstream',
            capabilities: ['tools', 'json'],
            contextWindow: 200_000,
            pricing: { inputPerMillion: priceInput, outputPerMillion: priceOutput },
            baselineQuality: 0.8,
            baselineLatencyMs: 100,
            baseUrl: proxy!.baseUrl,
            apiKeyEnv: 'B_STUDIO_BENCH_PROXY_KEY',
          },
        ]),
        { mode: 0o600 },
      );
      Object.assign(benchEnv, { B_STUDIO_MODE: 'api', B_STUDIO_MODEL_REGISTRY: registryFile, B_STUDIO_BENCH_PROXY_KEY: 'local' });
      // 스튜디오 API 모드가 이 값을 읽어 러너에 넘긴다(loop.ts). 켠 실행과 끈 실행을 비교해 효과를 잰다
      if (contextClearing) benchEnv.B_STUDIO_CONTEXT_CLEARING = 'on';
    } else if (backend === 'claude-code') {
      // claude-code는 모델 레지스트리를 쓰지 않는다. 세션 생성도 고정 계획도 레지스트리를 요구하지 않는다
      Object.assign(benchEnv, { B_STUDIO_MODE: 'claude-code', B_STUDIO_CLAUDE_CODE_MODEL: requestedModel });
      // 시작 모델은 --model, 승격 대상은 --escalate-to. 세션·레인·통합이 모두 이 설정을 쓴다
      if (escalation.to) Object.assign(benchEnv, { B_STUDIO_CLAUDE_CODE_ESCALATE_MODEL: escalation.to, B_STUDIO_ESCALATE_AFTER: String(escalation.after) });
    } else if (backend === 'codex') {
      // codex도 모델 레지스트리를 쓰지 않는다. 모델을 주지 않으면 로그인 계정의 기본 모델을 쓴다
      Object.assign(benchEnv, { B_STUDIO_MODE: 'codex' });
      if (choice.model) benchEnv.B_STUDIO_CODEX_MODEL = choice.model;
    } else {
      // commandcode도 모델 레지스트리를 쓰지 않는다. 모델을 주지 않으면 로그인 계정의 기본 모델을 쓴다
      Object.assign(benchEnv, { B_STUDIO_MODE: 'commandcode' });
      if (choice.model) benchEnv.B_STUDIO_CMD_MODEL = choice.model;
    }
    Object.assign(process.env, benchEnv);

    if (backend !== 'openai') {
      // 4. 로컬 CLI 로그인 확인. 프롬프트를 보내지 않으므로 모델 사용량을 쓰지 않는다
      if (backend === 'claude-code') {
        const { preflightClaudeCode } = await import('@b-studio/agent');
        const preflight = await preflightClaudeCode({ cwd: projectDir });
        if (!preflight.ok) {
          console.error(`로컬 Claude Code를 쓸 수 없습니다: ${preflight.reason}`);
          process.exitCode = 3;
          return;
        }
        console.log(`로컬 Claude Code 로그인 확인: ${preflight.account.subscriptionType ?? preflight.account.apiKeySource ?? '로그인 계정'} · 모델 ${requestedModel}`);
      } else if (backend === 'codex') {
        const { preflightCodex } = await import('@b-studio/agent');
        const preflight = await preflightCodex();
        if (!preflight.ok) {
          console.error(`로컬 Codex를 쓸 수 없습니다: ${preflight.reason}`);
          process.exitCode = 3;
          return;
        }
        console.log(`로컬 Codex 로그인 확인 · 모델 ${choice.model ?? '계정 기본값'}`);
      } else {
        const { preflightCommandCode } = await import('@b-studio/agent');
        const preflight = await preflightCommandCode();
        if (!preflight.ok) {
          console.error(`로컬 Command Code를 쓸 수 없습니다: ${preflight.reason}`);
          process.exitCode = 3;
          return;
        }
        console.log(`로컬 Command Code 로그인 확인 · 모델 ${choice.model ?? '계정 기본값'}`);
      }
    }

    const taskPlans = await import('../../lib/server/task-plans');
    const sessions = await import('../../lib/server/sessions');
    const auth = await import('../../lib/server/auth');

    /** 모델 계약 원문은 결과 폴더에 따로 남긴다(요약·JSONL에는 수치만 넣는다) */
    const saveContracts = async (name: string, payload: unknown): Promise<void> => {
      const directory = path.join(outRoot, 'contracts');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `${name}.json`), redact(JSON.stringify(payload, null, 2), secrets), { mode: 0o600 });
    };

    const context: RunContext = {
      taskPlans,
      sessions,
      localUser: auth.LOCAL_USER,
      backend,
      proxy,
      priceInput,
      priceOutput,
      requestedModel,
      planModelId: planModelId(backend, requestedModel, MODEL_ID),
      topology,
      integrationChecks: args.integrationChecks ?? false,
      contractsSource,
      ...(escalation.to ? { escalateTo: escalation.to } : {}),
      escalateAfter: escalation.after,
      ...(prices ? { prices } : {}),

      projectDir,
      resetProject,
      saveContracts,
    };

    // 5. 반복·과제·전략 순서. 반복마다 전략 순서를 뒤집어 시간에 따른 환경 변화가 한 전략에 몰리지 않게 한다
    let order = 0;
    const record = async (task: BenchTask, strategy: Strategy, repeat: number, retryOf?: number): Promise<BenchRow> => {
      order += 1;
      console.log(`[${order}] 반복 ${repeat}/${repeats} · ${task.id} · ${strategy} (${STRATEGY_LABELS[strategy]})${retryOf === undefined ? '' : ` (재시도 of ${retryOf})`}`);
      const row = await runOnce(context, task, strategy, order, repeat, activeSessions);
      const stored: BenchRow = retryOf === undefined ? row : { ...row, retryOf };
      rows.push(stored);
      await appendFile(path.join(outRoot, 'results.jsonl'), `${redact(JSON.stringify(stored), secrets)}\n`);
      console.log(`    → ${stored.success ? '성공' : stored.category} (계획 ${stored.planStatus}${stored.detail ? ` · ${stored.detail.slice(0, 120)}` : ''})`);
      return stored;
    };

    for (let repeat = 1; repeat <= repeats && !abortReason; repeat += 1) {
      const ordered = repeat % 2 === 1 ? strategies : [...strategies].reverse();
      for (const task of tasks) {
        for (const strategy of ordered) {
          let row = await record(task, strategy, repeat);
          // 남은 컨테이너가 있으면 재시도하지 않고 아래 '남은 컨테이너' 중단 경로로 멈춘다
          if (row.leftoverContainers.length === 0 && row.category === 'rate_limited' && rateLimit.policy === 'wait') {
            console.warn(`사용 한도에 걸렸습니다. ${rateLimit.waitMinutes}분 기다린 뒤 같은 실행을 한 번만 다시 시도합니다.`);
            await delay(rateLimit.waitMinutes * 60_000);
            row = await record(task, strategy, repeat, row.order);
          }
          if (row.leftoverContainers.length > 0) {
            abortReason = `남은 컨테이너가 있어 멈춥니다: ${row.leftoverContainers.join(', ')}`;
            console.error(abortReason);
            break;
          }
          if (row.category === 'rate_limited') {
            abortReason =
              rateLimit.policy === 'wait'
                ? '다시 시도한 실행도 사용 한도에 걸려 멈춥니다.'
                : `사용 한도에 걸려 멈춥니다 (--on-rate-limit wait로 기다렸다 다시 시도할 수 있습니다).`;
            console.error(abortReason);
            break;
          }
        }
        if (abortReason) break;
      }
    }
  } finally {
    await cleanup();
  }

  const finishedAt = new Date().toISOString();
  const observedModels = [...new Set(rows.flatMap((row) => row.observedModels))];
  await writeFile(path.join(outRoot, 'summary.md'), redact(summarize(rows, { backend, requestedModel, contextClearing, contracts: contractsSource }), secrets));
  await writeFile(
    path.join(outRoot, 'meta.json'),
    redact(
      JSON.stringify(
        {
          startedAt,
          finishedAt,
          dry,
          backend,
          requestedModel,
          observedModels,
          dockerMemTotal,
          gitCommit: commitAtStart,
          // 끝날 때 다르면 기록한다. 결과를 해석할 때 어느 코드로 돌았는지 헷갈리지 않게
          ...(gitCommit() === commitAtStart ? {} : { gitCommitAtEnd: gitCommit() }),
          tasks: tasks.map((task) => task.id),
          strategies,
          topology,
          contracts: contractsSource,
          escalateTo: escalation.to,
          escalateAfter: escalation.after,
          pricesPath: args.prices,
          repeats,
          runs: rows.length,
          onRateLimit: rateLimit.policy,
          rateLimitWaitMinutes: rateLimit.waitMinutes,
          contextClearing,
          integrationChecks: args.integrationChecks ?? false,
          abortReason,
        },
        null,
        2,
      ),
      secrets,
    ),
    { mode: 0o600 },
  );

  console.log(`\n결과: ${outRoot}`);
  console.log(`  results.jsonl (${rows.length}줄), summary.md, meta.json`);
  if (abortReason) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(describe(error));
  process.exitCode = 1;
});
