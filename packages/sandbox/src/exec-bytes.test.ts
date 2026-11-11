import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execArchiveExtract, execBytes, ExecBytesError } from './exec-bytes';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const tmp = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'exec-bytes-'));
  dirs.push(dir);
  return dir;
};
const fail = async (promise: Promise<unknown>): Promise<ExecBytesError> => promise.then(() => expect.unreachable(), (error: unknown) => error as ExecBytesError);

describe('execBytes', () => {
  it('stdout·stderr를 바이트 그대로 받는다(UTF-8이 아닌 바이트, NUL 포함)', async () => {
    const result = await execBytes('sh', ['-c', "printf '\\377\\000\\376a' ; printf '\\200' 1>&2"]);
    expect([...result.stdout]).toEqual([0xff, 0x00, 0xfe, 0x61]);
    expect([...result.stderr]).toEqual([0x80]);
  });

  it('stdin 바이트(NUL 구분)를 그대로 넣고, 입력이 없으면 stdin을 닫는다', async () => {
    const piped = await execBytes('cat', [], { input: Buffer.from('a\0b\0한글') });
    expect(piped.stdout.equals(Buffer.from('a\0b\0한글'))).toBe(true);
    expect((await execBytes('cat', [])).stdout.length).toBe(0);
  });

  it('비0 종료는 code·stdout·stderr를 가진 오류로 던진다', async () => {
    const error = await fail(execBytes('sh', ['-c', 'printf out; printf err 1>&2; exit 3']));
    expect(error).toBeInstanceOf(ExecBytesError);
    expect(error.code).toBe(3);
    expect(error.killed).toBe(false);
    expect(error.stdout.toString()).toBe('out');
    expect(error.stderr.toString()).toBe('err');
  });

  it('신호로 죽으면 code는 null이다(1로 접지 않는다)', async () => {
    const error = await fail(execBytes('sh', ['-c', 'kill -9 $$']));
    expect(error.code).toBeNull();
    expect(error.killed).toBe(false);
  });

  it('시간 초과는 killed: true이고 SIGTERM을 먼저 받는다', async () => {
    const dir = await tmp();
    const marker = path.join(dir, 'got-term');
    const error = await fail(execBytes('sh', ['-c', `trap 'echo term > "$1"; exit 0' TERM; echo started; while :; do sleep 0.05; done`, 'sh', marker], { timeoutMs: 400 }));
    expect(error.killed).toBe(true);
    expect(error.code).toBeNull();
    expect(error.stdout.toString()).toContain('started');
    expect(await readFile(marker, 'utf8')).toBe('term\n');
  });

  it('출력이 maxBuffer를 넘으면 읽는 중에 멈추고 killed 없이 ERR_CHILD_PROCESS_STDIO_MAXBUFFER로 던진다', async () => {
    const started = Date.now();
    const error = await fail(execBytes('sh', ['-c', 'yes | head -c 50000000'], { maxBuffer: 1000 }));
    expect(error.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    expect(error.killed).toBe(false);
    expect(error.stdout.length).toBeLessThanOrEqual(1001);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('maxBuffer와 같은 길이의 출력은 통과한다', async () => {
    const result = await execBytes('sh', ['-c', 'head -c 1000 /dev/zero'], { maxBuffer: 1000 });
    expect(result.stdout.length).toBe(1000);
  });

  it('없는 실행 파일은 ENOENT와 spawn 문구를 담아 던진다', async () => {
    const error = await fail(execBytes('definitely-not-a-binary-xyz', []));
    expect(error.code).toBe('ENOENT');
    expect(error.stderr.toString()).toBe('spawn definitely-not-a-binary-xyz ENOENT');
  });

  it('env는 상속 없이 통째로 바꾸고 cwd에서 돈다', async () => {
    process.env.EXEC_BYTES_PARENT = 'leak';
    const dir = await tmp();
    const result = await execBytes('sh', ['-c', 'printf "%s:%s:%s" "${EXEC_BYTES_PARENT:-none}" "$CHILD" "$(pwd -P)"'], { env: { CHILD: 'set', PATH: process.env.PATH }, cwd: dir });
    delete process.env.EXEC_BYTES_PARENT;
    expect(result.stdout.toString()).toMatch(/^none:set:.*exec-bytes-/);
  });

  it('AbortSignal로 취소하면 던진다', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const error = await fail(execBytes('sleep', ['30'], { signal: controller.signal }));
    expect(error.killed).toBe(true);
  });
});

describe('execArchiveExtract', () => {
  it('git 출력을 tar로 이어 dest에 푼다. 종료 코드는 둘 다 0이다', async () => {
    const dir = await tmp();
    const dest = path.join(dir, 'dest');
    // git 대신 tar c를 쓰는 대체 실행 파일: 인자를 그대로 받는 sh 스크립트
    const fake = path.join(dir, 'fake-git');
    await writeFile(fake, `#!/bin/sh\ncd "${dir}" && printf hello > payload && tar -c payload\n`, { mode: 0o755 });
    await mkdir(dest);
    const outcome = await execArchiveExtract(fake, [], { PATH: process.env.PATH }, dest);
    expect(outcome).toEqual({ gitCode: 0, tarCode: 0, stderr: '', spawnError: null });
    expect(await readFile(path.join(dest, 'payload'), 'utf8')).toBe('hello');
  });

  it('git이 실패하면 gitCode와 stderr를 돌려준다', async () => {
    const dir = await tmp();
    const outcome = await execArchiveExtract('sh', ['-c', 'echo boom 1>&2; exit 9'], { PATH: process.env.PATH }, dir);
    expect(outcome.gitCode).toBe(9);
    expect(outcome.stderr).toContain('boom');
  });

  it('git을 띄우지 못하면 spawnError', async () => {
    const outcome = await execArchiveExtract('definitely-not-a-binary-xyz', [], {}, tmpdir());
    expect(outcome.spawnError).toBe('spawn definitely-not-a-binary-xyz ENOENT');
  });
});

/** ustar 항목 하나(헤더 512바이트 + 내용을 512 배수로 채움) */
function tarEntry(name: string, type: '0' | '1' | '2', content = '', linkName = ''): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write(linkName, 157, 100, 'utf8');
  header.write('ustar\0', 257);
  header.write('00', 263);
  const sum = [...header].reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const body = Buffer.from(content);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

describe('execArchiveExtract: 적대적 항목', () => {
  // 가짜 git이 아래 항목으로 만든 tar를 낸다. 지금(옛 `tar -x --no-same-owner`)과 같은 tar가 해제하므로 같은 결과여야 한다.
  // 파일 시스템 종류에 기대지 않도록 "dest 밖에 아무것도 쓰이지 않았다"만 확인한다
  const extract = async (entries: Buffer[]) => {
    const dir = await tmp();
    const dest = path.join(dir, 'box', 'dest');
    await mkdir(dest, { recursive: true });
    const tarFile = path.join(dir, 'in.tar');
    await writeFile(tarFile, Buffer.concat([...entries, Buffer.alloc(1024)]));
    const outcome = await execArchiveExtract('cat', [tarFile], { PATH: process.env.PATH }, dest);
    return { dir, dest, outcome };
  };

  it('`..` 항목과 절대 경로 항목은 dest 밖에 쓰지 않는다', async () => {
    const outside = `/tmp/exec-bytes-abs-${process.pid}`;
    const { dir } = await extract([tarEntry('../escape.txt', '0', 'bad'), tarEntry('sub/../../escape2.txt', '0', 'bad'), tarEntry(outside, '0', 'bad'), tarEntry('ok.txt', '0', 'fine')]);
    expect(await readdir(path.join(dir, 'box'))).toEqual(['dest']);
    await expect(readFile(outside)).rejects.toThrow();
    await rm(outside, { force: true });
  });

  it('dest 밖을 가리키는 링크를 지나 쓰는 항목은 밖에 쓰지 않는다(링크 먼저, 그 아래 파일)', async () => {
    const { dir } = await extract([tarEntry('link', '2', '', '..'), tarEntry('link/through.txt', '0', 'bad')]);
    expect(await readdir(path.join(dir, 'box'))).toEqual(['dest']);
  });

  it('dest 밖을 가리키는 하드링크는 밖의 파일을 끌어오지 않는다', async () => {
    const dir = await tmp();
    const secret = path.join(dir, 'secret.txt');
    await writeFile(secret, 'secret');
    const { dest } = await extract([tarEntry('hard', '1', '', secret)]);
    await expect(readFile(path.join(dest, 'hard'), 'utf8')).rejects.toThrow();
  });
});
