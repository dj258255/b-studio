"use client";

import { useSyncExternalStore } from "react";

/**
 * 데스크톱 앱(apps/desktop)이 스튜디오 화면에 여는 좁은 통로(ADR-085). 브라우저에서 그냥 열면 없다(undefined) —
 * 화면은 이 값의 있고 없음만으로 "OS 폴더 선택 창을 쓸 수 있는가"를 판단한다(따로 서버에 묻지 않는다).
 */
export interface DesktopBridge {
  /** OS 기본 폴더 선택 창을 띄운다. 취소하면 undefined */
  pickFolder(): Promise<string | undefined>;
}

declare global {
  interface Window {
    bStudioDesktop?: DesktopBridge;
  }
}

/** SSR(window 없음)에서도 안전하게 부를 수 있는 접근자 */
export function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.bStudioDesktop;
}

const noSubscription = () => () => undefined;

/**
 * "데스크톱 앱에서 열었는가"를 효과 안에서 setState하지 않고 읽는다(`preview-panel.tsx`의 QA 자동 전환 설정과
 * 같은 방법, `useSyncExternalStore`). 페이지가 떠 있는 동안 이 값은 바뀌지 않으므로 구독은 아무 일도 하지 않는다.
 * 서버 렌더는 항상 없음(false)으로 본다 — 데스크톱 판단은 마운트 뒤 클라이언트에서만 가능하다
 */
export function useHasDesktopBridge(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => Boolean(desktopBridge()?.pickFolder),
    () => false,
  );
}
