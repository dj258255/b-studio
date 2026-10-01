import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardAccess } from '@b-studio/agent';
import type { WorkflowPageCheck } from '@b-studio/spec';
import type { StudioEvent } from '../studio-events';
import type { TaskPlanView } from '../task-plan-types';

type Checkpoint = { sha: string; shortSha: string; message: string; createdAt: string; files: string[] };
type Session = {
  id: string;
  projectId: string;
  owner: string;
  status: 'ready';
  workDir: string;
  checkpoints: Checkpoint[];
  bootNetwork?: Array<{ service: string; rxBytes: number; txBytes: number }>;
};
type SendOptions = {
  allowBreaking: boolean;
  by?: string;
  writableScope?: readonly string[];
  steering?: boolean;
  scriptedTurns?: Array<{ toolCalls?: Array<{ name: string; input: { path: string; content?: string } }> }>;
  board?: BoardAccess;
  verify?: 'light';
};

/** 검증기가 낸 실패 서명 하나를 담은 이벤트(레인 실패 때 기록에 남긴다). S5가 이걸 읽어 게시한다 */
function failureEvent(runId: string): StudioEvent {
  return {
    type: 'agent',
    runId,
    event: {
      type: 'verify_result',
      text: '',
      report: { ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: 'web', ready: false, error: 'cannot find symbol at line 42' }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] },
    },
  } as StudioEvent;
}

/** S4 수리 요청인지: 원래 요청 + 통합 게이트 실패 문구 */
function isRepair(request: string): boolean {
  return request.includes('[조율] 레인') && request.includes('검증이 실패했습니다');
}

const fake = vi.hoisted(() => ({
  root: '',
  counter: 0,
  plan: {} as unknown,
  /** findProject가 돌려주는 프로젝트. 시크릿 가림 테스트는 여기에 secrets를 넣고 환경 변수를 세운다 */
  project: { spec: { name: 'orders' }, managed: [['web', { template: 'nextjs', path: 'web' }]] } as unknown,
  sessions: new Map<string, Session>(),
  /** createSession에 넘어온 옵션(순서대로). 통합 세션에만 extraPageChecks가 붙는지, 레인에만 backend가 붙는지 확인한다 */
  sessionOptions: [] as Array<{ modelId?: string; effort?: string; backend?: string; extraPageChecks?: readonly WorkflowPageCheck[]; seedFromSessionId?: string }>,
  /** commitPendingWorkingCopyDocs를 부른 세션 id와 메시지(순서대로). sourceSessionId가 있는 계획만 부른다 */
  docsCommitted: [] as Array<{ sessionId: string; message: string }>,
  /** createSession이 돌려주는 세션의 기동 네트워크. 기동 수신 지표를 확인할 때 채운다 */
  bootNetwork: [] as Array<{ service: string; rxBytes: number; txBytes: number }>,
  listeners: new Map<string, Set<(event: StudioEvent) => void>>(),
  /** 세션별 이벤트 기록. subscribe가 다시 보내 주므로 S5가 실패 서명을 읽는다 */
  history: new Map<string, StudioEvent[]>(),
  /** 작업 id → 그 작업이 쓸 파일. 없으면 실패로 끝낸다 */
  writes: {} as Record<string, Record<string, string> | 'fail'>,
  /** 작업 id → 그 작업이 지울 파일 */
  deletes: {} as Record<string, string[]>,
  /** 세션을 만들 때 작업 폴더에 넣는 프로젝트 원본 파일 */
  sourceFiles: {} as Record<string, string>,
  sends: [] as Array<{ sessionId: string; request: string; options: SendOptions }>,
  stopped: [] as string[],
  /** stopAndDeleteSession을 부른 세션 id들(순서 그대로, 계획·플릿을 지울 때 구성원 세션도 지우는지 확인한다) */
  stopAndDeleted: [] as string[],
  stopOrder: { integrationCreatedAfterStops: false },
  /** 원본 저장소의 상태. originUrl이 없으면 원격 저장소가 아니다 */
  source: { base: 'main', originUrl: 'git@github.com:acme/orders.git', dirtyFiles: 0, subdir: '' } as { base: string; originUrl?: string; dirtyFiles: number; subdir: string } | undefined,
  /** 만든 이슈 제목 (만든 순서) */
  issues: [] as string[],
  /** 만든 이슈의 제목·본문 (만든 순서). 추적 이슈 본문을 확인할 때 쓴다 */
  issueInputs: [] as Array<{ title: string; body: string }>,
  /** 연결한 하위 이슈 수 */
  subIssues: [] as boolean[],
  /** true면 이슈 만들기가 실패한다 */
  failIssue: false,
  /** 계획 모델을 부른 횟수. 고정 계획(presetPlan)은 0이어야 한다 */
  modelCalls: 0,
  /** 그중 레인 사이 계약 호출 횟수(B_STUDIO_PLAN_CONTRACTS) */
  contractCalls: 0,
  /** 로컬 Claude Code 호출(계획·계약 공용)이 만든 ask의 옵션과, 실제로 불린 횟수 */
  claudeCodeAsks: [] as Array<{ cwd: string; model?: string; effort?: string }>,
  claudeCodeCalls: 0,
  /** 로컬 CLI가 돌려주는 usage. 어댑터를 거치지 않고 ask가 직접 주므로 이미 세션 지표 모양(camelCase)이다 */
  claudeCodePlanUsage: { inputTokens: 21, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 },
  claudeCodeContractUsage: { inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  /** 계약 호출이 돌려주는 텍스트와 usage */
  contractText: '{"contracts":[{"body":"GET /api/orders → 200 JSON 배열","refs":["api"]}]}',
  contractUsage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  /** 통합 스크립트 턴의 게이트 결과. S4 수리를 부르려면 'failed'로 둔다 */
  integration: 'done' as 'done' | 'failed',
  /** S4 수리 요청의 게이트 결과 */
  repair: 'done' as 'done' | 'failed',
  /** 모든 run_finished에 붙이는 실행 지표. 계획 기록에 그대로 옮겨지는지 확인한다 */
  run: {
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    metrics: { modelCalls: 2, maxContextTokens: 9, modelMs: 5, toolMs: 6, gateMs: 7 },
    durationMs: 11,
  },
}));

// 원격 이슈 올리기는 실제 API를 부르므로 CheckpointStore.inspectSource와 createIssue·addSubIssue만 바꿔 끼운다
vi.mock('@b-studio/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/agent')>();
  return {
    ...actual,
    CheckpointStore: { inspectSource: async () => fake.source },
    createIssue: async (_remote: unknown, input: { title: string; body: string }) => {
      if (fake.failIssue) throw new Error('이슈를 만들지 못했습니다');
      fake.issues.push(input.title);
      fake.issueInputs.push({ title: input.title, body: input.body });
      return { number: fake.issues.length, url: `https://github.com/acme/orders/issues/${fake.issues.length}` };
    },
    addSubIssue: async () => {
      fake.subIssues.push(true);
      return { supported: true };
    },
  };
});

