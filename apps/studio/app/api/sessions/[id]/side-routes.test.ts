import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_HEADER } from '@/lib/server/auth';

/**
 * 서버 방식(#1473, #1338)에서 터미널 옆으로 일을 시키거나 실행 방식을 바꾸는 세션 라우트, 게이트를 푸는 허용의 권한 시험.
 * 접근·권한 검사는 진짜를 쓰고 동작만 가짜다. 서버 방식 터미널이 열린 서버에서는 만든 사람만 되고(관리자·다른 사용자·로그인 없음은 막힌다),
 * 게이트를 푸는 허용(allowBreaking·allowCheckChanges, 지적 닫기)은 터미널이 닫힌 서버방식에서도 만든 사람만 된다.
 */
const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { owner?: string }>(),
  sendMessage: vi.fn((...args: unknown[]) => ({ runId: 'r1', args })),
  steerRun: vi.fn((...args: unknown[]) => ({ runId: 'r1', args })),
  setSessionModel: vi.fn(async () => ({})),
  restoreCheckpoint: vi.fn(),
  reverifySession: vi.fn(async () => ({})),
  restoreDiscardedBackup: vi.fn(),
  resumeSession: vi.fn(async () => ({})),
  setSessionServiceSelection: vi.fn(async () => ({})),
  resolveReviewFinding: vi.fn(async () => ({ review: {} })),
  stopExploreQa: vi.fn(),
}));

vi.mock('@/lib/server/sessions', () => ({
  getSnapshot: (id: string) => mocks.sessions.get(id),
  recoverSessions: async () => {},
  sendMessage: mocks.sendMessage,
  steerRun: mocks.steerRun,
  setSessionModel: mocks.setSessionModel,
  sessionModelPicker: async () => ({}),
  restoreCheckpoint: mocks.restoreCheckpoint,
  reverifySession: mocks.reverifySession,
  restoreDiscardedBackup: mocks.restoreDiscardedBackup,
  resumeSession: mocks.resumeSession,
  setSessionServiceSelection: mocks.setSessionServiceSelection,
  resolveReviewFinding: mocks.resolveReviewFinding,
}));
vi.mock('@/lib/server/design-pipeline', () => ({ assertDesignApprovedForRequest: async () => {} }));
vi.mock('@/lib/server/explore-qa-runs', () => ({
  ExploreQaError: class extends Error {},
  loadExploreQaRun: async () => undefined,
  saveExploreQaRun: async () => ({}),
  startExploreQa: () => ({}),
  stopExploreQa: mocks.stopExploreQa,
}));

import { POST as restoreCheckpoint } from './checkpoints/[sha]/restore/route';
import { POST as reverify } from './checkpoints/[sha]/reverify/route';
import { POST as restoreDiscarded } from './discarded/[backupId]/restore/route';
import { POST as exploreQa } from './explore-qa/route';
import { POST as messages } from './messages/route';
import { POST as model } from './model/route';
import { POST as resume } from './resume/route';
import { POST as resolveFinding } from './review/resolve/route';
import { POST as selection } from './services/[service]/selection/route';
import { POST as steer } from './steer/route';

const HOST = 'studio.example.com';

