import { appendFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { compareScreenshot, VisualCompareError } from './visual-compare';
import { compareScreenshot as legacyCompare, VisualCompareError as LegacyError } from './visual-compare-legacy';
import { buildPng, chunk, joinChunks, SIGNATURE, splitChunks, type PngSpec } from './visual-compare-png-kit';
import { VECTOR_EXPECTED } from './visual-compare-vectors-expected';

/**
 * 디자인 비교(ADR-191 3ae)의 벡터. 기대값은 옛 TS(`visual-compare-legacy.ts`, pngjs 7.0.0 + pixelmatch 7.2.0)가 낸 값이다
 * (`visual-compare-vectors-expected.ts`; 만드는 법은 그 파일 머리말). `intended`가 적힌 벡터만 옛 TS와 일부러 다르다: 옛 TS에서는 이 벡터의 기대값이 맞지 않아야 하고
 * (그것도 시험한다), 이유를 적었다.
 *
 * 경계는 정확히 밟는다: threshold 경계(회색 차이 26과 27), 가림 경계(±1), 너비 ±1, 높이 ±1, 16비트 확대 반올림 경계(128과 129).
 */

type Rgba = readonly [number, number, number, number];
const WHITE: Rgba = [255, 255, 255, 255];
const BLACK: Rgba = [0, 0, 0, 255];

function rgba(width: number, height: number, paint: (x: number, y: number) => Rgba = () => WHITE, extra: Partial<PngSpec> = {}): Buffer {
  const samples: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) samples.push(...paint(x, y));
  return buildPng({ width, height, depth: 8, colorType: 6, samples, ...extra });
}

const gray = (v: number): Rgba => [v, v, v, 255];
/** 한 픽셀만 다른 12x12 */
const dot = (color: Rgba, at: [number, number] = [6, 6]) => rgba(12, 12, (x, y) => (x === at[0] && y === at[1] ? color : WHITE));

type Output = { kind: 'ok'; diffPixels: number; comparedPixels: number; width: number; height: number; diffHash: string } | { kind: 'compare'; message: string } | { kind: 'error' };

interface Vector {
  name: string;
  actual: Buffer;
  reference: Buffer;
  masks?: Array<{ x: number; y: number; width: number; height: number }>;
  threshold?: number;
  /** 옛 TS와 일부러 다른 이유. 이 벡터의 새 쪽 기대값(`now`)은 옛 TS에서 맞지 않는다 */
  intended?: string;
  /** 의도한 차이의 새 쪽 기대값 */
  now?: Output;
  /** 옛 TS를 돌리지 않는 이유(돌릴 때마다 결과가 다르거나 프로세스가 죽는다). 옛 쪽 기대값은 한 번 돌린 값일 뿐이다 */
  skipOld?: string;
}

const vectors: Vector[] = [];
const add = (v: Vector) => vectors.push(v);

// ── 같은 그림·threshold 경계(회색 차이 d의 색 차이는 0.5053·d²이고 threshold 0.1의 한계는 352.15라 d=26은 같음, d=27은 다름)
add({ name: '같은 이미지', actual: rgba(12, 12), reference: rgba(12, 12) });
add({ name: '회색 차이 26은 threshold 0.1에서 다르지 않다', actual: dot(gray(255 - 26)), reference: rgba(12, 12) });
add({ name: '회색 차이 27은 threshold 0.1에서 다르다', actual: dot(gray(255 - 27)), reference: rgba(12, 12) });
add({ name: 'threshold 0이면 차이 1도 센다', actual: dot(gray(254)), reference: rgba(12, 12), threshold: 0 });
add({ name: 'threshold 0에서 같은 이미지는 0이다', actual: rgba(12, 12), reference: rgba(12, 12), threshold: 0 });
add({ name: 'threshold 1은 흰색과 검정도 같다고 본다', actual: dot(BLACK), reference: rgba(12, 12), threshold: 1 });
add({ name: 'threshold 0.99는 흰색과 검정을 다르다고 본다', actual: dot(BLACK), reference: rgba(12, 12), threshold: 0.99 });
add({ name: 'threshold 0.05: 회색 차이 13은 같고 14는 다르다(13)', actual: dot(gray(255 - 13)), reference: rgba(12, 12), threshold: 0.05 });
add({ name: 'threshold 0.05: 회색 차이 14는 다르다', actual: dot(gray(255 - 14)), reference: rgba(12, 12), threshold: 0.05 });
// 최대 차이 상수(35215)를 못 박는다: 회색 차이 27의 색 차이 D에 대해 35215·t²가 D보다 t²/2 위(같음)와 아래(다름)가 되게 threshold를 고른다.
// 상수가 한 칸이라도 커지면(여는 쪽) 아래 벡터가, 작아지면 위 벡터가 바뀐다
const GRAY27_DELTA = (() => {
  const d = 27;
  const y = d * 0.29889531 + d * 0.58662247 + d * 0.11448223;
  const i = d * 0.59597799 - d * 0.2741761 - d * 0.32180189;
  const q = d * 0.21147017 - d * 0.52261711 + d * 0.31114694;
  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
})();
add({ name: '최대 차이 상수 경계: 한계가 차이보다 반 칸 위면 같다', actual: dot(gray(255 - 27)), reference: rgba(12, 12), threshold: Math.sqrt(GRAY27_DELTA / 35214.5) });
add({ name: '최대 차이 상수 경계: 한계가 차이보다 반 칸 아래면 다르다', actual: dot(gray(255 - 27)), reference: rgba(12, 12), threshold: Math.sqrt(GRAY27_DELTA / 35215.5) });
add({ name: '색 채널 하나만 큰 차이', actual: dot([255, 255, 0, 255]), reference: rgba(12, 12) });
add({ name: '알파 254와 255', actual: dot([255, 255, 255, 254]), reference: rgba(12, 12) });
add({ name: '알파 0과 255(흰색)', actual: dot([255, 255, 255, 0]), reference: rgba(12, 12) });
add({ name: '완전 투명이면 색이 달라도 같다', actual: rgba(12, 12, () => [10, 20, 30, 0]), reference: rgba(12, 12, () => [200, 100, 50, 0]) });
add({ name: '반투명 두 장의 차이', actual: rgba(12, 12, (x) => [x * 20, 0, 0, 128]), reference: rgba(12, 12, (x) => [x * 20 + 6, 0, 0, 128]) });
add({ name: '검은 한 줄(안티앨리어싱 아님)', actual: rgba(12, 12, (_x, y) => (y === 6 ? BLACK : WHITE)), reference: rgba(12, 12) });
add({
  name: '안티앨리어싱으로 보이는 경계 한 픽셀은 세지 않는다',
  actual: rgba(12, 12, (x) => (x < 6 ? BLACK : x === 6 ? gray(128) : WHITE)),
  reference: rgba(12, 12, (x) => (x < 6 ? BLACK : x === 6 ? gray(60) : WHITE)),
});
add({
  name: '경계가 한 칸 밀린 가장자리는 세지 않거나 센다',
  actual: rgba(12, 12, (x) => (x < 6 ? BLACK : WHITE)),
  reference: rgba(12, 12, (x) => (x < 7 ? BLACK : WHITE)),
});
add({
  name: '대각선 계단',
  actual: rgba(16, 16, (x, y) => (x + y < 16 ? BLACK : WHITE)),
  reference: rgba(16, 16, (x, y) => (x + y < 17 ? BLACK : WHITE)),
});
add({ name: '1x1 같음', actual: rgba(1, 1), reference: rgba(1, 1) });
add({ name: '1x1 다름', actual: rgba(1, 1, () => BLACK), reference: rgba(1, 1) });
add({ name: '모서리 픽셀 다름', actual: dot(BLACK, [0, 0]), reference: rgba(12, 12) });
add({ name: '반대 모서리 픽셀 다름', actual: dot(BLACK, [11, 11]), reference: rgba(12, 12) });

