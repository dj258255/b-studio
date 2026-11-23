import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { normalizedDumpHash } from './database-branches';
import { Gen } from './differential-kit';
import { summarizeJsonContent } from './json-summary';
import { TaskGraphError, validateTaskGraph, type TaskNode } from './task-graph';

/**
 * 작은 판정 모음(ADR-191 3af)에서 새 구현만으로 확인하는 것: 잘못된 UTF-8 덤프 해시, 아주 긴 의존 사슬, 너무 깊게 중첩한 JSON 요약.
 * 옛 TS 사본과 무작위로 견주던 시험(`small-judges-differential.test.ts`)에서 사본과 무관한 확인만 남겼다(#1347).
 */
const TIMEOUT = 120_000;

// ── 덤프 해시 ─────────────────────────────────────────────────────────────────────────────────────
const LINE_PIECES = [
  'SELECT 1;',
  'COPY public.t (id, name) FROM stdin;',
  '1\t한글 이름\t\\N',
  '\\.',
  '',
  ' ',
  '--',
  'CREATE TABLE public.t (',
  '\\restrict ',
  '\\restrict',
  '\\restricted x',
  '\\Restrict x',
  ' \\restrict x',
  '\\\\restrict x',
  '\\unrestrict ',
  '\\unrestrict\u00a0',
  '\\restrict\u2028x',
  '\\restrict\u3000x',
  '\\restrict\ufeffx',
  '\\restrict\u0085x',
  '\\restrict\tx',
  '😀 이모지',
  'a\u2028b',
  'a\u0085b',
  '\ufeffbom',
  'x'.repeat(40),
];
const TERMINATORS = ['\n', '\n', '\n', '\r\n', '\r'];


interface Dump {
  lines: string[];
  terminators: string[];
  /** 마지막 줄 뒤에 줄 끝이 있는가 */
  finalTerminator: boolean;
}

function genDump(rng: Gen): Dump {
  const count = rng.int(8);
  const lines = Array.from({ length: count }, () => {
    const base = rng.pick(LINE_PIECES);
    if (/restrict/.test(base) && rng.chance(0.7)) return `${base}${rng.text(['a', 'B', '3', 'z'], 1 + rng.int(8))}`;
    return rng.chance(0.2) ? `${base}${rng.int(100)}` : base;
  });
  return { lines, terminators: lines.map(() => rng.pick(TERMINATORS)), finalTerminator: rng.chance(0.8) };
}

function render(dump: Dump): Buffer {
  let text = '';
  dump.lines.forEach((line, index) => {
    const last = index === dump.lines.length - 1;
    text += line;
    if (!last || dump.finalTerminator) text += dump.terminators[index];
  });
  return Buffer.from(text, 'utf8');
}

function chunked(rng: Gen, bytes: Buffer): Buffer[] {
  if (rng.chance(0.3) || bytes.length === 0) return [bytes];
  const chunks: Buffer[] = [];
  let at = 0;
  while (at < bytes.length) {
    const size = 1 + rng.int(Math.max(1, Math.min(12, bytes.length)));
    chunks.push(bytes.subarray(at, at + size));
    at += size;
  }
  return chunks;
}

function newHash(chunks: readonly Buffer[]): string {
  const normalizer = new native.NativeDumpNormalizer();
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(normalizer.feed(chunk));
  hash.update(normalizer.finish());
  return hash.digest('hex');
}


describe('덤프 해시', () => {
  it('잘못된 UTF-8 바이트가 다른 덤프는 새 판정이 다르게 본다, 파일 함수도 같은 값을 낸다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'small-judges-hash-'));
    try {
      const a = Buffer.from([0x61, 0xff, 0x62, 0x0a]);
      const b = Buffer.from([0x61, 0xfe, 0x62, 0x0a]);
      expect(newHash([a])).not.toBe(newHash([b]));
      await writeFile(path.join(dir, 'a.sql'), a);
      expect(await normalizedDumpHash(path.join(dir, 'a.sql'))).toBe(newHash([a]));
      // 파일 함수는 한 번에 읽은 조각 나누기와 무관하게 같은 값이다
      const rng = new Gen(5);
      for (let n = 0; n < 60; n++) {
        const bytes = render(genDump(rng));
        await writeFile(path.join(dir, 'x.sql'), bytes);
        expect(await normalizedDumpHash(path.join(dir, 'x.sql'))).toBe(newHash(chunked(rng, bytes)));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, TIMEOUT);
});

const graphOutcome = (fn: () => void): string => {
  try {
    fn();
    return 'ok';
  } catch (error) {
    return `${(error as Error).constructor.name}:${(error as Error).message}`;
  }
};

describe('작업 그래프', () => {
  it('아주 긴 의존 사슬도 통과·거절을 바르게 낸다', () => {
    const n = 60_000;
    const chain: TaskNode[] = Array.from({ length: n }, (_, i) => ({ id: String(i), dependsOn: i === 0 ? [] : [String(i - 1)], run: async () => undefined }));
    // 사슬의 끝에서부터 방문해야 깊이가 깊어지므로 거꾸로 놓는다
    const reversed = [...chain].reverse();
    expect(graphOutcome(() => validateTaskGraph(reversed))).toBe('ok');
    reversed.find((node) => node.id === '0')!.dependsOn = [String(n - 1)];
    expect(graphOutcome(() => validateTaskGraph(reversed))).toMatch(/^TaskGraphError:순환 의존성이 있습니다: /);
  });

  it('TaskGraphError를 던진다', () => {
    expect(() => validateTaskGraph([{ id: 'a', dependsOn: ['a'], run: async () => undefined }])).toThrow(TaskGraphError);
  });
});

describe('JSON 요약', () => {
  it('너무 깊게 중첩한 글은 새 요약이 undefined다', () => {
    const deep = `${'['.repeat(3000)}${']'.repeat(3000)}`;
    expect(summarizeJsonContent(deep)).toBeUndefined();
  });
});
