import { appendFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { Gen } from './differential-kit';
import { compareScreenshot, VisualCompareError } from './visual-compare';
import { compareScreenshot as legacyCompare, VisualCompareError as LegacyError } from './visual-compare-legacy';
import { buildPng, CHANNELS, joinChunks, splitChunks, type PngSpec } from './visual-compare-png-kit';

/**
 * 디자인 비교를 Rust로 옮기면서(ADR-191 3ae) 옛 TS(`visual-compare-legacy.ts`, pngjs 7.0.0 + pixelmatch 7.2.0)와 새 껍데기에 같은 PNG 쌍·가림·threshold를
 * 넣어 결과를 견준다. 결과는 JSON 글자로(비율·픽셀 수·크기, 차이 이미지는 pngjs로 디코드한 픽셀)견준다. 인코딩 바이트는 다르다(의도한 차이).
 *
 * 세 가지를 센다. "다름": 둘 다 값을 냈는데 JSON이 다르다. "열림": 다름 가운데 새 비율이 옛 비율보다 작은 것(옛 실패가 새 통과가 될 수 있음) +
 * 옛이 던진 입력을 새가 받은 것. "닫힘": 옛이 받은 입력을 새가 던진 것(규격에 없는 PNG 꼴 등 의도한 차이만 있어야 한다).
 *
 * 크기는 환경 변수로 바꾼다: VISUAL_COMPARE_DIFF_SEEDS(쉼표 목록), VISUAL_COMPARE_DIFF_ITERATIONS, VISUAL_COMPARE_MUTATION_ITERATIONS,
 * VISUAL_COMPARE_DIFF_REPORT=1(분포 출력), VISUAL_COMPARE_DIFF_REPORT_FILE(출력 파일)
 */

const SEEDS = (process.env.VISUAL_COMPARE_DIFF_SEEDS ?? '1,7,42,2026').split(',').map(Number);
const ITERATIONS = Number(process.env.VISUAL_COMPARE_DIFF_ITERATIONS ?? 400);
const MUTATIONS = Number(process.env.VISUAL_COMPARE_MUTATION_ITERATIONS ?? 600);
const REPORT = process.env.VISUAL_COMPARE_DIFF_REPORT === '1';

function report(line: string): void {
  console.log(line);
  const file = process.env.VISUAL_COMPARE_DIFF_REPORT_FILE;
  if (file) appendFileSync(file, `${line}\n`);
}

type Mask = { x: number; y: number; width: number; height: number };
type Result = { threw: 'compare'; message: string } | { threw: 'error'; message: string } | { threw: false; json: string; ratio: number; diffPixels: number };

function decodeDiff(diff: Buffer): string {
  const png = PNG.sync.read(diff);
  return `${png.width}x${png.height}:${Buffer.from(png.data).toString('base64')}`;
}

function run(fn: typeof compareScreenshot, compareError: typeof VisualCompareError | typeof LegacyError, actual: Buffer, reference: Buffer, masks: Mask[], threshold: number): Result {
  try {
    const r = fn({ actual, reference, masks, threshold });
    return { threw: false, json: JSON.stringify({ ratio: r.ratio, diffPixels: r.diffPixels, comparedPixels: r.comparedPixels, width: r.width, height: r.height, diff: decodeDiff(r.diff) }), ratio: r.ratio, diffPixels: r.diffPixels };
  } catch (error) {
    if (error instanceof compareError) return { threw: 'compare', message: error.message };
    return { threw: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/** IHDR가 적은 크기(서명 뒤 첫 청크). 읽을 수 없으면 0 */
function declaredPixels(png: Buffer): number {
  if (png.length < 24) return 0;
  return png.readUInt32BE(16) * png.readUInt32BE(20);
}

/** 옛 pngjs는 IHDR가 수억 픽셀을 적으면 줄마다 배열을 키우다 힙을 다 써서 프로세스가 죽는다(시험 중 실제로 겪었다). 그 입력은 옛을 돌리지 않고 새가 던지는지만 본다 */
const OLD_SAFE_PIXELS = 4_000_000;

interface Tally {
  compared: number;
  same: number;
  bothThrow: number;
  different: number;
  opened: number;
  acceptedFlip: number;
  closed: number;
  closedUnexpected: number;
  distribution: Map<string, number>;
  examples: string[];
}

function newTally(): Tally {
  return { compared: 0, same: 0, bothThrow: 0, different: 0, opened: 0, acceptedFlip: 0, closed: 0, closedUnexpected: 0, distribution: new Map(), examples: [] };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** `expectClosed`: 규격에 없는 PNG 꼴처럼 새가 거절해도 되는 입력 */
function judge(t: Tally, label: string, oldResult: Result, newResult: Result, expectClosed: boolean, describeCase: () => string): void {
  t.compared++;
  if (oldResult.threw && newResult.threw) {
    if (expectClosed) {
      // 옛은 다른 사유(너비 불일치 등)로, 새는 읽지 못해 던졌다. 둘 다 던졌으므로 게이트는 실패로 알린다(사유·종류가 달라도 된다)
      t.bothThrow++;
    } else if (oldResult.threw !== newResult.threw || (oldResult.threw === 'compare' && newResult.threw === 'compare' && oldResult.message !== newResult.message)) {
      t.different++;
      if (t.examples.length < 60) t.examples.push(`던짐 종류가 다르다 ${JSON.stringify(oldResult)} / ${JSON.stringify(newResult)} ${describeCase()}`);
    } else t.bothThrow++;
    bump(t.distribution, `${label}:둘 다 던짐`);
    return;
  }
  if (oldResult.threw && !newResult.threw) {
    t.acceptedFlip++;
    t.opened++;
    bump(t.distribution, `${label}:옛 던짐→새 받음`);
    if (t.examples.length < 60) t.examples.push(`옛 던짐→새 받음 옛=${JSON.stringify(oldResult)} 변이=${lastMutation} ${describeCase()}`);
    return;
  }
  if (!oldResult.threw && newResult.threw) {
    t.closed++;
    if (!expectClosed) {
      t.closedUnexpected++;
      if (t.examples.length < 60) t.examples.push(`옛 값→새 던짐(${JSON.stringify(newResult)}) ${describeCase()}`);
    }
    bump(t.distribution, `${label}:옛 값→새 던짐`);
    return;
  }
  if (!oldResult.threw && !newResult.threw) {
    if (oldResult.json === newResult.json) {
      t.same++;
      bump(t.distribution, `${label}:${oldResult.diffPixels === 0 ? '차이 0' : '차이 있음'}`);
    } else {
      t.different++;
      if (newResult.ratio < oldResult.ratio || newResult.diffPixels < oldResult.diffPixels) t.opened++;
      if (t.examples.length < 60) t.examples.push(`값이 다르다 변이=${lastMutation} old=${oldResult.json.slice(0, 120)} new=${newResult.json.slice(0, 120)} ${describeCase()}`);
    }
  }
}

// ── 입력 만들기

type Format = { colorType: PngSpec['colorType']; depth: PngSpec['depth']; invalid?: boolean };
const FORMATS: ReadonlyArray<readonly [number, Format]> = [
  [20, { colorType: 6, depth: 8 }],
  [15, { colorType: 2, depth: 8 }],
  [8, { colorType: 0, depth: 8 }],
  [6, { colorType: 4, depth: 8 }],
  [6, { colorType: 3, depth: 8 }],
  [2, { colorType: 3, depth: 4 }],
  [2, { colorType: 3, depth: 2 }],
  [2, { colorType: 3, depth: 1 }],
  [2, { colorType: 0, depth: 4 }],
  [2, { colorType: 0, depth: 2 }],
  [2, { colorType: 0, depth: 1 }],
  [4, { colorType: 0, depth: 16 }],
  [4, { colorType: 2, depth: 16 }],
  [3, { colorType: 4, depth: 16 }],
  [4, { colorType: 6, depth: 16 }],
  // 규격에 없는 조합: pngjs는 읽고 png 크레이트는 거절한다(닫는 쪽 차이)
  [1, { colorType: 2, depth: 4, invalid: true }],
  [1, { colorType: 3, depth: 16, invalid: true }],
  [1, { colorType: 6, depth: 4, invalid: true }],
  [1, { colorType: 4, depth: 2, invalid: true }],
];

interface Base {
  width: number;
  height: number;
  /** 픽셀마다 r,g,b,a(0..255) */
  px: number[];
}

function makeBase(g: Gen, width: number, height: number): Base {
  const levels = [0, 255, 128, 64, 200, g.int(256)];
  const colors = Array.from({ length: 3 + g.int(3) }, () => [g.pick(levels), g.pick(levels), g.pick(levels), g.chance(0.7) ? 255 : g.pick([0, 1, 100, 128, 254])]);
  const px: number[] = [];
  const block = 1 + g.int(4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = colors[(Math.floor(x / block) + Math.floor(y / block) * 3) % colors.length]!;
      px.push(...color);
    }
  }
  return { width, height, px };
}

/** 기준에서 조금 바꾼 그림(작은 값 차이·큰 값 차이·낱낱 픽셀 바꾸기) */
function perturb(g: Gen, base: Base, height: number): Base {
  const rate = g.pick([0, 0.02, 0.1, 0.3, 0.6]);
  const px: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < base.width; x++) {
      const from = ((y % base.height) * base.width + x) * 4;
      let pixel = base.px.slice(from, from + 4);
      if (g.chance(rate)) {
        const mode = g.int(3);
        if (mode === 0) pixel = pixel.map((v, c) => (c < 3 ? Math.max(0, Math.min(255, v + g.int(81) - 40)) : v));
        else if (mode === 1) pixel = [g.int(256), g.int(256), g.int(256), g.pick([255, 255, 0, 128])];
        else pixel = pixel.map((v, c) => (c === 3 ? v : 255 - v));
      }
      px.push(...pixel);
    }
  }
  return { width: base.width, height, px };
}

function toSamples(g: Gen, base: Base, format: Format): { spec: PngSpec } {
  const { width, height } = base;
  const max = 2 ** format.depth - 1;
  const channels = CHANNELS[format.colorType]!;
  const scale = (v: number) => Math.round((v / 255) * max);
  const samples: number[] = [];
  let palette: Array<[number, number, number]> | undefined;
  let trns: number[] | undefined;
  if (format.colorType === 3) {
    const size = Math.min(2 ** Math.min(format.depth, 8), 1 + g.int(40));
    palette = Array.from({ length: size }, () => [g.int(256), g.int(256), g.int(256)]);
    // 같은 기준 색은 같은 번호로
    const index = (r: number, gg: number, b: number) => (r * 31 + gg * 17 + b * 7) % size;
    for (let i = 0; i < width * height; i++) samples.push(g.chance(0.01) ? Math.min(max, size + g.int(3)) : index(base.px[i * 4]!, base.px[i * 4 + 1]!, base.px[i * 4 + 2]!));
    if (g.chance(0.5)) trns = Array.from({ length: g.int(size + 1) }, () => g.pick([0, 255, 128, 1, 254, g.int(256)]));
  } else {
    for (let i = 0; i < width * height; i++) {
      const [r, gg, b, a] = [base.px[i * 4]!, base.px[i * 4 + 1]!, base.px[i * 4 + 2]!, base.px[i * 4 + 3]!];
      if (channels === 1) samples.push(scale(r));
      else if (channels === 2) samples.push(scale(r), scale(a));
      else if (channels === 3) samples.push(scale(r), scale(gg), scale(b));
      else samples.push(scale(r), scale(gg), scale(b), scale(a));
    }
    if ((format.colorType === 0 || format.colorType === 2) && g.chance(0.3)) {
      // 투명 색: 이미 있는 표본 값이거나 마음대로 고른 값(16비트로 적는다)
      const pick = () => (g.chance(0.7) ? samples[g.int(samples.length)]! : g.int(2 ** Math.min(16, format.depth + 1)));
      const words = format.colorType === 0 ? [pick()] : [pick(), pick(), pick()];
      trns = words.flatMap((v) => [(v >> 8) & 0xff, v & 0xff]);
    }
  }
  const spec: PngSpec = {
    width,
    height,
    depth: format.depth,
    colorType: format.colorType,
    samples,
    ...(palette ? { palette } : {}),
    ...(trns ? { trns } : {}),
    ...(g.chance(0.3) ? { interlace: true } : {}),
    ...(g.chance(0.15) ? { gamma: g.int(200000) } : {}),
    ...(g.chance(0.1) ? { idatSplit: 1 + g.int(30) } : {}),
    ...(g.chance(0.1) ? { ancillary: true } : {}),
    ...(g.chance(0.25) ? { filter: ((type: number) => () => type)(g.int(5)) } : {}),
  };
  return { spec };
}

function makeMask(g: Gen, width: number, height: number): Mask {
  const mode = g.int(12);
  const inside = () => ({ x: g.int(width), y: g.int(height), width: 1 + g.int(width), height: 1 + g.int(height) });
  switch (mode) {
    case 0:
      return { x: -g.int(5), y: -g.int(5), width: g.int(width + 5), height: g.int(height + 5) };
    case 1:
      return { x: width - 1, y: height - 1, width: 1 + g.int(20), height: 1 + g.int(20) };
    case 2:
      return { x: g.int(width) + 0.5, y: g.int(height) + 0.5, width: 1 + g.int(width), height: 1 + g.int(height) };
    case 3:
      return { x: g.int(width), y: g.int(height), width: g.pick([0, -1, 0.5, 1.5, 2.25]), height: g.pick([0, -3, 0.5, 1.5, 2.75]) };
    case 4:
      return { ...inside(), x: g.pick([NaN, Infinity, -Infinity, 1e9, -1e9]) };
    case 5:
      return { ...inside(), width: g.pick([NaN, Infinity, 1e300, -Infinity]) };
    case 6:
      return { ...inside(), y: g.pick([NaN, Infinity, -Infinity, 1e9]) };
    case 7:
      return { ...inside(), height: g.pick([NaN, Infinity, 1e300]) };
    case 8:
      return { x: g.int(width * 3) / 3, y: g.int(height * 3) / 3, width: (1 + g.int(width * 3)) / 3, height: (1 + g.int(height * 3)) / 3 };
    case 9:
      return { x: 0, y: 0, width: width + g.int(3), height: height + g.int(3) };
    default:
      return inside();
  }
}

interface Case {
  actual: Buffer;
  reference: Buffer;
  masks: Mask[];
  threshold: number;
  label: string;
  invalid: boolean;
  describe: () => string;
}

function makeCase(g: Gen): Case {
  const small = g.chance(0.8);
  const width = 1 + g.int(small ? 9 : 40);
  const height = 1 + g.int(small ? 9 : 40);
  const refBase = makeBase(g, width, height);
  const refFormat = pickFormat(g);
  const actFormat = g.chance(0.5) ? refFormat : pickFormat(g);
  const actualWidth = g.chance(0.05) ? width + 1 + g.int(3) : width;
  const actualHeight = g.chance(0.3) ? Math.max(1, height + g.int(7) - 3) : height;
  const actualBase = perturb(g, actualWidth === width ? refBase : makeBase(g, actualWidth, height), actualHeight);
  const refSpec = toSamples(g, refBase, refFormat).spec;
  const actSpec = toSamples(g, actualBase, actFormat).spec;
  const masks = Array.from({ length: g.chance(0.5) ? 0 : 1 + g.int(3) }, () => makeMask(g, width, height));
  const threshold = g.pick([0.1, 0.1, 0, 1, 0.05, 0.3, g.int(1001) / 1000]);
  const actual = buildPng(actSpec);
  const referencePng = buildPng(refSpec);
  return {
    actual,
    reference: referencePng,
    masks,
    threshold,
    label: `${refFormat.colorType}/${refFormat.depth}${refSpec.interlace ? 'i' : ''}`,
    invalid: Boolean(refFormat.invalid || actFormat.invalid),
    describe: () => `act=${actual.toString('base64')} ref=${referencePng.toString('base64')} masks=${JSON.stringify(masks)} t=${threshold}`,
  };
}

function pickFormat(g: Gen): Format {
  return g.weighted(FORMATS);
}

const tallies = new Map<string, Tally>();
function tally(name: string): Tally {
  let t = tallies.get(name);
  if (!t) {
    t = newTally();
    tallies.set(name, t);
  }
  return t;
}

const formatCounts = new Map<string, number>();
let hugeHeaders = 0;

describe('디자인 비교 차등 시험(옛 TS와 Rust 껍데기)', () => {
  for (const seed of SEEDS) {
    it(`시드 ${seed}: ${ITERATIONS}회 PNG 쌍이 옛 TS와 같다`, () => {
      const g = new Gen(seed);
      const t = tally('PNG 쌍');
      for (let i = 0; i < ITERATIONS; i++) {
        const c = makeCase(g);
        bump(formatCounts, c.label.replace(/i$/, ''));
        const oldResult = run(legacyCompare, LegacyError, c.actual, c.reference, c.masks, c.threshold);
        const newResult = run(compareScreenshot, VisualCompareError, c.actual, c.reference, c.masks, c.threshold);
        judge(t, c.label.replace(/i$/, ''), oldResult, newResult, c.invalid, c.describe);
      }
    }, 600_000);
  }

  for (const seed of SEEDS) {
    it(`시드 ${seed}: 바이트를 망가뜨린 PNG ${MUTATIONS}회에서 옛이 던진 입력을 새가 받지 않는다`, () => {
      const g = new Gen(seed + 1000);
      const t = tally('바이트 변이');
      for (let i = 0; i < MUTATIONS; i++) {
        const base = makeCase(g);
        const target = g.chance(0.5) ? base.actual : base.reference;
        const other = target === base.actual ? base.reference : base.actual;
        const mutated = mutate(g, target);
        const forwards = g.chance(0.5);
        const [a, b] = forwards ? [mutated, other] : [other, mutated];
        // 크기가 다른 입력이 잡다하게 섞이도록 상대는 그대로 둔다. 새가 거절해도 되는 PNG 꼴이 아니므로 닫힘은 센다만 한다(변이는 바이트 규칙이 달라 닫힘이 나올 수 있다)
        const newResult = run(compareScreenshot, VisualCompareError, a, b, [], 0.1);
        if (declaredPixels(a) > OLD_SAFE_PIXELS || declaredPixels(b) > OLD_SAFE_PIXELS) {
          hugeHeaders++;
          if (!newResult.threw) t.different++;
          continue;
        }
        const oldResult = run(legacyCompare, LegacyError, a, b, [], 0.1);
        judge(t, '변이', oldResult, newResult, true, () => `a=${a.toString('base64')} b=${b.toString('base64')}`);
      }
    }, 600_000);
  }

  it('차등 시험의 결과 분포(출력)', () => {
    if (REPORT) {
      for (const [name, t] of tallies) {
        report(`${name}: 비교 ${t.compared}, 같음 ${t.same}, 둘 다 던짐 ${t.bothThrow}, 다름 ${t.different}, 열림(비율 감소·옛 던짐→새 받음) ${t.opened}, 옛 던짐→새 받음 ${t.acceptedFlip}, 닫힘(옛 값→새 던짐) ${t.closed}, 예상 밖 닫힘 ${t.closedUnexpected}`);
        report(`  분포 ${JSON.stringify(Object.fromEntries([...t.distribution].sort()))}`);
      }
      report(`IHDR가 수백만 픽셀 넘게 적은 변이(옛을 돌리지 않음, 새는 모두 던졌다) ${hugeHeaders}건`);
      report(`PNG 꼴(기준 쪽) ${JSON.stringify(Object.fromEntries([...formatCounts].sort()))}`);
    }
    expect(tallies.size).toBe(2);
  });

  it('다른 결과·열린 쪽 뒤집힘·예상 밖 닫힘이 0이다', () => {
    const bad = [...tallies].filter(([, t]) => t.different > 0 || t.opened > 0 || t.acceptedFlip > 0 || t.closedUnexpected > 0).map(([name, t]) => `${name}: 다름 ${t.different} 열림 ${t.opened} 받음 ${t.acceptedFlip} 예상 밖 닫힘 ${t.closedUnexpected}\n${t.examples.join('\n')}`);
    expect(bad).toEqual([]);
  });

  it('입력이 비지 않았다: PNG 꼴·차이 있음·차이 0·던짐·닫힘이 모두 나온다', () => {
    const t = tally('PNG 쌍');
    expect(t.compared).toBe(SEEDS.length * ITERATIONS);
    const keys = [...t.distribution.keys()];
    expect(keys.some((key) => key.endsWith(':차이 있음'))).toBe(true);
    expect(keys.some((key) => key.endsWith(':차이 0'))).toBe(true);
    expect(keys.some((key) => key.endsWith(':둘 다 던짐'))).toBe(true);
    expect(t.same).toBeGreaterThan(t.compared / 2);
    for (const formatKey of ['6/8', '2/8', '0/8', '4/8', '3/8', '3/4', '3/2', '3/1', '0/4', '0/2', '0/1', '0/16', '2/16', '4/16', '6/16']) expect([...formatCounts.keys()], formatKey).toContain(formatKey);
    expect(tally('바이트 변이').distribution.size).toBeGreaterThanOrEqual(3);
  });

  it('대조 장치: 옛 구현의 결과·입력을 한 칸만 바꿔도 차이로 잡힌다', () => {
    const g = new Gen(99);
    let resultOff = 0;
    let maskShifted = 0;
    let thresholdFlipped = 0;
    let cases = 0;
    for (let i = 0; i < 300; i++) {
      const c = makeCase(g);
      if (c.invalid) continue;
      const newResult = run(compareScreenshot, VisualCompareError, c.actual, c.reference, c.masks, c.threshold);
      if (newResult.threw) continue;
      cases++;
      const off = run((o) => ({ ...legacyCompare(o), diffPixels: legacyCompare(o).diffPixels + 1 }), LegacyError, c.actual, c.reference, c.masks, c.threshold);
      if (!off.threw && off.json !== newResult.json) resultOff++;
      // 가림 경계를 한 칸 줄이면(옛 구현의 경계 하나를 바꾼 것) 가림이 있는 입력 가운데 일부가 달라진다
      const narrowed = run(legacyCompare, LegacyError, c.actual, c.reference, c.masks.map((m) => ({ ...m, width: m.width - 1 })), c.threshold);
      if (c.masks.length > 0 && !narrowed.threw && narrowed.json !== newResult.json) maskShifted++;
      // threshold의 경계(>를 >=처럼): 한 칸 낮추면 달라지는 입력이 있다
      const lowered = run(legacyCompare, LegacyError, c.actual, c.reference, c.masks, Math.max(0, c.threshold - 0.04));
      if (!lowered.threw && lowered.json !== newResult.json) thresholdFlipped++;
    }
    expect(cases).toBeGreaterThan(100);
    expect(resultOff).toBe(cases);
    expect(maskShifted).toBeGreaterThan(0);
    expect(thresholdFlipped).toBeGreaterThan(0);
  });
});

// ── 바이트 변이: 청크 안의 한 바이트(CRC를 고쳐 쓰거나 그대로 두거나), 청크 빼기·복제·순서 바꾸기, 자르기, 덧붙이기, zlib 끝 건드리기

let lastMutation = -1;

function mutate(g: Gen, png: Buffer): Buffer {
  const chunks = splitChunks(png);
  lastMutation = g.int(12);
  switch (lastMutation) {
    case 0: {
      const copy = Buffer.from(png);
      copy[g.int(copy.length)] = g.int(256);
      return copy;
    }
    case 1:
      return png.subarray(0, g.int(png.length));
    case 2:
      return Buffer.concat([png, Buffer.from(Array.from({ length: 1 + g.int(5) }, () => g.int(256)))]);
    case 3: {
      const i = g.int(chunks.length);
      return joinChunks(chunks.filter((_, at) => at !== i));
    }
    case 4: {
      const i = g.int(chunks.length);
      return joinChunks([...chunks.slice(0, i + 1), chunks[i]!, ...chunks.slice(i + 1)]);
    }
    case 5: {
      const next = [...chunks];
      const a = g.int(next.length);
      const b = g.int(next.length);
      [next[a], next[b]] = [next[b]!, next[a]!];
      return joinChunks(next);
    }
    case 6: {
      // 청크 본문 한 바이트를 바꾸고 CRC를 다시 쓴다(CRC가 가리지 못하게)
      const next = chunks.map((c) => ({ type: c.type, data: Buffer.from(c.data) }));
      const target = next[g.int(next.length)]!;
      if (target.data.length > 0) target.data[g.int(target.data.length)] = g.int(256);
      return joinChunks(next);
    }
    case 7: {
      // IDAT의 zlib 끝(adler32)을 건드리고 CRC를 다시 쓴다
      const next = chunks.map((c) => ({ type: c.type, data: Buffer.from(c.data) }));
      const idats = next.filter((c) => c.type === 'IDAT');
      const last = idats.at(-1);
      if (last && last.data.length > 0) {
        const at = last.data.length - 1 - g.int(Math.min(4, last.data.length));
        last.data[at] = last.data[at]! ^ (1 << g.int(8));
      }
      return joinChunks(next);
    }
    case 8: {
      // IDAT 끝에 쓰레기를 덧붙인다
      const next = chunks.map((c) => ({ type: c.type, data: Buffer.from(c.data) }));
      const last = next.filter((c) => c.type === 'IDAT').at(-1);
      if (last) last.data = Buffer.concat([last.data, Buffer.from(Array.from({ length: 1 + g.int(6) }, () => g.int(256)))]);
      return joinChunks(next);
    }
    case 9: {
      // IHDR 필드(크기·깊이·색 종류·인터레이스)를 바꾸고 CRC를 다시 쓴다
      const next = chunks.map((c) => ({ type: c.type, data: Buffer.from(c.data) }));
      const ihdr = next[0]!;
      const field = g.int(5);
      if (field === 0) ihdr.data.writeUInt32BE(Math.max(0, ihdr.data.readUInt32BE(0) + g.int(3) - 1), 0);
      else if (field === 1) ihdr.data.writeUInt32BE(Math.max(0, ihdr.data.readUInt32BE(4) + g.int(3) - 1), 4);
      else if (field === 2) ihdr.data[8] = g.pick([1, 2, 4, 8, 16, 3, 0]);
      else if (field === 3) ihdr.data[9] = g.pick([0, 2, 3, 4, 6, 1, 5]);
      else ihdr.data[12] = g.pick([0, 1, 2]);
      return joinChunks(next);
    }
    case 10: {
      // 알려지지 않은 청크(보조·필수)를 끼워 넣는다. 보조 청크는 CRC를 틀리게 써 보기도 한다
      const type = g.pick(['tEXt', 'prVt', 'XyZw', 'acTL', 'fcTL', 'fdAT', 'bKGD', 'sRGB', 'cHRM']);
      const body = Buffer.from(Array.from({ length: g.int(12) }, () => g.int(256)));
      const at = 1 + g.int(chunks.length);
      const next = [...chunks.slice(0, at), { type, data: body }, ...chunks.slice(at)];
      const joined = joinChunks(next);
      if (g.chance(0.3)) {
        const crcAt = 8 + chunks.slice(0, at).reduce((sum, c) => sum + 12 + c.data.length, 0) + 8 + body.length;
        joined[crcAt] = joined[crcAt]! ^ 0xff;
      }
      return joined;
    }
    default: {
      // PLTE·tRNS·gAMA 본문 길이를 바꾼다
      const next = chunks.map((c) => ({ type: c.type, data: Buffer.from(c.data) }));
      const pick = next.filter((c) => ['PLTE', 'tRNS', 'gAMA'].includes(c.type));
      const target = pick.length > 0 ? pick[g.int(pick.length)]! : next[1]!;
      target.data = g.chance(0.5) ? target.data.subarray(0, Math.max(0, target.data.length - 1 - g.int(3))) : Buffer.concat([target.data, Buffer.from([g.int(256), g.int(256)])]);
      return joinChunks(next);
    }
  }
}
