// @vitest-environment happy-dom
/** 새 요청을 터미널로 보냈는데 첫 요청을 넣지 못한 까닭을 세션 화면에 한 번 보인다(#849) */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LaunchNotice, rememberLaunchNotice } from "./launch-notice";

afterEach(() => {
  document.body.innerHTML = "";
  window.sessionStorage.clear();
});

describe("LaunchNotice", () => {
  it("넘겨받은 까닭을 한 번 보이고, 닫으면 사라진다. 다시 그려도 또 보이지 않는다", () => {
    rememberLaunchNotice("s1", "터미널은 열었지만 첫 요청을 넣지 못했습니다: 까닭");
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    act(() => root.render(<LaunchNotice sessionId="s1" />));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("첫 요청을 넣지 못했습니다: 까닭");
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="안내 닫기"]')!.click());
    expect(container.querySelector('[role="status"]')).toBeNull();

    act(() => root.unmount());
    const again = createRoot(container);
    act(() => again.render(<LaunchNotice sessionId="s1" />));
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("다른 세션의 안내는 보이지 않는다", () => {
    rememberLaunchNotice("s2", "다른 세션");
    const container = document.body.appendChild(document.createElement("div"));
    act(() => createRoot(container).render(<LaunchNotice sessionId="s1" />));
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