// ── 너비·높이
add({ name: '너비 +1', actual: rgba(13, 12), reference: rgba(12, 12) });
add({ name: '너비 -1', actual: rgba(11, 12), reference: rgba(12, 12) });
add({ name: '높이 +1은 겹치는 높이만 본다', actual: rgba(12, 13, (_x, y) => (y === 12 ? BLACK : WHITE)), reference: rgba(12, 12) });
add({ name: '높이 -1은 겹치는 높이만 본다', actual: rgba(12, 11), reference: rgba(12, 12, (_x, y) => (y === 11 ? BLACK : WHITE)) });
add({ name: '높이가 달라도 겹치는 줄의 차이는 센다', actual: rgba(12, 20, (_x, y) => (y === 3 ? BLACK : WHITE)), reference: rgba(12, 12) });
add({ name: '높이 1과 12', actual: rgba(12, 1), reference: rgba(12, 12) });

// ── 가림: 차이 사각형은 (4,4)~(7,7)(4x4). 경계 ±1을 모두 밟는다
const square = () => rgba(12, 12, (x, y) => (x >= 4 && x <= 7 && y >= 4 && y <= 7 ? BLACK : WHITE));
const refW = () => rgba(12, 12);
const m = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
add({ name: '가림이 사각형과 정확히 같다', actual: square(), reference: refW(), masks: [m(4, 4, 4, 4)] });
add({ name: '가림 너비 -1', actual: square(), reference: refW(), masks: [m(4, 4, 3, 4)] });
add({ name: '가림 높이 -1', actual: square(), reference: refW(), masks: [m(4, 4, 4, 3)] });
add({ name: '가림 x +1', actual: square(), reference: refW(), masks: [m(5, 4, 4, 4)] });
add({ name: '가림 y +1', actual: square(), reference: refW(), masks: [m(4, 5, 4, 4)] });
add({ name: '가림이 사각형보다 한 칸 넓다', actual: square(), reference: refW(), masks: [m(3, 3, 6, 6)] });
add({ name: '가림 두 개의 합집합', actual: square(), reference: refW(), masks: [m(4, 4, 2, 4), m(6, 4, 2, 4)] });
add({ name: '가림 두 개 사이에 한 열이 남는다', actual: square(), reference: refW(), masks: [m(4, 4, 1, 4), m(6, 4, 2, 4)] });
add({ name: '기준 그림의 차이도 가림이 가린다', actual: refW(), reference: square(), masks: [m(4, 4, 4, 4)] });
add({ name: '가림 없음', actual: square(), reference: refW(), masks: [] });
add({ name: '가림이 이미지 밖에서 걸친다(음수 x)', actual: square(), reference: refW(), masks: [m(-10, -10, 16, 16)] });
add({ name: '가림이 이미지를 넘친다', actual: square(), reference: refW(), masks: [m(0, 0, 1000, 1000)] });
add({ name: '가림이 이미지 오른쪽 아래 밖이다', actual: square(), reference: refW(), masks: [m(12, 12, 5, 5)] });
add({ name: '가림이 마지막 열·줄만 가린다', actual: dot(BLACK, [11, 11]), reference: refW(), masks: [m(11, 11, 5, 5)] });
add({ name: '가림이 마지막 열 바로 앞까지만이다', actual: dot(BLACK, [11, 11]), reference: refW(), masks: [m(0, 0, 11, 11)] });
add({ name: '가림 너비 0', actual: square(), reference: refW(), masks: [m(4, 4, 0, 4)] });
add({ name: '가림 음수 너비', actual: square(), reference: refW(), masks: [m(8, 4, -4, 4)] });
add({ name: '가림 NaN x', actual: square(), reference: refW(), masks: [m(NaN, 4, 4, 4)] });
add({ name: '가림 NaN 너비', actual: square(), reference: refW(), masks: [m(4, 4, NaN, 4)] });
add({ name: '가림 NaN y', actual: square(), reference: refW(), masks: [m(4, NaN, 4, 4)] });
add({ name: '가림 NaN 높이', actual: square(), reference: refW(), masks: [m(4, 4, 4, NaN)] });
add({ name: '가림 Infinity 너비', actual: square(), reference: refW(), masks: [m(0, 0, Infinity, 12)] });
add({ name: '가림 -Infinity x', actual: square(), reference: refW(), masks: [m(-Infinity, 0, Infinity, 12)] });
add({ name: '가림 x +Infinity', actual: square(), reference: refW(), masks: [m(Infinity, 0, 12, 12)] });
add({ name: '가림 소수 x(0.5)', actual: square(), reference: refW(), masks: [m(3.5, 4, 4, 4)] });
add({ name: '가림 소수 y(0.5)', actual: square(), reference: refW(), masks: [m(4, 3.5, 4, 4)] });
add({ name: '가림 소수 너비(3.5)', actual: square(), reference: refW(), masks: [m(4, 4, 3.5, 4)] });
add({ name: '가림 소수 높이(3.5)', actual: square(), reference: refW(), masks: [m(4, 4, 4, 3.5)] });
add({ name: '가림 소수 x,y(4.5)와 너비·높이 4', actual: square(), reference: refW(), masks: [m(4.5, 4.5, 4, 4)] });
add({ name: '가림 소수 y는 줄을 어긋나게 칠한다', actual: rgba(12, 12, (x, y) => (y >= 5 ? BLACK : WHITE)), reference: refW(), masks: [m(0, 0.5, 12, 12)] });
add({ name: '가림 소수 한 칸 미만(0.5x0.5)', actual: square(), reference: refW(), masks: [m(4, 4, 0.5, 0.5)] });
add({ name: '가림 1e9 x', actual: square(), reference: refW(), masks: [m(1e9, 4, 4, 4)] });
add({ name: '가림 -1e9 x와 1e9+8 너비', actual: square(), reference: refW(), masks: [m(-1e9, 0, 1e9 + 8, 12)] });
add({ name: '가림이 잘려 나가는 아래쪽 줄만 가린다(높이가 다른 그림)', actual: rgba(12, 20, (x, y) => (y === 15 ? BLACK : WHITE)), reference: rgba(12, 12), masks: [m(0, 12, 12, 8)] });
add({ name: '가림이 겹치는 높이 안쪽만 가린다', actual: rgba(12, 20, (x, y) => (y === 11 ? BLACK : WHITE)), reference: rgba(12, 12), masks: [m(0, 12, 12, 8)] });

