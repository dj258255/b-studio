"use client";

import { useSyncExternalStore } from "react";
import { defaultSubTab, readSubTab, type SubTabGroup, type SubTabOption, writeSubTab } from "@/lib/tab-model";

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

/**
 * options가 있고 캐시값이 그 목록에 없으면(조건이 바뀌어 하위 탭이 숨겨진 경우, 예: 배포 절이 없어진 프로젝트)
 * 다시 읽어 첫 하위 탭으로 돌아간다 — 그러지 않으면 "배포"가 화면에서 사라져도 캐시에는 여전히 남는다
 */
function snapshot(group: SubTabGroup, options?: readonly SubTabOption[]): string {
  const cached = cache.get(group);
  if (cached !== undefined && (!options || options.some((option) => option.id === cached))) return cached;
  const value = readSubTab(browserStorage(), group, options);
  cache.set(group, value);
  return value;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * [지금 하위 탭 id, 바꾸는 함수]. options를 주면 그 묶음이 보일 수 있는 하위 탭을 좁힌다(실행 탭의 "배포"처럼
 * studio.yaml 설정에 따라 조건부로 숨는 하위 탭을 다루기 위함). 생략하면 묶음의 정적 전체 목록을 쓴다
 */
export function useSubTab(group: SubTabGroup, options?: readonly SubTabOption[]): [string, (next: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => snapshot(group, options),
    () => defaultSubTab(group, options),
  );

  function set(next: string): void {
    cache.set(group, next);
    writeSubTab(browserStorage(), group, next);
    for (const listener of listeners) listener();
  }

  return [value, set];
}
