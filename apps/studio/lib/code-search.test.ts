import { describe, expect, it } from 'vitest';
import { matchLines } from './code-search';

/** 소스에 제어 문자를 그대로 두지 않으려고 코드로 만든다 */
const NUL = String.fromCharCode(0);
const ELLIPSIS = '…';

describe('matchLines', () => {
  it('대소문자를 가리지 않고 맞은 줄과 자리를 돌려주며, 파일마다 보여 줄 줄 수를 제한한다', () => {
    const content = ['const Order = 1;', 'function order() {}', '// no match', 'ORDER', 'order', 'order'].join('\n');
    expect(matchLines(content, 'order', { limit: 3 })).toEqual([
      { line: 1, text: 'const Order = 1;', start: 6, length: 5 },
      { line: 2, text: 'function order() {}', start: 9, length: 5 },
      { line: 4, text: 'ORDER', start: 0, length: 5 },
    ]);
  });

  it('빈 검색어와 바이너리 파일은 찾지 않는다', () => {
    expect(matchLines('order', '')).toEqual([]);
    expect(matchLines(`order${NUL}order`, 'order')).toEqual([]);
  });

  it('아주 긴 줄은 맞은 자리 주변만 남기고 자리도 그에 맞춘다', () => {
    const line = `${'a'.repeat(500)}needle${'b'.repeat(500)}`;
    const [match] = matchLines(line, 'needle', { maxLength: 40 });
    expect(match!.text).toHaveLength(40 + 2);
    expect(match!.text.startsWith(ELLIPSIS)).toBe(true);
    expect(match!.text.endsWith(ELLIPSIS)).toBe(true);
    expect(match!.text.slice(match!.start, match!.start + match!.length)).toBe('needle');

    const short = matchLines('start needle end', 'needle', { maxLength: 40 })[0]!;
    expect(short).toEqual({ line: 1, text: 'start needle end', start: 6, length: 6 });
  });

  it('줄 끝에서 맞으면 줄의 끝까지만 보여 준다', () => {
    const line = `${'a'.repeat(300)}needle`;
    const [match] = matchLines(line, 'needle', { maxLength: 20 });
    expect(match!.text.endsWith('needle')).toBe(true);
    expect(match!.text.startsWith(ELLIPSIS)).toBe(true);
    expect(match!.text.slice(match!.start, match!.start + match!.length)).toBe('needle');
  });
});