// ── PNG 꼴: 같은 그림을 여러 형식으로 쓰면 같다고 나와야 하고, 형식마다 한 칸 다른 값은 다르다고 나와야 한다
const pxList = (w: number, h: number, f: (i: number) => number) => Array.from({ length: w * h }, (_, i) => f(i));
for (const depth of [1, 2, 4, 8, 16] as const) {
  const max = 2 ** depth - 1;
  const samples = pxList(6, 6, (i) => (i * 7 + 3) % (max + 1));
  const same = (v: number) => (depth === 8 ? v : depth === 16 ? Math.round((v / 65535) * 255) : Math.round((v / max) * 255));
  const eight = rgba(6, 6, (x, y) => gray(same(samples[y * 6 + x]!)));
  add({ name: `회색조 ${depth}비트 = 같은 그림의 RGBA8`, actual: buildPng({ width: 6, height: 6, depth, colorType: 0, samples }), reference: eight, threshold: 0 });
  add({ name: `회색조 ${depth}비트 인터레이스 = 같은 그림의 RGBA8`, actual: buildPng({ width: 6, height: 6, depth, colorType: 0, samples, interlace: true }), reference: eight, threshold: 0 });
  add({ name: `회색조 ${depth}비트와 어두운 기준`, actual: buildPng({ width: 6, height: 6, depth, colorType: 0, samples }), reference: rgba(6, 6, () => gray(0)), threshold: 0 });
}
for (const depth of [1, 2, 4, 8] as const) {
  const palette: Array<[number, number, number]> = Array.from({ length: Math.min(2 ** depth, 6) }, (_, i) => [i * 40, 255 - i * 30, (i * 97) % 256]);
  const samples = pxList(6, 6, (i) => (i * 5 + 1) % palette.length);
  const eight = rgba(6, 6, (x, y) => [...palette[samples[y * 6 + x]!]!, 255] as unknown as Rgba);
  add({ name: `팔레트 ${depth}비트 = 같은 그림의 RGBA8`, actual: buildPng({ width: 6, height: 6, depth, colorType: 3, samples, palette }), reference: eight, threshold: 0 });
  add({ name: `팔레트 ${depth}비트 인터레이스 + tRNS`, actual: buildPng({ width: 6, height: 6, depth, colorType: 3, samples, palette, interlace: true, trns: [0, 128, 255] }), reference: eight, threshold: 0 });
}
add({ name: 'tRNS 팔레트: 알파 0·128·255', actual: buildPng({ width: 3, height: 1, depth: 8, colorType: 3, samples: [0, 1, 2], palette: [[255, 0, 0], [0, 255, 0], [0, 0, 255]], trns: [0, 128] }), reference: rgba(3, 1, (x) => [[255, 0, 0, 0], [0, 255, 0, 128], [0, 0, 255, 255]][x] as unknown as Rgba), threshold: 0 });
add({ name: '팔레트 번호가 팔레트 밖이면 던진다', actual: buildPng({ width: 2, height: 1, depth: 8, colorType: 3, samples: [0, 5], palette: [[1, 2, 3], [4, 5, 6]] }), reference: rgba(2, 1) });
add({ name: 'RGB 8비트', actual: buildPng({ width: 3, height: 1, depth: 8, colorType: 2, samples: [255, 0, 0, 0, 255, 0, 0, 0, 255] }), reference: rgba(3, 1, (x) => [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]][x] as unknown as Rgba), threshold: 0 });
add({ name: 'RGB 16비트(반올림: 0x0080은 0, 0x0081은 1)', actual: buildPng({ width: 2, height: 1, depth: 16, colorType: 2, samples: [128, 128, 128, 129, 129, 129] }), reference: rgba(2, 1, (x) => (x === 0 ? [0, 0, 0, 255] : [1, 1, 1, 255])), threshold: 0 });
add({ name: 'RGB 16비트(반올림 경계 한 칸 위: 0x0080이 1)', actual: buildPng({ width: 2, height: 1, depth: 16, colorType: 2, samples: [128, 128, 128, 129, 129, 129] }), reference: rgba(2, 1, () => [1, 1, 1, 255]), threshold: 0 });
add({ name: '회색조+알파 8비트', actual: buildPng({ width: 2, height: 1, depth: 8, colorType: 4, samples: [100, 255, 100, 128] }), reference: rgba(2, 1, (x) => (x === 0 ? [100, 100, 100, 255] : [100, 100, 100, 128])), threshold: 0 });
add({ name: '회색조+알파 16비트', actual: buildPng({ width: 2, height: 1, depth: 16, colorType: 4, samples: [25700, 65535, 25700, 32896] }), reference: rgba(2, 1, (x) => (x === 0 ? [100, 100, 100, 255] : [100, 100, 100, 128])), threshold: 0 });
add({ name: 'RGBA 16비트', actual: buildPng({ width: 1, height: 1, depth: 16, colorType: 6, samples: [65535, 0, 32768, 65535] }), reference: rgba(1, 1, () => [255, 0, 128, 255]), threshold: 0 });
add({ name: 'tRNS 회색조 8비트: 투명 색 100', actual: buildPng({ width: 3, height: 1, depth: 8, colorType: 0, samples: [100, 101, 99], trns: [0, 100] }), reference: rgba(3, 1, (x) => (x === 0 ? [0, 0, 0, 0] : x === 1 ? [101, 101, 101, 255] : [99, 99, 99, 255])), threshold: 0 });
add({ name: 'tRNS 회색조 8비트: 투명 색이 256 이상이면 어느 픽셀과도 맞지 않는다', actual: buildPng({ width: 2, height: 1, depth: 8, colorType: 0, samples: [0, 255], trns: [1, 0] }), reference: rgba(2, 1, (x) => (x === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255])), threshold: 0 });
add({ name: 'tRNS 회색조 16비트: 투명 색 0x0102', actual: buildPng({ width: 2, height: 1, depth: 16, colorType: 0, samples: [258, 259], trns: [1, 2] }), reference: rgba(2, 1, (x) => (x === 0 ? [0, 0, 0, 0] : [1, 1, 1, 255])), threshold: 0 });
add({ name: 'tRNS 회색조 2비트: 투명 색 2', actual: buildPng({ width: 3, height: 1, depth: 2, colorType: 0, samples: [2, 1, 3], trns: [0, 2] }), reference: rgba(3, 1, (x) => (x === 0 ? [0, 0, 0, 0] : x === 1 ? [85, 85, 85, 255] : [255, 255, 255, 255])), threshold: 0 });
add({ name: 'tRNS RGB 8비트: 세 값이 모두 맞아야 투명', actual: buildPng({ width: 3, height: 1, depth: 8, colorType: 2, samples: [1, 2, 3, 1, 2, 4, 1, 9, 3], trns: [0, 1, 0, 2, 0, 3] }), reference: rgba(3, 1, (x) => (x === 0 ? [0, 0, 0, 0] : x === 1 ? [1, 2, 4, 255] : [1, 9, 3, 255])), threshold: 0 });
add({ name: 'tRNS RGB 16비트', actual: buildPng({ width: 2, height: 1, depth: 16, colorType: 2, samples: [513, 514, 515, 513, 514, 516], trns: [2, 1, 2, 2, 2, 3] }), reference: rgba(2, 1, (x) => (x === 0 ? [0, 0, 0, 0] : [2, 2, 2, 255])), threshold: 0 });
add({ name: 'tRNS가 알파 있는 색 종류에서는 쓰이지 않는다', actual: buildPng({ width: 1, height: 1, depth: 8, colorType: 4, samples: [100, 200], trns: [0, 100] }), reference: rgba(1, 1, () => [100, 100, 100, 200]), threshold: 0 });
add({ name: 'gAMA는 픽셀을 바꾸지 않는다', actual: buildPng({ width: 2, height: 2, depth: 8, colorType: 6, samples: pxList(2, 2, (i) => i * 60).flatMap((v) => [v, v, v, 255]), gamma: 45455 }), reference: rgba(2, 2, (x, y) => gray((y * 2 + x) * 60)), threshold: 0 });
add({ name: '필터 종류를 모두 쓴 줄', actual: buildPng({ width: 8, height: 5, depth: 8, colorType: 6, samples: pxList(8, 5, (i) => (i * 31) % 251).flatMap((v) => [v, 255 - v, (v * 3) % 256, 255]) }), reference: rgba(8, 5, (x, y) => { const v = ((y * 8 + x) * 31) % 251; return [v, 255 - v, (v * 3) % 256, 255]; }), threshold: 0 });
add({ name: 'IDAT를 여러 청크로 나눠도 같다', actual: rgba(12, 12, undefined, { idatSplit: 7 }), reference: rgba(12, 12) });
add({ name: '모르는 보조 청크는 건너뛴다', actual: rgba(12, 12, undefined, { ancillary: true }), reference: rgba(12, 12) });


