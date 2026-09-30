"use client";

import { useSyncExternalStore } from "react";
import { defaultSubTab, readSubTab, type SubTabGroup, writeSubTab } from "@/lib/tab-model";

/**
 * 개발 화면 탭 묶음(코드·요구사항·실행·저장소)이 마지막으로 본 하위 탭을 localStorage에 기억한다.
 * usePreference(use-preference.ts)와 같은 이유로 useSyncExternalStore를 쓴다: 저장값을 효과 안에서
 * setState하지 않고 반영하고, 서버 렌더는 항상 첫 하위 탭으로 일관되게 그린다.
 */
const listeners = new Set<() => void>();
/** 묶음 → 지금 화면이 아는 하위 탭. 저장소를 매 렌더마다 읽지 않게 한다 */
const cache = new Map<SubTabGroup, string>();

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

function snapshot(group: SubTabGroup): string {
  const cached = cache.get(group);
  if (cached !== undefined) return cached;
  const value = readSubTab(browserStorage(), group);
  cache.set(group, value);
  return value;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** [지금 하위 탭 id, 바꾸는 함수] */
export function useSubTab(group: SubTabGroup): [string, (next: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => snapshot(group),
    () => defaultSubTab(group),
  );

  function set(next: string): void {
    cache.set(group, next);
    writeSubTab(browserStorage(), group, next);
    for (const listener of listeners) listener();
  }

  return [value, set];
}
