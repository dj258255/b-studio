/**
 * 옛 터미널 턴 끝의 나머지(ADR-217 이전)의 판정. 새 코드(`session-terminal-turn-end-rest.ts`, Rust `bstudio-session`의 `terminal::turn_end_rest`)와 견주는 차등 시험의 기준으로만 남아 있다.
 * 4g에서 지운다. 옛 `sessions.ts`의 `finishTerminalTurn`의 `catch` 블록, `unsettled`·`moved` 클로저, `landedCheckpoint`, `savingTerminalRun`이 정하던 분기를 그대로 옮겼다(부수 효과는 뺐다).
 * 옛 코드의 모습 그대로의 결함도 함께 옮겼다:
 * - 플랫폼 실패를 세션에 남은 표시(`status==='failed' && bootPlatformFailure`)로 알아봤다. 앞선 켜기의 표시가 남아 있으면 이번 실행의 코드 탓 오류도 플랫폼 실패가 됐다
 * - 남은 체크포인트를 읽지 못한 칸을 조용히 "없음"으로 닫았다
 * - 게이트 전체의 시간 상한이 없었다
 */

export interface LegacyErrorFacts {
  stopped: boolean;
  /** `landedCheckpoint`가 체크포인트를 돌려줬다(읽지 못한 칸은 `false`였다) */
  landed: boolean;
  runCancelled: boolean;
  /** 세션 상태가 failed다 */
  statusFailed: boolean;
  /** 세션에 남은 `bootPlatformFailure` 표시 */
  bootFlag: boolean;
}

export type LegacyErrorClose = 'stopped' | 'keep_landed' | 'cancelled' | 'platform' | 'failure';

/** `catch` 블록의 분류: 멈춤 → 남은 체크포인트 → 취소 → 플랫폼 실패 → 오류 */
export function legacyErrorClose(facts: LegacyErrorFacts): LegacyErrorClose {
  if (facts.stopped) return 'stopped';
  if (facts.landed) return 'keep_landed';
  if (facts.runCancelled) return 'cancelled';
  if (facts.statusFailed && facts.bootFlag) return 'platform';
  return 'failure';
}

/** `landedCheckpoint`: 저장이 커밋한 sha가 지금 HEAD일 때만. 읽지 못하면 `undefined`(없음) */
export function legacyLanded(committed: string | undefined, head: { kind: 'empty' } | { kind: 'sha'; sha: string } | { kind: 'failed' }): boolean {
  if (committed === undefined) return false;
  if (head.kind !== 'sha') return false;
  return head.sha === committed;
}

/** `savingTerminalRun` */
export function legacySavingAccepts(hasSaving: boolean, attachedAsSessionRun: boolean, closed: boolean): boolean {
  return hasSaving && !attachedAsSessionRun && !closed;
}

/** `session.run === undefined && !terminalRunClosed(...)` */
export function legacyShouldReattach(sessionHasRun: boolean, closed: boolean): boolean {
  return !sessionHasRun && !closed;
}

export type LegacySaveStep = 'reconcile_then_rethrow' | 'retry_moved' | 'rethrow';

/** 저장이 던진 오류: HeadMovedError → 맞추고 다시 던짐, StagedMismatchError → 게이트 밖 사유, 그 밖 → 다시 던짐 */
export function legacySaveFailure(kind: 'head_moved' | 'staged_mismatch' | 'other'): LegacySaveStep {
  if (kind === 'head_moved') return 'reconcile_then_rethrow';
  if (kind === 'staged_mismatch') return 'retry_moved';
  return 'rethrow';
}

export interface LegacyGateStageFacts {
  pauseFailed: boolean;
  /** 첫 지문 맞추기에서 거절된 경로가 있다 */
  rejected: boolean;
  gate: 'pass' | 'retry' | 'exhausted';
  /** 통과 뒤 지문 맞추기에서 바뀐 것이 있다 */
  moved: boolean;
  /** 통과·바뀐 파일 없음·완료 검사 있음일 때 완료 검사가 실패했다 */
  doneTestsFailed: boolean;
}

export type LegacyGateStage = 'pass' | 'retry' | 'exhausted' | 'unsettled_pause' | 'unsettled_rejected' | 'unsettled_moved' | 'unsettled_done_tests';

/** 게이트 단계의 순서: 멈추지 못함 → 거절된 경로 → 게이트 → (통과면) 통과 뒤 바뀜 → (통과면) 완료 검사 */
export function legacyGateStage(facts: LegacyGateStageFacts): LegacyGateStage {
  if (facts.pauseFailed) return 'unsettled_pause';
  if (facts.rejected) return 'unsettled_rejected';
  if (facts.gate !== 'pass') return facts.gate;
  if (facts.moved) return 'unsettled_moved';
  if (facts.doneTestsFailed) return 'unsettled_done_tests';
  return 'pass';
}
