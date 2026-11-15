import type { StudioEvent } from '@/lib/studio-events';
import { trimHistory } from './session-store';

/**
 * 옛 세션 기록 구현(B1a 앞의 `sessions.ts`의 `emit` 버퍼 처리와 질의)을 순수 함수로 떼어 둔 것이다.
 * 새 구현(`session-record.ts`의 `SessionRecord`, Rust `crates/bstudio-session`)과 견주는 차등 시험의 기준으로만 쓴다. 4g에서 옛 TS를 지울 때 함께 지운다.
 * 제품 코드는 이 파일을 쓰지 않는다.
 */

export const LEGACY_HISTORY_LIMIT = 5_000;
export const LEGACY_LOG_LIMIT = 1_000;
export const LEGACY_OVERVIEW_TAIL = 40;

export interface LegacyRecord {
  history: StudioEvent[];
  logs: StudioEvent[];
}

/** 옛 `emit`의 버퍼 부분. 돌려주는 값은 옛 코드가 `updatedAt`을 바꾸고 `schedulePersist`를 부르던 조건이다 */
export function legacyPush(record: LegacyRecord, event: StudioEvent, limits = { history: LEGACY_HISTORY_LIMIT, log: LEGACY_LOG_LIMIT }): boolean {
  // 사용량과 파일 변경 알림은 자주 오므로 기록에 쌓지 않는다. 새로 연결한 브라우저는 스냅샷에서 최신 값을 받는다
  const transient =
    event.type === 'usage' || event.type === 'sandbox_link' || event.type === 'files_changed' || event.type === 'tests_changed' || event.type === 'deploy_log' || event.type === 'label';
  if (!transient) {
    const buffer = event.type === 'log' ? record.logs : record.history;
    buffer.push(event);
    const limit = event.type === 'log' ? limits.log : limits.history;
    if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
  }
  return !transient && event.type !== 'log';
}

/** 옛 `summarize`·`lastRunStartedRequest`·`overviewSessions`의 마지막 요청 */
export function legacyLastRequest(history: readonly StudioEvent[]): string | undefined {
  const started = history.findLast((event) => event.type === 'run_started');
  return started?.type === 'run_started' ? started.request : undefined;
}

/** 옛 `overviewSessions`의 `tail` */
export function legacyTail(events: readonly StudioEvent[], n = LEGACY_OVERVIEW_TAIL): StudioEvent[] {
  return events.slice(-n);
}

/** 옛 `toPersisted`의 history */
export function legacyTrimmed(history: readonly StudioEvent[]): StudioEvent[] {
  return trimHistory(history);
}
