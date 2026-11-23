import { native } from '@b-studio/sandbox';
import { afterAll, describe, expect, it } from 'vitest';
import {
  beginTerminalClose,
  cliEnded,
  closeSteps,
  decideClose,
  retryRoute,
  runTerminalClose,
  terminalRunClosed,
  terminalRunOpen,
  violationRoute,
  type CloseActions,
  type CloseEndStatus,
  type CloseFacts,
  type CloseStep,
} from './session-terminal-close';
import { frozenModule, loadTable } from './frozen-vectors';

// 아래 `legacy*`는 옛 TS가 낸 값을 JSON에서 꺼내는 껍데기다(옛 TS 파일은 지웠다). 같은 입력은 같은 값을 돌려준다.
const FROZEN = loadTable(new URL('./session-terminal-close-vectors.json', import.meta.url));
const { legacyCliEnded, legacyClose, legacyOpen, legacyRetry, legacyViolationRoute } = frozenModule(FROZEN, 'session-terminal-close-legacy:');

/**
 * 세션 터미널 실행의 닫기·열린 실행·CLI 종료·위반 갈 곳(ADR-210, 4f B4a): Rust `terminal`을 옛 규칙이 같은 사실에 낸 값(`session-terminal-close-vectors.json`에 입력별로 고정)과 견준다.
 * 같은 할 일·끝 상태·글의 종류·갈 곳을 낸다. 다른 것은 아래 "의도한 차이" 칸들뿐이고 목록으로 고정한다.
 */
const counts = { close: 0, cliEnded: 0, retry: 0, violation: 0, openSequences: 0, dOpen: 0, dRetry: 0 };
const SEQUENCES = 583;
const DIFFERENT = 7;
afterAll(() => console.log(`[session-terminal-close 벡터] ${JSON.stringify(counts)}`));

type Life = { native: InstanceType<typeof native.SessionState> };
const fresh = (): Life => ({ native: new native.SessionState('idle') });

const END: CloseEndStatus[] = ['failed', 'cancelled', 'error'];
const bools = [false, true];

describe('닫기의 단계 이름과 순서', () => {
  it('코어가 정한 목록이다', () => {
    expect(closeSteps()).toEqual(['revert_run', 'revert_host_only', 'notice_platform', 'build_summary', 'detach_run', 'announce_run']);
  });
});

describe('닫기 판정: 사실 조합 전체', () => {
  it('옛 `abandonTerminalRun`의 분기와 같은 할 일·끝 상태·글의 종류다(닫을 때 중단 신호를 끊는 것만 다르다)', () => {
    for (const status of END) for (const stopping of bools) for (const platformFailure of bools) for (const local of bools) for (const ready of bools) for (const booted of bools) for (const hasReason of bools) {
      const facts: CloseFacts = { status, stopping, platformFailure, local, ready, booted, hasReason };
      const old = legacyClose(facts);
      const got = decideClose(facts);
      counts.close += 1;
      expect(got, JSON.stringify(facts)).toEqual({ action: old.action, status: old.status, text: old.text });
      // 의도한 차이 D1(결함 1): 옛 닫기는 중단 신호를 끊지 않았다. 새 닫기는 늘 끊는다(sessions-terminal-close.test.ts가 잡는다)
      expect(old.aborts).toBe(false);
    }
    expect(counts.close).toBe(192);
  });

  it('핵심 칸: 샌드박스 쪽 실패는 상태보다 먼저 본다, 켠 적 없는 세션은 작업 복사본만 되돌린다, 멈추는 중이면 되돌리지 않는다', () => {
    const base: CloseFacts = { status: 'failed', stopping: false, platformFailure: false, local: false, ready: true, booted: true, hasReason: true };
    expect(decideClose({ ...base, platformFailure: true, ready: false }).action).toBe('notice_platform');
    expect(decideClose({ ...base, platformFailure: true, local: true, ready: false }).action).toBe('notice_kept');
    expect(decideClose({ ...base, booted: false, ready: false }).action).toBe('revert_host_only');
    expect(decideClose({ ...base, stopping: true }).action).toBe('none');
    expect(decideClose({ ...base, stopping: true }).status).toBe('cancelled');
  });
});

