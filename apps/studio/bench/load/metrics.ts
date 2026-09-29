/**
 * 부하 스모크의 핵심 계산. 서버를 띄우지 않고도 검증할 수 있게 순수 함수로 둔다.
 * 부하 스크립트(studio-load.ts)는 여기의 백분위·집계만 써서 표와 JSON을 만든다.
 */

export interface LatencySummary {
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
}

/** 값이 가장 가까운 순위의 값을 돌려준다. p는 0~100. 값이 없으면 0 */
export function percentile(values: readonly number[], p: number): number {
  if (!(p >= 0 && p <= 100)) throw new Error(`백분위는 0~100이어야 합니다 (지금 값: ${p})`);
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // 개수 4개에서 p50이면 두 번째(아래쪽 중앙값)를 고른다. 같은 입력에 항상 같은 답을 내는 규칙이면 된다
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

export function summarize(values: readonly number[]): LatencySummary {
  if (values.length === 0) return { count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, meanMs: 0 };
  let min = values[0]!;
  let max = values[0]!;
  let sum = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  return { count: values.length, minMs: min, p50Ms: percentile(values, 50), p95Ms: percentile(values, 95), maxMs: max, meanMs: sum / values.length };
}

/** 보낸 수보다 적게 받았으면 떨어진 수. 더 받았으면(중복 등) 0으로 둔다 */
export function countDropped(produced: number, received: number): number {
  return Math.max(0, produced - received);
}

export function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

/** 사람이 읽는 표 한 장. 열 수가 다르면 빈 칸으로 둔다 */
export function renderTable(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) => Math.max(...all.map((row) => (row[column] ?? '').length)));
  return all.map((row) => headers.map((_, column) => (row[column] ?? '').padEnd(widths[column]!)).join('  ').trimEnd()).join('\n');
}
