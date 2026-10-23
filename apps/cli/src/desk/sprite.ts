/**
 * 카드의 작은 픽셀 그림(#887). PNG·GIF를 의존성 없이 읽어(node:zlib, gif.ts) 반칸 블록(▀ ▄)으로 칸에 그린다 — 한 칸이 위아래 두 픽셀이다.
 * 어느 터미널에서나, tmux 안에서도 보이고 desk의 줄 단위 다시 그리기와 맞물린다. 그림은 사용자 폴더(`~/.config/b-studio/sprites/`)에서 읽고,
 * 없거나 읽지 못하면 desk가 가진 기본 그림을 쓴다. 저장소에는 남이 만든 캐릭터 그림을 넣지 않는다.
 * 움짤(GIF, #902)은 프레임마다 픽셀을 두고, 그리는 쪽이 시각(ms)으로 보일 프레임을 고른다
 */
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { decodeGif, isGif } from './gif';
import { rgbSgr, RESET, type Theme } from './theme';

/** 움짤의 프레임 하나. delay는 보이는 시간(ms, 짧게 적힌 값은 frameDelay로 고친 뒤) */
export interface SpriteFrame {
  pixels: Uint8Array;
  delay: number;
}

/** RGBA 픽셀(한 픽셀 4바이트, 위에서 아래로). 움짤이면 frames에 프레임마다의 픽셀이 있고 pixels는 첫 프레임이다 */
export interface Sprite {
  width: number;
  height: number;
  pixels: Uint8Array;
  frames?: SpriteFrame[];
}

/** 움짤 프레임 사이의 최소 시간(ms). 너무 잦게 다시 그리지 않는다 */
export const MIN_FRAME_MS = 80;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 그림 하나의 상한. 카드에는 몇십 픽셀만 쓰므로 큰 그림은 받지 않는다(압축 풀기 폭탄 막기) */
const MAX_SIDE = 1024;
const MAX_FILE = 4 * 1024 * 1024;
/** 이 값 아래의 불투명도는 투명으로 본다 */
const ALPHA_CUT = 128;

/** PNG를 RGBA 픽셀로. 비트 깊이는 팔레트·회색이면 1·2·4·8, 그 밖은 8만 받는다. 인터레이스는 받지 않는다. 받지 못하면 던진다 */
export function decodePng(data: Uint8Array): Sprite {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('PNG가 아닙니다');
  let at = 8;
  let header: { width: number; height: number; depth: number; type: number } | undefined;
  let palette: Buffer | undefined;
  let alpha: Buffer | undefined;
  const chunks: Buffer[] = [];
  while (at + 8 <= buf.length) {
    const length = buf.readUInt32BE(at);
    const kind = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (body.length < length) throw new Error('PNG가 잘렸습니다');
    at += 12 + length;
    if (kind === 'IHDR') {
      const width = body.readUInt32BE(0);
      const height = body.readUInt32BE(4);
      const [depth, type, , , interlace] = [body[8]!, body[9]!, body[10], body[11], body[12]];
      if (interlace !== 0) throw new Error('인터레이스 PNG는 받지 않습니다');
      if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) throw new Error(`그림이 너무 큽니다(${MAX_SIDE}픽셀까지)`);
      const lowDepth = type === 0 || type === 3;
      if (!(depth === 8 || (lowDepth && [1, 2, 4].includes(depth)))) throw new Error(`비트 깊이 ${depth}는 받지 않습니다`);
      if (![0, 2, 3, 4, 6].includes(type)) throw new Error(`색 형식 ${type}은 받지 않습니다`);
      header = { width, height, depth, type };
    } else if (kind === 'PLTE') palette = Buffer.from(body);
    else if (kind === 'tRNS') alpha = Buffer.from(body);
    else if (kind === 'IDAT') chunks.push(body);
    else if (kind === 'IEND') break;
  }
  if (!header) throw new Error('PNG 머리(IHDR)가 없습니다');
  const { width, height, depth, type } = header;
  if (type === 3 && !palette) throw new Error('팔레트(PLTE)가 없습니다');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type]!;
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const step = Math.max(1, bitsPerPixel / 8);
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height + 1 });
  if (raw.length < (stride + 1) * height) throw new Error('PNG 그림 자료가 모자랍니다');
  const rows = unfilter(raw, stride, height, step);
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      let rgba: [number, number, number, number];
      if (type === 6) rgba = [row[x * 4]!, row[x * 4 + 1]!, row[x * 4 + 2]!, row[x * 4 + 3]!];
      else if (type === 2) {
        const [r, g, b] = [row[x * 3]!, row[x * 3 + 1]!, row[x * 3 + 2]!];
        // tRNS가 있으면 그 색 하나가 투명이다(16비트 값의 낮은 바이트)
        const clear = alpha && alpha.length >= 6 && alpha[1] === r && alpha[3] === g && alpha[5] === b;
        rgba = [r, g, b, clear ? 0 : 255];
      } else if (type === 4) rgba = [row[x * 2]!, row[x * 2]!, row[x * 2]!, row[x * 2 + 1]!];
      else {
        const value = sample(row, x, depth);
        if (type === 3) {
          if (value * 3 + 2 >= palette!.length) throw new Error('팔레트 밖의 색입니다');
          rgba = [palette![value * 3]!, palette![value * 3 + 1]!, palette![value * 3 + 2]!, alpha && value < alpha.length ? alpha[value]! : 255];
        } else {
          const gray = Math.round((value * 255) / ((1 << depth) - 1));
          const clear = alpha && alpha.length >= 2 && alpha.readUInt16BE(0) === value;
          rgba = [gray, gray, gray, clear ? 0 : 255];
        }
      }
      pixels.set(rgba, out);
    }
  }
  return { width, height, pixels };
}

