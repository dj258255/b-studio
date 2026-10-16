// @vitest-environment happy-dom
/**
 * 좁은 화면에서 위 탭이 넘칠 때의 단서(가장자리 흐림)와 누르는 자리 크기, 메뉴 표면이 불투명한지를 본다.
 * 실제 레이아웃 폭은 happy-dom이 계산하지 않으므로 scrollWidth·clientWidth는 직접 정해 준다.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createView } from "@/lib/session-view";
import type { SessionSnapshot } from "@/lib/studio-events";
import { PreviewPanel } from "./preview-panel";
import { ProjectMenu } from "./project-menu";
import { SupportingServicesChip } from "./supporting-services-chip";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined, push: () => undefined }), usePathname: () => "/" }));

const snapshot: SessionSnapshot = {
  id: "s1",
  projectId: "orders",
  projectName: "orders",
  workDir: "/tmp/orders-s1",
  status: "ready",
  mode: "demo",
  running: false,
  checkpoints: [],
  services: [
    { name: "web", template: "next", preview: "browser", state: "ready", hasContract: false },
    { name: "api", template: "fastify", preview: "openapi", state: "ready", hasContract: false },
  ],
};

// 패널이 마운트되며 부르는 API는 응답하지 않는 fetch로 막는다(실제 서버로 나가지 않게)
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
});

let mounted: { root: Root; container: HTMLElement } | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.root.unmount());
  mounted?.container.remove();
  mounted = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function mount(element: React.ReactElement): HTMLElement {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  act(() => root.render(element));
  mounted = { root, container };
  return container;
}

describe("세션 위 탭", () => {
  it("탭 막대는 넘칠 때 가장자리 단서를 두는 유틸리티를 쓰고, 탭은 누르는 자리 크기를 지킨다", () => {
    const html = renderToStaticMarkup(<PreviewPanel view={createView(snapshot)} />);
    expect(html).toMatch(/role="tablist" aria-label="미리보기 대상" class="[^"]*\bscroll-fade-x\b/);
    const tabs = [...html.matchAll(/<button role="tab"[^>]*class="([^"]*)"/g)].map((match) => match[1]!);
    expect(tabs.length).toBeGreaterThanOrEqual(6);
    for (const className of tabs) expect(className).toMatch(/\btap-target\b/);
  });

  it("넘칠 때 뒤쪽 가장자리를 흐리고, 끝까지 넘기면 앞쪽으로 옮긴다", () => {
    const container = mount(<PreviewPanel view={createView(snapshot)} />);
    const tablist = container.querySelector<HTMLElement>('[aria-label="미리보기 대상"]')!;
    Object.defineProperty(tablist, "scrollWidth", { configurable: true, value: 455 });
    Object.defineProperty(tablist, "clientWidth", { configurable: true, value: 366 });
    act(() => window.dispatchEvent(new Event("resize")));
    expect(tablist.dataset.fade).toBe("end");

    tablist.scrollLeft = 89;
    act(() => tablist.dispatchEvent(new Event("scroll")));
    expect(tablist.dataset.fade).toBe("start");
  });

  it("화면 밖의 탭을 고르면 그 탭이 보이도록 막대를 넘긴다", () => {
    const container = mount(<PreviewPanel view={createView(snapshot)} />);
    const tablist = container.querySelector<HTMLElement>('[aria-label="미리보기 대상"]')!;
    Object.defineProperty(tablist, "scrollWidth", { configurable: true, value: 455 });
    Object.defineProperty(tablist, "clientWidth", { configurable: true, value: 366 });
    tablist.getBoundingClientRect = () => ({ left: 0, right: 366, top: 0, bottom: 44, width: 366, height: 44, x: 0, y: 0, toJSON: () => ({}) });
    const last = [...tablist.querySelectorAll<HTMLElement>('[role="tab"]')].at(-1)!;
    last.getBoundingClientRect = () => ({ left: 390, right: 451, top: 0, bottom: 44, width: 61, height: 44, x: 390, y: 0, toJSON: () => ({}) });

    act(() => last.click());
    expect(last.getAttribute("aria-selected")).toBe("true");
    expect(tablist.scrollLeft).toBe(89);
  });
});

describe("헤더 메뉴", () => {
  it("서비스 칩은 누르는 자리 크기를 지킨다", () => {
    const html = renderToStaticMarkup(<SupportingServicesChip sessionId="s1" services={[]} />);
    expect(html).toMatch(/aria-haspopup="menu"[^>]*class="[^"]*\btap-target\b/);
  });

  it("서비스 메뉴와 프로젝트 메뉴는 뒤가 비치지 않는 불투명 표면을 쓴다", () => {
    const services = mount(<SupportingServicesChip sessionId="s1" services={[]} />);
    act(() => services.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
    const servicesMenu = document.querySelector<HTMLElement>('[role="menu"][aria-label="서비스 켜고 끄기"]')!;
    expect(servicesMenu.className).toMatch(/\bmenu-surface\b/);
    expect(servicesMenu.className).not.toMatch(/\bglass\b/);
    act(() => mounted!.root.unmount());
    mounted = undefined;

    const project = mount(<ProjectMenu projectId="orders" projectName="orders" />);
    act(() => project.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
    const projectMenu = document.querySelector<HTMLElement>('[role="menu"][aria-label="프로젝트 메뉴"]')!;
    expect(projectMenu.className).toMatch(/\bmenu-surface\b/);
    expect(projectMenu.className).not.toMatch(/\bglass\b/);
  });
});
