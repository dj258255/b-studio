/**
 * 옛 터미널 실행 닫기(ADR-210 이전)의 판정. 새 코드(`session-terminal-close.ts`, Rust `bstudio-session`의 `terminal`)와 견주는 차등 시험의 기준으로만 남아 있다.
 * 4g에서 지운다. 옛 `sessions.ts`의 `abandonTerminalRun`·`terminalCliEnded`·`terminalViolation`·`openTerminalRun`이 정하던 것을 그대로 옮겼다(부수 효과는 뺐고 이름으로 적는다).
 * 옛 코드의 모습 그대로의 결함도 함께 옮겼다:
 * - 닫기가 그 실행의 중단 신호를 끊지 않았다(`aborts`가 늘 거짓)
 * - CLI 종료를 검사 중에 받으면 미뤘지만 그 표시를 남기지 않아, 검사가 재시도로 끝나도 피드백을 돌려주고 실행이 열린 채 남았다(`retry`가 늘 `feedback`)
 */
export type LegacyEndStatus = 'failed' | 'cancelled' | 'error';
export type LegacyCloseAction = 'none' | 'revert' | 'revert_host_only' | 'notice_platform' | 'notice_kept';
export type LegacyCloseText = 'stopped' | 'platform_kept' | 'kept' | 'reverted' | 'cancelled_report';

export interface LegacyCloseFacts {
  status: LegacyEndStatus;
  stopping: boolean;
  platformFailure: boolean;
  local: boolean;
  ready: boolean;
  booted: boolean;
  hasReason: boolean;
}

export interface LegacyCloseDecision {
  action: LegacyCloseAction;
  status: LegacyEndStatus;
  text: LegacyCloseText;
  /** 닫으면서 그 실행의 중단 신호를 끊는가(옛 코드는 끊지 않았다) */
  aborts: boolean;
}

/** `abandonTerminalRun`의 분기 순서 그대로: 멈추는 중 → 샌드박스 쪽 실패(내 폴더가 아니면) → 켜는 중·켜지 못함 → 되돌림(켜지 않았으면 작업 복사본만) */
export function legacyClose(facts: LegacyCloseFacts): LegacyCloseDecision {
  const aborts = false;
  if (facts.stopping) return { action: 'none', status: 'cancelled', text: 'stopped', aborts };
  if (facts.platformFailure && !facts.local) return { action: 'notice_platform', status: facts.status, text: 'platform_kept', aborts };
  if (!facts.ready && facts.booted) return { action: 'notice_kept', status: facts.status, text: 'kept', aborts };
  const hostOnly = !facts.booted;
  const cancelled = facts.status === 'cancelled';
  return { action: hostOnly ? 'revert_host_only' : 'revert', status: facts.status, text: cancelled && !facts.hasReason ? 'cancelled_report' : 'reverted', aborts };
}

export type LegacyCliEnded = 'nothing' | 'defer' | 'failed' | 'cancelled';

/** `terminalCliEnded`: 열린 실행이 없거나 검사 중이면 아무것도 하지 않는다. 피드백이 있었으면 실패, 없으면 취소로 닫는다 */
export function legacyCliEnded(facts: { open: boolean; checking: boolean; hasFeedback: boolean }): LegacyCliEnded {
  if (!facts.open) return 'nothing';
  if (facts.checking) return 'defer';
  return facts.hasFeedback ? 'failed' : 'cancelled';
}

/** 턴이 API 오류로 끝났을 때: 옛 코드는 그 훅(StopFailure)을 설치하지 않아 아무것도 하지 않았다(실행이 열린 채 남았다, #1284) */
export function legacyTurnFailed(): 'nothing' {
  return 'nothing';
}

/** 검사가 재시도로 끝났을 때: 옛 코드는 CLI가 끝났는지 몰라 늘 피드백을 돌려줬다 */
export function legacyRetry(): 'feedback' | 'close_failed' {
  return 'feedback';
}

export type LegacyViolationRoute = 'ignore' | 'close_open_run' | 'defer';

/** `terminalViolation`: 멈추는 중이거나 멈춘 세션이면 버리고, 열린 실행이 있으면 닫고, 없으면 담아 둔다 */
export function legacyViolationRoute(facts: { alive: boolean; open: boolean }): LegacyViolationRoute {
  if (!facts.alive) return 'ignore';
  return facts.open ? 'close_open_run' : 'defer';
}

/** 옛 `openTerminalRun`: 세션에 걸린 터미널 실행이 있고 닫지 않았고 취소 신호가 오르지 않았다 */
export function legacyOpen(facts: { attached: boolean; settled: boolean; cancelAborted: boolean }): boolean {
  return facts.attached && !facts.settled && !facts.cancelAborted;
}
