import { createServer, request as httpRequest, type Server } from 'node:http';
import { createSocket } from 'node:dgram';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isAllowedRequest, launchBrowser } from './browser-check';
import { startOriginProxy, type OriginProxy, type OriginProxyBlock } from './origin-proxy';

// 프록시를 날것의 소켓으로 직접 두드린다. 브라우저가 보내지 않는 모양(Host 불일치, origin-form, Upgrade)도 막는지 본다.
// 허용 밖 서버가 "요청을 받았는지"는 서버 쪽 기록으로 확인한다
let allowedServer: Server;
let outsideServer: Server;
let allowedPort = 0;
let outsidePort = 0;
const allowedLog: string[] = [];
const outsideLog: string[] = [];
let outsideConnections = 0;
const sockets = new Set<Socket>();

const track = (server: Server, log: string[], counter?: () => void) => {
  server.on('connection', (socket) => {
    counter?.();
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('request', (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      log.push(`${request.method} ${request.url} host=${request.headers.host} proxy-connection=${request.headers['proxy-connection'] ?? '-'} body=${Buffer.concat(chunks).toString()}`);
      response.writeHead(request.url === '/redirect-out' ? 302 : 200, { 'content-type': 'text/plain', ...(request.url === '/redirect-out' ? { location: `http://127.0.0.1:${outsidePort}/leak` } : {}), 'x-up': '1' });
      response.end(`from:${request.url}`);
    });
  });
};

beforeAll(async () => {
  allowedServer = createServer();
  outsideServer = createServer();
  track(allowedServer, allowedLog);
  track(outsideServer, outsideLog, () => (outsideConnections += 1));
  await Promise.all(
    [allowedServer, outsideServer].map((server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))),
  );
  allowedPort = (allowedServer.address() as AddressInfo).port;
  outsidePort = (outsideServer.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([allowedServer, outsideServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function withProxy<T>(run: (proxy: OriginProxy, blocks: OriginProxyBlock[]) => Promise<T>): Promise<T> {
  const blocks: OriginProxyBlock[] = [];
  const allowed = new Set([`http://127.0.0.1:${allowedPort}`]);
  const proxy = await startOriginProxy({ isAllowed: (url) => isAllowedRequest(url, allowed), onBlocked: (block) => blocks.push(block) });
  try {
    return await run(proxy, blocks);
  } finally {
    await proxy.close();
  }
}

/** 프록시에 날것의 요청을 보내고 돌아온 바이트와 연결이 끊겼는지를 돌려준다 */
function raw(proxy: OriginProxy, payload: string): Promise<{ response: string; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: Number(new URL(proxy.server).port) });
    let response = '';
    socket.on('data', (chunk: Buffer) => (response += chunk.toString('latin1')));
    socket.on('error', () => {});
    socket.on('close', () => resolve({ response, closed: true }));
    socket.write(payload);
    setTimeout(() => {
      socket.destroy();
    }, 1500);
  });
}

