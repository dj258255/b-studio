import { afterEach, describe, expect, it, vi } from 'vitest';
import { USER_HEADER } from './auth';
import { StudioError } from './errors';

// 로컬 토큰은 파일을 만지지 않게 가짜로 끼운다(진짜는 local-token.test.ts가 본다)
const mocks = vi.hoisted(() => ({ token: 'f'.repeat(64) }));
vi.mock('./local-token', () => ({
  LOCAL_TOKEN_COOKIE: 'b_studio_local',
  hasLocalToken: (cookie: string | undefined) => cookie === mocks.token,
}));
// 세션 복구는 파일을 만지지 않게 가짜로 끼운다(진짜는 session-store·sessions 쪽이 본다)
vi.mock('./sessions', () => ({ recoverSessions: vi.fn(async () => {}) }));

import { recoverSessions } from './sessions';
import { assertLocalRequest, assertLocalToken, assertTerminalAccess, cookieValue } from './terminal-access';

const headers = (over: Record<string, string> = {}): Headers => new Headers(over);

/** 검사가 던진 StudioError의 상태 코드. 던지지 않으면 undefined */
function status(fn: () => void): number | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof StudioError ? error.status : undefined;
  }
}

describe('assertLocalRequest', () => {
  it('이 컴퓨터의 주소(127.0.0.1·localhost·::1)로 온 요청은 지나간다', () => {
    for (const host of ['127.0.0.1:3000', '127.0.0.1', 'localhost:1234', 'LOCALHOST', '[::1]:3000']) {
      expect(() => assertLocalRequest(headers({ host })), host).not.toThrow();
    }
  });

  it('다른 주소는 403으로 막는다(DNS 리바인딩)', () => {
    for (const host of ['evil.example:3000', 'evil.example', '127.0.0.1.evil.example:3000', '192.168.0.10:3000', '']) {
      expect(status(() => assertLocalRequest(headers({ host }))), host).toBe(403);
    }
    // 스크립트가 바꿀 수 있는 x-forwarded-host로는 속이지 못한다
    expect(status(() => assertLocalRequest(headers({ host: 'evil.example', 'x-forwarded-host': '127.0.0.1:3000' })))).toBe(403);
  });
});

/** 인증을 켠 서버 방식의 환경. switchOn이 꺼져 있으면 운영자가 서버 방식 터미널을 켜지 않은 서버다 */
function serverEnv(options: { switchOn: boolean; terminal?: string; experimental?: boolean; auth?: string } = { switchOn: true }): void {
  vi.stubEnv('B_STUDIO_AUTH', options.auth ?? 'token');
  vi.stubEnv('B_STUDIO_AUTH_SECRET', 's'.repeat(40));
  vi.stubEnv('B_STUDIO_AUTH_TOKENS', `kim:${'k'.repeat(32)}`);
  vi.stubEnv('B_STUDIO_SERVER_TERMINAL', options.switchOn ? '1' : '');
  vi.stubEnv('B_STUDIO_TERMINAL', options.terminal ?? 'container');
  vi.stubEnv('B_STUDIO_EXPERIMENTAL', options.experimental === false ? '' : '1');
}

describe('assertLocalRequest: 인증을 켠 서버 방식', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('운영자가 서버 방식 터미널을 켠 서버(컨테이너 방식)에서는 이 컴퓨터가 아닌 주소로 온 요청도 받는다 — 로그인이 근거다', () => {
    serverEnv();
    for (const host of ['studio.example.com', 'studio.example.com:8443', '10.0.0.5:3000', '127.0.0.1:3000']) expect(() => assertLocalRequest(headers({ host })), host).not.toThrow();
  });

  it('스위치가 꺼져 있으면 다른 주소의 요청은 까닭을 적어 403으로 막는다(이 컴퓨터 주소는 라우트가 까닭을 적어 거절한다)', () => {
    serverEnv({ switchOn: false });
    expect(status(() => assertLocalRequest(headers({ host: 'studio.example.com' })))).toBe(403);
    try {
      assertLocalRequest(headers({ host: 'studio.example.com' }));
    } catch (error) {
      expect((error as Error).message).toContain('B_STUDIO_SERVER_TERMINAL=1');
    }
    expect(() => assertLocalRequest(headers({ host: '127.0.0.1:3000' }))).not.toThrow();
  });

  it('스위치를 켜도 이 컴퓨터 방식·실험 기능 없음·틀린 인증 설정·인증 없음이면 다른 주소는 막는다', () => {
    serverEnv({ switchOn: true, terminal: 'host' });
    expect(status(() => assertLocalRequest(headers({ host: 'studio.example.com' })))).toBe(403);
    serverEnv({ switchOn: true, terminal: '' });
    expect(status(() => assertLocalRequest(headers({ host: 'studio.example.com' })))).toBe(403);
    serverEnv({ switchOn: true, experimental: false });
    expect(status(() => assertLocalRequest(headers({ host: 'studio.example.com' })))).toBe(403);
    serverEnv({ switchOn: true, auth: 'bogus' });
    expect(status(() => assertLocalRequest(headers({ host: 'studio.example.com' })))).toBe(403);
    // 인증이 없으면 스위치를 켜도 달라지지 않는다(DNS 리바인딩 방어)
    serverEnv({ switchOn: true, auth: 'none' });
    expect(status(() => assertLocalRequest(headers({ host: 'studio.example.com' })))).toBe(403);
  });
});

