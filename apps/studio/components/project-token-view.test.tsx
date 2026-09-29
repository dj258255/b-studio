import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TRIM_ESTIMATE_METHOD, type ProjectTokenReport } from "@/lib/project-token-types";
import { ProjectTokenView } from "./project-token-view";

function report(over: Partial<ProjectTokenReport> = {}): ProjectTokenReport {
  return {
    projectId: "orders",
    projectName: "orders",
    generatedAt: "2026-09-03T00:00:00.000Z",
    sessions: 2,
    requests: [
      {
        sessionId: "s-normal",
        kind: "normal",
        request: "주문 목록에 필터를 추가해 줘",
        at: "2026-09-01T10:00:00.000Z",
        usage: { inputTokens: 3000, outputTokens: 110, cacheReadTokens: 30_000, cacheWriteTokens: 100 },
        costUsd: 0.0178,
        turns: 2,
        result: "changed",
      },
      {
        sessionId: "s-lane",
        kind: "lane",
        request: "문구만 고쳐 줘",
        at: "2026-09-02T09:00:00.000Z",
        usage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        result: "light",
      },
    ],
    totals: { inputTokens: 3500, outputTokens: 130, cacheReadTokens: 30_000, cacheWriteTokens: 100 },
    modelCalls: 4,
    usageByModel: {
      haiku: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      sonnet: { inputTokens: 2000, outputTokens: 60, cacheReadTokens: 30_000, cacheWriteTokens: 100 },
    },
    modelCosts: { haiku: 0.0015, sonnet: 0.0163 },
    estimatedCostUsd: 0.0178,
    priceSource: "by-model",
    cacheHitRatio: 30_000 / 33_730,
    kinds: [
      { kind: "normal", sessions: 1, requests: 1, usage: { inputTokens: 3000, outputTokens: 110, cacheReadTokens: 30_000, cacheWriteTokens: 100 }, costUsd: 0.0178 },
      { kind: "lane", sessions: 1, requests: 1, usage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ],
    saved: {
      trimmedChars: 2780,
      repeatedResults: 1,
      clearedCount: 2,
      clearedChars: 1200,
      lightRuns: 1,
      lightSkipped: [{ stage: "test", runs: 1 }],
      trimmedTokensEstimated: 1195,
      trimmedCostUsd: 0.0004,
      trimmedCostModel: "sonnet",
    },
    notes: [],
    ...over,
  };
}

const render = (value: ProjectTokenReport) => renderToStaticMarkup(<ProjectTokenView report={value} />);

describe("ProjectTokenView", () => {
  it("쓴 양 카드에 총 토큰·환산 비용·요청 수·캐시 적중률을 보여 준다", () => {
    const html = render(report());

    expect(html).toContain("토큰 보고서 — orders");
    expect(html).toContain("전체 기간 · 세션 2개");
    expect(html).toContain("33,730");
    expect(html).toContain("$0.0178 · 모델별 단가");
    expect(html).toContain("88.9%");
    expect(html).toContain("모델 호출 4회");
  });

  it("모델별·세션 종류별·요청별 표를 좁은 화면용 압축 표기로 그린다", () => {
    const html = render(report());

    expect(html).toContain("<table");
    // 최소 너비를 고정하지 않아 390px에서 가로로 넘치지 않는다(토큰 탭과 같은 규칙)
    expect(html).not.toContain("min-w-[");
    expect(html).toContain("sonnet");
    expect(html).toContain("작업 분해 레인");
    expect(html).toContain("주문 목록에 필터를 추가해 줘");
    expect(html).toContain("바꿈");
    expect(html).toContain("가볍게");
  });

  it("줄인 양을 측정과 추정으로 나눠 보여 주고 추정 방식을 함께 적는다", () => {
    const html = render(report());

    expect(html).toContain("측정");
    expect(html).toContain("2,780자");
    expect(html).toContain("추정");
    expect(html).toContain("1,195 토큰");
    expect(html).toContain("캐시 읽기 단가 sonnet");
    expect(html).toContain(TRIM_ESTIMATE_METHOD);
    expect(html).toContain("비용은 공식 단가로 환산한 추정치이며 구독 요금과 다릅니다");
  });

  it("단가가 없으면 비용 자리에 단가 미설정을 적는다", () => {
    const html = render(report({ estimatedCostUsd: undefined, modelCosts: {}, priceSource: "none", priceNote: "단가 미설정" }));

    expect(html).toContain("단가 미설정");
    expect(html).toContain("단가 없음");
    expect(html).not.toContain("$0.0178 · ");
  });

  it("세션이 없는 프로젝트에는 안내를 보여 준다", () => {
    const html = render(report({ sessions: 0, requests: [], kinds: [], usageByModel: {}, totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }));

    expect(html).toContain("이 프로젝트에는 아직 세션이 없습니다");
    expect(html).not.toContain("요청별");
  });

  it("알아둘 점을 함께 보여 준다", () => {
    const html = render(report({ notes: ["시각을 남기지 않은 실행 2개는 기간 필터에서 뺐습니다"] }));

    expect(html).toContain("알아둘 점");
    expect(html).toContain("시각을 남기지 않은 실행 2개는 기간 필터에서 뺐습니다");
  });
});
