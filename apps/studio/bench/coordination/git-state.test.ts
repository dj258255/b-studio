import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitState } from './git-state';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-git-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir });
  git('init', '-q');
  await writeFile(path.join(dir, 'a.txt'), 'a');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

describe('벤치가 남기는 코드 상태', () => {
  it('깨끗한 작업 트리는 전체 해시와 dirty false를 남긴다', async () => {
    const dir = await repo();
    const state = gitState(dir);
    expect(state.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(state.shortCommit).toBe(state.commit.slice(0, state.shortCommit.length));
    expect(state.dirty).toBe(false);
    expect(state.dirtyFiles).toEqual([]);
  });

  it('고친 파일이나 새 파일이 있으면 dirty true와 그 경로를 남긴다', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, 'a.txt'), 'changed');
    await writeFile(path.join(dir, 'new.txt'), 'n');
    const state = gitState(dir);
    expect(state.dirty).toBe(true);
    expect(state.dirtyFiles).toEqual(['a.txt', 'new.txt']);
  });

  it('git 저장소가 아니면 알 수 없음으로 남기고 dirty를 단정하지 않는다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bench-nogit-'));
    dirs.push(dir);
    expect(gitState(dir)).toEqual({ commit: '알 수 없음', shortCommit: '알 수 없음', dirty: 'unknown', dirtyFiles: [] });
  });
});
