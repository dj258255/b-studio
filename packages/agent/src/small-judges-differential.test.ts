import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type Anthropic from '@anthropic-ai/sdk';
import { native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { normalizedDumpHash, pickStaleTemp, restoreDatabaseName } from './database-branches';
import { legacyKeptLines, legacyNormalizedDumpHashFromStream, legacyRestoreDatabaseName, legacySweepVictims } from './database-branches-legacy';
import { Gen } from './differential-kit';
import { legacySummarizeJsonContent } from './json-summary-legacy';
import { summarizeJsonContent } from './json-summary';
import { appendUserText, formatSteering } from './loop';
import { legacyAppendUserText, legacyFormatSteering } from './loop-legacy';
import { TaskGraphError, validateTaskGraph, type TaskNode } from './task-graph';
import { legacyValidateGraph } from './task-graph-legacy';

/**
 * 작은 판정 모음(ADR-191 3af)을 Rust로 옮기면서, 옛 TS 구현(`*-legacy.ts`)과 새 껍데기에 같은 무작위 입력을 넣어 견준다.
 * 크기는 환경 변수로 바꾼다: SMALL_JUDGES_DIFF_SEEDS(쉼표 목록), SMALL_JUDGES_DIFF_ITERATIONS, SMALL_JUDGES_DIFF_REPORT=1(분포 출력)
 * 열린 쪽으로 뒤집힌 수(옛 "바뀜" → 새 "바뀌지 않음", 옛 "지우지 않음" → 새 "지움", 옛 거절 → 새 통과)는 0이어야 한다.
 */
const SEEDS = (process.env['SMALL_JUDGES_DIFF_SEEDS'] ?? '1,7,42,2026').split(',').map(Number);
const ITERATIONS = Number(process.env['SMALL_JUDGES_DIFF_ITERATIONS'] ?? 1500);
const REPORT = process.env['SMALL_JUDGES_DIFF_REPORT'] === '1';
const TIMEOUT = 120_000;

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

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

function newKeptLines(chunks: readonly Buffer[]): string[] {
  const normalizer = new native.NativeDumpNormalizer();
  const parts = chunks.map((chunk) => normalizer.feed(chunk));
  parts.push(normalizer.finish());
  // 줄 끝 토큰: LF=`\n`, CR=`\r\r`, CRLF=`\r\n`
  const lines = Buffer.concat(parts).toString('utf8').split(/\r\r|\r\n|\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

const oldHash = (chunks: readonly Buffer[]) => legacyNormalizedDumpHashFromStream(Readable.from(chunks as Buffer[]));

function mutate(rng: Gen, dump: Dump): { kind: string; dump: Dump } {
  const copy: Dump = { lines: [...dump.lines], terminators: [...dump.terminators], finalTerminator: dump.finalTerminator };
  const kind = rng.pick(['restrictKey', 'editLine', 'dropLine', 'insertLine', 'terminator', 'eof', 'insertRestrict', 'restrictTerminator']);
  const at = copy.lines.length === 0 ? 0 : rng.int(copy.lines.length);
  switch (kind) {
    case 'restrictKey':
      copy.lines = copy.lines.map((line) => (/^\\(un)?restrict\s/.test(line) ? `${line.replace(/\S*$/, '')}${rng.text(['q', 'W', '9'], 1 + rng.int(5))}` : line));
      break;
    case 'editLine':
      if (copy.lines.length > 0) copy.lines[at] = `${copy.lines[at]}${rng.pick(['x', ' ', '\u200b', '\\'])}`;
      break;
    case 'dropLine':
      copy.lines.splice(at, 1);
      copy.terminators.splice(at, 1);
      break;
    case 'insertLine':
      copy.lines.splice(at, 0, rng.pick(LINE_PIECES));
      copy.terminators.splice(at, 0, rng.pick(TERMINATORS));
      break;
    case 'terminator':
      if (copy.lines.length > 0) copy.terminators[at] = rng.pick(TERMINATORS);
      break;
    case 'eof':
      copy.finalTerminator = !copy.finalTerminator;
      break;
    case 'insertRestrict':
      copy.lines.splice(at, 0, `\\restrict ${rng.text(['a', 'b'], 6)}`);
      copy.terminators.splice(at, 0, rng.pick(TERMINATORS));
      break;
    case 'restrictTerminator':
      copy.terminators = copy.terminators.map((term, index) => (/^\\(un)?restrict\s/.test(copy.lines[index] ?? '') ? rng.pick(TERMINATORS) : term));
      break;
  }
  return { kind, dump: copy };
}

describe('덤프 해시: 옛 readline 판정과 같은 줄을 남기고, 열린 쪽으로 뒤집히지 않는다', () => {
  it('남기는 줄 목록이 옛 판정과 같다(줄 끝 글자·마지막 줄은 해시에만 더 들어간다)', async () => {
    let cases = 0;
    let withRestrict = 0;
    let mismatches = 0;
    for (const seed of SEEDS) {
      const rng = new Gen(seed);
      for (let n = 0; n < ITERATIONS; n++) {
        const bytes = render(genDump(rng));
        const chunks = chunked(rng, bytes);
        const expected = await legacyKeptLines(Readable.from(chunks));
        const actual = newKeptLines(chunks);
        cases += 1;
        if (bytes.toString('utf8').includes('restrict')) withRestrict += 1;
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          mismatches += 1;
          if (mismatches <= 3) throw new Error(`줄 목록이 다릅니다 seed=${seed} n=${n} bytes=${JSON.stringify(bytes.toString('utf8'))}\n옛 ${JSON.stringify(expected)}\n새 ${JSON.stringify(actual)}`);
        }
      }
    }
    if (REPORT) console.log(`[덤프 줄] 사례 ${cases}, restrict 낱말이 든 덤프 ${withRestrict}, 다름 ${mismatches}`);
    expect(withRestrict).toBeGreaterThan(cases / 4);
    expect(mismatches).toBe(0);
  }, TIMEOUT);

  it('쌍 비교: 옛 "바뀜" → 새 "바뀌지 않음"은 0, 옛 "같음" → 새 "다름"은 줄 끝·마지막 줄 끝만 다른 쌍뿐', async () => {
    const tally = { pairs: 0, bothEqual: 0, bothDifferent: 0, openFlips: 0, closedFlips: 0, closedUnexplained: 0 } as Record<string, number>;
    const byKind: Record<string, { pairs: number; closed: number }> = {};
    for (const seed of SEEDS) {
      const rng = new Gen(seed);
      for (let n = 0; n < ITERATIONS; n++) {
        const a = genDump(rng);
        const { kind, dump: b } = mutate(rng, a);
        const aBytes = render(a);
        const bBytes = render(b);
        const aChunks = chunked(rng, aBytes);
        const bChunks = chunked(rng, bBytes);
        const oldEqual = (await oldHash(aChunks)) === (await oldHash(bChunks));
        const newEqual = newHash(aChunks) === newHash(bChunks);
        tally['pairs']! += 1;
        byKind[kind] ??= { pairs: 0, closed: 0 };
        byKind[kind]!.pairs += 1;
        if (oldEqual && newEqual) tally['bothEqual']! += 1;
        else if (!oldEqual && !newEqual) tally['bothDifferent']! += 1;
        else if (!oldEqual && newEqual) {
          tally['openFlips']! += 1;
          throw new Error(`열린 쪽으로 뒤집혔습니다(옛 바뀜 → 새 같음) seed=${seed} n=${n} kind=${kind}\nA=${JSON.stringify(aBytes.toString('utf8'))}\nB=${JSON.stringify(bBytes.toString('utf8'))}`);
        } else {
          tally['closedFlips']! += 1;
          byKind[kind]!.closed += 1;
          // 옛 판정이 같다고 본 쌍이 새 판정에서 다르면, 남는 줄은 같고 줄 끝 글자(또는 마지막 줄 끝 유무)만 달라야 한다
          const sameLines = JSON.stringify(newKeptLines(aChunks)) === JSON.stringify(newKeptLines(bChunks));
          if (!sameLines || !['terminator', 'eof', 'restrictTerminator', 'restrictKey', 'insertRestrict', 'dropLine', 'insertLine', 'editLine'].includes(kind)) tally['closedUnexplained']! += 1;
        }
      }
    }
    if (REPORT) console.log(`[덤프 쌍] ${JSON.stringify(tally)} 종류별 ${JSON.stringify(byKind)}`);
    expect(tally['pairs']).toBe(SEEDS.length * ITERATIONS);
    expect(tally['openFlips']).toBe(0);
    expect(tally['closedUnexplained']).toBe(0);
    expect(tally['bothEqual']).toBeGreaterThan(0);
    expect(tally['bothDifferent']).toBeGreaterThan(0);
    expect(tally['closedFlips']).toBeGreaterThan(0);
  }, TIMEOUT);

  it('잘못된 UTF-8 바이트가 다른 덤프는 옛 판정은 같게 보고 새 판정은 다르게 본다(닫는 쪽 차이), 파일 함수도 같은 값을 낸다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'small-judges-hash-'));
    try {
      const a = Buffer.from([0x61, 0xff, 0x62, 0x0a]);
      const b = Buffer.from([0x61, 0xfe, 0x62, 0x0a]);
      expect(await oldHash([a])).toBe(await oldHash([b]));
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

  it('대조 장치: 줄 끝 한 글자·경계를 바꾼 구현은 차이로 잡힌다', () => {
    const base = Buffer.from('a\nb\n');
    expect(newHash([base])).not.toBe(newHash([Buffer.from('a\nb')]));
    expect(newHash([base])).not.toBe(newHash([Buffer.from('a\r\nb\n')]));
    expect(newHash([Buffer.from('\\restrict k\nb\n')])).toBe(newHash([Buffer.from('b\n')]));
    expect(newHash([Buffer.from('\\restrictk\nb\n')])).not.toBe(newHash([Buffer.from('b\n')]));
  });
});

// ── 임시 DB 이름 ──────────────────────────────────────────────────────────────────────────────────
const NAME_PIECES = ['a', 'b', '_', '9', '가', '나', '😀', '\ud83d', '\ude00', '\ud800', '\udfff', '\ue000', '\ue010', '\ue011', '\ue01f', '\u00e9'];

describe('임시 DB 이름: 옛 slice와 글자 그대로 같다(서로게이트 쌍을 가르는 것까지)', () => {
  it('무작위 이름', () => {
    let cut = 0;
    let splitPair = 0;
    for (const seed of SEEDS) {
      const rng = new Gen(seed);
      for (let n = 0; n < ITERATIONS * 4; n++) {
        const name = rng.text(NAME_PIECES, rng.int(80));
        const expected = legacyRestoreDatabaseName(name);
        expect(restoreDatabaseName(name)).toBe(expected);
        if (name.length > 45) cut += 1;
        if (name.length > 45 && /[\ud800-\udbff]/.test(name.charAt(44)) && /[\udc00-\udfff]/.test(name.charAt(45))) splitPair += 1;
      }
    }
    if (REPORT) console.log(`[임시 DB 이름] 잘린 사례 ${cut}, 서로게이트 쌍을 가른 사례 ${splitPair}`);
    expect(cut).toBeGreaterThan(100);
    expect(splitPair).toBeGreaterThan(5);
  });

  it('대조 장치: 경계를 ±1 바꾼 구현은 차이로 잡힌다', () => {
    const name = 'x'.repeat(60);
    expect(restoreDatabaseName(name)).not.toBe(`${name.slice(0, 44)}__b_studio_restore`);
    expect(restoreDatabaseName(name)).not.toBe(`${name.slice(0, 46)}__b_studio_restore`);
  });
});

// ── 임시 파일 이름(지우는 코드) ────────────────────────────────────────────────────────────────────
const SHAS = ['abcdef0', '0123456789abcdef0123456789abcdef01234567', 'abcdef', 'ABCDEF0', '', 'a', 'g123456'];
const REASONS = ['save', 'changed', 'restore', 'SAVE', 'other', '', 'save '];
const PIDS = ['1', '7', '123', '2147483646', '2147483647', '2147483648', '4294967296', '99999999999999999999', '0', '00', '007', '-5', '+5', '0x10', '1e3', '1E3', ' 12', '12 ', '1_0', '١٢', '12.5', '', 'NaN', 'Infinity', '\u00a012', '12\u200b'];
const TIMES = ['1', '1700000000000', '', 'x', '1.5', '١'];
const ENDS = ['tmp', 'tmp', 'tmp', 'TMP', 'tmp ', 'tmp\u200b', 'tmp.bak', 'sql', ''];

function genTempName(rng: Gen): string {
  if (rng.chance(0.25)) return `${rng.pick(['abcdef0', '0123456789abcdef', 'deadbeef12'])}.${rng.pick(['save', 'changed', 'restore'])}.${rng.pick(['1', '7', '12', '123', '1000', '2147483646', '2147483647', '99999'])}.${rng.pick(['1', '1700000000000'])}.tmp`;
  const parts = [rng.pick(SHAS), rng.pick(REASONS), rng.pick(PIDS), rng.pick(TIMES), rng.pick(ENDS)];
  if (rng.chance(0.1)) parts.shift();
  if (rng.chance(0.1)) parts.splice(rng.int(parts.length), 1);
  if (rng.chance(0.05)) parts.unshift('extra');
  if (rng.chance(0.03)) return rng.pick(['x.tmp', 'notes.tmp', '.tmp', 'a.b.tmp', 'a..tmp', 'dump.sql', '\ud800.tmp', `${parts.join('.')}\ud800`]);
  return parts.join('.');
}

describe('임시 파일 이름: 지우는 이름은 옛 판정의 부분집합이고, 우리가 쓰는 꼴은 옛 판정과 같다', () => {
  it('무작위 이름과 무작위 "살아 있는 pid" 집합', () => {
    const tally = { names: 0, oldDeletes: 0, newDeletes: 0, openFlips: 0, closedFlips: 0, canonical: 0, canonicalMismatch: 0 };
    const CANONICAL = /^[0-9a-f]{7,40}\.(save|changed|restore)\.[1-9][0-9]{0,9}\.[0-9]+\.tmp$/;
    for (const seed of SEEDS) {
      const rng = new Gen(seed);
      for (let n = 0; n < ITERATIONS; n++) {
        const names = Array.from({ length: 1 + rng.int(12) }, () => genTempName(rng));
        const alive = new Set([1, 7, 123, 12, 16, 1000, 5, 2147483646].filter(() => rng.chance(0.4)));
        const oldVictims = new Set(legacySweepVictims(names, (pid) => pid !== undefined && alive.has(pid)));
        const newVictims = new Set(pickStaleTemp(names, (pid) => alive.has(pid)));
        for (const name of names) {
          tally.names += 1;
          const oldDeletes = oldVictims.has(name);
          const newDeletes = newVictims.has(name);
          if (oldDeletes) tally.oldDeletes += 1;
          if (newDeletes) tally.newDeletes += 1;
          if (!oldDeletes && newDeletes) {
            tally.openFlips += 1;
            throw new Error(`옛 "지우지 않음"이 새 "지움"으로 뒤집혔습니다: ${JSON.stringify(name)}`);
          }
          if (oldDeletes && !newDeletes) tally.closedFlips += 1;
          if (CANONICAL.test(name) && Number(name.split('.')[2]) <= 2147483647) {
            tally.canonical += 1;
            if (oldDeletes !== newDeletes) tally.canonicalMismatch += 1;
          }
        }
      }
    }
    if (REPORT) console.log(`[임시 파일] ${JSON.stringify(tally)}`);
    expect(tally.openFlips).toBe(0);
    expect(tally.canonicalMismatch).toBe(0);
    expect(tally.canonical).toBeGreaterThan(100);
    expect(tally.closedFlips).toBeGreaterThan(100);
    expect(tally.newDeletes).toBeGreaterThan(100);
  });

  it('대조 장치: 지우는 쪽으로 넓힌 판정(옛 판정 그대로)은 차이로 잡힌다', () => {
    const names = ['x.tmp', 'abcdef0.save.0x10.1.tmp', 'abcdef0.save.123.1.tmp'];
    expect(legacySweepVictims(names, () => false)).toEqual(names);
    expect(pickStaleTemp(names, () => false)).toEqual(['abcdef0.save.123.1.tmp']);
  });
});

// ── 작업 그래프 ───────────────────────────────────────────────────────────────────────────────────
const IDS = ['a', 'b', 'c', 'd', 'e', 'f', '가', '😀', '\ud800', '\udc00', '\ud800\udc00', '\ue010', '\ue011', "it's", ''];

function genGraph(rng: Gen): TaskNode[] {
  const ids = rng.chance(0.85) ? Array.from(new Set(Array.from({ length: 1 + rng.int(7) }, () => rng.pick(IDS)))) : Array.from({ length: 1 + rng.int(6) }, () => rng.pick(IDS));
  const dag = rng.chance(0.5);
  return ids.map((id, index) => {
    const pool = dag ? ids.slice(0, index) : ids;
    const deps = rng.list(0, 3, () => (rng.chance(0.05) ? rng.pick(IDS) : pool.length > 0 ? rng.pick(pool) : id));
    return { id, dependsOn: rng.chance(0.2) ? undefined : deps, run: async () => undefined };
  });
}

const graphOutcome = (fn: () => void): string => {
  try {
    fn();
    return 'ok';
  } catch (error) {
    return `${(error as Error).constructor.name}:${(error as Error).message}`;
  }
};

describe('작업 그래프: 옛 검증과 같은 메시지로 같은 그래프를 거절한다', () => {
  it('무작위 그래프', () => {
    const tally: Record<string, number> = { graphs: 0, ok: 0, duplicate: 0, missing: 0, cycle: 0, mismatch: 0, openFlips: 0 };
    for (const seed of SEEDS) {
      const rng = new Gen(seed);
      for (let n = 0; n < ITERATIONS * 2; n++) {
        const nodes = genGraph(rng);
        const expected = graphOutcome(() => legacyValidateGraph(nodes));
        const actual = graphOutcome(() => validateTaskGraph(nodes));
        tally['graphs']! += 1;
        if (expected === 'ok') tally['ok']! += 1;
        else if (expected.includes('중복')) tally['duplicate']! += 1;
        else if (expected.includes('없는 의존성')) tally['missing']! += 1;
        else tally['cycle']! += 1;
        if (expected !== 'ok' && actual === 'ok') tally['openFlips']! += 1;
        if (expected !== actual) {
          tally['mismatch']! += 1;
          if (tally['mismatch']! <= 3) throw new Error(`그래프 판정이 다릅니다: ${JSON.stringify(nodes.map((node) => [node.id, node.dependsOn]))}\n옛 ${expected}\n새 ${actual}`);
        }
      }
    }
    if (REPORT) console.log(`[작업 그래프] ${JSON.stringify(tally)}`);
    expect(tally['openFlips']).toBe(0);
    expect(tally['mismatch']).toBe(0);
    for (const key of ['ok', 'duplicate', 'missing', 'cycle']) expect(tally[key]).toBeGreaterThan(20);
  });

  it('의도한 차이: 아주 긴 의존 사슬은 옛 재귀가 RangeError로 던지고 새 판정은 통과·거절을 바르게 낸다', () => {
    const n = 60_000;
    const chain: TaskNode[] = Array.from({ length: n }, (_, i) => ({ id: String(i), dependsOn: i === 0 ? [] : [String(i - 1)], run: async () => undefined }));
    // 사슬의 끝에서부터 방문해야 깊이가 깊어지므로 거꾸로 놓는다
    const reversed = [...chain].reverse();
    expect(graphOutcome(() => legacyValidateGraph(reversed))).toMatch(/^RangeError/);
    expect(graphOutcome(() => validateTaskGraph(reversed))).toBe('ok');
    reversed.find((node) => node.id === '0')!.dependsOn = [String(n - 1)];
    expect(graphOutcome(() => validateTaskGraph(reversed))).toMatch(/^TaskGraphError:순환 의존성이 있습니다: /);
  });

  it('TaskGraphError를 던진다', () => {
    expect(() => validateTaskGraph([{ id: 'a', dependsOn: ['a'], run: async () => undefined }])).toThrow(TaskGraphError);
  });
});

// ── 진행 중 지시 ──────────────────────────────────────────────────────────────────────────────────
type Message = Anthropic.Beta.BetaMessageParam;
const TEXTS = ['', 'a', '지시 하나', 'x\ny', '😀', '\ud83d', '\ude00', '\ue010', '\ue011\ue000\ue001', '[진행 중 지시] 이미'];

describe('진행 중 지시: 옛 글·메시지 배열 변경과 같다', () => {
  it('formatSteering', () => {
    for (const seed of SEEDS) {
      const rng = new Gen(seed);
      for (let n = 0; n < ITERATIONS; n++) {
        const texts = rng.list(0, 4, () => rng.pick(TEXTS));
        expect(formatSteering(texts)).toBe(legacyFormatSteering(texts));
      }
    }
  });

  it('appendUserText', () => {
    const tally: Record<string, number> = { string: 0, array: 0, other: 0, assistant: 0, empty: 0 };
    for (const seed of SEEDS) {
      const rng = new Gen(seed);
      for (let n = 0; n < ITERATIONS; n++) {
        const make = (): Message[] => {
          const kind = rng.pick(['string', 'array', 'other', 'assistantString', 'assistantArray', 'empty']);
          const base: Message[] = rng.chance(0.5) ? [{ role: 'assistant', content: '앞' }] : [];
          switch (kind) {
            case 'string':
              return [...base, { role: 'user', content: rng.pick(TEXTS) }];
            case 'array':
              return [...base, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: rng.pick(TEXTS) }] }];
            case 'other':
              return [...base, { role: 'user', content: undefined as unknown as string }];
            case 'assistantString':
              return [...base, { role: 'assistant', content: rng.pick(TEXTS) }];
            case 'assistantArray':
              return [...base, { role: 'assistant', content: [{ type: 'text', text: 'x' }] }];
            default:
              return [];
          }
        };
        const seedState = rng.int(1_000_000);
        const rngCopy = new Gen(seedState);
        void rngCopy;
        const messages = make();
        const text = rng.pick(TEXTS);
        const before = structuredClone(messages);
        const legacyMessages = structuredClone(before);
        const newMessages = structuredClone(before);
        legacyAppendUserText(legacyMessages, text);
        appendUserText(newMessages, text);
        expect(JSON.stringify(newMessages)).toBe(JSON.stringify(legacyMessages));
        const last = before.at(-1);
        if (!last) tally['empty']! += 1;
        else if (last.role !== 'user') tally['assistant']! += 1;
        else if (typeof last.content === 'string') tally['string']! += 1;
        else if (Array.isArray(last.content)) tally['array']! += 1;
        else tally['other']! += 1;
      }
    }
    if (REPORT) console.log(`[appendUserText] ${JSON.stringify(tally)}`);
    for (const key of Object.keys(tally)) expect(tally[key]).toBeGreaterThan(20);
  });
});

// ── JSON 요약 ─────────────────────────────────────────────────────────────────────────────────────
const KEYS = ['a', 'b', 'id', 'name', '1', '2', '10', '0', '-1', '01', '__proto__', 'constructor', '가', '😀', '\\ud83d', '\\ude00', '\\ud800\\udc00', '\\u0000', '', 'a b', '\\"', '\\\\', '\\u00e9', '\ue010', '\\ue011'];

function genJsonValue(rng: Gen, depth: number): string {
  const kind = rng.weighted<string>([
    [3, 'num'],
    [2, 'str'],
    [1, 'bool'],
    [1, 'null'],
    [depth > 3 ? 0 : 3, 'arr'],
    [depth > 3 ? 0 : 3, 'obj'],
  ]);
  switch (kind) {
    case 'num':
      return rng.pick(['0', '-0', '1', '-1', '1.5', '1e3', '1E+2', '1e-7', '123456789012345678901234567890', '1e999', '-1e999', '0.1', '5e-324', '1.7976931348623157e308', '100000000000000000000', '1e21', '0.000001']);
    case 'str':
      return `"${rng.pick(['', 'x', '가나', '\\ud83d', '\\ud83d\\ude00', '\\u0041', '\\n', '\\/', '\ue010'])}"`;
    case 'bool':
      return rng.pick(['true', 'false']);
    case 'null':
      return 'null';
    case 'arr': {
      const count = rng.pick([0, 0, 1, 2, 3, 5, 1000, 1001, 1234567 > 0 ? 2076 : 0]);
      if (count > 5) return `[${new Array(count).fill('0').join(',')}]`;
      return `[${Array.from({ length: count }, () => genJsonValue(rng, depth + 1)).join(rng.pick([',', ' , ', ',\n']))}]`;
    }
    default: {
      const count = rng.pick([0, 1, 2, 3, 4, 6]);
      return `{${Array.from({ length: count }, () => `"${rng.pick(KEYS)}":${genJsonValue(rng, depth + 1)}`).join(',')}}`;
    }
  }
}

function genJsonText(rng: Gen): string {
  let text = genJsonValue(rng, 0);
  if (rng.chance(0.25)) {
    text = rng.pick<(t: string) => string>([
      (t) => t.slice(0, Math.max(0, t.length - 1 - rng.int(3))),
      (t) => `${t},`,
      (t) => `${t} x`,
      (t) => `\ufeff${t}`,
      (t) => `\u00a0${t}`,
      (t) => `\u2028${t}`,
      (t) => `\f${t}`,
      (t) => t.replace(/,/, ',,'),
      (t) => t.replace(/"/, "'"),
      (t) => t.replace(/\[/, '[,'),
      (t) => t.replace(/0/, '00'),
      (t) => t.replace(/1/, '+1'),
      (t) => t.replace(/:/, ' : '),
      (t) => `${t}\n`,
      (t) => `  ${t}\t\r\n`,
      (t) => t.replace(/"/, '"\n'),
      (t) => t.replace(/"/, '"\\x'),
      (t) => t.replace(/"/, '"\\u12'),
      (t) => t.replace(/\{/, '{"k":1,"k":2,'),
      (t) => `// c\n${t}`,
      (t) => `NaN`,
      (t) => ``,
    ])(text);
  }
  return text;
}

describe('JSON 요약: 옛 JSON.parse 기반 요약과 글자 그대로 같다', () => {
  it('무작위 JSON 글', () => {
    const tally: Record<string, number> = { texts: 0, summarized: 0, undefinedBoth: 0, mismatch: 0, onlyOldUndefined: 0, onlyNewUndefined: 0 };
    for (const seed of SEEDS) {
      const rng = new Gen(seed);
      for (let n = 0; n < ITERATIONS * 2; n++) {
        const text = genJsonText(rng);
        const expected = legacySummarizeJsonContent(text);
        const actual = summarizeJsonContent(text);
        tally['texts']! += 1;
        if (expected === undefined && actual === undefined) tally['undefinedBoth']! += 1;
        else if (expected !== undefined && actual !== undefined) tally['summarized']! += 1;
        else if (expected === undefined) tally['onlyOldUndefined']! += 1;
        else tally['onlyNewUndefined']! += 1;
        if (expected !== actual) {
          tally['mismatch']! += 1;
          if (tally['mismatch']! <= 3) throw new Error(`요약이 다릅니다: ${JSON.stringify(text)}\n옛 ${JSON.stringify(expected)}\n새 ${JSON.stringify(actual)}`);
        }
      }
    }
    if (REPORT) console.log(`[JSON 요약] ${JSON.stringify(tally)}`);
    expect(tally['mismatch']).toBe(0);
    expect(tally['summarized']).toBeGreaterThan(1000);
    expect(tally['undefinedBoth']).toBeGreaterThan(100);
  });

  it('의도한 차이: 너무 깊게 중첩한 글은 새 요약이 undefined(옛 요약은 읽는다)', () => {
    const deep = `${'['.repeat(3000)}${']'.repeat(3000)}`;
    expect(legacySummarizeJsonContent(deep)).toBe('배열, 1개 항목');
    expect(summarizeJsonContent(deep)).toBeUndefined();
  });
});
