import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROXY_SECRET_HEADER, USER_HEADER } from '@/lib/server/auth';
import { createStudioHandler, type StudioHandlerOptions } from './app';
import type { RouteEntry } from './router';

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function serve(routes: RouteEntry[], options: Partial<StudioHandlerOptions> = {}): Promise<string> {
  server = createServer(createStudioHandler({ routes, env: { B_STUDIO_AUTH: 'none' }, ...options }));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const route = (pattern: string, module: Record<string, unknown>): RouteEntry => ({ pattern, load: () => Promise.resolve(module) });

describe('스튜디오 핸들러: 라우트 부르기', () => {
  it('맞는 라우트의 메서드를 부르고 params를 Promise로 넘긴다', async () => {
    const GET = vi.fn(async (_request: Request, context: { params: Promise<Record<string, string>> }) => Response.json({ id: (await context.params).id }));
    const origin = await serve([route('/api/sessions/[id]', { GET })]);
    const response = await fetch(`${origin}/api/sessions/s-1`);
    expect(await response.json()).toEqual({ id: 's-1' });
  });

  it('없는 경로는 404 JSON', async () => {
    const origin = await serve([]);
    const response = await fetch(`${origin}/api/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '없는 경로입니다' });
  });

  it('없는 메서드는 405와 Allow', async () => {
    const origin = await serve([route('/api/x', { GET: () => new Response('ok'), POST: () => new Response('ok') })]);
    const response = await fetch(`${origin}/api/x`, { method: 'DELETE', headers: { origin } });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD, OPTIONS, POST');
  });

  it('HEAD는 GET으로 답하고 본문을 비운다, OPTIONS는 Allow로 답한다', async () => {
    const origin = await serve([route('/api/x', { GET: () => new Response('본문', { headers: { 'x-a': '1' } }) })]);
    const head = await fetch(`${origin}/api/x`, { method: 'HEAD' });
    expect([head.status, head.headers.get('x-a'), await head.text()]).toEqual([200, '1', '']);
    const options = await fetch(`${origin}/api/x`, { method: 'OPTIONS' });
    expect([options.status, options.headers.get('allow')]).toEqual([204, 'GET, HEAD, OPTIONS']);
  });

  it('라우트가 던지면 500 JSON으로 답하고 서버는 계속 돈다', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const origin = await serve([route('/api/boom', { GET: () => { throw new Error('터짐'); } }), route('/api/ok', { GET: () => new Response('ok') })]);
    const response = await fetch(`${origin}/api/boom`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: '서버 안에서 오류가 났습니다' });
    expect(await (await fetch(`${origin}/api/ok`)).text()).toBe('ok');
    error.mockRestore();
  });

  it('본문이 한도를 넘으면 413', async () => {
    const origin = await serve([route('/api/x', { POST: async (request: Request) => new Response(await request.text()) })], { maxBodyBytes: 8 });
    const response = await fetch(`${origin}/api/x`, { method: 'POST', headers: { origin }, body: '0123456789' });
    expect(response.status).toBe(413);
  });

  it('첫 화면(/)은 b-studio 표지가 든 안내를 준다', async () => {
    const origin = await serve([]);
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('b-studio');
  });
});

describe('스튜디오 핸들러: 인증', () => {
  it('브라우저가 보낸 사용자·비밀 헤더는 지우고 확인한 사용자만 넣는다', async () => {
    let seen: { user: string | null; secret: string | null } | undefined;
    const GET = (request: Request) => {
      seen = { user: request.headers.get(USER_HEADER), secret: request.headers.get(PROXY_SECRET_HEADER) };
      return new Response('ok');
    };
    const origin = await serve([route('/api/me', { GET })]);
    await fetch(`${origin}/api/me`, { headers: { [USER_HEADER]: 'admin', [PROXY_SECRET_HEADER]: 'x' } });
    expect(seen?.secret).toBeNull();
    expect(seen?.user).not.toBe('admin');
  });

  it('다른 출처의 쓰기 요청은 라우트에 닿기 전에 403', async () => {
    const POST = vi.fn(() => new Response('ok'));
    const origin = await serve([route('/api/x', { POST })]);
    const response = await fetch(`${origin}/api/x`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(response.status).toBe(403);
    expect(POST).not.toHaveBeenCalled();
  });

  it('인증 없이 띄운 서버는 이 컴퓨터 주소가 아닌 Host를 막는다', async () => {
    const GET = vi.fn(() => new Response('ok'));
    const origin = await serve([route('/api/x', { GET })]);
    // fetch는 Host를 바꾸지 못해 node:http로 보낸다
    const status = await new Promise<number>((resolve, reject) => {
      const client = httpRequest(`${origin}/api/x`, { headers: { host: 'evil.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      client.on('error', reject);
      client.end();
    });
    expect(status).toBe(403);
    expect(GET).not.toHaveBeenCalled();
  });

  it('token 모드에서 로그인하지 않은 API 요청은 401', async () => {
    const GET = vi.fn(() => new Response('ok'));
    const origin = await serve([route('/api/x', { GET })], {
      env: { B_STUDIO_AUTH: 'token', B_STUDIO_AUTH_TOKENS: 'kim:0123456789abcdef0123456789abcdef', B_STUDIO_AUTH_SECRET: '0123456789abcdef0123456789abcdef' },
    });
    const response = await fetch(`${origin}/api/x`);
    expect(response.status).toBe(401);
    expect(GET).not.toHaveBeenCalled();
  });
});
