/**
 * 요소 선택(드래그·오버레이)에 쓰는 순수 기하 계산. DOM에 닿지 않으므로 vitest로 그대로 검증할 수 있다.
 * 실제 드래그 선택은 서버가 Playwright의 page.evaluate 안에서 돌리므로(원격 브라우저의 실제 DOM을 봐야 해서
 * 이 파일의 함수를 그대로 부를 수 없다. packages/agent/src/remote-browser.ts의 pickRectExpression이 같은 규칙을
 * 브라우저 안 자바스크립트 문자열로 다시 구현한다), 여기서는 그 규칙이 옳은지 검증하고 클라이언트 쪽 계산(정규화·클램프·표시 크기 환산)에 쓴다.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 드래그 중 눌린 점과 지금 점(어느 방향이든)에서 좌상단 기준의 정상화된 사각형을 만든다 */
export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** 폭·높이가 음수여도 안전하게 0으로 본다 */
export function rectArea(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

/** 두 사각형의 교집합. 겹치지 않으면 undefined */
export function intersectRect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return undefined;
  return { x, y, width: right - x, height: bottom - y };
}

/** inner가 outer 안에 완전히 들어오는지(경계가 닿는 것도 포함) */
export function containsRect(outer: Rect, inner: Rect): boolean {
  return outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
}

/** 사각형을 뷰포트 범위 안으로 잘라낸다. 드래그가 화면 밖으로 나가도 보낼 좌표는 항상 뷰포트 안이게 한다 */
export function clampRect(rect: Rect, bounds: Size): Rect {
  const x = Math.min(Math.max(rect.x, 0), bounds.width);
  const y = Math.min(Math.max(rect.y, 0), bounds.height);
  const right = Math.min(Math.max(rect.x + rect.width, 0), bounds.width);
  const bottom = Math.min(Math.max(rect.y + rect.height, 0), bounds.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

export interface RectCandidate<T> {
  rect: Rect;
  value: T;
}

/**
 * 드래그 사각형을 두고, 후보 중 가장 쓸모 있는 하나를 고른다.
 *
 * 드래그 선택은 디자인 도구의 마퀴(marquee) 선택처럼, 고르려는 요소를 상자로 감싸듯 그리는 것이 자연스러운 조작이다.
 * 그래서 순서는:
 * 1순위: 드래그 사각형 안에 완전히 들어오는 후보 중 면적이 가장 작은 것(상자로 정확히 둘러싼, 가장 구체적인 후보를 남긴다).
 * 2순위: 완전히 들어오는 후보가 없으면(상자가 후보 가장자리를 살짝 벗어나거나 후보보다 작게 그렸을 때), 드래그와 겹치는
 *        비율(교집합 면적 / 자기 면적)이 가장 크고, 그중 면적이 가장 작은 후보.
 * 아무 후보와도 겹치지 않으면 undefined.
 *
 * packages/agent/src/remote-browser.ts의 pickRectExpression이 실제 DOM 안에서 같은 규칙을 구현한다(그 코드는
 * page.evaluate 문자열이라 이 함수를 직접 불러 쓰지 못한다). 이 함수는 그 규칙을 순수하게 재현해 vitest로 검증한다.
 */
export function pickBestRect<T>(drag: Rect, candidates: readonly RectCandidate<T>[]): RectCandidate<T> | undefined {
  if (rectArea(drag) <= 0) return undefined;

  let contained: { candidate: RectCandidate<T>; area: number } | undefined;
  let overlapping: { candidate: RectCandidate<T>; ratio: number; area: number } | undefined;

  for (const candidate of candidates) {
    const area = rectArea(candidate.rect);
    if (area <= 0) continue;
    if (containsRect(drag, candidate.rect)) {
      if (!contained || area < contained.area) contained = { candidate, area };
      continue;
    }
    const overlap = intersectRect(drag, candidate.rect);
    if (!overlap) continue;
    const ratio = rectArea(overlap) / area;
    if (ratio <= 0) continue;
    if (!overlapping || ratio > overlapping.ratio || (ratio === overlapping.ratio && area < overlapping.area)) {
      overlapping = { candidate, ratio, area };
    }
  }

  return (contained ?? overlapping)?.candidate;
}

/** rect를 from 크기 기준에서 to 크기 기준으로 선형 비례 환산한다(뷰포트 픽셀 → 화면에 그려진 프레임 크기, 또는 퍼센트) */
export function scaleRect(rect: Rect, from: Size, to: Size): Rect {
  if (from.width <= 0 || from.height <= 0) return rect;
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  return { x: rect.x * sx, y: rect.y * sy, width: rect.width * sx, height: rect.height * sy };
}

/**
 * 선택을 고른 순간의 뷰포트 크기와 지금 프레임의 뷰포트 크기가 다르면 true(프리셋이 바뀌어 화면이 통째로 다시 짜였다는 뜻).
 * 이때는 저장된 좌표가 지금 화면과 안 맞으므로 오버레이를 숨긴다. 스크롤만 바뀐 경우는 크기가 그대로라 여기 걸리지 않고,
 * (스크롤 변화를 알 방법이 없으므로) 고른 순간 위치를 대략 그대로 보여 준다
 */
export function isRectStale(capturedViewport: Size, currentViewport: Size): boolean {
  return capturedViewport.width !== currentViewport.width || capturedViewport.height !== currentViewport.height;
}