/** 낮은 비트 깊이(1·2·4·8) 줄에서 x번째 값 */
function sample(row: Uint8Array, x: number, depth: number): number {
  if (depth === 8) return row[x]!;
  const perByte = 8 / depth;
  const byte = row[Math.floor(x / perByte)]!;
  const shift = 8 - depth * ((x % perByte) + 1);
  return (byte >> shift) & ((1 << depth) - 1);
}

/** PNG 줄 필터(None·Sub·Up·Average·Paeth)를 푼다 */
function unfilter(raw: Uint8Array, stride: number, height: number, step: number): Uint8Array {
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= step ? out[dst + i - step]! : 0;
      const up = y > 0 ? out[dst - stride + i]! : 0;
      const corner = y > 0 && i >= step ? out[dst - stride + i - step]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      } else if (filter !== 0) throw new Error(`알 수 없는 줄 필터 ${filter}`);
      out[dst + i] = (raw[src + i]! + predictor) & 255;
    }
  }
  return out;
}

/** GIF에 적힌 지연을 보일 시간으로: 0·1(=10ms)처럼 짧게 적힌 것은 브라우저처럼 100ms로 보고, 그 밖에는 최소 시간을 지킨다 */
export function frameDelay(delay: number): number {
  return delay < 20 ? 100 : Math.max(MIN_FRAME_MS, delay);
}

/** 프레임마다의 픽셀(움짤이 아니면 pixels 하나) */
export function framesOf(sprite: Sprite): SpriteFrame[] {
  return sprite.frames?.length ? sprite.frames : [{ pixels: sprite.pixels, delay: 0 }];
}

/** 시각 clock(ms)에 보일 프레임 번호. 프레임이 하나면 0이다 */
export function frameAt(sprite: Sprite, clock: number): number {
  const frames = framesOf(sprite);
  if (frames.length < 2 || !Number.isFinite(clock)) return 0;
  const total = frames.reduce((sum, frame) => sum + frame.delay, 0);
  if (total <= 0) return 0;
  let left = ((clock % total) + total) % total;
  for (let index = 0; index < frames.length; index++) {
    left -= frames[index]!.delay;
    if (left < 0) return index;
  }
  return frames.length - 1;
}

