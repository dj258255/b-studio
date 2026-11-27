import { authConfig, LOCAL_USER, USER_HEADER } from '../auth';
import { readRevocations } from '../auth-state';
import { LOCAL_TOKEN_COOKIE, localToken } from '../local-token';
import {
  bytesOf,
  fromBase64,
  KEY_BYTES,
  messageNonce,
  NONCE_BYTES,
  newKeyPair,
  NonceKind,
  openBox,
  openSecret,
  PHONE_PROTOCOL_VERSION,
  randomBytes,
  randomHex,
  safeEqual,
  sealBox,
  sealSecret,
  sessionKey,
  sha256Hex,
  toBase64,
  utf8,
} from './crypto';
import { addDevice, checkPairingCode, getDevice, listDevices, readSettings, removeDevice, serverKeys, touchDevice, type PhoneDevice } from './state';

/**
 * 휴대폰 암호 통로의 서버 쪽 판정과 처리(docs/phone-protocol.md). 전송(HTTP)을 모르는 순수한 요청 → 응답 함수라서,
 * listener.ts가 LAN에 연 귀와 시험이 같은 코드를 부른다.
 *
 * 믿는 근거는 주소가 아니라 암호다: 짝 코드(한 번, 2분)로 기기 키를 등록하고, 그 뒤 모든 요청은 기기 키로 세션을 연 사람의 것만 받는다.
 * 통과한 요청은 "짝 맺을 때 desk를 쓰던 사용자"의 권한으로 기존 라우트를 그대로 지난다(허용 경로 목록 안에서만, 라우트의 소유자 검사 그대로)
 */

export interface GatewayRequest {
  method: string;
  /** 쿼리를 뺀 경로 */
  path: string;
  /** 읽기를 마친 본문. 크기 상한은 읽기 전에 listener가 본다(여기서도 한 번 더 본다) */
  body: Uint8Array | undefined;
  /** 요청을 보낸 쪽 주소(시도 횟수 제한의 단위) */
  peer: string;
}

export interface GatewayResponse {
  status: number;
  body: unknown;
}

export interface GatewayDeps {
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** 라우트를 부르는 함수(server/app.ts의 createRouteDispatcher). 앞단의 인증 판단을 거치지 않는다 — 이 파일이 이미 판단했다 */
  dispatch: (request: Request) => Promise<Response>;
  /** 이 기기의 사용자가 지금도 유효한가. 기본은 인증 설정과 무효화 기록을 읽는다 */
  userValid?: (device: PhoneDevice) => boolean;
}

export const MAX_PAIR_BODY = 8 * 1024;
export const MAX_RPC_BODY = 512 * 1024;
const MAX_INNER_BODY = 256 * 1024;
const MAX_INNER_RESPONSE = 4 * 1024 * 1024;
const CHALLENGE_TTL_MS = 30_000;
const MAX_CHALLENGES = 64;
const SESSION_MAX_MS = 12 * 3_600_000;
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_SESSIONS_PER_DEVICE = 4;
const MAX_STREAMS_PER_DEVICE = 4;
const MAX_STREAMS = 16;
const STREAM_IDLE_MS = 60_000;
const MAX_STREAM_EVENTS = 2000;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const READ_BATCH_BYTES = 256 * 1024;
const MAX_WAIT_MS = 25_000;
const FAIL_WINDOW_MS = 60_000;
const FAIL_LIMIT = 10;
const MAX_FAIL_PEERS = 1000;

const HEX32 = /^[0-9a-f]{32}$/;
const ID = '[A-Za-z0-9_-]{1,64}';
const QUERY = /^[A-Za-z0-9_=&.-]{0,128}$/;

/**
 * 암호 통로 안에서 부를 수 있는 라우트의 허용 목록. 여는 쪽이라 정확히 맞는 것만 통과하고, 모르는 경로·메서드는 범위 밖이다.
 * 세그먼트 값(세션 id)에는 `.`·`/`·`%`가 없어 `..`나 인코딩으로 다른 경로가 되지 못한다. 권한은 각 라우트의 검사가 그대로 본다
 */
