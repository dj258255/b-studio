import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  authorizeSession: vi.fn<(id: string) => Promise<void>>(async () => {}),
  sessionTerminalTarget: vi.fn((): { sandboxId: string; root: string; projectId: string } => ({ sandboxId: 'studio-orders-abc123', root: '/work/orders', projectId: 'orders' })),
  subscribeSessionTerminal: vi.fn<(id: string, listener: (message: unknown) => void) => () => void>(() => () => {}),
  recoverSessions: vi.fn(async () => {}),
  // 로컬 토큰은 파일을 만지지 않게 가짜로 끼운다(진짜는 local-token.test.ts가 본다)
  localToken: 'f'.repeat(64),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ sessionTerminalTarget: mocks.sessionTerminalTarget, recoverSessions: mocks.recoverSessions }));
vi.mock('@/lib/server/session-terminal', () => ({ subscribeSessionTerminal: mocks.subscribeSessionTerminal }));
vi.mock('@/lib/server/local-token', () => ({
  LOCAL_TOKEN_COOKIE: 'b_studio_local',
  hasLocalToken: (cookie: string | undefined) => cookie === mocks.localToken,
}));

import { createTerminalStream, GET } from './route';

const COOKIE = `b_studio_local=${mocks.localToken}`;

const get = (ids: string, options: { host?: string; cookie?: string | null; signal?: AbortSignal } = {}): Promise<Response> => {
  const cookie = options.cookie === undefined ? COOKIE : options.cookie;
  const url = `http://localhost/api/terminals/stream?ids=${encodeURIComponent(ids)}`;
  return GET(new Request(url, { headers: { host: options.host ?? '127.0.0.1:3000', ...(cookie ? { cookie } : {}) }, ...(options.signal ? { signal: options.signal } : {}) }));
};

/** 흘러나온 SSE 본문을 다 모은다. 조각이 20ms 동안 안 오면 멈춘다(초기 메시지는 곧바로 온다) */
async function collect(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 20))]);
    if (!chunk || chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  return text;
}

/** SSE 본문에서 `data:` 줄들을 꺼내 JSON으로 푼다 */
function events(text: string): Array<{ id: string; message: { kind: string; state?: string; data?: string; message?: string } }> {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as { id: string; message: { kind: string; state?: string; data?: string; message?: string } });
}

beforeEach(() => {
  for (const mock of [mocks.authorizeSession, mocks.sessionTerminalTarget, mocks.subscribeSessionTerminal, mocks.recoverSessions]) mock.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
  mocks.sessionTerminalTarget.mockImplementation(() => ({ sandboxId: 'studio-orders-abc123', root: '/work/orders', projectId: 'orders' }));
  mocks.subscribeSessionTerminal.mockImplementation((id, listener) => {
    listener({ kind: 'data', data: `hello-${id}` });
    return () => {};
  });
});

