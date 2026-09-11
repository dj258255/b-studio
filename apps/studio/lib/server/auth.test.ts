import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authConfig,
  canManage,
  decideRequest,
  hashToken,
  identify,
  isSameOrigin,
  LOCAL_USER,
  PROXY_SECRET_HEADER,
  safeNextPath,
  sessionClaims,
  sessionUser,
  signPreviewGrant,
  signSession,
  USER_HEADER,
  verifyLogin,
  verifyPreviewGrant,
} from './auth';

const SECRET = 's'.repeat(40);
const ALICE = 'a'.repeat(30);
const BOB = 'b'.repeat(30);
const TOKEN_ENV = { B_STUDIO_AUTH: 'token', B_STUDIO_AUTH_SECRET: SECRET, B_STUDIO_AUTH_TOKENS: `alice:${ALICE}, bob:sha256:${hashToken(BOB)}`, B_STUDIO_AUTH_ADMINS: 'bob' };
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
    expect(() => authConfig({ ...TOKEN_ENV, B_STUDIO_AUTH_TOKENS: 'alice:sha256:abc' })).toThrow('24자 이상');
    expect(() => authConfig({ ...TOKEN_ENV, B_STUDIO_AUTH_TOKENS: `김철수:${ALICE}` })).toThrow('쓸 수 없는 글자');
    expect(() => authConfig({ ...TOKEN_ENV, B_STUDIO_AUTH_TOKENS: `alice:${ALICE},carol:${ALICE}` })).toThrow('같은 토큰');
    // 한쪽은 평문, 한쪽은 해시로 적어도 같은 토큰이면 거부한다
    expect(() => authConfig({ ...TOKEN_ENV, B_STUDIO_AUTH_TOKENS: `alice:${ALICE},carol:sha256:${hashToken(ALICE)}` })).toThrow('같은 토큰');
    expect(() => authConfig({ ...PROXY_ENV, B_STUDIO_AUTH_PROXY_SECRET: '' })).toThrow('32자 이상');
    expect(() => authConfig({ ...TOKEN_ENV, B_STUDIO_AUTH_SESSION_HOURS: '0' })).toThrow('SESSION_HOURS');

    const token = authConfig(TOKEN_ENV);
    expect([...token.tokens.keys()]).toEqual(['alice', 'bob']);
    expect(token.tokens.get('bob')).toEqual({ kind: 'sha256', hash: hashToken(BOB) });
    expect(token.admins).toEqual(new Set(['bob']));
    expect(token.sessionHours).toBe(12);
    expect(authConfig(PROXY_ENV).userHeader).toBe('x-forwarded-email');
  });
});

