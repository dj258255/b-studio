import { describe, expect, it } from 'vitest';
import {
  buildReverseGraph,
  collectImportGraph,
  extractImportSpecifiers,
  parseAliasConfig,
  resolveImport,
  tracePages,
  type AliasConfig,
  type ImportGraphDeps,
} from './import-graph';

describe('extractImportSpecifiers', () => {
  it('정적 import·부수 효과 import·type import·재수출·동적 import·require를 뽑는다', () => {
    const source = `
      import React from 'react';
      import { A, B as C } from "./a";
      import * as ns from '@/lib/ns';
      import type { T } from './types';
      import './side-effect';
      export { x } from './x';
      export * from './all';
      export * as util from './util';
      export type { Y } from './y';
      const Lazy = dynamic(() => import('./Lazy'));
      const mod = await import(\`./tpl\`);
      const old = require('./old');
    `;
    expect(extractImportSpecifiers(source)).toEqual([
      'react',
      './a',
      '@/lib/ns',
      './types',
      './side-effect',
      './x',
      './all',
      './util',
      './y',
      './Lazy',
      './tpl',
      './old',
    ]);
  });

  it('주석과 문자열·템플릿 안의 가짜 import는 무시한다', () => {
    const source = `
      // import { A } from './line-comment';
      /* import { B } from './block-comment'; */
      const s = "import { C } from './in-string'";
      const t = 'export * from "./in-single"';
      const u = \`import('./in-template')\`;
      /**
       * import { D } from './jsdoc';
       */
      import { Real } from './real';
    `;
    expect(extractImportSpecifiers(source)).toEqual(['./real']);
  });

  it('동적 import의 변수·보간 템플릿, export 선언, 속성 접근은 import로 보지 않는다', () => {
    const source = `
      const a = import(name);
      const b = import(\`./x/\${id}\`);
      export const c = 1;
      export default function Page() {}
      export function f() { return obj.import('./nope'); }
      const m = import.meta.url;
    `;
    expect(extractImportSpecifiers(source)).toEqual([]);
  });

  it('JSX 글자의 아포스트로피가 뒤쪽 import를 삼키지 않는다', () => {
    const source = `
      export function A() { return <p>Don't stop</p>; }
      const Lazy = dynamic(() => import('./Late'));
    `;
    expect(extractImportSpecifiers(source)).toEqual(['./Late']);
  });

  it('정규식 리터럴 안의 따옴표에 속지 않는다', () => {
    const source = `const re = /["']import/g;\nimport { A } from './a';`;
    expect(extractImportSpecifiers(source)).toEqual(['./a']);
  });
});

describe('resolveImport', () => {
  const files = new Set(['app/live/[id]/page.tsx', 'components/LiveViewer.tsx', 'components/ui/index.ts', 'lib/livePin.ts', 'src/lib/only-in-src.ts', 'utils/esm.ts']);
  const none: AliasConfig = { paths: [] };

  it('상대 경로는 확장자 생략과 index 파일을 푼다', () => {
    expect(resolveImport('../../../components/LiveViewer', 'app/live/[id]/page.tsx', files, none)).toBe('components/LiveViewer.tsx');
    expect(resolveImport('./ui', 'components/LiveViewer.tsx', files, none)).toBe('components/ui/index.ts');
    expect(resolveImport('../lib/livePin', 'components/LiveViewer.tsx', files, none)).toBe('lib/livePin.ts');
  });

  it("TS ESM 식 './esm.js'를 .ts 파일로 푼다", () => {
    expect(resolveImport('./esm.js', 'utils/other.ts', files, none)).toBe('utils/esm.ts');
  });

  it('서비스 밖으로 나가는 경로와 패키지·node: 지정자는 따라가지 않는다', () => {
    expect(resolveImport('../../outside', 'components/LiveViewer.tsx', files, none)).toBeUndefined();
    expect(resolveImport('react', 'components/LiveViewer.tsx', files, none)).toBeUndefined();
    expect(resolveImport('node:fs', 'components/LiveViewer.tsx', files, none)).toBeUndefined();
  });

  it('tsconfig paths 별칭을 푼다', () => {
    const alias = parseAliasConfig('{ "compilerOptions": { "paths": { "@/*": ["./*"], "@lib/*": ["lib/*"] } } }');
    expect(resolveImport('@/components/LiveViewer', 'app/live/[id]/page.tsx', files, alias)).toBe('components/LiveViewer.tsx');
    expect(resolveImport('@lib/livePin', 'components/LiveViewer.tsx', files, alias)).toBe('lib/livePin.ts');
  });

  it('baseUrl이 src이면 paths 타깃과 맨 경로 import가 src 기준으로 풀린다', () => {
    const alias = parseAliasConfig('{ // 주석\n "compilerOptions": { "baseUrl": "src", "paths": { "@/*": ["*"], }, }, }');
    expect(alias).toEqual({ baseUrl: 'src', paths: [{ pattern: '@/*', targets: ['src/*'] }] });
    expect(resolveImport('@/lib/only-in-src', 'app/page.tsx', files, alias)).toBe('src/lib/only-in-src.ts');
    expect(resolveImport('lib/only-in-src', 'app/page.tsx', files, alias)).toBe('src/lib/only-in-src.ts');
  });

  it('설정이 없으면 @/를 서비스 루트와 src/ 순서로 시도한다', () => {
    expect(resolveImport('@/lib/livePin', 'app/page.tsx', files, none)).toBe('lib/livePin.ts');
    expect(resolveImport('@/lib/only-in-src', 'app/page.tsx', files, none)).toBe('src/lib/only-in-src.ts');
  });
});

