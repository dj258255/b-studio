import { describe, expect, it } from 'vitest';
import { describeLoadExpect } from './load-check';

/**
 * 부하 확인 기대값의 수 표기가 `Number#toString`과 같은지 임의의 비트 무늬로 본다(ADR-191 3e). 옛 TS 사본과 견주던 시험(`gate-review-differential`)에서
 * 사본과 무관한 부분만 남긴 것이다(#1347).
 */

const N = Number(process.env.GATE_REVIEW_DIFF_N ?? 4000);
const LONG = 3_600_000;
const SEEDS = (process.env.GATE_REVIEW_DIFF_SEEDS ?? '20261110,20261111').split(',').map(Number);

function makeRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

class Gen {
  constructor(readonly rand: () => number) {}
  int = (n: number): number => Math.floor(this.rand() * n);
  pick = <T>(items: readonly T[]): T => items[this.int(items.length)]!;
  range = (lo: number, hi: number): number => lo + this.int(hi - lo + 1);
}

describe.each(SEEDS)('수를 글자로 쓰는 규칙 (시드 %i)', (seed) => {
  it('Number#toString과 같다: 임의의 비트 무늬, 정수·소수 가운데(.25·.75), 2의 거듭제곱 둘레', () => {
    const g = new Gen(makeRandom(seed + 2));
    const view = new DataView(new ArrayBuffer(8));
    const text = (x: number): string => describeLoadExpect({ p50Ms: x } as never);
    const samples = 5 * N;
    for (let i = 0; i < samples; i++) {
      let x: number;
      const mode = g.int(4);
      if (mode === 0) {
        view.setUint32(0, Math.floor(g.rand() * 2 ** 32));
        view.setUint32(4, Math.floor(g.rand() * 2 ** 32));
        x = view.getFloat64(0);
      } else if (mode === 1) {
        // 16~17자리에서 정확한 값이 가운데가 되기 쉬운 수: 큰 정수 + .25/.5/.75
        x = Math.floor(g.rand() * 2 ** 53) / 2 ** g.int(4) + g.pick([0, 0.25, 0.5, 0.75]);
      } else if (mode === 2) {
        // 2의 거듭제곱 바로 위아래(간격이 비대칭인 곳)
        const e = g.int(120) - 20;
        x = 2 ** e * g.pick([1, 1 + Number.EPSILON, 1 - Number.EPSILON / 2, 1.5]);
      } else {
        x = Number((g.rand() * 10 ** (g.int(40) - 15)).toPrecision(g.range(14, 17)));
      }
      if (!Number.isFinite(x)) continue;
      expect(text(x), String(x)).toBe(`p50 ${x}ms 이하`);
    }
  }, LONG);
});
