import { describe, expect, it } from 'vitest';
import {
  authConfig,
  canManage,
  decideRequest,
  identify,
  isSameOrigin,
  LOCAL_USER,
  PROXY_SECRET_HEADER,
  safeNextPath,
  sessionUser,
  signSession,
  USER_HEADER,
  userForToken,
} from './auth';

const SECRET = 's'.repeat(40);
const ALICE = 'a'.repeat(30);
const BOB = 'b'.repeat(30);
const TOKEN_ENV = { B_STUDIO_AUTH: 'token', B_STUDIO_AUTH_SECRET: SECRET, B_STUDIO_AUTH_TOKENS: `alice:${ALICE}, bob:${BOB}`, B_STUDIO_AUTH_ADMINS: 'bob' };
const PROXY_SECRET = 'p'.repeat(40);
const PROXY_ENV = { B_STUDIO_AUTH: 'proxy', B_STUDIO_AUTH_PROXY_SECRET: PROXY_SECRET, B_STUDIO_AUTH_USER_HEADER: 'X-Forwarded-Email' };
const NOW = 1_800_000_000_000;

const request = (pathname: string, init: { method?: string; headers?: Record<string, string>; cookie?: string; search?: string } = {}) => ({
  method: init.method ?? 'GET',
  pathname,
  search: init.search ?? '',
  headers: new Headers({ host: 'studio.internal:3000', ...init.headers }),
  cookie: init.cookie,
});

describe('authConfig', () => {
  it('설정하지 않으면 인증 없이 동작하고, 모르는 값과 약한 설정은 거부한다', () => {
    expect(authConfig({}).mode).toBe('none');
    expect(() => authConfig({ B_STUDIO_AUTH: 'sso' })).toThrow('none, token, proxy');
    expect(() => authConfig({ ...TOKEN_ENV, B_STUDIO_AUTH_SECRET: 'short' })).toThrow('32자 이상');
    expect(() => authConfig({ ...TOKEN_ENV, B_STUDIO_AUTH_TOKENS: '' })).toThrow('하나 이상');
    expect(() => authConfig({ ...TOKEN_ENV, B_STUDIO_AUTH_TOKENS: 'alice:short' })).toThrow('24자 이상');
    expect(() => authConfig({ ...TOKEN_ENV, B_STUDIO_AUTH_TOKENS: `김철수:${ALICE}` })).toThrow('쓸 수 없는 글자');
    expect(() => authConfig({ ...TOKEN_ENV, B_STUDIO_AUTH_TOKENS: `alice:${ALICE},carol:${ALICE}` })).toThrow('같은 토큰');
    expect(() => authConfig({ ...PROXY_ENV, B_STUDIO_AUTH_PROXY_SECRET: '' })).toThrow('32자 이상');
    expect(() => authConfig({ ...TOKEN_ENV, B_STUDIO_AUTH_SESSION_HOURS: '0' })).toThrow('SESSION_HOURS');

    const token = authConfig(TOKEN_ENV);
    expect([...token.tokens.keys()]).toEqual(['alice', 'bob']);
    expect(token.admins).toEqual(new Set(['bob']));
    expect(token.sessionHours).toBe(12);
    expect(authConfig(PROXY_ENV).userHeader).toBe('x-forwarded-email');
  });
});

describe('토큰 로그인과 세션 쿠키', () => {
  const config = authConfig(TOKEN_ENV);

  it('맞는 토큰의 사용자를 찾는다', () => {
    expect(userForToken(config, ALICE)).toBe('alice');
    expect(userForToken(config, 'x'.repeat(30))).toBeUndefined();
    expect(userForToken(config, '')).toBeUndefined();
  });

  it('서명한 쿠키만 받고, 고치거나 만료되거나 목록에서 빠진 사용자의 쿠키는 거부한다', () => {
    const cookie = signSession('alice', SECRET, NOW, 12);
    expect(sessionUser(cookie, config, NOW + 1_000)).toBe('alice');

    const [payload, signature] = cookie.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'bob', exp: NOW + 3_600_000 })).toString('base64url');
    expect(sessionUser(`${forged}.${signature}`, config, NOW)).toBeUndefined();
    expect(sessionUser(`${payload}.${signature}x`, config, NOW)).toBeUndefined();
    expect(sessionUser(signSession('alice', 'z'.repeat(40), NOW, 12), config, NOW)).toBeUndefined();
    expect(sessionUser(cookie, config, NOW + 12 * 3_600_000 + 1)).toBeUndefined();
    expect(sessionUser(signSession('carol', SECRET, NOW, 12), config, NOW)).toBeUndefined();
    expect(sessionUser('garbage', config, NOW)).toBeUndefined();
    expect(sessionUser(undefined, config, NOW)).toBeUndefined();
  });
});

