import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isInScope, MAX_PLAN_LANES, planLanes, requestTaskPlan, runTaskGraph, TaskPlanError, type AgentUsage, type RunMetrics, type ScriptedTurn, type TaskLane } from '@b-studio/agent';
import type { Checkpoint } from '@b-studio/agent';
import type { StudioEvent } from '@/lib/studio-events';
import { summarizeTaskPlan } from '@/lib/task-plan-metrics';
import type { TaskPlanCheckpointView, TaskPlanIntegrationView, TaskPlanLaneView, TaskPlanStepStatus, TaskPlanView } from '@/lib/task-plan-types';
import { StudioError } from './errors';
import { clientForModel, listModelOptions, modelById } from './model-registry';
import { findProject } from './projects';
import { createSession, getSnapshot, sendMessage, stopSession, subscribe } from './sessions';

/**
 * 한 요청을 작업 계획으로 나눠 실행한다.
 *  1. 모델이 작업·쓰기 범위·의존 관계를 JSON으로 제안하고 planLanes가 검증한다 (틀리면 실행하지 않는다)
 *  2. 검증을 통과한 계획은 사람이 승인할 때까지 멈춘다. 승인 없이는 어떤 레인 세션도 만들지 않는다
 *  3. 의존 관계로 이어진 작업은 한 세션(레인)에서 차례로, 독립 레인은 서로 다른 세션에서 동시에 돌린다
 *     작업마다 쓰기 범위를 실행기 정책으로 걸어 레인끼리 변경이 겹치지 않게 한다
 *  4. 모든 레인이 게이트를 통과하면 새 세션에서 레인들의 최종 파일을 같은 루프·게이트로 다시 적용해 합친 결과를 검증한다
 * 자동 병합·푸시·배포는 하지 않는다. 통합 세션의 체크포인트를 사람이 검토하고 기존 흐름(PR·배포 조건)으로 넘긴다
 */
const MAX_REQUEST = 20_000;
const BOOT_TIMEOUT_MS = 20 * 60_000;
const RUN_TIMEOUT_MS = 30 * 60_000;
/** 통합 세션에 다시 쓸 파일 하나의 상한. 생성물이나 바이너리가 레인 결과에 섞였을 때 통합을 멈춘다 */
const MAX_INTEGRATION_FILE_BYTES = 256 * 1024;

const plans = new Map<string, TaskPlanView>();
let loaded = false;

export async function createTaskPlan(input: {
  projectId: string;
  request: string;
  modelId: string;
  owner: string;
  /**
   * 서버 안에서만 넘긴다(벤치마크·테스트). HTTP 라우트는 이 필드를 넘기지 않는다.
   * ADR-051에서 쓰기 범위를 서버 안에서만 넘긴 것과 같은 규칙이다.
   * 있으면 모델 레지스트리 확인을 건너뛰고 이 계획을 planLanes로 검증해 쓴다.
   */
  presetPlan?: unknown;
}): Promise<TaskPlanView> {
  const mode = process.env.B_STUDIO_MODE?.trim() || 'api';
  const preset = input.presetPlan;
  if (preset === undefined) {
    if (mode !== 'api') throw new StudioError(409, '작업 분해는 B_STUDIO_MODE=api에서만 사용할 수 있습니다');
  } else if (mode !== 'api' && mode !== 'claude-code') {
    // 고정 계획은 모델을 부르지 않으므로 claude-code 모드에서도 쓴다. demo는 지금처럼 거부한다
    throw new StudioError(409, '고정 계획은 B_STUDIO_MODE=api 또는 claude-code에서만 사용할 수 있습니다');
  }
  const request = input.request.trim();
  if (!request) throw new StudioError(400, '요청 내용을 입력하세요');
  if (request.length > MAX_REQUEST) throw new StudioError(400, `요청은 ${MAX_REQUEST.toLocaleString()}자까지 입력할 수 있습니다`);

  let modelId = input.modelId;
  if (preset === undefined) {
    const model = listModelOptions().find((candidate) => candidate.id === input.modelId && candidate.enabled !== false);
    if (!model) throw new StudioError(400, `등록되지 않은 모델입니다: ${input.modelId}`);
    if (!model.configured) throw new StudioError(400, `${model.label}의 API 키 환경 변수가 설정되지 않았습니다`);
    if (!model.capabilities.includes('tools')) throw new StudioError(400, `${model.label}은 Coding Agent 도구 호출을 지원하지 않습니다`);
    modelId = model.id;
  } else {
    // 고정 계획에는 모델 호출이 없다. modelId는 기록용이라 비어 있으면 안 된다
    if (!modelId.trim()) throw new StudioError(400, 'modelId가 필요합니다');
    modelId = modelId.trim();
  }

  const project = await findProject(input.projectId);
  if (!project) throw new StudioError(404, '프로젝트를 찾을 수 없습니다');

  ensureLoaded();
  const plan: TaskPlanView = {
    id: randomUUID().slice(0, 8),
    owner: input.owner,
    projectId: input.projectId,
    request,
    modelId,
    status: 'planning',
    createdAt: new Date().toISOString(),
    lanes: [],
    ...(preset === undefined ? {} : { preset: true as const }),
  };
  plans.set(plan.id, plan);
  persist(plan);
  void execute(plan, preset).catch((error: unknown) => fail(plan, describe(error)));
  return clone(plan);
}

