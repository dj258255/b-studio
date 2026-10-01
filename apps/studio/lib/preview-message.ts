/**
 * 미리보기 iframe과 studio 화면이 postMessage로 주고받는 형태(ADR-113).
 * 서버 쪽 주입 스크립트(preview-inject.ts)와 화면 쪽 수신(preview-panel.tsx) 양쪽에서 같은 상수를 쓴다.
 */
export const PREVIEW_LOCATION_MESSAGE = 'b-studio:location';

/**
 * 받은 message 이벤트가 믿을 수 있는 미리보기 위치 알림인지 확인한다. 출처가 다르거나 보낸 창이 지금 보여주는
 * iframe이 아니면(다른 iframe·확장 프로그램·부모 창 자신의 메시지) 무시한다. 통과하면 샌드박스 앱의 지금 href를 돌려준다
 */
export function readPreviewLocationMessage(
  event: { origin: string; source: unknown; data: unknown },
  expected: { origin: string | undefined; source: unknown },
): string | undefined {
  if (!expected.origin || event.origin !== expected.origin || event.source !== expected.source) return undefined;
  const data = event.data;
  if (!data || typeof data !== 'object') return undefined;
  const { type, href } = data as Record<string, unknown>;
  if (type !== PREVIEW_LOCATION_MESSAGE || typeof href !== 'string') return undefined;
  return href;
}

/** 주소 입력칸에 보여 줄 값(경로+검색+해시). 서비스 출처는 이미 옆에 따로 보여 주므로 또 넣지 않는다 */
export function previewPathFromHref(href: string): string | undefined {
  try {
    const url = new URL(href);
    return `${url.pathname}${url.search}${url.hash}` || '/';
  } catch {
    return undefined;
  }
}
