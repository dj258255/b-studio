import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioError } from './errors';
import { listFolder, MAX_ENTRIES } from './folder-browser';

const made: string[] = [];

async function repo(files: Record<string, string>, dirs: string[] = []): Promise<string> {
  // listFolder는 realpath로 심볼릭 링크를 실제 경로로 푼다(macOS의 /var → /private/var처럼 tmpdir 자체가
  // 링크인 경우가 있어, 만든 루트도 미리 실제 경로로 바꿔 둬야 비교가 어긋나지 않는다
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'b-studio-folders-')));
  made.push(root);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  for (const dir of dirs) await mkdir(path.join(root, dir), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('listFolder', () => {
  it('하위 폴더를 이름순으로 보여주고 각 폴더의 실마리를 찾는다', async () => {
    const root = await repo(
      {
        'web/package.json': JSON.stringify({ dependencies: { next: '16.0.0' } }),
        'api/build.gradle': "plugins { id 'org.springframework.boot' }",
        'api/gradlew': '#!/bin/sh',
        'db/compose.yaml': 'services: {}',
        'plain/README.md': '# plain',
      },
      ['web', 'api', 'db', 'plain'],
    );

    const listing = await listFolder({ path: root });

    expect(listing.path).toBe(root);
    expect(listing.children.map((child) => child.name)).toEqual(['api', 'db', 'plain', 'web']);
    expect(listing.children.find((child) => child.name === 'web')?.hints).toEqual(['nextjs']);
    expect(listing.children.find((child) => child.name === 'api')?.hints).toEqual(['spring-boot']);
    expect(listing.children.find((child) => child.name === 'db')?.hints).toEqual(['compose']);
    expect(listing.children.find((child) => child.name === 'plain')?.hints).toEqual([]);
  });

  it('등록된 폴더는 registered 실마리를 더한다', async () => {
    const root = await repo({}, ['registered-app']);
    const registryFile = path.join(root, 'registry.json');
    await writeFile(
      registryFile,
      JSON.stringify({ version: 1, projects: [{ id: 'registered-app', path: path.join(root, 'registered-app'), addedAt: new Date().toISOString() }] }),
    );

    const listing = await listFolderWithRegistry(root, registryFile);

    expect(listing.children.find((child) => child.name === 'registered-app')?.hints).toContain('registered');
  });

  it('studio.yaml이 있는 폴더는 studio-yaml 실마리를 보인다', async () => {
    const root = await repo({ 'has-spec/studio.yaml': 'version: 1\n' }, ['has-spec']);

    const listing = await listFolder({ path: root });

    expect(listing.children.find((child) => child.name === 'has-spec')?.hints).toEqual(['studio-yaml']);
  });

  it('점으로 시작하는 폴더는 기본으로 숨기고, showHidden이면 보여준다(node_modules·.git은 항상 숨긴다)', async () => {
    const root = await repo({}, ['.hidden', 'node_modules', '.git', 'visible']);

    const withoutHidden = await listFolder({ path: root });
    expect(withoutHidden.children.map((child) => child.name)).toEqual(['visible']);

    const withHidden = await listFolder({ path: root, showHidden: true });
    expect(withHidden.children.map((child) => child.name)).toEqual(['.hidden', 'visible']);
  });

  it('하위 폴더가 있는 폴더는 hasChildren을 true로 표시한다', async () => {
    const root = await repo({}, ['with-child', 'with-child/inner', 'empty']);

    const listing = await listFolder({ path: root });

    expect(listing.children.find((child) => child.name === 'with-child')?.hasChildren).toBe(true);
    expect(listing.children.find((child) => child.name === 'empty')?.hasChildren).toBe(false);
  });

  it('심볼릭 링크로 이어진 폴더도 목록에 넣고 실제 경로가 아닌 링크 이름으로 보여준다', async () => {
    const root = await repo({}, ['real-target']);
    await symlink(path.join(root, 'real-target'), path.join(root, 'linked'));

    const listing = await listFolder({ path: root });

    expect(listing.children.map((child) => child.name)).toEqual(['linked', 'real-target']);
  });

  it('상한을 넘는 폴더는 일부만 보여주고 truncated를 켠다', async () => {
    const names = Array.from({ length: MAX_ENTRIES + 5 }, (_, index) => `dir-${String(index).padStart(4, '0')}`);
    const root = await repo({}, names);

    const listing = await listFolder({ path: root });

    expect(listing.children).toHaveLength(MAX_ENTRIES);
    expect(listing.truncated).toBe(true);
    expect(listing.totalCount).toBe(names.length);
  });

  it('부모·빵부스러기를 계산한다', async () => {
    const root = await repo({}, ['child']);
    const childPath = path.join(root, 'child');

    const listing = await listFolder({ path: childPath });

    expect(listing.parent).toBe(root);
    expect(listing.breadcrumbs[listing.breadcrumbs.length - 1]).toEqual({ name: 'child', path: childPath });
    expect(listing.breadcrumbs[0]).toEqual({ name: path.sep, path: path.sep });
  });

  it('폴더가 아닌 경로는 400을 던진다', async () => {
    const root = await repo({ 'file.txt': 'hi' });

    await expect(listFolder({ path: path.join(root, 'file.txt') })).rejects.toThrow(StudioError);
  });

  it('없는 경로는 400을 던진다', async () => {
    const root = await repo({});

    await expect(listFolder({ path: path.join(root, 'nope') })).rejects.toMatchObject({ status: 400 });
  });

  it('상대 경로는 400을 던진다', async () => {
    await expect(listFolder({ path: 'relative/path' })).rejects.toMatchObject({ status: 400 });
  });

  it('바로가기에 홈과 존재하는 최근 폴더를 담는다(최대 8개, 최신 순)', async () => {
    const root = await repo({}, Array.from({ length: 10 }, (_, index) => `proj-${index}`));
    const registryFile = path.join(root, 'registry.json');
    const projects = Array.from({ length: 10 }, (_, index) => ({
      id: `proj-${index}`,
      path: path.join(root, `proj-${index}`),
      addedAt: new Date(2026, 0, index + 1).toISOString(),
    }));
    await writeFile(registryFile, JSON.stringify({ version: 1, projects }));

    const listing = await listFolderWithRegistry(root, registryFile);

    const recent = listing.shortcuts.filter((shortcut) => shortcut.recent);
    expect(recent).toHaveLength(8);
    expect(recent[0]?.path).toBe(path.join(root, 'proj-9'));
    expect(listing.shortcuts[0]).toEqual({ label: '홈', path: expect.any(String) });
  });
});

/** 레지스트리 파일 경로를 바꿔서 listFolder를 부른다(project-registry의 registryPath는 env로만 바뀐다) */
async function listFolderWithRegistry(root: string, registryFile: string) {
  const previous = process.env.B_STUDIO_PROJECT_REGISTRY;
  process.env.B_STUDIO_PROJECT_REGISTRY = registryFile;
  try {
    return await listFolder({ path: root });
  } finally {
    if (previous === undefined) delete process.env.B_STUDIO_PROJECT_REGISTRY;
    else process.env.B_STUDIO_PROJECT_REGISTRY = previous;
  }
}
