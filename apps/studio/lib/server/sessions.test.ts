import type { LoadedProject } from '@b-studio/spec';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioError } from './errors';
import {
  allowedBackends,
  apiEscalation,
  assertBackendReady,
  assertResumableBackend,
  buildExportChecks,
  claudeCodeAutoEscalation,
  claudeCodeEscalation,
  cliModelOverride,
  nextAutoTier,
  parseIssueInput,
  parseIssueList,
  planBriefBackend,
  planExecuteConfig,
  planKindForBackend,
  resolveSessionBackend,
  selfCheckMode,
  sessionBackend,
} from './sessions';

describe('parseIssueInput', () => {
  it('생략은 undefined, 1~10,000,000 정수만 받고 나머지는 400으로 거부한다', () => {
    expect(parseIssueInput(undefined)).toBeUndefined();
    expect(parseIssueInput(null)).toBeUndefined();
    expect(parseIssueInput('')).toBeUndefined();
    expect(parseIssueInput(57)).toBe(57);
    expect(parseIssueInput(10_000_000)).toBe(10_000_000);

    for (const bad of [0, -1, 1.5, 10_000_001, Number.NaN, Infinity, '57', true]) {
      expect(() => parseIssueInput(bad)).toThrow(StudioError);
    }
  });
});

describe('parseIssueList', () => {
  it('단수 issue와 배열 issues를 합치고 중복을 없앤다', () => {
    expect(parseIssueList({ issue: 57 })).toEqual([57]);
    expect(parseIssueList({ issues: [57, 58, 57] })).toEqual([57, 58]);
    expect(parseIssueList({ issue: 57, issues: [58, 57] })).toEqual([57, 58]);
    expect(parseIssueList({ issues: [] })).toEqual([]);
    // 입력이 아예 없으면 undefined라 부르는 쪽이 기본값을 쓸지 정한다
    expect(parseIssueList({})).toBeUndefined();
  });

  it('잘못된 값은 400으로 거부한다', () => {
    expect(() => parseIssueList({ issues: '57' })).toThrow('issues는 이슈 번호 배열이어야 합니다');
    for (const bad of [{ issues: [0] }, { issues: [1.5] }, { issues: ['57'] }, { issue: 0 }]) {
      expect(() => parseIssueList(bad)).toThrow(StudioError);
    }
  });
});

describe('buildExportChecks', () => {
  it('이슈 연결·원격 이슈 상태·누락 단계·체크포인트 밖 변경·진행 상태를 확인 목록으로 만든다', () => {
    const checks = buildExportChecks({
      issues: [57],
      issueLookups: [{ issue: 57, lookup: { ok: true, state: 'open', title: 'PR 미리보기' } }],
      missing: [{ shortSha: 'aaaaaaa', subject: '배송 메모 추가', stages: ['test', 'review'] }],
      uncheckpointed: 2,
      running: false,
    });

    expect(checks.map((check) => [check.id, check.ok])).toEqual([
      ['issue_linked', true],
      ['issue_open', true],
      ['stages_passed', false],
      ['uncheckpointed_changes', false],
      ['running', true],
    ]);
    expect(checks.find((check) => check.id === 'issue_open')?.detail).toContain('PR 미리보기');
    expect(checks.find((check) => check.id === 'stages_passed')?.detail).toBe('필수 단계 기록이 없는 커밋 1개가 있습니다');
  });

  it('여러 이슈를 이어 붙여 보여 준다', () => {
    const checks = buildExportChecks({
      issues: [57, 58],
      issueLookups: [
        { issue: 57, lookup: { ok: true, state: 'open', title: '미리보기' } },
        { issue: 58, lookup: { ok: true, state: 'closed', title: '작업 분해' } },
      ],
      missing: [],
      uncheckpointed: 0,
      running: false,
    });

    expect(checks.find((check) => check.id === 'issue_linked')?.detail).toBe('#57, #58 이슈를 PR에 연결합니다');
    // 하나라도 닫혀 있으면 false
    expect(checks.find((check) => check.id === 'issue_open')?.ok).toBe(false);
    expect(checks.find((check) => check.id === 'issue_open')?.detail).toContain('#57 미리보기 (열림)');
    expect(checks.find((check) => check.id === 'issue_open')?.detail).toContain('#58 작업 분해 (닫힘)');
  });

  it('원격 이슈 조회에 실패하면 unknown과 이유로 두고 막지 않는다', () => {
    const checks = buildExportChecks({
      issues: [57],
      issueLookups: [{ issue: 57, lookup: { ok: false, error: 'B_STUDIO_GITHUB_TOKEN 토큰이 없어 이슈를 확인할 수 없습니다' } }],
      missing: [],
      uncheckpointed: 0,
      running: true,
    });

    const open = checks.find((check) => check.id === 'issue_open')!;
    expect(open.ok).toBe('unknown');
    expect(open.detail).toContain('B_STUDIO_GITHUB_TOKEN');
    expect(checks.find((check) => check.id === 'stages_passed')?.ok).toBe(true);
    expect(checks.find((check) => check.id === 'running')?.ok).toBe(false);
  });

  it('이슈 번호가 없으면 확인할 이슈가 없다고 알린다', () => {
    const checks = buildExportChecks({ issues: [], missing: [], uncheckpointed: 0, running: false });

    expect(checks.find((check) => check.id === 'issue_linked')).toMatchObject({ ok: false });
    expect(checks.find((check) => check.id === 'issue_open')).toMatchObject({ ok: 'unknown' });
  });
});

