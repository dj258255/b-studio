import { describe, expect, it } from 'vitest';
import { runAcceptance, type AcceptanceFetcher } from './acceptance';
import type { AcceptanceCheck } from './tasks';

const urls = { api: 'http://127.0.0.1:8080', web: 'http://127.0.0.1:3000' };

function fetcherFor(routes: Record<string, { status?: number; body: string }>): AcceptanceFetcher {
  return async (url) => {
    const route = routes[url.pathname];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(route.body, { status: route.status ?? 200, headers: { 'content-type': 'text/html' } });
  };
}

describe('runAcceptance', () => {
  it('상태 200이고 기대 문구가 모두 있으면 통과한다', async () => {
    const checks: AcceptanceCheck[] = [{ service: 'web', path: '/orders', expectAll: ['김민수', '이영희'] }];
    const results = await runAcceptance(checks, urls, fetcherFor({ '/orders': { body: '<table><td>김민수</td><td>이영희</td></table>' } }));

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, status: 200 });
    // detail에는 태그를 걷어낸 본문 앞부분이 들어간다
    expect(results[0]!.detail).toContain('김민수 이영희');
  });

  it('상태가 200이 아니면 실패한다', async () => {
    const checks: AcceptanceCheck[] = [{ service: 'api', path: '/api/orders', expectAll: ['김민수'] }];
    const results = await runAcceptance(checks, urls, fetcherFor({ '/api/orders': { status: 500, body: 'boom' } }));

    expect(results[0]).toMatchObject({ ok: false, status: 500 });
    expect(results[0]!.detail).toContain('상태 500');
  });

  it('기대 문구가 빠지면 실패하고 이유를 남긴다', async () => {
    const checks: AcceptanceCheck[] = [{ service: 'web', path: '/orders', expectAll: ['김민수', '박철수'] }];
    const results = await runAcceptance(checks, urls, fetcherFor({ '/orders': { body: '김민수' } }));

    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toContain('문구 누락: 박철수');
  });

  it('expectAny는 하나라도 있으면 통과한다', async () => {
    const pass = await runAcceptance([{ service: 'web', path: '/dashboard', expectAny: ['45000', '45,000'] }], urls, fetcherFor({ '/dashboard': { body: '총매출 45,000원' } }));
    expect(pass[0]!.ok).toBe(true);

    const fail = await runAcceptance([{ service: 'web', path: '/dashboard', expectAny: ['45000', '45,000'] }], urls, fetcherFor({ '/dashboard': { body: '총매출 0원' } }));
    expect(fail[0]!.ok).toBe(false);
    expect(fail[0]!.detail).toContain('기대 문구 없음');
  });

  it('서비스 URL이 없으면 실패한다', async () => {
    const results = await runAcceptance([{ service: 'api', path: '/api/orders' }], { api: undefined, web: 'http://127.0.0.1:3000' });
    expect(results[0]).toMatchObject({ ok: false, detail: '서비스 URL 없음' });
  });

  it('요청이 실패하면 실패로 남긴다', async () => {
    const failing: AcceptanceFetcher = async () => {
      throw new Error('connection refused');
    };
    const results = await runAcceptance([{ service: 'web', path: '/orders' }], urls, failing);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toContain('요청 실패');
  });
});
