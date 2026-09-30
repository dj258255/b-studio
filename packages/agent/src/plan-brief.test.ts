import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import type { AgentUsage } from './loop';
import {
  appendPlanToRequest,
  buildPlanBriefSystem,
  PLAN_BRIEF_MAX_CHARS,
  PLAN_BRIEF_MAX_WORDS_LONG,
  PLAN_BRIEF_MAX_WORDS_SHORT,
  planWordLimit,
  PlanBriefError,
  requestPlanBrief,
  shouldPlanBrief,
} from './plan-brief';

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

describe('planWordLimit', () => {
  it('문장 2개 이하인 짧은 요청은 짧은 상한을 쓴다', () => {
    expect(planWordLimit('버튼 색을 파란색으로 바꿔줘')).toBe(PLAN_BRIEF_MAX_WORDS_SHORT);
    expect(planWordLimit('버튼 색을 바꿔줘. 텍스트도 굵게 해줘.')).toBe(PLAN_BRIEF_MAX_WORDS_SHORT);
  });

  it('문장 3개 이상인 요청은 긴 상한을 쓴다', () => {
    expect(planWordLimit('주문 목록 화면을 만들어줘. 페이지네이션도 넣어줘. 정렬 기능도 있으면 좋겠어.')).toBe(PLAN_BRIEF_MAX_WORDS_LONG);
  });

  it('줄바꿈으로 나뉜 요청도 조각 수로 센다', () => {
    const long = Array.from({ length: 5 }, (_, index) => `${index}번째 줄`).join('\n');
    expect(planWordLimit(long)).toBe(PLAN_BRIEF_MAX_WORDS_LONG);
  });
});

describe('buildPlanBriefSystem', () => {
  it('프로젝트 이름과 managed 서비스를 넣고, 요청 크기에 맞는 단어 상한을 안내한다', () => {
    const system = buildPlanBriefSystem(project, '버튼 색을 파란색으로 바꿔줘');
    expect(system).toContain('orders');
    expect(system).toContain('web: nextjs, 폴더 web');
    expect(system).toContain(String(PLAN_BRIEF_MAX_WORDS_SHORT));
    expect(system).not.toContain(String(PLAN_BRIEF_MAX_WORDS_LONG));
  });

  it('긴 요청은 긴 상한을 안내한다', () => {
    const system = buildPlanBriefSystem(project, '주문 목록 화면을 만들어줘. 페이지네이션도 넣어줘. 정렬 기능도 있으면 좋겠어.');
    expect(system).toContain(String(PLAN_BRIEF_MAX_WORDS_LONG));
  });

  it('최소 변경 원칙(파일·계층·테스트·확인 단계 금지)을 명시한다', () => {
    const system = buildPlanBriefSystem(project, '버튼 색을 파란색으로 바꿔줘');
    expect(system).toMatch(/MINIMAL change/);
    expect(system).toMatch(/Do not add files, layers/);
    expect(system).toMatch(/Prefer editing existing files/);
    expect(system).toMatch(/Do not add a verification or testing step/);
    expect(system).toContain('ADR-064');
  });
});

describe('appendPlanToRequest', () => {
  it('원래 요청은 그대로 두고 계획을 구분선으로 붙인다', () => {
    const result = appendPlanToRequest('버튼을 추가해줘', '1. Button.tsx를 만든다');
    expect(result.startsWith('버튼을 추가해줘\n\n---\n')).toBe(true);
    expect(result).toContain('1. Button.tsx를 만든다');
    expect(result).toContain('[계획 끝]');
  });

  it('"참고 계획"으로 틀을 잡아 실행기가 요청 범위를 넘지 않게 한다', () => {
    const result = appendPlanToRequest('버튼을 추가해줘', '1. Button.tsx를 만든다');
    expect(result).toContain('[참고 계획(요청 범위를 넘는 일은 하지 않는다)');
  });

  it('계획이 글자 수 상한을 넘으면 잘라내고 안내 문구를 남긴다', () => {
    const longPlan = 'x'.repeat(PLAN_BRIEF_MAX_CHARS + 500);
    const result = appendPlanToRequest('버튼을 추가해줘', longPlan);
    const body = result.slice(result.indexOf(']\n') + 2, result.indexOf('\n[계획 끝]'));
    expect(body.startsWith('x'.repeat(PLAN_BRIEF_MAX_CHARS))).toBe(true);
    expect(body).toContain('잘랐습니다');
    expect(body.length).toBeLessThan(longPlan.length);
  });

  it('상한 이하인 계획은 자르지 않는다', () => {
    const shortPlan = '1. 파일을 고친다';
    const result = appendPlanToRequest('버튼을 추가해줘', shortPlan);
    expect(result).not.toContain('잘랐습니다');
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
