"use client";

import { useSyncExternalStore } from "react";
import { readReadOnly, storeReadOnly } from "@/lib/read-only-preference";

/**
 * 대화 입력창의 "읽기만" 스위치(세션마다 기억).
 *
 * 저장값을 효과 안에서 setState하지 않고 반영하려고 useSyncExternalStore를 쓴다(서버 렌더는 꺼짐).
 * 저장소를 못 쓰는 환경에서도 꺼진 채로 동작한다.
 */
const listeners = new Set<() => void>();
/** 세션 id → 지금 화면이 아는 값. 저장소를 매 렌더마다 읽지 않게 한다 */
const cache = new Map<string, boolean>();

function storage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

function snapshot(sessionId: string): boolean {
  const cached = cache.get(sessionId);
  if (cached !== undefined) return cached;
  const value = readReadOnly(storage(), sessionId);
  cache.set(sessionId, value);
  return value;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** [읽기만인가, 바꾸는 함수] */
export function useReadOnly(sessionId: string): [boolean, (next: boolean) => void] {
  const readOnly = useSyncExternalStore(subscribe, () => snapshot(sessionId), () => false);

  function set(next: boolean): void {
    cache.set(sessionId, next);
    storeReadOnly(storage(), sessionId, next);
    for (const listener of listeners) listener();
  }

  return [readOnly, set];
}
