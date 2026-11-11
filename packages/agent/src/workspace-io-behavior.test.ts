import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangeTracker } from './change-tracker';
import { readProjectFileSync, readRegularFileBytesSync, Workspace, WorkspaceError } from './workspace';

/**
 * 작업 공간의 파일 시스템 I/O 동작 고정 시험(ADR-195 4f A3). 옛 TS 구현(node:fs)과 Rust(bstudio-io)가 같은 시험을 통과해야 한다.
 * 기대값은 이 기기의 파일 시스템을 기준으로 적지 않는다: 대소문자를 구분하는지 실행 중에 확인해 두 경우를 나눠 적는다
 * (macOS 기본 볼륨은 구분하지 않고 리눅스 CI는 구분한다).
 */
let root: string;
let outside: string;
let caseSensitive: boolean;
let workspace: Workspace;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'workspace-io-'));
  outside = await mkdtemp(path.join(tmpdir(), 'workspace-io-outside-'));
  await writeFile(path.join(outside, 'secret.txt'), 'outside secret');
  await mkdir(path.join(root, 'api/src'), { recursive: true });
  await writeFile(path.join(root, 'api/src/App.java'), 'class App {}\n');
  await writeFile(path.join(root, 'probe-lower'), 'x');
  caseSensitive = await lstat(path.join(root, 'PROBE-LOWER')).then(
    () => false,
    () => true,
  );
  workspace = new Workspace(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

describe('링크 바꿔치기: 확인한 경로가 아니라 실제로 연 대상이 프로젝트 안이어야 한다', () => {
  it('상위 폴더가 바깥을 가리키는 링크면 읽기·쓰기·고치기·지우기 모두 거절하고 바깥은 그대로다', async () => {
    await symlink(outside, path.join(root, 'swap'));
    await expect(workspace.read('swap/secret.txt')).rejects.toThrow(WorkspaceError);
    await expect(workspace.write('swap/secret.txt', 'tampered')).rejects.toThrow(WorkspaceError);
    await expect(workspace.write('swap/new.txt', 'tampered')).rejects.toThrow(WorkspaceError);
    await expect(workspace.edit('swap/secret.txt', 'outside', 'inside')).rejects.toThrow(WorkspaceError);
    await expect(workspace.remove('swap/secret.txt')).rejects.toThrow(WorkspaceError);
    await expect(workspace.search(['secret'], 'swap')).rejects.toThrow(WorkspaceError);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside secret');
    await expect(lstat(path.join(outside, 'new.txt'))).rejects.toThrow();
  });

  it('마지막 조각이 링크면(가리키는 곳이 바깥이든 안이든) 읽기·쓰기·지우기를 거절하고 링크도 대상도 그대로다', async () => {
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'out-link'));
    await symlink(path.join(root, 'api/src/App.java'), path.join(root, 'in-link'));
    for (const name of ['out-link', 'in-link']) {
      await expect(workspace.read(name)).rejects.toThrow('링크');
      await expect(workspace.write(name, 'tampered')).rejects.toThrow('링크');
      await expect(workspace.remove(name)).rejects.toThrow('링크');
    }
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside secret');
    expect(await readFile(path.join(root, 'api/src/App.java'), 'utf8')).toBe('class App {}\n');
    expect(await readlink(path.join(root, 'out-link'))).toBe(path.join(outside, 'secret.txt'));
    expect(await readlink(path.join(root, 'in-link'))).toBe(path.join(root, 'api/src/App.java'));
  });

  it('루트 자체가 링크를 거쳐 있어도 안쪽 파일은 읽고 쓰고 지운다(루트의 실제 위치를 기준으로 본다)', async () => {
    const viaLink = path.join(outside, 'root-link');
    await symlink(root, viaLink);
    const ws = new Workspace(viaLink);
    expect(await ws.read('api/src/App.java')).toBe('class App {}\n');
    await ws.write('api/src/New.java', 'class New {}\n');
    expect(await readFile(path.join(root, 'api/src/New.java'), 'utf8')).toBe('class New {}\n');
    await ws.remove('api/src/New.java');
    await expect(lstat(path.join(root, 'api/src/New.java'))).rejects.toThrow();
    expect(readProjectFileSync(viaLink, 'api/src/App.java')).toEqual({ kind: 'text', content: 'class App {}\n' });
  });

  it('쓰기가 만든 새 폴더 아래로는 바깥에 닿지 못한다', async () => {
    await workspace.write('fresh/dir/file.txt', 'ok');
    expect(await readFile(path.join(root, 'fresh/dir/file.txt'), 'utf8')).toBe('ok');
    expect((await lstat(path.join(root, 'fresh/dir'))).isDirectory()).toBe(true);
  });
});

