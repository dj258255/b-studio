/**
 * 대화 입력창의 "가볍게 확인" 스위치를 세션마다 기억한다.
 *
 * 켜면 검증 게이트가 서비스 재시작·준비 판정·계약만 돌리고 테스트·화면 확인·리뷰는 건너뛴다.
 * 건너뛴 단계는 통과 기록에 없어 배포 조건(releaseRequires)이 그대로 막으므로, 빠른 확인용이다.
 * 저장소를 못 쓰는 환경에서도 화면은 동작해야 하므로 실패는 무시하고 꺼진 것으로 본다.
 */
export function lightVerifyKey(sessionId: string): string {
  return `b-studio:light-verify:${sessionId}`;
}

/** 이 세션의 스위치 상태. 저장된 값이 없거나 못 읽으면 꺼짐(full) */
export function readLightVerify(storage: Pick<Storage, 'getItem'> | undefined, sessionId: string): boolean {
  try {
    return storage?.getItem(lightVerifyKey(sessionId)) === 'on';
  } catch {
    return false;
  }
}

/** 스위치 상태를 저장한다. 저장에 실패해도 이번 화면은 그대로 동작한다 */
export function storeLightVerify(storage: Pick<Storage, 'setItem'> | undefined, sessionId: string, value: boolean): void {
  try {
    storage?.setItem(lightVerifyKey(sessionId), value ? 'on' : 'off');
  } catch {
    return;
  }
}
