import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createPreviewProxy } from './preview-proxy';

const servers: http.Server[] = [];
afterEach(async () => {
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

function send(port: number, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

function upgrade(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('GET /_next/hmr HTTP/1.1\r\nhost: 127.0.0.1\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
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
});