/** 1x1 RGBA(0,0,0,0) 이미지의 IDAT를 손으로 쓴 zlib 바이트로 바꾼다 */
function adler32(bytes: readonly number[]): number {
  let a = 1;
  let b = 0;
  for (const v of bytes) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}
function pngWithIdat(zlibBytes: Buffer, width = 1, height = 1): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlibBytes), chunk('IEND', Buffer.alloc(0))]);
}
function storedZlib(raw: number[], opts: { header?: [number, number]; nlenBad?: boolean; lenExtra?: number; adlerBad?: boolean } = {}): Buffer {
  const [cmf, flg] = opts.header ?? [0x78, 0x01];
  const len = raw.length + (opts.lenExtra ?? 0);
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE((adler32(raw) ^ (opts.adlerBad ? 1 : 0)) >>> 0);
  return Buffer.concat([Buffer.from([cmf, flg, 0x01, len & 0xff, len >> 8, opts.nlenBad ? 0 : ~len & 0xff, opts.nlenBad ? 0 : (~len >> 8) & 0xff]), Buffer.from(raw), adler]);
}
/** FLG의 확인 비트(하위 5비트)를 맞춘다. base는 상위 3비트(FDICT 0x20 등) */
const fcheck = (cmf: number, base: number) => base + ((31 - ((cmf * 256 + base) % 31)) % 31);
const clear = rgba(1, 1, () => [0, 0, 0, 0]);

