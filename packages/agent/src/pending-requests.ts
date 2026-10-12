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

/**
 * 응답 본문이 끝나지 않는 것이 정상인 연결(이벤트 스트림). 본문이 끝나길 기다리면 매번 상한까지 가므로, 응답의 머리(상태 코드)가
 * 올 때까지만 센다. 실패 여부는 상태 코드로 가리므로 그때까지면 충분하다.
 * WebSocket은 요청으로 잡히지 않아(실측) 여기서 다룰 것이 없다 — 개발 서버의 HMR 연결이 기다림을 늘리지 않는다
 */
const STREAM_TYPES = new Set(['eventsource']);

const POLL_MS = 20;

export function trackPendingRequests(page: Page): PendingRequests {
  const pending = new Set<Request>();
  page.on('request', (request) => pending.add(request));
  page.on('response', (response) => {
    if (STREAM_TYPES.has(response.request().resourceType())) pending.delete(response.request());
  });
  page.on('requestfinished', (request) => pending.delete(request));
  page.on('requestfailed', (request) => pending.delete(request));
  // 문서가 바뀔 때 앞 문서가 보내 둔 요청을 여기서 지우지 않는다. 브라우저는 그 요청이 끝났다고 알려 주지 않을 수 있어(실측: 이동
  // 0.3초 뒤에도 남았다) 지우고 싶어지지만, "문서가 바뀌었다"는 알림은 같은 문서 안의 이동(history.pushState, 한 화면 앱의 라우팅)에도
  // 온다. 그때 지우면 살아 있는 요청을 놓쳐 응답 전에 기다림이 끝난다 — 화면이 주소를 바꾸는 것만으로 실패를 숨길 수 있다.
  // 둘을 확실히 가를 신호가 없으므로 남겨 둔다. 남은 요청이 있으면 기다림이 상한까지 갈 뿐이다(닫힌 쪽)

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