describe('세션 백엔드', () => {
  it('서버 모드는 기본값이고, B_STUDIO_BACKENDS가 허용 목록을 넓힌다. 목록 밖은 400으로 거부한다', () => {
    const env = { B_STUDIO_MODE: 'api' };
    // 아무것도 설정하지 않으면 서버 모드 하나뿐이라 지금과 같다
    expect([...allowedBackends('api', env)]).toEqual(['api']);
    expect(resolveSessionBackend(undefined, env)).toBe('api');
    expect(() => resolveSessionBackend('claude-code', env)).toThrow(StudioError);

    const withList = { B_STUDIO_MODE: 'api', B_STUDIO_BACKENDS: 'claude-code,commandcode,opencode' };
    expect([...allowedBackends('api', withList)].sort()).toEqual(['api', 'claude-code', 'commandcode', 'opencode']);
    expect(resolveSessionBackend('commandcode', withList)).toBe('commandcode');
    expect(resolveSessionBackend('opencode', withList)).toBe('opencode');
    // 요청이 없으면 여전히 서버 모드(계획 기본·통합 세션)
    expect(resolveSessionBackend(undefined, withList)).toBe('api');
    expect(() => resolveSessionBackend('codex', withList)).toThrow(/쓸 수 없는 백엔드/);
    // 목록에 모르는 값이 있으면 서버 설정 오류로 거부한다
    expect(() => allowedBackends('api', { B_STUDIO_MODE: 'api', B_STUDIO_BACKENDS: 'gemini' })).toThrow(/B_STUDIO_BACKENDS/);
  });

  it('demo 서버에서는 백엔드를 고를 수 없다', () => {
    expect(resolveSessionBackend(undefined, { B_STUDIO_MODE: 'demo' })).toBe('demo');
    expect(() => resolveSessionBackend('api', { B_STUDIO_MODE: 'demo' })).toThrow(/데모/);
  });

  it('레거시 기록(backend 없음)은 mode를 백엔드로 읽는다', () => {
    expect(sessionBackend({ mode: 'claude-code' })).toBe('claude-code');
    expect(sessionBackend({ mode: 'api', backend: 'codex' })).toBe('codex');
  });

  it('백엔드마다 자기 실행 방식으로 가고, 데모만 실행 방식이 없다(대본 경로)', () => {
    expect(planKindForBackend('api')).toBe('model');
    expect(planKindForBackend('claude-code')).toBe('claude-code');
    expect(planKindForBackend('codex')).toBe('codex');
    expect(planKindForBackend('commandcode')).toBe('commandcode');
    expect(planKindForBackend('opencode')).toBe('opencode');
    // demo는 준비된 대본이라 표에 없다 → planRun이 데모 시나리오 경로로 처리한다
    expect(planKindForBackend('demo')).toBeUndefined();
  });

  it('CLI 백엔드는 세션을 만들기 전에 로그인을 확인하고, 실패하면 이유와 함께 거부한다', async () => {
    const ready = {
      claudeCode: async () => ({ ok: true as const }),
      codex: async () => ({ ok: true as const }),
      commandCode: async () => ({ ok: true as const }),
      openCode: async () => ({ ok: true as const }),
    };
    await expect(assertBackendReady('claude-code', '/x', ready)).resolves.toBeUndefined();
    await expect(assertBackendReady('codex', '/x', ready)).resolves.toBeUndefined();
    await expect(assertBackendReady('commandcode', '/x', ready)).resolves.toBeUndefined();
    await expect(assertBackendReady('opencode', '/x', ready)).resolves.toBeUndefined();
    // api는 CLI가 아니라 확인하지 않는다(preflight를 주지 않아도 통과)
    await expect(assertBackendReady('api', '/x', {})).resolves.toBeUndefined();

    const fail = { codex: async () => ({ ok: false as const, reason: '로그인이 필요합니다' }) };
    await expect(assertBackendReady('codex', '/x', fail)).rejects.toThrow('로그인이 필요합니다');
    // OpenCode도 로그인 확인에 실패하면 세션을 만들지 않고 이유와 함께 거부한다
    await expect(assertBackendReady('opencode', '/x', { openCode: async () => ({ ok: false as const, reason: 'opencode CLI가 없습니다' }) })).rejects.toThrow(
      /로컬 OpenCode를 쓸 수 없습니다: opencode CLI가 없습니다/,
    );
  });
});

