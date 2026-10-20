import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { PREVIEW_COOKIE, SESSION_COOKIE } from './auth';
import { LOCAL_TOKEN_COOKIE } from './local-token';
import { createPreviewProxy, STUDIO_COOKIE_PREFIX } from './preview-proxy';

const servers: http.Server[] = [];
const extraSockets = new Set<Duplex>();
afterEach(async () => {
  // 업그레이드로 넘어간 소켓은 서버의 연결 목록에서 빠져 closeAllConnections가 닿지 않는다
  for (const socket of extraSockets) socket.destroy();
  extraSockets.clear();
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** host가 null이면 Host 헤더를 아예 보내지 않는다(기본값은 이 프록시가 듣는 맞는 값 — 기존 테스트가 그대로 통과하게) */
function send(
  port: number,
  path: string,
  host: string | null = `127.0.0.1:${port}`,
  extra: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...extra };
    if (host !== null) headers.host = host;
    const options: http.RequestOptions = { hostname: '127.0.0.1', port, path, headers };
    if (host === null) options.setHost = false;
    const request = http.request(options, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

function upgrade(port: number, host: string = `127.0.0.1:${port}`, extra = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET /_next/hmr HTTP/1.1\r\nhost: ${host}\r\nupgrade: websocket\r\nconnection: Upgrade\r\n${extra}\r\n`);
    });
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString();
      if (received.includes('101 Switching Protocols') && !received.includes('echo:')) socket.write('ping');
      if (received.includes('echo:ping')) {
        socket.destroy();
        resolve(received);
      }
    });
    socket.on('end', () => resolve(received));
    socket.on('error', reject);
  });
}

/** 테스트용 "서비스": HTML·JSON을 돌려주고, 웹소켓은 받은 그대로 되돌려 준다(echo) */
function fakeService() {
  const server = http.createServer((request, response) => {
    if (request.url === '/page') {
      const html = '<html><head><title>t</title></head><body>hi</body></html>';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, host: request.headers.host }));
  });
  server.on('upgrade', (request, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
    socket.on('data', (chunk) => socket.write(`echo:${chunk.toString()}`));
    socket.on('end', () => socket.destroy());
    socket.on('error', () => socket.destroy());
  });
  return server;
}

/** 받은 쿠키를 되비추고, studio 쿠키를 심는 Set-Cookie를 함께 보내는 테스트용 서비스 */
function cookieService() {
  const setCookies = ['b_studio_local=x; Path=/', 'app=1; Path=/'];
  const server = http.createServer((request, response) => {
    if (request.url === '/page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': setCookies });
      response.end('<html><head></head><body>hi</body></html>');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': setCookies });
    response.end(JSON.stringify({ cookie: request.headers.cookie ?? null }));
  });
  server.on('upgrade', (request, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nset-cookie: b_studio_local=x\r\nset-cookie: app=1\r\n\r\n');
    socket.write(`cookie:${request.headers.cookie ?? ''}\n`);
    socket.on('data', (chunk) => socket.write(`echo:${chunk.toString()}`));
    socket.on('end', () => socket.destroy());
    socket.on('error', () => socket.destroy());
  });
  return server;
}

/** 이름이 빈 Set-Cookie로 studio 쿠키를 심는 길까지 확인하는 테스트용 서비스 */
function oddCookieService() {
  const setCookies = ['=b_studio_local=x; Path=/', ' =b_studio_session=y', 'b_studio_local', '=plain', 'app=1'];
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': setCookies });
    response.end(JSON.stringify({ ok: true }));
  });
  server.on('upgrade', (_request, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n' + setCookies.map((value) => `set-cookie: ${value}\r\n`).join('') + '\r\n');
    socket.on('data', (chunk) => socket.write(`echo:${chunk.toString()}`));
    socket.on('end', () => socket.destroy());
    socket.on('error', () => socket.destroy());
  });
  return server;
}

/** `\r\n\r\n` 없이 상한(64KiB)을 넘게 보내는 테스트용 서비스 */
function runawayHeadService() {
  const server = http.createServer();
  server.on('upgrade', (_request, socket: Duplex) => {
    extraSockets.add(socket);
    socket.on('close', () => extraSockets.delete(socket));
    socket.write(Buffer.alloc(70 * 1024, 0x61));
  });
  return server;
}

/** 업그레이드를 보내고 브라우저 쪽 소켓이 닫힐 때까지 모은다. 닫히지 않으면 시간 초과로 closed: false */
function upgradeUntilClosed(port: number, timeoutMs = 2000): Promise<{ received: string; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET /_next/hmr HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n`);
    });
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ received, closed: false });
    }, timeoutMs);
    socket.on('data', (chunk) => (received += chunk.toString()));
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ received, closed: true });
    });
  });
}

