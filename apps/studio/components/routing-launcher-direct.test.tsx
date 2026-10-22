// @vitest-environment happy-dom
/** 새 요청 칸(#827): 미리보기 아래에 같은 종류의 AI별 기록을 보이고, "이번만 다른 AI로"를 고르면 규칙 대신 그 AI로 보낸다 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendRulesView } from "@/lib/backend-rules";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { RoutingLauncher } from "./routing-launcher";

const view: BackendRulesView = { rules: { rules: [{ when: {}, backend: "claude-code" }] }, allowed: ["claude-code", "codex"], defaultBackend: "claude-code" };

function setValue(element: HTMLTextAreaElement | HTMLSelectElement | HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(element) as object;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  router.push.mockReset();
  document.body.innerHTML = "";
});

describe("RoutingLauncher 직접 고름과 기록", () => {
  it("미리보기 아래에 기록을 보이고, 고른 AI로 route: direct를 보낸다", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        if (url === "/api/routing/preview") {
          return Response.json({ backend: "claude-code", rule: 0, matched: "상관없음", kind: { complexity: "simple", risk: "high" }, records: [{ backend: "codex", passed: 4, judged: 5 }] });
        }
        return Response.json({ session: { id: "s9" }, routing: { backend: "codex", rule: "direct" } }, { status: 201 });
      }),
    );
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    act(() => root.render(<RoutingLauncher projects={[{ id: "orders", name: "주문" }]} initial={view} />));

    act(() => setValue(container.querySelector("textarea")!, "결제 화면 고쳐 줘"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(container.textContent).toContain("같은 종류의 기록: 로컬 ChatGPT Agent 통과 4/5");

    act(() => setValue(container.querySelector<HTMLSelectElement>('select[aria-label="보낼 AI"]')!, "codex"));
    expect(container.textContent).toContain("로컬 ChatGPT Agent로 보냅니다 · 이번만 직접 고름");
    act(() => setValue(container.querySelector<HTMLInputElement>('input[aria-label="보낼 모델"]')!, "gpt-5.5"));
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "보내기")!.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(calls.find((call) => call.url === "/api/sessions")?.body).toEqual({ projectId: "orders", route: "direct", backend: "codex", model: "gpt-5.5", request: "결제 화면 고쳐 줘", intent: "build" });
    expect(router.push).toHaveBeenCalledWith("/sessions/s9");
  });

  it("규칙대로면 지금처럼 route: rules를 보낸다", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Response.json({ session: { id: "s1" } }, { status: 201 });
      }),
    );
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    act(() => root.render(<RoutingLauncher projects={[{ id: "orders", name: "주문" }]} initial={view} />));
    act(() => setValue(container.querySelector("textarea")!, "고쳐 줘"));
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "보내기")!.click();
    });
    expect(calls.find((call) => call.url === "/api/sessions")?.body).toEqual({ projectId: "orders", route: "rules", request: "고쳐 줘", intent: "build" });
  });

  it("터미널을 쓸 수 있으면 '터미널로'를 보이고, 고르면 terminal: true를 보낸다. 쓸 수 없으면 선택지가 없다(#836)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Response.json({ session: { id: "s3" }, terminal: { opened: true, pasted: true } }, { status: 201 });
      }),
    );
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    act(() => root.render(<RoutingLauncher projects={[{ id: "orders", name: "주문" }]} initial={view} />));
    expect(container.querySelector('input[aria-label="터미널로"]')).toBeNull();

    act(() => root.render(<RoutingLauncher projects={[{ id: "orders", name: "주문" }]} initial={view} terminalAllowed />));
    act(() => container.querySelector<HTMLInputElement>('input[aria-label="터미널로"]')!.click());
    act(() => setValue(container.querySelector("textarea")!, "고쳐 줘"));
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "보내기")!.click();
    });
    expect(calls.find((call) => call.url === "/api/sessions")?.body).toEqual({ projectId: "orders", route: "rules", request: "고쳐 줘", intent: "build", terminal: true });
    expect(router.push).toHaveBeenCalledWith("/sessions/s3");
  });
});
