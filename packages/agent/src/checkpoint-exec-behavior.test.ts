import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

describe('체크포인트 실행의 바깥 동작(git·tar)', () => {
  it('바이너리 파일은 blobAt이 바이트 그대로 돌려준다', async () => {
    await writeFile(path.join(root, 'all.bin'), allBytes);
    await writeFile(path.join(root, 'bad-utf8.txt'), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
    const store = new CheckpointStore(root);
    const start = await store.init();
    const blob = await store.blobAt('all.bin', start.sha);
    expect(blob.kind).toBe('file');
    expect(blob.kind === 'file' && Buffer.compare(blob.content, allBytes)).toBe(0);
    const bad = await store.blobAt('bad-utf8.txt', start.sha);
    expect(bad.kind === 'file' && Buffer.compare(bad.content, Buffer.from([0x61, 0xff, 0xfe, 0x62]))).toBe(0);
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
      await store.blobAt('plain.txt', start.sha);
    } finally {
      delete process.env.GIT_DIR;
    }
    const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
    const args = lines.filter((line) => line.startsWith('ARGS:'));
    expect(args.length).toBeGreaterThan(3);
    for (const line of args) expect(line).toMatch(/^ARGS: \[-c\] \[core\.hooksPath=\/dev\/null\] \[-c\] \[core\.fsmonitor=false\] \[-c\] \[core\.attributesFile=\/dev\/null\] \[-C\] /);
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
});
