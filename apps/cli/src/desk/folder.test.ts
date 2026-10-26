/**
 * 폴더 열기 화면(#916): 경로를 쓰고 Tab으로 채우고, 하위 폴더를 고르고, 제안을 본 뒤 프로젝트로 등록한다.
 * 키는 화면 상태만 바꾸고 할 일(FolderEffect)을 돌려준다. 스튜디오를 부르는 일은 desk.ts가 한다
 */
import { describe, expect, it } from 'vitest';
import { applyListing, dirOf, folderKey, folderMatches, folderPaste, openFolder, renderFolder, type FolderListingView, type FolderState } from './folder';
import { stripAnsi } from './screen';
import { DEFAULT_THEME } from './theme';

const home: FolderListingView = {
  path: '/Users/me',
  parent: '/Users',
  children: [
    { name: 'blog', path: '/Users/me/blog', hasChildren: true, hints: ['git'] },
    { name: 'shop', path: '/Users/me/shop', hasChildren: true, hints: ['git', 'nextjs'] },
    { name: 'shopping-list', path: '/Users/me/shopping-list', hasChildren: false, hints: [] },
  ],
  truncated: false,
  totalCount: 3,
};

/** 열고 홈 목록을 받은 상태 */
function opened(): FolderState {
  const { state, effects } = openFolder();
  expect(effects).toEqual([{ type: 'list', path: '' }]);
  return applyListing(state, '', home);
}

function type(state: FolderState, text: string): { state: FolderState; effects: ReturnType<typeof folderKey>['effects'] } {
  let current = state;
  const effects: ReturnType<typeof folderKey>['effects'] = [];
  for (const key of Array.from(text)) {
    const result = folderKey(current, key);
    current = result.state!;
    effects.push(...result.effects);
  }
  return { state: current, effects };
}

