import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createView } from "@/lib/session-view";
import type { SessionSnapshot } from "@/lib/studio-events";
import { SubmissionPanel } from "./submission-panel";

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

describe("SubmissionPanel", () => {
  it("데이터를 받기 전에는 점검표를 불러오는 중이라고 알린다(서버 렌더는 fetch를 하지 않는다)", () => {
    const html = renderToStaticMarkup(<SubmissionPanel view={createView(baseSnapshot)} />);
    expect(html).toContain("점검표를 불러오는 중");
  });
});
