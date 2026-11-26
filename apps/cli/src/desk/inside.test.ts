import { describe, expect, it } from 'vitest';
import { activityLines, MAX_ACTIVITY_LINES, MAX_ENTRIES, cleanText, insideCards, insideFailed, insideKey, insideLoaded, openInside, renderInside, type InsideState } from './inside';
import { flushPending, handleInput, initialState, type DeskState } from './keys';
import { stringWidth, stripAnsi } from './screen';
import { defaultSprite, spriteLines, subagentSprite, type Sprite } from './sprite';
import { DEFAULT_THEME } from './theme';
import type { ActivityEntryView, ActivityLogView, DeskAgent, DeskItem } from './types';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const usage = { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const sub = (id: string, patch: Partial<DeskAgent> = {}): DeskAgent => ({ id, name: 'Explore', type: 'Explore', kind: 'subagent', state: 'working', tokens: usage, startedAt: ago(240), lastAt: ago(5), ...patch });
const main: DeskAgent = { id: 'main', name: '메인', kind: 'main', state: 'working', tokens: usage };

const session: DeskItem = {
  kind: 'session',
  id: 's1',
  title: '주문 모듈',
  projectName: 'shop',
  state: 'working',
  workingSince: ago(23 * 60),
  backend: 'claude-code',
  lastActivityAt: ago(5),
  now: { tool: 'Edit', target: 'src/order.ts', at: ago(6), running: true },
  agents: [
    main,
    sub('a1', { description: '결제 흐름 찾기', tool: 'Grep order' }),
    sub('a2', { type: 'test-runner', name: 'test-runner', description: 'pnpm test' }),
    sub('a3', { state: 'done', description: '문서 찾기', result: 'README에 세 곳' }),
  ],
};

const entry = (patch: Partial<ActivityEntryView>): ActivityEntryView => ({ at: ago(60), tool: 'Read', kind: 'read', state: 'done', ...patch });
const view = (agents: ActivityLogView['agents']): ActivityLogView => ({ agents });

const DATA: ActivityLogView = view([
  { id: 'main', main: true, entries: [entry({ tool: 'Edit', kind: 'edit', target: 'src/order.ts', changes: [{ file: 'src/order.ts', removed: 'const a = 1;\nconst b = 2;', added: 'const total = 3;' }] })] },
  { id: 'a1', type: 'Explore', description: '결제 흐름 찾기', state: 'working', entries: [entry({ target: 'src/pay.ts' }), entry({ tool: 'Grep', kind: 'search', target: 'order' })] },
  { id: 'a2', type: 'test-runner', state: 'working', entries: [entry({ tool: 'Bash', kind: 'run', command: 'pnpm test', output: 'ok\n3 passed', at: ago(30), endedAt: ago(28) })] },
  { id: 'a3', type: 'Explore', state: 'done', entries: [entry({ tool: 'Write', kind: 'write', target: '.env', withheld: 'secret', changes: [{ file: '.env' }] })] },
]);

const state = (inside: InsideState | undefined, patch: Partial<DeskState> = {}): DeskState => ({ ...initialState(), items: [session], inside, ...patch });
const base = (patch: Partial<InsideState> = {}): InsideState => ({ ...openInside('s1', '주문 모듈'), data: DATA, loading: false, ...patch });
const rect = { w: 80, h: 22 };
const draw = (inside: InsideState, r = rect, patch: Partial<DeskState> = {}) => renderInside(state(inside, patch), r, NOW).lines.map(stripAnsi);

describe('에이전트 안: 카드 모으기', () => {
  it('메인 카드 하나와 서브에이전트마다 카드 하나, 기록에만 있는 서브에이전트도 붙는다', () => {
    const cards = insideCards(session, view([...DATA.agents, { id: 'z9', type: 'Plan', entries: [] }]));
    expect(cards.map((card) => card.id)).toEqual(['main', 'a1', 'a2', 'a3', 'z9']);
    expect(cards[0]!.main).toBe(true);
  });
});

describe('에이전트 안: 깊이 1 그림', () => {
  it('카드마다 이름·상태·지금 하는 일과 코드 조각이 보이고, 줄마다 폭이 화면 폭이다', () => {
    const text = draw(base(), { w: 80, h: 60 });
    for (const line of text) expect(stringWidth(line)).toBe(80);
    const all = text.join('\n');
    expect(all).toContain('주문 모듈');
    expect(all).toContain('탐색 결제 흐름 찾기');
    expect(all).toContain('src/order.ts');
    expect(all).toMatch(/- const a = 1;/);
    expect(all).toMatch(/\+ const total = 3;/);
    expect(all).toContain('$ pnpm test');
    expect(all).toContain('3 passed');
    expect(all).toContain('src/pay.ts');
  });

  it('조각을 남기지 않은 까닭을 글로 적는다: 비밀 파일, 내용이 큼, 읽지 못함', () => {
    const cases: Array<[ActivityEntryView['withheld'], string]> = [
      ['secret', '비밀 파일이라 내용을 보이지 않습니다'],
      ['large', '내용이 커서 보이지 않습니다'],
      ['unknown', '내용을 읽지 못했습니다'],
    ];
    for (const [withheld, message] of cases) {
      const data = view([{ id: 'main', main: true, entries: [entry({ tool: 'Edit', kind: 'edit', target: 'a.ts', withheld, changes: [{ file: 'a.ts', removed: 'SECRET_OLD', added: 'SECRET_NEW' }] })] }]);
      const all = draw(base({ data }), { w: 80, h: 30 }).join('\n');
      expect(all).toContain(message);
      expect(all).not.toContain('SECRET_NEW');
    }
  });

  it('줄이 모자라도 지운 줄과 쓴 줄이 둘 다 보인다', () => {
    const long = (prefix: string) => Array.from({ length: 8 }, (_, at) => `${prefix}${at}`).join('\n');
    const data = view([{ id: 'main', main: true, entries: [entry({ tool: 'Edit', kind: 'edit', target: 'a.ts', changes: [{ file: 'a.ts', removed: long('old'), added: long('new') }] })] }, ...DATA.agents.slice(1)]);
    const text = draw(base({ data }), { w: 80, h: 22 }).join('\n');
    expect(text).toMatch(/- old0/);
    expect(text).toMatch(/\+ new0/);
    expect(text).toContain('…');
  });

  it('서브에이전트 id에 claude:agent: 머리가 붙어 와도 기록을 찾는다', () => {
    const prefixed = { ...session, agents: [main, sub('claude:agent:a1', { description: '결제 흐름 찾기' })] } as DeskItem;
    const cards = insideCards(prefixed, DATA);
    expect(cards[1]!.log?.id).toBe('a1');
  });

  it('실행 항목도 비밀이면 결과를 그리지 않고 까닭을 적는다', () => {
    const data = view([{ id: 'main', main: true, entries: [entry({ tool: 'Bash', kind: 'run', command: 'cat .env', output: 'TOKEN=abc123', withheld: 'secret' })] }]);
    const text = draw(base({ data }), { w: 80, h: 30 }).join('\n');
    expect(text).toContain('$ cat .env');
    expect(text).toContain('비밀 파일이라 내용을 보이지 않습니다');
    expect(text).not.toContain('abc123');
    expect(activityLines(data.agents[0]!, DEFAULT_THEME, NOW).map(stripAnsi).join('\n')).not.toContain('abc123');
  });

  it('항목 수에 상한이 있다: 받을 때와 줄을 만들 때 모두 뒤 MAX_ENTRIES개만 쓴다', () => {
    const entries = Array.from({ length: MAX_ENTRIES + 100 }, (_, at) => entry({ target: `r${at}.ts` }));
    const loaded = insideLoaded(base({ data: undefined }), view([{ id: 'main', main: true, entries }]));
    expect(loaded.data!.agents[0]!.entries).toHaveLength(MAX_ENTRIES);
    expect(activityLines({ id: 'main', entries }, DEFAULT_THEME, NOW)).toHaveLength(MAX_ENTRIES);
  });

  it('모양이 틀린 응답은 버리고 깨지지 않는다', () => {
    const loaded = insideLoaded(base({ data: undefined }), { agents: [null, { id: 5 }, { id: 'a1', entries: 'x' }, { id: 'a2', entries: [{ tool: 1 }, entry({})] }] });
    expect(loaded.data!.agents.map((agent) => agent.id)).toEqual(['a1', 'a2']);
    expect(loaded.data!.agents[1]!.entries).toHaveLength(1);
    expect(() => draw(loaded)).not.toThrow();
    expect(() => insideLoaded(base(), 'nope')).not.toThrow();
  });

  it('잘린 조각은 …로 알린다', () => {
    const data = view([{ id: 'main', main: true, entries: [entry({ tool: 'Edit', kind: 'edit', target: 'a.ts', truncated: true, changes: [{ file: 'a.ts', added: 'x', truncated: true }] })] }]);
    expect(draw(base({ data }), { w: 80, h: 30 }).join('\n')).toMatch(/…/);
  });

  it('기록이 없는 서브에이전트는 조각 없이 한 줄만 보이고, 화면 아래에 까닭이 있다', () => {
    const codex = { ...session, backend: 'codex' } as DeskItem;
    const text = renderInside(state(base({ data: view([]) }), { items: [codex] }), { w: 80, h: 30 }, NOW).lines.map(stripAnsi);
    expect(text.join('\n')).toContain('탐색 결제 흐름 찾기');
    expect(text.join('\n')).not.toContain('$ ');
    expect(text.slice(-3).join('\n')).toContain('이 CLI는 서브에이전트의 코드를 보내지 않습니다');
  });

  it('옛 스튜디오(404)면 깨지지 않고 까닭을 적는다', () => {
    const gone = insideFailed(base({ data: undefined }), { status: 404, message: '없음' });
    const text = draw(gone, { w: 80, h: 20 });
    expect(text.join('\n')).toContain('이 스튜디오는 활동 기록을 보내지 않습니다');
    expect(text.join('\n')).toContain('결제 흐름 찾기');
  });

  it('받기에 실패하면 마지막 자료를 두고 아래에 한 줄 알린다', () => {
    const failed = insideFailed(base(), { status: 403, message: '권한이 없습니다' });
    const text = draw(failed, { w: 80, h: 40 });
    expect(text.join('\n')).toContain('src/order.ts');
    expect(text.slice(-2).join('\n')).toContain('활동 기록을 받지 못했습니다: 권한이 없습니다');
  });

  it('80칸·좁은 칸에서도 모든 줄이 폭을 넘지 않고 정확히 h줄이다(넓은 글자 포함)', () => {
    const wide = view([
      { id: 'main', main: true, entries: [entry({ tool: 'Edit', kind: 'edit', target: '한글파일이름이아주길게이어지는경로/주문처리서비스구현체.ts', changes: [{ file: '한글파일이름.ts', removed: '지운 줄입니다 매우 길게 이어지는 한글 줄입니다 매우 길게 이어지는 한글 줄입니다', added: '🙂'.repeat(60) }] })] },
    ]);
    for (const w of [20, 30, 45, 55, 80, 120, 200]) {
      for (const h of [3, 8, 22]) {
        const text = draw(base({ data: wide }), { w, h });
        expect(text).toHaveLength(h);
        for (const line of text) expect(stringWidth(line)).toBe(w);
      }
    }
  });

  it('카드가 화면보다 많으면 고른 카드가 보이게 넘기고 몇 장 더 있는지 알린다', () => {
    const text = draw(base({ cursor: 3, agent: 'a3' }), { w: 80, h: 14 });
    expect(text.join('\n')).toContain('문서 찾기');
    expect(text.join('\n')).toMatch(/위에 카드 \d+장/);
  });

  it('서버가 준 글의 제어 글자와 ANSI는 지우고 그린다', () => {
    const evil = '\x1b[2J\x1b]0;제목\x07\x1b[31m빨강\x1b[0m\r\x00\u202e끝';
    const data = view([{ id: 'main', main: true, entries: [entry({ tool: 'Bash', kind: 'run', command: `echo ${evil}`, output: evil, error: evil, target: evil })] }]);
    const raw = renderInside(state(base({ data })), { w: 80, h: 30 }, NOW).lines.join('\n');
    expect(raw).not.toMatch(/\x1b\[2J|\x1b\]0;|\x00|\u202e|\r/);
    expect(stripAnsi(raw)).toContain('빨강');
    expect(cleanText(evil)).toBe('빨강끝');
  });

  it('항목이 수천 개여도 그리는 줄 수에 상한이 있다', () => {
    const many = Array.from({ length: 5000 }, (_, at) => entry({ tool: 'Edit', kind: 'edit', target: `f${at}.ts`, changes: [{ file: `f${at}.ts`, added: Array.from({ length: 3000 }, (_, n) => `line ${n}`).join('\n') }] }));
    const lines = renderInside(state(openDepth2(view([{ id: 'main', main: true, entries: many }]), 'main')), { w: 80, h: 22 }, NOW).lines;
    expect(lines).toHaveLength(22);
    // 화면에 자르기 전에 만드는 줄 수부터 상한이 있다(항목·변경·줄 수)
    const log = { id: 'main', main: true as const, entries: many };
    const built = activityLines(log, DEFAULT_THEME, NOW);
    expect(built.length).toBeLessThanOrEqual(MAX_ACTIVITY_LINES);
    const one = activityLines({ id: 'x', entries: [many[0]!] }, DEFAULT_THEME, NOW);
    expect(one.length).toBeLessThanOrEqual(1 + 1 + 60 + 1);
  });
});

function openDepth2(data: ActivityLogView, agent: string): InsideState {
  return { ...openInside('s1', '주문 모듈', { depth: 2, agent }), data, loading: false };
}

describe('에이전트 안: 깊이 2 활동 기록', () => {
  it('시각·우리말 도구 이름·대상·상태·걸린 시간과 diff, 명령과 결과가 시간순으로 보인다', () => {
    const data = view([
      {
        id: 'a2',
        type: 'test-runner',
        entries: [
          entry({ tool: 'Edit', kind: 'edit', target: 'src/a.ts', at: ago(100), endedAt: ago(98.5), changes: [{ file: 'src/a.ts', removed: 'old', added: 'new' }] }),
          entry({ tool: 'Bash', kind: 'run', command: 'pnpm test', output: 'FAIL a.test.ts', state: 'failed', error: '종료 코드 1', at: ago(60), endedAt: ago(40) }),
          entry({ tool: 'Write', kind: 'write', target: 'x.ts', state: 'denied', error: '쓰기 범위 밖', at: ago(20) }),
        ],
      },
    ]);
    const text = draw(openDepth2(data, 'a2'), { w: 80, h: 30 }).join('\n');
    expect(text).toMatch(/\d\d:\d\d:\d\d +.*편집.*src\/a\.ts/);
    expect(text).toContain('1.5초');
    expect(text).toContain('- old');
    expect(text).toContain('+ new');
    expect(text).toContain('$ pnpm test');
    expect(text).toContain('FAIL a.test.ts');
    expect(text).toContain('종료 코드 1');
    expect(text).toContain('거절');
    expect(text).toContain('쓰기 범위 밖');
    expect(text.indexOf('src/a.ts')).toBeLessThan(text.indexOf('$ pnpm test'));
  });

  it('맨 아래에 있을 때만 새 항목을 따라간다', () => {
    const first = Array.from({ length: 40 }, (_, at) => entry({ target: `r${at}.ts`, at: ago(1000 - at) }));
    const data1 = view([{ id: 'a1', entries: first }]);
    const follow = openDepth2(data1, 'a1');
    expect(draw(follow, { w: 80, h: 12 }).join('\n')).toContain('r39.ts');
    const more = view([{ id: 'a1', entries: [...first, entry({ target: 'r40.ts' }), entry({ target: 'r41.ts' })] }]);
    expect(draw(insideLoaded(follow, more), { w: 80, h: 12 }).join('\n')).toContain('r41.ts');
    // 위로 읽는 중이면 새 항목이 와도 보던 자리가 그대로다
    const up = insideKey(state(follow), 'k').state!;
    const upMore = insideKey(state(up), '\x1b[5~').state!;
    const before = draw(upMore, { w: 80, h: 12 });
    const after = draw(insideLoaded(upMore, more), { w: 80, h: 12 });
    expect(after.slice(1, -1)).toEqual(before.slice(1, -1));
    expect(after.join('\n')).not.toContain('r41.ts');
  });

  it('↑↓ PgUp PgDn g G로 굴린다. 맨 위·맨 아래를 넘지 않는다', () => {
    const data = view([{ id: 'a1', entries: Array.from({ length: 40 }, (_, at) => entry({ target: `r${at}.ts` })) }]);
    let s = openDepth2(data, 'a1');
    s = insideKey(state(s), 'g').state!;
    expect(draw(s, { w: 80, h: 12 }).join('\n')).toContain('r0.ts');
    s = insideKey(state(s), 'G').state!;
    expect(s.up).toBe(0);
    expect(insideKey(state(s), '\x1b[B').state!.up).toBe(0);
    expect(insideKey(state(s), '\x1b[6~').state!.up).toBe(0);
  });
});

describe('에이전트 안: 키', () => {
  it('←→↑↓로 카드를 고르고 범위를 넘지 않는다', () => {
    let s = base();
    s = insideKey(state(s), '\x1b[C').state!;
    expect(s.agent).toBe('a1');
    s = insideKey(state(s), 'j').state!;
    expect(s.agent).toBe('a2');
    for (let n = 0; n < 9; n++) s = insideKey(state(s), '\x1b[C').state!;
    expect(s.agent).toBe('a3');
    expect(insideKey(state(base()), '\x1b[D').state!.agent).toBe('main');
  });

  it('Enter: 메인 카드는 터미널을 열라고 하고, 서브에이전트 카드는 활동 기록(깊이 2)으로 들어간다', () => {
    expect(insideKey(state(base()), '\r').terminal).toBe(true);
    const sa = insideKey(state(base({ cursor: 1, agent: 'a1' })), '\r').state!;
    expect(sa.depth).toBe(2);
    expect(sa.agent).toBe('a1');
  });

  it('Esc는 한 단계 위로: 깊이 2에서 깊이 1, 깊이 1에서 닫기', () => {
    const d2 = openDepth2(DATA, 'a1');
    const up = insideKey(state(d2), '\x1b');
    expect(up.state?.depth).toBe(1);
    expect(up.state?.agent).toBe('a1');
    expect(insideKey(state(base()), '\x1b').state).toBeUndefined();
  });

  it('? 는 도움말', () => {
    expect(insideKey(state(base()), '?').help).toBe(true);
  });
});

describe('에이전트 안: desk 키 처리', () => {
  const desk = (patch: Partial<DeskState> = {}): DeskState => ({ ...initialState(), items: [session], view: 'space', ...patch });

  it('카드 화면에서 s로 들어가고(Enter는 그대로 칸에 열기), 활동 기록을 받으라는 일이 나간다', () => {
    const { state: opened, effects } = handleInput(desk(), 's');
    expect(opened.inside).toMatchObject({ id: 's1', depth: 1, agent: 'main' });
    expect(effects).toContainEqual({ type: 'inside-open', id: 's1' });
    expect(handleInput(desk(), '\r').effects).toContainEqual({ type: 'open', slot: 0, id: 's1' });
  });

  it('열려 있는 동안 친 글자는 칸으로 가지 않고, 붙여넣기와 마우스도 받지 않는다', () => {
    const opened = handleInput(desk({ slots: ['s1', undefined, undefined, undefined] }), 's').state;
    expect(handleInput(opened, 'ls').effects.every((effect) => effect.type !== 'input')).toBe(true);
    expect(handleInput(opened, '\x1b[200~hello\x1b[201~').effects).toEqual([]);
    expect(handleInput(opened, '\x1b[<0;5;5M').effects).toEqual([]);
  });

  it('메인 카드에서 Enter하면 카드 화면의 Enter와 같이 고른 칸에 터미널을 열고 이 화면을 닫는다', () => {
    const opened = handleInput(desk(), 's').state;
    const { state: next, effects } = handleInput(opened, '\r');
    expect(effects).toContainEqual({ type: 'open', slot: 0, id: 's1' });
    expect(next.inside).toBeUndefined();
  });

  it('서브에이전트 카드에서 Enter하면 깊이 2, Esc는 한 단계씩 위로(깊이 2, 깊이 1, 닫기)', () => {
    let current = handleInput(desk(), 's').state;
    current = handleInput(current, '\x1b[C').state;
    current = handleInput(current, '\r').state;
    expect(current.inside).toMatchObject({ depth: 2, agent: 'a1' });
    current = flushPending(handleInput(current, '\x1b').state).state;
    expect(current.inside).toMatchObject({ depth: 1, agent: 'a1' });
    current = flushPending(handleInput(current, '\x1b').state).state;
    expect(current.inside).toBeUndefined();
    expect(current.view).toBe('space');
  });

  it('나무 화면의 서브에이전트 줄에서 Enter하면 그 서브에이전트의 활동 기록(깊이 2)으로 간다', () => {
    let current = handleInput(desk(), 'm').state;
    current = handleInput(current, '\x1b[B').state;
    const { state: next, effects } = handleInput(current, '\r');
    expect(next.tree).toBeUndefined();
    expect(next.inside).toMatchObject({ id: 's1', depth: 2, agent: 'a1' });
    expect(effects).toContainEqual({ type: 'inside-open', id: 's1' });
  });

  it('앞글쇠 다음 다른 화면 키는 닫고 그 일을 한다', () => {
    const opened = handleInput(desk(), 's').state;
    const next = handleInput(opened, '\x02w').state;
    expect(next.inside).toBeUndefined();
  });
});

describe('메인과 서브에이전트의 그림이 다르다', () => {
  // 카드의 그림 자리는 12칸×5줄이다. 그림의 둘째 줄(몸이 나오는 줄)이 어느 카드에 들어갔는지로 본다
  const row = (sprite: Sprite) => spriteLines(sprite, 12, 5, DEFAULT_THEME, 0)[1]!;
  const mainArt = row(defaultSprite('claude-code'));
  const exploreArt = row(subagentSprite('Explore'));
  const item = { ...session, backend: 'claude-code' };

  it('메인 카드는 세션의 그림, 서브에이전트 카드는 도우미 그림이다(서브에이전트 카드에 메인의 그림이 없다)', () => {
    expect(mainArt).not.toBe(exploreArt);
    const lines = renderInside(state(base(), { items: [item] }), { w: 80, h: 40 }, NOW).lines;
    const withMain = lines.filter((line) => line.includes(mainArt));
    const withSub = lines.filter((line) => line.includes(exploreArt));
    // 메인은 한 장, 서브에이전트(탐색)는 한 장 이상
    expect(withMain).toHaveLength(1);
    expect(withSub.length).toBeGreaterThanOrEqual(1);
    expect(withMain[0]).not.toBe(withSub[0]);
  });

  it('그림 폴더에 subagent 그림이 있으면 서브에이전트 카드가 그것을 쓴다(메인은 그대로)', () => {
    const custom: Sprite = { width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 255]) };
    const lines = renderInside(state(base(), { items: [item], sprites: { subagent: custom } }), { w: 80, h: 40 }, NOW).lines;
    expect(lines.filter((line) => line.includes(mainArt))).toHaveLength(1);
    expect(lines.some((line) => line.includes(exploreArt))).toBe(false);
    expect(lines.some((line) => line.includes(row(custom)))).toBe(true);
  });
});
