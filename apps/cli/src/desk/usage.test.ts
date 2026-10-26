import { describe, expect, it } from 'vitest';
import { initialState, type DeskState } from './keys';
import { stringWidth, stripAnsi } from './screen';
import { defaultSprite } from './sprite';
import { DEFAULT_THEME, fg } from './theme';
import type { DeskAccountLimits, DeskItem, DeskSpend } from './types';
import { byTightness, usageAccounts, exhaustAt, sessionLimits, tightestLine, usageCardLines, usageScreen, usageSpriteKey, usageSummary } from './usage';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const later = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const clock = (iso: string) => {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};
const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-23T11:57:00Z', ...patch });
const account = (patch: Partial<DeskAccountLimits> = {}): DeskAccountLimits => ({
  id: 'acct-1',
  backend: 'claude-code',
  name: '피오',
  plan: 'Max 20x',
  status: 'warn',
  windows: [
    { kind: 'five_hour', usedPercent: 37, resetsAt: later(110) },
    { kind: 'weekly', usedPercent: 90, resetsAt: later(3 * 24 * 60) },
  ],
  source: 'claude-oauth',
  fetchedAt: '2026-10-23T11:36:00Z',
  ...patch,
});
const marco = account({ id: 'codex', backend: 'codex', name: '마르코', plan: 'Pro', status: 'ok', windows: [{ kind: 'weekly', usedPercent: 26, resetsAt: later(4 * 24 * 60) }], source: 'codex-app-server', recommended: true });
const gemini = account({ id: 'gemini', backend: 'gemini', name: '기본', status: 'unsupported', windows: [], source: 'none', plan: undefined, fetchedAt: undefined });

describe('세션 카드의 사용량 잇기', () => {
  it('세션의 계정(없으면 그 CLI의 기본 계정)의 5시간·주간 창을 세션 id로 묶는다', () => {
    const items = [item('a', { accountId: 'acct-1' }), item('b', { backend: 'codex' }), item('c'), item('d', { accountId: 'gone' })];
    const accounts = [account(), marco, account({ id: 'claude-code', name: '기본', status: 'unknown', windows: [], error: '로그인 필요' })];

    expect(sessionLimits(items, accounts)).toEqual({
      a: { fiveHour: { usedPercent: 37, resetsAt: later(110) }, weekly: { usedPercent: 90, resetsAt: later(3 * 24 * 60) } },
      b: { weekly: { usedPercent: 26, resetsAt: later(4 * 24 * 60) } },
    });
  });
});

describe('사용량 요약 한 줄', () => {
  it('CLI마다 읽은 계정 수, 주간 평균, 기준 시각을 적는다', () => {
    const accounts = [account(), account({ id: 'acct-2', status: 'unknown', windows: [], error: '로그인 필요' }), marco, gemini];
    expect(usageSummary(accounts)).toBe(`Claude 1/2 연결 · Codex 1/1 연결 · Gemini · 주간 평균 58% · ${clock('2026-10-23T11:36:00Z')} 기준`);
  });

  it('읽은 값이 없으면 평균과 기준 시각을 빼고 적는다', () => {
    expect(usageSummary([gemini])).toBe('Gemini');
  });
});

