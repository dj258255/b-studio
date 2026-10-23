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
    const { state, effects } = handleInput(withItems(), '\x02w');
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

describe('복사 모드·확대·사이드바·도움말 키(#863)', () => {
  const open = (patch: Partial<DeskState> = {}) => withItems({ slots: ['a', undefined, undefined, undefined], ...patch });

  it('Ctrl-b [는 고른 칸의 복사 모드를 켜고, 그동안 친 키는 CLI로 가지 않고 복사 모드 조작이 된다', () => {
    const entered = handleInput(open(), '\x02[');
    expect(entered.state.copy).toEqual({});
    expect(entered.effects).toEqual([{ type: 'copy', id: 'a', action: 'enter' }]);
    const moved = handleInput(entered.state, 'kk\x1b[Bbfgv');
    expect(moved.effects.filter((effect) => effect.type === 'input')).toEqual([]);
    expect(moved.effects.map((effect) => (effect.type === 'copy' ? effect.action : effect.type))).toEqual(['up', 'up', 'down', 'pageUp', 'pageDown', 'top', 'mark']);
    const yanked = handleInput(moved.state, 'y');
    expect(yanked.effects).toEqual([{ type: 'copy', id: 'a', action: 'yank' }]);
    expect(yanked.state.copy).toBeUndefined();
  });

  it('복사 모드는 q나 Esc로 나가고, 나간 뒤의 키는 다시 CLI로 간다', () => {
    const entered = handleInput(open(), '\x02[').state;
    const quit = handleInput(entered, 'q');
    expect(quit.state.copy).toBeUndefined();
    expect(quit.effects).toEqual([{ type: 'copy', id: 'a', action: 'exit' }]);
    expect(handleInput(quit.state, 'x').effects).toEqual([{ type: 'input', id: 'a', data: 'x' }]);
    const escaped = handleInput(entered, '\x1b', true);
    expect(escaped.state.copy).toBeUndefined();
  });

  it('복사 모드에서 /로 찾을 글을 쓰고 Enter로 찾으며, n은 같은 글을 더 위에서 찾는다', () => {
    const entered = handleInput(open(), '\x02[').state;
    const typing = handleInput(entered, '/ab');
    expect(typing.state.copy).toEqual({ search: 'ab' });
    expect(typing.effects).toEqual([]);
    const found = handleInput(typing.state, '\x7fc\r');
    expect(found.effects).toEqual([{ type: 'copy', id: 'a', action: 'search', text: 'ac' }]);
    expect(found.state.copy).toEqual({});
    expect(handleInput(found.state, 'n').effects).toEqual([{ type: 'copy', id: 'a', action: 'next' }]);
  });

  it('빈 칸에서는 복사 모드를 켜지 않는다', () => {
    const { state, effects } = handleInput(withItems(), '\x02[');
    expect(state.copy).toBeUndefined();
    expect(effects).toEqual([]);
  });

  it('복사 모드 중에 붙여 넣은 글은 CLI로 보내지 않는다', () => {
    const entered = handleInput(open(), '\x02[').state;
    expect(handleInput(entered, '\x1b[200~rm -rf\r\x1b[201~').effects).toEqual([]);
  });

  it('Ctrl-b z는 고른 칸을 크게 보기를 켜고 끄며, 칸 수를 바꾸면 풀린다', () => {
    const state = open({ layout: 2, slots: ['a', 'b', undefined, undefined], focus: 1 });
    const zoomed = handleInput(state, '\x02z');
    expect(zoomed.state.zoom).toBe(true);
    expect(zoomed.effects).toEqual([{ type: 'layout' }]);
    expect(handleInput(zoomed.state, '\x02z').state.zoom).toBe(false);
    expect(handleInput(zoomed.state, '\x02l').state.zoom).toBe(false);
  });

  it('Ctrl-b o는 다음 칸으로 가고 끝에서 처음으로 돈다', () => {
    const state = open({ layout: 2, slots: ['a', 'b', undefined, undefined], focus: 0 });
    const next = handleInput(state, '\x02o').state;
    expect(next.focus).toBe(1);
    expect(handleInput(next, '\x02o').state.focus).toBe(0);
  });

  it('Ctrl-b s는 사이드바를 숨기고 다시 보인다', () => {
    const hidden = handleInput(open(), '\x02s');
    expect(hidden.state.sidebarHidden).toBe(true);
    expect(hidden.effects).toEqual([{ type: 'layout' }]);
    expect(handleInput(hidden.state, '\x02s').state.sidebarHidden).toBe(false);
  });

  it('Ctrl-b ?는 도움말을 열고, 다음 키 하나는 도움말을 닫기만 한다', () => {
    const help = handleInput(open(), '\x02?');
    expect(help.state.help).toBe(true);
    const closed = handleInput(help.state, 'x');
    expect(closed.state.help).toBe(false);
    expect(closed.effects).toEqual([]);
  });
});

