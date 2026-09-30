import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createView } from "@/lib/session-view";
import type { SessionSnapshot } from "@/lib/studio-events";
import { RequirementsPanel } from "./requirements-panel";

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