describe('tracePages', () => {
  const files = new Set(['app/page.tsx', 'app/layout.tsx', 'app/live/[id]/page.tsx', 'app/shorts/page.tsx', 'components/LiveViewer.tsx', 'components/Badge.tsx', 'lib/livePin.ts']);
  const sources = new Map([
    ['app/live/[id]/page.tsx', "import { LiveViewer } from '@/components/LiveViewer';"],
    ['components/LiveViewer.tsx', "import { pin } from '../lib/livePin';"],
    ['app/layout.tsx', "import './globals';"],
    ['app/page.tsx', ''],
    ['app/shorts/page.tsx', ''],
  ]);
  const reverse = buildReverseGraph(sources, files, { paths: [] });

  it('컴포넌트 변경은 그것을 import하는 page를 1단계로 찾는다', () => {
    const { candidates, truncated } = tracePages(['components/LiveViewer.tsx'], reverse, files, 5);
    expect(candidates).toEqual([{ page: 'app/live/[id]/page.tsx', cause: 'components/LiveViewer.tsx', distance: 1, tie: 0 }]);
    expect(truncated).toEqual([]);
  });

  it('유틸 변경은 컴포넌트를 거쳐 page를 2단계로 찾는다', () => {
    const { candidates } = tracePages(['lib/livePin.ts'], reverse, files, 5);
    expect(candidates).toEqual([{ page: 'app/live/[id]/page.tsx', cause: 'lib/livePin.ts', distance: 2, tie: 0 }]);
  });

  it('바뀐 page 자체는 거리 0으로 먼저 온다', () => {
    const { candidates } = tracePages(['lib/livePin.ts', 'app/shorts/page.tsx'], reverse, files, 5);
    expect(candidates.map((c) => [c.page, c.distance])).toEqual([
      ['app/shorts/page.tsx', 0],
      ['app/live/[id]/page.tsx', 2],
    ]);
  });

  it('깊이 상한을 넘는 사슬은 멈춘 곳을 truncated로 남기고 page를 돌려주지 않는다', () => {
    const { candidates, truncated } = tracePages(['lib/livePin.ts'], reverse, files, 1);
    expect(candidates).toEqual([]);
    expect(truncated).toEqual([{ cause: 'lib/livePin.ts', stoppedAt: 'components/LiveViewer.tsx' }]);
  });

  it('layout이 바뀌면 그 폴더 아래 page를 얕은 순서로 잇는다', () => {
    const { candidates } = tracePages(['app/layout.tsx'], reverse, files, 5);
    expect(candidates.map((c) => [c.page, c.distance, c.tie])).toEqual([
      ['app/page.tsx', 1, 0],
      ['app/shorts/page.tsx', 1, 1],
      ['app/live/[id]/page.tsx', 1, 2],
    ]);
  });

  it('layout이 쓰는 컴포넌트가 바뀌면 layout을 거쳐 하위 page까지 2단계로 닿는다', () => {
    const withHeader = new Set([...files, 'components/Header.tsx']);
    const graph = buildReverseGraph(new Map([...sources, ['app/layout.tsx', "import { Header } from '@/components/Header';"]]), withHeader, { paths: [] });
    const { candidates } = tracePages(['components/Header.tsx'], graph, withHeader, 5);
    expect(candidates.map((c) => c.distance)).toEqual([2, 2, 2]);
    expect(candidates[0]!.page).toBe('app/page.tsx');
  });

  it('순환 import에서도 끝난다', () => {
    const cyc = new Set(['a.ts', 'b.ts', 'c.ts', 'app/page.tsx']);
    const graph = buildReverseGraph(
      new Map([
        ['a.ts', "import './b';"],
        ['b.ts', "import './c';"],
        ['c.ts', "import './a'; import './app/page';"],
        ['app/page.tsx', "import '../a';"],
      ]),
      cyc,
      { paths: [] },
    );
    const { candidates } = tracePages(['a.ts'], graph, cyc, 5);
    expect(candidates.map((c) => c.page)).toEqual(['app/page.tsx']);
  });
});