describe('세션 조작: 멈추기·이어서 작업·이름 바꾸기(#864)', () => {
  const stopped = (id: string): DeskItem => ({ ...item(id), state: 'stopped' });
  const opened = (patch: Partial<DeskState> = {}): DeskState => withItems({ slots: ['a', undefined, undefined, undefined], ...patch });

  it('Ctrl-b p는 사이드바에서 고른 세션을 멈출지 묻고, y면 멈춘다', () => {
    const asked = handleInput(opened({ selected: 1 }), '\x02p');
    expect(asked.state.confirm).toEqual({ action: 'stop', id: 'b', title: 'b' });
    expect(asked.effects).toEqual([]);
    const done = handleInput(asked.state, 'y');
    expect(done.effects).toEqual([{ type: 'session', action: 'stop', id: 'b' }]);
    expect(done.state.confirm).toBeUndefined();
  });

  it('묻는 동안 다른 키를 누르면 그만두고, 그 키는 CLI로 가지 않는다', () => {
    const asked = handleInput(opened(), '\x02p').state;
    const cancelled = handleInput(asked, 'n');
    expect(cancelled.effects).toEqual([]);
    expect(cancelled.state.confirm).toBeUndefined();
    expect(cancelled.state.message).toContain('그만');
  });

  it('이미 멈춘 세션은 멈추지 않는다', () => {
    const { state, effects } = handleInput(withItems({ items: [stopped('a')] }), '\x02p');
    expect(state.confirm).toBeUndefined();
    expect(effects).toEqual([]);
    expect(state.message).toContain('이미 멈춘');
  });

  it('Ctrl-b r은 멈춘 세션만 이어서 작업할지 묻고, Enter로도 고른다', () => {
    const running = handleInput(withItems(), '\x02r');
    expect(running.state.confirm).toBeUndefined();
    expect(running.state.message).toContain('멈춘 세션만');
    const asked = handleInput(withItems({ items: [stopped('a')] }), '\x02r');
    expect(asked.state.confirm).toEqual({ action: 'resume', id: 'a', title: 'a' });
    expect(handleInput(asked.state, '\r').effects).toEqual([{ type: 'session', action: 'resume', id: 'a' }]);
  });

  it('Ctrl-b ,는 이름 입력 줄을 열고, 친 글자는 CLI로 가지 않으며 Enter로 이름을 바꾼다', () => {
    const naming = handleInput(opened({ selected: 2 }), '\x02,');
    expect(naming.state.rename).toEqual({ id: 'c', text: '' });
    const typed = handleInput(naming.state, '결제 화면x\x7f');
    expect(typed.effects).toEqual([]);
    expect(typed.state.rename?.text).toBe('결제 화면');
    const done = handleInput(typed.state, '\r');
    expect(done.effects).toEqual([{ type: 'rename', id: 'c', label: '결제 화면' }]);
    expect(done.state.rename).toBeUndefined();
  });

  it('이름 입력 중 Esc는 그만두고, 붙여 넣은 줄바꿈은 빈칸이 된다', () => {
    const naming = handleInput(opened(), '\x02,').state;
    const pasted = handleInput(naming, '\x1b[200~줄\n바꿈\x1b[201~');
    expect(pasted.state.rename?.text).toBe('줄 바꿈');
    expect(pasted.effects).toEqual([]);
    const cancelled = handleInput(pasted.state, '\x1b', true);
    expect(cancelled.state.rename).toBeUndefined();
    expect(cancelled.effects).toEqual([]);
  });

  it('세션이 없으면 조작할 것이 없다고 알린다', () => {
    const { state } = handleInput({ ...initialState() }, '\x02p');
    expect(state.confirm).toBeUndefined();
    expect(state.message).toContain('세션');
  });
});

