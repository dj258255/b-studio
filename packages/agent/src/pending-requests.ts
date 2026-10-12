import type { Page, Request } from 'playwright-core';

/**
 * 페이지가 보낸 요청 가운데 아직 끝나지 않은 것을 센다(#684).
 *
 * 조작 뒤에 "그 조작이 낸 요청의 응답이 올 때까지" 기다리려고 `waitForLoadState('networkidle')`을 쓰면 안 된다.
 * 그 상태는 문서가 한 번 들면 유지된다 — 화면이 0.5초쯤 쉬었던 뒤의 조작에서는 바로 통과해, 응답이 오기 전에 판정이 내려진다.
 * 그래서 떠 있는 요청을 직접 센다.
 */
export interface PendingRequests {
  /**
   * 떠 있는 요청이 없어질 때까지 기다린다.
   * - graceMs: 조작의 핸들러가 요청을 내보낼 시간. 이만큼은 무조건 기다린다
   * - quietMs: 떠 있는 요청이 없는 상태가 이만큼 이어져야 끝난 것으로 본다(응답을 받고 이어서 보내는 요청을 놓치지 않게)
   * - timeoutMs: 상한. 끝나지 않는 요청(스트림, 긴 폴링)이 있어도 여기서 멈춘다
   */
  waitForIdle(options: { graceMs: number; quietMs: number; timeoutMs: number }): Promise<void>;
  /** 지금 떠 있는 요청 수 */
  readonly size: number;
}

/** 끝나지 않는 것이 정상인 연결. 이것을 기다리면 매번 상한까지 간다 */
const STREAM_TYPES = new Set(['eventsource', 'websocket']);

const POLL_MS = 20;

export function trackPendingRequests(page: Page): PendingRequests {
  const pending = new Set<Request>();
  page.on('request', (request) => {
    if (!STREAM_TYPES.has(request.resourceType())) pending.add(request);
  });
  page.on('requestfinished', (request) => pending.delete(request));
  page.on('requestfailed', (request) => pending.delete(request));
  // 문서가 바뀌면 앞 문서가 보내 둔 요청은 끝났다는 알림 없이 남는다(실측: 이동 0.3초 뒤에도 떠 있는 것으로 남았다).
  // 그대로 두면 그 뒤의 기다림이 매번 상한까지 간다. 이 시점에 떠 있는 것은 이동 요청 자신과 앞 문서의 요청뿐이다
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    for (const request of pending) if (!request.isNavigationRequest()) pending.delete(request);
  });

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  return {
    get size() {
      return pending.size;
    },
    async waitForIdle({ graceMs, quietMs, timeoutMs }) {
      const deadline = Date.now() + Math.max(timeoutMs, graceMs);
      await sleep(graceMs);
      let quietSince = pending.size === 0 ? Date.now() : undefined;
      while (Date.now() < deadline) {
        if (pending.size === 0) {
          quietSince ??= Date.now();
          if (Date.now() - quietSince >= quietMs) return;
        } else {
          quietSince = undefined;
        }
        await sleep(POLL_MS);
      }
    },
  };
}
