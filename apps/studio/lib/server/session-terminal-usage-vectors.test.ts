import { describe, expect, it } from 'vitest';
import { decideSilence, decideStall, decideUsage, EARLY_USAGE_MS, LATE_USAGE_MS, stallIntervalMs, type UsageFacts } from './session-terminal-usage';
import { frozenModule, loadTable } from './frozen-vectors';

// 아래 `legacy*`는 옛 TS가 낸 값을 JSON에서 꺼내는 껍데기다(옛 TS 파일은 지웠다). 같은 입력은 같은 값을 돌려준다.
const FROZEN = loadTable(new URL('./session-terminal-usage-vectors.json', import.meta.url));
const { legacyStall, legacyStallIntervalMs, legacyUsage } = frozenModule(FROZEN, 'session-terminal-usage-legacy:');

/**
 * 차등 시험(ADR-213, 4f B4d): 코어의 사용량·정체 판정을 옛 분기 순서이 낸 값(`session-terminal-usage-vectors.json`에 입력별로 고정)과 사실 조합 전체에서 견준다.
 * 다른 칸은 의도한 차이뿐이어야 하고, 그 목록을 이 파일이 고정한다.
 */
const BOOLS = [false, true] as const;

function* usageRows(): Generator<UsageFacts> {
  for (const hasRequestId of BOOLS)
    for (const counted of BOOLS)
      for (const attached of BOOLS)
        for (const openRun of BOOLS)
          for (const inOpenWindow of BOOLS)
            for (const inEarlySlack of BOOLS)
              for (const openedByTool of BOOLS)
                for (const inClosedRun of BOOLS)
                  for (const inClosedLate of BOOLS) yield { hasRequestId, counted, attached, openRun, inOpenWindow, inEarlySlack, openedByTool, inClosedRun, inClosedLate };
}

describe('사용량 귀속 차등 (옛 분기 순서와 사실 조합 전체)', () => {
  it('다른 칸은 의도한 차이뿐이다: 도구 호출이 연 실행의 열린 시각 앞 요청(U5)', () => {
    let rows = 0;
    const differing: UsageFacts[] = [];
    for (const facts of usageRows()) {
      rows += 1;
      const step = decideUsage(facts);
      const old = legacyUsage({ hasRequestId: facts.hasRequestId, counted: facts.counted, attached: facts.attached, openRun: facts.openRun, inOpenWindow: facts.inOpenWindow, inClosedWindow: facts.inClosedRun || facts.inClosedLate });
      // 옛 판정에는 없는 `markSeen`(ADR-216)은 따로 본다: 열린 실행에 붙을 때만 선다
      expect(step.markSeen).toBe(step.target === 'open');
      if (JSON.stringify({ count: step.count, target: step.target, countTurn: step.countTurn, checkLimits: step.checkLimits }) !== JSON.stringify(old)) differing.push(facts);
    }
    expect(rows).toBe(512);
    expect(differing.length).toBeGreaterThan(0);
    // 의도한 차이의 조건: 열린 실행이 도구 호출이 열었고, 열린 시각 앞의 짧은 시간에 들며, 열린 창 밖이고, 앞서 닫힌 실행의 시간 안이 아니며, 이미 붙인 번호가 아니다
    for (const facts of differing) {
      expect(facts.openRun && facts.openedByTool && facts.inEarlySlack && !facts.inOpenWindow && !facts.inClosedRun && !(facts.hasRequestId && facts.attached)).toBe(true);
      const step = decideUsage(facts);
      expect(step.target).toBe('open');
      expect(step.countTurn).toBe(true);
      // 세는 것(count)과 한도를 보는 것은 옛 판정과 같다
      const old = legacyUsage({ hasRequestId: facts.hasRequestId, counted: facts.counted, attached: facts.attached, openRun: facts.openRun, inOpenWindow: facts.inOpenWindow, inClosedWindow: facts.inClosedRun || facts.inClosedLate });
      expect(step.count).toBe(old.count);
      expect(step.checkLimits).toBe(old.checkLimits);
    }
    // 반대쪽: 차이가 나는 칸이 위 조건을 가진 칸 전부다(조건을 가진 칸이 같게 나온 경우가 없다)
    let expected = 0;
    for (const facts of usageRows()) if (facts.openRun && facts.openedByTool && facts.inEarlySlack && !facts.inOpenWindow && !facts.inClosedRun && !(facts.hasRequestId && facts.attached)) expected += 1;
    expect(differing.length).toBe(expected);
  });

  it('덜 세는 칸이 없다: 새 판정이 한도에 더하는 것과 턴으로 세는 것은 옛 판정의 상위다', () => {
    for (const facts of usageRows()) {
      const step = decideUsage(facts);
      const old = legacyUsage({ hasRequestId: facts.hasRequestId, counted: facts.counted, attached: facts.attached, openRun: facts.openRun, inOpenWindow: facts.inOpenWindow, inClosedWindow: facts.inClosedRun || facts.inClosedLate });
      if (old.count) expect(step.count).toBe(true);
      if (old.countTurn) expect(step.countTurn).toBe(true);
      if (old.checkLimits) expect(step.checkLimits).toBe(true);
    }
  });

  it('요청 번호가 없으면 늘 센다', () => {
    for (const facts of usageRows()) if (!facts.hasRequestId) expect(decideUsage(facts).count).toBe(true);
  });

  it('시간 상수는 코어가 정한다', () => {
    expect(EARLY_USAGE_MS).toBe(5_000);
    expect(LATE_USAGE_MS).toBe(5_000);
  });
});