const HTTP_ROUTES: ReadonlyArray<{ method: string; pattern: RegExp; query?: boolean }> = [
  { method: 'GET', pattern: /^\/api\/sessions$/, query: true },
  { method: 'GET', pattern: new RegExp(`^/api/sessions/${ID}/status$`) },
  { method: 'GET', pattern: new RegExp(`^/api/sessions/${ID}/changes$`) },
  { method: 'POST', pattern: new RegExp(`^/api/sessions/${ID}/terminal$`) },
  { method: 'GET', pattern: /^\/api\/agents$/ },
];
const STREAM_ROUTES: readonly RegExp[] = [new RegExp(`^/api/sessions/${ID}/terminal$`), /^\/api\/agents\/stream$/];

export function isPhoneHttpRoute(method: string, target: string): boolean {
  const [pathname, query, ...rest] = target.split('?');
  if (rest.length > 0 || !pathname || target.length > 256) return false;
  const route = HTTP_ROUTES.find((entry) => entry.method === method && entry.pattern.test(pathname));
  if (!route) return false;
  return query === undefined || (route.query === true && QUERY.test(query));
}

export function isPhoneStreamRoute(target: string): boolean {
  return !target.includes('?') && target.length <= 256 && STREAM_ROUTES.some((pattern) => pattern.test(target));
}

interface PhoneSession {
  id: string;
  deviceId: string;
  key: Uint8Array;
  lastSeq: number;
  createdAt: number;
  lastUsedAt: number;
}

interface PhoneStream {
  id: string;
  deviceId: string;
  abort: AbortController;
  events: Array<{ i: number; data: string }>;
  bytes: number;
  next: number;
  closed: boolean;
  gap: boolean;
  waiters: Set<() => void>;
  lastReadAt: number;
}

class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const rejected = (): GatewayError => new GatewayError(403, 'rejected');

function json(value: unknown): Uint8Array {
  return bytesOf(JSON.stringify(value));
}

function parseObject(bytes: Uint8Array, maxBytes: number): Record<string, unknown> {
  if (bytes.length === 0 || bytes.length > maxBytes) throw new GatewayError(bytes.length > maxBytes ? 413 : 400, bytes.length > maxBytes ? 'too_large' : 'bad_request');
  try {
    const value: unknown = JSON.parse(utf8(bytes));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('객체가 아닙니다');
    return value as Record<string, unknown>;
  } catch {
    throw new GatewayError(400, 'bad_request');
  }
}

