import { describe, expect, it } from 'vitest';
import { stringWidth, stripAnsi } from './screen';
import {
  openSettings,
  pickerItems,
  renderSettings,
  settingsHint,
  settingsKey,
  settingsPaste,
  suggestConfigDir,
  type RulesView,
  type SettingsAccount,
  type SettingsEffect,
  type SettingsState,
} from './settings';
import { DEFAULT_THEME } from './theme';

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';
const ESC = '\x1b';
const SHIFT_TAB = '\x1b[Z';

const accounts: SettingsAccount[] = [
  { id: 'claude-code', name: '기본', backend: 'claude-code', builtin: true, status: { connected: true, installed: true, accountKind: 'Max 구독' } },
  { id: 'acct-1a2b3c4d', name: '피오', backend: 'claude-code', configDir: '/home/me/.b-studio/accounts/claude-code-1', sprite: 'pokemon/25.gif', status: { connected: false, installed: true, reason: '로그인이 필요합니다' } },
  { id: 'codex', name: '기본', backend: 'codex', builtin: true },
];

const rules: RulesView = {
  rules: [
    { when: { complexity: ['complex'] }, backend: 'claude-code', accountId: 'acct-1a2b3c4d' },
    { when: { keywords: ['테스트'] }, backend: 'codex', model: 'gpt-5' },
  ],
  fallback: { backend: 'claude-code' },
};

function loaded(patch: Partial<SettingsState> = {}): SettingsState {
  return {
    ...openSettings({ config: {}, sprites: ['default.png', 'pokemon/1.gif', 'pokemon/25.gif', 'pokemon/250.gif'] }),
    accounts,
    backends: ['claude-code', 'codex'],
    rules,
    defaultBackend: 'claude-code',
    loading: false,
    ...patch,
  };
}

