import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  localFolderAllowed: vi.fn((): boolean => true),
  listProjects: vi.fn(async () => [] as Array<{ id: string; folder?: string }>),
  proposeFolder: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ detection: {}, files: [] })),
  registerFolder: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ id: 'lib', created: true, written: [], excluded: false })),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/server/sessions', () => ({ localFolderAllowed: mocks.localFolderAllowed }));
vi.mock('@/lib/server/projects', () => ({ listProjects: mocks.listProjects }));
vi.mock('@/lib/server/project-registry', () => ({ proposeFolder: mocks.proposeFolder, registerFolder: mocks.registerFolder }));

import { POST } from './route';

function post(body: unknown): Request {
  return new Request('http://localhost/api/projects/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

beforeEach(() => {
  mocks.proposeFolder.mockClear();
  mocks.registerFolder.mockClear();
});

describe('POST /api/projects/open: 코드·테스트만 등록(#946)', () => {
  it('workspace.test를 제안과 등록에 그대로 넘긴다', async () => {
    expect((await POST(post({ path: '/home/kim/lib', workspace: { test: ['go', 'test', './...'] } }))).status).toBe(200);
    expect(mocks.proposeFolder).toHaveBeenCalledWith('/home/kim/lib', undefined, { workspace: { test: ['go', 'test', './...'] } });

    expect((await POST(post({ path: '/home/kim/lib', apply: true, workspace: { test: ['sh', '-c', 'make test'] } }))).status).toBe(201);
    expect(mocks.registerFolder).toHaveBeenCalledWith('/home/kim/lib', expect.any(Set), undefined, expect.objectContaining({ workspace: { test: ['sh', '-c', 'make test'] } }));
  });

  it('workspace가 없으면 지금처럼 넘기지 않는다', async () => {
    await POST(post({ path: '/home/kim/lib' }));
    expect(mocks.proposeFolder).toHaveBeenCalledWith('/home/kim/lib', undefined, {});
  });

  it('꼴이 틀린 workspace는 400으로 돌려보내고 아무것도 하지 않는다', async () => {
    for (const workspace of [{ test: 'make test' }, { test: [1] }, { test: ['a\u0000b'] }, { test: Array.from({ length: 100 }, () => 'x') }, { test: ['x'.repeat(5000)] }]) {
      const response = await POST(post({ path: '/home/kim/lib', apply: true, workspace }));
      expect(response.status).toBe(400);
    }
    expect(mocks.registerFolder).not.toHaveBeenCalled();
  });
});
