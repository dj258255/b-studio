import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluationAssetCopies, prepareEvaluationAssetCopies, removeEvaluationAssets } from './evaluation-assets';

/**
 * 링크 안전 파일 시스템 준비(ADR-193, 2c-1b)의 특성 시험. 공개 함수(`prepareEvaluationAssetCopies`·
 * `removeEvaluationAssets`)로만 확인해, 옛 TS 구현과 Rust 구현에 같은 시험을 돌릴 수 있다.
 * 기대값은 파일 시스템의 대소문자 규칙에 기대지 않는다(링크·내용·종류·신원으로만 본다).
 */
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'link-safe-fs-')));
  dirs.push(dir);
  return dir;
}

/** 링크 너머에 두는 "지우면 안 되는" 폴더 */
async function outsideDir(base: string): Promise<string> {
  const outside = path.join(base, 'outside');
  await mkdir(path.join(outside, 'keep'), { recursive: true });
  await writeFile(path.join(outside, 'important.txt'), '지우면 안 되는 파일');
  await writeFile(path.join(outside, 'keep', 'deep.txt'), '깊은 파일');
  return outside;
}

async function expectOutsideIntact(outside: string): Promise<void> {
  expect(await readFile(path.join(outside, 'important.txt'), 'utf8')).toBe('지우면 안 되는 파일');
  expect(await readFile(path.join(outside, 'keep', 'deep.txt'), 'utf8')).toBe('깊은 파일');
}

describe('평가 자산 복사본 자리 준비(prepareEvaluationAssetCopies)', () => {
  it('폴더 자산의 자리가 밖을 가리키는 링크면 링크만 지우고 진짜 폴더를 만든다', async () => {
    const base = await temp();
    const root = path.join(base, 'cache');
    const outside = await outsideDir(base);
    const [copy] = evaluationAssetCopies(['tests'], root, 'sb-1');
    await mkdir(path.dirname(copy!.source), { recursive: true });
    await symlink(outside, copy!.source);
    const slots = await prepareEvaluationAssetCopies(['tests'], root, 'sb-1', [{ path: 'tests', kind: 'directory', files: [] }]);
    expect(slots[0]?.kind).toBe('directory');
    expect((await lstat(copy!.source)).isSymbolicLink()).toBe(false);
    await expectOutsideIntact(outside);
  });

  it('파일 자산의 자리가 밖의 파일을 가리키는 링크면 그 파일을 자르지 않는다', async () => {
    const base = await temp();
    const root = path.join(base, 'cache');
    const victim = path.join(base, 'victim.txt');
    await writeFile(victim, '보존');
    const [copy] = evaluationAssetCopies(['spec.md'], root, 'sb-1');
    await mkdir(path.dirname(copy!.source), { recursive: true });
    await symlink(victim, copy!.source);
    await prepareEvaluationAssetCopies(['spec.md'], root, 'sb-1', [
      { path: 'spec.md', kind: 'file', files: [{ path: 'spec.md', content: Buffer.from('새 내용'), executable: false }] },
    ]);
    expect(await readFile(victim, 'utf8')).toBe('보존');
    expect((await lstat(copy!.source)).isFile()).toBe(true);
    expect(await readFile(copy!.source, 'utf8')).toBe('새 내용');
  });

  it('파일 자산의 자리에 내용이 든 폴더가 있으면 재귀로 지우지 않고 멈춘다(옛 구현은 폴더를 통째로 지웠다)', async () => {
    const base = await temp();
    const root = path.join(base, 'cache');
    const [copy] = evaluationAssetCopies(['spec.md'], root, 'sb-1');
    await mkdir(path.join(copy!.source, 'inner'), { recursive: true });
    await writeFile(path.join(copy!.source, 'inner', 'note.txt'), '지우지 않는다');
    await expect(
      prepareEvaluationAssetCopies(['spec.md'], root, 'sb-1', [{ path: 'spec.md', kind: 'file', files: [] }]),
    ).rejects.toThrow();
    expect(await readFile(path.join(copy!.source, 'inner', 'note.txt'), 'utf8')).toBe('지우지 않는다');
  });

  it('다시 불러도(재시도·동시) 폴더 자리는 같은 inode로 남는다', async () => {
    const base = await temp();
    const root = path.join(base, 'cache');
    const first = await prepareEvaluationAssetCopies(['tests'], root, 'sb-1', [{ path: 'tests', kind: 'directory', files: [] }]);
    const second = await prepareEvaluationAssetCopies(['tests'], root, 'sb-1', [{ path: 'tests', kind: 'directory', files: [] }]);
    expect(second[0]?.ino).toBe(first[0]?.ino);
    expect(second[0]?.dev).toBe(first[0]?.dev);
  });
});

describe('샌드박스 복사본 폴더 지우기(removeEvaluationAssets)', () => {
  it('폴더 자체가 링크면 링크만 지우고 너머는 건드리지 않는다', async () => {
    const base = await temp();
    const root = path.join(base, 'cache');
    await mkdir(root);
    const outside = await outsideDir(base);
    await symlink(outside, path.join(root, 'sb-1'));
    await removeEvaluationAssets(root, 'sb-1');
    await expect(lstat(path.join(root, 'sb-1'))).rejects.toThrow();
    await expectOutsideIntact(outside);
  });

  it('폴더 안의 링크(폴더·파일)는 따라가지 않고 링크만 지운다', async () => {
    const base = await temp();
    const root = path.join(base, 'cache');
    const outside = await outsideDir(base);
    const dir = path.join(root, 'sb-1');
    await mkdir(path.join(dir, 'a', 'b'), { recursive: true });
    await symlink(outside, path.join(dir, 'a', 'b', 'dirlink'));
    await symlink(path.join(outside, 'important.txt'), path.join(dir, 'filelink'));
    await removeEvaluationAssets(root, 'sb-1');
    await expect(lstat(dir)).rejects.toThrow();
    await expectOutsideIntact(outside);
  });

  it('없는 폴더는 조용히 넘어간다', async () => {
    const base = await temp();
    await expect(removeEvaluationAssets(path.join(base, 'cache'), 'none')).resolves.toBeUndefined();
  });
});
