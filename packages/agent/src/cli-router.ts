/**
 * CLI 백엔드(claude-code) 자동 모델 선택(ADR-089). ADR-047의 라우터(model-router.ts)는 가격·컨텍스트·실측 통계를 아는
 * 후보 여러 개의 점수를 매겨 고르지만, 이 프로젝트에서 로컬 Claude Code 구독에는 그런 후보 목록이 없다 — 로그인한
 * 계정의 별칭(haiku·sonnet·opus) 중 하나를 이름으로 고를 뿐이다. 그래서 이 모듈은 점수 계산이 아니라
 * "세 단계 중 하나를 고르는 규칙표"다. fable은 단가를 몰라 자동 선택 후보에 넣지 않는다(사용자가 대화에서 직접 고를 때만).
 *
 * 복잡도·위험도 분류는 ADR-047이 쓰는 classifyComplexity·classifyRisk(model-router.ts)를 그대로 재사용한다 —
 * "복잡하다/위험하다"의 뜻을 두 라우터가 따로 정의하지 않는다.
 *
 * E8(계획-실행 분리, docs/experiments/2026-09-30-e8-plan-execute-split.md)과 E9(2026-10-01)는 세션 안에서 모델을
 * 바꿀 때마다(계획 모델 ↔ 실행 모델) 프롬프트 캐시가 다시 만들어져 비용이 크게 뛰는 것을 쟀다
 * (E8-split은 단일 모델보다 성공 1건당 비용이 538% 많았다). 이 라우터는 그 결과를 반영해 매 요청 다시 계산하지 않고
 * "그대로 두는 쪽"에 기운다 — 세션 안에서 어떤 단계가 검증 게이트를 통과했으면, 읽기 전용 질문이 아닌 한
 * 뒤이은 만들기 요청에서 그 단계 아래로 내리지 않는다(stickiness).
 */
import { classifyComplexity, classifyRisk, estimateTokens, type RouteIntent, type RoutingDecision } from './model-router';

/** 자동 선택이 고를 수 있는 단계. 낮은 인덱스가 더 싸고 빠르다. fable은 단가를 몰라 여기 없다(명시적으로 고를 때만 쓴다) */
export const CLI_TIERS = ['haiku', 'sonnet', 'opus'] as const;
export type CliTier = (typeof CLI_TIERS)[number];

/** 사람이 읽는 단계 이름(대화 이벤트·화면 문구용) */
const TIER_LABELS: Record<CliTier, string> = { haiku: 'Haiku', sonnet: 'Sonnet 5', opus: 'Opus' };

export function tierLabel(tier: CliTier): string {
  return TIER_LABELS[tier];
}

function tierIndex(tier: CliTier): number {
  return CLI_TIERS.indexOf(tier);
}

/** tier보다 한 단계 위. 이미 최고 단계(opus)면 더 올릴 곳이 없어 undefined(승격 대상 없음) */
export function nextCliTier(tier: CliTier): CliTier | undefined {
  return CLI_TIERS[tierIndex(tier) + 1];
}

/** 두 단계 중 더 높은(더 비싼) 쪽. undefined는 "아직 쓴 적 없음"을 뜻해 있는 쪽을 그대로 돌려준다 */
export function higherCliTier(a: CliTier | undefined, b: CliTier): CliTier {
  if (!a) return b;
  return tierIndex(a) >= tierIndex(b) ? a : b;
}

export interface CliRouteRequest {
  prompt: string;
  /** 'ask' = 읽기만 하는 질문(파일을 바꾸지 않음). 'build'만 만들기 요청으로 본다 */
  intent: RouteIntent;
  /** 이 세션에서 지금까지 성공적으로 쓴 가장 높은 단계(stickiness). 없으면 이번이 첫 자동 선택이다 */
  stickyTier?: CliTier;
}

export interface CliRouteDecision {
  tier: CliTier;
  reason: string;
  /** ADR-047과 같은 분류값을 그대로 실어 대화 이벤트·관측에 남긴다 */
  complexity: RoutingDecision['complexity'];
  risk: RoutingDecision['risk'];
  /** stickiness가 이번 선택을 끌어올렸는지(화면·기록에 왜 이 단계인지 설명할 때 쓴다) */
  stuckTo: boolean;
}

/**
 * claude-code 'auto' 모델 선택(phase 1, 같은 세션 안에서만 — 백엔드를 넘나드는 전환은 phase 2).
 * 규칙:
 *  - 읽기만 하는 질문(intent === 'ask')은 항상 haiku. 구현 품질의 증거가 아니라 stickiness도 적용하지 않는다(ADR-047과 같은 원칙 — 질문 완료는 정답을 뜻하지 않는다).
 *  - 만들기 요청은 단순/보통이면 sonnet, 복잡하거나(ADR-047 COMPLEX) 위험하면(ADR-047 HIGH_RISK: 인증·결제·마이그레이션 등) opus.
 *    E9에서 Sonnet 단독이 가장 쌌고(성공 1건당 $0.233) Haiku 단독은 성공률이 떨어졌으므로(로딩에서 멈춘 화면을 못 고침),
 *    자동 선택은 만들기 요청에 haiku를 쓰지 않는다.
 *  - stickiness: 세션에서 이미 성공적으로 쓴 단계(stickyTier)가 이번에 계산한 단계보다 높으면 내리지 않는다
 *    (모델을 바꾸면 프롬프트 캐시가 새로 생겨 비용이 뛴다 — E8/E9).
 */
export function routeCliTier(request: CliRouteRequest): CliRouteDecision {
  const prompt = request.prompt.trim();
  if (!prompt) throw new Error('라우팅할 요청을 입력하세요');
  const inputTokens = estimateTokens(prompt);
  const complexity = classifyComplexity(prompt, inputTokens);
  const risk = classifyRisk(prompt);

  if (request.intent === 'ask') {
    return { tier: 'haiku', reason: '읽기만 하는 질문이라 가장 가벼운 모델로 답합니다', complexity, risk, stuckTo: false };
  }

  const escalated = risk === 'high' || complexity === 'complex';
  const natural: CliTier = escalated ? 'opus' : 'sonnet';
  const naturalReason = risk === 'high' ? '인증·결제·마이그레이션 등 위험 신호가 있어' : complexity === 'complex' ? '요청이 복잡해' : '단순한 만들기 요청이라';

  if (request.stickyTier && tierIndex(request.stickyTier) > tierIndex(natural)) {
    return {
      tier: request.stickyTier,
      reason: `이 세션에서 이미 ${tierLabel(request.stickyTier)}로 성공했어 그대로 유지합니다(모델을 바꾸면 캐시가 새로 생겨 비용이 늘어납니다)`,
      complexity,
      risk,
      stuckTo: true,
    };
  }

  return { tier: natural, reason: `${naturalReason} ${tierLabel(natural)}을 선택합니다`, complexity, risk, stuckTo: false };
}
