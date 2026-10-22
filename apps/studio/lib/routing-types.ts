/**
 * AI별 결과표(#821)의 형식과 화면 문구. 계산은 lib/server/routing-stats.ts가 하고, 화면은 이 파일만 가져다 쓴다.
 */

/** 요청의 작업 종류. 라우터의 복잡도·위험도 분류(classifyTask)와 같은 값이다 */
export interface TaskKind {
  complexity: 'simple' | 'normal' | 'complex';
  risk: 'normal' | 'high';
}

/** 작업 종류를 남기기 전의 옛 기록 */
export const UNKNOWN_KIND = 'unknown';
export type TaskKindKey = TaskKind | typeof UNKNOWN_KIND;

/** 시작 모델을 알 수 없는 실행(대본 실행, 모델별 사용량을 남기지 않는 러너) */
export const UNKNOWN_MODEL_LABEL = '(모름)';

export interface RoutingStatsRow {
  backend: string;
  /** 실행을 시작한 모델. 실행 중 승격했어도 시작한 모델로 묶는다 */
  model: string;
  kind: TaskKindKey;
  /** 끝까지 간 만들기 요청 수(통과·실패·오류·플랫폼 실패·바꾼 것 없음의 합) */
  runs: number;
  /** 게이트를 통과해 체크포인트로 남았다 */
  passed: number;
  /** 게이트가 실패로 판정했다 */
  failed: number;
  /** 실행이 오류로 끝났다(턴 상한, 러너 오류 등) */
  errors: number;
  /** b-studio 쪽(샌드박스·도커) 문제로 판정하지 못했다. AI의 성적에 넣지 않는다 */
  platformFailures: number;
  /** 바꾼 파일 없이 끝났다. 판정할 변경이 없어 통과율에 넣지 않는다 */
  noChange: number;
  /** 통과 ÷ (통과 + 실패 + 오류). 판정한 실행이 없으면 없다 */
  passRate?: number;
  /** 단가를 찾은 실행의 환산 비용 중앙값 */
  medianCostUsd?: number;
  medianDurationMs?: number;
}

export interface RoutingStats {
  rows: RoutingStatsRow[];
  /** 표에 넣지 않은 실행. asks: 질문, unfinished: 취소·되묻기·진행 중 */
  excluded: { asks: number; unfinished: number };
}

const COMPLEXITY_LABEL: Record<TaskKind['complexity'], string> = { simple: '단순', normal: '보통', complex: '복잡' };

export function taskKindLabel(kind: TaskKindKey): string {
  if (kind === UNKNOWN_KIND) return '모름';
  return kind.risk === 'high' ? `${COMPLEXITY_LABEL[kind.complexity]} · 위험` : COMPLEXITY_LABEL[kind.complexity];
}
