// @vitest-environment happy-dom
/** 로그아웃 요청이 실패하면 로그인 화면으로 넘기지 않고 알린다. 쿠키는 HttpOnly라 화면이 지울 수 없어, 넘기면 세션이 살아 있는데 로그아웃된 것처럼 보인다 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { LogoutButton } from "./logout-button";

async function clickWith(response: () => Promise<Response>): Promise<HTMLElement> {
  vi.stubGlobal("fetch", vi.fn(response));
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  act(() => root.render(<LogoutButton />));
  await act(async () => {
    container.querySelector("button")!.click();
  });
  return container;
}

afterEach(() => {
  vi.unstubAllGlobals();
  router.replace.mockReset();
  router.refresh.mockReset();
  document.body.innerHTML = "";
});

describe("LogoutButton", () => {
  it("로그아웃이 되면 로그인 화면으로 간다", async () => {
    await clickWith(async () => new Response(null, { status: 200 }));
    expect(router.replace).toHaveBeenCalledWith("/login");
  });

  it("서버가 실패하거나 요청이 끊기면 넘기지 않고 로그아웃하지 못했다고 알린다", async () => {
    for (const response of [async () => new Response(null, { status: 500 }), async () => Promise.reject(new TypeError("network"))]) {
      const container = await clickWith(response);
      expect(router.replace).not.toHaveBeenCalled();
      expect(container.textContent).toContain("로그아웃하지 못했습니다");
      expect(container.querySelector("button")!.disabled).toBe(false);
      document.body.innerHTML = "";
    }
  });
});