export function listTaskPlans(owner: string): TaskPlanView[] {
  ensureLoaded();
  return [...plans.values()]
    .filter((plan) => plan.owner === owner)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 30)
    .map(clone);
}

export function getTaskPlan(id: string, owner: string): TaskPlanView {
  return clone(findPlan(id, owner));
}

/** 계획을 찾아 소유자를 확인한다. 승인·거부도 같은 규칙을 쓴다 */
function findPlan(id: string, owner: string): TaskPlanView {
  ensureLoaded();
  const plan = plans.get(id);
  if (!plan) throw new StudioError(404, '작업 계획을 찾을 수 없습니다');
  if (plan.owner !== owner) throw new StudioError(403, '이 작업 계획을 볼 수 없습니다');
  return plan;
}

/** 사람이 계획을 승인하면 그때 레인 실행을 시작한다. 승인 전에는 세션을 만들지 않는다 */
export function approveTaskPlan(id: string, owner: string): TaskPlanView {
  const plan = findPlan(id, owner);
  if (plan.status !== 'awaiting_approval') throw new StudioError(409, '승인을 기다리는 계획이 아닙니다');
  plan.approvedBy = owner;
  plan.approvedAt = new Date().toISOString();
  persist(plan);
  void runApprovedPlan(plan).catch((error: unknown) => fail(plan, describe(error)));
  return clone(plan);
}

/** 사람이 계획을 거부하면 세션을 만들지 않고 멈춘다 */
export function rejectTaskPlan(id: string, owner: string, reason?: string): TaskPlanView {
  const plan = findPlan(id, owner);
  if (plan.status !== 'awaiting_approval') throw new StudioError(409, '승인을 기다리는 계획이 아닙니다');
  plan.status = 'rejected';
  plan.rejectedReason = reason?.trim() || undefined;
  plan.finishedAt = new Date().toISOString();
  persist(plan);
  return clone(plan);
}

/**
 * 재시작으로 멈춘 계획의 통합만 다시 시작한다.
 * 레인 세션은 이미 없어졌지만 남겨 둔 결과 기록이 있으므로 레인을 다시 돌리지 않고 합치는 단계만 반복한다
 */
export function resumeTaskPlan(id: string, owner: string): TaskPlanView {
  const plan = findPlan(id, owner);
  if (plan.status !== 'interrupted') throw new StudioError(409, '이어서 할 수 있는 계획이 아닙니다');
  plan.error = undefined;
  void integrate(plan).catch((error: unknown) => fail(plan, describe(error)));
  return clone(plan);
}

