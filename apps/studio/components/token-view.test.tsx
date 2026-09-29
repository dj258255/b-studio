import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TokenReport } from "@/lib/token-types";
import { RunDetail } from "./token-view";

function report(over: Partial<TokenReport> = {}): TokenReport {
  return {
    runId: "r1",
    request: "요청",
    turns: [],
    toolTotals: [],
    biggest: [],
    warnings: [],
    totals: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
    cacheHitRatio: 0,
    cleared: { count: 0, chars: 0 },
    priceSource: "none",
    ...over,
  };
}

const render = (reportValue: TokenReport) => renderToStaticMarkup(<RunDetail report={reportValue} />);

describe("RunDetail 모델별", () => {
  it("모델이 여럿이면 모델·토큰·비용 표를 그린다", () => {
    const html = render(
      report({
        usageByModel: {
          haiku: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
          sonnet: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
        modelCosts: { haiku: 0.0001, sonnet: 0.0009 },
        estimatedCostUsd: 0.001,
        priceSource: "by-model",
      }),
    );

    expect(html).toContain("모델</th>");
    expect(html).toContain("캐시 읽기</th>");
    expect(html).toContain("haiku");
    expect(html).toContain("sonnet");
    expect(html).toContain("$0.0001");
    expect(html).toContain("$0.0009");
    // 합계 비용 옆에 계산 방식
    expect(html).toContain("$0.0010 · 모델별 단가");
  });

  it("모델이 하나면 표 대신 한 줄로 적는다", () => {
    const html = render(
      report({
        usageByModel: { haiku: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        modelCosts: { haiku: 0.0001 },
        estimatedCostUsd: 0.0001,
        priceSource: "by-model",
      }),
    );

    expect(html).not.toContain("모델</th>");
    expect(html).toContain("haiku");
    expect(html).toContain("$0.0001");
  });

  it("단가가 없는 모델은 비용 칸에 사유를 적는다", () => {
    const html = render(
      report({
        usageByModel: {
          haiku: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
          sonnet: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
        modelCosts: { haiku: 0.0001 },
        priceNote: "단가 없음: sonnet",
        priceSource: "by-model",
      }),
    );

    expect(html).toContain("단가 없음: sonnet");
    expect(html).toContain("단가 없음</td>");
  });

  it("승격이 있으면 몇 번째 실패 뒤 무엇으로 올렸는지 한 줄로 적는다", () => {
    const html = render(report({ escalation: { from: "haiku", to: "sonnet", attempt: 2 } }));
    expect(html).toContain("2번째 게이트 실패 뒤");
    expect(html).toContain("haiku");
    expect(html).toContain("sonnet");
  });

  it("단일 단가와 단가 미설정을 구분해 표시한다", () => {
    expect(render(report({ estimatedCostUsd: 0.5, priceSource: "single" }))).toContain("$0.5000 · 단일 단가");
    expect(render(report({ priceSource: "none" }))).toContain("단가 미설정");
  });
});
