import type { LoadedProject } from '@b-studio/spec';
import { z } from 'zod';
import type { ModelClient } from './loop';
import { isProtectedPath } from './policy';

/**
 * 한 요청을 하위 작업으로 나눈 계획.
 * 서로 의존하는 작업은 앞 작업의 변경을 봐야 하므로 한 레인(한 세션)에서 차례로 돌리고,
 * 의존 관계가 없는 레인끼리만 다른 세션에서 동시에 돌린다. 레인마다 쓰기 범위가 겹치지 않아야 결과를 합칠 수 있다.
 */
export const MAX_PLAN_TASKS = 6;
export const MAX_PLAN_LANES = 3;

const TASK_ID = /^[a-z][a-z0-9-]{0,39}$/;
const SCOPE_PATH = z
  .string()
  .min(1)
  .refine((value) => !/^([a-zA-Z]:)?[\\/]/.test(value) && !value.split(/[\\/]/).includes('..'), '프로젝트 안의 상대 경로여야 합니다')
  .transform((value) => value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, ''))
  .refine((value) => value !== '' && value !== '.', '프로젝트 전체를 쓰기 범위로 둘 수 없습니다');

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
      }),
    )
    .min(1)
    .max(MAX_PLAN_TASKS),
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

export class TaskPlanError extends Error {}

/** 계획을 검증하고 레인으로 묶는다. 모델이 만든 계획이라도 이 검사를 통과하지 못하면 실행하지 않는다 */
export function planLanes(input: unknown): TaskLane[] {
  const parsed = TaskPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new TaskPlanError(`작업 계획 형식이 올바르지 않습니다: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  const tasks = parsed.data.tasks;
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
    return { id: `lane-${index + 1}`, tasks: ordered, paths: [...new Set(ordered.flatMap((task) => task.paths))].sort() };
  });
  if (lanes.length > MAX_PLAN_LANES) throw new TaskPlanError(`동시에 돌릴 레인은 ${MAX_PLAN_LANES}개까지입니다 (계획: ${lanes.length}개)`);

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

/** 작업 계획을 받을 때 쓰는 시스템 프롬프트. 도구 없이 JSON만 받는다 */
export function buildPlannerSystem(project: LoadedProject): string {
  const services = project.managed.map(([name, service]) => `- ${name}: ${service.template}, 폴더 ${service.path}`).join('\n');
  return `You split a web development request for project "${project.spec.name}" into independent tasks for coding agents.
Services:
${services}

Reply with ONLY a JSON object: {"tasks":[{"id":"kebab-id","title":"short","request":"full instruction for one agent","paths":["folder/or/file the task may write"],"dependsOn":["id"]}]}
Rules:
- At most ${MAX_PLAN_TASKS} tasks. Use one task if the request is small. Do not split for the sake of splitting.
- paths are project-relative. An agent is blocked from writing anywhere else, so include every folder the task must change.
- Tasks that need another task's changes must list it in dependsOn; they run later in the same workspace.
- Tasks without dependencies run in parallel in separate workspaces, so their paths must not overlap.`;
}

/** 모델 응답에서 JSON 객체를 꺼낸다. 코드 펜스나 앞뒤 설명이 있어도 첫 객체만 읽는다 */
export function parsePlannerReply(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const source = fenced ?? text;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end <= start) throw new TaskPlanError('작업 계획 응답에서 JSON을 찾지 못했습니다');
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch (error) {
    throw new TaskPlanError(`작업 계획 JSON을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 모델에게 계획을 받아 검증까지 마친 레인을 돌려준다. 계획이 틀리면 한 작업으로 몰래 바꾸지 않고 실패시킨다 */
export async function requestTaskPlan(client: ModelClient, project: LoadedProject, request: string, signal?: AbortSignal): Promise<{ lanes: TaskLane[]; raw: unknown }> {
  const message = await client.createMessage({ system: buildPlannerSystem(project), tools: [], messages: [{ role: 'user', content: request }] }, signal);
  const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
  const raw = parsePlannerReply(text);
  return { lanes: planLanes(raw), raw };
}
