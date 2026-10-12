import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser-check';
import { trackPendingRequests } from './pending-requests';

/**
 * 떠 있는 요청을 세어 기다리는 도우미(#684). 실제 브라우저와 로컬 서버를 쓴다.
 * /slow 0.5초 뒤 응답 · /chain 응답을 받으면 이어서 /slow를 보낸다 · /never 응답하지 않는다
 */
const PAGE = `<html><body>
  <button id="slow" onclick="fetch('/slow',{method:'POST'})">늦음</button>
  <button id="chain" onclick="fetch('/quick',{method:'POST'}).then(function(){ return fetch('/slow',{method:'POST'}); })">이어짐</button>
  <button id="never" onclick="fetch('/never',{method:'POST'})">안 끝남</button>
  <button id="none" onclick="document.title='눌림'">요청 없음</button>
</body></html>`;

let server: Server;
let base = '';
let browser: Browser;
let page: Page;
const answered: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? '';
    if (path === '/never') return;
    if (path === '/slow') {
      setTimeout(() => {
        answered.push(path);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      }, 500);
      return;
    }
    response.writeHead(200, { 'content-type': path === '/quick' ? 'application/json' : 'text/html; charset=utf-8' });
    response.end(path === '/quick' ? '{}' : PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function open() {
  page = await browser.newPage();
  const pending = trackPendingRequests(page);
  await page.goto(`${base}/page`, { waitUntil: 'load' });
  // 문서가 "네트워크 잠잠" 상태에 든 뒤에 시험한다. 그 상태만 기다리던 코드가 틀리던 조건이다
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(200);
  answered.length = 0;
  return pending;
}

const idle = { graceMs: 100, quietMs: 100, timeoutMs: 2_000 };

describe('떠 있는 요청을 세어 기다린다', { timeout: 60_000 }, () => {
  it('문서가 이미 잠잠했던 뒤에 보낸 요청도 응답이 올 때까지 기다린다', async () => {
    const pending = await open();
    await page.click('#slow');
    // 문서의 상태만 보면 바로 통과한다(이미 잠잠 상태에 들었다). 그래서 응답 전에 판정이 내려졌다
    await page.waitForLoadState('networkidle', { timeout: 2_000 });
    expect(answered).toEqual([]);

    await pending.waitForIdle(idle);
    expect(answered).toEqual(['/slow']);
    expect(pending.size).toBe(0);
    await page.close();
  });

  it('응답을 받고 이어서 보낸 요청까지 기다린다', async () => {
    const pending = await open();
    await page.click('#chain');
    await pending.waitForIdle(idle);
    expect(answered).toEqual(['/slow']);
    await page.close();
  });

  it('요청이 없으면 정해 둔 최소 시간만 기다린다', async () => {
    const pending = await open();
    await page.click('#none');
    const started = Date.now();
    await pending.waitForIdle(idle);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(1_000);
    await page.close();
  });

  it('끝나지 않는 요청이 있어도 상한에서 멈춘다', async () => {
    const pending = await open();
    await page.click('#never');
    const started = Date.now();
    await pending.waitForIdle({ ...idle, timeoutMs: 600 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(580);
    expect(elapsed).toBeLessThan(1_500);
    expect(pending.size).toBe(1);
    await page.close();
  });

  it('문서가 바뀌면 앞 문서가 보내 둔 요청은 세지 않는다', async () => {
    const pending = await open();
    await page.click('#never');
    await page.waitForTimeout(100);
    expect(pending.size).toBe(1);
    await page.goto(`${base}/page`, { waitUntil: 'load' });
    const started = Date.now();
    await pending.waitForIdle(idle);
    // 앞 문서의 끝나지 않는 요청 때문에 상한(2초)까지 가지 않는다
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pending.size).toBe(0);
    await page.close();
  });
});
