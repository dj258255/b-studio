import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { CompareMask } from '@b-studio/spec';

export interface CompareResult {
  /** 실제 화면이 디자인과 다른 픽셀 비율 (0~1) */
  ratio: number;
  diffPixels: number;
  comparedPixels: number;
  width: number;
  height: number;
  /** 차이를 표시한 PNG 이미지 */
  diff: Buffer;
}

/** 비교 자체가 성립하지 않는 경우(너비 불일치). 게이트가 이 메시지를 실패 사유로 그대로 쓴다 */
export class VisualCompareError extends Error {}

/** 가림 영역을 칠하는 색. 두 이미지에 같은 색을 칠해야 그 영역이 차이로 세어지지 않는다 */
const MASK_COLOR = { r: 0, g: 0, b: 0, a: 255 };

function paintMask(png: PNG, mask: CompareMask): void {
  const left = Math.max(0, mask.x);
  const top = Math.max(0, mask.y);
  const right = Math.min(png.width, mask.x + mask.width);
  const bottom = Math.min(png.height, mask.y + mask.height);
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const index = (png.width * y + x) << 2;
      png.data[index] = MASK_COLOR.r;
      png.data[index + 1] = MASK_COLOR.g;
      png.data[index + 2] = MASK_COLOR.b;
      png.data[index + 3] = MASK_COLOR.a;
    }
  }
}

/**
 * 실제 화면과 디자인 기준 이미지를 픽셀 단위로 비교한다.
 * 너비가 다르면 자동으로 맞추지 않고 실패로 알린다(비교가 성립하려면 뷰포트를 디자인 프레임 너비에 맞춰야 한다).
 * 높이는 짧은 쪽에 맞춰 겹치는 부분만 비교한다. masks 영역은 두 이미지 모두 같은 색으로 칠해 비교에서 뺀다.
 */
export function compareScreenshot({
  actual,
  reference,
  masks = [],
  threshold = 0.1,
}: {
  actual: Buffer;
  reference: Buffer;
  masks?: readonly CompareMask[];
  threshold?: number;
}): CompareResult {
  const actualPng = PNG.sync.read(actual);
  const referencePng = PNG.sync.read(reference);
  if (actualPng.width !== referencePng.width) {
    throw new VisualCompareError(
      `이미지 너비가 다릅니다 (실제 ${actualPng.width}px, 디자인 ${referencePng.width}px). 뷰포트를 디자인 프레임 너비에 맞추세요`,
    );
  }
  const width = actualPng.width;
  // pixelmatch는 두 배열의 길이가 같아야 하므로, 겹치는 위쪽 height행만 잘라 넘긴다
  const height = Math.min(actualPng.height, referencePng.height);
  for (const mask of masks) {
    paintMask(actualPng, mask);
    paintMask(referencePng, mask);
  }
  const diff = new PNG({ width, height });
  const rows = width * height * 4;
  const diffPixels = pixelmatch(actualPng.data.subarray(0, rows), referencePng.data.subarray(0, rows), diff.data, width, height, { threshold });
  const comparedPixels = width * height;
  return {
    ratio: comparedPixels === 0 ? 0 : diffPixels / comparedPixels,
    diffPixels,
    comparedPixels,
    width,
    height,
    diff: PNG.sync.write(diff),
  };
}
