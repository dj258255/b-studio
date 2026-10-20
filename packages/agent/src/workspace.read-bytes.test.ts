import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// node:fs의 readSync·fstatSync만 가로챈다. shortRead를 켜면 한 바이트도 읽지 않은 것처럼 만들고(확인한 stat 크기보다 적게 읽은 상황),
// growOnSecondStat을 켜면 두 번째 fstat이 더 큰 크기를 돌려준다(읽는 동안 파일 뒤에 내용이 덧붙은 상황).
// 둘 다 readRegularFileBytesSync가 어중간하게 읽은 내용을 완전한 것으로 돌려주지 않는지 확인한다
const state = vi.hoisted(() => ({ shortRead: false, growOnSecondStat: false, statCalls: 0 }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const readSync = ((...args: Parameters<typeof actual.readSync>) => (state.shortRead ? 0 : actual.readSync(...args))) as typeof actual.readSync;
  const fstatSync = ((...args: Parameters<typeof actual.fstatSync>) => {
    const stat = actual.fstatSync(...args);
    if (state.growOnSecondStat && ++state.statCalls >= 2) return { ...stat, size: Number(stat.size) + 1, mtimeMs: Number(stat.mtimeMs) + 1 } as typeof stat;
    return stat;
  }) as typeof actual.fstatSync;
  return { ...actual, readSync, fstatSync };
});

import { readRegularFileBytesSync } from './workspace';

let root: string;

beforeEach(async () => {
  state.shortRead = false;
  state.growOnSecondStat = false;
  state.statCalls = 0;
  root = await mkdtemp(path.join(tmpdir(), 'workspace-bytes-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('readRegularFileBytesSync', () => {
  it('원본 바이트를 그대로 돌려준다(글자로 바꾸지 않는다)', async () => {
    const file = path.join(root, 'asset.bin');
    await writeFile(file, Buffer.from([0xff, 0x41]));

    expect(readRegularFileBytesSync(file)).toEqual({ kind: 'bytes', content: Buffer.from([0xff, 0x41]), complete: true });
  });

  it('읽는 도중 파일이 줄어 확인한 크기만큼 읽지 못하면 complete=false로 알린다(지문 쪽에서 실패로 본다)', async () => {
    const file = path.join(root, 'asset.bin');
    await writeFile(file, Buffer.from([0xff, 0x41]));
    state.shortRead = true;

    expect(readRegularFileBytesSync(file)).toMatchObject({ kind: 'bytes', complete: false });
  });

  it('읽는 도중 파일이 늘어 두 번째 fstat이 달라지면 complete=false로 알린다', async () => {
    const file = path.join(root, 'asset.bin');
    await writeFile(file, Buffer.from([0xff, 0x41]));
    state.growOnSecondStat = true;

    expect(readRegularFileBytesSync(file)).toMatchObject({ kind: 'bytes', complete: false });
  });
});
