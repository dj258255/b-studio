import type { LoadedProject } from '@b-studio/spec';
import { z } from 'zod';
import type { AgentUsage, ModelClient } from './loop';
import { isProtectedPath } from './policy';

/**
 * 한 요청을 하위 작업으로 나눈 계획.
 * 서로 의존하는 작업은 앞 작업의 변경을 봐야 하므로 한 레인(한 세션)에서 차례로 돌리고,
 * 의존 관계가 없는 레인끼리만 다른 세션에서 동시에 돌린다. 레인마다 쓰기 범위가 겹치지 않아야 결과를 합칠 수 있다.
 */
export const MAX_PLAN_TASKS = 6;
export const MAX_PLAN_LANES = 3;
/** 설정으로 올릴 수 있는 절대 상한. 이 위는 스키마도 검증도 받지 않는다 */
export const MAX_PLAN_LANES_CAP = 8;
export const MAX_PLAN_TASKS_CAP = 16;

/** 계획 상한. 기본값은 위 상수와 같고, 실행기(studio)·벤치가 설정에서 읽어 넘긴다 */
export interface PlanLimits {
  /** 동시에 돌릴 수 있는 레인 수 */
  maxLanes: number;
  /** 한 계획이 만들 수 있는 작업 수 */
  maxTasks: number;
}

export const DEFAULT_PLAN_LIMITS: PlanLimits = { maxLanes: MAX_PLAN_LANES, maxTasks: MAX_PLAN_TASKS };

/**
 * 설정에서 계획 상한을 읽는다. `B_STUDIO_MAX_LANES`(1~8)·`B_STUDIO_MAX_PLAN_TASKS`(1~16), 기본 3·6.
 * 잘못된 값은 기본값으로 돌리고 이유를 경고로 남긴다 — 오타 하나로 계획 기능이 멈추는 것보다 낫다.
 */
export function planLimitsFromEnv(env: Record<string, string | undefined> = process.env): PlanLimits {
  return {
    maxLanes: readPlanLimit(env.B_STUDIO_MAX_LANES, 'B_STUDIO_MAX_LANES', MAX_PLAN_LANES, MAX_PLAN_LANES_CAP),
    maxTasks: readPlanLimit(env.B_STUDIO_MAX_PLAN_TASKS, 'B_STUDIO_MAX_PLAN_TASKS', MAX_PLAN_TASKS, MAX_PLAN_TASKS_CAP),
  };
}

/** 값 하나를 읽는다. 비었으면 기본값, 정수가 아니거나 1~상한 밖이면 경고하고 기본값 */
function readPlanLimit(raw: string | undefined, name: string, fallback: number, cap: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > cap) {
    console.warn(`[b-studio] ${name}=${value}을(를) 쓸 수 없습니다. 1~${cap} 사이 정수여야 합니다. 기본값 ${fallback}으로 진행합니다`);
    return fallback;
  }
  return parsed;
}

const TASK_ID = /^[a-z][a-z0-9-]{0,39}$/;
const SCOPE_PATH = z
  .string()
  .min(1)
  .refine((value) => !/^([a-zA-Z]:)?[\\/]/.test(value) && !value.split(/[\\/]/).includes('..'), '프로젝트 안의 상대 경로여야 합니다')
  .transform((value) => value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, ''))
  .refine((value) => value !== '' && value !== '.', '프로젝트 전체를 쓰기 범위로 둘 수 없습니다');

/**
 * 고정 계획(presetPlan)이 작업마다 지정할 수 있는 세션 백엔드. 실행기(studio)가 아는 값만 받는다.
 * 모델이 만든 계획(API 모드 계획 호출)에는 이 필드를 쓰지 않는다 — 계획 프롬프트는 바꾸지 않는다.
 */
export const PlanBackendSchema = z.enum(['api', 'claude-code', 'codex', 'commandcode', 'opencode']);
export type PlanBackend = z.infer<typeof PlanBackendSchema>;

export const TaskPlanSchema = z.object({
  tasks: z
    .array(
      z.object({
        id: z.string().regex(TASK_ID, '소문자·숫자·하이픈으로 된 작업 id여야 합니다'),
        title: z.string().min(1).max(80),
        request: z.string().min(1).max(4_000),
        /** 이 작업이 파일을 쓸 수 있는 경로. 실행기가 이 밖의 쓰기를 막는다 */
        paths: z.array(SCOPE_PATH).min(1).max(8),
        dependsOn: z.array(z.string()).default([]),
        /** 이 작업을 돌릴 세션 백엔드. 없으면 서버 모드. 같은 레인의 작업은 모두 같아야 한다(레인은 한 세션) */
        backend: PlanBackendSchema.optional(),
        /** 이 작업에 고정할 모델. 백엔드마다 뜻이 다르다(api=레지스트리 id, commandcode=cmd 모델 id, claude-code·codex=무시) */
        model: z.string().min(1).max(120).optional(),
      }),
    )
    .min(1)
    // 스키마는 절대 상한만 막는다. 설정값(기본 6)은 planLanes가 그 실행의 상한으로 따로 본다
    .max(MAX_PLAN_TASKS_CAP),
});

