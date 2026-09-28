/**
 * 실행 하나가 실패했을 때 원인을 분류한다. 규칙은 위에서부터 먼저 맞는 것을 쓴다.
 */
import type { TaskPlanView } from '../../lib/task-plan-types';
import type { AcceptanceResult } from './acceptance';

export type FailureCategory =
  | 'none'
  | 'plan_rejected'
  | 'scope_violation'
  | 'lane_gate'
  | 'integration_gate'
  | 'acceptance'
  | 'rate_limited'
  | 'environment'
  | 'timeout'
  | 'unknown';

export interface Classification {
  category: FailureCategory;
  detail: string;
}

/**
 * 사용 한도 신호. environment보다 먼저 본다.
 * 부분 문자열이 아니라 경계가 있는 정규식으로 찾는다 — '1429ms'·'4290 bytes'·'unlimited' 같은 값을 한도로 오인하지 않게.
 */
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b429\b/,
  /\busage limit\b/i,
  /\brate[ _]limit/i,
  /\bhit your (usage )?limit\b/i,
  /\blimit reached\b/i,
  /\boverloaded\b/i,
];
const ENVIRONMENT_NEEDLES = ['준비하지 못했습니다', 'no space left', 'ENOSPC', 'OOM', 'ECONNREFUSED', '502'];
const DETAIL_LIMIT = 300;

export function classify(plan: TaskPlanView, acceptance: AcceptanceResult[] | undefined, harnessError?: string): Classification {
  const errors = [plan.error, ...plan.lanes.map((lane) => lane.error), plan.integration?.error].filter((value): value is string => Boolean(value));
  const combined = [harnessError, ...errors].filter((value): value is string => Boolean(value)).join('\n');

  // 사용 한도는 환경 문제보다 먼저 본다. 한도에 걸린 실행을 환경 오류로 묶으면 원인을 잃는다
  const rateLimit = RATE_LIMIT_PATTERNS.find((pattern) => pattern.test(combined));
  if (rateLimit) return { category: 'rate_limited', detail: clip(`${rateLimit.source}: ${combined}`) };

  // 하네스(벤치 실행기) 자체 오류
  if (harnessError) {
    return { category: /시간\s*초과|timeout|timed out/i.test(harnessError) ? 'timeout' : 'environment', detail: clip(harnessError) };
  }

  const environment = ENVIRONMENT_NEEDLES.find((needle) => errors.some((error) => error.includes(needle)));
  if (environment) return { category: 'environment', detail: clip(`${environment}: ${errors.join(' | ')}`) };

  // 승인 전에 계획 단계에서 실패한 경우(레인을 돌리지 않았다)
  if (plan.status === 'failed' && !plan.approvedAt) {
    return { category: 'plan_rejected', detail: clip(plan.error ?? '계획 단계에서 실패했습니다') };
  }

  const scope = plan.lanes.find((lane) => lane.error?.includes('writable scope'));
  if (scope?.error) return { category: 'scope_violation', detail: clip(scope.error) };

  const failedLane = plan.lanes.find((lane) => lane.status === 'failed');
  if (failedLane) return { category: 'lane_gate', detail: clip(failedLane.error ?? `${failedLane.id} 레인이 실패했습니다`) };

  if (plan.integration?.status === 'failed') return { category: 'integration_gate', detail: clip(plan.integration.error ?? '통합이 실패했습니다') };

  if (plan.status === 'done') {
    const failed = (acceptance ?? []).filter((result) => !result.ok);
    if (failed.length > 0) return { category: 'acceptance', detail: clip(failed.map((result) => `${result.check}: ${result.detail}`).join(' | ')) };
    return { category: 'none', detail: '통과' };
  }

  return { category: 'unknown', detail: clip(`계획 상태 ${plan.status}${errors.length ? ` · ${errors.join(' | ')}` : ''}`) };
}

function clip(text: string): string {
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}
