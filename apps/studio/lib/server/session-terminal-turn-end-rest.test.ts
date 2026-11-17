import { AGENT_HOOK_EVENTS } from '@b-studio/sandbox';
import { afterAll, describe, expect, it } from 'vitest';
import {
  decideGateStage,
  decideSaveFailure,
  decideTurnEndError,
  gateDeadlineMs,
  landedState,
  savingAccepts,
  shouldReattach,
  type GateStageFacts,
  type GateStageStep,
  type HeadRead,
  type Landed,
} from './session-terminal-turn-end-rest';
import { legacyErrorClose, legacyGateStage, legacyLanded, legacySaveFailure, legacySavingAccepts, legacyShouldReattach, type LegacyGateStage } from './session-terminal-turn-end-rest-legacy';

/**
 * 차등 시험(ADR-217, 4f B5c): 코어의 턴 끝 나머지 판정을 옛 분기(`session-terminal-turn-end-rest-legacy.ts`)와 사실 조합 전체에서 견준다.
 * 다른 칸은 의도한 차이뿐이어야 하고, 그 목록을 이 파일이 고정한다. 의도한 차이는 모두 되돌리거나 닫는 쪽이어야 한다(여는 쪽으로 달라지는 칸은 확인한 사실이 있을 때뿐이다).
 */
const BOOLS = [false, true] as const;
const counts = { errorRows: 0, errorDiffPlatformStale: 0, errorDiffPlatformConfirmed: 0, errorDiffDeadline: 0, landedRows: 0, landedDiffUnknown: 0, saving: 0, reattach: 0, saveFailure: 0, stageRows: 0, stageDiffDeadline: 0 };
afterAll(() => console.log(`[session-terminal-turn-end-rest 차등] ${JSON.stringify(counts)}`));

describe('예외 경로 분류: 사실 조합 전체', () => {
  it('옛 분류와 같고, 다른 칸은 플랫폼 근거(표시 → 이번 오류)와 시간 상한뿐이다', () => {
    const landedValues: Landed[] = ['yes', 'no', 'unknown'];
    for (const stopped of BOOLS)
      for (const landed of landedValues)
        for (const runCancelled of BOOLS)
          for (const deadlineExceeded of BOOLS)
            for (const statusFailed of BOOLS)
              for (const bootFlag of BOOLS)
                for (const errorIsBootFailure of BOOLS) {
                  const row = { stopped, landed, runCancelled, deadlineExceeded, statusFailed, bootFlag, errorIsBootFailure };
                  const got = decideTurnEndError({ stopped, landed, runCancelled, deadlineExceeded, bootPlatformFailure: errorIsBootFailure && bootFlag });
                  const old = legacyErrorClose({ stopped, landed: landed === 'yes', runCancelled, statusFailed, bootFlag });
                  counts.errorRows += 1;
                  const name = got.kind === 'failure' ? 'failure' : got.kind;
                  if (name === old) continue;
                  // 의도한 차이 1: 시간 상한(옛 코드에는 없었다). 멈춤·남은 체크포인트·취소가 먼저이고, 상한은 플랫폼 실패·오류 앞이다. 닫고 되돌리는 쪽이다
                  if (got.kind === 'deadline') {
                    expect(deadlineExceeded, JSON.stringify(row)).toBe(true);
                    expect(stopped || landed === 'yes' || runCancelled, JSON.stringify(row)).toBe(false);
                    expect(['platform', 'failure'], JSON.stringify(row)).toContain(old);
                    counts.errorDiffDeadline += 1;
                    continue;
                  }
                  // 의도한 차이 2: 플랫폼 실패의 근거. 옛 코드는 세션 표시(status failed + 표시)로, 새 코드는 이번 오류가 켜기 실패인지로 알아본다
                  if (old === 'platform' && got.kind === 'failure') {
                    // 표시만 남은 세션의 코드 탓 오류: 되돌리는 쪽으로 바뀐다
                    expect(errorIsBootFailure && bootFlag, JSON.stringify(row)).toBe(false);
                    counts.errorDiffPlatformStale += 1;
                    continue;
                  }
                  if (old === 'failure' && got.kind === 'platform') {
                    // 되돌리지 않는 쪽으로 바뀌는 칸은 확인한 사실(이번 오류가 켜기 실패이고 플랫폼 쪽)이 있을 때뿐이다
                    expect(errorIsBootFailure && bootFlag, JSON.stringify(row)).toBe(true);
                    expect(statusFailed && bootFlag, JSON.stringify(row)).toBe(false);
                    counts.errorDiffPlatformConfirmed += 1;
                    continue;
                  }
                  throw new Error(`의도하지 않은 차이: ${JSON.stringify(row)} 옛 ${old} 새 ${got.kind}`);
                }
    expect(counts.errorRows).toBe(3 * 2 ** 6);
    expect(counts.errorDiffDeadline).toBeGreaterThan(0);
    expect(counts.errorDiffPlatformStale).toBeGreaterThan(0);
    expect(counts.errorDiffPlatformConfirmed).toBeGreaterThan(0);
  });

  it('남은 체크포인트를 읽지 못한 칸은 오류로 닫는다(남았다고 보지 않는다): 옛 코드와 같은 닫힘이고 확인하지 못했다는 표시만 더한다', () => {
    const got = decideTurnEndError({ stopped: false, landed: 'unknown', runCancelled: false, deadlineExceeded: false, bootPlatformFailure: false });
    expect(got).toEqual({ kind: 'failure', landedUnknown: true });
    expect(decideTurnEndError({ stopped: false, landed: 'no', runCancelled: false, deadlineExceeded: false, bootPlatformFailure: false })).toEqual({ kind: 'failure', landedUnknown: false });
  });

  it('남은 체크포인트는 취소·플랫폼 실패·시간 상한보다 먼저, 멈춤보다는 나중이다', () => {
    const base = { stopped: false, landed: 'yes' as const, runCancelled: true, deadlineExceeded: true, bootPlatformFailure: true };
    expect(decideTurnEndError(base)).toEqual({ kind: 'keep_landed' });
    expect(decideTurnEndError({ ...base, stopped: true })).toEqual({ kind: 'stopped' });
  });
});