describe('startOriginProxy (#1210)', { timeout: 30_000 }, () => {
  it('허용 출처의 절대 형식 요청은 메서드·머리·본문 그대로 전달하고 Proxy-Connection은 뺀다', async () => {
    allowedLog.length = 0;
    await withProxy(async (proxy, blocks) => {
      const response = await new Promise<{ status: number; body: string; up: string | undefined }>((resolve, reject) => {
        const request = httpRequest({ host: '127.0.0.1', port: Number(new URL(proxy.server).port), method: 'POST', path: `http://127.0.0.1:${allowedPort}/a?x=1`, headers: { host: `127.0.0.1:${allowedPort}`, 'proxy-connection': 'keep-alive', 'content-type': 'text/plain' } }, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, up: res.headers['x-up'] as string | undefined }));
        });
        request.on('error', reject);
        request.end('payload');
      });
      expect(response).toEqual({ status: 200, body: 'from:/a?x=1', up: '1' });
      expect(blocks).toEqual([]);
    });
    expect(allowedLog).toEqual([`POST /a?x=1 host=127.0.0.1:${allowedPort} proxy-connection=- body=payload`]);
  });

  it('허용 출처의 리다이렉트 응답은 따라가지 않고 그대로 돌려준다 (따라가는 것은 브라우저이고 다음 홉도 이 프록시를 지난다)', async () => {
    outsideConnections = 0;
    outsideLog.length = 0;
    await withProxy(async (proxy) => {
      const { response } = await raw(proxy, `GET http://127.0.0.1:${allowedPort}/redirect-out HTTP/1.1\r\nHost: 127.0.0.1:${allowedPort}\r\nConnection: close\r\n\r\n`);
      expect(response).toMatch(/^HTTP\/1\.1 302 /);
      expect(response).toContain(`location: http://127.0.0.1:${outsidePort}/leak`);
    });
    expect(outsideConnections).toBe(0);
  });

  it('허용 밖 절대 형식 요청은 업스트림에 접속하지 않고 응답 없이 연결을 끊는다. 막은 URL을 알린다', async () => {
    outsideConnections = 0;
    outsideLog.length = 0;
    await withProxy(async (proxy, blocks) => {
      const url = `http://127.0.0.1:${outsidePort}/secret`;
      const result = await raw(proxy, `GET ${url} HTTP/1.1\r\nHost: 127.0.0.1:${outsidePort}\r\n\r\n`);
      expect(result).toEqual({ response: '', closed: true });
      expect(blocks).toEqual([{ kind: 'url', url }]);
    });
    expect(outsideConnections).toBe(0);
    expect(outsideLog).toEqual([]);
  });

  it('같은 기계의 다른 이름(localhost, [::1], 0.0.0.0)은 허용 출처와 포트가 같아도 막는다', async () => {
    allowedLog.length = 0;
    await withProxy(async (proxy, blocks) => {
      for (const host of [`localhost:${allowedPort}`, `[::1]:${allowedPort}`, `0.0.0.0:${allowedPort}`, `127.0.0.2:${allowedPort}`]) {
        const result = await raw(proxy, `GET http://${host}/x HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
        expect(result, host).toEqual({ response: '', closed: true });
      }
      expect(blocks.map((block) => (block.kind === 'tunnel' ? block.hostPort : block.url))).toEqual([
        `http://localhost:${allowedPort}/x`,
        `http://[::1]:${allowedPort}/x`,
        `http://0.0.0.0:${allowedPort}/x`,
        `http://127.0.0.2:${allowedPort}/x`,
      ]);
    });
    expect(allowedLog).toEqual([]);
  });

  it('절대 형식 URL과 Host 머리가 다르면 어느 쪽으로도 가지 않고 막는다', async () => {
    allowedLog.length = 0;
    outsideConnections = 0;
    await withProxy(async (proxy, blocks) => {
      // 허용 URL + 허용 밖 Host, 허용 밖 URL + 허용 Host, Host 없음, Host 둘
      const cases = [
        `GET http://127.0.0.1:${allowedPort}/x HTTP/1.1\r\nHost: 127.0.0.1:${outsidePort}\r\n\r\n`,
        `GET http://127.0.0.1:${outsidePort}/x HTTP/1.1\r\nHost: 127.0.0.1:${allowedPort}\r\n\r\n`,
        `GET http://127.0.0.1:${allowedPort}/x HTTP/1.1\r\n\r\n`,
        `GET http://127.0.0.1:${allowedPort}/x HTTP/1.1\r\nHost: 127.0.0.1:${allowedPort}\r\nHost: 127.0.0.1:${outsidePort}\r\n\r\n`,
      ];
      for (const payload of cases) {
        const result = await raw(proxy, payload);
        // Host가 없는 요청은 Node의 파서가 400으로 먼저 거절한다. 어느 쪽이든 업스트림에는 가지 않는다
        expect(result.response, payload).toMatch(/^(HTTP\/1\.1 400 [^]*)?$/);
      }
      expect(blocks).toHaveLength(cases.length - 1);
    });
    expect(allowedLog).toEqual([]);
    expect(outsideConnections).toBe(0);
  });

  it('모르는 모양(origin-form, 사용자 정보, https 절대 형식, 알 수 없는 메서드, Upgrade)은 막는다', async () => {
    allowedLog.length = 0;
    await withProxy(async (proxy, blocks) => {
      const host = `127.0.0.1:${allowedPort}`;
      const cases = [
        `GET /x HTTP/1.1\r\nHost: ${host}\r\n\r\n`,
        `GET http://user:pw@${host}/x HTTP/1.1\r\nHost: ${host}\r\n\r\n`,
        `GET https://${host}/x HTTP/1.1\r\nHost: ${host}\r\n\r\n`,
        `TRACE http://${host}/x HTTP/1.1\r\nHost: ${host}\r\n\r\n`,
        `GET http://${host}/ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        // Connection: Upgrade 없이 Upgrade 머리만 단 요청
        `GET http://${host}/x HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\n\r\n`,
        `GARBAGE\r\n\r\n`,
      ];
      for (const payload of cases) expect(await raw(proxy, payload), payload).toEqual({ response: '', closed: true });
      expect(blocks.length).toBeGreaterThanOrEqual(cases.length - 1);
    });
    expect(allowedLog).toEqual([]);
  });

  it('서비스 워커 스크립트 요청은 허용 출처라도 막는다 (Service-Worker 머리 또는 Sec-Fetch-Dest: serviceworker)', async () => {
    allowedLog.length = 0;
    await withProxy(async (proxy, blocks) => {
      const host = `127.0.0.1:${allowedPort}`;
      const cases = [
        `GET http://${host}/sw.js HTTP/1.1\r\nHost: ${host}\r\nService-Worker: script\r\n\r\n`,
        `GET http://${host}/sw.js HTTP/1.1\r\nHost: ${host}\r\nSec-Fetch-Dest: serviceworker\r\n\r\n`,
        `GET http://${host}/sw.js HTTP/1.1\r\nHost: ${host}\r\nSec-Fetch-Dest: ServiceWorker\r\n\r\n`,
      ];
      for (const payload of cases) expect(await raw(proxy, payload), payload).toEqual({ response: '', closed: true });
      expect(blocks).toEqual(cases.map(() => ({ kind: 'serviceWorker', url: `http://${host}/sw.js` })));
    });
    expect(allowedLog).toEqual([]);
  });

  it('허용 출처의 같은 host:port로만 CONNECT 터널을 연다', async () => {
    outsideConnections = 0;
    await withProxy(async (proxy, blocks) => {
      const outside = await raw(proxy, `CONNECT 127.0.0.1:${outsidePort} HTTP/1.1\r\nHost: 127.0.0.1:${outsidePort}\r\n\r\n`);
      expect(outside.response).toMatch(/^HTTP\/1\.1 403 /);
      for (const authority of [`localhost:${allowedPort}`, `[::1]:${allowedPort}`, `127.0.0.1:${allowedPort}@127.0.0.1:${outsidePort}`, `127.0.0.1`, `127.0.0.1:0`, `127.0.0.1:99999`, `127.0.0.1:${allowedPort}/x`]) {
        const result = await raw(proxy, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
        expect(result.response, authority).not.toMatch(/^HTTP\/1\.1 200/);
      }
      expect(blocks.length).toBe(8);
      expect(blocks[0]).toEqual({ kind: 'tunnel', hostPort: `127.0.0.1:${outsidePort}` });
    });
    expect(outsideConnections).toBe(0);

    allowedLog.length = 0;
    await withProxy(async (proxy, blocks) => {
      // 터널이 서면 그 안은 불투명한 바이트다. 터널 안에서 보낸 평문 요청이 허용 서버에 닿는지로 확인한다
      const tunneled = await new Promise<string>((resolve) => {
        const socket = connect({ host: '127.0.0.1', port: Number(new URL(proxy.server).port) });
        let data = '';
        socket.on('data', (chunk: Buffer) => {
          data += chunk.toString('latin1');
          if (data.includes('from:/inside')) socket.destroy();
        });
        socket.on('close', () => resolve(data));
        socket.write(`CONNECT 127.0.0.1:${allowedPort} HTTP/1.1\r\nHost: 127.0.0.1:${allowedPort}\r\n\r\nGET /inside HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        setTimeout(() => socket.destroy(), 3000);
      });
      expect(tunneled).toMatch(/^HTTP\/1\.1 200 Connection Established/);
      expect(tunneled).toContain('from:/inside');
      expect(blocks).toEqual([]);
    });
  });

  it('업스트림에 접속하지 못하면 502로 알린다 (통과로 바뀌지 않는다)', async () => {
    // 허용 출처로 선언했지만 아무도 듣지 않는 포트
    const closed = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const blocks: OriginProxyBlock[] = [];
    const allowed = new Set([`http://127.0.0.1:${closed}`]);
    const proxy = await startOriginProxy({ isAllowed: (url) => isAllowedRequest(url, allowed), onBlocked: (block) => blocks.push(block) });
    try {
      const result = await raw(proxy, `GET http://127.0.0.1:${closed}/x HTTP/1.1\r\nHost: 127.0.0.1:${closed}\r\nConnection: close\r\n\r\n`);
      expect(result.response).toMatch(/^HTTP\/1\.1 502 /);
      const tunnel = await raw(proxy, `CONNECT 127.0.0.1:${closed} HTTP/1.1\r\nHost: 127.0.0.1:${closed}\r\n\r\n`);
      expect(tunnel.response).toMatch(/^HTTP\/1\.1 502 /);
      expect(blocks).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it('close하면 포트가 닫히고, 터널처럼 일하는 중인 연결도 끊긴다', async () => {
    const proxy = await startOriginProxy({ isAllowed: (url) => isAllowedRequest(url, new Set([`http://127.0.0.1:${allowedPort}`])), onBlocked: () => {} });
    const port = Number(new URL(proxy.server).port);
    const open = connect({ host: '127.0.0.1', port });
    open.on('error', () => {});
    let received = '';
    open.on('data', (chunk: Buffer) => (received += chunk.toString('latin1')));
    open.write(`CONNECT 127.0.0.1:${allowedPort} HTTP/1.1\r\nHost: 127.0.0.1:${allowedPort}\r\n\r\n`);
    // 터널이 선 연결은 요청이 오가지 않아도 서버가 닫기를 기다려 주지 않는다
    await vi.waitFor(() => expect(received).toContain('200 Connection Established'));
    const closed = new Promise<void>((resolve) => open.once('close', () => resolve()));
    await proxy.close();
    await closed;
    await expect(new Promise((resolve, reject) => connect({ host: '127.0.0.1', port }).once('connect', resolve).once('error', reject))).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('프록시 뒤의 브라우저 (#1210)', { timeout: 60_000 }, () => {
  it('127.0.0.1·localhost·[::1]·링크 로컬 요청이 모두 프록시를 지난다 (loopback 우회가 꺼져 있다)', async () => {
    const seen: string[] = [];
    const proxy = await startOriginProxy({
      isAllowed: () => false,
      onBlocked: (block) => seen.push(block.kind === 'tunnel' ? `CONNECT ${block.hostPort}` : block.url),
    });
    // 환경 변수로 Playwright의 loopback 프록시를 끄더라도 인자로 다시 켜져 있어야 한다
    const previous = process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK;
    process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
    const browser = await launchBrowser({ proxyServer: proxy.server });
    try {
      const page = await browser.newPage();
      const targets = [`http://127.0.0.1:${allowedPort}/a`, `http://localhost:${allowedPort}/b`, `http://[::1]:${allowedPort}/c`, `http://foo.localhost:${allowedPort}/d`, `http://169.254.169.254/e`, `https://127.0.0.1:${allowedPort}/f`];
      for (const target of targets) await page.goto(target, { timeout: 8000 }).catch(() => {});
      // Google Chrome은 시간 동기화·로그인 확인 같은 배경 요청도 프록시로 보낸다. 시험 주소로 가는 것만 견준다
      // Chrome은 응답 없이 끊긴 이동을 한 번 다시 보내기도 해서 같은 주소는 한 번만 센다
      expect([...new Set(seen.filter((entry) => entry.includes(`:${allowedPort}`) || entry.includes('169.254.169.254')))]).toEqual([
        `http://127.0.0.1:${allowedPort}/a`,
        `http://localhost:${allowedPort}/b`,
        `http://[::1]:${allowedPort}/c`,
        `http://foo.localhost:${allowedPort}/d`,
        `http://169.254.169.254/e`,
        `CONNECT 127.0.0.1:${allowedPort}`,
      ]);
    } finally {
      if (previous === undefined) delete process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK;
      else process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = previous;
      await browser.close();
      await proxy.close();
    }
  });

  it('WebRTC의 UDP(STUN)는 프록시를 지나지 못하므로 브라우저가 보내지 않는다', async () => {
    const udp = createSocket('udp4');
    let packets = 0;
    udp.on('message', () => (packets += 1));
    await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
    const proxy = await startOriginProxy({ isAllowed: () => false, onBlocked: () => {} });
    const browser = await launchBrowser({ proxyServer: proxy.server });
    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      const port = udp.address().port;
      const state = await page.evaluate(
        `(async () => { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${port}' }, { urls: 'stun:localhost:${port}' }] }); pc.createDataChannel('x'); await pc.setLocalDescription(await pc.createOffer()); const started = Date.now(); while (pc.iceGatheringState !== 'complete' && Date.now() - started < 8000) await new Promise((resolve) => setTimeout(resolve, 100)); return pc.iceGatheringState; })()`,
      );
      // UDP를 막으면 수집이 곧 끝난다. 인자가 하나라도 안 먹으면 STUN을 보내며 수집이 끝나지 않는다(headless shell과 Google Chrome이 따르는 인자 이름이 다르다)
      expect(state).toBe('complete');
      expect(packets).toBe(0);
    } finally {
      await browser.close();
      await proxy.close();
      udp.close();
    }
  });
});
