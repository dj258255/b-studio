import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import type { AgentUsage } from './loop';
import { appendPlanToRequest, buildPlanBriefSystem, PLAN_BRIEF_MAX_WORDS, PlanBriefError, requestPlanBrief, shouldPlanBrief } from './plan-brief';

const usage: AgentUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
const project = { spec: { name: 'orders' }, managed: [['web', { template: 'nextjs', path: 'web' }]] } as unknown as LoadedProject;

describe('shouldPlanBrief', () => {
  it('짧고 평이한 요청(simple)은 계획을 건너뛴다', () => {
    expect(shouldPlanBrief('버튼 색을 파란색으로 바꿔줘')).toBe(false);
  });

  it('빈 요청은 계획을 건너뛴다', () => {
    expect(shouldPlanBrief('   ')).toBe(false);
  });

  it('복잡한 신호(아키텍처·마이그레이션 등)가 있는 요청은 계획을 만든다', () => {
    expect(shouldPlanBrief('결제 서비스를 마이그레이션하면서 동시성 문제도 함께 리팩터링해줘')).toBe(true);
  });

  it('줄바꿈이 많은 긴 요청도 계획을 만든다(model-router의 classifyComplexity와 같은 판정)', () => {
    const long = Array.from({ length: 15 }, (_, index) => `${index}번째 줄 설명입니다`).join('\n');
    expect(shouldPlanBrief(long)).toBe(true);
  });
});

describe('buildPlanBriefSystem', () => {
  it('프로젝트 이름과 managed 서비스를 넣고, 단어 상한을 안내한다', () => {
    const system = buildPlanBriefSystem(project);
    expect(system).toContain('orders');
    expect(system).toContain('web: nextjs, 폴더 web');
    expect(system).toContain(String(PLAN_BRIEF_MAX_WORDS));
  });
});

describe('appendPlanToRequest', () => {
  it('원래 요청은 그대로 두고 계획을 구분선으로 붙인다', () => {
    const result = appendPlanToRequest('버튼을 추가해줘', '1. Button.tsx를 만든다');
    expect(result.startsWith('버튼을 추가해줘\n\n---\n')).toBe(true);
    expect(result).toContain('1. Button.tsx를 만든다');
    expect(result).toContain('[계획 끝]');
  });
});

describe('requestPlanBrief', () => {
  it('계획 글과 사용량·시간을 돌려준다', async () => {
    const ask = async () => ({ text: '  1. 파일을 고친다  ', usage });
    const result = await requestPlanBrief(ask, project, '버튼을 추가해줘');
    expect(result).toMatchObject({ text: '1. 파일을 고친다', usage });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('빈 응답이면 토큰·시간을 담아 PlanBriefError를 던진다', async () => {
    const ask = async () => ({ text: '   ', usage });
    await expect(requestPlanBrief(ask, project, '요청')).rejects.toMatchObject({ usage, durationMs: expect.any(Number) });
    await expect(requestPlanBrief(ask, project, '요청')).rejects.toBeInstanceOf(PlanBriefError);
  });
});