describe('이름 변형: 숨긴 이름은 어떤 꼴이든 숨긴 이름이다', () => {
  it('대소문자·끝의 점·보이지 않는 글자·정규화 꼴을 바꾼 숨긴 이름을 읽거나 쓰지 못한다', async () => {
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(path.join(root, '.git/config'), 'cfg');
    await writeFile(path.join(root, '.env'), 'SECRET=1');
    const names = ['.GIT/config', '.Git/config', '.git./config', '.git​/config', '.ENV', '.Env', '.env.', '.env​', 'NODE_MODULES/x', 'node_modules/x', '.env.local', '.énv'];
    for (const name of names) {
      await expect(workspace.read(name), `read ${JSON.stringify(name)}`).rejects.toThrow(WorkspaceError);
      await expect(workspace.write(name, 'x'), `write ${JSON.stringify(name)}`).rejects.toThrow(WorkspaceError);
      await expect(workspace.remove(name), `remove ${JSON.stringify(name)}`).rejects.toThrow(WorkspaceError);
    }
    expect(await readFile(path.join(root, '.git/config'), 'utf8')).toBe('cfg');
    expect(await readFile(path.join(root, '.env'), 'utf8')).toBe('SECRET=1');
  });

  it('`..`·겹친 구분자·`.` 조각은 정리해서 읽고, 정리한 결과가 숨긴 이름이거나 밖이면 거절한다', async () => {
    await writeFile(path.join(root, '.env'), 'SECRET=1');
    expect(await workspace.read('api//src///App.java')).toBe('class App {}\n');
    expect(await workspace.read('./api/./src/App.java')).toBe('class App {}\n');
    expect(await workspace.read('api/src/../src/App.java')).toBe('class App {}\n');
    await expect(workspace.read('api/../.env')).rejects.toThrow(WorkspaceError);
    await expect(workspace.read('api/src/../../../x')).rejects.toThrow('프로젝트 밖');
    await expect(workspace.read('')).rejects.toThrow(WorkspaceError);
    await expect(workspace.read('.')).rejects.toThrow(WorkspaceError);
    await expect(workspace.write('', 'x')).rejects.toThrow();
  });

  it('유니코드 정규화: 한쪽 꼴(NFC)로 만든 파일은 다른 꼴(NFD)로 불러도 파일 시스템이 같게 읽는 만큼만 닿는다', async () => {
    const nfc = '가나.txt';
    const nfd = nfc.normalize('NFD');
    await workspace.write(nfc, 'hangul');
    const direct = await readFile(path.join(root, nfd), 'utf8').then(
      (text) => text,
      () => undefined,
    );
    // 정규화를 같게 보는 볼륨(macOS APFS)은 같은 파일이고, 아니면(리눅스) 없는 파일이다
    if (direct === 'hangul') expect(await workspace.read(nfd)).toBe('hangul');
    else await expect(workspace.read(nfd)).rejects.toThrow('파일이 없습니다');
  });

  it('대소문자만 다른 일반 이름: 구분하는 볼륨이면 다른 파일이고 아니면 같은 파일이다. 같은 파일이면 실제 저장 이름으로 기록한다', async () => {
    if (caseSensitive) {
      await expect(workspace.read('API/src/App.java')).rejects.toThrow('파일이 없습니다');
      await workspace.write('API/src/Other.java', 'x');
      expect(workspace.changedFiles()).toEqual(['API/src/Other.java']);
      expect((await lstat(path.join(root, 'API/src/Other.java'))).isFile()).toBe(true);
    } else {
      expect(await workspace.read('API/src/APP.JAVA')).toBe('class App {}\n');
      await workspace.write('API/SRC/app.java', 'class App { int a; }\n');
      expect(workspace.changedFiles()).toEqual(['api/src/App.java']);
      expect(await readFile(path.join(root, 'api/src/App.java'), 'utf8')).toBe('class App { int a; }\n');
    }
  });
});