// ── 읽지 못하는 PNG(던진다)
const okPng = rgba(12, 12);
const withChunks = (edit: (chunks: Array<{ type: string; data: Buffer }>) => Array<{ type: string; data: Buffer }>) => joinChunks(edit(splitChunks(okPng)));
add({ name: '빈 버퍼', actual: Buffer.alloc(0), reference: okPng });
add({ name: 'PNG가 아닌 글자', actual: Buffer.from('not a png at all'), reference: okPng });
add({ name: '서명만 있다', actual: SIGNATURE, reference: okPng });
add({ name: '끝이 잘렸다(IEND 없음)', actual: okPng.subarray(0, okPng.length - 12), reference: okPng });
add({ name: '끝이 한 바이트 잘렸다', actual: okPng.subarray(0, okPng.length - 1), reference: okPng });
add({ name: '끝에 한 바이트 더 있다', actual: Buffer.concat([okPng, Buffer.from([0])]), reference: okPng });
add({ name: '서명 한 바이트가 다르다', actual: Buffer.concat([Buffer.from([0x88]), okPng.subarray(1)]), reference: okPng });
add({ name: '기준이 읽히지 않아도 던진다', actual: okPng, reference: Buffer.from('nope') });
add({ name: 'IHDR 뒤 필수 청크 CRC가 틀렸다', actual: (() => { const copy = Buffer.from(okPng); copy[29] = copy[29]! ^ 1; return copy; })(), reference: okPng });
add({ name: 'IDAT의 CRC가 틀렸다', actual: (() => { const copy = Buffer.from(okPng); copy[copy.length - 17] = copy[copy.length - 17]! ^ 1; return copy; })(), reference: okPng });
add({ name: '모르는 보조 청크의 CRC가 틀려도 건너뛴다', actual: (() => { const c = chunk('prVt', Buffer.from([1, 2, 3])); c[c.length - 1] = c[c.length - 1]! ^ 1; const [sig, rest] = [okPng.subarray(0, 8), okPng.subarray(8)]; const ihdrEnd = 8 + 12 + 13; return Buffer.concat([sig, rest.subarray(0, ihdrEnd - 8), c, okPng.subarray(ihdrEnd)]); })(), reference: okPng });
add({ name: '모르는 필수 청크', actual: withChunks((c) => [c[0]!, { type: 'XyZw', data: Buffer.from([1]) }, ...c.slice(1)]), reference: okPng });
add({ name: '첫 청크가 IHDR이 아니다', actual: withChunks((c) => [{ type: 'tEXt', data: Buffer.from('a\0b') }, ...c]), reference: okPng });
add({ name: 'IDAT가 없다', actual: withChunks((c) => c.filter((x) => x.type !== 'IDAT')), reference: okPng, now: { kind: 'error' }, skipOld: '불안정', intended: '옛 pngjs는 IDAT가 없는 PNG를 초기화되지 않은 메모리(Buffer.allocUnsafe)로 읽는다: 돌릴 때마다 모든 픽셀이 0인 이미지로 받거나 필터 종류 오류로 던진다(그림이 통째로 없어도 받는다). 새는 거절한다(닫는 쪽)' });
add({ name: 'IEND가 없다', actual: withChunks((c) => c.filter((x) => x.type !== 'IEND')), reference: okPng });
add({ name: 'IEND 뒤에 청크가 더 있다', actual: withChunks((c) => [...c, { type: 'tEXt', data: Buffer.from('a\0b') }]), reference: okPng });
add({ name: 'IHDR가 둘이다', actual: withChunks((c) => [c[0]!, c[0]!, ...c.slice(1)]), reference: okPng, now: { kind: 'error' }, intended: '옛 pngjs는 둘째 IHDR로 메타데이터를 다시 정한다. 새는 거절한다(닫는 쪽)' });
add({ name: 'IDAT가 떨어져 있다(사이에 보조 청크)', actual: rgba(12, 12, undefined, { idatSplit: 20 }), reference: okPng });
add({ name: 'gAMA가 3바이트다', actual: withChunks((c) => [c[0]!, { type: 'gAMA', data: Buffer.from([0, 0, 1]) }, ...c.slice(1)]), reference: okPng });
add({ name: 'gAMA가 5바이트다', actual: withChunks((c) => [c[0]!, { type: 'gAMA', data: Buffer.from([0, 0, 1, 2, 3]) }, ...c.slice(1)]), reference: okPng });
add({ name: 'IHDR가 12바이트다', actual: withChunks((c) => [{ type: 'IHDR', data: c[0]!.data.subarray(0, 12) }, ...c.slice(1)]), reference: okPng });
add({ name: '비트 깊이 3', actual: withChunks((c) => [{ type: 'IHDR', data: Buffer.from(c[0]!.data.map((v, i) => (i === 8 ? 3 : v))) }, ...c.slice(1)]), reference: okPng });
add({ name: '색 종류 1', actual: withChunks((c) => [{ type: 'IHDR', data: Buffer.from(c[0]!.data.map((v, i) => (i === 9 ? 1 : v))) }, ...c.slice(1)]), reference: okPng });
add({ name: '압축 방식 1', actual: withChunks((c) => [{ type: 'IHDR', data: Buffer.from(c[0]!.data.map((v, i) => (i === 10 ? 1 : v))) }, ...c.slice(1)]), reference: okPng });
add({ name: '필터 방식 1', actual: withChunks((c) => [{ type: 'IHDR', data: Buffer.from(c[0]!.data.map((v, i) => (i === 11 ? 1 : v))) }, ...c.slice(1)]), reference: okPng });
add({ name: '인터레이스 방식 2', actual: withChunks((c) => [{ type: 'IHDR', data: Buffer.from(c[0]!.data.map((v, i) => (i === 12 ? 2 : v))) }, ...c.slice(1)]), reference: okPng });
add({ name: '팔레트 색 종류인데 PLTE가 없다', actual: withChunks((c) => [{ type: 'IHDR', data: Buffer.from(c[0]!.data.map((v, i) => (i === 9 ? 3 : v))) }, ...c.slice(1)]), reference: okPng });
add({ name: 'tRNS가 PLTE보다 앞이다', actual: (() => { const p = buildPng({ width: 2, height: 1, depth: 8, colorType: 3, samples: [0, 1], palette: [[1, 2, 3], [4, 5, 6]], trns: [255] }); const c = splitChunks(p); const t = c.findIndex((x) => x.type === 'tRNS'); const l = c.findIndex((x) => x.type === 'PLTE'); [c[t], c[l]] = [c[l]!, c[t]!]; return joinChunks(c); })(), reference: rgba(2, 1) });
add({ name: 'tRNS가 팔레트보다 길다', actual: buildPng({ width: 2, height: 1, depth: 8, colorType: 3, samples: [0, 1], palette: [[1, 2, 3], [4, 5, 6]], trns: [255, 255, 255] }), reference: rgba(2, 1) });
add({ name: 'tRNS가 팔레트와 같은 길이다', actual: buildPng({ width: 2, height: 1, depth: 8, colorType: 3, samples: [0, 1], palette: [[1, 2, 3], [4, 5, 6]], trns: [255, 255] }), reference: rgba(2, 1, () => [1, 2, 3, 255]) });
add({ name: '회색조 tRNS가 1바이트다', actual: buildPng({ width: 1, height: 1, depth: 8, colorType: 0, samples: [1], trns: [0] }), reference: rgba(1, 1) });
add({ name: 'RGB tRNS가 5바이트다', actual: buildPng({ width: 1, height: 1, depth: 8, colorType: 2, samples: [1, 2, 3], trns: [0, 1, 0, 2, 0] }), reference: rgba(1, 1) });
add({ name: '압축을 푼 데이터가 모자라다(잘린 마지막 줄)', actual: buildPng({ width: 5, height: 4, depth: 8, colorType: 6, samples: pxList(5, 4, (i) => i * 4).flatMap((v) => [v, v, v, 255]), cutRaw: 3 }), reference: rgba(5, 4), now: { kind: 'error' }, intended: '옛 pngjs는 인터레이스가 아닌 PNG의 잘린 마지막 줄을 0으로 채워 읽는다. 새는 거절한다(닫는 쪽)' });
add({ name: '압축을 푼 데이터가 남는다', actual: buildPng({ width: 5, height: 4, depth: 8, colorType: 6, samples: Array(80).fill(0), extraRaw: [0, 1, 2] }), reference: rgba(5, 4) });
add({ name: '인터레이스 PNG에서 압축을 푼 데이터가 남는다', actual: buildPng({ width: 5, height: 4, depth: 8, colorType: 6, samples: Array(80).fill(0), extraRaw: [0, 1, 2], interlace: true }), reference: rgba(5, 4) });
add({ name: '인터레이스 PNG에서 압축을 푼 데이터가 모자라다', actual: buildPng({ width: 5, height: 4, depth: 8, colorType: 6, samples: Array(80).fill(0), cutRaw: 3, interlace: true }), reference: rgba(5, 4) });
add({
  name: 'IDAT 끝에 쓰레기가 붙었다',
  actual: withChunks((c) => c.map((x) => (x.type === 'IDAT' ? { ...x, data: Buffer.concat([x.data, Buffer.from([1, 2, 3])]) } : x))),
  reference: okPng,
});
add({
  name: '인터레이스 PNG의 IDAT 끝에 쓰레기가 붙었다',
  actual: (() => { const p = buildPng({ width: 5, height: 4, depth: 8, colorType: 6, samples: Array(80).fill(0), interlace: true }); return joinChunks(splitChunks(p).map((x) => (x.type === 'IDAT' ? { ...x, data: Buffer.concat([x.data, Buffer.from([1, 2, 3])]) } : x))); })(),
  reference: rgba(5, 4),
  now: { kind: 'error' }, intended: '옛 pngjs는 인터레이스 PNG의 압축 스트림 뒤 쓰레기 바이트를 무시한다. 새는 스트림이 정확히 끝나지 않으면 거절한다(닫는 쪽)',
});
add({
  name: 'adler32가 틀렸다',
  actual: withChunks((c) => c.map((x) => { if (x.type !== 'IDAT') return x; const d = Buffer.from(x.data); d[d.length - 1] = d[d.length - 1]! ^ 1; return { ...x, data: d }; })),
  reference: okPng,
  now: { kind: 'error' },
  intended: '옛 pngjs는 인터레이스가 아닌 PNG에서 이미지를 다 채우면 멈춰 adler32를 보지 않는다. 새는 스트림 끝까지 확인한다(닫는 쪽)',
});
add({ name: '규격에 없는 조합: RGB 4비트', actual: buildPng({ width: 2, height: 2, depth: 4, colorType: 2, samples: Array(12).fill(5) }), reference: rgba(2, 2), now: { kind: 'error' }, intended: '옛 pngjs는 규격에 없는 깊이·색 조합도 읽는다. 새는 거절한다(닫는 쪽)' });
add({ name: '규격에 없는 조합: 팔레트 16비트', actual: buildPng({ width: 2, height: 1, depth: 16, colorType: 3, samples: [0, 1], palette: [[1, 2, 3], [4, 5, 6]] }), reference: rgba(2, 1) });