vi.mock('./model-registry', () => ({
  listModelOptions: () => [{ id: 'model-a', label: 'Model A', enabled: true, configured: true, capabilities: ['tools'] }],
  modelById: (id: string) => ({ id }),
  clientForModel: () => ({
    createMessage: async (request: { system?: string }) => {
      fake.modelCalls += 1;
      // 계약 호출과 계획 호출은 시스템 프롬프트로 갈린다(제품과 벤치가 같은 문구를 쓴다)
      const contract = typeof request?.system === 'string' && request.system.startsWith('You write the interface contracts');
      if (contract) {
        fake.contractCalls += 1;
        return { content: [{ type: 'text', text: fake.contractText }], stop_reason: 'end_turn', usage: fake.contractUsage };
      }
      return { content: [{ type: 'text', text: JSON.stringify(fake.plan) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    },
  }),
}));

// 로컬 Claude Code 구독으로 계획·계약을 받는 경로. 실제 SDK·모델 호출 없이 옵션과 호출 수만 본다
vi.mock('./claude-code-ask', () => ({
  claudeCodeAsk: (options: { cwd: string; model?: string; effort?: string }) => {
    fake.claudeCodeAsks.push(options);
    return async (request: { system: string; user: string }) => {
      // 계약과 계획은 시스템 프롬프트로 갈린다(제품·벤치가 같은 문구를 쓴다)
      if (request.system.startsWith('You write the interface contracts')) {
        fake.contractCalls += 1;
        return { text: fake.contractText, usage: fake.claudeCodeContractUsage };
      }
      fake.claudeCodeCalls += 1;
      return { text: JSON.stringify(fake.plan), usage: fake.claudeCodePlanUsage };
    };
  },
}));

vi.mock('./projects', () => ({
  findProject: async () => fake.project,
}));

vi.mock('./sessions', () => ({
  commitPendingWorkingCopyDocs: async (sessionId: string, message: string) => {
    fake.docsCommitted.push({ sessionId, message });
    return undefined;
  },
  createSession: async (
    projectId: string,
    owner: string,
    _workspace: string,
    options: { modelId?: string; effort?: string; backend?: string; extraPageChecks?: readonly WorkflowPageCheck[]; seedFromSessionId?: string } = {},
  ) => {
    fake.sessionOptions.push(options);
    const id = `session-${++fake.counter}`;
    // 두 레인 세션이 모두 멈춘 뒤에 만들어진 세션이면 통합 세션이다
    if (fake.counter === 3) fake.stopOrder.integrationCreatedAfterStops = new Set(fake.stopped).size === 2;
    const workDir = path.join(fake.root, id);
    mkdirSync(workDir, { recursive: true });
    // 실제 세션은 프로젝트 원본을 복사해 시작한다. 지운 파일이 여기 있으면 통합 세션도 그 파일을 갖고 시작한다
    for (const [file, content] of Object.entries(fake.sourceFiles)) {
      mkdirSync(path.dirname(path.join(workDir, file)), { recursive: true });
      writeFileSync(path.join(workDir, file), content);
    }
    fake.sessions.set(id, {
      id,
      projectId,
      owner,
      status: 'ready',
      workDir,
      bootNetwork: fake.bootNetwork,
      checkpoints: [{ sha: `${id}-start`, shortSha: 'start', message: '세션 시작', createdAt: '', files: [] }],
    });
    return { id };
  },
  getSnapshot: (id: string) => fake.sessions.get(id),
  stopSession: async (id: string) => {
    fake.stopped.push(id);
  },
  stopAndDeleteSession: async (id: string) => {
    fake.stopAndDeleted.push(id);
    fake.sessions.delete(id);
  },
  subscribe: (id: string, listener: (event: StudioEvent) => void) => {
    // 실제 세션과 같이 지금까지의 기록을 먼저 보낸다(레인 조율이 실패 서명을 읽는 경로)
    for (const event of fake.history.get(id) ?? []) listener(event);
    const set = fake.listeners.get(id) ?? new Set();
    set.add(listener);
    fake.listeners.set(id, set);
    return () => set.delete(listener);
  },
  sendMessage: (sessionId: string, request: string, options: SendOptions) => {
    fake.sends.push({ sessionId, request, options });
    const session = fake.sessions.get(sessionId)!;
    const runId = `run-${fake.sends.length}`;
    const record = (event: StudioEvent) => {
      const list = fake.history.get(sessionId) ?? [];
      list.push(event);
      fake.history.set(sessionId, list);
      for (const listener of fake.listeners.get(sessionId) ?? []) listener(event);
    };
    const finish = (status: 'done' | 'failed', summary: string) => {
      // 실패한 실행은 검증기가 낸 실패 서명을 하나 남긴다(S5가 읽어 게시한다)
      if (status === 'failed') record(failureEvent(runId));
      record({ type: 'run_finished', runId, status, summary, ...fake.run } as StudioEvent);
    };

    // 통합: 스크립트 턴이 만든 파일을 적용하고 게이트 결과는 fake.integration이 정한다
    if (options.scriptedTurns) {
      const writes = (options.scriptedTurns[0]?.toolCalls ?? []).filter((call) => call.name === 'write_file');
      for (const call of writes) {
        mkdirSync(path.dirname(path.join(session.workDir, call.input.path)), { recursive: true });
        writeFileSync(path.join(session.workDir, call.input.path), call.input.content ?? '');
      }
      if (fake.integration === 'done') {
        session.checkpoints.unshift({ sha: runId, shortSha: runId, message: request, createdAt: '', files: [...new Set(writes.map((call) => call.input.path))] });
        finish('done', '완료');
      } else {
        finish('failed', '검증 게이트를 통과하지 못했습니다');
      }
      return { runId };
    }
    // S4 수리: 모델 경로로 보낸 요청. 게이트 결과는 fake.repair가 정한다
    if (isRepair(request)) {
      finish(fake.repair, fake.repair === 'done' ? '수리 완료' : '검증 게이트를 통과하지 못했습니다');
      return { runId };
    }
    // 레인 작업
    const taskId = /\[id:([a-z0-9-]+)\]/.exec(request)?.[1];
    const deleted = taskId ? (fake.deletes[taskId] ?? []) : [];
    const files = taskId ? fake.writes[taskId] : undefined;
    if (files === 'fail' || files === undefined) {
      finish('failed', '검증 게이트를 통과하지 못했습니다');
    } else {
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(session.workDir, file)), { recursive: true });
        writeFileSync(path.join(session.workDir, file), content);
      }
      // 레인이 지운 파일은 작업 폴더에서 사라지고 체크포인트에만 남는다 (실제 체크포인트의 변경 목록과 같다)
      for (const file of deleted) rmSync(path.join(session.workDir, file), { force: true });
      session.checkpoints.unshift({ sha: runId, shortSha: runId, message: request, createdAt: '', files: [...new Set([...Object.keys(files), ...deleted])] });
      finish('done', '완료');
    }
    return { runId };
  },
}));

import { StudioError } from './errors';
import { approveTaskPlan, createTaskPlan, deleteTaskPlan, getTaskPlan, rejectTaskPlan } from './task-plans';

const directory = mkdtempSync(path.join(tmpdir(), 'b-studio-task-plans-'));
const saved = {
  mode: process.env.B_STUDIO_MODE,
  dir: process.env.B_STUDIO_TASK_PLANS_DIR,
  token: process.env.B_STUDIO_GITHUB_TOKEN,
  giteaToken: process.env.B_STUDIO_GITEA_TOKEN,
  provider: process.env.B_STUDIO_GIT_PROVIDER,
  contracts: process.env.B_STUDIO_PLAN_CONTRACTS,
};

const task = (id: string, paths: string[], dependsOn: string[] = []) => ({ id, title: id, request: `[id:${id}] ${id} 작업`, paths, dependsOn });