describe('마우스와 앞글쇠 설정(#874)', () => {
  const open = (patch: Partial<DeskState> = {}) => withItems({ slots: ['a', undefined, undefined, undefined], ...patch });

  it('SGR 마우스 열을 CLI로 보내지 않고 마우스 할 일로 낸다(누름·뗌·휠)', () => {
    const { effects } = handleInput(open(), 'x\x1b[<0;10;5My\x1b[<0;10;5m\x1b[<64;3;4M');
    expect(effects).toEqual([
      { type: 'input', id: 'a', data: 'x' },
      { type: 'mouse', button: 0, x: 9, y: 4, release: false },
      { type: 'input', id: 'a', data: 'y' },
      { type: 'mouse', button: 0, x: 9, y: 4, release: true },
      { type: 'mouse', button: 64, x: 2, y: 3, release: false },
    ]);
  });

  it('조각 경계에서 나뉜 마우스 열도 기다렸다가 하나로 읽는다', () => {
    const first = handleInput(open(), '\x1b[<0;1');
    expect(first.effects).toEqual([]);
    expect(first.state.pending).toBe('\x1b[<0;1');
    const second = handleInput(first.state, '2;7M');
    expect(second.effects).toEqual([{ type: 'mouse', button: 0, x: 11, y: 6, release: false }]);
  });

  it('붙여넣기 안의 마우스 열 모양 글은 내용이다', () => {
    const { effects } = handleInput(open(), '\x1b[200~\x1b[<0;1;1M\x1b[201~');
    expect(effects).toEqual([{ type: 'paste', id: 'a', data: '\x1b[<0;1;1M' }]);
  });

  it('도움말·확인·이름 입력·새 요청 중의 마우스는 버린다', () => {
    for (const patch of [{ help: true }, { rename: { id: 'a', text: '' } }] as Partial<DeskState>[]) {
      const { state, effects } = handleInput(open(patch), '\x1b[<0;1;1M');
      expect(effects).toEqual([]);
      expect(state.help ?? false).toBe(patch.help ?? false);
    }
  });

  it('앞글쇠를 누른 뒤의 마우스는 앞글쇠를 풀고 마우스로 낸다', () => {
    const { state, effects } = handleInput(open(), '\x02\x1b[<0;1;1M');
    expect(state.prefix).toBe(false);
    expect(effects).toEqual([{ type: 'mouse', button: 0, x: 0, y: 0, release: false }]);
  });

  it('설정한 앞글쇠(Ctrl-a)로 명령을 받고, Ctrl-b는 그냥 CLI로 간다', () => {
    const state = open({ prefixKey: '\x01', layout: 2 });
    expect(handleInput(state, '\x02').effects).toEqual([{ type: 'input', id: 'a', data: '\x02' }]);
    const { state: next } = handleInput(state, '\x012');
    expect(next.focus).toBe(1);
    expect(handleInput(state, '\x01\x01').effects).toEqual([{ type: 'input', id: 'a', data: '\x01' }]);
  });
});
