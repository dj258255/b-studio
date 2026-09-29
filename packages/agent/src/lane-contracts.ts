/**
 * 레인 사이 인터페이스 계약을 한 번의 모델 호출로 받는다(S2 계약 먼저).
 *
 * 왜 필요한가: E2(docs/experiments/2026-09-29-e2-coordination-strategies.md)에서 격리 병렬(S1)은
 * api 응답과 web 화면이 엮인 과제에서 9회 중 4회만 성공했고, 실패는 모두 레인 경계의 필드 이름·모양 불일치였습니다.
 * 계약을 먼저 게시하면 9/9였지만 그 계약은 사람이 써 준 것이었습니다(ADR-059의 가장 큰 한계).
 * 여기서는 계획 모델이 같은 일을 하게 합니다.
 *
 * 원칙:
 *  - 제품(studio의 작업 분해)과 벤치가 **같은 프롬프트·같은 함수**로 계약을 받습니다. 벤치로 잰 것이 제품 동작이어야 합니다
 *  - 계획(레인·작업)은 그대로 두고 계약만 따로 받습니다. 벤치에서 고정 계획을 유지한 채 계약 출처만 바꿀 수 있습니다
 *  - 기본값은 끔(제품). 효과를 재기 전에는 켜지 않습니다
 *
 * 계약은 레인 시작 전에 S2 게시판에 contract 메모로 게시되므로, body에는 두 레인이 합의해야 하는 것만 들어갑니다.
 * 게시판은 contract 메모에 refs가 하나 이상 있어야 받습니다(Board.validate). 모델이 refs를 비우면 계약을 버리지 않고
 * 모든 레인의 첫 쓰기 경로로 채웁니다 — refs가 빠졌다는 이유로 계약이 게시되지 않으면 모델 계약의 효과를 낮게 재게 됩니다.
 *
 * 프롬프트의 예시는 벤치 과제(주문)와 무관한 영역(책)으로 둡니다. 예시가 과제의 필드 이름을 담으면 모델 계약이 답을 베낀 셈이 됩니다.
 */
import type { LoadedProject } from '@b-studio/spec';
import { z } from 'zod';
import type { AgentUsage, ModelClient } from './loop';
import { parsePlannerReply, TaskPlanError, usageFromMessage, type ModelAsk, type ModelAskInput, type TaskLane } from './task-plan';

/** 한 계획에 받는 계약 수 상한 */
export const MAX_LANE_CONTRACTS = 6;
export const CONTRACT_BODY_MAX = 1_200;
export const CONTRACT_REFS_MAX = 8;

export const LaneContractSchema = z.object({
  /** 맞물리는 인터페이스 하나. 필드 이름·형·중첩을 정확히 적는다 */
  body: z.string().min(1).max(CONTRACT_BODY_MAX),
  /** 이 인터페이스에 속한 경로(api 경로나 양쪽이 만지는 파일) */
  refs: z.array(z.string().min(1).max(200)).max(CONTRACT_REFS_MAX).default([]),
});

export const LaneContractsSchema = z.object({ contracts: z.array(LaneContractSchema).max(MAX_LANE_CONTRACTS) });

export type LaneContract = z.infer<typeof LaneContractSchema>;

/**
 * 모델을 부르는 방법을 바깥에서 준다. 제품은 ModelClient나 로컬 CLI 한 번 호출로, 벤치는 API 클라이언트나 로컬 CLI로 채운다.
 * 계약 받기가 러너에 묶이지 않아야 같은 프롬프트를 제품과 벤치가 함께 쓸 수 있다.
 * 모양은 계획 호출(task-plan의 PlanAsk)과 같아 공용 타입(ModelAsk)을 그대로 쓴다.
 */
export type ContractAskInput = ModelAskInput;
export type ContractAsk = ModelAsk;

const ZERO_USAGE: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * 계약 시스템 프롬프트. 계획 프롬프트(buildPlannerSystem)와 **다른 문구로 시작해야** 합니다:
 * 벤치 프록시가 system이 "You split a web development request"로 시작하고 도구가 없는 요청을 계획 요청으로 보고
 * 고정 계획 JSON을 돌려주기 때문입니다(proxy.ts의 isPlannerRequest). 그 접두사와 겹치면 계약 호출이 계획 응답을 받습니다.
 */
