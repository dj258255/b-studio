import { describe, expect, it } from 'vitest';
import {
  decideAfterCheckpoint,
  decideGateOutcome,
  decideTurnEnd,
  type CardCheck,
  type FingerprintCheck,
  type GateFacts,
  type GateKind,
  type TurnEndFacts,
  type TurnEndStep,
  type UnchangedCheck,
} from './session-terminal-turn-end';
import { legacyGate, legacyTurnEnd, type LegacyTurnEndFacts } from './session-terminal-turn-end-legacy';

/**
 * 차등 시험(ADR-212, 4f B4c): 코어의 턴 끝 판정을 옛 분기 순서(`session-terminal-turn-end-legacy.ts`)와 사실 조합 전체에서 견준다.
 * 다른 칸은 의도한 차이뿐이어야 하고, 그 목록을 이 파일이 고정한다.
 * 판정은 읽지 않은 사실(`unread`)이 필요한 칸에서 `need_*`를 돌려주므로, 시험은 TS가 하는 것처럼 표에서 그 사실을 채워 가며 끝 결정까지 돈다.
 */
const BOOLS = [false, true] as const;

interface Row {
  closed: boolean;
  pendingViolation: boolean;
  violation: boolean;
  readOnly: boolean;
  readOnlyAfterWork: boolean;
  gitFailed: boolean;
  fingerprint: 'same' | 'different' | 'unknown';
  verification: boolean;
  unchanged: boolean;
  doneTests: boolean;
  hasCard: boolean;
  cardOutside: boolean;
  unsettledAttempts: number;
  gateAttempts: number;
}

const MAX = 3;

function* rows(gateAttemptValues: readonly number[]): Generator<Row> {
  for (const closed of BOOLS)
    for (const pendingViolation of BOOLS)
      for (const violation of BOOLS)
        for (const readOnly of BOOLS)
          for (const readOnlyAfterWork of BOOLS)
            for (const gitFailed of BOOLS)
              for (const fingerprint of ['same', 'different', 'unknown'] as const)
                for (const verification of BOOLS)
                  for (const unchanged of BOOLS)
                    for (const doneTests of BOOLS)
                      for (const hasCard of BOOLS)
                        for (const cardOutside of BOOLS)
                          for (const unsettledAttempts of [0, 1, 2, 3])
                            for (const gateAttempts of gateAttemptValues)
                              yield { closed, pendingViolation, violation, readOnly, readOnlyAfterWork, gitFailed, fingerprint, verification, unchanged, doneTests, hasCard, cardOutside, unsettledAttempts, gateAttempts };
}

const toLegacy = (row: Row): LegacyTurnEndFacts => ({
  closed: row.closed,
  pendingViolation: row.pendingViolation,
  violation: row.violation,
  readOnly: row.readOnly,
  readOnlyAfterWork: row.readOnlyAfterWork,
  gitFailed: row.gitFailed,
  fingerprint: row.fingerprint,
  verification: row.verification,
  unchanged: row.unchanged,
  doneTests: row.doneTests,
  hasCard: row.hasCard,
  cardOutside: row.cardOutside,
  unsettledAttempts: row.unsettledAttempts,
  maxAttempts: MAX,
});

/** TS가 하는 것처럼: 판정이 `need_*`를 돌려주면 표에서 그 사실을 채워 같은 판정을 다시 부른다. 읽은 순서도 돌려준다 */
function resolve(row: Row): { step: TurnEndStep; reads: string[] } {
  const facts: TurnEndFacts = {
    closed: row.closed,
    pendingViolation: row.pendingViolation,
    violation: row.violation,
    readOnly: row.readOnly,
    readOnlyAfterWork: row.readOnlyAfterWork,
    git: 'unread',
    fingerprint: 'unread',
    verification: row.verification,
    unchanged: 'unread',
    doneTests: row.doneTests,
    hasCard: row.hasCard,
    card: 'unread',
    unsettledAttempts: row.unsettledAttempts,
    gateAttempts: row.gateAttempts,
    maxAttempts: MAX,
  };
  const reads: string[] = [];
  for (let guard = 0; guard < 10; guard++) {
    const step = decideTurnEnd(facts);
    switch (step.kind) {
      case 'need_git':
        reads.push(step.allowUnwind ? 'git(unwind)' : 'git');
        facts.git = row.gitFailed ? 'failed' : 'aligned';
        // TS는 Git 맞추기가 실행을 닫았으면 닫힘·위반을 다시 보지 않는다(`turnEndFacts`의 ownClose). 표는 그 사실을 바꾸지 않는다
        break;
      case 'need_fingerprint':
        reads.push('fingerprint');
        facts.fingerprint = row.fingerprint as FingerprintCheck;
        break;
      case 'need_unchanged':
        reads.push('unchanged');
        facts.unchanged = (row.unchanged ? 'yes' : 'no') as UnchangedCheck;
        break;
      case 'need_card_scope':
        reads.push('card');
        facts.card = (row.cardOutside ? 'outside' : 'inside') as CardCheck;
        break;
      default:
        return { step, reads };
    }
  }
  throw new Error(`판정이 끝나지 않았습니다: ${JSON.stringify(row)}`);
}