export class PhoneGateway {
  readonly #env: Record<string, string | undefined>;
  readonly #now: () => number;
  readonly #dispatch: GatewayDeps['dispatch'];
  readonly #userValid: (device: PhoneDevice) => boolean;
  readonly #challenges = new Map<string, number>();
  readonly #sessions = new Map<string, PhoneSession>();
  readonly #streams = new Map<string, PhoneStream>();
  readonly #failures = new Map<string, { count: number; resetAt: number }>();
  #sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(deps: GatewayDeps) {
    this.#env = deps.env ?? process.env;
    this.#now = deps.now ?? Date.now;
    this.#dispatch = deps.dispatch;
    this.#userValid = deps.userValid ?? ((device) => defaultUserValid(device, this.#env));
  }

  /** 요청 하나. 켜짐 스위치가 꺼졌으면 어떤 경로도 없는 것처럼 답한다 */
  async handle(request: GatewayRequest): Promise<GatewayResponse> {
    try {
      if (!readSettings(this.#env).enabled) throw new GatewayError(404, 'not_found');
      const route = `${request.method} ${request.path}`;
      switch (route) {
        case 'GET /phone/v1/hello':
          return { status: 200, body: this.#hello() };
        case 'POST /phone/v1/pair':
          return { status: 200, body: this.#pair(request) };
        case 'POST /phone/v1/open':
          return { status: 200, body: this.#open(request) };
        case 'POST /phone/v1/rpc':
          return { status: 200, body: await this.#rpc(request) };
        default:
          throw new GatewayError(404, 'not_found');
      }
    } catch (error) {
      if (error instanceof GatewayError) return { status: error.status, body: { error: error.code } };
      console.error('[b-studio] 휴대폰 통로에서 오류가 났습니다:', error instanceof Error ? (error.stack ?? error.message) : String(error));
      return { status: 500, body: { error: 'internal' } };
    }
  }

  // ─── 시도 횟수 제한(같은 주소에서 실패가 쌓이면 잠시 막는다) ───

  #throttle(peer: string): void {
    const entry = this.#failures.get(peer);
    if (entry && entry.resetAt > this.#now() && entry.count >= FAIL_LIMIT) throw new GatewayError(429, 'rate_limited');
  }

  #fail(peer: string): GatewayError {
    const now = this.#now();
    const entry = this.#failures.get(peer);
    if (entry && entry.resetAt > now) entry.count += 1;
    else {
      if (this.#failures.size >= MAX_FAIL_PEERS) {
        for (const [key, value] of this.#failures) if (value.resetAt <= now) this.#failures.delete(key);
        // 그래도 가득 차면 가장 오래된 것을 버린다(공격자가 주소를 바꿔 가며 표를 채워도 메모리는 늘지 않는다)
        if (this.#failures.size >= MAX_FAIL_PEERS) this.#failures.delete(this.#failures.keys().next().value as string);
      }
      this.#failures.set(peer, { count: 1, resetAt: now + FAIL_WINDOW_MS });
    }
    return rejected();
  }

  // ─── hello: 일회용 도전값 ───

  #hello(): { v: number; challenge: string; serverTime: number } {
    const now = this.#now();
    for (const [key, expires] of this.#challenges) if (expires <= now) this.#challenges.delete(key);
    if (this.#challenges.size >= MAX_CHALLENGES) throw new GatewayError(429, 'rate_limited');
    const challenge = randomHex(16);
    this.#challenges.set(challenge, now + CHALLENGE_TTL_MS);
    return { v: PHONE_PROTOCOL_VERSION, challenge, serverTime: now };
  }

  // ─── pair: 짝 코드로 기기 등록 ───

  #pair(request: GatewayRequest): { v: number; n: string; c: string } {
    this.#throttle(request.peer);
    const body = parseObject(request.body ?? new Uint8Array(), MAX_PAIR_BODY);
    if (body.v !== PHONE_PROTOCOL_VERSION) throw new GatewayError(400, 'unsupported_version');
    const devicePublic = fromBase64(body.pk, KEY_BYTES);
    const nonce = fromBase64(body.n, NONCE_BYTES);
    const cipher = fromBase64(body.c, undefined, MAX_PAIR_BODY);
    if (!devicePublic || !nonce || !cipher) throw new GatewayError(400, 'bad_request');

    const keys = serverKeys(this.#env);
    const opened = openBox(cipher, nonce, devicePublic, keys.secretKey);
    if (!opened) throw this.#fail(request.peer);
    let code: unknown;
    let name: unknown;
    try {
      const payload = JSON.parse(utf8(opened)) as { code?: unknown; name?: unknown };
      code = payload.code;
      name = payload.name;
    } catch {
      throw this.#fail(request.peer);
    }
    if (typeof code !== 'string' || code.length > 64) throw this.#fail(request.peer);
    // 없음·만료·틀림·소진은 같은 거절로 답한다(까닭을 나눠 말하지 않는다)
    const check = checkPairingCode(code, this.#now());
    if (!check.ok) throw this.#fail(request.peer);

    const publicKey = toBase64(devicePublic);
    if (listDevices(this.#env).some((device) => device.publicKey === publicKey)) throw new GatewayError(409, 'already_paired');
    const token = randomHex(32);
    let device: PhoneDevice;
    try {
      device = addDevice({ name: typeof name === 'string' ? name : '', publicKey, tokenHash: sha256Hex(token), user: check.user }, this.#now(), this.#env);
    } catch {
      throw new GatewayError(409, 'device_limit');
    }
    const replyNonce = randomBytes(NONCE_BYTES);
    const reply = sealBox(json({ deviceId: device.id, token, user: check.user }), replyNonce, devicePublic, keys.secretKey);
    return { v: PHONE_PROTOCOL_VERSION, n: toBase64(replyNonce), c: toBase64(reply) };
  }

  // ─── open: 기기 키로 세션 열기(임시 키 교환) ───

  #open(request: GatewayRequest): { v: number; n: string; c: string } {
    this.#throttle(request.peer);
    const body = parseObject(request.body ?? new Uint8Array(), MAX_PAIR_BODY);
    if (body.v !== PHONE_PROTOCOL_VERSION) throw new GatewayError(400, 'unsupported_version');
    const nonce = fromBase64(body.n, NONCE_BYTES);
    const cipher = fromBase64(body.c, undefined, MAX_PAIR_BODY);
    if (typeof body.d !== 'string' || !HEX32.test(body.d) || !nonce || !cipher) throw new GatewayError(400, 'bad_request');

    const device = getDevice(body.d, this.#env);
    if (!device || !this.#userValid(device)) throw this.#fail(request.peer);
    const devicePublic = fromBase64(device.publicKey, KEY_BYTES);
    if (!devicePublic) throw this.#fail(request.peer);
    const keys = serverKeys(this.#env);
    const opened = openBox(cipher, nonce, devicePublic, keys.secretKey);
    if (!opened) throw this.#fail(request.peer);
    let payload: { token?: unknown; epk?: unknown; challenge?: unknown };
    try {
      payload = JSON.parse(utf8(opened)) as typeof payload;
    } catch {
      throw this.#fail(request.peer);
    }
    const now = this.#now();
    // 도전값은 한 번만 쓴다. 가로챈 open 요청을 다시 보내도 도전값이 없어 거절된다
    const expires = typeof payload.challenge === 'string' ? this.#challenges.get(payload.challenge) : undefined;
    if (typeof payload.challenge === 'string') this.#challenges.delete(payload.challenge);
    if (expires === undefined || expires <= now) throw this.#fail(request.peer);
    const ephemeralPublic = fromBase64(payload.epk, KEY_BYTES);
    if (typeof payload.token !== 'string' || !ephemeralPublic || !safeEqual(sha256Hex(payload.token), device.tokenHash)) throw this.#fail(request.peer);

    const ephemeral = newKeyPair();
    const key = sessionKey(ephemeralPublic, ephemeral.secretKey);
    ephemeral.secretKey.fill(0);
    const mine = [...this.#sessions.values()].filter((entry) => entry.deviceId === device.id).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    while (mine.length >= MAX_SESSIONS_PER_DEVICE) this.#dropSession(mine.shift()!.id);
    const session: PhoneSession = { id: randomHex(16), deviceId: device.id, key, lastSeq: 0, createdAt: now, lastUsedAt: now };
    this.#sessions.set(session.id, session);
    touchDevice(device.id, now, this.#env);
    this.#startSweeper();

    const replyNonce = randomBytes(NONCE_BYTES);
    const reply = sealBox(json({ sid: session.id, epk: toBase64(ephemeral.publicKey), expiresInSec: Math.floor(SESSION_MAX_MS / 1000), idleSec: Math.floor(SESSION_IDLE_MS / 1000) }), replyNonce, devicePublic, keys.secretKey);
    return { v: PHONE_PROTOCOL_VERSION, n: toBase64(replyNonce), c: toBase64(reply) };
  }

  // ─── rpc: 세션 열쇠로 암호화한 요청 하나 ───

  async #rpc(request: GatewayRequest): Promise<{ q: number; c: string }> {
    this.#throttle(request.peer);
    const body = parseObject(request.body ?? new Uint8Array(), MAX_RPC_BODY);
    const seq = body.q;
    if (typeof body.s !== 'string' || !HEX32.test(body.s) || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) throw new GatewayError(400, 'bad_request');
    const cipher = fromBase64(body.c, undefined, MAX_RPC_BODY);
    if (!cipher) throw new GatewayError(400, 'bad_request');

    const session = this.#sessions.get(body.s);
    if (!session) throw new GatewayError(401, 'session');
    const now = this.#now();
    const device = getDevice(session.deviceId, this.#env);
    // 끊긴 기기·만료된 세션·더는 유효하지 않은 사용자는 열린 세션도 그 자리에서 거절한다
    if (!device || now - session.createdAt > SESSION_MAX_MS || now - session.lastUsedAt > SESSION_IDLE_MS || !this.#userValid(device)) {
      this.#dropSession(session.id);
      throw new GatewayError(401, 'session');
    }
    const plain = openSecret(cipher, messageNonce(NonceKind.request, seq), session.key);
    if (!plain) throw this.#fail(request.peer);
    // 번호는 열어 본 뒤에 확인한다(위조 메시지가 번호를 올리지 못한다). 지난 번호와 같은 번호는 재전송이다
    if (seq <= session.lastSeq) throw new GatewayError(409, 'replay');
    session.lastSeq = seq;
    session.lastUsedAt = now;
    touchDevice(device.id, now, this.#env);

    let result: unknown;
    try {
      result = await this.#operate(device, session, JSON.parse(utf8(plain)) as unknown);
    } catch (error) {
      result = { ok: false, error: error instanceof GatewayError ? error.code : 'bad_request' };
    }
    let reply = json(result);
    if (reply.length > MAX_INNER_RESPONSE + 1024) reply = json({ ok: false, error: 'too_large' });
    // 요청이 처리되는 동안 끊겼으면 답을 주지 않는다
    if (!this.#sessions.has(session.id) || !getDevice(device.id, this.#env)) throw new GatewayError(401, 'session');
    return { q: seq, c: toBase64(sealSecret(reply, messageNonce(NonceKind.response, seq), session.key)) };
  }

  async #operate(device: PhoneDevice, session: PhoneSession, message: unknown): Promise<unknown> {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) throw new GatewayError(400, 'bad_request');
    const op = message as Record<string, unknown>;
    switch (op.op) {
      case 'ping':
        return { ok: true, now: this.#now() };
      case 'http':
        return await this.#http(device, op);
      case 'stream.open':
        return await this.#streamOpen(device, session, op);
      case 'stream.read':
        return await this.#streamRead(device, op);
      case 'stream.close':
        return this.#streamClose(device, op);
      default:
        throw new GatewayError(400, 'unknown_op');
    }
  }

  /** 기존 라우트에 보내는 안쪽 요청. 손님이 정한 것은 메서드·경로·본문뿐이고, 사용자·로컬 토큰·Host는 서버가 넣는다 */
  #innerRequest(device: PhoneDevice, method: string, target: string, body: string | undefined, signal?: AbortSignal): Request {
    const headers = new Headers({ host: '127.0.0.1', [USER_HEADER]: authConfig(this.#env).mode === 'none' ? LOCAL_USER : device.user, cookie: `${LOCAL_TOKEN_COOKIE}=${localToken(this.#env)}` });
    if (body !== undefined) headers.set('content-type', 'application/json');
    return new Request(`http://127.0.0.1${target}`, { method, headers, ...(body !== undefined ? { body } : {}), ...(signal ? { signal } : {}) });
  }

  async #http(device: PhoneDevice, op: Record<string, unknown>): Promise<unknown> {
    const method = typeof op.method === 'string' ? op.method : '';
    const target = typeof op.path === 'string' ? op.path : '';
    if (!isPhoneHttpRoute(method, target)) throw new GatewayError(403, 'route_not_allowed');
    let bodyText: string | undefined;
    if (op.body !== undefined) {
      bodyText = JSON.stringify(op.body);
      if (bodyText.length > MAX_INNER_BODY) throw new GatewayError(413, 'too_large');
    }
    const response = await this.#dispatch(this.#innerRequest(device, method, target, bodyText));
    const text = await readCapped(response, MAX_INNER_RESPONSE);
    if (text === undefined) return { ok: false, error: 'too_large' };
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = undefined;
    }
    return parsed !== undefined ? { ok: true, status: response.status, json: parsed } : { ok: true, status: response.status, text };
  }

  // ─── 흐름: 서버가 안쪽 SSE를 받아 두고, 손님이 긴 기다림으로 가져간다 ───

  async #streamOpen(device: PhoneDevice, _session: PhoneSession, op: Record<string, unknown>): Promise<unknown> {
    const target = typeof op.path === 'string' ? op.path : '';
    if (!isPhoneStreamRoute(target)) throw new GatewayError(403, 'route_not_allowed');
    const mine = [...this.#streams.values()].filter((entry) => entry.deviceId === device.id).length;
    if (mine >= MAX_STREAMS_PER_DEVICE || this.#streams.size >= MAX_STREAMS) throw new GatewayError(429, 'too_many_streams');
    const abort = new AbortController();
    const response = await this.#dispatch(this.#innerRequest(device, 'GET', target, undefined, abort.signal));
    if (!response.ok || !response.body) {
      const text = await readCapped(response, 64 * 1024);
      abort.abort();
      return { ok: false, status: response.status, error: 'stream_refused', text: text ?? '' };
    }
    // 열리는 동안 기기가 끊겼으면 흐름을 만들지 않는다
    if (!getDevice(device.id, this.#env)) {
      abort.abort();
      throw new GatewayError(401, 'session');
    }
    const stream: PhoneStream = { id: randomHex(8), deviceId: device.id, abort, events: [], bytes: 0, next: 0, closed: false, gap: false, waiters: new Set(), lastReadAt: this.#now() };
    this.#streams.set(stream.id, stream);
    void this.#pump(stream, response.body);
    return { ok: true, stream: stream.id };
  }

  async #pump(stream: PhoneStream, body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let pending = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        for (;;) {
          const match = /\r?\n\r?\n/.exec(pending);
          if (!match) break;
          const block = pending.slice(0, match.index);
          pending = pending.slice(match.index + match[0].length);
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => (line.startsWith('data: ') ? line.slice(6) : line.slice(5)))
            .join('\n');
          if (data) this.#push(stream, data);
        }
        // 끝나지 않는 조각이 계속 쌓이지 않게 한다
        if (pending.length > MAX_STREAM_BYTES) throw new Error('조각이 너무 큽니다');
      }
    } catch {
      // 끊김·취소·너무 큰 조각은 모두 흐름의 끝이다
    } finally {
      stream.closed = true;
      this.#wake(stream);
      reader.cancel().catch(() => undefined);
    }
  }

  #push(stream: PhoneStream, data: string): void {
    stream.events.push({ i: stream.next++, data });
    stream.bytes += data.length;
    while (stream.events.length > MAX_STREAM_EVENTS || stream.bytes > MAX_STREAM_BYTES) {
      const dropped = stream.events.shift()!;
      stream.bytes -= dropped.data.length;
      stream.gap = true;
    }
    this.#wake(stream);
  }

  #wake(stream: PhoneStream): void {
    const waiters = [...stream.waiters];
    stream.waiters.clear();
    for (const wake of waiters) wake();
  }

  #ownStream(device: PhoneDevice, op: Record<string, unknown>): PhoneStream {
    const stream = typeof op.stream === 'string' ? this.#streams.get(op.stream) : undefined;
    // 다른 기기의 흐름 id를 알아도 읽을 수 없다
    if (!stream || stream.deviceId !== device.id) throw new GatewayError(404, 'no_stream');
    return stream;
  }

  async #streamRead(device: PhoneDevice, op: Record<string, unknown>): Promise<unknown> {
    const stream = this.#ownStream(device, op);
    const after = typeof op.after === 'number' && Number.isSafeInteger(op.after) && op.after >= 0 ? op.after : 0;
    const waitMs = typeof op.waitMs === 'number' && Number.isFinite(op.waitMs) ? Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(op.waitMs))) : 0;
    stream.lastReadAt = this.#now();
    // 받았다고 알린 번호 앞은 버린다
    while (stream.events.length > 0 && stream.events[0]!.i < after) stream.bytes -= stream.events.shift()!.data.length;
    if (stream.events.length === 0 && !stream.closed && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          stream.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        stream.waiters.add(done);
      });
    }
    // 기다리는 사이 끊겼으면 이 흐름은 이미 없다
    if (this.#streams.get(stream.id) !== stream) throw new GatewayError(404, 'no_stream');
    stream.lastReadAt = this.#now();
    const events: Array<{ i: number; data: string }> = [];
    let size = 0;
    for (const entry of stream.events) {
      if (entry.i < after) continue;
      if (events.length > 0 && size + entry.data.length > READ_BATCH_BYTES) break;
      events.push(entry);
      size += entry.data.length;
    }
    const gap = stream.gap;
    stream.gap = false;
    const next = events.length > 0 ? events[events.length - 1]!.i + 1 : Math.max(after, stream.next);
    const finished = stream.closed && events.length === stream.events.filter((entry) => entry.i >= after).length;
    if (finished) this.#streams.delete(stream.id);
    return { ok: true, events, next, ...(gap ? { gap: true } : {}), ...(finished ? { closed: true } : {}) };
  }

  #streamClose(device: PhoneDevice, op: Record<string, unknown>): unknown {
    const stream = this.#ownStream(device, op);
    this.#closeStream(stream);
    return { ok: true };
  }

  #closeStream(stream: PhoneStream): void {
    stream.abort.abort();
    stream.closed = true;
    this.#streams.delete(stream.id);
    this.#wake(stream);
  }

  #dropSession(id: string): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    session.key.fill(0);
    this.#sessions.delete(id);
  }

  #startSweeper(): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => this.sweep(), 15_000);
    this.#sweeper.unref();
  }

  /** 오래 읽지 않은 흐름과 만료된 세션·도전값을 치운다 */
  sweep(): void {
    const now = this.#now();
    for (const stream of [...this.#streams.values()]) if (now - stream.lastReadAt > STREAM_IDLE_MS) this.#closeStream(stream);
    for (const session of [...this.#sessions.values()]) if (now - session.createdAt > SESSION_MAX_MS || now - session.lastUsedAt > SESSION_IDLE_MS) this.#dropSession(session.id);
    for (const [key, expires] of this.#challenges) if (expires <= now) this.#challenges.delete(key);
  }

  /** 기기를 끊는다: 목록에서 지우고, 그 기기의 세션을 없애고, 열린 흐름을 닫는다. 끊은 직후의 요청은 모두 거절된다 */
  revokeDevice(id: string): boolean {
    const removed = removeDevice(id, this.#env);
    for (const session of [...this.#sessions.values()]) if (session.deviceId === id) this.#dropSession(session.id);
    for (const stream of [...this.#streams.values()]) if (stream.deviceId === id) this.#closeStream(stream);
    return removed;
  }

  /** 지금 세션이 열려 있는 기기 id들(desk의 "연결됨" 표시) */
  connectedDevices(): Set<string> {
    const now = this.#now();
    return new Set([...this.#sessions.values()].filter((session) => now - session.lastUsedAt <= SESSION_IDLE_MS).map((session) => session.deviceId));
  }

  /** 스위치를 껐을 때나 서버를 닫을 때: 세션·흐름·도전값을 모두 버린다 */
  shutdown(): void {
    for (const stream of [...this.#streams.values()]) this.#closeStream(stream);
    for (const id of [...this.#sessions.keys()]) this.#dropSession(id);
    this.#challenges.clear();
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = undefined;
  }
}

/** 응답 본문을 상한까지만 읽는다. 넘으면 undefined(끝까지 읽지 않는다) */
async function readCapped(response: Response, max: number): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * 기기의 사용자가 지금도 유효한가. 인증 설정이 틀리거나 무효화 기록을 읽지 못하면 유효하지 않다(fail-closed).
 * token 방식은 토큰 목록에서 빠진 사용자와, 운영자가 무효화한 시각 이후 기준(짝 맺은 시각이 그 전이면)의 기기를 거절한다.
 * proxy 방식은 서버가 사용자를 확인할 수단이 없으므로 기기를 끊는 것이 유일한 회수 방법이다
 */
export function defaultUserValid(device: PhoneDevice, env: Record<string, string | undefined> = process.env): boolean {
  try {
    const config = authConfig(env);
    if (config.mode === 'none') return true;
    if (config.mode === 'proxy') return device.user.length > 0;
    if (!config.tokens.has(device.user)) return false;
    const notBefore = readRevocations().users[device.user];
    return notBefore === undefined || device.createdAt > notBefore;
  } catch {
    return false;
  }
}
