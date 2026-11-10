/**
 * 모델 답 읽기(ADR-191 3단계 3ad)를 Rust로 옮기면서, 옛 TS(`requirements-replies-legacy.ts`: 옮기기 전 `parsePlannerReply`·`repairExtractionReply`·`enforceSpecQuoteEvidence`·`firstLinesPreview`·
 * `addUsage`·참조 파일 상한 문구·JSON 파일 이름 판정)와 지금의 껍데기에 같은 무작위 입력(시드 고정)을 넣어 견준다. 결과는 `JSON.stringify` 글자(키 순서·짝 없는 서로게이트 이스케이프 포함)로 견준다.
 *
 * - 답 읽기: 코드 펜스·`json` 표지·공백 종류·짝 없는 서로게이트·예약 글자·깨진 JSON(jsonrepair 경로)을 이어 붙인 글에서 같은 값 또는 같은 오류 문구가 나와야 한다.
 * - 고치기: 목록 상한·null 항목·떨어진 인수 조건·시나리오 id 맞추기·배열/문자열/null이 섞인 모양에서 결과가 글자까지 같아야 한다.
 * - 인용 강등(여는 쪽): 옛 "근거 없음(practice)" → 새 "근거 있음(spec)" 뒤집힘(`flips`)은 0이어야 한다. 옛 "있음" → 새 "없음"은 낱말 중간을 자른 ASCII 인용뿐이어야 하고(`closed`), JS로 따로 쓴 같은 규칙(`oracle`)과 새 구현이 글자까지 같아야 한다.
 * - 미리보기·상한 문구·JSON 이름·사용량 합: 글자(숫자는 `Object.is`)까지 같아야 한다.
 * 환경 변수: `REQ_REPLIES_DIFF_SEEDS`(쉼표 목록), `REQ_REPLIES_DIFF_N`(시드·함수마다 입력 수).
 */
import { isDeepStrictEqual } from 'node:util';
import { encodeLoneSurrogates, native } from '@b-studio/sandbox';
import { describe, expect, it, vi } from 'vitest';
import { Gen, perturb, readEnvList, readEnvNumber } from './differential-kit';
import * as old from './requirements-replies-legacy';
import * as cur from './requirements';
import { decodeLoneSurrogates } from './lone-surrogates';
import { parsePlannerReply } from './task-plan';

const SEEDS = readEnvList('REQ_REPLIES_DIFF_SEEDS', [1, 7, 42, 2026]);
const N = readEnvNumber('REQ_REPLIES_DIFF_N', 1500);
vi.setConfig({ testTimeout: 3_600_000 });

type Out = { threw: true; message: string } | { threw: false; value: string };

function run(fn: () => unknown): Out {
  try {
    const value = fn();
    return { threw: false, value: `${typeof value}:${JSON.stringify(value)}` };
  } catch (error) {
    return { threw: true, message: error instanceof Error ? error.message : String(error) };
  }
}

const same = (a: Out, b: Out): boolean => isDeepStrictEqual(a, b);

// ───────────────────────── 답에서 JSON 꺼내기 ─────────────────────────

const REPLY_PIECES = [
  '```json\n', '```json', '```JSON\n', '```\n', '```', '````', '`', '``', 'json', '{"a":1}', '{"requirements":[', '{"a":"x"}', '{', '}', '{}', '[1,2]', '"x"', ',', ']', ' ', '\n', '\r\n', '\t', ' ', '﻿', ' ', '　',
  '앞 설명입니다.', 'x', '{"a":"b"c"}', '{"a":[1,2,}', '{"a":1,}', "{'a':1}", '"unterminated', 'null', '\\', '\ud800', '\udc00', '😀', '', '', '', '{"s":"\ud800"}', '{"k\udc00":1}',
];

function genReply(g: Gen): string {
  const count = 1 + g.int(10);
  let out = '';
  for (let i = 0; i < count; i++) out += g.pick(REPLY_PIECES);
  return out;
}

