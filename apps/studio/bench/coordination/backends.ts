/**
 * 벤치마크 실행 방식(백엔드)과 사용 한도 정책.
 *
 * 모델 경로를 조용한 기본값으로 고르지 않는다. `--dry`는 항상 openai 가짜 상류를 쓰고,
 * `--dry`가 아니면 `--backend`를 반드시 받는다(claude-code·codex·commandcode·opencode=본인 PC CLI, openai=유료 API).
 */

import type { SelfCheckMode } from '@b-studio/agent';
import type { Strategy } from './tasks';

export type Backend = 'claude-code' | 'codex' | 'commandcode' | 'opencode' | 'openai';
export type RateLimitPolicy = 'stop' | 'wait';
/** 검증 범위(--verify). 기본 full은 지금과 같고, light는 레인·통합 게이트가 재시작·준비·계약만 확인한다 */
export type BenchVerify = 'full' | 'light';

export interface BackendChoice {
  backend: Backend;
  /** claude-code·codex·commandcode·opencode에서 고정할 모델 이름. openai면 없다(상류 모델은 BENCH_UPSTREAM_MODEL로 받는다) */
  model?: string;
}

export const DEFAULT_CLAUDE_CODE_MODEL = 'sonnet';

export function isBackend(value: string): value is Backend {
  return value === 'claude-code' || value === 'codex' || value === 'commandcode' || value === 'opencode' || value === 'openai';
}

export function resolveBackend(input: { dry: boolean; backend?: string; model?: string }): BackendChoice {
  if (input.dry) {
    if (input.backend !== undefined) throw new Error('--dry는 --backend와 함께 쓸 수 없습니다 (--dry는 항상 openai 가짜 상류를 씁니다)');
    if (input.model !== undefined) throw new Error('--dry는 --model과 함께 쓸 수 없습니다');
    return { backend: 'openai' };
  }
  if (input.backend === undefined) throw new Error('--backend가 필요합니다: claude-code, codex, commandcode, opencode 또는 openai (모델 경로를 조용히 고르지 않습니다)');
  if (!isBackend(input.backend)) throw new Error(`알 수 없는 백엔드입니다: ${input.backend} (claude-code, codex, commandcode, opencode 또는 openai)`);
  if (input.backend === 'openai') {
    if (input.model !== undefined) throw new Error('--model은 --backend claude-code, codex, commandcode 또는 opencode에서만 쓸 수 있습니다');
    return { backend: 'openai' };
  }
  const model = input.model?.trim();
  // codex는 기본 모델을 고정하지 않는다. 로그인 계정의 기본 모델을 쓰고 실제로 쓴 이름은 observedModels로 기록된다
  if (input.backend === 'codex') return model ? { backend: 'codex', model } : { backend: 'codex' };
  // commandcode는 기본 모델을 고정하지 않는다. 계정 기본 모델을 쓰고, 무료 모델을 골라 비용 없이 돌릴 수 있다
  if (input.backend === 'commandcode') return model ? { backend: 'commandcode', model } : { backend: 'commandcode' };
  // opencode는 모델을 추측하지 않는다. 기본 모델을 두지 않고 반드시 --model을 받는다(무료 Zen 모델은 b-studio 구성에서 거절된다)
  if (input.backend === 'opencode') {
    if (!model) throw new Error('--backend opencode에는 --model이 필요합니다 (기본 모델을 추측하지 않습니다. `opencode models`로 로그인한 제공자의 모델을 고르세요)');
    return { backend: 'opencode', model };
  }
  return { backend: 'claude-code', model: model || DEFAULT_CLAUDE_CODE_MODEL };
}

/**
 * 작업 계획에 기록할 모델 id. 로컬 CLI 러너는 모델 레지스트리에 없는 모델이라 따로 표시한다.
 * codex·commandcode는 모델을 고정하지 않을 수 있어 그때는 `default`로 적는다(계정 기본 모델).
 */
