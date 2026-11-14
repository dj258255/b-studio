import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installNative } from './install-native.mjs';

// #1214: macOS는 서명된 Mach-O의 코드 서명을 vnode 단위로 캐시한다. 같은 inode의 내용을 바꾸면 그 파일을 다시 매핑하는 프로세스가
// SIGKILL로 죽는다. 그래서 다시 둘 때는 새 파일(새 inode)로 바꿔 넣어야 하고, 이미 불러온 프로세스는 옛 inode를 계속 쓴다
describe('installNative', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'install-native-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('이미 있는 모듈을 같은 inode에 덮어쓰지 않고 새 파일로 바꿔 넣는다', () => {
    const source = path.join(dir, 'built.dylib');
    const out = path.join(dir, 'out', 'bstudio_node.node');
    rmSync(path.dirname(out), { recursive: true, force: true });
    writeFileSync(source, 'first');
    mkdirSync(path.dirname(out));
    installNative(source, out);
    const before = statSync(out).ino;
    writeFileSync(source, 'second');
    installNative(source, out);
    expect(readFileSync(out, 'utf8')).toBe('second');
    expect(statSync(out).ino).not.toBe(before);
    // 임시 파일을 남기지 않는다
    expect(readdirSync(path.dirname(out))).toEqual(['bstudio_node.node']);
  });

  it('대상이 심볼릭 링크면 링크 너머에 쓰지 않고 링크 자리에 파일을 둔다', () => {
    const source = path.join(dir, 'built.dylib');
    const elsewhere = path.join(dir, 'elsewhere.node');
    const out = path.join(dir, 'bstudio_node.node');
    writeFileSync(source, 'new');
    writeFileSync(elsewhere, 'keep');
    symlinkSync(elsewhere, out);
    installNative(source, out);
    expect(lstatSync(out).isSymbolicLink()).toBe(false);
    expect(readFileSync(out, 'utf8')).toBe('new');
    expect(readFileSync(elsewhere, 'utf8')).toBe('keep');
  });

  it('처음 둘 때도 동작한다', () => {
    const source = path.join(dir, 'built.dylib');
    const out = path.join(dir, 'bstudio_node.node');
    writeFileSync(source, 'only');
    installNative(source, out);
    expect(readFileSync(out, 'utf8')).toBe('only');
  });
});
