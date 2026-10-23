import { describe, expect, it } from 'vitest';
import { initialState, type DeskState } from './keys';
import { previewLine, renderScreen, stripAnsi } from './render';
import { PaneTerminal } from './pane';
import { computeLayout, stringWidth } from './screen';
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

  it('왼쪽에 사이드바, 구분선, 오른쪽에 칸 머리와 터미널 내용이 놓인다', () => {
    const { lines } = renderScreen(state({ slots: ['a', undefined, undefined, undefined] }), size, [{ lines: ['$ echo hi', 'hi'] }]);
    // 화면 칸 기준으로 가른다(한글은 한 글자가 두 칸이라 글자 수로 자르면 어긋난다)
    const split = (line: string) => {
      const at = line.indexOf('│');
      return { side: line.slice(0, at), pane: line.slice(at + 1) };
    };
    const plain = lines.map(stripAnsi).map(split);
    expect(stringWidth(plain[1]!.side)).toBe(30);
    expect(plain[1]!.side).toContain('Claude');
    expect(plain[2]!.side).toContain('통과');
    expect(plain[1]!.pane).toMatch(/^ 1 /);
    expect(plain[1]!.pane).toContain('요청 a');
    expect(plain[2]!.pane).toContain('$ echo hi');
    expect(plain[3]!.pane).toContain('hi');
  });

  it('고른 항목이 아래쪽이어도 그 아래 펼친 에이전트 내역까지 사이드바에 보인다(#843)', () => {
    const usage = { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const items = Array.from({ length: 12 }, (_, index) => item(`s${index}`));
    items[11] = item('s11', {
      agents: [
        { id: 'main', name: '메인', kind: 'main', state: 'idle', tokens: usage },
        { id: 'claude:Explore', name: 'Explore', kind: 'subagent', state: 'working', activity: '모델 요청 1회', tokens: usage },
      ],
      capabilities: { backend: 'claude-code', tools: 'cli-default', writeScope: '세션 작업 복사본 전체', permission: 'CLI 권한 확인' },
    });
    const plain = renderScreen(state({ items, selected: 11 }), size, []).lines.map(stripAnsi);
    const side = plain.slice(1, size.rows - 1).map((line) => line.slice(0, line.indexOf('│')));
    expect(side.some((line) => line.includes('요청 s11'))).toBe(true);
    expect(side.some((line) => line.includes('↳ Explore'))).toBe(true);
    expect(side.some((line) => line.includes('권한 CLI 권한 확인'))).toBe(true);
  });

  it('고른 칸의 머리는 반전으로, 고른 사이드바 줄도 반전으로 그린다', () => {
    const { lines } = renderScreen(state({ layout: 2, slots: ['a', 'b', undefined, undefined], focus: 1 }), size, [{ lines: [] }, { lines: [] }]);
    const header = lines[1]!;
    // 오른쪽 칸(둘째)의 머리에만 반전이 있다
    const second = header.lastIndexOf('\x1b[7m');
    expect(second).toBeGreaterThan(header.indexOf('│'));
    expect(stripAnsi(header).indexOf('요청 b')).toBeGreaterThan(stripAnsi(header).indexOf('요청 a'));
    expect(lines[1]!.startsWith('\x1b[7m')).toBe(true);
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