function env(overrides: Record<string, string> = {}): void {
  const values: Record<string, string> = {
    B_STUDIO_AUTH: 'token',
    B_STUDIO_AUTH_SECRET: 's'.repeat(40),
    B_STUDIO_AUTH_TOKENS: `kim:${'k'.repeat(32)},lee:${'l'.repeat(32)},root:${'r'.repeat(32)}`,
    B_STUDIO_AUTH_ADMINS: 'root',
    B_STUDIO_SERVER_TERMINAL: '1',
    B_STUDIO_TERMINAL: 'container',
    B_STUDIO_EXPERIMENTAL: '1',
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

const headers = (user: string | undefined): Record<string, string> => ({ host: HOST, ...(user ? { [USER_HEADER]: user } : {}) });
const call = (handler: (request: Request, context: never) => Promise<Response>, body: unknown, params: Record<string, string>) => (id: string, user: string | undefined): Promise<Response> =>
  handler(new Request('http://localhost/x', { method: 'POST', headers: headers(user), body: JSON.stringify(body) }), { params: Promise.resolve({ id, ...params }) } as never);

interface Action {
  name: string;
  ok: number;
  send: (id: string, user: string | undefined) => Promise<Response>;
  reached: () => boolean;
}

const actions: Action[] = [
  { name: '메시지 보내기(채팅식 요청)', ok: 202, send: call(messages, { text: '고쳐 줘' }, {}), reached: () => mocks.sendMessage.mock.calls.length > 0 },
  { name: '진행 중 지시(steer)', ok: 202, send: call(steer, { text: '이쪽으로' }, {}), reached: () => mocks.steerRun.mock.calls.length > 0 },
  { name: '모델 바꾸기', ok: 200, send: call(model, { modelId: 'sonnet' }, {}), reached: () => mocks.setSessionModel.mock.calls.length > 0 },
  { name: '체크포인트로 되돌리기', ok: 202, send: call(restoreCheckpoint, {}, { sha: 'abc1234' }), reached: () => mocks.restoreCheckpoint.mock.calls.length > 0 },
  { name: '체크포인트 다시 검증', ok: 202, send: call(reverify, {}, { sha: 'abc1234' }), reached: () => mocks.reverifySession.mock.calls.length > 0 },
  { name: '버린 변경 되살리기', ok: 202, send: call(restoreDiscarded, {}, { backupId: 'b1' }), reached: () => mocks.restoreDiscardedBackup.mock.calls.length > 0 },
  { name: '세션 이어서 작업', ok: 202, send: call(resume, {}, {}), reached: () => mocks.resumeSession.mock.calls.length > 0 },
  { name: '서비스 선택 바꾸기', ok: 200, send: call(selection, { on: false }, { service: 'api' }), reached: () => mocks.setSessionServiceSelection.mock.calls.length > 0 },
  { name: '탐색형 QA 중지/시작', ok: 200, send: call(exploreQa, { action: 'stop' }, {}), reached: () => mocks.stopExploreQa.mock.calls.length > 0 },
];

beforeEach(() => {
  for (const mock of Object.values(mocks)) if (typeof mock === 'function') mock.mockClear();
  mocks.sessions.clear();
  mocks.sessions.set('s1', { owner: 'kim' });
  mocks.sessions.set('s2', { owner: 'lee' });
  mocks.sessions.set('s3', {});
  env();
});
afterEach(() => vi.unstubAllEnvs());

describe.each(actions)('서버 방식 터미널이 열린 서버의 옆 라우트: $name', (action) => {
  it('만든 사람은 한다', async () => {
    expect((await action.send('s1', 'kim')).status).toBe(action.ok);
    expect(action.reached()).toBe(true);
  });
  it('관리자·다른 사용자는 못 한다(403)', async () => {
    expect((await action.send('s1', 'root')).status).toBe(403);
    expect((await action.send('s1', 'lee')).status).toBe(403);
    expect(action.reached()).toBe(false);
  });
  it('로그인이 없으면 401, 다른 프로젝트·다른 사용자의 세션과 만든 사람이 없는 세션은 403이다', async () => {
    expect((await action.send('s1', undefined)).status).toBe(401);
    expect((await action.send('s2', 'kim')).status).toBe(403);
    expect((await action.send('s2', 'root')).status).toBe(403);
    expect((await action.send('s3', 'root')).status).toBe(403);
    expect(action.reached()).toBe(false);
  });
  it('서버 방식 터미널을 켜지 않은 서버에서는 관리자 권한이 옛 그대로다(관리자 허용)', async () => {
    vi.stubEnv('B_STUDIO_SERVER_TERMINAL', '');
    expect((await action.send('s1', 'root')).status).toBe(action.ok);
    expect((await action.send('s1', 'lee')).status).toBe(403);
  });
});

describe('게이트를 푸는 허용은 만든 사람만(#1338)', () => {
  const closed = (): void => {
    vi.stubEnv('B_STUDIO_SERVER_TERMINAL', '');
  };

  it('메시지의 allowBreaking·allowCheckChanges는 터미널이 닫힌 서버방식에서도 관리자를 막는다. 허용 없는 메시지는 관리자도 보낸다(옛 동작)', async () => {
    closed();
    expect((await call(messages, { text: 'x', allowBreaking: true }, {})('s1', 'root')).status).toBe(403);
    expect((await call(messages, { text: 'x', allowCheckChanges: true }, {})('s1', 'root')).status).toBe(403);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect((await call(messages, { text: 'x', allowBreaking: true }, {})('s1', 'kim')).status).toBe(202);
    expect(mocks.sendMessage.mock.calls.at(-1)?.[2]).toMatchObject({ allowBreaking: true });
    expect((await call(messages, { text: 'x' }, {})('s1', 'root')).status).toBe(202);
  });

  it('allow가 거짓이면 owner 검사를 하지 않는다(허용을 켤 때만 검사)', async () => {
    closed();
    expect((await call(messages, { text: 'x', allowBreaking: false, allowCheckChanges: false }, {})('s1', 'root')).status).toBe(202);
  });

  it('리뷰 지적 닫기는 터미널이 닫힌 서버방식에서도 만든 사람만 한다', async () => {
    closed();
    const resolve = call(resolveFinding, { round: 1, findingIndex: 0, reason: '오탐' }, {});
    expect((await resolve('s1', 'root')).status).toBe(403);
    expect((await resolve('s1', 'lee')).status).toBe(403);
    expect((await resolve('s1', undefined)).status).toBe(401);
    expect(mocks.resolveReviewFinding).not.toHaveBeenCalled();
    expect((await resolve('s1', 'kim')).status).toBe(200);
  });

  it('인증을 끈 개인 PC에서는 사용자 구분 없이 지나간다', async () => {
    for (const key of ['B_STUDIO_AUTH', 'B_STUDIO_SERVER_TERMINAL', 'B_STUDIO_TERMINAL', 'B_STUDIO_EXPERIMENTAL']) vi.stubEnv(key, '');
    const response = await messages(new Request('http://localhost/x', { method: 'POST', headers: { host: '127.0.0.1:3000' }, body: JSON.stringify({ text: 'x', allowBreaking: true }) }), { params: Promise.resolve({ id: 's1' }) } as never);
    expect(response.status).toBe(202);
  });
});