export function buildContractSystem(project: LoadedProject): string {
  const services = project.managed.map(([name, service]) => `- ${name}: ${service.template}, 폴더 ${service.path}`).join('\n');
  return `You write the interface contracts between parallel coding agents for project "${project.spec.name}".
Services:
${services}

The agents run at the same time in separate workspaces and cannot see each other's code. Write down ONLY the interfaces where two agents must agree: an endpoint one agent serves and another calls, the shape of that response, a field name both sides use.
Reply with ONLY a JSON object: {"contracts":[{"body":"...","refs":["..."]}]}
Rules:
- Each body is one interface, in exactly this shape: "GET /api/books/{id} → 200 JSON, 404 if missing. Fields: id(number), title(string), authors(array of {name(string)}), note(string|null)"
- Name every field exactly, with its type (string, number, boolean, array, object, null) and say whether a value is a list or a map (for example "countsByGenre(object map: genre→count)").
- Include the request (method, path, query or body fields) and the response status codes.
- Do not write anything only one agent uses: private helpers, internal state, styling, refactors.
- refs are the paths this interface belongs to (the api path, or a file both sides touch).
- If no two agents share an interface, reply {"contracts":[]}.
- At most ${MAX_LANE_CONTRACTS} contracts. Do not invent interfaces the request does not imply.`;
}

/** 레인별 작업 요청과 쓰기 경로를 계약 판단에 필요한 만큼만 요약한다 */
export function buildContractUser(request: string, lanes: readonly TaskLane[]): string {
  const laneText = lanes
    .map((lane) => {
      const tasks = lane.tasks.map((task) => `  · ${task.id} (${task.title}): ${task.request}`).join('\n');
      return `- ${lane.id} · 쓰기 경로: ${lane.paths.join(', ')}\n${tasks}`;
    })
    .join('\n');
  return `전체 요청: ${request}

레인 (동시에 실행되고 서로의 코드를 보지 못합니다):
${laneText}`;
}

/** ModelClient로 계약을 받는다. tools를 주지 않고(계획 호출과 같은 방식) usage 매핑도 requestTaskPlan과 같다 */
export function contractAskFromClient(client: ModelClient): ContractAsk {
  return async ({ system, user }, signal) => {
    const message = await client.createMessage({ system, tools: [], messages: [{ role: 'user', content: user }] }, signal);
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    return { text, usage: usageFromMessage(message.usage) };
  };
}

export interface LaneContractsResult {
  contracts: LaneContract[];
  usage: AgentUsage;
  durationMs: number;
}

/**
 * 계약을 한 번 받아 검증한다. 형식이 틀리면 TaskPlanError를 던지고, 그때까지 쓴 usage·시간을 오류에 붙인다
 * (계획 호출과 같은 규칙 — 실패해도 토큰을 잃지 않게).
 * 레인이 하나면 레인 사이 경계가 없으므로 모델을 부르지 않는다.
 */
export async function requestLaneContracts(
  ask: ContractAsk,
  project: LoadedProject,
  request: string,
  lanes: readonly TaskLane[],
  signal?: AbortSignal,
): Promise<LaneContractsResult> {
  if (lanes.length < 2) return { contracts: [], usage: { ...ZERO_USAGE }, durationMs: 0 };

  const started = performance.now();
  const answer = await ask({ system: buildContractSystem(project), user: buildContractUser(request, lanes) }, signal);
  const durationMs = Math.round(performance.now() - started);
  try {
    const parsed = LaneContractsSchema.safeParse(parsePlannerReply(answer.text));
    if (!parsed.success) {
      throw new TaskPlanError(`레인 계약 형식이 올바르지 않습니다: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    }
    const fallbackRefs = [...new Set(lanes.map((lane) => lane.paths[0]!).filter(Boolean))];
    const contracts = parsed.data.contracts.map((contract) => (contract.refs.length > 0 ? contract : { ...contract, refs: fallbackRefs }));
    return { contracts, usage: answer.usage, durationMs };
  } catch (error) {
    if (error instanceof TaskPlanError) {
      error.usage = answer.usage;
      error.durationMs = durationMs;
    }
    throw error;
  }
}
