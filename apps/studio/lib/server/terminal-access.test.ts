import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('cookieValue', () => {
  it('Cookie 헤더에서 이름 하나의 값을 꺼낸다', () => {
    expect(cookieValue(headers({ cookie: 'a=1; b_studio_local=xyz; c=3' }), 'b_studio_local')).toBe('xyz');
    expect(cookieValue(headers({ cookie: 'other=1' }), 'b_studio_local')).toBeUndefined();
    expect(cookieValue(headers(), 'b_studio_local')).toBeUndefined();
    // 이름이 접두사로만 겹치는 값은 꺼내지 않는다
    expect(cookieValue(headers({ cookie: 'b_studio_local_extra=1' }), 'b_studio_local')).toBeUndefined();
  });
});
