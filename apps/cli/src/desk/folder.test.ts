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

  it('알아보지 못한 폴더는 코드·테스트만 등록을 제안하고, 테스트 명령을 골라 y·Enter로 등록한다(#946)', () => {
    const workspaceProposal = {
      detection: {
        folder: '/Users/me/tool',
        name: 'tool',
        hasSpec: false,
        services: [],
        infra: [],
        defaultInfra: [],
        warnings: ['Next.js·Vite·Spring Boot·FastAPI 앱을 찾지 못했습니다'],
        workspace: {
          language: 'Go',
          image: 'golang:1-bookworm',
          candidates: [
            { label: 'go test ./...', source: 'go.mod', command: ['go', 'test', './...'] },
            { label: 'make test', source: 'Makefile', command: ['make', 'test'] },
          ],
        },
      },
      files: [],
    };
    const state: FolderState = { ...opened(), proposal: workspaceProposal };
    const text = stripAnsi(renderFolder(state, { w: 120, h: 24 }, DEFAULT_THEME).lines.join('\n'));
    expect(text).toContain('코드·테스트만');
    expect(text).toContain('Go');
    expect(text).toContain('go test ./...');
    expect(text).toContain('make test');
    expect(text).toContain('직접 쓰기');
    // 게이트가 이 프로젝트에서 무엇을 확인하는지 적는다
    expect(text).toContain('게이트');
    expect(text).toContain('종료 코드 0');
    expect(text).not.toContain('등록할 수 없습니다');

    // 첫 후보가 골라져 있고 y로 그 명령을 실어 등록한다
    expect(folderKey(state, 'y').effects).toEqual([{ type: 'register', path: '/Users/me/tool', workspace: { test: ['go', 'test', './...'] } }]);
    const second = folderKey(state, '\x1b[B').state!;
    expect(folderKey(second, '\r').effects).toEqual([{ type: 'register', path: '/Users/me/tool', workspace: { test: ['make', 'test'] } }]);

    // 마지막 줄은 직접 쓰기: 친 글자는 명령 칸에 들어가고(y도 글자다), Enter로 sh -c 꼴로 등록한다
    let custom = folderKey(second, '\x1b[B').state!;
    for (const key of Array.from('yarn test')) custom = folderKey(custom, key).state!;
    expect(stripAnsi(renderFolder(custom, { w: 120, h: 24 }, DEFAULT_THEME).lines.join('\n'))).toContain('yarn test');
    expect(folderKey(custom, '\r').effects).toEqual([{ type: 'register', path: '/Users/me/tool', workspace: { test: ['sh', '-c', 'yarn test'] } }]);
    // 비어 있으면 등록하지 않는다
    const blank = folderKey(second, '\x1b[B').state!;
    expect(folderKey(blank, '\r').effects).toEqual([]);
    // 붙여 넣은 명령도 직접 쓰기 칸에 들어간다
    expect(folderPaste(blank, 'npm test\n').state.custom).toBe('npm test');
  });

  it('후보가 없으면 직접 쓰기 칸부터 고른다(#946)', () => {
    const state: FolderState = {
      ...opened(),
      proposal: {
        detection: { folder: '/Users/me/notes', name: 'notes', hasSpec: false, services: [], infra: [], defaultInfra: [], warnings: [], workspace: { language: '알 수 없음', image: 'buildpack-deps:bookworm', candidates: [] } },
        files: [],
      },
    };
    let typed = state;
    for (const key of Array.from('./check.sh')) typed = folderKey(typed, key).state!;
    expect(folderKey(typed, '\r').effects).toEqual([{ type: 'register', path: '/Users/me/notes', workspace: { test: ['sh', '-c', './check.sh'] } }]);
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