describe('폴더 열기 화면(#916)', () => {
  it('처음 받은 홈 목록의 경로로 입력 칸을 채운다', () => {
    const state = opened();
    expect(state.text).toBe('/Users/me/');
    expect(folderMatches(state).map((child) => child.name)).toEqual(['blog', 'shop', 'shopping-list']);
  });

  it('dirOf는 입력의 폴더 부분이다(끝이 /면 그 폴더, 아니면 마지막 / 앞)', () => {
    expect(dirOf('/Users/me/')).toBe('/Users/me');
    expect(dirOf('/Users/me/sh')).toBe('/Users/me');
    expect(dirOf('/')).toBe('/');
    expect(dirOf('/Us')).toBe('/');
    expect(dirOf('~/')).toBe('~');
    expect(dirOf('~/wo')).toBe('~');
    expect(dirOf('~')).toBe('');
  });

  it('쓴 글로 하위 폴더를 거르고, 폴더 부분이 바뀌면 그 폴더 목록을 청한다', () => {
    const { state, effects } = type(opened(), 'sh');
    expect(folderMatches(state).map((child) => child.name)).toEqual(['shop', 'shopping-list']);
    expect(effects).toEqual([]);
    const slash = type(state, 'op/');
    expect(slash.effects).toEqual([{ type: 'list', path: '/Users/me/shop' }]);
    expect(slash.state.loading).toBe(true);
  });

  it('Tab은 하나만 맞으면 그 폴더로 들어가고, 여럿이면 같은 앞부분까지 채운다', () => {
    const many = folderKey(type(opened(), 's').state, '\t');
    expect(many.state!.text).toBe('/Users/me/shop');
    expect(many.effects).toEqual([]);
    const one = folderKey(type(opened(), 'b').state, '\t');
    expect(one.state!.text).toBe('/Users/me/blog/');
    expect(one.effects).toEqual([{ type: 'list', path: '/Users/me/blog' }]);
  });

  it('↑↓로 하위 폴더를 고르면 Tab이 그 폴더로 들어가고, Enter는 고른 폴더를 연다', () => {
    const down = folderKey(folderKey(opened(), '\x1b[B').state!, '\x1b[B').state!;
    expect(down.row).toBe(1);
    const tab = folderKey(down, '\t');
    expect(tab.state!.text).toBe('/Users/me/shop/');
    const enter = folderKey(down, '\r');
    expect(enter.effects).toEqual([{ type: 'propose', path: '/Users/me/shop' }]);
    expect(enter.state!.sending).toBe(true);
  });

  it('고른 줄이 없으면 Enter는 쓴 경로(끝 / 없이)를 연다. ~도 그대로 스튜디오에 넘긴다', () => {
    const typed: FolderState = { ...opened(), text: '~/work/shop/', row: -1 };
    expect(folderKey(typed, '\r').effects).toEqual([{ type: 'propose', path: '~/work/shop' }]);
    expect(folderKey({ ...typed, text: '/' }, '\r').effects).toEqual([{ type: 'propose', path: '/' }]);
    expect(folderKey({ ...typed, text: '  ' }, '\r').effects).toEqual([]);
  });

  it('지우기로 폴더 부분이 바뀌면 다시 청하고, 서로게이트 글자는 한 글자로 지운다', () => {
    const state: FolderState = { ...opened(), text: '/Users/me/' };
    const back = folderKey(state, '\x7f');
    expect(back.state!.text).toBe('/Users/me');
    expect(back.effects).toEqual([{ type: 'list', path: '/Users' }]);
    expect(folderKey({ ...state, text: '/Users/me/😀' }, '\x7f').state!.text).toBe('/Users/me/');
  });

  it('제안을 받으면 등록 확인 단계가 되고, y·Enter로 등록, Esc로 돌아간다', () => {
    const proposal = {
      detection: { folder: '/Users/me/shop', name: 'shop', hasSpec: false, services: [{ name: 'web', template: 'nextjs', path: '.', port: 3000 }], infra: [{ name: 'postgres' }], defaultInfra: ['postgres'], warnings: ['README가 없습니다'] },
      files: [{ path: 'studio.yaml' }, { path: 'compose.b-studio.yaml' }],
    };
    const confirm: FolderState = { ...opened(), proposal, sending: false };
    const text = stripAnsi(renderFolder(confirm, { w: 100, h: 20 }, DEFAULT_THEME).lines.join('\n'));
    expect(text).toContain('shop');
    expect(text).toContain('web');
    expect(text).toContain('postgres');
    expect(text).toContain('studio.yaml');
    expect(text).toContain('README가 없습니다');
    expect(folderKey(confirm, 'y').effects).toEqual([{ type: 'register', path: '/Users/me/shop' }]);
    expect(folderKey(confirm, '\r').effects).toEqual([{ type: 'register', path: '/Users/me/shop' }]);
    const back = folderKey(confirm, '\x1b');
    expect(back.state!.proposal).toBeUndefined();
    expect(back.effects).toEqual([]);
    expect(folderKey(confirm, 'x').effects).toEqual([]);
  });

  it('찾은 서비스도 studio.yaml도 없으면 등록할 수 없다고 보이고 y를 받지 않는다', () => {
    const empty: FolderState = {
      ...opened(),
      proposal: { detection: { folder: '/Users/me/notes', name: 'notes', hasSpec: false, services: [], infra: [], defaultInfra: [], warnings: ['이 폴더에서 돌릴 서비스를 찾지 못했습니다'] }, files: [] },
    };
    expect(folderKey(empty, 'y').effects).toEqual([]);
    expect(stripAnsi(renderFolder(empty, { w: 100, h: 20 }, DEFAULT_THEME).lines.join('\n'))).toContain('등록할 수 없습니다');
  });

  it('이미 등록한 폴더면 그렇다고 보이고 Enter로 그대로 연다', () => {
    const registered: FolderState = {
      ...opened(),
      proposal: { detection: { folder: '/Users/me/shop', name: 'shop', hasSpec: true, services: [], infra: [], defaultInfra: [], warnings: [] }, files: [], registeredId: 'shop' },
    };
    expect(stripAnsi(renderFolder(registered, { w: 100, h: 20 }, DEFAULT_THEME).lines.join('\n'))).toContain('이미 등록한 폴더');
    expect(folderKey(registered, '\r').effects).toEqual([{ type: 'register', path: '/Users/me/shop' }]);
  });

  it('Esc는 화면을 닫고, 보내는 중에는 다른 키를 받지 않는다', () => {
    const close = folderKey(opened(), '\x1b');
    expect(close.state).toBeUndefined();
    expect(close.effects).toEqual([{ type: 'close' }]);
    const sending: FolderState = { ...opened(), sending: true };
    expect(folderKey(sending, 'a')).toEqual({ state: sending, effects: [] });
  });

  it('붙여 넣은 경로는 한 줄로 넣고 그 폴더 목록을 청한다', () => {
    const pasted = folderPaste({ ...opened(), text: '' }, '/Users/me/shop/\n');
    expect(pasted.state.text).toBe('/Users/me/shop/');
    expect(pasted.effects).toEqual([{ type: 'list', path: '/Users/me/shop' }]);
  });

  it('목록에 git 저장소·이미 등록한 폴더를 표시하고, 읽지 못한 까닭을 보인다', () => {
    const state: FolderState = { ...opened(), listing: { ...home, children: [...home.children, { name: 'old', path: '/Users/me/old', hasChildren: true, hints: ['registered'] }] } };
    const text = stripAnsi(renderFolder(state, { w: 100, h: 20 }, DEFAULT_THEME).lines.join('\n'));
    expect(text).toContain('git');
    expect(text).toContain('등록됨');
    const failed = stripAnsi(renderFolder({ ...state, error: '폴더를 찾을 수 없습니다: /nope' }, { w: 100, h: 20 }, DEFAULT_THEME).lines.join('\n'));
    expect(failed).toContain('폴더를 찾을 수 없습니다');
  });

  it('늦게 온 다른 폴더의 목록은 버린다(지금 쓰는 글의 폴더 목록만 받는다)', () => {
    const state: FolderState = { ...opened(), text: '/Users/me/shop/', listed: '/Users/me/shop', loading: true };
    expect(applyListing(state, '/Users/me', home)).toBe(state);
  });
});

