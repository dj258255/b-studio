import { native } from '@b-studio/sandbox';
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

/** 비교 자체가 성립하지 않는 경우(너비 불일치, 너무 큰 이미지, 비교한 픽셀 0, 범위 밖 threshold). 게이트가 이 메시지를 실패 사유로 그대로 쓴다 */
export class VisualCompareError extends Error {}

/**
 * 실제 화면과 디자인 기준 이미지를 픽셀 단위로 비교한다(판정은 Rust: crates/bstudio-guard/src/visual_compare.rs, ADR-191 3ae. 이 파일은 같은 이름·시그니처의 껍데기다).
 * 너비가 다르면 자동으로 맞추지 않고 실패로 알린다(비교가 성립하려면 뷰포트를 디자인 프레임 너비에 맞춰야 한다).
 * 높이는 짧은 쪽에 맞춰 겹치는 부분만 비교한다. masks 영역은 두 이미지 모두 같은 색으로 칠해 비교에서 뺀다.
 * PNG를 읽지 못하면 일반 Error, 비교가 성립하지 않으면 VisualCompareError를 던진다.
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
  const flat: number[] = [];
  for (const mask of masks) flat.push(Number(mask.x), Number(mask.y), Number(mask.width), Number(mask.height));
  const result = native.visualCompare(actual, reference, flat, Number(threshold));
  if (result.errorKind === 'compare') throw new VisualCompareError(result.message ?? '비교가 성립하지 않습니다');
  if (result.errorKind || !result.diff) throw new Error(result.message ?? 'PNG를 읽지 못했습니다');
  return {
    ratio: result.diffPixels / result.comparedPixels,
    diffPixels: result.diffPixels,
    comparedPixels: result.comparedPixels,
    width: result.width,
    height: result.height,
    diff: result.diff,
  };
}
