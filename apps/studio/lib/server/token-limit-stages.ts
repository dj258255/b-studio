/**
 * 토큰 한도에 다가가는 단계 알림의 판정(순수 함수). 알림만 정한다 — 한도를 넘었는지(막는 판정)는 `session-limits.ts`의 `judgeLimits`가 하고, 여기는 부르지도 바꾸지도 않는다.
 *
 * 단계는 한도 대비 사용량의 50%·80%다. 처음 넘을 때 한 번만 알리고, 한 번에 두 단계를 넘으면 높은 단계만 알린다.
 * 100% 이상은 막는 쪽이 이미 알리므로 알리지 않고 "넘음"으로만 기억한다.
 */

export const LIMIT_ALERT_STAGES = [50, 80] as const;
export type LimitAlertStage = (typeof LIMIT_ALERT_STAGES)[number];
/** 0: 아직 50% 아래, 100: 한도에 닿았거나 넘음(알리지 않는다) */
export type LimitStage = 0 | LimitAlertStage | 100;

/** 이미 알린 단계의 기억. key는 한도를 가르는 값(한도 크기·사람·기간)이라, 키가 달라지면 다른 한도로 보고 처음부터 센다 */
export interface StageMemory {
  key: string;
  stage: LimitStage;
}

/** 쓴 양이 한도의 몇 %인가. 한도나 사용량을 셀 수 없으면(모름) undefined — 0%로 읽지 않는다 */
export function limitPercent(used: number | undefined, limit: number | undefined): number | undefined {
  if (used === undefined || limit === undefined) return undefined;
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(limit) || limit <= 0) return undefined;
  return (used / limit) * 100;
}

/** 퍼센트가 어느 단계인가. 모르면 undefined */
export function stageOf(percent: number | undefined): LimitStage | undefined {
  if (percent === undefined || !Number.isFinite(percent) || percent < 0) return undefined;
  if (percent >= 100) return 100;
  if (percent >= 80) return 80;
  if (percent >= 50) return 50;
  return 0;
}

export interface StageStep {
  memory: StageMemory | undefined;
  /** 이번에 처음 넘어 알릴 단계. 없으면 알리지 않는다 */
  alert?: LimitAlertStage;
}

/**
 * 사용량을 보고 기억을 한 걸음 나아가게 한다.
 * - 사용량을 모르면(undefined) 기억도 알림도 그대로다(조용해지는 것이지 "0%로 내려가는" 것이 아니다)
 * - key가 달라졌으면(한도가 바뀜·다른 사람·다른 기간) 앞의 기억을 버리고 지금 단계부터 센다
 * - 단계가 내려갔으면(기간이 바뀌어 사용량이 초기화됨) 기억도 내려가, 다시 넘을 때 다시 알린다
 */
export function advanceStage(memory: StageMemory | undefined, key: string, used: number | undefined, limit: number | undefined): StageStep {
  const stage = stageOf(limitPercent(used, limit));
  if (stage === undefined) return { memory };
  const before = memory && memory.key === key ? memory.stage : 0;
  if (stage <= before) return { memory: { key, stage } };
  return { memory: { key, stage }, ...(stage === 50 || stage === 80 ? { alert: stage } : {}) };
}

/** 사람 몫(ADR-209와 같은 식): 파일 합계 − 이 실행이 저장을 마친 몫 + 이 실행 누적. 읽을 수 없는 값이 있으면 undefined */
export function userUsedTokens(fileTotal: number, ledger: { accum: number; saved: number } | undefined): number | undefined {
  const saved = ledger?.saved ?? 0;
  const accum = ledger?.accum ?? 0;
  for (const value of [fileTotal, saved, accum]) if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.max(0, fileTotal - saved) + accum;
}

/** desk 카드에 보일 한도 사용 비율. 세션 한도와 사람 한도 가운데 더 빠듯한 쪽이다. percent가 없으면 사용량을 읽지 못한 것(모름) */
export interface TokenLimitView {
  kind: 'session' | 'user';
  limit: number;
  used?: number;
  percent?: number;
}

/**
 * 세션·사람 한도 후보에서 보일 하나를 고른다. 아는 값 가운데 가장 높은 %를 고르되, 80% 아래이고 사용량을 읽지 못한 한도가 따로 있으면
 * 그 "모름"을 보인다(읽은 쪽이 낮다고 읽지 못한 쪽까지 괜찮은 것처럼 보이지 않게 한다)
 */
export function pickTokenLimitView(candidates: ReadonlyArray<TokenLimitView | undefined>): TokenLimitView | undefined {
  const present = candidates.filter((view): view is TokenLimitView => view !== undefined);
  const known = present.filter((view) => view.percent !== undefined);
  const unknown = present.find((view) => view.percent === undefined);
  const top = known.length > 0 ? known.reduce((best, view) => ((view.percent ?? 0) > (best.percent ?? 0) ? view : best)) : undefined;
  if (top && (top.percent ?? 0) >= LIMIT_ALERT_STAGES[1]) return top;
  return unknown ?? top;
}

/** 한도 후보 하나를 화면 값으로. 사용량을 읽지 못했으면 used·percent 없이 한도만 싣는다 */
export function tokenLimitView(kind: 'session' | 'user', limit: number, used: number | undefined): TokenLimitView {
  const percent = limitPercent(used, limit);
  return { kind, limit, ...(percent !== undefined && used !== undefined ? { used, percent } : {}) };
}
