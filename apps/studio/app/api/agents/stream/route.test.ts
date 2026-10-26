import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  listAgentOverview: vi.fn(async () => ({ items: [{ id: 'a', state: 'idle' }], totals: { total: 1 } })),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/server/agents-overview', () => ({ listAgentOverview: mocks.listAgentOverview }));

import { GET, MAX_AGENT_STREAMS } from './route';

async function firstEvent(response: Response): Promise<unknown> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
}

beforeEach(() => {
  mocks.requireUser.mockImplementation(() => 'kim');
});

describe('GET /api/agents/stream(#923)', () => {
  it('SSE로 처음에 전체 목록을 보낸다', async () => {
    const abort = new AbortController();
    const response = await GET(new Request('http://localhost/api/agents/stream', { signal: abort.signal }));
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await firstEvent(response)).toEqual({ type: 'full', items: [{ id: 'a', state: 'idle' }], totals: { total: 1 } });
    abort.abort();
  });

  it('사용자를 확인하지 못하면 그 오류로 답한다', async () => {
    mocks.requireUser.mockImplementation(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });
    const response = await GET(new Request('http://localhost/api/agents/stream'));
    expect(response.status).toBe(401);
  });

  it('열린 통로가 너무 많으면 429로 막고, 끊긴 자리는 다시 쓸 수 있다', async () => {
    const aborts: AbortController[] = [];
    for (let index = 0; index < MAX_AGENT_STREAMS; index += 1) {
      const abort = new AbortController();
      aborts.push(abort);
      const response = await GET(new Request('http://localhost/api/agents/stream', { signal: abort.signal }));
      expect(response.status).toBe(200);
    }
    const over = await GET(new Request('http://localhost/api/agents/stream'));
    expect(over.status).toBe(429);
    aborts[0]!.abort();
    const again = new AbortController();
    const reused = await GET(new Request('http://localhost/api/agents/stream', { signal: again.signal }));
    expect(reused.status).toBe(200);
    again.abort();
    for (const abort of aborts) abort.abort();
  });
});
