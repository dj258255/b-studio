import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_TOKEN_COOKIE, localToken } from '@/lib/server/local-token';
import { phoneGateway, phoneListening, setPhoneDispatcher, stopPhoneListener } from '@/lib/server/phone/listener';
import { addDevice, readSettings, resetPhoneState } from '@/lib/server/phone/state';
import { DELETE as deleteDevice } from './devices/[id]/route';
import { DELETE as cancelPairing, POST as newPairing } from './pairing/route';
import { GET, POST } from './route';

/** desk가 쓰는 관리 경로(/api/phone)의 접근과 동작. 귀는 127.0.0.1의 임시 포트에 연다(실제 LAN에는 바인드하지 않는다) */
let dir: string;

const local = (init: RequestInit & { host?: string; user?: string; cookie?: boolean } = {}): Request => {
  const headers: Record<string, string> = { host: init.host ?? '127.0.0.1:3000' };
  if (init.cookie !== false) headers.cookie = `${LOCAL_TOKEN_COOKIE}=${localToken()}`;
  if (init.user) headers['x-b-studio-user'] = init.user;
  return new Request(`http://${headers.host}/api/phone`, { method: init.method ?? 'GET', headers, ...(init.body ? { body: init.body } : {}) });
};
const toggle = (enabled: boolean, extra: Parameters<typeof local>[0] = {}) => POST(local({ ...extra, method: 'POST', body: JSON.stringify({ enabled }) }));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'b-studio-phone-route-'));
  vi.stubEnv('B_STUDIO_AUTH', 'none');
  vi.stubEnv('B_STUDIO_PHONE_DIR', path.join(dir, 'phone'));
  vi.stubEnv('B_STUDIO_LOCAL_TOKEN_FILE', path.join(dir, 'local-token'));
  vi.stubEnv('B_STUDIO_PHONE_HOSTS', '127.0.0.1');
  resetPhoneState();
  (globalThis as { __bStudioLocalToken?: string }).__bStudioLocalToken = undefined;
  setPhoneDispatcher(async () => new Response('{}'));
});

