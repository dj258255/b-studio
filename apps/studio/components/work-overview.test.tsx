import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentItem, AgentTotals } from "@/lib/server/agents-overview";
import { WorkOverview } from "./work-overview";

// 나란히 보기로 옮기는 라우터는 서버 렌더에 컨텍스트가 없다. 화면 마크업만 보므로 빈 구현으로 바꾼다
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

function item(overrides: Partial<AgentItem> & Pick<AgentItem, "id">): AgentItem {
  return {
    kind: "session",
    title: "주문 목록 API와 화면을 만들어줘",
    projectName: "orders",
    href: `/sessions/${overrides.id}`,
    state: "idle",
    lastActivityAt: "2026-09-30T01:00:00.000Z",
    ...overrides,
  };
}

const totals: AgentTotals = { total: 0, attention: 0, working: 0, tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };

function render(items: AgentItem[]): string {
  return renderToStaticMarkup(<WorkOverview initial={{ items, totals: { ...totals, total: items.length } }} />);
}

describe("WorkOverview의 지우기 동작", () => {
  it("중지된 세션은 지우기 버튼을 그대로 눌러 지울 수 있게 둔다", () => {
    const html = render([item({ id: "s1", state: "stopped" })]);

    expect(html).toContain(">지우기<");
    expect(html).not.toMatch(/지우기[^>]*disabled/);
  });

  it("작업 중인 세션은 지우기 버튼을 잠그고 이유를 안내한다", () => {
    const html = render([item({ id: "s1", state: "working" })]);

    expect(html).toMatch(/<button[^>]*disabled[^>]*title="세션이 아직 실행 중입니다[^>]*>\s*지우기/);
  });

  it("여러 명 비교는 구성원 하나라도 작업 중이면 묶음 지우기를 잠근다", () => {
    const fleet = { kind: "fleet" as const, id: "f1", href: "/fleets?id=f1" };
    const html = render([
      item({ id: "m1", kind: "fleet", group: fleet, state: "working" }),
      item({ id: "m2", kind: "fleet", group: fleet, state: "stopped" }),
    ]);

    expect(html).toMatch(/<button[^>]*disabled[^>]*title="진행 중인 참가자가 있습니다[^>]*>\s*지우기/);
  });

  it("여러 명 비교는 작업 중인 구성원이 없으면(실패·중지뿐이면) 지울 수 있게 둔다", () => {
    const fleet = { kind: "fleet" as const, id: "f1", href: "/fleets?id=f1" };
    const html = render([
      item({ id: "m1", kind: "fleet", group: fleet, state: "error" }),
      item({ id: "m2", kind: "fleet", group: fleet, state: "stopped" }),
    ]);

    expect(html).not.toMatch(/지우기[^>]*disabled/);
  });
});