describe('남은 체크포인트 알아보기: 사실 조합 전체', () => {
  it('옛 판정과 같고, 읽지 못한 칸만 `unknown`이다(옛 판정은 없음으로 닫았다)', () => {
    const heads: HeadRead[] = [{ kind: 'empty' }, { kind: 'sha', sha: 'a' }, { kind: 'sha', sha: 'b' }, { kind: 'failed' }];
    for (const committed of [undefined, 'a'])
      for (const head of heads) {
        const got = landedState(committed, head);
        const old = legacyLanded(committed, head);
        counts.landedRows += 1;
        expect(got === 'yes', JSON.stringify({ committed, head })).toBe(old);
        if (got === 'unknown') {
          // 커밋했는데 읽지 못한 칸뿐이다
          expect(committed !== undefined && head.kind === 'failed').toBe(true);
          counts.landedDiffUnknown += 1;
        }
      }
    expect(counts.landedRows).toBe(8);
    expect(counts.landedDiffUnknown).toBe(1);
  });
});

describe('저장 중 실행·다시 붙이기·저장 실패의 갈 곳', () => {
  it('옛 조건과 사실 조합 전체가 같다', () => {
    for (const has of BOOLS)
      for (const attached of BOOLS)
        for (const closed of BOOLS) {
          expect(savingAccepts(has, attached, closed)).toBe(legacySavingAccepts(has, attached, closed));
          counts.saving += 1;
        }
    for (const has of BOOLS)
      for (const closed of BOOLS) {
        expect(shouldReattach(has, closed)).toBe(legacyShouldReattach(has, closed));
        counts.reattach += 1;
      }
    for (const kind of ['head_moved', 'staged_mismatch', 'other'] as const) {
      expect(decideSaveFailure(kind)).toBe(legacySaveFailure(kind));
      counts.saveFailure += 1;
    }
  });
});