// ── 손으로 쓴 zlib 스트림(저장 블록)과 모든 바이트가 0인 이미지(뒤로 참조가 맨 앞 바이트를 가리킨다)
add({ name: '저장 블록 zlib으로 쓴 1x1', actual: pngWithIdat(storedZlib([0, 0, 0, 0, 0])), reference: clear, threshold: 0 });
add({ name: '저장 블록 NLEN이 틀렸다', actual: pngWithIdat(storedZlib([0, 0, 0, 0, 0], { nlenBad: true })), reference: clear , now: { kind: 'error' }, intended: '옛 pngjs가 압축을 푸는 데 실패해도 던지지 않고 초기화되지 않은 메모리를 픽셀로 읽는다(돌릴 때마다 다르다). 새는 거절한다(닫는 쪽)', skipOld: '불안정' });
add({ name: '저장 블록 LEN이 남은 바이트보다 길다', actual: pngWithIdat(storedZlib([0, 0, 0, 0, 0], { lenExtra: 3 })), reference: clear , now: { kind: 'error' }, intended: '옛 pngjs가 압축을 푸는 데 실패해도 던지지 않고 초기화되지 않은 메모리를 픽셀로 읽는다(돌릴 때마다 다르다). 새는 거절한다(닫는 쪽)', skipOld: '불안정' });
add({ name: '저장 블록 adler32가 틀렸다', actual: pngWithIdat(storedZlib([0, 0, 0, 0, 0], { adlerBad: true })), reference: clear, intended: '옛 pngjs는 인터레이스가 아닌 PNG에서 이미지를 다 채우면 멈춰 adler32를 보지 않는다. 새는 끝까지 확인한다(닫는 쪽)', now: { kind: 'error' } });
add({ name: 'zlib 머리에 사전 표시(FDICT)가 있다', actual: pngWithIdat(storedZlib([0, 0, 0, 0, 0], { header: [0x78, fcheck(0x78, 0x20)] })), reference: clear , now: { kind: 'error' }, intended: '옛 pngjs가 압축을 푸는 데 실패해도 던지지 않고 초기화되지 않은 메모리를 픽셀로 읽는다(돌릴 때마다 다르다). 새는 거절한다(닫는 쪽)', skipOld: '불안정' });
add({ name: 'zlib 압축 방식이 8이 아니다', actual: pngWithIdat(storedZlib([0, 0, 0, 0, 0], { header: [0x79, fcheck(0x79, 0)] })), reference: clear , now: { kind: 'error' }, intended: '옛 pngjs가 압축을 푸는 데 실패해도 던지지 않고 초기화되지 않은 메모리를 픽셀로 읽는다(돌릴 때마다 다르다). 새는 거절한다(닫는 쪽)', skipOld: '불안정' });
add({ name: 'zlib 머리 확인 비트가 틀렸다', actual: pngWithIdat(storedZlib([0, 0, 0, 0, 0], { header: [0x78, 0x02] })), reference: clear , now: { kind: 'error' }, intended: '옛 pngjs가 압축을 푸는 데 실패해도 던지지 않고 초기화되지 않은 메모리를 픽셀로 읽는다(돌릴 때마다 다르다). 새는 거절한다(닫는 쪽)', skipOld: '불안정' });
add({ name: '모든 바이트가 0인 이미지(첫 바이트를 가리키는 뒤로 참조)', actual: buildPng({ width: 16, height: 16, depth: 8, colorType: 6, samples: Array(1024).fill(0), filter: () => 0 }), reference: rgba(16, 16, () => [0, 0, 0, 0]), threshold: 0 });
add({ name: '모든 바이트가 0인 이미지와 흰색 기준', actual: buildPng({ width: 16, height: 16, depth: 8, colorType: 6, samples: Array(1024).fill(0), filter: () => 0 }), reference: rgba(16, 16) });

