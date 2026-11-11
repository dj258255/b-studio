import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { execChecked, ExecCheckedError } from './exec-checked';

describe('execChecked', () => {
  it('0으로 끝나면 stdout·stderr를 돌려준다', async () => {
    expect(await execChecked('sh', ['-c', 'printf out; printf err 1>&2'])).toEqual({ stdout: 'out', stderr: 'err' });
  });

  it('비0 종료는 코드와 출력을 담아 던진다', async () => {
    const error = await execChecked('sh', ['-c', 'printf o; printf oops 1>&2; exit 7']).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExecCheckedError);
    expect(error).toMatchObject({ code: 7, stdout: 'o', stderr: 'oops' });
    expect((error as Error).message).toContain('oops');
  });

  it('없는 실행 파일은 던진다', async () => {
    await expect(execChecked('definitely-not-a-real-binary-xyz', [])).rejects.toThrow(ExecCheckedError);
  });

  it('시간 초과는 자식을 죽이고 던진다', async () => {
    const started = Date.now();
    await expect(execChecked('sh', ['-c', 'sleep 30'], { timeoutMs: 150 })).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('호출자의 signal로 취소해도 던진다', async () => {
    const controller = new AbortController();
    const promise = execChecked('sh', ['-c', 'sleep 30'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(promise).rejects.toMatchObject({ code: 'ABORT_ERR' });
  });

  it('출력이 maxBuffer를 넘으면 0으로 끝나도 던진다', async () => {
    await expect(execChecked('sh', ['-c', 'head -c 2000 /dev/zero | tr "\\0" x'], { maxBuffer: 1000 })).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    expect((await execChecked('sh', ['-c', 'head -c 900 /dev/zero | tr "\\0" x'], { maxBuffer: 1000 })).stdout).toHaveLength(900);
  });

  it('maxBuffer를 넘으면 그 자리에서 자식을 멈춰, 상한을 크게 넘는 출력을 모으지 않는다(상한은 읽기 전에 본다)', async () => {
    const error = await execChecked('sh', ['-c', 'head -c 5000000 /dev/zero | tr "\\0" y'], { maxBuffer: 1000 }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    expect(Buffer.byteLength((error as ExecCheckedError).stdout)).toBeLessThanOrEqual(1001);
  });

  it('기본 maxBuffer는 execFile처럼 1MiB다', async () => {
    await expect(execChecked('sh', ['-c', 'head -c 1100000 /dev/zero | tr "\\0" x'])).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  });

  it('cwd에서 돈다', async () => {
    const { stdout } = await execChecked('pwd', ['-P'], { cwd: tmpdir() });
    expect(stdout.trim()).toBe(await realpath(tmpdir()));
  });

  it('없는 cwd는 던진다', async () => {
    await expect(execChecked('pwd', [], { cwd: '/definitely/not/here' })).rejects.toThrow(ExecCheckedError);
  });
});