describe('게이트 밖 사유', () => {
  type Read = 'rejected' | 'gate' | 'moved' | 'done_tests';
  interface Row {
    pauseFailed: boolean;
    rejected: boolean;
    gate: 'pass' | 'retry' | 'exhausted';
    moved: boolean;
    doneTestsFailed: boolean;
  }
  /** TS가 하는 것처럼 코어가 읽으라는 칸을 표에서 채우며 끝 결정까지 돈다. `deadlineAfter`번째 읽기 뒤에 상한이 지난다(없으면 지나지 않는다) */
  function run(row: Row, deadlineAfter?: number): { step: GateStageStep; reads: Read[] } {
    const facts: GateStageFacts = { deadlineExceeded: false, pauseFailed: row.pauseFailed, rejected: 'unread', gate: 'unread', moved: 'unread', doneTests: 'unread' };
    const reads: Read[] = [];
    for (;;) {
      const step = decideGateStage(facts);
      const read = (kind: Read, fill: () => void): void => {
        reads.push(kind);
        fill();
        if (deadlineAfter !== undefined && reads.length >= deadlineAfter) facts.deadlineExceeded = true;
      };
      switch (step.kind) {
        case 'need_rejected':
          read('rejected', () => (facts.rejected = row.rejected ? 'found' : 'clear'));
          continue;
        case 'need_gate':
          read('gate', () => (facts.gate = row.gate));
          continue;
        case 'need_moved':
          read('moved', () => (facts.moved = row.moved ? 'found' : 'clear'));
          continue;
        case 'need_done_tests':
          read('done_tests', () => (facts.doneTests = row.doneTestsFailed ? 'found' : 'clear'));
          continue;
        default:
          return { step, reads };
      }
    }
  }
  const toLegacyName = (step: GateStageStep): LegacyGateStage | 'deadline' | 'unknown' => {
    if (step.kind === 'pass') return 'pass';
    if (step.kind === 'deadline') return 'deadline';
    if (step.kind === 'gate') return step.result === 'unknown' ? 'unknown' : step.result;
    if (step.kind === 'unsettled') return ({ pause_failed: 'unsettled_pause', rejected: 'unsettled_rejected', moved: 'unsettled_moved', done_tests_failed: 'unsettled_done_tests' } as const)[step.reason];
    return 'unknown';
  };
  /** 옛 코드가 읽은 순서(읽지 않은 칸은 읽지 않았다) */
  function legacyReads(row: Row): Read[] {
    if (row.pauseFailed) return [];
    const reads: Read[] = ['rejected'];
    if (row.rejected) return reads;
    reads.push('gate');
    if (row.gate !== 'pass') return reads;
    reads.push('moved');
    if (row.moved) return reads;
    reads.push('done_tests');
    return reads;
  }

  it('시간 상한이 없으면 옛 판정과 사실 조합 전체가 같고 읽는 순서도 같다', () => {
    for (const pauseFailed of BOOLS)
      for (const rejected of BOOLS)
        for (const gate of ['pass', 'retry', 'exhausted'] as const)
          for (const moved of BOOLS)
            for (const doneTestsFailed of BOOLS) {
              const row: Row = { pauseFailed, rejected, gate, moved, doneTestsFailed };
              const got = run(row);
              counts.stageRows += 1;
              expect(toLegacyName(got.step), JSON.stringify(row)).toBe(legacyGateStage(row));
              expect(got.reads, JSON.stringify(row)).toEqual(legacyReads(row));
            }
    expect(counts.stageRows).toBe(2 * 2 * 3 * 2 * 2);
  });

  it('시간 상한이 지나면 어느 칸에서든 통과가 아니다: 상한 전에 통과가 확정된 칸은 없고, 상한 뒤에 끝난 결과는 쓰지 않는다', () => {
    for (const pauseFailed of BOOLS)
      for (const rejected of BOOLS)
        for (const gate of ['pass', 'retry', 'exhausted'] as const)
          for (const moved of BOOLS)
            for (const doneTestsFailed of BOOLS)
              for (const deadlineAfter of [1, 2, 3, 4]) {
                const row: Row = { pauseFailed, rejected, gate, moved, doneTestsFailed };
                const got = run(row, deadlineAfter);
                const old = legacyGateStage(row);
                const total = legacyReads(row).length;
                // 상한이 읽는 도중이나 마지막 읽기 직후에 지났으면 상한으로 끝난다(판정은 상한을 먼저 본다). 읽을 것이 남지 않았거나 상한이 더 늦으면 옛 판정과 같다
                if (deadlineAfter <= total) {
                  expect(toLegacyName(got.step), JSON.stringify({ row, deadlineAfter })).toBe('deadline');
                  counts.stageDiffDeadline += 1;
                } else {
                  expect(toLegacyName(got.step), JSON.stringify({ row, deadlineAfter })).toBe(old);
                }
                expect(toLegacyName(got.step) === 'pass', JSON.stringify({ row, deadlineAfter })).toBe(false);
              }
    expect(counts.stageDiffDeadline).toBeGreaterThan(0);
  });

  it('알아보지 못한 글은 닫는 쪽으로 읽는다', () => {
    // 읽지 않은 칸을 채우지 않고 끝 결정을 요구하면 통과가 될 수 없다
    expect(decideGateStage({ deadlineExceeded: false, pauseFailed: false, rejected: 'clear', gate: 'pass', moved: 'clear', doneTests: 'unread' }).kind).toBe('need_done_tests');
    expect(decideGateStage({ deadlineExceeded: false, pauseFailed: false, rejected: 'bogus' as 'found', gate: 'pass', moved: 'clear', doneTests: 'clear' })).toEqual({ kind: 'unsettled', reason: 'rejected' });
    expect(decideGateStage({ deadlineExceeded: false, pauseFailed: false, rejected: 'clear', gate: 'bogus' as 'pass', moved: 'clear', doneTests: 'clear' })).toEqual({ kind: 'gate', result: 'unknown' });
  });
});

describe('게이트 시간 상한', () => {
  it('Stop 훅 상한(초)보다 300초 앞이다', () => {
    expect(gateDeadlineMs(AGENT_HOOK_EVENTS.stop)).toBe((AGENT_HOOK_EVENTS.stop - 300) * 1000);
    expect(gateDeadlineMs(AGENT_HOOK_EVENTS.stop)).toBeLessThan(AGENT_HOOK_EVENTS.stop * 1000);
    // 훅 상한이 여유보다 짧아도 0이 되지 않는다
    expect(gateDeadlineMs(100)).toBeGreaterThan(0);
  });
});
