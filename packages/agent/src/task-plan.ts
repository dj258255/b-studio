import path from 'node:path';
import { encodeLoneSurrogates, native } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';
import { decodeLoneSurrogates } from './lone-surrogates';
import type { AgentUsage, ModelClient } from './loop';

/** Windows면 역슬래시도 구분자다. 판정은 Rust가 하고 플랫폼 값만 여기서 넘긴다 */
const BACKSLASH_SEP = path.sep === '\\';

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
 * 판정은 Rust(crates/bstudio-guard/src/task_plan.rs, ADR-191 3단계 3x)가 하고, 여기서는 경고만 찍는다
 */
export function planLimitsFromEnv(env: Record<string, string | undefined> = process.env): PlanLimits {
  const decided = JSON.parse(native.taskPlanLimits(env.B_STUDIO_MAX_LANES, env.B_STUDIO_MAX_PLAN_TASKS)) as { maxLanes: number; maxTasks: number; warnings: string[] };
  for (const warning of decided.warnings) console.warn(warning);
  return { maxLanes: decided.maxLanes, maxTasks: decided.maxTasks };
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
export const PlanBackendSchema = z.enum(['api', 'claude-code', 'codex', 'commandcode', 'opencode', 'gemini']);
export type PlanBackend = z.infer<typeof PlanBackendSchema>;

/**
 * 레인 조율 게시판(BoardAccess: post_note·read_notes)을 지원하는 백엔드 표. 판정은 이 한 곳에서만 한다
 * (이슈 #428, E12). 벤치(bench/coordination/backends.ts)와 실행기(task-plans.ts)가 이 표를 같이 본다.
 *
 * E12 전에는 commandcode·opencode·gemini 러너가 buildTools에 board를 넘기지 않아 실제로는 도구 목록에
 * post_note·read_notes가 오르지 않았다(혼합 레인 mesh 4/9, 모든 레인 claude-code 9/9, p=0.029).
 * 이 표에 넣은 백엔드는 그 배선이 끝난 것만 의미한다 — 새 백엔드를 추가하면서 board를 잊으면 여기 넣지
 * 않는 한 backendSupportsBoard가 false를 돌려줘 시작 전에 막힌다.
 */
export const BOARD_SUPPORTED_BACKENDS: ReadonlySet<PlanBackend> = new Set<PlanBackend>(['api', 'claude-code', 'codex', 'commandcode', 'opencode', 'gemini']);

/** 이 백엔드가 레인 조율 게시판을 지원하는지. 단일 진실 원천은 BOARD_SUPPORTED_BACKENDS다 */
export function backendSupportsBoard(backend: PlanBackend): boolean {
  return BOARD_SUPPORTED_BACKENDS.has(backend);
}

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
 * 상한(작업 수·레인 수)은 그 실행의 설정값을 따른다 — 기본은 6·3이다.
 * 형식(zod)은 여기서 읽고, 그 뒤의 판정(상한·id·의존·레인 나누기·의존 순서·backend/model 일치·병렬 레인의 쓰기 범위 겹침)은 Rust(ADR-191 3단계 3x)가 한다.
 * 글자는 `encodeLoneSurrogates`해서 보내고 오류 글과 레인 범위는 풀어 읽는다: 통과한 레인 범위가 쓰기 허용 목록이 되므로 짝 없는 서로게이트가 U+FFFD로 합쳐지면 안 된다
 */
export function planLanes(input: unknown, limits: PlanLimits = DEFAULT_PLAN_LIMITS): TaskLane[] {
  const parsed = TaskPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new TaskPlanError(`작업 계획 형식이 올바르지 않습니다: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  const tasks = parsed.data.tasks;
  const decided = JSON.parse(
    native.taskPlanLanes(
      JSON.stringify(
        tasks.map((task) => ({
          id: encodeLoneSurrogates(task.id),
          dependsOn: task.dependsOn.map(encodeLoneSurrogates),
          backend: task.backend,
          model: task.model === undefined ? undefined : encodeLoneSurrogates(task.model),
          paths: task.paths.map(encodeLoneSurrogates),
        })),
      ),
      limits.maxTasks,
      limits.maxLanes,
      BACKSLASH_SEP,
    ),
  ) as { error: string } | { lanes: Array<{ id: string; tasks: number[]; paths: string[] }> };
  if ('error' in decided) throw new TaskPlanError(decodeLoneSurrogates(decided.error));
  return decided.lanes.map((lane) => ({ id: lane.id, tasks: lane.tasks.map((index) => tasks[index]!), paths: lane.paths.map(decodeLoneSurrogates) }));
}

/**
 * 파일이 그 작업(레인)의 쓰기 범위 안에 있는지. 명령으로 만든 파일처럼 도구 게이트를 거치지 않은 변경을 합치기 전에 다시 본다.
 * 쓰기 범위는 허용 목록이다: 판정은 Rust(path_policy::is_within_scope, 좁게 맞춘다)가 하고, 글자는 단사로 바꿔 보낸다(짝 없는 서로게이트가 U+FFFD로 합쳐져 범위 밖이 범위 안이 되지 않게)
 */
export function isInScope(file: string, paths: readonly string[]): boolean {
  return native.taskPlanIsInScope(encodeLoneSurrogates(file), paths.map(encodeLoneSurrogates), BACKSLASH_SEP);
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
  // 코드 펜스는 마지막 펜스까지 잡는다 — 답 안의 문자열에 또 다른 펜스(```)가 있으면 처음 만나는 펜스에서 끊겨
  // JSON이 중간에 잘렸다(요구사항 추출처럼 긴 답에서 실제로 일어났다). JSON 글자를 꺼내는 규칙은 Rust(`requirements_replies.rs`, ADR-191 3단계 3ad)가 한다.
  // 글자는 `encodeLoneSurrogates`해서 보내고 결과는 `decodeLoneSurrogates`로 푼다. 꺼낸 글자를 읽는 것(`JSON.parse`·`jsonrepair`)은 여기서 한다
  const found = native.reqReplyExtractJson(encodeLoneSurrogates(text)).map(decodeLoneSurrogates);
  const candidate = found[0];
  if (candidate === undefined) throw new TaskPlanError('모델 응답에서 JSON을 찾지 못했습니다');
  try {
    return JSON.parse(candidate);
  } catch (error) {
    // 모델이 자주 내는 깨진 JSON(문자열 안의 이스케이프 안 된 큰따옴표, 잘린 끝, 끝 쉼표 등)은 한 번 고쳐서 읽는다.
    // 고친 결과는 이어지는 스키마 검사를 그대로 거치므로, 모양이 틀리면 거기서 걸러진다
    try {
      return JSON.parse(jsonrepair(found[1]!));
    } catch {
      throw new TaskPlanError(`모델 응답 JSON을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
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
