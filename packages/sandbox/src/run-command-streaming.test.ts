import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommandStreaming } from './stream-exec';

// TS → napi(ThreadsafeFunction) → Rust(bstudio-io) 경로 전체를 호스트 sh로 확인한다(ADR-193, 2c-3a, #1045).
// deploy의 #docker가 이 함수를 쓴다. 줄 분할·끝 조각·뒤쪽 자르기 경계는 cargo 단위 테스트가 본다.
// 여기서는 onLine 콜백이 Rust 작업 스레드에서 JS로 역류하는 경계와 취소를 본다.
// NonBlocking TSFN 호출은 Promise resolve보다 늦게 비워질 수 있어, 줄을 확인하기 전에 한 틱 기다린다.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

describe('runCommandStreaming (Rust 경계, deploy #docker 계약)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bstudio-stream-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('완성된 줄마다 onLine을 부르고 끝 조각도 부른다', async () => {
    const lines: string[] = [];
    const result = await runCommandStreaming('sh', ['-c', "printf 'a\\nb\\ntail'"], { onLine: (line) => lines.push(line) });
    await tick();
    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(['a', 'b', 'tail']);
  });

  it('stderr도 줄 단위로 역류하고 결과에 모은다', async () => {
    const lines: string[] = [];
    const result = await runCommandStreaming('sh', ['-c', "printf 'oops\\n' 1>&2; exit 2"], { onLine: (line) => lines.push(line) });
    await tick();
    expect(result.exitCode).toBe(2);
    expect(lines).toEqual(['oops']);
    expect(result.stderr).toBe('oops\n');
  });

  it('onLine 없이도 출력을 모은다', async () => {
    const result = await runCommandStreaming('sh', ['-c', "printf 'hello\\n'"]);
    expect(result).toEqual({ exitCode: 0, stdout: 'hello\n', stderr: '' });
  });

  it('cwd에서 돌고 input을 stdin으로 넣는다', async () => {
    await writeFile(path.join(dir, 'marker.txt'), 'x');
    const lines: string[] = [];
    const result = await runCommandStreaming('sh', ['-c', 'ls; cat'], { cwd: dir, input: 'from-stdin', onLine: (line) => lines.push(line) });
    await tick();
    expect(result.exitCode).toBe(0);
    expect(lines).toContain('marker.txt');
    expect(lines).toContain('from-stdin');
  });

  it('취소하면 거절하지 않고 부분 결과를 주며 자식을 죽인다', async () => {
    const marker = path.join(dir, 'ran.txt');
    const lines: string[] = [];
    const controller = new AbortController();
    const promise = runCommandStreaming('sh', ['-c', `printf 'early\\n'; sleep 5; printf late > "${marker}"`], {
      signal: controller.signal,
      onLine: (line) => lines.push(line),
    });
    setTimeout(() => controller.abort(), 150);
    const result = await promise;
    expect(result.exitCode).toBe(1);
    await tick();
    expect(lines).toContain('early');
    // sh가 죽었으면 sleep 뒤의 printf가 실행되지 않아 marker가 생기지 않는다
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });
});
