import { describe, expect, it } from 'vitest';
import { flushPending, handleInput, initialState, pasteFor, reselect, toInnerKeys, type DeskState, type Effect } from './keys';
import type { DeskItem } from './types';

const item = (id: string): DeskItem => ({ kind: 'session', id, title: id, projectName: 'shop', state: 'idle', lastActivityAt: '2026-10-22T00:00:00Z' });

function withItems(patch: Partial<DeskState> = {}): DeskState {
  return { ...initialState(), items: [item('a'), item('b'), item('c')], ...patch };
}

describe('키 처리', () => {
  it('앞글쇠가 없으면 친 글자를 고른 칸의 세션으로 그대로 보낸다', () => {
    const { effects } = handleInput(withItems({ slots: ['a', undefined, undefined, undefined] }), 'ls -la\r');
    expect(effects).toEqual([{ type: 'input', id: 'a', data: 'ls -la\r' }]);
  });

  it('고른 칸이 비었으면 아무 데도 보내지 않는다', () => {
    expect(handleInput(withItems(), 'hello').effects).toEqual([]);
  });

  it('Ctrl-b 다음 Ctrl-b는 Ctrl-b 한 글자를 칸으로 보낸다', () => {
    const { effects } = handleInput(withItems({ slots: ['a', undefined, undefined, undefined] }), '\x02\x02');
    expect(effects).toEqual([{ type: 'input', id: 'a', data: '\x02' }]);
  });

  it('사이드바를 ↑↓로 고르는 중에 다시 누른 Ctrl-b는 칸으로 보내지 않고 새 앞글쇠로 본다(#855)', () => {
    const state = withItems({ layout: 2, slots: ['a', 'b', undefined, undefined] });
    const { state: next, effects } = handleInput(state, '\x02\x1b[B\x022');
    expect(effects).toEqual([]);
    expect(next.focus).toBe(1);
    expect(next.selected).toBe(1);
    expect(next.prefix).toBe(false);
  });

  it('사이드바를 고르는 중에는 아래 줄에 그 사실을 알린다(#855)', () => {
    const { state: next } = handleInput(withItems(), '\x02\x1b[B');
    expect(next.prefix).toBe(true);
    expect(next.message).toContain('사이드바');
  });

  it('Ctrl-b 앞뒤의 글자는 나눠서 보내고, 명령 글쇠는 보내지 않는다', () => {
    const state = withItems({ layout: 2, slots: ['a', 'b', undefined, undefined] });
    const { state: next, effects } = handleInput(state, 'x\x022y');
    expect(effects).toEqual([
      { type: 'input', id: 'a', data: 'x' },
      { type: 'input', id: 'b', data: 'y' },
    ]);
    expect(next.focus).toBe(1);
  });

  it('앞글쇠는 한 번에 와도, 나눠 와도 같다', () => {
    const first = handleInput(withItems({ layout: 2 }), '\x02');
    expect(first.state.prefix).toBe(true);
    const second = handleInput(first.state, '2');
    expect(second.state.focus).toBe(1);
    expect(second.state.prefix).toBe(false);
  });

  it('칸 수보다 큰 숫자는 무시한다', () => {
    expect(handleInput(withItems({ layout: 1 }), '\x023').state.focus).toBe(0);
  });

  it('방향키로 사이드바를 움직이고(앞글쇠가 이어진다) Enter로 고른 세션을 고른 칸에 연다', () => {
    let state = withItems();
    state = handleInput(state, '\x02\x1b[B').state;
    expect(state.prefix).toBe(true);
    state = handleInput(state, '\x1b[B').state;
    expect(state.selected).toBe(2);
    state = handleInput(state, '\x1b[B').state;
    expect(state.selected).toBe(2);
    const { state: opened, effects } = handleInput(state, '\r');
    expect(effects).toEqual([{ type: 'open', slot: 0, id: 'c' }]);
    expect(opened.slots[0]).toBe('c');
    expect(opened.prefix).toBe(false);
  });

  it('이미 다른 칸에 열린 세션을 고르면 새로 열지 않고 그 칸으로 간다(터미널이 끝났으면 다시 열라고만 알린다)', () => {
    const state = withItems({ layout: 2, slots: ['a', 'b', undefined, undefined], selected: 1 });
    const { state: next, effects } = handleInput(state, '\x02\r');
    expect(effects).toEqual([{ type: 'reopen', id: 'b' }]);
    expect(next.focus).toBe(1);
  });

  it('고른 칸에 다른 세션이 있으면 그 칸을 바꾼다(앞 세션은 닫지 않고 칸에서만 뺀다)', () => {
    const state = withItems({ slots: ['a', undefined, undefined, undefined], selected: 2 });
    const { state: next, effects } = handleInput(state, '\x02\r');
    expect(effects).toEqual([{ type: 'open', slot: 0, id: 'c' }]);
    expect(next.slots[0]).toBe('c');
  });

  it('l은 칸 수를 1→2→4→1로 바꾸고, 줄어들면 남는 칸의 세션은 칸에서 빼고 고른 칸을 맞춘다', () => {
    let state = withItems();
    state = handleInput(state, '\x02l').state;
    expect(state.layout).toBe(2);
    state = handleInput(state, '\x02l').state;
    expect(state.layout).toBe(4);
    state = { ...state, slots: ['a', 'b', 'c', undefined], focus: 2 };
    const { state: back, effects } = handleInput(state, '\x02l');
    expect(back.layout).toBe(1);
    expect(back.focus).toBe(0);
    expect(back.slots).toEqual(['a', undefined, undefined, undefined]);
    expect(effects).toEqual([{ type: 'layout' }]);
  });

  it('x는 고른 칸을 비운다(세션은 계속 돈다), q는 나간다', () => {
    const state = withItems({ slots: ['a', undefined, undefined, undefined] });
    const closed = handleInput(state, '\x02x');
    expect(closed.state.slots[0]).toBeUndefined();
    expect(closed.effects).toEqual([{ type: 'close', slot: 0, id: 'a' }]);
    expect(handleInput(state, '\x02q').effects).toEqual([{ type: 'quit' }]);
  });

  it('모르는 글쇠는 앞글쇠를 풀고 안내를 남긴다', () => {
    const { state, effects } = handleInput(withItems(), '\x02z');
    expect(state.prefix).toBe(false);
    expect(state.message).toContain('Ctrl-b');
    expect(effects).toEqual([]);
  });
});

