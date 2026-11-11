import { describe, expect, it } from 'vitest';
import { revertedText } from './revert-outcome';

describe('revertedText (이슈 #992)', () => {
  it('되돌린 것도 남긴 문서도 없으면 바뀐 파일이 없었다고 쓴다', () => {
    expect(revertedText([], [])).toBe('바뀐 파일은 없었습니다');
  });

  it('문서를 체크포인트로 남긴 실행을 "바뀐 파일은 없었습니다"로 쓰지 않는다', () => {
    const text = revertedText([], ['README.md']);
    expect(text).not.toContain('바뀐 파일은 없었습니다');
    expect(text).toBe('되돌릴 변경은 없었고 문서 1개(README.md)는 되돌리지 않고 체크포인트로 남겼습니다');
  });

  it('되돌린 파일과 남긴 문서를 함께 알린다', () => {
    expect(revertedText(['a.ts', 'b.ts'], ['README.md'])).toBe('바뀐 파일 2개를 되돌렸습니다. 문서 1개(README.md)는 되돌리지 않고 체크포인트로 남겼습니다');
    expect(revertedText(['a.ts'], [], { restorable: true })).toBe('바뀐 파일 1개를 되돌렸습니다(대화 탭에서 되살릴 수 있습니다)');
  });

  it('남긴 문서가 많으면 앞의 몇 개만 이름으로 보인다', () => {
    const docs = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md'];
    expect(revertedText([], docs)).toContain('문서 7개(a.md, b.md, c.md, d.md, e.md 외 2개)');
  });
});
