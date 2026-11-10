import { deflateSync } from 'node:zlib';

/**
 * 디자인 비교(ADR-191 3ae) 시험이 쓰는 PNG 만들기. pngjs의 쓰기는 8·16비트 RGB/RGBA뿐이라 팔레트·회색조·1~4비트·인터레이스·tRNS를 직접 쓴다.
 * 시험 파일(`visual-compare-*.test.ts`)만 쓴다. 제품 코드는 이 파일을 쓰지 않는다.
 */

export interface PngSpec {
  width: number;
  height: number;
  depth: 1 | 2 | 4 | 8 | 16;
  /** 0 회색조, 2 RGB, 3 팔레트, 4 회색조+알파, 6 RGBA */
  colorType: 0 | 2 | 3 | 4 | 6;
  interlace?: boolean;
  /** 래스터 순서로 `width*height*채널 수`개. 각 값은 0..2^depth-1 */
  samples: readonly number[];
  palette?: ReadonlyArray<readonly [number, number, number]>;
  /** tRNS 청크 본문(그대로) */
  trns?: readonly number[];
  gamma?: number;
  /** 줄마다 쓸 필터 종류(0~4). 기본은 줄 번호에 따라 돌린다 */
  filter?: (row: number) => number;
  /** IDAT를 이만큼씩 나눠 여러 청크로 쓴다 */
  idatSplit?: number;
  /** 압축 전 바이트 뒤에 덧붙인다(옛·새 읽기가 "남는 데이터"를 어떻게 다루는지 본다) */
  extraRaw?: readonly number[];
  /** 압축 전 바이트의 끝을 이만큼 자른다 */
  cutRaw?: number;
  /** 보조 청크를 IHDR 바로 뒤에 둔다 */
  ancillary?: boolean;
}

export const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function packRow(values: readonly number[], depth: number): number[] {
  const out: number[] = [];
  if (depth === 8) return [...values];
  if (depth === 16) {
    for (const v of values) out.push((v >> 8) & 0xff, v & 0xff);
    return out;
  }
  let byte = 0;
  let filled = 0;
  for (const v of values) {
    byte = (byte << depth) | v;
    filled += depth;
    if (filled === 8) {
      out.push(byte);
      byte = 0;
      filled = 0;
    }
  }
  if (filled > 0) out.push(byte << (8 - filled));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function filterRow(type: number, row: number[], prev: number[], bpp: number): number[] {
  const out = [type];
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp]! : 0;
    const b = prev[i] ?? 0;
    const c = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
    const x = row[i]!;
    const predicted = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c);
    out.push((x - predicted) & 0xff);
  }
  return out;
}

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

export function buildPng(spec: PngSpec): Buffer {
  const { width, height, depth, colorType } = spec;
  const channels = CHANNELS[colorType]!;
  const bpp = Math.max(1, Math.ceil((channels * depth) / 8));
  const passes = spec.interlace ? ADAM7 : ([[0, 0, 1, 1]] as const);
  const raw: number[] = [];
  let rowNumber = 0;
  for (const [xStart, yStart, xStep, yStep] of passes) {
    const passWidth = Math.ceil((width - xStart) / xStep);
    const passHeight = Math.ceil((height - yStart) / yStep);
    if (passWidth <= 0 || passHeight <= 0) continue;
    let prev: number[] = [];
    for (let py = 0; py < passHeight; py++) {
      const values: number[] = [];
      for (let px = 0; px < passWidth; px++) {
        const x = xStart + px * xStep;
        const y = yStart + py * yStep;
        for (let c = 0; c < channels; c++) values.push(spec.samples[(y * width + x) * channels + c]!);
      }
      const row = packRow(values, depth);
      const type = spec.filter ? spec.filter(rowNumber) : rowNumber % 5;
      raw.push(...filterRow(type, row, prev, bpp));
      prev = row;
      rowNumber++;
    }
  }
  let rawBytes = Buffer.from(raw);
  if (spec.cutRaw) rawBytes = rawBytes.subarray(0, Math.max(0, rawBytes.length - spec.cutRaw));
  if (spec.extraRaw) rawBytes = Buffer.concat([rawBytes, Buffer.from(spec.extraRaw)]);
  const compressed = deflateSync(rawBytes);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = spec.interlace ? 1 : 0;
  const parts: Buffer[] = [SIGNATURE, chunk('IHDR', ihdr)];
  if (spec.ancillary) parts.push(chunk('prVt', Buffer.from([1, 2, 3])));
  if (spec.gamma !== undefined) {
    const gama = Buffer.alloc(4);
    gama.writeUInt32BE(spec.gamma, 0);
    parts.push(chunk('gAMA', gama));
  }
  if (spec.palette) parts.push(chunk('PLTE', Buffer.from(spec.palette.flat())));
  if (spec.trns) parts.push(chunk('tRNS', Buffer.from(spec.trns)));
  const split = spec.idatSplit && spec.idatSplit > 0 ? spec.idatSplit : compressed.length || 1;
  for (let at = 0; at < compressed.length || at === 0; at += split) parts.push(chunk('IDAT', compressed.subarray(at, at + split)));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** PNG를 청크로 나눈다(서명 뒤부터). 시험이 청크를 바꾸거나 빼거나 순서를 바꿀 때 쓴다 */
export function splitChunks(png: Buffer): Array<{ type: string; data: Buffer }> {
  const chunks: Array<{ type: string; data: Buffer }> = [];
  let pos = 8;
  while (pos + 12 <= png.length) {
    const length = png.readUInt32BE(pos);
    chunks.push({ type: png.toString('latin1', pos + 4, pos + 8), data: Buffer.from(png.subarray(pos + 8, pos + 8 + length)) });
    pos += 12 + length;
  }
  return chunks;
}

export function joinChunks(chunks: ReadonlyArray<{ type: string; data: Buffer }>): Buffer {
  return Buffer.concat([SIGNATURE, ...chunks.map((c) => chunk(c.type, c.data))]);
}
