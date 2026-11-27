import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_HEADER } from '@/lib/server/auth';
import { StudioError } from '@/lib/server/errors';

/**
 * 인증을 켠 서버 방식(#1473)의 권한 시험. 접근·권한 검사(access.ts, terminal-access.ts, terminal-allowed.ts, auth.ts)는 진짜를 쓰고,
 * 세션 표와 터미널·리뷰·취소 같은 동작만 가짜로 끼운다. 쓰기 동작마다 "만든 사람만" 되는지, 관리자·다른 사용자·로그인 없음·다른 프로젝트의
 * 세션은 모두 막히고 동작에 닿지 않는지 본다. 만료된 로그인은 앞단 시험(front 시험, app.test.ts)이 본다
 */
const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { owner?: string; projectId: string }>(),
  sessionTerminalTarget: vi.fn((id: string) => ({ sandboxId: `studio-${id}`, root: `/work/${id}`, projectId: 'orders' })),
  setTerminalCheckChanges: vi.fn((...args: unknown[]) => args[1] === true),
  runReviewRound: vi.fn(async (...args: unknown[]): Promise<void> => void args),
  cancelRun: vi.fn((...args: unknown[]): void => void args),
  openSessionTerminal: vi.fn(async () => ({ initialPromptUsed: false })),
  writeSessionTerminal: vi.fn(),
  resizeSessionTerminal: vi.fn(async () => {}),
  closeSessionTerminal: vi.fn(),
  subscribeSessionTerminal: vi.fn(() => () => {}),
}));

vi.mock('@/lib/server/sessions', () => ({
  getSnapshot: (id: string) => mocks.sessions.get(id),
  recoverSessions: async () => {},
  sessionTerminalTarget: mocks.sessionTerminalTarget,
  setTerminalCheckChanges: mocks.setTerminalCheckChanges,
  runReviewRound: mocks.runReviewRound,
  cancelRun: mocks.cancelRun,
}));
vi.mock('@/lib/server/session-terminal', () => ({
  MAX_TERMINAL_INPUT: 256 * 1024,
  openSessionTerminal: mocks.openSessionTerminal,
  writeSessionTerminal: mocks.writeSessionTerminal,
  resizeSessionTerminal: mocks.resizeSessionTerminal,
  closeSessionTerminal: mocks.closeSessionTerminal,
  subscribeSessionTerminal: mocks.subscribeSessionTerminal,
}));

import { POST as cancel } from '../runs/[runId]/cancel/route';
import { POST as checkChanges } from '../check-changes/route';
import { POST as review } from '../review/route';
import { GET as terminalGet, POST as terminalPost } from './route';

const HOST = 'studio.example.com';
const SECRET = 's'.repeat(40);