/** 움짤의 가장 짧은 프레임 시간(ms). 움직이지 않으면 undefined */
export function shortestFrame(sprite: Sprite): number | undefined {
  const frames = framesOf(sprite);
  if (frames.length < 2) return undefined;
  return Math.min(...frames.map((frame) => frame.delay));
}

function opaqueAt(pixels: Uint8Array, width: number, x: number, y: number): boolean {
  return pixels[(y * width + x) * 4 + 3]! >= ALPHA_CUT;
}

const trimmed = new WeakMap<Sprite, Sprite>();

/**
 * 투명한 가장자리를 잘라낸다(픽셀 그림은 둘레에 빈 곳을 두는 일이 많다). 움짤은 모든 프레임을 합친 자리로 자른다
 * (프레임마다 자르면 그림이 흔들린다). 다 투명하면 그대로. 같은 그림은 한 번만 자른다
 */
export function trimSprite(sprite: Sprite): Sprite {
  const known = trimmed.get(sprite);
  if (known) return known;
  const frames = framesOf(sprite);
  let [left, top, right, bottom] = [sprite.width, sprite.height, -1, -1];
  for (const frame of frames) {
    for (let y = 0; y < sprite.height; y++) {
      for (let x = 0; x < sprite.width; x++) {
        if (!opaqueAt(frame.pixels, sprite.width, x, y)) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  let result = sprite;
  if (right >= 0 && (left > 0 || top > 0 || right < sprite.width - 1 || bottom < sprite.height - 1)) {
    const width = right - left + 1;
    const height = bottom - top + 1;
    const crop = (pixels: Uint8Array) => {
      const out = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) out.set(pixels.subarray(((top + y) * sprite.width + left) * 4, ((top + y) * sprite.width + left + width) * 4), y * width * 4);
      return out;
    };
    const cropped = frames.map((frame) => ({ pixels: crop(frame.pixels), delay: frame.delay }));
    result = { width, height, pixels: cropped[0]!.pixels, ...(sprite.frames?.length ? { frames: cropped } : {}) };
  }
  trimmed.set(sprite, result);
  trimmed.set(result, result);
  return result;
}

/**
 * 그림을 width×height 픽셀로 줄인다. 한 픽셀은 원래 그림의 그 자리 상자에서 불투명한 픽셀이 1/3 이상이면
 * 그 불투명한 픽셀들의 평균 색이고, 아니면 투명이다(가장 가까운 픽셀 하나만 고르면 얇은 테두리가 사라지거나 끊긴다)
 */
export function shrinkPixels(pixels: Uint8Array, sourceWidth: number, sourceHeight: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const scaleX = sourceWidth / width;
  const scaleY = sourceHeight / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(sourceHeight, Math.floor((y + 1) * scaleY)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(sourceWidth, Math.floor((x + 1) * scaleX)));
      let [count, r, g, b] = [0, 0, 0, 0];
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const at = (sy * sourceWidth + sx) * 4;
          if (pixels[at + 3]! < ALPHA_CUT) continue;
          count++;
          r += pixels[at]!;
          g += pixels[at + 1]!;
          b += pixels[at + 2]!;
        }
      }
      const area = (y1 - y0) * (x1 - x0);
      if (count * 3 < area || count === 0) continue;
      out.set([Math.round(r / count), Math.round(g / count), Math.round(b / count), 255], (y * width + x) * 4);
    }
  }
  return out;
}

const drawn = new WeakMap<Sprite, Map<string, string[]>>();

/**
 * 그림을 cols칸 × rows줄(= cols × rows*2 픽셀) 안에 비율을 지켜 넣고(줄이기만 하고 키우지 않는다) 가운데 아래쪽에 놓는다.
 * frame은 움짤의 프레임 번호다. 돌려주는 줄은 정확히 cols칸이다. 투명한 곳은 밖 터미널의 바탕 그대로다.
 * 같은 그림·프레임·크기는 한 번만 그린다(카드 화면은 움짤 때문에 자주 다시 그린다)
 */