describe('세션 이어서 하기의 백엔드 확인', () => {
  it('지금 서버가 허용하는 백엔드면 그 백엔드로 이어 간다', () => {
    expect(assertResumableBackend({ mode: 'api', backend: 'claude-code' }, 'api', { B_STUDIO_BACKENDS: 'claude-code' })).toBe('claude-code');
    // backend가 없는 옛 기록은 만들 때의 서버 모드로 본다
    expect(assertResumableBackend({ mode: 'api' }, 'api', {})).toBe('api');
  });

  it('허용하지 않는 백엔드로 만든 세션은 이어서 돌리지 않는다(예: 개인 PC의 claude-code 세션을 API 모드 공유 서버에서)', () => {
    expect(() => assertResumableBackend({ mode: 'claude-code' }, 'api', {})).toThrow(/claude-code 백엔드로 만들었는데/);
    expect(() => assertResumableBackend({ mode: 'api', backend: 'codex' }, 'api', { B_STUDIO_BACKENDS: 'claude-code' })).toThrow(/B_STUDIO_BACKENDS/);
    // 데모 세션은 데모 서버에서만
    expect(() => assertResumableBackend({ mode: 'demo' }, 'api', {})).toThrow();
  });
});

describe('세션 백엔드 확정은 두 번 불러도 같다', () => {
  it('데모 서버에서 라우트가 확정한 demo를 createSession이 다시 확정해도 통과한다', () => {
    const env = { B_STUDIO_MODE: 'demo' };
    const first = resolveSessionBackend(undefined, env);
    expect(first).toBe('demo');
    expect(resolveSessionBackend(first, env)).toBe('demo');
    // 데모 서버에서 다른 백엔드는 여전히 거부한다
    expect(() => resolveSessionBackend('claude-code', env)).toThrow(/데모 모드에서는/);
  });

  it('다른 서버 모드에서도 확정한 값을 다시 확정하면 같은 값이다', () => {
    for (const mode of ['api', 'claude-code', 'codex', 'commandcode', 'opencode']) {
      const env = { B_STUDIO_MODE: mode };
      expect(resolveSessionBackend(resolveSessionBackend(undefined, env), env)).toBe(mode);
    }
  });
});

