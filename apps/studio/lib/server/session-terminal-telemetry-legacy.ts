/**
 * 옛 터미널 텔레메트리 입력 판정(ADR-216 이전). 새 코드(`session-terminal-telemetry.ts`, Rust `bstudio-session`의 `terminal::telemetry`·`terminal::limit`)와
 * 견주는 차등 시험의 기준으로만 남아 있다. 4g에서 지운다. 옛 `sessions.ts`의 규칙을 그대로 옮겼다(부수 효과는 뺐다).
 *
 * 옛 모습 그대로의 틈도 옮겼다:
 * - `apiRequestsFromOtlp`(`terminal-telemetry.ts`에 그대로 남아 있다): 필수 속성이 빠지거나 값이 이상한 `api_request`는 통째로 버렸고, 항목은 1,000개까지만 꺼냈고,
 *   시각은 CLI가 준 값을 그대로 썼다
 * - `legacyTurnLimit`: 턴 상한 전이
 * - `legacyTelemetrySeenTarget`: 묶음 안에 모델 요청이 하나라도 있으면 그 요청이 어느 실행의 것이든 지금 열린 실행에 "소식이 왔다"를 세웠다
 */
export { apiRequestsFromOtlp as legacyApiRequestsFromOtlp } from './terminal-telemetry';

export type LegacyLimitReason = 'max_turns' | 'budget' | undefined;

/** 옛 `checkTerminalLimits`의 앞부분: 턴 상한 전이와 토큰 한도를 이어서 볼지 */
export function legacyTurnLimit(reason: LegacyLimitReason, maxTurns: number | undefined, modelCalls: number, aborted: boolean): { reason: LegacyLimitReason; checkBudget: boolean } {
  let next = reason;
  if (next !== 'budget') {
    if (maxTurns !== undefined && modelCalls >= maxTurns) next = 'max_turns';
  }
  return { reason: next, checkBudget: !(aborted || next === 'budget') };
}

/** 옛 `terminalTelemetry`: 묶음에 모델 요청이 하나라도 있으면 열린 실행에 소식이 왔다고 표시했다 */
export function legacyTelemetrySeenTarget(requests: number, openRun: boolean): boolean {
  return requests > 0 && openRun;
}