describe('읽기 상한과 종류는 읽기 전에 본다', () => {
  it('read: 256KiB는 읽고 256KiB+1은 내용을 읽기 전에 거절한다', async () => {
    await writeFile(path.join(root, 'edge.txt'), 'a'.repeat(256 * 1024));
    expect((await workspace.read('edge.txt')).length).toBe(256 * 1024);
    await writeFile(path.join(root, 'edge.txt'), 'a'.repeat(256 * 1024 + 1));
    await expect(workspace.read('edge.txt')).rejects.toThrow('파일이 너무 큽니다');
  });

  it('readProjectFileSync·readRegularFileBytesSync: 상한 경계, 상위 폴더가 파일이면 없음, 폴더면 일반 파일이 아님', async () => {
    await writeFile(path.join(root, 'edge.bin'), Buffer.alloc(1024, 7));
    expect(readProjectFileSync(root, 'edge.bin', 1024)).toMatchObject({ kind: 'text' });
    expect(readProjectFileSync(root, 'edge.bin', 1023)).toMatchObject({ kind: 'irregular', reason: expect.stringContaining('너무 큽니다') });
    expect(readProjectFileSync(root, 'edge.bin', Number.POSITIVE_INFINITY)).toMatchObject({ kind: 'text' });
    expect(readProjectFileSync(root, 'api/src/App.java/inner')).toEqual({ kind: 'missing' });
    expect(readProjectFileSync(root, 'api/src')).toMatchObject({ kind: 'irregular', reason: '일반 파일이 아닙니다' });
    expect(readRegularFileBytesSync(path.join(root, 'edge.bin'), 1024)).toMatchObject({ kind: 'bytes', complete: true });
    expect(readProjectFileSync(root, 'api/src/../src/App.java')).toMatchObject({ kind: 'text' });
  });

  it('readProjectFileSync: 상위 폴더가 링크면 안쪽을 가리켜도 읽지 않는다', async () => {
    await symlink(path.join(root, 'api'), path.join(root, 'api-link'));
    await symlink(outside, path.join(root, 'out-link'));
    expect(readProjectFileSync(root, 'api-link/src/App.java')).toMatchObject({ kind: 'irregular', reason: '상위 폴더가 심볼릭 링크입니다' });
    expect(readProjectFileSync(root, 'out-link/secret.txt')).toMatchObject({ kind: 'irregular', reason: '상위 폴더가 심볼릭 링크입니다' });
    expect(readProjectFileSync(root, 'out-link')).toMatchObject({ kind: 'irregular', reason: '심볼릭 링크입니다' });
  });
});

describe('목록과 검색', () => {
  it('list: 숨긴 이름·링크를 빼고 이름순으로 돌려주고 깊이를 지킨다', async () => {
    await mkdir(path.join(root, 'b/deep/deeper'), { recursive: true });
    await writeFile(path.join(root, 'b/deep/deeper/z.txt'), 'z');
    await writeFile(path.join(root, 'b/a.txt'), 'a');
    await mkdir(path.join(root, 'node_modules/x'), { recursive: true });
    await writeFile(path.join(root, '.env'), 's');
    await symlink(outside, path.join(root, 'linkdir'));
    const entries = await workspace.list('.', 2);
    expect(entries).toEqual(['api/', 'api/src/', 'b/', 'b/a.txt', 'b/deep/', 'probe-lower']);
    expect(await workspace.list('b', 3)).toEqual(['b/a.txt', 'b/deep/', 'b/deep/deeper/', 'b/deep/deeper/z.txt']);
    await expect(workspace.list('swap-none')).rejects.toThrow('파일이 없습니다');
  });

  it('list: 항목 상한(500)에서 멈춘다', async () => {
    await mkdir(path.join(root, 'many'), { recursive: true });
    for (let index = 0; index < 520; index += 1) await writeFile(path.join(root, 'many', `f${String(index).padStart(4, '0')}.txt`), '');
    expect((await workspace.list('many', 1)).length).toBe(500);
  });

  it('search: 링크·큰 파일·이진 파일·숨긴 폴더를 건너뛰고 가린 글에서 찾는다', async () => {
    await writeFile(path.join(root, 'api/src/Needle.java'), 'int a;\nString needle = "hit";\n');
    await writeFile(path.join(root, 'big.txt'), `needle${'x'.repeat(256 * 1024)}`);
    await writeFile(path.join(root, 'bin.dat'), Buffer.from('needle\0binary'));
    await mkdir(path.join(root, 'node_modules/pkg'), { recursive: true });
    await writeFile(path.join(root, 'node_modules/pkg/i.js'), 'needle');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'linked.txt'));
    await writeFile(path.join(outside, 'secret.txt'), 'needle outside');
    const result = await workspace.search(['needle']);
    expect(result.matches).toEqual([{ file: 'api/src/Needle.java', line: 2, text: 'String needle = "hit";' }]);
    const redacted = await workspace.search(['needle'], '.', { redact: (text) => text.replaceAll('needle', 'N') });
    expect(redacted.matches).toEqual([]);
  });
});

