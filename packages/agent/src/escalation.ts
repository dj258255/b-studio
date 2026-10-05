/**
 * 모델 승격 규칙. 검토 문서(docs/research/2026-09-25-knowledge-sharing-and-model-handoff.md 3절)가
 * 이 저장소에 맞는 교체 방식으로 고른 "실패 시 승격(cascade)"을 구현한다.
 *
 * 원칙:
 * - 승격 여부는 모델의 자기 평가가 아니라 게이트의 실패 서명이 정한다.
 * - 기본값은 지금 동작(승격 없음)이다. 옵션을 줄 때만 승격한다.
 * - 효과는 벤치로 잰 뒤에만 주장한다. 여기서는 규칙만 정하고 수치를 말하지 않는다.
 */
import { signatureFromCheck, signatureKey, signaturesFromReport } from './coordination/signature';
import type { VerificationReport } from './verify';
import type { WorkflowCheck } from './workflow';

/** 같은 실패 서명 집합이 연속 몇 번 나오면 승격할지의 기본값 */
export const DEFAULT_SAME_SIGNATURE_TIMES = 2;
/** 승격한 뒤 게이트 재시도를 새로 주는 횟수의 기본값 */
export const DEFAULT_ESCALATION_RETRY_BUDGET = 2;

export interface EscalationPolicy {
  /** 승격할 모델 이름. 로컬 Claude Agent 러너는 SDK 모델 이름, API 루프는 사람이 읽는 이름을 쓴다 */
  to: string;
  /** 같은 실패 서명 집합이 연속 몇 번 나오면 올릴지. 기본 2 */
  sameSignatureTimes?: number;
  /**
   * 서명과 무관하게 게이트 실패가 이만큼이면 승격한다(같은 서명 규칙과 OR).
   * E4에서 5회는 실패 서명이 매번 달라 승격 계기가 아예 없었던 것을 겨냥한 선택 규칙이다
   */
  afterFailures?: number;
  /**
   * 승격한 뒤 게이트 재시도를 **새로** 주는 횟수. 기존 남은 횟수에 더하지 않고 "지금까지 시도한 수 + 이 값"으로
   * 상한을 다시 잡는다(E4에서 2번째 실패 뒤 승격하고도 비싼 모델에게 한 번밖에 남지 않았던 것을 겨냥).
   * 기본값은 DEFAULT_ESCALATION_RETRY_BUDGET. 승격을 설정하지 않은 실행에는 아무 영향이 없다
   */
  retryBudget?: number;
}

/**
 * 게이트 보고서와 실패한 워크플로 확인에서 이번 시도의 실패 서명 키 집합을 만든다.
 * 키를 정렬·중복 제거해 합친 문자열 하나로 두어, 두 시도의 "실패한 것의 집합"이 같은지를 문자열 비교로 볼 수 있게 한다.
 */
export function signatureSetKey(report: VerificationReport | undefined, checks: readonly WorkflowCheck[] = []): string {
  const keys = new Set<string>();
  if (report) for (const signature of signaturesFromReport(report)) keys.add(signatureKey(signature));
  for (const check of checks) if (!check.ok) keys.add(signatureKey(signatureFromCheck(check)));
  return [...keys].sort().join('\n');
}

/**
 * 마지막 `times`번의 실패 서명 집합이 모두 같으면 true(같은 실패가 연속으로 반복).
 * history는 게이트 실패마다 signatureSetKey로 만든 값을 시도 순서대로 담는다.
 * "한 번 승격하면 다시 승격하지 않는다"는 규칙은 호출자가 기억한다. 이 함수는 기록만 보고 판단한다.
 */
export function shouldEscalate(history: readonly string[], times: number): boolean {
  if (times < 1 || history.length < times) return false;
  const last = history[history.length - 1];
  for (let index = history.length - times; index < history.length; index += 1) {
    if (history[index] !== last) return false;
  }
  return true;
}

/**
 * 이번 실패로 승격할지. 두 규칙의 OR다.
 *  - 같은 실패 서명 집합이 `sameSignatureTimes`번(기본 2) 반복됐다
 *  - `afterFailures`가 있고 게이트 실패 횟수가 거기에 이르렀다(서명이 매번 달라도 올린다)
 * "한 실행에 한 번만 승격"은 호출자가 기억한다(기존 규칙 그대로).
 */
export function shouldPromote(policy: EscalationPolicy, history: readonly string[]): boolean {
  const times = policy.sameSignatureTimes ?? DEFAULT_SAME_SIGNATURE_TIMES;
  if (shouldEscalate(history, times)) return true;
  return policy.afterFailures !== undefined && history.length >= policy.afterFailures;
}

/** 승격한 뒤 줄 재시도 횟수. 정책에 없으면 기본값을 쓰고, 0 이하이거나 숫자가 아니면 0(예산 없음) */
export function retryBudgetFor(policy: EscalationPolicy): number {
  const budget = policy.retryBudget ?? DEFAULT_ESCALATION_RETRY_BUDGET;
  return Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0;
}

/**
 * 승격을 알린 뒤 모델에게 다시 보낼 말.
 * 상한을 새로 받은 경우(게이트가 이미 exhausted였을 수도 있다)에는 마지막 실패 안내를 함께 보낸다 —
 * 그래야 올라간 모델이 무엇을 고쳐야 하는지 안다
 */
export function escalationPrompt(summary: string, lastFeedback: string | undefined): string {
  return lastFeedback ? `${summary}\n\n직전 검증 결과를 다시 보냅니다.\n\n${lastFeedback}` : summary;
}
