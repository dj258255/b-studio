/**
 * 협업 벤치마크 실행기.
 *
 * 작업 분해의 두 전략(S0 직렬화 / S1 격리 병렬)을 같은 과제·같은 모델로 반복 실행해 원자료를 남긴다.
 * 운영 코드(apps/studio/lib, packages)는 고치지 않고, e2e처럼 환경 변수를 세운 뒤 서버 내부 함수를 dynamic import로 부른다.
 * 사람 승인 게이트는 그대로 지난다(approveTaskPlan을 직접 부른다). 새 HTTP 라우트나 우회 경로를 만들지 않는다.
 *
 *   pnpm bench:coordination --dry          # 가짜 상류로, 실제 모델 호출 없이
 *   BENCH_UPSTREAM_BASE_URL=... BENCH_UPSTREAM_API_KEY=... BENCH_UPSTREAM_MODEL=... pnpm bench:coordination
 */
import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { runAcceptance, type AcceptanceResult } from './acceptance';
import { classify } from './classify';
import { startDryProvider } from './dry-provider';
import { startProxy, type ProxyHandle } from './proxy';
import { redact } from './redact';
import { summarize, type BenchLaneRow, type BenchRow } from './summary';
import { BENCH_TASKS, planFor, type BenchTask, type Strategy } from './tasks';
import type { TaskPlanView } from '../../lib/task-plan-types';

type TaskPlansModule = typeof import('../../lib/server/task-plans');
type SessionsModule = typeof import('../../lib/server/sessions');

const PROJECT_ID = 'bench-orders';
const MODEL_ID = 'bench-coordination';
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 40 * 60_000;
const POLL_MS = 2_000;

interface Args {
  dry: boolean;
  force: boolean;
  taskIds?: string[];
  strategies?: Strategy[];
  repeats?: number;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dry: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--dry') args.dry = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--tasks') args.taskIds = split(next(argv, index++, '--tasks'));
    else if (arg === '--strategies') args.strategies = split(next(argv, index++, '--strategies')) as Strategy[];
    else if (arg === '--repeats') args.repeats = Number(next(argv, index++, '--repeats'));
    else if (arg === '--out') args.out = next(argv, index++, '--out');
    else if (arg.startsWith('--tasks=')) args.taskIds = split(arg.slice('--tasks='.length));
    else if (arg.startsWith('--strategies=')) args.strategies = split(arg.slice('--strategies='.length)) as Strategy[];
    else if (arg.startsWith('--repeats=')) args.repeats = Number(arg.slice('--repeats='.length));
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
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
  const values: Strategy[] | undefined = dry ? ['S0', 'S1'] : strategies;
  if (!values || values.length === 0) return ['S0', 'S1'];
  for (const value of values) if (value !== 'S0' && value !== 'S1') throw new Error(`전략은 S0 또는 S1이어야 합니다: ${value}`);
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

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`실제 실행에는 ${name} 환경 변수가 필요합니다`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RunContext {
  taskPlans: TaskPlansModule;
  sessions: SessionsModule;
  localUser: string;
  proxy: ProxyHandle;
  priceInput: number;
  priceOutput: number;
  model: string;
}

