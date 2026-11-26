/**
 * 활동 기록을 칸에 고정(#1411): 칸 id, 받은 자료 넣기, 굴리기, 그림, 키. 고정한 칸에는 입력을 터미널로 보내지 않는다
 */
import { describe, expect, it } from 'vitest';
import { openInside } from './inside';
import { handleInput, initialState, type DeskState, type Effect } from './keys';
import { isPinId, openPin, parsePin, pinFailed, pinId, pinKey, pinLoaded, pinTitle, renderPin } from './pinned';
import { renderScreen } from './render';
import { stringWidth, stripAnsi } from './screen';
import type { ActivityEntryView, ActivityLogView, DeskAgent, DeskItem } from './types';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const usage = { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: ago(30), ...patch });
const sub = (id: string, patch: Partial<DeskAgent> = {}): DeskAgent => ({ id: `claude:agent:${id}`, name: 'Explore', type: 'Explore', kind: 'subagent', state: 'working', tokens: usage, startedAt: ago(120), lastAt: ago(5), ...patch });
const entry = (n: number, patch: Partial<ActivityEntryView> = {}): ActivityEntryView => ({ at: ago(100 - n), tool: 'Read', kind: 'read', state: 'done', target: `src/file${n}.ts`, ...patch });
const log = (id: string, entries: ActivityEntryView[], patch: Partial<ActivityLogView['agents'][number]> = {}) => ({ id, type: 'Explore', description: '결제 흐름 찾기', state: 'working' as const, entries, ...patch });
const data = (...agents: ActivityLogView['agents']): ActivityLogView => ({ agents });
const many = (count: number) => Array.from({ length: count }, (_, at) => entry(at));

const session = item('a', { title: '주문 모듈', agents: [sub('x1', { description: '결제 흐름 찾기' }), sub('x2', { description: '테스트 돌리기' })] });
const PIN = pinId('a', 'x1');

const stateWith = (pin: ReturnType<typeof openPin>, patch: Partial<DeskState> = {}): DeskState => ({ ...initialState(), items: [session, item('b')], layout: 2, slots: ['b', PIN, undefined, undefined], focus: 1, pins: { [PIN]: pin }, ...patch });
const run = (start: DeskState, input: string) => handleInput(start, input);
const kinds = (effects: Effect[]) => effects.map((effect) => effect.type);

describe('칸 id', () => {
  it('세션·에이전트 id의 :를 가려 둬 서로 섞이지 않고, 세션 id나 셸 id와도 다르다', () => {
    const id = pinId('a:b', 'claude:agent:x');
    expect(parsePin(id)).toEqual({ session: 'a:b', agent: 'claude:agent:x' });
    expect(isPinId(id)).toBe(true);
    expect(isPinId('a')).toBe(false);
    expect(isPinId('shell:1')).toBe(false);
    expect(parsePin('pin:깨진%')).toBeUndefined();
    expect(parsePin('pin:a:b:c')).toBeUndefined();
  });
});

