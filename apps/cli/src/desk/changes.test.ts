import { describe, expect, it } from 'vitest';
import {
  changesHint,
  changesKey,
  changesLoaded,
  changesPaste,
  commentPrompt,
  diffRows,
  openChanges,
  renderChanges,
  type ChangesState,
  type DeskComment,
  type LiveChangesView,
} from './changes';
import { stringWidth, stripAnsi } from './screen';
import { DEFAULT_THEME } from './theme';

const ESC = '\x1b';
const DOWN = '\x1b[B';
const UP = '\x1b[A';

const PATCH = [
  'diff --git a/api/Order.java b/api/Order.java',
  'index 1111111..2222222 100644',
  '--- a/api/Order.java',
  '+++ b/api/Order.java',
  '@@ -1,3 +1,3 @@',
  ' class Order {',
  '-  int sum;',
  '+  int total;',
  ' }',
].join('\n');

const DATA: LiveChangesView = {
  files: [
    { file: 'api/Order.java', change: 'modified', patch: PATCH, added: 1, removed: 1 },
    { file: 'logo.png', change: 'added', binary: true, added: 0, removed: 0 },
    { file: 'docs/a.md', change: 'added', patch: '--- /dev/null\n+++ b/docs/a.md\n@@ -0,0 +1,2 @@\n+# 제목\n+본문\n', added: 2, removed: 0 },
  ],
  truncated: false,
  head: 'abc1234',
  branch: 'b-studio/s1',
  base: 'main',
  behind: 2,
  ahead: 1,
};

function loaded(comments: DeskComment[] = []): ChangesState {
  const opened = openChanges('s1', '주문 고치기', comments);
  return changesLoaded(opened.state, DATA);
}

/** 키를 차례로 누른다. 낸 할 일을 모두 모은다 */
function press(state: ChangesState, ...keys: string[]) {
  let current: ChangesState | undefined = state;
  const effects = [];
  for (const key of keys) {
    const result = changesKey(current!, key, () => '2026-10-26T00:00:00.000Z');
    current = result.state;
    effects.push(...result.effects);
    if (!current) break;
  }
  return { state: current, effects };
}

