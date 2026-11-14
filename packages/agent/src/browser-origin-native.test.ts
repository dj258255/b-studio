import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInBrowser } from './browser-check';
import { runInBrowserNative } from './browser-check-native';

/**
 * `browser-check.test.ts`의 "출처 제한은 네트워크 층에서도 막는다 (#1210)" 시험을 옛 러너와 Rust 러너에 똑같이 돌린다(ADR-199).
 * 허용 밖 서버가 요청을 받았는지(TCP 접속까지)를 서버 쪽 기록으로 확인한다. Rust 러너는 단계(`steps`)를 아직 지원하지 않아
 * 완료 표시를 기다리지 않는다: 화면 글자는 네트워크가 잠잠해진 뒤에 읽는다(페이지 스크립트는 응답을 받는 대로 글자를 바꾼다).
 *
 * 시스템 Google Chrome으로도 돌리려면 `B_STUDIO_BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`를 준다.
 */

const RUNNERS = [
  { name: 'Playwright(runInBrowser)', run: runInBrowser },
  { name: 'Rust(runInBrowserNative)', run: runInBrowserNative },
];

// #1210: 라우트(page.route)는 리다이렉트로 이어진 요청과 서비스 워커의 요청을 보지 못한다. 허용 출처 밖 서버가 요청을 받았는지(접속 자체도)
// 서버 쪽 기록으로 확인한다. 브라우저가 낸 결과만 보면 "막혔다"와 "도달했지만 본문을 못 읽었다(CORS)"를 가를 수 없다
describe.each(RUNNERS)('출처 제한은 네트워크 층에서도 막는다 (#1210) — $name', { timeout: 60_000 }, ({ run }) => {
  interface Probe {
    server: Server;
    base: string;
    port: number;
    /** `METHOD /path` 기록 */
    requests: string[];
    /** TCP 접속 수(CONNECT 터널을 열기만 해도 센다) */
    connections: number;
    /** 웹소켓 업그레이드 요청 수 */
    upgrades: number;
  }
  let allowed: Probe;
  let outside: Probe;
  /** 같은 기계의 IPv6 loopback에 선 서버. IPv6가 없는 환경이면 undefined */
  let outside6: Probe | undefined;
  const sockets = new Set<Socket>();

  /** 서버가 클라이언트에 바로 글자 프레임 하나를 보내는 최소한의 웹소켓 */
  function acceptWebSocket(probe: Probe, request: IncomingMessage, socket: Socket) {
    probe.upgrades += 1;
    probe.requests.push(`UPGRADE ${request.url}`);
    const key = String(request.headers['sec-websocket-key']);
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const payload = Buffer.from('hello-from-server');
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  }

  async function startProbe(host: string, handler: (probe: Probe, request: IncomingMessage, response: import('node:http').ServerResponse) => void): Promise<Probe> {
    const probe = { requests: [], connections: 0, upgrades: 0 } as unknown as Probe;
    probe.server = createServer((request, response) => {
      probe.requests.push(`${request.method} ${request.url}`);
      handler(probe, request, response);
    });
    probe.server.on('connection', (socket) => {
      probe.connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    probe.server.on('upgrade', (request, socket) => acceptWebSocket(probe, request, socket as Socket));
    await new Promise<void>((resolve, reject) => {
      probe.server.once('error', reject);
      probe.server.listen(0, host, resolve);
    });
    probe.port = (probe.server.address() as AddressInfo).port;
    probe.base = `http://${host.includes(':') ? `[${host}]` : host}:${probe.port}`;
    return probe;
  }

  const reset = (...probes: (Probe | undefined)[]) => {
    for (const probe of probes) if (probe) Object.assign(probe, { requests: [], connections: 0, upgrades: 0 });
  };

  beforeAll(async () => {
    outside = await startProbe('127.0.0.1', (_probe, _request, response) => {
      response.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
      response.end('<h1>outside-secret</h1>');
    });
    outside6 = await startProbe('::1', (_probe, _request, response) => {
      response.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
      response.end('<h1>outside6-secret</h1>');
    }).catch(() => undefined);
    allowed = await startProbe('127.0.0.1', (_probe, request, response) => {
      const url = new URL(request.url ?? '/', 'http://x');
      const html = (body: string) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<html><body><div id="out">pending</div>${body}</body></html>`);
      };
      const done = (expr: string) => `document.getElementById('out').textContent = ${expr}; const d = document.createElement('i'); d.id = 'done'; d.textContent = '끝'; document.body.append(d);`;
      switch (url.pathname) {
        case '/redir':
          response.writeHead(302, { location: url.searchParams.get('to') ?? '/' });
          response.end();
          return;
        case '/page':
          return html('<h1 id="title">평범한 화면</h1><script>fetch(\'/data.json\').then((r) => r.json()).then((d) => { document.title = d.value; })</script>');
        case '/data.json':
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"value":"ok"}');
          return;
        case '/r-fetch':
          return html(`<script>fetch('/redir?to=' + encodeURIComponent('${outside.base}/redirected')).then((r) => r.text()).then((t) => { ${done("'body:' + t")} }).catch((e) => { ${done("'err:' + e")} });</script>`);
        case '/r-https':
          // 막힌 CONNECT(https)는 URL을 알 수 없다. 그래도 앱의 실패가 아니라 막은 것으로 센다
          return html(`<script>fetch('/redir?to=' + encodeURIComponent('https://127.0.0.1:${outside.port}/tls')).then(() => { ${done("'reached'")} }).catch((e) => { ${done("'err'")} });</script>`);
        case '/r-img':
          return html(`<img src="/redir?to=${encodeURIComponent(`${outside.base}/pixel.png`)}"><script>setTimeout(() => { ${done("'img'")} }, 800);</script>`);
        case '/r-frame':
          return html(`<iframe src="/redir?to=${encodeURIComponent(`${outside.base}/frame`)}"></iframe><script>setTimeout(() => { ${done("'frame'")} }, 800);</script>`);
        case '/r-worker':
          return html(`<script>const w = new Worker('/worker.js'); w.onmessage = (e) => { ${done("e.data")} };</script>`);
        case '/worker.js':
          response.writeHead(200, { 'content-type': 'text/javascript' });
          response.end(`fetch('/redir?to=' + encodeURIComponent('${outside.base}/from-worker')).then((r) => postMessage('worker-got:' + r.status)).catch((e) => postMessage('worker-err'));`);
          return;
        case '/sw-bypass':
          // serviceWorkers: 'block'은 navigator.serviceWorker.register만 바꿔치므로 prototype으로 부르면 등록된다
          return html(
            `<script>ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, '/sw-probe.js').then(() => navigator.serviceWorker.ready).then(() => new Promise((resolve) => { const t = setInterval(() => { if (navigator.serviceWorker.controller) { clearInterval(t); resolve(); } }, 50); })).then(() => fetch('/swprobe')).then((r) => r.text()).then((t) => { ${done("'sw:' + t")} }).catch((e) => { ${done("'sw-err:' + e")} });</script>`,
          );
        case '/sw-hide':
          // 서비스 워커 스크립트로 막힌 허용 출처 주소가 그 주소의 진짜 요청 실패를 가리면 안 된다
          return html(
            `<script>ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, '/api-fail').catch(() => {}).then(() => fetch('/api-fail')).then((r) => { ${done("'status:' + r.status")} }).catch((e) => { ${done("'err:' + e")} });</script>`,
          );
        case '/method-hide':
          // 낯선 메서드라 프록시가 막은 허용 출처 주소가 그 주소의 진짜 요청 실패를 가리면 안 된다
          return html(
            `<script>fetch('/api-fail', { method: 'PROPFIND' }).catch(() => {}).then(() => fetch('/api-fail')).then((r) => { ${done("'status:' + r.status")} }).catch((e) => { ${done("'err:' + e")} });</script>`,
          );
        case '/api-fail':
          response.writeHead(500, { 'content-type': 'text/plain' });
          response.end('boom');
          return;
        case '/sw-probe.js':
          response.writeHead(200, { 'content-type': 'text/javascript' });
          response.end(
            `self.addEventListener('install', (e) => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(clients.claim())); self.addEventListener('fetch', (e) => { if (e.request.url.includes('swprobe')) e.respondWith(fetch('${outside.base}/from-sw').then((r) => new Response('reached:' + r.status)).catch(() => new Response('blocked'))); });`,
          );
          return;
        case '/ws-allowed':
          return html(`<script>const w = new WebSocket('ws://' + location.host + '/socket'); w.onmessage = (e) => { ${done("'ws:' + e.data")} }; w.onerror = () => { ${done("'ws-error'")} };</script>`);
        case '/ws-outside':
          return html(`<script>const w = new WebSocket('ws://127.0.0.1:${outside.port}/socket'); w.onmessage = (e) => { ${done("'ws:' + e.data")} }; w.onerror = () => { ${done("'ws-error'")} };</script>`);
        case '/wss-outside':
          return html(`<script>const w = new WebSocket('wss://127.0.0.1:${outside.port}/socket'); w.onmessage = (e) => { ${done("'ws:' + e.data")} }; w.onerror = () => { ${done("'ws-error'")} };</script>`);
        default:
          response.writeHead(404, { 'content-type': 'text/plain' });
          response.end('not found');
      }
    });
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([allowed, outside, outside6].map((probe) => probe && new Promise<void>((resolve) => probe.server.close(() => resolve()))));
  });

  /** 본문 첫 줄(완료 표시 '끝'은 둘째 줄) */
  const firstLine = (text: string) => text.split('\n')[0];

  it('허용 출처가 허용 밖으로 리다이렉트한 fetch는 허용 밖 서버에 닿지 않는다', async () => {
    reset(outside);
    const result = await run(`${allowed.base}/r-fetch`, { allowedOrigins: [allowed.base] });
    expect(firstLine(result.text)).toMatch(/^err:/);
    expect(result.text).not.toContain('outside-secret');
    expect(outside.requests).toEqual([]);
    expect(outside.connections).toBe(0);
    expect(result.blockedRequests).toEqual([`${outside.base}/redirected`]);
    expect(result.failedRequests).toEqual([]);
  });

  it('리다이렉트로 이어진 https(CONNECT)도 막고, 앱의 실패가 아니라 막은 것으로 센다', async () => {
    reset(outside);
    const result = await run(`${allowed.base}/r-https`, { allowedOrigins: [allowed.base] });
    expect(firstLine(result.text)).toBe('err');
    expect(outside.connections).toBe(0);
    expect(result.blockedRequests).toEqual([`CONNECT 127.0.0.1:${outside.port}`]);
    expect(result.failedRequests).toEqual([]);
  });

  it('리다이렉트로 이어진 이미지도 막는다', async () => {
    reset(outside);
    const result = await run(`${allowed.base}/r-img`, { allowedOrigins: [allowed.base] });
    expect(outside.requests).toEqual([]);
    expect(outside.connections).toBe(0);
    expect(result.blockedRequests).toEqual([`${outside.base}/pixel.png`]);
  });

  it('리다이렉트로 이어진 iframe 이동도 막는다', async () => {
    reset(outside);
    const result = await run(`${allowed.base}/r-frame`, { allowedOrigins: [allowed.base] });
    expect(outside.requests).toEqual([]);
    expect(outside.connections).toBe(0);
    expect(result.blockedRequests).toContain(`${outside.base}/frame`);
  });

  it('문서 이동이 허용 밖으로 리다이렉트되면 통과하지 않고 실패한다 (화면 글자도 새지 않는다)', async () => {
    reset(outside);
    await expect(run(`${allowed.base}/redir?to=${encodeURIComponent(`${outside.base}/secret`)}`, { allowedOrigins: [allowed.base] })).rejects.toThrow(/net::ERR_/);
    expect(outside.requests).toEqual([]);
    expect(outside.connections).toBe(0);
  });

  it('전용 워커의 리다이렉트된 fetch도 막는다', async () => {
    reset(outside);
    const result = await run(`${allowed.base}/r-worker`, { allowedOrigins: [allowed.base] });
    expect(firstLine(result.text)).toBe('worker-err');
    expect(outside.requests).toEqual([]);
    expect(result.blockedRequests).toEqual([`${outside.base}/from-worker`]);
  });

  it('prototype으로 우회한 서비스 워커 등록은 스크립트를 받지 못해 설치되지 않고, 허용 밖 서버에도 닿지 않는다', async () => {
    reset(outside);
    reset(allowed);
    const result = await run(`${allowed.base}/sw-bypass`, { allowedOrigins: [allowed.base] });
    expect(firstLine(result.text)).toMatch(/^sw-err:/);
    // 서비스 워커 스크립트 요청은 프록시가 허용 출처 서버에 보내지 않는다
    expect(allowed.requests.some((entry) => entry.includes('/sw-probe.js'))).toBe(false);
    expect(outside.requests).toEqual([]);
    expect(outside.connections).toBe(0);
    expect(result.blockedRequests).toContain(`SERVICE-WORKER ${allowed.base}/sw-probe.js`);
  });

  it('서비스 워커 스크립트로 막은 허용 출처 주소는 그 주소의 실패 기록을 지우지 않고, 막은 기록에 따로 남는다', async () => {
    reset(allowed);
    const result = await run(`${allowed.base}/sw-hide`, { allowedOrigins: [allowed.base] });
    expect(firstLine(result.text)).toBe('status:500');
    expect(result.failedRequests).toContain(`500 ${allowed.base}/api-fail`);
    expect(result.blockedRequests).toContain(`SERVICE-WORKER ${allowed.base}/api-fail`);
  });

  it('낯선 메서드라 막은 허용 출처 주소도 그 주소의 실패를 가리지 않는다 (막은 요청 자체가 실패로 남는다)', async () => {
    reset(allowed);
    const result = await run(`${allowed.base}/method-hide`, { allowedOrigins: [allowed.base] });
    expect(firstLine(result.text)).toBe('status:500');
    expect(result.failedRequests.some((entry) => entry.endsWith(`${allowed.base}/api-fail`))).toBe(true);
    expect(result.blockedRequests).toContain(`${allowed.base}/api-fail`);
  });

  it('허용 출처의 웹소켓은 동작한다 (개발 서버의 HMR 연결)', async () => {
    reset(allowed);
    const result = await run(`${allowed.base}/ws-allowed`, { allowedOrigins: [allowed.base] });
    expect(firstLine(result.text)).toBe('ws:hello-from-server');
    expect(allowed.upgrades).toBe(1);
    expect(result.blockedRequests).toEqual([]);
    expect(result.consoleErrors).toEqual([]);
    expect(result.failedRequests).toEqual([]);
  });

  it('허용 밖 웹소켓(ws·wss)은 막고 서버에 접속하지 않는다', async () => {
    for (const path of ['/ws-outside', '/wss-outside']) {
      reset(outside);
      const result = await run(`${allowed.base}${path}`, { allowedOrigins: [allowed.base] });
      expect(firstLine(result.text), path).toBe('ws-error');
      expect(outside.upgrades, path).toBe(0);
      expect(outside.connections, path).toBe(0);
      expect(result.blockedRequests, path).toHaveLength(1);
      expect(result.blockedRequests[0], path).toContain(`127.0.0.1:${outside.port}`);
    }
  });

  it('같은 기계의 다른 이름(localhost, [::1])으로 리다이렉트해도 허용 출처가 아니면 막는다', async () => {
    reset(allowed, outside6);
    const byName = `http://localhost:${allowed.port}/by-name`;
    const by6 = outside6 ? `${outside6.base}/by-ipv6` : `http://[::1]:${allowed.port}/by-ipv6`;
    for (const target of [byName, by6]) {
      // 문서 이동이 막히면 오류로 끝난다(결과를 돌려주면 통과로 보인다)
      await expect(run(`${allowed.base}/redir?to=${encodeURIComponent(target)}`, { allowedOrigins: [allowed.base] }), target).rejects.toThrow(/net::ERR_/);
    }
    expect(allowed.requests.some((entry) => entry.includes('/by-name'))).toBe(false);
    expect(outside6?.requests ?? []).toEqual([]);
    expect(outside6?.connections ?? 0).toBe(0);
  });

  it('평범한 화면의 결과는 그대로다', async () => {
    reset(outside);
    const result = await run(`${allowed.base}/page`, { allowedOrigins: [allowed.base] });
    expect(result.status).toBe(200);
    expect(result.text).toContain('평범한 화면');
    expect(result.blockedRequests).toEqual([]);
    expect(result.failedRequests).toEqual([]);
    expect(result.consoleErrors).toEqual([]);
    expect(result.pageErrors).toEqual([]);
  });
});