describe('받은 자료 넣기', () => {
  it('에이전트 id의 기록을 넣고, 위로 읽는 중이면 새 항목이 와도 보던 자리를 지킨다', () => {
    let pin = pinLoaded(openPin('a', 'x1'), data(log('x1', many(5)), log('x2', many(1))));
    expect(pin.log?.entries).toHaveLength(5);
    expect(pin.loading).toBe(false);
    pin = pinKey(pin, '\x1b[A');
    expect(pin.up).toBe(1);
    pin = pinLoaded(pin, data(log('x1', many(7))));
    // 항목 둘이 늘었으니 같은 자리에 두려고 그만큼 더 올라간다
    expect(pin.up).toBe(1 + 2);
    // 맨 아래를 따라가던 칸은 계속 따라간다
    expect(pinLoaded({ ...pin, up: 0 }, data(log('x1', many(9)))).up).toBe(0);
  });

  it('서버가 이 에이전트의 기록을 더 주지 않으면(끝나서 지워짐) 마지막 기록을 두고 끝난 것으로 본다', () => {
    const first = pinLoaded(openPin('a', 'x1'), data(log('x1', many(3))));
    const gone = pinLoaded(first, data(log('x2', many(1))));
    expect(gone.log?.entries).toHaveLength(3);
    expect(gone.ended).toBe(true);
    // 다시 오면(같은 id가 돌아오면) 끝남 표시를 지운다
    expect(pinLoaded(gone, data(log('x1', many(4)))).ended).toBeUndefined();
    // 한 번도 받은 적이 없으면 끝난 것이 아니라 아직 기록이 없는 것이다
    expect(pinLoaded(openPin('a', 'x1'), data()).ended).toBeUndefined();
  });

  it('메인 기록은 id가 main이거나 main 표시가 있는 것이다', () => {
    expect(pinLoaded(openPin('a', 'main'), data({ id: 'zz', main: true, entries: many(2) })).log?.entries).toHaveLength(2);
  });

  it('받기에 실패하면 마지막 기록을 두고 까닭을 남긴다. 제어 글자는 지운다', () => {
    const loaded = pinLoaded(openPin('a', 'x1'), data(log('x1', many(2))));
    const failed = pinFailed(loaded, { message: '끊겼습니다\x1b[31m빨강\x1b]0;제목\x07' });
    expect(failed.log).toBe(loaded.log);
    expect(failed.error).toBe('끊겼습니다빨강');
    expect(pinFailed(loaded, { message: '', old: true })).toMatchObject({ gone: true, error: '알 수 없는 오류' });
  });

  it('에이전트 안 화면이 이미 받은 자료로 고정하면 바로 채워진다', () => {
    expect(openPin('a', 'x1', data(log('x1', many(2)))).log?.entries).toHaveLength(2);
  });
});

describe('굴리기', () => {
  const pin = pinLoaded(openPin('a', 'x1'), data(log('x1', many(30))));
  it('↑↓ PgUp PgDn g G가 굴리고, 그 밖의 키는 아무것도 바꾸지 않는다. 맨 위·맨 아래를 넘지 않는다', () => {
    expect(pinKey(pin, 'k').up).toBe(1);
    expect(pinKey(pinKey(pin, 'k'), 'j').up).toBe(0);
    expect(pinKey(pin, 'j').up).toBe(0);
    expect(pinKey(pin, '\x1b[5~').up).toBe(10);
    expect(pinKey(pinKey(pin, '\x1b[5~'), '\x1b[6~').up).toBe(0);
    const top = pinKey(pin, 'g');
    expect(top.up).toBeGreaterThan(20);
    expect(pinKey(top, '\x1b[A').up).toBe(top.up);
    expect(pinKey(top, 'G').up).toBe(0);
    expect(pinKey(pin, 'x')).toBe(pin);
  });
});