describe('계획-실행 분리(ADR-075) 설정', () => {
  const fakeProject = (models?: { plan?: string; execute?: string }): LoadedProject => ({ spec: { name: 'orders', models } }) as unknown as LoadedProject;

  it('studio.yaml의 models가 같은 이름의 환경 변수보다 우선한다', () => {
    const env = { B_STUDIO_PLAN_MODEL: 'env-plan', B_STUDIO_EXECUTE_MODEL: 'env-execute' };
    expect(planExecuteConfig(fakeProject({ plan: 'yaml-plan', execute: 'yaml-execute' }), env)).toEqual({ plan: 'yaml-plan', execute: 'yaml-execute' });
  });

  it('studio.yaml에 없으면 환경 변수를 쓴다', () => {
    const env = { B_STUDIO_PLAN_MODEL: 'env-plan', B_STUDIO_EXECUTE_MODEL: 'env-execute' };
    expect(planExecuteConfig(fakeProject(), env)).toEqual({ plan: 'env-plan', execute: 'env-execute' });
    expect(planExecuteConfig(fakeProject(), { ...env, B_STUDIO_PLAN_BRIEF: 'always' })).toEqual({ plan: 'env-plan', execute: 'env-execute', always: true });
    expect(() => planExecuteConfig(fakeProject(), { ...env, B_STUDIO_PLAN_BRIEF: 'sometimes' })).toThrow(/auto 또는 always/);
  });

  it('둘 다 없으면 빈 객체를 돌려준다(계획 호출을 하지 않는, 지금과 같은 동작)', () => {
    expect(planExecuteConfig(fakeProject(), {})).toEqual({});
  });
});

describe('모델 승격의 기본 대상(ADR-075: 계획 모델로 올린다)', () => {
  afterEach(() => {
    delete process.env.B_STUDIO_MODEL_REGISTRY;
  });

  it('로컬 Claude 모드: 명시적 승격 대상(B_STUDIO_CLAUDE_CODE_ESCALATE_MODEL)이 있으면 그것을 쓴다', () => {
    const env = { B_STUDIO_CLAUDE_CODE_ESCALATE_MODEL: 'opus' };
    expect(claudeCodeEscalation('sonnet', env)?.to).toBe('opus');
  });

  it('로컬 Claude 모드: 명시적 승격 대상이 없으면 계획 모델로 올린다', () => {
    expect(claudeCodeEscalation('opus', {})?.to).toBe('opus');
  });

  it('로컬 Claude 모드: 계획 모델도 없으면 승격하지 않는다(지금과 같은 동작)', () => {
    expect(claudeCodeEscalation(undefined, {})).toBeUndefined();
  });

  it('API 모드: 명시적 승격 대상(B_STUDIO_ESCALATE_MODEL_ID)이 있으면 그것을 쓴다', () => {
    const env = { B_STUDIO_ESCALATE_MODEL_ID: 'anthropic-default' };
    expect(apiEscalation('other-plan-id', env)?.to).toBe('Claude 기본 모델');
  });

  it('API 모드: 명시적 승격 대상이 없으면 계획 모델 id로 올린다', () => {
    expect(apiEscalation('anthropic-default', {})?.to).toBe('Claude 기본 모델');
  });

  it('API 모드: 계획 모델도 없으면 승격하지 않는다(지금과 같은 동작)', () => {
    expect(apiEscalation(undefined, {})).toBeUndefined();
  });

  it('로컬 Claude 모드: 사람이 대화에서 이미 승격 대상과 같은 모델을 실행 모델로 골랐으면 승격하지 않는다(no-op)', () => {
    const env = { B_STUDIO_CLAUDE_CODE_ESCALATE_MODEL: 'opus' };
    expect(claudeCodeEscalation('sonnet', env, 'opus')).toBeUndefined();
    // 다른 모델을 골랐으면 그대로 승격한다
    expect(claudeCodeEscalation('sonnet', env, 'haiku')?.to).toBe('opus');
    // 아무것도 고르지 않았으면(undefined) 지금과 같이 승격한다
    expect(claudeCodeEscalation('sonnet', env, undefined)?.to).toBe('opus');
  });

  it('API 모드: 사람이 대화에서 이미 승격 대상과 같은 모델을 실행 모델로 골랐으면 승격하지 않는다(no-op)', () => {
    const env = { B_STUDIO_ESCALATE_MODEL_ID: 'anthropic-default' };
    expect(apiEscalation('other-plan-id', env, 'anthropic-default')).toBeUndefined();
    expect(apiEscalation('other-plan-id', env, 'other-model')?.to).toBe('Claude 기본 모델');
  });
});

