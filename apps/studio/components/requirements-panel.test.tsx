import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createView } from "@/lib/session-view";
import type { SessionSnapshot } from "@/lib/studio-events";
import { ImportFlow, RequirementsPanel } from "./requirements-panel";

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

describe("RequirementsPanel", () => {
  it("데이터를 받기 전에는 불러오는 중이라고 알린다(명세 → 요구사항 → 검증 추적, ADR-079)", () => {
    const html = renderToStaticMarkup(<RequirementsPanel view={createView(baseSnapshot)} />);

    expect(html).toContain("명세 → 요구사항 → 검증 추적");
    expect(html).toContain("불러오는 중");
  });
});

describe("ImportFlow 용어", () => {
  it("과제처럼 들리는 말 대신 중립적인 제품 용어를 쓴다", () => {
    const html = renderToStaticMarkup(<ImportFlow sessionId="s1" onApplied={() => {}} />);

    expect(html).not.toContain("과제");
    expect(html).toContain("만들 것을 적어 주세요");
  });
});