/** 인증을 켠 서버 방식에서 운영자가 터미널을 켠 환경. root는 관리자다 */
function serverEnv(overrides: Record<string, string> = {}): void {
  const env: Record<string, string> = {
    B_STUDIO_AUTH: 'token',
    B_STUDIO_AUTH_SECRET: SECRET,
    B_STUDIO_AUTH_TOKENS: `kim:${'k'.repeat(32)},lee:${'l'.repeat(32)},root:${'r'.repeat(32)}`,
    B_STUDIO_AUTH_ADMINS: 'root',
    B_STUDIO_SERVER_TERMINAL: '1',
    B_STUDIO_TERMINAL: 'container',
    B_STUDIO_EXPERIMENTAL: '1',
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

const headersFor = (user: string | undefined, host = HOST): Record<string, string> => ({ host, ...(user ? { [USER_HEADER]: user } : {}) });
const context = (id: string) => ({ params: Promise.resolve({ id }) });

/** 쓰기 동작 하나: 이름, 요청 보내기, 그 동작이 닿는 가짜 */
interface WriteAction {
  name: string;
  /** 만든 사람이 했을 때의 상태 코드 */
  ok: number;
  send: (id: string, user: string | undefined) => Promise<Response>;
  reached: () => boolean;
}

const terminalWrite = (body: unknown) => (id: string, user: string | undefined): Promise<Response> =>
  terminalPost(new Request(`http://localhost/api/sessions/${id}/terminal`, { method: 'POST', headers: headersFor(user), body: JSON.stringify(body) }), context(id));

const writes: WriteAction[] = [
  { name: '터미널 열기(첫 요청 자리)', ok: 200, send: terminalWrite({ action: 'open', cols: 120, rows: 40 }), reached: () => mocks.openSessionTerminal.mock.calls.length > 0 },
  { name: '터미널 입력(키 입력 보내기)', ok: 200, send: terminalWrite({ action: 'input', data: 'ls\r' }), reached: () => mocks.writeSessionTerminal.mock.calls.length > 0 },
  { name: '터미널 크기 바꾸기', ok: 200, send: terminalWrite({ action: 'resize', cols: 80, rows: 24 }), reached: () => mocks.resizeSessionTerminal.mock.calls.length > 0 },
  {
    name: '확인 선언 변경 허용 켜기',
    ok: 200,
    send: (id, user) => checkChanges(new Request(`http://localhost/api/sessions/${id}/check-changes`, { method: 'POST', headers: headersFor(user), body: JSON.stringify({ allow: true }) }), context(id)),
    reached: () => mocks.setTerminalCheckChanges.mock.calls.length > 0,
  },
  {
    name: 'AI 리뷰 돌리기(고침 요청이 터미널로 들어간다)',
    ok: 200,
    send: (id, user) => review(new Request(`http://localhost/api/sessions/${id}/review`, { method: 'POST', headers: headersFor(user), body: '{}' }), context(id)),
    reached: () => mocks.runReviewRound.mock.calls.length > 0,
  },
  {
    name: '실행 중단(CLI에 Esc를 보낸다)',
    ok: 202,
    send: (id, user) => cancel(new Request(`http://localhost/api/sessions/${id}/runs/r1/cancel`, { method: 'POST', headers: headersFor(user) }), { params: Promise.resolve({ id, runId: 'r1' }) }),
    reached: () => mocks.cancelRun.mock.calls.length > 0,
  },
];

/** 실제 동작처럼 없는 세션은 404다(접근·권한 검사가 먼저 통과시켜도 동작이 알린다) */
function missingIsNotFound(id: string): void {
  if (!mocks.sessions.has(id)) throw new StudioError(404, '세션을 찾을 수 없습니다');
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) if (typeof mock === 'function') mock.mockClear();
  mocks.sessionTerminalTarget.mockImplementation((id: string) => {
    missingIsNotFound(id);
    return { sandboxId: `studio-${id}`, root: `/work/${id}`, projectId: 'orders' };
  });
  mocks.setTerminalCheckChanges.mockImplementation((...args: unknown[]) => {
    const [id, allow] = args as [string, boolean];
    missingIsNotFound(id);
    return allow;
  });
  mocks.runReviewRound.mockImplementation(async (...args: unknown[]) => missingIsNotFound(args[0] as string));
  mocks.cancelRun.mockImplementation((...args: unknown[]) => missingIsNotFound(args[0] as string));
  mocks.sessions.clear();
  // s1: kim의 orders 세션, s2: lee의 billing 세션(다른 프로젝트·다른 사용자), s3: 만든 사람이 기록되지 않은 세션
  mocks.sessions.set('s1', { owner: 'kim', projectId: 'orders' });
  mocks.sessions.set('s2', { owner: 'lee', projectId: 'billing' });
  mocks.sessions.set('s3', { projectId: 'orders' });
  serverEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(writes)('서버 방식의 쓰기 동작: $name', (action) => {
  it('만든 사람은 다른 주소(원격)에서도 할 수 있다', async () => {
    expect((await action.send('s1', 'kim')).status).toBe(action.ok);
    expect(action.reached()).toBe(true);
  });

  it('관리자는 하지 못한다(403) — 보기와 닫기만 한다', async () => {
    expect((await action.send('s1', 'root')).status).toBe(403);
    expect(action.reached()).toBe(false);
  });

  it('다른 사용자는 하지 못한다(403)', async () => {
    expect((await action.send('s1', 'lee')).status).toBe(403);
    expect(action.reached()).toBe(false);
  });

  it('로그인 헤더가 없으면(토큰 없음) 401이고 아무것도 닿지 않는다', async () => {
    expect((await action.send('s1', undefined)).status).toBe(401);
    expect(action.reached()).toBe(false);
    expect(mocks.sessionTerminalTarget).not.toHaveBeenCalled();
  });

  it('다른 프로젝트의 다른 사용자 세션은 하지 못한다(403). 관리자도 못 한다', async () => {
    expect((await action.send('s2', 'kim')).status).toBe(403);
    expect((await action.send('s2', 'root')).status).toBe(403);
    expect(action.reached()).toBe(false);
  });

  it('만든 사람이 기록되지 않은 세션은 관리자도 못 한다', async () => {
    expect((await action.send('s3', 'root')).status).toBe(403);
    expect((await action.send('s3', 'kim')).status).toBe(403);
    expect(action.reached()).toBe(false);
  });

  it('없는 세션은 404고, 이름만 비슷한 사용자(대소문자)는 만든 사람으로 세지 않는다', async () => {
    expect((await action.send('nope', 'kim')).status).toBe(404);
    expect((await action.send('s1', 'KIM')).status).toBe(403);
    expect((await action.send('s1', 'Kim')).status).toBe(403);
    expect(action.reached()).toBe(false);
  });
});

describe('서버 방식에서 관리자의 보기와 닫기', () => {
  it('관리자는 남의 터미널을 닫을 수 있고 출력을 볼 수 있다', async () => {
    expect((await terminalPost(new Request('http://localhost/x', { method: 'POST', headers: headersFor('root'), body: JSON.stringify({ action: 'close' }) }), context('s1'))).status).toBe(200);
    expect(mocks.closeSessionTerminal).toHaveBeenCalledWith('s1');
    const stream = await terminalGet(new Request('http://localhost/x', { headers: headersFor('root') }), context('s1'));
    expect(stream.status).toBe(200);
    expect(mocks.subscribeSessionTerminal).toHaveBeenCalled();
    await stream.body?.cancel();
  });

  it('다른 사용자는 남의 터미널을 닫지도 보지도 못한다(관리자만 예외)', async () => {
    expect((await terminalPost(new Request('http://localhost/x', { method: 'POST', headers: headersFor('lee'), body: JSON.stringify({ action: 'close' }) }), context('s1'))).status).toBe(403);
    expect(mocks.closeSessionTerminal).not.toHaveBeenCalled();
    expect((await terminalGet(new Request('http://localhost/x', { headers: headersFor('lee') }), context('s1'))).status).toBe(403);
    expect((await terminalGet(new Request('http://localhost/x', { headers: headersFor(undefined) }), context('s1'))).status).toBe(401);
    expect(mocks.subscribeSessionTerminal).not.toHaveBeenCalled();
  });

  it('모르는 action은 관리자에게도 보기로 취급하지 않고 400이다', async () => {
    const response = await terminalPost(new Request('http://localhost/x', { method: 'POST', headers: headersFor('root'), body: JSON.stringify({ action: 'attach' }) }), context('s1'));
    expect(response.status).toBe(400);
  });
});

describe('운영자 스위치가 꺼진 서버 방식', () => {
  it('원격에서는 까닭을 적어 403이고 소유자도 열지 못한다(채팅식으로 돌아가지 않는다)', async () => {
    vi.stubEnv('B_STUDIO_SERVER_TERMINAL', '');
    for (const action of writes.slice(0, 3)) {
      const remote = await action.send('s1', 'kim');
      expect(remote.status, action.name).toBe(403);
      expect(((await remote.json()) as { error: string }).error).toContain('B_STUDIO_SERVER_TERMINAL=1');
    }
    expect(mocks.openSessionTerminal).not.toHaveBeenCalled();
    expect(mocks.writeSessionTerminal).not.toHaveBeenCalled();
    expect(mocks.resizeSessionTerminal).not.toHaveBeenCalled();
  });

  it('스위치를 켜도 이 컴퓨터 방식(host)이면 닫힌다', async () => {
    vi.stubEnv('B_STUDIO_TERMINAL', 'host');
    expect((await writes[0]!.send('s1', 'kim')).status).toBe(403);
    vi.stubEnv('B_STUDIO_TERMINAL', '');
    expect((await writes[1]!.send('s1', 'kim')).status).toBe(403);
    expect(mocks.openSessionTerminal).not.toHaveBeenCalled();
    expect(mocks.writeSessionTerminal).not.toHaveBeenCalled();
  });
});

describe('서버 방식이 아닌 곳은 그대로', () => {
  it('인증을 끈 개인 PC에서 AI 리뷰·실행 중단은 사용자 구분 없이 지나간다(만든 사람 검사는 서버 방식에만 있다)', async () => {
    for (const key of ['B_STUDIO_AUTH', 'B_STUDIO_SERVER_TERMINAL', 'B_STUDIO_TERMINAL', 'B_STUDIO_EXPERIMENTAL']) vi.stubEnv(key, '');
    const response = await review(new Request('http://localhost/api/sessions/s1/review', { method: 'POST', headers: { host: '127.0.0.1:3000' }, body: '{}' }), context('s1'));
    expect(response.status).toBe(200);
    expect(mocks.runReviewRound).toHaveBeenCalled();
  });

  it('서버 방식이어도 터미널을 켜지 않은 서버(채팅식만)에서는 관리자가 리뷰를 돌릴 수 있다(옛 동작)', async () => {
    vi.stubEnv('B_STUDIO_SERVER_TERMINAL', '');
    expect((await writes[4]!.send('s1', 'root')).status).toBe(200);
    expect(mocks.runReviewRound).toHaveBeenCalled();
  });
});
