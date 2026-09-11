import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 스튜디오 접근 인증. proxy.ts가 모든 요청 앞에서 쓰므로 무거운 서버 모듈(에이전트, 샌드박스)을 불러오지 않는다.
 * none: 인증 없음(루프백에 띄운 개인 PC용), token: 운영자가 준 접근 토큰으로 로그인, proxy: 사내 SSO 프록시가 넣은 사용자 헤더
 */
export type AuthMode = 'none' | 'token' | 'proxy';

export interface AuthConfig {
  mode: AuthMode;
  /** token 모드의 세션 쿠키 서명 키 */
  secret: string;
  /** token 모드의 사용자 이름별 접근 토큰 */
  tokens: Map<string, string>;
  /** proxy 모드에서 SSO 프록시가 사용자를 넣는 헤더 */
  userHeader: string;
  /** proxy 모드에서 SSO 프록시만 아는 값. 스튜디오 포트로 바로 들어와 사용자 헤더를 꾸미는 요청을 막는다 */
  proxySecret: string;
  admins: Set<string>;
  sessionHours: number;
}

export const SESSION_COOKIE = 'b_studio_session';
/** proxy.ts가 확인한 사용자를 라우트에 넘기는 내부 헤더. 브라우저가 보낸 같은 이름의 헤더는 proxy.ts가 지운다 */
export const USER_HEADER = 'x-b-studio-user';
export const PROXY_SECRET_HEADER = 'x-b-studio-proxy-secret';
export const LOCAL_USER = 'local';

const USER_NAME = /^[A-Za-z0-9._@-]{1,64}$/;
const HEADER_USER = /^[\x21-\x7E]{1,256}$/;
const PUBLIC_PATHS = new Set(['/login', '/api/auth/login', '/api/auth/logout']);

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

/** "alice:토큰,bob:토큰" */
function parseTokens(value: string | undefined): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const entry of splitList(value)) {
    const colon = entry.indexOf(':');
    const name = entry.slice(0, colon);
    const token = entry.slice(colon + 1);
    if (colon <= 0 || !USER_NAME.test(name)) throw new Error(`B_STUDIO_AUTH_TOKENS의 "${name || entry.slice(0, 16)}"는 "이름:토큰" 형식이 아니거나 이름에 쓸 수 없는 글자가 있습니다`);
    if (token.length < 24) throw new Error(`B_STUDIO_AUTH_TOKENS에서 ${name}의 토큰은 24자 이상이어야 합니다`);
    if (tokens.has(name)) throw new Error(`B_STUDIO_AUTH_TOKENS에 ${name}이 두 번 있습니다`);
    if ([...tokens.values()].includes(token)) throw new Error('B_STUDIO_AUTH_TOKENS에 같은 토큰을 쓰는 사용자가 있습니다');
    tokens.set(name, token);
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

/** 토큰이 맞는 사용자. 처음 맞는 곳에서 멈추지 않고 모두 비교해 걸린 시간으로 토큰을 알아내지 못하게 한다 */
export function userForToken(config: AuthConfig, token: string): string | undefined {
  let found: string | undefined;
  for (const [name, expected] of config.tokens) {
    if (safeEqual(token, expected)) found = name;
  }
  return found;
}

export function signSession(user: string, secret: string, now: number, hours: number): string {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: now + hours * 3_600_000 })).toString('base64url');
  return `${payload}.${mac(payload, secret)}`;
}

/** 서명과 만료를 확인한 쿠키의 사용자. 운영자가 토큰 목록에서 뺀 사용자의 쿠키도 거부한다 */
export function sessionUser(cookie: string | undefined, config: AuthConfig, now = Date.now()): string | undefined {
  if (!cookie) return undefined;
  const [payload, signature, extra] = cookie.split('.');
  if (!payload || !signature || extra !== undefined || !safeEqual(signature, mac(payload, config.secret))) return undefined;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: unknown; exp?: unknown };
    if (typeof data.u !== 'string' || typeof data.exp !== 'number' || data.exp <= now) return undefined;
    return config.tokens.has(data.u) ? data.u : undefined;
  } catch {
    return undefined;
  }
}

/** 요청을 보낸 사용자. 확인하지 못하면 undefined */
export function identify(headers: Headers, cookie: string | undefined, config: AuthConfig, now = Date.now()): string | undefined {
  switch (config.mode) {
    case 'none':
      return LOCAL_USER;
    case 'token':
      return sessionUser(cookie, config, now);
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

/** proxy.ts가 요청마다 내리는 판단. 화면이 아닌 곳에서 시험할 수 있게 NextRequest에 기대지 않는다 */
export function decideRequest(request: IncomingRequest, env: Env = process.env, now = Date.now()): RequestDecision {
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

  const user = identify(request.headers, request.cookie, config, now);
  if (user) return { kind: 'allow', user };
  if (api) return { kind: 'reject', status: 401, message: '로그인이 필요합니다' };
  if (config.mode === 'token') return { kind: 'redirect', location: `/login?next=${encodeURIComponent(request.pathname + request.search)}` };
  return { kind: 'reject', status: 401, message: '사내 SSO 프록시를 거쳐 접속하세요' };
}
