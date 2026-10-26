import { describe, expect, it } from 'vitest';
import { initialState, type DeskState } from './keys';
import { previewLine, renderScreen, stripAnsi } from './render';
import { PaneTerminal } from './pane';
import { computeLayout, stringWidth } from './screen';
import { bg, fg } from './theme';
import type { DeskItem } from './types';

const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-22T00:00:00Z', ...patch });
const size = { cols: 100, rows: 20 };

function state(patch: Partial<DeskState> = {}): DeskState {
  return { ...initialState(), items: [item('a', { state: 'working', gate: { state: 'passed', checkpoints: 2 } }), item('b', { backend: 'codex' })], ...patch };
}

describe('화면 그리기', () => {
  it('모든 줄이 화면 폭과 정확히 같다(색 제어 문자는 폭에 넣지 않는다)', () => {
    const { lines } = renderScreen(state({ layout: 4, slots: ['a', 'b', undefined, undefined] }), size, [{ lines: ['hello'] }, { lines: ['세계'] }, { lines: [] }, { lines: [] }]);
    expect(lines).toHaveLength(size.rows);
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(size.cols);
  });

  it('머리 줄에 이름과 칸 수, 아래 줄에 키 안내가 있고, 앞글쇠를 누르면 표시가 바뀐다', () => {
    const plain = renderScreen(state(), size, []).lines.map(stripAnsi);
    expect(plain[0]).toContain('b-studio desk');
    expect(plain[0]).toContain('칸 1');
    expect(plain[size.rows - 1]).toContain('Ctrl-b');
    const prefixed = renderScreen(state({ prefix: true }), size, []).lines.map(stripAnsi);
    expect(prefixed[size.rows - 1]).toContain('숫자');
  });

  it('왼쪽에 스페이스 사이드바, 구분선, 오른쪽에 칸 머리와 터미널 내용이 놓이고, 사이드바 맨 아래에는 키 안내를 두지 않는다(#935)', () => {
    const { lines } = renderScreen(state({ slots: ['a', undefined, undefined, undefined] }), size, [{ lines: ['$ echo hi', 'hi'] }]);
    // 화면 칸 기준으로 가른다(한글은 한 글자가 두 칸이라 글자 수로 자르면 어긋난다)
    const split = (line: string) => {
      const at = line.indexOf('│');
      return { side: line.slice(0, at), pane: line.slice(at + 1) };
    };
    const plain = lines.map(stripAnsi).map(split);
    expect(stringWidth(plain[1]!.side)).toBe(30);
    expect(plain[1]!.side).toContain('스페이스');
    expect(plain[2]!.side).toContain('shop');
    expect(plain[3]!.side).toContain('요청 a');
    expect(plain[size.rows - 2]!.side).not.toContain('Ctrl-b w');
    expect(plain[size.rows - 2]!.side.trim()).not.toMatch(/\? 키$/);
    expect(plain[1]!.pane).toMatch(/^ 1 /);
    expect(plain[1]!.pane).toContain('요청 a');
    expect(plain[1]!.pane).toContain('통과');
    expect(plain[2]!.pane).toContain('$ echo hi');
    expect(plain[3]!.pane).toContain('hi');
  });

  it('스페이스가 많아도 고른 세션이 든 스페이스와 그 세션이 사이드바에 보인다', () => {
    const items = Array.from({ length: 30 }, (_, index) => item(`s${index}`, { projectName: `p${index}` }));
    const plain = renderScreen(state({ items, selected: 29 }), size, []).lines.map(stripAnsi);
    const side = plain.slice(1, size.rows - 1).map((line) => line.slice(0, line.indexOf('│')));
    expect(side.some((line) => line.includes('p29'))).toBe(true);
    expect(side.some((line) => line.includes('요청 s29'))).toBe(true);
  });

  it('고른 칸의 머리와 고른 사이드바 줄은 바탕색으로 가른다(반전을 쓰지 않는다)', () => {
    const theme = { name: 'dark' as const, depth: 'truecolor' as const };
    const { lines } = renderScreen(state({ layout: 2, slots: ['a', 'b', undefined, undefined], focus: 1, theme }), size, [{ lines: [] }, { lines: [] }]);
    const header = lines[1]!;
    const active = bg(theme, 'active');
    // 오른쪽 칸(둘째)의 머리만 밝은 바탕에 강조색 칸 번호다
    const left = header.slice(header.indexOf('│'), header.lastIndexOf('│'));
    const right = header.slice(header.lastIndexOf('│'));
    expect(right).toContain(active);
    expect(right).toContain(`${fg(theme, 'accent')} 2 `);
    expect(left).not.toContain(active);
    expect(header).not.toContain('\x1b[7m');
    expect(stripAnsi(header).indexOf('요청 b')).toBeGreaterThan(stripAnsi(header).indexOf('요청 a'));
    const selectedRow = lines.find((line) => stripAnsi(line).startsWith('   ◐ 요청 a'))!;
    expect(selectedRow.startsWith(bg(theme, 'active'))).toBe(true);
  });

  it('256색 팔레트면 24비트 색을 쓰지 않는다', () => {
    const { lines } = renderScreen(state({ theme: { name: 'light', depth: '256' }, view: 'space' }), size, []);
    expect(lines.join('')).not.toMatch(/\x1b\[[34]8;2;/);
    expect(lines.join('')).toMatch(/\x1b\[[34]8;5;/);
  });

  it('스페이스 화면: 본문에 고른 스페이스의 세션 카드가 놓이고, 모든 줄이 화면 폭과 같다', () => {
    const items = [item('a', { state: 'working', gate: { state: 'passed', checkpoints: 2 } }), item('b', { backend: 'codex' }), item('c', { projectName: 'blog' })];
    const { lines } = renderScreen(state({ items, view: 'space' }), { cols: 140, rows: 30 }, []);
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(140);
    const plain = lines.map(stripAnsi).join('\n');
    expect(plain).toContain('스페이스 화면');
    expect(plain).toMatch(/shop +에이전트 2/);
    expect(plain).toContain('╭');
    expect(plain).toMatch(/요청 a +Claude +.*◐ 작업 중/);
    expect(plain).toMatch(/요청 b +Codex/);
    // 다른 스페이스의 세션은 카드로 놓지 않는다
    expect(plain).not.toMatch(/요청 c +Claude/);
  });

  it('빈 칸에는 여는 법을 적는다', () => {
    const plain = renderScreen(state(), size, [{ lines: [] }]).lines.map(stripAnsi).join('\n');
    expect(plain).toContain('Ctrl-b Enter');
  });

  it('칸에 남긴 알림(닫힘·오류)을 칸 머리에 보인다', () => {
    const plain = renderScreen(state({ slots: ['a', undefined, undefined, undefined] }), size, [{ lines: [], note: '세션이 멈췄습니다' }]).lines.map(stripAnsi);
    expect(plain[1]).toContain('세션이 멈췄습니다');
  });

  it('커서는 고른 칸의 터미널 커서 자리에 둔다', () => {
    const { cursor } = renderScreen(state({ slots: ['a', undefined, undefined, undefined] }), size, [{ lines: ['abc'], cursor: { x: 3, y: 0 } }]);
    expect(cursor).toEqual({ x: 31 + 3, y: 2 });
  });

  it('새 요청 입력 중에는 아래 두 줄이 입력과 미리보기가 되고 커서는 입력 끝에 있다', () => {
    const prompt = { step: 'request' as const, projects: [{ id: 'p1', name: 'shop' }], projectIndex: 0, text: '주문', choices: ['rules', 'codex'], choice: 0, preview: 'Codex로 보냅니다 · 규칙 1' };
    const { lines, cursor } = renderScreen(state({ prompt }), size, []);
    const plain = lines.map(stripAnsi);
    expect(plain[size.rows - 2]).toContain('Codex로 보냅니다');
    expect(plain[size.rows - 2]).toContain('규칙대로');
    expect(plain[size.rows - 1]).toContain('shop');
    expect(plain[size.rows - 1]).toContain('주문');
    expect(cursor!.y).toBe(size.rows - 1);
    expect(cursor!.x).toBe(stringWidth(plain[size.rows - 1]!.trimEnd()));
  });

  it('남긴 안내(message)는 아래 줄에 보인다', () => {
    const plain = renderScreen(state({ message: '보냈습니다' }), size, []).lines.map(stripAnsi);
    expect(plain[size.rows - 1]).toContain('보냈습니다');
  });
});

describe('칸 줄의 폭(#860)', () => {
  it('칸 해석기가 낸 줄을 다시 재지 않는다: 이모지·풀어쓴 한글이 있어도 잘리지 않고 구분선이 밀리지 않는다', async () => {
    const rect = computeLayout(size.cols, size.rows, 2).panes[0]!;
    const pane = new PaneTerminal(rect.w, rect.h - 1);
    // 칸을 꽉 채운다: 폭을 잘못 세면 끝의 |가 잘리거나 구분선이 밀린다
    await pane.write(`a😀b🚀c ${'한글'.normalize('NFD')} 끝${'x'.repeat(rect.w - 16)}|`);
    const { lines } = renderScreen(state({ layout: 2, slots: ['a', 'b', undefined, undefined] }), size, [{ lines: pane.lines(), cols: pane.cols }, { lines: ['right'], cols: 5 }]);
    const row = stripAnsi(lines[2]!).normalize('NFC');
    expect(row).toContain(`a😀b🚀c 한글 끝${'x'.repeat(rect.w - 16)}|│right`);
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(size.cols);
    pane.dispose();
  });
});

describe('미리보기 줄', () => {
  it('규칙과 같은 종류의 기록을 한 줄로 쓴다', () => {
    expect(previewLine({ backend: 'codex', model: 'gpt-5.5', rule: 0, matched: '위험', records: [{ backend: 'codex', passed: 4, judged: 5 }] })).toBe('Codex (gpt-5.5)로 보냅니다 · 규칙 1(위험) · 같은 종류 기록: Codex 통과 4/5');
    expect(previewLine({ backend: 'claude-code', rule: 'default', matched: '맞는 규칙 없음' })).toBe('Claude로 보냅니다 · 맞는 규칙이 없어 서버 기본 AI');
    expect(previewLine({ backend: 'claude-code', rule: 'fallback', matched: '기본값' })).toBe('Claude로 보냅니다 · 맞는 규칙이 없어 기본값');
  });

  it('직접 고른 AI가 있으면 규칙 미리보기 대신 그 AI로 바로 보낸다고 쓴다', () => {
    const prompt = { step: 'request' as const, projects: [{ id: 'p1', name: 'shop' }], projectIndex: 0, text: 'x', choices: ['rules', 'codex'], choice: 1, preview: 'Claude로 보냅니다 · 규칙 1' };
    const plain = renderScreen(state({ prompt }), size, []).lines.map(stripAnsi);
    expect(plain[size.rows - 2]).toContain('Codex로 바로 보냅니다');
    expect(plain[size.rows - 2]).not.toContain('Claude로 보냅니다');
  });
});

describe('여러 AI 비교 화면 그리기(#892)', () => {
  it('비교 화면은 사이드바 없이 본문 전체에 그리고, 맨 아래 줄은 비교 화면의 안내다', () => {
    const fleets = { mode: 'list' as const, fleets: [{ id: 'f1', projectId: 'shop', projectName: 'shop', request: '검색을 추가해줘', createdAt: '2026-10-23T00:00:00Z', members: [] }], row: 0, member: 0 };
    const { lines } = renderScreen(state({ fleets }), size, []);
    const text = lines.map(stripAnsi);
    expect(text[0]).toContain('여러 AI 비교');
    expect(text.join('\n')).toContain('검색을 추가해줘');
    expect(text.join('\n')).not.toContain('스페이스');
    expect(text.at(-1)).toContain('n 새 비교');
    expect(lines).toHaveLength(size.rows);
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(size.cols);
  });

  it('도움말에 f 키가 있다', () => {
    const text = renderScreen(state({ help: true }), { cols: 140, rows: 60 }, []).lines.map(stripAnsi).join('\n');
    expect(text).toMatch(/f\s+여러 AI 비교/);
  });
});

describe('빠른 전환과 안 본 끝남(#922)', () => {
  it('빠른 전환 목록을 본문 자리에 급한 순으로 그리고, 커서를 찾기 칸에 둔다', () => {
    const items = [item('a'), item('b', { terminal: { cli: 'up', waiting: 'permission' } })];
    const switcher = { query: '요청', index: 0, order: ['b', 'a'] };
    const { lines, cursor } = renderScreen(state({ items, switcher }), size, []);
    const plain = lines.map(stripAnsi);
    expect(lines).toHaveLength(size.rows);
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(size.cols);
    expect(plain[0]).toContain('빠른 전환');
    const find = plain.findIndex((line) => line.includes('찾기 › 요청'));
    expect(find).toBeGreaterThan(0);
    const urgent = plain.findIndex((line) => /권한 대기\s+요청 b/.test(line));
    expect(urgent).toBeGreaterThan(find);
    expect(urgent).toBeLessThan(plain.findIndex((line) => /쉼\s+요청 a/.test(line)));
    expect(cursor?.y).toBe(find);
    expect(plain.at(-1)).toContain('빠른 전환');
  });

  it('도움말에 j와 Space가 있다', () => {
    const plain = renderScreen(state({ help: true }), { cols: 160, rows: 60 }, []).lines.map(stripAnsi).join('\n');
    expect(plain).toContain('다음 확인');
    expect(plain).toContain('빠른 전환');
  });
});

describe('아래 키 안내는 한 줄에 몇 개만(#935)', () => {
  const footer = (patch: Partial<DeskState>, cols = 100) => stripAnsi(renderScreen(state(patch), { cols, rows: 20 }, []).lines.at(-1)!);

  it('칸·앞글쇠·카드·사용량 화면의 안내는 잘린 글자 없이 다섯 개 안팎이고, 끝에 모든 키를 보는 법이 있다', () => {
    for (const patch of [{}, { prefix: true }, { view: 'space' as const }, { view: 'usage' as const }]) {
      for (const cols of [100, 72]) {
        const line = footer(patch, cols);
        expect(line).not.toContain('…');
        expect(line).toContain('모든 키');
        expect(line.trim().split(' · ').length).toBeLessThanOrEqual(7);
      }
    }
  });

  it('카드 화면 안내에는 고르기·열기·닫기가 있다', () => {
    const line = footer({ view: 'space' });
    expect(line).toContain('Enter');
    expect(line).toContain('Esc');
  });

  it('덮는 화면의 긴 안내도 폭이 모자라면 뒤 항목부터 통째로 빠지고 Esc는 남는다', () => {
    const fleets = { mode: 'detail' as const, fleets: [], row: 0, member: 0 };
    const line = footer({ fleets }, 60);
    expect(line).not.toContain('…');
    expect(line).toContain('Esc');
  });
});
