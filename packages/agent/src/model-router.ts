import { decodeNative, encodeNative, native } from '@b-studio/sandbox';

/**
 * 모델 선택(ADR-047). 점수 계산·정렬·선택, 비용·토큰 추정, 복잡도·위험도 분류, 실측 통계, 모델 설정 검증의 판정은
 * Rust(crates/bstudio-guard/src/model_router.rs, ADR-191 3단계 3f)가 한다. 이 파일은 타입과 같은 이름·시그니처의 껍데기다.
 * 모델 목록은 Rust로 읽기만 하고, 고른 모델은 원본 배열의 위치로 받아 원래 객체(참조)를 돌려준다.
 */
export type ModelProvider = 'anthropic' | 'openai' | 'google';
export type ModelCapability = 'tools' | 'reasoning' | 'long-context' | 'json';
export type RouteIntent = 'build' | 'ask' | 'evaluate';

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

export interface ModelProfile {
  /** 설정과 실행 기록에서 바뀌지 않는 식별자 */
  id: string;
  provider: ModelProvider;
  model: string;
  label: string;
  enabled?: boolean;
  capabilities: ModelCapability[];
  contextWindow: number;
  pricing: ModelPricing;
  /** 실측이 없을 때 쓰는 0~1 초기값 */
  baselineQuality: number;
  /** 실측이 없을 때 쓰는 예상 지연 */
  baselineLatencyMs: number;
  apiKeyEnv?: string;
  baseUrl?: string;
}

export interface ModelObservation {
  modelId: string;
  passed: boolean;
  latencyMs: number;
  /** 가격표를 설정해 실제 사용량을 환산할 수 있을 때만 기록한다 */
  costUsd?: number;
}

export interface ModelStats {
  runs: number;
  passes: number;
  totalLatencyMs: number;
  totalCostUsd: number;
  pricedRuns: number;
}

export interface RouteRequest {
  prompt: string;
  intent: RouteIntent;
  requiredCapabilities?: ModelCapability[];
  /** 한 번의 요청에 허용할 예상 비용. 가격을 0으로 둔 모델은 알 수 없는 비용으로 취급한다 */
  maxCostUsd?: number;
  preferredModelId?: string;
}

export interface RouteCandidate {
  model: ModelProfile;
  eligible: boolean;
  score: number;
  estimatedCostUsd?: number;
  quality: number;
  latencyMs: number;
  reasons: string[];
}

export interface RoutingDecision {
  selected: ModelProfile;
  complexity: 'simple' | 'normal' | 'complex';
  risk: 'normal' | 'high';
  inputTokens: number;
  outputTokens: number;
  candidates: RouteCandidate[];
  reason: string;
}

/** 설정의 `baseUrl`을 JS의 `new URL`로 읽은 사실. URL 파서는 JS 런타임(WHATWG)의 것을 쓰고 판정은 Rust가 한다 */
function readUrlFacts(value: unknown): { ok: true; username: string; password: string; protocol: string; hostname: string } | { ok: false } {
  try {
    const url = new URL(value as string);
    return { ok: true, username: url.username, password: url.password, protocol: url.protocol, hostname: url.hostname };
  } catch {
    return { ok: false };
  }
}

export function validateModelProfiles(input: unknown): ModelProfile[] {
  const facts = Array.isArray(input)
    ? input.map((item: unknown) => (item !== null && typeof item === 'object' && (item as { baseUrl?: unknown }).baseUrl !== undefined ? readUrlFacts((item as { baseUrl?: unknown }).baseUrl) : null))
    : [];
  return decodeNative<ModelProfile[]>(native.validateModelProfiles(encodeNative(input) ?? 'null', JSON.stringify(facts)));
}

export function aggregateModelStats(observations: readonly ModelObservation[]): Record<string, ModelStats> {
  return decodeNative<Record<string, ModelStats>>(native.aggregateModelStats(encodeNative(observations)));
}

interface NativeRouting {
  /** profiles 배열에서의 위치 */
  selected: number;
  complexity: RoutingDecision['complexity'];
  risk: RoutingDecision['risk'];
  inputTokens: number;
  outputTokens: number;
  candidates: Array<{ index: number; eligible: boolean; score: number; estimatedCostUsd?: number; quality: number; latencyMs: number; reasons: string[] }>;
  reason: string;
}

export function routeModel(profiles: readonly ModelProfile[], request: RouteRequest, stats: Readonly<Record<string, ModelStats>> = {}): RoutingDecision {
  const routed = decodeNative<NativeRouting>(native.routeModel(encodeNative(profiles), encodeNative(request), encodeNative(stats)));
  return {
    selected: profiles[routed.selected]!,
    complexity: routed.complexity,
    risk: routed.risk,
    inputTokens: routed.inputTokens,
    outputTokens: routed.outputTokens,
    candidates: routed.candidates.map((candidate) => ({
      model: profiles[candidate.index]!,
      eligible: candidate.eligible,
      score: candidate.score,
      estimatedCostUsd: candidate.estimatedCostUsd,
      quality: candidate.quality,
      latencyMs: candidate.latencyMs,
      reasons: candidate.reasons,
    })),
    reason: routed.reason,
  };
}

export function estimateCost(profile: ModelProfile, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number | undefined {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage;
  return native.estimateCost(encodeNative(profile.pricing), encodeNative({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })) ?? undefined;
}

/**
 * 요청 글자 수에서 토큰을 대충 잡는다(라우팅용 추정, 실제 비용은 공급자 usage로 따로 기록한다).
 * 계획-실행 분리(ADR-075)의 "계획을 건너뛸 만큼 작은 요청인가" 판정도 이 추정을 그대로 재사용한다(plan-brief.ts).
 */
export function estimateTokens(text: string): number {
  return native.estimateTokens(text);
}

/**
 * 요청의 복잡도를 simple/normal/complex로 나눈다. 모델 라우팅(routeModel)의 비용·품질 가중치뿐 아니라
 * 계획-실행 분리(ADR-075)가 "계획 호출을 할 만큼 큰 요청인가"를 판정할 때도 그대로 재사용한다(plan-brief.ts의 shouldPlanBrief) —
 * "크다/작다"의 뜻을 두 곳에서 따로 정의하지 않는다.
 */
export function classifyComplexity(prompt: string, inputTokens: number): RoutingDecision['complexity'] {
  return native.classifyComplexity(prompt, inputTokens) as RoutingDecision['complexity'];
}

/**
 * 요청에 인증·결제·마이그레이션처럼 실패 비용이 큰 키워드가 있는지(ADR-047의 HIGH_RISK 목록).
 * routeModel의 위험도 판정과 CLI 백엔드 자동 모델 선택(cli-router.ts)이 이 하나의 분류를 함께 쓴다 —
 * "위험하다"의 뜻을 두 라우터가 따로 정의하지 않는다.
 */
export function classifyRisk(prompt: string): RoutingDecision['risk'] {
  return native.classifyRisk(prompt) as RoutingDecision['risk'];
}

/**
 * 요청의 작업 종류(복잡도 × 위험도). 실행 기록이 AI별 결과를 묶는 열쇠이고(#821), 라우터와 같은 분류를 쓴다.
 * 요청 글만 보고 정하므로 같은 글은 늘 같은 종류가 된다
 */
export function classifyTask(prompt: string): Pick<RoutingDecision, 'complexity' | 'risk'> {
  return JSON.parse(native.classifyTask(prompt)) as Pick<RoutingDecision, 'complexity' | 'risk'>;
}
