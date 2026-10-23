import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { stringWidth, stripAnsi } from './screen';
import { decodePng, decodeSprite, defaultSprite, encodePng, frameAt, frameDelay, loadSprite, pickSprite, scalePixels, scanSprites, shortestFrame, shrinkPixels, spriteFromRows, spriteLines, trimSprite, type Sprite } from './sprite';
import { DEFAULT_THEME } from './theme';

function chunk(kind: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(kind, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind, 'latin1'), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** 시험용 PNG: rows는 줄마다 (필터 바이트 없는) 픽셀 바이트 */
function png(width: number, height: number, depth: number, type: number, rows: number[][], extra: Buffer[] = [], filter = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = type;
  const raw = Buffer.from(rows.flatMap((row) => [filter, ...row]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const rgba = (sprite: { pixels: Uint8Array; width: number }, x: number, y: number) => [...sprite.pixels.subarray((y * sprite.width + x) * 4, (y * sprite.width + x) * 4 + 4)];

describe('PNG 읽기', () => {
  it('RGBA 8비트', () => {
    const sprite = decodePng(png(2, 1, 8, 6, [[255, 0, 0, 255, 0, 0, 255, 0]]));
    expect([sprite.width, sprite.height]).toEqual([2, 1]);
    expect(rgba(sprite, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(rgba(sprite, 1, 0)).toEqual([0, 0, 255, 0]);
  });

  it('RGB와 tRNS의 투명색', () => {
    const trns = chunk('tRNS', Buffer.from([0, 1, 0, 2, 0, 3]));
    const sprite = decodePng(png(2, 1, 8, 2, [[1, 2, 3, 9, 9, 9]], [trns]));
    expect(rgba(sprite, 0, 0)).toEqual([1, 2, 3, 0]);
    expect(rgba(sprite, 1, 0)).toEqual([9, 9, 9, 255]);
  });

  it('4비트 팔레트와 팔레트별 투명도', () => {
    const plte = chunk('PLTE', Buffer.from([10, 20, 30, 40, 50, 60]));
    const trns = chunk('tRNS', Buffer.from([0]));
    // 한 바이트에 두 픽셀: 0, 1, 1, 0
    const sprite = decodePng(png(4, 1, 4, 3, [[0x01, 0x10]], [plte, trns]));
    expect(rgba(sprite, 0, 0)).toEqual([10, 20, 30, 0]);
    expect(rgba(sprite, 1, 0)).toEqual([40, 50, 60, 255]);
    expect(rgba(sprite, 2, 0)).toEqual([40, 50, 60, 255]);
  });

  it('줄 필터(Sub·Up·Average·Paeth)를 푼다', () => {
    // Sub: 둘째 픽셀은 앞 픽셀과의 차
    const sub = decodePng(png(2, 1, 8, 6, [[10, 10, 10, 255, 5, 5, 5, 0]], [], 1));
    expect(rgba(sub, 1, 0)).toEqual([15, 15, 15, 255]);
    // Up: 둘째 줄은 윗줄과의 차
    const up = decodePng(png(1, 2, 8, 6, [[7, 7, 7, 255], [1, 1, 1, 0]], [], 2));
    expect(rgba(up, 0, 1)).toEqual([8, 8, 8, 255]);
    // Average: (왼쪽 + 위) / 2
    const average = decodePng(png(1, 2, 8, 6, [[20, 20, 20, 200], [1, 1, 1, 1]], [], 3));
    expect(rgba(average, 0, 0)).toEqual([20, 20, 20, 200]);
    expect(rgba(average, 0, 1)).toEqual([11, 11, 11, 101]);
    // Paeth: 첫 줄 둘째 픽셀은 왼쪽을 고른다
    const paeth = decodePng(png(2, 1, 8, 6, [[3, 3, 3, 3, 1, 1, 1, 1]], [], 4));
    expect(rgba(paeth, 1, 0)).toEqual([4, 4, 4, 4]);
  });

  it('PNG가 아니거나, 인터레이스이거나, 너무 크거나, 16비트면 던진다', () => {
    expect(() => decodePng(Buffer.from('not png'))).toThrow('PNG가 아닙니다');
    const interlaced = png(1, 1, 8, 6, [[0, 0, 0, 0]]);
    interlaced[8 + 8 + 12] = 1;
    expect(() => decodePng(interlaced)).toThrow('인터레이스');
    expect(() => decodePng(png(2000, 1, 8, 6, [[]]))).toThrow('너무 큽니다');
    expect(() => decodePng(png(1, 1, 16, 6, [[0, 0, 0, 0, 0, 0, 0, 0]]))).toThrow('비트 깊이 16');
  });

  it('압축을 풀었을 때 그림보다 큰 자료는 받지 않는다(압축 풀기 폭탄)', () => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const bomb = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(10_000_000))), chunk('IEND', Buffer.alloc(0))]);
    expect(() => decodePng(bomb)).toThrow();
  });
});

describe('반칸 블록 그림', () => {
  const sprite = spriteFromRows(['ab', 'b '], { a: '#ff0000', b: '#00ff00' });

  it('위 픽셀은 글자색 ▀, 아래 픽셀은 바탕색. 위가 투명하면 ▄, 둘 다 투명하면 빈칸', () => {
    const [line] = spriteLines(sprite, 2, 1, DEFAULT_THEME);
    expect(stripAnsi(line!)).toBe('▀▀');
    expect(line).toContain('\x1b[38;2;255;0;0m\x1b[48;2;0;255;0m▀');
    // 오른쪽 열: 위는 초록, 아래는 투명이라 바탕을 칠하지 않는다
    expect(line).toContain('\x1b[38;2;0;255;0m▀');
    const lower = spriteLines(spriteFromRows([' ', 'a'], { a: '#ff0000' }), 1, 1, DEFAULT_THEME)[0]!;
    expect(stripAnsi(lower)).toBe('▄');
  });

  it('투명한 가장자리를 잘라 칸 가운데 아래쪽에 놓고, 줄마다 정확히 받은 폭이다', () => {
    const padded = spriteFromRows(['    ', ' aa ', ' aa ', '    '], { a: '#ffffff' });
    expect(trimSprite(padded).width).toBe(2);
    const lines = spriteLines(padded, 6, 2, DEFAULT_THEME);
    expect(lines.map(stripAnsi)).toEqual(['      ', '  ▀▀  ']);
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(6);
  });

  it('큰 그림은 비율을 지켜 줄인다', () => {
    const big = spriteFromRows(Array.from({ length: 40 }, () => 'a'.repeat(20)), { a: '#ffffff' });
    const lines = spriteLines(big, 10, 5, DEFAULT_THEME).map(stripAnsi);
    // 20×40을 10칸 × 10픽셀에 넣으면 5×10 픽셀
    expect(lines.every((line) => line.trim().length === 5)).toBe(true);
  });

  it('256색 팔레트면 256색 SGR로 그린다', () => {
    const [line] = spriteLines(sprite, 2, 1, { name: 'dark', depth: '256' });
    expect(line).toMatch(/\x1b\[38;5;\d+m/);
    expect(line).not.toContain(';2;');
  });

  it('기본 그림은 AI마다 몸 색이 다르다', () => {
    const claude = defaultSprite('claude-code');
    const codex = defaultSprite('codex');
    expect(claude.width).toBe(10);
    expect(Buffer.from(claude.pixels).equals(Buffer.from(codex.pixels))).toBe(false);
  });
});

describe('그림 폴더', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('이름 차례로 찾아 처음 읽힌 그림을 쓰고, 깨진 파일은 알린다. 경로 글자가 든 이름은 보지 않는다', () => {
    dir = mkdtempSync(join(tmpdir(), 'desk-sprite-'));
    writeFileSync(join(dir, 'broken.png'), 'nope');
    writeFileSync(join(dir, 'codex.png'), png(1, 1, 8, 6, [[1, 2, 3, 255]]));
    const warnings: string[] = [];
    const sprite = loadSprite(dir, ['../codex', 'missing', 'broken', 'codex'], warnings);
    expect(sprite && rgba(sprite, 0, 0)).toEqual([1, 2, 3, 255]);
    expect(warnings).toEqual([expect.stringContaining('broken.png')]);
    expect(loadSprite(dir, ['missing'])).toBeUndefined();
  });
});

/** 한 프레임 1×1 GIF(색 하나): 머리, 색표 2색, 이미지, 끝 */
const tinyGif = (r: number, g: number, b: number) =>
  Buffer.from([...Buffer.from('GIF89a'), 1, 0, 1, 0, 0x80, 0, 0, r, g, b, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0, 0x3b]);

describe('움짤 그림(#902)', () => {
  const pixel = (hex: string) => spriteFromRows(['a'], { a: hex }).pixels;
  const frames = [
    { pixels: pixel('#ff0000'), delay: 100 },
    { pixels: pixel('#00ff00'), delay: 300 },
  ];
  const animated: Sprite = { width: 1, height: 1, pixels: frames[0]!.pixels, frames };

  it('GIF에 적힌 짧은 지연은 100ms로, 그 밖에는 최소 80ms를 지킨다', () => {
    expect(frameDelay(0)).toBe(100);
    expect(frameDelay(10)).toBe(100);
    expect(frameDelay(30)).toBe(80);
    expect(frameDelay(120)).toBe(120);
  });

  it('시계로 보일 프레임을 고르고, 한 바퀴를 돌면 처음으로 돌아간다', () => {
    expect([0, 99, 100, 399, 400, 550].map((clock) => frameAt(animated, clock))).toEqual([0, 0, 1, 1, 0, 1]);
    expect(frameAt(defaultSprite('codex'), 500)).toBe(0);
    expect(shortestFrame(animated)).toBe(100);
    expect(shortestFrame(defaultSprite('codex'))).toBeUndefined();
  });

  it('모든 프레임을 합친 자리로 투명한 가장자리를 자른다(프레임마다 자르면 흔들린다)', () => {
    const left = spriteFromRows(['a   ', '    '], { a: '#ffffff' });
    const right = spriteFromRows(['    ', '   a'], { a: '#ffffff' });
    const sprite: Sprite = { width: 4, height: 2, pixels: left.pixels, frames: [{ pixels: left.pixels, delay: 100 }, { pixels: right.pixels, delay: 100 }] };
    const trimmed = trimSprite(sprite);
    expect([trimmed.width, trimmed.height]).toEqual([4, 2]);
    expect(trimSprite(sprite)).toBe(trimmed);
    const padded = spriteFromRows(['   ', ' a ', '   '], { a: '#ffffff' });
    const both: Sprite = { width: 3, height: 3, pixels: padded.pixels, frames: [{ pixels: padded.pixels, delay: 100 }, { pixels: padded.pixels, delay: 100 }] };
    expect(trimSprite(both).frames?.map((frame) => frame.pixels.length)).toEqual([4, 4]);
  });

  it('반칸 블록은 받은 프레임을 그린다', () => {
    expect(spriteLines(animated, 1, 1, DEFAULT_THEME, 0)[0]).toContain('38;2;255;0;0');
    expect(spriteLines(animated, 1, 1, DEFAULT_THEME, 1)[0]).toContain('38;2;0;255;0');
  });

  it('줄일 때 상자 안 불투명한 픽셀의 평균 색을 쓰고, 얇은 테두리를 잃지 않는다', () => {
    // 4×4에 1픽셀 테두리(검정) + 안쪽 흰색 → 2×2로 줄이면 네 픽셀 모두 불투명이고 회색이 섞인다
    const framed = spriteFromRows(['kkkk', 'kwwk', 'kwwk', 'kkkk'], { k: '#000000', w: '#ffffff' });
    const small = shrinkPixels(framed.pixels, 4, 4, 2, 2);
    expect([...small.subarray(0, 4)]).toEqual([64, 64, 64, 255]);
    // 가장자리 한 줄만 있는 그림을 줄여도 사라지지 않는다
    const line = spriteFromRows(['aaa', '   ', '   '], { a: '#ff0000' });
    expect(shrinkPixels(line.pixels, 3, 3, 1, 1)[3]).toBe(255);
    const dust = spriteFromRows(['a   ', '    ', '    ', '    '], { a: '#ff0000' });
    expect(shrinkPixels(dust.pixels, 4, 4, 1, 1)[3]).toBe(0);
  });

  it('PNG로 다시 쓰면 같은 픽셀로 읽히고, 정수 배로 키운다', () => {
    const sprite = spriteFromRows(['ab', ' a'], { a: '#102030', b: '#405060' });
    const round = decodePng(encodePng(2, 2, sprite.pixels));
    expect(Buffer.from(round.pixels).equals(Buffer.from(sprite.pixels))).toBe(true);
    const big = scalePixels(sprite.pixels, 2, 2, 3);
    expect(big.length).toBe(6 * 6 * 4);
    expect([...big.subarray((5 * 6 + 5) * 4, (5 * 6 + 5) * 4 + 4)]).toEqual([0x10, 0x20, 0x30, 255]);
  });

  it('머리 바이트로 PNG와 GIF를 가려 읽는다', () => {
    const fromGif = decodeSprite(tinyGif(9, 8, 7));
    expect(rgba(fromGif, 0, 0)).toEqual([9, 8, 7, 255]);
    expect(fromGif.frames).toBeUndefined();
    expect(() => decodeSprite(Buffer.from('hello'))).toThrow('PNG가 아닙니다');
  });
});

describe('그림 폴더에서 무작위로 고르기(#902)', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('하위 폴더까지 .png·.gif만 모으고, 숨은 것과 링크는 보지 않는다', () => {
    dir = mkdtempSync(join(tmpdir(), 'desk-sprites-'));
    mkdirSync(join(dir, 'pokemon'));
    mkdirSync(join(dir, '.hidden'));
    writeFileSync(join(dir, 'pokemon', '25.gif'), tinyGif(1, 2, 3));
    writeFileSync(join(dir, 'pokemon', 'notes.txt'), 'x');
    writeFileSync(join(dir, '.hidden', 'a.png'), 'x');
    writeFileSync(join(dir, 'codex.PNG'), 'x');
    symlinkSync('/etc', join(dir, 'link'));
    expect(scanSprites(dir)).toEqual(['codex.PNG', join('pokemon', '25.gif')]);
    expect(scanSprites(join(dir, 'missing'))).toEqual([]);
  });

  it('세션 id로 고르면 늘 같은 그림이고, 여러 세션은 고르게 흩어진다', () => {
    const files = Array.from({ length: 50 }, (_, index) => `${index}.gif`);
    expect(pickSprite('session-1', files)).toBe(pickSprite('session-1', files));
    expect(pickSprite('x', [])).toBeUndefined();
    const picked = new Set(Array.from({ length: 200 }, (_, index) => pickSprite(`s${index}`, files)));
    expect(picked.size).toBeGreaterThan(30);
  });

  it('이름 붙인 그림은 .gif도 읽는다', () => {
    dir = mkdtempSync(join(tmpdir(), 'desk-sprites-'));
    writeFileSync(join(dir, 'codex.gif'), tinyGif(4, 5, 6));
    const sprite = loadSprite(dir, ['codex']);
    expect(sprite && rgba(sprite, 0, 0)).toEqual([4, 5, 6, 255]);
  });
});