async function execute(plan: TaskPlanView, preset?: unknown): Promise<void> {
  const project = await findProject(plan.projectId);
  if (!project) return fail(plan, '프로젝트를 찾을 수 없습니다');

  let lanes: TaskLane[];
  try {
    if (preset === undefined) {
      const planned = await requestTaskPlan(clientForModel(modelById(plan.modelId)), project, plan.request);
      plan.planning = { usage: planned.usage, durationMs: planned.durationMs };
      lanes = planned.lanes;
    } else {
      // 고정 계획은 모델을 부르지 않는다. plan.planning은 남기지 않는다(모델 호출이 없었다)
      lanes = planLanes(preset);
    }
  } catch (error) {
    // 계획 검증이 실패해도 모델 호출에 쓴 토큰과 시간은 남긴다. 아래 fail()이 지표를 계산한다
    if (error instanceof TaskPlanError && error.usage) {
      plan.planning = { usage: error.usage, durationMs: error.durationMs ?? 0 };
    }
    return fail(plan, `작업 계획을 만들지 못했습니다: ${describe(error)}`);
  }
  plan.lanes = lanes.map((lane) => ({
    id: lane.id,
    paths: lane.paths,
    status: 'queued',
    tasks: lane.tasks.map((task) => ({ ...task, status: 'queued' })),
  }));
  // 사람이 승인할 때까지 여기서 멈춘다. 승인 없이 레인을 돌리지 않는다
  plan.status = 'awaiting_approval';
  persist(plan);
}

async function runApprovedPlan(plan: TaskPlanView): Promise<void> {
  plan.status = 'running';
  persist(plan);

  // 레인끼리는 의존 관계가 없으므로 작업 그래프로 동시에 돌린다. 한 레인이 실패해도 다른 레인은 끝까지 돌려 결과를 남긴다
  const results = await runTaskGraph(
    plan.lanes.map((lane) => ({ id: lane.id, run: () => runLane(plan, lane) })),
    { concurrency: MAX_PLAN_LANES },
  );
  const failed = results.filter((result) => result.status !== 'succeeded');
  if (failed.length > 0) return fail(plan, `레인이 게이트를 통과하지 못해 통합하지 않습니다: ${failed.map((result) => `${result.id} (${result.error})`).join(', ')}`);

  await integrate(plan);
}

async function runLane(plan: TaskPlanView, lane: TaskPlanLaneView): Promise<void> {
  lane.status = 'booting';
  lane.startedAt = new Date().toISOString();
  persist(plan);
  const bootStarted = performance.now();
  try {
    const snapshot = await createSession(plan.projectId, plan.owner, 'copy', { modelId: plan.modelId });
    lane.sessionId = snapshot.id;
    persist(plan);
    await waitForReady(snapshot.id);
    lane.bootMs = Math.round(performance.now() - bootStarted);
    lane.status = 'running';
    persist(plan);

    for (const [index, task] of lane.tasks.entries()) {
      task.status = 'running';
      persist(plan);
      const outcome = await runAndWait(snapshot.id, taskRequest(plan, lane, index), { by: plan.owner, writableScope: task.paths });
      task.run = { status: outcome.status, durationMs: outcome.durationMs, usage: outcome.usage, metrics: outcome.metrics };
      task.summary = outcome.summary;
      if (outcome.status !== 'done') {
        task.status = 'failed';
        for (const rest of lane.tasks.slice(index + 1)) rest.status = 'skipped';
        throw new Error(`${task.id}: ${outcome.status} ${outcome.summary}`);
      }
      task.status = 'done';
      task.checkpoint = checkpointView(getSnapshot(snapshot.id)?.checkpoints[0]);
      persist(plan);
    }
    lane.status = 'done';
    // 세션이 보관 처리된 뒤에도 통합이 결과를 다시 읽을 수 있게 작업 폴더와 바꾼 파일을 계획에 남긴다.
    // 체크포인트는 최신부터 정렬돼 있고 마지막은 세션 시작 체크포인트라 변경 목록에서 뺀다
    const finished = getSnapshot(snapshot.id);
    if (finished) {
      lane.workDir = finished.workDir;
      lane.changedFiles = [...new Set(finished.checkpoints.slice(0, -1).flatMap((checkpoint) => checkpoint.files))].sort();
    }
    persist(plan);
  } catch (error) {
    lane.status = 'failed';
    lane.error = describe(error);
    persist(plan);
    throw error;
  } finally {
    lane.finishedAt = new Date().toISOString();
    persist(plan);
  }
}

