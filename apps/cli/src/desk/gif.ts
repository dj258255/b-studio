/**
 * 카드 움짤(#902): GIF를 의존성 없이 읽어 논리 화면에 합성한 RGBA 프레임 목록으로 바꾼다.
 * GIF87a·89a, 전역·지역 색표, LZW, 인터레이스, 그래픽 제어 확장(지연, 투명 색, disposal 0~3)을 받는다.
 * 카드에는 몇십 픽셀만 쓰므로 큰 그림과 많은 프레임은 받지 않는다(압축 풀기 폭탄 막기)
 */

export interface GifFrame {
  /** 논리 화면 전체 크기의 RGBA 픽셀 */
  pixels: Uint8Array;
  /** 이 프레임을 보이는 시간(ms). GIF에 적힌 그대로다(0일 수 있다) */
  delay: number;
}

export interface Gif {
  width: number;
  height: number;
  frames: GifFrame[];
}

/** 논리 화면 한 변의 상한 */
export const GIF_MAX_SIDE = 256;
/** 받는 프레임 수의 상한. 넘는 프레임은 버린다 */
export const GIF_MAX_FRAMES = 200;

/** GIF인가(머리 여섯 바이트) */
export function isGif(data: Uint8Array): boolean {
  if (data.length < 6) return false;
  const head = String.fromCharCode(...data.subarray(0, 6));
  return head === 'GIF87a' || head === 'GIF89a';
}

/** GIF를 프레임 목록으로. 받지 못하는 파일이면 던진다 */
export function decodeGif(data: Uint8Array): Gif {
  if (!isGif(data)) throw new Error('GIF가 아닙니다');
  let at = 6;
  const need = (count: number) => {
    if (at + count > data.length) throw new Error('GIF가 잘렸습니다');
  };
  const u16 = (offset: number) => data[offset]! | (data[offset + 1]! << 8);
  need(7);
  const width = u16(6);
  const height = u16(8);
  const flags = data[10]!;
  at = 13;
  if (width < 1 || height < 1 || width > GIF_MAX_SIDE || height > GIF_MAX_SIDE) throw new Error(`그림이 너무 큽니다(${GIF_MAX_SIDE}픽셀까지)`);
  let globalTable: Uint8Array | undefined;
  if (flags & 0x80) {
    const size = 3 * (2 << (flags & 7));
    need(size);
    globalTable = data.subarray(at, at + size);
    at += size;
  }

  /** 하위 블록(길이 한 바이트 + 내용)을 0 길이 블록까지 이어 붙인다 */
  const subBlocks = (): Uint8Array => {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      need(1);
      const size = data[at++]!;
      if (size === 0) break;
      need(size);
      parts.push(data.subarray(at, at + size));
      total += size;
      at += size;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };

  const canvas = new Uint8Array(width * height * 4);
  const frames: GifFrame[] = [];
  let control = { delay: 0, transparent: -1, disposal: 0 };
  for (;;) {
    need(1);
    const block = data[at++]!;
    if (block === 0x3b) break;
    if (block === 0x21) {
      need(1);
      const label = data[at++]!;
      const body = subBlocks();
      if (label === 0xf9 && body.length >= 4) {
        control = { delay: (body[1]! | (body[2]! << 8)) * 10, transparent: body[0]! & 1 ? body[3]! : -1, disposal: (body[0]! >> 2) & 7 };
      }
      continue;
    }
    if (block !== 0x2c) throw new Error(`알 수 없는 GIF 블록 ${block}`);
    need(9);
    const left = u16(at);
    const top = u16(at + 2);
    const frameWidth = u16(at + 4);
    const frameHeight = u16(at + 6);
    const packed = data[at + 8]!;
    at += 9;
    let table = globalTable;
    if (packed & 0x80) {
      const size = 3 * (2 << (packed & 7));
      need(size);
      table = data.subarray(at, at + size);
      at += size;
    }
    need(1);
    const minCode = data[at++]!;
    const indices = lzw(subBlocks(), minCode, frameWidth * frameHeight);
    if (!table) throw new Error('GIF 색표가 없습니다');
    if (frames.length >= GIF_MAX_FRAMES) {
      control = { delay: 0, transparent: -1, disposal: 0 };
      continue;
    }

    const saved = control.disposal === 3 ? canvas.slice() : undefined;
    const rows = rowOrder(frameHeight, (packed & 0x40) !== 0);
    for (let row = 0; row < frameHeight; row++) {
      const y = top + rows[row]!;
      if (y >= height) continue;
      for (let column = 0; column < frameWidth; column++) {
        const x = left + column;
        if (x >= width) continue;
        const index = indices[row * frameWidth + column]!;
        if (index === control.transparent || index * 3 + 2 >= table.length) continue;
        canvas.set([table[index * 3]!, table[index * 3 + 1]!, table[index * 3 + 2]!, 255], (y * width + x) * 4);
      }
    }
    frames.push({ pixels: canvas.slice(), delay: control.delay });
    // 다음 프레임 전에 이 프레임의 자리를 어떻게 둘지: 2는 지우고(투명), 3은 앞 화면으로 되돌린다
    if (control.disposal === 2) {
      for (let y = top; y < Math.min(height, top + frameHeight); y++) canvas.fill(0, (y * width + left) * 4, (y * width + Math.min(width, left + frameWidth)) * 4);
    } else if (saved) canvas.set(saved);
    control = { delay: 0, transparent: -1, disposal: 0 };
  }
  if (frames.length === 0) throw new Error('GIF에 프레임이 없습니다');
  return { width, height, frames };
}

