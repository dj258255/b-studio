import { describe, expect, it } from 'vitest';
import { FAVICON_SIZES, ICONSET, packIco } from './make-icon';

/** ICO 항목 하나를 읽는다(헤더 6바이트 + 항목 16바이트) */
function entry(ico: Buffer, index: number) {
  const at = 6 + 16 * index;
  return {
    width: ico.readUInt8(at),
    height: ico.readUInt8(at + 1),
    bitCount: ico.readUInt16LE(at + 6),
    length: ico.readUInt32LE(at + 8),
    offset: ico.readUInt32LE(at + 12),
  };
}

describe('packIco', () => {
  it('PNG들을 ICO 하나로 묶고 항목마다 크기·길이·시작 위치를 적는다', () => {
    const ico = packIco([
      { size: 16, png: Buffer.from('16') },
      { size: 32, png: Buffer.from('3232') },
      { size: 48, png: Buffer.from('484848') },
    ]);

    expect(ico.readUInt16LE(0)).toBe(0); // 예약
    expect(ico.readUInt16LE(2)).toBe(1); // 아이콘
    expect(ico.readUInt16LE(4)).toBe(3);
    expect(entry(ico, 0)).toEqual({ width: 16, height: 16, bitCount: 32, length: 2, offset: 54 });
    expect(entry(ico, 1)).toEqual({ width: 32, height: 32, bitCount: 32, length: 4, offset: 56 });
    expect(entry(ico, 2)).toEqual({ width: 48, height: 48, bitCount: 32, length: 6, offset: 60 });
    // 본문이 항목 순서대로 이어 붙는다(브라우저가 offset으로 찾아 읽는다)
    expect(ico.subarray(54).toString()).toBe('163232484848');
    expect(ico.length).toBe(54 + 2 + 4 + 6);
  });

  it('256은 한 바이트에 담기지 않아 0으로 적는다(ICO 규칙)', () => {
    const ico = packIco([{ size: 256, png: Buffer.from('x') }]);
    expect([ico.readUInt8(6), ico.readUInt8(7)]).toEqual([0, 0]);
  });
});

describe('아이콘 크기 목록', () => {
  it('iconset은 macOS가 요구하는 10개(이름·크기)를 그대로 담는다', () => {
    expect(ICONSET.map(([, size]) => size)).toEqual([16, 32, 32, 64, 128, 256, 256, 512, 512, 1024]);
    expect(ICONSET.map(([name]) => name)).toContain('icon_512x512@2x.png');
  });

  it('favicon은 탭·작업 표시줄·바로 가기 크기를 담는다', () => {
    expect(FAVICON_SIZES).toEqual([16, 32, 48]);
  });
});