describe('GET /api/terminals/stream (묶음 터미널 통로, B4)', () => {
  it('id별 메시지를 어느 세션 것인지와 함께 흘린다', async () => {
    const response = await get('a,b');
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await collect(response);
    const parsed = events(body);
    expect(parsed).toContainEqual({ id: 'a', message: { kind: 'data', data: 'hello-a' } });
    expect(parsed).toContainEqual({ id: 'b', message: { kind: 'data', data: 'hello-b' } });
    expect(mocks.subscribeSessionTerminal).toHaveBeenCalledTimes(2);
  });

  it('쿠키가 없으면 통로 전체를 403으로 막는다(개인 PC 모드)', async () => {
    const response = await get('a,b', { cookie: null });
    expect(response.status).toBe(403);
    expect(mocks.authorizeSession).not.toHaveBeenCalled();
    expect(mocks.subscribeSessionTerminal).not.toHaveBeenCalled();
    // 세션 복구 전에 막는다
    expect(mocks.recoverSessions).not.toHaveBeenCalled();
  });

  it('이 컴퓨터의 주소가 아닌 Host로 온 요청은 403이다(DNS 리바인딩)', async () => {
    for (const host of ['evil.example:3000', '192.168.0.10:3000', '']) {
      expect((await get('a', { host })).status, host).toBe(403);
    }
    expect(mocks.authorizeSession).not.toHaveBeenCalled();
    expect(mocks.recoverSessions).not.toHaveBeenCalled();
  });

  it('검사 전에 세션을 복구한다(단일 통로와 같은 순서)', async () => {
    await collect(await get('a'));
    expect(mocks.recoverSessions).toHaveBeenCalledTimes(1);
  });

  it('권한이 없는 id는 그 id만 닫힘으로 알리고 나머지는 계속 흐른다', async () => {
    mocks.authorizeSession.mockImplementation(async (id: string) => {
      if (id === 'b') throw new StudioError(403, '이 세션은 만든 사람만 쓸 수 있습니다');
    });
    const response = await get('a,b,c');
    const parsed = events(await collect(response));
    // b만 닫힘
    expect(parsed.find((entry) => entry.id === 'b' && entry.message.kind === 'status')).toMatchObject({ id: 'b', message: { kind: 'status', state: 'closed', message: '이 세션은 만든 사람만 쓸 수 있습니다' } });
    // a·c는 출력이 흐른다
    expect(parsed).toContainEqual({ id: 'a', message: { kind: 'data', data: 'hello-a' } });
    expect(parsed).toContainEqual({ id: 'c', message: { kind: 'data', data: 'hello-c' } });
    expect(mocks.subscribeSessionTerminal).toHaveBeenCalledTimes(2);
  });

  it('쓸 수 없는 서버(실험 기능이 꺼졌거나 멈춘 세션)의 id도 그 id만 닫힌다', async () => {
    mocks.sessionTerminalTarget.mockImplementation(() => {
      throw new StudioError(403, '세션 터미널은 실험 기능을 켠 개인 PC 모드에서만 씁니다(B_STUDIO_EXPERIMENTAL=1)');
    });
    const parsed = events(await collect(await get('a')));
    expect(parsed).toContainEqual({ id: 'a', message: { kind: 'status', state: 'closed', message: '세션 터미널은 실험 기능을 켠 개인 PC 모드에서만 씁니다(B_STUDIO_EXPERIMENTAL=1)' } });
    expect(mocks.subscribeSessionTerminal).not.toHaveBeenCalled();
  });

  it('5개를 넘겨도 상한(4개)까지만 붙는다', async () => {
    await collect(await get('a,b,c,d,e,f'));
    expect(mocks.subscribeSessionTerminal).toHaveBeenCalledTimes(4);
    expect(mocks.subscribeSessionTerminal.mock.calls.map((call) => call[0])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('연결이 끊기면 붙였던 구독을 모두 푼다', async () => {
    const unsubscribes = ['a', 'b', 'c'].map(() => vi.fn());
    let index = 0;
    mocks.subscribeSessionTerminal.mockImplementation((id, listener) => {
      listener({ kind: 'data', data: `hello-${id}` });
      return unsubscribes[index++]!;
    });
    const controller = new AbortController();
    const response = await get('a,b,c', { signal: controller.signal });
    await collect(response);
    controller.abort();
    for (const unsubscribe of unsubscribes) expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('검사를 기다리는 동안 연결이 끊기면 구독을 붙이지 않는다', async () => {
    let release!: () => void;
    mocks.authorizeSession.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    await get('a', { signal: controller.signal });
    // 검사(authorizeSession)가 끝나기 전에 끊는다
    controller.abort();
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mocks.subscribeSessionTerminal).not.toHaveBeenCalled();
  });
});

describe('묶음 통로의 쓰기와 정리(B4)', () => {
  const fakeController = (enqueue: (chunk: Uint8Array) => void, close: () => void): ReadableStreamDefaultController<Uint8Array> =>
    ({ enqueue, close }) as unknown as ReadableStreamDefaultController<Uint8Array>;

  it('쓰기가 실패하면 그 자리에서 정리한다(구독 해제·close가 한 번)', () => {
    const close = vi.fn();
    const stream = createTerminalStream(fakeController(() => { throw new Error('closed'); }, close));
    const unsubscribe = vi.fn();
    stream.track(unsubscribe);

    stream.message('a', { kind: 'data', data: 'x' });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(stream.closed()).toBe(true);
    // 정리는 한 번만 돈다
    stream.cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('쓰기가 성공하면 정리는 닫힘 경로에서 한 번 돈다', () => {
    const enqueue = vi.fn();
    const close = vi.fn();
    const stream = createTerminalStream(fakeController(enqueue, close));
    const unsubscribe = vi.fn();
    stream.track(unsubscribe);

    stream.message('a', { kind: 'data', data: 'x' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    stream.cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(stream.closed()).toBe(true);
  });
});
