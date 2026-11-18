import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckpointStore } from '@b-studio/agent';
import { afterEach, describe, expect, it } from 'vitest';
import { generatedFilePaths, readRegistry, unregisterProject } from './project-registry';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 등록 항목 count개가 든 projects.json 하나. 등록 파일 쓰기(임시 파일)를 직접 겨눈다 */
async function registryFile(count: number): Promise<{ file: string; ids: string[] }> {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-registry-'));
  roots.push(root);
  const file = path.join(root, 'projects.json');
  const ids = Array.from({ length: count }, (_, index) => `p-${index}`);
  const projects = ids.map((id) => ({ id, path: `/tmp/${id}`, addedAt: '2026-01-01T00:00:00.000Z' }));
  await writeFile(file, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`);
  return { file, ids };
}

describe('등록 파일 쓰기(임시 이름이 프로세스마다 겹치지 않는다)', () => {
  it('같은 파일에 동시에 여러 번 쓰면 임시 이름이 겹치지 않아 모두 성공하고, 남은 .tmp 없이 하나의 온전한 내용만 남는다', async () => {
    const { file, ids } = await registryFile(30);

    // 옛 이름(`${file}.<pid>.tmp`)이면 같은 임시 파일에 겹쳐 써 rename이 ENOENT로 실패한다
    await expect(Promise.all(ids.map((id) => unregisterProject(id, file)))).resolves.toBeDefined();

    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const saved = await readRegistry(file);
    expect(saved.length).toBeGreaterThan(0);
    for (const entry of saved) {
      expect(entry.path).toMatch(/^\/tmp\/p-\d+$/);
      expect(ids).toContain(entry.id);
    }
  });
});

describe('생성 파일 이름 경계(제품 경로를 막지 않는다)', () => {
  it('generatedFilePaths가 내는 이름은 체크포인트가 거부하지 않는다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'b-studio-generated-'));
    roots.push(root);
    await mkdir(path.join(root, 'apps/web'), { recursive: true });
    for (const file of ['studio.yaml', 'compose.b-studio.yaml', 'Dockerfile.b-studio', 'apps/web/Dockerfile.b-studio']) {
      await writeFile(path.join(root, file), 'generated\n');
    }

    // 실제로 내는 이름: studio.yaml·compose.b-studio.yaml·루트/한 단계/두 단계의 Dockerfile.b-studio
    expect(await generatedFilePaths(root)).toEqual(['studio.yaml', 'compose.b-studio.yaml', 'Dockerfile.b-studio', 'apps/web/Dockerfile.b-studio']);

    const store = new CheckpointStore(root, { excludedFiles: (projectRoot) => generatedFilePaths(projectRoot) });
    await expect(store.init()).resolves.toBeDefined();
    await writeFile(path.join(root, 'studio.yaml'), 'changed\n');
    await expect(store.discard()).resolves.toBeDefined();
  });
});

describe('생성 파일 이름 경계(링크 폴더를 따라가지 않는다)', () => {
  it('링크 폴더 아래의 Dockerfile.b-studio는 내지 않는다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'b-studio-link-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'b-studio-link-out-'));
    roots.push(root, outside);
    await mkdir(path.join(outside, 'web'), { recursive: true });
    await writeFile(path.join(outside, 'web', 'Dockerfile.b-studio'), 'outside\n');
    // 프로젝트 안의 apps는 프로젝트 밖 폴더를 가리키는 링크다
    await symlink(outside, path.join(root, 'apps'));

    expect(await generatedFilePaths(root)).toEqual([]);
  });
});
