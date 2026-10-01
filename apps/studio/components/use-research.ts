"use client";

import { readResearch, researchKey, storeResearch } from "@/lib/research-preference";
import { usePreference } from "./use-preference";

/**
 * 대화 입력창의 "조사" 스위치(세션마다 기억).
 *
 * "읽기만"이 켜졌을 때만 화면에 보인다("가볍게 확인"과 같은 자리 규칙) — 켜면 질문이 웹에서 찾아 답하라는
 * 조사 모드로 간다. "읽기만"이 꺼지면 화면에서 숨기지만 값은 세션마다 그대로 기억한다.
 */
export function useResearch(sessionId: string): [boolean, (next: boolean) => void] {
  return usePreference(
    researchKey(sessionId),
    (storage) => readResearch(storage, sessionId),
    (storage, value) => storeResearch(storage, sessionId, value),
  );
}