/** 인터레이스면 저장된 줄 차례(0,8,…,4,…,2,…,1,…)가 화면의 몇째 줄인지 */
function rowOrder(height: number, interlaced: boolean): number[] {
  if (!interlaced) return Array.from({ length: height }, (_, row) => row);
  const order: number[] = [];
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ] as const) {
    for (let row = start; row < height; row += step) order.push(row);
  }
  return order;
}

/** GIF의 LZW(가변 길이 코드, 최대 12비트)를 풀어 색 번호 count개를 돌려준다. 모자라면 0으로 남는다 */
export function lzw(data: Uint8Array, minCode: number, count: number): Uint8Array {
  if (minCode < 1 || minCode > 11) throw new Error(`GIF 최소 코드 크기 ${minCode}는 받지 않습니다`);
  const clear = 1 << minCode;
  const end = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  const out = new Uint8Array(count);
  let written = 0;
  let size = minCode + 1;
  let next = end + 1;
  let previous = -1;
  let first = 0;
  let bits = 0;
  let buffer = 0;
  let at = 0;
  while (written < count) {
    while (bits < size && at < data.length) {
      buffer |= data[at++]! << bits;
      bits += 8;
    }
    if (bits < size) break;
    const code = buffer & ((1 << size) - 1);
    buffer >>>= size;
    bits -= size;
    if (code === clear) {
      size = minCode + 1;
      next = end + 1;
      previous = -1;
      continue;
    }
    if (code === end) break;
    if (previous === -1) {
      if (code >= clear) throw new Error('GIF 압축 자료가 깨졌습니다');
      out[written++] = code;
      previous = code;
      first = code;
      continue;
    }
    let depth = 0;
    let current = code;
    if (code >= next) {
      // 아직 없는 코드(KwKwK): 앞 문자열 + 앞 문자열의 첫 글자
      if (code > next) throw new Error('GIF 압축 자료가 깨졌습니다');
      stack[depth++] = first;
      current = previous;
    }
    while (current > end) {
      stack[depth++] = suffix[current]!;
      current = prefix[current]!;
    }
    if (current >= clear) throw new Error('GIF 압축 자료가 깨졌습니다');
    first = current;
    stack[depth++] = current;
    while (depth > 0 && written < count) out[written++] = stack[--depth]!;
    if (next < 4096) {
      prefix[next] = previous;
      suffix[next] = first;
      next++;
      if (next === 1 << size && size < 12) size++;
    }
    previous = code;
  }
  return out;
}