describe('claude-code 자동 모델 선택(ADR-091)', () => {
  it('승격은 고른 단계의 바로 위 단계다(haiku→sonnet, sonnet→opus)', () => {
    expect(claudeCodeAutoEscalation('haiku')?.to).toBe('sonnet');
    expect(claudeCodeAutoEscalation('sonnet')?.to).toBe('opus');
  });

  it('이미 opus(최고 단계)면 더 올릴 곳이 없어 승격하지 않는다', () => {
    expect(claudeCodeAutoEscalation('opus')).toBeUndefined();
  });

  it('stickiness: 검증을 통과한(done) 만들기 요청만 기억하고, 승격 없이 끝났으면 고른 단계를 그대로 기억한다', () => {
    const route = { tier: 'sonnet', reason: 'x', complexity: 'simple', risk: 'normal', stuckTo: false } as const;
    expect(nextAutoTier(undefined, route, { intent: 'build', status: 'done', escalated: false })).toBe('sonnet');
  });

  it('stickiness: 승격이 일어났으면(게이트 반복 실패) 올라간 단계를 기억한다', () => {
    const route = { tier: 'sonnet', reason: 'x', complexity: 'simple', risk: 'normal', stuckTo: false } as const;
    expect(nextAutoTier(undefined, route, { intent: 'build', status: 'done', escalated: true })).toBe('opus');
  });

  it('stickiness: 이미 더 높은 단계를 기억하고 있으면 내리지 않는다', () => {
    const route = { tier: 'sonnet', reason: 'x', complexity: 'simple', risk: 'normal', stuckTo: false } as const;
    expect(nextAutoTier('opus', route, { intent: 'build', status: 'done', escalated: false })).toBe('opus');
  });

  it('stickiness: 질문(ask)이나 실패한 시도는 기억하지 않는다(구현 품질의 증거가 아니다)', () => {
    const route = { tier: 'opus', reason: 'x', complexity: 'complex', risk: 'high', stuckTo: false } as const;
    expect(nextAutoTier('haiku', route, { intent: 'ask', status: 'done', escalated: false })).toBe('haiku');
    expect(nextAutoTier('haiku', route, { intent: 'build', status: 'failed', escalated: false })).toBe('haiku');
  });
});

describe('cliModelOverride(CLI 러너에 넘길 모델)', () => {
  it('대화에서 고른 모델(별칭·id)을 그대로 넘긴다', () => {
    expect(cliModelOverride('opus')).toBe('opus');
    expect(cliModelOverride(' sonnet ')).toBe('sonnet');
  });

  it('고르지 않았거나(undefined) 작업 분해 레인의 기록용 id(local-cli:...)는 넘기지 않는다(환경 변수로 떨어진다)', () => {
    expect(cliModelOverride(undefined)).toBeUndefined();
    expect(cliModelOverride('')).toBeUndefined();
    expect(cliModelOverride('local-cli:claude-code:sonnet')).toBeUndefined();
  });
});

describe('자가 확인 범위(B_STUDIO_SELF_CHECK)', () => {
  it('설정하지 않으면 lean(ADR-064), full을 주면 이전 동작이다', () => {
    expect(selfCheckMode({})).toBe('lean');
    expect(selfCheckMode({ B_STUDIO_SELF_CHECK: '' })).toBe('lean');
    expect(selfCheckMode({ B_STUDIO_SELF_CHECK: ' lean ' })).toBe('lean');
    expect(selfCheckMode({ B_STUDIO_SELF_CHECK: 'full' })).toBe('full');
  });

  it('모르는 값은 조용히 full로 떨어뜨리지 않고 설정 오류로 알린다', () => {
    expect(() => selfCheckMode({ B_STUDIO_SELF_CHECK: 'LEAN' })).toThrow(StudioError);
    expect(() => selfCheckMode({ B_STUDIO_SELF_CHECK: 'on' })).toThrow(/full 또는 lean/);
  });
});

describe('planBriefBackend', () => {
  it('계획 호출은 api·claude-code 세션에서만 하고, 데모(대본)·다른 백엔드는 건너뛴다', () => {
    expect(planBriefBackend('api')).toBe('api');
    expect(planBriefBackend('claude-code')).toBe('claude-code');
    expect(planBriefBackend('demo')).toBeUndefined();
    expect(planBriefBackend('codex')).toBeUndefined();
    expect(planBriefBackend('opencode')).toBeUndefined();
  });
});
