import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedProject } from '@b-studio/spec';

const spies = vi.hoisted(() => ({
  inspectSource: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined),
  cachedRepositoryToken: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(async () => undefined),
  localFolderAllowed: vi.fn(() => false),
}));

vi.mock('@b-studio/spec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/spec')>();
  return {
    ...actual,
    loadProject: async (dir: string) =>
      ({ root: dir, spec: { name: 'orders', repository: undefined }, managed: [] }) as unknown as LoadedProject,
  };
});
vi.mock('@b-studio/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/agent')>();
  return { ...actual, CheckpointStore: { inspectSource: spies.inspectSource } };
});
vi.mock('./project-registry', () => ({ readRegistry: async () => [] }));
vi.mock('./repo-token', () => ({ cachedRepositoryToken: spies.cachedRepositoryToken, localFolderAllowed: spies.localFolderAllowed }));

import { canPublishIssues } from './projects';

/**
 * 57번 버그: 원격 저장소 토큰이 환경 변수에 없어도 개인 PC 모드의 gh CLI 로그인으로 있으면
 * "이슈로 올리기" 버튼이 보여야 한다 — 세션의 PR 생성·이슈 발행과 같은 토큰 찾기를 쓰는지 확인한다
 */
describe('canPublishIssues', () => {
  let root: string;
  const savedDir = process.env.B_STUDIO_PROJECTS_DIR;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'b-studio-projects-'));
    await mkdir(path.join(root, 'orders'));
    process.env.B_STUDIO_PROJECTS_DIR = root;
    spies.inspectSource.mockReset().mockResolvedValue({ base: 'main', originUrl: 'git@github.com:acme/orders.git', dirtyFiles: 0, subdir: '' });
    spies.cachedRepositoryToken.mockReset().mockResolvedValue(undefined);
    spies.localFolderAllowed.mockReset().mockReturnValue(false);
  });

  afterEach(async () => {
    if (savedDir === undefined) delete process.env.B_STUDIO_PROJECTS_DIR;
    else process.env.B_STUDIO_PROJECTS_DIR = savedDir;
    await rm(root, { recursive: true, force: true });
  });

  it('환경 변수 토큰이 있으면 올릴 수 있다', async () => {
    spies.cachedRepositoryToken.mockResolvedValue('env-token');
    expect(await canPublishIssues('orders')).toBe(true);
  });

  it('환경 변수도 gh CLI 대체도 없으면 올릴 수 없다', async () => {
    expect(await canPublishIssues('orders')).toBe(false);
  });

  it('개인 PC 모드의 gh CLI 로그인 토큰만 있어도 올릴 수 있다(세션의 PR 생성·이슈 발행과 같은 토큰 찾기)', async () => {
    spies.cachedRepositoryToken.mockResolvedValue('gh-cli-token');
    expect(await canPublishIssues('orders')).toBe(true);
    expect(spies.cachedRepositoryToken).toHaveBeenCalledWith('github', expect.anything());
  });

  it('원격 저장소가 아니면 토큰을 찾지 않고 올릴 수 없다고 한다', async () => {
    spies.inspectSource.mockResolvedValue(undefined);
    expect(await canPublishIssues('orders')).toBe(false);
    expect(spies.cachedRepositoryToken).not.toHaveBeenCalled();
  });
});
