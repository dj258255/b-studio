import { describe, expect, it } from 'vitest';
import { decidePreTool, decidePrompt, takesCheckChanges, type PreToolFacts, type PromptFacts, type TerminalLimit } from './session-terminal-prompt';
import { frozenModule, loadTable } from './frozen-vectors';

// 아래 `legacy*`는 옛 TS가 낸 값을 JSON에서 꺼내는 껍데기다(옛 TS 파일은 지웠다). 같은 입력은 같은 값을 돌려준다.
const FROZEN = loadTable(new URL('./session-terminal-prompt-vectors.json', import.meta.url));
const { legacyPreToolAfter, legacyPreToolBefore, legacyPrompt, legacyTakesCheckChanges } = frozenModule(FROZEN, 'session-terminal-prompt-legacy:');

/**
 * 차등 시험(ADR-211, 4f B4b): 코어의 요청 시작·쓰기 직전·MCP 판정을 옛 분기 순서이 낸 값(`session-terminal-prompt-vectors.json`에 입력별로 고정)과 사실 조합 전체에서 견준다.
 * 다른 칸은 의도한 차이뿐이어야 하고, 그 목록을 이 파일이 고정한다.
 */
const BOOLS = [false, true] as const;

function* promptCombos(): Generator<PromptFacts> {
  for (const openRun of BOOLS)
    for (const runReadOnly of BOOLS)
      for (const promptReadOnly of BOOLS)
        for (const busy of BOOLS)
          for (const slash of BOOLS)
            for (const budget of BOOLS) yield { openRun, runReadOnly, promptReadOnly, busy, slash, budget };
}

const LIMITS: TerminalLimit[] = ['none', 'max_turns', 'budget'];

function* preToolCombos({ closed }: { closed: readonly boolean[] }): Generator<PreToolFacts> {
  for (const readTool of BOOLS)
    for (const budget of BOOLS)
      for (const gotRun of BOOLS)
        for (const readOnly of BOOLS)
          for (const limit of LIMITS)
            for (const outOfScope of BOOLS)
              for (const isClosed of closed) yield { readTool, budget, gotRun, readOnly, limit, outOfScope, closed: isClosed };
}

describe('요청 시작 판정: 옛 순서와 사실 조합 64개가 모두 같다', () => {
  it('열린 실행에 이어 붙임 → 바쁨 → "/" 명령 → 토큰 한도 → 새 실행', () => {
    let count = 0;
    for (const facts of promptCombos()) {
      count += 1;
      const old = legacyPrompt(facts);
      const got = decidePrompt(facts);
      const mapped =
        got.kind === 'attach'
          ? { decision: 'attach', markReadOnly: got.markReadOnly, readOnly: got.readOnly }
          : got.kind === 'block'
            ? { decision: got.block === 'busy' ? 'block_busy' : 'block_budget', markReadOnly: false, readOnly: false }
            : { decision: got.kind, markReadOnly: false, readOnly: false };
      expect(mapped, JSON.stringify(facts)).toEqual(old);
    }
    expect(count).toBe(64);
  });
});

describe('쓰기 직전·MCP 판정: 기다림 앞(닫힘 없음)은 옛 앞의 판정과 같다', () => {
  it('읽기 도구 → 토큰 한도 → 바쁨 → 읽기만 → 실행 한도 → 카드 범위', () => {
    let count = 0;
    for (const facts of preToolCombos({ closed: [false] })) {
      count += 1;
      const old = legacyPreToolBefore(facts);
      const got = decidePreTool(facts);
      expect(got, JSON.stringify(facts)).toEqual(old);
    }
    // 2(읽기 도구) × 2(한도 글) × 2(실행) × 2(읽기만) × 3(실행 한도) × 2(범위) = 96
    expect(count).toBe(96);
  });
});

