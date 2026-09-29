import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TaskPlanMetrics } from "@/lib/task-plan-metrics";
import { PlanTokenTotals } from "./task-plan-workbench";

function metrics(over: Partial<TaskPlanMetrics> = {}): TaskPlanMetrics {
  return {
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    modelCalls: 0,
    maxContextTokens: 0,
    bootMsTotal: 0,
    bootMsMax: 0,
    bootRxBytesTotal: 0,
    modelMs: 0,
    toolMs: 0,
    gateMs: 0,
    sessions: 1,
    ...over,
  };
}

describe("PlanTokenTotals", () => {
  it("계획 토큰 합계와 모델별 합을 보여 준다", () => {
    const html = renderToStaticMarkup(
      <PlanTokenTotals
        metrics={metrics({
          usage: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
          usageByModel: {
            haiku: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
            sonnet: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
        })}
      />,
    );

    expect(html).toContain("토큰 합계");
    expect(html).toContain("haiku");
    expect(html).toContain("sonnet");
  });

  it("토큰이 없으면 아무것도 그리지 않는다", () => {
    expect(renderToStaticMarkup(<PlanTokenTotals metrics={metrics()} />)).toBe("");
    expect(renderToStaticMarkup(<PlanTokenTotals metrics={undefined} />)).toBe("");
  });
});
