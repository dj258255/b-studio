/**
 * 미리보기 iframe과 studio 화면이 postMessage로 주고받는 형태(ADR-113).
 * 서버 쪽 주입 스크립트(preview-inject.ts)와 화면 쪽 수신(preview-panel.tsx) 양쪽에서 같은 상수를 쓴다.
 */
export const PREVIEW_LOCATION_MESSAGE = 'b-studio:location';
