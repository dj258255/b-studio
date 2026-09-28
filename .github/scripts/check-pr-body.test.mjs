import { describe, expect, it } from 'vitest';
import { checkPrBody } from './check-pr-body.mjs';

function bodyWith(overrides = {}) {
  const parts = {
    closing: 'Closes #12',
    검증: '단위 테스트 505개가 통과했습니다.',
    '돌리지 않은 검증과 이유': 'Docker E2E는 돌리지 않았습니다.',
    '예상과 실제': '| | 예상 | 실제 | 차이 원인 |\n|---|---|---|---|\n| 시간 | 2시간 | 2시간 | — |',
    ...overrides,
  };
  return [
    '## 무엇을',
    '',
    '주문 목록에 상태 필터를 추가합니다.',
    '',
    parts.closing,
    '',
    '## 검증',
    '',
    parts.검증,
    '',
    '## 돌리지 않은 검증과 이유',
    '',
    parts['돌리지 않은 검증과 이유'],
    '',
    '## 예상과 실제',
    '',
    parts['예상과 실제'],
    '',
  ].join('\n');
}

const base = { baseRef: 'main', defaultBranch: 'main' };

describe('checkPrBody', () => {
  it('닫는 키워드와 모든 필수 절을 채운 본문을 통과시킨다', () => {
    const result = checkPrBody(bodyWith(), base);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it('닫는 키워드가 없으면 실패한다', () => {
    const result = checkPrBody(bodyWith({ closing: 'Refs #3' }), base);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('Closes');
  });

  it('필수 절이 비어 있으면 실패한다', () => {
    const result = checkPrBody(bodyWith({ 검증: '' }), base);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('필수 절 `## 검증`이 비어 있습니다');
  });

  it('필수 절이 아예 없으면 실패한다', () => {
    const body = bodyWith().replace('## 돌리지 않은 검증과 이유', '## 다른 절');
    const result = checkPrBody(body, base);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('필수 절 `## 돌리지 않은 검증과 이유`이 없습니다');
  });

  it('주석만 있는 절은 비어 있는 것으로 본다', () => {
    const body = bodyWith({ 검증: '<!-- 실행한 명령과 결과를 적습니다. -->' });
    const result = checkPrBody(body, base);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('필수 절 `## 검증`이 비어 있습니다');
  });

  it('주석 안의 닫는 키워드는 세지 않는다', () => {
    const body = bodyWith({ closing: '<!-- Closes #12 -->' });
    const result = checkPrBody(body, base);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('Closes');
  });

  it('Closes 줄만 있는 절은 비어 있는 것으로 본다', () => {
    const body = bodyWith({ 검증: 'Closes #12' });
    const result = checkPrBody(body, base);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('필수 절 `## 검증`이 비어 있습니다');
  });

  it.each(['Fixes #3', 'fixes #3', 'Fixed #3', 'resolves #10', 'Resolved #10'])(
    '%s도 닫는 키워드로 허용한다',
    (closing) => {
      const result = checkPrBody(bodyWith({ closing }), base);
      expect(result.ok).toBe(true);
    },
  );

  it('Refs만 있으면 닫는 키워드로 보지 않는다', () => {
    const result = checkPrBody(bodyWith({ closing: 'Refs #3\nRefs #10' }), base);
    expect(result.ok).toBe(false);
  });

  it('기본 브랜치가 아닌 base는 실패가 아니라 note로 알린다', () => {
    const result = checkPrBody(bodyWith(), { baseRef: 'feature/coordination-metrics', defaultBranch: 'main' });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('기본 브랜치');
  });
});
