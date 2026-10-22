import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentItem } from "@/lib/server/agents-overview";
import { AgentBreakdown, breakdownSummary } from "./agent-breakdown";

// 작업 화면 줄의 에이전트 내역과 범위(#843)

const usage = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

function member(overrides: Partial<AgentItem> = {}): AgentItem {
  return { kind: "session", id: "s1", title: "주문 목록", projectName: "orders", href: "/sessions/s1", state: "working", lastActivityAt: "2026-10-22T01:00:00.000Z", ...overrides };
}

const withAgents = member({
  agents: [
    { id: "main", name: "메인", kind: "main", state: "working", tokens: usage(3000), costUsd: 0.03 },
    { id: "claude:Explore", name: "Explore", kind: "subagent", state: "working", activity: "모델 요청 2회", tokens: usage(1500), costUsd: 0.0054 },
    { id: "claude:Plan", name: "Plan", kind: "subagent", state: "done", activity: "끝남 · 도구 3회", tokens: usage(200) },
  ],
  capabilities: { backend: "claude-code", model: "opus", tools: "cli-default", writeScope: "세션 작업 복사본 전체", permission: "CLI 권한 확인 + 쓰기 직전 관문 + 턴 끝 게이트" },
});

describe("AgentBreakdown", () => {
  it("내역도 범위도 없으면 아무것도 그리지 않는다", () => {
    expect(renderToStaticMarkup(<AgentBreakdown members={[member()]} />)).toBe("");
    expect(breakdownSummary([member()])).toBeUndefined();
  });

  it("요약은 서브에이전트 수와 작업 중인 수", () => {
    expect(breakdownSummary([withAgents])).toBe("서브에이전트 2(작업 중 1)");
    expect(breakdownSummary([member({ agents: [{ id: "main", name: "메인", kind: "main", state: "idle", tokens: usage(10) }] })])).toBe("서브에이전트 없음");
  });

  it("펼치면 에이전트마다 상태·토큰·비용·하는 일, 그리고 할 수 있는 범위가 보인다", () => {
    const html = renderToStaticMarkup(<AgentBreakdown members={[withAgents]} />);
    expect(html).toContain("<details");
    expect(html).toContain("메인");
    expect(html).toContain("Explore");
    expect(html).toContain("1,500");
    expect(html).toContain("$0.0054");
    expect(html).toContain("모델 요청 2회");
    expect(html).toContain("끝남 · 도구 3회");
    expect(html).toContain("CLI 기본 도구");
    expect(html).toContain("세션 작업 복사본 전체");
    expect(html).toContain("CLI 권한 확인 + 쓰기 직전 관문 + 턴 끝 게이트");
  });

  it("허용 도구 목록이 있으면 그 목록을, 여러 구성원이면 구성원마다 제목을 붙인다", () => {
    const listed = member({ id: "s2", title: "레인 2", capabilities: { backend: "codex", tools: ["Read", "Edit"], writeScope: "카드 범위: api/", permission: "b-studio 실행 정책 + 게이트" } });
    const html = renderToStaticMarkup(<AgentBreakdown members={[withAgents, listed]} />);
    expect(html).toContain("Read, Edit");
    expect(html).toContain("레인 2");
    expect(html).toContain("주문 목록");
  });
});