export function planModelId(backend: Backend, requestedModel: string, upstreamModelId: string): string {
  if (backend === 'claude-code') return `local-cli:${requestedModel}`;
  if (backend === 'codex') return `local-cli-chatgpt:${requestedModel || 'default'}`;
  if (backend === 'commandcode') return `local-cli-commandcode:${requestedModel || 'default'}`;
  if (backend === 'opencode') return `local-cli-opencode:${requestedModel || 'default'}`;
  return upstreamModelId;
}

/**
 * 컨텍스트 비우기(`--context-clearing`). 기본은 꺼짐이다 — 효과를 재기 전이라(ADR-055 보강)
 * 켠 실행과 끈 실행을 같은 조건에서 비교해 재려고 인자로 뺐다.
 */
export function resolveContextClearing(value: string | undefined): boolean {
  const trimmed = value?.trim().toLowerCase() || 'off';
  if (trimmed !== 'on' && trimmed !== 'off') throw new Error(`--context-clearing은 on 또는 off여야 합니다 (지금 값: ${value})`);
  return trimmed === 'on';
}

/**
 * 검증 범위(`--verify`). 기본은 full(지금과 같다). light는 E5(전체 검증 대 가볍게 확인)를 재려고 둔다.
 * 모르는 값은 조용히 full로 떨어뜨리지 않고 여기서 멈춘다.
 */
export function resolveVerify(value: string | undefined): BenchVerify {
  const trimmed = value?.trim().toLowerCase();
  if (trimmed === undefined || trimmed === '' || trimmed === 'full') return 'full';
  if (trimmed === 'light') return 'light';
  throw new Error(`--verify는 full 또는 light여야 합니다 (지금 값: ${value})`);
}

/** 자가 확인 범위(--self-check). 기본 full(지금과 같다), lean이면 B_STUDIO_SELF_CHECK=lean으로 모든 세션에 적용한다 */
export function resolveSelfCheck(value: string | undefined): SelfCheckMode {
  const trimmed = value?.trim().toLowerCase();
  if (trimmed === undefined || trimmed === '' || trimmed === 'full') return 'full';
  if (trimmed === 'lean') return 'lean';
  throw new Error(`--self-check는 full 또는 lean이어야 합니다 (지금 값: ${value})`);
}

/**
 * P0(그냥 Claude Code)는 b-studio 검증 게이트를 쓰지 않으므로 verify가 적용되지 않는다.
 * light를 P0와 함께 주면 무시한다는 경고 한 줄을 돌려준다(에러가 아니다).
 */
export function verifyNotice(verify: BenchVerify, strategies: readonly Strategy[]): string | undefined {
  if (verify === 'light' && strategies.includes('P0')) {
    return '경고: P0는 b-studio 검증 게이트를 쓰지 않아 --verify light가 적용되지 않습니다(P0 행은 전체 검증과 같습니다).';
  }
  return undefined;
}

/** 벤치가 넘길 승격 설정. claude-code 백엔드에서만 쓴다 */
export interface EscalationChoice {
  /** --escalate-to. 없으면 승격을 설정하지 않은 실행 */
  to?: string;
  /** --escalate-after. 기본 2 */
  after: number;
  /** --escalate-after-failures. 없으면 서명 규칙만 쓴다(실패 N번 규칙 없음) */
  afterFailures?: number;
  /** --escalate-retry-budget. 승격 뒤 새로 주는 게이트 재시도 횟수(기본 2) */
  retryBudget: number;
}

/**
 * 승격 인자를 확정한다. --escalate-to는 승격을 지원하는 claude-code 백엔드에서만 쓸 수 있다.
 * 레인마다 백엔드를 고를 수 있으므로(레인 백엔드) 레인 중 하나라도 claude-code면 허용한다.
 * 모델 경로를 조용히 고르지 않는 원칙과 같게, claude-code가 하나도 없는데 주면 시작 전에 오류를 낸다.
 */