describe('그림', () => {
  const draw = (state: DeskState, size = { cols: 60, rows: 12 }) => renderPin(state, PIN, size, NOW).map(stripAnsi);

  it('머리 한 줄과 활동 기록(깊이 2와 같은 그림), 정확히 rows줄·줄마다 cols칸이다', () => {
    const state = stateWith(pinLoaded(openPin('a', 'x1'), data(log('x1', [entry(1, { tool: 'Edit', kind: 'edit', target: 'a.ts', changes: [{ file: 'a.ts', removed: 'old', added: 'new' }] })]))));
    const lines = draw(state);
    expect(lines).toHaveLength(12);
    for (const line of lines) expect(stringWidth(line)).toBe(60);
    expect(lines[0]).toContain('항목 1');
    expect(lines.join('\n')).toContain('편집 a.ts');
    expect(lines.join('\n')).toContain('- old');
    expect(lines.join('\n')).toContain('+ new');
  });

  it('칸 머리에 에이전트 이름과 상태를 적는다', () => {
    const state = stateWith(pinLoaded(openPin('a', 'x1'), data(log('x1', many(1)))));
    expect(pinTitle(state, PIN)).toBe('활동 기록 · 탐색 결제 흐름 찾기 · 작업 중');
    const done = { ...state, items: [{ ...session, agents: [sub('x1', { description: '결제 흐름 찾기', state: 'done' })] }] };
    expect(pinTitle(done, PIN)).toContain('끝남');
  });

  it('위로 읽는 중이면 그 자리를 보이고, 맨 아래를 따라가면 마지막 항목이 보인다', () => {
    const base = pinLoaded(openPin('a', 'x1'), data(log('x1', many(40))));
    const following = draw(stateWith(base), { cols: 60, rows: 8 }).join('\n');
    expect(following).toContain('file39.ts');
    expect(following).toContain('맨 아래를 따라가는 중');
    const up = draw(stateWith({ ...base, up: 20 }), { cols: 60, rows: 8 }).join('\n');
    expect(up).not.toContain('file39.ts');
    expect(up).toContain('위로 20줄');
  });

  it('끝난 서브에이전트는 마지막 기록을 두고 한 줄 알린다', () => {
    const first = pinLoaded(openPin('a', 'x1'), data(log('x1', many(3))));
    const text = draw(stateWith(pinLoaded(first, data()))).join('\n');
    expect(text.replace(/ *\n */g, '')).toContain('끝난 서브에이전트입니다(마지막으로 받은 기록)');
    expect(text).toContain('file2.ts');
    // 좁은 칸에서도 잘리지 않고 나뉜다
    const narrow = renderPin(stateWith(pinLoaded(first, data())), PIN, { cols: 24, rows: 12 }, NOW).map((line) => stripAnsi(line).trimEnd());
    expect(narrow.join('').replace(/\s/g, '')).toContain('끝난서브에이전트입니다(마지막으로받은기록)');
  });

  it('세션이 멈추거나 사라지면 까닭을 적고 칸을 닫지 않는다', () => {
    const pin = pinLoaded(openPin('a', 'x1'), data(log('x1', many(2))));
    expect(draw(stateWith(pin, { items: [{ ...session, state: 'stopped' }] })).join('\n')).toContain('세션이 멈췄습니다');
    const missing = stateWith(pin, { items: [item('b')] });
    expect(draw(missing).join('\n')).toContain('이 세션이 없습니다');
    expect(draw(missing).join('\n')).toContain('file1.ts');
    expect(pinTitle(missing, PIN)).toContain('활동 기록');
  });

  it('받는 중·옛 스튜디오·실패를 가른다', () => {
    expect(draw(stateWith(openPin('a', 'x1'))).join('\n')).toContain('활동 기록을 받는 중…');
    expect(draw(stateWith(pinFailed(openPin('a', 'x1'), { message: '', old: true }))).join('\n')).toContain('이 스튜디오는 활동 기록을 보내지 않습니다');
    const failed = pinFailed(pinLoaded(openPin('a', 'x1'), data(log('x1', many(2)))), { message: '권한이 없습니다' });
    // 알림은 칸 폭에 맞춰 줄을 나눈다
    expect(draw(stateWith(failed)).map((line) => line.trimEnd()).join('')).toContain('활동 기록을 받지 못했습니다: 권한이 없습니다(마지막으로 받은 자료를 보입니다)');
  });

  it('서버가 준 글의 제어 글자와 가림 표시를 기존 규칙대로 거친다', () => {
    const pin = pinLoaded(
      openPin('a', 'x1'),
      data(log('x1', [entry(1, { tool: 'Edit', kind: 'edit', target: 'a\x1b[2Jb.ts', withheld: 'secret', changes: [{ file: '.env', removed: 'SECRET=1', added: 'SECRET=2' }] })])),
    );
    const text = draw(stateWith(pin)).join('\n');
    expect(text).not.toContain('\x1b');
    expect(text).toContain('비밀 파일이라 내용을 보이지 않습니다');
    expect(text).not.toContain('SECRET');
  });

  it('칸이 아주 좁고 낮아도 깨지지 않는다(80칸 화면의 2×2 칸)', () => {
    const state = stateWith(pinLoaded(openPin('a', 'x1'), data(log('x1', many(30)))));
    for (const size of [{ cols: 1, rows: 1 }, { cols: 10, rows: 2 }, { cols: 29, rows: 9 }, { cols: 80, rows: 30 }]) {
      const lines = renderPin(state, PIN, size, NOW);
      expect(lines).toHaveLength(size.rows);
      for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(size.cols);
    }
  });

  it('화면 전체에서도 80칸을 넘지 않고 고른 칸 안내가 활동 기록 칸의 것이다', () => {
    const state = stateWith(pinLoaded(openPin('a', 'x1'), data(log('x1', many(30)))), { layout: 4, slots: ['b', PIN, undefined, undefined] });
    const views = state.slots.map((id) => (id === PIN ? { lines: renderPin(state, PIN, { cols: 28, rows: 10 }, NOW), title: pinTitle(state, PIN) } : { lines: [] as string[] }));
    const screen = renderScreen(state, { cols: 80, rows: 24 }, views);
    for (const line of screen.lines) expect(stringWidth(stripAnsi(line))).toBe(80);
    expect(stripAnsi(screen.lines.at(-1)!)).toContain('활동 기록 칸');
  });
});

