/** 세션 모델 우선순위: 세션에서 고른 모델 → `B_STUDIO_GEMINI_MODEL` → 없음(러너가 모델을 요구한다) */
export function resolveGeminiModel(selected: string | undefined, envModel: string | undefined): string | undefined {
  return selected?.trim() || envModel?.trim() || undefined;
}
