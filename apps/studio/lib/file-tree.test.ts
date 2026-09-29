import { describe, expect, it } from 'vitest';
import { ancestorsOf, buildFileTree } from './file-tree';

describe('buildFileTree', () => {
  it('평평한 경로에서 폴더 트리를 만들고, 폴더를 먼저 이름순으로 둔다', () => {
    const tree = buildFileTree(['b.ts', 'src/index.ts', 'src/a/z.ts', 'src/a/a.ts', 'a.ts', 'src/b/y.ts']);

    expect(tree).toEqual([
      {
        type: 'folder',
        name: 'src',
        path: 'src',
        children: [
          {
            type: 'folder',
            name: 'a',
            path: 'src/a',
            children: [
              { type: 'file', name: 'a.ts', path: 'src/a/a.ts' },
              { type: 'file', name: 'z.ts', path: 'src/a/z.ts' },
            ],
          },
          {
            type: 'folder',
            name: 'b',
            path: 'src/b',
            children: [{ type: 'file', name: 'y.ts', path: 'src/b/y.ts' }],
          },
          { type: 'file', name: 'index.ts', path: 'src/index.ts' },
        ],
      },
      { type: 'file', name: 'a.ts', path: 'a.ts' },
      { type: 'file', name: 'b.ts', path: 'b.ts' },
    ]);
  });

  it('같은 경로가 여러 번 나와도 한 번만 담는다', () => {
    const tree = buildFileTree(['src/index.ts', 'src/index.ts']);
    expect(tree).toEqual([{ type: 'folder', name: 'src', path: 'src', children: [{ type: 'file', name: 'index.ts', path: 'src/index.ts' }] }]);
  });

  it('빈 목록이면 빈 트리를 돌려준다', () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it('앞뒤 슬래시나 빈 조각은 무시한다', () => {
    const tree = buildFileTree(['/src//index.ts']);
    expect(tree).toEqual([{ type: 'folder', name: 'src', path: 'src', children: [{ type: 'file', name: 'index.ts', path: 'src/index.ts' }] }]);
  });
});

describe('ancestorsOf', () => {
  it('루트에 가까운 순서로 조상 폴더 경로를 돌려준다', () => {
    expect(ancestorsOf('src/a/b/file.ts')).toEqual(['src', 'src/a', 'src/a/b']);
  });

  it('최상위 파일이면 빈 배열', () => {
    expect(ancestorsOf('file.ts')).toEqual([]);
  });
});
