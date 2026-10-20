import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
    const { root } = await roots();
    const contents = [
      { path: 'tests/acceptance', kind: 'directory' as const, files: [] },
      { path: 'expected.json', kind: 'file' as const, files: [] },
    ];

    const forward = await prepareEvaluationAssetCopies(['tests/acceptance', 'expected.json'], root, 'sb', contents);
    const backward = await prepareEvaluationAssetCopies(['expected.json', 'tests/acceptance'], root, 'sb', contents);

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
    const { root } = await roots();
    const outside = path.join(path.dirname(root), 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'important.txt'), '지우면 안 된다');

    const [slot] = evaluationAssetCopies(['tests/acceptance'], root, 'sb');
    await mkdir(path.dirname(slot!.source), { recursive: true });
    await symlink(outside, slot!.source);

    const [prepared] = await prepareEvaluationAssetCopies(['tests/acceptance'], root, 'sb');
    expect((await lstat(prepared!.source)).isSymbolicLink()).toBe(false);
    expect((await lstat(prepared!.source)).isDirectory()).toBe(true);
    expect(await readdir(prepared!.source)).toEqual([]);
    expect(await readFile(path.join(outside, 'important.txt'), 'utf8')).toBe('지우면 안 된다');
  });

  it('자리 종류와 첫 내용은 넘긴 판(체크포인트)을 따른다. 작업 복사본의 모습은 보지 않는다', async () => {
    const { project, root } = await roots();
    // 작업 복사본에서는 자산이 없거나 링크일 수 있다. 에이전트가 그렇게 바꿔도 자리 종류가 따라가지 않아야 한다
    const outside = path.join(path.dirname(root), 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(project, 'tests'));

    const slots = await prepareEvaluationAssetCopies(['tests/acceptance', 'expected.json', 'later.json'], root, 'sb', [
      { path: 'tests/acceptance', kind: 'directory', files: [{ path: 'tests/acceptance/a.txt', content: Buffer.from('a\n'), executable: false }] },
      { path: 'expected.json', kind: 'file', files: [{ path: 'expected.json', content: Buffer.from('{}\n'), executable: false }] },
    ]);

    expect(slots.map((slot) => [slot.path, slot.kind])).toEqual([
      ['tests/acceptance', 'directory'],
      ['expected.json', 'file'],
      ['later.json', 'directory'],
    ]);
    expect(await readFile(path.join(slots[0]!.source, 'a.txt'), 'utf8')).toBe('a\n');
    expect(await readFile(slots[1]!.source, 'utf8')).toBe('{}\n');
    // 선언했지만 판에 없는 자산은 빈 폴더 자리다
    expect((await lstat(slots[2]!.source)).isDirectory()).toBe(true);
    expect(await readdir(slots[2]!.source)).toEqual([]);
    // 작업 복사본의 링크 너머는 건드리지 않는다
    expect(await readdir(outside)).toEqual([]);
  });

  it('선언에 없는 자산의 복사본은 바꾸지 않는다', async () => {
    const { root } = await roots();
    const slots = await prepareEvaluationAssetCopies(['tests/acceptance'], root, 'sb');
    await expect(syncEvaluationAssetCopies(slots, evaluationAssetSandboxDir(root, 'sb'), [{ path: 'elsewhere', kind: 'directory', files: [] }])).rejects.toThrow(
      '선언하지 않은 평가 자산',
    );
  });
});

describe('syncEvaluationAssetCopies', () => {
  async function setup(): Promise<{ slots: EvaluationAssetSlot[]; sandboxDir: string; root: string }> {
    const { root } = await roots();
    const slots = await prepareEvaluationAssetCopies(['tests/acceptance', 'expected.json'], root, 'sb', [
      { path: 'tests/acceptance', kind: 'directory', files: [] },
      { path: 'expected.json', kind: 'file', files: [] },
    ]);
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

  const contents = [
    { path: 'tests/acceptance', kind: 'directory' as const, files: [{ path: 'tests/acceptance/a.txt', content: Buffer.from('a\n'), executable: false }] },
    { path: 'expected.json', kind: 'file' as const, files: [{ path: 'expected.json', content: Buffer.from('{"ok":true}\n'), executable: false }] },
  ];

  it('자리를 지웠으면 sync는 자리를 다시 만들지 않고 멈춘다', async () => {
    const { slots, sandboxDir } = await setup();
    const dirSlot = slots.find((slot) => slot.kind === 'directory')!;
    await rm(dirSlot.source, { recursive: true, force: true });

    await expect(syncEvaluationAssetCopies(slots, sandboxDir, contents)).rejects.toThrow('자리가 바뀌었습니다');
    expect(await lstat(dirSlot.source).catch(() => undefined)).toBeUndefined();
  });

  it('자리를 다른 inode로 바꿔치기했으면 sync는 그 자리를 고치지 않고 멈춘다', async () => {
    const { slots, sandboxDir } = await setup();
    const dirSlot = slots.find((slot) => slot.kind === 'directory')!;
    // 실제로는 컨테이너 마운트가 옛 자리를 붙잡고 있어 그 inode 번호가 풀리지 않는다. 열어 두지 않으면 리눅스는 지운 번호를 곧바로
    // 새 폴더에 다시 써서 같은 자리로 보인다(CI에서 그랬다)
    const held = await open(dirSlot.source, 'r');
    try {
      await rm(dirSlot.source, { recursive: true, force: true });
      await mkdir(dirSlot.source);

      await expect(syncEvaluationAssetCopies(slots, sandboxDir, contents)).rejects.toThrow('자리가 바뀌었습니다');
      expect(await readdir(dirSlot.source)).toEqual([]);
    } finally {
      await held.close();
    }
  });

  it('파일 자산 자리를 다른 inode로 바꿔치기했으면 그 내용을 덮어쓰지 않고 멈춘다', async () => {
    const { slots, sandboxDir } = await setup();
    const fileSlot = slots.find((slot) => slot.kind === 'file')!;
    // 위와 같은 까닭으로 옛 자리를 열어 둔다(마운트가 붙잡은 것과 같게)
    const held = await open(fileSlot.source, 'r');
    try {
      await rm(fileSlot.source, { force: true });
      await writeFile(fileSlot.source, '바꿔치기한 내용');

      await expect(syncEvaluationAssetCopies(slots, sandboxDir, contents)).rejects.toThrow('자리가 바뀌었습니다');
      expect(await readFile(fileSlot.source, 'utf8')).toBe('바꿔치기한 내용');
    } finally {
      await held.close();
    }
  });

  it('넘긴 판의 종류가 자리 종류와 다르면 sync는 자리를 바꾸지 않고 멈춘다', async () => {
    const { slots, sandboxDir } = await setup();
    const dirSlot = slots.find((slot) => slot.kind === 'directory')!;
    await expect(
      syncEvaluationAssetCopies(slots, sandboxDir, [{ path: 'tests/acceptance', kind: 'file', files: [{ path: 'tests/acceptance', content: Buffer.from('x'), executable: false }] }]),
    ).rejects.toThrow('자리가 바뀌었습니다');
    expect((await lstat(dirSlot.source)).isDirectory()).toBe(true);
  });
});

describe('removeEvaluationAssets', () => {
  it('그 샌드박스 id의 복사본 폴더만 지운다', async () => {
    const { project, root } = await roots();
    await mkdir(path.join(project, 'tests', 'acceptance'), { recursive: true });
    await prepareEvaluationAssetCopies(['tests/acceptance'], root, 'sb');
    await prepareEvaluationAssetCopies(['tests/acceptance'], root, 'other');
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