describe('키: 고정한 칸에는 입력을 터미널로 보내지 않는다', () => {
  const pin = pinLoaded(openPin('a', 'x1'), data(log('x1', many(30))));

  it('글자·Enter·방향키 어느 것도 input 할 일을 내지 않고, 굴리는 키만 굴린다', () => {
    const typed = run(stateWith(pin), 'abc\r');
    expect(typed.effects).toEqual([]);
    expect(typed.state.pins![PIN]!.up).toBe(0);
    const scrolled = run(stateWith(pin), 'kk\x1b[5~');
    expect(scrolled.effects).toEqual([]);
    expect(scrolled.state.pins![PIN]!.up).toBe(12);
    expect(run(scrolled.state, 'G').state.pins![PIN]!.up).toBe(0);
  });

  it('붙여넣기는 버린다(조각으로 와도)', () => {
    const pasted = run(stateWith(pin), '\x1b[200~rm -rf /\n\x1b[201~');
    expect(pasted.effects).toEqual([]);
    const parts = run(run(stateWith(pin), '\x1b[200~앞').state, '뒤\x1b[201~');
    expect(parts.effects).toEqual([]);
    expect(parts.state.pasting).toBeUndefined();
  });

  it('앞글쇠 두 번도 Ctrl-b를 보내지 않고 알린다. 복사 모드는 열지 않는다', () => {
    const twice = run(stateWith(pin), '\x02\x02');
    expect(kinds(twice.effects)).not.toContain('input');
    expect(twice.state.message).toContain('활동 기록 칸에는');
    const copy = run(stateWith(pin), '\x02[');
    expect(kinds(copy.effects)).not.toContain('copy');
    expect(copy.state.copy).toBeUndefined();
  });

  it('다른 칸으로 가면 그 칸의 CLI로 입력이 간다(활동 기록 칸에서 빠져나올 수 있다)', () => {
    const moved = run(stateWith(pin), '\x021x');
    expect(moved.state.focus).toBe(0);
    expect(moved.effects).toContainEqual({ type: 'input', id: 'b', data: 'x' });
  });

  it('x로 칸을 비우면 그 칸의 상태도 지운다. 칸 수를 줄여 가려진 칸도 지운다', () => {
    const cleared = run(stateWith(pin), '\x02x');
    expect(cleared.state.slots[1]).toBeUndefined();
    expect(cleared.state.pins).toBeUndefined();
    expect(cleared.effects.map((effect) => effect.type)).toContain('close');
    const four = stateWith(pin, { layout: 4, slots: ['b', undefined, undefined, PIN], focus: 0 });
    const shrunk = run(four, '\x02l');
    expect(shrunk.state.layout).toBe(1);
    expect(shrunk.state.pins).toBeUndefined();
  });
});

