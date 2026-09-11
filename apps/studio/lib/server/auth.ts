import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 스튜디오 접근 인증. proxy.ts가 모든 요청 앞에서 쓰므로 무거운 서버 모듈(에이전트, 샌드박스)을 불러오지 않는다.
 * none: 인증 없음(루프백에 띄운 개인 PC용), token: 운영자가 준 접근 토큰으로 로그인, proxy: 사내 SSO 프록시가 넣은 사용자 헤더
 */
export type AuthMode = 'none' | 'token' | 'proxy';

/** 접근 토큰. 환경 변수에 평문 대신 SHA-256 해시를 둘 수 있다 */
export type TokenEntry = { kind: 'plain'; value: string } | { kind: 'sha256'; hash: string };

export interface AuthConfig {
  mode: AuthMode;
  /** token 모드의 세션 쿠키 서명 키 */
  secret: string;
  /** token 모드의 사용자 이름별 접근 토큰 */
  tokens: Map<string, TokenEntry>;
  /** proxy 모드에서 SSO 프록시가 사용자를 넣는 헤더 */
  userHeader: string;
  /** proxy 모드에서 SSO 프록시만 아는 값. 스튜디오 포트로 바로 들어와 사용자 헤더를 꾸미는 요청을 막는다 */
  proxySecret: string;
  admins: Set<string>;
  sessionHours: number;
}

/** 서명을 확인한 세션 쿠키의 내용. 로그인할 때마다 새 세션 ID를 만들어, 로그아웃하면 그 ID만 무효로 한다 */
export interface SessionClaims {
  user: string;
  sid: string;
  issuedAt: number;
  expiresAt: number;
}

/** 서버에 남긴 무효화 기록. sessions는 세션 ID별 쿠키 만료 시각, users는 그 시각까지 발급한 쿠키를 모두 거부할 사용자별 기준 시각 */
export interface Revocations {
  sessions: Readonly<Record<string, number>>;
  users: Readonly<Record<string, number>>;
}

export const NO_REVOCATIONS: Revocations = { sessions: {}, users: {} };

export const SESSION_COOKIE = 'b_studio_session';
/** 미리보기 게이트웨이가 미리보기 호스트마다 주는 쿠키 */
export const PREVIEW_COOKIE = 'b_studio_preview';
/** proxy.ts가 확인한 사용자를 라우트에 넘기는 내부 헤더. 브라우저가 보낸 같은 이름의 헤더는 proxy.ts가 지운다 */
export const USER_HEADER = 'x-b-studio-user';
export const PROXY_SECRET_HEADER = 'x-b-studio-proxy-secret';
export const LOCAL_USER = 'local';

const USER_NAME = /^[A-Za-z0-9._@-]{1,64}$/;
const HEADER_USER = /^[\x21-\x7E]{1,256}$/;
const TOKEN_HASH = /^sha256:([0-9a-f]{64})$/;
const SESSION_ID = /^[0-9a-f]{32}$/;
/** 로그인 없이 여는 경로. /api/health는 컨테이너 헬스체크가 부른다 */
const PUBLIC_PATHS = new Set(['/login', '/api/auth/login', '/api/auth/logout', '/api/health']);

/** 환경 변수. 테스트가 process.env 대신 필요한 값만 넘길 수 있게 좁힌 형태 */
export type Env = Record<string, string | undefined>;

/** 설정이 틀리면 인증이 조용히 꺼지지 않도록 던진다 */
export function authConfig(env: Env = process.env): AuthConfig {
  const mode = env.B_STUDIO_AUTH?.trim() || 'none';
  if (mode !== 'none' && mode !== 'token' && mode !== 'proxy') {
    throw new Error(`B_STUDIO_AUTH는 none, token, proxy 중 하나여야 합니다 (지금 값: ${mode})`);
  }
  const config: AuthConfig = {
    mode,
    secret: '',
    tokens: new Map(),
    userHeader: env.B_STUDIO_AUTH_USER_HEADER?.trim().toLowerCase() || 'x-forwarded-user',
    proxySecret: '',
    admins: new Set(splitList(env.B_STUDIO_AUTH_ADMINS)),
    sessionHours: parseHours(env.B_STUDIO_AUTH_SESSION_HOURS),
  };

  if (mode === 'token') {
    config.secret = env.B_STUDIO_AUTH_SECRET ?? '';
    if (config.secret.length < 32) throw new Error('B_STUDIO_AUTH=token이면 B_STUDIO_AUTH_SECRET에 32자 이상의 임의 값을 넣어야 합니다');
    config.tokens = parseTokens(env.B_STUDIO_AUTH_TOKENS);
  }
  if (mode === 'proxy') {
    config.proxySecret = env.B_STUDIO_AUTH_PROXY_SECRET ?? '';
    if (config.proxySecret.length < 32) throw new Error('B_STUDIO_AUTH=proxy면 B_STUDIO_AUTH_PROXY_SECRET에 32자 이상의 임의 값을 넣고, SSO 프록시가 같은 값을 x-b-studio-proxy-secret 헤더로 보내게 해야 합니다');
  }
  return config;
}

