"use client";

import { readReadOnly, readOnlyKey, storeReadOnly } from "@/lib/read-only-preference";
import { usePreference } from "./use-preference";

/**
 * 대화 입력창의 "읽기만" 스위치(세션마다 기억).
 *
 * 켜면 질문 경로(intent `ask`, 읽기 전용 도구)로 보내고, 끄면 만들기 경로로 보낸다.
 */
export function useReadOnly(sessionId: string): [boolean, (next: boolean) => void] {
  return usePreference(
    readOnlyKey(sessionId),
    (storage) => readReadOnly(storage, sessionId),
    (storage, value) => storeReadOnly(storage, sessionId, value),
  );
}
