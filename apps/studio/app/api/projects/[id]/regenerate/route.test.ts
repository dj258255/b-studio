import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  localFolderAllowed: vi.fn((): boolean => true),
  proposeRegeneration: vi.fn(async () => ({ detection: {}, files: [], eligible: true })),
  applyRegeneration: vi.fn(async () => ({ written: [] as string[] })),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/server/sessions', () => ({ localFolderAllowed: mocks.localFolderAllowed }));
vi.mock('@/lib/server/project-registry', () => ({ proposeRegeneration: mocks.proposeRegeneration, applyRegeneration: mocks.applyRegeneration }));

import { GET, POST } from './route';

const context = { params: Promise.resolve({ id: 'orders' }) } as Parameters<typeof GET>[1];

beforeEach(() => {
  mocks.requireUser.mockReset().mockReturnValue('kim');
  mocks.localFolderAllowed.mockReset().mockReturnValue(true);
  mocks.proposeRegeneration.mockReset().mockResolvedValue({ detection: {}, files: [], eligible: true });
  mocks.applyRegeneration.mockReset().mockResolvedValue({ written: [] });
});

describe('GET /api/projects/[id]/regenerate', () => {
  it('proposeRegeneration을 그대로 돌려준다', async () => {
    const response = await GET(new Request('http://studio.local/api/projects/orders/regenerate'), context);
    expect(response.status).toBe(200);
    expect(mocks.proposeRegeneration).toHaveBeenCalledWith('orders');
  });

  it('개인 PC 모드가 아니면 403이고 아무것도 보지 않는다(폴더 열기와 같은 가드)', async () => {
    mocks.localFolderAllowed.mockReturnValue(false);
    const response = await GET(new Request('http://studio.local/api/projects/orders/regenerate'), context);
    expect(response.status).toBe(403);
    expect(mocks.proposeRegeneration).not.toHaveBeenCalled();
  });

  it('로그인하지 않으면 401이다', async () => {
    mocks.requireUser.mockImplementation(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });
    const response = await GET(new Request('http://studio.local/api/projects/orders/regenerate'), context);
    expect(response.status).toBe(401);
  });

  it('등록하지 않은 프로젝트면 404를 그대로 돌려준다', async () => {
    mocks.proposeRegeneration.mockRejectedValue(new StudioError(404, '등록한 폴더 프로젝트를 찾지 못했습니다'));
    const response = await GET(new Request('http://studio.local/api/projects/orders/regenerate'), context);
    expect(response.status).toBe(404);
  });
});

describe('POST /api/projects/[id]/regenerate', () => {
  it('body의 overwrite 배열을 그대로 applyRegeneration에 넘긴다', async () => {
    const request = new Request('http://studio.local/api/projects/orders/regenerate', {
      method: 'POST',
      body: JSON.stringify({ overwrite: ['studio.yaml', 123, 'compose.b-studio.yaml'] }),
    });
    const response = await POST(request, context);
    expect(response.status).toBe(200);
    expect(mocks.applyRegeneration).toHaveBeenCalledWith('orders', ['studio.yaml', 'compose.b-studio.yaml']);
  });

  it('개인 PC 모드가 아니면 403이고 쓰지 않는다', async () => {
    mocks.localFolderAllowed.mockReturnValue(false);
    const response = await POST(new Request('http://studio.local/api/projects/orders/regenerate', { method: 'POST', body: '{}' }), context);
    expect(response.status).toBe(403);
    expect(mocks.applyRegeneration).not.toHaveBeenCalled();
  });

  it('body가 없으면 overwrite를 빈 배열로 본다', async () => {
    const response = await POST(new Request('http://studio.local/api/projects/orders/regenerate', { method: 'POST' }), context);
    expect(response.status).toBe(200);
    expect(mocks.applyRegeneration).toHaveBeenCalledWith('orders', []);
  });
});
