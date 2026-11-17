import { native } from '@b-studio/sandbox';

/**
 * 세션 터미널 턴 끝의 나머지(ADR-217, 4f B5c): 예외 경로 분류, 게이트 밖 사유, 남은 체크포인트·저장 중 실행·다시 붙이기의 조건, 게이트 시간 상한.
 * 판정은 Rust `crates/bstudio-session`의 `terminal::turn_end_rest`가 한다(순수 함수). 여기는 사실을 코어에 넘기고 결정을 TS 값으로 돌려주는 껍데기다.
 * 읽기(Git·지문·샌드박스)와 되돌리기·알림·글 조립은 `sessions.ts`가 한다. 옛 판정은 `session-terminal-turn-end-rest-legacy.ts`에 차등 시험의 기준으로만 남아 있다.
 * 모르는 결정은 닫는 쪽이다(예외 경로는 오류로 되돌리고, 게이트 단계는 알아보지 못한 결과로 실패로 닫는다).
 */

export type Landed = 'yes' | 'no' | 'unknown';
export type HeadRead = { kind: 'empty' } | { kind: 'sha'; sha: string } | { kind: 'failed' };

/** 저장이 남긴 체크포인트(`committedSha`)가 지금 HEAD인가. 읽지 못하면 `unknown`이고, `unknown`은 남았다고 보지 않는다 */
export function landedState(committed: string | undefined, head: HeadRead): Landed {
  const state = native.terminalLandedState(committed ?? null, head.kind, head.kind === 'sha' ? head.sha : null);
  return state === 'yes' || state === 'no' ? state : 'unknown';
}

export interface ErrorFacts {
  /** 세션을 멈추는 신호가 서 있다 */
  stopped: boolean;
  landed: Landed;
  /** 이 실행의 취소 신호가 서 있다 */
  runCancelled: boolean;
  /** 게이트 시간 상한이 지났다 */
  deadlineExceeded: boolean;
  /** 던져진 오류가 이번 실행에서 샌드박스를 켜지 못해 난 오류이고 그 켜기 실패가 플랫폼 쪽이었다 */
  bootPlatformFailure: boolean;
}

export type ErrorClose =
  | { kind: 'stopped' }
  | { kind: 'keep_landed' }
  | { kind: 'cancelled' }
  | { kind: 'deadline' }
  | { kind: 'platform' }
  | { kind: 'failure'; landedUnknown: boolean };

/** 턴 끝이 던졌을 때: 멈춤 → 남은 체크포인트 → 취소 → 시간 상한 → 플랫폼 실패 → 오류. 알아보지 못한 결정은 오류로 되돌린다 */
export function decideTurnEndError(facts: ErrorFacts): ErrorClose {
  const close = native.terminalDecideTurnEndError(facts);
  switch (close.kind) {
    case 'stopped':
    case 'keep_landed':
    case 'cancelled':
    case 'deadline':
    case 'platform':
      return { kind: close.kind };
    default:
      return { kind: 'failure', landedUnknown: close.kind === 'failure' ? close.landedUnknown : true };
  }
}

/** 체크포인트를 남기는 중인 실행을 위반을 적을 실행으로 받아들이는가 */
export function savingAccepts(hasSaving: boolean, attachedAsSessionRun: boolean, closed: boolean): boolean {
  return native.terminalSavingAccepts(hasSaving, attachedAsSessionRun, closed);
}

/** 저장 중이던 실행을 다시 여는가 */
export function shouldReattach(sessionHasRun: boolean, closed: boolean): boolean {
  return native.terminalShouldReattach(sessionHasRun, closed);
}

export type SaveFailureKind = 'head_moved' | 'staged_mismatch' | 'other';
export type SaveStep = 'reconcile_then_rethrow' | 'retry_moved' | 'rethrow';

/** 체크포인트 저장이 던진 오류의 갈 곳. 알아보지 못한 결정은 그대로 다시 던진다(예외 경로가 오류로 닫는다) */
export function decideSaveFailure(kind: SaveFailureKind): SaveStep {
  const step = native.terminalDecideSaveFailure(kind);
  return step === 'reconcile_then_rethrow' || step === 'retry_moved' ? step : 'rethrow';
}

export type Probe = 'unread' | 'clear' | 'found';
export type GateRead = 'unread' | 'pass' | 'retry' | 'exhausted';
export type Unsettled = 'pause_failed' | 'rejected' | 'moved' | 'done_tests_failed';

export interface GateStageFacts {
  deadlineExceeded: boolean;
  /** 검증 동안 에이전트 컨테이너를 멈추지 못했다 */
  pauseFailed: boolean;
  /** 게이트가 다룰 수 없는 경로가 바뀌었는가(첫 지문 맞추기) */
  rejected: Probe;
  gate: GateRead;
  /** 통과 뒤 지문 맞추기에서 바뀐 것이 있는가 */
  moved: Probe;
  /** 통과했는데 바뀐 파일이 없고 완료 검사가 있어 직접 돌린 결과(실패가 `found`). 돌릴 필요가 없으면 `clear` */
  doneTests: Probe;
}

export type GateStageStep =
  | { kind: 'need_rejected' }
  | { kind: 'need_gate' }
  | { kind: 'need_moved' }
  | { kind: 'need_done_tests' }
  | { kind: 'pass' }
  | { kind: 'gate'; result: 'retry' | 'exhausted' | 'unknown' }
  | { kind: 'unsettled'; reason: Unsettled }
  | { kind: 'deadline' }
  /** 코어가 알아보지 못한 결정. 통과로 두지 않고 닫는다 */
  | { kind: 'unknown' };

/** 게이트 단계: 시간 상한 → 멈추지 못함 → 거절된 경로 → 게이트 → 통과 뒤 바뀜 → 완료 검사. 통과(`pass`)는 모든 확인이 끝난 뒤 한 칸뿐이다 */
export function decideGateStage(facts: GateStageFacts): GateStageStep {
  const step = native.terminalDecideGateStage(facts);
  switch (step.kind) {
    case 'need_rejected':
    case 'need_gate':
    case 'need_moved':
    case 'need_done_tests':
      return { kind: step.kind };
    case 'final':
      if (step.end === 'pass') return { kind: 'pass' };
      if (step.end === 'deadline') return { kind: 'deadline' };
      if (step.end === 'gate' && (step.gate === 'retry' || step.gate === 'exhausted' || step.gate === 'unknown')) return { kind: 'gate', result: step.gate };
      if (step.end === 'unsettled' && (step.unsettled === 'pause_failed' || step.unsettled === 'rejected' || step.unsettled === 'moved' || step.unsettled === 'done_tests_failed')) {
        return { kind: 'unsettled', reason: step.unsettled };
      }
      return { kind: 'unknown' };
    default:
      return { kind: 'unknown' };
  }
}

/** 게이트 시간 상한(ms). CLI가 Stop 훅을 끊는 시각(초)보다 여유(300초)만큼 앞이다 */
export function gateDeadlineMs(hookSeconds: number): number {
  return native.terminalGateDeadlineMs(hookSeconds);
}
