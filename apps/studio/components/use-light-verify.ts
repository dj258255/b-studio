"use client";

import { lightVerifyKey, readLightVerify, storeLightVerify } from "@/lib/light-verify-preference";
import { usePreference } from "./use-preference";

/**
 * 대화 입력창의 "가볍게 확인" 스위치(세션마다 기억).
 *
 * 켜면 검증 게이트가 재시작·준비 판정·계약만 돌리고 테스트·화면 확인·리뷰는 건너뛴다.
 * "읽기만"이 켜지면 화면에서 숨기지만, 값은 세션마다 그대로 기억한다.
 */
export function useLightVerify(sessionId: string): [boolean, (next: boolean) => void] {
  return usePreference(
    lightVerifyKey(sessionId),
    (storage) => readLightVerify(storage, sessionId),
    (storage, value) => storeLightVerify(storage, sessionId, value),
  );
}
