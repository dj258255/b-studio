import { describe, expect, it } from 'vitest';
import { checkToolPolicy, isToolAllowed } from './policy';

/**
 * 막는 검사(policy)가 옛 구현과 다르게 더 막는 두 자리를 새 구현만으로 고정한다: 빈 규칙, 객체 프로토타입 이름의 도구.
 * 옛 TS 사본과 무작위로 견주던 시험(`path-policy-differential.test.ts`)에서 사본과 무관한 확인만 남겼다(#1347).
 */
describe('policy의 더 막는 쪽 차이', () => {
  it('빈 규칙은 거절한다 (`if (found)`의 거짓)', () => {
    const protectedEmpty = { protectedPaths: [''] };
    expect(checkToolPolicy('write_file', { path: 'web/x.ts' }, protectedEmpty, undefined)).toMatchObject({ decision: 'deny', reason: 'path is protected by execution policy: ' });
    const deniedEmpty = { deniedCommands: ['', 'git status'] };
    const command = ['sh', '-c', 'git status'];
    expect(checkToolPolicy('run_in_service', { command: ['sh', '-c', ' git status'] }, deniedEmpty, undefined).decision).toBe('deny');
    expect(checkToolPolicy('run_in_service', { command }, deniedEmpty, undefined).decision).toBe('deny');
  });

  it('constructor 같은 이름의 도구는 거절한다', () => {
    for (const tool of ['constructor', 'toString', '__proto__']) {
      expect(checkToolPolicy(tool, {}, { allowedTools: ['read_file'] }, undefined).decision, tool).toBe('deny');
      expect(isToolAllowed(tool, ['read_file']), tool).toBe(false);
    }
  });
});
