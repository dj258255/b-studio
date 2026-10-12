import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser-check';
import { trackPendingRequests } from './pending-requests';

/**
 * 떠 있는 요청을 세어 기다리는 도우미(#684). 실제 브라우저와 로컬 서버를 쓴다.
 * /slow 0.5초 뒤 응답 · /chain 응답을 받으면 이어서 /slow를 보낸다 · /never 응답하지 않는다
 * /slow-body 머리는 바로, 본문은 0.8초 뒤에 끝난다
 * /events 머리만 보내고 본문을 끝내지 않는 이벤트 스트림 · /slow-events 그 머리를 0.5초 뒤에 보낸다
 */
const PAGE = `<html><body>
  <button id="slow" onclick="fetch('/slow',{method:'POST'})">늦음</button>
  <button id="chain" onclick="fetch('/quick',{method:'POST'}).then(function(){ return fetch('/slow',{method:'POST'}); })">이어짐</button>
  <button id="never" onclick="fetch('/never',{method:'POST'})">안 끝남</button>
  <button id="none" onclick="document.title='눌림'">요청 없음</button>
  <button id="slow-body" onclick="fetch('/slow-body',{method:'POST'}).then(function(r){ return r.text(); }).then(function(){ return fetch('/slow',{method:'POST'}); })">본문이 늦음</button>
  <button id="events" onclick="window.es = new EventSource('/events')">스트림</button>
  <button id="slow-events" onclick="window.es = new EventSource('/slow-events')">늦은 스트림</button>
  <button id="spa" onclick="fetch('/slow',{method:'POST'}); history.pushState({}, '', '/next'); location.hash = 'done'">화면 전환</button>
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
    if (path === '/slow-body') {
      // 머리는 바로, 본문은 0.8초 뒤에 끝난다
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('시작');
      setTimeout(() => response.end('끝'), 800);
      return;
    }
    if (path === '/events' || path === '/slow-events') {
      // 머리를 보낸 뒤 본문을 끝내지 않는다. 늦은 쪽은 머리를 0.5초 뒤에 보낸다
      setTimeout(
        () => {
          answered.push(path);
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          response.write('data: hello\n\n');
        },
        path === '/slow-events' ? 500 : 0,
      );
      return;
    }
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

  it('보통 요청은 본문이 끝날 때까지 떠 있는 것으로 센다 — 본문을 다 받은 뒤에 이어 보내는 요청을 놓치지 않는다', async () => {
    // 머리는 바로 오고 본문이 0.8초 걸린다. 머리만 보고 끝난 것으로 치면 잠잠한 시간(0.1초)이 지나 기다림이 끝나고,
    // 본문을 다 읽은 뒤에 나가는 다음 요청을 보지 못한다
    const pending = await open();
    await page.click('#slow-body');
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

  it('같은 문서 안의 이동(주소만 바뀜)은 떠 있는 요청을 버리지 않는다', async () => {
    // 한 화면 앱의 라우팅은 문서를 바꾸지 않고 주소만 바꾼다. 그때 보낸 요청은 계속 살아 있다.
    // 이것을 문서 이동으로 보고 지우면 응답 전에 기다림이 끝난다(화면이 주소를 바꿔 실패를 숨길 수 있다)
    const pending = await open();
    await page.click('#spa');
    await page.waitForTimeout(50);
    expect(page.url()).toBe(`${base}/next#done`);
    expect(pending.size).toBe(1);
    await pending.waitForIdle(idle);
    expect(answered).toEqual(['/slow']);
    await page.close();
  });

  it('문서가 바뀌어도 앞 문서가 보내 둔 요청을 지우지 않는다 — 가를 수 없으면 기다리는 쪽을 고른다', async () => {
    const pending = await open();
    await page.click('#never');
    await page.waitForTimeout(100);
    expect(pending.size).toBe(1);
    await page.goto(`${base}/page`, { waitUntil: 'load' });
    // 브라우저는 앞 문서의 요청이 끝났다고 알려 주지 않는다. 같은 문서 안의 이동과 가를 신호가 없어 그대로 둔다
    const started = Date.now();
    await pending.waitForIdle({ ...idle, timeoutMs: 600 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(580);
    await page.close();
  });

  it('이벤트 스트림은 응답의 머리가 오면 끝난 것으로 본다(본문은 끝나지 않는다)', async () => {
    const pending = await open();
    await page.click('#events');
    const started = Date.now();
    await pending.waitForIdle(idle);
    // 상한(2초)까지 가지 않는다
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(pending.size).toBe(0);
    await page.close();
  });

  it('이벤트 스트림도 응답의 머리가 올 때까지는 기다린다', async () => {
    const pending = await open();
    await page.click('#slow-events');
    await page.waitForTimeout(100);
    expect(pending.size).toBe(1);
    await pending.waitForIdle(idle);
    expect(answered).toEqual(['/slow-events']);
    await page.close();
  });
});