// ───────────────────────── 고치기 ─────────────────────────

const STRS = ['', 'a', 'R1', 'R2', 'R1.1', 'R9.1', 'R9.2', 'R1.x', 'x', '로그인', '\ud800', 'a\udc00', '😀', '', '"q"'];
const IDS = ['R1', 'R2', 'R10', 'R1.1', '', 'x', '\ud800'];
const SCENARIO_IDS = ['R1.1', 'R1.2', 'R2.1', 'R9.1', 'R9.2', 'R9.3', 'S.5', 'x', '', 'R1.0', 'R1.01', 'R1.007', 'R1.-3', 'R1.', '\ud800', 'R1.1٠'];

function genValue(g: Gen, depth = 0): unknown {
  const roll = g.int(depth > 1 ? 6 : 9);
  switch (roll) {
    case 0: return g.pick(STRS);
    case 1: return g.pick([0, 1, -0, 1.5, 1e21, 99999999999999999999, -1]);
    case 2: return g.pick([true, false]);
    case 3: return null;
    case 4: return g.pick(STRS);
    case 5: return g.pick([0, 7]);
    case 6: return g.list(0, 3, () => genValue(g, depth + 1));
    case 7: return Object.fromEntries(g.list(0, 3, () => [g.pick(['a', 'b', 'k\ud800', '0', '1', 'id', 'x y']), genValue(g, depth + 1)] as const));
    default: return { items: g.list(0, 2, () => genValue(g, depth + 1)) };
  }
}

function genScenarios(g: Gen): unknown {
  return g.weighted<() => unknown>([
    [3, () => null],
    [1, () => []],
    [1, () => 'text'],
    [8, () => {
      const ids: string[] = [];
      return g.list(1, 4, () => {
        let id = g.pick(SCENARIO_IDS);
        // 같은 큰 수가 둘이면 옛 TS의 "다음 빈 번호" 반복이 끝나지 않는다(옛 구현의 한계) — 겹치지 않게 한다
        if (ids.includes(id)) id = `${id}-${ids.length}`;
        ids.push(id);
        return { id, given: g.pick(STRS), when: 'w', then: 't' };
      });
    }],
    [2, () => g.list(1, 3, () => g.pick<unknown>([{ id: 'R1.1' }, { id: 5 }, { given: 'x' }, null, 'R1.1', ['R1.1'], { id: 'R1.2' }]))],
    [1, () => g.list(21, 23, (): unknown => ({ id: `R1.${1 + g.int(30)}` }))],
  ])();
}

function genRequirement(g: Gen): unknown {
  if (g.chance(0.06)) return g.pick<unknown>(['R1', null, 5, [], ['R1'], true, [{ id: 'R1' }]]);
  const requirement: Record<string, unknown> = {};
  if (g.chance(0.92)) requirement.id = g.chance(0.05) ? g.pick<unknown>([5, null, ['R1']]) : g.pick(IDS);
  if (g.chance(0.9)) requirement.title = g.pick(STRS);
  if (g.chance(0.85)) {
    requirement.acceptance = g.weighted<() => unknown>([
      [4, () => g.list(0, 3, () => g.pick(STRS))],
      [4, () => g.list(1, 4, () => (g.chance(0.5) ? g.pick(STRS) : genValue(g)))],
      [1, () => null],
      [1, () => 'text'],
      [1, () => [{ x: 1 }, 'a', { y: [1, { z: '\ud800' }] }]],
    ])();
  }
  if (g.chance(0.6)) requirement.scenarios = genScenarios(g);
  for (const key of ['ears', 'nfr', 'trace', 'rev', 'hash', 'revisedAt']) {
    if (g.chance(0.35)) requirement[key] = g.chance(0.6) ? null : genValue(g);
  }
  if (g.chance(0.2)) requirement.extra = genValue(g);
  if (g.chance(0.03)) Object.defineProperty(requirement, '__proto__', { value: genValue(g), enumerable: true, configurable: true, writable: true });
  return requirement;
}

