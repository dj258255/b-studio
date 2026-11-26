import { describe, expect, it } from 'vitest';
import { initialState } from './keys';
import { renderScreen, stripAnsi } from './render';
import { stringWidth, tailFit } from './screen';

/** #1387 전에 입력 줄이 쓰던 방식(앞을 한 글자씩 자르며 폭을 다시 잰다). 같은 결과인지 비교하는 기준이다 */
function oldTail(text: string, budget: number): string {
  let out = text;
  while (out && stringWidth(out) > budget) out = [...out].slice(1).join('');
  return out;
}

const samples: Record<string, string> = {
  빈글: '',
  ascii: 'hello world, this is a request',
  한글: '결제 테스트를 보강해 주세요 그리고 로그인도',
  섞임: 'fix 결제 bug 를 고쳐 주세요 #1387',
  이모지: '배포 🚀 완료 👨‍👩‍👧‍👦 끝 🇰🇷 ok',
  결합: 'éá 한゙ ​끝‍',
  앞에결합: '́́abc',
  떠돌이대리쌍: 'ab\ud83dcd\ude00ef',
  줄바꿈: 'a\nb\tc 한글',
};

describe('입력 줄 끝부분 자르기(tailFit)', () => {
  for (const [name, text] of Object.entries(samples)) {
    it(`${name}: 모든 폭에서 옛 방식과 같다`, () => {
      const total = stringWidth(text);
      for (let budget = -2; budget <= total + 3; budget++) expect(tailFit(text, budget)).toBe(oldTail(text, budget));
    });
  }

  it('폭 경계: 넓은 글자가 걸치면 그 글자를 뺀다', () => {
    expect(tailFit('가나다', 4)).toBe('나다');
    expect(tailFit('가나다', 5)).toBe('나다');
    expect(tailFit('가나다', 6)).toBe('가나다');
    expect(tailFit('abc', 0)).toBe('');
    expect(tailFit('abc', -1)).toBe('');
  });

  it('새 요청 입력 줄은 옛 방식과 같은 줄과 커서를 낸다', () => {
    const size = { cols: 60, rows: 12 };
    for (const text of Object.values(samples).concat(['긴 글 '.repeat(40), 'x'.repeat(200)])) {
      const prompt = { step: 'request' as const, projects: [{ id: 'p1', name: 'shop' }], projectIndex: 0, text, choices: ['rules'], choice: 0 };
      const { lines, cursor } = renderScreen({ ...initialState(), items: [], prompt }, size, []);
      const head = ' shop 요청> ';
      const expected = oldTail(text, size.cols - 1 - stringWidth(head));
      const last = stripAnsi(lines[size.rows - 1]!).trimEnd();
      expect(last).toBe((head + expected).trimEnd());
      expect(cursor).toEqual({ x: stringWidth(head + expected), y: size.rows - 1 });
    }
  });

  it('200KB 입력도 오래 걸리지 않는다(글 길이의 제곱으로 느려지지 않는다)', () => {
    const text = '붙여 넣은 글 😀 abc '.repeat(200_000 / 14);
    expect(text.length).toBeGreaterThan(190_000);
    const started = performance.now();
    const shown = tailFit(text, 80);
    const prompt = { step: 'request' as const, projects: [{ id: 'p1', name: 'shop' }], projectIndex: 0, text, choices: ['rules'], choice: 0 };
    const { cursor } = renderScreen({ ...initialState(), items: [], prompt }, { cols: 100, rows: 20 }, []);
    const elapsed = performance.now() - started;
    expect(stringWidth(shown)).toBeLessThanOrEqual(80);
    expect(cursor!.x).toBeLessThan(100);
    expect(elapsed).toBeLessThan(200);
  });
});