// ── 입력이 이상한 경우(옛 코드가 열린 쪽으로 틀린 곳과 상한)
const zeroWidth = (() => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(0, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', Buffer.from('789c6360000000020001', 'hex')), chunk('IEND', Buffer.alloc(0))]);
})();
add({ name: '너비 0인 PNG 두 장', actual: zeroWidth, reference: zeroWidth, now: { kind: 'compare', message: '이미지 크기가 0입니다 (0x2px)' }, intended: '옛 코드는 비교한 픽셀 0개로 비율 0(통과)을 냈다. 새는 VisualCompareError로 던져 게이트가 실패로 알린다' });
add({ name: 'threshold NaN', actual: dot(BLACK), reference: rgba(12, 12), threshold: NaN, now: { kind: 'compare', message: 'threshold는 0~1의 수여야 합니다 (NaN)' }, intended: '옛 코드는 NaN threshold에서 어떤 차이도 세지 않아 비율 0(통과)을 냈다. 새는 던진다' });
add({ name: 'threshold -0.1', actual: dot(BLACK), reference: rgba(12, 12), threshold: -0.1, now: { kind: 'compare', message: 'threshold는 0~1의 수여야 합니다 (-0.1)' }, intended: '옛 코드는 음수 threshold를 제곱해 받았다(0.1로 동작). 새는 0~1 밖이면 던진다' });
add({ name: 'threshold 1.5', actual: dot(BLACK), reference: rgba(12, 12), threshold: 1.5, now: { kind: 'compare', message: 'threshold는 0~1의 수여야 합니다 (1.5)' }, intended: '옛 코드는 1보다 큰 threshold를 받아 차이를 하나도 세지 않았다. 새는 0~1 밖이면 던진다' });
add({ name: 'threshold Infinity', actual: dot(BLACK), reference: rgba(12, 12), threshold: Infinity, now: { kind: 'compare', message: 'threshold는 0~1의 수여야 합니다 (inf)' }, intended: '옛 코드는 무한 threshold에서 차이를 하나도 세지 않았다. 새는 던진다' });
add({ name: 'threshold 1은 받는다(경계)', actual: dot(BLACK), reference: rgba(12, 12), threshold: 1 });
add({ name: 'threshold 0은 받는다(경계)', actual: dot(BLACK), reference: rgba(12, 12), threshold: 0 });
const hugeHeader = (() => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(100_000, 0);
  ihdr.writeUInt32BE(100_000, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', Buffer.from('789c6360000000020001', 'hex')), chunk('IEND', Buffer.alloc(0))]);
})();
add({ name: 'IHDR가 100000x100000을 적었다(읽기 전에 거절)', actual: hugeHeader, reference: okPng, now: { kind: 'compare', message: '이미지가 너무 큽니다 (100000x100000px, 최대 50000000픽셀)' }, skipOld: '프로세스가 죽는다', intended: '옛 코드는 줄마다 배열을 키우다 힙이 바닥나 프로세스가 죽을 수 있다(시험 중 실제로 겪음). 새는 읽기 전에 IHDR 크기로 던진다' });

