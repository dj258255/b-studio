import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluationAssetCopies,
  evaluationAssetSandboxDir,
  prepareEvaluationAssetCopies,
  removeEvaluationAssets,
  syncEvaluationAssetCopies,
  type EvaluationAssetSlot,
} from './evaluation-assets';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'evaluation-assets-'));
  dirs.push(dir);
  return dir;
}

/** 작업 복사본(프로젝트)과 b-studio 복사본 루트를 나눠 만든다 */
async function roots(): Promise<{ project: string; root: string }> {
  const base = await temp();
  const project = path.join(base, 'project');
  const root = path.join(base, 'cache');
  await mkdir(project, { recursive: true });
  await mkdir(root, { recursive: true });
  return { project, root };
}

describe('평가 자산 복사본 자리', () => {
  it('폴더 자산은 빈 폴더, 파일 자산은 빈 파일로 만든다. 순서를 바꿔 불러도 같은 자리다', async () => {
    const { project, root } = await roots();
    await mkdir(path.join(project, 'tests', 'acceptance'), { recursive: true });
    await writeFile(path.join(project, 'expected.json'), '{}\n');

    const forward = await prepareEvaluationAssetCopies(['tests/acceptance', 'expected.json'], project, root, 'sb');
    const backward = await prepareEvaluationAssetCopies(['expected.json', 'tests/acceptance'], project, root, 'sb');

    expect(forward.map((slot) => [slot.path, slot.kind])).toEqual([
      ['tests/acceptance', 'directory'],
      ['expected.json', 'file'],
    ]);
    const byPath = new Map(backward.map((slot) => [slot.path, slot.source]));
    for (const slot of forward) expect(byPath.get(slot.path)).toBe(slot.source);
    expect((await lstat(forward[0]!.source)).isDirectory()).toBe(true);
    expect((await lstat(forward[1]!.source)).isFile()).toBe(true);
    expect(await readFile(forward[1]!.source, 'utf8')).toBe('');
    // 모든 자리가 복사본 폴더 바로 아래다
    for (const slot of forward) expect(path.dirname(slot.source)).toBe(evaluationAssetSandboxDir(root, 'sb'));
  });

  it('자리로 쓰일 경로가 링크나 다른 종류면 그 항목만 지우고 새로 만든다(링크 너머는 그대로)', async () => {
    const { project, root } = await roots();
    await mkdir(path.join(project, 'tests', 'acceptance'), { recursive: true });
    const outside = path.join(path.dirname(root), 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'important.txt'), '지우면 안 된다');

    const [slot] = evaluationAssetCopies(['tests/acceptance'], root, 'sb');
    await mkdir(path.dirname(slot!.source), { recursive: true });
    await symlink(outside, slot!.source);

    const [prepared] = await prepareEvaluationAssetCopies(['tests/acceptance'], project, root, 'sb');
    expect((await lstat(prepared!.source)).isSymbolicLink()).toBe(false);
    expect((await lstat(prepared!.source)).isDirectory()).toBe(true);
    expect(await readdir(prepared!.source)).toEqual([]);
    expect(await readFile(path.join(outside, 'important.txt'), 'utf8')).toBe('지우면 안 된다');
  });

  it('선언에 없는 자산의 복사본은 바꾸지 않는다', async () => {
    const { project, root } = await roots();
    await mkdir(path.join(project, 'tests', 'acceptance'), { recursive: true });
    const slots = await prepareEvaluationAssetCopies(['tests/acceptance'], project, root, 'sb');
    await expect(syncEvaluationAssetCopies(slots, evaluationAssetSandboxDir(root, 'sb'), [{ path: 'elsewhere', kind: 'directory', files: [] }])).rejects.toThrow(
      '선언하지 않은 평가 자산',
    );
  });
});

