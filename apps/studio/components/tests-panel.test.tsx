import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createView } from "@/lib/session-view";
import type { SessionSnapshot } from "@/lib/studio-events";
import { TestsPanel } from "./tests-panel";

const baseSnapshot: SessionSnapshot = {
  id: "s1",
  projectId: "orders",
  projectName: "orders",
  workDir: "/tmp/orders-s1",
  status: "ready",
  mode: "api",
  running: false,
  checkpoints: [],
  services: [],
};

describe("TestsPanel", () => {
  it("데이터를 받기 전에는 불러오는 중이라고 알리고, 전체 실행 버튼과 필터를 보여 준다(ADR-084)", () => {
    const html = renderToStaticMarkup(<TestsPanel view={createView(baseSnapshot)} />);

    expect(html).toContain("백엔드·프론트 테스트를 한 줄씩 보고 돌린다");
    expect(html).toContain("전체 실행");
    expect(html).toContain("전체");
    expect(html).toContain("실패만");
    expect(html).toContain("요구사항 연결");
    expect(html).toContain("불러오는 중");
  });
});
