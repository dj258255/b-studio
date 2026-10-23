import { describe, expect, it } from 'vitest';
import { decodeGif, GIF_MAX_FRAMES, isGif, lzw } from './gif';

/** 시험용 LZW 인코더(GIF 방식: 가변 길이 코드, 4096에서 지우기) */
function compress(indices: readonly number[], minCode: number): Uint8Array {
  const clear = 1 << minCode;
  const end = clear + 1;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  let size = minCode + 1;
  let next = end + 1;
  let table = new Map<number, number>();
  const emit = (code: number) => {
    buffer |= code << bits;
    bits += size;
    while (bits >= 8) {
      bytes.push(buffer & 255);
      buffer >>>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  let current = indices[0]!;
  for (const index of indices.slice(1)) {
    const key = (current << 8) | index;
    const known = table.get(key);
    if (known !== undefined) {
      current = known;
      continue;
    }
    emit(current);
    if (next === 4096) {
      emit(clear);
      size = minCode + 1;
      next = end + 1;
      table = new Map();
    } else {
      if (next >= 1 << size) size++;
      table.set(key, next++);
    }
    current = index;
  }
  emit(current);
  emit(end);
  if (bits > 0) bytes.push(buffer & 255);
  return Uint8Array.from(bytes);
}

function blocks(data: Uint8Array): number[] {
  const out: number[] = [];
  for (let at = 0; at < data.length; at += 255) {
    const part = data.subarray(at, at + 255);
    out.push(part.length, ...part);
  }
  out.push(0);
  return out;
}

interface TestFrame {
  indices: number[];
  left?: number;
  top?: number;
  width: number;
  height: number;
  delay?: number;
  transparent?: number;
  disposal?: number;
  local?: number[];
  interlaced?: boolean;
}

const u16 = (value: number) => [value & 255, value >> 8];

/** 시험용 GIF. palette는 [r,g,b,…] 4색(2비트) */
function gif(width: number, height: number, palette: number[] | undefined, frames: TestFrame[]): Uint8Array {
  const out: number[] = [...Buffer.from('GIF89a'), ...u16(width), ...u16(height), palette ? 0x81 : 0, 0, 0];
  if (palette) out.push(...palette);
  for (const frame of frames) {
    const packed = ((frame.disposal ?? 0) << 2) | (frame.transparent !== undefined ? 1 : 0);
    out.push(0x21, 0xf9, 4, packed, ...u16((frame.delay ?? 0) / 10), frame.transparent ?? 0, 0);
    out.push(0x2c, ...u16(frame.left ?? 0), ...u16(frame.top ?? 0), ...u16(frame.width), ...u16(frame.height), (frame.local ? 0x81 : 0) | (frame.interlaced ? 0x40 : 0));
    if (frame.local) out.push(...frame.local);
    out.push(2, ...blocks(compress(frame.indices, 2)));
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}

const PALETTE = [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255];
const at = (pixels: Uint8Array, width: number, x: number, y: number) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

describe('GIF 읽기', () => {
  it('LZW: 긴 자료(코드 크기가 12비트까지 자라고 4096에서 지운다)를 그대로 되돌린다', () => {
    let seed = 7;
    const indices = Array.from({ length: 20_000 }, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >> 16) & 3;
    });
    expect([...lzw(compress(indices, 2), 2, indices.length)]).toEqual(indices);
    // 같은 값이 길게 이어지면 아직 없는 코드(KwKwK)가 나온다
    const runs = Array.from({ length: 500 }, () => 1);
    expect([...lzw(compress(runs, 2), 2, runs.length)]).toEqual(runs);
  });

  it('전역 색표로 한 프레임을 RGBA로 그린다', () => {
    const image = decodeGif(gif(2, 2, PALETTE, [{ width: 2, height: 2, indices: [0, 1, 2, 3], delay: 70 }]));
    expect([image.width, image.height, image.frames.length]).toEqual([2, 2, 1]);
    expect(at(image.frames[0]!.pixels, 2, 1, 0)).toEqual([255, 0, 0, 255]);
    expect(at(image.frames[0]!.pixels, 2, 1, 1)).toEqual([0, 0, 255, 255]);
    expect(image.frames[0]!.delay).toBe(70);
  });

  it('투명 색과 disposal: 1(그대로 둠)은 앞 프레임 위에 겹치고, 2는 그 자리를 지우고, 3은 앞 화면으로 되돌린다', () => {
    const image = decodeGif(
      gif(2, 1, PALETTE, [
        { width: 2, height: 1, indices: [1, 1], disposal: 1 },
        // 왼쪽은 투명이라 앞 프레임의 빨강이 남는다. 그린 뒤 자리를 지운다
        { width: 2, height: 1, indices: [0, 2], transparent: 0, disposal: 2 },
        // 지운 뒤라 오른쪽만 파랑. 그린 뒤 앞 화면(다 투명)으로 되돌린다
        { left: 1, width: 1, height: 1, indices: [3], disposal: 3 },
        { width: 1, height: 1, indices: [2] },
      ]),
    );
    const frames = image.frames.map((frame) => [at(frame.pixels, 2, 0, 0), at(frame.pixels, 2, 1, 0)]);
    expect(frames[0]).toEqual([
      [255, 0, 0, 255],
      [255, 0, 0, 255],
    ]);
    expect(frames[1]).toEqual([
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ]);
    expect(frames[2]).toEqual([
      [0, 0, 0, 0],
      [0, 0, 255, 255],
    ]);
    expect(frames[3]).toEqual([
      [0, 255, 0, 255],
      [0, 0, 0, 0],
    ]);
  });

  it('지역 색표와 인터레이스 줄 차례를 따른다', () => {
    const local = [10, 10, 10, 20, 20, 20, 30, 30, 30, 40, 40, 40];
    // 인터레이스: 저장 차례 0,4,2,1,3 → 화면 줄 0..4
    const image = decodeGif(gif(1, 5, undefined, [{ width: 1, height: 5, indices: [0, 3, 2, 1, 0], local, interlaced: true }]));
    const column = [0, 1, 2, 3, 4].map((y) => at(image.frames[0]!.pixels, 1, 0, y)[0]);
    expect(column).toEqual([10, 20, 30, 10, 40]);
  });

  it('GIF가 아니거나, 잘렸거나, 너무 크거나, 프레임이 없으면 던진다. 프레임은 상한까지만 받는다', () => {
    expect(isGif(Buffer.from('GIF89a'))).toBe(true);
    expect(() => decodeGif(Buffer.from('PNG...'))).toThrow('GIF가 아닙니다');
    const whole = gif(2, 2, PALETTE, [{ width: 2, height: 2, indices: [0, 1, 2, 3] }]);
    expect(() => decodeGif(whole.subarray(0, whole.length - 6))).toThrow('잘렸습니다');
    expect(() => decodeGif(gif(300, 1, PALETTE, []))).toThrow('너무 큽니다');
    expect(() => decodeGif(gif(1, 1, PALETTE, []))).toThrow('프레임이 없습니다');
    const many = gif(
      1,
      1,
      PALETTE,
      Array.from({ length: GIF_MAX_FRAMES + 5 }, () => ({ width: 1, height: 1, indices: [1] })),
    );
    expect(decodeGif(many).frames).toHaveLength(GIF_MAX_FRAMES);
  });
});