describe('계정 카드', () => {
  const card = (input: Partial<Parameters<typeof usageCardLines>[0]> = {}, width = 84) =>
    usageCardLines({ account: account(), selected: false, sprite: defaultSprite('claude-code'), ...input }, width, DEFAULT_THEME, NOW);

  it('그림 옆에 이름·CLI 배지·상태, 플랜, 5시간·주간 막대를 나란히 두고, 그 아래 다시 차는 때를 적는다', () => {
    const lines = card();
    const plain = lines.map(stripAnsi);
    for (const line of plain) expect(stringWidth(line)).toBe(84);
    expect(plain[0]!.startsWith('╭')).toBe(true);
    expect(plain[1]).toMatch(/│ .{14} {2}피오 +Claude +▲ 주의 │/);
    expect(plain[2]).toContain('Max 20x');
    expect(plain[3]).toMatch(/5시간 +37% +주간 .*90%/);
    expect(plain[4]).toMatch(/[█▏▎▍▌▋▊▉]/);
    expect(plain[5]).toContain('1시간 50분 뒤');
    // 주의(70% 넘음)는 노란 막대다
    expect(lines[4]).toContain(fg(DEFAULT_THEME, 'yellow'));
  });

  it('좁으면 5시간과 주간을 위아래로 둔다', () => {
    const plain = card({}, 56).map(stripAnsi);
    for (const line of plain) expect(stringWidth(line)).toBe(56);
    const five = plain.findIndex((line) => line.includes('5시간'));
    const week = plain.findIndex((line) => line.includes('주간'));
    expect(five).toBeGreaterThan(0);
    expect(week).toBeGreaterThan(five);
    expect(plain[five]).toContain('37%');
    expect(plain[week]).toContain('90%');
  });

  it('추천 계정에는 추천 배지, 다 쓴 계정에는 어느 창을 다 썼는지 적는다', () => {
    expect(stripAnsi(card({ account: marco })[1]!)).toMatch(/마르코 +Codex +추천 +✓ 여유/);
    const spent = account({ status: 'exhausted', windows: [{ kind: 'weekly', usedPercent: 100, resetsAt: later(30) }] });
    expect(stripAnsi(card({ account: spent })[1]!)).toContain('× 주간 다 씀');
    expect(stripAnsi(card({ account: account({ status: 'idle' }) })[1]!)).toContain('☾ 쉬는 중');
  });

  it('한도가 없는 CLI는 해당 없음, 읽지 못한 계정은 그 까닭, 지난 값이면 그렇다고 적는다', () => {
    expect(card({ account: gemini }).map(stripAnsi).join('\n')).toContain('5시간·주간 한도가 없는 CLI입니다');
    const failed = card({ account: account({ status: 'unknown', windows: [], error: '토큰이 만료됐습니다. CLI에서 한 번 쓰면 갱신됩니다' }) }).map(stripAnsi).join('\n');
    expect(failed).toContain('토큰이 만료됐습니다. CLI에서 한 번 쓰면 갱신됩니다');
    const stale = card({ account: account({ stale: true, error: '잠시 뒤 다시 묻습니다' }) }).map(stripAnsi).join('\n');
    expect(stale).toContain('지난 값');
    expect(stale).toContain('잠시 뒤 다시 묻습니다');
  });

  it('고른 카드는 테두리가 강조색이다', () => {
    expect(card({ selected: true })[0]).toContain(fg(DEFAULT_THEME, 'accent'));
    expect(card()[0]).not.toContain(fg(DEFAULT_THEME, 'accent'));
  });
});

