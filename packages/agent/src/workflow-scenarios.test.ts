import { encodeNative, native } from '@b-studio/sandbox';
import { AUTO_PAGE_MAX } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';

/**
 * 워크플로 판정의 상수를 Rust와 같이 쓰는지 본다. 옛 TS 사본과 무작위로 견주던 시험(`workflow-differential.test.ts`)에서 사본과 무관한 확인만 남겼다(#1347).
 */
describe('워크플로 상수', () => {
  it('상수를 Rust와 같이 쓴다', () => {
    expect(AUTO_PAGE_MAX).toBe(10);
    expect(encodeNative({ a: 1 })).toBe('{"a":1}');
    expect(native.workflowFormatPassedTrailer([])).toBe('Workflow-Passed: none');
  });
});