describe('쓰기·지우기', () => {
  it('write: 기존 파일을 짧게 덮어쓰면 꼬리가 남지 않고, 새 파일은 부모 폴더까지 만들며, 바이너리도 쓴다', async () => {
    await workspace.write('api/src/App.java', 'x');
    expect(await readFile(path.join(root, 'api/src/App.java'), 'utf8')).toBe('x');
    await workspace.write('a/b/c/d.txt', 'deep');
    expect(await readFile(path.join(root, 'a/b/c/d.txt'), 'utf8')).toBe('deep');
    await workspace.writeBinary('img/p.png', Buffer.from([0x89, 0x50, 0xff, 0x00]));
    expect([...(await readFile(path.join(root, 'img/p.png')))]).toEqual([0x89, 0x50, 0xff, 0x00]);
    await workspace.write('empty.txt', '');
    expect((await lstat(path.join(root, 'empty.txt'))).size).toBe(0);
  });

  it('write: 부모 자리에 파일이 있으면 던지고 그 파일은 그대로다', async () => {
    await expect(workspace.write('api/src/App.java/inner.txt', 'x')).rejects.toThrow();
    expect(await readFile(path.join(root, 'api/src/App.java'), 'utf8')).toBe('class App {}\n');
  });

  it('write: 폴더 자리에는 쓰지 못한다', async () => {
    await expect(workspace.write('api/src', 'x')).rejects.toThrow();
    expect((await lstat(path.join(root, 'api/src'))).isDirectory()).toBe(true);
  });

  it('remove: 일반 파일만 지운다. 폴더는 지우지 못하고 안의 파일도 그대로다', async () => {
    await expect(workspace.remove('api/src')).rejects.toThrow();
    expect(await readFile(path.join(root, 'api/src/App.java'), 'utf8')).toBe('class App {}\n');
    await workspace.remove('api/src/App.java');
    await expect(lstat(path.join(root, 'api/src/App.java'))).rejects.toThrow();
    expect(workspace.deletedFiles()).toEqual(['api/src/App.java']);
  });

  it('remove: 링크는 따라가지 않는다. 링크를 가리킨 요청은 거절하고 링크 너머의 파일과 폴더가 모두 남는다', async () => {
    await mkdir(path.join(outside, 'dir'), { recursive: true });
    await writeFile(path.join(outside, 'dir/keep.txt'), 'keep');
    await symlink(path.join(outside, 'dir'), path.join(root, 'dir-link'));
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'file-link'));
    await expect(workspace.remove('dir-link')).rejects.toThrow('링크');
    await expect(workspace.remove('file-link')).rejects.toThrow('링크');
    await expect(workspace.remove('dir-link/keep.txt')).rejects.toThrow('링크');
    expect(await readFile(path.join(outside, 'dir/keep.txt'), 'utf8')).toBe('keep');
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside secret');
    expect((await lstat(path.join(root, 'dir-link'))).isSymbolicLink()).toBe(true);
    expect((await lstat(path.join(root, 'file-link'))).isSymbolicLink()).toBe(true);
  });
});

