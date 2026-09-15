import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInBrowser } from './browser-check';

// 실제 헤드리스 Chromium을 띄운다. 브라우저가 없으면 건너뛰지 않고 실패한다. 건너뛰면 검사 안 함이 통과처럼 보인다
const PAGES: Record<string, string> = {
  '/ok': `<html><body><h1 id="title"></h1><script>document.getElementById('title').textContent = '주문 목록'</script></body></html>`,
  '/broken': `<html><body><p>로딩</p><script>console.error('hydration failed'); window.missing.call()</script></body></html>`,
  '/missing-chunk': `<html><body><p>표</p><script src="/chunk.js"></script></body></html>`,
  '/wide': `<html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0"><div style="width:900px">표</div></body></html>`,
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const body = PAGES[request.url ?? ''];
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('runInBrowser', { timeout: 60_000 }, () => {
  it('클라이언트 스크립트가 만든 텍스트를 렌더링 뒤에 읽는다 (HTTP 본문에는 없는 문구)', async () => {
    const result = await runInBrowser(`${base}/ok`, {});
    // 서버에 favicon이 없어 브라우저가 스스로 연 /favicon.ico는 404지만 실패로 세지 않는다
    expect(result).toMatchObject({ status: 200, pageErrors: [], consoleErrors: [], failedRequests: [], horizontalOverflowPx: 0 });
    expect(result.text).toContain('주문 목록');
  });

  it('스크립트 예외와 console.error를 모은다', async () => {
    const result = await runInBrowser(`${base}/broken`, {});
    expect(result.status).toBe(200);
    expect(result.pageErrors.join()).toMatch(/Cannot read properties of undefined/);
    expect(result.consoleErrors).toContain('hydration failed');
  });

  it('페이지가 부른 리소스가 404면 URL과 함께 실패한 요청으로 남긴다', async () => {
    const result = await runInBrowser(`${base}/missing-chunk`, {});
    expect(result.failedRequests).toEqual([`404 ${base}/chunk.js`]);
    expect(result.consoleErrors).toEqual([]);
  });

  it('모바일 창 크기에서 가로 넘침을 잰다', async () => {
    const mobile = await runInBrowser(`${base}/wide`, { viewport: { width: 390, height: 844 } });
    expect(mobile.horizontalOverflowPx).toBe(900 - 390);
    const desktop = await runInBrowser(`${base}/wide`, { viewport: { width: 1280, height: 800 } });
    expect(desktop.horizontalOverflowPx).toBe(0);
  });
});
