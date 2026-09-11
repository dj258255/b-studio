import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCESS_PATH,
  createPreviewGateway,
  parsePreviewHost,
  previewHost,
  readCookie,
  rewriteLocation,
  safePreviewPath,
  upstreamHeaders,
  withoutCookie,
  type PreviewTarget,
} from './preview-gateway';

const DOMAIN = 'preview.localhost';
const TARGET: PreviewTarget = { service: 'web', sessionId: '67e417ec', token: 'a'.repeat(32) };
const servers: Array<http.Server> = [];

afterEach(async () => {
  // keep-alive 연결이 남아 있으면 close()가 끝나지 않는다
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

function send(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path, headers }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

function upgrade(port: number, host: string, extra = '') {
  return new Promise<string>((resolve, reject) => {
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

function echoUpstream() {
  const server = http.createServer((request, response) => {
    if (request.url === '/moved') {
      response.writeHead(307, { location: `http://${request.headers.host}/orders` });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ url: request.url, host: request.headers.host, origin: request.headers.origin ?? null, cookie: request.headers.cookie ?? null }));
  });
  server.on('upgrade', (request, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
    socket.write(`cookie:${request.headers.cookie ?? ''}\n`);
    socket.on('data', (chunk) => socket.write(`echo:${chunk.toString()}`));
    // 실제 웹소켓 서버처럼 상대가 끊으면 자기 쪽도 닫는다
    socket.on('end', () => socket.destroy());
    socket.on('error', () => socket.destroy());
  });
  return server;
}

describe('미리보기 호스트', () => {
  it('서비스·세션·토큰을 호스트 이름으로 주고받고, 포트와 대소문자는 무시한다', () => {
    const host = previewHost(TARGET, DOMAIN);
    expect(host).toBe(`web--67e417ec--${'a'.repeat(32)}.preview.localhost`);
    expect(parsePreviewHost(`${host.toUpperCase()}:4100`, DOMAIN)).toEqual(TARGET);
    // 서비스 이름에 하이픈이 두 개 들어가도 끝의 고정 길이 세션·토큰으로 구분한다
    expect(parsePreviewHost(previewHost({ ...TARGET, service: 'order--web' }, DOMAIN), DOMAIN)).toEqual({ ...TARGET, service: 'order--web' });
  });

  it('도메인이 다르거나 토큰 길이가 맞지 않으면 대상으로 보지 않는다', () => {
    expect(parsePreviewHost(previewHost(TARGET, 'evil.example.com'), DOMAIN)).toBeUndefined();
    expect(parsePreviewHost(`web--67e417ec--abc.${DOMAIN}`, DOMAIN)).toBeUndefined();
    expect(parsePreviewHost(`preview.localhost`, DOMAIN)).toBeUndefined();
    expect(parsePreviewHost(undefined, DOMAIN)).toBeUndefined();
  });

  it('서비스에는 루프백 주소에서 온 같은 출처 요청으로 보이게 헤더를 바꾸고, 리다이렉트는 미리보기 주소로 돌린다', () => {
    const upstream = new URL('http://127.0.0.1:33048');
    const publicHost = previewHost(TARGET, DOMAIN);
    expect(
      upstreamHeaders({ host: publicHost, origin: `http://${publicHost}`, referer: `http://${publicHost}/orders?x=1`, accept: 'text/html' }, upstream, publicHost),
    ).toEqual({ host: '127.0.0.1:33048', origin: 'http://127.0.0.1:33048', referer: 'http://127.0.0.1:33048/orders?x=1', accept: 'text/html', 'x-forwarded-host': publicHost });
    expect(rewriteLocation('http://127.0.0.1:33048/login?next=%2F', upstream, `http://${publicHost}`)).toBe(`http://${publicHost}/login?next=%2F`);
    expect(rewriteLocation('/relative', upstream, `http://${publicHost}`)).toBe(`http://${publicHost}/relative`);
    expect(rewriteLocation('https://accounts.example.com/', upstream, `http://${publicHost}`)).toBe('https://accounts.example.com/');
  });

  it('접근 쿠키만 골라 읽고 빼며, 돌아갈 경로는 같은 호스트의 경로만 받는다', () => {
    expect(readCookie('theme=dark; b_studio_preview=v.s; other=1', 'b_studio_preview')).toBe('v.s');
    expect(readCookie('theme=dark', 'b_studio_preview')).toBeUndefined();
    expect(withoutCookie('theme=dark; b_studio_preview=v.s; other=1', 'b_studio_preview')).toBe('theme=dark; other=1');
    expect(withoutCookie('b_studio_preview=v.s', 'b_studio_preview')).toBe('');
    expect(safePreviewPath('/orders?x=1')).toBe('/orders?x=1');
    expect(safePreviewPath('//evil.example')).toBe('/');
    expect(safePreviewPath('https://evil.example')).toBe('/');
    expect(safePreviewPath(null)).toBe('/');
  });
});

describe('createPreviewGateway', () => {
  it('맞는 세션과 토큰의 요청만 경로 그대로 서비스에 넘기고, 웹소켓 업그레이드도 잇는다', async () => {
    const upstreamPort = await listen(echoUpstream());
    const gateway = createPreviewGateway({
      domain: DOMAIN,
      resolve: async (target) => (target.sessionId === TARGET.sessionId && target.token === TARGET.token ? `http://127.0.0.1:${upstreamPort}` : undefined),
    });
    const gatewayPort = await listen(gateway);
    const host = `${previewHost(TARGET, DOMAIN)}:${gatewayPort}`;

    const page = await send(gatewayPort, '/_next/static/chunk.js?v=1', { host, origin: `http://${host}` });
    expect(page.status).toBe(200);
    expect(JSON.parse(page.body)).toEqual({ url: '/_next/static/chunk.js?v=1', host: `127.0.0.1:${upstreamPort}`, origin: `http://127.0.0.1:${upstreamPort}`, cookie: null });

    const moved = await send(gatewayPort, '/moved', { host });
    expect(moved.headers.location).toBe(`http://${host}/orders`);

    const wrongToken = await send(gatewayPort, '/', { host: `${previewHost({ ...TARGET, token: 'b'.repeat(32) }, DOMAIN)}:${gatewayPort}` });
    expect(wrongToken.status).toBe(404);

    const echoed = await upgrade(gatewayPort, host);
    expect(echoed).toContain('HTTP/1.1 101 Switching Protocols');
    expect(echoed).toContain('echo:ping');
  });

  it('접근 확인을 켜면 티켓을 쿠키로 바꿔 주고, 쿠키가 없는 요청과 웹소켓은 거부하며, 접근 쿠키는 서비스에 넘기지 않는다', async () => {
    const upstreamPort = await listen(echoUpstream());
    const gateway = createPreviewGateway({
      domain: DOMAIN,
      resolve: async () => `http://127.0.0.1:${upstreamPort}`,
      access: {
        cookieName: 'b_studio_preview',
        redeem: (host, ticket) => (ticket === 'good' && host.startsWith('web--') ? { cookie: 'granted.sig', maxAgeSeconds: 600 } : undefined),
        allows: (_host, cookie) => cookie === 'granted.sig',
      },
    });
    const gatewayPort = await listen(gateway);
    const host = `${previewHost(TARGET, DOMAIN)}:${gatewayPort}`;

    expect((await send(gatewayPort, '/orders', { host })).status).toBe(401);
    expect((await send(gatewayPort, '/orders', { host, cookie: 'b_studio_preview=forged' })).status).toBe(401);
    expect((await send(gatewayPort, `${ACCESS_PATH}?ticket=bad&next=/orders`, { host })).status).toBe(403);

    const redeemed = await send(gatewayPort, `${ACCESS_PATH}?ticket=good&next=${encodeURIComponent('/orders?x=1')}`, { host });
    expect(redeemed.status).toBe(302);
    expect(redeemed.headers.location).toBe('/orders?x=1');
    expect(redeemed.headers['cache-control']).toBe('no-store');
    expect(redeemed.headers['set-cookie']).toEqual(['b_studio_preview=granted.sig; Path=/; HttpOnly; SameSite=Lax; Max-Age=600']);
    const elsewhere = await send(gatewayPort, `${ACCESS_PATH}?ticket=good&next=${encodeURIComponent('//evil.example')}`, { host, 'x-forwarded-proto': 'https' });
    expect(elsewhere.headers.location).toBe('/');
    expect(elsewhere.headers['set-cookie']?.[0]).toMatch(/; Secure$/);

    const allowed = await send(gatewayPort, '/orders', { host, cookie: 'theme=dark; b_studio_preview=granted.sig' });
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body)).toMatchObject({ url: '/orders', cookie: 'theme=dark' });
    expect(JSON.parse((await send(gatewayPort, '/', { host, cookie: 'b_studio_preview=granted.sig' })).body).cookie).toBeNull();

    expect(await upgrade(gatewayPort, host)).toMatch(/^HTTP\/1\.1 401/);
    const socket = await upgrade(gatewayPort, host, 'cookie: b_studio_preview=granted.sig; theme=dark\r\n');
    expect(socket).toContain('101 Switching Protocols');
    expect(socket).toContain('cookie:theme=dark\n');
  });
});