describe('새 요청 입력', () => {
  const prompting = (): DeskState =>
    withItems({
      slots: ['a', undefined, undefined, undefined],
      prompt: { step: 'project', projects: [{ id: 'p1', name: 'shop' }, { id: 'p2', name: 'blog' }], projectIndex: 0, text: '', choices: ['rules', 'claude-code', 'codex'], choice: 0 },
    });

  it('n은 새 요청 입력을 연다', () => {
    expect(handleInput(withItems(), '\x02n').effects).toEqual([{ type: 'prompt' }]);
  });

  it('입력하는 동안 친 글자는 칸으로 가지 않는다', () => {
    const state = prompting();
    const { effects } = handleInput({ ...state, prompt: { ...state.prompt!, step: 'request' } }, 'hi');
    expect(effects.some((effect) => effect.type === 'input')).toBe(false);
  });

  it('프로젝트를 고르고, 요청을 쓰고(지우기 포함), Tab으로 AI를 바꾼 뒤 Enter로 보낸다', () => {
    let state = prompting();
    state = handleInput(state, '\x1b[B').state;
    expect(state.prompt!.projectIndex).toBe(1);
    state = handleInput(state, '\r').state;
    expect(state.prompt!.step).toBe('request');
    let result = handleInput(state, '주문 목록x');
    expect(result.effects).toContainEqual({ type: 'preview', text: '주문 목록x' });
    result = handleInput(result.state, '\x7f');
    expect(result.state.prompt!.text).toBe('주문 목록');
    result = handleInput(result.state, '\t\t');
    expect(result.state.prompt!.choice).toBe(2);
    result = handleInput(result.state, '\r');
    expect(result.effects).toEqual([{ type: 'submit', projectId: 'p2', request: '주문 목록', choice: 'codex' }]);
    expect(result.state.prompt!.sending).toBe(true);
  });

  it('빈 요청은 보내지 않고, 보내는 중에는 다시 보내지 않는다', () => {
    const state = prompting();
    const request = { ...state, prompt: { ...state.prompt!, step: 'request' as const } };
    expect(handleInput(request, '\r').effects).toEqual([]);
    const sending = { ...state, prompt: { ...state.prompt!, step: 'request' as const, text: 'x', sending: true } };
    expect(handleInput(sending, '\r').effects).toEqual([]);
  });

  it('Esc나 Ctrl-c는 입력을 닫는다', () => {
    // 혼자 온 Esc는 방향키의 앞일 수 있어 잠깐 기다린다(desk가 곧 flushPending을 부른다)
    expect(flushPending(handleInput(prompting(), '\x1b').state).state.prompt).toBeUndefined();
    expect(handleInput(prompting(), '\x03').state.prompt).toBeUndefined();
  });

  it('붙여 넣은 줄바꿈은 보내기가 아니라 빈칸이 된다', () => {
    const state = prompting();
    const request = { ...state, prompt: { ...state.prompt!, step: 'request' as const } };
    const { state: next, effects } = handleInput(request, 'a\nb');
    expect(next.prompt!.text).toBe('a b');
    expect(effects.some((effect) => effect.type === 'submit')).toBe(false);
  });
});