export function spriteLines(source: Sprite, cols: number, rows: number, theme: Theme, frame = 0): string[] {
  const sprite = trimSprite(source);
  const frames = framesOf(sprite);
  const index = Math.max(0, Math.min(frames.length - 1, frame));
  const key = `${cols}x${rows}:${theme.depth}:${index}`;
  let cache = drawn.get(sprite);
  const known = cache?.get(key);
  if (known) return known;
  const scale = Math.min(1, cols / sprite.width, (rows * 2) / sprite.height);
  const width = Math.max(1, Math.round(sprite.width * scale));
  const height = Math.max(1, Math.round(sprite.height * scale));
  const pixels = scale === 1 ? frames[index]!.pixels : shrinkPixels(frames[index]!.pixels, sprite.width, sprite.height, width, height);
  const left = Math.floor((cols - width) / 2);
  // 아래쪽에 붙인다(카드에서 발이 바닥에 닿게)
  const top = rows * 2 - height;
  const pixel = (x: number, y: number): [number, number, number] | undefined => {
    const sx = x - left;
    const sy = y - top;
    if (sx < 0 || sy < 0 || sx >= width || sy >= height || !opaqueAt(pixels, width, sx, sy)) return undefined;
    const at = (sy * width + sx) * 4;
    return [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!];
  };
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = '';
    for (let x = 0; x < cols; x++) {
      const upper = pixel(x, row * 2);
      const lower = pixel(x, row * 2 + 1);
      if (upper && lower) line += `${rgbSgr(upper, 'fg', theme.depth)}${rgbSgr(lower, 'bg', theme.depth)}▀${RESET}`;
      else if (upper) line += `${rgbSgr(upper, 'fg', theme.depth)}▀${RESET}`;
      else if (lower) line += `${rgbSgr(lower, 'fg', theme.depth)}▄${RESET}`;
      else line += ' ';
    }
    lines.push(line);
  }
  if (!cache) {
    cache = new Map();
    drawn.set(sprite, cache);
  }
  cache.set(key, lines);
  return lines;
}

