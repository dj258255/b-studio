import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { native } from '@b-studio/sandbox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRegularFileBytesSync } from './workspace';

// 읽는 도중 파일이 줄거나 늘어 complete=false가 되는 경우(짧게 읽힘, 두 번째 fstat의 크기·수정 시각 변화)는 읽기를 Rust로 옮기면서
// node:fs를 가로채는 방식으로는 시험할 수 없게 되어, crates/bstudio-io/src/workspace_io.rs의 `읽는_동안_줄거나_늘면_완전한_읽기가_아니다`가 본다

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'workspace-bytes-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('readRegularFileBytesSync', () => {
  it('원본 바이트를 그대로 돌려준다(글자로 바꾸지 않는다)', async () => {
    const file = path.join(root, 'asset.bin');
    await writeFile(file, Buffer.from([0xff, 0x41]));

    expect(readRegularFileBytesSync(file)).toEqual({ kind: 'bytes', content: Buffer.from([0xff, 0x41]), complete: true });
  });

  it('상한 경계: 상한과 같으면 읽고 1바이트 넘으면 읽지 않는다', async () => {
    const file = path.join(root, 'asset.bin');
    await writeFile(file, Buffer.alloc(16, 1));

    expect(readRegularFileBytesSync(file, 16)).toMatchObject({ kind: 'bytes', complete: true });
    expect(readRegularFileBytesSync(file, 15)).toMatchObject({ kind: 'irregular', reason: expect.stringContaining('너무 큽니다') });
  });

  it('Rust가 완전하지 않다고 알린 읽기와 모르는 꼴은 그대로 옮긴다(완전한 읽기로 올리지 않는다)', () => {
    const spy = vi.spyOn(native, 'workspaceReadRegularFile');
    spy.mockReturnValueOnce({ kind: 'bytes', content: Buffer.from('ab'), complete: false });
    expect(readRegularFileBytesSync('/x')).toEqual({ kind: 'bytes', content: Buffer.from('ab'), complete: false });
    spy.mockReturnValueOnce({ kind: 'bytes', content: Buffer.from('ab') });
    expect(readRegularFileBytesSync('/x')).toMatchObject({ kind: 'bytes', complete: false });
    spy.mockReturnValueOnce({ kind: 'surprise' } as never);
    expect(readRegularFileBytesSync('/x')).toMatchObject({ kind: 'irregular' });
    spy.mockReturnValueOnce({ kind: 'bytes' } as never);
    expect(readRegularFileBytesSync('/x')).toMatchObject({ kind: 'irregular' });
  });
});