describe('경로 칸 비우기와 새 경로 치기(#945)', () => {
  it('Ctrl-U로 비운 뒤 홈 목록이 늦게 와도 입력 칸을 다시 채우지 않는다', () => {
    const cleared = folderKey(opened(), '\x15');
    expect(cleared.state!.text).toBe('');
    expect(cleared.effects).toEqual([{ type: 'list', path: '' }]);
    const after = applyListing(cleared.state!, '', home);
    expect(after.text).toBe('');
  });

  it('백스페이스로 다 지운 뒤에도 다시 채우지 않는다', () => {
    let state: FolderState = { ...opened(), text: '/U', listed: '' };
    state = folderKey(state, '\x7f').state!;
    state = folderKey(state, '\x7f').state!;
    expect(state.text).toBe('');
    expect(applyListing(state, state.listed, home).text).toBe('');
  });

  it('처음 열 때만 홈 경로로 채운다', () => {
    expect(opened().text).toBe('/Users/me/');
  });

  it('채워진 경로 뒤에 절대 경로를 붙여 넣거나 치면 새 경로로 본다(…/me//private → /private)', () => {
    const typed = type(opened(), '/private/tmp');
    expect(typed.state.text).toBe('/private/tmp');
    const pasted = folderPaste(opened(), '/private/tmp/shop');
    expect(pasted.state.text).toBe('/private/tmp/shop');
  });

  it('채워진 경로 뒤에 ~를 치면 홈부터 다시 쓴다', () => {
    expect(type(opened(), '~/blog').state.text).toBe('~/blog');
  });
});
