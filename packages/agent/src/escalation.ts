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

export interface EscalationPolicy {
  /** 승격할 모델 이름. 로컬 Claude Agent 러너는 SDK 모델 이름, API 루프는 사람이 읽는 이름을 쓴다 */
  to: string;
  /** 같은 실패 서명 집합이 연속 몇 번 나오면 올릴지. 기본 2 */
  sameSignatureTimes?: number;
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
