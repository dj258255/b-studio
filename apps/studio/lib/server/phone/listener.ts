import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { authConfig } from '../auth';
import { PhoneGateway, MAX_PAIR_BODY, MAX_RPC_BODY, type GatewayDeps } from './gateway';
import { readSettings, writeSettings } from './state';

/**
 * 휴대폰 통로의 귀. 스튜디오 본 서버(127.0.0.1)와 **따로** 사설 네트워크 주소에만 연다 — 본 서버의 주소는 그대로고,
 * 이 귀는 `/phone/v1/*` 네 경로만 안다(나머지는 404). 짝짓기 스위치가 켜졌을 때만 열고, 끄면 닫는다(기본 꺼짐).
 *
 * 바인드는 0.0.0.0이 아니라 이 컴퓨터의 사설 IPv4 주소마다 하나씩이다(RFC1918, Tailscale 같은 100.64.0.0/10, 링크 로컬).
 * 공인 주소로 열린 인터페이스에는 귀를 열지 않는다. 운영자가 B_STUDIO_PHONE_HOSTS(쉼표)로 바인드할 주소를 직접 정할 수 있고, 그때는 그 값을 따른다.
 * 받은 연결의 상대 주소도 사설·루프백이 아니면 끊는다(운영자 지정 시 제외). 암호 통로라 쿠키·CORS를 쓰지 않으므로 브라우저를 통한 요청은 읽히지 않는다
 */

export function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

/** 연결해 온 상대가 사설·루프백 주소인가. IPv4-mapped IPv6(::ffff:a.b.c.d)는 안의 IPv4로 본다. 모르는 꼴은 아니다 */
export function isPrivatePeer(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (v4.startsWith('127.') && v4.split('.').length === 4) return true;
  if (address === '::1') return true;
  if (isPrivateIPv4(v4)) return true;
  const lower = address.toLowerCase();
  return /^f[cd][0-9a-f]{2}:/.test(lower) || lower.startsWith('fe80:');
}

/** 귀를 열 주소들. 운영자가 정했으면 그 값, 아니면 이 컴퓨터의 사설 IPv4 */
export function phoneHosts(env: Record<string, string | undefined> = process.env, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const configured = env.B_STUDIO_PHONE_HOSTS?.split(',').map((host) => host.trim()).filter(Boolean);
  if (configured && configured.length > 0) return [...new Set(configured)];
  const found: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) if (info.family === 'IPv4' && !info.internal && isPrivateIPv4(info.address)) found.push(info.address);
  }
  return [...new Set(found)];
}

export interface PhoneListening {
  hosts: string[];
  port: number;
}

interface Runtime {
  gateway?: PhoneGateway;
  servers: Server[];
  listening?: PhoneListening;
  dispatch?: GatewayDeps['dispatch'];
}

const holder = globalThis as typeof globalThis & { __bStudioPhoneRuntime?: Runtime };
function runtime(): Runtime {
  return (holder.__bStudioPhoneRuntime ??= { servers: [] });
}

export function setPhoneDispatcher(dispatch: GatewayDeps['dispatch']): void {
  runtime().dispatch = dispatch;
}

export function phoneGateway(): PhoneGateway | undefined {
  return runtime().gateway;
}

export function phoneListening(): PhoneListening | undefined {
  return runtime().listening;
}

/** 운영자가 이 서버에서 짝짓기를 허용했는가. 개인 PC(인증 없음)는 늘 가능하고, 인증을 켠 서버는 B_STUDIO_PHONE=1일 때만(허용 목록, 설정이 틀리면 불가) */
export function phoneAllowed(env: Record<string, string | undefined> = process.env): boolean {
  try {
    return authConfig(env).mode === 'none' || env.B_STUDIO_PHONE === '1';
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, max: number): Promise<Uint8Array | undefined> {
  // 상한은 읽기 전에 본다: 선언된 길이가 넘으면 본문을 읽지 않는다. 선언이 없거나 거짓이어도 읽는 동안 센다
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > max)) return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > max) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), 'x-content-type-options': 'nosniff' });
  res.end(text);
}

export function createPhoneHttpHandler(gateway: PhoneGateway, options: { checkPeer: boolean }): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      if (options.checkPeer && !isPrivatePeer(req.socket.remoteAddress)) {
        req.socket.destroy();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://phone.invalid');
      const method = req.method ?? 'GET';
      // 쿼리를 쓰는 경로는 없다. 있으면 모르는 입력이다
      if (url.search !== '' || !url.pathname.startsWith('/phone/v1/')) return respond(res, 404, { error: 'not_found' });
      let body: Uint8Array | undefined;
      if (method === 'POST') {
        // 경로마다 상한이 다르다: 짝 맺기·세션 열기는 작은 JSON이라 8KiB, 요청(rpc)만 512KiB
        body = await readBody(req, url.pathname === '/phone/v1/rpc' ? MAX_RPC_BODY : MAX_PAIR_BODY);
        if (!body) return respond(res, 413, { error: 'too_large' });
      } else if (method !== 'GET') return respond(res, 405, { error: 'method_not_allowed' });
      const result = await gateway.handle({ method, path: url.pathname, body, peer: req.socket.remoteAddress ?? 'unknown' });
      respond(res, result.status, result.body);
    } catch (error) {
      console.error('[b-studio] 휴대폰 귀에서 오류가 났습니다:', error instanceof Error ? error.message : String(error));
      if (!res.headersSent) respond(res, 500, { error: 'internal' });
      else res.destroy();
    }
  };
}

