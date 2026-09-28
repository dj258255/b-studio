/**
 * 벤치마크 실행 방식(백엔드)과 사용 한도 정책.
 *
 * 모델 경로를 조용한 기본값으로 고르지 않는다. `--dry`는 항상 openai 가짜 상류를 쓰고,
 * `--dry`가 아니면 `--backend`를 반드시 받는다(claude-code·codex=본인 PC 구독 CLI, openai=유료 API).
 */

export type Backend = 'claude-code' | 'codex' | 'openai';
export type RateLimitPolicy = 'stop' | 'wait';

export interface BackendChoice {
  backend: Backend;
  /** claude-code·codex에서 고정할 모델 이름. openai면 없다(상류 모델은 BENCH_UPSTREAM_MODEL로 받는다) */
  model?: string;
}

export const DEFAULT_CLAUDE_CODE_MODEL = 'sonnet';

export function isBackend(value: string): value is Backend {
  return value === 'claude-code' || value === 'codex' || value === 'openai';
}

export function resolveBackend(input: { dry: boolean; backend?: string; model?: string }): BackendChoice {
  if (input.dry) {
    if (input.backend !== undefined) throw new Error('--dry는 --backend와 함께 쓸 수 없습니다 (--dry는 항상 openai 가짜 상류를 씁니다)');
    if (input.model !== undefined) throw new Error('--dry는 --model과 함께 쓸 수 없습니다');
    return { backend: 'openai' };
  }
  if (input.backend === undefined) throw new Error('--backend가 필요합니다: claude-code, codex 또는 openai (모델 경로를 조용히 고르지 않습니다)');
  if (!isBackend(input.backend)) throw new Error(`알 수 없는 백엔드입니다: ${input.backend} (claude-code, codex 또는 openai)`);
  if (input.backend === 'openai') {
    if (input.model !== undefined) throw new Error('--model은 --backend claude-code 또는 codex에서만 쓸 수 있습니다');
    return { backend: 'openai' };
  }
  // codex는 기본 모델을 고정하지 않는다. 로그인 계정의 기본 모델을 쓰고 실제로 쓴 이름은 observedModels로 기록된다
  const model = input.model?.trim();
  if (input.backend === 'codex') return model ? { backend: 'codex', model } : { backend: 'codex' };
  return { backend: 'claude-code', model: model || DEFAULT_CLAUDE_CODE_MODEL };
}

/**
 * 작업 계획에 기록할 모델 id. 로컬 CLI 러너는 모델 레지스트리에 없는 모델이라 따로 표시한다.
 * codex는 모델을 고정하지 않을 수 있어 그때는 `default`로 적는다(계정 기본 모델).
 */
export function planModelId(backend: Backend, requestedModel: string, upstreamModelId: string): string {
  if (backend === 'claude-code') return `local-cli:${requestedModel}`;
  if (backend === 'codex') return `local-cli-chatgpt:${requestedModel || 'default'}`;
  return upstreamModelId;
}

/** 벤치가 넘길 승격 설정. claude-code 백엔드에서만 쓴다 */
export interface EscalationChoice {
  /** --escalate-to. 없으면 승격을 설정하지 않은 실행 */
  to?: string;
  /** --escalate-after. 기본 2 */
  after: number;
}

/**
 * 승격 인자를 확정한다. --escalate-to는 승격을 지원하는 claude-code 백엔드에서만 쓸 수 있다.
 * 모델 경로를 조용히 고르지 않는 원칙과 같게, 다른 백엔드에 주면 시작 전에 오류를 낸다.
 */
export function resolveEscalation(input: { backend: Backend; escalateTo?: string; escalateAfter?: number }): EscalationChoice {
  const after = input.escalateAfter ?? 2;
  if (!Number.isInteger(after) || after < 1) throw new Error(`--escalate-after는 1 이상의 정수여야 합니다 (지금 값: ${input.escalateAfter})`);
  // --escalate-after만 주고 --escalate-to를 주지 않으면 승격하지 않는다(설정만 기억한다)
  const to = input.escalateTo?.trim();
  if (!to) return { after };
  if (input.backend !== 'claude-code') throw new Error(`--escalate-to는 --backend claude-code에서만 쓸 수 있습니다 (지금 백엔드: ${input.backend})`);
  return { to, after };
}

export function resolveRateLimitPolicy(onRateLimit: string | undefined, waitMinutes: number | undefined): { policy: RateLimitPolicy; waitMinutes: number } {
  const value = onRateLimit?.trim() || 'stop';
  if (value !== 'stop' && value !== 'wait') throw new Error(`--on-rate-limit은 stop 또는 wait여야 합니다 (지금 값: ${onRateLimit})`);
  const minutes = waitMinutes ?? 30;
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`--rate-limit-wait-minutes는 0보다 큰 숫자여야 합니다 (지금 값: ${waitMinutes})`);
  return { policy: value, waitMinutes: minutes };
}