export type TaskPlan = z.infer<typeof TaskPlanSchema>;
export type PlannedTask = TaskPlan['tasks'][number];

export interface TaskLane {
  id: string;
  /** 의존 순서대로 정렬한 작업 */
  tasks: PlannedTask[];
  /** 레인에 속한 작업들의 쓰기 범위 합 */
  paths: string[];
}

export class TaskPlanError extends Error {
  /** 계획 검증이 실패해도 그때까지 쓴 계획 호출의 토큰과 시간을 남긴다 */
  usage?: AgentUsage;
  durationMs?: number;
}

/**
 * 계획을 검증하고 레인으로 묶는다. 모델이 만든 계획이라도 이 검사를 통과하지 못하면 실행하지 않는다.
 * 상한(작업 수·레인 수)은 그 실행의 설정값을 따른다 — 기본은 6·3이다
 */
export function planLanes(input: unknown, limits: PlanLimits = DEFAULT_PLAN_LIMITS): TaskLane[] {
  const parsed = TaskPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new TaskPlanError(`작업 계획 형식이 올바르지 않습니다: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  const tasks = parsed.data.tasks;
  if (tasks.length > limits.maxTasks) throw new TaskPlanError(`작업은 ${limits.maxTasks}개까지입니다 (계획: ${tasks.length}개)`);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) throw new TaskPlanError('작업 id가 중복됩니다');
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) throw new TaskPlanError(`${task.id}: 없는 작업 '${dependency}'에 의존합니다`);
      if (dependency === task.id) throw new TaskPlanError(`${task.id}: 자기 자신에게 의존할 수 없습니다`);
    }
  }

  // 의존 관계로 이어진 작업끼리 한 레인에 묶는다 (방향 없는 연결 요소)
  const parent = new Map(tasks.map((task) => [task.id, task.id]));
  const find = (id: string): string => {
    const root = parent.get(id)!;
    if (root === id) return id;
    const top = find(root);
    parent.set(id, top);
    return top;
  };
  for (const task of tasks) for (const dependency of task.dependsOn) parent.set(find(task.id), find(dependency));

  const groups = new Map<string, PlannedTask[]>();
  for (const task of tasks) {
    const root = find(task.id);
    groups.set(root, [...(groups.get(root) ?? []), task]);
  }

  const lanes = [...groups.values()].map((group, index) => {
    const ordered = topologicalOrder(group);
    // 한 레인의 작업은 한 세션에서 차례로 돈다. 백엔드·모델이 섞이면 세션 하나로 돌릴 수 없으므로 실행 전에 막는다
    const head = ordered[0]!;
    for (const task of ordered) {
      if (task.backend !== head.backend) throw new TaskPlanError(`같은 레인의 작업은 backend가 같아야 합니다: ${head.id}(${head.backend ?? '서버 기본'}) ↔ ${task.id}(${task.backend ?? '서버 기본'})`);
      if (task.model !== head.model) throw new TaskPlanError(`같은 레인의 작업은 model이 같아야 합니다: ${head.id}(${head.model ?? '기본'}) ↔ ${task.id}(${task.model ?? '기본'})`);
    }
    return { id: `lane-${index + 1}`, tasks: ordered, paths: [...new Set(ordered.flatMap((task) => task.paths))].sort() };
  });
  if (lanes.length > limits.maxLanes) throw new TaskPlanError(`동시에 돌릴 레인은 ${limits.maxLanes}개까지입니다 (계획: ${lanes.length}개)`);

  // 병렬 레인의 쓰기 범위가 겹치면 합칠 때 어느 쪽 결과가 맞는지 정할 수 없다. 실행 전에 막는다
  for (let a = 0; a < lanes.length; a++) {
    for (let b = a + 1; b < lanes.length; b++) {
      for (const left of lanes[a]!.paths) {
        const overlap = lanes[b]!.paths.find((right) => isProtectedPath(left, right) || isProtectedPath(right, left));
        if (overlap) throw new TaskPlanError(`병렬 레인의 쓰기 범위가 겹칩니다: ${lanes[a]!.id} '${left}' ↔ ${lanes[b]!.id} '${overlap}'`);
      }
    }
  }
  return lanes;
}

/** 파일이 그 작업(레인)의 쓰기 범위 안에 있는지. 명령으로 만든 파일처럼 도구 게이트를 거치지 않은 변경을 합치기 전에 다시 본다 */
export function isInScope(file: string, paths: readonly string[]): boolean {
  return paths.some((scope) => isProtectedPath(file, scope));
}

function topologicalOrder(tasks: PlannedTask[]): PlannedTask[] {
  const ids = new Set(tasks.map((task) => task.id));
  const ordered: PlannedTask[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (task: PlannedTask) => {
    const current = state.get(task.id);
    if (current === 'done') return;
    if (current === 'visiting') throw new TaskPlanError(`순환 의존성이 있습니다: ${task.id}`);
    state.set(task.id, 'visiting');
    for (const dependency of task.dependsOn) if (ids.has(dependency)) visit(byId.get(dependency)!);
    state.set(task.id, 'done');
    ordered.push(task);
  };
  for (const task of tasks) visit(task);
  return ordered;
}

/** 작업 계획을 받을 때 쓰는 시스템 프롬프트. 도구 없이 JSON만 받는다. 상한은 그 실행의 설정값을 따른다 */
export function buildPlannerSystem(project: LoadedProject, limits: PlanLimits = DEFAULT_PLAN_LIMITS): string {
  const services = project.managed.map(([name, service]) => `- ${name}: ${service.template}, 폴더 ${service.path}`).join('\n');
  return `You split a web development request for project "${project.spec.name}" into independent tasks for coding agents.
Services:
${services}

Reply with ONLY a JSON object: {"tasks":[{"id":"kebab-id","title":"short","request":"full instruction for one agent","paths":["folder/or/file the task may write"],"dependsOn":["id"]}]}
Rules:
- At most ${limits.maxTasks} tasks and at most ${limits.maxLanes} groups of dependent tasks (lanes) running at the same time. Use one task if the request is small. Do not split for the sake of splitting.
- paths are project-relative. An agent is blocked from writing anywhere else, so include every folder the task must change.
- Tasks that need another task's changes must list it in dependsOn; they run later in the same workspace.
- Tasks without dependencies run in parallel in separate workspaces, so their paths must not overlap.`;
}

/**
 * 모델 응답에서 JSON 객체를 꺼낸다. 코드 펜스나 앞뒤 설명이 있어도 첫 객체만 읽는다.
 * 계획 요청과 레인 사이 계약 요청이 함께 쓴다 — 그래서 문구에 "작업 계획"이라고 박아 두지 않는다
 */
export function parsePlannerReply(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const source = fenced ?? text;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end <= start) throw new TaskPlanError('모델 응답에서 JSON을 찾지 못했습니다');
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch (error) {
    throw new TaskPlanError(`모델 응답 JSON을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 모델을 부르는 방법을 바깥에서 준다(계획·레인 계약 공용). 부르는 쪽이 ModelClient를 주든,
 * 로컬 Claude Code CLI를 도구 없이 한 번 부르든, 같은 프롬프트·같은 검증을 쓰게 한다.
 */
export interface ModelAskInput {
  system: string;
  user: string;
}

export type ModelAsk = (input: ModelAskInput, signal?: AbortSignal) => Promise<{ text: string; usage: AgentUsage }>;

/** 계획 호출에 쓰는 이름. 레인 계약(lane-contracts의 ContractAsk)과 같은 모양이다 */
export type PlanAsk = ModelAsk;

/** ModelClient로 계획을 받는다. tools를 주지 않고(모델이 JSON만 내게) usage도 같은 규칙으로 옮긴다 */
export function planAskFromClient(client: ModelClient): PlanAsk {
  return async ({ system, user }, signal) => {
    const message = await client.createMessage({ system, tools: [], messages: [{ role: 'user', content: user }] }, signal);
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    return { text, usage: usageFromMessage(message.usage) };
  };
}

/**
 * 모델 응답의 usage를 세션 지표 모양으로 옮긴다. 계획 호출(requestTaskPlan)과
 * 레인 사이 계약 호출(lane-contracts)이 같은 매핑을 쓴다 — 두 곳이 갈라지면 토큰 합계를 비교할 수 없다.
 * loop.ts의 addUsage와 같은 규칙이다(그 함수는 세션 토큰 한도를 쓰므로 여기서 같은 모양으로 바꾼다).
 */
export function usageFromMessage(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): AgentUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * 모델에게 계획을 받아 검증까지 마친 레인을 돌려준다. 계획이 틀리면 한 작업으로 몰래 바꾸지 않고 실패시킨다.
 * 부르는 방법은 바깥에서 준다(PlanAsk) — API 모드는 ModelClient 어댑터, 로컬 CLI 모드는 도구 없는 한 번 호출.
 */
export async function requestTaskPlan(
  ask: PlanAsk,
  project: LoadedProject,
  request: string,
  signal?: AbortSignal,
  limits: PlanLimits = DEFAULT_PLAN_LIMITS,
): Promise<{ lanes: TaskLane[]; raw: unknown; usage: AgentUsage; durationMs: number }> {
  const started = performance.now();
  const answer = await ask({ system: buildPlannerSystem(project, limits), user: request }, signal);
  const durationMs = Math.round(performance.now() - started);
  const { text, usage } = answer;
  try {
    const raw = parsePlannerReply(text);
    return { lanes: planLanes(raw, limits), raw, usage, durationMs };
  } catch (error) {
    // 계획 검증이 실패해도 호출에 쓴 토큰과 시간은 잃지 않도록 오류에 남겨 다시 던진다
    if (error instanceof TaskPlanError) {
      error.usage = usage;
      error.durationMs = durationMs;
    }
    throw error;
  }
}