describe('CLI 종료와 위반의 갈 곳: 사실 조합 전체', () => {
  it('열린 실행이 없거나 검사 중이면 아무것도 닫지 않고, 피드백이 있었으면 실패·없으면 취소로 닫는다', () => {
    for (const open of bools) for (const checking of bools) for (const hasFeedback of bools) {
      const life = fresh();
      const ticket = open ? (life.native.beginTerminalRun('t').token as number) : 0;
      const got = cliEnded(life, ticket, checking, hasFeedback);
      const old = legacyCliEnded({ open, checking, hasFeedback });
      counts.cliEnded += 1;
      expect(got).toBe(old);
    }
    expect(counts.cliEnded).toBe(8);
  });

  it('의도한 차이 D2(의심 2): 검사 중에 받은 CLI 종료는 표시를 남기고, 검사가 재시도로 끝나면 피드백 대신 실패로 닫는다', () => {
    for (const marked of bools) {
      const life = fresh();
      const ticket = life.native.beginTerminalRun('t').token as number;
      expect(retryRoute(life, ticket)).toBe('feedback');
      if (marked) expect(cliEnded(life, ticket, true, true)).toBe('defer');
      const got = retryRoute(life, ticket);
      const old = legacyRetry();
      counts.retry += 1;
      if (got === old) continue;
      expect(marked).toBe(true);
      expect([old, got]).toEqual(['feedback', 'close_failed']);
      counts.dRetry += 1;
    }
    expect(counts.retry).toBe(2);
    expect(counts.dRetry).toBe(1);
  });

  it('위반: 멈추는 중이면 버리고 열린 실행이 있으면 닫고 없으면 담아 둔다', () => {
    for (const alive of bools) for (const open of bools) {
      const life = fresh();
      const ticket = open ? (life.native.beginTerminalRun('t').token as number) : 0;
      counts.violation += 1;
      expect(violationRoute(life, ticket, alive)).toBe(legacyViolationRoute({ alive, open }));
    }
    expect(counts.violation).toBe(4);
  });
});

describe('열린 실행 판정은 코어 하나다', () => {
  type Op = 'begin' | 'cancel_user' | 'budget' | 'detach' | 'reattach' | 'close' | 'announce';
  const OPS: Op[] = ['begin', 'cancel_user', 'budget', 'detach', 'reattach', 'close', 'announce'];

  interface Model {
    attached: boolean;
    settled: boolean;
    aborted: boolean;
    /** 저장 중(`session.run`을 뗀 동안)에 한도 중단 신호가 올랐다 */
    abortedWhileDetached: boolean;
  }

  /** 옛 `session.run`·`settled`·`cancel.aborted`를 그 실행의 흐름대로 흉내 낸다(`sessions.ts`의 취소·한도·떼기·다시 열기·닫기·알림) */
  function applyOp(op: Op, life: Life, ticketRef: { ticket: number; runId: string }, model: Model): boolean {
    switch (op) {
      case 'begin': {
        if (ticketRef.ticket !== 0) return false;
        const claimed = life.native.beginTerminalRun('t1');
        if (claimed.fail) return false;
        ticketRef.ticket = claimed.token as number;
        ticketRef.runId = 't1';
        Object.assign(model, { attached: true, settled: false, aborted: false, abortedWhileDetached: false });
        return true;
      }
      case 'cancel_user': {
        if (ticketRef.ticket === 0) return false;
        const result = life.native.cancelRun(ticketRef.runId);
        // 거절(저장 중·실행 없음)이거나 이미 취소 중이면 중단 신호를 올리지 않는다. `session.run`이 있을 때만 올린다
        if (result.fail || result.outcome === 'already') return true;
        if (model.attached) model.aborted = true;
        return true;
      }
      case 'budget': {
        if (ticketRef.ticket === 0 || model.aborted) return false;
        // 터미널 한도 중단: 단계를 `취소 중`으로(안 되면 그대로) 바꾸고 중단 신호를 올린다
        life.native.setPhase(ticketRef.ticket, 'cancelling');
        model.aborted = true;
        if (!model.attached) model.abortedWhileDetached = true;
        return true;
      }
      case 'detach': {
        // 게이트를 통과해 저장 단계로 넘어간다. 취소 신호가 오른 실행은 이 길에 오지 않는다(게이트 뒤에서 던진다)
        if (ticketRef.ticket === 0 || model.aborted || model.settled || !model.attached) return false;
        model.attached = false;
        life.native.setPhase(ticketRef.ticket, 'saving');
        return true;
      }
      case 'reattach': {
        if (ticketRef.ticket === 0 || model.attached || model.settled) return false;
        if (life.native.setPhase(ticketRef.ticket, 'running')) model.attached = true;
        return true;
      }
      case 'close': {
        if (ticketRef.ticket === 0) return false;
        const decision = beginTerminalClose(life, ticketRef.ticket, { kind: 'settle', status: 'done' });
        if (decision) model.settled = true;
        return true;
      }
      case 'announce': {
        if (ticketRef.ticket === 0 || !model.settled) return false;
        model.attached = false;
        life.native.release(ticketRef.ticket);
        return true;
      }
    }
  }

  it('옛 `session.run && !settled && !cancel.aborted`와 같은 답이다. 다른 칸은 저장 중에 올라온 한도 중단 신호가 다시 열린 실행에 남은 칸뿐이다', () => {
    // 길이 6까지의 연산 열을 모두 돈다. 적용할 수 없는 연산이 든 열은 거기서 자른다(그 열의 확장도 없다). 열마다 마지막 연산 뒤의 답을 견준다
    const walk = (prefix: Op[]): void => {
      const life = fresh();
      const ticketRef = { ticket: 0, runId: '' };
      const model: Model = { attached: false, settled: false, aborted: false, abortedWhileDetached: false };
      for (const op of prefix) if (!applyOp(op, life, ticketRef, model)) return;
      counts.openSequences += 1;
      const old = legacyOpen({ attached: model.attached, settled: model.settled, cancelAborted: model.aborted });
      const got = terminalRunOpen(life, ticketRef.ticket);
      if (old !== got) {
        // 의도한 차이 D3: 저장 중에 한도 중단 신호가 올랐다가 다시 열린 실행. 옛 판정은 신호가 올라 있어 닫힌 것으로, 새 판정은 단계가 `진행`이라 열린 것으로 본다.
        // 다시 열린 실행은 게이트 앞에서 신호를 보고 취소로 닫는다(sessions.ts `finishTerminalTurn`)
        expect({ prefix, old, got, abortedWhileDetached: model.abortedWhileDetached }).toEqual({ prefix, old: false, got: true, abortedWhileDetached: true });
        counts.dOpen += 1;
      }
      if (prefix.length < 6) for (const op of OPS) walk([...prefix, op]);
    };
    for (const op of OPS) walk([op]);
    // 칸의 수를 고정한다(연산을 빼거나 판정을 바꾸는 변경도 잡는다)
    expect(counts.openSequences).toBe(SEQUENCES);
    expect(counts.dOpen).toBe(DIFFERENT);
  });

  it('닫기를 시작한 순간부터 열린 실행이 아니고, 모르는 표와 앞 실행의 표는 닫힌 것이다', () => {
    const life = fresh();
    const first = life.native.beginTerminalRun('t1').token as number;
    expect(terminalRunOpen(life, first)).toBe(true);
    expect(terminalRunClosed(life, first)).toBe(false);
    expect(beginTerminalClose(life, first, { kind: 'settle', status: 'done' })).toBeDefined();
    expect(terminalRunOpen(life, first)).toBe(false);
    expect(terminalRunClosed(life, first)).toBe(true);
    expect(beginTerminalClose(life, first, { kind: 'settle', status: 'done' })).toBeUndefined();
    life.native.release(first);
    const second = life.native.beginTerminalRun('t2').token as number;
    expect(terminalRunClosed(life, first)).toBe(true);
    expect(terminalRunOpen(life, second)).toBe(true);
    expect(terminalRunClosed(life, 999)).toBe(true);
  });
});

