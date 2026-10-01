import { describe, expect, it } from 'vitest';
import { buildRequirementAskPrefill, requirementToMarkdown } from './requirement-chat-prefill';

const requirement = {
  id: 'R4',
  title: '주문 목록 필터',
  acceptance: ['상태별로 걸러 보인다', '빈 결과면 안내 문구가 보인다'],
  ears: { statement: '사용자가 상태를 고르면 시스템은 그 상태의 주문만 보여야 한다' },
  scenarios: [{ id: 'R4.1', given: '주문이 3건 있을 때', when: '완료 상태를 고르면', then: '완료 주문만 보인다' }],
};

describe('buildRequirementAskPrefill', () => {
  it('id·제목·EARS·인수 조건·시나리오를 맥락으로 채우고 끝에 질문 쓸 자리를 남긴다', () => {
    const prefill = buildRequirementAskPrefill(requirement);
    expect(prefill).toContain('[R4] 주문 목록 필터');
    expect(prefill).toContain('EARS: 사용자가 상태를 고르면 시스템은 그 상태의 주문만 보여야 한다');
    expect(prefill).toContain('- 상태별로 걸러 보인다');
    expect(prefill).toContain('- R4.1: (Given) 주문이 3건 있을 때 (When) 완료 상태를 고르면 (Then) 완료 주문만 보인다');
    expect(prefill.endsWith('질문: ')).toBe(true);
  });

  it('EARS·시나리오가 없어도(옛 문서) 인수 조건만으로 만든다', () => {
    const minimal = { id: 'R1', title: '제목만', acceptance: ['조건 하나'] };
    const prefill = buildRequirementAskPrefill(minimal);
    expect(prefill).toContain('[R1] 제목만');
    expect(prefill).not.toContain('EARS:');
    expect(prefill).not.toContain('시나리오:');
    expect(prefill).toContain('- 조건 하나');
  });
});

describe('requirementToMarkdown', () => {
  it('같은 내용을 H2 헤딩을 가진 마크다운으로 돌려준다(질문 자리는 없다)', () => {
    const markdown = requirementToMarkdown(requirement);
    expect(markdown).toContain('## [R4] 주문 목록 필터');
    expect(markdown).toContain('- 빈 결과면 안내 문구가 보인다');
    expect(markdown).not.toContain('질문:');
  });
});