/** 그림을 정수 배로 키운다(가장 가까운 픽셀). Kitty 그래픽으로 보낼 때 터미널이 크게 늘리며 흐려지지 않게 쓴다 */
export function scalePixels(pixels: Uint8Array, width: number, height: number, factor: number): Uint8Array {
  if (factor <= 1) return pixels;
  const outWidth = width * factor;
  const out = new Uint8Array(outWidth * height * factor * 4);
  for (let y = 0; y < height * factor; y++) {
    for (let x = 0; x < outWidth; x++) {
      const at = (Math.floor(y / factor) * width + Math.floor(x / factor)) * 4;
      out.set(pixels.subarray(at, at + 4), (y * outWidth + x) * 4);
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RGBA 픽셀을 PNG로(8비트 RGBA, 줄 필터 없음). Kitty 그래픽에 PNG로 보낸다 */
export function encodePng(width: number, height: number, pixels: Uint8Array): Buffer {
  const chunk = (kind: string, body: Uint8Array) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(kind, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(kind, 'latin1'), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}

/** 글자 그림(한 글자가 한 픽셀, 빈칸은 투명)을 그림으로. 기본 그림을 코드로 두려고 쓴다 */
export function spriteFromRows(rows: readonly string[], colors: Readonly<Record<string, string>>): Sprite {
  const width = Math.max(...rows.map((row) => row.length));
  const height = rows.length;
  const pixels = new Uint8Array(width * height * 4);
  rows.forEach((row, y) => {
    [...row].forEach((char, x) => {
      const hex = colors[char];
      if (!hex) return;
      const value = Number.parseInt(hex.slice(1), 16);
      pixels.set([(value >> 16) & 255, (value >> 8) & 255, value & 255, 255], (y * width + x) * 4);
    });
  });
  return { width, height, pixels };
}

/** desk가 가진 기본 그림: 작은 로봇(이 저장소에서 새로 그린 것). 몸 색만 AI마다 다르다 */
const ROBOT = [
  '    aa    ',
  '    aa    ',
  ' bbbbbbbb ',
  ' bwwwwwwb ',
  ' bwkwwkwb ',
  ' bwwwwwwb ',
  ' bbbbbbbb ',
  '  cbbbbc  ',
  'cc bbbb cc',
  '   b  b   ',
];
const BODY: Record<string, string> = { 'claude-code': '#e8956b', codex: '#8aa4c8', gemini: '#7fb7a4' };

export function defaultSprite(backend: string | undefined): Sprite {
  const body = (backend && BODY[backend]) ?? '#a6adc8';
  return spriteFromRows(ROBOT, { a: '#f9e2af', b: body, c: '#6c7086', w: '#eff1f5', k: '#1e1e2e' });
}

export function spriteDir(configDir: string): string {
  return join(configDir, 'sprites');
}

/** PNG나 GIF를 그림으로(머리 바이트로 가린다). GIF는 프레임마다의 픽셀을 frames에 둔다. 받지 못하면 던진다 */
export function decodeSprite(data: Uint8Array): Sprite {
  if (data.length > MAX_FILE) throw new Error('파일이 너무 큽니다(4MB까지)');
  if (!isGif(data)) return decodePng(data);
  const gif = decodeGif(data);
  const frames = gif.frames.map((frame) => ({ pixels: frame.pixels, delay: frameDelay(frame.delay) }));
  return { width: gif.width, height: gif.height, pixels: frames[0]!.pixels, ...(frames.length > 1 ? { frames } : {}) };
}

/** 그림 파일 하나를 읽는다. 읽지 못하면 그 까닭을 던진다 */
export function readSprite(file: string): Sprite {
  return decodeSprite(readFileSync(file));
}

/**
 * 그림 폴더에서 이름 차례로 `<이름>.png`·`<이름>.gif`를 찾아 읽는다. 처음 읽힌 것을 쓰고, 읽지 못한 파일은 그 까닭을 warnings에 남긴다.
 * 이름에는 경로 글자를 받지 않는다(폴더 밖을 읽지 않게)
 */
export function loadSprite(dir: string, names: readonly string[], warnings: string[] = []): Sprite | undefined {
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) continue;
    for (const extension of ['png', 'gif']) {
      const file = join(dir, `${name}.${extension}`);
      let data: Buffer;
      try {
        data = readFileSync(file);
      } catch {
        continue;
      }
      try {
        return decodeSprite(data);
      } catch (error) {
        warnings.push(`그림 ${name}.${extension}를 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return undefined;
}

/** 무작위로 고를 그림 파일의 상한과 폴더 깊이 */
const CATALOG_MAX = 10_000;
const CATALOG_DEPTH = 4;

/**
 * 그림 폴더(하위 폴더 포함)의 .png·.gif 파일 목록(폴더 기준 상대 경로, 정렬). 숨은 파일·폴더와 링크는 보지 않는다(폴더 밖을 읽지 않게).
 * 폴더가 없으면 빈 목록이다
 */
export function scanSprites(dir: string): string[] {
  const found: string[] = [];
  const walk = (folder: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= CATALOG_MAX) return;
      if (entry.name.startsWith('.')) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth < CATALOG_DEPTH) walk(path, depth + 1);
      } else if (entry.isFile() && /\.(png|gif)$/i.test(entry.name)) found.push(relative(dir, path));
    }
  };
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  walk(dir, 0);
  return found.sort();
}

/** 세션 id로 목록에서 하나를 고른다(FNV-1a). 같은 id는 늘 같은 그림이다 */
export function pickSprite(id: string, files: readonly string[]): string | undefined {
  if (files.length === 0) return undefined;
  let hash = 0x811c9dc5;
  for (const char of id) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return files[hash % files.length];
}