describe('닫기의 순서와 점유 풀기(코어를 거쳐 TS 콜백으로)', () => {
  const noop = (): void => {};
  function recorder(trace: string[], life: Life, extra: Partial<CloseActions> = {}): CloseActions {
    const steps: CloseStep[] = ['revert_run', 'revert_host_only', 'notice_platform', 'build_summary', 'detach_run', 'announce_run'];
    return Object.fromEntries(
      steps.map((step) => [
        step,
        extra[step] ??
          ((arg: string) => {
            trace.push(`${step}(${arg})${life.native.busy ? '' : ':풀림'}`);
          }),
      ]),
    ) as CloseActions;
  }

  it('되돌린 뒤 끝 글을 만들고 떼고, 표로 점유를 푼 다음 끝 알림을 낸다', async () => {
    const life = fresh();
    const ticket = life.native.beginTerminalRun('t').token as number;
    const facts: CloseFacts = { status: 'cancelled', stopping: false, platformFailure: false, local: false, ready: true, booted: true, hasReason: false };
    expect(beginTerminalClose(life, ticket, { kind: 'abandon', facts })).toEqual({ action: 'revert', status: 'cancelled', text: 'cancelled_report' });
    const trace: string[] = [];
    await runTerminalClose(life, ticket, recorder(trace, life), noop);
    expect(trace).toEqual(['revert_run(cancelled)', 'build_summary(cancelled_report)', 'detach_run()', 'announce_run(cancelled):풀림']);
    expect(life.native.busy).toBe(false);
  });

  it('단계가 던져도(콜백이 실패를 돌려줘도) 끝까지 가서 점유를 풀고 끝 알림을 낸다', async () => {
    const life = fresh();
    const ticket = life.native.beginTerminalRun('t').token as number;
    const facts: CloseFacts = { status: 'failed', stopping: false, platformFailure: true, local: false, ready: true, booted: true, hasReason: true };
    beginTerminalClose(life, ticket, { kind: 'abandon', facts });
    const trace: string[] = [];
    const errors: string[] = [];
    await runTerminalClose(
      life,
      ticket,
      recorder(trace, life, {
        notice_platform: () => {
          throw new Error('알림을 받는 쪽이 던졌습니다');
        },
        build_summary: () => {
          throw new Error('끝 글을 만들다 던졌습니다');
        },
      }),
      (error, step) => errors.push(`${step}:${(error as Error).message}`),
    );
    expect(errors).toEqual(['notice_platform:알림을 받는 쪽이 던졌습니다', 'build_summary:끝 글을 만들다 던졌습니다']);
    expect(trace).toEqual(['detach_run()', 'announce_run(failed):풀림']);
    expect(life.native.busy).toBe(false);
  });
});