function genList(g: Gen, max: number): unknown {
  return g.weighted<() => unknown>([
    [6, () => g.list(0, max - 1, () => g.pick(STRS))],
    [2, () => g.list(max, max + 1, () => g.pick(STRS))],
    [1, () => g.list(max + 2, max + 6, () => g.pick(STRS))],
    [1, () => null],
    [1, () => g.pick<unknown>(['text', 5, {}, true])],
    [2, () => g.list(0, 2, () => genValue(g))],
  ])();
}

function genRaw(g: Gen): unknown {
  if (g.chance(0.04)) return g.pick<unknown>([[], [1, { a: 1 }], [{ requirements: [] }]]);
  const raw: Record<string, unknown> = {};
  if (g.chance(0.95)) {
    raw.requirements = g.weighted<() => unknown>([
      [8, () => g.list(0, 3, () => genRequirement(g))],
      [1, () => Array.from({ length: 60 + g.int(4) }, (_, i) => ({ id: `R${i + 1}`, title: 't' }))],
      [1, () => null],
      [1, () => g.pick<unknown>(['x', {}, 5])],
    ])();
  }
  raw.questions = genList(g, 5);
  if (g.chance(0.85)) raw.outOfScope = genList(g, 20);
  if (g.chance(0.85)) raw.assumptions = genList(g, 10);
  if (g.chance(0.85)) raw.manualSteps = genList(g, 20);
  if (g.chance(0.2)) raw.extra = genValue(g);
  if (g.chance(0.03)) Object.defineProperty(raw, '__proto__', { value: genValue(g), enumerable: true, configurable: true, writable: true });
  return raw;
}

// ───────────────────────── 인용 ─────────────────────────

const SPEC_WORDS = ['사용자는', '로그인한다', 'the', 'user', 'API', 'v2', 'id', 'id_1', '10', '1', '연', '10회', '연 10회', 'JWT를', '비밀번호', 'a', 'e', 'x', '·', '-', '_', '\ud800', '\udc00', '😀', '', '', 'ſ', 'K', '결제'];
const SPACES = [' ', ' ', ' ', '  ', '\n', '\t', ' ', '﻿', ' ', '　', '\r\n', '​'];

function genSpec(g: Gen): string {
  const count = 1 + g.int(10);
  let out = '';
  for (let i = 0; i < count; i++) out += (i === 0 && g.chance(0.5) ? '' : g.pick(SPACES)) + g.pick(SPEC_WORDS);
  return out;
}

function genQuote(g: Gen, spec: string): string {
  const roll = g.int(10);
  const chars = [...spec];
  if (roll === 0) return '';
  if (roll === 1) return g.pick(SPACES);
  if (roll === 2) return genSpec(g);
  if (chars.length === 0) return 'x';
  const from = g.int(chars.length);
  const to = from + 1 + g.int(Math.min(chars.length - from, 12));
  let quote = chars.slice(from, to).join('');
  if (roll === 3) quote = quote.toUpperCase();
  if (roll === 4) quote = quote.replace(/\s+/g, g.pick(SPACES));
  if (roll === 5) quote = g.pick(SPACES) + quote + g.pick(SPACES);
  if (roll === 6) quote = quote.replace(/ /g, '');
  return quote;
}

/** 새 규칙을 JS로 따로 쓴 것: 공백을 접은 부분 문자열이면서, 인용의 앞·끝이 ASCII 낱말 글자일 때 그 옆도 낱말 글자인 자리는 세지 않는다. 짝 없는 서로게이트는 단사 인코딩으로 견준다 */
function oracle(quote: string, spec: string): boolean {
  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
  const q = collapse(encodeLoneSurrogates(quote));
  if (!q) return false;
  const t = collapse(encodeLoneSurrogates(spec));
  const word = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
  for (let at = t.indexOf(q); at !== -1; at = t.indexOf(q, at + 1)) {
    const cutBefore = word(q[0]) && word(t[at - 1]);
    const cutAfter = word(q[q.length - 1]) && word(t[at + q.length]);
    if (!cutBefore && !cutAfter) return true;
  }
  return false;
}

