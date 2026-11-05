import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedFiles } from './verify';

const execFileAsync = promisify(execFile);

let root: string;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args]);
  return stdout;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'verify-test-'));
  await git('init', '-q');
  await git('config', 'user.name', 'tester');
  await git('config', 'user.email', 'tester@example.com');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('changedFiles', () => {
  it('추적하지 않는 폴더 안의 파일을 폴더가 아니라 파일로 돌려준다', async () => {
    await mkdir(path.join(root, 'infra/deep'), { recursive: true });
    await writeFile(path.join(root, 'infra/verify-check.txt'), 'x');
    await writeFile(path.join(root, 'infra/deep/a.txt'), 'y');

    expect(await changedFiles(root)).toEqual(['infra/deep/a.txt', 'infra/verify-check.txt']);
  });

  it('프로젝트 루트가 저장소 하위 폴더면 그 안의 변경만 상대 경로로 돌려준다', async () => {
    await mkdir(path.join(root, 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'pkg/inside.txt'), 'x');
    await writeFile(path.join(root, 'outside.txt'), 'y');

    expect(await changedFiles(path.join(root, 'pkg'))).toEqual(['inside.txt']);
  });
});

describe('changedFiles: ..로 시작하는 이름 (#1004)', () => {
  it('..로 시작하는 폴더·파일의 변경도 검사 대상에 넣는다(빠지면 게이트가 보지 않는다)', async () => {
    await mkdir(path.join(root, '..docs'), { recursive: true });
    await writeFile(path.join(root, '..docs/a.md'), 'x');
    await writeFile(path.join(root, '...hidden.ts'), 'y');

    expect(await changedFiles(root)).toEqual(['...hidden.ts', '..docs/a.md']);
  });

  it('하위 폴더 프로젝트에서는 ..로 시작하는 이름의 형제 폴더를 프로젝트 밖으로 걸러 내고 안의 것은 남긴다', async () => {
    await mkdir(path.join(root, 'pkg/..in'), { recursive: true });
    await mkdir(path.join(root, '..out'), { recursive: true });
    await writeFile(path.join(root, 'pkg/..in/a.txt'), 'x');
    await writeFile(path.join(root, '..out/b.txt'), 'y');

    expect(await changedFiles(path.join(root, 'pkg'))).toEqual(['..in/a.txt']);
  });
});
