import { describe, expect, it } from 'vitest';
import { initialState, type DeskState } from './keys';
import { stringWidth, stripAnsi } from './screen';
import { defaultSprite } from './sprite';
import { DEFAULT_THEME, fg } from './theme';
import type { DeskAccountLimits, DeskItem } from './types';
import { sessionLimits, usageCardLines, usageScreen, usageSpriteKey, usageSummary } from './usage';

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
    expect(plain[3]).toMatch(/5시간 +37% +주간 +90%/);
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

  it('맨 위에 제목과 요약, 그 아래 계정마다 카드를 놓는다. 줄마다 본문 폭이다', () => {
    const screen = usageScreen(state({ usage: { accounts: [account(), marco, gemini] } }), rect, NOW);
    const plain = screen.lines.map(stripAnsi);
    expect(plain).toHaveLength(rect.h);
    for (const line of plain) expect(stringWidth(line)).toBe(rect.w);
    expect(plain[0]).toMatch(/^ +사용량 +Claude 1\/1 연결 · Codex 1\/1 연결 · Gemini/);
    expect(plain.join('\n')).toContain('피오');
    expect(plain.join('\n')).toContain('마르코');
    expect(screen.cards.map((card) => card.index)).toEqual([0, 1, 2]);
    expect(screen.cards[0]!.rect.y).toBe(rect.y + 2);
  });

  it('고른 계정의 카드가 보이게 아래로 내린다', () => {
    const many = Array.from({ length: 8 }, (_, index) => account({ id: `acct-${index}`, name: `계정${index}` }));
    const screen = usageScreen(state({ usage: { accounts: many }, usageSelected: 7 }), rect, NOW);
    expect(screen.lines.map(stripAnsi).join('\n')).toContain('계정7');
    expect(screen.cards.some((card) => card.index === 7)).toBe(true);
    expect(screen.cards.some((card) => card.index === 0)).toBe(false);
  });

  it('아직 읽지 않았으면 읽는 중, 읽지 못했으면 그 까닭, 사용량을 모르는 스튜디오면 그렇다고 보인다', () => {
    expect(usageScreen(state(), rect, NOW).lines.map(stripAnsi).join('\n')).toContain('사용량을 읽는 중');
    expect(usageScreen(state({ usage: { accounts: [], error: '스튜디오가 500으로 답했습니다' } }), rect, NOW).lines.map(stripAnsi).join('\n')).toContain('스튜디오가 500으로 답했습니다');
    expect(usageScreen(state({ usage: { accounts: [], unsupported: true } }), rect, NOW).lines.map(stripAnsi).join('\n')).toContain('사용량을 알려 주지 않는 스튜디오');
  });

  it('계정 그림은 사용량 화면의 그림 자리(acct:id)에서 찾는다', () => {
    expect(usageSpriteKey('codex')).toBe('acct:codex');
  });
});
