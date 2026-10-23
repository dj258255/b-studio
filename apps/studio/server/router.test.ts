import { describe, expect, it } from 'vitest';
import { compileRoutes, matchRoute, routePathOf } from './router';

const load = () => Promise.resolve({});

describe('라우트 경로', () => {
  it('app 아래 route.ts 경로를 URL 패턴으로 바꾼다(묶음 폴더는 빼고)', () => {
    expect(routePathOf('api/health/route.ts')).toBe('/api/health');
    expect(routePathOf('api/sessions/[id]/route.ts')).toBe('/api/sessions/[id]');
    expect(routePathOf('(admin)/api/x/route.ts')).toBe('/api/x');
    expect(routePathOf('local-auth/route.ts')).toBe('/local-auth');
  });
});

describe('라우트 맞추기', () => {
  const routes = compileRoutes([
    { pattern: '/api/sessions/[id]', load },
    { pattern: '/api/sessions/new', load },
    { pattern: '/api/sessions/[id]/artifacts/[...path]', load },
    { pattern: '/api/docs/[[...slug]]', load },
    { pattern: '/api/health', load },
  ]);

  it('고정 경로는 그대로 맞춘다', () => {
    expect(matchRoute(routes, '/api/health')?.route.pattern).toBe('/api/health');
    expect(matchRoute(routes, '/api/health/')?.route.pattern).toBe('/api/health');
  });

  it('고정 세그먼트가 동적 세그먼트보다 먼저다', () => {
    expect(matchRoute(routes, '/api/sessions/new')?.route.pattern).toBe('/api/sessions/new');
    const hit = matchRoute(routes, '/api/sessions/s-1');
    expect(hit?.route.pattern).toBe('/api/sessions/[id]');
    expect(hit?.params).toEqual({ id: 's-1' });
  });

  it('세그먼트 값은 퍼센트 인코딩을 풀어 넘긴다', () => {
    expect(matchRoute(routes, '/api/sessions/%ED%95%9C%EA%B8%80')?.params).toEqual({ id: '한글' });
  });

  it('잘못된 퍼센트 인코딩은 맞추지 않는다', () => {
    expect(matchRoute(routes, '/api/sessions/%E0%A4%A')).toBeUndefined();
  });

  it('나머지 세그먼트([...path])는 하나 이상을 배열로 받는다', () => {
    expect(matchRoute(routes, '/api/sessions/s/artifacts/a/b.png')?.params).toEqual({ id: 's', path: ['a', 'b.png'] });
    expect(matchRoute(routes, '/api/sessions/s/artifacts')).toBeUndefined();
  });

  it('선택 나머지 세그먼트([[...slug]])는 없어도 맞춘다', () => {
    expect(matchRoute(routes, '/api/docs')?.params).toEqual({});
    expect(matchRoute(routes, '/api/docs/a/b')?.params).toEqual({ slug: ['a', 'b'] });
  });

  it('없는 경로는 맞추지 않는다', () => {
    expect(matchRoute(routes, '/api/nope')).toBeUndefined();
    expect(matchRoute(routes, '/api/sessions/s/x')).toBeUndefined();
  });
});