describe('붙여넣기와 나뉘어 온 키(#860)', () => {
  const open = (patch: Partial<DeskState> = {}) => withItems({ slots: ['a', undefined, undefined, undefined], ...patch });

  it('붙여넣기 묶음 안의 Ctrl-b는 명령으로 읽지 않고, 묶음은 paste로 칸에 간다', () => {
    const { state, effects } = handleInput(open(), 'x\x1b[200~line1\rline2\x02x\x1b[201~y');
    expect(effects).toEqual([
      { type: 'input', id: 'a', data: 'x' },
      { type: 'paste', id: 'a', data: 'line1\rline2\x02x' },
      { type: 'input', id: 'a', data: 'y' },
    ]);
    expect(state.slots[0]).toBe('a');
    expect(state.prefix).toBe(false);
  });

  it('붙여넣기 표지가 조각 경계에서 나뉘어 와도 같다', () => {
    let state = open();
    const effects: unknown[] = [];
    for (const chunk of ['\x1b[20', '0~ab\x02', 'x\x1b[2', '01~']) {
      const result = handleInput(state, chunk);
      state = result.state;
      effects.push(...result.effects);
    }
    // 조각으로 나눠 보내도 이어 붙이면 붙여넣기 하나다
    const pastes = effects as Array<Extract<Effect, { type: 'paste' }>>;
    expect(pastes.every((effect) => effect.type === 'paste' && effect.id === 'a')).toBe(true);
    expect(pastes.map((effect) => pasteFor(effect, true)).join('')).toBe('\x1b[200~ab\x02x\x1b[201~');
    expect(state.slots[0]).toBe('a');
    expect(state.pending).toBeUndefined();
  });

  it('긴 붙여넣기가 여러 조각으로 오면 조각마다 내용을 보낸다', () => {
    let state = open();
    const effects: unknown[] = [];
    for (const chunk of ['\x1b[200~hello ', 'world\x1b[201~']) {
      const result = handleInput(state, chunk);
      state = result.state;
      effects.push(...result.effects);
    }
    expect(effects).toEqual([
      { type: 'paste', id: 'a', data: 'hello ', part: 'start' },
      { type: 'paste', id: 'a', data: 'world', part: 'end' },
    ]);
  });

  it('앞글쇠 뒤 방향키가 조각 경계에서 나뉘어 와도 CLI로 새지 않는다', () => {
    const first = handleInput(open(), '\x02\x1b');
    expect(first.effects).toEqual([]);
    const second = handleInput(first.state, '[B');
    expect(second.effects).toEqual([]);
    expect(second.state.selected).toBe(1);
  });

  it('끝이 Esc 하나로 끝나 기다리던 글은 flushPending이 그대로 보낸다', () => {
    const first = handleInput(open(), 'q\x1b');
    expect(first.effects).toEqual([{ type: 'input', id: 'a', data: 'q' }]);
    expect(first.state.pending).toBe('\x1b');
    const flushed = flushPending(first.state);
    expect(flushed.effects).toEqual([{ type: 'input', id: 'a', data: '\x1b' }]);
    expect(flushed.state.pending).toBeUndefined();
  });

  it('새 요청 입력 중의 붙여넣기는 줄바꿈을 빈칸으로 바꿔 요청 글에 넣고 보내지 않는다', () => {
    const state = withItems({ prompt: { step: 'request', projects: [{ id: 'p', name: 'shop' }], projectIndex: 0, text: '', choices: ['rules'], choice: 0 } });
    const { state: next, effects } = handleInput(state, '\x1b[200~고쳐\r줘\x02\x1b[201~');
    expect(next.prompt?.text).toBe('고쳐 줘');
    expect(effects.some((effect) => effect.type === 'submit')).toBe(false);
  });
});

describe('안쪽 CLI의 모드 따르기(#860)', () => {
  it('응용 커서 키 모드면 방향키를 SS3 꼴로 바꾼다', () => {
    expect(toInnerKeys('\x1b[A\x1b[Bx\x1b[1;5C', { appCursor: true })).toBe('\x1bOA\x1bOBx\x1b[1;5C');
    expect(toInnerKeys('\x1b[A', { appCursor: false })).toBe('\x1b[A');
  });

  it('CLI가 bracketed paste를 켰을 때만 표지로 감싸고, 내용 안의 끝 표지는 지운다', () => {
    expect(pasteFor({ type: 'paste', id: 'a', data: 'a\x1b[201~b' }, true)).toBe('\x1b[200~ab\x1b[201~');
    expect(pasteFor({ type: 'paste', id: 'a', data: 'a\nb' }, false)).toBe('a\nb');
    expect(pasteFor({ type: 'paste', id: 'a', data: 'x', part: 'start' }, true)).toBe('\x1b[200~x');
    expect(pasteFor({ type: 'paste', id: 'a', data: 'y', part: 'end' }, true)).toBe('y\x1b[201~');
  });
});

describe('사이드바 선택은 세션으로 기억한다(#860)', () => {
  it('목록 순서가 바뀌어도 고르던 세션을 그대로 고른다', () => {
    const before = [item('a'), item('b'), item('c')];
    const after = [item('c'), item('a'), item('b')];
    expect(reselect(before, 1, after)).toBe(2);
  });

  it('고르던 세션이 사라지면 같은 자리(범위 안)를 고른다', () => {
    expect(reselect([item('a'), item('b'), item('c')], 2, [item('a'), item('b')])).toBe(1);
    expect(reselect([item('a')], 0, [])).toBe(0);
  });
});
