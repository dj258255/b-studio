import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BackendRulesView } from "@/lib/backend-rules";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

import { previewLine, RoutingLauncher } from "./routing-launcher";

const view: BackendRulesView = {
  rules: { rules: [{ when: { risk: "high" }, backend: "claude-code", model: "opus" }], fallback: { backend: "codex" } },
  allowed: ["claude-code", "codex"],
  defaultBackend: "claude-code",
};

describe("RoutingLauncher(#822)", () => {
  it("프로젝트 고르기, 요청 입력, 규칙 수를 보인다", () => {
    const html = renderToStaticMarkup(<RoutingLauncher projects={[{ id: "orders", name: "주문" }, { id: "board", name: "게시판" }]} initial={view} />);
    expect(html).toContain("주문");
    expect(html).toContain("게시판");
    expect(html).toContain("<textarea");
    expect(html).toContain("규칙 고치기(1개)");
    expect(html).toContain("요청을 쓰면 어느 AI로 갈지 여기 보입니다");
  });

  it("저장한 규칙을 쓰지 못했으면 그 까닭을 보인다", () => {
    const html = renderToStaticMarkup(<RoutingLauncher projects={[{ id: "orders", name: "주문" }]} initial={{ ...view, error: "저장한 규칙을 쓰지 못해 규칙 없이 고릅니다: 규칙 1: …" }} />);
    expect(html).toContain("저장한 규칙을 쓰지 못해 규칙 없이 고릅니다");
  });

  it("프로젝트가 없으면 입력 대신 안내를 보인다", () => {
    const html = renderToStaticMarkup(<RoutingLauncher projects={[]} initial={view} />);
    expect(html).toContain("프로젝트를 먼저 열면");
    expect(html).not.toContain("<textarea");
  });
});

describe("previewLine", () => {
  it("어느 AI로, 어느 규칙 때문에 가는지 한 줄로 적는다", () => {
    expect(previewLine({ backend: "claude-code", model: "opus", rule: 0, matched: "위험", kind: { complexity: "simple", risk: "high" } })).toBe("로컬 Claude Agent (opus)로 보냅니다 · 규칙 1(위험) · 작업 종류 단순 · 위험");
    expect(previewLine({ backend: "codex", rule: "fallback", matched: "기본값", kind: { complexity: "normal", risk: "normal" } })).toBe("로컬 ChatGPT Agent로 보냅니다 · 맞는 규칙이 없어 기본값 · 작업 종류 보통");
    expect(previewLine({ backend: "claude-code", rule: "default", matched: "맞는 규칙 없음", kind: { complexity: "simple", risk: "normal" } })).toContain("서버 기본 AI");
  });
});
