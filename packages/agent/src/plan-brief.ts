/**
 * 계획-실행 분리(ADR-075). "계획은 큰 모델, 실행은 작은 모델"(Cognition Devin Fusion, Aider architect/editor와 같은 결)로,
 * 만들기(build) 요청 하나를 실행기(작은/싼 모델)에 넘기기 전에 계획 모델(크고/비싼 모델)이 먼저 짧은 계획을 쓰게 한다.
 *
 * PR 자동 리뷰(pr-review.ts)·작업 계획(task-plan.ts)과 같은 "도구 없이 한 번만 묻는다"(ModelAsk) 방식을 그대로 재사용한다 —
 * 계획 모델에게 파일 읽기·명령 실행 도구를 주지 않고, 요청과 프로젝트 요약만 준다. 응답은 JSON이 아니라 사람이 읽는
 * 계획 글이다(작업 계획처럼 실행기가 그대로 실행할 구조가 아니라, 실행기 모델이 참고할 안내이기 때문이다).
 *
 * E8([docs/experiments/2026-09-30-e8-plan-execute-split.md](../../../docs/experiments/2026-09-30-e8-plan-execute-split.md))은
 * 계획을 받은 Haiku가 Haiku 단독보다 파일 쓰기 3배, 고치기 4.5배, 턴 2배, 최대 문맥 2배를 써 비용이 538% 늘고 성공은
 * 오히려 줄었다는 것을 쟀다. 계획 텍스트를 남기지 못해 확신하지는 못했지만, 도구 호출 수로 미루어 계획이 요청보다
 * 큰 설계(파일 분리, 요청에 없는 확인 단계)를 적었다는 추론이었다. 아래 프롬프트는 그 추론을 근거로 계획을
 * "요청이 요구하는 최소 변경"으로 좁힌다 — 새 파일·계층·테스트·리팩터·확인 단계를 금지하고, 계획 길이를 요청 크기에 맞춘다.
 *
 * 계획을 할지 판정하는 것(shouldPlanBrief·planWordLimit)과 프롬프트·붙이기 글자(buildPlanBriefSystem·appendPlanToRequest)는
 * Rust(crates/bstudio-guard/src/plan_brief.rs, ADR-191 3단계 3m)가 만들고, 이 파일은 같은 이름·시그니처의 껍데기다.
 * 상수(단어·글자 상한)는 여기서 정해 Rust로 넘긴다. 모델 호출(requestPlanBrief)은 여기 남는다.
 */
import { encodeNative, native } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import type { AgentUsage } from './loop';
import type { ModelAsk } from './task-plan';

/** 짧은 요청(문장 2개 이하)의 계획 글 길이 상한(단어 수) */
export const PLAN_BRIEF_MAX_WORDS_SHORT = 150;
/** 그 밖의 요청의 계획 글 길이 상한(단어 수) */
export const PLAN_BRIEF_MAX_WORDS_LONG = 400;
/**
 * appendPlanToRequest가 실행기에 붙이는 계획 글의 글자 수 상한. 단어 상한은 프롬프트로만 지키게 하므로(하드 컷 없음),
 * 계획 모델이 지시를 어기고 길게 써도 실행기 문맥을 부풀리지 못하도록 붙이는 단계에서 한 번 더 자른다(안전망).
 */
export const PLAN_BRIEF_MAX_CHARS = 3_000;

export interface PlanBrief {
  text: string;
  usage: AgentUsage;
  durationMs: number;
}

export class PlanBriefError extends Error {
  /** 계획 호출이 실패해도 그때까지 쓴 토큰과 시간은 남긴다(계획·리뷰 호출과 같은 규칙) */
  usage?: AgentUsage;
  durationMs?: number;
  constructor(message: string) {
    super(message);
    this.name = 'PlanBriefError';
  }
}

/**
 * 계획 호출을 할 만큼 요청이 큰지. 새 휴리스틱을 만들지 않고 모델 라우팅이 이미 쓰는 복잡도 판정
 * (model-router.ts의 classifyComplexity)을 그대로 재사용한다 — simple(짧고 평이한 요청)이면 계획 없이 바로 실행한다.
 * ask 의도(질문, 파일을 바꾸지 않음)는 호출하는 쪽(sessions.ts)이 먼저 걸러낸다.
 */
export function shouldPlanBrief(request: string): boolean {
  return native.shouldPlanBrief(request);
}

/**
 * 요청 문장 수로 계획 길이 상한을 고른다. 문장 종결 부호(.!?)나 줄바꿈으로 나눈 조각이 2개 이하면 짧은 요청으로 본다
 * (E8의 세 과제가 모두 한두 문장이었다). 그 밖에는 긴 요청 상한을 쓴다.
 */
export function planWordLimit(request: string): number {
  return native.planWordLimit(request, PLAN_BRIEF_MAX_WORDS_SHORT, PLAN_BRIEF_MAX_WORDS_LONG);
}

/** 계획 모델에게 줄 시스템 프롬프트. 프로젝트의 managed 서비스만 짧게 요약해 준다(전체 파일 트리를 싣지 않는다) */
export function buildPlanBriefSystem(project: LoadedProject, request: string): string {
  // 읽는 필드만 넘긴다(전체 LoadedProject를 보내지 않는다)
  const summary = { name: project.spec.name, managed: project.managed.map(([name, service]) => [name, { template: service.template, path: service.path }]) };
  return native.buildPlanBriefSystem(encodeNative(summary), request, PLAN_BRIEF_MAX_WORDS_SHORT, PLAN_BRIEF_MAX_WORDS_LONG);
}

/**
 * 계획 모델을 도구 없이 한 번 불러 계획 글을 받는다. 부르는 방법(claude-code CLI 또는 모델 레지스트리 클라이언트)은
 * 밖에서 준다(ModelAsk) — pr-review.ts·task-plan.ts와 같은 경계다.
 */
export async function requestPlanBrief(ask: ModelAsk, project: LoadedProject, request: string, signal?: AbortSignal): Promise<PlanBrief> {
  const started = performance.now();
  const { text, usage } = await ask({ system: buildPlanBriefSystem(project, request), user: request }, signal);
  const durationMs = Math.round(performance.now() - started);
  const trimmed = text.trim();
  if (!trimmed) {
    const error = new PlanBriefError('계획 모델이 빈 응답을 돌려줬습니다');
    error.usage = usage;
    error.durationMs = durationMs;
    throw error;
  }
  return { text: trimmed, usage, durationMs };
}

/**
 * 계획을 실행기에 넘길 요청 끝에 구분선으로 붙인다. 원래 요청은 한 글자도 바꾸지 않고(체크포인트 제목·기록은 원래 요청을 쓴다),
 * 실행기에게 줄 요청에만 이 함수의 결과를 쓴다. "참고 계획"이라고 불러 실행기가 계획을 요청보다 우선하는 지시로
 * 받아들이지 않게 하고, 요청 범위를 넘는 일은 하지 않는다고 못 박는다. 실행 중 알게 된 사실이 계획과 어긋나면
 * 실제 코드를 따르라고도 명시한다 — 계획은 안내이지 반드시 지켜야 할 규칙이 아니다.
 * 계획 모델이 길이 상한(프롬프트 지시)을 어겨도 실행기 문맥이 그대로 부풀지 않도록 PLAN_BRIEF_MAX_CHARS로 한 번 더 자른다.
 */
export function appendPlanToRequest(request: string, plan: string): string {
  return native.appendPlanToRequest(request, plan, PLAN_BRIEF_MAX_CHARS);
}
