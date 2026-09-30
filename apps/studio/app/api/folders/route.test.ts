import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  localFolderAllowed: vi.fn((): boolean => true),
  listFolder: vi.fn(async (input: { path?: string; showHidden?: boolean }) => ({
    path: input.path ?? '/home/kim',
    breadcrumbs: [{ name: '/', path: '/' }],
    children: [],
    truncated: false,
    totalCount: 0,
    shortcuts: [],
  })),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/server/sessions', () => ({ localFolderAllowed: mocks.localFolderAllowed }));
vi.mock('@/lib/server/folder-browser', () => ({ listFolder: mocks.listFolder }));

import { GET } from './route';

beforeEach(() => {
  mocks.requireUser.mockImplementation(() => 'kim');
  mocks.localFolderAllowed.mockImplementation(() => true);
  mocks.listFolder.mockClear();
});

describe('GET /api/folders', () => {
  it('path·showHidden 쿼리를 그대로 listFolder에 넘긴다', async () => {
    const response = await GET(new Request('http://localhost/api/folders?path=%2FUsers%2Fkim%2Fcode&showHidden=1'));

    expect(response.status).toBe(200);
    expect(mocks.listFolder).toHaveBeenCalledWith({ path: '/Users/kim/code', showHidden: true });
  });

  it('path가 없으면 undefined로 넘겨 홈 폴더를 보여준다', async () => {
    await GET(new Request('http://localhost/api/folders'));

    expect(mocks.listFolder).toHaveBeenCalledWith({ path: undefined, showHidden: false });
  });

  it('로그인하지 않았으면 401을 돌려주고 목록을 만들지 않는다', async () => {
    mocks.requireUser.mockImplementationOnce(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });

    const response = await GET(new Request('http://localhost/api/folders'));

    expect(response.status).toBe(401);
    expect(mocks.listFolder).not.toHaveBeenCalled();
  });

  it('개인 PC 모드가 아니면 403을 돌려주고 목록을 만들지 않는다', async () => {
    mocks.localFolderAllowed.mockReturnValue(false);

    const response = await GET(new Request('http://localhost/api/folders'));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: '이 서버에서는 폴더를 둘러볼 수 없습니다. 개인 PC 모드(로컬 CLI)에서만 씁니다' });
    expect(mocks.listFolder).not.toHaveBeenCalled();
  });

  it('listFolder가 던진 StudioError를 그 상태 코드로 돌려준다', async () => {
    mocks.listFolder.mockRejectedValueOnce(new StudioError(400, '폴더가 아닙니다: /etc/hosts'));

    const response = await GET(new Request('http://localhost/api/folders?path=%2Fetc%2Fhosts'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '폴더가 아닙니다: /etc/hosts' });
  });
});
