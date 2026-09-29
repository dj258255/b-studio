import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  Board,
  failureNotesFromEvents,
  isInScope,
  MAX_PLAN_LANES,
  planLanes,
  requestTaskPlan,
  runTaskGraph,
  TaskPlanError,
  type AgentUsage,
  type BoardAccess,
  type Note,
  type RunMetrics,
  type ScriptedTurn,
  type TaskLane,
  type Topology,
} from '@b-studio/agent';
import type { Checkpoint } from '@b-studio/agent';
import { Redactor, resolveSecrets } from '@b-studio/sandbox';
import type { WorkflowPageCheck } from '@b-studio/spec';
import type { StudioEvent } from '@/lib/studio-events';
import { summarizeTaskPlan } from '@/lib/task-plan-metrics';
import type {
  TaskPlanBoardView,
  TaskPlanCheckpointView,
  TaskPlanIntegrationView,
  TaskPlanLaneView,
  TaskPlanNoteView,
  TaskPlanStepStatus,
  TaskPlanStrategy,
  TaskPlanView,
} from '@/lib/task-plan-types';
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
/** 계획별 조율 게시판. 서버 메모리에만 있고, 재시작하면 사라진다(그때는 조율 없이 이어서 한다) */
const boards = new Map<string, Board>();
/**
 * S3에서 모델이 게시판에 쓴 본문·refs를 게시 전에 가리는 가림기. 조율 모듈(coordination/)이 아니라
 * 실행기에서 만든다 — 게시판은 샌드박스·시크릿을 모르고, 값은 여기서만 다룬다.
 */
const redactors = new Map<string, Redactor>();
/**
 * 계획별 통합 게이트 전용 pageChecks(S 서버 안에서만 넘긴다). 레인 게이트는 그대로 두고 통합 세션에만 덧붙인다.
 * 게시판처럼 서버 메모리에만 있고 재시작하면 사라진다(그때는 통합을 다시 시도해도 확인 없이 돈다)
 */
const integrationPageChecks = new Map<string, readonly WorkflowPageCheck[]>();
let loaded = false;

/**
 * 조율 전략 S2~S5. presetPlan과 같은 규칙으로 서버 안에서만 넘긴다(HTTP 라우트는 받지 않는다).
 * 이 필드가 없으면 지금 동작(공유 없음)과 한 글자도 다르지 않다.
 *  - S2 계약 먼저: 계획의 인터페이스 계약을 레인 시작 전에 플랫폼이 게시. 레인은 읽기만
 *  - S3 게시판: 레인이 contract·fact를 쓰고 읽음. topology로 읽기 범위를 제한
 *  - S4 통합 후 수리: 공유 없음. 통합 게이트 실패 시 통합 세션에 모델 수리 요청 한 번
 *  - S5 실패 서명만: 작업마다 플랫폼이 검증 실패 서명을 게시. 레인은 읽기만(모델 쓰기 끔)
 */
