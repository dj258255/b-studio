import { native, type NativeSessionState } from '@b-studio/sandbox';

/**
 * 요청 실행(`execute`)의 끝 결정과 단계 순서(ADR-208, 4f B3b). 순서·판정·점유 단계 바꾸기와 풀기는 Rust `crates/bstudio-session`의 `outcome`이 하고,
 * 여기는 단계마다 부수 효과(앞 단계·계획 요약·러너·체크포인트 저장·되돌리기·알림·끝 알림)를 TS 콜백으로 잇는 껍데기다. 옛 `execute`의 판정은
 * 지웠다(#1347).
 *
 * 콜백은 던지지 않고 사실(`RunReply`)을 돌려준다(Rust가 부르는 콜백이 던지면 Node가 경고한다, 트러블슈팅 210). 던진 오류 객체는 `onError`로 받아 껍데기 쪽이 쥔다.
 * 어느 단계든 실패하면 코어는 이후 단계를 하지 않고 예외 경로로 간다.
 */

/** 단계 이름. 순서는 Rust `RUN_STEPS`가 정한다 */
export type RunStep =
  | 'prepare_edits'
  | 'announce_edits'
  | 'plan_brief'
  | 'run_plan'
  | 'detach_run'
  | 'tally_run'
  | 'note_question'
  | 'probe_pending'
  | 'save_checkpoint'
  | 'after_save'
  | 'revert_after_mismatch'
  | 'revert_run'
  | 'revert_host_only'
  | 'notice_platform'
  | 'notice_kept'
  | 'build_finished'
  | 'settle'
  | 'announce_finished';

export type ResultState = 'done' | 'failed' | 'awaiting_input';

/** 단계가 돌려주는 사실. 신호(`cancelAborted`·`stopAborted`·`booted`·`local`)는 껍데기가 답을 만드는 순간에 채운다 */
export interface RunFacts {
  result?: ResultState;
  /** 시작 전 확인이 막았다 */
  preflight?: boolean;
  questionGatePassed?: boolean;
  platformFailure?: boolean;
  /** 러너가 돌아온 뒤 사용자·한도 취소 신호가 올라 있었다 */
  cancelRequested?: boolean;
  pending?: boolean;
  mismatch?: boolean;
  reverted?: boolean;
}

export interface RunSignals {
  cancelAborted: boolean;
  stopAborted: boolean;
  /** 샌드박스를 켠 세션이다(`bootPromise`) */
  booted: boolean;
  /** 내 폴더 세션이다 */
  local: boolean;
}

/** 단계마다의 콜백. 던지면 실패로 본다. `arg`는 코어가 넘기는 한 마디(되돌리기의 취소 여부, 끝 글의 종류 등) */
export type RunActions = Record<RunStep, (arg: string) => RunFacts | void | Promise<RunFacts | void>>;

export interface RunHooks {
  signals: () => RunSignals;
  /** 던진 오류를 받는다. `localEdits`는 `prepare_edits`가 `LocalEditsError`로 실패한 것이다 */
  isLocalEdits: (error: unknown) => boolean;
  onError: (error: unknown, step: RunStep) => void;
}

/** 요청 하나를 끝까지 돈다. 끝에서 이 실행의 표로 점유를 푼다 */
export async function runRequest(life: { native: NativeSessionState }, ask: boolean, ticket: number, actions: RunActions, hooks: RunHooks): Promise<void> {
  await life.native.runRequest(ask, ticket, async ({ step, arg }) => {
    const name = step as RunStep;
    const base = { ...hooks.signals() };
    const reply = (facts: RunFacts, ok: boolean, localEdits: boolean) => ({
      ok,
      localEdits,
      result: facts.result,
      preflight: facts.preflight === true,
      questionGatePassed: facts.questionGatePassed === true,
      platformFailure: facts.platformFailure === true,
      cancelRequested: facts.cancelRequested === true,
      cancelAborted: base.cancelAborted,
      stopAborted: base.stopAborted,
      booted: base.booted,
      local: base.local,
      pending: facts.pending === true,
      mismatch: facts.mismatch === true,
      reverted: facts.reverted === true,
    });
    try {
      const action = actions[name];
      if (!action) throw new Error(`알 수 없는 요청 단계입니다: ${step}`);
      const facts = (await action(arg)) ?? {};
      // 신호는 단계가 끝난 지금 값이다(단계 안에서 취소·멈춤이 올 수 있다)
      Object.assign(base, hooks.signals());
      return reply(facts, true, false);
    } catch (error) {
      hooks.onError(error, name);
      Object.assign(base, hooks.signals());
      return reply({}, false, hooks.isLocalEdits(error));
    }
  });
}

export interface RunNormalFacts {
  ask: boolean;
  result: ResultState;
  questionGatePassed: boolean;
  platformFailure: boolean;
  booted: boolean;
  status: string;
  local: boolean;
  stopped: boolean;
}

export interface RunExceptionFacts {
  ask: boolean;
  cancelled: boolean;
  stopped: boolean;
  booted: boolean;
  status: string;
}

export type RunAction = 'none' | 'save' | 'revert' | 'revert_host_only' | 'notice_platform' | 'notice_kept';
export type RunFinishedStatus = 'done' | 'failed' | 'awaiting_input' | 'error' | 'cancelled';
export type RunSummary = 'result' | 'preflight' | 'local_edits' | 'mismatch' | 'error' | 'cancelled' | 'cancelled_question' | 'cancelled_kept' | 'unverified';
export interface RunOutcome {
  action: RunAction;
  status: RunFinishedStatus;
  summary: RunSummary;
}

/** 결과가 나온 뒤의 판정(시험·진단용. 실행은 `runRequest`가 코어 안에서 같은 판정을 쓴다) */
export function decideNormal(facts: RunNormalFacts, pending: boolean): RunOutcome {
  return native.runOutcomeDecideNormal(facts, pending) as RunOutcome;
}

export function needsProbeNormal(facts: RunNormalFacts): boolean {
  return native.runOutcomeNeedsProbeNormal(facts);
}

export function decideException(facts: RunExceptionFacts, pending: boolean): RunOutcome {
  return native.runOutcomeDecideException(facts, pending) as RunOutcome;
}

export function needsProbeException(facts: RunExceptionFacts): boolean {
  return native.runOutcomeNeedsProbeException(facts);
}

/** 코어의 단계 이름 목록(순서대로) */
export function runSteps(): string[] {
  return native.runOutcomeSteps();
}