const KIND: Record<string, string> = { read_only_fail: 'read_only_fail', read_only_done: 'read_only_done' };

function legacyOf(step: TurnEndStep): string {
  if (step.kind === 'read_only_fail') return step.unverified ? 'read_only_fail_unverified' : 'read_only_fail';
  return KIND[step.kind] ?? step.kind;
}

describe('턴 끝 판정(게이트 앞): 옛 순서와 사실 조합을 견준다', () => {
  it('의도한 차이 말고는 모든 조합이 같다', () => {
    let count = 0;
    const differing: Array<{ row: Row; old: string; got: string }> = [];
    for (const row of rows([0])) {
      count += 1;
      const old = legacyTurnEnd(toLegacy(row));
      const got = legacyOf(resolve(row).step);
      if (old !== got) differing.push({ row, old, got });
    }
    // 2^5(닫힘·미룬 위반·위반·읽기만·앞선 변경) × 2(Git) × 3(지문) × 2^5(기준·바뀐 것 없음·완료 검사·카드·범위 밖) × 4(재시도 셈)
    expect(count).toBe(32 * 2 * 3 * 32 * 4);
    // 의도한 차이 하나뿐이다: 읽기만이 앞선 변경이 있는 실행에 이어 켜졌다면 읽기만 지름길을 타지 않는다(S6).
    // 그 칸은 읽기만이 아닌 실행과 같이 판정한다(`읽기만 = 거짓`으로 옛 판정을 부른 것과 같다)
    for (const { row, old, got } of differing) {
      expect(row.readOnly && row.readOnlyAfterWork, JSON.stringify(row)).toBe(true);
      const asMaker = legacyTurnEnd({ ...toLegacy(row), readOnly: false });
      expect(got, JSON.stringify({ row, old })).toBe(asMaker);
    }
    // 읽기만이고 앞선 변경이 있으며 위반·닫힘·Git 실패가 없는 칸만 다르다. 그 칸에서 옛 판정은 읽기만 done/fail이었다
    for (const { old } of differing) expect(['read_only_done', 'read_only_fail', 'read_only_fail_unverified']).toContain(old);
    expect(differing.length).toBeGreaterThan(0);
    // 칸 수: 읽기만 + 앞선 변경 + (닫힘·미룬 위반·위반·Git 실패 없음) = 지문 3 × 기준·바뀐 것 없음·완료 검사·카드·범위 밖 32 × 재시도 셈 4 = 384칸에서,
    // 일반 판정이 옛 읽기만 판정과 우연히 같은 칸을 뺀 수. 일반 판정은 읽기만 판정(`read_only_*`)을 내지 않으므로 같은 칸은 없다
    expect(differing).toHaveLength(3 * 32 * 4);
  });

  it('읽기만 + 앞선 변경이어도 닫힘·미룬 위반·위반·Git 실패는 먼저 본다', () => {
    const base: Row = {
      closed: false,
      pendingViolation: false,
      violation: false,
      readOnly: true,
      readOnlyAfterWork: true,
      gitFailed: false,
      fingerprint: 'same',
      verification: true,
      unchanged: true,
      doneTests: false,
      hasCard: false,
      cardOutside: false,
      unsettledAttempts: 0,
      gateAttempts: 0,
    };
    expect(resolve({ ...base, closed: true }).step.kind).toBe('nothing');
    expect(resolve({ ...base, pendingViolation: true }).step.kind).toBe('fail_pending_violation');
    expect(resolve({ ...base, violation: true }).step.kind).toBe('fail_violation');
    expect(resolve({ ...base, gitFailed: true }).step.kind).toBe('git_failed');
    // 앞선 변경이 있으면 기준이 있고 바뀐 것 없음이어도 게이트로 간다
    expect(resolve(base).step.kind).toBe('run_gate');
  });

  it('읽는 순서: Git은 만들기·앞선 변경이 있는 읽기만이면 풀 수 있고, 읽기만은 풀지 않는다', () => {
    const base: Row = {
      closed: false,
      pendingViolation: false,
      violation: false,
      readOnly: false,
      readOnlyAfterWork: false,
      gitFailed: false,
      fingerprint: 'same',
      verification: false,
      unchanged: false,
      doneTests: false,
      hasCard: true,
      cardOutside: false,
      unsettledAttempts: 0,
      gateAttempts: 0,
    };
    expect(resolve(base).reads).toEqual(['git(unwind)', 'unchanged', 'card']);
    expect(resolve({ ...base, readOnly: true }).reads).toEqual(['git', 'fingerprint']);
    expect(resolve({ ...base, readOnly: true, readOnlyAfterWork: true }).reads).toEqual(['git(unwind)', 'unchanged', 'card']);
    // 위반이 있으면 아무것도 읽지 않는다
    expect(resolve({ ...base, violation: true }).reads).toEqual([]);
  });

  it('재지 못한 읽기만 지문은 통과가 아니다. 바뀐 것을 읽지 못해도 바뀐 것 없음으로 보지 않는다', () => {
    const facts: TurnEndFacts = {
      closed: false,
      pendingViolation: false,
      violation: false,
      readOnly: true,
      readOnlyAfterWork: false,
      git: 'aligned',
      fingerprint: 'unknown',
      verification: false,
      unchanged: 'unknown',
      doneTests: false,
      hasCard: false,
      card: 'inside',
      unsettledAttempts: 0,
      gateAttempts: 0,
      maxAttempts: MAX,
    };
    expect(decideTurnEnd(facts)).toEqual({ kind: 'read_only_fail', unverified: true });
    expect(decideTurnEnd({ ...facts, readOnly: false })).toEqual({ kind: 'run_gate' });
  });

  it('알아보지 못한 글 값은 닫는 쪽이다', () => {
    const base: TurnEndFacts = {
      closed: false,
      pendingViolation: false,
      violation: false,
      readOnly: false,
      readOnlyAfterWork: false,
      git: 'aligned',
      fingerprint: 'same',
      verification: false,
      unchanged: 'no',
      doneTests: false,
      hasCard: true,
      card: 'inside',
      unsettledAttempts: 0,
      gateAttempts: 0,
      maxAttempts: MAX,
    };
    expect(decideTurnEnd({ ...base, git: 'bogus' as never })).toEqual({ kind: 'git_failed' });
    expect(decideTurnEnd({ ...base, readOnly: true, fingerprint: 'bogus' as never })).toEqual({ kind: 'read_only_fail', unverified: true });
    expect(decideTurnEnd({ ...base, unchanged: 'bogus' as never })).toEqual({ kind: 'run_gate' });
    expect(decideTurnEnd({ ...base, card: 'bogus' as never })).toEqual({ kind: 'card_retry' });
  });

  it('게이트가 센 횟수를 합쳐 카드 범위 밖 재시도의 상한을 본다(S12). 옛 판정과 다른 칸은 그 합이 상한에 닿는 칸뿐이다', () => {
    const differing: Row[] = [];
    for (const row of rows([0, 1, 2])) {
      if (!row.hasCard || !row.cardOutside || row.closed || row.pendingViolation || row.violation || row.gitFailed || row.readOnly) continue;
      if (row.unchanged && !row.verification) continue;
      const old = legacyTurnEnd(toLegacy(row));
      const got = legacyOf(resolve(row).step);
      if (old !== got) {
        expect([old, got]).toEqual(['card_retry', 'card_exhausted']);
        expect(row.unsettledAttempts + 1 + row.gateAttempts).toBeGreaterThanOrEqual(MAX);
        expect(row.unsettledAttempts + 1).toBeLessThan(MAX);
        differing.push(row);
      }
    }
    // (재시도 셈 0·1·2) × (게이트 횟수 0·1·2) 가운데 합이 상한에 닿고 옛 셈은 닿지 않는 칸: 셈+1+게이트 ≥ 3 이고 셈+1 < 3
    // 셈 0: 게이트 ≥ 2 → 1칸(2). 셈 1: 게이트 ≥ 1 → 2칸(1, 2). 셈 2는 옛 셈도 닿는다 → 3쌍. 여기에 시험이 거르지 않은 다른 사실의 조합을 곱한다:
    // 앞선 변경(2) × 지문(3, 읽기만이 아니라 쓰이지 않는다) × (기준·바뀐 것 없음·완료 검사 8조합 가운데 지름길 둘을 뺀 6)
    expect(differing.length).toBe(3 * (2 * 3 * 6));
  });
});

