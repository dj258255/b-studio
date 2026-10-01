/**
 * 대화 입력창의 "조사" 스위치를 세션마다 기억한다(ADR-0XX).
 *
 * "읽기만"이 켜졌을 때만 뜻이 있다 — 켜면 질문에 웹에서 찾아 답하라는 안내를 더 붙이고,
 * claude-code 백엔드면 이번 턴 WebSearch·WebFetch를 실제로 연다(다른 백엔드는 모델 지식으로만 답한다).
 * 저장소를 못 쓰는 환경에서도 화면은 동작해야 하므로 실패는 무시하고 꺼진 것으로 본다.
 */
export function researchKey(sessionId: string): string {
  return `b-studio:research:${sessionId}`;
}

/** 이 세션의 스위치 상태. 저장된 값이 없거나 못 읽으면 꺼짐 */
export function readResearch(storage: Pick<Storage, 'getItem'> | undefined, sessionId: string): boolean {
  try {
    return storage?.getItem(researchKey(sessionId)) === 'on';
  } catch {
    return false;
  }
}

/** 스위치 상태를 저장한다. 저장에 실패해도 이번 화면은 그대로 동작한다 */
export function storeResearch(storage: Pick<Storage, 'setItem'> | undefined, sessionId: string, value: boolean): void {
  try {
    storage?.setItem(researchKey(sessionId), value ? 'on' : 'off');
  } catch {
    return;
  }
}
