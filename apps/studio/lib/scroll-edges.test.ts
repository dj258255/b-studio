import { describe, expect, it } from "vitest";
import { revealScrollLeft, scrollFade } from "./scroll-edges";

describe("scrollFade", () => {
  it("넘칠 것이 없으면 단서를 두지 않는다(넓은 화면은 그대로)", () => {
    expect(scrollFade({ scrollLeft: 0, scrollWidth: 400, clientWidth: 400 })).toBeUndefined();
    // 소수점 반올림으로 1px 남는 것은 넘침으로 보지 않는다
    expect(scrollFade({ scrollLeft: 0, scrollWidth: 401, clientWidth: 400 })).toBeUndefined();
  });

  it("맨 앞이면 뒤쪽만, 맨 끝이면 앞쪽만, 가운데면 양쪽에 단서를 둔다", () => {
    expect(scrollFade({ scrollLeft: 0, scrollWidth: 455, clientWidth: 366 })).toBe("end");
    expect(scrollFade({ scrollLeft: 89, scrollWidth: 455, clientWidth: 366 })).toBe("start");
    expect(scrollFade({ scrollLeft: 40, scrollWidth: 455, clientWidth: 366 })).toBe("both");
  });
});

describe("revealScrollLeft", () => {
  const viewport = { scrollLeft: 0, scrollWidth: 455, clientWidth: 366 };

  it("이미 단서 안쪽까지 보이는 탭이면 움직이지 않는다", () => {
    expect(revealScrollLeft(viewport, { start: 4, end: 90 }, 24)).toBeUndefined();
  });

  it("오른쪽에 가려진 탭은 가장자리 단서만큼 더 넘겨 다 보이게 한다", () => {
    expect(revealScrollLeft(viewport, { start: 300, end: 360 }, 24)).toBe(360 + 24 - 366);
  });

  it("왼쪽에 가려진 탭은 앞으로 되돌린다", () => {
    expect(revealScrollLeft({ ...viewport, scrollLeft: 89 }, { start: 60, end: 140 }, 24)).toBe(36);
  });

  it("넘길 수 있는 범위 밖으로는 넘기지 않는다", () => {
    expect(revealScrollLeft(viewport, { start: 400, end: 451 }, 24)).toBe(455 - 366);
    expect(revealScrollLeft({ ...viewport, scrollLeft: 89 }, { start: 4, end: 90 }, 24)).toBe(0);
  });
});