/** 레인 세션들의 최종 파일을 새 세션에 같은 루프·게이트로 다시 적용한다. git 병합 없이 합친 결과를 한 번 더 검증하기 위해서다 */
async function integrate(plan: TaskPlanView): Promise<void> {
  plan.status = 'integrating';
  const integration: TaskPlanIntegrationView = (plan.integration = { status: 'booting' as TaskPlanStepStatus, files: [] as string[], deleted: [] as string[] });
  persist(plan);

  const writes: Array<{ path: string; content: string }> = [];
  const deletes: string[] = [];
  try {
    for (const lane of plan.lanes) {
      // 재시작 뒤에는 레인 세션이 없어도 남겨 둔 기록으로 통합한다. 기록이 없으면 합칠 근거가 없으므로 멈춘다
      if (!lane.workDir || !lane.changedFiles) throw new Error(`${lane.id} 의 결과 기록이 없어 통합할 수 없습니다`);
      const workDir = lane.workDir;
      const changed = lane.changedFiles;
      const outside = changed.filter((file) => !isInScope(file, lane.paths));
      // 명령으로 만든 파일처럼 도구 게이트를 거치지 않은 변경도 체크포인트에는 들어온다. 범위 밖이면 합치지 않는다
      if (outside.length > 0) throw new Error(`${lane.id}가 쓰기 범위 밖 파일을 바꿨습니다: ${outside.join(', ')}`);
      for (const file of changed) {
        const content = await readFile(path.join(workDir, file)).catch(() => undefined);
        // 작업 폴더에 없는 파일은 레인이 지운 것이다. 지운 것도 통합이 함께 지운다
        if (!content) {
          deletes.push(file);
          continue;
        }
        if (content.byteLength > MAX_INTEGRATION_FILE_BYTES || content.includes(0)) throw new Error(`${lane.id}의 ${file}은 텍스트 파일로 다시 적용할 수 없습니다`);
        writes.push({ path: file, content: content.toString('utf8') });
      }
    }
    if (writes.length === 0 && deletes.length === 0) throw new Error('바꾼 파일이 없어 통합할 내용이 없습니다');
    // 레인 결과는 이미 메모리로 옮겼다. 통합 샌드박스를 띄우기 전에 레인 샌드박스를 내려, 동시에 뜨는 샌드박스를 레인 수 이하로 둔다
    await stopLaneSessions(plan);

    integration.startedAt = new Date().toISOString();
    const bootStarted = performance.now();
    const snapshot = await createSession(plan.projectId, plan.owner, 'copy', { modelId: plan.modelId });
    Object.assign(integration, { sessionId: snapshot.id });
    // 통합 세션의 원본에도 없는 파일은 지울 수 없다. delete_file이 실패하면 통합 전체가 멈추므로 지울 목록에서 뺀다
    const integrationRoot = getSnapshot(snapshot.id)?.workDir;
    if (!integrationRoot) throw new Error('통합 세션의 작업 폴더를 찾지 못했습니다');
    const removable = deletes.filter((file) => existsSync(path.join(integrationRoot, file)));
    // 레인이 만들었다가 지운 파일만 있으면 적용할 변경이 없다. 빈 턴은 게이트를 그냥 통과하므로 여기서 멈춘다
    if (writes.length === 0 && removable.length === 0) throw new Error('통합 세션에 적용할 변경이 없습니다 (레인이 만들었다가 지운 파일만 있었습니다)');
    integration.files = [...writes.map((write) => write.path), ...removable].sort();
    integration.deleted = removable;
    persist(plan);
    await waitForReady(snapshot.id);
    integration.bootMs = Math.round(performance.now() - bootStarted);
    integration.status = 'running';
    persist(plan);

    const turns: ScriptedTurn[] = [
      {
        toolCalls: [
          ...writes.map((write) => ({ name: 'write_file', input: { path: write.path, content: write.content } })),
          ...removable.map((file) => ({ name: 'delete_file', input: { path: file } })),
        ],
      },
      { text: `레인 ${plan.lanes.length}개의 결과(파일 ${writes.length}개, 삭제 ${removable.length}개)를 합쳤습니다.` },
    ];
    const outcome = await runAndWait(snapshot.id, `작업 분해 통합: ${plan.request}`, {
      by: plan.owner,
      scriptedTurns: turns,
      writableScope: [...new Set(plan.lanes.flatMap((lane) => lane.paths))],
    });
    integration.run = { status: outcome.status, durationMs: outcome.durationMs, usage: outcome.usage, metrics: outcome.metrics };
    if (outcome.status !== 'done') throw new Error(`합친 결과가 게이트를 통과하지 못했습니다: ${outcome.status} ${outcome.summary}`);
    Object.assign(integration, { status: 'done', checkpoint: checkpointView(getSnapshot(snapshot.id)?.checkpoints[0]) });
    plan.status = 'done';
    plan.finishedAt = new Date().toISOString();
    recordMetrics(plan);
    persist(plan);
  } catch (error) {
    Object.assign(integration, { status: 'failed', error: describe(error) });
    fail(plan, `통합하지 못했습니다: ${describe(error)}`);
  } finally {
    integration.finishedAt = new Date().toISOString();
    // 통합 전에 실패했어도 레인 세션의 자원은 돌려준다. 기록과 체크포인트는 남아 다시 열 수 있다
    await stopLaneSessions(plan);
    // finally에서 넣은 finishedAt이 파일에 남도록 마지막으로 저장한다
    persist(plan);
  }
}