describe('assertLocalToken', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('개인 PC 모드(인증 없음)에서는 맞는 로컬 토큰 쿠키가 있어야 지나간다', () => {
    vi.stubEnv('B_STUDIO_AUTH', '');
    expect(status(() => assertLocalToken(headers()))).toBe(403);
    expect(status(() => assertLocalToken(headers({ cookie: 'b_studio_local=deadbeef' })))).toBe(403);
    expect(() => assertLocalToken(headers({ cookie: `b_studio_local=${mocks.token}` }))).not.toThrow();
  });

  it('인증을 켠 서버(token)에서는 이 쿠키를 요구하지 않는다(로그인으로 충분하다)', () => {
    vi.stubEnv('B_STUDIO_AUTH', 'token');
    vi.stubEnv('B_STUDIO_AUTH_SECRET', 's'.repeat(40));
    vi.stubEnv('B_STUDIO_AUTH_TOKENS', `kim:${'k'.repeat(32)}`);
    expect(() => assertLocalToken(headers())).not.toThrow();
  });
});

describe('assertTerminalAccess', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('주소·로컬 토큰·사용자를 차례로 확인하고 세션을 복구한 뒤 사용자를 돌려준다', async () => {
    vi.stubEnv('B_STUDIO_AUTH', '');
    vi.mocked(recoverSessions).mockClear();
    expect(await assertTerminalAccess(headers({ host: '127.0.0.1:3000', cookie: `b_studio_local=${mocks.token}` }))).toBe('local');
    expect(recoverSessions).toHaveBeenCalledTimes(1);
  });

  it('앞의 검사가 실패하면 세션 복구 전에 403으로 막는다', async () => {
    vi.stubEnv('B_STUDIO_AUTH', '');
    vi.mocked(recoverSessions).mockClear();
    // 이 컴퓨터 주소가 아니면 복구 전에 막는다
    await expect(assertTerminalAccess(headers({ host: 'evil.example' }))).rejects.toBeInstanceOf(StudioError);
    expect(recoverSessions).not.toHaveBeenCalled();
    // 로컬 토큰이 없어도 복구 전에 막는다
    vi.mocked(recoverSessions).mockClear();
    await expect(assertTerminalAccess(headers({ host: '127.0.0.1:3000' }))).rejects.toBeInstanceOf(StudioError);
    expect(recoverSessions).not.toHaveBeenCalled();
  });
});

describe('assertTerminalAccess: 인증을 켠 서버 방식', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('스위치를 켠 서버에서 로그인한 사용자는 다른 주소로도 지나가고 사용자 이름을 돌려받는다(로컬 토큰 쿠키는 요구하지 않는다)', async () => {
    serverEnv();
    vi.mocked(recoverSessions).mockClear();
    expect(await assertTerminalAccess(headers({ host: 'studio.example.com', [USER_HEADER]: 'kim' }))).toBe('kim');
    expect(recoverSessions).toHaveBeenCalledTimes(1);
  });

  it('로그인한 사용자 헤더가 없으면(앞단을 거치지 않았거나 로그인이 만료됨) 세션 복구 전에 401로 막는다', async () => {
    serverEnv();
    vi.mocked(recoverSessions).mockClear();
    await expect(assertTerminalAccess(headers({ host: 'studio.example.com' }))).rejects.toMatchObject({ status: 401 });
    expect(recoverSessions).not.toHaveBeenCalled();
  });

  it('스위치가 꺼진 서버에서는 로그인한 사용자도 다른 주소로는 지나가지 못한다', async () => {
    serverEnv({ switchOn: false });
    vi.mocked(recoverSessions).mockClear();
    await expect(assertTerminalAccess(headers({ host: 'studio.example.com', [USER_HEADER]: 'kim' }))).rejects.toMatchObject({ status: 403 });
    expect(recoverSessions).not.toHaveBeenCalled();
  });
});

describe('cookieValue', () => {
  it('Cookie 헤더에서 이름 하나의 값을 꺼낸다', () => {
    expect(cookieValue(headers({ cookie: 'a=1; b_studio_local=xyz; c=3' }), 'b_studio_local')).toBe('xyz');
    expect(cookieValue(headers({ cookie: 'other=1' }), 'b_studio_local')).toBeUndefined();
    expect(cookieValue(headers(), 'b_studio_local')).toBeUndefined();
    // 이름이 접두사로만 겹치는 값은 꺼내지 않는다
    expect(cookieValue(headers({ cookie: 'b_studio_local_extra=1' }), 'b_studio_local')).toBeUndefined();
  });
});