describe('p: 활동 기록을 칸에 고정', () => {
  const inside = (patch: Partial<NonNullable<DeskState['inside']>> = {}) => ({ ...openInside('a', '주문 모듈', { depth: 2, agent: 'claude:agent:x1' }), loading: false, data: data(log('x1', many(4))), ...patch });
  const insideState = (patch: Partial<DeskState> = {}): DeskState => ({ ...initialState(), items: [session, item('b')], layout: 1, slots: ['b', undefined, undefined, undefined], focus: 0, inside: inside(), ...patch });

  it('깊이 2에서 p: 터미널이 있는 칸은 두고 칸 수를 늘려 새 칸에 놓고 받은 기록을 바로 채운다', () => {
    const result = run(insideState(), 'p');
    expect(result.state.layout).toBe(2);
    expect(result.state.slots).toEqual(['b', PIN, undefined, undefined]);
    expect(result.state.focus).toBe(0);
    expect(result.state.pins![PIN]!.log?.entries).toHaveLength(4);
    expect(result.effects).toContainEqual({ type: 'layout' });
    // 에이전트 안 화면은 그대로 두고 알린다(이어서 다른 에이전트를 고정할 수 있게)
    expect(result.state.inside?.note).toContain('2번 칸에 고정했습니다');
    expect(result.state.view).toBeUndefined();
  });

  it('깊이 1에서는 고른 카드의 기록을 고정한다(서브에이전트도 메인도)', () => {
    const one = insideState({ inside: { ...inside(), depth: 1, agent: 'claude:agent:x2' } });
    expect(run(one, 'p').state.slots).toContain(pinId('a', 'x2'));
    const main = insideState({ inside: { ...inside(), depth: 1, agent: 'main' } });
    expect(run(main, 'p').state.slots).toContain(pinId('a', 'main'));
  });

  it('둘을 고정하면 2칸이 4칸이 되고, 왼쪽 칸의 터미널은 그대로다', () => {
    let result = run(insideState(), 'p');
    result = run({ ...result.state, inside: { ...result.state.inside!, agent: 'claude:agent:x2' } }, 'p');
    expect(result.state.layout).toBe(4);
    expect(result.state.slots).toEqual(['b', pinId('a', 'x1'), pinId('a', 'x2'), undefined]);
    expect(Object.keys(result.state.pins!)).toHaveLength(2);
  });

  it('같은 기록을 다시 고정하면 새 칸을 만들지 않고 있던 칸을 알린다', () => {
    const once = run(insideState(), 'p').state;
    const again = run(once, 'p');
    expect(again.state.slots).toEqual(once.slots);
    expect(again.state.inside?.note).toContain('이미 2번 칸에');
  });

  it('빈 칸이 없으면 터미널이 든 칸을 덮어쓰지 않고 이유를 알린다', () => {
    const full = insideState({ layout: 4, slots: ['b', 'c', 'd', 'e'] });
    const result = run(full, 'p');
    expect(result.state.slots).toEqual(['b', 'c', 'd', 'e']);
    expect(result.state.inside?.note).toContain('빈 칸이 없습니다');
    expect(result.effects).toEqual([]);
  });

  it('빈 칸이 이미 있으면 칸 수를 늘리지 않고 거기에 놓는다', () => {
    const result = run(insideState({ layout: 2, slots: ['b', undefined, undefined, undefined] }), 'p');
    expect(result.state.layout).toBe(2);
    expect(result.state.slots[1]).toBe(PIN);
  });

  it('고정한 뒤 다음 키에 알림이 사라진다', () => {
    const pinned = run(insideState(), 'p').state;
    expect(run(pinned, '\x1b[A').state.inside?.note).toBeUndefined();
  });
});
