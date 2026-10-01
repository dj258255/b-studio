// @vitest-environment happy-dom
/**
 * 샌드박스가 뜨는 중에도 대화 입력창이 쓴 글을 지키는지 본다(도그푸딩 72번).
 *
 * chat-panel.test.tsx의 나머지 테스트는 renderToStaticMarkup으로 마크업만 보지만, 이 파일은 "타이핑 → 상태 변화
 * → 다시 그리기"를 거쳐도 글이 남는지까지 봐야 해서 실제 DOM에 올려(happy-dom) act로 업데이트한다.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createView, type SessionView } from "@/lib/session-view";
import type { SessionSnapshot } from "@/lib/studio-events";
import { ChatPanel } from "./chat-panel";
import { SessionAccessProvider } from "./session-access";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined, push: () => undefined }) }));

const booting: SessionSnapshot = {
  id: "s1",
  projectId: "orders",
  projectName: "orders",
  workDir: "/tmp/orders-s1",
  status: "starting",
  mode: "api",
  running: false,
  checkpoints: [],
  services: [{ name: "web", template: "nextjs", preview: "browser", state: "starting", hasContract: false }],
};

function mount(initial: SessionView): { container: HTMLElement; root: Root } {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  act(() => {
    root.render(
      <SessionAccessProvider value={{ canManage: true, canLogout: false }}>
        <ChatPanel view={initial} />
      </SessionAccessProvider>,
    );
  });
  return { container, root };
}

function rerender(root: Root, next: SessionView): void {
  act(() => {
    root.render(
      <SessionAccessProvider value={{ canManage: true, canLogout: false }}>
        <ChatPanel view={next} />
      </SessionAccessProvider>,
    );
  });
}

/** React가 추적하는 value 세터를 거쳐야 실제 타이핑처럼 onChange가 울린다(그냥 .value = 는 React가 무시한다) */
function typeInto(textarea: HTMLTextAreaElement, text: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function sendButton(container: HTMLElement): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((button) => button.type === "submit")!;
}

describe("대화 입력창 — 샌드박스가 뜨는 중에도 쓴 글 지키기", () => {
  beforeEach(() => {
    // 사용량·모델 선택을 불러오는 배경 fetch가 실제 네트워크를 타지 않게 막는다(:3000 서버 없이 테스트한다)
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("테스트에는 네트워크가 없습니다"))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("부팅 중에도 입력창은 비활성화되지 않아 타이핑한 글이 사라지지 않는다", () => {
    const { container } = mount(createView(booting));
    const textarea = container.querySelector("textarea")!;

    expect(textarea.disabled).toBe(false);
    typeInto(textarea, "주문 목록에 필터를 추가해줘");
    expect(textarea.value).toBe("주문 목록에 필터를 추가해줘");
  });

  it("부팅 중에는 보내기가 막히고 버튼 옆에 짧은 안내가 보인다", () => {
    const { container } = mount(createView(booting));
    typeInto(container.querySelector("textarea")!, "주문 목록에 필터를 추가해줘");

    expect(sendButton(container).disabled).toBe(true);
    expect(container.textContent).toContain("샌드박스가 준비되면 보낼 수 있습니다");
  });

  it("샌드박스가 준비되면 안내가 사라지고 보내기를 할 수 있으며, 그사이 쓴 글은 그대로 남는다", () => {
    const { container, root } = mount(createView(booting));
    typeInto(container.querySelector("textarea")!, "주문 목록에 필터를 추가해줘");

    rerender(root, createView({ ...booting, status: "ready" }));

    expect(container.querySelector("textarea")!.value).toBe("주문 목록에 필터를 추가해줘");
    expect(container.textContent).not.toContain("샌드박스가 준비되면 보낼 수 있습니다");
    expect(sendButton(container).disabled).toBe(false);
  });
});
