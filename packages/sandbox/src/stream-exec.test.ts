import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommandFromFile, runCommandToFile } from './stream-exec';

// TS → napi → Rust(bstudio-io) 경로 전체를 임시 폴더와 호스트 sh로 확인한다(ADR-193, 2c-1).
// 코어 로직의 경계값(1MiB 자르기 등)은 cargo 쪽 단위 테스트가 본다. 여기서는 경계 넘기기와 취소를 본다.
describe('stream-exec (Rust 경계)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bstudio-stream-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stdout을 파일로 흘리고 stderr를 잡는다', async () => {
    const out = path.join(dir, 'out.txt');
    const result = await runCommandToFile('sh', ['-c', 'printf hello; printf oops 1>&2'], out);
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: 'oops' });
    expect(await readFile(out, 'utf8')).toBe('hello');
  });

  it('0이 아닌 종료 코드를 그대로 준다', async () => {
    const out = path.join(dir, 'out.txt');
    const result = await runCommandToFile('sh', ['-c', 'printf bad 1>&2; exit 3'], out);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('bad');
  });

  it('파일을 stdin으로 넣고 stdout·stderr를 잡는다', async () => {
    const input = path.join(dir, 'in.txt');
    await writeFile(input, 'abcABC\n');
    const result = await runCommandFromFile('tr', ['a-z', 'A-Z'], input);
    expect(result).toEqual({ exitCode: 0, stdout: 'ABCABC\n', stderr: '' });
  });

  it('env를 주면 상속 없이 통째로 바꾼다', async () => {
    const out = path.join(dir, 'out.txt');
    process.env.BSTUDIO_STREAM_PARENT = 'leak';
    try {
      await runCommandToFile('sh', ['-c', 'printf "%s:%s" "${BSTUDIO_STREAM_PARENT:-none}" "${BSTUDIO_STREAM_CHILD:-none}"'], out, {
        env: { BSTUDIO_STREAM_CHILD: 'set', PATH: process.env.PATH ?? '' },
      });
    } finally {
      delete process.env.BSTUDIO_STREAM_PARENT;
    }
    expect(await readFile(out, 'utf8')).toBe('none:set');
  });

  it('signal로 취소하면 거절하고 자식을 죽인다', async () => {
    const out = path.join(dir, 'out.txt');
    const marker = path.join(dir, 'ran.txt');
    const controller = new AbortController();
    const promise = runCommandToFile('sh', ['-c', `sleep 5; printf done > "${marker}"`], out, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(promise).rejects.toThrow();
    // sh가 죽었으면 뒤의 printf가 실행되지 않아 marker가 생기지 않는다
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });
});
