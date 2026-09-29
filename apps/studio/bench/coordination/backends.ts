/**
 * 벤치마크 실행 방식(백엔드)과 사용 한도 정책.
 *
 * 모델 경로를 조용한 기본값으로 고르지 않는다. `--dry`는 항상 openai 가짜 상류를 쓰고,
 * `--dry`가 아니면 `--backend`를 반드시 받는다(claude-code·codex·commandcode·opencode=본인 PC CLI, openai=유료 API).
 */

import type { Strategy } from './tasks';

export type Backend = 'claude-code' | 'codex' | 'commandcode' | 'opencode' | 'openai';
export type RateLimitPolicy = 'stop' | 'wait';

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
 * P0(그냥 Claude Code) 기준선은 로컬 Claude Code로만 돌 수 있다. 다른 백엔드는 Claude Code가 아니라 비교 기준이 아니다.
 * Docker·모델을 건드리기 전에 막는다.
 */
export function assertPlainBaselineBackend(backend: Backend, strategies: readonly Strategy[]): void {
  if (strategies.includes('P0') && backend !== 'claude-code') {
    throw new Error(`P0(그냥 Claude Code)는 --backend claude-code에서만 쓸 수 있습니다 (지금 백엔드: ${backend})`);
  }
}

export function resolveRateLimitPolicy(onRateLimit: string | undefined, waitMinutes: number | undefined): { policy: RateLimitPolicy; waitMinutes: number } {
  const value = onRateLimit?.trim() || 'stop';
  if (value !== 'stop' && value !== 'wait') throw new Error(`--on-rate-limit은 stop 또는 wait여야 합니다 (지금 값: ${onRateLimit})`);
  const minutes = waitMinutes ?? 30;
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`--rate-limit-wait-minutes는 0보다 큰 숫자여야 합니다 (지금 값: ${waitMinutes})`);
  return { policy: value, waitMinutes: minutes };
}
