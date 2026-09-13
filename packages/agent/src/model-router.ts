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

const COMPLEX = /아키텍처|architecture|migration|마이그레이션|distributed|분산|concurren|동시성|security|보안|refactor|리팩터|multi[- ]?service|멀티|성능|performance|incident|장애/i;
const HIGH_RISK = /결제|payment|정산|권한|인증|authorization|authentication|secret|credential|삭제|delete|drop\s|truncate|production|운영|배포|deploy|migration|마이그레이션/i;
const VALID_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const VALID_ENV = /^[A-Z][A-Z0-9_]{0,127}$/;

export function validateModelProfiles(input: unknown): ModelProfile[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('모델 레지스트리는 한 개 이상의 모델 배열이어야 합니다');
  const ids = new Set<string>();
  return input.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`모델 ${index + 1} 설정이 객체가 아닙니다`);
    const item = value as Partial<ModelProfile>;
    if (typeof item.id !== 'string' || !VALID_ID.test(item.id)) throw new Error(`모델 ${index + 1}의 id가 올바르지 않습니다`);
    if (ids.has(item.id)) throw new Error(`모델 id가 겹칩니다: ${item.id}`);
    ids.add(item.id);
    if (item.provider !== 'anthropic' && item.provider !== 'openai' && item.provider !== 'google') {
      throw new Error(`${item.id}의 provider는 anthropic, openai, google 중 하나여야 합니다`);
    }
    if (typeof item.model !== 'string' || !item.model.trim()) throw new Error(`${item.id}의 model이 필요합니다`);
    if (typeof item.label !== 'string' || !item.label.trim()) throw new Error(`${item.id}의 label이 필요합니다`);
    if (!Array.isArray(item.capabilities) || item.capabilities.some((capability) => !['tools', 'reasoning', 'long-context', 'json'].includes(capability))) {
      throw new Error(`${item.id}의 capabilities가 올바르지 않습니다`);
    }
    positive(item.contextWindow, `${item.id}.contextWindow`);
    between(item.baselineQuality, 0, 1, `${item.id}.baselineQuality`);
    positive(item.baselineLatencyMs, `${item.id}.baselineLatencyMs`);
    if (!item.pricing || typeof item.pricing !== 'object') throw new Error(`${item.id}.pricing이 필요합니다`);
    nonNegative(item.pricing.inputPerMillion, `${item.id}.pricing.inputPerMillion`);
    nonNegative(item.pricing.outputPerMillion, `${item.id}.pricing.outputPerMillion`);
    if (item.pricing.cacheReadPerMillion !== undefined) nonNegative(item.pricing.cacheReadPerMillion, `${item.id}.pricing.cacheReadPerMillion`);
    if (item.pricing.cacheWritePerMillion !== undefined) nonNegative(item.pricing.cacheWritePerMillion, `${item.id}.pricing.cacheWritePerMillion`);
    if (item.apiKeyEnv !== undefined && !VALID_ENV.test(item.apiKeyEnv)) throw new Error(`${item.id}.apiKeyEnv가 올바른 환경 변수 이름이 아닙니다`);
    if (item.baseUrl !== undefined) safeBaseUrl(item.baseUrl, item.id);
    return {
      id: item.id,
      provider: item.provider,
      model: item.model.trim(),
      label: item.label.trim(),
      enabled: item.enabled !== false,
      capabilities: [...new Set(item.capabilities)] as ModelCapability[],
      contextWindow: item.contextWindow!,
      pricing: { ...item.pricing },
      baselineQuality: item.baselineQuality!,
      baselineLatencyMs: item.baselineLatencyMs!,
      ...(item.apiKeyEnv ? { apiKeyEnv: item.apiKeyEnv } : {}),
      ...(item.baseUrl ? { baseUrl: item.baseUrl.replace(/\/$/, '') } : {}),
    };
  });
}

