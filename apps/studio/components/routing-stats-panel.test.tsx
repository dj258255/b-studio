import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RoutingStats } from "@/lib/routing-types";
import { RoutingStatsPanel } from "./routing-stats-panel";

const stats: RoutingStats = {
  rows: [
    { backend: "claude-code", model: "sonnet", kind: { complexity: "simple", risk: "normal" }, runs: 3, passed: 2, failed: 1, errors: 0, platformFailures: 1, noChange: 0, passRate: 2 / 3, medianCostUsd: 0.0123, medianDurationMs: 61_000 },
    { backend: "codex", model: "(모름)", kind: "unknown", runs: 1, passed: 0, failed: 0, errors: 0, platformFailures: 0, noChange: 1 },
  ],
  excluded: { asks: 4, unfinished: 2 },
};

describe("RoutingStatsPanel(#821)", () => {
  it("AI·모델·작업 종류별 통과율과 비용·시간을 한 줄씩 보인다", () => {
    const html = renderToStaticMarkup(<RoutingStatsPanel stats={stats} />);
    expect(html).toContain("로컬 Claude Agent");
    expect(html).toContain("sonnet");
    expect(html).toContain("단순");
    expect(html).toContain("67%");
    expect(html).toContain("2/3");
    expect(html).toContain("$0.01");
    expect(html).toContain("1분 1초");
    // 플랫폼 실패는 성적과 따로 적는다
    expect(html).toContain("플랫폼 문제 1");
  });

  it("판정할 실행이 없는 줄은 통과율 대신 까닭을 적는다", () => {
    const html = renderToStaticMarkup(<RoutingStatsPanel stats={stats} />);
    expect(html).toContain("로컬 ChatGPT Agent");
    expect(html).toContain("판정할 변경 없음");
  });

  it("표에 넣지 않은 실행 수를 알린다", () => {
    const html = renderToStaticMarkup(<RoutingStatsPanel stats={stats} />);
    expect(html).toContain("질문 4건");
    expect(html).toContain("끝나지 않은 실행 2건");
  });

  it("기록이 없으면 빈 표 대신 안내를 보인다", () => {
    const html = renderToStaticMarkup(<RoutingStatsPanel stats={{ rows: [], excluded: { asks: 0, unfinished: 0 } }} />);
    expect(html).toContain("아직 판정한 만들기 요청이 없습니다");
    expect(html).not.toContain("<table");
  });
});
