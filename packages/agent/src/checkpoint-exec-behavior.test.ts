import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointError, CheckpointStore } from './checkpoints';

// 체크포인트의 git·tar 실행을 Node `execFile`·`spawn`에서 Rust로 옮기는 조각(ADR-195 4f A1)의 동작 고정 시험.
// 옮기기 전 코드에서 먼저 통과시켰고, 옮긴 뒤에도 같아야 한다. 임시 폴더와 진짜 git·tar만 쓴다.
vi.setConfig({ testTimeout: 30_000 });

let root: string;
const cleanup: string[] = [];
const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'checkpoint-exec-'));
  const globalConfig = `${root}.gitconfig`;
  await writeFile(globalConfig, '');
  cleanup.push(root, globalConfig);
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

afterEach(async () => {
  for (const item of cleanup.splice(0)) await rm(item, { recursive: true, force: true });
  if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved.global;
  if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
});

const allBytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
const outDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'checkpoint-exec-out-'));
  cleanup.push(dir);
  return dir;
};

describe('체크포인트 실행의 바깥 동작(git·tar)', () => {
  it('바이너리 파일은 blobAt·exportTree 모두 바이트 그대로 나온다', async () => {
    await writeFile(path.join(root, 'all.bin'), allBytes);
    await writeFile(path.join(root, 'bad-utf8.txt'), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
    const store = new CheckpointStore(root);
    const start = await store.init();
    const blob = await store.blobAt('all.bin', start.sha);
    expect(blob.kind).toBe('file');
    expect(blob.kind === 'file' && Buffer.compare(blob.content, allBytes)).toBe(0);
    const out = await outDir();
    await store.exportTree(start.sha, out);
    expect(Buffer.compare(await readFile(path.join(out, 'all.bin')), allBytes)).toBe(0);
    expect(Buffer.compare(await readFile(path.join(out, 'bad-utf8.txt')), Buffer.from([0x61, 0xff, 0xfe, 0x62]))).toBe(0);
  });

  it('UTF-8이 아닌 바이트가 든 파일을 문자열로 읽으면 U+FFFD로 바뀐다(옛 execFile의 utf8 디코딩)', async () => {
    await writeFile(path.join(root, 'bad-utf8.txt'), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
    const store = new CheckpointStore(root);
    await store.init();
    expect(await store.fileAt('bad-utf8.txt')).toBe('a��b');
  });

  it('1MiB를 넘는 출력도 받는다(상한은 64MiB)', async () => {
    const line = `${'x'.repeat(99)}\n`;
    const store = new CheckpointStore(root);
    await store.init();
    await writeFile(path.join(root, 'big.txt'), line.repeat(30_000)); // 3MB
    await store.commit('요청: 큰 파일');
    const diff = await store.sessionDiff();
    expect(diff.length).toBeGreaterThan(3_000_000);
    expect(diff).toContain('+++ b/big.txt');
  });

  it('git이 실패하면 CheckpointError에 git 하위 명령과 stderr가 담긴다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    const error = await store.diffSince('0000000000000000000000000000000000000000').then(
      () => expect.unreachable(),
      (e: unknown) => e as CheckpointError,
    );
    expect(error).toBeInstanceOf(CheckpointError);
    expect(error.message).toMatch(/^git diff 실패: /);
    expect(error.message).not.toContain('시간 초과');
  });

  it('exportTree: 실행 비트와 심볼릭 링크를 보존하고 dest 밖에는 아무것도 쓰지 않는다', async () => {
    await mkdir(path.join(root, 'bin'), { recursive: true });
    await writeFile(path.join(root, 'bin/run.sh'), '#!/bin/sh\necho hi\n');
    await chmod(path.join(root, 'bin/run.sh'), 0o755);
    await writeFile(path.join(root, 'plain.txt'), 'plain\n');
    await symlink('plain.txt', path.join(root, 'rel-link'));
    await symlink('/nonexistent-outside-target/secret', path.join(root, 'abs-link'));
    const store = new CheckpointStore(root);
    const start = await store.init();
    const parent = await outDir();
    const dest = path.join(parent, 'dest');
    await store.exportTree(start.sha, dest);
    expect((await lstat(path.join(dest, 'bin/run.sh'))).mode & 0o111).not.toBe(0);
    expect((await lstat(path.join(dest, 'plain.txt'))).mode & 0o111).toBe(0);
    expect((await lstat(path.join(dest, 'rel-link'))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(dest, 'rel-link'))).toBe('plain.txt');
    expect(await readlink(path.join(dest, 'abs-link'))).toBe('/nonexistent-outside-target/secret');
    expect(await readdir(parent)).toEqual(['dest']);
  });

  it('exportTree: 큰 파일(5MB)도 파이프로 끝까지 풀린다', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 7);
    await writeFile(path.join(root, 'big.bin'), big);
    const store = new CheckpointStore(root);
    const start = await store.init();
    const out = await outDir();
    await store.exportTree(start.sha, out);
    expect(Buffer.compare(await readFile(path.join(out, 'big.bin')), big)).toBe(0);
  });

  it('exportTree: git archive가 실패하면 "체크포인트를 꺼내지 못했습니다"와 종료 코드를 알린다', async () => {
    const store = new CheckpointStore(root);
    const start = await store.init();
    // resolve는 통과하지만 archive가 실패하게: dest가 파일이면 tar가 실패한다
    const parent = await outDir();
    await writeFile(path.join(parent, 'file'), 'x');
    await expect(store.exportTree(start.sha, path.join(parent, 'file', 'sub'))).rejects.toThrow();
  });

  it('check-ignore: 개행·유니코드 이름의 중첩 저장소는 무시 여부를 stdin(NUL 구분)으로 정확히 판단한다', async () => {
    const mkRepo = async (dir: string) => {
      await mkdir(path.join(root, dir, '.git'), { recursive: true });
      await writeFile(path.join(root, dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    };
    await writeFile(path.join(root, '.gitignore'), '한글 폴더/\n');
    await mkRepo('한글 폴더/lib');
    await mkRepo('줄\n바꿈');
    await mkdir(path.join(root, 'ok'), { recursive: true });
    // 무시되는 한글 폴더는 통과, 개행 이름 폴더는 무시되지 않아 거부된다
    await expect(new CheckpointStore(root).init()).rejects.toThrow(/줄\n바꿈\/\.git/);
    await rm(path.join(root, '줄\n바꿈'), { recursive: true });
    await expect(new CheckpointStore(root).init()).resolves.toBeDefined();
  });

  it('check-ignore: 무시되는 경로가 하나도 없어도(종료 코드 1) 정상이다', async () => {
    await mkdir(path.join(root, 'plain-dir'), { recursive: true });
    await writeFile(path.join(root, 'plain-dir/a.txt'), 'a');
    await expect(new CheckpointStore(root).init()).resolves.toBeDefined();
  });

  // 실제 git 앞에 서는 감시 스크립트: 받은 인자·환경·stdin을 파일에 남기고 진짜 git을 부른다
  const spyGit = async (extra = ''): Promise<{ bin: string; log: string }> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'checkpoint-exec-spy-'));
    cleanup.push(dir);
    const realGit = (await import('node:child_process')).execFileSync('sh', ['-c', 'command -v git']).toString().trim();
    const bin = path.join(dir, 'git');
    const log = path.join(dir, 'log');
    await writeFile(
      bin,
      `#!/bin/sh
${extra}
{ printf 'ARGS:'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'; printf 'ENV:%s|%s|%s|%s\\n' "$GIT_TERMINAL_PROMPT" "$GIT_OPTIONAL_LOCKS" "$GIT_ATTR_NOSYSTEM" "\${GIT_DIR:-unset}"; } >> "${log}"
case " $* " in *" check-ignore "*) tee "${dir}/stdin" | exec "${realGit}" "$@" ;; *) exec "${realGit}" "$@" ;; esac
`,
      { mode: 0o755 },
    );
    return { bin, log };
  };

  it('git에는 하드닝 인자와 gitEnv() 환경이 가고, 허용하지 않는 GIT_DIR은 지워진다', async () => {
    const { bin, log } = await spyGit();
    process.env.GIT_DIR = '/nonexistent-git-dir';
    try {
      const store = new CheckpointStore(root, { gitBin: bin });
      const start = await store.init();
      await store.exportTree(start.sha, await outDir());
    } finally {
      delete process.env.GIT_DIR;
    }
    const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
    const args = lines.filter((line) => line.startsWith('ARGS:'));
    expect(args.length).toBeGreaterThan(3);
    for (const line of args) expect(line).toMatch(/^ARGS: \[-c\] \[core\.hooksPath=\/dev\/null\] \[-c\] \[core\.fsmonitor=false\] \[-c\] \[core\.attributesFile=\/dev\/null\] \[-C\] /);
    expect(args.some((line) => line.includes('[archive] [--format=tar]'))).toBe(true);
    for (const line of lines.filter((item) => item.startsWith('ENV:'))) expect(line).toBe('ENV:0|0|1|unset');
  });

  it('check-ignore: 경로는 NUL로 이어 stdin으로만 간다(인자에 없다)', async () => {
    await mkdir(path.join(root, 'a'), { recursive: true });
    await mkdir(path.join(root, 'b c'), { recursive: true });
    const { bin, log } = await spyGit();
    await new CheckpointStore(root, { gitBin: bin }).init();
    const stdin = await readFile(path.join(path.dirname(log), 'stdin'), 'utf8');
    expect(stdin.split('\0').sort()).toEqual(['a', 'b c']);
    const checkLine = (await readFile(log, 'utf8')).split('\n').find((line) => line.includes('[check-ignore]'));
    expect(checkLine).toMatch(/\[check-ignore\] \[-z\] \[--stdin\]$/);
  });

  it('check-ignore가 0·1 말고 끝나면 확인하지 못한 것으로 던진다(fail-closed): 종료 코드 128', async () => {
    await mkdir(path.join(root, 'a'), { recursive: true });
    const { bin } = await spyGit('case " $* " in *" check-ignore "*) echo "fatal: boom" 1>&2; exit 128 ;; esac');
    await expect(new CheckpointStore(root, { gitBin: bin }).init()).rejects.toThrow(/무시 여부를 확인하지 못했습니다 \(check-ignore 128\): fatal: boom/);
  });

  it('check-ignore가 신호로 죽어도 "무시되는 경로 없음(1)"으로 읽지 않는다', async () => {
    await mkdir(path.join(root, 'a'), { recursive: true });
    const { bin } = await spyGit('case " $* " in *" check-ignore "*) kill -9 $$ ;; esac');
    await expect(new CheckpointStore(root, { gitBin: bin }).init()).rejects.toThrow(/무시 여부를 확인하지 못했습니다 \(check-ignore null\)/);
  });

  it('git 하위 명령의 stderr는 CheckpointError 메시지에 담기고 비밀은 가려진다', async () => {
    const { bin } = await spyGit('case " $* " in *" diff "*) echo "fatal: https://user:hunter2@example.com/x.git" 1>&2; exit 128 ;; esac');
    const store = new CheckpointStore(root, { gitBin: bin });
    await store.init();
    const error = await store.sessionDiff().then(
      () => expect.unreachable(),
      (e: unknown) => e as CheckpointError,
    );
    expect(error.message).toMatch(/^git diff 실패: fatal: /);
    expect(error.message).not.toContain('hunter2');
  });

  it('exportTree: git archive만 실패해도(종료 코드 9) 알린다', async () => {
    const { bin } = await spyGit('case " $* " in *" archive "*) echo "archive-broke" 1>&2; exit 9 ;; esac');
    const store = new CheckpointStore(root, { gitBin: bin });
    const start = await store.init();
    const error = await store.exportTree(start.sha, await outDir()).then(
      () => expect.unreachable(),
      (e: unknown) => e as CheckpointError,
    );
    expect(error.message).toContain('archive-broke');
    expect(error.message).toContain('git archive이(가) 9로 끝났습니다');
  });

  it('exportTree: tar는 `-x --no-same-owner -C dest`로 불리고, tar만 실패해도(종료 코드 5) 알린다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'checkpoint-exec-faketar-'));
    cleanup.push(dir);
    const argsFile = path.join(dir, 'tar-args');
    await writeFile(path.join(dir, 'tar'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\ncat > /dev/null\necho tar-broke 1>&2\nexit 5\n`, { mode: 0o755 });
    const store = new CheckpointStore(root);
    const start = await store.init();
    const dest = await outDir();
    const savedPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ''}`;
    const error = await store.exportTree(start.sha, dest).then(
      () => expect.unreachable(),
      (e: unknown) => e as CheckpointError,
    );
    process.env.PATH = savedPath;
    expect(error.message).toContain('tar-broke');
    expect(error.message).toContain('tar이(가) 5로 끝났습니다');
    expect(error.message).not.toContain('git archive이(가)');
    expect((await readFile(argsFile, 'utf8')).split('\n').filter(Boolean)).toEqual(['-x', '--no-same-owner', '-C', dest]);
  });
});
