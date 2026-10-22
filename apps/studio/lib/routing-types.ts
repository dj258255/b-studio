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
  /** 끝까지 간 만들기 요청 수(통과·실패·오류·플랫폼 실패·바꾼 것 없음·확인 필요의 합) */
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
  /** 게이트는 통과했지만 에이전트가 요청과 확인의 어긋남을 알렸다(#666). 맞았는지 사람이 봐야 해 통과율에 넣지 않는다 */
  needsReview: number;
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

/** 미리보기 옆에 보일 만큼 판정이 난 실행 수. 이보다 적으면 우연과 구별되지 않아 보이지 않는다(#827) */
export const MIN_JUDGED_FOR_HINT = 3;

/** 한 작업 종류에서 한 AI(백엔드)가 낸 결과. judged는 통과 + 실패 + 오류다 */
export interface KindRecord {
  backend: string;
  passed: number;
  judged: number;
}

function sameKind(a: TaskKindKey, b: TaskKind): boolean {
  return a !== UNKNOWN_KIND && a.complexity === b.complexity && a.risk === b.risk;
}

/**
 * 같은 작업 종류의 결과를 AI(백엔드)별로 모은다(#827). 모델이 달라도 같은 AI로 묶는다. 판정 난 실행이
 * MIN_JUDGED_FOR_HINT 이상인 AI만, 통과율이 높은 순(같으면 판정 수가 많은 순)으로 돌려준다. 고르는 데 쓰지 않고 보이기만 한다
 */
export function kindRecords(rows: readonly RoutingStatsRow[], kind: TaskKind, minJudged = MIN_JUDGED_FOR_HINT): KindRecord[] {
  const byBackend = new Map<string, KindRecord>();
  for (const row of rows) {
    if (!sameKind(row.kind, kind)) continue;
    const record = byBackend.get(row.backend) ?? { backend: row.backend, passed: 0, judged: 0 };
    record.passed += row.passed;
    record.judged += row.passed + row.failed + row.errors;
    byBackend.set(row.backend, record);
  }
  return [...byBackend.values()]
    .filter((record) => record.judged >= minJudged)
    .sort((a, b) => b.passed / b.judged - a.passed / a.judged || b.judged - a.judged || a.backend.localeCompare(b.backend));
}
