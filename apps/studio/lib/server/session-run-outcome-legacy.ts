import type { SessionStatus } from '../studio-events';

/**
 * 옛 `execute`(ADR-208 이전)의 끝 결정과 단계 순서. 새 코드(`session-run.ts`, Rust `bstudio-session`의 `outcome`)와 견주는 차등 시험의 기준으로만 남아 있다.
 * 4g에서 지운다. 옛 `sessions.ts`의 `execute`가 정하던 것을 그대로 옮겼다(부수 효과는 뺐고 단계 이름으로 적는다). 옛 코드의 모습 그대로의 결함도 함께 옮겼다:
 * - 켜지 않은 세션과 `ready`가 아닌 세션에서는 아무것도 하지 않았다(검증하지 않은 변경이 남는지 보지 않았다)
 * - 멈추는 중에도 체크포인트를 저장했다
 * - 취소했는데 되돌리기를 시도하지 않은 칸의 글이 "되돌리지 못했습니다: undefined"였다(`cancelled_unreverted`)
 */
export type LegacyResult = 'done' | 'failed' | 'awaiting_input';
export type LegacyAction = 'none' | 'save' | 'revert' | 'notice_platform';
export type LegacySummary = 'result' | 'preflight' | 'local_edits' | 'mismatch' | 'error' | 'cancelled' | 'cancelled_question' | 'cancelled_unreverted';
export type LegacyFinishedStatus = 'done' | 'failed' | 'awaiting_input' | 'error' | 'cancelled';

export interface LegacyNormalFacts {
  ask: boolean;
  result: LegacyResult;
  questionGatePassed: boolean;
  platformFailure: boolean;
  booted: boolean;
  status: SessionStatus;
  local: boolean;
}

export interface LegacyDecision {
  action: LegacyAction;
  status: LegacyFinishedStatus;
  summary: LegacySummary;
}

/** 결과가 나온 뒤의 옛 판정 */
export function legacyNormal(facts: LegacyNormalFacts): LegacyDecision {
  const finished = { status: facts.result, summary: 'result' as const };
  if (facts.ask) return { action: 'none', ...finished };
  if (facts.booted && (facts.result === 'done' || (facts.result === 'awaiting_input' && facts.questionGatePassed))) return { action: 'save', ...finished };
  if (facts.status === 'ready' && facts.result !== 'awaiting_input') {
    const platform = facts.result === 'failed' && facts.platformFailure;
    return { action: platform && !facts.local ? 'notice_platform' : 'revert', ...finished };
  }
  return { action: 'none', ...finished };
}

export interface LegacyExceptionFacts {
  ask: boolean;
  /** 취소 신호가 올랐다(멈춤 신호와 따로) */
  cancelAborted: boolean;
  stopped: boolean;
  status: SessionStatus;
}

/** 예외로 끝났을 때의 옛 판정. 되돌리기는 멈추는 중이 아니고 질문이 아니고 상태가 `ready`일 때만 했다 */
export function legacyException(facts: LegacyExceptionFacts): LegacyDecision {
  const cancelled = facts.cancelAborted && !facts.stopped;
  const action: LegacyAction = !facts.stopped && !facts.ask && facts.status === 'ready' ? 'revert' : 'none';
  if (!cancelled) return { action, status: 'error', summary: 'error' };
  if (facts.ask) return { action, status: 'cancelled', summary: 'cancelled_question' };
  return { action, status: 'cancelled', summary: action === 'revert' ? 'cancelled' : 'cancelled_unreverted' };
}

export type LegacyKind = 'prepare_fails' | 'plan_fails' | 'run_throws' | 'preflight' | 'done' | 'failed' | 'awaiting_input';
export type LegacySave = 'ok' | 'mismatch' | 'throws';

export interface LegacyScenario {
  ask: boolean;
  kind: LegacyKind;
  questionGatePassed: boolean;
  platformFailure: boolean;
  booted: boolean;
  status: SessionStatus;
  local: boolean;
  stopped: boolean;
  cancelAborted: boolean;
  save: LegacySave;
  /** 결과 뒤의 되돌리기가 던진다(옛 코드는 예외 경로에서 한 번 더 되돌렸다) */
  revertThrows: boolean;
}

export interface LegacyFlow {
  /** 부른 단계 이름(순서대로) */
  steps: string[];
  /** 단계를 부를 때 점유의 단계(`running`·`saving`). `detach_run`부터 저장 중이다(옛 `detachRun`) */
  phases: string[];
  status: LegacyFinishedStatus;
  summary: LegacySummary;
}

class Thrown {
  constructor(readonly localEdits: boolean) {}
}

/** 옛 `execute`가 시나리오에서 한 일. 단계 이름은 새 코드의 `RUN_STEPS`와 같게 적는다 */
export function legacyFlow(scenario: LegacyScenario): LegacyFlow {
  const steps: string[] = [];
  const phases: string[] = [];
  let phase = 'running';
  let decision: LegacyDecision;
  const step = (...names: string[]): void => {
    for (const name of names) {
      if (name === 'detach_run') phase = 'saving';
      steps.push(name);
      phases.push(phase);
    }
  };
  try {
    step('prepare_edits');
    if (scenario.kind === 'prepare_fails') throw new Thrown(true);
    step('announce_edits', 'plan_brief');
    if (scenario.kind === 'plan_fails') throw new Thrown(false);
    step('run_plan');
    if (scenario.kind === 'run_throws') throw new Thrown(false);
    // 취소를 받은 직후 에이전트가 먼저 끝났어도 사용자가 원한 대로 되돌린다
    if (scenario.cancelAborted) throw new Thrown(false);
    step('detach_run');
    if (scenario.kind === 'preflight') {
      decision = { action: 'none', status: 'error', summary: 'preflight' };
    } else {
      step('tally_run', 'note_question');
      const result = scenario.kind as LegacyResult;
      decision = legacyNormal({ ask: scenario.ask, result, questionGatePassed: scenario.questionGatePassed, platformFailure: scenario.platformFailure, booted: scenario.booted, status: scenario.status, local: scenario.local });
      if (decision.action === 'save') {
        step('save_checkpoint');
        if (scenario.save === 'throws') throw new Thrown(false);
        if (scenario.save === 'mismatch') {
          step('revert_after_mismatch');
          decision = { action: 'save', status: 'error', summary: 'mismatch' };
        } else {
          step('after_save');
        }
      } else if (decision.action === 'revert') {
        step('revert_run');
        if (scenario.revertThrows) throw new Thrown(false);
      } else if (decision.action === 'notice_platform') {
        step('notice_platform');
      }
    }
  } catch (error) {
    if (!(error instanceof Thrown)) throw error;
    if (error.localEdits) {
      step('detach_run');
      decision = { action: 'none', status: 'error', summary: 'local_edits' };
    } else {
      const cancelled = scenario.cancelAborted && !scenario.stopped;
      if (!cancelled) step('detach_run');
      decision = legacyException({ ask: scenario.ask, cancelAborted: scenario.cancelAborted, stopped: scenario.stopped, status: scenario.status });
      if (decision.action === 'revert') step('revert_run');
    }
  }
  step('build_finished', 'settle', 'announce_finished');
  return { steps, phases, status: decision.status, summary: decision.summary };
}
