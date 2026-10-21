import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ base: '' }));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: async () => {} }));
vi.mock('@/lib/server/sessions', () => ({ endpointFor: async () => mocks.base }));

import { POST } from './route';

let server: Server;
/** 서비스가 보낸 바이트 수와, 다 보내기 전에 연결이 끊겼는지 */
const sent = { bytes: 0, aborted: false };

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/huge') {
      // 50MB를 64KB씩 보낸다. 라우트가 상한에서 끊으면 다 보내기 전에 연결이 닫힌다
      sent.bytes = 0;
      sent.aborted = false;
      response.on('close', () => {
        if (!response.writableFinished) sent.aborted = true;
      });
      response.writeHead(200, { 'content-type': 'text/plain' });
      const chunk = Buffer.alloc(64 * 1024, 'a');
      const total = 50 * 1024 * 1024;
      const pump = () => {
        while (sent.bytes < total) {
          sent.bytes += chunk.length;
          if (!response.write(chunk)) return void response.once('drain', pump);
        }
        response.end();
      };
      pump();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mocks.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function send(input: Record<string, unknown>): Promise<Response> {
  return POST(new Request('http://localhost/api/sessions/s1/services/api/request', { method: 'POST', body: JSON.stringify(input) }), {
    params: Promise.resolve({ id: 's1', service: 'api' }),
  });
}

describe('POST /api/sessions/[id]/services/[service]/request', () => {
  it('서비스에 요청을 보내 상태·본문을 돌려준다', async () => {
    const response = await send({ method: 'GET', path: '/orders' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 200, body: '{"ok":true}', truncated: false });
  });

  it('"//다른-호스트" 같은 경로로 서비스 밖에 요청하지 않는다', async () => {
    const response = await send({ method: 'GET', path: '//example.com/steal' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('서비스 밖');
  });

  it('아주 큰 응답은 상한까지만 읽고 끊는다(끝까지 받아 서버 메모리에 담지 않는다, #815)', async () => {
    const response = await send({ method: 'GET', path: '/huge' });
    const result = (await response.json()) as { body: string; truncated: boolean };
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBe(200_000);
    // 연결이 끊기는 것을 서버가 알아차릴 시간을 준다
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent.aborted).toBe(true);
    expect(sent.bytes).toBeLessThan(50 * 1024 * 1024);
  });
});