describe('정체 판정 차등', () => {
  const STALLS = [1_000, 8_000, 120_000];
  it('판정은 사실 조합 전체에서 옛 판정과 같다', () => {
    let rows = 0;
    for (const openRun of BOOLS)
      for (const notified of BOOLS)
        for (const stallMs of STALLS)
          for (const idleMs of [-1, 0, stallMs - 1, stallMs, stallMs + 1, stallMs * 3]) {
            rows += 1;
            const facts = { openRun, notified, idleMs, stallMs };
            const old = legacyStall(facts);
            expect(decideStall(facts), JSON.stringify(facts)).toBe(old);
          }
    expect(rows).toBe(2 * 2 * 3 * 6);
  });

  it('의도한 차이: 감시 주기가 정체 시간의 1/4(최소 1초)다. 마지막 활동 뒤 정체 시간의 1.25배 안에 알린다(U6)', () => {
    for (const stallMs of [1_000, 2_000, 8_000, 60_000, 120_000]) {
      expect(legacyStallIntervalMs(stallMs)).toBe(stallMs);
      expect(stallIntervalMs(stallMs)).toBe(Math.max(1_000, stallMs / 4));
      // 가장 늦은 경우: 활동 직후 한 주기를 막 지나 시작했다. 정체 시간 뒤 첫 확인까지 한 주기 이하
      expect(stallMs + stallIntervalMs(stallMs)).toBeLessThanOrEqual(Math.max(stallMs * 1.25, stallMs + 1_000));
    }
  });
});

describe('사용량 소식 판정', () => {
  const silent = { cliSendsUsage: true, telemetrySeen: false, writeHooks: 11, elapsedMs: 30_000, silentBefore: false };
  it('소식을 받았거나 소식을 보내지 않는 CLI이거나 쓰기 훅이 적거나 열린 지 얼마 안 됐으면 정상이다', () => {
    expect(decideSilence(silent)).toBe('silent');
    expect(decideSilence({ ...silent, telemetrySeen: true })).toBe('fine');
    expect(decideSilence({ ...silent, cliSendsUsage: false })).toBe('fine');
    expect(decideSilence({ ...silent, writeHooks: 10 })).toBe('fine');
    expect(decideSilence({ ...silent, elapsedMs: 29_999 })).toBe('fine');
    expect(decideSilence({ ...silent, elapsedMs: -1 })).toBe('silent');
    expect(decideSilence({ ...silent, writeHooks: 1, elapsedMs: 0, silentBefore: true })).toBe('silent');
    expect(decideSilence({ ...silent, writeHooks: 1, elapsedMs: 0, silentBefore: true, telemetrySeen: true })).toBe('fine');
  });
});