describe('보호 경로 고정(pinBeforeWrite)과 비교(restoredProtectedFiles)', () => {
  const guarded = (): Workspace => {
    const ws = new Workspace(root);
    ws.watchProtectedPaths(['guard.txt', 'rules']);
    return ws;
  };

  it('쓰고 원래대로 되돌린 파일만 같다고 하고, 한 바이트라도 다르면 바뀐 것이다', async () => {
    await writeFile(path.join(root, 'guard.txt'), 'original');
    const ws = guarded();
    await ws.pinBeforeWrite('guard.txt');
    await ws.write('guard.txt', 'tampered');
    expect(ws.restoredProtectedFiles(['guard.txt'])).toEqual([]);
    await ws.write('guard.txt', 'original');
    expect(ws.restoredProtectedFiles(['guard.txt'])).toEqual(['guard.txt']);
    await ws.write('guard.txt', 'original\n');
    expect(ws.restoredProtectedFiles(['guard.txt'])).toEqual([]);
  });

  it('고정값은 처음 쓰기 직전 것 하나다: 두 번째 쓰기가 바뀐 내용을 고정값으로 삼지 못한다', async () => {
    await writeFile(path.join(root, 'guard.txt'), 'original');
    const ws = guarded();
    await ws.write('guard.txt', 'first');
    await ws.write('guard.txt', 'second');
    await ws.write('guard.txt', 'second');
    expect(ws.restoredProtectedFiles(['guard.txt'])).toEqual([]);
    await ws.write('guard.txt', 'original');
    expect(ws.restoredProtectedFiles(['guard.txt'])).toEqual(['guard.txt']);
  });

  it('보호 경로가 아닌 파일, 이미 바뀐 목록에 있던 파일은 고정하지 않는다', async () => {
    await writeFile(path.join(root, 'plain.txt'), 'original');
    await writeFile(path.join(root, 'guard.txt'), 'original');
    const ws = guarded();
    await ws.write('plain.txt', 'changed');
    await ws.write('plain.txt', 'original');
    expect(ws.restoredProtectedFiles(['plain.txt'])).toEqual([]);
    ws.trackExternalChanges(['guard.txt']);
    await ws.write('guard.txt', 'changed');
    await ws.write('guard.txt', 'original');
    expect(ws.restoredProtectedFiles(['guard.txt'])).toEqual([]);
  });

  it('없던 파일은 쓴 뒤 지우면 같고, 지우지 않았으면 다르다', async () => {
    const ws = guarded();
    await ws.write('guard.txt', 'new');
    expect(ws.restoredProtectedFiles(['guard.txt'])).toEqual([]);
    await ws.remove('guard.txt');
    expect(ws.restoredProtectedFiles(['guard.txt'])).toEqual(['guard.txt']);
  });

  it('1MiB 경계: 1MiB는 고정하고 1MiB+1은 고정하지 못해 되돌려도 같다고 하지 않는다', async () => {
    const limit = 1024 * 1024;
    await writeFile(path.join(root, 'rules'), Buffer.alloc(limit, 1));
    await writeFile(path.join(root, 'guard.txt'), Buffer.alloc(limit + 1, 2));
    const ws = guarded();
    await ws.pinBeforeWrite('rules');
    await ws.pinBeforeWrite('guard.txt');
    await ws.write('rules', 'x');
    await ws.write('guard.txt', 'x');
    await ws.writeBinary('rules', Buffer.alloc(limit, 1));
    await ws.writeBinary('guard.txt', Buffer.alloc(limit + 1, 2));
    expect(ws.restoredProtectedFiles(['rules', 'guard.txt'])).toEqual(['rules']);
  });

  it('링크인 경로는 고정하지 않고, 지금 내용을 읽을 때도 링크를 따라가지 않는다', async () => {
    await writeFile(path.join(outside, 'target.txt'), 'same');
    await writeFile(path.join(root, 'guard.txt'), 'same');
    const ws = guarded();
    await ws.pinBeforeWrite('guard.txt');
    // 쓰는 동안 일반 파일을 같은 내용을 가리키는 링크로 바꿔 놓는다
    await rm(path.join(root, 'guard.txt'));
    await symlink(path.join(outside, 'target.txt'), path.join(root, 'guard.txt'));
    expect(ws.restoredProtectedFiles(['guard.txt'])).toEqual([]);
    // 고정 시점에 이미 링크였던 파일은 고정하지 못한다
    await rm(path.join(root, 'rules'), { force: true });
    await symlink(path.join(outside, 'target.txt'), path.join(root, 'rules'));
    await ws.pinBeforeWrite('rules');
    await rm(path.join(root, 'rules'));
    await writeFile(path.join(root, 'rules'), 'same');
    expect(ws.restoredProtectedFiles(['rules'])).toEqual([]);
  });

  it('읽지 못한 파일은 고정하지 못한다(읽기 실패는 고정하지 않음)', async () => {
    if (process.getuid?.() === 0) return;
    await writeFile(path.join(root, 'guard.txt'), 'original');
    const ws = guarded();
    await chmod(path.join(root, 'guard.txt'), 0o000);
    await ws.pinBeforeWrite('guard.txt');
    await chmod(path.join(root, 'guard.txt'), 0o644);
    expect(ws.restoredProtectedFiles(['guard.txt'])).toEqual([]);
  });

  it('보호 경로 규칙이 비면 아무것도 고정하지 않고, 경로를 풀지 못하는 파일도 던지지 않는다', async () => {
    const ws = new Workspace(root);
    await ws.pinBeforeWrite('guard.txt');
    ws.watchProtectedPaths(['guard.txt']);
    await expect(ws.pinBeforeWrite('../outside')).resolves.toBeUndefined();
    await expect(ws.pinBeforeWrite('.env')).resolves.toBeUndefined();
    expect(ws.restoredProtectedFiles(['guard.txt', '../outside'])).toEqual([]);
  });

  it('도구 밖 변경을 옮기지 못하면 고정하지 않는다', async () => {
    await writeFile(path.join(root, 'guard.txt'), 'original');
    const ws = guarded();
    ws.useOutsideSync(async () => {
      throw new Error('sync failed');
    });
    await ws.write('guard.txt', 'changed');
    await ws.write('guard.txt', 'original');
    expect(ws.restoredProtectedFiles(['guard.txt'])).toEqual([]);
  });
});

