/**
 * 세션 목록의 변화를 받는다(wait·events). 스튜디오의 목록 통로(/api/agents/stream)가 있으면 그것을 쓰고(이벤트가 오면 바로 반응),
 * 통로가 없는 옛 스튜디오(404)면 목록을 주기적으로 읽는다. 통로가 끊기면 다시 붙는다 — 연달아 실패하면 던진다(끝까지 모르는 채 기다리지 않는다)
 */
import { StudioRequestError, type StudioClient } from '../desk/client';
import type { DeskItem } from '../desk/types';

export interface WatchOptions {
  /** 통로가 없을 때 목록을 읽는 간격 */
  pollMs?: number;
  /** 다시 붙기 전 기다림 */
  retryMs?: number;
  /** 연달아 실패해도 다시 붙어 보는 횟수 */
  maxFailures?: number;
}

function sleepUntilAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** signal로 끊으면 끝난다. 복구할 수 없는 오류면 던진다 */
export async function watchSessions(client: StudioClient, onItems: (items: DeskItem[]) => void, signal: AbortSignal, options: WatchOptions = {}): Promise<void> {
  const pollMs = options.pollMs ?? 1_000;
  const retryMs = options.retryMs ?? 500;
  const maxFailures = options.maxFailures ?? 5;
  let failures = 0;
  let polling = false;
  while (!signal.aborted) {
    try {
      if (polling) {
        onItems((await client.agents()).items);
        failures = 0;
        await sleepUntilAbort(pollMs, signal);
        continue;
      }
      await client.agentsStream((overview) => {
        failures = 0;
        onItems(overview.items);
      }, signal);
      // 서버가 통로를 닫았다. 끊은 것이 아니면 다시 붙는다
      if (!signal.aborted) await sleepUntilAbort(retryMs, signal);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof StudioRequestError && error.status === 404 && !polling) {
        polling = true;
        continue;
      }
      // 인증·권한 거절은 되풀이해도 같다
      if (error instanceof StudioRequestError && (error.status === 401 || error.status === 403)) throw error;
      failures += 1;
      if (failures > maxFailures) throw error;
      await sleepUntilAbort(retryMs, signal);
    }
  }
}
