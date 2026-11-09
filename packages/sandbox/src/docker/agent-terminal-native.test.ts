import { describe, expect, it } from 'vitest';
import { openExecSession } from '../stream-exec';
import { openAgentTerminal, spawnNativeTerminal } from './agent-terminal';

// TS → napi(ExecSession, ThreadsafeFunction 밀어내기 + 동기 write/terminate) → Rust(bstudio-io exec_stream) 전체를 호스트 sh로 확인한다
// (ADR-193, 2c-4b). 진짜 docker는 쓰지 않는다: docker exec -i 자리에 sh를 끼워 양방향 파이프를 흉내 낸다.
// 바이트 역류·종료 순서·SIGTERM의 세부는 cargo 단위 테스트가 본다. 여기서는 napi 경계와 openAgentTerminal 계약을 본다.

function until(condition: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (condition()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('시간 초과'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

describe('openExecSession (napi 양방향 경계)', () => {
  it('stdin에 쓴 것이 stdout 바이트로 돌아오고, end 뒤 종료 코드가 마지막에 온다', async () => {
    const order: string[] = [];
    const chunks: Buffer[] = [];
    let exit: number | null | undefined;
    const session = openExecSession('sh', ['-c', 'cat'], {
      onData: (chunk) => {
        order.push('data');
        chunks.push(chunk);
      },
      onExit: (code) => {
        order.push('exit');
        exit = code;
      },
    });
    expect(session.write('안녕\r')).toBe(true);
    session.write(Buffer.from([0x1b, 0x5b, 0x32, 0x4a, 0xff]));
    session.end();
    await until(() => exit !== undefined);
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([Buffer.from('안녕\r'), Buffer.from([0x1b, 0x5b, 0x32, 0x4a, 0xff])]));
    expect(exit).toBe(0);
    expect(order.at(-1)).toBe('exit');
    expect(order.filter((entry) => entry === 'exit')).toHaveLength(1);
    expect(session.write('late')).toBe(false);
  });

  it('terminate는 SIGTERM이라 종료 코드가 null이다', async () => {
    let exit: number | null | undefined;
    const session = openExecSession('sh', ['-c', 'printf ready; exec sleep 30'], { onData: () => {}, onExit: (code) => (exit = code) });
    session.terminate();
    await until(() => exit !== undefined);
    expect(exit).toBeNull();
  });

  it('띄우기 실패는 던지지 않고 -2로 끝난다', async () => {
    let exit: number | null | undefined;
    openExecSession('/nonexistent/bstudio-bin', [], { onData: () => {}, onExit: (code) => (exit = code) });
    await until(() => exit !== undefined);
    expect(exit).toBe(-2);
  });

  it('stderr도 같은 흐름으로 온다', async () => {
    const chunks: Buffer[] = [];
    let exit: number | null | undefined;
    openExecSession('sh', ['-c', "printf 'oops' 1>&2; exit 4"], { onData: (chunk) => chunks.push(chunk), onExit: (code) => (exit = code) });
    await until(() => exit !== undefined);
    expect(Buffer.concat(chunks).toString()).toBe('oops');
    expect(exit).toBe(4);
  });
});

describe('openAgentTerminal (기본 spawn = Rust 세션)', () => {
  it('write → 출력 역류 → close(stdin 닫기 + SIGTERM) → 종료', async () => {
    const terminal = openAgentTerminal('c-agent', { id: 'main', size: { cols: 80, rows: 24 }, spawnProcess: () => spawnNativeTerminal('sh', ['-c', 'cat']) });
    const chunks: Buffer[] = [];
    terminal.onData((chunk) => chunks.push(chunk));
    let exit: number | null | undefined;
    terminal.onExit((code) => (exit = code));
    terminal.write('ls\r');
    await until(() => Buffer.concat(chunks).toString() === 'ls\r');
    terminal.close();
    await until(() => exit !== undefined);
    // 닫은 뒤의 입력은 조용히 버려진다(던지지 않는다)
    expect(() => terminal.write('late')).not.toThrow();
  });

  it('리스너를 늦게 붙여도 앞서 온 출력과 종료를 잃지 않는다', async () => {
    const terminal = openAgentTerminal('c-agent', { id: 'main', size: { cols: 80, rows: 24 }, spawnProcess: () => spawnNativeTerminal('sh', ['-c', "printf 'early'"]) });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const chunks: Buffer[] = [];
    let exit: number | null | undefined;
    terminal.onData((chunk) => chunks.push(chunk));
    terminal.onExit((code) => (exit = code));
    await until(() => exit !== undefined);
    expect(Buffer.concat(chunks).toString()).toBe('early');
    expect(exit).toBe(0);
  });

  it('시그널로 죽으면 종료 코드는 null이다', async () => {
    const terminal = openAgentTerminal('c-agent', { id: 'main', size: { cols: 80, rows: 24 }, spawnProcess: () => spawnNativeTerminal('sh', ['-c', 'exec sleep 30']) });
    let exit: number | null | undefined;
    terminal.onData(() => {});
    terminal.onExit((code) => (exit = code));
    terminal.close();
    await until(() => exit !== undefined);
    expect(exit).toBeNull();
  });
});
