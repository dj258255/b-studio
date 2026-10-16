/**
 * 가로로 넘치는 탭 막대의 가장자리 단서와 고른 탭 보이기. DOM 없이 계산만 해 테스트한다
 * (components/use-scroll-fade.ts가 이 값으로 data-fade 속성과 scrollLeft를 정한다).
 */

export interface ScrollViewport {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/** 어느 쪽 가장자리에 "더 있다"는 단서를 둘지. 넘치지 않으면 undefined라 넓은 화면은 그대로다 */
export type ScrollFade = "start" | "end" | "both";

/** 레이아웃 반올림으로 생기는 1px 차이는 넘침으로 보지 않는다 */
const SLACK = 1;

export function scrollFade({ scrollLeft, scrollWidth, clientWidth }: ScrollViewport): ScrollFade | undefined {
  const hiddenBefore = scrollLeft > SLACK;
  const hiddenAfter = scrollLeft + clientWidth < scrollWidth - SLACK;
  if (hiddenBefore && hiddenAfter) return "both";
  if (hiddenBefore) return "start";
  if (hiddenAfter) return "end";
  return undefined;
}

/**
 * 탭(막대 안쪽 좌표의 start~end)이 가장자리 단서(margin)에 가리지 않고 보이도록 할 scrollLeft.
 * 이미 보이면 undefined. 넘길 수 있는 범위(0 ~ scrollWidth - clientWidth) 밖으로는 넘기지 않는다
 */
export function revealScrollLeft(viewport: ScrollViewport, item: { start: number; end: number }, margin: number): number | undefined {
  const { scrollLeft, scrollWidth, clientWidth } = viewport;
  const max = Math.max(0, scrollWidth - clientWidth);
  let next: number | undefined;
  if (item.start - margin < scrollLeft) next = item.start - margin;
  else if (item.end + margin > scrollLeft + clientWidth) next = item.end + margin - clientWidth;
  if (next === undefined) return undefined;
  const clamped = Math.min(max, Math.max(0, next));
  return clamped === scrollLeft ? undefined : clamped;
}
