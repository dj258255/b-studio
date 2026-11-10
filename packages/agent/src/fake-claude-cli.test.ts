import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';

/**
 * 가짜 CLI는 SIGTERM을 받으면 받은 신호를 더해 기록 파일을 다시 쓴다. 러너 시험은 곧이어 SIGKILL을 보내므로, 쓰는 도중에 죽어도
 * 읽는 쪽이 잘린 JSON을 보지 않아야 한다(CI에서 `Unexpected end of JSON input`으로 흔들렸다, 이슈 #1106).
 * 실제로 잘리는 창은 파일을 비운 뒤(open O_TRUNC) 다 쓰기 전까지라 아주 짧다. 시험은 `slowFlushMs`로 그 창을 넓힌다
 */
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude-cli.mjs');
const posixOnly = process.platform === 'win32' ? it.skip : it;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fake-cli-flush-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readRecord(file: string): { stdin?: unknown[] } | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { stdin?: unknown[] };
  } catch {
    return undefined;
  }
}

posixOnly('기록을 다시 쓰는 도중 SIGKILL을 맞아도 기록 파일은 늘 온전한 JSON이다', async () => {
  const scenario = path.join(dir, 'scenario.json');
  const prefix = path.join(dir, 'log');
  writeFileSync(scenario, JSON.stringify({ slowFlushMs: 300, turns: [[{ hang: true }]], invocations: [{ ignoreSigterm: true, hangAfterEof: true }] }));
  const child = spawn(process.execPath, [FIXTURE, scenario, prefix], { stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const logFile = `${prefix}.1.json`;
  child.stdin.write('{"type":"user"}\n');
  // 입력 줄까지 기록된 것을 본 뒤에 신호를 보낸다
  for (let i = 0; i < 300 && (readRecord(logFile)?.stdin?.length ?? 0) < 1; i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(readRecord(logFile)?.stdin?.length).toBe(1);
  child.kill('SIGTERM');
  // 다시 쓰기의 앞 절반을 쓰고 쉬는 동안에 죽인다
  await new Promise((r) => setTimeout(r, 120));
  child.kill('SIGKILL');
  await exited;
  const text = readFileSync(logFile, 'utf8');
  expect(() => JSON.parse(text), `기록 파일: ${text.slice(0, 80)}…(길이 ${text.length})`).not.toThrow();
}, 30_000);