export function aggregateModelStats(observations: readonly ModelObservation[]): Record<string, ModelStats> {
  const stats: Record<string, ModelStats> = {};
  for (const observation of observations) {
    if (!Number.isFinite(observation.latencyMs) || observation.latencyMs < 0) continue;
    if (observation.costUsd !== undefined && (!Number.isFinite(observation.costUsd) || observation.costUsd < 0)) continue;
    const current = (stats[observation.modelId] ??= { runs: 0, passes: 0, totalLatencyMs: 0, totalCostUsd: 0, pricedRuns: 0 });
    current.runs += 1;
    current.passes += observation.passed ? 1 : 0;
    current.totalLatencyMs += observation.latencyMs;
    if (observation.costUsd !== undefined) {
      current.totalCostUsd += observation.costUsd;
      current.pricedRuns += 1;
    }
  }
  return stats;
}

export function routeModel(profiles: readonly ModelProfile[], request: RouteRequest, stats: Readonly<Record<string, ModelStats>> = {}): RoutingDecision {
  const prompt = request.prompt.trim();
  if (!prompt) throw new Error('라우팅할 요청을 입력하세요');
  const enabled = profiles.filter((profile) => profile.enabled !== false);
  if (enabled.length === 0) throw new Error('사용할 수 있는 모델이 없습니다');

  const inputTokens = estimateTokens(prompt);
  const complexity = classifyComplexity(prompt, inputTokens);
  const risk = HIGH_RISK.test(prompt) ? 'high' : 'normal';
  const outputTokens = request.intent === 'build' ? (complexity === 'complex' ? 4_000 : complexity === 'normal' ? 2_000 : 1_000) : complexity === 'complex' ? 1_500 : 700;
  const required = new Set<ModelCapability>(request.requiredCapabilities ?? (request.intent === 'build' ? ['tools'] : []));

  const candidates = enabled.map((model) => rank(model, { request, stats: stats[model.id], required, inputTokens, outputTokens, complexity, risk }));
  candidates.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.model.id.localeCompare(b.model.id));

  const preferred = request.preferredModelId ? candidates.find((candidate) => candidate.model.id === request.preferredModelId) : undefined;
  const chosen = preferred?.eligible ? preferred : candidates.find((candidate) => candidate.eligible);
  if (!chosen) {
    const reasons = candidates.flatMap((candidate) => candidate.reasons.filter((reason) => reason.startsWith('제외:')).map((reason) => `${candidate.model.label}: ${reason}`));
    throw new Error(`요청 조건을 만족하는 모델이 없습니다${reasons.length ? ` (${reasons.join('; ')})` : ''}`);
  }

  return {
    selected: chosen.model,
    complexity,
    risk,
    inputTokens,
    outputTokens,
    candidates,
    reason: request.preferredModelId && chosen === preferred ? `사용자가 지정한 ${chosen.model.label}을 선택했습니다` : chosen.reasons.join(', '),
  };
}