export function resolveEscalation(input: {
  backend: Backend;
  laneBackends?: Iterable<Backend>;
  escalateTo?: string;
  escalateAfter?: number;
  escalateAfterFailures?: number;
  escalateRetryBudget?: number;
}): EscalationChoice {
  const after = integer(input.escalateAfter, '--escalate-after', 1) ?? 2;
  const afterFailures = integer(input.escalateAfterFailures, '--escalate-after-failures', 1);
  // 0이면 새 예산을 주지 않는다(승격해도 남은 횟수만 쓴다 — 승격 규칙을 넣기 전과 같은 동작)
  const retryBudget = integer(input.escalateRetryBudget, '--escalate-retry-budget', 0) ?? 2;
  // --escalate-*만 주고 --escalate-to를 주지 않으면 승격하지 않는다(설정만 기억한다)
  const to = input.escalateTo?.trim();
  if (!to) return { after, retryBudget, ...(afterFailures === undefined ? {} : { afterFailures }) };
  const backends = new Set<Backend>([input.backend, ...(input.laneBackends ?? [])]);
  if (!backends.has('claude-code')) throw new Error(`--escalate-to는 claude-code 백엔드에서만 쓸 수 있습니다 (지금 백엔드: ${[...backends].join(', ')})`);
  return { to, after, retryBudget, ...(afterFailures === undefined ? {} : { afterFailures }) };
}

function integer(value: number | undefined, flag: string, min: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < min) throw new Error(`${flag}는 ${min} 이상의 정수여야 합니다 (지금 값: ${value})`);
  return value;
}

/** 벤치 레인 그룹(레인의 첫 쓰기 경로). planFor가 만드는 레인은 api·web 둘이다 */
export const BENCH_LANE_GROUPS = ['api', 'web'] as const;
export type BenchLaneGroup = (typeof BENCH_LANE_GROUPS)[number];

export interface LaneBackendChoice {
  group: BenchLaneGroup;
  backend: Backend;
  model?: string;
}

/**
 * `--lane-backend api=claude-code:sonnet` 한 줄을 해석한다. 레인 그룹은 정해진 것만, 백엔드는 --backend와 같은 목록만 받는다.
 * 모델은 선택이고, 백엔드마다 뜻이 다르다(api=레지스트리 id, commandcode=cmd 모델 id, CLI=러너에 넘길 모델 이름).
 */
export function parseLaneBackend(value: string): LaneBackendChoice {
  const eq = value.indexOf('=');
  if (eq < 0) throw new Error(`--lane-backend는 <레인 그룹>=<백엔드>[:<모델>] 형식이어야 합니다 (지금 값: ${value})`);
  const group = value.slice(0, eq).trim();
  const rest = value.slice(eq + 1).trim();
  if (!(BENCH_LANE_GROUPS as readonly string[]).includes(group)) {
    throw new Error(`모르는 레인 그룹입니다: ${group} (가능: ${BENCH_LANE_GROUPS.join(', ')})`);
  }
  const colon = rest.indexOf(':');
  const backend = (colon < 0 ? rest : rest.slice(0, colon)).trim();
  const model = colon < 0 ? undefined : rest.slice(colon + 1).trim() || undefined;
  if (!isBackend(backend)) throw new Error(`알 수 없는 레인 백엔드입니다: ${backend} (claude-code, codex, commandcode, opencode 또는 openai)`);
  return { group: group as BenchLaneGroup, backend, ...(model ? { model } : {}) };
}

/** 반복해 준 --lane-backend를 레인 그룹 → 선택으로 모은다. 같은 그룹을 두 번 주면 오류 */
export function parseLaneBackends(values: readonly string[] | undefined): Map<BenchLaneGroup, LaneBackendChoice> {
  const map = new Map<BenchLaneGroup, LaneBackendChoice>();
  for (const value of values ?? []) {
    const choice = parseLaneBackend(value);
    if (map.has(choice.group)) throw new Error(`레인 그룹이 중복됩니다: ${choice.group}`);
    map.set(choice.group, choice);
  }
  return map;
}