export interface CoordinationInput {
  strategy: TaskPlanStrategy;
  /** 읽기 범위 topology. S3에서만 의미가 있고 기본 mesh */
  topology?: Topology;
  /** S2: 레인 시작 전에 플랫폼이 게시할 인터페이스 계약 */
  contracts?: Array<{ body: string; refs: string[] }>;
}

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
  /** 서버 안에서만 넘긴다(벤치마크·테스트). 조율 전략 S2~S5와 topology·계약. HTTP 라우트는 이 필드를 넘기지 않는다 */
  coordination?: CoordinationInput;
  /**
   * 서버 안에서만 넘긴다(벤치마크·테스트). 통합 게이트에만 덧붙일 pageChecks. HTTP 라우트는 이 필드를 넘기지 않는다.
   * presetPlan·coordination과 같은 규칙이다. 레인 게이트는 그대로 두고 통합 세션에만 더한다
   */
  integrationChecks?: { pageChecks?: WorkflowPageCheck[] };
}): Promise<TaskPlanView> {
  const mode = process.env.B_STUDIO_MODE?.trim() || 'api';
  const preset = input.presetPlan;
  if (preset === undefined) {
    if (mode !== 'api') throw new StudioError(409, '작업 분해는 B_STUDIO_MODE=api에서만 사용할 수 있습니다');
  } else if (mode !== 'api' && mode !== 'claude-code' && mode !== 'codex') {
    // 고정 계획은 모델을 부르지 않으므로 claude-code·codex 모드에서도 쓴다. demo는 지금처럼 거부한다
    throw new StudioError(409, '고정 계획은 B_STUDIO_MODE=api, claude-code 또는 codex에서만 사용할 수 있습니다');
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
  // S3만 모델이 게시판에 쓴다. 그 본문·refs는 계획 기록과 화면에 남으므로 게시 전에 프로젝트 시크릿 값을 가린다.
  // 가림은 조율 모듈이 아니라 실행기(여기)에서 한다. 샌드박스와 같은 값을 쓴다
  const redactor = input.coordination?.strategy === 'S3' ? new Redactor(await resolveSecrets(project)) : undefined;

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
  attachCoordination(plan, input.coordination, redactor);
  if (input.integrationChecks?.pageChecks?.length) integrationPageChecks.set(plan.id, input.integrationChecks.pageChecks);
  persist(plan);
  void execute(plan, preset).catch((error: unknown) => fail(plan, describe(error)));
  return clone(plan);
}

/**
 * 조율을 켠 계획에 게시판을 붙인다. S2·S5는 모델 쓰기를 끄고(레인은 읽기만), S3만 레인이 쓴다.
 * 게시판은 계획이 끝나면 함께 사라진다(저장하지 않는다). 상태는 plan.board로 복사해 기록에 남긴다.
 */
function attachCoordination(plan: TaskPlanView, input: CoordinationInput | undefined, redactor?: Redactor): void {
  if (!input) return;
  const topology = input.topology ?? 'mesh';
  const board = new Board({
    topology,
    hub: 'plan',
    // S2·S5는 레인 읽기 전용이다. 끄면 실행기가 post_note를 도구 목록에서 뺀다
    modelWrites: input.strategy === 'S3',
    onChange: () => {
      syncBoard(plan, board);
      persist(plan);
    },
  });
  boards.set(plan.id, board);
  if (redactor) redactors.set(plan.id, redactor);
  plan.coordination = { strategy: input.strategy, topology };
  if (input.strategy === 'S2') {
    // 계약은 레인 시작 전에 플랫폼이 한 번 게시한다. 같은 본문은 게시판이 중복으로 걸러 준다
    for (const contract of input.contracts ?? []) {
      board.post({ kind: 'contract', body: contract.body, refs: contract.refs }, { lane: 'plan', by: 'platform' });
    }
  }
  syncBoard(plan, board);
}

/** 게시판 상태를 계획 기록용으로 복사한다. 메모 id는 화면에 쓰지 않아 뺀다 */
function syncBoard(plan: TaskPlanView, board: Board): void {
  const view: TaskPlanBoardView = { notes: board.snapshot().map(noteView), stats: board.stats() };
  plan.board = view;
}

function noteView(note: Note): TaskPlanNoteView {
  return {
    kind: note.kind,
    body: note.body,
    refs: note.refs,
    lane: note.author.lane,
    ...(note.author.task !== undefined ? { task: note.author.task } : {}),
    by: note.author.by,
    ...(note.group !== undefined ? { group: note.group } : {}),
    priority: note.priority,
    at: note.at,
  };
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
    lane.bootRxBytes = bootRxBytes(snapshot.id);
    lane.status = 'running';
    persist(plan);

    for (const [index, task] of lane.tasks.entries()) {
      task.status = 'running';
      persist(plan);
      const board = laneBoard(plan, lane, task.id);
      const outcome = await runAndWait(snapshot.id, taskRequest(plan, lane, index), { by: plan.owner, writableScope: task.paths, ...(board ? { board } : {}) });
      // S5: 성공·실패와 무관하게 그 실행의 검증 실패 서명을 플랫폼이 게시해 다른 레인이 읽게 한다
      if (plan.coordination?.strategy === 'S5') postFailures(plan, lane, snapshot.id);
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
    // 통합 게이트에만 확인을 덧붙인다(레인·통합 모두 이 세션에서 파일을 적용한 뒤 같은 루프·게이트를 돈다)
    const extraPageChecks = integrationPageChecks.get(plan.id);
    const snapshot = await createSession(plan.projectId, plan.owner, 'copy', { modelId: plan.modelId, ...(extraPageChecks ? { extraPageChecks } : {}) });
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
    integration.bootRxBytes = bootRxBytes(snapshot.id);
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
    const writableScope = [...new Set(plan.lanes.flatMap((lane) => lane.paths))];
    const outcome = await runAndWait(snapshot.id, `작업 분해 통합: ${plan.request}`, { by: plan.owner, scriptedTurns: turns, writableScope });
    integration.run = runView(outcome);
    let settled = outcome;
    // S4: 통합 게이트가 실패하면 한 번만 통합 세션에 모델 수리를 요청한다(공유 없이 실패 뒤에만 비용을 내는 대조군).
    // scriptedTurns 없이 보내므로 세션의 기본 모델 경로(API 모드는 계획의 모델, 로컬 CLI는 그 러너)로 실제 호출된다
    if (outcome.status !== 'done' && plan.coordination?.strategy === 'S4') {
      const repair = await runAndWait(snapshot.id, repairRequest(plan, outcome.summary), { by: plan.owner, writableScope });
      integration.repair = { attempted: true, status: repair.status, run: runView(repair) };
      settled = repair;
    }
    if (settled.status !== 'done') throw new Error(`합친 결과가 게이트를 통과하지 못했습니다: ${settled.status} ${settled.summary}`);
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
  const request = `${task.request}

[작업 분해] 전체 요청: ${plan.request}
이 작업이 파일을 쓸 수 있는 경로: ${task.paths.join(', ')} (그 밖의 쓰기는 실행기가 막습니다)${previous ? `\n같은 작업 공간에서 먼저 끝난 작업:\n${previous}` : ''}`;
  // 조율을 켠 실행에서만 요청 끝에 한 줄을 더한다. 도구는 실행기가 알아서 목록에 넣는다
  const guidance = coordinationGuidance(plan.coordination?.strategy);
  return guidance ? `${request}\n${guidance}` : request;
}

function coordinationGuidance(strategy: TaskPlanStrategy | undefined): string | undefined {
  switch (strategy) {
    case 'S2':
      return '[조율] 시작 전에 read_notes로 공유된 계약을 확인하세요';
    case 'S3':
      return '[조율] 다른 레인과 맞물리는 인터페이스를 정하면 post_note(contract)로 남기고, 시작 전과 끝내기 전에 read_notes로 확인하세요';
    case 'S5':
      return '[조율] 시작 전에 read_notes로 다른 레인의 검증 실패를 확인하세요';
    default:
      // S4는 공유 없음. 레인에는 아무것도 넘기지 않는다
      return undefined;
  }
}

/**
 * 레인 작업 요청에 넘길 게시판 접근. 레인 id와 작업 id로 신원을 고정하고, 쓰기 여부는 전략이 정한다.
 * S4(공유 없음)이거나 게시판이 없으면 넘기지 않아 도구 목록이 지금과 같다.
 */
function laneBoard(plan: TaskPlanView, lane: TaskPlanLaneView, taskId: string): BoardAccess | undefined {
  const board = boards.get(plan.id);
  const strategy = plan.coordination?.strategy;
  if (!board || !strategy || strategy === 'S4') return undefined;
  const redactor = redactors.get(plan.id);
  // 모델이 쓴 본문·refs는 계획 기록과 화면에 남는다. 게시 전에 프로젝트 시크릿 값을 가린다(가림 형식은 샌드박스와 같다)
  const redact = (text: string) => (redactor ? redactor.redact(text) : text);
  return {
    lane: lane.id,
    task: taskId,
    modelWrites: board.modelWrites,
    // 계층 구조의 같은 그룹 비교(note.group === reader.group)가 성립하도록, 읽을 때와 같은 기준(laneGroup)으로 그룹을 넣는다
    post: (input) => {
      const group = laneGroup(lane);
      return board.post(
        { kind: input.kind, body: redact(input.body), ...(input.refs ? { refs: input.refs.map(redact) } : {}), ...(group !== undefined ? { group } : {}) },
        { lane: lane.id, task: taskId, by: 'model' },
      );
    },
    read: (options) => {
      const result = board.read({ lane: lane.id, group: laneGroup(lane) }, options);
      // 읽기 통계도 화면·지표에 남도록 스냅샷을 갱신한다(저장은 다음 상태 전이가 한다)
      syncBoard(plan, board);
      return result;
    },
  };
}

/** 계층 구조에서 같은 그룹으로 묶는 기준: 레인의 첫 쓰기 범위. 병렬 레인의 범위는 겹치지 않으므로 서로 다른 그룹이 된다 */
function laneGroup(lane: TaskPlanLaneView): string | undefined {
  return lane.paths[0];
}

/** S5: 레인 세션 기록에서 검증 실패 서명을 뽑아 플랫폼 이름으로 게시한다 */
function postFailures(plan: TaskPlanView, lane: TaskPlanLaneView, sessionId: string): void {
  const board = boards.get(plan.id);
  if (!board) return;
  for (const note of failureNotesFromEvents(readSessionEvents(sessionId))) {
    board.post({ kind: 'failure', body: note.body, refs: note.refs }, { lane: lane.id, by: 'platform' });
  }
}

/** 세션 기록을 다시 보내 주는 subscribe를 등록→즉시 해제해 통째로 읽는다. 읽기 실패는 빈 배열로 둔다 */
function readSessionEvents(sessionId: string): StudioEvent[] {
  const events: StudioEvent[] = [];
  try {
    const unsubscribe = subscribe(sessionId, (event) => events.push(event));
    unsubscribe();
  } catch {
    // 없는 세션이거나 기록을 읽지 못하면 서명도 없다
  }
  return events;
}

/** 기동 직후 세션 스냅샷이 읽은 수신 바이트 합. 못 읽었으면 undefined */
function bootRxBytes(sessionId: string): number | undefined {
  const network = getSnapshot(sessionId)?.bootNetwork;
  return network ? network.reduce((sum, entry) => sum + entry.rxBytes, 0) : undefined;
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
  options: { by: string; writableScope?: readonly string[]; scriptedTurns?: ScriptedTurn[]; board?: BoardAccess },
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

function runView(outcome: { status: string; durationMs?: number; usage?: AgentUsage; metrics?: RunMetrics }) {
  return { status: outcome.status, durationMs: outcome.durationMs, usage: outcome.usage, metrics: outcome.metrics };
}

/** S4: 통합 게이트 실패를 모델에 되돌려 준다. 원래 요청 + 실패 요약 + 쓰기 범위 안에서 고치라는 지시 */
function repairRequest(plan: TaskPlanView, summary: string): string {
  return `${plan.request}

[조율] 레인 ${plan.lanes.length}개의 결과를 합친 뒤 검증이 실패했습니다: ${summary}
쓰기 범위 안에서 고쳐 검증을 다시 통과시키세요.`;
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