export function estimateCost(profile: ModelProfile, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number | undefined {
  const { pricing } = profile;
  if (pricing.inputPerMillion === 0 && pricing.outputPerMillion === 0) return undefined;
  return (
    usage.inputTokens * pricing.inputPerMillion +
    usage.outputTokens * pricing.outputPerMillion +
    (usage.cacheReadTokens ?? 0) * (pricing.cacheReadPerMillion ?? pricing.inputPerMillion) +
    (usage.cacheWriteTokens ?? 0) * (pricing.cacheWritePerMillion ?? pricing.inputPerMillion)
  ) / 1_000_000;
}

function rank(
  model: ModelProfile,
  context: {
    request: RouteRequest;
    stats?: ModelStats;
    required: Set<ModelCapability>;
    inputTokens: number;
    outputTokens: number;
    complexity: RoutingDecision['complexity'];
    risk: RoutingDecision['risk'];
  },
): RouteCandidate {
  const reasons: string[] = [];
  const missing = [...context.required].filter((capability) => !model.capabilities.includes(capability));
  const neededContext = context.inputTokens + context.outputTokens;
  const estimatedCostUsd = estimateCost(model, { inputTokens: context.inputTokens, outputTokens: context.outputTokens });
  const observedCostUsd = context.stats?.pricedRuns ? context.stats.totalCostUsd / context.stats.pricedRuns : undefined;
  // 실측 비용이 있으면 이 모델의 실제 평균 소비를 우선하고, 없으면 요청 길이와 가격표로 추정한다
  const rankedCostUsd = observedCostUsd ?? estimatedCostUsd;
  let eligible = true;
  if (missing.length > 0) {
    eligible = false;
    reasons.push(`제외: ${missing.join(', ')} 기능이 없습니다`);
  }
  if (model.contextWindow < neededContext) {
    eligible = false;
    reasons.push(`제외: 예상 ${neededContext.toLocaleString()}토큰이 컨텍스트 한도를 넘습니다`);
  }
  if (context.request.maxCostUsd !== undefined && estimatedCostUsd !== undefined && estimatedCostUsd > context.request.maxCostUsd) {
    eligible = false;
    reasons.push(`제외: 예상 비용 $${estimatedCostUsd.toFixed(4)}가 한도를 넘습니다`);
  }

  const priorRuns = 5;
  const observed = context.stats;
  const quality = observed ? (model.baselineQuality * priorRuns + observed.passes) / (priorRuns + observed.runs) : model.baselineQuality;
  const latencyMs = observed?.runs ? observed.totalLatencyMs / observed.runs : model.baselineLatencyMs;
  const latencyScore = 1 / (1 + latencyMs / 10_000);
  const costScore = rankedCostUsd === undefined ? 0.35 : 1 / (1 + rankedCostUsd * 20);
  const qualityWeight = context.risk === 'high' || context.complexity === 'complex' ? 0.65 : context.complexity === 'simple' ? 0.35 : 0.5;
  const costWeight = context.risk === 'high' || context.complexity === 'complex' ? 0.15 : context.complexity === 'simple' ? 0.45 : 0.3;
  const score = quality * qualityWeight + costScore * costWeight + latencyScore * 0.2;

  if (observed?.runs) reasons.push(`실측 통과율 ${Math.round((observed.passes / observed.runs) * 100)}% (${observed.runs}건)`);
  else reasons.push(`초기 품질 기준 ${Math.round(model.baselineQuality * 100)}%`);
  reasons.push(`예상 지연 ${Math.round(latencyMs).toLocaleString()}ms`);
  reasons.push(observedCostUsd !== undefined ? `실측 평균 비용 $${observedCostUsd.toFixed(4)}` : estimatedCostUsd === undefined ? '가격 미설정' : `예상 비용 $${estimatedCostUsd.toFixed(4)}`);
  if (context.risk === 'high') reasons.push('고위험 요청은 품질 가중치를 높임');
  else if (context.complexity === 'simple') reasons.push('단순 요청은 비용 가중치를 높임');

  return { model, eligible, score: eligible ? score : -1, estimatedCostUsd, quality, latencyMs, reasons };
}

function estimateTokens(text: string): number {
  // 라우팅 전에 별도 토크나이저를 호출하지 않고 보수적으로 잡는다. 실제 비용은 공급자 usage로 다시 기록한다
  const ascii = [...text].filter((character) => character.codePointAt(0)! <= 0x7f).length;
  return Math.max(1, Math.ceil(ascii / 4 + (text.length - ascii) / 1.5));
}

function classifyComplexity(prompt: string, inputTokens: number): RoutingDecision['complexity'] {
  const signals = (COMPLEX.test(prompt) ? 1 : 0) + (inputTokens >= 800 ? 1 : 0) + ((prompt.match(/\n/g)?.length ?? 0) >= 12 ? 1 : 0);
  return signals >= 2 ? 'complex' : signals === 1 ? 'normal' : 'simple';
}

function positive(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name}은 0보다 큰 숫자여야 합니다`);
}

function nonNegative(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${name}은 0 이상의 숫자여야 합니다`);
}

function between(value: unknown, min: number, max: number, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name}은 ${min}~${max} 사이 숫자여야 합니다`);
}

function safeBaseUrl(value: string, id: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${id}.baseUrl이 올바른 URL이 아닙니다`);
  }
  if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw new Error(`${id}.baseUrl에는 http(s) 주소만 쓸 수 있습니다`);
  if (url.protocol === 'http:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1') {
    throw new Error(`${id}.baseUrl의 원격 주소에는 https를 사용해야 합니다`);
  }
}
