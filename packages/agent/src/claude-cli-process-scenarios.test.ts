import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { native } from '@b-studio/sandbox';
import { spawnClaudeCli } from './claude-cli-process';
import type { ClaudeCliProcess, CliExit, CliMessage, CliStopOptions } from './claude-cli-process';
import { fakeClaudeCli } from './fake-claude-cli';

/**
 * CLI 프로세스 층(ADR-195 4f A8a)을 가짜 자식으로 확인한다: `messages()` 목록·`stderrTail()`·`exited`, 닫기 단계(graceful/now → SIGTERM → SIGKILL),
 * 자기 pid에만 신호를 보내는 보장. 줄 나누기와 UTF-8 해석은 프로세스 없이 Node `readline`·`StringDecoder`와도 무작위로 견준다.
 * 옛 TS 구현(`node:child_process` 사본)과 견주던 부분은 걷어냈다(#1347).
 */

const root = mkdtempSync(path.join(tmpdir(), 'cli-process-diff-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// ── 가짜 자식: 계획(plan)을 순서대로 한다 ──
// out/err: 바이트를 쓴다. fill: 한 바이트를 count번(수 MiB 줄). repeat: 바이트를 times번. sleep: 쉰다(덩어리 경계를 만든다).
// closeStdin: 입력을 먼저 닫는다. exit: 그 코드로 끝난다. kill: 자기에게 신호를 보낸다
const CHILD = `
import fs from 'node:fs';
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (stream, buf) => new Promise((resolve) => stream.write(buf, resolve));
for (const op of plan) {
  if (op.out) await write(process.stdout, Buffer.from(op.out));
  else if (op.err) await write(process.stderr, Buffer.from(op.err));
  else if (op.fill) {
    const chunk = Buffer.alloc(64 * 1024, op.fill.byte);
    for (let left = op.fill.count; left > 0; left -= chunk.length) await write(process.stdout, chunk.subarray(0, Math.min(left, chunk.length)));
  } else if (op.repeat) {
    const bytes = Buffer.from(op.repeat.bytes);
    for (let i = 0; i < op.repeat.times; i++) await write(process.stdout, bytes);
  } else if (op.sleep) await sleep(op.sleep);
  else if (op.closeStdin) fs.closeSync(0);
  else if (op.exit !== undefined) process.exit(op.exit);
  else if (op.kill) { process.kill(process.pid, op.kill); await sleep(10_000); }
}
`;
const childPath = path.join(root, 'child.mjs');
writeFileSync(childPath, CHILD);

type Op = { out?: number[]; err?: number[]; fill?: { byte: number; count: number }; repeat?: { bytes: number[]; times: number }; sleep?: number; closeStdin?: true; exit?: number; kill?: string };

let planSeq = 0;
function planFile(plan: Op[]): string {
  const file = path.join(root, `plan-${planSeq++}.json`);
  writeFileSync(file, JSON.stringify(plan));
  return file;
}

const bytes = (text: string): number[] => [...Buffer.from(text, 'utf8')];
const out = (...parts: Array<string | number[]>): Op => ({ out: parts.flatMap((part) => (typeof part === 'string' ? bytes(part) : part)) });
const err = (...parts: Array<string | number[]>): Op => ({ err: parts.flatMap((part) => (typeof part === 'string' ? bytes(part) : part)) });
// 덩어리 사이를 쉬어 파이프에서 따로 읽히게 한다
const gap: Op = { sleep: 25 };
const obj = (n: unknown): string => JSON.stringify({ type: 'assistant', n });

interface Observed {
  messages: CliMessage[];
  stderrTail: string;
  exit: { code: number | null; signal: string | null; error: { code?: unknown; message: string } | null };
}

type Spawn = (options: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; stop?: CliStopOptions }) => ClaudeCliProcess;

interface Drive {
  sends?: string[];
  /** 띄운 뒤 이만큼 쉬고 나서 더 보낼 줄 */
  lateSends?: string[];
  command?: string;
  args?: string[];
  cwd?: string;
}

async function observe(spawnImpl: Spawn, plan: Op[], drive: Drive = {}): Promise<Observed> {
  const proc = spawnImpl({
    command: drive.command ?? process.execPath,
    args: drive.args ?? [childPath, planFile(plan)],
    cwd: drive.cwd ?? root,
    env: { ...process.env },
    stop: { termAfterMs: 200, killAfterMs: 200 },
  });
  for (const line of drive.sends ?? []) proc.send(line);
  const collecting = (async () => {
    const messages: CliMessage[] = [];
    for await (const message of proc.messages()) messages.push(message);
    return messages;
  })();
  if (drive.lateSends) {
    await new Promise((r) => setTimeout(r, 150));
    for (const line of drive.lateSends) proc.send(line);
  }
  const exit: CliExit = await proc.exited;
  const messages = await collecting;
  return {
    messages,
    stderrTail: proc.stderrTail(),
    exit: { code: exit.code, signal: exit.signal, error: exit.error ? { code: (exit.error as NodeJS.ErrnoException).code, message: exit.error.message } : null },
  };
}

/** 계획을 가짜 자식에게 시켜 관찰한 값을 돌려준다 */
async function same(plan: Op[], drive?: Drive): Promise<Observed> {
  return observe(spawnClaudeCli, plan, drive);
}

// 파이프 덩어리 경계가 시험마다 다르므로 같은 계획을 여러 번 견주는 대신 경계를 계획에 박는다(gap)

describe('줄 나누기·UTF-8: messages()', () => {
  it('CRLF·LF·홀로 선 CR이 모두 줄 끝이다', async () => {
    const seen = await same([out(`${obj(1)}\r\n${obj(2)}\n${obj(3)}\r${obj(4)}\n`)]);
    expect(seen.messages.map((m) => (m as { n?: number }).n)).toEqual([1, 2, 3, 4]);
  });

  it('덩어리 경계에 걸린 CR과 LF', async () => {
    const seen = await same([out(obj(1), [13]), gap, out([10], obj(2), [13]), gap, out(obj(3)), gap, out([13, 10], obj(4), [13]), gap, out([13], obj(5), [10])]);
    expect(seen.messages.map((m) => (m as { n?: number }).n)).toEqual([1, 2, 3, 4, 5]);
  });

  it('줄 끝이 덩어리 안 여러 곳에 있고 경계가 줄 한가운데다', async () => {
    const line = obj('가나다');
    const raw = bytes(`${line}\n${line}\n`);
    const seen = await same([out(raw.slice(0, 5)), gap, out(raw.slice(5, 9)), gap, out(raw.slice(9))]);
    expect(seen.messages.map((m) => (m as { n?: string }).n)).toEqual(['가나다', '가나다']);
  });

  it('덩어리 경계에 걸린 여러 바이트 글자(한글·이모지)를 잇는다', async () => {
    const raw = bytes(`${obj('한글😀끝')}\n`);
    const at = raw.indexOf(0xed) + 1; // 한 글자의 첫 바이트 다음
    const seen = await same([out(raw.slice(0, at)), gap, out(raw.slice(at, at + 1)), gap, out(raw.slice(at + 1))]);
    expect((seen.messages[0] as { n?: string }).n).toBe('한글😀끝');
  });

  it('깨진 UTF-8은 U+FFFD가 된다(덩어리 안, 덩어리 경계, 이어져야 할 자리에 다른 글자)', async () => {
    const seen = await same([
      out(bytes('{"type":"x","n":"a'), [0xff, 0xfe], bytes('b"}\n')),
      out(bytes('{"type":"x","n":"c'), [0xe2, 0x82]),
      gap,
      out(bytes('d"}\n')),
      out(bytes('{"type":"x","n":"e'), [0xf0, 0x9f]),
      gap,
      out([0x98], bytes('f"}\n')),
      out(bytes('{"type":"x","n":"g'), [0xe0, 0x80, 0x80, 0xc0, 0xaf, 0xf5, 0x80], bytes('h"}\n')),
    ]);
    expect(seen.messages.map((m) => (m as { n?: string }).n)).toEqual(['a��b', 'c�d', 'e�f', 'g�������h']);
  });

  it('마지막 줄에 줄바꿈이 없어도 낸다. 끝에 미완성 UTF-8 바이트가 남으면 버린다', async () => {
    const a = await same([out(`${obj(1)}\n${obj(2)}`)]);
    expect(a.messages).toHaveLength(2);
    const b = await same([out(`${obj(1)}\n${obj(2)}`, [0xe2, 0x82])]);
    expect(b.messages).toHaveLength(2);
    const c = await same([out(`${obj(1)}\n`, [0xe2, 0x82])]);
    expect(c.messages).toHaveLength(1);
  });

  it('빈 줄·공백 줄·JS trim이 지우는 글자만 있는 줄은 건너뛰고 앞뒤에 붙은 것은 JSON이 아니라 건너뛴다', async () => {
    const spaces = [' ', '\t', '\v', '\f', ' ', '﻿', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　'];
    const lines = spaces.flatMap((space) => [`${space}\n`, `${space}${space}\r\n`, `${space}${obj('붙음')}\n`, `${obj('뒤')}${space}\n`]);
    const seen = await same([out('\n\r\n\r', ...lines, obj('끝'), '\n')]);
    // 뒤에 공백이 붙은 줄은 JSON으로 읽히는 공백(' ', \t)일 때만 객체다
    expect(seen.messages.length).toBeGreaterThan(1);
  });

  it('JSON이 아닌 줄, 배열·숫자·null·문자열 줄, 객체 줄이 섞여 있다', async () => {
    const seen = await same([out('not json\n[1,2]\n42\nnull\n"str"\ntrue\n{"type":"a"}\n{broken\n{"type":"b"} trailing\n{"type":"c"}\n')]);
    expect(seen.messages).toEqual([{ type: 'a' }, { type: 'c' }]);
  });

  it('아주 긴 줄(수 MiB)이 줄 한 개로 온다', async () => {
    const seen = await same([out('{"type":"big","text":"'), { fill: { byte: 120, count: 4_500_000 } }, out('"}\n'), out('not json '), { fill: { byte: 121, count: 3_000_000 } }, out('\n', obj('뒤'), '\n')]);
    expect(seen.messages).toHaveLength(2);
    expect(((seen.messages[0] as { text?: string }).text ?? '').length).toBe(4_500_000);
  });

  it('많은 줄(수만)이 순서대로 온다', async () => {
    const seen = await same([{ repeat: { bytes: bytes('{"type":"n"}\n'), times: 30_000 } }]);
    expect(seen.messages).toHaveLength(30_000);
  });
});

describe('표준 오류 끝부분과 끝 상태', () => {
  it('2,000자 경계: 짧을 때·딱 2,000·넘을 때', async () => {
    for (const n of [0, 1, 1999, 2000, 2001, 5000]) {
      const seen = await same([err('e'.repeat(n)), out(`${obj(1)}\n`)]);
      expect(seen.stderrTail.length).toBe(Math.min(n, 2000));
    }
  });

  it('서로게이트 쌍이 2,000 경계에 걸리면 짝 없는 단위가 남는다(UTF-16 단위로 자른다)', async () => {
    const seen = await same([err('😀', 'x'.repeat(1998)), gap, err('y')]);
    expect(seen.stderrTail.charCodeAt(0)).toBe(0xde00);
    expect(seen.stderrTail.length).toBe(2000);
    // 한 덩어리로 와도 같다
    const whole = await same([err('😀', 'x'.repeat(1998), 'y')]);
    expect(whole.stderrTail.charCodeAt(0)).toBe(0xde00);
    expect(whole.stderrTail.length).toBe(2000);
    // 여러 쌍과 한글이 섞이고 덩어리 경계가 쌍 한가운데다
    const text = '가😀나😀'.repeat(900);
    const raw = bytes(text);
    const split = await same([err(raw.slice(0, 1001)), gap, err(raw.slice(1001, 4003)), gap, err(raw.slice(4003))]);
    expect(split.stderrTail).toBe(text.slice(-2000));
  });

  it('표준 오류의 깨진 바이트·덩어리 경계 글자·끝의 미완성 글자(U+FFFD)', async () => {
    const seen = await same([err('a', [0xff], 'b', [0xe2]), gap, err([0x82, 0xac], 'c', [0xe2, 0x82])]);
    expect(seen.stderrTail).toBe('a�b€c�');
  });

  it('표준 오류만 쓰고 끝난다(출력 줄 없음)', async () => {
    const seen = await same([err('boom\n'), { exit: 1 }]);
    expect(seen.messages).toEqual([]);
    expect(seen.stderrTail).toBe('boom\n');
    expect(seen.exit).toEqual({ code: 1, signal: null, error: null });
  });

  it('종료 코드 여러 개', async () => {
    for (const code of [0, 1, 2, 42, 127, 255]) {
      const seen = await same([out(`${obj(code)}\n`), { exit: code }]);
      expect(seen.exit).toEqual({ code, signal: null, error: null });
    }
  });

  it('신호로 죽으면 code는 null이고 signal은 Node의 이름이다', async () => {
    for (const signal of ['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT', 'SIGUSR2', 'SIGALRM']) {
      const seen = await same([out(`${obj(signal)}\n`), { kill: signal }]);
      expect(seen.exit).toEqual({ code: null, signal, error: null });
      expect(seen.messages).toHaveLength(1);
    }
  });
});

describe('띄우기 실패', () => {
  it('없는 경로는 resolveCliCommand가 막아 ENOENT로 끝난다(줄·신호 없음)', async () => {
    const seen = await same([], { command: path.join(root, 'no-such-bin'), args: [] });
    expect(seen.exit.code).toBeNull();
    expect(seen.exit.error?.code).toBe('ENOENT');
    expect(seen.messages).toEqual([]);
    expect(seen.stderrTail).toBe('');
  });

  it('고른 파일을 띄우지 못하면(인터프리터가 없다) spawn이 낸 오류로 끝난다', async () => {
    // 작업 폴더(root) 밖에 둔다(resolveCliCommand는 작업 폴더 안의 실행 파일을 고르지 않는다)
    const binDir = mkdtempSync(path.join(tmpdir(), 'cli-process-bin-'));
    const script = path.join(binDir, 'bad-interp.sh');
    writeFileSync(script, '#!/nonexistent/interpreter\n');
    chmodSync(script, 0o755);
    const seen = await same([], { command: script, args: [] }).finally(() => rmSync(binDir, { recursive: true, force: true }));
    // 메시지의 경로는 resolveCliCommand가 돌려준 실제 경로다(임시 폴더가 링크 아래일 수 있다)
    expect(seen.exit).toEqual({ code: null, signal: null, error: { code: 'ENOENT', message: expect.stringMatching(/^spawn \/.*bad-interp\.sh ENOENT$/) } });
  });

  it('작업 폴더가 없으면 spawn이 낸 오류로 끝난다', async () => {
    const seen = await same([], { cwd: path.join(root, 'no-such-dir') });
    expect(seen.exit.code).toBeNull();
    expect(seen.exit.error?.code).toBe('ENOENT');
  });

  it('띄우기 실패 뒤의 send·closeInput·stop은 아무 일도 하지 않는다', async () => {
    for (const impl of [spawnClaudeCli]) {
      const proc = impl({ command: path.join(root, 'no-such-bin'), args: [], cwd: root, env: { ...process.env } });
      proc.send('x');
      proc.closeInput();
      proc.stop('now');
      proc.stop('graceful');
      expect((await proc.exited).error).toBeDefined();
    }
  });
});

describe('표준 입력', () => {
  it('보낸 줄이 순서대로 자식에 닿고 closeInput 뒤의 send는 무시한다', async () => {
    // 자식(cat 역할): 받은 줄을 그대로 출력한다
    const echo = path.join(root, 'echo.mjs');
    writeFileSync(echo, `process.stdin.pipe(process.stdout);`);
    for (const impl of [spawnClaudeCli]) {
      const proc = impl({ command: process.execPath, args: [echo], cwd: root, env: { ...process.env } });
      proc.send('첫째 😀');
      proc.send('둘째');
      proc.closeInput();
      proc.send('버림');
      const messages: CliMessage[] = [];
      for await (const message of proc.messages()) messages.push(message);
      expect((await proc.exited).code).toBe(0);
      expect(messages.map((m) => (m as { message?: { content?: string } }).message?.content)).toEqual(['첫째 😀', '둘째']);
    }
  });

  it('자식이 입력을 먼저 닫아도(EPIPE) 우리가 계속 send해도 죽지 않는다', async () => {
    const big = 'x'.repeat(64 * 1024);
    const seen = await same([{ closeStdin: true }, { sleep: 50 }, out(`${obj(1)}\n`), { sleep: 100 }], {
      sends: Array.from({ length: 100 }, () => big),
      lateSends: Array.from({ length: 100 }, () => big),
    });
    expect(seen.messages).toHaveLength(1);
    expect(seen.exit.code).toBe(0);
  });
});

// ── 무작위: 줄 나누기와 UTF-8을 Node readline·StringDecoder와 견준다(프로세스 없이) ──

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 줄 끝, 여러 바이트 글자의 조각, 깨진 바이트, JSON 조각이 섞인 바이트 덩어리를 만든다
const PIECES: number[][] = [
  [13],
  [10],
  [13, 10],
  [13, 13],
  [10, 10],
  [0x20],
  [0x61],
  [0x7b, 0x7d],
  [0x22],
  [0xe2],
  [0x82],
  [0xac],
  [0xe2, 0x82, 0xac],
  [0xf0, 0x9f, 0x98, 0x80],
  [0xf0],
  [0x9f],
  [0x98],
  [0x80],
  [0xed, 0xa0, 0x80],
  [0xc0, 0xaf],
  [0xe0],
  [0xf5],
  [0xff],
  [0xfe],
  [0xc2, 0xa0],
  [0xef, 0xbb, 0xbf],
  [0xea, 0xb0, 0x80],
];

function randomChunks(random: () => number): Buffer[] {
  const chunks: Buffer[] = [];
  const count = 1 + Math.floor(random() * 12);
  for (let i = 0; i < count; i++) {
    const out: number[] = [];
    const pieces = Math.floor(random() * 9);
    for (let j = 0; j < pieces; j++) {
      if (random() < 0.15) out.push(Math.floor(random() * 256));
      else out.push(...(PIECES[Math.floor(random() * PIECES.length)] ?? []));
    }
    // 실제 파이프는 빈 덩어리를 주지 않는다(PassThrough도 빈 쓰기는 내보내지 않는다)
    if (out.length > 0) chunks.push(Buffer.from(out));
  }
  return chunks;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Node readline(crlfDelay: Infinity)이 이 덩어리들에서 내는 줄 */
async function nodeLines(chunks: Buffer[]): Promise<string[]> {
  const input = new PassThrough();
  const rl = createInterface({ input, crlfDelay: Infinity });
  const lines: string[] = [];
  rl.on('line', (line) => lines.push(line));
  const closed = new Promise<void>((resolve) => rl.on('close', resolve));
  for (const chunk of chunks) {
    input.write(chunk);
    await tick();
  }
  input.end();
  await closed;
  return lines;
}

/** `setEncoding('utf8')` 뒤 `(stderr + chunk).slice(-2000)`을 하던 옛 코드가 이 덩어리들에서 남기는 글 */
async function nodeStderrTail(chunks: Buffer[]): Promise<string> {
  const input = new PassThrough();
  input.setEncoding('utf8');
  let tail = '';
  input.on('data', (chunk: string) => {
    tail = (tail + chunk).slice(-2000);
  });
  const ended = new Promise<void>((resolve) => input.on('end', resolve));
  for (const chunk of chunks) {
    input.write(chunk);
    await tick();
  }
  input.end();
  await ended;
  return tail;
}

const units = (text: string): number[] => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));

describe('Node readline·StringDecoder와 같다(무작위, 프로세스 없이)', () => {
  it('줄 나누기와 UTF-8 해석: 시드 1,500개', async () => {
    for (let seed = 1; seed <= 1500; seed++) {
      const chunks = randomChunks(mulberry32(seed));
      const expected = await nodeLines(chunks);
      const actual = native.cliSplitLines(chunks);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`시드 ${seed}: 줄이 다르다\n덩어리 ${JSON.stringify(chunks.map((c) => [...c]))}\nNode ${JSON.stringify(expected)}\nRust ${JSON.stringify(actual)}`);
      }
    }
  });

  it('줄 끝만 가득한 덩어리(CR·LF 조합)를 모든 경계로 나눈다', async () => {
    const alphabet = [13, 10, 0x61];
    for (let length = 1; length <= 7; length++) {
      for (let code = 0; code < 3 ** length; code++) {
        const stream = Array.from({ length }, (_, i) => alphabet[Math.floor(code / 3 ** i) % 3] as number);
        for (let mask = 0; mask < 2 ** (length - 1); mask++) {
          const chunks: Buffer[] = [];
          let start = 0;
          for (let i = 1; i <= length; i++) {
            if (i === length || (mask >> (i - 1)) & 1) {
              chunks.push(Buffer.from(stream.slice(start, i)));
              start = i;
            }
          }
          const expected = await nodeLines(chunks);
          const actual = native.cliSplitLines(chunks);
          if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${JSON.stringify(chunks.map((c) => [...c]))}: Node ${JSON.stringify(expected)} Rust ${JSON.stringify(actual)}`);
        }
      }
    }
  }, 60_000);

  it('표준 오류 끝 2,000 UTF-16 단위: 시드 600개(서로게이트가 경계에 걸리는 긴 입력 포함)', async () => {
    for (let seed = 1; seed <= 600; seed++) {
      const random = mulberry32(seed * 7919);
      const chunks = randomChunks(random);
      // 반 정도는 2,000을 넘기게 늘린다
      if (seed % 2 === 0) for (let i = 0; i < 80; i++) chunks.push(Buffer.from([...(PIECES[Math.floor(random() * PIECES.length)] ?? []), ...bytes('😀가x'.repeat(Math.floor(random() * 6)))]));
      const expected = await nodeStderrTail(chunks);
      const actual = Array.from(native.cliStderrTailOf(chunks));
      if (JSON.stringify(actual) !== JSON.stringify(units(expected))) throw new Error(`시드 ${seed}: 표준 오류 끝부분이 다르다`);
    }
  });
});

// ── 닫기 단계 ──

// SIGTERM을 무시하고 자기 pid를 파일에 적는 자식. 표준 입력이 닫혀도 끝나지 않는다
const STUBBORN = `
import fs from 'node:fs';
fs.writeFileSync(process.argv[2], String(process.pid));
process.on('SIGTERM', () => fs.appendFileSync(process.argv[2] + '.signals', 'TERM\\n'));
process.stdout.write('{"type":"ready"}\\n');
setTimeout(() => process.exit(9), 20000); // 시험이 실패해도 자식이 남지 않게
setInterval(() => {}, 1000);
`;
const stubbornPath = path.join(root, 'stubborn.mjs');
writeFileSync(stubbornPath, STUBBORN);

// SIGTERM에 응하는 자식(기본 동작으로 죽는다). 표준 입력이 닫혀도 끝나지 않는다
const PATIENT = `
import fs from 'node:fs';
fs.writeFileSync(process.argv[2], String(process.pid));
process.stdout.write('{"type":"ready"}\\n');
setTimeout(() => process.exit(9), 20000); // 시험이 실패해도 자식이 남지 않게
setInterval(() => {}, 1000);
`;
const patientPath = path.join(root, 'patient.mjs');
writeFileSync(patientPath, PATIENT);

// 표준 입력이 닫히면 스스로 끝나는 자식
const POLITE = `
import fs from 'node:fs';
fs.writeFileSync(process.argv[2], String(process.pid));
process.stdout.write('{"type":"ready"}\\n');
setTimeout(() => process.exit(9), 20000); // 시험이 실패해도 자식이 남지 않게
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;
const politePath = path.join(root, 'polite.mjs');
writeFileSync(politePath, POLITE);

let closeSeq = 0;
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('기다리던 조건이 오지 않았다');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 자식을 띄우고 ready 줄이 올 때까지 기다린다. 자식의 pid는 자식이 파일에 적은 값이다 */
async function launch(spawnImpl: Spawn, script: string, stop: CliStopOptions) {
  const pidFile = path.join(root, `pid-${closeSeq++}`);
  const proc = spawnImpl({ command: process.execPath, args: [script, pidFile], cwd: root, env: { ...process.env }, stop });
  const iterator = proc.messages()[Symbol.asyncIterator]();
  const ready = await iterator.next();
  expect(ready.value).toEqual({ type: 'ready' });
  const pid = Number(readFileSync(pidFile, 'utf8'));
  return { proc, pid, pidFile, signalsOf: () => (existsSync(`${pidFile}.signals`) ? readFileSync(`${pidFile}.signals`, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

const bothImplementations: Array<[string, Spawn]> = [['새 구현', spawnClaudeCli]];

describe.each(bothImplementations)('닫기 단계 (%s)', (_name, spawnImpl) => {
  it('graceful: 입력만 닫으면 끝나는 자식은 신호 없이 끝난다', async () => {
    const { proc, pid, signalsOf } = await launch(spawnImpl, politePath, { termAfterMs: 300, killAfterMs: 300 });
    proc.stop('graceful');
    const exit = await proc.exited;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(signalsOf()).toEqual([]);
    expect(alive(pid)).toBe(false);
  });

  it('graceful: 입력을 닫아도 안 끝나면 termAfterMs 뒤 SIGTERM, SIGTERM을 무시하면 killAfterMs 뒤 SIGKILL', async () => {
    const { proc, pid, signalsOf } = await launch(spawnImpl, stubbornPath, { termAfterMs: 400, killAfterMs: 400 });
    const started = Date.now();
    proc.stop('graceful');
    await new Promise((r) => setTimeout(r, 200));
    expect(signalsOf()).toEqual([]); // 아직 termAfterMs 전이다
    const exit = await proc.exited;
    const elapsed = Date.now() - started;
    expect(exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(signalsOf()).toEqual(['TERM']);
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(6000);
    expect(alive(pid)).toBe(false);
  });

  it('graceful: SIGTERM에 응하는 자식은 SIGTERM으로 끝난다(SIGKILL까지 가지 않는다)', async () => {
    const { proc } = await launch(spawnImpl, patientPath, { termAfterMs: 200, killAfterMs: 60_000 });
    const started = Date.now();
    proc.stop('graceful');
    expect(await proc.exited).toEqual({ code: null, signal: 'SIGTERM' });
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it('now: 바로 SIGTERM, 무시하면 killAfterMs 뒤 SIGKILL (termAfterMs는 길어도 기다리지 않는다)', async () => {
    const { proc, signalsOf } = await launch(spawnImpl, stubbornPath, { termAfterMs: 60_000, killAfterMs: 500 });
    const started = Date.now();
    proc.stop('now');
    await waitFor(() => signalsOf().length === 1);
    expect(Date.now() - started).toBeLessThan(400);
    expect(await proc.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(signalsOf()).toEqual(['TERM']);
  });

  it('now는 걸려 있던 graceful 타이머를 당긴다', async () => {
    const { proc } = await launch(spawnImpl, patientPath, { termAfterMs: 60_000, killAfterMs: 60_000 });
    proc.stop('graceful');
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    proc.stop('now');
    expect(await proc.exited).toEqual({ code: null, signal: 'SIGTERM' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('SIGTERM은 한 번만 간다(now를 여러 번, graceful을 섞어 불러도)', async () => {
    const { proc, signalsOf } = await launch(spawnImpl, stubbornPath, { termAfterMs: 50, killAfterMs: 700 });
    proc.stop('now');
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 40));
      proc.stop(i % 2 ? 'now' : 'graceful');
    }
    expect(await proc.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(signalsOf()).toEqual(['TERM']);
  });

  it('끝난 뒤의 stop·send·closeInput은 아무 일도 하지 않는다', async () => {
    const { proc, pid } = await launch(spawnImpl, politePath, { termAfterMs: 100, killAfterMs: 100 });
    proc.closeInput();
    await proc.exited;
    expect(alive(pid)).toBe(false);
    proc.stop('now');
    proc.stop('graceful');
    proc.send('x');
    proc.closeInput();
  });

  it('fake-claude-cli의 ignoreSigterm·hangAfterEof: graceful → SIGTERM(무시) → SIGKILL', async () => {
    const fake = fakeClaudeCli({ invocations: [{ ignoreSigterm: true, hangAfterEof: true }] });
    const proc = spawnImpl({ command: fake.cli.command, args: fake.cli.commandArgs, cwd: root, env: { ...process.env }, stop: { termAfterMs: 300, killAfterMs: 300 } });
    const first = await proc.messages()[Symbol.asyncIterator]().next();
    expect((first.value as CliMessage).subtype).toBe('init');
    const started = Date.now();
    proc.stop('graceful');
    const exit = await proc.exited;
    expect(exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    const log = fake.logs()[0];
    expect(log?.stdinClosed).toBe(true);
    expect(log?.signals).toEqual(['SIGTERM']);
  });
});


// ── 표준 출력 백프레셔: 소비자가 안 읽는 동안 자식이 쓰기에서 막힌다(옛 readline 비동기 반복자는 줄 1,024개에서 입력을 멈춘다) ──

// 막히는 쓰기(fs.writeSync)로 줄을 낸다. 파이프가 차면 EAGAIN을 되풀이하며 기다린다(Node의 process.stdout은 파이프에서 비동기라 자식이 막히지 않는다).
// 다 쓰면 표시 파일을 만든다
const WRITER = `
import fs from 'node:fs';
const [marker, total] = [process.argv[2], Number(process.argv[3])];
const wait = new Int32Array(new SharedArrayBuffer(4));
for (let i = 1; i <= total; i++) {
  const buf = Buffer.from('{"n":' + i + '}\\n');
  for (let at = 0; at < buf.length; ) {
    try { at += fs.writeSync(1, buf, at); } catch (e) { if (e.code === 'EAGAIN') Atomics.wait(wait, 0, 0, 1); else throw e; }
  }
}
fs.writeFileSync(marker, 'done');
setTimeout(() => process.exit(0), 20000); // 시험이 실패해도 남지 않게
process.exit(0);
`;
const writerPath = path.join(root, 'writer.mjs');
writeFileSync(writerPath, WRITER);

describe.each(bothImplementations)('표준 출력 백프레셔 (%s)', (_name, spawnImpl) => {
  for (const [title, pull] of [
    ['messages()를 부르지 않는 동안', 0],
    ['줄 10개만 읽고 멈춘 동안', 10],
  ] as const) {
    it(`${title} 자식이 막혀 있고, 다 소비하면 순서대로 끝까지 온다 (20만 줄)`, async () => {
      const marker = path.join(root, `writer-${closeSeq++}.marker`);
      const proc = spawnImpl({ command: process.execPath, args: [writerPath, marker, '200000'], cwd: root, env: { ...process.env }, stop: { termAfterMs: 200, killAfterMs: 200 } });
      try {
        const seen: number[] = [];
        let iterator: AsyncIterator<CliMessage> | undefined;
        if (pull > 0) {
          iterator = proc.messages()[Symbol.asyncIterator]();
          for (let i = 0; i < pull; i++) seen.push(((await iterator.next()).value as { n: number }).n);
        }
        await new Promise((r) => setTimeout(r, 1200));
        expect(existsSync(marker), '소비하지 않는데 자식이 다 썼다(막히지 않았다)').toBe(false);
        iterator ??= proc.messages()[Symbol.asyncIterator]();
        const deadline = Date.now() + 40_000;
        for (;;) {
          if (Date.now() > deadline) throw new Error(`소비해도 끝나지 않는다(교착): ${seen.length}줄`);
          const next = await Promise.race([iterator.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`줄이 오지 않는다(교착): ${seen.length}줄`)), 15_000))]);
          if (next.done) break;
          seen.push((next.value as { n: number }).n);
        }
        expect(seen.length).toBe(200_000);
        expect(seen.every((n, i) => n === i + 1)).toBe(true);
        expect(existsSync(marker)).toBe(true);
        expect((await proc.exited).code).toBe(0);
      } finally {
        proc.stop('now');
        await proc.exited;
      }
    }, 90_000);
  }

  it('소비자가 없어 막힌 자식도 stop(now) 뒤에 끝난다', async () => {
    const marker = path.join(root, `writer-${closeSeq++}.marker`);
    const proc = spawnImpl({ command: process.execPath, args: [writerPath, marker, '2000000'], cwd: root, env: { ...process.env }, stop: { termAfterMs: 200, killAfterMs: 200 } });
    await new Promise((r) => setTimeout(r, 800));
    proc.stop('now');
    const exit = await proc.exited;
    expect(exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL').toBe(true);
  }, 30_000);
});

describe('새 구현만의 보장', () => {
  it('신호는 자기가 띄운 자식에게만 간다: 이웃 프로세스는 stop 뒤에도 산다', async () => {
    // 같은 시험 안에서 비슷한 자식을 둘 띄우고 하나만 stop한다
    const a = await launch(spawnClaudeCli, patientPath, { termAfterMs: 50, killAfterMs: 50 });
    const b = await launch(spawnClaudeCli, patientPath, { termAfterMs: 50, killAfterMs: 50 });
    a.proc.stop('now');
    expect(await a.proc.exited).toEqual({ code: null, signal: 'SIGTERM' });
    expect(alive(a.pid)).toBe(false);
    expect(alive(b.pid)).toBe(true);
    b.proc.stop('now');
    await b.proc.exited;
  });

  it('이미 끝난 자식에게 stop을 되풀이해도 그 pid에 신호를 보내지 않는다(거둔 pid는 재사용될 수 있다)', async () => {
    // 끝난 pid로 위장한 "이웃"을 띄워 두고, 끝난 자식의 stop이 이웃에 가지 않았음을 본다
    const neighbour = await launch(spawnClaudeCli, patientPath, { termAfterMs: 60_000, killAfterMs: 60_000 });
    const gone = await launch(spawnClaudeCli, politePath, { termAfterMs: 20, killAfterMs: 20 });
    gone.proc.closeInput();
    await gone.proc.exited;
    for (let i = 0; i < 5; i++) {
      gone.proc.stop(i % 2 ? 'now' : 'graceful');
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(alive(neighbour.pid)).toBe(true);
    neighbour.proc.stop('now');
    await neighbour.proc.exited;
  });
});

beforeAll(() => {
  // 자식 스크립트가 있는지 한 번 확인한다(없으면 모든 시험이 같은 이유로 실패한다)
  expect(existsSync(childPath)).toBe(true);
});
