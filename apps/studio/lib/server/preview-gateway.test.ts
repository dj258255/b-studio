import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createPreviewGateway, parsePreviewHost, previewHost, rewriteLocation, upstreamHeaders, type PreviewTarget } from './preview-gateway';

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
});

describe('createPreviewGateway', () => {
  it('맞는 세션과 토큰의 요청만 경로 그대로 서비스에 넘기고, 웹소켓 업그레이드도 잇는다', async () => {
    const upstreamServer = http.createServer((request, response) => {
      if (request.url === '/moved') {
        response.writeHead(307, { location: `http://${request.headers.host}/orders` });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ url: request.url, host: request.headers.host, origin: request.headers.origin ?? null }));
    });
    upstreamServer.on('upgrade', (_request, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
      socket.on('data', (chunk) => socket.write(`echo:${chunk.toString()}`));
      // 실제 웹소켓 서버처럼 상대가 끊으면 자기 쪽도 닫는다
      socket.on('end', () => socket.destroy());
      socket.on('error', () => socket.destroy());
    });
    const upstreamPort = await listen(upstreamServer);

    const gateway = createPreviewGateway({
      domain: DOMAIN,
      resolve: async (target) => (target.sessionId === TARGET.sessionId && target.token === TARGET.token ? `http://127.0.0.1:${upstreamPort}` : undefined),
    });
    const gatewayPort = await listen(gateway);
    const host = `${previewHost(TARGET, DOMAIN)}:${gatewayPort}`;
    const get = (path: string, requestHost: string) =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port: gatewayPort, path, headers: { host: requestHost, origin: `http://${requestHost}` } }, (response) => {
          let body = '';
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
        });
        request.on('error', reject);
        request.end();
      });

    const page = await get('/_next/static/chunk.js?v=1', host);
    expect(page.status).toBe(200);
    expect(JSON.parse(page.body)).toEqual({ url: '/_next/static/chunk.js?v=1', host: `127.0.0.1:${upstreamPort}`, origin: `http://127.0.0.1:${upstreamPort}` });

    const moved = await get('/moved', host);
    expect(moved.headers.location).toBe(`http://${host}/orders`);

    const wrongToken = await get('/', `${previewHost({ ...TARGET, token: 'b'.repeat(32) }, DOMAIN)}:${gatewayPort}`);
    expect(wrongToken.status).toBe(404);

    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(gatewayPort, '127.0.0.1', () => {
        socket.write(`GET /_next/hmr HTTP/1.1\r\nhost: ${host}\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n`);
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
      socket.on('error', reject);
    });
    expect(echoed).toContain('HTTP/1.1 101 Switching Protocols');
    expect(echoed).toContain('echo:ping');
  });
});
