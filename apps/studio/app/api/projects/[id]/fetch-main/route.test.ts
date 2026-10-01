import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  localFolderAllowed: vi.fn((): boolean => true),
  findRegisteredProject: vi.fn(async (): Promise<{ id: string; path: string; addedAt: string } | undefined> => ({ id: 'orders', path: '/home/kim/orders', addedAt: '2026-01-01T00:00:00.000Z' })),
  fetchOriginMain: vi.fn(async () => ({ branch: 'main', status: 'up-to-date' as const, commits: [] })),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/server/sessions', () => ({ localFolderAllowed: mocks.localFolderAllowed }));
vi.mock('@/lib/server/project-registry', () => ({ findRegisteredProject: mocks.findRegisteredProject }));
vi.mock('@/lib/server/project-source-sync', () => ({ fetchOriginMain: mocks.fetchOriginMain }));

import { POST } from './route';

const context = { params: Promise.resolve({ id: 'orders' }) } as Parameters<typeof POST>[1];

beforeEach(() => {
  mocks.requireUser.mockReset().mockReturnValue('kim');
  mocks.localFolderAllowed.mockReset().mockReturnValue(true);
  mocks.findRegisteredProject.mockReset().mockResolvedValue({ id: 'orders', path: '/home/kim/orders', addedAt: '2026-01-01T00:00:00.000Z' });
  mocks.fetchOriginMain.mockReset().mockResolvedValue({ branch: 'main', status: 'up-to-date', commits: [] });
});

describe('POST /api/projects/[id]/fetch-main', () => {
  it('등록된 폴더 경로로 fetchOriginMain을 부른다', async () => {
    const response = await POST(new Request('http://studio.local/api/projects/orders/fetch-main', { method: 'POST' }), context);
    expect(response.status).toBe(200);
    expect(mocks.fetchOriginMain).toHaveBeenCalledWith('/home/kim/orders');
  });

  it('개인 PC 모드가 아니면 403이고 아무것도 받아오지 않는다(폴더 열기와 같은 가드)', async () => {
    mocks.localFolderAllowed.mockReturnValue(false);
    const response = await POST(new Request('http://studio.local/api/projects/orders/fetch-main', { method: 'POST' }), context);
    expect(response.status).toBe(403);
    expect(mocks.fetchOriginMain).not.toHaveBeenCalled();
  });

  it('등록한 폴더 프로젝트가 아니면 404다', async () => {
    mocks.findRegisteredProject.mockResolvedValue(undefined);
    const response = await POST(new Request('http://studio.local/api/projects/orders/fetch-main', { method: 'POST' }), context);
    expect(response.status).toBe(404);
    expect(mocks.fetchOriginMain).not.toHaveBeenCalled();
  });

  it('fetchOriginMain이 거부(갈라짐·더티 트리)하면 그 상태 코드를 그대로 돌려준다', async () => {
    mocks.fetchOriginMain.mockRejectedValue(new StudioError(409, '커밋하지 않은 변경이 있어 받아올 수 없습니다'));
    const response = await POST(new Request('http://studio.local/api/projects/orders/fetch-main', { method: 'POST' }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: '커밋하지 않은 변경이 있어 받아올 수 없습니다' });
  });
});
