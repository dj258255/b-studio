import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HandoffCard, handoffTarget } from "./handoff-card";

describe("handoffTarget", () => {
  it("넘긴 곳 주소에서 계획·비교 id를 꺼내고, 모르는 주소는 버린다", () => {
    expect(handoffTarget("/task-plans?id=adee9322")).toEqual({ kind: "plan", id: "adee9322" });
    expect(handoffTarget("/fleets?id=f%2D1")).toEqual({ kind: "fleet", id: "f-1" });
    expect(handoffTarget("/sessions/abc")).toBeUndefined();
    expect(handoffTarget("https://example.com/task-plans?id=x")).toBeUndefined();
  });
});

describe("HandoffCard", () => {
  it("계획·비교 카드는 첫 그리기에 불러오는 중을 보이고 자세히 링크를 단다(대화 안에서 진행을 본다)", () => {
    const plan = renderToStaticMarkup(<HandoffCard href="/task-plans?id=p1" canManage />);
    expect(plan).toContain('aria-label="나눠서 병렬 진행"');
    expect(plan).toContain("불러오는 중");
    expect(plan).toContain('href="/task-plans?id=p1"');

    const fleet = renderToStaticMarkup(<HandoffCard href="/fleets?id=f1" canManage />);
    expect(fleet).toContain('aria-label="여러 명 비교 진행"');
  });

  it("주소를 해석할 수 없으면 아무것도 그리지 않는다", () => {
    expect(renderToStaticMarkup(<HandoffCard href="/sessions/abc" canManage />)).toBe("");
  });
});
