import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execBytes, ExecBytesError } from './exec-bytes';

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
