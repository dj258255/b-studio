import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';
import type { TaskPlanView } from '../task-plan-types';

type Checkpoint = { sha: string; shortSha: string; message: string; createdAt: string; files: string[] };
type Session = { id: string; status: 'ready'; workDir: string; checkpoints: Checkpoint[] };
type SendOptions = { allowBreaking: boolean; by?: string; writableScope?: readonly string[]; scriptedTurns?: Array<{ toolCalls?: Array<{ name: string; input: { path: string; content?: string } }> }> };

const fake = vi.hoisted(() => ({
  root: '',
  counter: 0,
  plan: {} as unknown,
  sessions: new Map<string, Session>(),
  listeners: new Map<string, Set<(event: StudioEvent) => void>>(),
  /** 작업 id → 그 작업이 쓸 파일. 없으면 실패로 끝낸다 */
  writes: {} as Record<string, Record<string, string> | 'fail'>,
  /** 작업 id → 그 작업이 지울 파일 */
  deletes: {} as Record<string, string[]>,
  /** 세션을 만들 때 작업 폴더에 넣는 프로젝트 원본 파일 */
  sourceFiles: {} as Record<string, string>,
  sends: [] as Array<{ sessionId: string; request: string; options: SendOptions }>,
  stopped: [] as string[],
  stopOrder: { integrationCreatedAfterStops: false },
}));

vi.mock('./model-registry', () => ({
  listModelOptions: () => [{ id: 'model-a', label: 'Model A', enabled: true, configured: true, capabilities: ['tools'] }],
  modelById: (id: string) => ({ id }),
  clientForModel: () => ({
    createMessage: async () => ({ content: [{ type: 'text', text: JSON.stringify(fake.plan) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
  }),
}));

vi.mock('./projects', () => ({
  findProject: async () => ({ spec: { name: 'orders' }, managed: [['web', { template: 'nextjs', path: 'web' }]] }),
}));

vi.mock('./sessions', () => ({
  createSession: async () => {
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
    fake.sessions.set(id, { id, status: 'ready', workDir, checkpoints: [{ sha: `${id}-start`, shortSha: 'start', message: '세션 시작', createdAt: '', files: [] }] });
    return { id };
  },
  getSnapshot: (id: string) => fake.sessions.get(id),
  stopSession: async (id: string) => {
    fake.stopped.push(id);
  },
  subscribe: (id: string, listener: (event: StudioEvent) => void) => {
    const set = fake.listeners.get(id) ?? new Set();
    set.add(listener);
    fake.listeners.set(id, set);
    return () => set.delete(listener);
  },
  sendMessage: (sessionId: string, request: string, options: SendOptions) => {
    fake.sends.push({ sessionId, request, options });
    const session = fake.sessions.get(sessionId)!;
    const runId = `run-${fake.sends.length}`;
    const taskId = /\[id:([a-z0-9-]+)\]/.exec(request)?.[1];
    const deleted = taskId ? (fake.deletes[taskId] ?? []) : [];
    const scripted = (options.scriptedTurns?.[0]?.toolCalls ?? []).filter((call) => call.name === 'write_file');
    const files = options.scriptedTurns
      ? Object.fromEntries(scripted.map((call) => [call.input.path, call.input.content ?? '']))
      : taskId
        ? fake.writes[taskId]
        : undefined;
    const finish = (status: 'done' | 'failed', summary: string) => {
      for (const listener of fake.listeners.get(sessionId) ?? []) listener({ type: 'run_finished', runId, status, summary } as StudioEvent);
    };
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
import { approveTaskPlan, createTaskPlan, getTaskPlan, rejectTaskPlan } from './task-plans';

const directory = mkdtempSync(path.join(tmpdir(), 'b-studio-task-plans-'));
const saved = { mode: process.env.B_STUDIO_MODE, dir: process.env.B_STUDIO_TASK_PLANS_DIR };

const task = (id: string, paths: string[], dependsOn: string[] = []) => ({ id, title: id, request: `[id:${id}] ${id} 작업`, paths, dependsOn });

beforeEach(() => {
  fake.root = mkdtempSync(path.join(directory, 'work-'));
  fake.counter = 0;
  fake.sessions.clear();
  fake.listeners.clear();
  fake.deletes = {};
  fake.sourceFiles = {};
  fake.sends = [];
  fake.stopped = [];
  fake.stopOrder.integrationCreatedAfterStops = false;
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_TASK_PLANS_DIR = path.join(directory, 'plans');
});

afterAll(() => {
  for (const [key, value] of [['B_STUDIO_MODE', saved.mode], ['B_STUDIO_TASK_PLANS_DIR', saved.dir]] as const) {
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