describe('collectImportGraph', () => {
  /** 메모리 파일 시스템. 키는 프로젝트 루트 기준 경로 */
  function memory(fileMap: Record<string, string>, log: { reads: string[]; lists: string[] } = { reads: [], lists: [] }): ImportGraphDeps {
    let clock = 0;
    return {
      now: () => (clock += 1),
      list: async (dir) => {
        log.lists.push(dir);
        const base = dir === '.' ? '' : `${dir}/`;
        const names = new Map<string, boolean>();
        for (const file of Object.keys(fileMap)) {
          if (!file.startsWith(base)) continue;
          const rest = file.slice(base.length);
          const slash = rest.indexOf('/');
          names.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
        }
        return [...names].map(([name, isDir]) => `${base}${name}${isDir ? '/' : ''}`);
      },
      read: async (file) => {
        log.reads.push(file);
        const content = fileMap[file];
        if (content === undefined) throw new Error('없음');
        return content;
      },
    };
  }

  it('서비스 폴더의 소스를 읽어 역방향 그래프를 만들고 node_modules·.next·테스트 파일은 읽지 않는다', async () => {
    const log = { reads: [] as string[], lists: [] as string[] };
    const graph = await collectImportGraph(
      memory(
        {
          'apps/web/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }',
          'apps/web/app/live/[id]/page.tsx': "import { LiveViewer } from '@/components/LiveViewer';",
          'apps/web/components/LiveViewer.tsx': "import { pin } from '@/lib/livePin';",
          'apps/web/components/LiveViewer.test.tsx': "import './LiveViewer';",
          'apps/web/lib/livePin.ts': 'export const pin = 1;',
          'apps/web/node_modules/pkg/index.js': "import './x';",
          'apps/web/.next/server/page.js': "import './x';",
          'apps/web/types.d.ts': 'declare const x: number;',
          'apps/api/Main.java': 'class Main {}',
        },
        log,
      ),
      'apps/web',
    );

    expect([...graph.files].sort()).toEqual(['app/live/[id]/page.tsx', 'components/LiveViewer.tsx', 'lib/livePin.ts']);
    expect(graph.reverse.get('lib/livePin.ts')).toEqual(new Set(['components/LiveViewer.tsx']));
    expect(graph.reverse.get('components/LiveViewer.tsx')).toEqual(new Set(['app/live/[id]/page.tsx']));
    expect(log.reads.some((file) => file.includes('node_modules') || file.includes('.next') || file.includes('.test.'))).toBe(false);
    expect(graph.readCount).toBe(3);
    expect(graph.incomplete).toBeUndefined();
  });

  it('읽기 상한을 넘으면 거기까지 만들고 이유를 incomplete로 남긴다', async () => {
    const fileMap: Record<string, string> = {};
    for (let i = 0; i < 10; i++) fileMap[`web/lib/f${i}.ts`] = '';
    const graph = await collectImportGraph(memory(fileMap), 'web', { maxFiles: 4, maxDirs: 50, maxMs: 10_000 });
    expect(graph.readCount).toBe(4);
    expect(graph.incomplete).toContain('10개 중 4개까지만 읽었습니다');
  });

  it('시간 상한을 넘으면 읽기를 멈추고 이유를 남긴다', async () => {
    const fileMap: Record<string, string> = {};
    for (let i = 0; i < 40; i++) fileMap[`web/lib/f${i}.ts`] = '';
    const graph = await collectImportGraph(memory(fileMap), 'web', { maxFiles: 100, maxDirs: 50, maxMs: 3 });
    expect(graph.incomplete).toContain('시간 상한');
  });
});