async function listenOne(server: Server, host: string, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

/**
 * 귀를 연다. 주소가 하나도 없으면(사설 주소가 없는 컴퓨터) 열지 않고 던진다. 일부 주소만 열리면 연 것만으로 계속한다(연 주소 목록을 돌려준다).
 * 이미 열려 있으면 먼저 닫고 연다
 */
export async function startPhoneListener(options: { env?: Record<string, string | undefined>; port?: number; now?: () => number; userValid?: GatewayDeps['userValid'] } = {}): Promise<PhoneListening> {
  const env = options.env ?? process.env;
  const rt = runtime();
  if (!rt.dispatch) throw new Error('휴대폰 통로가 부를 라우트 표가 아직 없습니다(서버가 다 뜨기 전입니다)');
  await stopPhoneListener();
  const hosts = phoneHosts(env);
  if (hosts.length === 0) throw new Error('휴대폰이 닿을 수 있는 사설 네트워크 주소(같은 와이파이)가 이 컴퓨터에 없습니다');
  const gateway = new PhoneGateway({ env, dispatch: rt.dispatch, ...(options.now ? { now: options.now } : {}), ...(options.userValid ? { userValid: options.userValid } : {}) });
  const handler = createPhoneHttpHandler(gateway, { checkPeer: !env.B_STUDIO_PHONE_HOSTS?.trim() });
  let port = options.port ?? readSettings(env).port;
  const servers: Server[] = [];
  const opened: string[] = [];
  const errors: string[] = [];
  for (const host of hosts) {
    const server = createServer((req, res) => void handler(req, res));
    server.requestTimeout = 60_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    try {
      // 첫 주소가 포트를 정하면(0이면 임시 포트) 나머지 주소도 같은 포트를 쓴다(QR에는 포트가 하나다)
      const bound = await listenOne(server, host, port);
      if (port === 0) port = bound;
      servers.push(server);
      opened.push(host);
    } catch (error) {
      errors.push(`${host}: ${error instanceof Error ? error.message : String(error)}`);
      server.close();
    }
  }
  if (opened.length === 0) throw new Error(`휴대폰 통로를 열지 못했습니다(${errors.join('; ')})`);
  rt.gateway = gateway;
  rt.servers = servers;
  rt.listening = { hosts: opened, port };
  return rt.listening;
}

export async function stopPhoneListener(): Promise<void> {
  const rt = runtime();
  const servers = rt.servers;
  rt.servers = [];
  rt.listening = undefined;
  rt.gateway?.shutdown();
  rt.gateway = undefined;
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
}

/** 서버가 뜰 때: 스위치가 켜져 있으면 귀를 연다. 못 열면 스위치는 그대로 두고 알린다(주소가 생기면 다시 켜서 연다) */
export async function resumePhoneListener(env: Record<string, string | undefined> = process.env): Promise<void> {
  if (!phoneAllowed(env) || !readSettings(env).enabled) return;
  try {
    const listening = await startPhoneListener({ env });
    console.log(`b-studio 휴대폰 통로가 열렸습니다: ${listening.hosts.map((host) => `${host}:${listening.port}`).join(', ')}`);
  } catch (error) {
    console.error('[b-studio] 휴대폰 통로를 열지 못했습니다:', error instanceof Error ? error.message : String(error));
  }
}

/** 스위치를 켜거나 끈다. 켜면 귀를 열고(못 열면 스위치를 켜지 않는다), 끄면 귀를 닫고 열린 세션과 흐름을 모두 버린다 */
export async function setPhoneEnabled(enabled: boolean, env: Record<string, string | undefined> = process.env): Promise<PhoneListening | undefined> {
  if (!enabled) {
    writeSettings({ enabled: false }, env);
    await stopPhoneListener();
    return undefined;
  }
  if (!phoneAllowed(env)) throw new Error('이 서버는 휴대폰 짝짓기를 허용하지 않습니다');
  // gateway가 요청마다 켜짐을 확인하므로 스위치를 먼저 켜고 귀를 연다. 귀를 못 열면 스위치를 되돌린다
  writeSettings({ enabled: true }, env);
  try {
    return await startPhoneListener({ env });
  } catch (error) {
    writeSettings({ enabled: false }, env);
    throw error;
  }
}