describe('syncEvaluationAssetCopies', () => {
  async function setup(): Promise<{ slots: EvaluationAssetSlot[]; sandboxDir: string; root: string }> {
    const { project, root } = await roots();
    await mkdir(path.join(project, 'tests', 'acceptance'), { recursive: true });
    await writeFile(path.join(project, 'expected.json'), '{}\n');
    const slots = await prepareEvaluationAssetCopies(['tests/acceptance', 'expected.json'], project, root, 'sb');
    return { slots, sandboxDir: evaluationAssetSandboxDir(root, 'sb'), root };
  }

  it('폴더 자산은 폴더 inode를 그대로 두고 안만 바꾼다. 파일 자산도 inode가 그대로다', async () => {
    const { slots, sandboxDir } = await setup();
    const dirSlot = slots.find((slot) => slot.kind === 'directory')!;
    const fileSlot = slots.find((slot) => slot.kind === 'file')!;
    const dirIno = (await lstat(dirSlot.source)).ino;
    const fileIno = (await lstat(fileSlot.source)).ino;

    await syncEvaluationAssetCopies(slots, sandboxDir, [
      {
        path: 'tests/acceptance',
        kind: 'directory',
        files: [
          { path: 'tests/acceptance/a.txt', content: Buffer.from('a\n'), executable: false },
          { path: 'tests/acceptance/nested/run.sh', content: Buffer.from('#!/bin/sh\n'), executable: true },
        ],
      },
      { path: 'expected.json', kind: 'file', files: [{ path: 'expected.json', content: Buffer.from('{"ok":true}\n'), executable: false }] },
    ]);

    expect(await readFile(path.join(dirSlot.source, 'a.txt'), 'utf8')).toBe('a\n');
    expect(await readFile(path.join(dirSlot.source, 'nested', 'run.sh'), 'utf8')).toBe('#!/bin/sh\n');
    expect((await lstat(path.join(dirSlot.source, 'nested', 'run.sh'))).mode & 0o111).not.toBe(0);
    expect(await readFile(fileSlot.source, 'utf8')).toBe('{"ok":true}\n');
    expect((await lstat(dirSlot.source)).ino).toBe(dirIno);
    expect((await lstat(fileSlot.source)).ino).toBe(fileIno);

    // 지운 파일은 사라지고, 폴더 inode는 여전히 그대로다
    await syncEvaluationAssetCopies(slots, sandboxDir, [
      { path: 'tests/acceptance', kind: 'directory', files: [{ path: 'tests/acceptance/b.txt', content: Buffer.from('b\n'), executable: false }] },
      { path: 'expected.json', kind: 'file', files: [{ path: 'expected.json', content: Buffer.from('{"ok":false}\n'), executable: false }] },
    ]);
    expect(await readdir(dirSlot.source)).toEqual(['b.txt']);
    expect((await lstat(dirSlot.source)).ino).toBe(dirIno);
    expect((await lstat(fileSlot.source)).ino).toBe(fileIno);
    expect(await readFile(fileSlot.source, 'utf8')).toBe('{"ok":false}\n');
  });

  it('복사본 안의 링크는 따라가지 않고 지운 뒤 진짜 파일을 쓴다(링크 너머는 그대로)', async () => {
    const { slots, sandboxDir, root } = await setup();
    const dirSlot = slots.find((slot) => slot.kind === 'directory')!;
    const outside = path.join(path.dirname(root), 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'important.txt'), '지우면 안 된다');
    await mkdir(path.join(dirSlot.source, 'nested'));
    await symlink(path.join(outside, 'important.txt'), path.join(dirSlot.source, 'nested', 'evil.txt'));

    await syncEvaluationAssetCopies(slots, sandboxDir, [
      { path: 'tests/acceptance', kind: 'directory', files: [{ path: 'tests/acceptance/nested/evil.txt', content: Buffer.from('우리 것\n'), executable: false }] },
      { path: 'expected.json', kind: 'file', files: [] },
    ]);

    const written = path.join(dirSlot.source, 'nested', 'evil.txt');
    expect((await lstat(written)).isSymbolicLink()).toBe(false);
    expect(await readFile(written, 'utf8')).toBe('우리 것\n');
    expect(await readFile(path.join(outside, 'important.txt'), 'utf8')).toBe('지우면 안 된다');
  });

  it('선언 경로 밖의 파일과 `..`가 든 경로는 거절한다', async () => {
    const { slots, sandboxDir } = await setup();
    await expect(
      syncEvaluationAssetCopies(slots, sandboxDir, [{ path: 'tests/acceptance', kind: 'directory', files: [{ path: 'tests/other.txt', content: Buffer.from('x'), executable: false }] }]),
    ).rejects.toThrow('선언 경로 밖');
    await expect(
      syncEvaluationAssetCopies(slots, sandboxDir, [
        { path: 'tests/acceptance', kind: 'directory', files: [{ path: 'tests/acceptance/../escape.txt', content: Buffer.from('x'), executable: false }] },
      ]),
    ).rejects.toThrow('올바르지 않습니다');
  });
});

describe('removeEvaluationAssets', () => {
  it('그 샌드박스 id의 복사본 폴더만 지운다', async () => {
    const { project, root } = await roots();
    await mkdir(path.join(project, 'tests', 'acceptance'), { recursive: true });
    await prepareEvaluationAssetCopies(['tests/acceptance'], project, root, 'sb');
    await prepareEvaluationAssetCopies(['tests/acceptance'], project, root, 'other');
    await removeEvaluationAssets(root, 'sb');
    expect(await readdir(root)).toEqual(['other']);
  });

  it('복사본 폴더 자리가 링크면 링크만 지우고 너머는 건드리지 않는다', async () => {
    const { root } = await roots();
    const outside = path.join(path.dirname(root), 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'important.txt'), '그대로');
    await symlink(outside, evaluationAssetSandboxDir(root, 'sb'));
    await removeEvaluationAssets(root, 'sb');
    expect(await readdir(root)).toEqual([]);
    expect(await readFile(path.join(outside, 'important.txt'), 'utf8')).toBe('그대로');
  });
});
