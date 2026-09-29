"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 899px)";

function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** 900px 미만이면 참. 서버 렌더는 넓은 화면으로 보고(getServerSnapshot), 마운트된 뒤 실제 폭에 맞춘다(나란히 보기 좁은 화면 대응) */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
