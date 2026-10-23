import { describe, expect, it } from 'vitest';
import { fleetOptions, fleetsHint, fleetsKey, fleetsPaste, openFleets, openableMembers, placeMembers, renderFleets, type FleetsState } from './fleets';
import { stringWidth, stripAnsi } from './screen';
import { DEFAULT_THEME } from './theme';
import type { DeskFleet, DeskItem } from './types';

const ESC = '\x1b';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';
const TAB = '\t';

const fleet = (id: string, patch: Partial<DeskFleet> = {}): DeskFleet => ({
  id,
  projectId: 'shop',
  projectName: 'shop',
  request: `요청 ${id}`,
  createdAt: '2026-10-23T00:00:00Z',
  members: [
    { sessionId: `${id}-a`, backend: 'claude-code', label: '계정 기본', provider: 'claude-code', status: 'done', checkpoint: { sha: 'abc', shortSha: 'abc', files: ['a.ts', 'b.ts'] }, usage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    { sessionId: `${id}-b`, backend: 'codex', accountId: 'acct-pio', label: '피오', provider: 'codex', status: 'running' },
    { sessionId: `failed-${id}`, backend: 'codex', label: '계정 기본', provider: 'codex', status: 'error', summary: '샌드박스를 켜지 못했습니다' },
  ],
  ...patch,
});

function listed(fleets: DeskFleet[] = [fleet('f1'), fleet('f2')]): FleetsState {
  return { ...openFleets(), loading: false, fleets };
}

function press(state: FleetsState, ...keys: string[]) {
  let current: FleetsState | undefined = state;
  const effects: ReturnType<typeof fleetsKey>['effects'] = [];
  for (const key of keys) {
    const result = fleetsKey(current!, key);
    current = result.state;
    effects.push(...result.effects);
  }
  return { state: current, effects };
}

describe('여러 AI 비교 목록', () => {
  it('↓로 고르고 Enter로 비교를 열면 그 비교를 받는다', () => {
    const { state, effects } = press(listed(), DOWN, '\r');
    expect(state).toMatchObject({ mode: 'detail', detail: 'f2', member: 0 });
    expect(effects).toEqual([{ type: 'detail', id: 'f2' }]);
  });

  it('n은 새 비교 입력을 열고 프로젝트·AI 목록을 청한다', () => {
    const { state, effects } = press(listed(), 'n');
    expect(state?.mode).toBe('new');
    expect(state?.form).toMatchObject({ loading: true, field: 'project' });
    expect(effects).toEqual([{ type: 'form' }]);
  });

  it('d는 한 번 묻고 y면 지운다. 다른 키면 그만둔다', () => {
    const asked = press(listed(), 'd');
    expect(asked.state?.confirm).toEqual({ kind: 'delete', fleetId: 'f1', request: '요청 f1' });
    expect(asked.effects).toEqual([]);
    expect(press(asked.state!, 'y').effects).toEqual([{ type: 'delete', id: 'f1' }]);
    const cancelled = press(asked.state!, 'n');
    expect(cancelled.effects).toEqual([]);
    expect(cancelled.state?.confirm).toBeUndefined();
  });

  it('r은 다시 읽고 Esc는 닫는다', () => {
    expect(press(listed(), 'r').effects).toEqual([{ type: 'reload' }]);
    const closed = press(listed(), ESC);
    expect(closed.state).toBeUndefined();
    expect(closed.effects).toEqual([{ type: 'close' }]);
  });
});

describe('비교 보기', () => {
  const detail = (): FleetsState => ({ ...listed(), mode: 'detail', detail: 'f1', member: 0 });

  it('→로 참가자를 고르고 Enter로 그 참가자의 작업 복사본을 칸에 연다', () => {
    const { state, effects } = press(detail(), RIGHT, '\r');
    expect(state?.member).toBe(1);
    expect(effects).toEqual([{ type: 'open', sessionIds: ['f1-b'] }]);
  });

  it('a는 열 수 있는 참가자를 모두 나란히 연다(세션을 만들지 못한 참가자는 뺀다)', () => {
    expect(press(detail(), 'a').effects).toEqual([{ type: 'open', sessionIds: ['f1-a', 'f1-b'] }]);
  });

  it('세션을 만들지 못한 참가자는 열지 않고 까닭을 보인다', () => {
    const { state, effects } = press(detail(), RIGHT, RIGHT, '\r');
    expect(effects).toEqual([]);
    expect(state?.note).toContain('열 세션이 없습니다');
  });

  it('w는 검증을 통과한 참가자만 승자로 묻고, y면 고른다', () => {
    const running = press(detail(), RIGHT, 'w');
    expect(running.state?.confirm).toBeUndefined();
    expect(running.state?.note).toContain('검증을 통과한');
    const asked = press(detail(), 'w');
    expect(asked.state?.confirm).toEqual({ kind: 'winner', fleetId: 'f1', sessionId: 'f1-a', label: '계정 기본' });
    expect(press(asked.state!, '\r').effects).toEqual([{ type: 'winner', id: 'f1', sessionId: 'f1-a' }]);
  });

  it('Esc는 목록으로 돌아간다', () => {
    expect(press(detail(), ESC).state).toMatchObject({ mode: 'list', detail: undefined });
  });
});

describe('새 비교', () => {
  const form = (): FleetsState => {
    const opened = press(listed(), 'n').state!;
    return {
      ...opened,
      form: {
        ...opened.form!,
        loading: false,
        projects: [
          { id: 'shop', name: 'shop' },
          { id: 'blog', name: 'blog' },
        ],
        options: fleetOptions(['claude-code', 'codex'], [
          { id: 'codex', name: 'Codex', backend: 'codex', builtin: true },
          { id: 'acct-pio', name: '피오', backend: 'codex', configDir: '/home/me/.b-studio/accounts/codex-1' },
        ]),
      },
    };
  };

  it('프로젝트를 고르고, 요청을 쓰고, 참가자를 더해 보낸다(같은 AI를 두 번 넣으면 독립 시도 둘이다)', () => {
    let state = press(form(), DOWN, TAB, ...'검색 추가', TAB).state!;
    expect(state.form?.field).toBe('option');
    // Claude를 모델 없이 더한다
    state = press(state, '\r').state!;
    // AI 칸에서 Codex · 피오로 옮기고, 모델 칸에 gpt-5를 쓴 뒤 Shift-Tab으로 AI 칸에 돌아와 더한다
    state = press(state, DOWN, DOWN).state!;
    state = press(state, TAB, ...'gpt-5', '\x1b[Z', '\r').state!;
    expect(state.form?.field).toBe('option');
    expect(state.form?.members.map((member) => member.label)).toEqual(['Claude', 'Codex · 피오 · gpt-5']);
    const sent = press(state, TAB, TAB, TAB, '\r');
    expect(sent.effects).toEqual([
      {
        type: 'create',
        projectId: 'blog',
        request: '검색 추가',
        candidates: [{ backend: 'claude-code' }, { backend: 'codex', accountId: 'acct-pio', model: 'gpt-5' }],
      },
    ]);
    expect(sent.state?.form?.sending).toBe(true);
  });

  it('참가자가 둘보다 적거나 요청이 비면 보내지 않고 까닭을 보인다', () => {
    const empty = press(form(), TAB, TAB, TAB, TAB, TAB, '\r');
    expect(empty.effects).toEqual([]);
    expect(empty.state?.form?.error).toContain('요청');
    const one = press(form(), TAB, ...'요청', TAB, '\r', TAB, TAB, TAB, '\r');
    expect(one.effects).toEqual([]);
    expect(one.state?.form?.error).toContain('2~4');
  });

  it('참가자는 넷까지이고, 참가자 칸에서 d로 뺀다', () => {
    let state = press(form(), TAB, ...'요청', TAB, '\r', '\r', '\r', '\r', '\r').state!;
    expect(state.form?.members).toHaveLength(4);
    expect(state.form?.error).toContain('넷까지');
    state = press(state, TAB, TAB, 'd').state!;
    expect(state.form?.field).toBe('members');
    expect(state.form?.members).toHaveLength(3);
  });

  it('요청 칸의 붙여넣기는 한 줄로 넣고, 지우개는 한 글자(넓은 글자 포함)씩 지운다', () => {
    let state = press(form(), TAB).state!;
    state = fleetsPaste(state, '첫 줄\n둘째 줄');
    expect(state.form?.request).toBe('첫 줄 둘째 줄');
    state = press(state, '\x7f', '\x7f').state!;
    expect(state.form?.request).toBe('첫 줄 둘째');
  });

  it('Esc는 입력을 닫고 목록으로 돌아간다', () => {
    expect(press(form(), ESC).state).toMatchObject({ mode: 'list', form: undefined });
  });
});

describe('fleetOptions', () => {
  it('계정이 둘 이상인 CLI는 계정마다 하나, 기본 계정은 계정 id를 싣지 않는다', () => {
    const options = fleetOptions(['api', 'claude-code', 'codex'], [
      { id: 'claude-code', name: 'Claude Code', backend: 'claude-code', builtin: true },
      { id: 'codex', name: 'Codex', backend: 'codex', builtin: true },
      { id: 'acct-pio', name: '피오', backend: 'codex', configDir: '/x' },
    ]);
    expect(options).toEqual([
      { backend: 'api', label: 'API' },
      { backend: 'claude-code', label: 'Claude' },
      { backend: 'codex', label: 'Codex · Codex' },
      { backend: 'codex', accountId: 'acct-pio', label: 'Codex · 피오' },
    ]);
  });
});

describe('placeMembers', () => {
  const desk = { layout: 1 as const, focus: 0, slots: [undefined, undefined, undefined, undefined] as Array<string | undefined> };

  it('참가자 수에 맞게 칸 수를 늘려 나란히 놓는다', () => {
    expect(placeMembers(desk, ['a', 'b'])).toEqual({ layout: 2, focus: 0, slots: ['a', 'b', undefined, undefined] });
    expect(placeMembers(desk, ['a', 'b', 'c'])).toEqual({ layout: 4, focus: 0, slots: ['a', 'b', 'c', undefined] });
    expect(placeMembers(desk, ['a'])).toEqual({ layout: 1, focus: 0, slots: ['a', undefined, undefined, undefined] });
  });

  it('셸 칸은 그대로 두고 그 밖의 칸에 놓는다. 자리가 모자라면 까닭을 돌려준다', () => {
    expect(placeMembers({ ...desk, slots: ['shell:1', undefined, undefined, undefined] }, ['a', 'b'])).toEqual({ layout: 4, focus: 1, slots: ['shell:1', 'a', 'b', undefined] });
    expect(placeMembers({ ...desk, slots: ['shell:1', 'shell:2', 'shell:3', undefined] }, ['a', 'b'])).toEqual({ error: expect.stringContaining('셸 칸') });
  });
});

describe('openableMembers', () => {
  it('터미널로 열 수 있는 AI의 세션만(세션을 만들지 못한 참가자와 api 후보는 뺀다)', () => {
    const view = fleet('f9');
    view.members.push({ sessionId: 'f9-api', backend: 'api', label: 'Model A', provider: 'anthropic', status: 'done' });
    expect(openableMembers(view).map((member) => member.sessionId)).toEqual(['f9-a', 'f9-b']);
  });
});

describe('renderFleets', () => {
  const items: DeskItem[] = [{ kind: 'session', id: 'f1-a', title: '요청 f1', projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-23T00:00:00Z' }];
  const context = { items, theme: DEFAULT_THEME, sprites: {}, spriteClock: 0 };

  it('목록은 비교마다 요청·프로젝트·참가자 상태·승자를 보이고 줄마다 폭이 같다', () => {
    const state = listed([fleet('f1', { winnerSessionId: 'f1-a' }), fleet('f2')]);
    const { lines } = renderFleets(state, context, { w: 100, h: 20 });
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('여러 AI 비교');
    expect(text).toContain('요청 f1');
    expect(text).toContain('승자 계정 기본');
    expect(lines).toHaveLength(20);
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(100);
  });

  it('보기는 참가자마다 카드(상태, 바뀐 파일 수, 토큰, 승자 표시)를 그린다', () => {
    const state: FleetsState = { ...listed([fleet('f1', { winnerSessionId: 'f1-a' })]), mode: 'detail', detail: 'f1', member: 0 };
    const { lines } = renderFleets(state, context, { w: 120, h: 40 });
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('요청 f1');
    expect(text).toContain('검증 통과');
    expect(text).toContain('바뀐 파일 2');
    expect(text).toContain('토큰 1.5천');
    expect(text).toContain('승자');
    expect(text).toContain('피오');
    expect(text).toContain('샌드박스를 켜지 못했습니다');
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(120);
  });

  it('새 비교 입력은 고른 칸에 커서를 둔다', () => {
    const state: FleetsState = { ...listed(), mode: 'new', form: { loading: false, field: 'request', projects: [{ id: 'shop', name: 'shop' }], projectIndex: 0, request: '검색', options: [{ backend: 'codex', label: 'Codex' }], option: 0, model: '', members: [], selectedMember: 0 } };
    const { lines, cursor } = renderFleets(state, context, { w: 80, h: 24 });
    expect(cursor).toBeDefined();
    expect(stripAnsi(lines[cursor!.y]!)).toContain('검색');
  });

  it('아래 줄 안내는 화면마다 다르다', () => {
    expect(fleetsHint(listed())).toContain('n 새 비교');
    expect(fleetsHint({ ...listed(), mode: 'detail', detail: 'f1' })).toContain('w 승자');
  });
});
