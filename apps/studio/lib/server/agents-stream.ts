import type { AgentItem, AgentTotals } from './agents-overview';

/** 목록 통로(#923)가 흘리는 한 조각. 처음에 전체, 그다음 바뀐 항목만 */
export type AgentsStreamMessage =
  | { type: 'full'; items: AgentItem[]; totals: AgentTotals }
  | {
      type: 'delta';
      /** 새로 생기거나 바뀐 항목(통째로) */
      items: AgentItem[];
      /** 사라진 항목의 id */
      removed: string[];
      /** 바뀐 뒤의 전체 순서(서버가 급한 것을 위로 올리므로 순서도 바뀐다) */
      order: string[];
      /** 합계가 바뀌었을 때만 */
      totals?: AgentTotals;
    };

export interface AgentsOverview {
  items: AgentItem[];
  totals: AgentTotals;
}

/** 두 목록을 비교한다. 하나도 바뀌지 않았으면 없다 */
export function diffOverview(prev: AgentsOverview, next: AgentsOverview): AgentsStreamMessage | undefined {
  const before = new Map(prev.items.map((entry) => [entry.id, JSON.stringify(entry)]));
  const changed = next.items.filter((entry) => before.get(entry.id) !== JSON.stringify(entry));
  const nextIds = new Set(next.items.map((entry) => entry.id));
  const removed = prev.items.filter((entry) => !nextIds.has(entry.id)).map((entry) => entry.id);
  const order = next.items.map((entry) => entry.id);
  const sameOrder = order.length === prev.items.length && order.every((id, index) => prev.items[index]!.id === id);
  const totalsChanged = JSON.stringify(prev.totals) !== JSON.stringify(next.totals);
  if (changed.length === 0 && removed.length === 0 && sameOrder && !totalsChanged) return undefined;
  return { type: 'delta', items: changed, removed, order, ...(totalsChanged ? { totals: next.totals } : {}) };
}

export interface AgentsFeedDeps {
  /** 지금 목록(라우트에서는 listAgentOverview) */
  compute: () => Promise<AgentsOverview>;
  /** 바뀜 신호를 듣는다(agents-pulse). 푸는 함수를 돌려준다 */
  onChange: (listener: () => void) => () => void;
  send: (message: AgentsStreamMessage) => void;
  /** 신호가 몰려 오면 이만큼 모아 한 번 계산한다 */
  debounceMs?: number;
  /** 신호를 놓쳐도(플릿·작업 나누기처럼 신호를 내지 않는 곳) 이 간격마다 다시 본다 */
  refreshMs?: number;
}

const DEBOUNCE_MS = 150;
const REFRESH_MS = 5_000;

/**
 * 한 연결의 목록 통로. 처음에 전체를 보내고, 신호가 오거나 간격이 지나면 다시 계산해 바뀐 것만 보낸다.
 * 계산은 한 번에 하나만 돈다: 도는 중에 신호가 오면 끝난 뒤 한 번 더 돈다
 */
export function createAgentsFeed(deps: AgentsFeedDeps): { start: () => Promise<void>; stop: () => void } {
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  const refreshMs = deps.refreshMs ?? REFRESH_MS;
  let last: AgentsOverview | undefined;
  let stopped = false;
  let running = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const refresh = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const next = await deps.compute();
      if (stopped) return;
      if (!last) deps.send({ type: 'full', items: next.items, totals: next.totals });
      else {
        const delta = diffOverview(last, next);
        if (delta) deps.send(delta);
      }
      last = next;
    } catch {
      // 이번 차례만 건너뛴다. 다음 신호나 간격에서 다시 본다
    } finally {
      running = false;
    }
    if (again && !stopped) {
      again = false;
      await refresh();
    }
  };

  const schedule = (): void => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, debounceMs);
  };

  return {
    start: async () => {
      unsubscribe = deps.onChange(schedule);
      interval = setInterval(() => void refresh(), refreshMs);
      await refresh();
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      if (interval !== undefined) clearInterval(interval);
      unsubscribe?.();
    },
  };
}
