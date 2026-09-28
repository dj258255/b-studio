import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { compareScreenshot, VisualCompareError } from './visual-compare';

/** 단색 배경에 원하는 색을 칠한 PNG 버퍼를 만든다 */
function image(width: number, height: number, paint: (x: number, y: number) => [number, number, number] = () => [255, 255, 255]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (width * y + x) << 2;
      const [r, g, b] = paint(x, y);
      png.data[index] = r;
      png.data[index + 1] = g;
      png.data[index + 2] = b;
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe('compareScreenshot', () => {
  it('같은 이미지는 차이가 0이다', () => {
    const result = compareScreenshot({ actual: image(100, 100), reference: image(100, 100) });
    expect(result.ratio).toBe(0);
    expect(result.diffPixels).toBe(0);
    expect(result.comparedPixels).toBe(10_000);
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
  });

  it('100×100에서 10×10 사각형이 다르면 1%다', () => {
    const reference = image(100, 100);
    const actual = image(100, 100, (x, y) => (x < 10 && y < 10 ? [0, 0, 0] : [255, 255, 255]));
    const result = compareScreenshot({ actual, reference });
    expect(result.diffPixels).toBe(100);
    expect(result.ratio).toBeCloseTo(0.01, 5);
    // 차이 이미지는 PNG로 돌려준다
    expect(result.diff.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('mask로 가린 영역은 비교에서 빼 0이 된다', () => {
    const reference = image(100, 100);
    const actual = image(100, 100, (x, y) => (x < 10 && y < 10 ? [0, 0, 0] : [255, 255, 255]));
    const result = compareScreenshot({ actual, reference, masks: [{ x: 0, y: 0, width: 10, height: 10 }] });
    expect(result.diffPixels).toBe(0);
    expect(result.ratio).toBe(0);
  });

  it('너비가 다르면 자동으로 맞추지 않고 실패로 알린다', () => {
    expect(() => compareScreenshot({ actual: image(120, 100), reference: image(100, 100) })).toThrow(VisualCompareError);
    expect(() => compareScreenshot({ actual: image(120, 100), reference: image(100, 100) })).toThrow(/뷰포트를 디자인 프레임 너비에 맞추세요/);
  });

  it('높이가 다르면 겹치는 위쪽만 비교하고 비교한 높이를 적는다', () => {
    // 아래쪽(50~79행)만 다른 색이지만 기준은 50행까지만 비교 대상이다
    const reference = image(100, 50);
    const actual = image(100, 80, (_x, y) => (y >= 50 ? [0, 0, 0] : [255, 255, 255]));
    const result = compareScreenshot({ actual, reference });
    expect(result.height).toBe(50);
    expect(result.comparedPixels).toBe(5_000);
    expect(result.diffPixels).toBe(0);
  });
});
