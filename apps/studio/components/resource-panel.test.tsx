import { renderToStaticMarkup } from "react-dom/server";
import type { ServiceUsage } from "@b-studio/sandbox";
import { describe, expect, it } from "vitest";
import { createView } from "@/lib/session-view";
import type { SessionSnapshot } from "@/lib/studio-events";
import { ResourcePanel } from "./resource-panel";

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

const usage = (partial: Partial<ServiceUsage> & { service: string }): ServiceUsage => ({ state: "running", oomKilled: false, ...partial });

describe("ResourcePanel", () => {
  it("샌드박스가 꺼져 있으면 빈 상태 문구를 보여 준다", () => {
    const view = createView({ ...baseSnapshot, status: "stopped" });
    const html = renderToStaticMarkup(<ResourcePanel view={view} />);
    expect(html).toContain("샌드박스가 꺼져 있습니다");
  });

  it("아직 한 번도 재지 않았으면 준비 안내 문구를 보여 준다", () => {
    const view = createView(baseSnapshot);
    const html = renderToStaticMarkup(<ResourcePanel view={view} />);
    expect(html).toContain("몇 초마다 보여 줍니다");
  });

  it("갈래별로 묶어 컨테이너를 보여 준다", () => {
    const view = createView({
      ...baseSnapshot,
      usage: {
        at: "2026-09-12T12:00:00.000Z",
        services: [
          usage({ service: "api", role: "managed", cpuPercent: 12.5, memoryBytes: 100 * 1024 ** 2, memoryLimitBytes: 512 * 1024 ** 2, health: "healthy" }),
          usage({ service: "db", role: "supporting", cpuPercent: 1, memoryBytes: 40 * 1024 ** 2 }),
          usage({ service: "b-studio-edge", role: "platform", cpuPercent: 0.1, memoryBytes: 8 * 1024 ** 2 }),
        ],
      },
    });
    const html = renderToStaticMarkup(<ResourcePanel view={view} />);
    expect(html).toContain("서비스");
    expect(html).toContain("부가 서비스");
    expect(html).toContain("플랫폼");
    expect(html).toContain("api");
    expect(html).toContain("db");
    expect(html).toContain("b-studio-edge");
    expect(html).toContain("정상");
  });

  it("컨테이너가 사라졌다가 나타나도 화면이 지금 목록만 보여 준다", () => {
    const withDb = createView({
      ...baseSnapshot,
      usage: { at: "2026-09-12T12:00:00.000Z", services: [usage({ service: "api", role: "managed" }), usage({ service: "db", role: "supporting" })] },
    });
    const withoutDb = createView({ ...baseSnapshot, usage: { at: "2026-09-12T12:00:05.000Z", services: [usage({ service: "api", role: "managed" })] } });

    expect(renderToStaticMarkup(<ResourcePanel view={withDb} />)).toContain("db");
    expect(renderToStaticMarkup(<ResourcePanel view={withoutDb} />)).not.toContain(">db<");
  });
});