afterEach(async () => {
  await stopPhoneListener();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('/api/phone: 이 컴퓨터의 desk만 다룬다', () => {
  it('다른 주소(Host)로 온 요청과 로컬 토큰이 없는 요청은 거절한다', async () => {
    expect((await GET(local({ host: '192.168.0.5:3000' }))).status).toBe(403);
    expect((await GET(local({ cookie: false }))).status).toBe(403);
    expect((await toggle(true, { host: 'studio.example.com' })).status).toBe(403);
    expect((await newPairing(local({ method: 'POST', host: '10.0.0.4' }))).status).toBe(403);
    expect(readSettings().enabled).toBe(false);
  });

  it('꺼진 상태에서 상태를 읽으면 주소 없음·기기 없음이고, 짝 코드는 만들지 않는다', async () => {
    const view = (await (await GET(local())).json()) as { allowed: boolean; enabled: boolean; addresses: string[]; devices: unknown[] };
    expect(view).toMatchObject({ allowed: true, enabled: false, addresses: [], devices: [] });
    const refused = await newPairing(local({ method: 'POST' }));
    expect(refused.status).toBe(409);
  });

  it('켜면 귀가 열리고 QR 내용(서버 공개 키·코드·주소)을 받는다. 거두면 코드가 못 쓰인다', async () => {
    const on = (await (await toggle(true)).json()) as { enabled: boolean; addresses: string[] };
    expect(on.enabled).toBe(true);
    expect(on.addresses).toHaveLength(1);
    expect(phoneListening()?.hosts).toEqual(['127.0.0.1']);
    const pairing = (await (await newPairing(local({ method: 'POST' }))).json()) as { payload: string; expiresAt: number };
    const content = JSON.parse(pairing.payload) as { t: string; v: number; k: string; c: string; a: string[] };
    expect(content).toMatchObject({ t: 'b-studio-pair', v: 1 });
    expect(content.k).toHaveLength(44);
    expect(content.c).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect(content.a).toEqual(on.addresses);
    const view = (await (await GET(local())).json()) as { pairing?: { expiresAt: number } };
    expect(view.pairing?.expiresAt).toBe(pairing.expiresAt);
    expect((await cancelPairing(local({ method: 'DELETE' }))).status).toBe(200);
    expect(((await (await GET(local())).json()) as { pairing?: unknown }).pairing).toBeUndefined();
  });

  it('끄면 귀가 닫히고 스위치도 꺼진다', async () => {
    await toggle(true);
    await toggle(false);
    expect(phoneListening()).toBeUndefined();
    expect(readSettings().enabled).toBe(false);
  });

  it('잘못된 본문은 400', async () => {
    expect((await POST(local({ method: 'POST', body: JSON.stringify({ enabled: 'yes' }) }))).status).toBe(400);
    expect((await POST(local({ method: 'POST', body: '{' }))).status).toBe(400);
  });

  it('기기 끊기: 없는 기기는 404, 있으면 목록에서 지운다', async () => {
    await toggle(true);
    const device = addDevice({ name: '폰', publicKey: Buffer.alloc(32, 1).toString('base64'), tokenHash: 'a'.repeat(64), user: 'local' }, Date.now());
    const context = (id: string) => ({ params: Promise.resolve({ id }) });
    expect((await deleteDevice(local({ method: 'DELETE' }), context('f'.repeat(32)))).status).toBe(404);
    expect((await deleteDevice(local({ method: 'DELETE', host: '192.168.0.5' }), context(device.id))).status).toBe(403);
    expect((await deleteDevice(local({ method: 'DELETE' }), context(device.id))).status).toBe(200);
    expect(((await (await GET(local())).json()) as { devices: unknown[] }).devices).toEqual([]);
    expect(phoneGateway()).toBeDefined();
  });
});

describe('/api/phone: 인증을 켠 서버', () => {
  function serverMode(extra: Record<string, string> = {}): void {
    vi.stubEnv('B_STUDIO_AUTH', 'token');
    vi.stubEnv('B_STUDIO_AUTH_SECRET', 's'.repeat(40));
    vi.stubEnv('B_STUDIO_AUTH_TOKENS', `kim:${'k'.repeat(32)},lee:${'l'.repeat(32)},root:${'r'.repeat(32)}`);
    vi.stubEnv('B_STUDIO_AUTH_ADMINS', 'root');
    for (const [key, value] of Object.entries(extra)) vi.stubEnv(key, value);
  }

  it('운영자가 B_STUDIO_PHONE=1을 적지 않으면 켜지 못하고, 적어도 일반 사용자는 스위치를 못 바꾼다(관리자만)', async () => {
    serverMode();
    expect((await toggle(true, { user: 'root' })).status).toBe(409);
    expect(readSettings().enabled).toBe(false);
    serverMode({ B_STUDIO_PHONE: '1' });
    expect((await toggle(true, { user: 'kim' })).status).toBe(403);
    expect((await toggle(true, { user: 'root' })).status).toBe(200);
    expect((await toggle(true)).status).toBe(401);
  });

  it('기기는 짝 맺은 사람과 관리자만 보고 끊는다', async () => {
    serverMode({ B_STUDIO_PHONE: '1' });
    const device = addDevice({ name: '킴의 폰', publicKey: Buffer.alloc(32, 2).toString('base64'), tokenHash: 'b'.repeat(64), user: 'kim' }, Date.now());
    const names = async (user: string) => ((await (await GET(local({ user }))).json()) as { devices: Array<{ name: string }> }).devices.map((entry) => entry.name);
    expect(await names('kim')).toEqual(['킴의 폰']);
    expect(await names('lee')).toEqual([]);
    expect(await names('root')).toEqual(['킴의 폰']);
    const context = { params: Promise.resolve({ id: device.id }) };
    expect((await deleteDevice(local({ method: 'DELETE', user: 'lee' }), context)).status).toBe(404);
    expect((await deleteDevice(local({ method: 'DELETE', user: 'kim' }), context)).status).toBe(200);
  });
});