/** 키를 차례로 누르고 마지막 상태와 모든 할 일을 돌려준다. 닫히면 state가 없다 */
function press(start: SettingsState, ...keys: string[]): { state: SettingsState | undefined; effects: SettingsEffect[] } {
  let state: SettingsState | undefined = start;
  const effects: SettingsEffect[] = [];
  for (const key of keys) {
    if (!state) break;
    const result = settingsKey(state, key);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

/** 글자를 하나씩 친다 */
function type(text: string): string[] {
  return [...text];
}

describe('설정 화면 이동', () => {
  it('Tab과 Shift-Tab으로 탭을 돌고, 탭을 바꾸면 첫 줄을 고른다', () => {
    let { state } = press(loaded({ row: 1 }), '\t');
    expect(state?.tab).toBe('rules');
    expect(state?.row).toBe(0);
    state = press(state!, '\t', '\t', '\t').state;
    expect(state?.tab).toBe('accounts');
    expect(press(state!, SHIFT_TAB).state?.tab).toBe('keys');
  });

  it('↑↓는 그 탭의 줄 안에서만 움직인다', () => {
    expect(press(loaded(), DOWN, DOWN, DOWN, DOWN).state?.row).toBe(2);
    expect(press(loaded(), UP).state?.row).toBe(0);
    // 규칙 탭은 규칙들 다음에 기본값 줄이 있다
    expect(press(loaded({ tab: 'rules' }), DOWN, DOWN, DOWN).state?.row).toBe(2);
  });

  it('Esc는 닫는다. 저장하지 않은 규칙이 있으면 먼저 묻고 y면 버리고 닫는다', () => {
    expect(press(loaded(), ESC).state).toBeUndefined();
    const dirty = press(loaded({ tab: 'rules', rulesDirty: true }), ESC);
    expect(dirty.state?.confirm).toEqual({ kind: 'discard-rules' });
    expect(press(dirty.state!, 'n').state?.confirm).toBeUndefined();
    expect(press(dirty.state!, 'y').state).toBeUndefined();
  });
});

describe('계정', () => {
  it('a로 계정을 더한다: 한글 이름, CLI 고르기, 비운 설정 폴더는 제안값으로 보낸다', () => {
    const { state, effects } = press(loaded(), 'a', ...type('트레버'), '\t', RIGHT, '\r');
    expect(effects).toEqual([{ type: 'account-add', name: '트레버', backend: 'codex', configDir: '~/.b-studio/accounts/codex-1' }]);
    expect(state?.form).toBeUndefined();
  });

  it('이름이 비면 보내지 않고 그 자리에 까닭을 보인다', () => {
    const { state, effects } = press(loaded(), 'a', '\r');
    expect(effects).toEqual([]);
    expect(state?.form?.error).toContain('이름');
  });

  it('제안하는 설정 폴더는 이미 쓰는 번호를 건너뛴다', () => {
    expect(suggestConfigDir('claude-code', accounts)).toBe('~/.b-studio/accounts/claude-code-2');
    expect(suggestConfigDir('codex', accounts)).toBe('~/.b-studio/accounts/codex-1');
  });

  it('Enter는 이름 바꾸기: 지금 이름이 채워져 있고, 지우고 새로 쓴 이름을 보낸다', () => {
    const opened = press(loaded({ row: 1 }), '\r').state!;
    expect(opened.form?.fields[0]).toMatchObject({ kind: 'text', value: '피오' });
    const { effects } = press(opened, '\x7f', '\x7f', ...type('마르코'), '\r');
    expect(effects).toEqual([{ type: 'account-update', id: 'acct-1a2b3c4d', name: '마르코' }]);
  });

  it('지우기는 한 번 묻고, 기본 계정은 지우지 않는다', () => {
    expect(press(loaded({ row: 0 }), 'x').state?.note).toContain('기본 계정은 지울 수 없습니다');
    const asked = press(loaded({ row: 1 }), 'x').state!;
    expect(asked.confirm).toEqual({ kind: 'remove-account', id: 'acct-1a2b3c4d', name: '피오' });
    expect(press(asked, 'y').effects).toEqual([{ type: 'account-remove', id: 'acct-1a2b3c4d' }]);
    expect(press(asked, 'n').effects).toEqual([]);
  });

  it('r은 고른 계정의 로그인 상태를 다시 묻는다', () => {
    const { state, effects } = press(loaded({ row: 1 }), 'r');
    expect(effects).toEqual([{ type: 'account-status', id: 'acct-1a2b3c4d' }]);
    expect(state?.accounts[1]?.checking).toBe(true);
  });

  it('p는 그림 고르기: 지금 그림에서 시작하고, 글자로 거르고, 고르면 그 파일을 보낸다', () => {
    const picker = press(loaded({ row: 1 }), 'p');
    expect(picker.state?.picker).toMatchObject({ accountId: 'acct-1a2b3c4d', filter: '' });
    // 0번은 무작위, 지금 그림(pokemon/25.gif)이 골라져 있다
    expect(picker.effects).toEqual([{ type: 'sprite-preview', file: 'pokemon/25.gif' }]);
    const filtered = press(picker.state!, '2', '5');
    // 거른 목록: 무작위, pokemon/25.gif, pokemon/250.gif
    expect(press(filtered.state!, DOWN, '\r').effects.at(-1)).toEqual({ type: 'account-update', id: 'acct-1a2b3c4d', sprite: 'pokemon/250.gif' });
    expect(press(picker.state!, UP, UP, UP, UP, '\r').effects.at(-1)).toEqual({ type: 'account-update', id: 'acct-1a2b3c4d', sprite: '' });
  });

  it('그림 목록은 숫자를 수의 차례로 놓는다(24가 239 뒤에 오지 않게)', () => {
    const state = loaded({ sprites: ['p/239.gif', 'p/24.gif', 'p/3.gif', 'p/240.gif'] });
    expect(pickerItems(state, { accountId: 'x', filter: '', index: 0 })).toEqual(['', 'p/3.gif', 'p/24.gif', 'p/239.gif', 'p/240.gif']);
  });

  it('l은 로그인을 시작하고, 도는 동안 c로 취소하고, Esc로 창만 닫는다(로그인은 계속 돈다)', () => {
    const started = press(loaded({ row: 1 }), 'l');
    expect(started.effects).toEqual([{ type: 'login-start', id: 'acct-1a2b3c4d' }]);
    const running = { ...started.state!, login: { ...started.state!.login!, state: 'running' as const, url: 'https://claude.ai/oauth?x=1', code: 'ABCD-1234' } };
    expect(press(running, 'c').effects).toEqual([{ type: 'login-cancel', id: 'acct-1a2b3c4d' }]);
    expect(press(running, 'o').effects).toEqual([{ type: 'open-url', url: 'https://claude.ai/oauth?x=1' }]);
    const closed = press(running, ESC).state!;
    expect(closed.login).toBeUndefined();
    expect(closed.note).toContain('뒤에서');
  });
});

describe('라우팅 규칙', () => {
  it('Enter로 규칙을 고치면 목록이 바뀌고 저장하지 않음 표시가 붙는다', () => {
    const form = press(loaded({ tab: 'rules', row: 1 }), '\r').state!;
    expect(form.form?.purpose).toBe('rule');
    const keywords = form.form!.fields.findIndex((field) => field.key === 'keywords');
    const moves = Array.from({ length: keywords }, () => DOWN);
    const { state, effects } = press(form, ...moves, ...type(', 커버리지'), '\r');
    expect(effects).toEqual([]);
    expect(state?.rules?.rules[1]?.when.keywords).toEqual(['테스트', '커버리지']);
    expect(state?.rulesDirty).toBe(true);
  });

  it('규칙의 계정 고르기는 고른 AI의 계정만 보이고, AI를 바꾸면 기본 계정으로 돌아간다', () => {
    const form = press(loaded({ tab: 'rules', row: 0 }), '\r').state!.form!;
    const account = form.fields.find((field) => field.key === 'accountId');
    expect(account).toMatchObject({ kind: 'choice', value: 'acct-1a2b3c4d' });
    expect(account?.kind === 'choice' && account.options.map((option) => option.value)).toEqual(['', 'acct-1a2b3c4d']);
    const backend = form.fields.findIndex((field) => field.key === 'backend');
    const changed = press({ ...loaded({ tab: 'rules', row: 0 }), form: { ...form, at: backend } }, RIGHT).state!.form!;
    expect(changed.fields.find((field) => field.key === 'backend')).toMatchObject({ value: 'codex' });
    const after = changed.fields.find((field) => field.key === 'accountId');
    expect(after).toMatchObject({ value: '' });
    expect(after?.kind === 'choice' && after.options.map((option) => option.value)).toEqual(['']);
  });

  it('복잡도는 ←→로 옮기고 Space로 켜고 끈다', () => {
    const form = press(loaded({ tab: 'rules', row: 1 }), '\r').state!;
    const at = form.form!.fields.findIndex((field) => field.key === 'complexity');
    const { state } = press({ ...form, form: { ...form.form!, at } }, ' ', RIGHT, RIGHT, ' ', '\r');
    expect(state?.rules?.rules[1]?.when.complexity).toEqual(['simple', 'complex']);
  });

  it('a는 고른 규칙 다음에 새 규칙을 더하고, K·J로 옮기고, x는 묻고 지운다', () => {
    const added = press(loaded({ tab: 'rules', row: 0 }), 'a', '\r').state!;
    expect(added.rules?.rules).toHaveLength(3);
    expect(added.rules?.rules[1]).toEqual({ when: {}, backend: 'claude-code' });
    expect(added.row).toBe(1);
    const moved = press(added, 'K').state!;
    expect(moved.rules?.rules[0]).toEqual({ when: {}, backend: 'claude-code' });
    expect(moved.row).toBe(0);
    expect(press(moved, '\x1b[1;2B').state?.row).toBe(1);
    const asked = press(moved, 'x').state!;
    expect(asked.confirm).toEqual({ kind: 'remove-rule', index: 0 });
    expect(press(asked, 'y').state?.rules?.rules).toEqual(rules.rules);
  });

  it('기본값 줄을 고치면 AI를 비울 수 있다(서버 기본 AI)', () => {
    const form = press(loaded({ tab: 'rules', row: 2 }), '\r').state!;
    expect(form.form?.purpose).toBe('fallback');
    const { state } = press(form, LEFT, '\r');
    expect(state?.rules?.fallback).toBeUndefined();
    expect(state?.rulesDirty).toBe(true);
  });

  it('s는 규칙 전체를 보내고, t는 요청 글을 받아 미리보기를 묻는다', () => {
    expect(press(loaded({ tab: 'rules', rulesDirty: true }), 's').effects).toEqual([{ type: 'rules-save', rules }]);
    const { state, effects } = press(loaded({ tab: 'rules' }), 't', ...type('결제 테스트 보강'), '\r');
    expect(effects).toEqual([{ type: 'preview', text: '결제 테스트 보강' }]);
    expect(state?.preview).toEqual({ text: '결제 테스트 보강', pending: true });
  });
});

describe('화면과 키', () => {
  it('→로 값을 바꾸면 그 설정을 바로 저장한다', () => {
    const { state, effects } = press(loaded({ tab: 'screen', row: 0 }), RIGHT);
    expect(effects).toEqual([{ type: 'config', config: { theme: 'light' } }]);
    expect(state?.config.theme).toBe('light');
    // 움짤 끄기
    const animate = press(loaded({ tab: 'screen', row: 2 }), '\r');
    expect(animate.effects).toEqual([{ type: 'config', config: { animate: false } }]);
  });

  it('키·알림 탭에서 완료 알림과 입력 필요 알림을 따로 끈다(#922)', () => {
    const text = renderSettings(loaded({ tab: 'keys' }), { w: 100, h: 24 }, DEFAULT_THEME).lines.map(stripAnsi).join('\n');
    expect(text).toContain('완료 알림');
    expect(text).toContain('입력 알림');
    expect(press(loaded({ tab: 'keys', row: 2 }), '\r').effects).toEqual([{ type: 'config', config: { notifyDone: false } }]);
    expect(press(loaded({ tab: 'keys', row: 3 }), '\r').effects).toEqual([{ type: 'config', config: { notifyInput: false } }]);
  });

  it('앞글쇠는 Ctrl-c·h·i·j·m을 건너뛴다', () => {
    const { effects } = press(loaded({ tab: 'keys', row: 0 }), LEFT);
    expect(effects).toEqual([{ type: 'config', config: { prefix: { key: '\x01', label: 'Ctrl-a' } } }]);
    const fromB = press(loaded({ tab: 'keys', row: 0 }), RIGHT).effects;
    expect(fromB).toEqual([{ type: 'config', config: { prefix: { key: '\x04', label: 'Ctrl-d' } } }]);
  });
});

describe('입력 칸', () => {
  it('백스페이스는 넓은 글자와 이모지 하나를 통째로 지운다', () => {
    const form = press(loaded(), 'a', ...type('피오😀')).state!;
    const after = press(form, '\x7f', '\x7f').state!;
    expect(after.form?.fields[0]).toMatchObject({ value: '피' });
  });

  it('붙여 넣은 글은 한 줄로 넣고 제어 글자는 버린다', () => {
    const form = press(loaded(), 'a').state!;
    expect(settingsPaste(form, '트레\n버\x1b[31m').form?.fields[0]).toMatchObject({ value: '트레 버[31m' });
    // 입력 칸이 없으면 버린다
    expect(settingsPaste(loaded(), 'x')).toEqual(loaded());
  });
});

describe('그리기', () => {
  const size = { w: 100, h: 24 };

  it('줄마다 폭이 정확하고, 탭 이름과 계정 줄이 보인다', () => {
    const { lines } = renderSettings(loaded({ row: 1 }), size, DEFAULT_THEME);
    expect(lines).toHaveLength(size.h);
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(size.w);
    const text = lines.map(stripAnsi).join('\n');
    for (const label of ['계정', '라우팅 규칙', '화면', '키·알림', '피오', 'Claude', 'Codex', '로그인됨', '로그인 필요', 'pokemon/25.gif']) expect(text).toContain(label);
  });

  it('규칙 탭은 조건 요약과 보낼 곳, 기본값, 저장하지 않음 표시를 보인다', () => {
    const text = renderSettings(loaded({ tab: 'rules', rulesDirty: true }), size, DEFAULT_THEME).lines.map(stripAnsi).join('\n');
    expect(text).toContain('복잡');
    expect(text).toContain('Claude · 피오');
    expect(text).toContain('"테스트" 포함');
    expect(text).toContain('gpt-5');
    expect(text).toContain('기본값');
    expect(text).toContain('저장하지 않음');
  });

  it('로그인 창은 주소를 누를 수 있는 링크(OSC 8)로 보이고 코드를 보인다', () => {
    const state = loaded({ login: { accountId: 'acct-1a2b3c4d', name: '피오', state: 'running', url: 'https://claude.ai/oauth?x=1', code: 'ABCD-1234', lines: ['브라우저에서 여세요'] } });
    const { lines } = renderSettings(state, size, DEFAULT_THEME);
    const joined = lines.join('\n');
    expect(joined).toContain('\x1b]8;;https://claude.ai/oauth?x=1\x07');
    expect(lines.map(stripAnsi).join('\n')).toContain('ABCD-1234');
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(size.w);
  });

  it('입력 칸을 쓰는 중이면 커서가 그 칸 글 끝에 있다', () => {
    const state = press(loaded(), 'a', ...type('피오')).state!;
    const { lines, cursor } = renderSettings(state, size, DEFAULT_THEME);
    expect(cursor).toBeDefined();
    const row = stripAnsi(lines[cursor!.y]!);
    // 커서 바로 앞이 친 글이다
    const before = [...row].reduce<{ width: number; text: string }>((acc, char) => (acc.width >= cursor!.x ? acc : { width: acc.width + stringWidth(char), text: acc.text + char }), { width: 0, text: '' }).text;
    expect(before.endsWith('피오')).toBe(true);
  });

  it('아래 줄 안내는 지금 하는 일을 따른다', () => {
    expect(settingsHint(loaded())).toContain('a 더하기');
    expect(settingsHint(loaded({ tab: 'rules' }))).toContain('s 저장');
    expect(settingsHint(press(loaded(), 'a').state!)).toContain('Enter 저장');
    expect(settingsHint(loaded({ note: '저장했습니다' }))).toContain('저장했습니다');
  });

  it('불러오는 중이면 그렇게 보인다', () => {
    const text = renderSettings(openSettings({ config: {}, sprites: [] }), size, DEFAULT_THEME).lines.map(stripAnsi).join('\n');
    expect(text).toContain('불러오는 중');
  });
});
