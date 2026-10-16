import { describe, expect, it } from 'vitest';
import { fisherExactTwoSided, formatP, wilsonInterval } from './stats';

describe('Fisher 정확 검정(양측)', () => {
  // 기대값은 실험 보고서의 p값이다(E1·E2·E4·E11). 저장소 밖에서 계산했던 값을 이 코드로 다시 얻는다
  it('실험 기록의 p값을 다시 계산한다', () => {
    expect(fisherExactTwoSided(9, 9, 4, 9)).toBeCloseTo(0.029412, 5); // E1 S0 9/9 대 S1 4/9, E2 S2 대 S1
    expect(fisherExactTwoSided(17, 18, 9, 18)).toBeCloseTo(0.00723, 5); // E2 S2+S3 대 S1+S4(사후 묶음)
    expect(fisherExactTwoSided(17, 18, 17, 27)).toBeCloseTo(0.030655, 5); // 같은 묶음에 S5를 비공유 쪽으로 넣었을 때
    expect(fisherExactTwoSided(8, 9, 1, 9)).toBeCloseTo(0.003373, 5); // E4-a 대 E4-b
    expect(fisherExactTwoSided(7, 9, 5, 9)).toBeCloseTo(0.61991, 5); // E11 mesh 대 star
  });

  it('두 쪽을 바꿔도 같고, 같은 비율이면 1이다', () => {
    expect(fisherExactTwoSided(4, 9, 9, 9)).toBeCloseTo(fisherExactTwoSided(9, 9, 4, 9), 12);
    expect(fisherExactTwoSided(5, 9, 5, 9)).toBe(1);
    expect(fisherExactTwoSided(0, 3, 0, 3)).toBe(1);
  });

  it('건수가 범위를 벗어나면 던진다', () => {
    expect(() => fisherExactTwoSided(10, 9, 4, 9)).toThrow();
    expect(() => fisherExactTwoSided(-1, 9, 4, 9)).toThrow();
    expect(() => fisherExactTwoSided(1.5, 9, 4, 9)).toThrow();
  });
});

describe('Wilson 구간', () => {
  it('작은 표본의 95% 구간을 계산한다', () => {
    const [low, high] = wilsonInterval(4, 9);
    expect(low).toBeCloseTo(0.1888, 3);
    expect(high).toBeCloseTo(0.7333, 3);
    const [allLow, allHigh] = wilsonInterval(9, 9);
    expect(allLow).toBeCloseTo(0.7008, 3);
    expect(allHigh).toBe(1);
    expect(wilsonInterval(0, 9)[0]).toBe(0);
  });

  it('실행이 없으면 모른다는 뜻으로 0~1을 돌려준다', () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
  });
});

describe('p값 표기', () => {
  it('셋째 자리까지, 0.001 밑은 부등호로 적는다', () => {
    expect(formatP(0.029412)).toBe('0.029');
    expect(formatP(0.0004)).toBe('<0.001');
    expect(formatP(1)).toBe('1.000');
  });
});
