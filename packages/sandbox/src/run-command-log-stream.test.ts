import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommandLogStream } from './stream-exec';

// TS → napi(async_iterator) → Rust(bstudio-io) 경로 전체를 호스트 sh로 확인한다(ADR-193, 2c-3b, #1047).
// compose-provider의 logs()가 이 함수를 쓴다. 줄 분할·cwd·env·spawn 실패 경계는 cargo 단위 테스트가 본다.
// 여기서는 당기기(pull) 경계(for await로 당기면 줄이 오고, break·signal이 자식을 kill하는지)를 본다.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function collect(stream: AsyncIterableIterator<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of stream) lines.push(line);
  return lines;
}

describe('runCommandLogStream (Rust 경계, logs() 당기기 계약)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bstudio-logs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('줄을 순서대로 당기고 끝나면 스트림이 닫힌다', async () => {
    const lines = await collect(runCommandLogStream('sh', ['-c', "printf 'a\\nb\\nc\\n'"]));
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('stdout만 흘린다 (stderr는 버린다)', async () => {
    const lines = await collect(runCommandLogStream('sh', ['-c', "printf 'out\\n'; printf 'err\\n' 1>&2"]));
    expect(lines).toEqual(['out']);
  });

  it('env를 적용한다', async () => {
    const lines = await collect(
      runCommandLogStream('sh', ['-c', 'printf "%s\\n" "$MARKER"'], { env: { ...process.env, MARKER: 'from-env' } }),
    );
    expect(lines).toContain('from-env');
  });

  it('소비자가 break하면 자식을 죽인다', async () => {
    const marker = path.join(dir, 'ran.txt');
    // 첫 줄을 받은 뒤 break한다. sh가 죽으면 sleep 뒤의 printf가 실행되지 않아 marker가 안 생긴다.
    const stream = runCommandLogStream('sh', ['-c', `printf 'first\\n'; sleep 5; printf late > "${marker}"`]);
    const received: string[] = [];
    for await (const line of stream) {
      received.push(line);
      break;
    }
    expect(received).toEqual(['first']);
    await sleep(400);
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('signal로 취소하면 거절하지 않고 스트림을 닫으며 자식을 죽인다', async () => {
    const marker = path.join(dir, 'ran.txt');
    const controller = new AbortController();
    const stream = runCommandLogStream('sh', ['-c', `printf 'early\\n'; sleep 5; printf late > "${marker}"`], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    // 취소는 throw가 아니라 스트림 종료다(옛 logs()도 abort를 조용히 끝냈다).
    const lines = await collect(stream);
    expect(lines).toContain('early');
    await sleep(400);
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('없는 바이너리는 던지지 않고 빈 스트림으로 끝난다', async () => {
    const lines = await collect(runCommandLogStream('this-binary-does-not-exist-xyz', ['--help']));
    expect(lines).toEqual([]);
  });

  it('소비가 느려도 많은 줄을 빠짐없이 받는다 (백프레셔)', async () => {
    // 채널 용량(256)보다 많은 줄을 천천히 당긴다. 밀어내기+무한 큐라면 순서·누락 문제가 날 수 있지만, 당기기는 안전하다.
    const stream = runCommandLogStream('sh', ['-c', 'i=0; while [ $i -lt 400 ]; do printf "%d\\n" "$i"; i=$((i+1)); done']);
    const lines: string[] = [];
    for await (const line of stream) {
      lines.push(line);
      if (lines.length % 100 === 0) await sleep(10); // 소비를 일부러 늦춘다
    }
    expect(lines).toHaveLength(400);
    expect(lines[0]).toBe('0');
    expect(lines[399]).toBe('399');
  });
});