async function runOnce(context: RunContext, task: BenchTask, strategy: Strategy, order: number, repeat: number, activeSessions: Set<string>): Promise<BenchRow> {
  const startedAt = new Date().toISOString();
  const { taskPlans, sessions, localUser, proxy } = context;
  let plan: TaskPlanView = { id: '', owner: localUser, projectId: PROJECT_ID, request: '', modelId: MODEL_ID, status: 'failed', createdAt: startedAt, lanes: [] };
  let planId: string | undefined;
  let acceptance: AcceptanceResult[] | undefined;
  let harnessError: string | undefined;

  try {
    proxy.setPlan(planFor(task, strategy));
    const created = await taskPlans.createTaskPlan({ projectId: PROJECT_ID, request: task.request, modelId: MODEL_ID, owner: localUser });
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

  // 세션을 모두 내린다. 실패·시간 초과로 끝났어도 남기지 않는다.
  // stopSession이 실패하면 activeSessions에 남겨, 남은 컨테이너가 있을 때 다시 시도한다
  const sessionIds = [...plan.lanes.flatMap((lane) => (lane.sessionId ? [lane.sessionId] : [])), ...(plan.integration?.sessionId ? [plan.integration.sessionId] : [])];
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
  const proxyStats = proxy.takeStats();
  const metrics = plan.metrics;
  const estimatedCostUsd =
    (context.priceInput * ((metrics?.usage.inputTokens ?? 0) + (metrics?.usage.cacheReadTokens ?? 0) + (metrics?.usage.cacheWriteTokens ?? 0)) +
      context.priceOutput * (metrics?.usage.outputTokens ?? 0)) /
    1_000_000;

  return {
    order,
    repeat,
    taskId: task.id,
    coupled: task.coupled,
    strategy,
    model: context.model,
    startedAt,
    finishedAt: new Date().toISOString(),
    planId,
    planStatus: plan.status,
    planError: plan.error,
    lanes: plan.lanes.map(
      (lane): BenchLaneRow => ({
        id: lane.id,
        status: lane.status,
        bootMs: lane.bootMs,
        error: lane.error,
        tasks: lane.tasks.map((item) => ({ id: item.id, status: item.status, run: item.run })),
      }),
    ),
    integration: plan.integration ? { status: plan.integration.status, bootMs: plan.integration.bootMs, run: plan.integration.run, error: plan.integration.error } : undefined,
    metrics,
    acceptance,
    success,
    category: classification.category,
    detail: classification.detail,
    proxy: proxyStats,
    leftoverContainers,
    estimatedCostUsd,
  };
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
  const dry = args.dry;
  const repeats = args.repeats ?? (dry ? 1 : 3);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error(`--repeats는 1 이상의 정수여야 합니다 (지금 값: ${args.repeats})`);
  const tasks = selectTasks(args.taskIds, dry);
  const strategies = selectStrategies(args.strategies, dry);

  // 1. 사전 확인 — 다른 프로젝트 컨테이너가 있으면 여기서 멈춘다
  const dockerMemTotal = preflight(args.force);

  const upstreamModel = dry ? 'dry' : requiredEnv('BENCH_UPSTREAM_MODEL');
  const upstream = dry ? await startDryProvider() : { baseUrl: requiredEnv('BENCH_UPSTREAM_BASE_URL'), close: async () => {} };
  const upstreamApiKey = dry ? 'dry' : requiredEnv('BENCH_UPSTREAM_API_KEY');
  const priceInput = price('BENCH_PRICE_INPUT_PER_M');
  const priceOutput = price('BENCH_PRICE_OUTPUT_PER_M');
  const secrets = dry ? [] : [upstreamApiKey].filter((value) => value.length >= 8);

  const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl, upstreamApiKey });
  const outRoot = args.out ? path.resolve(args.out) : path.join(homedir(), '.cache/b-studio/bench/coordination', timestamp());
  await mkdir(outRoot, { recursive: true });
  const workRoot = await mkdtemp(path.join(homedir(), '.cache/b-studio/bench-work-'));
  const activeSessions = new Set<string>();
  const startedAt = new Date().toISOString();

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    const { stopSession } = await import('../../lib/server/sessions');
    for (const id of activeSessions) await stopSession(id).catch(() => {});
    activeSessions.clear();
    await proxy.close().catch(() => {});
    await upstream.close().catch(() => {});
    await rm(workRoot, { recursive: true, force: true }).catch(() => {});
  };
  process.on('SIGINT', () => {
    void cleanup().finally(() => process.exit(130));
  });

  const rows: BenchRow[] = [];
  let abortReason: string | undefined;

  try {
    // 2. 임시 루트에 프로젝트 복사와 모델 레지스트리·환경 변수 준비 (e2e와 같은 방식)
    const projectsDir = path.join(workRoot, 'projects');
    const projectDir = path.join(projectsDir, PROJECT_ID);
    await cp(path.resolve(import.meta.dirname, '../../../../examples/orders'), projectDir, {
      recursive: true,
      filter: (source) => !/[/\\](node_modules|\.next|build|\.gradle)([/\\]|$)/.test(source),
    });
    const specFile = path.join(projectDir, 'studio.yaml');
    await writeFile(specFile, (await readFile(specFile, 'utf8')).replace(/^name: orders$/m, `name: ${PROJECT_ID}`));

    const registryFile = path.join(workRoot, 'models.json');
    await writeFile(
      registryFile,
      JSON.stringify([
        {
          id: MODEL_ID,
          provider: 'openai',
          model: upstreamModel,
          label: 'Bench upstream',
          capabilities: ['tools', 'json'],
          contextWindow: 200_000,
          pricing: { inputPerMillion: priceInput, outputPerMillion: priceOutput },
          baselineQuality: 0.8,
          baselineLatencyMs: 100,
          baseUrl: proxy.baseUrl,
          apiKeyEnv: 'B_STUDIO_BENCH_PROXY_KEY',
        },
      ]),
      { mode: 0o600 },
    );
    await mkdir(path.join(workRoot, 'sessions'), { recursive: true });
    Object.assign(process.env, {
      B_STUDIO_MODE: 'api',
      B_STUDIO_AUTH: 'none',
      B_STUDIO_MODEL_REGISTRY: registryFile,
      B_STUDIO_PROJECTS_DIR: projectsDir,
      B_STUDIO_SESSIONS_DIR: path.join(workRoot, 'sessions'),
      B_STUDIO_TASK_PLANS_DIR: path.join(workRoot, 'task-plans'),
      B_STUDIO_MODEL_OBSERVATIONS_FILE: path.join(workRoot, 'model-observations.json'),
      B_STUDIO_BENCH_PROXY_KEY: 'local',
    });

    const taskPlans = await import('../../lib/server/task-plans');
    const sessions = await import('../../lib/server/sessions');
    const auth = await import('../../lib/server/auth');

    const context: RunContext = { taskPlans, sessions, localUser: auth.LOCAL_USER, proxy, priceInput, priceOutput, model: upstreamModel };

    // 3. 반복·과제·전략 순서. 반복마다 전략 순서를 뒤집어 시간에 따른 환경 변화가 한 전략에 몰리지 않게 한다
    let order = 0;
    for (let repeat = 1; repeat <= repeats && !abortReason; repeat += 1) {
      const ordered = repeat % 2 === 1 ? strategies : [...strategies].reverse();
      for (const task of tasks) {
        for (const strategy of ordered) {
          order += 1;
          console.log(`[${order}] 반복 ${repeat}/${repeats} · ${task.id} · ${strategy}`);
          const row = await runOnce(context, task, strategy, order, repeat, activeSessions);
          rows.push(row);
          await appendFile(path.join(outRoot, 'results.jsonl'), `${redact(JSON.stringify(row), secrets)}\n`);
          console.log(`    → ${row.success ? '성공' : row.category} (계획 ${row.planStatus}${row.detail ? ` · ${row.detail.slice(0, 120)}` : ''})`);
          if (row.leftoverContainers.length > 0) {
            abortReason = `남은 컨테이너가 있어 멈춥니다: ${row.leftoverContainers.join(', ')}`;
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
  await writeFile(path.join(outRoot, 'summary.md'), redact(summarize(rows), secrets));
  await writeFile(
    path.join(outRoot, 'meta.json'),
    redact(
      JSON.stringify(
        {
          startedAt,
          finishedAt,
          dry,
          model: upstreamModel,
          dockerMemTotal,
          gitCommit: gitCommit(),
          tasks: tasks.map((task) => task.id),
          strategies,
          repeats,
          runs: rows.length,
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
