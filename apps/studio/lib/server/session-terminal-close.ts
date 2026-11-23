import { native, type NativeSessionState } from '@b-studio/sandbox';

/**
 * 세션 터미널 실행의 닫기·열린 실행·CLI 종료·위반 갈 곳(ADR-210, 4f B4a). 판정과 순서·점유 풀기는 Rust `crates/bstudio-session`의 `terminal`이 하고,
 * 여기는 단계마다 부수 효과(되돌리기·알림·끝 글 조립·떼기·끝 알림)를 TS 콜백으로 잇는 껍데기다. 옛 판정은 지웠다(#1347).
 *
 * 닫기는 두 번에 나뉜다. `beginTerminalClose`가 **동기**로 한 번만 닫기를 시작하고(그 순간부터 열린 실행이 아니다), 부른 쪽이 그 실행의 중단 신호를 끊은 뒤
 * `runTerminalClose`가 단계를 차례로 돈다. 콜백은 던지지 않는다(던지면 `onError`로 받고 코어는 끝까지 가서 점유를 푼다. Rust가 부르는 콜백이 던지면 Node가 경고한다, 트러블슈팅 210).
 */

export type CloseEndStatus = 'failed' | 'cancelled' | 'error';
export type CloseFinishedStatus = 'done' | 'failed' | 'awaiting_input' | 'error' | 'cancelled';
export type CloseAction = 'none' | 'revert' | 'revert_host_only' | 'notice_platform' | 'notice_kept';
/** 끝 글의 종류. 글 조립은 TS가 한다 */
export type CloseText = 'stopped' | 'platform_kept' | 'kept' | 'reverted' | 'cancelled_report' | 'settled';

export interface CloseFacts {
  status: CloseEndStatus;
  /** 세션이 멈추는 중이다(멈춤 신호) */
  stopping: boolean;
  /** 샌드박스·도커 쪽 문제로 검증하지 못했다는 글이 있다 */
  platformFailure: boolean;
  /** 내 폴더 세션이다 */
  local: boolean;
  /** 세션 상태가 `ready`다 */
  ready: boolean;
  /** 샌드박스를 켠 적 있다(`bootPromise`) */
  booted: boolean;
  /** 사유 글이 있다 */
  hasReason: boolean;
}

export interface CloseDecision {
  action: CloseAction;
  status: CloseFinishedStatus;
  text: CloseText;
}

export type CloseInput = { kind: 'abandon'; facts: CloseFacts } | { kind: 'settle'; status: CloseFinishedStatus };

/** 닫기의 단계 이름. 순서는 Rust `CLOSE_STEPS`가 정한다 */
export type CloseStep = 'revert_run' | 'revert_host_only' | 'notice_platform' | 'build_summary' | 'detach_run' | 'announce_run';

export type CloseActions = Record<CloseStep, (arg: string) => void | Promise<void>>;

type Life = { native: NativeSessionState };

/** 통과하지 못한 채 닫을 때의 판정(시험·진단용. 실행은 `beginTerminalClose`가 코어 안에서 같은 판정을 쓴다) */
export function decideClose(facts: CloseFacts): CloseDecision {
  return native.terminalDecideClose({ kind: 'abandon', ...facts }) as CloseDecision;
}

/** 코어의 닫기 단계 이름 목록(순서대로) */
export function closeSteps(): string[] {
  return native.terminalCloseSteps();
}

/** 지금 열린 터미널 실행인가: 점유가 이 표이고 단계가 `진행`이며 닫기를 시작하지 않았다 */
export function terminalRunOpen(life: Life, ticket: number): boolean {
  return life.native.terminalRunOpen(ticket);
}

/** 닫기를 시작한 실행인가(모르는 표도 닫힌 것이다) */
export function terminalRunClosed(life: Life, ticket: number): boolean {
  return life.native.terminalRunClosed(ticket);
}

/** 닫기를 시작한다. 처음 부른 호출에만 할 일을 돌려준다(이미 닫았으면 `undefined`) */
export function beginTerminalClose(life: Life, ticket: number, input: CloseInput): CloseDecision | undefined {
  const facts =
    input.kind === 'abandon'
      ? { kind: 'abandon' as const, ...input.facts }
      : { kind: 'settle' as const, status: input.status, stopping: false, platformFailure: false, local: false, ready: false, booted: false, hasReason: false };
  return (life.native.terminalCloseBegin(ticket, facts) ?? undefined) as CloseDecision | undefined;
}

/** 닫기의 단계를 코어가 정한 순서로 돈다. 끝에서(끝 알림 앞에서) 이 실행의 표로 점유를 푼다 */
export async function runTerminalClose(life: Life, ticket: number, actions: CloseActions, onError: (error: unknown, step: CloseStep) => void): Promise<void> {
  await life.native.terminalCloseRun(ticket, async ({ step, arg }) => {
    const name = step as CloseStep;
    try {
      const action = actions[name];
      if (!action) throw new Error(`알 수 없는 닫기 단계입니다: ${step}`);
      await action(arg);
      return null;
    } catch (error) {
      onError(error, name);
      return error instanceof Error ? error.message : String(error);
    }
  });
}

export type CliEndedAction = 'nothing' | 'defer' | 'failed' | 'cancelled' | 'error';

/** CLI가 끝났다. 열린 실행이 없으면 `nothing`, 검사 중이면 미룬다는 표시를 실행에 남기고 `defer`, 아니면 닫을 끝 상태다 */
export function cliEnded(life: Life, ticket: number, checking: boolean, hasFeedback: boolean): CliEndedAction {
  return life.native.terminalCliEnded(ticket, checking, hasFeedback) as CliEndedAction;
}

/**
 * 턴이 API 오류로 끝났다(StopFailure). 열린 실행이 없으면 `nothing`, 검사 중이면 미룬다는 표시를 실행에 남기고 `defer`, 아니면 `failed`다.
 * 피드백이 있었는지와 상관없이 취소가 아니라 실패로 닫는다(오류로 끊긴 턴은 일을 마친 것이 아니다)
 */
export function turnFailed(life: Life, ticket: number, checking: boolean): Extract<CliEndedAction, 'nothing' | 'defer' | 'failed'> {
  return life.native.terminalTurnFailed(ticket, checking) as 'nothing' | 'defer' | 'failed';
}

/** 검사가 재시도(피드백)로 끝났다. CLI 종료를 미뤄 둔 실행이면 `close_failed`(받을 CLI가 없다) */
export function retryRoute(life: Life, ticket: number): 'feedback' | 'close_failed' {
  return life.native.terminalRetry(ticket) as 'feedback' | 'close_failed';
}

/** 감시가 위반을 찾았다. 열린 실행이 있으면 닫고, 없으면 담아 두며, 멈추는 중이거나 멈춘 세션이면 버린다 */
export function violationRoute(life: Life, ticket: number, alive: boolean): 'ignore' | 'close_open_run' | 'defer' {
  return life.native.terminalViolationRoute(ticket, alive) as 'ignore' | 'close_open_run' | 'defer';
}
