import { describe, expect, it } from 'vitest';
import {
  assertContractsBackend,
  assertContractsStrategy,
  assertPlainBaselineBackend,
  cliBackendsInUse,
  parseLaneBackend,
  parseLaneBackends,
  planModelId,
  resolveBackend,
  resolveContextClearing,
  resolveContractsSource,
  resolveEscalation,
  resolvePlanExecute,
  resolveRateLimitPolicy,
  resolveSelfCheck,
  resolveVerify,
  sessionBackendOf,
  verifyNotice,
} from './backends';

describe('resolveBackend', () => {
  it('--dry는 --backend·--model과 함께 쓸 수 없고 항상 openai다', () => {
    expect(resolveBackend({ dry: true })).toEqual({ backend: 'openai' });
    expect(() => resolveBackend({ dry: true, backend: 'openai' })).toThrow(/--backend와 함께/);
    expect(() => resolveBackend({ dry: true, model: 'sonnet' })).toThrow(/--model과 함께/);
  });

  it('--dry가 아니면 --backend가 필수다', () => {
    expect(() => resolveBackend({ dry: false })).toThrow(/--backend가 필요합니다/);
    expect(() => resolveBackend({ dry: false, backend: 'anthropic' })).toThrow(/알 수 없는 백엔드/);
  });

  it('claude-code는 모델을 받거나 sonnet을 기본으로 쓴다', () => {
    expect(resolveBackend({ dry: false, backend: 'claude-code' })).toEqual({ backend: 'claude-code', model: 'sonnet' });
    expect(resolveBackend({ dry: false, backend: 'claude-code', model: ' opus ' })).toEqual({ backend: 'claude-code', model: 'opus' });
  });

  it('codex는 모델을 고정할 수도, 계정 기본 모델을 쓰게 둘 수도 있다', () => {
    expect(resolveBackend({ dry: false, backend: 'codex' })).toEqual({ backend: 'codex' });
    expect(resolveBackend({ dry: false, backend: 'codex', model: ' gpt-5-codex ' })).toEqual({ backend: 'codex', model: 'gpt-5-codex' });
  });

  it('commandcode는 모델을 고정할 수도, 계정 기본 모델을 쓰게 둘 수도 있다', () => {
    expect(resolveBackend({ dry: false, backend: 'commandcode' })).toEqual({ backend: 'commandcode' });
    expect(resolveBackend({ dry: false, backend: 'commandcode', model: ' poolside/laguna-s-2.1-free ' })).toEqual({ backend: 'commandcode', model: 'poolside/laguna-s-2.1-free' });
  });

  it('opencode는 --model이 필수다(기본 모델을 추측하지 않는다)', () => {
    expect(() => resolveBackend({ dry: false, backend: 'opencode' })).toThrow(/--model이 필요합니다/);
    expect(resolveBackend({ dry: false, backend: 'opencode', model: ' opencode/space-bunny-free ' })).toEqual({ backend: 'opencode', model: 'opencode/space-bunny-free' });
  });

  it('--model은 claude-code, codex, commandcode 또는 opencode에서만 쓸 수 있다', () => {
    expect(resolveBackend({ dry: false, backend: 'openai' })).toEqual({ backend: 'openai' });
    expect(() => resolveBackend({ dry: false, backend: 'openai', model: 'sonnet' })).toThrow(/claude-code, codex, commandcode 또는 opencode에서만/);
  });
});

