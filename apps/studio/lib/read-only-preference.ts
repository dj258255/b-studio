/**
 * 대화 입력창의 "읽기만" 스위치를 세션마다 기억한다.
 *
 * 켜면 지금의 질문 경로(intent `ask`, 읽기 전용 도구)로 보내고, 끄면 만들기 경로로 보낸다.
 * 저장소를 못 쓰는 환경(사생활 보호 모드 등)에서도 화면은 동작해야 하므로 실패는 무시하고 꺼진 것으로 본다.
 */
export function readOnlyKey(sessionId: string): string {
  return `b-studio:read-only:${sessionId}`;
}

/** 이 세션의 스위치 상태. 저장된 값이 없거나 못 읽으면 꺼짐 */
export function readReadOnly(storage: Pick<Storage, 'getItem'> | undefined, sessionId: string): boolean {
  try {
    return storage?.getItem(readOnlyKey(sessionId)) === 'on';
  } catch {
    return false;
  }
}

/** 스위치 상태를 저장한다. 저장에 실패해도 이번 화면은 그대로 동작한다 */
export function storeReadOnly(storage: Pick<Storage, 'setItem'> | undefined, sessionId: string, value: boolean): void {
  try {
    storage?.setItem(readOnlyKey(sessionId), value ? 'on' : 'off');
  } catch {
    return;
  }
}