/** 벤치 백엔드 → 세션 백엔드. openai는 api 세션이다 */
export function sessionBackendOf(backend: Backend): 'api' | 'claude-code' | 'codex' | 'commandcode' | 'opencode' {
  return backend === 'openai' ? 'api' : backend;
}

/** 이 실행이 쓰는 CLI 백엔드(계획 기본 + 레인). 쓰는 CLI마다 시작 전에 로그인을 확인한다 */
export function cliBackendsInUse(backend: Backend, laneBackends: ReadonlyMap<BenchLaneGroup, LaneBackendChoice>): Backend[] {
  const clis = new Set<Backend>();
  if (backend !== 'openai') clis.add(backend);
  for (const choice of laneBackends.values()) if (choice.backend !== 'openai') clis.add(choice.backend);
  return [...clis];
}

/**
 * P0(그냥 Claude Code) 기준선은 로컬 Claude Code로만 돌 수 있다. 다른 백엔드는 Claude Code가 아니라 비교 기준이 아니다.
 * Docker·모델을 건드리기 전에 막는다.
 */
export function assertPlainBaselineBackend(backend: Backend, strategies: readonly Strategy[]): void {
  if (strategies.includes('P0') && backend !== 'claude-code') {
    throw new Error(`P0(그냥 Claude Code)는 --backend claude-code에서만 쓸 수 있습니다 (지금 백엔드: ${backend})`);
  }
}

/**
 * 레인 사이 계약(S2)의 출처. 기본 human(과제 정의에 사람이 써 둔 것, E2와 같다).
 * model이면 고정 계획은 그대로 두고 계약만 계획 모델에게 받는다(계획 품질은 재지 않는다).
 */
export type ContractsSource = 'human' | 'model';

export function resolveContractsSource(value: string | undefined): ContractsSource {
  const trimmed = value?.trim().toLowerCase() || 'human';
  if (trimmed !== 'human' && trimmed !== 'model') throw new Error(`--contracts는 human 또는 model이어야 합니다 (지금 값: ${value})`);
  return trimmed;
}

/**
 * 모델 계약은 S2에서만 뜻이 있다. 계약을 쓰지 않는 전략과 함께 주면 무엇을 잰 것인지 알 수 없다.
 * 조용히 human으로 돌리면 "model 계약"이라고 적힌 행이 실제로는 사람 계약이 되어 결과가 거짓말이 된다.
 */
export function assertContractsStrategy(source: ContractsSource, strategies: readonly Strategy[]): void {
  if (source !== 'model') return;
  const wrong = strategies.filter((strategy) => strategy !== 'S2');
  if (wrong.length > 0) throw new Error(`--contracts model은 S2에서만 쓸 수 있습니다 (지금 전략: ${wrong.join(', ')})`);
}

/** 모델 계약을 부를 수 있는 백엔드. codex는 한 번 호출 경로를 만들지 않았다(계획도 presetPlan으로 넘긴다) */
export function assertContractsBackend(source: ContractsSource, backend: Backend): void {
  if (source !== 'model') return;
  if (backend === 'openai' || backend === 'claude-code') return;
  throw new Error(`--contracts model은 --backend openai 또는 claude-code에서만 쓸 수 있습니다 (지금 백엔드: ${backend})`);
}

export function resolveRateLimitPolicy(onRateLimit: string | undefined, waitMinutes: number | undefined): { policy: RateLimitPolicy; waitMinutes: number } {
  const value = onRateLimit?.trim() || 'stop';
  if (value !== 'stop' && value !== 'wait') throw new Error(`--on-rate-limit은 stop 또는 wait여야 합니다 (지금 값: ${onRateLimit})`);
  const minutes = waitMinutes ?? 30;
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`--rate-limit-wait-minutes는 0보다 큰 숫자여야 합니다 (지금 값: ${waitMinutes})`);
  return { policy: value, waitMinutes: minutes };
}
