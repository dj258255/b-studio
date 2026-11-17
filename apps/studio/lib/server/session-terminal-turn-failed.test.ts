import { native } from '@b-studio/sandbox';
import { afterAll, describe, expect, it } from 'vitest';
import { cliEnded, retryRoute, terminalRunClosed, turnFailed, beginTerminalClose } from './session-terminal-close';
import { legacyCliEnded, legacyTurnFailed } from './session-terminal-close-legacy';

/**
 * API 오류로 턴이 끝났을 때(StopFailure, #1284, ADR-214)의 갈 곳: Rust `terminal_turn_failed`를 옛 동작과 같은 사실로 견준다.
 * 옛 동작은 "훅을 설치하지 않아 아무것도 하지 않음"이다. 다른 것은 아래 "의도한 차이"뿐이고 목록으로 고정한다.
 * 그 밖에 CLI 종료(`legacyCliEnded`)와 같은 꼴인지(열린 실행이 없으면 없음, 검사 중이면 미룸)도 같은 사실로 견준다.
 */
const counts = { turnFailed: 0, dOldNothing: 0, sameShapeAsCliEnded: 0 };
afterAll(() => console.log(`[session-terminal-turn-failed 차등] ${JSON.stringify(counts)}`));

type Life = { native: InstanceType<typeof native.SessionState> };
const fresh = (): Life => ({ native: new native.SessionState('idle') });
const bools = [false, true];

describe('턴이 API 오류로 끝났을 때의 갈 곳: 사실 조합 전체', () => {
  it('열린 실행이 없으면 없음, 검사 중이면 미룸, 아니면 늘 실패로 닫는다(피드백이 있었는지와 상관없다)', () => {
    for (const open of bools) for (const checking of bools) for (const hasFeedback of bools) {
      const life = fresh();
      const ticket = open ? (life.native.beginTerminalRun('t').token as number) : 0;
      const got = turnFailed(life, ticket, checking);
      counts.turnFailed += 1;
      const expected = !open ? 'nothing' : checking ? 'defer' : 'failed';
      expect(got, JSON.stringify({ open, checking, hasFeedback })).toBe(expected);

      // CLI 종료와 같은 꼴: 없음·미룸은 같고, 닫을 때만 끝 상태가 다르다(취소 대신 늘 실패)
      const ended = legacyCliEnded({ open, checking, hasFeedback });
      if (got === 'nothing' || got === 'defer') expect(got).toBe(ended);
      else expect(['failed', 'cancelled']).toContain(ended);
      counts.sameShapeAsCliEnded += 1;

      // 옛 동작(훅이 없어 아무것도 하지 않음)과의 차이는 열린 실행이 있을 때뿐이다
      const old = legacyTurnFailed();
      if (got === old) continue;
      expect(open).toBe(true);
      expect(['defer', 'failed']).toContain(got);
      counts.dOldNothing += 1;
    }
    expect(counts.turnFailed).toBe(8);
    // 열린 실행이 있는 4칸(검사 중 둘·아닌 것 둘)이 옛 동작과 다르다
    expect(counts.dOldNothing).toBe(4);
  });

  it('검사 중에 미루면 표시를 남겨, 검사가 재시도로 끝날 때 피드백 대신 실패로 닫는다. 열린 실행이 없을 때는 표시를 남기지 않는다', () => {
    const life = fresh();
    expect(turnFailed(life, 0, true)).toBe('nothing');
    const ticket = life.native.beginTerminalRun('t').token as number;
    expect(retryRoute(life, ticket)).toBe('feedback');
    expect(turnFailed(life, ticket, false)).toBe('failed');
    // 바로 닫는 경우는 표시가 없다
    expect(retryRoute(life, ticket)).toBe('feedback');
    expect(turnFailed(life, ticket, true)).toBe('defer');
    expect(retryRoute(life, ticket)).toBe('close_failed');
    // CLI 종료와 같은 표시를 쓴다
    const other = fresh();
    const t2 = other.native.beginTerminalRun('t').token as number;
    expect(cliEnded(other, t2, true, true)).toBe('defer');
    expect(retryRoute(other, t2)).toBe('close_failed');
  });

  it('닫기를 시작한 실행에는 더 하지 않는다', () => {
    const life = fresh();
    const ticket = life.native.beginTerminalRun('t').token as number;
    expect(beginTerminalClose(life, ticket, { kind: 'settle', status: 'done' })).toBeDefined();
    expect(terminalRunClosed(life, ticket)).toBe(true);
    for (const checking of bools) expect(turnFailed(life, ticket, checking)).toBe('nothing');
  });
});