// ── 차이 이미지: 픽셀 값
add({ name: '차이 이미지: 같은 그림은 회색(흰색 255, 검정 229)', actual: rgba(2, 1, (x) => (x === 0 ? WHITE : BLACK)), reference: rgba(2, 1, (x) => (x === 0 ? WHITE : BLACK)) });
add({ name: '차이 이미지: 다른 픽셀은 빨강, 같은 픽셀은 회색', actual: rgba(3, 3, (x, y) => (x === 1 && y === 1 ? BLACK : WHITE)), reference: rgba(3, 3) });
add({ name: '차이 이미지: 안티앨리어싱은 노랑', actual: rgba(12, 12, (x) => (x < 6 ? BLACK : x === 6 ? gray(128) : WHITE)), reference: rgba(12, 12, (x) => (x < 6 ? BLACK : x === 6 ? gray(60) : WHITE)) });
add({ name: '차이 이미지: 반투명 픽셀의 회색', actual: rgba(2, 2, () => [200, 100, 50, 100]), reference: rgba(2, 2, () => [200, 100, 50, 100]) });

// ── 시험 본체

function summarize(fn: typeof compareScreenshot, errorClass: typeof VisualCompareError | typeof LegacyError, v: Vector): Output {
  try {
    const r = fn({ actual: v.actual, reference: v.reference, ...(v.masks ? { masks: v.masks } : {}), ...(v.threshold !== undefined ? { threshold: v.threshold } : {}) });
    const png = PNG.sync.read(r.diff);
    return { kind: 'ok', diffPixels: r.diffPixels, comparedPixels: r.comparedPixels, width: r.width, height: r.height, diffHash: `${png.width}x${png.height}:${Buffer.from(png.data).toString('hex')}` };
  } catch (error) {
    return error instanceof errorClass ? { kind: 'compare', message: (error as Error).message } : { kind: 'error' };
  }
}

const printPath = process.env.VISUAL_COMPARE_VECTORS_PRINT;

describe('디자인 비교 벡터(기대값은 옛 TS가 낸 값)', () => {
  it('이름이 겹치지 않는다', () => {
    expect(new Set(vectors.map((v) => v.name)).size).toBe(vectors.length);
  });

  if (printPath) {
    it('옛 TS가 낸 기대값을 파일로 쓴다(VISUAL_COMPARE_VECTORS_PRINT)', () => {
      const table = Object.fromEntries(vectors.filter((v) => v.skipOld !== '프로세스가 죽는다').map((v) => [v.name, summarize(legacyCompare, LegacyError, v)]));
      appendFileSync(printPath, `${JSON.stringify(table)}\n`);
    });
    return;
  }

  for (const v of vectors) {
    it(v.intended ? `[의도한 차이] ${v.name}` : v.name, () => {
      const got = summarize(compareScreenshot, VisualCompareError, v);
      if (!v.intended) {
        expect(VECTOR_EXPECTED[v.name], '기대값이 없다').toBeDefined();
        expect(got).toEqual(VECTOR_EXPECTED[v.name]);
        return;
      }
      expect(got).toEqual(v.now);
      // 열린 쪽으로 틀리지 않는다: 옛이 던진 입력은 새도 던지고, 옛이 값을 냈으면 새는 값을 내지 않거나 비율이 더 크다
      const old = VECTOR_EXPECTED[v.name] as Output | undefined;
      if (old?.kind === 'error' || old?.kind === 'compare') expect(got.kind).not.toBe('ok');
      if (got.kind === 'ok' && old?.kind === 'ok') expect(got.diffPixels / got.comparedPixels).toBeGreaterThanOrEqual(old.diffPixels / old.comparedPixels);
    });
  }

  it('옛 TS에 같은 기대값을 돌리면 의도한 차이만 실패한다', () => {
    const failures: string[] = [];
    let ran = 0;
    let skipped = 0;
    for (const v of vectors) {
      // 옛 pngjs는 IHDR가 수억 픽셀을 적으면 힙을 다 써서 프로세스가 죽는다. 돌리지 않고 의도한 차이로 센다
      if (v.skipOld) {
        // 옛 pngjs 결과가 돌릴 때마다 다르거나(초기화되지 않은 메모리) 프로세스가 죽는다. 돌리지 않고 의도한 차이로 센다
        failures.push(v.name);
        skipped++;
        continue;
      }
      ran++;
      const old = summarize(legacyCompare, LegacyError, v);
      const want = v.intended ? v.now : VECTOR_EXPECTED[v.name];
      if (JSON.stringify(old) !== JSON.stringify(want)) failures.push(v.name);
    }
    expect(failures.sort()).toEqual(vectors.filter((v) => v.intended).map((v) => v.name).sort());
    expect(ran).toBe(vectors.length - skipped);
    expect(skipped).toBe(vectors.filter((v) => v.skipOld).length);
  });

  it('벡터가 두 갈래로 나뉜다: 값, 던짐(compare), 던짐(error)이 모두 있다', () => {
    const kinds = new Set(Object.values(VECTOR_EXPECTED).map((e) => (e as Output).kind));
    expect(kinds).toEqual(new Set(['ok', 'compare', 'error']));
    expect(vectors.length).toBeGreaterThanOrEqual(130);
  });
});

