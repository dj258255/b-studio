import { describe, expect, it } from "vitest";
import { clampRect, containsRect, intersectRect, isRectStale, normalizeRect, pickBestRect, rectArea, scaleRect, type Rect } from "./element-pick-geometry";

describe("normalizeRect", () => {
  it("두 점이 어느 방향이든 좌상단 기준 사각형으로 정리한다", () => {
    expect(normalizeRect({ x: 10, y: 10 }, { x: 50, y: 30 })).toEqual({ x: 10, y: 10, width: 40, height: 20 });
    expect(normalizeRect({ x: 50, y: 30 }, { x: 10, y: 10 })).toEqual({ x: 10, y: 10, width: 40, height: 20 });
    expect(normalizeRect({ x: 50, y: 10 }, { x: 10, y: 30 })).toEqual({ x: 10, y: 10, width: 40, height: 20 });
  });

  it("같은 점이면 크기 0인 사각형이 된다", () => {
    expect(normalizeRect({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5, width: 0, height: 0 });
  });
});

describe("rectArea", () => {
  it("폭과 높이를 곱한다", () => {
    expect(rectArea({ x: 0, y: 0, width: 10, height: 4 })).toBe(40);
  });

  it("음수 폭·높이는 0으로 본다", () => {
    expect(rectArea({ x: 0, y: 0, width: -10, height: 4 })).toBe(0);
  });
});

describe("intersectRect", () => {
  it("겹치는 영역을 돌려준다", () => {
    const a: Rect = { x: 0, y: 0, width: 10, height: 10 };
    const b: Rect = { x: 5, y: 5, width: 10, height: 10 };
    expect(intersectRect(a, b)).toEqual({ x: 5, y: 5, width: 5, height: 5 });
  });

  it("겹치지 않으면 undefined", () => {
    const a: Rect = { x: 0, y: 0, width: 10, height: 10 };
    const b: Rect = { x: 20, y: 20, width: 10, height: 10 };
    expect(intersectRect(a, b)).toBeUndefined();
  });

  it("경계만 맞닿으면 겹치지 않는 것으로 본다(면적이 0)", () => {
    const a: Rect = { x: 0, y: 0, width: 10, height: 10 };
    const b: Rect = { x: 10, y: 0, width: 10, height: 10 };
    expect(intersectRect(a, b)).toBeUndefined();
  });
});

describe("containsRect", () => {
  const outer: Rect = { x: 0, y: 0, width: 100, height: 100 };

  it("inner가 outer 안에 완전히 들어오면 true", () => {
    expect(containsRect(outer, { x: 10, y: 10, width: 20, height: 20 })).toBe(true);
  });

  it("경계가 정확히 맞닿아도 true", () => {
    expect(containsRect(outer, { x: 0, y: 0, width: 100, height: 100 })).toBe(true);
  });

  it("한쪽이라도 벗어나면 false", () => {
    expect(containsRect(outer, { x: 90, y: 10, width: 20, height: 20 })).toBe(false);
  });
});

describe("clampRect", () => {
  it("범위 안이면 그대로 둔다", () => {
    expect(clampRect({ x: 10, y: 10, width: 20, height: 20 }, { width: 100, height: 100 })).toEqual({ x: 10, y: 10, width: 20, height: 20 });
  });

  it("음수 좌표와 범위를 벗어난 크기를 뷰포트 안으로 잘라낸다", () => {
    expect(clampRect({ x: -10, y: -10, width: 30, height: 30 }, { width: 100, height: 100 })).toEqual({ x: 0, y: 0, width: 20, height: 20 });
    expect(clampRect({ x: 90, y: 90, width: 30, height: 30 }, { width: 100, height: 100 })).toEqual({ x: 90, y: 90, width: 10, height: 10 });
  });

  it("완전히 범위 밖이면 크기가 0이 된다", () => {
    expect(clampRect({ x: 200, y: 200, width: 10, height: 10 }, { width: 100, height: 100 })).toEqual({ x: 100, y: 100, width: 0, height: 0 });
  });
});

describe("pickBestRect", () => {
  // 카드(큰 컨테이너) 안에 버튼(작은 요소)이 있는 전형적인 페이지 구조
  const card = { rect: { x: 0, y: 0, width: 300, height: 200 }, value: "card" };
  const button = { rect: { x: 20, y: 20, width: 60, height: 24 }, value: "button" };

  it("드래그 사각형 안에 완전히 들어오는 후보 중 가장 작은 것을 고른다", () => {
    // 버튼을 여유 있게 감싸는 드래그. 카드는 드래그보다 커서 안에 들어오지 않는다
    const drag: Rect = { x: 10, y: 10, width: 100, height: 60 };
    expect(pickBestRect(drag, [card, button])?.value).toBe("button");
  });

  it("완전히 감싸는 후보가 없으면 겹치는 비율이 가장 큰 후보를 고른다", () => {
    // 버튼 오른쪽 절반만 걸치는 좁은 드래그: 버튼을 완전히 감싸지 못하지만(오른쪽으로 삐져나감) 카드보다 훨씬 많이 겹친다
    const drag: Rect = { x: 50, y: 20, width: 30, height: 24 };
    expect(pickBestRect(drag, [card, button])?.value).toBe("button");
  });

  it("겹치는 후보가 없으면 undefined", () => {
    const drag: Rect = { x: 500, y: 500, width: 10, height: 10 };
    expect(pickBestRect(drag, [card, button])).toBeUndefined();
  });

  it("드래그 사각형 자체가 비어 있으면(면적 0) undefined", () => {
    const drag: Rect = { x: 10, y: 10, width: 0, height: 0 };
    expect(pickBestRect(drag, [card, button])).toBeUndefined();
  });

  it("완전히 감싸는 후보가 여럿이면 그중 가장 작은 것을 고른다(중첩된 컨테이너 예시)", () => {
    const outer = { rect: { x: 0, y: 0, width: 400, height: 400 }, value: "outer" };
    const middle = { rect: { x: 10, y: 10, width: 200, height: 200 }, value: "middle" };
    const inner = { rect: { x: 20, y: 20, width: 50, height: 50 }, value: "inner" };
    const drag: Rect = { x: 0, y: 0, width: 300, height: 300 };
    expect(pickBestRect(drag, [outer, middle, inner])?.value).toBe("inner");
  });

  it("후보가 비어 있으면 undefined", () => {
    expect(pickBestRect({ x: 0, y: 0, width: 10, height: 10 }, [])).toBeUndefined();
  });
});

describe("scaleRect", () => {
  it("가로세로 비율이 같으면 그대로 비례한다", () => {
    const rect: Rect = { x: 100, y: 50, width: 200, height: 100 };
    expect(scaleRect(rect, { width: 1000, height: 500 }, { width: 500, height: 250 })).toEqual({ x: 50, y: 25, width: 100, height: 50 });
  });

  it("퍼센트로 환산할 때도 쓸 수 있다(to가 100×100)", () => {
    const rect: Rect = { x: 320, y: 200, width: 160, height: 80 };
    expect(scaleRect(rect, { width: 1280, height: 800 }, { width: 100, height: 100 })).toEqual({ x: 25, y: 25, width: 12.5, height: 10 });
  });

  it("원본 크기가 0 이하면 그대로 돌려준다(0으로 나누기 방지)", () => {
    const rect: Rect = { x: 1, y: 2, width: 3, height: 4 };
    expect(scaleRect(rect, { width: 0, height: 0 }, { width: 100, height: 100 })).toEqual(rect);
  });
});

describe("isRectStale", () => {
  it("고른 순간과 지금 뷰포트 크기가 같으면 stale이 아니다(스크롤만 바뀐 경우 포함)", () => {
    expect(isRectStale({ width: 1280, height: 800 }, { width: 1280, height: 800 })).toBe(false);
  });

  it("프리셋이 바뀌어 뷰포트 크기가 달라지면 stale이다", () => {
    expect(isRectStale({ width: 1280, height: 800 }, { width: 375, height: 812 })).toBe(true);
  });
});
