import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from './errors';

const mocks = vi.hoisted(() => ({
  snapshot: undefined as { owner?: string } | undefined,
  recoverSessions: vi.fn(async () => {}),
}));

vi.mock('./sessions', () => ({ getSnapshot: () => mocks.snapshot, recoverSessions: mocks.recoverSessions }));

import { authorizeSession, authorizeSessionOwner } from './access';

const SECRET = 's'.repeat(40);

/** 인증을 켠 서버. admin은 관리자다 */
function serverMode(): void {
  vi.stubEnv('B_STUDIO_AUTH', 'proxy');
  vi.stubEnv('B_STUDIO_AUTH_PROXY_SECRET', SECRET);
  vi.stubEnv('B_STUDIO_AUTH_ADMINS', 'admin');
}

async function status(run: Promise<void>): Promise<number> {
  try {
    await run;
    return 200;
  } catch (error) {
    if (error instanceof StudioError) return error.status;
    throw error;
  }
}

beforeEach(() => {
  mocks.snapshot = { owner: 'kim' };
  mocks.recoverSessions.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('authorizeSessionOwner: 터미널을 움직이는 요청(서버 방식에서 관리자도 남의 터미널은 움직이지 못한다, #1353)', () => {
  it('서버 방식: 만든 사람만 통과한다. 관리자·다른 사용자는 403', async () => {
    serverMode();
    expect(await status(authorizeSessionOwner('s1', 'kim'))).toBe(200);
    expect(await status(authorizeSessionOwner('s1', 'admin'))).toBe(403);
    expect(await status(authorizeSessionOwner('s1', 'lee'))).toBe(403);
  });

  it('서버 방식: 만든 사람이 기록되지 않은 세션은 관리자도 움직이지 못한다', async () => {
    serverMode();
    mocks.snapshot = {};
    expect(await status(authorizeSessionOwner('s1', 'admin'))).toBe(403);
    expect(await status(authorizeSessionOwner('s1', 'kim'))).toBe(403);
  });

  it('서버 방식: 이름은 정확히 같아야 한다(대소문자·공백이 다르면 다른 사람이다)', async () => {
    serverMode();
    expect(await status(authorizeSessionOwner('s1', 'Kim'))).toBe(403);
    expect(await status(authorizeSessionOwner('s1', 'kim '))).toBe(403);
  });

  it('서버 방식: 없는 세션은 404(조용히 통과하지 않는다)', async () => {
    serverMode();
    mocks.snapshot = undefined;
    expect(await status(authorizeSessionOwner('s1', 'admin'))).toBe(404);
    expect(await status(authorizeSessionOwner('s1', 'kim'))).toBe(404);
  });

  it('서버 방식: 세션 복구를 먼저 부른다', async () => {
    serverMode();
    await authorizeSessionOwner('s1', 'kim');
    expect(mocks.recoverSessions).toHaveBeenCalled();
  });

  it('개인 PC 모드(인증 없음)는 그대로 통과한다', async () => {
    expect(await status(authorizeSessionOwner('s1', 'local'))).toBe(200);
    mocks.snapshot = {};
    expect(await status(authorizeSessionOwner('s1', 'local'))).toBe(200);
  });
});

describe('authorizeSession: 보기·닫기용 넓은 검사는 그대로(관리자 허용)', () => {
  it('서버 방식: 만든 사람과 관리자는 통과, 다른 사용자는 403', async () => {
    serverMode();
    expect(await status(authorizeSession('s1', 'kim'))).toBe(200);
    expect(await status(authorizeSession('s1', 'admin'))).toBe(200);
    expect(await status(authorizeSession('s1', 'lee'))).toBe(403);
  });
});