async function stopLaneSessions(plan: TaskPlanView): Promise<void> {
  await Promise.all(plan.lanes.map((lane) => (lane.sessionId ? stopSession(lane.sessionId).catch(() => {}) : undefined)));
}

function taskRequest(plan: TaskPlanView, lane: TaskPlanLaneView, index: number): string {
  const task = lane.tasks[index]!;
  const previous = lane.tasks.slice(0, index).map((item) => `- ${item.title}`).join('\n');
  return `${task.request}

[작업 분해] 전체 요청: ${plan.request}
이 작업이 파일을 쓸 수 있는 경로: ${task.paths.join(', ')} (그 밖의 쓰기는 실행기가 막습니다)${previous ? `\n같은 작업 공간에서 먼저 끝난 작업:\n${previous}` : ''}`;
}

function waitForReady(sessionId: string): Promise<void> {
  return waitForEvent(
    sessionId,
    () => {
      const snapshot = getSnapshot(sessionId);
      if (snapshot?.status === 'ready') return { done: true };
      // 원인(샌드박스 기동 실패, 포트·자원 부족 등)을 그대로 남겨야 레인·통합 실패를 코드 문제와 환경 문제로 나눌 수 있다
      if (snapshot?.status === 'failed' || snapshot?.status === 'stopped') {
        return { done: true, error: `세션 ${sessionId}을 준비하지 못했습니다 (${snapshot.status}${snapshot.error ? `: ${snapshot.error}` : ''})` };
      }
      return { done: false };
    },
    BOOT_TIMEOUT_MS,
  );
}

async function runAndWait(
  sessionId: string,
  request: string,
  options: { by: string; writableScope?: readonly string[]; scriptedTurns?: ScriptedTurn[] },
): Promise<{ status: string; summary: string; usage?: AgentUsage; metrics?: RunMetrics; durationMs?: number }> {
  let finished: Extract<StudioEvent, { type: 'run_finished' }> | undefined;
  let runId: string | undefined;
  const unsubscribe = subscribe(sessionId, (event) => {
    if (event.type === 'run_finished' && (runId === undefined || event.runId === runId)) finished = event;
  });
  try {
    ({ runId } = sendMessage(sessionId, request, { allowBreaking: false, ...options }));
    await waitForEvent(sessionId, () => ({ done: finished?.runId === runId }), RUN_TIMEOUT_MS);
    return { status: finished!.status, summary: finished!.summary, usage: finished!.usage, metrics: finished!.metrics, durationMs: finished!.durationMs };
  } finally {
    unsubscribe();
  }
}

