/**
 * 에이전트가 알린 요청과 확인(테스트)의 어긋남(#666)을 사람이 읽는 말로 바꾼다. 화면(대화·작업·계획)이 같은 문구를 쓴다.
 * 서버 모듈을 가져오지 않는다(브라우저 번들에 들어간다).
 */
import type { RequestMismatch } from '@b-studio/agent';

export const MISMATCH_FOLLOWED_LABEL: Record<RequestMismatch['followed'], string> = {
  request: '요청을 따름',
  check: '확인을 따름',
  neither: '어느 쪽도 맞추지 못함',
};

/** 한 줄: 요청 값 ↔ 확인 값 · 따른 쪽 */
export function mismatchLine(mismatch: RequestMismatch): string {
  return `요청 "${mismatch.requestValue}" ↔ 확인 "${mismatch.checkValue}" · ${MISMATCH_FOLLOWED_LABEL[mismatch.followed]}`;
}
