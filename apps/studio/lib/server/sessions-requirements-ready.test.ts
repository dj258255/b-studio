import { describe, expect, it } from 'vitest';
import type { Requirement } from '@b-studio/agent';
import { evaluateRequirement } from './sessions';

/** 요구사항 린트 결과와 Ready 여부를 화면이 그대로 쓰도록 서버가 요구사항마다 붙인다(#819). 가짜 값만 쓴다 */
const ready: Requirement = {
  id: 'R1',
  title: '로그인 API',
  kind: 'api',
  priority: 'must',
  acceptance: ['토큰을 준다'],
  ears: { pattern: 'event', statement: '사용자가 로그인하면 시스템은 토큰을 발급해야 한다' },
  scenarios: [{ id: 'R1.1', given: '가입한 사용자', when: '로그인한다', then: '토큰을 받는다' }],
} as Requirement;

describe('evaluateRequirement — 린트와 Ready', () => {
  it('흠이 없으면 lint가 비고 ready가 true다', () => {
    const view = evaluateRequirement(ready, [], [], []);
    expect(view.lint).toEqual([]);
    expect(view.ready).toBe(true);
  });

  it('약한 표현·시나리오 없음은 고칠 것(mustFix)으로 실리고 ready가 false다', () => {
    const view = evaluateRequirement({ ...ready, title: '빠르게 로그인하는 API', scenarios: undefined } as Requirement, [], [], []);
    expect(view.lint.filter((warning) => warning.mustFix).map((warning) => warning.code)).toEqual(['weak-word', 'no-scenario']);
    expect(view.ready).toBe(false);
  });

  it('권고(mustFix: false)만 있으면 ready는 true다', () => {
    const view = evaluateRequirement({ ...ready, ears: { pattern: 'event', statement: '사용자가 로그인하면 토큰을 준다' } } as Requirement, [], [], []);
    expect(view.lint.map((warning) => [warning.code, warning.mustFix])).toEqual([['not-ears-shaped', false]]);
    expect(view.ready).toBe(true);
  });
});