interface Rec { question: string; answer: string; rationale: string; basis: unknown; specQuote?: string; sources?: unknown }

function recommendReplyText(g: Gen, spec: string): string {
  const recs: Rec[] = g.list(1, 5, () => {
    const rec: Rec = { question: 'q', answer: 'a', rationale: 'r', basis: g.weighted<unknown>([[7, 'spec'], [3, 'practice'], [1, 'other'], [1, null]]) };
    if (g.chance(0.85)) rec.specQuote = genQuote(g, spec);
    if (g.chance(0.2)) rec.sources = [{ url: 'https://x.dev' }];
    return rec;
  });
  return `설명\n\`\`\`json\n${JSON.stringify({ recommendations: recs })}\n\`\`\``;
}

/** 옛 구현으로 같은 일을 한 것: 옛 답 읽기 → 같은 zod → 옛 강등 */
function legacyRecommend(text: string, spec: string): unknown {
  const raw = old.parsePlannerReplyLegacy(text);
  const result = cur.RecommendationReplySchema.safeParse(raw);
  if (!result.success) throw new cur.RequirementsError(`추천 응답 형식이 올바르지 않습니다: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  const parsed = result.data;
  return { recommendations: old.enforceSpecQuoteEvidenceLegacy(parsed.recommendations as old.Recommendation[], spec) };
}

// ───────────────────────── 시험 ─────────────────────────

const stats = {
  reply: { values: 0, threw: 0, fenced: 0, repaired: 0 },
  repair: { runs: 0, changed: 0, threw: 0 },
  recommend: { runs: 0, ok: 0, threw: 0, demotedBoth: 0, flips: 0, closed: 0, specKept: 0 },
  quote: { runs: 0, trueBoth: 0, falseBoth: 0, closed: 0, flips: 0 },
  preview: { runs: 0, truncated: 0, multiline: 0 },
  misc: { tooBig: 0, tooBigNone: 0, json: 0, nonJson: 0, usage: 0 },
};

describe('모델 답 읽기: 옛 TS와 같은 결과', () => {
  it('답에서 JSON을 꺼내 읽는다(값 또는 오류 문구가 같다)', () => {
    let runs = 0;
    for (const seed of SEEDS) {
      const g = new Gen(seed * 11 + 1);
      for (let i = 0; i < N; i++) {
        const text = genReply(g);
        const legacy = run(() => old.parsePlannerReplyLegacy(text));
        const current = run(() => parsePlannerReply(text));
        if (!same(legacy, current)) throw new Error(`parsePlannerReply 다름: ${JSON.stringify(text)}\n${JSON.stringify(legacy)}\n${JSON.stringify(current)}`);
        runs += 1;
        if (legacy.threw) stats.reply.threw += 1;
        else {
          stats.reply.values += 1;
          if (text.includes('```')) stats.reply.fenced += 1;
          if (!isParsedDirectly(text)) stats.reply.repaired += 1;
        }
        if (i % 50 === 0) {
          // 대조 장치: 결과를 한 글자 바꾼 옛 구현은 차이로 잡혀야 한다
          const bad: Out = legacy.threw ? { threw: true, message: `${legacy.message}!` } : { threw: false, value: `${legacy.value}!` };
          expect(same(bad, current)).toBe(false);
        }
      }
    }
    expect(runs).toBeGreaterThan(1000);
    expect(stats.reply.values).toBeGreaterThan(100);
    expect(stats.reply.threw).toBeGreaterThan(100);
    expect(stats.reply.repaired).toBeGreaterThan(20);
  });

  it('추출 답을 고친다(글자까지 같다)', () => {
    for (const seed of SEEDS) {
      const g = new Gen(seed * 13 + 2);
      for (let i = 0; i < N; i++) {
        const raw = genRaw(g);
        const before = JSON.stringify(raw);
        const legacy = run(() => old.repairExtractionReplyLegacy(raw));
        const current = run(() => cur.repairExtractionReply(raw));
        if (JSON.stringify(raw) !== before) throw new Error('입력을 고쳐 썼다');
        if (!same(legacy, current)) throw new Error(`repairExtractionReply 다름: ${before}\n${JSON.stringify(legacy)}\n${JSON.stringify(current)}`);
        stats.repair.runs += 1;
        if (legacy.threw) stats.repair.threw += 1;
        else if (legacy.value !== `object:${before}`) stats.repair.changed += 1;
        // 같은 값끼리 deepStrictEqual(-0·키 순서·짝 없는 서로게이트)
        if (!legacy.threw && !current.threw) {
          const a = old.repairExtractionReplyLegacy(raw);
          const b = cur.repairExtractionReply(raw);
          expect(isDeepStrictEqual(a, b), before).toBe(true);
          expect(Object.keys(a as object)).toEqual(Object.keys(b as object));
        }
        if (i % 50 === 0 && !legacy.threw) expect(same({ threw: false, value: `${legacy.value}!` }, current)).toBe(false);
      }
    }
    expect(stats.repair.runs).toBeGreaterThan(1000);
    expect(stats.repair.changed).toBeGreaterThan(300);
  });

  it('인용 확인: 열린 쪽 뒤집힘 0, 닫힌 것은 낱말 중간 자르기뿐이고 JS로 따로 쓴 같은 규칙과 같다', () => {
    for (const seed of SEEDS) {
      const g = new Gen(seed * 17 + 3);
      for (let i = 0; i < N * 4; i++) {
        const spec = genSpec(g);
        const quote = genQuote(g, spec);
        const legacy = old.verifySpecQuote(quote, spec);
        const current = cur.verifySpecQuote(quote, spec);
        stats.quote.runs += 1;
        if (!legacy && current) stats.quote.flips += 1;
        if (legacy && !current) stats.quote.closed += 1;
        if (legacy && current) stats.quote.trueBoth += 1;
        if (!legacy && !current) stats.quote.falseBoth += 1;
        expect(current, JSON.stringify([quote, spec])).toBe(oracle(quote, spec));
        // 옛 "있음" → 새 "없음"이면 그 인용은 정말 모든 자리에서 낱말 중간이다(oracle이 거절했고 옛 구현은 받았다 — 둘의 차이가 이 규칙뿐인지 본다)
        if (legacy && !current) {
          const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
          expect(/[A-Za-z0-9_]/.test(collapse(quote)[0]!) || /[A-Za-z0-9_]/.test(collapse(quote).slice(-1)), JSON.stringify([quote, spec])).toBe(true);
        }
      }
    }
    expect(stats.quote.flips).toBe(0);
    expect(stats.quote.trueBoth).toBeGreaterThan(300);
    expect(stats.quote.falseBoth).toBeGreaterThan(300);
    expect(stats.quote.closed).toBeGreaterThan(20);
  });

  it('추천 답의 근거 강등(여는 쪽): 옛 "근거 없음" → 새 "근거 있음" 뒤집힘 0', () => {
    for (const seed of SEEDS) {
      const g = new Gen(seed * 19 + 4);
      for (let i = 0; i < N; i++) {
        const spec = genSpec(g);
        const text = recommendReplyText(g, spec);
        const legacy = run(() => legacyRecommend(text, spec));
        const current = run(() => cur.parseRecommendationReply(text, spec));
        stats.recommend.runs += 1;
        if (legacy.threw || current.threw) {
          stats.recommend.threw += 1;
          // 던짐은 zod 검증이다(강등은 던지지 않는다) — 같은 문구여야 한다
          expect(same(legacy, current), text).toBe(true);
          continue;
        }
        stats.recommend.ok += 1;
        const a = JSON.parse(legacy.value.slice(legacy.value.indexOf(':') + 1)) as { recommendations: Rec[] };
        const b = JSON.parse(current.value.slice(current.value.indexOf(':') + 1)) as { recommendations: Rec[] };
        expect(b.recommendations.length).toBe(a.recommendations.length);
        a.recommendations.forEach((rec, index) => {
          const now = b.recommendations[index]!;
          if (rec.basis !== 'spec' && now.basis === 'spec') stats.recommend.flips += 1;
          if (rec.basis === 'spec' && now.basis === 'spec') stats.recommend.specKept += 1;
          if (rec.basis === 'spec' && now.basis !== 'spec') stats.recommend.closed += 1;
          if (rec.basis !== 'spec' && now.basis !== 'spec') stats.recommend.demotedBoth += 1;
          // 인용이 남은 추천은 새 구현이 oracle로도 받은 것이다
          if (now.basis === 'spec') expect(oracle(now.specQuote ?? '', spec), JSON.stringify([now, spec])).toBe(true);
          // 강등되면 인용을 지운다
          if (rec.basis === 'spec' && now.basis !== 'spec') expect('specQuote' in now).toBe(false);
          // 그 밖의 필드는 같다
          const { basis: _b1, specQuote: _q1, ...restOld } = rec;
          const { basis: _b2, specQuote: _q2, ...restNew } = now;
          expect(restNew).toEqual(restOld);
        });
        if (i % 50 === 0) expect(legacy.value === `${current.value}!`).toBe(false);
      }
    }
    expect(stats.recommend.flips).toBe(0);
    expect(stats.recommend.specKept).toBeGreaterThan(200);
    expect(stats.recommend.demotedBoth).toBeGreaterThan(200);
    expect(stats.recommend.ok).toBeGreaterThan(500);
  });

  it('참조 파일 미리보기·상한 문구·JSON 이름·사용량 합', () => {
    const LINE = ['a', 'b c', '  ', '', '가나다', '😀', '\ud800', '\udc00', '', '', '﻿', ' ', ' ', 'x'.repeat(100), '가'.repeat(150), '\r', '\t'];
    const EOLS = ['\n', '\r\n', '\n', '\r', '\n\n', ' '];
    for (const seed of SEEDS) {
      const g = new Gen(seed * 23 + 5);
      for (let i = 0; i < N * 2; i++) {
        let content = g.list(0, 9, () => g.pick(LINE)).map((line) => line + g.pick(EOLS)).join('');
        if (g.chance(0.2)) content = content.trimEnd();
        if (g.chance(0.3)) {
          // 300 코드 단위 경계: 두 단위 글자와 짝 없는 서로게이트가 경계에 걸리게 한다
          const filler = 'a'.repeat(295 + g.int(10));
          content = g.pick(['', ' ', '\n']) + filler + g.pick(['😀', '\ud83d', '\ude00', '가', 'b😀c', '', '😀😀']) + g.pick(['', 'zzz', '\n', ' ']);
        }
        const legacy = old.firstLinesPreviewLegacy(content);
        const current = cur.buildReferencedFilePreview('x.txt', content, 1).preview;
        stats.preview.runs += 1;
        if (legacy.endsWith('…')) stats.preview.truncated += 1;
        if (legacy.includes('\n')) stats.preview.multiline += 1;
        if (legacy !== current || JSON.stringify(legacy) !== JSON.stringify(current)) throw new Error(`firstLinesPreview 다름: ${JSON.stringify(content)}\n${JSON.stringify(legacy)}\n${JSON.stringify(current)}`);
        if (i % 50 === 0) expect(`${legacy}!`).not.toBe(current);
      }
      for (let i = 0; i < N; i++) {
        const path = g.text(['a', '/', '.', 'json', 'JSON', 'Json', 'jsoN', 's', 'ſ', 'ſon', 'ı', 'K', ' ', '\n', '.json', '.JSON', 'x'], 1 + g.int(6));
        const legacy = old.isJsonPathLegacy(path);
        expect(native.reqReplyIsJsonPath(path), JSON.stringify(path)).toBe(legacy);
        if (legacy) stats.misc.json += 1;
        else stats.misc.nonJson += 1;
        const message = g.text(['너무 큽니다 (', '너무 큽니다 ', '(', '12', '0', '9'.repeat(20), ' bytes)', ' byte)', 'bytes', ')', '파일이 ', '\n', 'x', '１２', '너무 큽니다 (1 bytes) '], 1 + g.int(7));
        const match = old.REFERENCE_FILE_TOO_BIG.exec(message);
        const expected = match ? Number(match[1]) : null;
        const actual = native.reqReplyTooBigBytes(message) ?? null;
        expect(Object.is(actual, expected), JSON.stringify(message)).toBe(true);
        if (match) stats.misc.tooBig += 1;
        else stats.misc.tooBigNone += 1;
      }
      const NUMS = [0, -0, 1, 2, 3.5, 1e21, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, Infinity, -Infinity, NaN, 123456789];
      for (let i = 0; i < N; i++) {
        const usage = () => ({ inputTokens: g.pick(NUMS), outputTokens: g.pick(NUMS), cacheReadTokens: g.pick(NUMS), cacheWriteTokens: g.pick(NUMS) });
        const a = usage();
        const b = usage();
        const legacy = old.addUsageLegacy(a, b);
        const current = native.reqReplyAddUsage([a.inputTokens, a.outputTokens, a.cacheReadTokens, a.cacheWriteTokens], [b.inputTokens, b.outputTokens, b.cacheReadTokens, b.cacheWriteTokens]);
        expect(isDeepStrictEqual([legacy.inputTokens, legacy.outputTokens, legacy.cacheReadTokens, legacy.cacheWriteTokens], current)).toBe(true);
        stats.misc.usage += 1;
      }
    }
    expect(stats.preview.truncated).toBeGreaterThan(100);
    expect(stats.preview.multiline).toBeGreaterThan(300);
    expect(stats.misc.tooBig).toBeGreaterThan(50);
    expect(stats.misc.tooBigNone).toBeGreaterThan(50);
    expect(stats.misc.json).toBeGreaterThan(50);
    expect(stats.misc.nonJson).toBeGreaterThan(50);
  });

  it('대조 장치: 결과를 바꾼 옛 구현은 차이로 잡힌다', () => {
    expect(perturb(old.repairExtractionReplyLegacy({ requirements: [], questions: null }))).not.toEqual(cur.repairExtractionReply({ requirements: [], questions: null }));
    // 경계를 ±1 바꾼 옛 구현
    const off = (content: string) => (content.length > 299 ? `${content.slice(0, 299)}…` : content);
    const long = 'a'.repeat(301);
    expect(off(long)).not.toBe(cur.buildReferencedFilePreview('x.txt', long, 1).preview);
    expect(cur.buildReferencedFilePreview('x.txt', long, 1).preview).toBe(old.firstLinesPreviewLegacy(long));
  });

  it('분포를 찍는다', () => {
    // eslint-disable-next-line no-console
    console.log(`[requirements-replies differential] ${JSON.stringify(stats)}`);
  });
});

/** 꺼낸 글자를 `JSON.parse`가 그대로 읽는지(아니면 jsonrepair를 거친 것) */
function isParsedDirectly(text: string): boolean {
  const found = native.reqReplyExtractJson(encodeLoneSurrogates(text));
  if (found.length === 0) return true;
  try {
    JSON.parse(decodeLoneSurrogates(found[0]!));
    return true;
  } catch {
    return false;
  }
}
