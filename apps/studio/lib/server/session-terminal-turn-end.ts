import { native } from '@b-studio/sandbox';

/**
 * 세션 터미널의 턴 끝(Stop 훅) 판정(ADR-212, 4f B4c). 판정은 Rust `crates/bstudio-session`의 `terminal::turn_end`가 한다(순수 함수).
 * 여기는 사실을 코어에 넘기고 결정을 TS 값으로 돌려주는 껍데기다. 되돌리기·저장·알림·글 조립은 `sessions.ts`가 한다. 옛 판정은 지웠다(#1347).
 *
 * 읽기가 부수 효과인 사실(Git 맞추기, 지문, 바뀐 파일 목록, 카드 범위)은 `unread`로 넘기고, 판정이 `need_*`를 돌려주면 읽어서 채운 뒤
 * **닫힘·미룬 위반·위반을 포함한 모든 사실을 그 순간 값으로 다시 읽어** 같은 판정을 다시 부른다. 모르는 결정은 닫는 쪽(`unknown`)이다.
 */

export type GitCheck = 'unread' | 'aligned' | 'failed';
export type FingerprintCheck = 'unread' | 'same' | 'different' | 'unknown';
export type UnchangedCheck = 'unread' | 'yes' | 'no' | 'unknown';
export type CardCheck = 'unread' | 'inside' | 'outside';

export interface TurnEndFacts {
  /** 실행이 닫혔다 */
  closed: boolean;
  /** 감시가 담아 둔 위반이 있다 */
  pendingViolation: boolean;
  /** 이 실행에 적힌 위반이 있다 */
  violation: boolean;
  /** 이 실행이 읽기만이다 */
  readOnly: boolean;
  /** 읽기만이 앞선 변경이 있는 실행에 이어 켜졌다 */
  readOnlyAfterWork: boolean;
  git: GitCheck;
  fingerprint: FingerprintCheck;
  /** 변경 전 기준(검증 상태)이 이미 세워져 있다 */
  verification: boolean;
  unchanged: UnchangedCheck;
  /** 카드에 완료 검사가 있다 */
  doneTests: boolean;
  /** 카드 실행 맥락이 걸려 있다 */
  hasCard: boolean;
  card: CardCheck;
  /** 게이트 밖 사유로 돌려보낸 횟수(이번 판정 앞까지) */
  unsettledAttempts: number;
  /** 게이트가 센 실패 횟수 */
  gateAttempts: number;
  maxAttempts: number;
}

export type TurnEndStep =
  | { kind: 'nothing' }
  | { kind: 'fail_pending_violation' }
  | { kind: 'fail_violation' }
  | { kind: 'need_git'; allowUnwind: boolean }
  | { kind: 'git_failed' }
  | { kind: 'need_fingerprint' }
  | { kind: 'read_only_fail'; unverified: boolean }
  | { kind: 'read_only_done' }
  | { kind: 'need_unchanged' }
  | { kind: 'settle_unchanged' }
  | { kind: 'run_done_tests' }
  | { kind: 'need_card_scope' }
  | { kind: 'card_retry' }
  | { kind: 'card_exhausted' }
  | { kind: 'run_gate' }
  /** 코어가 알아보지 못한 결정. 통과로 두지 않고 실행을 실패로 닫는다 */
  | { kind: 'unknown' };

const STEP_KINDS = new Set([
  'nothing',
  'fail_pending_violation',
  'fail_violation',
  'need_git',
  'git_failed',
  'need_fingerprint',
  'read_only_fail',
  'read_only_done',
  'need_unchanged',
  'settle_unchanged',
  'run_done_tests',
  'need_card_scope',
  'card_retry',
  'card_exhausted',
  'run_gate',
]);

/** 게이트 앞 판정: 닫힘 → 미룬 위반 → 위반 → Git 맞추기 → (읽기만: 지문) → 바뀐 것 없음 → 카드 범위 → 게이트 */
export function decideTurnEnd(facts: TurnEndFacts): TurnEndStep {
  const step = native.terminalDecideTurnEnd(facts);
  if (!STEP_KINDS.has(step.kind)) return { kind: 'unknown' };
  if (step.kind === 'need_git') return { kind: 'need_git', allowUnwind: step.allowUnwind };
  if (step.kind === 'read_only_fail') return { kind: 'read_only_fail', unverified: step.unverified };
  return { kind: step.kind } as TurnEndStep;
}

export type GatePath = 'gate' | 'done_tests';
export type GateKind = 'pass' | 'retry' | 'exhausted';

export interface GateFacts {
  path: GatePath;
  outcome: GateKind;
  /** 실행이 취소됐거나 세션이 멈췄다 */
  cancelled: boolean;
  /** 이 실행이 턴 상한에 닿았다 */
  maxTurnsLimit: boolean;
  /** 이 실행에 위반이 적혀 있다 */
  violation: boolean;
  /** 게이트 밖 사유로 돌려보낸 횟수(이번 것을 센 뒤) */
  unsettledAttempts: number;
  gateAttempts: number;
  maxAttempts: number;
}

export type GateStep =
  | { kind: 'throw_cancel' }
  | { kind: 'pass' }
  | { kind: 'fail_violation' }
  | { kind: 'retry' }
  | { kind: 'exhaust'; maxTurns: boolean; attempts: boolean }
  | { kind: 'unknown' };

const GATE_KINDS = new Set(['throw_cancel', 'pass', 'fail_violation', 'retry', 'exhaust', 'unknown']);

/** 게이트 뒤 판정: 취소 → 턴 상한 → 통과면 위반 → 재시도·소진. 알아보지 못한 결과는 `unknown`이다 */
export function decideGateOutcome(facts: GateFacts): GateStep {
  const step = native.terminalDecideGateOutcome(facts);
  if (!GATE_KINDS.has(step.kind)) return { kind: 'unknown' };
  if (step.kind === 'exhaust') return { kind: 'exhaust', maxTurns: step.maxTurns, attempts: step.attempts };
  return { kind: step.kind } as GateStep;
}

/** 체크포인트를 남긴 직후 판정: 남기는 동안 위반이 왔으면 실패로 닫는다. 알아보지 못한 결과도 실패다 */
export function decideAfterCheckpoint(violation: boolean): 'settle' | 'fail_violation' {
  return native.terminalDecideAfterCheckpoint(violation) === 'settle' ? 'settle' : 'fail_violation';
}
