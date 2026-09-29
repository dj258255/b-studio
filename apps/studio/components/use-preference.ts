"use client";

import { useSyncExternalStore } from "react";

/**
 * 세션별 불리언 스위치를 저장소(localStorage)에 기억한다. "읽기만"·"가볍게 확인"이 같은 규칙을 쓴다.
 *
 * 저장값을 효과 안에서 setState하지 않고 반영하려고 useSyncExternalStore를 쓴다(서버 렌더는 꺼짐).
 * 저장소를 못 쓰는 환경(사생활 보호 모드 등)에서도 꺼진 채로 동작한다.
 */
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const listeners = new Set<() => void>();
/** 저장 키 → 지금 화면이 아는 값. 저장소를 매 렌더마다 읽지 않게 한다 */
const cache = new Map<string, boolean>();

function browserStorage(): PreferenceStorage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

function snapshot(key: string, read: (storage: PreferenceStorage | undefined) => boolean): boolean {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = read(browserStorage());
  cache.set(key, value);
  return value;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** [켜졌는가, 바꾸는 함수]. read·store는 저장소를 못 쓸 때도 예외를 내지 않아야 한다 */
export function usePreference(
  key: string,
  read: (storage: PreferenceStorage | undefined) => boolean,
  store: (storage: PreferenceStorage | undefined, value: boolean) => void,
): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => snapshot(key, read),
    () => false,
  );

  function set(next: boolean): void {
    cache.set(key, next);
    store(browserStorage(), next);
    for (const listener of listeners) listener();
  }

  return [value, set];
}
