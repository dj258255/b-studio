import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localToken, LOCAL_TOKEN_COOKIE } from '@/lib/server/local-token';
import { POST } from './route';

const cache = globalThis as typeof globalThis & { __bStudioLocalToken?: string };
let dir: string;
let token: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'local-auth-api-'));
  process.env.B_STUDIO_LOCAL_TOKEN_FILE = path.join(dir, 'local-token');
  delete cache.__bStudioLocalToken;
  token = localToken();
});

afterEach(async () => {
  delete cache.__bStudioLocalToken;
  delete process.env.B_STUDIO_LOCAL_TOKEN_FILE;
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const post = (body: unknown, headers: Record<string, string> = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }): Promise<Response> =>
  POST(new Request('http://127.0.0.1:3000/api/local-auth', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }));

describe('POST /api/local-auth (ADR-173 덧붙임)', () => {
  it('맞는 토큰이면 쿠키(HttpOnly·SameSite=Strict·Path=/, http라 Secure 없음)를 심고 { ok: true }', async () => {
    const response = await post({ token });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${LOCAL_TOKEN_COOKIE}=${token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');
  });

  it('틀린 값·없는 값·모양이 틀린 본문은 403이고 쿠키를 심지 않으며, 토큰 값을 글에 찍지 않는다', async () => {
    for (const body of [{ token: 'deadbeef' }, {}, { token: 123 }, 'not json', undefined]) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(403);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    const wrong = await post({ token: 'deadbeef' });
    expect(JSON.stringify(await wrong.json())).not.toContain('deadbeef');
  });

  it('쿼리로 온 토큰은 받지 않는다(토큰은 본문으로만 온다)', async () => {
    const response = await POST(new Request(`http://127.0.0.1:3000/api/local-auth?token=${token}`, { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' } }));
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('이 컴퓨터 주소가 아니거나 다른 출처에서 온 요청은 받지 않는다', async () => {
    expect((await post({ token }, { host: 'evil.example:3000', origin: 'http://evil.example:3000' })).status).toBe(403);
    expect((await post({ token }, { host: '127.0.0.1:3000', origin: 'https://evil.example' })).status).toBe(403);
    // 스크립트가 바꿀 수 있는 x-forwarded-host로는 속이지 못한다(Host만 본다)
    expect((await post({ token }, { host: 'evil.example:3000', origin: 'http://evil.example:3000', 'x-forwarded-host': '127.0.0.1:3000' })).status).toBe(403);
  });

  it('인증을 켠 서버(token)에서는 아무 일도 하지 않는다(404)', async () => {
    vi.stubEnv('B_STUDIO_AUTH', 'token');
    vi.stubEnv('B_STUDIO_AUTH_SECRET', 's'.repeat(40));
    vi.stubEnv('B_STUDIO_AUTH_TOKENS', `kim:${'k'.repeat(32)}`);
    const response = await post({ token });
    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