describe('planModelId', () => {
  it('로컬 CLI 백엔드는 따로 표시하고, openai는 상류 모델 id를 쓴다', () => {
    expect(planModelId('claude-code', 'sonnet', 'bench-coordination')).toBe('local-cli:sonnet');
    expect(planModelId('codex', 'gpt-5-codex', 'bench-coordination')).toBe('local-cli-chatgpt:gpt-5-codex');
    expect(planModelId('commandcode', 'poolside/laguna-s-2.1-free', 'bench-coordination')).toBe('local-cli-commandcode:poolside/laguna-s-2.1-free');
    expect(planModelId('opencode', 'opencode/mimo-v2.6-flash-free', 'bench-coordination')).toBe('local-cli-opencode:opencode/mimo-v2.6-flash-free');
    expect(planModelId('openai', 'dry', 'bench-coordination')).toBe('bench-coordination');
  });

  it('codex·commandcode·opencode에 모델이 없으면 default로 적는다', () => {
    expect(planModelId('codex', '', 'bench-coordination')).toBe('local-cli-chatgpt:default');
    expect(planModelId('commandcode', '', 'bench-coordination')).toBe('local-cli-commandcode:default');
    expect(planModelId('opencode', '', 'bench-coordination')).toBe('local-cli-opencode:default');
  });
});

describe('resolveContextClearing', () => {
  it('기본은 꺼짐이고 on일 때만 켠다', () => {
    expect(resolveContextClearing(undefined)).toBe(false);
    expect(resolveContextClearing('off')).toBe(false);
    expect(resolveContextClearing('on')).toBe(true);
    expect(resolveContextClearing(' ON ')).toBe(true);
  });

  it('모르는 값은 거부한다', () => {
    expect(() => resolveContextClearing('yes')).toThrow(/on 또는 off/);
  });
});

describe('자가 확인 범위(--self-check)', () => {
  it('기본은 full이고, lean만 받는다. 모르는 값은 거부한다', () => {
    expect(resolveSelfCheck(undefined)).toBe('full');
    expect(resolveSelfCheck('full')).toBe('full');
    expect(resolveSelfCheck(' LEAN ')).toBe('lean');
    expect(() => resolveSelfCheck('light')).toThrow(/full 또는 lean/);
  });
});

describe('검증 범위(--verify)', () => {
  it('기본은 full이고, light만 가볍게 확인으로 받는다', () => {
    expect(resolveVerify(undefined)).toBe('full');
    expect(resolveVerify('full')).toBe('full');
    expect(resolveVerify('light')).toBe('light');
    expect(resolveVerify(' LIGHT ')).toBe('light');
  });

  it('모르는 값은 조용히 full로 떨어뜨리지 않고 거부한다', () => {
    expect(() => resolveVerify('none')).toThrow(/full 또는 light/);
    expect(() => resolveVerify('true')).toThrow(/full 또는 light/);
  });

  it('P0는 게이트가 없어 light가 적용되지 않는다. light와 함께 주면 무시하고 경고를 돌려준다', () => {
    expect(verifyNotice('light', ['P0'])).toMatch(/P0.*적용되지 않습니다/);
    expect(verifyNotice('light', ['S0', 'P0'])).toBeDefined();
    // full이거나 P0가 없으면 경고가 없다
    expect(verifyNotice('full', ['P0'])).toBeUndefined();
    expect(verifyNotice('light', ['S0', 'S1'])).toBeUndefined();
  });
});

describe('resolveRateLimitPolicy', () => {
  it('기본은 stop, 30분이다', () => {
    expect(resolveRateLimitPolicy(undefined, undefined)).toEqual({ policy: 'stop', waitMinutes: 30 });
  });

  it('wait과 기다릴 분을 받는다', () => {
    expect(resolveRateLimitPolicy('wait', 5)).toEqual({ policy: 'wait', waitMinutes: 5 });
  });

  it('모르는 값과 0 이하의 분은 거부한다', () => {
    expect(() => resolveRateLimitPolicy('continue', undefined)).toThrow(/stop 또는 wait/);
    expect(() => resolveRateLimitPolicy('wait', 0)).toThrow(/0보다 큰/);
  });
});

