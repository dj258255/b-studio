import { describe, expect, it } from 'vitest';
import { checkFindingLocations } from '@b-studio/agent';
import { buildDiff, lineNumberOf } from './diff';

describe('buildDiff', () => {
  it('새 파일은 전체가 추가 줄이고 머리글이 줄 수와 맞다', () => {
    expect(buildDiff([{ path: 'a.ts', after: ['x', 'y'] }])).toBe('diff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+x\n+y\n');
  });
  it('고친 파일은 바뀐 줄 앞뒤 3줄을 문맥으로 두고 머리글 수가 맞다', () => {
    const before = ['1', '2', '3', '4', '5', 'old', '7', '8', '9', '10', '11'];
    const after = ['1', '2', '3', '4', '5', 'new', '7', '8', '9', '10', '11'];
    const diff = buildDiff([{ path: 'a.py', before, after }]);
    expect(diff).toContain('@@ -3,7 +3,7 @@');
    expect(diff).toContain('-old\n+new');
    expect(diff).not.toContain(' 2\n');
    expect(diff).not.toContain(' 10\n');
  });
  it('만든 diff를 제품의 위치 대조가 읽는다(바뀐 줄은 in_diff, 먼 줄은 not_in_diff)', () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
    const after = before.map((l) => (l === 'l15' ? 'changed' : l));
    const diff = buildDiff([{ path: 'a.ts', before, after }]);
    const [near, far] = checkFindingLocations([{ file: 'a.ts', line: 15 }, { file: 'a.ts', line: 30 }], { diff, truncated: false, omittedFiles: [] });
    expect(near!.status).toBe('in_diff');
    expect(far!.status).toBe('not_in_diff');
  });
});

describe('lineNumberOf', () => {
  it('글자를 포함한 줄의 번호를 돌려주고 0개·2개 이상이면 던진다', () => {
    expect(lineNumberOf(['a', 'bb', 'c'], 'bb')).toBe(2);
    expect(() => lineNumberOf(['a'], 'z')).toThrow();
    expect(() => lineNumberOf(['aa', 'ab'], 'a')).toThrow();
  });
});
