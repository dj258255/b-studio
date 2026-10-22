import { describe, expect, it } from 'vitest';
import { describeWhen, draftToRule, matchCandidates, parseBackendRules, ruleToDraft, type BackendRules } from './backend-rules';

/**
 * 내가 정한 규칙으로 AI를 고른다(#822). 규칙은 위에서부터 보고, 조건을 모두 만족하는 규칙이 후보가 된다.
 */
const allowed = ['claude-code', 'codex', 'commandcode'];

describe('parseBackendRules', () => {
  it('규칙과 기본값을 읽는다', () => {
    const rules = parseBackendRules(
      {
        rules: [
          { when: { risk: 'high' }, backend: 'claude-code', model: 'opus' },
          { when: { complexity: ['simple'], keywords: ['문구', '  '] }, backend: 'codex' },
        ],
        fallback: { backend: 'claude-code', model: 'sonnet' },
      },
      allowed,
    );
    expect(rules).toEqual({
      rules: [
        { when: { risk: 'high' }, backend: 'claude-code', model: 'opus' },
        { when: { complexity: ['simple'], keywords: ['문구'] }, backend: 'codex' },
      ],
      fallback: { backend: 'claude-code', model: 'sonnet' },
    });
  });

  it('허용하지 않는 백엔드, 모르는 조건 값, 형식이 틀린 값은 몇 번째 규칙인지와 함께 거부한다', () => {
    expect(() => parseBackendRules({ rules: [{ when: {}, backend: 'gemini' }] }, allowed)).toThrow('규칙 1: 이 스튜디오가 허용하지 않는 백엔드입니다: gemini');
    expect(() => parseBackendRules({ rules: [{ when: { risk: 'huge' }, backend: 'codex' }] }, allowed)).toThrow('규칙 1: risk는 high나 normal이어야 합니다');
    expect(() => parseBackendRules({ rules: [{ when: { complexity: ['tiny'] }, backend: 'codex' }] }, allowed)).toThrow('규칙 1: complexity는 simple, normal, complex 중에서 고릅니다');
    expect(() => parseBackendRules({ rules: [{ when: { intent: 'chat' }, backend: 'codex' }] }, allowed)).toThrow('규칙 1: intent는 build나 ask여야 합니다');
    expect(() => parseBackendRules({ rules: 'x' }, allowed)).toThrow('rules는 목록이어야 합니다');
    expect(() => parseBackendRules({ rules: [], fallback: { backend: 'gemini' } }, allowed)).toThrow('기본값: 이 스튜디오가 허용하지 않는 백엔드입니다: gemini');
  });

  it('규칙은 50개까지 받는다', () => {
    const many = Array.from({ length: 51 }, () => ({ when: {}, backend: 'codex' }));
    expect(() => parseBackendRules({ rules: many }, allowed)).toThrow('규칙은 50개까지입니다');
  });
});

describe('matchCandidates', () => {
  const rules: BackendRules = {
    rules: [
      { when: { risk: 'high' }, backend: 'claude-code', model: 'opus' },
      { when: { keywords: ['README'] }, backend: 'commandcode' },
      { when: { intent: 'build', complexity: ['simple', 'normal'] }, backend: 'codex' },
    ],
    fallback: { backend: 'claude-code', model: 'sonnet' },
  };

  it('조건을 모두 만족하는 규칙을 위에서부터 후보로 내고, 맨 끝에 기본값을 둔다', () => {
    const candidates = matchCandidates(rules, { request: '결제 화면을 고쳐 줘', intent: 'build', kind: { complexity: 'simple', risk: 'high' } });
    expect(candidates.map((candidate) => [candidate.rule, candidate.backend])).toEqual([
      [0, 'claude-code'],
      [2, 'codex'],
      ['fallback', 'claude-code'],
    ]);
    expect(candidates[0]?.model).toBe('opus');
  });

  it('낱말은 대소문자를 가리지 않고 하나만 들어 있어도 맞는다', () => {
    const candidates = matchCandidates(rules, { request: 'readme 오타 고쳐 줘', intent: 'build', kind: { complexity: 'simple', risk: 'normal' } });
    expect(candidates[0]).toMatchObject({ rule: 1, backend: 'commandcode' });
  });

  it('맞는 규칙이 없고 기본값도 없으면 빈 목록이다', () => {
    expect(matchCandidates({ rules: [{ when: { intent: 'ask' }, backend: 'codex' }] }, { request: '만들어 줘', intent: 'build', kind: { complexity: 'simple', risk: 'normal' } })).toEqual([]);
  });
});

describe('describeWhen', () => {
  it('조건을 사람이 읽는 말로 바꾼다', () => {
    expect(describeWhen({})).toBe('모든 요청');
    expect(describeWhen({ intent: 'ask' })).toBe('질문');
    expect(describeWhen({ complexity: ['simple', 'normal'], risk: 'high' })).toBe('단순·보통 · 위험');
    expect(describeWhen({ risk: 'normal', keywords: ['결제', 'README'] })).toBe('위험 아님 · "결제", "README" 포함');
  });
});

describe('규칙 편집기 줄', () => {
  it('저장한 규칙과 편집기 줄을 오가도 같다', () => {
    const rule = { when: { intent: 'build' as const, complexity: ['complex' as const], risk: 'high' as const, keywords: ['결제', 'PG'] }, backend: 'claude-code', model: 'opus' };
    expect(draftToRule(ruleToDraft(rule))).toEqual(rule);
  });

  it('비운 칸은 조건에서 빠지고, 낱말은 쉼표로 나눠 다듬는다', () => {
    expect(draftToRule({ intent: '', complexity: [], risk: '', keywords: ' 결제 , ,README ', backend: 'codex', model: '  ' })).toEqual({ when: { keywords: ['결제', 'README'] }, backend: 'codex' });
  });
});