describe('createPreviewProxy', () => {
  it('HTML에는 스크립트를 심고, JSON은 바이트 그대로 돌려주고, 웹소켓 업그레이드도 잇는다', async () => {
    const servicePort = await listen(fakeService());
    const proxy = createPreviewProxy({ resolve: () => `http://127.0.0.1:${servicePort}` });
    const proxyPort = await listen(proxy);

    const page = await send(proxyPort, '/page');
    expect(page.status).toBe(200);
    expect(page.body.toString('utf8')).toContain('b-studio:location');

    const json = await send(proxyPort, '/data?x=1');
    const expected = Buffer.from(JSON.stringify({ ok: true, host: `127.0.0.1:${servicePort}` }));
    expect(json.body.equals(expected)).toBe(true);

    const echoed = await upgrade(proxyPort);
    expect(echoed).toContain('HTTP/1.1 101 Switching Protocols');
    expect(echoed).toContain('echo:ping');
  });

  it('resolve가 가리키는 주소가 바뀌면 다음 요청부터 새 주소로 간다(서비스 재시작으로 포트가 바뀐 상황)', async () => {
    const firstPort = await listen(fakeService());
    const secondPort = await listen(fakeService());
    let target = firstPort;
    const proxy = createPreviewProxy({ resolve: () => `http://127.0.0.1:${target}` });
    const proxyPort = await listen(proxy);

    expect(JSON.parse((await send(proxyPort, '/data')).body.toString()).host).toBe(`127.0.0.1:${firstPort}`);
    target = secondPort;
    expect(JSON.parse((await send(proxyPort, '/data')).body.toString()).host).toBe(`127.0.0.1:${secondPort}`);
  });

  it('resolve가 주소를 못 찾으면 502를 돌려준다', async () => {
    const proxy = createPreviewProxy({ resolve: () => undefined });
    const proxyPort = await listen(proxy);
    const result = await send(proxyPort, '/page');
    expect(result.status).toBe(502);
  });

  it('Host가 127.0.0.1 또는 localhost의 이 포트가 아니면 403을 돌려주고 업스트림에 연결하지 않는다', async () => {
    let hits = 0;
    const service = http.createServer((_request, response) => {
      hits += 1;
      response.end('ok');
    });
    const servicePort = await listen(service);
    const proxy = createPreviewProxy({ resolve: () => `http://127.0.0.1:${servicePort}` });
    const proxyPort = await listen(proxy);

    const message = '미리보기는 127.0.0.1 또는 localhost 주소로만 열 수 있습니다.';
    for (const host of [`evil.example:${proxyPort}`, `127.0.0.1:${proxyPort + 1}`, null]) {
      const result = await send(proxyPort, '/page', host);
      expect(result.status).toBe(403);
      expect(result.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(result.body.toString('utf8')).toBe(message);
    }
    expect(hits).toBe(0);

    for (const host of [`127.0.0.1:${proxyPort}`, `localhost:${proxyPort}`, `LOCALHOST:${proxyPort}`]) {
      expect((await send(proxyPort, '/data', host)).status).toBe(200);
    }
    expect(hits).toBe(3);
  });

  it('업그레이드도 Host가 맞지 않으면 403을 쓰고 업스트림에 연결하지 않는다', async () => {
    let upgrades = 0;
    const service = http.createServer();
    service.on('upgrade', (_request, socket) => {
      upgrades += 1;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
      socket.on('data', (chunk) => socket.write(`echo:${chunk.toString()}`));
      socket.on('end', () => socket.destroy());
      socket.on('error', () => socket.destroy());
    });
    const servicePort = await listen(service);
    const proxy = createPreviewProxy({ resolve: () => `http://127.0.0.1:${servicePort}` });
    const proxyPort = await listen(proxy);

    const forbidden = await upgrade(proxyPort, `evil.example:${proxyPort}`);
    expect(forbidden.startsWith('HTTP/1.1 403 Forbidden')).toBe(true);
    expect(upgrades).toBe(0);

    const ok = await upgrade(proxyPort);
    expect(ok).toContain('HTTP/1.1 101 Switching Protocols');
    expect(ok).toContain('echo:ping');
    expect(upgrades).toBe(1);
  });

  it('업스트림으로 가는 studio 쿠키를 떼고, 앱의 다른 쿠키는 그대로 둔다', async () => {
    const servicePort = await listen(cookieService());
    const proxy = createPreviewProxy({ resolve: () => `http://127.0.0.1:${servicePort}` });
    const proxyPort = await listen(proxy);
    const host = `127.0.0.1:${proxyPort}`;

    const mixed = await send(proxyPort, '/data', host, { cookie: 'b_studio_local=a; app=1; b_studio_session=b' });
    expect(JSON.parse(mixed.body.toString()).cookie).toBe('app=1');

    const onlyStudio = await send(proxyPort, '/data', host, { cookie: 'b_studio_local=a; b_studio_session=b' });
    expect(JSON.parse(onlyStudio.body.toString()).cookie).toBeNull();

    const upgraded = await upgrade(proxyPort, host, 'cookie: b_studio_local=a; app=1; b_studio_session=b\r\n');
    expect(upgraded).toContain('cookie:app=1\n');
  });

  it('업스트림이 보내는 studio Set-Cookie는 브라우저로 보내지 않는다', async () => {
    const servicePort = await listen(cookieService());
    const proxy = createPreviewProxy({ resolve: () => `http://127.0.0.1:${servicePort}` });
    const proxyPort = await listen(proxy);

    const html = await send(proxyPort, '/page');
    expect(html.status).toBe(200);
    expect(html.headers['set-cookie']).toEqual(['app=1; Path=/']);
    expect(html.body.toString('utf8')).toContain('b-studio:location');

    const json = await send(proxyPort, '/data');
    expect(json.headers['set-cookie']).toEqual(['app=1; Path=/']);

    const upgraded = await upgrade(proxyPort);
    expect(upgraded).toContain('HTTP/1.1 101 Switching Protocols');
    expect(upgraded).toContain('set-cookie: app=1');
    expect(upgraded).not.toContain('b_studio_local');
    expect(upgraded).toContain('echo:ping');
  });

  it('이름이 빈 Set-Cookie로 studio 쿠키를 심는 길도 막는다', async () => {
    const servicePort = await listen(oddCookieService());
    const proxy = createPreviewProxy({ resolve: () => `http://127.0.0.1:${servicePort}` });
    const proxyPort = await listen(proxy);

    const result = await send(proxyPort, '/data');
    expect(result.headers['set-cookie']).toEqual(['=plain', 'app=1']);

    const upgraded = await upgrade(proxyPort);
    expect(upgraded).toContain('set-cookie: =plain');
    expect(upgraded).toContain('set-cookie: app=1');
    expect(upgraded).not.toContain('b_studio_local');
    expect(upgraded).not.toContain('b_studio_session');
  });

  it('업그레이드 응답 머리가 상한을 넘으면 브라우저 쪽 소켓을 닫고 바이트를 하나도 넘기지 않는다', async () => {
    const servicePort = await listen(runawayHeadService());
    const proxy = createPreviewProxy({ resolve: () => `http://127.0.0.1:${servicePort}` });
    const proxyPort = await listen(proxy);

    const result = await upgradeUntilClosed(proxyPort);
    expect(result.closed).toBe(true);
    expect(result.received).toBe('');
  });

  it('studio 쿠키 상수는 모두 접두사로 시작한다', () => {
    for (const name of [LOCAL_TOKEN_COOKIE, SESSION_COOKIE, PREVIEW_COOKIE]) {
      expect(name.startsWith(STUDIO_COOKIE_PREFIX)).toBe(true);
    }
  });
});
