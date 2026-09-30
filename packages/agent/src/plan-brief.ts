/**
 * 계획-실행 분리(ADR-075). "계획은 큰 모델, 실행은 작은 모델"(Cognition Devin Fusion, Aider architect/editor와 같은 결)로,
 * 만들기(build) 요청 하나를 실행기(작은/싼 모델)에 넘기기 전에 계획 모델(크고/비싼 모델)이 먼저 짧은 계획을 쓰게 한다.
 *
 * PR 자동 리뷰(pr-review.ts)·작업 계획(task-plan.ts)과 같은 "도구 없이 한 번만 묻는다"(ModelAsk) 방식을 그대로 재사용한다 —
 * 계획 모델에게 파일 읽기·명령 실행 도구를 주지 않고, 요청과 프로젝트 요약만 준다. 응답은 JSON이 아니라 사람이 읽는
 * 계획 글이다(작업 계획처럼 실행기가 그대로 실행할 구조가 아니라, 실행기 모델이 참고할 안내이기 때문이다).
 */
import type { LoadedProject } from '@b-studio/spec';
import type { AgentUsage } from './loop';
import { classifyComplexity, estimateTokens } from './model-router';
import type { ModelAsk } from './task-plan';

/** 계획 글의 길이 상한(단어 수). 프롬프트로만 지키게 하고(하드 컷 없음), 화면에는 안내 문구로 남긴다 */
export const PLAN_BRIEF_MAX_WORDS = 1_200;

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
  const prompt = request.trim();
  if (!prompt) return false;
  return classifyComplexity(prompt, estimateTokens(prompt)) !== 'simple';
}

/** 계획 모델에게 줄 시스템 프롬프트. 프로젝트의 managed 서비스만 짧게 요약해 준다(전체 파일 트리를 싣지 않는다) */
export function buildPlanBriefSystem(project: LoadedProject): string {
  const services = project.managed.map(([name, service]) => `- ${name}: ${service.template}, 폴더 ${service.path}`).join('\n');
  return `You are a senior engineer writing an implementation plan for project "${project.spec.name}" that a smaller, cheaper coding agent will execute right after you.
Services:
${services}

Write the plan in Korean, as plain text (no JSON, no code fences), at most about ${PLAN_BRIEF_MAX_WORDS} words. Cover, in this order:
1. 바꿀 파일과 각 파일에서 할 일
2. 순서 있는 실행 단계
3. API·인터페이스 계약 결정(있다면; 없으면 "해당 없음"이라고만 쓴다)
4. 위험 요소
5. 완료를 확인할 방법(승인 기준)
Do not write any code. Do not restate the request verbatim — go straight to the plan. The executor will see this plan appended to the original request, so write it as instructions to that executor, not as a message back to the user.`;
}

/**
 * 계획 모델을 도구 없이 한 번 불러 계획 글을 받는다. 부르는 방법(claude-code CLI 또는 모델 레지스트리 클라이언트)은
 * 밖에서 준다(ModelAsk) — pr-review.ts·task-plan.ts와 같은 경계다.
 */
export async function requestPlanBrief(ask: ModelAsk, project: LoadedProject, request: string, signal?: AbortSignal): Promise<PlanBrief> {
  const started = performance.now();
  const { text, usage } = await ask({ system: buildPlanBriefSystem(project), user: request }, signal);
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
 * 실행기에게 줄 요청에만 이 함수의 결과를 쓴다. 실행 중 알게 된 사실이 계획과 어긋나면 실제 코드를 따르라고 명시한다 —
 * 계획은 안내이지 반드시 지켜야 할 규칙이 아니다(실행기가 도구로 실제 코드를 보며 판단할 수 있다).
 */
export function appendPlanToRequest(request: string, plan: string): string {
  return `${request}\n\n---\n[계획 — 다른(더 큰) 모델이 이 요청을 먼저 설계했습니다. 그대로 따르되, 실행 중 알게 된 사실이 실제 코드와 다르면 실제 코드를 따르세요]\n${plan.trim()}\n[계획 끝]\n---`;
}
