import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 휴대폰 암호 통로의 시험. 가짜 휴대폰(tweetnacl로 직접 쓴 클라이언트, docs/phone-protocol.md의 틀을 따로 구현)이 127.0.0.1의 임시 포트에 연 귀로
 * 실제 HTTP 왕복을 한다. 라우트 표는 진짜 터미널 라우트와 접근 검사(access.ts, terminal-access.ts)를 쓰고 세션 표와 터미널 동작만 가짜다.
 * 실제 LAN 주소에는 바인드하지 않는다(B_STUDIO_PHONE_HOSTS=127.0.0.1). "밖에서 온 것처럼"은 판정 함수(isPrivatePeer, phoneHosts)로 본다
 */
const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { owner?: string; projectId: string }>(),
  writeSessionTerminal: vi.fn(),
  subscribers: new Set<(message: unknown) => void>(),
  pulled: 0,
  cancelled: false,
  hugeResponse: (): Response => new Response(),
}));

vi.mock('@/lib/server/sessions', () => ({
  getSnapshot: (id: string) => mocks.sessions.get(id),
  recoverSessions: async () => {},
  sessionTerminalTarget: (id: string) => ({ sandboxId: `studio-${id}`, root: `/work/${id}`, projectId: 'orders' }),
}));
vi.mock('@/lib/server/session-terminal', () => ({
  MAX_TERMINAL_INPUT: 256 * 1024,
  openSessionTerminal: async () => ({ initialPromptUsed: false }),
  writeSessionTerminal: mocks.writeSessionTerminal,
  resizeSessionTerminal: async () => {},
  closeSessionTerminal: () => {},
  subscribeSessionTerminal: (_id: string, listener: (message: unknown) => void) => {
    mocks.subscribers.add(listener);
    return () => mocks.subscribers.delete(listener);
  },
}));

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRouteDispatcher, createStudioHandler } from '../../../server/app';
import { requireUser } from '../access';
import { revokeUser } from '../auth-state';
import { POST as terminalPost, GET as terminalGet } from '../../../app/api/sessions/[id]/terminal/route';
import { Readable } from 'node:stream';
import { fromBase64, messageNonce, NonceKind, openBox, openSecret, sealBox, sealSecret, sessionKey, toBase64 } from './crypto';
import { isPhoneHttpRoute, isPhoneStreamRoute, PhoneGateway, defaultUserValid } from './gateway';
import { createPhoneHttpHandler, isPrivateIPv4, isPrivatePeer, phoneGateway, phoneHosts, phoneListening, setPhoneDispatcher, setPhoneEnabled, startPhoneListener, stopPhoneListener } from './listener';
import { assertPhoneManager } from './manage';
import { cancelPairing, MAX_PENDING_PAIRINGS, addDevice, removeDevice, checkPairingCode, createPairingCode, listDevices, pendingPairing, readSettings, resetPhoneState, serverKeys, writeSettings } from './state';

let dir: string;
const SECRET = 's'.repeat(40);
const route = (pattern: string, module: Record<string, unknown>) => ({ pattern, load: () => Promise.resolve(module) });
const routes = [
  route('/api/sessions', { GET: (request: Request) => Response.json({ user: requireUser(request.headers), sessions: [...mocks.sessions.keys()] }) }),
  route('/api/sessions/[id]/terminal', { GET: terminalGet, POST: terminalPost }),
  route('/api/ai-accounts', { GET: () => Response.json({ secret: 'no' }) }),
  route('/api/sessions/[id]/changes', { GET: () => mocks.hugeResponse() }),
];

function personalPc(): void {
  vi.stubEnv('B_STUDIO_AUTH', 'none');
}

function serverMode(): void {
  vi.stubEnv('B_STUDIO_AUTH', 'token');
  vi.stubEnv('B_STUDIO_AUTH_SECRET', SECRET);
  vi.stubEnv('B_STUDIO_AUTH_TOKENS', `kim:${'k'.repeat(32)},lee:${'l'.repeat(32)},root:${'r'.repeat(32)}`);
  vi.stubEnv('B_STUDIO_AUTH_ADMINS', 'root');
  vi.stubEnv('B_STUDIO_SERVER_TERMINAL', '1');
  vi.stubEnv('B_STUDIO_TERMINAL', 'container');
  vi.stubEnv('B_STUDIO_EXPERIMENTAL', '1');
  vi.stubEnv('B_STUDIO_PHONE', '1');
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'b-studio-phone-test-'));
  vi.stubEnv('B_STUDIO_PHONE_DIR', path.join(dir, 'phone'));
  vi.stubEnv('B_STUDIO_LOCAL_TOKEN_FILE', path.join(dir, 'local-token'));
  vi.stubEnv('B_STUDIO_AUTH_STATE_DIR', path.join(dir, 'auth'));
  vi.stubEnv('B_STUDIO_PHONE_HOSTS', '127.0.0.1');
  resetPhoneState();
  mocks.sessions.clear();
  mocks.sessions.set('kimses01', { owner: 'kim', projectId: 'orders' });
  mocks.sessions.set('leeses01', { owner: 'lee', projectId: 'orders' });
  mocks.writeSessionTerminal.mockClear();
  mocks.subscribers.clear();
  mocks.pulled = 0;
  mocks.cancelled = false;
  // 끝없이 큰 본문(선언된 길이 없음). 상한을 넘으면 읽기를 멈추고 취소해야 한다
  mocks.hugeResponse = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          mocks.pulled += 1;
          controller.enqueue(new Uint8Array(1024 * 1024).fill(120));
        },
        cancel() {
          mocks.cancelled = true;
        },
      }),
    );
  setPhoneDispatcher(createRouteDispatcher(routes));
  (globalThis as { __bStudioLocalToken?: string }).__bStudioLocalToken = undefined;
});