describe('ChangeTracker 기본 지문', () => {
  it('일반 파일은 내용의 sha256, 링크는 가리키는 곳, 폴더는 other, 없는 파일은 missing이다. 링크를 따라가 읽지 않는다', async () => {
    const content = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    await writeFile(path.join(root, 'bin.dat'), content);
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    await mkdir(path.join(root, 'sub'), { recursive: true });
    await writeFile(path.join(root, '.env'), 'KEY=1');
    const pending = ['bin.dat', 'link.txt', 'sub', 'gone.txt', '.env', 'api/src/App.java'];
    const tracker = new ChangeTracker(workspace, async () => pending, { tolerateExisting: false });
    const result = await tracker.sync();
    expect(result.rejected).toEqual(['.env', 'link.txt']);
    expect(tracker.tracked.get('bin.dat')).toBe(`file:${sha(content)}`);
    expect(tracker.tracked.get('api/src/App.java')).toBe(`file:${sha('class App {}\n')}`);
    // 폴더 이름('sub')과 없는 파일('gone.txt')은 지문이 other·missing이지만 게이트가 다루는 경로라 알린다
    expect(tracker.tracked.get('gone.txt')).toBe('missing');
    expect(tracker.tracked.get('sub')).toMatch(/^other:\d+$/);
  });

  it('큰 파일도 내용 전체의 해시로 지문을 만든다', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 9);
    await writeFile(path.join(root, 'big.bin'), big);
    const tracker = new ChangeTracker(workspace, async () => ['big.bin']);
    await tracker.sync();
    expect(tracker.tracked.get('big.bin')).toBe(`file:${sha(big)}`);
    await truncate(path.join(root, 'big.bin'), 0);
    await tracker.sync();
    expect(tracker.tracked.get('big.bin')).toBe(`file:${sha('')}`);
  });
});