/** "alice:토큰,bob:sha256:<64자리 16진수>" */
function parseTokens(value: string | undefined): Map<string, TokenEntry> {
  const tokens = new Map<string, TokenEntry>();
  const digests = new Set<string>();
  for (const entry of splitList(value)) {
    const colon = entry.indexOf(':');
    const name = entry.slice(0, colon);
    const secret = entry.slice(colon + 1);
    if (colon <= 0 || !USER_NAME.test(name)) throw new Error(`B_STUDIO_AUTH_TOKENS의 "${name || entry.slice(0, 16)}"는 "이름:토큰" 형식이 아니거나 이름에 쓸 수 없는 글자가 있습니다`);
    const hashed = TOKEN_HASH.exec(secret);
    if (!hashed && secret.length < 24) throw new Error(`B_STUDIO_AUTH_TOKENS에서 ${name}의 토큰은 24자 이상이거나 "sha256:<64자리 16진수>" 해시여야 합니다`);
    if (tokens.has(name)) throw new Error(`B_STUDIO_AUTH_TOKENS에 ${name}이 두 번 있습니다`);
    // 평문과 해시가 섞여 있어도 같은 토큰을 두 사람이 쓰는지 해시로 비교한다
    const digest = hashed ? hashed[1]! : hashToken(secret);
    if (digests.has(digest)) throw new Error('B_STUDIO_AUTH_TOKENS에 같은 토큰을 쓰는 사용자가 있습니다');
    digests.add(digest);
    tokens.set(name, hashed ? { kind: 'sha256', hash: digest } : { kind: 'plain', value: secret });
  }
  if (tokens.size === 0) throw new Error('B_STUDIO_AUTH=token이면 B_STUDIO_AUTH_TOKENS에 "이름:토큰"을 하나 이상 넣어야 합니다');
  return tokens;
}