afterEach(async () => {
  await stopPhoneListener();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

// ─── 가짜 휴대폰 ───

class FakePhone {
  readonly keys = nacl.box.keyPair();
  deviceId = '';
  token = '';
  sid = '';
  key?: Uint8Array;
  seq = 0;
  constructor(
    readonly base: string,
    readonly serverPublic: Uint8Array,
  ) {}

  async post(pathname: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${this.base}${pathname}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  pairBody(code: string, name = '내 폰'): unknown {
    const nonce = nacl.randomBytes(24);
    const cipher = nacl.box(new TextEncoder().encode(JSON.stringify({ code, name })), nonce, this.serverPublic, this.keys.secretKey);
    return { v: 1, pk: Buffer.from(this.keys.publicKey).toString('base64'), n: Buffer.from(nonce).toString('base64'), c: Buffer.from(cipher).toString('base64') };
  }

  async pair(code: string, name?: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const result = await this.post('/phone/v1/pair', this.pairBody(code, name));
    if (result.status === 200) {
      const plain = nacl.box.open(Buffer.from(result.json.c as string, 'base64'), Buffer.from(result.json.n as string, 'base64'), this.serverPublic, this.keys.secretKey);
      const reply = JSON.parse(new TextDecoder().decode(plain!)) as { deviceId: string; token: string };
      this.deviceId = reply.deviceId;
      this.token = reply.token;
    }
    return result;
  }

  async hello(): Promise<string> {
    const response = await fetch(`${this.base}/phone/v1/hello`);
    return ((await response.json()) as { challenge: string }).challenge;
  }

  openBody(challenge: string, ephemeral = nacl.box.keyPair()): { body: unknown; ephemeral: nacl.BoxKeyPair } {
    const nonce = nacl.randomBytes(24);
    const plain = new TextEncoder().encode(JSON.stringify({ token: this.token, challenge, epk: Buffer.from(ephemeral.publicKey).toString('base64') }));
    const cipher = nacl.box(plain, nonce, this.serverPublic, this.keys.secretKey);
    return { body: { v: 1, d: this.deviceId, n: Buffer.from(nonce).toString('base64'), c: Buffer.from(cipher).toString('base64') }, ephemeral };
  }

  async open(): Promise<{ status: number; json: Record<string, unknown> }> {
    const { body, ephemeral } = this.openBody(await this.hello());
    const result = await this.post('/phone/v1/open', body);
    if (result.status === 200) {
      const plain = nacl.box.open(Buffer.from(result.json.c as string, 'base64'), Buffer.from(result.json.n as string, 'base64'), this.serverPublic, this.keys.secretKey);
      const reply = JSON.parse(new TextDecoder().decode(plain!)) as { sid: string; epk: string };
      this.sid = reply.sid;
      this.key = nacl.box.before(Buffer.from(reply.epk, 'base64'), ephemeral.secretKey);
      this.seq = 0;
    }
    return result;
  }

  /** 시험이 번호를 고르는 요청 상자 */
  rpcBody(op: unknown, seq: number, key = this.key!, sid = this.sid): unknown {
    const nonce = new Uint8Array(24);
    nonce[0] = 1;
    new DataView(nonce.buffer).setBigUint64(8, BigInt(seq), false);
    const cipher = nacl.secretbox(new TextEncoder().encode(JSON.stringify(op)), nonce, key);
    return { s: sid, q: seq, c: Buffer.from(cipher).toString('base64') };
  }

  async rpc(op: unknown): Promise<Record<string, unknown>> {
    const seq = ++this.seq;
    const result = await this.post('/phone/v1/rpc', this.rpcBody(op, seq));
    if (result.status !== 200) throw Object.assign(new Error(`HTTP ${result.status}`), { status: result.status, json: result.json });
    const nonce = new Uint8Array(24);
    nonce[0] = 2;
    new DataView(nonce.buffer).setBigUint64(8, BigInt(result.json.q as number), false);
    const plain = nacl.secretbox.open(Buffer.from(result.json.c as string, 'base64'), nonce, this.key!);
    if (!plain) throw new Error('응답을 열 수 없습니다');
    return JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
  }

  async rpcStatus(op: unknown): Promise<number> {
    return (await this.post('/phone/v1/rpc', this.rpcBody(op, ++this.seq))).status;
  }
}

async function startPhoneSide(user = 'local'): Promise<{ phone: FakePhone; base: string; code: () => string }> {
  writeSettings({ enabled: true });
  const listening = await startPhoneListener({ env: process.env, port: 0 });
  const base = `http://127.0.0.1:${listening.port}`;
  const phone = new FakePhone(base, serverKeys().publicKey);
  return { phone, base, code: () => createPairingCode(user, Date.now()).code };
}

async function pairedPhone(user = 'local'): Promise<FakePhone> {
  const side = await startPhoneSide(user);
  expect((await side.phone.pair(side.code())).status).toBe(200);
  expect((await side.phone.open()).status).toBe(200);
  return side.phone;
}

const get = (pathname: string) => ({ op: 'http', method: 'GET', path: pathname });

describe('스위치와 주소: 짝짓기를 켰을 때만 사설 주소에 귀를 연다', () => {
  it('기본은 꺼짐이다. 꺼져 있으면 귀가 없고, 설정 파일이 없거나 깨져도 꺼짐이다', () => {
    personalPc();
    expect(readSettings().enabled).toBe(false);
    expect(phoneListening()).toBeUndefined();
    resetPhoneState();
    writeFileSync(path.join(dir, 'phone-bad'), 'x');
    expect(readSettings().enabled).toBe(false);
  });

  it('꺼짐 상태의 gateway는 모든 경로를 없는 것처럼 404로 답한다', async () => {
    personalPc();
    const gateway = new PhoneGateway({ dispatch: createRouteDispatcher(routes) });
    for (const [method, path] of [['GET', '/phone/v1/hello'], ['POST', '/phone/v1/pair'], ['POST', '/phone/v1/open'], ['POST', '/phone/v1/rpc']] as const) {
      expect(await gateway.handle({ method, path, body: new Uint8Array([123, 125]), peer: 'p' })).toEqual({ status: 404, body: { error: 'not_found' } });
    }
  });

  it('켜면 귀가 열리고, 끄면 닫혀 연결이 거절된다(열린 세션도 버린다)', async () => {
    personalPc();
    const side = await startPhoneSide();
    expect((await fetch(`${side.base}/phone/v1/hello`)).status).toBe(200);
    expect(phoneListening()?.hosts).toEqual(['127.0.0.1']);
    await setPhoneEnabled(false);
    expect(readSettings().enabled).toBe(false);
    await expect(fetch(`${side.base}/phone/v1/hello`)).rejects.toThrow();
    expect(phoneGateway()).toBeUndefined();
  });

  it('귀가 알고 있는 경로는 /phone/v1 네 개뿐이다(그 밖의 API는 이 귀에 없다)', async () => {
    personalPc();
    const side = await startPhoneSide();
    for (const p of ['/api/sessions', '/api/health', '/', '/phone/v1/other', '/phone/v1/hello?x=1', '/phone/v1/../api/sessions']) {
      expect((await fetch(`${side.base}${p}`)).status).toBe(404);
    }
    expect((await fetch(`${side.base}/phone/v1/hello`, { method: 'DELETE' })).status).toBe(405);
  });

  it('주소 고르기: 사설 IPv4만(공인·루프백·내부 주소 제외). 운영자가 정하면 그 값', () => {
    const iface = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '', mac: '', cidr: null });
    const interfaces = { en0: [iface('192.168.0.5'), iface('8.8.8.8')], lo0: [iface('127.0.0.1', true)], utun: [iface('100.101.102.103'), iface('10.0.0.2'), iface('172.32.0.1'), iface('169.254.3.4')] };
    expect(phoneHosts({}, interfaces)).toEqual(['192.168.0.5', '100.101.102.103', '10.0.0.2', '169.254.3.4']);
    expect(phoneHosts({ B_STUDIO_PHONE_HOSTS: '10.9.9.9, 10.9.9.9' }, interfaces)).toEqual(['10.9.9.9']);
    expect(phoneHosts({}, { lo0: [iface('127.0.0.1', true)] })).toEqual([]);
  });

  it('상대 주소 판정: 사설·루프백만. 공인·모르는 꼴·IPv4-mapped의 공인 주소는 아니다', () => {
    for (const ok of ['192.168.1.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '100.64.0.1', '127.0.0.1', '::1', '::ffff:192.168.1.9', 'fd12::1', 'fe80::1']) expect(isPrivatePeer(ok), ok).toBe(true);
    for (const no of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '::ffff:8.8.8.8', '2001:db8::1', '', undefined, '192.168.1', '192.168.1.256', '1.1.1.1', 'localhost']) expect(isPrivatePeer(no), String(no)).toBe(false);
    expect(isPrivateIPv4('192.168.001.9')).toBe(true);
  });

  it('인증을 켠 서버는 운영자가 B_STUDIO_PHONE=1을 적어야 켤 수 있다', async () => {
    vi.stubEnv('B_STUDIO_AUTH', 'token');
    vi.stubEnv('B_STUDIO_AUTH_SECRET', SECRET);
    vi.stubEnv('B_STUDIO_AUTH_TOKENS', `kim:${'k'.repeat(32)}`);
    await expect(setPhoneEnabled(true)).rejects.toThrow('허용하지 않습니다');
    expect(readSettings().enabled).toBe(false);
    vi.stubEnv('B_STUDIO_PHONE', 'yes');
    await expect(setPhoneEnabled(true)).rejects.toThrow('허용하지 않습니다');
  });

  it('귀를 열지 못하면 스위치를 켜지 않는다', async () => {
    personalPc();
    vi.stubEnv('B_STUDIO_PHONE_HOSTS', '203.0.113.77');
    await expect(setPhoneEnabled(true)).rejects.toThrow();
    expect(readSettings().enabled).toBe(false);
  });
});

describe('저장: 키와 기기 목록은 600, 링크·넓은 권한은 쓰지 않는다', () => {
  it('서버 키와 기기 목록은 0600, 폴더는 0700이고 비밀 키가 목록에 들어 있지 않다', () => {
    personalPc();
    serverKeys();
    addDevice({ name: '폰', publicKey: Buffer.from(nacl.box.keyPair().publicKey).toString('base64'), tokenHash: 'a'.repeat(64), user: 'local' }, Date.now());
    const phoneDir = path.join(dir, 'phone');
    expect(statSync(phoneDir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(phoneDir, 'server-key.json')).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(phoneDir, 'devices.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(phoneDir, 'devices.json'), 'utf8')).not.toContain('secretKey');
  });

  it('서버 키 파일의 권한이 넓으면 쓰지 않고 던진다(새로 만들어 기기를 끊지도 않는다)', () => {
    serverKeys();
    resetPhoneState();
    chmodSync(path.join(dir, 'phone', 'server-key.json'), 0o644);
    expect(() => serverKeys()).toThrow('권한이 넓습니다');
  });

  it('기기 목록의 권한이 넓으면 기기가 없는 것으로 둔다(fail-closed)', () => {
    personalPc();
    addDevice({ name: '폰', publicKey: Buffer.from(nacl.box.keyPair().publicKey).toString('base64'), tokenHash: 'a'.repeat(64), user: 'local' }, Date.now());
    resetPhoneState();
    chmodSync(path.join(dir, 'phone', 'devices.json'), 0o666);
    expect(listDevices()).toEqual([]);
  });
});

describe('짝 코드: 한 번만, 짧은 시간, 틀린 횟수 제한', () => {
  it('맞는 코드는 한 번만 통한다(재사용은 거절)', () => {
    const { code } = createPairingCode('kim', 1000);
    expect(checkPairingCode(code, 2000)).toEqual({ ok: true, user: 'kim' });
    expect(checkPairingCode(code, 2000)).toEqual({ ok: false, reason: 'none' });
  });

  it('만료된 코드는 거절하고 지운다', () => {
    const { code } = createPairingCode('kim', 1000);
    expect(checkPairingCode(code, 1000 + 120_000)).toEqual({ ok: false, reason: 'none' });
    expect(checkPairingCode(code, 1001)).toEqual({ ok: false, reason: 'none' });
    expect(pendingPairing('kim', 1001)).toBeUndefined();
  });

  it('틀린 횟수가 5번이면 맞는 코드도 쓸 수 없다', () => {
    const { code } = createPairingCode('kim', 1000);
    for (let i = 0; i < 5; i++) expect(checkPairingCode('WRONGWRONG', 1100)).toEqual({ ok: false, reason: i < 4 ? 'wrong' : 'wrong' });
    expect(checkPairingCode(code, 1200)).toEqual({ ok: false, reason: 'none' });
  });

  it('새 코드를 만들면 앞의 코드는 못 쓰고, 코드는 10자 알파벳이다', () => {
    const first = createPairingCode('kim', 1000);
    const second = createPairingCode('kim', 1000);
    expect(first.code).not.toBe(second.code);
    expect(second.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect(checkPairingCode(first.code, 1001).ok).toBe(false);
  });

  it('HTTP로: 코드 재사용·만료·틀림 초과·평문·다른 서버 키로 쓴 상자를 거절한다', async () => {
    personalPc();
    const side = await startPhoneSide();
    const code = side.code();
    const first = await side.phone.pair(code);
    expect(first.status).toBe(200);
    expect(listDevices()).toHaveLength(1);
    // 같은 코드를 다른 기기가 다시 쓴다
    const second = new FakePhone(side.base, serverKeys().publicKey);
    expect((await second.pair(code)).status).toBe(403);
    // 가로챈 요청을 그대로 다시 보낸다(코드는 이미 소진)
    expect((await side.phone.post('/phone/v1/pair', side.phone.pairBody(code))).status).toBe(403);
    // 평문 JSON
    expect((await side.phone.post('/phone/v1/pair', { v: 1, code })).status).toBe(400);
    // 다른 서버 키로 만든 상자(서버가 열지 못한다)
    const stranger = new FakePhone(side.base, nacl.box.keyPair().publicKey);
    expect((await stranger.pair(side.code())).status).toBe(403);
    expect(listDevices()).toHaveLength(1);
    // 틀린 코드 5번이면 새 코드도 아닌 그 코드는 소진
    const real = side.code();
    for (let i = 0; i < 5; i++) expect((await new FakePhone(side.base, serverKeys().publicKey).pair('AAAAAAAAAA')).status).toBe(403);
    expect((await new FakePhone(side.base, serverKeys().publicKey).pair(real)).status).toBe(403);
    expect(listDevices()).toHaveLength(1);
  });

  it('만료된 코드는 HTTP로도 거절한다', async () => {
    personalPc();
    writeSettings({ enabled: true });
    let now = 1_000_000;
    const gateway = new PhoneGateway({ dispatch: createRouteDispatcher(routes), now: () => now });
    const code = createPairingCode('local', now).code;
    now += 120_001;
    const phone = new FakePhone('http://unused', serverKeys().publicKey);
    const response = await gateway.handle({ method: 'POST', path: '/phone/v1/pair', body: new TextEncoder().encode(JSON.stringify(phone.pairBody(code))), peer: 'p' });
    expect(response.status).toBe(403);
    expect(listDevices()).toEqual([]);
  });

  it('같은 주소에서 실패가 10번 쌓이면 429로 잠시 막는다', async () => {
    personalPc();
    writeSettings({ enabled: true });
    const gateway = new PhoneGateway({ dispatch: createRouteDispatcher(routes) });
    const attempt = () => gateway.handle({ method: 'POST', path: '/phone/v1/pair', body: new TextEncoder().encode(JSON.stringify(new FakePhone('x', serverKeys().publicKey).pairBody('AAAAAAAAAA'))), peer: '9.9.9.9' });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(403);
    expect((await attempt()).status).toBe(429);
    expect((await gateway.handle({ method: 'POST', path: '/phone/v1/pair', body: new TextEncoder().encode('{}'), peer: '8.8.4.4' })).status).toBe(400);
  });

  it('기기는 10대까지, 이름의 제어·방향 문자는 지운다', async () => {
    personalPc();
    const side = await startPhoneSide();
    const phone = side.phone;
    expect((await phone.pair(side.code(), 'a‮b\u0000c'.padEnd(60, 'x'))).status).toBe(200);
    expect(listDevices()[0]!.name).toBe('abc' + 'x'.repeat(37));
    for (let i = 0; i < 9; i++) expect((await new FakePhone(side.base, serverKeys().publicKey).pair(side.code())).status).toBe(200);
    expect((await new FakePhone(side.base, serverKeys().publicKey).pair(side.code())).status).toBe(409);
  });
});

describe('세션과 요청: 암호·번호·끊기', () => {
  it('정상 왕복: 짝 맺기 → 세션 열기 → 세션 목록(개인 PC는 local 사용자)', async () => {
    personalPc();
    const phone = await pairedPhone();
    const result = await phone.rpc(get('/api/sessions'));
    expect(result).toMatchObject({ ok: true, status: 200, json: { user: 'local', sessions: ['kimses01', 'leeses01'] } });
    expect(await phone.rpc({ op: 'ping' })).toMatchObject({ ok: true });
  });

  it('평문 요청과 상자를 열 수 없는 요청은 거절한다', async () => {
    personalPc();
    const phone = await pairedPhone();
    expect((await phone.post('/phone/v1/rpc', { op: 'http', method: 'GET', path: '/api/sessions' })).status).toBe(400);
    expect((await phone.post('/phone/v1/rpc', { s: phone.sid, q: 5, c: Buffer.from('평문').toString('base64') })).status).toBe(403);
    // 잘린 상자(변조)
    const body = phone.rpcBody({ op: 'ping' }, 9) as { s: string; q: number; c: string };
    const tampered = Buffer.from(body.c, 'base64');
    tampered[tampered.length - 1]! ^= 1;
    expect((await phone.post('/phone/v1/rpc', { ...body, c: tampered.toString('base64') })).status).toBe(403);
    // 정상 요청은 계속 된다(위조가 번호를 올리지 못했다)
    expect(await phone.rpc({ op: 'ping' })).toMatchObject({ ok: true });
  });

  it('다른 기기의 열쇠로 만든 요청과 모르는 세션 id는 거절한다', async () => {
    personalPc();
    const side = await startPhoneSide();
    const one = side.phone;
    expect((await one.pair(side.code())).status).toBe(200);
    expect((await one.open()).status).toBe(200);
    const two = new FakePhone(side.base, serverKeys().publicKey);
    expect((await two.pair(side.code())).status).toBe(200);
    expect((await two.open()).status).toBe(200);
    // 두 번째 기기의 열쇠로 첫 번째 세션 id에 보낸다
    expect((await one.post('/phone/v1/rpc', two.rpcBody({ op: 'ping' }, 1, two.key!, one.sid))).status).toBe(403);
    expect((await one.post('/phone/v1/rpc', two.rpcBody({ op: 'ping' }, 1, two.key!, 'f'.repeat(32)))).status).toBe(401);
    // 다른 기기의 토큰·열쇠로는 세션을 열지 못한다
    const forged = new FakePhone(side.base, serverKeys().publicKey);
    forged.deviceId = one.deviceId;
    forged.token = two.token;
    expect((await forged.open()).status).toBe(403);
    one.token = two.token;
    expect((await one.open()).status).toBe(403);
  });

  it('재전송과 번호 역행을 거절한다', async () => {
    personalPc();
    const phone = await pairedPhone();
    await phone.rpc({ op: 'ping' });
    await phone.rpc({ op: 'ping' });
    const sent = phone.rpcBody({ op: 'ping' }, 2);
    expect((await phone.post('/phone/v1/rpc', sent)).status).toBe(409);
    expect((await phone.post('/phone/v1/rpc', phone.rpcBody({ op: 'ping' }, 1))).status).toBe(409);
    phone.seq = 2;
    expect(await phone.rpc({ op: 'ping' })).toMatchObject({ ok: true });
    // 번호 0·음수·소수·문자열
    for (const q of [0, -1, 1.5, '4', 2 ** 53]) expect((await phone.post('/phone/v1/rpc', { s: phone.sid, q, c: 'AAAA' })).status).toBe(400);
  });

  it('세션 열기의 재전송: 도전값은 한 번만, 만료되면 거절', async () => {
    personalPc();
    const side = await startPhoneSide();
    expect((await side.phone.pair(side.code())).status).toBe(200);
    const challenge = await side.phone.hello();
    const { body } = side.phone.openBody(challenge);
    expect((await side.phone.post('/phone/v1/open', body)).status).toBe(200);
    expect((await side.phone.post('/phone/v1/open', body)).status).toBe(403);
    expect((await side.phone.post('/phone/v1/open', side.phone.openBody('0'.repeat(32)).body)).status).toBe(403);
  });

  it('기기를 끊으면 열린 세션이 그 자리에서 거절되고 새 세션도 못 연다', async () => {
    personalPc();
    const phone = await pairedPhone();
    expect(await phone.rpc({ op: 'ping' })).toMatchObject({ ok: true });
    expect(phoneGateway()!.revokeDevice(phone.deviceId)).toBe(true);
    expect(listDevices()).toEqual([]);
    expect(await phone.rpcStatus({ op: 'ping' })).toBe(401);
    expect((await phone.open()).status).toBe(403);
    // 파일에서도 사라졌다
    resetPhoneState();
    expect(listDevices()).toEqual([]);
  });

  it('끊으면 열린 터미널 흐름도 닫는다', async () => {
    personalPc();
    const phone = await pairedPhone();
    const opened = await phone.rpc({ op: 'stream.open', path: '/api/sessions/kimses01/terminal' });
    expect(opened.ok).toBe(true);
    expect(mocks.subscribers.size).toBe(1);
    phoneGateway()!.revokeDevice(phone.deviceId);
    await vi.waitFor(() => expect(mocks.subscribers.size).toBe(0));
  });

  it('스위치를 끄면 세션이 사라진다(다시 켜도 옛 세션 id로는 못 쓴다)', async () => {
    personalPc();
    const phone = await pairedPhone();
    await setPhoneEnabled(false);
    await setPhoneEnabled(true);
    const listening = phoneListening()!;
    const again = Object.assign(Object.create(Object.getPrototypeOf(phone)), phone, { base: `http://127.0.0.1:${listening.port}` }) as FakePhone;
    expect(await again.rpcStatus({ op: 'ping' })).toBe(401);
    expect((await again.open()).status).toBe(200);
  });

  it('세션은 오래 쓰지 않으면 만료된다', async () => {
    personalPc();
    writeSettings({ enabled: true });
    let now = 5_000_000;
    const gateway = new PhoneGateway({ dispatch: createRouteDispatcher(routes), now: () => now });
    const phone = new FakePhone('x', serverKeys().publicKey);
    const send = async (path: string, body: unknown, method = 'POST') => gateway.handle({ method, path, body: method === 'POST' ? new TextEncoder().encode(JSON.stringify(body)) : undefined, peer: 'p' });
    const pair = await send('/phone/v1/pair', phone.pairBody(createPairingCode('local', now).code));
    const reply = JSON.parse(new TextDecoder().decode(nacl.box.open(fromBase64((pair.body as { c: string }).c)!, fromBase64((pair.body as { n: string }).n)!, serverKeys().publicKey, phone.keys.secretKey)!)) as { deviceId: string; token: string };
    phone.deviceId = reply.deviceId;
    phone.token = reply.token;
    const hello = (await send('/phone/v1/hello', undefined, 'GET')).body as { challenge: string };
    const opened = phone.openBody(hello.challenge);
    const open = await send('/phone/v1/open', opened.body);
    const sessionReply = JSON.parse(new TextDecoder().decode(nacl.box.open(fromBase64((open.body as { c: string }).c)!, fromBase64((open.body as { n: string }).n)!, serverKeys().publicKey, phone.keys.secretKey)!)) as { sid: string; epk: string };
    phone.sid = sessionReply.sid;
    phone.key = nacl.box.before(fromBase64(sessionReply.epk)!, opened.ephemeral.secretKey);
    expect((await send('/phone/v1/rpc', phone.rpcBody({ op: 'ping' }, 1))).status).toBe(200);
    now += 31 * 60_000;
    expect((await send('/phone/v1/rpc', phone.rpcBody({ op: 'ping' }, 2))).status).toBe(401);
    expect(messageNonce(NonceKind.request, 1)[0]).toBe(1);
  });

  it('요청 크기 상한: 선언이 크면 본문을 읽기 전에 거절하고, 선언이 거짓이어도 읽는 동안 센다', async () => {
    personalPc();
    const side = await startPhoneSide();
    expect((await fetch(`${side.base}/phone/v1/open`, { method: 'POST', body: 'x'.repeat(9 * 1024) })).status).toBe(413);
    const big = await fetch(`${side.base}/phone/v1/rpc`, { method: 'POST', body: 'x'.repeat(600 * 1024) });
    expect(big.status).toBe(413);
    const chunked = await fetch(`${side.base}/phone/v1/pair`, { method: 'POST', body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"a":"' + 'x'.repeat(20_000) + '"}')); controller.close(); } }), duplex: 'half' } as RequestInit);
    expect(chunked.status).toBe(413);
    const empty = await fetch(`${side.base}/phone/v1/pair`, { method: 'POST' });
    expect(empty.status).toBe(400);
  });

  it('허용 목록 밖의 경로·메서드·쿼리는 암호 통로 안에서도 거절한다', async () => {
    personalPc();
    const phone = await pairedPhone();
    const denied = async (op: unknown) => expect(await phone.rpc(op), JSON.stringify(op)).toEqual({ ok: false, error: 'route_not_allowed' });
    await denied(get('/api/ai-accounts'));
    await denied(get('/api/sessions/kimses01/terminal/'));
    await denied(get('/api/sessions/../ai-accounts'));
    await denied(get('/api/sessions/kim%2Fx/changes'));
    await denied(get('/api/sessions/kimses01/status?x=1'));
    await denied(get('/api/sessions?a=%2e'));
    await denied({ op: 'http', method: 'DELETE', path: '/api/sessions' });
    await denied({ op: 'http', method: 'POST', path: '/api/sessions' });
    await denied({ op: 'http', method: 'get', path: '/api/sessions' });
    await denied({ op: 'http', method: 'GET', path: 'http://evil.example/api/sessions' });
    await denied({ op: 'stream.open', path: '/api/sessions/kimses01/terminal?x=1' });
    await denied({ op: 'stream.open', path: '/api/ai-accounts' });
    expect(await phone.rpc(get('/api/sessions?limit=5'))).toMatchObject({ ok: true, status: 200 });
    expect(isPhoneHttpRoute('GET', '/api/sessions/a-b_9/changes')).toBe(true);
    expect(isPhoneStreamRoute('/api/agents/stream')).toBe(true);
  });

  it('응답이 상한(4MiB)을 넘으면 읽다가 멈추고 too_large로 답한다', async () => {
    personalPc();
    const phone = await pairedPhone();
    expect(await phone.rpc(get('/api/sessions/kimses01/changes'))).toEqual({ ok: false, error: 'too_large' });
    // 끝없는 본문을 상한 뒤로 계속 읽지 않고 취소한다
    expect(mocks.cancelled).toBe(true);
    expect(mocks.pulled).toBeLessThan(12);
  });

  it('알 수 없는 op와 깨진 본문은 오류로 답한다(서버가 죽지 않는다)', async () => {
    personalPc();
    const phone = await pairedPhone();
    expect(await phone.rpc({ op: 'shell' })).toEqual({ ok: false, error: 'unknown_op' });
    expect(await phone.rpc([1, 2])).toEqual({ ok: false, error: 'bad_request' });
    expect(await phone.rpc({ op: 'stream.read', stream: 'nope' })).toEqual({ ok: false, error: 'no_stream' });
  });
});

describe('터미널 흐름과 입력', () => {
  it('흐름: 서버가 안쪽 SSE를 받아 두고 긴 기다림으로 순서대로 건넨다', async () => {
    personalPc();
    const phone = await pairedPhone();
    const opened = (await phone.rpc({ op: 'stream.open', path: '/api/sessions/kimses01/terminal' })) as { ok: boolean; stream: string };
    expect(opened.ok).toBe(true);
    const pending = phone.rpc({ op: 'stream.read', stream: opened.stream, after: 0, waitMs: 5000 });
    await vi.waitFor(() => expect(mocks.subscribers.size).toBe(1));
    for (const listener of mocks.subscribers) {
      listener({ type: 'output', data: 'aGk=' });
      listener({ type: 'output', data: 'eW8=' });
    }
    const first = (await pending) as { events: Array<{ i: number; data: string }>; next: number };
    expect(first.events.map((event) => JSON.parse(event.data).data)).toContain('aGk=');
    const all = [...first.events];
    if (all.length < 2) all.push(...((await phone.rpc({ op: 'stream.read', stream: opened.stream, after: first.next, waitMs: 2000 })) as { events: typeof all }).events);
    expect(all.map((event) => event.i)).toEqual([0, 1]);
    // 받았다고 알리면 앞은 버리고, 새것이 없으면 빈 목록으로 돌아온다
    expect(await phone.rpc({ op: 'stream.read', stream: opened.stream, after: 2, waitMs: 10 })).toMatchObject({ ok: true, events: [], next: 2 });
    expect(await phone.rpc({ op: 'stream.close', stream: opened.stream })).toEqual({ ok: true });
    await vi.waitFor(() => expect(mocks.subscribers.size).toBe(0));
    expect(await phone.rpc({ op: 'stream.read', stream: opened.stream })).toEqual({ ok: false, error: 'no_stream' });
  });

  it('다른 기기의 흐름 id로는 읽지도 닫지도 못한다', async () => {
    personalPc();
    const side = await startPhoneSide();
    const one = side.phone;
    await one.pair(side.code());
    await one.open();
    const two = new FakePhone(side.base, serverKeys().publicKey);
    await two.pair(side.code());
    await two.open();
    const opened = (await one.rpc({ op: 'stream.open', path: '/api/sessions/kimses01/terminal' })) as { stream?: string };
    const mine = opened.stream ?? '';
    expect(mine).not.toBe('');
    expect(await two.rpc({ op: 'stream.read', stream: mine })).toEqual({ ok: false, error: 'no_stream' });
    expect(await two.rpc({ op: 'stream.close', stream: mine })).toEqual({ ok: false, error: 'no_stream' });
  });

  it('입력: 개인 PC에서는 열고 입력한다(로컬 토큰·이 컴퓨터 주소 검사를 안쪽 요청이 통과한다)', async () => {
    personalPc();
    const phone = await pairedPhone();
    const result = await phone.rpc({ op: 'http', method: 'POST', path: '/api/sessions/kimses01/terminal', body: { action: 'input', data: 'ls\r' } });
    expect(result).toMatchObject({ ok: true, status: 200, json: { ok: true } });
    expect(mocks.writeSessionTerminal).toHaveBeenCalledWith('kimses01', 'ls\r');
  });
});

describe('권한: 기기는 짝 맺은 사용자의 권한만 갖는다(서버 방식)', () => {
  const write = (phone: FakePhone, id: string) => phone.rpc({ op: 'http', method: 'POST', path: `/api/sessions/${id}/terminal`, body: { action: 'input', data: 'x' } });

  it('만든 사람의 기기는 자기 세션에만 쓴다. 남의 세션 쓰기는 403이고 터미널에 닿지 않는다', async () => {
    serverMode();
    const phone = await pairedPhone('kim');
    expect(await write(phone, 'kimses01')).toMatchObject({ ok: true, status: 200 });
    expect(mocks.writeSessionTerminal).toHaveBeenCalledTimes(1);
    expect(await write(phone, 'leeses01')).toMatchObject({ ok: true, status: 403 });
    expect(await write(phone, 'nope0000')).toMatchObject({ ok: true, status: 404 });
    expect(mocks.writeSessionTerminal).toHaveBeenCalledTimes(1);
  });

  it('관리자의 기기도 남의 세션에는 쓰지 못한다(관리자 권한이 아니다)', async () => {
    serverMode();
    const phone = await pairedPhone('root');
    expect(await write(phone, 'kimses01')).toMatchObject({ ok: true, status: 403 });
    expect(mocks.writeSessionTerminal).not.toHaveBeenCalled();
  });

  it('손님이 낸 사용자 헤더·Host·쿠키는 안쪽 요청에 닿지 않는다(사용자는 기기에 적힌 값뿐)', async () => {
    serverMode();
    const phone = await pairedPhone('kim');
    const body = phone.rpcBody({ op: 'http', method: 'GET', path: '/api/sessions', headers: { 'x-b-studio-user': 'root', host: 'evil' }, user: 'root' }, ++phone.seq);
    const result = await phone.post('/phone/v1/rpc', body);
    const nonce = new Uint8Array(24);
    nonce[0] = 2;
    new DataView(nonce.buffer).setBigUint64(8, BigInt(result.json.q as number), false);
    const plain = JSON.parse(new TextDecoder().decode(nacl.secretbox.open(Buffer.from(result.json.c as string, 'base64'), nonce, phone.key!)!)) as { json: { user: string } };
    expect(plain.json.user).toBe('kim');
  });

  it('토큰 방식: 토큰 목록에서 빠진 사용자와 무효화한 사용자의 기기는 거절한다', async () => {
    serverMode();
    const phone = await pairedPhone('kim');
    expect(await phone.rpc({ op: 'ping' })).toMatchObject({ ok: true });
    await revokeUser('kim', Date.now() + 1000, path.join(dir, 'auth'));
    expect(await phone.rpcStatus({ op: 'ping' })).toBe(401);
    const device = { id: 'a'.repeat(32), name: 'x', publicKey: '', tokenHash: '', user: 'ghost', createdAt: 1, lastSeenAt: 1 };
    expect(defaultUserValid(device)).toBe(false);
    expect(defaultUserValid({ ...device, user: 'lee' })).toBe(true);
  });

  it('인증 설정이 틀리면 기기를 받지 않는다', () => {
    vi.stubEnv('B_STUDIO_AUTH', 'bogus');
    expect(defaultUserValid({ id: 'a'.repeat(32), name: 'x', publicKey: '', tokenHash: '', user: 'kim', createdAt: 1, lastSeenAt: 1 })).toBe(false);
  });
});

describe('본 서버는 그대로: 밖 주소로 온 요청과 휴대폰 경로', () => {
  it('본 서버(인증 없음)는 사설 주소의 Host로 온 요청을 지금처럼 거절한다', async () => {
    personalPc();
    const server: Server = createServer(createStudioHandler({ routes, env: { B_STUDIO_AUTH: 'none' } }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const { request } = await import('node:http');
      const send = (host: string, p: string) =>
        new Promise<number>((resolve, reject) => {
          const req = request({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on('error', reject);
          req.end();
        });
      expect(await send('192.168.0.5:3000', '/api/sessions')).toBe(403);
      expect(await send('127.0.0.1:3000', '/api/sessions')).toBe(200);
      // 휴대폰 경로는 본 서버에 없다
      expect(await send('127.0.0.1:3000', '/phone/v1/hello')).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('desk용 관리 경로는 이 컴퓨터의 주소로 온 요청만 받는다(인증을 켠 서버의 다른 주소 예외를 쓰지 않는다)', () => {
    personalPc();
    expect(() => assertPhoneManager(new Headers({ host: '192.168.0.5:3000' }))).toThrow('이 컴퓨터의 주소');
    serverMode();
    expect(() => assertPhoneManager(new Headers({ host: 'studio.example.com', 'x-b-studio-user': 'kim' }))).toThrow('이 컴퓨터의 주소');
    expect(assertPhoneManager(new Headers({ host: '127.0.0.1:3000', 'x-b-studio-user': 'kim' }))).toBe('kim');
  });

  it('개인 PC의 관리 경로는 로컬 토큰이 없으면 거절한다', () => {
    personalPc();
    expect(() => assertPhoneManager(new Headers({ host: '127.0.0.1:3000' }))).toThrow('pnpm studio launch');
  });
});

describe('귀의 입구 검사(요청을 읽기 전에)', () => {
  /** 가짜 요청: 읽은 조각 수를 센다 */
  function fakeRequest(options: { remote: string; headers?: Record<string, string>; chunks: number; method?: string; url?: string }) {
    const state = { read: 0, destroyed: false };
    const body = Readable.from(
      (async function* () {
        for (let i = 0; i < options.chunks; i++) {
          state.read += 1;
          yield Buffer.alloc(4096, 97);
        }
      })(),
    );
    const req = Object.assign(body, { method: options.method ?? 'POST', url: options.url ?? '/phone/v1/pair', headers: options.headers ?? {}, socket: { remoteAddress: options.remote, destroy: () => { state.destroyed = true; } } });
    const out = { status: 0, ended: false };
    const res = { headersSent: false, writeHead: (status: number) => { out.status = status; }, end: () => { out.ended = true; }, destroy: () => {} };
    return { req, res, state, out };
  }
  const gateway = () => new PhoneGateway({ dispatch: createRouteDispatcher(routes) });

  it('상대가 공인 주소면 요청을 읽지도 않고 연결을 끊는다(운영자가 주소를 정하지 않았을 때)', async () => {
    personalPc();
    writeSettings({ enabled: true });
    const handler = createPhoneHttpHandler(gateway(), { checkPeer: true });
    const fake = fakeRequest({ remote: '8.8.8.8', chunks: 1 });
    await handler(fake.req as never, fake.res as never);
    expect(fake.state.destroyed).toBe(true);
    expect(fake.out.ended).toBe(false);
    const inside = fakeRequest({ remote: '192.168.0.9', chunks: 1 });
    await handler(inside.req as never, inside.res as never);
    expect(inside.state.destroyed).toBe(false);
  });

  it('선언된 길이가 상한을 넘으면 본문을 한 조각도 읽지 않는다', async () => {
    personalPc();
    writeSettings({ enabled: true });
    const handler = createPhoneHttpHandler(gateway(), { checkPeer: false });
    const fake = fakeRequest({ remote: '127.0.0.1', chunks: 100, headers: { 'content-length': '999999' } });
    await handler(fake.req as never, fake.res as never);
    expect(fake.out.status).toBe(413);
    expect(fake.state.read).toBe(0);
    const bad = fakeRequest({ remote: '127.0.0.1', chunks: 5, headers: { 'content-length': '-1' } });
    await handler(bad.req as never, bad.res as never);
    expect(bad.out.status).toBe(413);
    expect(bad.state.read).toBe(0);
  });

  it('선언이 없거나 거짓이어도 상한을 넘으면 읽기를 멈춘다', async () => {
    personalPc();
    writeSettings({ enabled: true });
    const handler = createPhoneHttpHandler(gateway(), { checkPeer: false });
    const fake = fakeRequest({ remote: '127.0.0.1', chunks: 1000, headers: { 'content-length': '10' } });
    await handler(fake.req as never, fake.res as never);
    expect(fake.out.status).toBe(413);
    // 8KiB 상한이면 4KiB 조각 3개째에서 넘는다
    expect(fake.state.read).toBeLessThanOrEqual(4);
  });
});

describe('base64는 정해진 모양만 받는다', () => {
  it('패딩·글자·길이·여분 비트가 맞지 않으면 열지 않는다', () => {
    expect(fromBase64('AAAA', 3)).toEqual(new Uint8Array(3));
    for (const bad of ['AB==', 'AAA', 'AAAA ', ' AAAA', 'AA\nAA', 'AAA*', 'AAAA=', '=AAA', 'QQ=', '__8=']) expect(fromBase64(bad), bad).toBeUndefined();
    expect(fromBase64('AAAA', 4)).toBeUndefined();
    expect(fromBase64(123)).toBeUndefined();
    expect(fromBase64('AAAAAAAA', undefined, 3)).toBeUndefined();
  });
});

describe('끊기는 두 겹이다', () => {
  it('기기 목록에서만 지워져도(세션 표는 그대로) 열린 세션의 다음 요청은 거절한다', async () => {
    personalPc();
    const phone = await pairedPhone();
    expect(await phone.rpc({ op: 'ping' })).toMatchObject({ ok: true });
    removeDevice(phone.deviceId);
    expect(await phone.rpcStatus({ op: 'ping' })).toBe(401);
  });
});

describe('고정 벡터: docs/phone-protocol.md의 값과 서버 부품이 같다(앱이 이 값으로 자기 구현을 확인한다)', () => {
  const fill = (value: number) => new Uint8Array(32).fill(value);
  const b64 = (text: string) => fromBase64(text)!;
  const server = nacl.box.keyPair.fromSecretKey(fill(0x11));
  const device = nacl.box.keyPair.fromSecretKey(fill(0x22));

  it('짝 맺기 상자: 기기 비밀 키 + 서버 공개 키로 만들고 서버 비밀 키 + 기기 공개 키로 연다', () => {
    expect(toBase64(server.publicKey)).toBe('e06Qm75//kTEZaIgA31gjuNYl9Me+XLwf3SJLLD3PxM=');
    expect(toBase64(device.publicKey)).toBe('D6poTtKIZ7l/Smot7l34zpdOdrcBjj8iocTPJnhXDyA=');
    const plain = new TextEncoder().encode('{"code":"ABCDEFGHJK","name":"phone"}');
    const nonce = new Uint8Array(24).fill(0x33);
    const sealed = sealBox(plain, nonce, server.publicKey, device.secretKey);
    expect(toBase64(sealed)).toBe('ag/v+mg1uveciYYYGVtdw00+rfbajM9mgvNZYN2xgAK1XXr43SS/xAWkrO29Y5Q4hN5yjg==');
    expect(new TextDecoder().decode(openBox(sealed, nonce, device.publicKey, server.secretKey)!)).toBe('{"code":"ABCDEFGHJK","name":"phone"}');
  });

  it('세션 열쇠와 메시지 상자: 양쪽이 같은 열쇠를 얻고 nonce 틀은 [종류][0×7][번호 8바이트][0×8]이다', () => {
    const client = nacl.box.keyPair.fromSecretKey(fill(0x44));
    const serverEphemeral = nacl.box.keyPair.fromSecretKey(fill(0x55));
    const key = sessionKey(serverEphemeral.publicKey, client.secretKey);
    expect(toBase64(key)).toBe('G2+9pU9EgJCRgoDG/pJHn2VpfpvqUNZDKruOrl/5UYE=');
    expect(toBase64(sessionKey(client.publicKey, serverEphemeral.secretKey))).toBe(toBase64(key));
    expect(toBase64(messageNonce(NonceKind.request, 7))).toBe('AQAAAAAAAAAAAAAAAAAABwAAAAAAAAAA');
    expect(toBase64(messageNonce(NonceKind.response, 7))).toBe('AgAAAAAAAAAAAAAAAAAABwAAAAAAAAAA');
    const request = sealSecret(new TextEncoder().encode('{"op":"ping"}'), messageNonce(NonceKind.request, 7), key);
    expect(toBase64(request)).toBe('nlWYw+CgdPlpPXqFLjyyoZM8u9kUnR4OjRkGXgo=');
    const response = sealSecret(new TextEncoder().encode('{"ok":true,"now":1}'), messageNonce(NonceKind.response, 7), key);
    expect(toBase64(response)).toBe('PtU4m1XHJB41nW++2G7Z+FzToetcJ8M8RFApZFrv53fZgJY=');
    expect(openSecret(b64('nlWYw+CgdPlpPXqFLjyyoZM8u9kUnR4OjRkGXgo='), messageNonce(NonceKind.response, 7), key)).toBeUndefined();
    expect(openSecret(request, messageNonce(NonceKind.request, 8), key)).toBeUndefined();
  });
});

describe('짝 코드는 사용자별이다(서버 방식에서 남의 코드를 지우거나 덮어쓰지 못한다)', () => {
  it('B가 코드를 만들거나 취소해도 A의 코드는 그대로 쓸 수 있다', () => {
    const a = createPairingCode('kim', 1000);
    const b = createPairingCode('lee', 1000);
    expect(a.code).not.toBe(b.code);
    cancelPairing('lee');
    expect(pendingPairing('kim', 1001)).toEqual({ expiresAt: a.expiresAt });
    expect(checkPairingCode(a.code, 1001)).toEqual({ ok: true, user: 'kim' });
  });

  it('A의 화면(보기)에 B의 대기가 보이지 않는다', () => {
    createPairingCode('lee', 1000);
    expect(pendingPairing('kim', 1001)).toBeUndefined();
    expect(pendingPairing('lee', 1001)).toBeDefined();
  });

  it('같은 사용자가 다시 만들면 그 사용자의 앞 코드만 못 쓴다', () => {
    const first = createPairingCode('kim', 1000);
    const other = createPairingCode('lee', 1000);
    const second = createPairingCode('kim', 1001);
    expect(checkPairingCode(first.code, 1002).ok).toBe(false);
    expect(checkPairingCode(other.code, 1002)).toEqual({ ok: true, user: 'lee' });
    expect(checkPairingCode(second.code, 1002)).toEqual({ ok: true, user: 'kim' });
  });

  it('각자 코드로 각자 사용자의 기기가 된다(사용자 이름은 손님이 정하지 못한다)', async () => {
    personalPc();
    const side = await startPhoneSide();
    const kim = createPairingCode('kim', Date.now()).code;
    const lee = createPairingCode('lee', Date.now()).code;
    const phoneLee = new FakePhone(side.base, serverKeys().publicKey);
    expect((await phoneLee.pair(lee)).status).toBe(200);
    expect((await side.phone.pair(kim)).status).toBe(200);
    const users = Object.fromEntries(listDevices().map((device) => [device.id, device.user]));
    expect(users[phoneLee.deviceId]).toBe('lee');
    expect(users[side.phone.deviceId]).toBe('kim');
  });

  it('틀린 횟수는 전체에서 센다: 사용자가 여럿이어도 5번이면 대기 코드가 모두 죽는다', () => {
    const codes = ['kim', 'lee', 'park'].map((user) => createPairingCode(user, 1000).code);
    for (let i = 0; i < 5; i++) expect(checkPairingCode('WRONGWRONG', 1100).ok).toBe(false);
    for (const code of codes) expect(checkPairingCode(code, 1200).ok).toBe(false);
  });

  it('대기 코드는 전체 상한까지만, 같은 사용자의 다시 만들기는 상한과 무관하다', () => {
    for (let i = 0; i < MAX_PENDING_PAIRINGS; i++) createPairingCode(`u${i}`, 1000);
    expect(() => createPairingCode('late', 1000)).toThrow('너무 많습니다');
    expect(() => createPairingCode('u0', 1001)).not.toThrow();
    // 만료되면 자리가 난다
    expect(() => createPairingCode('late', 1000 + 121_000)).not.toThrow();
  });
});