describe('사용량 화면', () => {
  const rect = { x: 33, y: 1, w: 87, h: 28 };
  const state = (patch: Partial<DeskState> = {}): DeskState => ({ ...initialState(), view: 'usage', ...patch });
  const boxes = (plain: string[]) => plain.filter((line) => line.includes('╭')).length;

  it('맨 위에 제목과 요약, 그 아래 머리줄과 계정마다 한 줄을 놓는다. 줄마다 본문 폭이다', () => {
    const screen = usageScreen(state({ usage: { accounts: [account(), marco, gemini] } }), rect, NOW);
    const plain = screen.lines.map(stripAnsi);
    expect(plain).toHaveLength(rect.h);
    for (const line of plain) expect(stringWidth(line)).toBe(rect.w);
    expect(plain[0]).toMatch(/^ +사용량 +Claude 1\/1 연결 · Codex 1\/1 연결 · Gemini/);
    expect(plain[2]).toMatch(/계정 +AI +요금제 +5시간 +주간 +다시 참 +상태/);
    expect(screen.cards.map((card) => card.index)).toEqual([0, 1, 2]);
    expect(screen.cards.map((card) => card.rect.y)).toEqual([rect.y + 3, rect.y + 4, rect.y + 5]);
    for (const card of screen.cards) expect(card.rect.h).toBe(1);
  });

  it('계정 줄: 이름·AI·요금제·5시간 %·주간 %·가장 빠듯한 창이 다시 차는 때·상태', () => {
    const plain = usageScreen(state({ usage: { accounts: [account(), marco, gemini] } }), rect, NOW).lines.map(stripAnsi);
    expect(plain[3]).toMatch(/피오 +Claude +Max 20x +[█▏▎▍▌▋▊▉ ]+37% +[█▏▎▍▌▋▊▉ ]+90% +3일 뒤.* +▲ 주의/);
    // 5시간 창이 없는 계정은 그 칸을 비워 두고(─), 한도가 없는 CLI는 해당 없음
    expect(plain[4]).toMatch(/마르코 +Codex +Pro +─ +.*26% +.*✓ 여유/);
    expect(plain[5]).toMatch(/기본 +Gemini +─ +─ +· 해당 없음/);
    // 가장 긴 상태 글도 잘리지 않는다
    const spent = account({ id: 'spent', name: '에리', status: 'exhausted', windows: [{ kind: 'weekly', usedPercent: 100, resetsAt: later(3 * 24 * 60) }] });
    expect(usageScreen(state({ usage: { accounts: [spent] } }), rect, NOW).lines.map(stripAnsi)[3]).toContain('× 주간 다 씀');
  });

  it('고른 계정 하나만 아래에 그림 카드로 자세히 보인다', () => {
    const first = usageScreen(state({ usage: { accounts: [account(), marco, gemini] }, usageSelected: 0 }), rect, NOW).lines.map(stripAnsi);
    expect(boxes(first)).toBe(1);
    const card = first.slice(first.findIndex((line) => line.includes('╭')));
    expect(card.join('\n')).toContain('피오');
    expect(card.join('\n')).toContain('1시간 50분 뒤');
    const second = usageScreen(state({ usage: { accounts: [account(), marco, gemini] }, usageSelected: 1 }), rect, NOW).lines.map(stripAnsi);
    const other = second.slice(second.findIndex((line) => line.includes('╭')));
    expect(other.join('\n')).toContain('마르코');
    expect(other.join('\n')).not.toContain('피오');
    // 고른 줄은 앞에 표시가 붙는다
    expect(second[4]).toMatch(/^ *▸ 마르코/);
    expect(second[3]).not.toContain('▸');
  });

  it('계정 여덟 개도 한 화면에 모두 들어가고 고른 계정의 카드도 보인다', () => {
    const many = Array.from({ length: 8 }, (_, index) => account({ id: `acct-${index}`, name: `계정${index}` }));
    const screen = usageScreen(state({ usage: { accounts: many }, usageSelected: 7 }), rect, NOW);
    const plain = screen.lines.map(stripAnsi);
    for (let index = 0; index < 8; index++) expect(plain.some((line) => line.includes(`계정${index} `))).toBe(true);
    expect(screen.cards.map((card) => card.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(boxes(plain)).toBe(1);
  });

  it('높이가 모자라면 카드를 빼고, 그래도 모자라면 고른 줄이 보이게 내린다', () => {
    const many = Array.from({ length: 8 }, (_, index) => account({ id: `acct-${index}`, name: `계정${index}` }));
    const screen = usageScreen(state({ usage: { accounts: many }, usageSelected: 7 }), { ...rect, h: 8 }, NOW);
    const plain = screen.lines.map(stripAnsi);
    expect(plain).toHaveLength(8);
    expect(boxes(plain)).toBe(0);
    expect(screen.cards.some((card) => card.index === 7)).toBe(true);
    expect(screen.cards.some((card) => card.index === 0)).toBe(false);
  });

  it('좁으면 요금제, 다시 참, 막대, AI 차례로 뺀다. 이름·%·상태는 남는다', () => {
    const at = (w: number) => usageScreen(state({ usage: { accounts: [account(), marco] } }), { ...rect, w }, NOW).lines.map(stripAnsi);
    const wide = at(87);
    expect(wide[2]).toContain('요금제');
    const mid = at(74);
    for (const line of mid) expect(stringWidth(line)).toBe(74);
    expect(mid[2]).not.toContain('요금제');
    expect(mid[2]).toContain('다시 참');
    const narrow = at(58);
    expect(narrow[2]).not.toContain('다시 참');
    expect(narrow[3]).toMatch(/[█▏▎▍▌▋▊▉]/);
    const tight = at(46);
    for (const line of tight) expect(stringWidth(line)).toBe(46);
    expect(tight[2]).toContain('AI');
    expect(tight[3]).not.toMatch(/[█▏▎▍▌▋▊▉]/);
    expect(tight[3]).toMatch(/피오 .*37% +90% +▲ 주의/);
    const tiny = at(30);
    expect(tiny[2]).not.toContain('AI');
    expect(tiny[3]).toMatch(/피오.*37%.*90%/);
  });

  it('아직 읽지 않았으면 읽는 중, 읽지 못했으면 그 까닭, 사용량을 모르는 스튜디오면 그렇다고 보인다', () => {
    expect(usageScreen(state(), rect, NOW).lines.map(stripAnsi).join('\n')).toContain('사용량을 읽는 중');
    expect(usageScreen(state({ usage: { accounts: [], error: '스튜디오가 500으로 답했습니다' } }), rect, NOW).lines.map(stripAnsi).join('\n')).toContain('스튜디오가 500으로 답했습니다');
    expect(usageScreen(state({ usage: { accounts: [], unsupported: true } }), rect, NOW).lines.map(stripAnsi).join('\n')).toContain('사용량을 알려 주지 않는 스튜디오');
  });

  it('읽지 못한 계정은 줄에서 그렇다고 적는다', () => {
    const failed = account({ id: 'acct-x', name: '실패', status: 'unknown', windows: [], error: '토큰이 만료됐습니다' });
    const plain = usageScreen(state({ usage: { accounts: [failed] } }), rect, NOW).lines.map(stripAnsi);
    expect(plain[3]).toMatch(/실패 .*─ +─ +! 읽지 못함/);
  });

  it('계정 그림은 사용량 화면의 그림 자리(acct:id)에서 찾는다', () => {
    expect(usageSpriteKey('codex')).toBe('acct:codex');
  });
});

describe('가장 빠듯한 한도(#925)', () => {
  it('가장 많이 쓴 창이 큰 계정부터 둔다. 한도가 없거나 읽지 못한 계정은 뒤로 간다(같으면 원래 차례)', () => {
    const low = account({ id: 'low', windows: [{ kind: 'five_hour', usedPercent: 10 }] });
    const unknown = account({ id: 'unknown', status: 'unknown', windows: [] });
    const sorted = byTightness([gemini, low, unknown, marco, account()]);
    expect(sorted.map((entry) => entry.id)).toEqual(['acct-1', 'codex', 'low', 'gemini', 'unknown']);
  });

  it('카드의 80%를 넘은 창에 경고 칩을 단다', () => {
    const plain = usageCardLines({ account: account(), selected: false, sprite: defaultSprite('claude-code') }, 84, DEFAULT_THEME, NOW).map(stripAnsi);
    expect(plain[3]).toMatch(/주간 +80% 넘음 +90%/);
    expect(plain[3]).not.toMatch(/5시간 +80% 넘음/);
  });

  it('다시 차는 때에 시각을 함께 적는다', () => {
    const plain = usageCardLines({ account: account(), selected: false, sprite: defaultSprite('claude-code') }, 84, DEFAULT_THEME, NOW).map(stripAnsi);
    expect(plain[5]).toContain(`1시간 50분 뒤(${clock(later(110))})`);
  });

  it('창이 시작된 뒤의 평균 속도로 다시 차기 전에 바닥나는 때를 추정한다. 표본이 적거나 넉넉하면 내지 않는다', () => {
    // 5시간 창이 끝나기 110분 전: 시작한 지 190분에 76% → 190/76×24 = 60분 뒤 바닥
    expect(exhaustAt({ kind: 'five_hour', usedPercent: 76, resetsAt: later(110) }, NOW)).toBe(NOW + 60 * 60_000);
    // 이 속도면 다시 찰 때까지 다 쓰지 않는다
    expect(exhaustAt({ kind: 'five_hour', usedPercent: 37, resetsAt: later(110) }, NOW)).toBeUndefined();
    // 창이 열린 지 10분: 아직 모른다
    expect(exhaustAt({ kind: 'five_hour', usedPercent: 30, resetsAt: later(290) }, NOW)).toBeUndefined();
    expect(exhaustAt({ kind: 'five_hour', usedPercent: 100, resetsAt: later(110) }, NOW)).toBeUndefined();
    expect(exhaustAt({ kind: 'weekly', usedPercent: 90 }, NOW)).toBeUndefined();
  });

  it('바닥날 것 같으면 카드에 추정이라고 적어 보인다', () => {
    const hot = account({ windows: [{ kind: 'five_hour', usedPercent: 76, resetsAt: later(110) }, { kind: 'weekly', usedPercent: 40, resetsAt: later(3 * 24 * 60) }] });
    const text = usageCardLines({ account: hot, selected: false, sprite: defaultSprite('claude-code') }, 84, DEFAULT_THEME, NOW).map(stripAnsi).join('\n');
    expect(text).toContain(`이 속도면 ${clock(later(60))}에 다 씀(추정)`);
    const narrow = usageCardLines({ account: hot, selected: false, sprite: defaultSprite('claude-code') }, 56, DEFAULT_THEME, NOW).map(stripAnsi);
    for (const line of narrow) expect(stringWidth(line)).toBe(56);
    expect(narrow.join('\n')).toContain('다 씀(추정)');
  });

  it('사이드바 한 줄: 가장 빠듯한 계정의 창, %, 다시 차는 시각', () => {
    const line = tightestLine([marco, account(), gemini], 30, DEFAULT_THEME, NOW)!;
    expect(stringWidth(stripAnsi(line))).toBe(30);
    expect(stripAnsi(line)).toMatch(/^ 한도 Claude 주간 90% · \d+\/\d+ *$/);
    expect(stripAnsi(tightestLine([account({ windows: [{ kind: 'five_hour', usedPercent: 85, resetsAt: later(110) }] })], 30, DEFAULT_THEME, NOW)!)).toContain(`5시간 85% · ${clock(later(110))}`);
    expect(line).toContain(fg(DEFAULT_THEME, 'yellow'));
    expect(tightestLine([gemini], 30, DEFAULT_THEME, NOW)).toBeUndefined();
  });
});

describe('오늘·최근 7일 쓴 양(#925)', () => {
  const rect = { x: 33, y: 1, w: 87, h: 28 };
  const totals = (patch: Partial<DeskSpend['today']> = {}): DeskSpend['today'] => ({ tokens: 0, estimated: false, missingPrice: false, rows: [], ...patch });
  const spend: DeskSpend = {
    today: totals({
      tokens: 3_000_000,
      estimated: true,
      missingPrice: true,
      rows: [
        { backend: 'codex', model: 'gpt-5.5', tokens: 2_000_000, calls: 4, costUsd: 2, estimated: true },
        { backend: 'claude-code', model: 'claude-opus-5-5', tokens: 1_000_000, calls: 2, costUsd: 3, estimated: false },
        { backend: 'gemini', model: 'gemini-3-pro', tokens: 10_000, calls: 1, estimated: false },
      ],
    }),
    week: totals({ tokens: 4_000_000, costUsd: 6, estimated: true }),
  };

  it('요약 아래에 오늘·7일 합계 한 줄, 고른 계정의 카드에 그 CLI의 오늘·7일과 모델 줄을 보이고, 추정과 단가 없음을 숨기지 않는다', () => {
    const screen = usageScreen({ ...initialState(), view: 'usage', usage: { accounts: [account()], spend } }, rect, NOW);
    const plain = screen.lines.map(stripAnsi);
    for (const line of plain) expect(stringWidth(line)).toBe(rect.w);
    expect(plain[1]).toMatch(/오늘 +300만 토큰 · 합계 비용 없음 +7일 +\$6\.00 추정 포함 · 400만 토큰/);
    expect(plain.join('\n')).toContain('B_STUDIO_TOKEN_PRICES_JSON');
    const card = plain.slice(plain.findIndex((line) => line.includes('╭'))).join('\n');
    expect(card).toMatch(/Claude 전체 +오늘 +\$3\.00 · 100만 토큰/);
    expect(card).toMatch(/claude-opus-5-5 +100만 +\$3\.00/);
    // 다른 CLI의 모델 줄은 이 계정의 카드에 넣지 않는다
    expect(card).not.toContain('gpt-5.5');
    expect(screen.cards[0]!.rect.y).toBeGreaterThan(rect.y + 3);
  });

  it('쓴 것이 없으면 합계 한 줄만', () => {
    const screen = usageScreen({ ...initialState(), view: 'usage', usage: { accounts: [account()], spend: { today: totals(), week: totals() } } }, rect, NOW);
    const text = screen.lines.map(stripAnsi).join('\n');
    expect(text).toMatch(/오늘 +0 토큰 +7일 +0 토큰/);
    expect(text).not.toContain('단가 없음');
  });
});

describe('한도가 없는 CLI는 표에 두지 않는다(#945)', () => {
  it('usageAccounts는 빠듯한 순으로 놓고 5시간·주간 한도가 없는 계정(Gemini)을 뺀다', () => {
    expect(usageAccounts([gemini, marco, account()]).map((entry) => entry.id)).toEqual(['acct-1', 'codex']);
    // 읽지 못한 계정은 남긴다(로그인 필요 같은 까닭을 보여야 한다)
    const unknown = account({ id: 'unknown', status: 'unknown', windows: [], error: '로그인 필요' });
    expect(usageAccounts([gemini, unknown]).map((entry) => entry.id)).toEqual(['unknown']);
  });
});
