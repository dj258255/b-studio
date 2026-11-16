/**
 * 옛 터미널 턴 끝(Stop 훅) 판정(ADR-212 이전)의 판정. 새 코드(`session-terminal-turn-end.ts`, Rust `bstudio-session`의 `terminal::turn_end`)와 견주는 차등 시험의 기준으로만 남아 있다.
 * 4g에서 지운다. 옛 `sessions.ts`의 `finishTerminalTurn`이 정하던 분기 순서를 그대로 옮겼다(부수 효과는 뺐다). 모든 사실을 미리 읽은 꼴로 받는다(옛 코드는 필요한 칸에서 읽었다).
 * 옛 코드의 모습 그대로의 결함도 함께 옮겼다:
 * - 읽기만이 앞선 변경이 있는 실행에 이어 켜져도 지문 지름길을 탔다(그 변경이 게이트 없이 done이 됐다, S6)
 * - 게이트 밖 사유로 돌려보낸 횟수만 상한과 견줬다(게이트가 센 횟수는 따로였다, S12)
 * - 알아보지 못한 게이트 결과는 빈 답으로 돌아와 실행이 열린 채 남았다
 */

export interface LegacyTurnEndFacts {
  closed: boolean;
  pendingViolation: boolean;
  violation: boolean;
  readOnly: boolean;
  /** 옛 코드에는 없던 사실(읽기만이 앞선 변경이 있는 실행에 이어 켜졌다). 옛 판정은 읽지 않는다 */
  readOnlyAfterWork: boolean;
  /** Git 맞추기가 실행을 닫았다 */
  gitFailed: boolean;
  /** 읽기만 지문이 같다 */
  fingerprint: 'same' | 'different' | 'unknown';
  verification: boolean;
  unchanged: boolean;
  doneTests: boolean;
  hasCard: boolean;
  cardOutside: boolean;
  unsettledAttempts: number;
  maxAttempts: number;
}

export type LegacyTurnEnd =
  | 'nothing'
  | 'fail_pending_violation'
  | 'fail_violation'
  | 'git_failed'
  | 'read_only_fail'
  | 'read_only_fail_unverified'
  | 'read_only_done'
  | 'settle_unchanged'
  | 'run_done_tests'
  | 'card_retry'
  | 'card_exhausted'
  | 'run_gate';

/** `finishTerminalTurn`의 앞 순서: 닫힘 → 미룬 위반 → 위반 → 읽기만(Git, 지문) → Git → 바뀐 것 없음 → 카드 범위 → 게이트 */
export function legacyTurnEnd(facts: LegacyTurnEndFacts): LegacyTurnEnd {
  if (facts.closed) return 'nothing';
  if (facts.pendingViolation) return 'fail_pending_violation';
  if (facts.violation) return 'fail_violation';
  if (facts.gitFailed) return 'git_failed';
  if (facts.readOnly) {
    if (facts.fingerprint === 'unknown') return 'read_only_fail_unverified';
    if (facts.fingerprint === 'different') return 'read_only_fail';
    return 'read_only_done';
  }
  if (!facts.verification && facts.unchanged) return facts.doneTests ? 'run_done_tests' : 'settle_unchanged';
  if (facts.hasCard && facts.cardOutside) return facts.unsettledAttempts + 1 >= facts.maxAttempts ? 'card_exhausted' : 'card_retry';
  return 'run_gate';
}

export interface LegacyGateFacts {
  path: 'gate' | 'done_tests';
  outcome: 'pass' | 'retry' | 'exhausted';
  cancelled: boolean;
  maxTurnsLimit: boolean;
  violation: boolean;
}

export type LegacyGate = 'throw_cancel' | 'pass' | 'fail_violation' | 'retry' | 'exhaust' | 'exhaust_max_turns';

/** 게이트 뒤 순서. 게이트 길: 취소 → (턴 상한에 닿은 재시도는 소진) → 통과면 위반 → 재시도·소진. 완료 검사 길: 위반 → 통과 / 재시도·소진 */
export function legacyGate(facts: LegacyGateFacts): LegacyGate {
  if (facts.path === 'done_tests') {
    if (facts.violation) return 'fail_violation';
    return facts.outcome === 'pass' ? 'pass' : facts.outcome === 'retry' ? 'retry' : 'exhaust';
  }
  if (facts.cancelled) return 'throw_cancel';
  if (facts.maxTurnsLimit && facts.outcome === 'retry') return 'exhaust_max_turns';
  if (facts.outcome === 'pass') return facts.violation ? 'fail_violation' : 'pass';
  return facts.outcome === 'retry' ? 'retry' : 'exhaust';
}
