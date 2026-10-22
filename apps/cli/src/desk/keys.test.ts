import { describe, expect, it } from 'vitest';
import { handleInput, initialState, type DeskState } from './keys';
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

  it('이미 다른 칸에 열린 세션을 고르면 새로 열지 않고 그 칸으로 간다', () => {
    const state = withItems({ layout: 2, slots: ['a', 'b', undefined, undefined], selected: 1 });
    const { state: next, effects } = handleInput(state, '\x02\r');
    expect(effects).toEqual([]);
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
    expect(handleInput(prompting(), '\x1b').state.prompt).toBeUndefined();
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