const GATE_KINDS: GateKind[] = ['pass', 'retry', 'exhausted'];

describe('게이트 뒤 판정: 옛 순서와 사실 조합을 견준다', () => {
  it('게이트 길: 의도한 차이는 게이트 밖 사유와 게이트의 횟수를 합쳐 상한에 닿는 재시도뿐이다', () => {
    let count = 0;
    const differing: GateFacts[] = [];
    for (const outcome of GATE_KINDS)
      for (const cancelled of BOOLS)
        for (const maxTurnsLimit of BOOLS)
          for (const violation of BOOLS)
            for (const unsettledAttempts of [0, 1, 2, 3])
              for (const gateAttempts of [0, 1, 2, 3]) {
                count += 1;
                const facts: GateFacts = { path: 'gate', outcome, cancelled, maxTurnsLimit, violation, unsettledAttempts, gateAttempts, maxAttempts: MAX };
                const old = legacyGate({ path: 'gate', outcome, cancelled, maxTurnsLimit, violation });
                const got = decideGateOutcome(facts);
                const mapped = got.kind === 'exhaust' ? (got.maxTurns ? 'exhaust_max_turns' : 'exhaust') : got.kind;
                if (old !== mapped) differing.push(facts);
              }
    expect(count).toBe(3 * 2 * 2 * 2 * 4 * 4);
    for (const facts of differing) {
      expect(facts.outcome, JSON.stringify(facts)).toBe('retry');
      expect(facts.cancelled || facts.maxTurnsLimit).toBe(false);
      expect(facts.unsettledAttempts + facts.gateAttempts).toBeGreaterThanOrEqual(MAX);
      expect(decideGateOutcome(facts)).toEqual({ kind: 'exhaust', maxTurns: false, attempts: true });
    }
    // 재시도 + 취소·턴 상한 없음 + 합 ≥ 3인 (셈, 게이트) 쌍: 16쌍 가운데 합 < 3인 6쌍을 뺀 10쌍 × 위반 2
    expect(differing).toHaveLength(10 * 2);
  });

  it('완료 검사 길: 위반을 먼저 보고 취소·턴 상한을 보지 않는다. 상한은 같은 합산이다', () => {
    for (const outcome of GATE_KINDS)
      for (const violation of BOOLS) {
        const facts: GateFacts = { path: 'done_tests', outcome, cancelled: true, maxTurnsLimit: true, violation, unsettledAttempts: 0, gateAttempts: 0, maxAttempts: MAX };
        const old = legacyGate({ path: 'done_tests', outcome, cancelled: true, maxTurnsLimit: true, violation });
        const got = decideGateOutcome(facts);
        expect(got.kind === 'exhaust' ? 'exhaust' : got.kind).toBe(old);
      }
  });

  it('알아보지 못한 결과는 닫는다(옛 코드는 빈 답으로 실행이 열린 채 남았다)', () => {
    const facts: GateFacts = { path: 'gate', outcome: 'bogus' as GateKind, cancelled: false, maxTurnsLimit: false, violation: false, unsettledAttempts: 0, gateAttempts: 0, maxAttempts: MAX };
    expect(decideGateOutcome(facts)).toEqual({ kind: 'unknown' });
    expect(decideGateOutcome({ ...facts, path: 'bogus' as never, cancelled: true })).toEqual({ kind: 'throw_cancel' });
  });

  it('턴 상한에 닿은 재시도는 소진이다. 통과는 그대로 통과다', () => {
    const facts: GateFacts = { path: 'gate', outcome: 'retry', cancelled: false, maxTurnsLimit: true, violation: false, unsettledAttempts: 0, gateAttempts: 1, maxAttempts: MAX };
    expect(decideGateOutcome(facts)).toEqual({ kind: 'exhaust', maxTurns: true, attempts: false });
    expect(decideGateOutcome({ ...facts, outcome: 'pass' })).toEqual({ kind: 'pass' });
  });
});

describe('체크포인트를 남긴 직후 판정', () => {
  it('저장하는 동안 위반이 왔으면 통과로 닫지 않는다', () => {
    expect(decideAfterCheckpoint(false)).toBe('settle');
    expect(decideAfterCheckpoint(true)).toBe('fail_violation');
  });
});