describe('쓰기 직전·MCP 판정: 기다림 뒤(옛 코드는 닫힘만 봤다)와 다른 칸은 의도한 차이뿐이다', () => {
  /** 의도한 차이: 기다림 뒤에 닫히지 않았지만 앞에서 허용한 뒤 사실이 바뀐 칸. 새 판정은 거절하고 옛 판정은 허용했다 */
  const intended = (facts: PreToolFacts): boolean => !facts.readTool && !facts.closed && (facts.budget || facts.readOnly || facts.limit !== 'none' || facts.outOfScope);

  /** 의도한 차이 2: 닫힌 실행이 토큰 한도 글과 함께면 둘 다 거절이지만 사유 종류가 한도다(한도 중단이 실행을 닫는 경우 한도 글이 더 알려 준다) */
  const reasonOnly = (facts: PreToolFacts): boolean => !facts.readTool && facts.closed && facts.budget;

  it('다른 칸의 목록을 고정한다', () => {
    const allowToDeny: PreToolFacts[] = [];
    const reasonDiffers: PreToolFacts[] = [];
    let count = 0;
    // 기다림 뒤에는 실행을 얻은 상태이고 읽기 도구가 아니다(바쁨이면 읽기 도구는 기다리지 않는다)
    for (const facts of preToolCombos({ closed: BOOLS })) {
      if (!facts.gotRun || facts.readTool) continue;
      count += 1;
      const old = legacyPreToolAfter(facts);
      const got = decidePreTool(facts);
      if (old.allow === got.allow && (old.allow || (!got.allow && old.deny === got.deny))) continue;
      if (old.allow && !got.allow) allowToDeny.push(facts);
      else if (!old.allow && !got.allow) reasonDiffers.push(facts);
      else throw new Error(`옛 판정이 거절한 칸을 새 판정이 허용했습니다: ${JSON.stringify(facts)}`);
    }
    expect(count).toBe(48);
    // 다른 칸은 모두 의도한 차이다
    for (const facts of allowToDeny) expect(intended(facts), JSON.stringify(facts)).toBe(true);
    for (const facts of reasonDiffers) expect(reasonOnly(facts), JSON.stringify(facts)).toBe(true);
    // 칸 수: 허용 → 거절은 읽기 도구가 아니고 닫히지 않았으며 거절 사실이 하나라도 있는 조합(한도 글 2 × 읽기만 2 × 실행 한도 3 × 범위 2 = 24에서 모두 꺼진 1칸을 뺀 23).
    // 사유만 다른 칸은 닫힘 + 한도 글에 읽기만 2 × 실행 한도 3 × 범위 2 = 12
    expect(allowToDeny).toHaveLength(23);
    expect(reasonDiffers).toHaveLength(12);
  });

  it('닫힌 실행은 어느 칸에서나 거절한다(옛 판정과 같다. 읽기 도구는 기다리지 않아 허용이다)', () => {
    for (const facts of preToolCombos({ closed: [true] })) {
      if (!facts.gotRun) continue;
      const got = decidePreTool(facts);
      if (facts.readTool) expect(got.allow).toBe(true);
      else expect(got.allow, JSON.stringify(facts)).toBe(false);
    }
  });

  it('닫힌 실행은 읽기만·한도 글보다 먼저 닫힘으로 거절한다', () => {
    expect(decidePreTool({ readTool: false, budget: false, gotRun: true, readOnly: true, limit: 'max_turns', outOfScope: true, closed: true })).toEqual({ allow: false, deny: 'closed' });
  });
});

describe('모르는 값은 거절이다', () => {
  it('알아보지 못한 한도 종류는 거절한다', () => {
    const facts = { readTool: false, budget: false, gotRun: true, readOnly: false, outOfScope: false, closed: false };
    for (const limit of ['bogus', 'MAX_TURNS', ' budget', 'null', 'undefined']) {
      expect(decidePreTool({ ...facts, limit: limit as TerminalLimit }), limit).toEqual({ allow: false, deny: 'unknown' });
    }
  });
});

describe('확인 선언 변경 허용: 사람의 요청이 연 실행만 가져간다', () => {
  it('요청이 연 만들기 실행만 가져가고, 도구 호출이 연 실행과 읽기만은 남겨 둔다(옛 판정과 다른 칸은 도구 호출이 연 실행 하나뿐이다)', () => {
    const differing: string[] = [];
    for (const openedByPrompt of BOOLS)
      for (const readOnly of BOOLS)
        for (const allowedNext of BOOLS) {
          const old = legacyTakesCheckChanges(openedByPrompt, readOnly, allowedNext);
          const got = takesCheckChanges(openedByPrompt, readOnly, allowedNext);
          if (old !== got) differing.push(JSON.stringify({ openedByPrompt, readOnly, allowedNext }));
        }
    expect(differing).toEqual([JSON.stringify({ openedByPrompt: false, readOnly: false, allowedNext: true })]);
  });
});