function parseHours(value: string | undefined): number {
  if (!value?.trim()) return 12;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 720) throw new Error(`B_STUDIO_AUTH_SESSION_HOURS는 0보다 크고 720 이하인 숫자여야 합니다 (지금 값: ${value})`);
  return hours;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function mac(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** 접근 토큰의 SHA-256 해시(16진수). B_STUDIO_AUTH_TOKENS에 "이름:sha256:<해시>"로 넣는다 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * 이름과 토큰이 함께 맞으면 사용자 이름. 없는 이름도 같은 해시 계산과 비교를 거쳐, 걸린 시간으로 이름이 있는지 알아내지 못하게 한다.
 * 토큰은 24자 이상의 임의 값이라 해시 한 번으로 충분하다(비밀번호처럼 사람이 고른 값이 아니다)
 */
export function verifyLogin(config: AuthConfig, name: string, token: string): string | undefined {
  const entry = config.tokens.get(name);
  const expected = entry ? (entry.kind === 'sha256' ? entry.hash : hashToken(entry.value)) : '0'.repeat(64);
  const matched = safeEqual(hashToken(token), expected);
  return entry && matched && token.length > 0 ? name : undefined;
}

export function newSessionId(): string {
  return randomBytes(16).toString('hex');
}

export function signSession(user: string, secret: string, now: number, hours: number, sid = newSessionId()): string {
  const payload = Buffer.from(JSON.stringify({ u: user, sid, iat: now, exp: now + hours * 3_600_000 })).toString('base64url');
  return `${payload}.${mac(payload, secret)}`;
}

/** "내용.서명" 형식의 값을 서명 키로 확인하고 내용을 돌려준다 */
function readSigned(value: string | undefined, key: string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra !== undefined || !safeEqual(signature, mac(payload, key))) return undefined;
  try {
    const data: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** 로그아웃한 세션이거나, 운영자가 무효화한 시각 이전에 발급한 쿠키인지 */
export function isRevoked(user: string, sid: string | undefined, issuedAt: number, revocations: Revocations): boolean {
  if (sid !== undefined && revocations.sessions[sid] !== undefined) return true;
  const notBefore = revocations.users[user];
  return notBefore !== undefined && issuedAt <= notBefore;
}

/**
 * 서명·만료·무효화를 확인한 쿠키의 내용. 운영자가 토큰 목록에서 뺀 사용자의 쿠키도 거부한다.
 * 세션 ID가 없는 이전 형식의 쿠키는 받지 않아, 무효화할 수 없는 쿠키가 남지 않게 한다
 */
export function sessionClaims(cookie: string | undefined, config: AuthConfig, now = Date.now(), revocations: Revocations = NO_REVOCATIONS): SessionClaims | undefined {
  const data = readSigned(cookie, config.secret);
  if (!data || typeof data.u !== 'string' || typeof data.sid !== 'string' || !SESSION_ID.test(data.sid) || typeof data.iat !== 'number' || typeof data.exp !== 'number') {
    return undefined;
  }
  if (data.exp <= now || !config.tokens.has(data.u) || isRevoked(data.u, data.sid, data.iat, revocations)) return undefined;
  return { user: data.u, sid: data.sid, issuedAt: data.iat, expiresAt: data.exp };
}

export function sessionUser(cookie: string | undefined, config: AuthConfig, now = Date.now(), revocations: Revocations = NO_REVOCATIONS): string | undefined {
  return sessionClaims(cookie, config, now, revocations)?.user;
}

/** 요청을 보낸 사용자. 확인하지 못하면 undefined */
export function identify(headers: Headers, cookie: string | undefined, config: AuthConfig, now = Date.now(), revocations: Revocations = NO_REVOCATIONS): string | undefined {
  switch (config.mode) {
    case 'none':
      return LOCAL_USER;
    case 'token':
      return sessionUser(cookie, config, now, revocations);
    case 'proxy': {
      const given = headers.get(PROXY_SECRET_HEADER);
      const user = headers.get(config.userHeader)?.trim();
      if (!given || !safeEqual(given, config.proxySecret) || !user || !HEADER_USER.test(user)) return undefined;
      return user;
    }
  }
}

/** 세션을 바꿀 수 있는지. 인증을 켜면 만든 사람과 관리자만 바꿀 수 있고, 만든 사람이 기록되지 않은 세션은 관리자만 바꾼다 */
export function canManage(user: string, owner: string | undefined, config: AuthConfig): boolean {
  return config.mode === 'none' || (owner !== undefined && owner === user) || config.admins.has(user);
}

/**
 * 상태를 바꾸는 요청이 스튜디오 화면에서 왔는지. 다른 사이트가 사용자의 브라우저로 스튜디오에 요청을 보내는 것을 막는다.
 * Origin이 없는 요청(curl, CLI)은 쿠키를 싣지 않으므로 인증으로 걸러진다
 */
export function isSameOrigin(headers: Headers): boolean {
  const origin = headers.get('origin');
  if (!origin) return true;
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** 로그인 뒤 돌아갈 경로. 다른 사이트로 보내는 주소("//evil", "https://…")는 첫 화면으로 바꾼다 */
export function safeNextPath(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

/** 미리보기 게이트웨이에서 쓰는 값의 종류. 티켓을 쿠키로, 쿠키를 티켓으로 바꿔 쓰지 못하게 서명 내용에 넣는다 */
export type PreviewGrantKind = 'ticket' | 'cookie';

/** 미리보기 호스트 하나를 볼 수 있다는 증명. 스튜디오가 티켓으로 발급하고, 게이트웨이가 쿠키로 바꿔 준다 */
export interface PreviewGrant {
  /** 포트를 뺀 소문자 미리보기 호스트 이름 */
  host: string;
  user: string;
  /** token 모드에서 티켓을 받은 스튜디오 로그인 세션. 그 세션을 로그아웃하면 미리보기 쿠키도 거부한다 */
  sid?: string;
  issuedAt: number;
  expiresAt: number;
  /** 티켓을 한 번만 쓰게 하는 임의 값 */
  nonce?: string;
  /** 티켓을 받은 스튜디오 로그인의 만료 시각. 미리보기 쿠키가 그보다 오래가지 않게 한다 */
  sessionExpiresAt?: number;
}

/** 미리보기 서명 키. 세션 쿠키 서명과 같은 키를 쓰지 않도록 운영자 비밀 값에서 용도별 키를 만든다 */
function previewKey(config: AuthConfig): string {
  return createHmac('sha256', config.mode === 'proxy' ? config.proxySecret : config.secret)
    .update('b-studio preview access')
    .digest('base64url');
}

function hostName(host: string): string {
  return host.replace(/:\d+$/, '').toLowerCase();
}

export function signPreviewGrant(kind: PreviewGrantKind, grant: PreviewGrant, config: AuthConfig): string {
  const payload = Buffer.from(
    JSON.stringify({ k: kind, h: hostName(grant.host), u: grant.user, sid: grant.sid, iat: grant.issuedAt, exp: grant.expiresAt, n: grant.nonce, l: grant.sessionExpiresAt }),
  ).toString('base64url');
  return `${payload}.${mac(payload, previewKey(config))}`;
}

/** 서명, 종류, 호스트, 만료를 확인한다. token 모드는 로그아웃·무효화·토큰 목록에서 빠진 사용자까지 확인한다 */
export function verifyPreviewGrant(
  value: string | undefined,
  kind: PreviewGrantKind,
  host: string,
  config: AuthConfig,
  now = Date.now(),
  revocations: Revocations = NO_REVOCATIONS,
): PreviewGrant | undefined {
  if (config.mode === 'none') return undefined;
  const data = readSigned(value, previewKey(config));
  if (!data || data.k !== kind || typeof data.h !== 'string' || typeof data.u !== 'string' || typeof data.iat !== 'number' || typeof data.exp !== 'number') return undefined;
  if (data.h !== hostName(host) || data.exp <= now) return undefined;
  const sid = typeof data.sid === 'string' ? data.sid : undefined;
  if (config.mode === 'token' && (!sid || !config.tokens.has(data.u) || isRevoked(data.u, sid, data.iat, revocations))) return undefined;
  return {
    host: data.h,
    user: data.u,
    sid,
    issuedAt: data.iat,
    expiresAt: data.exp,
    nonce: typeof data.n === 'string' ? data.n : undefined,
    sessionExpiresAt: typeof data.l === 'number' ? data.l : undefined,
  };
}

export type RequestDecision =
  | { kind: 'pass' }
  | { kind: 'allow'; user: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'reject'; status: 401 | 403 | 500; message: string };

export interface IncomingRequest {
  method: string;
  pathname: string;
  search: string;
  headers: Headers;
  cookie?: string;
}

/**
 * proxy.ts가 요청마다 내리는 판단. 화면이 아닌 곳에서 시험할 수 있게 NextRequest에 기대지 않는다.
 * 무효화 기록은 token 모드에서 사용자를 확인할 때만 읽고, 읽지 못하면 인증을 건너뛰지 않고 막는다
 */
export function decideRequest(
  request: IncomingRequest,
  env: Env = process.env,
  now = Date.now(),
  loadRevocations: () => Revocations = () => NO_REVOCATIONS,
): RequestDecision {
  let config: AuthConfig;
  try {
    config = authConfig(env);
  } catch (error) {
    return { kind: 'reject', status: 500, message: error instanceof Error ? error.message : String(error) };
  }

  const api = request.pathname.startsWith('/api/');
  if (api && request.method !== 'GET' && request.method !== 'HEAD' && !isSameOrigin(request.headers)) {
    return { kind: 'reject', status: 403, message: '다른 출처에서 보낸 요청은 받지 않습니다' };
  }
  if (PUBLIC_PATHS.has(request.pathname)) return { kind: 'pass' };

  let revocations = NO_REVOCATIONS;
  if (config.mode === 'token') {
    try {
      revocations = loadRevocations();
    } catch (error) {
      return { kind: 'reject', status: 500, message: error instanceof Error ? error.message : String(error) };
    }
  }
  const user = identify(request.headers, request.cookie, config, now, revocations);
  if (user) return { kind: 'allow', user };
  if (api) return { kind: 'reject', status: 401, message: '로그인이 필요합니다' };
  if (config.mode === 'token') return { kind: 'redirect', location: `/login?next=${encodeURIComponent(request.pathname + request.search)}` };
  return { kind: 'reject', status: 401, message: '사내 SSO 프록시를 거쳐 접속하세요' };
}
