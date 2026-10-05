/**
 * 스튜디오의 Gemini 모델 선택 — opencode-models.ts와 달리 CLI가 모델 목록을 내려주는 명령을 확인하지 못했다
 * (`gemini-cli-runner.ts`의 0단계 조사 참고). 그래서 캐시된 목록을 만들지 않고, 세션 모델 id를 어디서 가져올지
 * 우선순위만 정한다. 모델 id 형식 검증도 하지 않는다 — Gemini 모델 이름이 자주 바뀌어(2.5 → 3.x) 고정된 정규식이
 * 금방 틀어질 수 있다.
 */

/** 지금 실행 모드가 gemini인지. 라우트의 사용자 입력 검증에만 쓴다 */
export function geminiMode(env: Record<string, string | undefined> = process.env): boolean {
  return (env.B_STUDIO_MODE?.trim() || 'api') === 'gemini';
}

/** 세션 모델 우선순위: 세션에서 고른 모델 → `B_STUDIO_GEMINI_MODEL` → 없음(러너가 모델을 요구한다) */
export function resolveGeminiModel(selected: string | undefined, envModel: string | undefined): string | undefined {
  return selected?.trim() || envModel?.trim() || undefined;
}
