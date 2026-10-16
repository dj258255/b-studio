/**
 * 실험 판정에 쓰는 통계(이슈 #704). 예전에는 p값을 저장소 밖에서 계산해 보고서에 옮겨 적었다.
 * 의존성을 들이지 않고 두 함수만 둔다. 기대값은 실험 보고서의 p값으로 테스트한다(stats.test.ts)
 */

/** 0..n의 log(k!) 표. 벤치 표본은 수십 건이라 그때그때 만든다 */
function logFactorials(n: number): number[] {
  const table = [0];
  for (let k = 1; k <= n; k++) table.push(table[k - 1]! + Math.log(k));
  return table;
}

function assertCount(successes: number, total: number): void {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || total < 0 || successes < 0 || successes > total) {
    throw new RangeError(`건수가 올바르지 않습니다: ${successes}/${total}`);
  }
}

/**
 * 두 비율(successesA/totalA, successesB/totalB)에 대한 Fisher 정확 검정의 양측 p값.
 * 여백을 고정한 초기하 분포에서 관측한 표보다 확률이 크지 않은 표의 확률을 모두 더한다(R `fisher.test`와 같은 규칙,
 * 부동소수 오차를 흡수하려고 1e-7 상대 여유를 둔다). 실행끼리 독립이라는 가정을 쓴다. 같은 과제를 반복한 실행은
 * 서로 닮아 있어 이 가정이 깨질 수 있으므로, 과제별 표를 함께 본다
 */
export function fisherExactTwoSided(successesA: number, totalA: number, successesB: number, totalB: number): number {
  assertCount(successesA, totalA);
  assertCount(successesB, totalB);
  const successes = successesA + successesB;
  const total = totalA + totalB;
  const logFact = logFactorials(total);
  const logChoose = (n: number, k: number) => logFact[n]! - logFact[k]! - logFact[n - k]!;
  const logDenominator = logChoose(total, successes);
  const probability = (a: number) => Math.exp(logChoose(totalA, a) + logChoose(totalB, successes - a) - logDenominator);

  const observed = probability(successesA);
  const low = Math.max(0, successes - totalB);
  const high = Math.min(totalA, successes);
  let p = 0;
  for (let a = low; a <= high; a++) {
    const value = probability(a);
    if (value <= observed * (1 + 1e-7)) p += value;
  }
  return Math.min(1, p);
}

/** 성공 비율의 Wilson 점수 구간(기본 95%). 작은 표본에서 정규 근사 구간보다 덜 틀린다. 실행이 없으면 [0, 1] */
export function wilsonInterval(successes: number, total: number, z = 1.959963984540054): [number, number] {
  assertCount(successes, total);
  if (total === 0) return [0, 1];
  const rate = successes / total;
  const z2 = z * z;
  const center = (rate + z2 / (2 * total)) / (1 + z2 / total);
  const half = (z / (1 + z2 / total)) * Math.sqrt((rate * (1 - rate)) / total + z2 / (4 * total * total));
  return [successes === 0 ? 0 : Math.max(0, center - half), successes === total ? 1 : Math.min(1, center + half)];
}

/** p값을 셋째 자리까지. 0.001 밑은 `<0.001` */
export function formatP(p: number): string {
  return p < 0.001 ? '<0.001' : p.toFixed(3);
}