async function waitForEvent(sessionId: string, check: () => { done: boolean; error?: string }, timeoutMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    const result = check();
    if (result.error) throw new Error(result.error);
    if (result.done) return;
    if (Date.now() - started > timeoutMs) throw new Error(`세션 ${sessionId}이 ${Math.round(timeoutMs / 60_000)}분 안에 끝나지 않았습니다`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function checkpointView(checkpoint: Checkpoint | undefined): TaskPlanCheckpointView | undefined {
  return checkpoint ? { sha: checkpoint.sha, shortSha: checkpoint.shortSha, files: checkpoint.files } : undefined;
}

function fail(plan: TaskPlanView, error: string): void {
  plan.status = 'failed';
  plan.error = error;
  plan.finishedAt = new Date().toISOString();
  for (const lane of plan.lanes) {
    if (lane.status === 'queued') lane.status = 'skipped';
    for (const task of lane.tasks) if (task.status === 'queued') task.status = 'skipped';
  }
  recordMetrics(plan);
  persist(plan);
}

/** 계획 전체 지표를 기록한다. 이 계산이 예외를 던져도 계획의 상태 전이를 바꾸면 안 된다 */
function recordMetrics(plan: TaskPlanView): void {
  try {
    plan.metrics = summarizeTaskPlan(plan);
  } catch (error) {
    console.error('[b-studio] 작업 계획 지표를 계산하지 못했습니다', error);
  }
}

/** 통합이 레인 세션 없이 결과를 다시 읽으려면 작업 폴더와 바꾼 파일 기록이 있어야 한다 */
function hasResultRecord(lane: TaskPlanLaneView): boolean {
  return Boolean(lane.workDir && lane.changedFiles);
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    for (const name of readdirSync(/* turbopackIgnore: true */ root())) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(path.join(root(), name), 'utf8')) as TaskPlanView;
        if (!parsed?.id || !Array.isArray(parsed.lanes)) continue;
        // 서버가 재시작되면 진행 중이던 계획은 이어서 돌릴 수 없다. 끝나지 않은 채 멈춘 것으로 남긴다.
        // 승인 대기(awaiting_approval)는 진행 중이 아니므로 그대로 두고, 서버가 다시 떠도 승인을 기다린다
        if (parsed.status === 'planning' || parsed.status === 'running' || parsed.status === 'integrating') {
          // 레인이 모두 끝나 통합만 남았으면 샌드박스가 사라져도 통합만 다시 시도할 수 있게 남긴다.
          // 다만 그 결과를 다시 읽을 기록(작업 폴더·바꾼 파일)이 레인마다 있어야 한다. 기록이 없으면 이어서 할 수 없는데 안내만 하면 누를 때마다 실패한다
          const allLanesDone = parsed.lanes.length > 0 && parsed.lanes.every((lane) => lane.status === 'done');
          if (allLanesDone && parsed.integration?.status !== 'done') {
            if (parsed.lanes.every(hasResultRecord)) {
              parsed.status = 'interrupted';
              parsed.error = '스튜디오가 다시 시작됐습니다. 레인 결과는 남아 있으니 통합을 다시 시도할 수 있습니다.';
            } else {
              parsed.status = 'failed';
              parsed.error = '스튜디오가 다시 시작됐고 레인 결과 기록이 없어 이어서 할 수 없습니다';
            }
          } else {
            parsed.status = 'failed';
            parsed.error = '스튜디오가 다시 시작돼 진행 중이던 작업 계획을 멈췄습니다';
          }
        }
        plans.set(parsed.id, parsed);
      } catch {
        // 손상된 기록 하나 때문에 다른 계획을 못 보게 하지 않는다
      }
    }
  } catch {
    // 아직 기록 폴더가 없다
  }
}

function persist(plan: TaskPlanView): void {
  const directory = root();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${plan.id}.json`);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(plan, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

function root(): string {
  return path.resolve(/* turbopackIgnore: true */ process.env.B_STUDIO_TASK_PLANS_DIR ?? path.join(homedir(), '.cache', 'b-studio', 'task-plans'));
}

function clone(plan: TaskPlanView): TaskPlanView {
  return structuredClone(plan);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