describe('diffRows', () => {
  it('머리 줄은 빼고 줄 번호를 매긴다', () => {
    const rows = diffRows(PATCH);
    expect(rows.map((row) => row.kind)).toEqual(['hunk', 'ctx', 'del', 'add', 'ctx']);
    expect(rows[1]).toMatchObject({ old: 1, new: 1, text: 'class Order {' });
    expect(rows[2]).toMatchObject({ kind: 'del', old: 2, text: '  int sum;' });
    expect(rows[2]!.new).toBeUndefined();
    expect(rows[3]).toMatchObject({ kind: 'add', new: 2, text: '  int total;' });
    expect(rows[4]).toMatchObject({ old: 3, new: 3 });
  });

  it('제어 글자는 화면에 그대로 내보내지 않는다(파일 내용이 터미널을 조작하지 못하게)', () => {
    const rows = diffRows('@@ -0,0 +1,1 @@\n+a\x1b]52;c;ZXZpbA==\x07b\tc');
    expect(rows[1]!.text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(rows[1]!.text).toContain('b    c');
  });
});

describe('지금 변경 화면 키', () => {
  it('열면 변경을 받고, 받으면 첫 파일의 첫 줄을 고른다', () => {
    const opened = openChanges('s1', '주문', []);
    expect(opened.effects).toEqual([{ type: 'load', id: 's1' }]);
    expect(opened.state.loading).toBe(true);
    const state = changesLoaded(opened.state, DATA);
    expect(state.loading).toBe(false);
    expect(state.file).toBe(0);
    expect(state.focus).toBe('files');
  });

  it('파일 목록에서 ↑↓로 파일을 고르고 Enter·Tab으로 diff로 간다', () => {
    let { state } = press(loaded(), DOWN, DOWN);
    expect(state!.file).toBe(2);
    ({ state } = press(state!, UP));
    expect(state!.file).toBe(1);
    ({ state } = press(state!, '\r'));
    expect(state!.focus).toBe('diff');
    ({ state } = press(state!, '\t'));
    expect(state!.focus).toBe('files');
    ({ state } = press(state!, ']'));
    expect(state!.file).toBe(2);
  });

  it('diff에서 c로 의견을 쓰고 Enter로 남긴다. 남기면 저장할 일을 낸다', () => {
    const { state, effects } = press(loaded(), '\r', DOWN, DOWN, DOWN, 'c', '이', '름', ' ', 'O', 'K', '\x7f', '\r');
    expect(state!.writing).toBeUndefined();
    expect(state!.comments).toHaveLength(1);
    expect(state!.comments[0]).toMatchObject({ file: 'api/Order.java', line: 2, side: 'new', code: '  int total;', text: '이름 O' });
    expect(effects).toContainEqual({ type: 'save-comments', id: 's1', comments: state!.comments });
  });

  it('지운 줄에 단 의견은 옛 줄 번호를 쓴다', () => {
    const { state } = press(loaded(), '\r', DOWN, DOWN, 'c', 'x', '\r');
    expect(state!.comments[0]).toMatchObject({ line: 2, side: 'old', code: '  int sum;' });
  });

  it('머리 줄(@@)에는 의견을 달지 않는다', () => {
    const { state } = press(loaded(), '\r', 'c');
    expect(state!.writing).toBeUndefined();
    expect(state!.note).toContain('줄');
  });

  it('의견을 쓰는 중 Esc는 쓰기만 그만두고, 화면은 닫지 않는다', () => {
    const { state, effects } = press(loaded(), '\r', DOWN, 'c', 'a', ESC);
    expect(state).toBeDefined();
    expect(state!.writing).toBeUndefined();
    expect(state!.comments).toHaveLength(0);
    expect(effects).toEqual([]);
  });

  it('쓰는 중에 붙여 넣은 글은 한 줄로 들어가고 제어 글자는 버린다', () => {
    const writing = press(loaded(), '\r', DOWN, 'c').state!;
    const pasted = changesPaste(writing, '첫\n둘\x1b[31m');
    expect(pasted.writing!.text).toBe('첫 둘[31m');
    // 쓰지 않을 때 붙여넣기는 버린다
    expect(changesPaste(loaded(), 'x')).toEqual(loaded());
  });

  it('x는 그 줄 의견의 해결 표시를 켜고 끈다', () => {
    const comment: DeskComment = { id: 'c1', file: 'api/Order.java', line: 2, side: 'new', code: '  int total;', text: '이름', createdAt: 't' };
    let { state, effects } = press(loaded([comment]), '\r', DOWN, DOWN, DOWN, 'x');
    expect(state!.comments[0]!.resolved).toBe(true);
    expect(effects).toHaveLength(1);
    ({ state } = press(state!, 'x'));
    expect(state!.comments[0]!.resolved).toBeUndefined();
  });

  it('D는 그 줄의 의견을 지운다', () => {
    const comment: DeskComment = { id: 'c1', file: 'api/Order.java', line: 2, side: 'new', code: '  int total;', text: '이름', createdAt: 't' };
    const { state } = press(loaded([comment]), '\r', DOWN, DOWN, DOWN, 'D');
    expect(state!.comments).toEqual([]);
  });

  it('S는 해결하지 않은 의견만 묶어 보낸다. 보낸 의견은 남는다', () => {
    const comments: DeskComment[] = [
      { id: 'c1', file: 'api/Order.java', line: 2, side: 'new', code: '  int total;', text: '이름을 amount로', createdAt: 't' },
      { id: 'c2', file: 'api/Order.java', line: 2, side: 'old', code: '  int sum;', text: '이건 됐음', createdAt: 't', resolved: true },
      { id: 'c3', file: 'docs/a.md', line: 1, side: 'new', code: '# 제목', text: '제목을 한국어로', createdAt: 't' },
    ];
    const { state, effects } = press(loaded(comments), 'S');
    const send = effects.find((effect) => effect.type === 'send');
    expect(send).toBeDefined();
    if (send?.type !== 'send') throw new Error('보내기가 없습니다');
    expect(send.id).toBe('s1');
    expect(send.count).toBe(2);
    expect(send.text).toContain('api/Order.java:2');
    expect(send.text).toContain('이름을 amount로');
    expect(send.text).toContain('docs/a.md:1');
    expect(send.text).not.toContain('이건 됐음');
    // 보내기(Enter)는 사람이 한다: 글 끝에 줄바꿈이 없다
    expect(send.text.endsWith('\n')).toBe(false);
    expect(state!.comments).toHaveLength(3);
    expect(state!.comments.find((comment) => comment.id === 'c1')!.sentAt).toBe('2026-10-26T00:00:00.000Z');
    expect(effects).toContainEqual({ type: 'save-comments', id: 's1', comments: state!.comments });
  });

  it('보낼 의견이 없으면 S는 알리기만 한다', () => {
    const { state, effects } = press(loaded(), 'S');
    expect(effects).toEqual([]);
    expect(state!.note).toContain('의견');
  });

  it('r은 다시 받고, Esc는 닫는다', () => {
    expect(press(loaded(), 'r').effects).toEqual([{ type: 'load', id: 's1' }]);
    const closed = press(loaded(), ESC);
    expect(closed.state).toBeUndefined();
    expect(closed.effects).toEqual([{ type: 'close' }]);
  });

  it('받는 동안 고른 파일이 사라지면 범위 안으로 옮긴다', () => {
    const state = press(loaded(), DOWN, DOWN).state!;
    const next = changesLoaded(state, { ...DATA, files: DATA.files.slice(0, 1) });
    expect(next.file).toBe(0);
  });
});

describe('commentPrompt', () => {
  it('파일:줄, 그 줄, 의견을 차례로 적는다', () => {
    const text = commentPrompt([
      { id: 'c1', file: 'a.ts', line: 3, side: 'new', code: 'const a = 1;', text: '이름', createdAt: 't' },
      { id: 'c2', file: 'b.ts', line: 9, side: 'old', code: 'old()', text: '왜 지웠나요', createdAt: 't' },
    ]);
    expect(text).toContain('1. a.ts:3');
    expect(text).toContain('> const a = 1;');
    expect(text).toContain('2. b.ts:9(지운 줄)');
    expect(text).toContain('왜 지웠나요');
  });
});

describe('그리기', () => {
  it('머리에 브랜치·기준과 갈라진 정도, 파일 목록과 diff를 그린다', () => {
    const state = press(loaded(), '\r').state!;
    const body = renderChanges(state, { w: 120, h: 20 }, DEFAULT_THEME).lines.map(stripAnsi);
    expect(body).toHaveLength(20);
    const text = body.join('\n');
    expect(text).toContain('b-studio/s1');
    expect(text).toContain('main보다 2 뒤');
    expect(text).toContain('api/Order.java');
    expect(text).toContain('logo.png');
    expect(text).toContain('int total;');
    for (const line of body) expect(stringWidth(line)).toBeLessThanOrEqual(120);
  });

  it('바이너리 파일은 내용 대신 표시를 보인다', () => {
    const state = press(loaded(), DOWN, '\r').state!;
    const text = renderChanges(state, { w: 100, h: 16 }, DEFAULT_THEME).lines.map(stripAnsi).join('\n');
    expect(text).toContain('바이너리');
  });

  it('의견은 그 줄 밑에 보이고 해결한 의견은 표시가 다르다', () => {
    const comments: DeskComment[] = [
      { id: 'c1', file: 'api/Order.java', line: 2, side: 'new', code: '  int total;', text: '이름을 amount로', createdAt: 't' },
      { id: 'c2', file: 'api/Order.java', line: 2, side: 'old', code: '  int sum;', text: '됐음', createdAt: 't', resolved: true },
    ];
    const state = press(loaded(comments), '\r').state!;
    const text = renderChanges(state, { w: 120, h: 20 }, DEFAULT_THEME).lines.map(stripAnsi).join('\n');
    expect(text).toContain('이름을 amount로');
    expect(text).toMatch(/✓ 됐음/);
  });

  it('바뀐 것이 없으면 그렇다고 알린다', () => {
    const state = changesLoaded(openChanges('s1', 't', []).state, { files: [], truncated: false });
    const text = renderChanges(state, { w: 80, h: 10 }, DEFAULT_THEME).lines.map(stripAnsi).join('\n');
    expect(text).toContain('바뀐 파일이 없습니다');
  });

  it('좁은 화면에서도 폭을 넘지 않는다', () => {
    const state = press(loaded(), '\r').state!;
    for (const line of renderChanges(state, { w: 50, h: 12 }, DEFAULT_THEME).lines) expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(50);
  });

  it('안내 줄은 쓰는 중과 보는 중이 다르다', () => {
    expect(changesHint(loaded())).toContain('S');
    expect(changesHint(press(loaded(), '\r', DOWN, 'c').state!)).toContain('Enter');
  });
});
