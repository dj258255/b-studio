/**
 * 환경 실패 연속 발생 시 조기 중단(이슈 #411, 실험 E10).
 *
 * E10(`--backend claude-code --model auto|sonnet --strategies S0 --tasks orders-list,order-detail,order-summary --repeats 1`)을
 * 18회 돌렸는데 14회가 category environment였다(2026-10-06 07:45~12:58, 약 5시간). 증상은 매번 같았다 — 레인 세션이
 * "앱이 켜지다가 종료됐습니다 (컨테이너 exited)"로 20초 안에 끝났는데, 벤치는 원인을 묻지 않고 다음 실행으로 넘어갔다.
 * 호스트 네트워크가 불안정해 edge가 registry.npmjs.org 같은 허용된 호스트의 이름도 못 풀었던 것으로 보인다
 * (같은 커밋을 --dry로 다시 띄우면 바로 떴다).
 *
 * environment가 연달아 N번(기본 DEFAULT_MAX_ENV_FAILURES) 나오면, 네트워크가 돌아올 때까지 나머지 실행이
 * 모두 같은 이유로 실패할 뿐이니 더 돌리지 않고 멈춘다. 이미 남은 컨테이너(leftoverContainers)·사용 한도(rate_limited)
 * 중단과 같은 자리(run.ts의 반복 루프)에서 abortReason으로 합류한다.
 */
import type { FailureCategory } from './classify';

/** --max-env-failures 기본값. 연속 2번이면 멈춘다 */
export const DEFAULT_MAX_ENV_FAILURES = 2;

/** --max-env-failures 해석. 주지 않으면 기본값, 1 이상의 정수가 아니면 거부한다 */
export function resolveMaxEnvFailures(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_ENV_FAILURES;
  if (!Number.isInteger(value) || value < 1) throw new Error(`--max-env-failures는 1 이상의 정수여야 합니다 (지금 값: ${value})`);
  return value;
}

/**
 * 다음 연속 environment 실패 횟수. environment가 아닌 결과(성공이든 다른 실패 분류든)가 하나라도 끼면
 * 연속이 끊긴 것이므로 0으로 되돌아간다 — "연달아"의 뜻을 그대로 지킨다
 */
export function nextEnvFailureStreak(streak: number, category: FailureCategory): number {
  return category === 'environment' ? streak + 1 : 0;
}

/** 연속 횟수가 한도에 이르렀는지 */
export function envFailuresExceeded(streak: number, max: number): boolean {
  return streak >= max;
}

/** 중단할 때 콘솔·meta.json(abortReason)에 남길 문구. "환경 장애로 멈췄다"는 사실과 조정 방법을 함께 적는다 */
export function envFailureAbortMessage(streak: number, max: number): string {
  return `environment 실패가 연달아 ${streak}번(한도 ${max}) 나서 멈춥니다. 네트워크 등 환경 장애로 추정합니다 — 복구를 기다리거나 --max-env-failures로 한도를 늘려 다시 시도하세요. 이미 끝난 실행 결과는 results.jsonl에 남아 있습니다.`;
}
