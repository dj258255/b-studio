// @vitest-environment happy-dom
/** 세션 화면 머리의 이름 붙이기(#875). 저장은 PATCH /api/sessions/{id}, Enter 저장, Esc 취소, 60자 제한, 멈춘 세션은 바꾸지 못한다 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionLabel } from "./session-label";

let root: Root | undefined;

function render(props: Partial<Parameters<typeof SessionLabel>[0]> = {}): HTMLElement {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => root!.render(<SessionLabel sessionId="s1" stopped={false} canManage {...props} />));
  return container;
}

function button(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent === name);
}

function input(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[aria-label="세션 이름"]') as HTMLInputElement;
}

/** React가 값 바뀜을 알도록 원래 setter로 넣고 input 이벤트를 낸다 */
function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(field: HTMLInputElement, key: string) {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("SessionLabel", () => {
  it("이름이 없으면 이름 붙이기 단추만, 있으면 이름과 바꾸기 단추를 보인다", () => {
    expect(button(render(), "세션 이름 붙이기")).toBeDefined();
    document.body.innerHTML = "";
    const named = render({ label: "결제 화면" });
    expect(named.textContent).toContain("결제 화면");
    expect(button(named, "세션 이름 바꾸기")).toBeDefined();
  });

  it("Enter로 PATCH를 보내고, 받은 이름을 보이며 입력 칸을 닫는다", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "s1", label: "결제 화면" }));
    vi.stubGlobal("fetch", fetchMock);
    const container = render();
    act(() => button(container, "세션 이름 붙이기")!.click());
    type(input(container), "  결제 화면 ");
    await press(input(container), "Enter");

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ label: "결제 화면" }) }));
    expect(input(container)).toBeNull();
    expect(container.textContent).toContain("결제 화면");
  });

  it("Esc는 보내지 않고 닫는다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const container = render({ label: "처음" });
    act(() => button(container, "세션 이름 바꾸기")!.click());
    type(input(container), "다른 이름");
    await press(input(container), "Escape");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(input(container)).toBeNull();
    expect(container.textContent).toContain("처음");
  });

  it("60자를 넘으면 알리고 보내지 않는다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const container = render();
    act(() => button(container, "세션 이름 붙이기")!.click());
    type(input(container), "가".repeat(61));
    await press(input(container), "Enter");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("60자까지");
  });

  it("서버가 거절하면 그 까닭을 보이고 입력 칸을 남긴다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "세션이 멈춰 있습니다" }, { status: 409 })));
    const container = render();
    act(() => button(container, "세션 이름 붙이기")!.click());
    type(input(container), "결제 화면");
    await press(input(container), "Enter");

    expect(container.textContent).toContain("세션이 멈춰 있습니다");
    expect(input(container)).not.toBeNull();
  });

  it("멈춘 세션과 바꿀 권한이 없는 사람에게는 단추를 두지 않는다", () => {
    const stopped = render({ label: "결제 화면", stopped: true });
    expect(stopped.textContent).toContain("결제 화면");
    expect(button(stopped, "세션 이름 바꾸기")).toBeUndefined();
    expect(stopped.querySelector('[title="이어서 작업한 뒤 바꿀 수 있습니다"]')).not.toBeNull();
    document.body.innerHTML = "";
    expect(button(render({ canManage: false }), "세션 이름 붙이기")).toBeUndefined();
  });
});