describe('resolveEscalation', () => {
  it('--escalate-to를 주지 않으면 기본 임계치만 두고 승격하지 않는다', () => {
    expect(resolveEscalation({ backend: 'claude-code' })).toEqual({ after: 2, retryBudget: 2 });
    expect(resolveEscalation({ backend: 'claude-code', escalateAfter: 3 })).toEqual({ after: 3, retryBudget: 2 });
    // 대상 없이 규칙만 주면 기억만 한다(승격 없음)
    expect(resolveEscalation({ backend: 'claude-code', escalateAfterFailures: 3, escalateRetryBudget: 4 })).toEqual({
      after: 2,
      afterFailures: 3,
      retryBudget: 4,
    });
  });

  it('claude-code 백엔드에서만 --escalate-to를 받는다', () => {
    expect(resolveEscalation({ backend: 'claude-code', escalateTo: 'sonnet' })).toEqual({ to: 'sonnet', after: 2, retryBudget: 2 });
    expect(resolveEscalation({ backend: 'claude-code', escalateTo: ' sonnet ', escalateAfter: 4 })).toEqual({ to: 'sonnet', after: 4, retryBudget: 2 });
  });

  it('실패 N번 규칙과 승격 뒤 재시도 예산을 함께 넘긴다', () => {
    expect(resolveEscalation({ backend: 'claude-code', escalateTo: 'sonnet', escalateAfterFailures: 3, escalateRetryBudget: 4 })).toEqual({
      to: 'sonnet',
      after: 2,
      afterFailures: 3,
      retryBudget: 4,
    });
    // 예산 0은 "새 예산 없음"이다(승격해도 남은 횟수만 쓴다)
    expect(resolveEscalation({ backend: 'claude-code', escalateTo: 'sonnet', escalateRetryBudget: 0 })).toEqual({ to: 'sonnet', after: 2, retryBudget: 0 });
  });

  it('승격을 지원하지 않는 백엔드에 --escalate-to를 주면 시작 전에 오류를 낸다', () => {
    expect(() => resolveEscalation({ backend: 'openai', escalateTo: 'sonnet' })).toThrow(/--escalate-to는 claude-code/);
    expect(() => resolveEscalation({ backend: 'codex', escalateTo: 'sonnet' })).toThrow(/--escalate-to는 claude-code/);
    // Command Code·OpenCode 러너도 승격을 지원하지 않는다. 조용히 무시하지 않고 시작 전에 거부한다
    expect(() => resolveEscalation({ backend: 'commandcode', escalateTo: 'deepseek/deepseek-v4-flash' })).toThrow(/--escalate-to는 claude-code/);
    expect(() => resolveEscalation({ backend: 'opencode', escalateTo: 'opencode/mimo-v2.6-flash-free' })).toThrow(/--escalate-to는 claude-code/);
  });

  it('승격 인자는 1 이상의 정수여야 한다(재시도 예산은 0도 받는다)', () => {
    expect(() => resolveEscalation({ backend: 'claude-code', escalateAfter: 0 })).toThrow(/--escalate-after는 1 이상의 정수/);
    expect(() => resolveEscalation({ backend: 'claude-code', escalateTo: 'sonnet', escalateAfter: 1.5 })).toThrow(/--escalate-after는 1 이상의 정수/);
    expect(() => resolveEscalation({ backend: 'claude-code', escalateTo: 'sonnet', escalateAfterFailures: 0 })).toThrow(/--escalate-after-failures는 1 이상의 정수/);
    expect(() => resolveEscalation({ backend: 'claude-code', escalateTo: 'sonnet', escalateRetryBudget: -1 })).toThrow(/--escalate-retry-budget는 0 이상의 정수/);
  });
});

