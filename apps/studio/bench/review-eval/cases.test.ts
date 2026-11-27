import { checkFindingLocations } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import { EVAL_CASES, evalSetHash } from './cases';
import { DEFECT_TAGS, EVAL_LANGUAGES } from './types';

describe('평가 세트', () => {
  it('두 언어·결함 종류 다섯 이상·결함 없는 항목이 들어 있다', () => {
    expect(new Set(EVAL_CASES.map((c) => c.language))).toEqual(new Set(EVAL_LANGUAGES));
    const tags = new Set(EVAL_CASES.flatMap((c) => c.expected.map((e) => e.tag)));
    expect(tags.size).toBeGreaterThanOrEqual(5);
    for (const tag of tags) expect(DEFECT_TAGS).toContain(tag);
    expect(EVAL_CASES.filter((c) => c.expected.length === 0).length).toBeGreaterThanOrEqual(3);
  });
  it('id가 겹치지 않고 항목마다 diff가 있다', () => {
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(EVAL_CASES.length);
    for (const c of EVAL_CASES) expect(c.diff).toContain('diff --git ');
  });
  it('기대 지적의 파일과 줄 범위가 항목의 diff 안(바뀐 곳)에 있다', () => {
    for (const c of EVAL_CASES) {
      for (const e of c.expected) {
        expect(e.startLine).toBeGreaterThanOrEqual(1);
        expect(e.endLine).toBeGreaterThanOrEqual(e.startLine);
        for (const line of [e.startLine, e.endLine]) {
          const [check] = checkFindingLocations([{ file: e.file, line }], { diff: c.diff, truncated: false, omittedFiles: [] });
          expect(check!.status, `${c.id}:${line}`).toBe('in_diff');
        }
      }
    }
  });
  it('세트 해시는 같은 내용이면 같고 내용이 바뀌면 달라진다', () => {
    expect(evalSetHash()).toBe(evalSetHash(EVAL_CASES));
    const changed = EVAL_CASES.map((c, i) => (i === 0 ? { ...c, request: `${c.request}!` } : c));
    expect(evalSetHash(changed)).not.toBe(evalSetHash());
  });
});
