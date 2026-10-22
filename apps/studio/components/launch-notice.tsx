"use client";

import { useSyncExternalStore } from "react";

/** 새 요청 칸이 세션 화면에 넘기는 한 번짜리 안내의 저장 이름(#849). 세션마다 따로 둔다 */
const KEY_PREFIX = "b-studio:launch-notice:";

/** 새 요청 칸이 세션 화면으로 가기 전에 부른다. 저장할 수 없는 브라우저(사생활 보호 창 등)면 조용히 넘어간다 */
export function rememberLaunchNotice(sessionId: string, message: string): void {
  try {
    window.sessionStorage.setItem(KEY_PREFIX + sessionId, message);
  } catch {
    // 안내를 못 넘겨도 세션은 그대로 쓴다
  }
}

/** 남겨 둔 안내를 꺼내고 지운다. 없으면 undefined */
export function readLaunchNotice(sessionId: string): string | undefined {
  try {
    const key = KEY_PREFIX + sessionId;
    const message = window.sessionStorage.getItem(key);
    if (message === null) return undefined;
    window.sessionStorage.removeItem(key);
    return message;
  } catch {
    return undefined;
  }
}

/** 세션마다 한 번 꺼낸 안내. null은 "꺼냈는데 없었다·닫았다"다. 꺼낸 값을 기억해 다시 그려도 저장소를 또 읽지 않는다 */
const taken = new Map<string, string | null>();
const listeners = new Set<() => void>();

function takeOnce(sessionId: string): string | undefined {
  if (!taken.has(sessionId)) taken.set(sessionId, readLaunchNotice(sessionId) ?? null);
  return taken.get(sessionId) ?? undefined;
}

function dismiss(sessionId: string): void {
  taken.set(sessionId, null);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 새 요청을 터미널로 보냈지만 첫 요청을 CLI에 넣지 못했을 때(#836의 pasteError) 그 까닭을 세션 화면 위에 한 번 보인다(#849).
 * 다시 열거나 새로 고치면 보이지 않는다. 서버 렌더에는 없다(브라우저 저장소에만 있다)
 */
export function LaunchNotice({ sessionId }: { sessionId: string }) {
  const message = useSyncExternalStore(subscribe, () => takeOnce(sessionId), () => undefined);
  if (!message) return null;
  return (
    <div role="status" className="glass fixed inset-x-4 top-4 z-50 mx-auto flex max-w-xl items-start gap-3 rounded-panel px-4 py-3 text-sm shadow-lg">
      <p className="min-w-0 flex-1 leading-6 text-wait">{message}</p>
      <button type="button" aria-label="안내 닫기" onClick={() => dismiss(sessionId)} className="rounded-control px-2 py-0.5 text-muted hover:bg-panel hover:text-ink">
        닫기
      </button>
    </div>
  );
}
