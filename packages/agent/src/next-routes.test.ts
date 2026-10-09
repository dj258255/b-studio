import { AUTO_PAGE_MAX } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { isIdLikeSegment, routesFromCandidates, routesFromChangedFiles } from './next-routes';

describe('routesFromChangedFiles', () => {
  it('서비스 폴더 안의 바뀐 page 파일에서 경로를 만든다', () => {
    const result = routesFromChangedFiles(['web/app/page.tsx', 'web/app/orders/page.tsx', 'web/app/orders/new/page.tsx'], 'web');

    expect(result.routes).toEqual([
      { path: '/', file: 'web/app/page.tsx' },
      { path: '/orders', file: 'web/app/orders/page.tsx' },
      { path: '/orders/new', file: 'web/app/orders/new/page.tsx' },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('src/app도 같은 규칙으로 읽고, page가 아닌 파일은 보지 않는다', () => {
    const result = routesFromChangedFiles(
      [
        'web/src/app/dashboard/page.tsx',
        'web/src/app/dashboard/layout.tsx',
        'web/src/app/dashboard/loading.tsx',
        'web/src/app/dashboard/page.test.tsx',
        'web/src/app/dashboard/page.tsx.bak',
        'web/app/api/orders/route.ts',
      ],
      'web',
    );

    expect(result.routes).toEqual([{ path: '/dashboard', file: 'web/src/app/dashboard/page.tsx' }]);
    expect(result.skipped).toEqual([]);
  });

  it('page 확장자 넷을 모두 받는다', () => {
    const files = ['web/app/a/page.tsx', 'web/app/b/page.jsx', 'web/app/c/page.ts', 'web/app/d/page.js', 'web/app/e/page.mdx'];
    expect(routesFromChangedFiles(files, 'web').routes.map((route) => route.path)).toEqual(['/a', '/b', '/c', '/d', '/e']);
  });

  it('라우트 그룹 (x)은 주소에서 뺀다', () => {
    const result = routesFromChangedFiles(['web/app/(marketing)/about/page.tsx', 'web/app/(shop)/(nested)/cart/page.tsx'], 'web');

    expect(result.routes.map((route) => route.path)).toEqual(['/about', '/cart']);
  });

  it('동적 세그먼트는 sampleParams 값으로 채운다', () => {
    const result = routesFromChangedFiles(['web/app/orders/[id]/page.tsx', 'web/app/u/[userId]/posts/[postId]/page.tsx'], 'web', {
      id: '1',
      userId: 'kim',
      postId: '42',
    });

    expect(result.routes.map((route) => route.path)).toEqual(['/orders/1', '/u/kim/posts/42']);
  });

  it('값을 알 수 있는 문자가 아니면 퍼센트 인코딩하고, 값이 없으면 건너뛴다', () => {
    // 스키마가 안전한 문자만 받지만, 순수 함수는 어떤 값이 와도 경로를 망가뜨리지 않아야 한다
    expect(routesFromChangedFiles(['web/app/tag/[name]/page.tsx'], 'web', { name: 'a b' }).routes.map((route) => route.path)).toEqual(['/tag/a%20b']);

    const missing = routesFromChangedFiles(['web/app/orders/[id]/page.tsx'], 'web');
    expect(missing.routes).toEqual([]);
    expect(missing.skipped).toEqual([{ file: 'web/app/orders/[id]/page.tsx', reason: "동적 세그먼트 'id'의 값이 없습니다 — autoPageChecks.sampleParams에 넣으세요" }]);

    // 다른 세그먼트의 값이 있어도 없는 쪽이 있으면 그 라우트는 건너뛴다
    const partial = routesFromChangedFiles(['web/app/[a]/[b]/page.tsx'], 'web', { a: 'x' });
    expect(partial.routes).toEqual([]);
    expect(partial.skipped[0]!.reason).toContain("'b'의 값이 없습니다");
  });

  it('catch-all·병렬·인터셉트 라우트는 이유와 함께 건너뛴다', () => {
    const result = routesFromChangedFiles(
      [
        'web/app/blog/[...slug]/page.tsx',
        'web/app/shop/[[...slug]]/page.tsx',
        'web/app/@modal/page.tsx',
        'web/app/(.)photo/page.tsx',
        'web/app/(..)photo/page.tsx',
        'web/app/(..)(..)photo/page.tsx',
        'web/app/[id/page.tsx',
      ],
      'web',
    );

    expect(result.routes).toEqual([]);
    // 건너뛴 항목은 파일 이름 순서로 남는다(결정론적)
    expect(result.skipped).toEqual([
      { file: 'web/app/(.)photo/page.tsx', reason: '인터셉트 라우트((.)·(..))는 화면 주소가 아니어서 열지 않습니다' },
      { file: 'web/app/(..)(..)photo/page.tsx', reason: '인터셉트 라우트((.)·(..))는 화면 주소가 아니어서 열지 않습니다' },
      { file: 'web/app/(..)photo/page.tsx', reason: '인터셉트 라우트((.)·(..))는 화면 주소가 아니어서 열지 않습니다' },
      { file: 'web/app/@modal/page.tsx', reason: '병렬 라우트(@slot)는 경로를 하나로 정할 수 없어 열지 않습니다' },
      { file: 'web/app/[id/page.tsx', reason: '동적 세그먼트 형식을 알아볼 수 없어 열지 않습니다: [id' },
      { file: 'web/app/blog/[...slug]/page.tsx', reason: 'catch-all 라우트([...x])는 열어 볼 값을 정할 수 없어 열지 않습니다' },
      { file: 'web/app/shop/[[...slug]]/page.tsx', reason: 'catch-all 라우트([...x])는 열어 볼 값을 정할 수 없어 열지 않습니다' },
    ]);
  });

  it('서비스 폴더 밖 파일과 다른 템플릿의 페이지는 보지 않는다', () => {
    const result = routesFromChangedFiles(
      ['api/app/page.tsx', 'webapp/app/page.tsx', 'web-old/app/page.tsx', 'web/app/page.tsx', 'docs/readme.md'],
      'web',
    );

    expect(result.routes).toEqual([{ path: '/', file: 'web/app/page.tsx' }]);
    expect(result.skipped).toEqual([]);
  });

  it('윈도 경로 구분자와 중복 슬래시를 견딘다', () => {
    const result = routesFromChangedFiles(['web\\app\\orders\\page.tsx', 'web//app//cart//page.tsx', './web/app/about/page.tsx'], 'web');

    expect(result.routes.map((route) => route.path)).toEqual(['/about', '/cart', '/orders']);
  });

  it('같은 경로를 만드는 파일이 여럿이면 하나만 남긴다', () => {
    const result = routesFromChangedFiles(['web/app/(a)/orders/page.tsx', 'web/app/orders/page.tsx'], 'web');

    expect(result.routes).toEqual([{ path: '/orders', file: 'web/app/(a)/orders/page.tsx' }]);
  });

  it('maxPages를 넘는 페이지는 건너뛰고 이유를 남긴다', () => {
    const files = ['web/app/a/page.tsx', 'web/app/b/page.tsx', 'web/app/c/page.tsx'];
    const result = routesFromChangedFiles(files, 'web', {}, 2);

    expect(result.routes.map((route) => route.path)).toEqual(['/a', '/b']);
    expect(result.skipped).toEqual([{ file: 'web/app/c/page.tsx', reason: '한 번에 열어 보는 페이지 상한(2개)을 넘었습니다 — autoPageChecks.maxPages를 늘리세요' }]);
  });

  it('maxPages는 기본 5이고 상한 10을 넘지 않는다', () => {
    const many = Array.from({ length: 12 }, (_, index) => `web/app/p${String(index).padStart(2, '0')}/page.tsx`);
    expect(routesFromChangedFiles(many, 'web').routes).toHaveLength(5);
    expect(routesFromChangedFiles(many, 'web', {}, 100).routes).toHaveLength(AUTO_PAGE_MAX);
  });

  it('바뀐 페이지가 없으면 빈 목록이다', () => {
    expect(routesFromChangedFiles(['api/src/main/java/Order.java', 'web/app/orders/layout.tsx'], 'web')).toEqual({ routes: [], skipped: [] });
    expect(routesFromChangedFiles([], 'web')).toEqual({ routes: [], skipped: [] });
  });

  it('서비스 경로가 "."이면 프로젝트 전체를 본다', () => {
    expect(routesFromChangedFiles(['app/page.tsx'], '.').routes).toEqual([{ path: '/', file: 'app/page.tsx' }]);
  });

  describe('동적 경로 fallback (ADR-078)', () => {
    it('id처럼 보이는 세그먼트는 fallbackValue로 채우고 usedFallbackParams에 이름을 남긴다', () => {
      const result = routesFromChangedFiles(['web/app/orders/[id]/page.tsx'], 'web', {}, 5, '1');
      expect(result.skipped).toEqual([]);
      expect(result.routes).toEqual([{ path: '/orders/1', file: 'web/app/orders/[id]/page.tsx', usedFallbackParams: ['id'] }]);
    });

    it('sampleParams에 이미 값이 있으면 fallbackValue를 쓰지 않고, usedFallbackParams도 남기지 않는다', () => {
      const result = routesFromChangedFiles(['web/app/orders/[id]/page.tsx'], 'web', { id: '7' }, 5, '1');
      expect(result.routes).toEqual([{ path: '/orders/7', file: 'web/app/orders/[id]/page.tsx' }]);
    });

    it('id로 보이지 않는 이름(slug)은 fallbackValue가 있어도 건너뛴다', () => {
      const result = routesFromChangedFiles(['web/app/tag/[slug]/page.tsx'], 'web', {}, 5, '1');
      expect(result.routes).toEqual([]);
      expect(result.skipped).toEqual([{ file: 'web/app/tag/[slug]/page.tsx', reason: "동적 세그먼트 'slug'의 값이 없습니다 — autoPageChecks.sampleParams에 넣으세요" }]);
    });

    it('fallbackValue를 주지 않으면(기본값) 예전처럼 값이 없는 세그먼트를 건너뛴다', () => {
      const result = routesFromChangedFiles(['web/app/orders/[id]/page.tsx'], 'web');
      expect(result.routes).toEqual([]);
      expect(result.skipped[0]!.reason).toContain("'id'의 값이 없습니다");
    });

    it('한 라우트에 id류 세그먼트가 여럿이면 모두 fallback으로 채우고 이름을 모두 남긴다', () => {
      const result = routesFromChangedFiles(['web/app/u/[userId]/posts/[postId]/page.tsx'], 'web', {}, 5, '1');
      expect(result.routes).toEqual([{ path: '/u/1/posts/1', file: 'web/app/u/[userId]/posts/[postId]/page.tsx', usedFallbackParams: ['userId', 'postId'] }]);
    });
  });

  describe('isIdLikeSegment', () => {
    it('id 자신과 camelCase·snake_case·kebab-case의 id 접미사를 id로 본다', () => {
      for (const name of ['id', 'ID', 'orderId', 'userId', 'order_id', 'order-id']) expect(isIdLikeSegment(name)).toBe(true);
    });

    it('우연히 id로 끝나는 낱말이나 관계없는 이름은 id로 보지 않는다', () => {
      for (const name of ['grid', 'slug', 'category', 'locale', 'valid']) expect(isIdLikeSegment(name)).toBe(false);
    });
  });
});

describe('routesFromCandidates', () => {
  const candidate = (page: string, cause: string, distance: number, tie = 0) => ({ page, cause, distance, tie });

  it('바뀐 page(거리 0), 직접 import하는 page(거리 1), 먼 page 순으로 maxPages까지 고르고 나머지는 원인별로 묶어 남긴다', () => {
    const result = routesFromCandidates(
      [
        candidate('app/c/page.tsx', 'lib/util.ts', 3),
        candidate('app/b/page.tsx', 'lib/util.ts', 1),
        candidate('app/a/page.tsx', 'lib/util.ts', 2),
        candidate('app/d/page.tsx', 'lib/util.ts', 3),
        candidate('app/own/page.tsx', 'app/own/page.tsx', 0),
      ],
      'web',
      {},
      3,
    );

    expect(result.routes).toEqual([
      { path: '/own', file: 'web/app/own/page.tsx' },
      { path: '/b', file: 'web/app/b/page.tsx', cause: 'web/lib/util.ts', distance: 1 },
      { path: '/a', file: 'web/app/a/page.tsx', cause: 'web/lib/util.ts', distance: 2 },
    ]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.file).toBe('web/lib/util.ts');
    expect(result.skipped[0]!.reason).toContain('페이지 2개');
    expect(result.skipped[0]!.reason).toContain('/c, /d');
    expect(result.skipped[0]!.reason).toContain('상한(3개)');
  });

  it('같은 경로는 가장 가까운 후보 하나만 쓰고, 동적 세그먼트는 기존 규칙(id 추정)으로 채운다', () => {
    const result = routesFromCandidates(
      [candidate('app/live/[id]/page.tsx', 'lib/b.ts', 2), candidate('app/live/[id]/page.tsx', 'components/A.tsx', 1), candidate('app/tags/[slug]/page.tsx', 'components/A.tsx', 1)],
      'apps/web',
      {},
      5,
      '1',
    );

    expect(result.routes).toEqual([{ path: '/live/1', file: 'apps/web/app/live/[id]/page.tsx', cause: 'apps/web/components/A.tsx', distance: 1, usedFallbackParams: ['id'] }]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("동적 세그먼트 'slug'의 값이 없습니다");
    expect(result.skipped[0]!.reason).toContain('components/A.tsx 변경으로 찾은 페이지');
  });

  it('거리 0 후보가 상한을 넘으면 기존처럼 페이지마다 한 줄로 남긴다', () => {
    const result = routesFromCandidates([candidate('app/a/page.tsx', 'app/a/page.tsx', 0), candidate('app/b/page.tsx', 'app/b/page.tsx', 0)], 'web', {}, 1);
    expect(result.routes.map((route) => route.path)).toEqual(['/a']);
    expect(result.skipped).toEqual([{ file: 'web/app/b/page.tsx', reason: '한 번에 열어 보는 페이지 상한(1개)을 넘었습니다 — autoPageChecks.maxPages를 늘리세요' }]);
  });
});
