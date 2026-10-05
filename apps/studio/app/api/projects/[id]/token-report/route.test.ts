import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  projectTokenReport: vi.fn(async (): Promise<unknown> => {
    throw new Error('테스트가 준비되지 않았습니다');
  }),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: spies.requireUser }));
vi.mock('@/lib/server/project-token-report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/project-token-report')>();
  return { ...actual, projectTokenReport: spies.projectTokenReport };
});

import { StudioError } from '@/lib/server/errors';
import { buildProjectTokenReport } from '@/lib/server/project-token-report';
import { GET } from './route';

const report = buildProjectTokenReport({ projectId: 'orders', projectName: 'orders', generatedAt: '2026-09-03T00:00:00.000Z', sessions: [] });
const context = { params: Promise.resolve({ id: 'orders' }) } as Parameters<typeof GET>[1];

function request(query = ''): Request {
  return new Request(`http://studio.local/api/projects/orders/token-report${query}`);
}

beforeEach(() => {
  spies.requireUser.mockReset();
  spies.requireUser.mockReturnValue('kim');
  spies.projectTokenReport.mockReset();
  spies.projectTokenReport.mockResolvedValue(report);
});

describe('GET /api/projects/[id]/token-report', () => {
  it('기간을 그대로 넘겨 보고서 JSON을 돌려준다', async () => {
    const response = await GET(request('?from=2026-09-01&to=2026-09-02'), context);

    expect(response.status).toBe(200);
    expect(spies.projectTokenReport).toHaveBeenCalledWith('orders', { viewer: 'kim', from: '2026-09-01', to: '2026-09-02' });
    expect((await response.json()).report).toMatchObject({ projectId: 'orders', projectName: 'orders', sessions: 0 });
  });

  it('format=markdown이면 README에 붙일 마크다운 본문을 준다', async () => {
    const response = await GET(request('?format=markdown'), context);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('content-disposition')).toBe('inline; filename="b-studio-token-report-orders-2026-09-03.md"');
    const body = await response.text();
    expect(body).toContain('# b-studio 토큰 사용 보고서 — orders');
    expect(body).toContain('비용은 공식 단가로 환산한 추정치이며 구독 요금과 다릅니다');
  });

  it('download=1이면 파일로 내려준다', async () => {
    const response = await GET(request('?format=markdown&download=1'), context);

    expect(response.headers.get('content-disposition')).toContain('attachment;');
  });

  it('로그인하지 않으면 401이고 아무것도 읽지 않는다', async () => {
    spies.requireUser.mockImplementation(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });
    const response = await GET(request(), context);

    expect(response.status).toBe(401);
    expect(spies.projectTokenReport).not.toHaveBeenCalled();
  });

  it('모르는 format은 400이다', async () => {
    const response = await GET(request('?format=csv'), context);

    expect(response.status).toBe(400);
    expect(spies.projectTokenReport).not.toHaveBeenCalled();
  });
});