beforeEach(() => {
  fake.root = mkdtempSync(path.join(directory, 'work-'));
  fake.counter = 0;
  fake.project = { spec: { name: 'orders' }, managed: [['web', { template: 'nextjs', path: 'web' }]] };
  fake.sessions.clear();
  fake.sessionOptions = [];
  fake.docsCommitted = [];
  fake.bootNetwork = [];
  fake.listeners.clear();
  fake.history.clear();
  fake.deletes = {};
  fake.sourceFiles = {};
  fake.sends = [];
  fake.stopped = [];
  fake.stopAndDeleted = [];
  fake.stopOrder.integrationCreatedAfterStops = false;
  fake.modelCalls = 0;
  fake.contractCalls = 0;
  fake.claudeCodeAsks = [];
  fake.claudeCodeCalls = 0;
  fake.contractText = '{"contracts":[{"body":"GET /api/orders → 200 JSON 배열","refs":["api"]}]}';
  fake.contractUsage = { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  fake.integration = 'done';
  fake.repair = 'done';
  fake.source = { base: 'main', originUrl: 'git@github.com:acme/orders.git', dirtyFiles: 0, subdir: '' };
  fake.issues = [];
  fake.issueInputs = [];
  fake.subIssues = [];
  fake.failIssue = false;
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_TASK_PLANS_DIR = path.join(directory, 'plans');
  // 계약 수신은 기본 꺼짐이다. 켜는 테스트만 직접 세운다
  delete process.env.B_STUDIO_PLAN_CONTRACTS;
  delete process.env.B_STUDIO_GITHUB_TOKEN;
  delete process.env.B_STUDIO_GITEA_TOKEN;
  delete process.env.B_STUDIO_GIT_PROVIDER;
});

afterAll(() => {
  for (const [key, value] of [
    ['B_STUDIO_MODE', saved.mode],
    ['B_STUDIO_TASK_PLANS_DIR', saved.dir],
    ['B_STUDIO_PLAN_CONTRACTS', saved.contracts],
    ['B_STUDIO_GITHUB_TOKEN', saved.token],
    ['B_STUDIO_GITEA_TOKEN', saved.giteaToken],
    ['B_STUDIO_GIT_PROVIDER', saved.provider],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

async function finished(id: string) {
  for (let i = 0; i < 500; i++) {
    const plan = getTaskPlan(id, 'kim');
    if (plan.status === 'done' || plan.status === 'failed') return plan;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('작업 계획이 끝나지 않았습니다');
}

/** 계획 검증이 끝나 승인을 기다리거나(awaiting_approval), 계획 단계에서 실패할 때까지 기다린다 */
async function awaiting(id: string): Promise<TaskPlanView> {
  for (let i = 0; i < 500; i++) {
    const plan = getTaskPlan(id, 'kim');
    if (plan.status === 'awaiting_approval' || plan.status === 'failed') return plan;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('작업 계획이 승인 대기에 이르지 않았습니다');
}

/** 이슈 올리기가 끝나 추적 이슈나 실패 이유가 남을 때까지 기다린다 */
async function untilIssues(id: string): Promise<TaskPlanView> {
  for (let i = 0; i < 500; i++) {
    const plan = getTaskPlan(id, 'kim');
    if (plan.issues?.tracking || plan.issues?.error) return plan;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('이슈를 올리지 않았습니다');
}

/** 계획을 만들고, 사람이 승인한 뒤 완료·실패까지 기다린다 */
async function run(input: Parameters<typeof createTaskPlan>[0]): Promise<TaskPlanView> {
  const created = await createTaskPlan(input);
  const waiting = await awaiting(created.id);
  if (waiting.status !== 'awaiting_approval') return waiting;
  approveTaskPlan(created.id, 'kim');
  return finished(created.id);
}

function statusOf(action: () => unknown): number {
  try {
    action();
  } catch (error) {
    if (error instanceof StudioError) return error.status;
    throw error;
  }
  throw new Error('오류가 나지 않았습니다');
}

describe('작업 분해 실행', () => {
  it('이어진 작업은 한 세션에서 쓰기 범위를 걸어 차례로, 독립 레인은 다른 세션에서 돌리고 결과를 새 세션에 다시 적용한다', async () => {
    fake.plan = { tasks: [task('a1', ['web/a']), task('a2', ['web/a'], ['a1']), task('b', ['web/b'])] };
    fake.writes = { a1: { 'web/a/one.md': 'one' }, a2: { 'web/a/two.md': 'two' }, b: { 'web/b/one.md': 'b' } };

    const plan = await run({ projectId: 'orders', request: '메모 추가', modelId: 'model-a', owner: 'kim' });

    expect(plan.status).toBe('done');
    const laneA = plan.lanes.find((lane) => lane.tasks.length === 2)!;
    const laneB = plan.lanes.find((lane) => lane.tasks.length === 1)!;
    const sendsA = fake.sends.filter((send) => send.sessionId === laneA.sessionId);
    expect(sendsA.map((send) => send.options.writableScope)).toEqual([['web/a'], ['web/a']]);
    expect(sendsA[1]!.request).toContain('같은 작업 공간에서 먼저 끝난 작업:\n- a1');
    // 레인·통합 실행에는 실행 중 지시(steering)를 켜지 않는다(사람이 보는 단일 세션만)
    expect(fake.sends.every((send) => send.options.steering === undefined)).toBe(true);
    expect(laneB.sessionId).not.toBe(laneA.sessionId);

    const integration = fake.sends.find((send) => send.options.scriptedTurns)!;
    expect(integration.sessionId).toBe(plan.integration?.sessionId);
    expect(integration.options.scriptedTurns![0]!.toolCalls!.map((call) => [call.input.path, call.input.content]).sort()).toEqual([
      ['web/a/one.md', 'one'],
      ['web/a/two.md', 'two'],
      ['web/b/one.md', 'b'],
    ]);
    expect(integration.options.writableScope).toEqual(['web/a', 'web/b']);
    expect(plan.integration).toMatchObject({ status: 'done', files: ['web/a/one.md', 'web/a/two.md', 'web/b/one.md'] });
    // 레인 세션은 통합 샌드박스를 띄우기 전에 내려 동시에 뜨는 샌드박스를 레인 수로 제한하고, 통합 세션은 검토용으로 남긴다
    expect([...new Set(fake.stopped)].sort()).toEqual([laneA.sessionId, laneB.sessionId].sort());
    expect(fake.stopOrder.integrationCreatedAfterStops).toBe(true);
  });

  it('세션에서 "나눠서 병렬로 하기"로 만든 계획은 레인·통합이 그 세션의 최신 체크포인트에서 시작한다(ADR-096)', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };
    // 이미 떠 있는 원본 세션(같은 프로젝트·소유자)을 createSession 없이 직접 등록한다
    fake.sessions.set('origin-1', {
      id: 'origin-1',
      projectId: 'orders',
      owner: 'kim',
      status: 'ready',
      workDir: path.join(fake.root, 'origin-1'),
      checkpoints: [{ sha: 'origin-sha', shortSha: 'origin', message: 'docs: 요구사항을 정리한다', createdAt: '', files: ['docs/requirements.md'] }],
    });

    const plan = await run({ projectId: 'orders', request: '메모 추가', modelId: 'model-a', owner: 'kim', sourceSessionId: 'origin-1' });

    expect(plan.status).toBe('done');
    expect(plan.sourceSessionId).toBe('origin-1');
    // 레인 둘과 통합 하나, 모두 origin-1에서 시작한다
    expect(fake.sessionOptions.filter((options) => options.seedFromSessionId === 'origin-1')).toHaveLength(3);
    // 레인을 시작하기 전에 원본 세션에 남아 있을 수 있는 문서 변경을 먼저 체크포인트로 남긴다
    expect(fake.docsCommitted.map((entry) => entry.sessionId)).toEqual(['origin-1']);
  });

  it('설계 파이프라인(ADR-0XX): 요청이 언급한 요구사항을 다루는 설계가 승인되지 않았으면 레인을 만들기 전에 409로 막는다', async () => {
    const workDir = path.join(fake.root, 'origin-2');
    mkdirSync(path.join(workDir, 'docs/design'), { recursive: true });
    writeFileSync(
      path.join(workDir, 'docs/design/01-메모.meta.json'),
      JSON.stringify({ path: 'docs/design/01-메모.md', number: 1, title: '메모', requirementIds: ['R4'], bundles: [], status: 'draft', createdAt: '', createdBy: 'kim' }),
    );
    fake.sessions.set('origin-2', { id: 'origin-2', projectId: 'orders', owner: 'kim', status: 'ready', workDir, checkpoints: [] });

    await expect(createTaskPlan({ projectId: 'orders', request: '[R4] 메모 추가', modelId: 'model-a', owner: 'kim', sourceSessionId: 'origin-2' })).rejects.toThrow(
      '설계 승인 전에는 구현을 시작할 수 없습니다',
    );
    // 레인·통합 세션을 하나도 만들지 않는다(승인 전에는 아예 시작하지 않는다)
    expect(fake.sessionOptions).toEqual([]);
  });

  it('세션에서 시작하지 않은 계획(화면의 "계획 만들기" 탭)은 지금처럼 프로젝트 원본에서 시작한다', async () => {
    fake.plan = { tasks: [task('a', ['web/a'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' } };

    const plan = await run({ projectId: 'orders', request: '메모 추가', modelId: 'model-a', owner: 'kim' });

    expect(plan.status).toBe('done');
    expect(plan.sourceSessionId).toBeUndefined();
    expect(fake.sessionOptions.every((options) => options.seedFromSessionId === undefined)).toBe(true);
    expect(fake.docsCommitted).toEqual([]);
  });

  it('다른 프로젝트·다른 소유자의 세션을 넘기면 404로 거부하고 레인을 시작하지 않는다', async () => {
    fake.sessions.set('other-project', { id: 'other-project', projectId: 'web-only', owner: 'kim', status: 'ready', workDir: fake.root, checkpoints: [] });
    await expect(createTaskPlan({ projectId: 'orders', request: '메모 추가', modelId: 'model-a', owner: 'kim', sourceSessionId: 'other-project' })).rejects.toThrow(
      '넘긴 세션을 찾을 수 없습니다',
    );

    fake.sessions.set('other-owner', { id: 'other-owner', projectId: 'orders', owner: 'lee', status: 'ready', workDir: fake.root, checkpoints: [] });
    await expect(createTaskPlan({ projectId: 'orders', request: '메모 추가', modelId: 'model-a', owner: 'kim', sourceSessionId: 'other-owner' })).rejects.toThrow(
      '넘긴 세션을 찾을 수 없습니다',
    );
    expect(fake.sessions.size).toBe(2);
  });

  it('병렬 레인의 쓰기 범위가 겹치는 계획은 세션을 만들기 전에 실패시킨다', async () => {
    fake.plan = { tasks: [task('a', ['web/app']), task('b', ['web/app/orders'])] };
    const plan = await run({ projectId: 'orders', request: '겹치는 계획', modelId: 'model-a', owner: 'kim' });
    expect(plan).toMatchObject({ status: 'failed', lanes: [] });
    expect(plan.error).toContain('쓰기 범위가 겹칩니다');
    expect(fake.sessions.size).toBe(0);
  });

  it('레인 하나가 실패하면 뒤 작업은 건너뛰고 통합하지 않는다', async () => {
    fake.plan = { tasks: [task('a1', ['web/a']), task('a2', ['web/a'], ['a1']), task('b', ['web/b'])] };
    fake.writes = { a1: 'fail', b: { 'web/b/one.md': 'b' } };
    const plan = await run({ projectId: 'orders', request: '실패 레인', modelId: 'model-a', owner: 'kim' });
    const laneA = plan.lanes.find((lane) => lane.tasks.length === 2)!;
    expect(plan.status).toBe('failed');
    expect(laneA.tasks.map((item) => item.status)).toEqual(['failed', 'skipped']);
    expect(plan.lanes.find((lane) => lane.tasks.length === 1)!.status).toBe('done');
    expect(plan.integration).toBeUndefined();
    expect(fake.sends.some((send) => send.options.scriptedTurns)).toBe(false);
  });

  it('레인이 도구를 거치지 않고 범위 밖 파일을 바꿨으면 통합하지 않는다', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    // 실행기 정책을 우회한 변경(명령으로 만든 파일 등)이 체크포인트에 들어온 상황
    fake.writes = { a: { 'web/a/one.md': 'one', 'web/b/sneaky.md': 'x' }, b: { 'web/b/one.md': 'b' } };
    const plan = await run({ projectId: 'orders', request: '범위 밖 변경', modelId: 'model-a', owner: 'kim' });
    expect(plan.status).toBe('failed');
    expect(plan.integration?.error).toContain('쓰기 범위 밖 파일을 바꿨습니다: web/b/sneaky.md');
    expect(fake.sends.some((send) => send.options.scriptedTurns)).toBe(false);
  });

  it('레인이 지운 파일을 통합이 delete_file로 함께 적용한다', async () => {
    fake.plan = { tasks: [task('a', ['web/a'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' } };
    // 프로젝트 원본에는 있지만 레인이 지운 파일. 통합 세션은 그 파일을 가진 원본에서 시작한다
    fake.sourceFiles = { 'web/a/removed.md': 'old' };
    fake.deletes = { a: ['web/a/removed.md'] };

    const plan = await run({ projectId: 'orders', request: '삭제 포함', modelId: 'model-a', owner: 'kim' });

    expect(plan.status).toBe('done');
    const integration = fake.sends.find((send) => send.options.scriptedTurns)!;
    // 쓰기 먼저, 삭제 나중
    expect(integration.options.scriptedTurns![0]!.toolCalls!.map((call) => [call.name, call.input.path])).toEqual([
      ['write_file', 'web/a/one.md'],
      ['delete_file', 'web/a/removed.md'],
    ]);
    expect(plan.integration).toMatchObject({
      status: 'done',
      files: ['web/a/one.md', 'web/a/removed.md'],
      deleted: ['web/a/removed.md'],
    });
  });

  it('통합 세션의 원본에도 없는 파일은 지울 목록에서 뺀다', async () => {
    fake.plan = { tasks: [task('a', ['web/a'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' } };
    // 레인이 만들었다가 지운 파일: 어느 작업 폴더에도 남아 있지 않다
    fake.deletes = { a: ['web/a/never-existed.md'] };

    const plan = await run({ projectId: 'orders', request: '없는 파일 삭제', modelId: 'model-a', owner: 'kim' });

    expect(plan.status).toBe('done');
    const integration = fake.sends.find((send) => send.options.scriptedTurns)!;
    expect(integration.options.scriptedTurns![0]!.toolCalls!.map((call) => call.name)).toEqual(['write_file']);
    expect(plan.integration).toMatchObject({ status: 'done', files: ['web/a/one.md'], deleted: [] });
  });

  it('레인이 만들었다가 지운 파일만 있으면 빈 턴을 돌리지 않고 실패시킨다', async () => {
    fake.plan = { tasks: [task('a', ['web/a'])] };
    // 파일을 만들었다가 지운 레인: 작업 폴더에도 통합 세션 원본에도 파일이 없다
    fake.writes = { a: {} };
    fake.deletes = { a: ['web/a/never-existed.md'] };

    const plan = await run({ projectId: 'orders', request: '만들었다 지운 파일', modelId: 'model-a', owner: 'kim' });

    expect(plan.status).toBe('failed');
    expect(plan.integration?.error).toContain('적용할 변경이 없습니다');
    // 아무것도 검증하지 않았는데 통과로 기록되면 안 된다. 스크립트 턴을 아예 보내지 않는다
    expect(fake.sends.some((send) => send.options.scriptedTurns)).toBe(false);
  });

  it('api 모드가 아니거나 모델이 등록되지 않았으면 시작하지 않는다', async () => {
    await expect(createTaskPlan({ projectId: 'orders', request: '요청', modelId: 'unknown', owner: 'kim' })).rejects.toThrow('등록되지 않은 모델');
    process.env.B_STUDIO_MODE = 'demo';
    await expect(createTaskPlan({ projectId: 'orders', request: '요청', modelId: 'model-a', owner: 'kim' })).rejects.toThrow('B_STUDIO_MODE=api');
  });

  // 계획은 메모리의 객체가 원본이고 persist는 그 객체 전체를 쓴다. 레인들이 동시에 끝나도 먼저 끝난 레인 결과가 저장에서 빠지면 안 된다
  it('여러 레인이 동시에 끝나도 계획 파일에 모든 레인 결과가 남는다', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };

    const plan = await run({ projectId: 'orders', request: '동시 저장', modelId: 'model-a', owner: 'kim' });

    expect(plan.status).toBe('done');
    const saved = JSON.parse(readFileSync(path.join(process.env.B_STUDIO_TASK_PLANS_DIR!, `${plan.id}.json`), 'utf8')) as TaskPlanView;
    expect(saved.lanes.map((lane) => lane.status)).toEqual(['done', 'done']);
    expect(saved.lanes.every((lane) => (lane.changedFiles?.length ?? 0) > 0)).toBe(true);
    expect(saved.integration?.status).toBe('done');
  });

  // integrationChecks는 통합 게이트에만 덧붙인다. 레인 세션에는 넘기지 않아 레인 게이트는 그대로다
  it('integrationChecks는 통합 게이트에만 덧붙인다', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };
    const pageChecks: WorkflowPageCheck[] = [
      {
        service: 'web',
        path: '/orders',
        mode: 'http',
        expectStatus: 200,
        expectFromApi: { service: 'api', path: '/api/orders', jsonPath: '$[0].customerName' },
        allowConsoleErrors: false,
        noHorizontalScroll: false,
      },
    ];

    const plan = await run({ projectId: 'orders', request: '통합 확인', modelId: 'model-a', owner: 'kim', integrationChecks: { pageChecks } });

    expect(plan.status).toBe('done');
    // 세션은 레인 2개 + 통합 1개 순서로 만들어지고, 통합 세션에만 덧붙인다
    expect(fake.sessionOptions).toHaveLength(3);
    expect(fake.sessionOptions.slice(0, 2).every((options) => options.extraPageChecks === undefined)).toBe(true);
    expect(fake.sessionOptions[2]!.extraPageChecks).toEqual(pageChecks);
  });

  // verify light는 레인·통합 실행에 그대로 넘긴다. S4 수리도 같은 verify로 돈다
  it('verify light면 레인·통합·S4 수리 실행에 가볍게 확인을 넘긴다', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };
    fake.integration = 'failed';

    const plan = await run({
      projectId: 'orders',
      request: '가볍게 확인',
      modelId: 'model-a',
      owner: 'kim',
      verify: 'light',
      coordination: { strategy: 'S4' },
    });

    expect(plan.status).toBe('done');
    // 계획이 기억해 레인·통합 실행이 같은 값을 쓴다
    expect(plan.verify).toBe('light');
    const laneSends = fake.sends.filter((send) => !send.options.scriptedTurns && !isRepair(send.request));
    expect(laneSends.length).toBeGreaterThan(0);
    expect(laneSends.every((send) => send.options.verify === 'light')).toBe(true);
    // 통합 실행과 S4 수리도 같은 값을 받는다
    expect(fake.sends.find((send) => send.options.scriptedTurns)!.options.verify).toBe('light');
    expect(fake.sends.find((send) => isRepair(send.request))!.options.verify).toBe('light');
  });

  it('기본(full)은 verify를 넘기지 않는다(지금과 같다)', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };

    const plan = await run({ projectId: 'orders', request: '전체 검증', modelId: 'model-a', owner: 'kim' });

    expect(plan.verify).toBeUndefined();
    expect(fake.sends.every((send) => send.options.verify === undefined)).toBe(true);
  });

  it('고정 계획의 레인 backend·model로 레인 세션을 만들고, 레인 뷰에 남긴다', async () => {
    const lane = (id: string, paths: string[], backend: string, model?: string) => ({ ...task(id, paths), backend, ...(model ? { model } : {}) });
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' }, c: { 'web/c/one.md': 'c' } };

    const plan = await run({
      projectId: 'orders',
      request: '레인 백엔드',
      modelId: 'model-a',
      owner: 'kim',
      presetPlan: {
        tasks: [lane('a', ['web/a'], 'claude-code', 'sonnet'), lane('b', ['web/b'], 'commandcode'), lane('c', ['web/c'], 'opencode', 'opencode/mimo-v2.6-flash-free')],
      },
    });

    expect(plan.status).toBe('done');
    // 레인 세션은 그 레인의 backend로 만들고, 모델을 고른 CLI 레인은 그 모델을 세션에 싣는다(modelId)
    expect(fake.sessionOptions.find((options) => options.backend === 'claude-code')?.modelId).toBe('sonnet');
    expect(fake.sessionOptions.find((options) => options.backend === 'commandcode')?.modelId).toBeUndefined();
    expect(fake.sessionOptions.find((options) => options.backend === 'opencode')?.modelId).toBe('opencode/mimo-v2.6-flash-free');
    // 통합 세션은 계획 기본(서버 모드)이라 backend가 없다
    expect(fake.sessionOptions[3]!.backend).toBeUndefined();
    // 레인 뷰에 backend·model이 남아 화면·서버 기록에서 볼 수 있다
    expect(plan.lanes.map((item) => [item.backend, item.model])).toEqual([
      ['claude-code', 'sonnet'],
      ['commandcode', undefined],
      ['opencode', 'opencode/mimo-v2.6-flash-free'],
    ]);
  });

  it('계획 호출·레인 기동·작업 실행·통합 지표를 계획에 기록한다', async () => {
    fake.plan = { tasks: [task('a1', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a1: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };
    // 모든 세션이 기동 중 1,000바이트를 받은 것으로 둔다 (레인 2 + 통합 1)
    fake.bootNetwork = [{ service: 'web', rxBytes: 1_000, txBytes: 100 }];

    const plan = await run({ projectId: 'orders', request: '지표 기록', modelId: 'model-a', owner: 'kim' });

    expect(plan.status).toBe('done');
    // 계획 호출의 usage와 걸린 시간
    expect(plan.planning).toEqual({ usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, durationMs: expect.any(Number) });

    const lane = plan.lanes.find((candidate) => candidate.tasks[0]!.id === 'a1')!;
    expect(lane.bootMs).toBeGreaterThanOrEqual(0);
    expect(lane.bootRxBytes).toBe(1_000);
    expect(typeof lane.startedAt).toBe('string');
    expect(typeof lane.finishedAt).toBe('string');
    // run_finished의 지표가 작업 실행 기록으로 그대로 옮겨진다
    expect(lane.tasks[0]!.run).toEqual({ status: 'done', durationMs: 11, usage: fake.run.usage, metrics: fake.run.metrics });
    expect(plan.integration?.run).toEqual({ status: 'done', durationMs: 11, usage: fake.run.usage, metrics: fake.run.metrics });
    expect(plan.integration?.bootMs).toBeGreaterThanOrEqual(0);

    // 계획 호출 1회 + 레인 작업 실행 2회 × 2회 = 5 (통합은 스크립트 턴이라 세지 않는다), 최대 입력 크기는 9, 세션은 레인 2 + 통합 1
    expect(plan.metrics).toMatchObject({ modelCalls: 5, maxContextTokens: 9, sessions: 3 });
    expect(plan.metrics!.bootMsTotal).toBeGreaterThanOrEqual(0);
    // 레인 2 + 통합 1의 기동 수신 합
    expect(plan.metrics!.bootRxBytesTotal).toBe(3_000);
    expect(typeof plan.metrics!.endToEndMs).toBe('number');
  });
});

describe('고정 계획(presetPlan)', () => {
  it('presetPlan이 있으면 모델을 부르지 않고 검증해 승인을 기다린다 (claude-code·codex·commandcode·opencode 모드 포함)', async () => {
    for (const mode of ['claude-code', 'codex', 'commandcode', 'opencode']) {
      process.env.B_STUDIO_MODE = mode;
      const created = await createTaskPlan({ projectId: 'orders', request: '고정 계획', modelId: mode, owner: 'kim', presetPlan: { tasks: [task('a1', ['web/a']), task('b', ['web/b'])] } });
      const waiting = await awaiting(created.id);
      expect(waiting.status, mode).toBe('awaiting_approval');
      expect(waiting.preset, mode).toBe(true);
      // 모델 호출이 없었으므로 planning이 없다
      expect(waiting.planning, mode).toBeUndefined();
      expect(
        waiting.lanes
          .map((lane) => lane.tasks.map((item) => item.id))
          .flat()
          .sort(),
        mode,
      ).toEqual(['a1', 'b']);
      // 승인 게이트는 그대로다. 승인 전에는 세션을 만들지 않는다
      expect(fake.sessions.size, mode).toBe(0);
    }
    expect(fake.modelCalls).toBe(0);
  });

  it('presetPlan도 승인 뒤 레인·통합이 그대로 돈다', async () => {
    process.env.B_STUDIO_MODE = 'claude-code';
    fake.writes = { a1: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };

    const plan = await run({
      projectId: 'orders',
      request: '고정 계획 실행',
      modelId: 'claude-code',
      owner: 'kim',
      presetPlan: { tasks: [task('a1', ['web/a']), task('b', ['web/b'])] },
    });

    expect(plan.status).toBe('done');
    expect(plan.preset).toBe(true);
    expect(plan.planning).toBeUndefined();
    expect(fake.modelCalls).toBe(0);
  });

  it('presetPlan이 없으면 계획 호출 경로가 없는 모드(codex·commandcode·opencode·demo)에서 거부한다', async () => {
    for (const mode of ['codex', 'commandcode', 'opencode', 'demo']) {
      process.env.B_STUDIO_MODE = mode;

      // claude-code는 이제 허용된다(로컬 구독으로 계획을 받는다). 그 밖의 모드는 이유와 함께 거부한다
      await expect(createTaskPlan({ projectId: 'orders', request: '요청', modelId: 'model-a', owner: 'kim' })).rejects.toThrow(`(지금 모드: ${mode})`);
      expect(fake.modelCalls).toBe(0);
      expect(fake.claudeCodeCalls).toBe(0);
    }
  });

  it('presetPlan이 있어도 demo 모드에서는 거부한다', async () => {
    process.env.B_STUDIO_MODE = 'demo';
    await expect(
      createTaskPlan({ projectId: 'orders', request: '요청', modelId: 'claude-code', owner: 'kim', presetPlan: { tasks: [task('a', ['web/a'])] } }),
    ).rejects.toThrow('api, claude-code, codex, commandcode 또는 opencode');
  });

  it('presetPlan이 규칙을 어기면 세션을 만들지 않고 실패한다', async () => {
    const created = await createTaskPlan({ projectId: 'orders', request: '나쁜 계획', modelId: 'model-a', owner: 'kim', presetPlan: { tasks: [] } });
    const plan = await awaiting(created.id);

    expect(plan.status).toBe('failed');
    expect(plan.error).toContain('작업 계획을 만들지 못했습니다');
    expect(fake.sessions.size).toBe(0);
  });

  it('presetPlan이면 modelId가 비어 있을 수 없다', async () => {
    await expect(
      createTaskPlan({ projectId: 'orders', request: '요청', modelId: '  ', owner: 'kim', presetPlan: { tasks: [task('a', ['web/a'])] } }),
    ).rejects.toThrow('modelId가 필요합니다');
  });
});

describe('작업 계획 승인', () => {
  it('계획을 만들면 승인을 기다리며 세션을 하나도 만들지 않는다', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };

    const created = await createTaskPlan({ projectId: 'orders', request: '승인 대기', modelId: 'model-a', owner: 'kim' });
    const waiting = await awaiting(created.id);

    expect(waiting.status).toBe('awaiting_approval');
    expect(waiting.lanes).toHaveLength(2);
    expect(fake.sessions.size).toBe(0);
    expect(fake.sends).toEqual([]);
  });

  it('승인해야 레인이 돌고 통합까지 끝난다', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };

    const created = await createTaskPlan({ projectId: 'orders', request: '승인 후 실행', modelId: 'model-a', owner: 'kim' });
    await awaiting(created.id);
    expect(fake.sessions.size).toBe(0);

    const approved = approveTaskPlan(created.id, 'kim');
    expect(approved).toMatchObject({ status: 'running', approvedBy: 'kim' });
    expect(approved.approvedAt).toBeDefined();

    const plan = await finished(created.id);
    expect(plan.status).toBe('done');
    expect(plan.lanes.every((lane) => lane.sessionId)).toBe(true);
    expect(plan.integration?.status).toBe('done');
  });

  it('다른 사용자는 승인·거부할 수 없고 승인 대기가 아니면 409로 거부한다', async () => {
    fake.plan = { tasks: [task('a', ['web/a'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' } };

    const created = await createTaskPlan({ projectId: 'orders', request: '승인 권한', modelId: 'model-a', owner: 'kim' });
    await awaiting(created.id);

    expect(statusOf(() => approveTaskPlan(created.id, 'lee'))).toBe(403);
    expect(statusOf(() => rejectTaskPlan(created.id, 'lee'))).toBe(403);
    expect(statusOf(() => approveTaskPlan('nope', 'kim'))).toBe(404);

    approveTaskPlan(created.id, 'kim');
    expect(statusOf(() => approveTaskPlan(created.id, 'kim'))).toBe(409);
    // 승인으로 시작한 실행을 이 테스트 안에서 끝내, 다음 테스트로 세션 생성이 새지 않게 한다
    await finished(created.id);
  });

  it('거부하면 세션을 만들지 않고 상태를 rejected로 남긴다', async () => {
    fake.plan = { tasks: [task('a', ['web/a'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' } };

    const created = await createTaskPlan({ projectId: 'orders', request: '거부', modelId: 'model-a', owner: 'kim' });
    await awaiting(created.id);

    const rejected = rejectTaskPlan(created.id, 'kim', '  쓰기 범위가 이상합니다  ');
    expect(rejected).toMatchObject({ status: 'rejected', rejectedReason: '쓰기 범위가 이상합니다' });
    expect(rejected.finishedAt).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.sessions.size).toBe(0);
    expect(fake.sends).toEqual([]);
    expect(getTaskPlan(created.id, 'kim').status).toBe('rejected');
    expect(statusOf(() => rejectTaskPlan(created.id, 'kim'))).toBe(409);
  });
});

describe('서버 재시작 뒤 이어서 하기', () => {
  it('레인이 끝나면 작업 폴더와 바꾼 파일을 계획에 남긴다', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b', 'web/b/two.md': 'two' } };

    const plan = await run({ projectId: 'orders', request: '결과 기록', modelId: 'model-a', owner: 'kim' });

    expect(plan.status).toBe('done');
    const laneA = plan.lanes.find((lane) => lane.tasks[0]!.id === 'a')!;
    const laneB = plan.lanes.find((lane) => lane.tasks[0]!.id === 'b')!;
    expect(laneA.workDir).toBe(fake.sessions.get(laneA.sessionId!)!.workDir);
    expect(laneA.changedFiles).toEqual(['web/a/one.md']);
    expect(laneB.changedFiles).toEqual(['web/b/one.md', 'web/b/two.md']);
  });

  it('레인이 모두 끝나 통합만 남은 계획은 재시작 뒤 interrupted로 남는다', async () => {
    writePlan({
      id: 'plan-done-lanes',
      owner: 'kim',
      lanes: [
        laneView('lane-1', 'done', { workDir: path.join(fake.root, 'lane-1'), changedFiles: ['web/a/one.md'] }),
        laneView('lane-2', 'done', { paths: ['web/b'], workDir: path.join(fake.root, 'lane-2'), changedFiles: ['web/b/one.md'] }),
      ],
    });

    const { getTaskPlan: reloaded } = await restart();
    const plan = reloaded('plan-done-lanes', 'kim');

    expect(plan.status).toBe('interrupted');
    expect(plan.error).toContain('통합을 다시 시도할 수 있습니다');
  });

  it('레인이 끝났어도 결과 기록이 없는 계획은 재시작 뒤 이어서 하라고 안내하지 않는다', async () => {
    writePlan({
      id: 'plan-no-record',
      owner: 'kim',
      lanes: [
        laneView('lane-1', 'done', { workDir: path.join(fake.root, 'lane-1'), changedFiles: ['web/a/one.md'] }),
        // 기록이 생기기 전에 만들어진 레인: 통합이 결과를 다시 읽을 근거가 없다
        laneView('lane-2', 'done', { paths: ['web/b'] }),
      ],
    });

    const { getTaskPlan: reloaded } = await restart();
    const plan = reloaded('plan-no-record', 'kim');

    expect(plan.status).toBe('failed');
    expect(plan.error).toContain('기록');
  });

  it('레인이 끝나지 않은 계획은 재시작 뒤 failed로 남는다', async () => {
    writePlan({ id: 'plan-half', owner: 'kim', lanes: [laneView('lane-1', 'done'), laneView('lane-2', 'running', { paths: ['web/b'] })] });

    const { getTaskPlan: reloaded } = await restart();
    const plan = reloaded('plan-half', 'kim');

    expect(plan.status).toBe('failed');
    expect(plan.error).toContain('스튜디오가 다시 시작돼');
  });

  it('resumeTaskPlan은 레인을 다시 돌리지 않고 통합만 다시 한다', async () => {
    const laneA = path.join(fake.root, 'lane-a');
    const laneB = path.join(fake.root, 'lane-b');
    mkdirSync(path.join(laneA, 'web/a'), { recursive: true });
    mkdirSync(path.join(laneB, 'web/b'), { recursive: true });
    writeFileSync(path.join(laneA, 'web/a/one.md'), 'one');
    writeFileSync(path.join(laneB, 'web/b/one.md'), 'b');
    writePlan({
      id: 'plan-resume',
      owner: 'kim',
      lanes: [
        laneView('lane-1', 'done', { sessionId: 'session-lane-1', workDir: laneA, changedFiles: ['web/a/one.md'], paths: ['web/a'] }),
        laneView('lane-2', 'done', { sessionId: 'session-lane-2', workDir: laneB, changedFiles: ['web/b/one.md'], paths: ['web/b'] }),
      ],
    });

    const { getTaskPlan: reloaded, resumeTaskPlan } = await restart();
    const resumed = resumeTaskPlan('plan-resume', 'kim');

    expect(resumed.status).toBe('integrating');
    expect(resumed.error).toBeUndefined();

    const done = await settled(() => reloaded('plan-resume', 'kim'));
    expect(done.status).toBe('done');
    expect(done.integration?.status).toBe('done');
    // 통합 세션 하나만 새로 만들어지고(레인 세션 2개는 다시 안 만든다), 레인에 대한 sendMessage도 새로 불리지 않는다
    expect(fake.counter).toBe(1);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.options.scriptedTurns![0]!.toolCalls!.map((call) => call.input.path).sort()).toEqual(['web/a/one.md', 'web/b/one.md']);
  });

  it('interrupted가 아닌 계획은 이어서 할 수 없고 남의 계획도 이어서 할 수 없다', async () => {
    writePlan({ id: 'plan-done', owner: 'kim', status: 'done', lanes: [laneView('lane-1', 'done')] });

    const { resumeTaskPlan } = await restart();

    expect(resumeStatus(() => resumeTaskPlan('plan-done', 'lee'))).toBe(403);
    expect(resumeStatus(() => resumeTaskPlan('plan-done', 'kim'))).toBe(409);
    expect(resumeStatus(() => resumeTaskPlan('missing', 'kim'))).toBe(404);
  });

  it('레인 결과 기록이 없으면 통합을 시작하지 않고 실패한다', async () => {
    // 이어서 하기로 남은 계획이지만 결과 기록이 없는 예전 기록: 통합이 다시 읽을 근거가 없다
    writePlan({ id: 'plan-no-record-resume', owner: 'kim', status: 'interrupted', lanes: [laneView('lane-1', 'done', { sessionId: 'session-lane-1' })] });

    const { getTaskPlan: reloaded, resumeTaskPlan } = await restart();
    resumeTaskPlan('plan-no-record-resume', 'kim');

    const plan = await settled(() => reloaded('plan-no-record-resume', 'kim'));
    expect(plan.status).toBe('failed');
    expect(plan.integration?.status).toBe('failed');
    expect(plan.integration?.error).toContain('결과 기록이 없어');
    // 통합 샌드박스를 띄우기 전에 멈춰야 한다. 스크립트 턴이 돌면 아무것도 합치지 않았는데 통과한 것처럼 남는다
    expect(fake.counter).toBe(0);
    expect(fake.sends.some((send) => send.options.scriptedTurns)).toBe(false);
  });
});

describe('레인 조율 전략', () => {
  const contract = { body: 'GET /api/orders → JSON 배열', refs: ['api'] };

  it('조율을 켜지 않으면 게시판도 도구도 없고 요청 문구도 그대로다', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };

    const plan = await run({ projectId: 'orders', request: '조율 없음', modelId: 'model-a', owner: 'kim' });

    expect(plan.status).toBe('done');
    expect(plan.coordination).toBeUndefined();
    expect(plan.board).toBeUndefined();
    expect(plan.metrics?.coordination).toBeUndefined();
    expect(fake.sends.every((send) => send.options.board === undefined)).toBe(true);
    expect(fake.sends.some((send) => send.request.includes('[조율]'))).toBe(false);
  });

  it('S2는 계약을 레인 시작 전에 플랫폼이 게시하고, 레인은 읽기만 한다', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };

    const created = await createTaskPlan({
      projectId: 'orders',
      request: 'S2 계약',
      modelId: 'model-a',
      owner: 'kim',
      coordination: { strategy: 'S2', contracts: [contract] },
    });
    const waiting = await awaiting(created.id);

    // 승인 전에도 계약은 이미 게시돼 있다
    expect(waiting.coordination).toEqual({ strategy: 'S2', topology: 'mesh' });
    expect(waiting.board?.notes).toHaveLength(1);
    expect(waiting.board?.notes[0]).toMatchObject({ kind: 'contract', lane: 'plan', by: 'platform', refs: ['api'] });

    approveTaskPlan(created.id, 'kim');
    const plan = await finished(created.id);

    expect(plan.status).toBe('done');
    const laneSends = fake.sends.filter((send) => send.options.board);
    expect(laneSends).toHaveLength(2);
    // S2는 레인 읽기 전용이라 모델 쓰기가 꺼져 있다
    expect(laneSends.every((send) => send.options.board!.modelWrites === false)).toBe(true);
    expect(laneSends.every((send) => send.request.includes('[조율] 시작 전에 read_notes로 공유된 계약을 확인하세요'))).toBe(true);
    expect(plan.metrics?.coordination).toMatchObject({ strategy: 'S2', topology: 'mesh', posts: 1 });
  });

  it('S3는 레인이 게시판에 쓸 수 있고 topology를 따른다', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };

    const plan = await run({
      projectId: 'orders',
      request: 'S3 게시판',
      modelId: 'model-a',
      owner: 'kim',
      coordination: { strategy: 'S3', topology: 'star' },
    });

    expect(plan.status).toBe('done');
    expect(plan.coordination).toEqual({ strategy: 'S3', topology: 'star' });
    const laneSends = fake.sends.filter((send) => send.options.board);
    expect(laneSends).toHaveLength(2);
    expect(laneSends.every((send) => send.options.board!.modelWrites === true)).toBe(true);
    expect(laneSends[0]!.request).toContain('post_note(contract)');
    expect(plan.metrics?.coordination).toMatchObject({ strategy: 'S3', topology: 'star' });
  });

  it('S5는 작업이 끝날 때마다 검증 실패 서명을 플랫폼이 게시하고 모델 쓰기를 끈다', async () => {
    fake.plan = { tasks: [task('a', ['web/a'])] };
    fake.writes = { a: 'fail' };

    const plan = await run({
      projectId: 'orders',
      request: 'S5 실패 서명',
      modelId: 'model-a',
      owner: 'kim',
      coordination: { strategy: 'S5' },
    });

    expect(plan.status).toBe('failed');
    const failures = plan.board?.notes.filter((note) => note.kind === 'failure') ?? [];
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ by: 'platform', refs: [] });
    expect(failures[0]!.body).toContain('[run web]');
    expect(failures[0]!.body).toContain('cannot find symbol at line N');

    const laneSend = fake.sends.find((send) => send.options.board)!;
    expect(laneSend.options.board!.modelWrites).toBe(false);
    expect(laneSend.request).toContain('[조율] 시작 전에 read_notes로 다른 레인의 검증 실패를 확인하세요');
    expect(plan.metrics?.coordination).toMatchObject({ strategy: 'S5', byKind: { failure: 1 } });
  });

  it('S4는 통합 게이트가 실패하면 한 번만 모델 수리를 요청하고, 레인에는 게시판을 넘기지 않는다', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };
    fake.integration = 'failed';

    const plan = await run({ projectId: 'orders', request: 'S4 수리', modelId: 'model-a', owner: 'kim', coordination: { strategy: 'S4' } });

    expect(plan.status).toBe('done');
    const repairs = fake.sends.filter((send) => isRepair(send.request));
    expect(repairs).toHaveLength(1);
    // 수리 요청은 스크립트 턴이 아니라 세션의 기본 모델 경로로 보낸다
    expect(repairs[0]!.options.scriptedTurns).toBeUndefined();
    expect(repairs[0]!.options.writableScope).toEqual(['web/a', 'web/b']);
    expect(repairs[0]!.request).toContain('검증이 실패했습니다');
    expect(plan.integration?.repair).toMatchObject({ attempted: true, status: 'done' });
    expect(fake.sends.filter((send) => send.options.board)).toHaveLength(0);
  });

  it('S4의 수리도 실패하면 통합이 실패한다', async () => {
    fake.plan = { tasks: [task('a', ['web/a'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' } };
    fake.integration = 'failed';
    fake.repair = 'failed';

    const plan = await run({ projectId: 'orders', request: 'S4 수리 실패', modelId: 'model-a', owner: 'kim', coordination: { strategy: 'S4' } });

    expect(plan.status).toBe('failed');
    expect(plan.integration?.repair).toMatchObject({ attempted: true, status: 'failed' });
    expect(fake.sends.filter((send) => isRepair(send.request))).toHaveLength(1);
  });

  it('S3에서 모델이 시크릿 값을 담아 게시하면 기록·화면에 남기 전에 가린다', async () => {
    const secret = 'sk_test_payment_secret';
    process.env.B_STUDIO_SECRET_PAYMENT_API_KEY = secret;
    fake.project = {
      spec: { name: 'orders' },
      managed: [['web', { template: 'nextjs', path: 'web' }]],
      secrets: [['PAYMENT_API_KEY', { services: ['web'] }]],
    };
    fake.plan = { tasks: [task('a', ['web/a'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' } };
    try {
      const plan = await run({ projectId: 'orders', request: 'S3 가림', modelId: 'model-a', owner: 'kim', coordination: { strategy: 'S3' } });
      expect(plan.status).toBe('done');

      // 레인에 실제로 넘긴 게시판 래퍼로 모델의 post_note를 흉내 낸다
      const board = fake.sends.find((send) => send.options.board)!.options.board!;
      const posted = board.post({ kind: 'fact', body: `배포 키는 ${secret} 입니다`, refs: [`config/${secret}.env`] });
      expect(posted.ok).toBe(true);

      // 계획 기록(plan.board)과 모델에게 돌려준 메모 어디에도 원래 값이 없고 가림 문구가 있다
      const stored = getTaskPlan(plan.id, 'kim').board!.notes.find((note) => note.body.includes('배포 키는'))!;
      expect(stored.body).not.toContain(secret);
      expect(stored.body).toContain('[PAYMENT_API_KEY 가림]');
      expect(stored.refs.join(' ')).not.toContain(secret);
      expect(stored.refs.join(' ')).toContain('[PAYMENT_API_KEY 가림]');
      expect(posted.ok && posted.note.body).not.toContain(secret);
      // 계층 구조의 그룹 비교가 성립하도록 레인의 첫 쓰기 범위가 그룹으로 남는다
      expect(stored.group).toBe('web/a');
    } finally {
      delete process.env.B_STUDIO_SECRET_PAYMENT_API_KEY;
    }
  });
});

describe('레인 사이 계약 (B_STUDIO_PLAN_CONTRACTS)', () => {
  const contractBody = 'GET /api/orders → 200 JSON 배열. 항목: id(number), customerName(string)';

  it('기본은 꺼짐이다: 계약 호출도 게시판도 없다', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };

    const plan = await run({ projectId: 'orders', request: '계약 끔', modelId: 'model-a', owner: 'kim' });

    expect(plan.status).toBe('done');
    expect(fake.contractCalls).toBe(0);
    // 계획 호출 한 번만 했다
    expect(fake.modelCalls).toBe(1);
    expect(plan.contracts).toBeUndefined();
    expect(plan.coordination).toBeUndefined();
    expect(plan.metrics?.contracts).toBeUndefined();
  });

  it('켜면 레인을 돌리기 전에 계약을 받아 S2로 게시하고, 계약 호출 지표를 따로 남긴다', async () => {
    process.env.B_STUDIO_PLAN_CONTRACTS = 'on';
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };
    fake.contractText = JSON.stringify({ contracts: [{ body: contractBody, refs: ['api'] }] });

    const created = await createTaskPlan({ projectId: 'orders', request: '계약 켬', modelId: 'model-a', owner: 'kim' });
    const waiting = await awaiting(created.id);

    // 승인 전에 계약을 받아 게시해 둔다(레인이 시작하기 전이어야 한다)
    expect(fake.contractCalls).toBe(1);
    expect(waiting.status).toBe('awaiting_approval');
    expect(fake.sessions.size).toBe(0);
    expect(waiting.coordination).toEqual({ strategy: 'S2', topology: 'mesh' });
    expect(waiting.contracts).toMatchObject({ source: 'model', count: 1 });
    expect(waiting.contracts?.usage).toEqual({ inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(typeof waiting.contracts?.durationMs).toBe('number');
    expect(waiting.board?.notes).toHaveLength(1);
    expect(waiting.board?.notes[0]).toMatchObject({ kind: 'contract', lane: 'plan', by: 'platform', refs: ['api'], body: contractBody });

    approveTaskPlan(created.id, 'kim');
    const plan = await finished(created.id);

    expect(plan.status).toBe('done');
    const laneSends = fake.sends.filter((send) => send.options.board);
    expect(laneSends).toHaveLength(2);
    // S2는 레인 읽기 전용이다(계약을 읽고 자기 몫만 만든다)
    expect(laneSends.every((send) => send.options.board!.modelWrites === false)).toBe(true);
    expect(laneSends.every((send) => send.request.includes('[조율] 시작 전에 read_notes로 공유된 계약을 확인하세요'))).toBe(true);
    // 계약 호출의 usage·시간을 따로 남기고, 호출 수·토큰 합계에도 넣는다(계획 1 + 계약 1 + 레인 2×2)
    expect(plan.metrics?.contracts).toEqual({
      count: 1,
      usage: { inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: expect.any(Number),
    });
    expect(plan.metrics?.modelCalls).toBe(6);
    expect(plan.metrics?.coordination).toMatchObject({ strategy: 'S2', posts: 1 });
  });

  it('계약을 받지 못하면 계약 없이 진행하고 경고 한 줄을 남긴다', async () => {
    process.env.B_STUDIO_PLAN_CONTRACTS = 'on';
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };
    // JSON이 없는 응답: 형식 오류로 계약을 못 받는다
    fake.contractText = '계약을 쓸 수 없습니다';

    const plan = await run({ projectId: 'orders', request: '계약 실패', modelId: 'model-a', owner: 'kim' });

    expect(plan.status).toBe('done');
    expect(plan.contracts?.source).toBe('model');
    expect(plan.contracts?.count).toBe(0);
    expect(plan.contracts?.warning).toContain('계약 없이 진행합니다');
    expect(plan.contracts?.warning).toContain('JSON을 찾지 못했습니다');
    // 실패해도 그때까지 쓴 토큰은 버리지 않는다
    expect(plan.contracts?.usage).toEqual({ inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(plan.metrics?.contracts?.count).toBe(0);
    // 계약이 없으므로 S2 게시판도 붙지 않고, 레인은 조율 없이 그대로 돈다
    expect(plan.coordination).toBeUndefined();
    expect(plan.board).toBeUndefined();
    expect(fake.sends.filter((send) => send.options.board)).toHaveLength(0);
  });

  it('레인이 하나면 계약을 받지 않는다', async () => {
    process.env.B_STUDIO_PLAN_CONTRACTS = 'on';
    fake.plan = { tasks: [task('a', ['web/a'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' } };

    const plan = await run({ projectId: 'orders', request: '레인 하나', modelId: 'model-a', owner: 'kim' });

    expect(plan.status).toBe('done');
    expect(fake.contractCalls).toBe(0);
    expect(plan.contracts).toBeUndefined();
    expect(plan.coordination).toBeUndefined();
  });

  it('조율 입력이 있으면(벤치 고정 계약) 모델을 부르지 않고 그 계약을 쓴다', async () => {
    process.env.B_STUDIO_PLAN_CONTRACTS = 'on';
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };

    const created = await createTaskPlan({
      projectId: 'orders',
      request: '고정 계약',
      modelId: 'model-a',
      owner: 'kim',
      coordination: { strategy: 'S2', contracts: [{ body: contractBody, refs: ['api'] }] },
    });
    const waiting = await awaiting(created.id);

    expect(fake.contractCalls).toBe(0);
    // 사람이 쓴 계약이라 호출 지표가 없다
    expect(waiting.contracts).toBeUndefined();
    expect(waiting.board?.notes).toHaveLength(1);

    approveTaskPlan(created.id, 'kim');
    const plan = await finished(created.id);
    expect(plan.status).toBe('done');
    expect(plan.metrics?.contracts).toBeUndefined();
  });

  it('모델이 시크릿 값을 계약에 담으면 게시 전에 가린다', async () => {
    const secret = 'sk_test_contract_secret';
    process.env.B_STUDIO_PLAN_CONTRACTS = 'on';
    process.env.B_STUDIO_SECRET_PAYMENT_API_KEY = secret;
    fake.project = {
      spec: { name: 'orders' },
      managed: [['web', { template: 'nextjs', path: 'web' }]],
      secrets: [['PAYMENT_API_KEY', { services: ['web'] }]],
    };
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };
    fake.contractText = JSON.stringify({ contracts: [{ body: `GET /api/orders → 헤더 x-api-key: ${secret}`, refs: ['api'] }] });
    try {
      const created = await createTaskPlan({ projectId: 'orders', request: '계약 가림', modelId: 'model-a', owner: 'kim' });
      const waiting = await awaiting(created.id);

      const posted = waiting.board!.notes[0]!;
      expect(posted.body).not.toContain(secret);
      expect(posted.body).toContain('[PAYMENT_API_KEY 가림]');

      approveTaskPlan(created.id, 'kim');
      const plan = await finished(created.id);
      expect(plan.status).toBe('done');
    } finally {
      delete process.env.B_STUDIO_SECRET_PAYMENT_API_KEY;
    }
  });
});

/** 계획 JSON을 기록 폴더에 직접 써, 서버가 다시 뜨며 기록을 읽는 상황을 만든다 */
function writePlan(plan: Pick<TaskPlanView, 'id' | 'owner' | 'lanes'> & Partial<TaskPlanView>): void {
  const file = path.join(process.env.B_STUDIO_TASK_PLANS_DIR!, `${plan.id}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ projectId: 'orders', request: '재시작', modelId: 'model-a', status: 'running', createdAt: new Date().toISOString(), ...plan }));
}

function laneView(
  id: string,
  status: TaskPlanView['lanes'][number]['status'],
  overrides: Partial<TaskPlanView['lanes'][number]> = {},
): TaskPlanView['lanes'][number] {
  return { id, paths: ['web/a'], status, tasks: [], ...overrides };
}

/** 모듈 내부 캐시를 비우고 다시 읽어, 서버가 다시 시작된 것과 같은 상태를 만든다 */
async function restart(): Promise<typeof import('./task-plans')> {
  vi.resetModules();
  // 계획 상태는 전역에 있다(개발 서버의 페이지·API가 같은 상태를 보게). 재시작을 흉내 내려면 전역 상태도 비운다
  delete (globalThis as { __bStudioTaskPlans?: unknown }).__bStudioTaskPlans;
  return import('./task-plans');
}

/** 다시 읽은 모듈은 StudioError 클래스도 새로 만들어 instanceof가 깨지므로 상태 코드만 읽는다 */
function resumeStatus(action: () => unknown): number {
  try {
    action();
  } catch (error) {
    return (error as { status?: number }).status ?? 0;
  }
  throw new Error('오류가 나지 않았습니다');
}

async function settled(read: () => TaskPlanView): Promise<TaskPlanView> {
  for (let i = 0; i < 500; i++) {
    const plan = read();
    if (plan.status === 'done' || plan.status === 'failed') return plan;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('작업 계획이 끝나지 않았습니다');
}

describe('승인 뒤 이슈로 올리기', () => {
  it('publishIssues를 고르면 작업별 하위 이슈를 먼저 만들고 추적 이슈를 만든 뒤 GitHub 하위 이슈로 연결한다', async () => {
    process.env.B_STUDIO_GITHUB_TOKEN = 't';
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };

    const created = await createTaskPlan({ projectId: 'orders', request: '메모 추가', modelId: 'model-a', owner: 'kim' });
    await awaiting(created.id);
    approveTaskPlan(created.id, 'kim', { publishIssues: true });
    await finished(created.id);

    const plan = await untilIssues(created.id);
    // 하위 이슈 2개를 먼저 만들고 추적 이슈를 마지막에 만든다
    expect(fake.issues).toHaveLength(3);
    expect(fake.issues.slice(0, 2).sort()).toEqual(['a', 'b']);
    expect(fake.issues[2]).toBe('[작업 분해] 메모 추가');
    expect(plan.issues?.tracking).toEqual({ number: 3, url: 'https://github.com/acme/orders/issues/3' });
    expect(Object.values(plan.issues!.tasks).map((ref) => ref.number).sort()).toEqual([1, 2]);
    // GitHub이면 하위 이슈 API로 연결한다
    expect(fake.subIssues).toHaveLength(2);
    expect(plan.issues?.error).toBeUndefined();
  });

  it('GitHub가 아니면 하위 이슈 API 대신 추적 이슈 본문에 체크리스트를 넣는다', async () => {
    process.env.B_STUDIO_GITEA_TOKEN = 't';
    process.env.B_STUDIO_GIT_PROVIDER = 'gitea';
    fake.source = { base: 'main', originUrl: 'https://git.corp.local/dev/orders.git', dirtyFiles: 0, subdir: '' };
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };

    const created = await createTaskPlan({ projectId: 'orders', request: '메모 추가', modelId: 'model-a', owner: 'kim' });
    await awaiting(created.id);
    approveTaskPlan(created.id, 'kim', { publishIssues: true });
    await finished(created.id);

    const plan = await untilIssues(created.id);
    expect(fake.subIssues).toEqual([]);
    const tracking = fake.issueInputs.find((input) => input.title === '[작업 분해] 메모 추가')!;
    expect(tracking.body).toContain('- [ ] #1 a');
    expect(tracking.body).toContain('- [ ] #2 b');
    expect(plan.issues?.tracking?.number).toBe(3);
  });

  it('이슈 올리기가 실패해도 계획은 끝까지 돌고 이유만 남긴다', async () => {
    process.env.B_STUDIO_GITHUB_TOKEN = 't';
    fake.failIssue = true;
    fake.plan = { tasks: [task('a', ['web/a'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' } };

    const created = await createTaskPlan({ projectId: 'orders', request: '실패', modelId: 'model-a', owner: 'kim' });
    await awaiting(created.id);
    approveTaskPlan(created.id, 'kim', { publishIssues: true });
    const plan = await finished(created.id);

    expect(plan.status).toBe('done');
    const withError = await untilIssues(created.id);
    expect(withError.issues?.error).toContain('이슈를 만들지 못했습니다');
    expect(withError.issues?.tracking).toBeUndefined();
  });

  it('원격 저장소가 아니거나 토큰이 없거나 고르지 않으면 이슈를 만들지 않는다', async () => {
    fake.plan = { tasks: [task('a', ['web/a'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' } };

    // 저장소가 원격이 아니다 (토큰은 있어도)
    process.env.B_STUDIO_GITHUB_TOKEN = 't';
    fake.source = undefined;
    const noRemote = await createTaskPlan({ projectId: 'orders', request: '원격 아님', modelId: 'model-a', owner: 'kim' });
    await awaiting(noRemote.id);
    approveTaskPlan(noRemote.id, 'kim', { publishIssues: true });
    await finished(noRemote.id);

    // 원격이지만 토큰이 없다
    fake.source = { base: 'main', originUrl: 'git@github.com:acme/orders.git', dirtyFiles: 0, subdir: '' };
    delete process.env.B_STUDIO_GITHUB_TOKEN;
    const noToken = await createTaskPlan({ projectId: 'orders', request: '토큰 없음', modelId: 'model-a', owner: 'kim' });
    await awaiting(noToken.id);
    approveTaskPlan(noToken.id, 'kim', { publishIssues: true });
    await finished(noToken.id);

    // publishIssues를 고르지 않았다
    process.env.B_STUDIO_GITHUB_TOKEN = 't';
    const notAsked = await createTaskPlan({ projectId: 'orders', request: '고르지 않음', modelId: 'model-a', owner: 'kim' });
    await awaiting(notAsked.id);
    approveTaskPlan(notAsked.id, 'kim');
    await finished(notAsked.id);

    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const id of [noRemote.id, noToken.id, notAsked.id]) expect(getTaskPlan(id, 'kim').issues).toBeUndefined();
    expect(fake.issues).toEqual([]);
  });

  it('이미 이슈를 만든 계획은 다시 만들지 않는다', async () => {
    process.env.B_STUDIO_GITHUB_TOKEN = 't';
    writePlan({
      id: 'plan-issues-done',
      owner: 'kim',
      status: 'awaiting_approval',
      lanes: [],
      issues: { tracking: { number: 9, url: 'https://github.com/acme/orders/issues/9' }, tasks: { a: { number: 8, url: 'https://github.com/acme/orders/issues/8' } } },
    });

    const { approveTaskPlan: approve, getTaskPlan: read } = await restart();
    approve('plan-issues-done', 'kim', { publishIssues: true });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(fake.issues).toEqual([]);
    const plan = read('plan-issues-done', 'kim');
    expect(plan.issues?.tracking?.number).toBe(9);
    expect(plan.issues?.tasks.a?.number).toBe(8);
  });
});

describe('로컬 Claude Code로 계획 받기', () => {
  const optionKeys = ['B_STUDIO_MODE', 'B_STUDIO_CLAUDE_CODE_MODEL'] as const;
  const before = Object.fromEntries(optionKeys.map((key) => [key, process.env[key]]));

  afterAll(() => {
    for (const key of optionKeys) {
      const value = before[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('API 키 없이 계획을 받고, 기록에는 그 CLI 모델 id를 남긴다', async () => {
    process.env.B_STUDIO_MODE = 'claude-code';
    process.env.B_STUDIO_CLAUDE_CODE_MODEL = ' sonnet ';
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };

    const plan = await run({ projectId: 'orders', request: '두 화면 추가', owner: 'kim' });

    expect(plan.status).toBe('done');
    // 모델 레지스트리(유료 API 키)는 부르지 않는다 — 로컬 Claude Code 구독으로만 부른다
    expect(fake.modelCalls).toBe(0);
    expect(fake.claudeCodeCalls).toBe(1);
    // 이어서 하는 계획(resume)도 같은 규칙을 타도록 기록에 CLI 모델 id가 남는다(앞뒤 공백은 떼고)
    expect(plan.modelId).toBe('local-cli:sonnet');
    expect(fake.claudeCodeAsks[0]).toMatchObject({ model: 'sonnet' });
    // 계획 호출 토큰은 기존 계획 지표에 그대로 들어간다
    expect(plan.planning?.usage).toEqual({ inputTokens: 21, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 });
  });

  it('모델을 정하지 않았으면 계정 기본 모델로 부르고 기록은 local-cli:default다', async () => {
    process.env.B_STUDIO_MODE = 'claude-code';
    delete process.env.B_STUDIO_CLAUDE_CODE_MODEL;
    fake.plan = { tasks: [task('a', ['web/a'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' } };

    const plan = await run({ projectId: 'orders', request: '한 화면', owner: 'kim' });

    expect(plan.modelId).toBe('local-cli:default');
    expect(fake.claudeCodeAsks[0]?.model).toBeUndefined();
  });

  it('세션에서 이어받은 모델·노력 단계를 계획 호출과 레인·통합 세션에 그대로 넘긴다', async () => {
    process.env.B_STUDIO_MODE = 'claude-code';
    // 서버 기본 환경 변수는 다른 모델을 가리키지만, 넘긴 modelId가 이긴다(세션에서 이어받은 값이 우선이어야 한다)
    process.env.B_STUDIO_CLAUDE_CODE_MODEL = 'haiku';
    fake.plan = { tasks: [task('a', ['web/a'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' } };

    const plan = await run({ projectId: 'orders', request: '세션 모델 이어받기', owner: 'kim', modelId: 'sonnet', effort: 'medium' });

    expect(plan.status).toBe('done');
    // 기록에는 접두어가 붙지만(local-cli:sonnet), 계획 호출에는 별칭과 노력 단계를 그대로 넘긴다
    expect(plan.modelId).toBe('local-cli:sonnet');
    expect(plan.effort).toBe('medium');
    expect(fake.claudeCodeAsks[0]).toMatchObject({ model: 'sonnet', effort: 'medium' });
    // 레인·통합 세션에는 기록용 접두어(local-cli:)를 뗀 실제 별칭만 넘긴다 — 접두어가 그대로 가면 세션이 서버 기본으로 떨어진다(버그였다)
    expect(fake.sessionOptions.length).toBeGreaterThan(0);
    for (const options of fake.sessionOptions) {
      expect(options.modelId).toBe('sonnet');
      expect(options.effort).toBe('medium');
    }
  });

  it('세션에서 "기본"을 이어받으면(빈 문자열) 레인·통합 세션에 모델을 강제하지 않는다', async () => {
    process.env.B_STUDIO_MODE = 'claude-code';
    delete process.env.B_STUDIO_CLAUDE_CODE_MODEL;
    fake.plan = { tasks: [task('a', ['web/a'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' } };

    const plan = await run({ projectId: 'orders', request: '기본 이어받기', owner: 'kim', modelId: '' });

    expect(plan.modelId).toBe('local-cli:default');
    for (const options of fake.sessionOptions) expect(options.modelId).toBeUndefined();
  });

  it('계약도 같은 호출로 받는다(B_STUDIO_PLAN_CONTRACTS=on)', async () => {
    process.env.B_STUDIO_MODE = 'claude-code';
    process.env.B_STUDIO_PLAN_CONTRACTS = 'on';
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };

    try {
      const plan = await run({ projectId: 'orders', request: '두 화면', owner: 'kim' });

      // 계획 한 번 + 계약 한 번, 둘 다 같은 공용 함수(같은 ask 옵션)를 쓴다
      expect(fake.claudeCodeCalls).toBe(1);
      expect(fake.contractCalls).toBe(1);
      expect(plan.contracts).toMatchObject({ source: 'model', count: 1 });
      expect(plan.contracts?.usage).toEqual(fake.claudeCodeContractUsage);
    } finally {
      delete process.env.B_STUDIO_PLAN_CONTRACTS;
    }
  });

});

describe('deleteTaskPlan', () => {
  it('실행·통합·계획 짜는 중이면 지우지 않는다', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: 'fail', b: { 'web/b/one.md': 'b' } };
    const created = await createTaskPlan({ projectId: 'orders', request: '요청', modelId: 'model-a', owner: 'kim' });
    const waiting = await awaiting(created.id);
    expect(waiting.status).toBe('awaiting_approval');
    approveTaskPlan(created.id, 'kim');
    // 승인 직후에는 레인이 running 상태다(레인 하나가 실패로 끝나기 전)
    await expect(deleteTaskPlan(created.id, 'kim')).rejects.toThrow(/진행 중인 작업 계획/);
    await finished(created.id);
  });

  it('승인 대기 계획은 세션이 아직 없어 지우면 기록만 사라진다', async () => {
    fake.plan = { tasks: [task('a', ['web/a'])] };
    const created = await createTaskPlan({ projectId: 'orders', request: '요청', modelId: 'model-a', owner: 'kim' });
    await awaiting(created.id);

    await deleteTaskPlan(created.id, 'kim');

    expect(fake.stopAndDeleted).toEqual([]);
    expect(() => getTaskPlan(created.id, 'kim')).toThrow('찾을 수 없습니다');
    expect(() => readFileSync(path.join(process.env.B_STUDIO_TASK_PLANS_DIR!, `${created.id}.json`), 'utf8')).toThrow();
  });

  it('내 계획이 아니면 지울 수 없다', async () => {
    fake.plan = { tasks: [task('a', ['web/a'])] };
    const created = await createTaskPlan({ projectId: 'orders', request: '요청', modelId: 'model-a', owner: 'kim' });
    await awaiting(created.id);

    await expect(deleteTaskPlan(created.id, 'mallory')).rejects.toThrow(/볼 수 없습니다/);
  });

  it('끝난 계획을 지우면 레인·통합 세션 기록도 함께 지운다', async () => {
    fake.plan = { tasks: [task('a', ['web/a']), task('b', ['web/b'])] };
    fake.writes = { a: { 'web/a/one.md': 'one' }, b: { 'web/b/one.md': 'b' } };

    const plan = await run({ projectId: 'orders', request: '요청', modelId: 'model-a', owner: 'kim' });
    expect(plan.status).toBe('done');
    const laneSessionIds = plan.lanes.map((lane) => lane.sessionId!);
    const integrationId = plan.integration!.sessionId!;

    await deleteTaskPlan(plan.id, 'kim');

    expect(fake.stopAndDeleted.sort()).toEqual([...laneSessionIds, integrationId].sort());
    expect(() => getTaskPlan(plan.id, 'kim')).toThrow('찾을 수 없습니다');
    expect(() => readFileSync(path.join(process.env.B_STUDIO_TASK_PLANS_DIR!, `${plan.id}.json`), 'utf8')).toThrow();
  });

  it('없는 계획은 404로 알린다', async () => {
    await expect(deleteTaskPlan('nope', 'kim')).rejects.toThrow(/찾을 수 없습니다/);
  });
});