describe('resolvePlanExecute(계획-실행 분리, ADR-075)', () => {
  it('둘 다 주지 않으면(기본, --dry 포함) 빈 설정이라 백엔드를 가리지 않는다', () => {
    expect(resolvePlanExecute({ backend: 'claude-code' })).toEqual({});
    // --dry는 항상 openai 백엔드다. 아무 값도 주지 않으면 그대로 통과한다(지금 동작과 같다)
    expect(resolvePlanExecute({ backend: 'openai' })).toEqual({});
  });

  it('claude-code 백엔드에서 --plan-model·--execute-model을 받고, 앞뒤 공백을 지운다', () => {
    expect(resolvePlanExecute({ backend: 'claude-code', planModel: 'opus', executeModel: 'haiku' })).toEqual({ plan: 'opus', execute: 'haiku' });
    expect(resolvePlanExecute({ backend: 'claude-code', planModel: ' opus ' })).toEqual({ plan: 'opus' });
    // 실행 모델 없이 계획 모델만 줄 수도 있다(실행은 --model을 그대로 쓴다)
    expect(resolvePlanExecute({ backend: 'claude-code', planModel: 'opus' })).toEqual({ plan: 'opus' });
  });

  it('계획 호출 경로가 없는 백엔드에 주면 시작 전에 오류를 낸다(--dry와 함께 주는 것도 여기서 걸린다)', () => {
    expect(() => resolvePlanExecute({ backend: 'openai', planModel: 'opus' })).toThrow(/--plan-model·--execute-model은 claude-code/);
    expect(() => resolvePlanExecute({ backend: 'codex', executeModel: 'haiku' })).toThrow(/claude-code 백엔드에서만/);
    expect(() => resolvePlanExecute({ backend: 'commandcode', planModel: 'opus' })).toThrow(/claude-code 백엔드에서만/);
    expect(() => resolvePlanExecute({ backend: 'opencode', planModel: 'opus' })).toThrow(/claude-code 백엔드에서만/);
  });

  it('claude-code 레인이 하나라도 있으면 계획 기본 백엔드가 openai여도 허용한다', () => {
    expect(resolvePlanExecute({ backend: 'openai', laneBackends: ['claude-code'], planModel: 'opus' })).toEqual({ plan: 'opus' });
    expect(() => resolvePlanExecute({ backend: 'openai', laneBackends: ['codex'], planModel: 'opus' })).toThrow(/claude-code/);
  });
});

describe('assertPlainBaselineBackend', () => {
  it('P0는 claude-code에서만 쓸 수 있고, 다른 백엔드는 시작 전에 거부한다', () => {
    expect(() => assertPlainBaselineBackend('claude-code', ['P0', 'S0'])).not.toThrow();
    expect(() => assertPlainBaselineBackend('openai', ['P0'])).toThrow(/claude-code에서만/);
    expect(() => assertPlainBaselineBackend('codex', ['S0', 'P0'])).toThrow(/claude-code에서만/);
    // P0가 없으면 백엔드를 가리지 않는다
    expect(() => assertPlainBaselineBackend('codex', ['S0', 'S1'])).not.toThrow();
  });
});

describe('레인 사이 계약(--contracts)', () => {
  it('기본은 human이고 human|model만 받는다', () => {
    expect(resolveContractsSource(undefined)).toBe('human');
    expect(resolveContractsSource('')).toBe('human');
    expect(resolveContractsSource(' human ')).toBe('human');
    expect(resolveContractsSource('MODEL')).toBe('model');
    expect(() => resolveContractsSource('auto')).toThrow(/human 또는 model/);
  });

  it('model 계약은 S2에서만 쓸 수 있다 (계약을 쓰지 않는 전략에 주면 무엇을 잰 것인지 알 수 없다)', () => {
    expect(() => assertContractsStrategy('human', ['P0', 'S0', 'S1', 'S2', 'S3'])).not.toThrow();
    expect(() => assertContractsStrategy('model', ['S2'])).not.toThrow();
    expect(() => assertContractsStrategy('model', ['S2', 'S1'])).toThrow(/S2에서만/);
    expect(() => assertContractsStrategy('model', ['S3'])).toThrow(/S2에서만/);
  });

  it('model 계약은 openai와 claude-code에서만 부를 수 있다 (codex·commandcode·opencode는 한 번 호출 경로가 없다)', () => {
    expect(() => assertContractsBackend('human', 'codex')).not.toThrow();
    expect(() => assertContractsBackend('model', 'openai')).not.toThrow();
    expect(() => assertContractsBackend('model', 'claude-code')).not.toThrow();
    expect(() => assertContractsBackend('model', 'codex')).toThrow(/openai 또는 claude-code/);
    expect(() => assertContractsBackend('model', 'commandcode')).toThrow(/openai 또는 claude-code/);
    expect(() => assertContractsBackend('model', 'opencode')).toThrow(/openai 또는 claude-code/);
    // human이면 백엔드를 가리지 않는다
    expect(() => assertContractsBackend('human', 'commandcode')).not.toThrow();
    expect(() => assertContractsBackend('human', 'opencode')).not.toThrow();
  });
});

