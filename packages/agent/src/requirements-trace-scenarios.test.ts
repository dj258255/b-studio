/**
 * 추적표(`buildTraceabilityMatrix`)가 서로 다른 짝 없는 서로게이트 이름을 합치지 않는지 새 구현만으로 확인한다.
 * 옛 TS 사본과 무작위로 견주던 시험(`requirements-trace-differential.test.ts`)에서 사본과 무관한 성질 하나만 남겼다(#1347).
 */
import { native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import * as cur from './requirements';

describe('추적표: 짝 없는 서로게이트 이름', () => {
  it('성질: 인코딩 없이 보내면 서로 다른 짝 없는 서로게이트 이름이 합쳐지지만, 껍데기의 판정은 그렇지 않다', () => {
    // 같은 이름 'x?'를 두 시험이 다른 짝 없는 서로게이트로 가지고, 실행 행은 한쪽에만 있다
    const content = "it('R1 x\ud800', () => {});\nit('R1 x\udc00', () => {});\n";
    const rows = [{ id: 'R1', file: 'a.test.ts', name: 'R1 x\ud800', status: 'pass', at: '2026-06-01T00:00:00.000Z', sha: 'b'.repeat(40), shortSha: 'bbbbbbb' }];
    const input = { requirements: [{ id: 'R1', title: 't', kind: 'api', priority: 'must', acceptance: ['a'] }], checkpoints: [], testFiles: [{ path: 'a.test.ts', content }], gateChecks: [], testRunRows: rows };
    const result = cur.buildTraceabilityMatrix(input as never);
    expect(result.rows[0]!.tests).toEqual([
      { file: 'a.test.ts', name: 'R1 x\ud800', result: 'pass' },
      { file: 'a.test.ts', name: 'R1 x\udc00' },
    ]);
    // 인코딩 없이 Rust로 곧장 보내면 두 이름이 모두 U+FFFD가 되어 합쳐지고, 실행 결과 pass가 엉뚱한 시험에도 붙는다(이 성질이 인코딩이 필요한 이유)
    const raw = JSON.parse(
      native.reqTraceMatrix(
        JSON.stringify({ ...input, testFiles: [{ path: 'a.test.ts', index: JSON.parse(native.reqTraceFileIndex('a.test.ts', content)!) }] }),
      ),
    ) as { rows: Array<{ tests: Array<{ name: string; result?: string }> }> };
    expect(raw.rows[0]!.tests.length).toBe(1);
    expect(raw.rows[0]!.tests[0]!.result).toBe('pass');
  });
});
