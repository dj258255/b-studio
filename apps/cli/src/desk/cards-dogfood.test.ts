import { describe, expect, it } from 'vitest';
import { cardLines, headStatus, remainingText, spaceScreen } from './cards';
import { initialState, type DeskState } from './keys';
import { renderScreen } from './render';
import { computeLayout, stringWidth, stripAnsi } from './screen';
import { agentStatus, detailLines, sidebarRows } from './sidebar';
import { defaultSprite } from './sprite';
import { DEFAULT_THEME } from './theme';
import type { DeskAccountLimits, DeskAgent, DeskItem } from './types';
import { tightestLine, usageCardLines } from './usage';

// #944: 진짜 서버·desk를 띄워 써 보고(실사용 점검) 나온 카드 화면 문제
const NOW = Date.parse('2026-10-26T12:00:00Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const usage = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: ago(30), ...patch });
const sub = (id: string, patch: Partial<DeskAgent> = {}): DeskAgent => ({ id, name: 'Explore', type: 'Explore', kind: 'subagent', state: 'done', tokens: usage(0), ...patch });
const draw = (target: DeskItem, patch: Partial<Parameters<typeof cardLines>[0]> = {}, width = 84) =>
  cardLines({ item: target, selected: false, flagged: false, withLimits: false, sprite: defaultSprite('claude-code'), ...patch }, width, DEFAULT_THEME, NOW).map(stripAnsi);
/** 카드 안쪽의 글 자리(그림 오른쪽) */
const textOf = (line: string, art: number) => [...line].slice(2 + art + 2, -2).join('');

const LONG = '주문 상태를 한 곳에서 바꾸게 묶었습니다. 테스트를 더했습니다. 결제 실패 경로도 함께 살폈고 남은 일은 없습니다.';
const done = item('d', {
  terminal: { cli: 'up' },
  gate: { state: 'passed', checkpoints: 1 },
  todos: { done: 7, total: 7 },
  context: { usedPct: 95 },
  lastMessage: LONG,
  agents: [sub('x')],
  capabilities: { backend: 'claude-code', tools: 'cli-default', writeScope: '세션 작업 복사본 전체', permission: 'CLI 권한 확인 + 쓰기 직전 관문 + 턴 끝 게이트' },
});

describe('고른 카드의 마지막 답: 그림 높이와 상관없이 이어 쓴다', () => {
  it('답의 다음 줄이 빈 줄을 건너뛰지 않고 바로 아래에 온다(100열에서 "테"와 "스트를" 사이에 빈 줄 둘이 끼던 것)', () => {
    // 큰 그림(7줄)보다 카드 몸 줄이 적을 때 나던 일이다
    const lines = draw(done, { selected: true }, 84);
    const text = lines.map((line) => textOf(line, 14).trimEnd());
    const at = text.findIndex((line) => line.startsWith('답 '));
    expect(at).toBeGreaterThan(0);
    expect(text[at + 1]).not.toBe('');
    expect((text[at]! + text[at + 1]!).replace(/\s/g, '')).toContain('테스트를');
  });
});

describe('펼친 줄은 낱말 사이에서 자른다', () => {
  it('넘치는 범위·검사 줄은 낱말 중간("턴 끝 게")에서 끊지 않고 …로 끝낸다', () => {
    // 알려진 문구는 짧은 말로 바꾸므로(#956) 넘치게 하려고 모르는 긴 문구를 쓴다(그대로 보인다)
    const long = { ...done, capabilities: { ...done.capabilities!, permission: 'CLI 권한 확인 + 쓰기 직전 관문 + 턴 끝 게이트 + 사람 확인' } };
    const text = draw(long, { selected: true }, 62).map((line) => textOf(line, 12).trimEnd());
    for (const line of text) expect(line).not.toMatch(/게$/);
    expect(text.some((line) => line.endsWith('…'))).toBe(true);
  });

  it('펼친 줄의 범위 문구는 무엇인지 말한다(쓸 수 있는 곳, 지키는 것, #956)', () => {
    const text = detailLines(done).map((line) => line.text);
    expect(text.some((line) => line.includes('쓸 수 있는 곳 세션 작업 복사본 전체'))).toBe(true);
    expect(text.some((line) => line.startsWith('지키는 것 '))).toBe(true);
  });
});

describe('서브에이전트와 토큰', () => {
  it('고른 카드에서 끝난 서브에이전트를 두 번 그리지 않는다', () => {
    const plain = draw(done, { selected: true }, 84).join('\n');
    expect(plain).not.toContain('서브에이전트 1개 끝남');
    expect(plain.match(/↳ Explore/g)).toHaveLength(1);
  });

  it('토큰을 모르면(0) "토큰 0"을 쓰지 않는다', () => {
    expect(detailLines(done).map((line) => line.text).join('\n')).not.toContain('토큰 0');
    const known = detailLines({ ...done, agents: [sub('x', { tokens: usage(1200) })] }).map((line) => line.text).join('\n');
    expect(known).toContain('토큰 1,200');
  });
});

describe('끝난 세션 머리의 결과', () => {
  it('쉬는 CLI라도 검증을 통과했으면 머리에 "검증 통과"를 보인다(흐린 CLI 대기만 보이지 않는다)', () => {
    expect(headStatus(done)).toMatchObject({ label: '검증 통과', tone: 'ok' });
    expect(draw(done)[1]).toContain('검증 통과');
    // 검증 기록이 없으면 그대로
    expect(headStatus(item('i', { terminal: { cli: 'up' } })).label).toBe('CLI 대기');
  });

  it('샌드박스를 띄우는 중이면 "준비 중"이고 지금 줄에 무엇을 하는지 적는다', () => {
    const booting = item('b', { state: 'booting' });
    expect(agentStatus(booting).label).toBe('준비 중');
    expect(draw(booting)[2]).toContain('샌드박스');
  });
});

describe('남은 시간 추정은 작업 중이고 충분히 지났을 때만', () => {
  const working = { state: 'working' as const, todos: { done: 2, total: 4 } };
  it('작업 중, 5분 지남, 2개 끝냄이면 적는다', () => {
    expect(remainingText(item('w', { ...working, workingSince: ago(5 * 60) }), NOW)).toMatch(/남음\(추정\)/);
  });
  it('시작 20초 만에는 적지 않는다', () => {
    expect(remainingText(item('w', { ...working, workingSince: ago(20) }), NOW)).toBe('');
  });
  it('권한을 기다리거나 오류면 적지 않는다', () => {
    expect(remainingText(item('w', { ...working, workingSince: ago(5 * 60), terminal: { cli: 'up', waiting: 'permission' } }), NOW)).toBe('');
    expect(remainingText(item('w', { ...working, state: 'error', workingSince: ago(5 * 60) }), NOW)).toBe('');
  });
});

const stateOf = (items: DeskItem[], patch: Partial<DeskState> = {}): DeskState => ({ ...initialState(), items, view: 'space', ...patch });

describe('좁은 화면', () => {
  for (const size of [
    { cols: 100, rows: 30 },
    { cols: 80, rows: 24 },
  ]) {
    it(`${size.cols}x${size.rows}: 모든 줄이 화면 폭과 같고 카드 테두리 안쪽 글이 테두리를 넘지 않는다`, () => {
      const items = [item('e', { state: 'error', reason: '60초 안에 준비되지 않았습니다 (마지막 확인: HTTP 404, 컨테이너 로그를 보세요)' }), done];
      const { lines } = renderScreen(stateOf(items, { selected: 1 }), size, []);
      for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(size.cols);
      // 카드 줄은 │로 시작하면 │로 끝난다
      for (const line of lines.map(stripAnsi)) {
        const body = line.slice(line.indexOf('│') + 1);
        const open = body.indexOf('│');
        if (open < 0 || !body.includes('╭') && !body.trimStart().startsWith('│')) continue;
        expect(body.trimEnd().endsWith('│') || body.trimEnd().endsWith('╮') || body.trimEnd().endsWith('╯')).toBe(true);
      }
    });
  }

  it('80열에서 사이드바는 화면의 1/4을 넘지 않는다', () => {
    expect(computeLayout(80, 24, 1).sidebar.w).toBeLessThanOrEqual(20);
    expect(computeLayout(160, 40, 1).sidebar.w).toBe(32);
  });

  it('카드가 다 들어가지 않으면 몇 장이 더 있는지 맨 아래에 알린다', () => {
    const items = [item('a', { state: 'working' }), item('b'), item('c'), done];
    const { lines } = spaceScreen(stateOf(items), { x: 21, y: 1, w: 59, h: 22 }, NOW);
    expect(lines.map(stripAnsi).join('\n')).toMatch(/카드 \d+장 더/);
  });
});

describe('화면 겉', () => {
  it('카드·사용량 화면에서는 칸의 커서를 보이지 않는다', () => {
    const items = [item('a')];
    const panes = [{ lines: ['$ '], cursor: { x: 2, y: 0 } }];
    const base = { slots: ['a', undefined, undefined, undefined] as DeskState['slots'] };
    expect(renderScreen(stateOf(items, { ...base, view: undefined }), { cols: 100, rows: 20 }, panes).cursor).toBeDefined();
    expect(renderScreen(stateOf(items, base), { cols: 100, rows: 20 }, panes).cursor).toBeUndefined();
    expect(renderScreen(stateOf(items, { ...base, view: 'usage' }), { cols: 100, rows: 20 }, panes).cursor).toBeUndefined();
  });

  it('세션이 없으면 카드 화면 아래 안내에 쓸 수 없는 키(Enter, i, d)를 두지 않는다', () => {
    const bottom = stripAnsi(renderScreen(stateOf([]), { cols: 120, rows: 20 }, []).lines.at(-1)!);
    expect(bottom).not.toContain('Enter');
    expect(bottom).not.toContain('i 자세히');
    expect(bottom).toContain('a ');
  });

  it('두 칸일 때 칸 머리는 제목을 …로 줄이고 상태는 남긴다(낱말 중간에서 말없이 끊지 않는다)', () => {
    const items = [item('a', { title: '주문 모듈을 서비스 계층으로 나누고 결제 실패 경로 테스트를 보강해 줘', state: 'working' }), item('b')];
    const { lines } = renderScreen(stateOf(items, { view: undefined, layout: 2, slots: ['a', 'b', undefined, undefined] }), { cols: 100, rows: 20 }, [{ lines: [] }, { lines: [] }]);
    const head = stripAnsi(lines[1]!);
    const first = head.slice(head.indexOf('│') + 1).split('│')[0]!.trimEnd();
    expect(first).toContain('…');
    expect(first).toMatch(/작업 중$/);
  });
});

describe('사용량 카드', () => {
  it('읽지 못한 까닭이 길면 낱말 사이에서 줄을 나눠 다 보이고 테두리를 넘지 않는다', () => {
    const failed: DeskAccountLimits = { id: 'c', backend: 'claude-code', name: '기본', status: 'unknown', windows: [], source: 'claude-oauth', fetchedAt: ago(10), error: 'Claude 사용량 API를 꺼 두었습니다(B_STUDIO_CLAUDE_USAGE_API=0)' };
    const lines = usageCardLines({ account: failed, selected: true, sprite: defaultSprite('claude-code') }, 52, DEFAULT_THEME, NOW).map(stripAnsi);
    for (const line of lines) expect(stringWidth(line)).toBe(52);
    const joined = lines.map((line) => textOf(line, 12).trim()).join(' ');
    expect(joined.replace(/\s+/g, '')).toContain('꺼두었습니다');
  });
});

describe('좁을 때 숫자·낱말을 반쯤 자르지 않는다', () => {
  const limits: DeskAccountLimits = { id: 'w', backend: 'claude-code', name: '에리', status: 'exhausted', windows: [{ kind: 'weekly', usedPercent: 100, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }], source: 'claude-oauth', fetchedAt: ago(10) };
  it('사이드바 맨 아래 한도 줄은 좁으면 뒤 항목을 빼고 %는 온전히 남긴다("주간 10"이 아니다)', () => {
    for (const width of [19, 24, 32]) {
      const line = stripAnsi(tightestLine([limits], width)!);
      expect(stringWidth(line)).toBe(width);
      expect(line).toContain('100%');
    }
  });

  it('사이드바 세션 제목이 잘리면 …를 붙인다', () => {
    const rows = sidebarRows([item('a', { title: '주문 모듈을 서비스 계층으로 나눠 줘', state: 'working', workingSince: ago(23 * 60) })], 0, new Map(), 20, new Set(), DEFAULT_THEME, new Set());
    const line = stripAnsi(rows.find((row) => row.item === 0)!.text);
    expect(line).toContain('…');
    expect(stringWidth(line)).toBe(20);
  });

  it('고른 카드의 마지막 답은 낱말 사이에서 줄을 나눈다', () => {
    const text = draw(done, { selected: true }, 84).map((line) => textOf(line, 14).trimEnd());
    const at = text.findIndex((line) => line.startsWith('답 '));
    const first = text[at]!;
    // 첫 줄 끝 낱말이 원문의 온전한 낱말이다
    expect(LONG.split(' ')).toContain(first.split(' ').at(-1));
  });
});

describe('말줄임표는 한 번만', () => {
  it('사이드바 제목과 마지막 답의 끝에 …가 겹치지 않는다', () => {
    const rows = sidebarRows([item('a', { title: '주문 모듈 리팩터링', state: 'working', workingSince: ago(23 * 60) })], 0, new Map(), 20, new Set(), DEFAULT_THEME, new Set());
    expect(rows.map((row) => stripAnsi(row.text)).join('\n')).not.toContain('……');
    const long = { ...done, lastMessage: '가'.repeat(400) };
    expect(draw(long, { selected: true }, 84).join('\n')).not.toContain('……');
  });
});