describe('레인 백엔드(--lane-backend)', () => {
  it('레인 그룹=백엔드[:모델]을 해석하고, 모르는 그룹·백엔드는 거부한다', () => {
    expect(parseLaneBackend('api=claude-code:sonnet')).toEqual({ group: 'api', backend: 'claude-code', model: 'sonnet' });
    expect(parseLaneBackend('web=commandcode')).toEqual({ group: 'web', backend: 'commandcode' });
    expect(parseLaneBackend('web=opencode:opencode/mimo-v2.6-flash-free')).toEqual({ group: 'web', backend: 'opencode', model: 'opencode/mimo-v2.6-flash-free' });
    expect(parseLaneBackend(' api = openai ')).toEqual({ group: 'api', backend: 'openai' });
    expect(() => parseLaneBackend('api')).toThrow(/형식/);
    expect(() => parseLaneBackend('db=codex')).toThrow(/모르는 레인 그룹/);
    expect(() => parseLaneBackend('api=gemini')).toThrow(/알 수 없는 레인 백엔드/);
  });

  it('반복해 준 레인 백엔드를 모으고, 같은 그룹이 두 번이면 거부한다', () => {
    const map = parseLaneBackends(['api=claude-code:sonnet', 'web=commandcode']);
    expect([...map.keys()]).toEqual(['api', 'web']);
    expect(map.get('api')).toEqual({ group: 'api', backend: 'claude-code', model: 'sonnet' });
    expect(() => parseLaneBackends(['api=claude-code', 'api=codex'])).toThrow(/중복/);
    expect(parseLaneBackends(undefined).size).toBe(0);
  });

  it('openai는 api 세션이고, 쓰는 CLI만 로그인 확인 목록에 모은다', () => {
    expect(sessionBackendOf('openai')).toBe('api');
    expect(sessionBackendOf('commandcode')).toBe('commandcode');
    expect(sessionBackendOf('opencode')).toBe('opencode');
    const lanes = parseLaneBackends(['api=claude-code', 'web=commandcode']);
    expect(cliBackendsInUse('openai', lanes).sort()).toEqual(['claude-code', 'commandcode']);
    expect(cliBackendsInUse('codex', parseLaneBackends([]))).toEqual(['codex']);
    // opencode 레인도 로그인 확인 목록에 들어간다(레인마다 다른 백엔드)
    expect(cliBackendsInUse('opencode', parseLaneBackends([]))).toEqual(['opencode']);
    expect(cliBackendsInUse('openai', parseLaneBackends(['web=opencode:opencode/mimo-v2.6-flash-free']))).toEqual(['opencode']);
  });

  it('claude-code 레인이 하나라도 있으면 --escalate-to를 허용한다', () => {
    expect(resolveEscalation({ backend: 'openai', laneBackends: ['claude-code'], escalateTo: 'sonnet' })).toEqual({ to: 'sonnet', after: 2, retryBudget: 2 });
    expect(() => resolveEscalation({ backend: 'openai', laneBackends: ['codex'], escalateTo: 'sonnet' })).toThrow(/claude-code/);
  });
});