describe('identify', () => {
  it('token 모드는 쿠키만 믿고, 브라우저가 보낸 내부 사용자 헤더는 무시한다', () => {
    const config = authConfig(TOKEN_ENV);
    expect(identify(new Headers({ [USER_HEADER]: 'alice' }), undefined, config, NOW)).toBeUndefined();
    expect(identify(new Headers(), signSession('bob', SECRET, NOW, 1), config, NOW)).toBe('bob');
  });

  it('proxy 모드는 SSO 프록시만 아는 값이 맞을 때만 사용자 헤더를 믿는다', () => {
    const config = authConfig(PROXY_ENV);
    expect(identify(new Headers({ 'x-forwarded-email': 'alice@corp.example', [PROXY_SECRET_HEADER]: PROXY_SECRET }), undefined, config)).toBe('alice@corp.example');
    expect(identify(new Headers({ 'x-forwarded-email': 'alice@corp.example' }), undefined, config)).toBeUndefined();
    expect(identify(new Headers({ 'x-forwarded-email': 'alice@corp.example', [PROXY_SECRET_HEADER]: 'q'.repeat(40) }), undefined, config)).toBeUndefined();
    expect(identify(new Headers({ [PROXY_SECRET_HEADER]: PROXY_SECRET }), undefined, config)).toBeUndefined();
  });

  it('인증을 켜지 않으면 로컬 사용자로 본다', () => {
    expect(identify(new Headers(), undefined, authConfig({}))).toBe(LOCAL_USER);
  });
});

describe('권한과 출처', () => {
  it('인증을 켜면 만든 사람과 관리자만 세션을 바꾼다', () => {
    const config = authConfig(TOKEN_ENV);
    expect(canManage('alice', 'alice', config)).toBe(true);
    expect(canManage('alice', 'bob', config)).toBe(false);
    expect(canManage('bob', 'alice', config)).toBe(true);
    expect(canManage('alice', undefined, config)).toBe(false);
    expect(canManage(LOCAL_USER, undefined, authConfig({}))).toBe(true);
  });

  it('상태를 바꾸는 요청의 출처를 확인한다', () => {
    expect(isSameOrigin(new Headers({ host: 'studio.internal:3000', origin: 'http://studio.internal:3000' }))).toBe(true);
    expect(isSameOrigin(new Headers({ host: 'studio.internal:3000', origin: 'https://evil.example' }))).toBe(false);
    expect(isSameOrigin(new Headers({ host: '127.0.0.1:3000', 'x-forwarded-host': 'studio.corp.example', origin: 'https://studio.corp.example' }))).toBe(true);
    expect(isSameOrigin(new Headers({ host: 'studio.internal:3000', origin: 'null' }))).toBe(false);
    expect(isSameOrigin(new Headers({ host: 'studio.internal:3000' }))).toBe(true);
  });

  it('로그인 뒤 다른 사이트로 보내지 않는다', () => {
    expect(safeNextPath('/sessions/abc?tab=code')).toBe('/sessions/abc?tab=code');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
  });
});

describe('decideRequest', () => {
  it('token 모드: 로그인하지 않은 화면은 로그인으로 보내고 API는 401, 로그인 경로는 통과시킨다', () => {
    expect(decideRequest(request('/sessions/abc', { search: '?tab=code' }), TOKEN_ENV, NOW)).toEqual({ kind: 'redirect', location: '/login?next=%2Fsessions%2Fabc%3Ftab%3Dcode' });
    expect(decideRequest(request('/api/projects'), TOKEN_ENV, NOW)).toMatchObject({ kind: 'reject', status: 401 });
    expect(decideRequest(request('/api/projects', { headers: { [USER_HEADER]: 'alice' } }), TOKEN_ENV, NOW)).toMatchObject({ kind: 'reject', status: 401 });
    expect(decideRequest(request('/login'), TOKEN_ENV, NOW)).toEqual({ kind: 'pass' });
    expect(decideRequest(request('/api/projects', { cookie: signSession('alice', SECRET, NOW, 1) }), TOKEN_ENV, NOW)).toEqual({ kind: 'allow', user: 'alice' });
  });

  it('다른 출처에서 보낸 상태 변경 요청은 인증 모드와 상관없이 막는다', () => {
    const crossSite = { method: 'POST', headers: { origin: 'https://evil.example' } };
    expect(decideRequest(request('/api/sessions', crossSite), {}, NOW)).toMatchObject({ kind: 'reject', status: 403 });
    expect(decideRequest(request('/api/auth/login', crossSite), TOKEN_ENV, NOW)).toMatchObject({ kind: 'reject', status: 403 });
    expect(decideRequest(request('/api/sessions', { method: 'POST', headers: { origin: 'http://studio.internal:3000' } }), {}, NOW)).toEqual({ kind: 'allow', user: LOCAL_USER });
  });

  it('proxy 모드는 로그인 화면 대신 SSO를 거치라고 알리고, 설정이 틀리면 500으로 막는다', () => {
    expect(decideRequest(request('/'), PROXY_ENV, NOW)).toMatchObject({ kind: 'reject', status: 401 });
    expect(decideRequest(request('/', { headers: { 'x-forwarded-email': 'alice@corp.example', [PROXY_SECRET_HEADER]: PROXY_SECRET } }), PROXY_ENV, NOW)).toEqual({
      kind: 'allow',
      user: 'alice@corp.example',
    });
    expect(decideRequest(request('/'), { B_STUDIO_AUTH: 'token' }, NOW)).toMatchObject({ kind: 'reject', status: 500 });
  });
});
