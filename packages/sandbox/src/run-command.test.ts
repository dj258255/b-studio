import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from './stream-exec';

// TS → napi → Rust(bstudio-io) 경로 전체를 호스트 sh로 확인한다(ADR-193, 2c-2, #1043).
// #docker가 이 함수를 쓴다. 코어 로직(256MB 상한·버퍼링)의 경계는 cargo 단위 테스트가 본다.
// 여기서는 #docker의 계약(던지지 않음, 취소 시 부분 결과)을 경계에서 본다.
describe('runCommand (Rust 경계, #docker 계약)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bstudio-run-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stdout·stderr를 모은다', async () => {
    const result = await runCommand('sh', ['-c', 'printf out; printf err 1>&2']);
    expect(result).toEqual({ exitCode: 0, stdout: 'out', stderr: 'err' });
  });

  it('0이 아닌 종료를 던지지 않고 결과로 돌려준다', async () => {
    const result = await runCommand('sh', ['-c', 'printf oops 1>&2; exit 7']);
    expect(result).toEqual({ exitCode: 7, stdout: '', stderr: 'oops' });
  });

  it('input을 stdin으로 넣는다', async () => {
    const result = await runCommand('tr', ['a-z', 'A-Z'], { input: 'abcABC\n' });
    expect(result).toEqual({ exitCode: 0, stdout: 'ABCABC\n', stderr: '' });
  });

  it('env를 주면 상속 없이 통째로 바꾼다', async () => {
    process.env.BSTUDIO_RUN_PARENT = 'leak';
    try {
      const result = await runCommand('sh', ['-c', 'printf "%s:%s" "${BSTUDIO_RUN_PARENT:-none}" "${BSTUDIO_RUN_CHILD:-none}"'], {
        env: { BSTUDIO_RUN_CHILD: 'set', PATH: process.env.PATH ?? '' },
      });
      expect(result.stdout).toBe('none:set');
    } finally {
      delete process.env.BSTUDIO_RUN_PARENT;
    }
  });

  it('없는 바이너리는 던지지 않고 exitCode 1로 돌려준다', async () => {
    const result = await runCommand('definitely-not-a-real-binary-xyz', []);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT');
  });

  it('취소하면 거절하지 않고 부분 출력과 exitCode 1을 돌려주며 자식을 죽인다', async () => {
    const marker = path.join(dir, 'ran.txt');
    const controller = new AbortController();
    const promise = runCommand('sh', ['-c', `printf early; sleep 5; printf late > "${marker}"`], { signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    // 2c-1의 stream-exec와 달리 거절하지 않는다 — #docker는 결과를 돌려준다
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('early');
    // sh가 죽었으면 sleep 뒤의 printf가 실행되지 않아 marker가 생기지 않는다
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });
});
