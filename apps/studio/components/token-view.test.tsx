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
    trimmed: { chars: 0, repeated: 0, estimatedTokens: 0 },
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

describe("RunDetail 문맥 급증", () => {
  it("contextGrowth가 없으면(옛 보고서) 문맥 급증 구역을 그리지 않는다", () => {
    const html = render(report({ turns: [{ turn: 1, contextTokens: 1000, delta: 1000, output: 10, cacheRead: 0 }] }));
    expect(html).not.toContain("문맥 급증");
  });

  it("급증이 없으면 없다는 문구를 보여 준다", () => {
    const html = render(
      report({
        turns: [{ turn: 1, contextTokens: 1000, delta: 1000, output: 10, cacheRead: 0 }],
        contextGrowth: { turns: [{ turn: 1, contextTokens: 1000, delta: 1000, sources: [] }], jumps: [] },
      }),
    );
    expect(html).toContain("문맥 급증 0개");
    expect(html).toContain("문맥이 급격히 늘어난 턴이 없습니다");
  });

  it("급증한 턴마다 원인·다시 읽힐 비용 추정·힌트를 보여 주고, 그래프의 해당 막대를 강조한다", () => {
    const html = render(
      report({
        turns: [
          { turn: 1, contextTokens: 1000, delta: 1000, output: 10, cacheRead: 0 },
          { turn: 2, contextTokens: 22_000, delta: 21_000, output: 20, cacheRead: 20_000 },
        ],
        contextGrowth: {
          turns: [
            { turn: 1, contextTokens: 1000, delta: 1000, sources: [] },
            {
              turn: 2,
              contextTokens: 22_000,
              delta: 21_000,
              sources: [{ kind: "tool_result", name: "run_in_service", chars: 20_000, share: 1, hint: "명령 출력을 grep/tail로 좁히게 하세요" }],
            },
          ],
          jumps: [
            {
              turn: 2,
              delta: 21_000,
              previousContext: 1000,
              sources: [{ kind: "tool_result", name: "run_in_service", chars: 20_000, share: 1, hint: "명령 출력을 grep/tail로 좁히게 하세요" }],
              remainingTurns: 2,
              estimatedRereadTokens: 42_000,
              repeatedCall: false,
              hints: ["명령 출력을 grep/tail로 좁히게 하세요"],
            },
          ],
        },
      }),
    );
    expect(html).toContain("문맥 급증 1개");
    expect(html).toContain("턴 2");
    expect(html).toContain("run_in_service");
    expect(html).toContain("42,000");
    expect(html).toContain("명령 출력을 grep/tail로 좁히게 하세요");
    // 턴 표에도 급증 표시가 붙는다
    expect(html).toContain("급증");
    // 그래프에 급증 막대의 툴팁(title)이 있다
    expect(html).toContain("<title>");
  });
});
