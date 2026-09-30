import { beforeEach, describe, expect, it, vi } from 'vitest';

interface TestsSnapshot {
  services: Array<Record<string, unknown>>;
  requirementsWithoutTests: Array<Record<string, unknown>>;
}

const mocks = vi.hoisted(() => ({
  runSessionTests: vi.fn<(id: string, input: unknown) => Promise<TestsSnapshot>>(async () => ({ services: [], requirementsWithoutTests: [] })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ runSessionTests: mocks.runSessionTests }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(body: unknown, id = 's1'): Promise<Response> {
  return POST(new Request(`http://localhost/api/sessions/${id}/tests/run`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.runSessionTests.mockClear();
  mocks.runSessionTests.mockImplementation(async () => ({ services: [], requirementsWithoutTests: [] }));
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/tests/run', () => {
  it('service를 넘기면 그 서비스의 테스트를 돌리고 새 결과를 돌려준다', async () => {
    const response = await post({ service: 'api' });

    expect(response.status).toBe(200);
    expect(mocks.runSessionTests).toHaveBeenCalledWith('s1', { service: 'api' });
  });

  it('file·suitePath·testName까지 그대로 넘긴다', async () => {
    await post({ service: 'web', file: 'src/order.test.ts', suitePath: ['OrderService'], testName: 'creates an order' });

    expect(mocks.runSessionTests).toHaveBeenCalledWith('s1', { service: 'web', file: 'src/order.test.ts', suitePath: ['OrderService'], testName: 'creates an order' });
  });

  it('service가 없으면 400', async () => {
    const response = await post({});

    expect(response.status).toBe(400);
    expect(mocks.runSessionTests).not.toHaveBeenCalled();
  });

  it('실행기 쪽 오류(예: 이미 실행 중)를 상태 코드 그대로 돌려준다', async () => {
    mocks.runSessionTests.mockRejectedValueOnce(new StudioError(409, '이미 테스트를 실행하는 중입니다'));

    const response = await post({ service: 'api' });

    expect(response.status).toBe(409);
  });
});