describe('토큰 로그인과 세션 쿠키', () => {
  const config = authConfig(TOKEN_ENV);

  it('이름과 토큰이 함께 맞아야 하고, 해시로 둔 토큰도 확인한다', () => {
    expect(verifyLogin(config, 'alice', ALICE)).toBe('alice');
    expect(verifyLogin(config, 'bob', BOB)).toBe('bob');
    expect(verifyLogin(config, 'bob', ALICE)).toBeUndefined();
    expect(verifyLogin(config, 'alice', 'x'.repeat(30))).toBeUndefined();
    expect(verifyLogin(config, 'carol', ALICE)).toBeUndefined();
    expect(verifyLogin(config, 'alice', '')).toBeUndefined();
  });

  it('로그인마다 새 세션 ID를 넣고, 서명한 쿠키만 받으며 고치거나 만료되거나 목록에서 빠진 사용자의 쿠키는 거부한다', () => {
    const cookie = signSession('alice', SECRET, NOW, 12);
    const claims = sessionClaims(cookie, config, NOW + 1_000);
    expect(claims).toMatchObject({ user: 'alice', issuedAt: NOW, expiresAt: NOW + 12 * 3_600_000 });
    expect(claims!.sid).toMatch(/^[0-9a-f]{32}$/);
    expect(sessionClaims(signSession('alice', SECRET, NOW, 12), config, NOW)!.sid).not.toBe(claims!.sid);

    const [payload, signature] = cookie.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'bob', sid: claims!.sid, iat: NOW, exp: NOW + 3_600_000 })).toString('base64url');
    expect(sessionUser(`${forged}.${signature}`, config, NOW)).toBeUndefined();
    expect(sessionUser(`${payload}.${signature}x`, config, NOW)).toBeUndefined();
    expect(sessionUser(signSession('alice', 'z'.repeat(40), NOW, 12), config, NOW)).toBeUndefined();
    expect(sessionUser(cookie, config, NOW + 12 * 3_600_000 + 1)).toBeUndefined();
    expect(sessionUser(signSession('carol', SECRET, NOW, 12), config, NOW)).toBeUndefined();
    expect(sessionUser('garbage', config, NOW)).toBeUndefined();
    expect(sessionUser(undefined, config, NOW)).toBeUndefined();

    // 세션 ID가 없던 이전 형식의 쿠키는 서명이 맞아도 받지 않는다
    const legacy = Buffer.from(JSON.stringify({ u: 'alice', exp: NOW + 3_600_000 })).toString('base64url');
    expect(sessionUser(`${legacy}.${createHmac('sha256', SECRET).update(legacy).digest('base64url')}`, config, NOW)).toBeUndefined();
  });

  it('로그아웃한 세션 ID와, 무효화한 시각까지 발급한 사용자의 쿠키를 거부한다', () => {
    const cookie = signSession('alice', SECRET, NOW, 12);
    const { sid, expiresAt } = sessionClaims(cookie, config, NOW)!;
    expect(sessionUser(cookie, config, NOW, { sessions: { [sid]: expiresAt }, users: {} })).toBeUndefined();
    expect(sessionUser(signSession('alice', SECRET, NOW, 12), config, NOW, { sessions: { [sid]: expiresAt }, users: {} })).toBe('alice');
    expect(sessionUser(cookie, config, NOW, { sessions: {}, users: { alice: NOW } })).toBeUndefined();
    expect(sessionUser(signSession('alice', SECRET, NOW + 1, 12), config, NOW + 2, { sessions: {}, users: { alice: NOW } })).toBe('alice');
    expect(sessionUser(cookie, config, NOW, { sessions: {}, users: { bob: NOW } })).toBe('alice');
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
    expect(decideRequest(request('/api/health'), TOKEN_ENV, NOW)).toEqual({ kind: 'pass' });
    expect(decideRequest(request('/api/projects', { cookie: signSession('alice', SECRET, NOW, 1) }), TOKEN_ENV, NOW)).toEqual({ kind: 'allow', user: 'alice' });
  });

  it('token 모드는 무효화 기록을 읽어 로그아웃한 쿠키를 거부하고, 기록을 읽지 못하면 500으로 막는다', () => {
    const cookie = signSession('alice', SECRET, NOW, 1);
    const { sid } = sessionClaims(cookie, authConfig(TOKEN_ENV), NOW)!;
    expect(decideRequest(request('/api/projects', { cookie }), TOKEN_ENV, NOW, () => ({ sessions: { [sid]: NOW + 3_600_000 }, users: {} }))).toMatchObject({ kind: 'reject', status: 401 });
    const broken = () => {
      throw new Error('revocations.json을(를) 읽지 못했습니다');
    };
    expect(decideRequest(request('/api/projects', { cookie }), TOKEN_ENV, NOW, broken)).toMatchObject({ kind: 'reject', status: 500, message: expect.stringContaining('revocations.json') });
    // 로그인 경로와 인증을 끈 스튜디오는 기록을 읽지 않는다
    expect(decideRequest(request('/login'), TOKEN_ENV, NOW, broken)).toEqual({ kind: 'pass' });
    expect(decideRequest(request('/api/projects'), {}, NOW, broken)).toEqual({ kind: 'allow', user: LOCAL_USER });
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

describe('미리보기 접근 티켓과 쿠키', () => {
  const config = authConfig(TOKEN_ENV);
  const HOST = `web--67e417ec--${'c'.repeat(32)}.preview.corp.example`;
  const sid = 'd'.repeat(32);
  const grant = { host: HOST, user: 'alice', sid, issuedAt: NOW, expiresAt: NOW + 60_000, nonce: 'e'.repeat(32), sessionExpiresAt: NOW + 3_600_000 };

  it('서명한 티켓을 같은 호스트에서만 받고, 쿠키 자리에는 쓰지 못한다', () => {
    const ticket = signPreviewGrant('ticket', grant, config);
    expect(verifyPreviewGrant(ticket, 'ticket', `${HOST.toUpperCase()}:4100`, config, NOW + 1_000)).toEqual(grant);
    expect(verifyPreviewGrant(ticket, 'cookie', HOST, config, NOW)).toBeUndefined();
    expect(verifyPreviewGrant(ticket, 'ticket', HOST.replace('web--', 'api--'), config, NOW)).toBeUndefined();
    expect(verifyPreviewGrant(ticket, 'ticket', HOST, config, NOW + 60_000)).toBeUndefined();
    expect(verifyPreviewGrant(`${ticket}x`, 'ticket', HOST, config, NOW)).toBeUndefined();
    // 세션 쿠키 서명 키로 만든 값은 미리보기 서명으로 통하지 않는다
    expect(verifyPreviewGrant(signSession('alice', SECRET, NOW, 1), 'ticket', HOST, config, NOW)).toBeUndefined();
  });

  it('token 모드는 로그아웃한 세션, 무효화한 사용자, 목록에서 빠진 사용자, 세션 ID가 없는 값을 거부한다', () => {
    const cookie = signPreviewGrant('cookie', { ...grant, expiresAt: NOW + 3_600_000 }, config);
    expect(verifyPreviewGrant(cookie, 'cookie', HOST, config, NOW)).toBeDefined();
    expect(verifyPreviewGrant(cookie, 'cookie', HOST, config, NOW, { sessions: { [sid]: NOW + 1 }, users: {} })).toBeUndefined();
    expect(verifyPreviewGrant(cookie, 'cookie', HOST, config, NOW, { sessions: {}, users: { alice: NOW } })).toBeUndefined();
    expect(verifyPreviewGrant(cookie, 'cookie', HOST, authConfig({ ...TOKEN_ENV, B_STUDIO_AUTH_TOKENS: `bob:${BOB}` }), NOW)).toBeUndefined();
    expect(verifyPreviewGrant(signPreviewGrant('cookie', { ...grant, sid: undefined }, config), 'cookie', HOST, config, NOW)).toBeUndefined();
  });

  it('proxy 모드는 세션 ID 없이 프록시 비밀 값에서 만든 키로 확인하고, 인증을 끄면 받지 않는다', () => {
    const proxy = authConfig(PROXY_ENV);
    const proxyGrant = { host: HOST, user: 'alice@corp.example', issuedAt: NOW, expiresAt: NOW + 60_000 };
    const cookie = signPreviewGrant('cookie', proxyGrant, proxy);
    expect(verifyPreviewGrant(cookie, 'cookie', HOST, proxy, NOW)).toEqual(proxyGrant);
    expect(verifyPreviewGrant(cookie, 'cookie', HOST, config, NOW)).toBeUndefined();
    expect(verifyPreviewGrant(cookie, 'cookie', HOST, authConfig({}), NOW)).toBeUndefined();
  });
});
