"use client";

import { type RefObject, useEffect } from "react";
import { revealScrollLeft, scrollFade } from "@/lib/scroll-edges";

/** globals.css의 scroll-fade-x가 흐리는 폭(1.5rem)과 맞춘다. 고른 탭이 흐린 자리에 걸치지 않게 이만큼 더 넘긴다 */
const FADE_PX = 24;

/**
 * 가로로 넘치는 탭 막대(scroll-fade-x)에 어느 가장자리가 가려졌는지 data-fade로 알리고, 고른 탭이 화면 밖이면 보이도록 넘긴다.
 * 속성은 DOM에 바로 쓴다(넘길 때마다 다시 그리지 않는다). activeKey가 바뀔 때만 넘기므로 사용자가 직접 넘긴 자리는 지킨다
 */
function applyFade(element: HTMLElement): void {
  const fade = scrollFade(element);
  if (fade) element.dataset.fade = fade;
  else delete element.dataset.fade;
}

export function useScrollFade(ref: RefObject<HTMLElement | null>, activeKey: string, contentKey: string): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => applyFade(element);
    update();
    element.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [ref, contentKey]);

  useEffect(() => {
    const element = ref.current;
    const active = element?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!element || !active) return;
    const box = element.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    const start = tab.left - box.left + element.scrollLeft;
    const next = revealScrollLeft(element, { start, end: start + tab.width }, FADE_PX);
    if (next === undefined) return;
    element.scrollLeft = next;
    // 프로그램으로 넘긴 뒤 scroll 이벤트를 기다리지 않고 바로 다시 잰다
    applyFade(element);
  }, [ref, activeKey]);
}
