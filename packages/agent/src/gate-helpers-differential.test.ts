import { appendFileSync } from 'node:fs';
import type { AutoPageChecks, ConcurrencyExpect } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import type { ViewportTextFinding, ViewportTextReport } from './browser-check';
import { Gen, outcome, perturb, readEnvList, readEnvNumber, sameOutcome, type Outcome } from './differential-kit';
import {
  acceptedNotes,
  autoPageCheck,
  compareDetail,
  containsApiValue,
  describeConcurrencyExpect,
  dynamicNames,
  dynamicProbeDataHint,
  formatFailedChecks,
  missingAllText,
  missingAnyText,
  missingApiValue,
  nextErrorMarker,
  sampledValues,
  stripHtml,
  usesInRunValue,
  viewportProblemText,
  viewportProblems,
  type ApiValue,
  type LatestSampleValues,
} from './gate';
import * as legacy from './gate-helpers-legacy';
import type { WorkflowCheck } from './workflow';
import type { CompareResult } from './visual-compare';

/**
 * 게이트의 순수 보조 판정을 Rust로 옮기면서(ADR-191 3r) 옛 TS 구현(`gate-helpers-legacy.ts`, 옮기기 전 gate.ts의 본문 그대로)과 새 껍데기를 같은 무작위 입력으로 견준다.
 * 결과는 JSON 글자(키 순서)와 값(-0·NaN 구별)이 모두 같아야 같다. 짝 없는 서로게이트는 경계에서 U+FFFD가 되는 것이 의도한 차이라 양쪽을 같은 규칙으로 맞춘다(wellFormed).
 * 통과 쪽으로 뒤집힌 수(옛 실패 → 새 통과, 옛 "표시 있음" → 새 "없음")는 따로 센다.
 *
 * 크기는 환경 변수로 바꾼다: GATE_HELPERS_DIFF_SEEDS(쉼표 목록), GATE_HELPERS_DIFF_ITERATIONS(함수마다 시드마다), GATE_HELPERS_DIFF_REPORT=<파일 경로>(분포를 그 파일에 덧붙인다)
 */
const SEEDS = readEnvList('GATE_HELPERS_DIFF_SEEDS', [1, 2]);
const ITERATIONS = readEnvNumber('GATE_HELPERS_DIFF_ITERATIONS', 5_000);
const REPORT = process.env.GATE_HELPERS_DIFF_REPORT;

interface Tally {
  runs: number;
  same: number;
  different: number;
  threw: number;
  /** 옛 결과의 종류별 개수(참/거짓/빈 값/값 있음) */
  kinds: Map<string, number>;
  /** 통과 쪽으로 뒤집힌 수 */
  open: number;
  /** 실패 쪽(옛 있음 → 새 없음)으로 달라진 수. 짝 없는 서로게이트를 가르는 경우에만 나온다 */
  closed: number;
}
const tallies = new Map<string, Tally>();
function tally(name: string): Tally {
  let t = tallies.get(name);
  if (!t) {
    t = { runs: 0, same: 0, different: 0, threw: 0, kinds: new Map(), open: 0, closed: 0 };
    tallies.set(name, t);
  }
  return t;
}

function kindOf(value: unknown): string {
  if (typeof value === 'boolean') return value ? '참' : '거짓';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return value.length === 0 ? '빈 배열' : '배열';
  if (typeof value === 'string') return value === '' ? '빈 글자' : '글자';
  return '값';
}

function compare(name: string, input: unknown, oldFn: () => unknown, newFn: () => unknown, isOpen?: (oldValue: unknown, newValue: unknown) => boolean): void {
  const t = tally(name);
  const oldResult: Outcome = outcome(oldFn);
  const newResult: Outcome = outcome(newFn);
  t.runs += 1;
  if (oldResult.threw) t.threw += 1;
  else t.kinds.set(kindOf(oldResult.value), (t.kinds.get(kindOf(oldResult.value)) ?? 0) + 1);
  if (sameOutcome(oldResult, newResult)) t.same += 1;
  else {
    t.different += 1;
    if (t.different <= 3) throw new Error(`${name}: 다른 결과\n입력 ${JSON.stringify(input)}\n옛 ${JSON.stringify(oldResult)}\n새 ${JSON.stringify(newResult)}`);
  }
  if (isOpen && !oldResult.threw && !newResult.threw && isOpen(oldResult.value, newResult.value)) t.open += 1;
}

// ── 입력 만들기 ──
const LONE = ['\ud800', '\udbff', '\udc00', '\udfff', '\ud83d', '\ude00'];
const TEXT_ALPHABET = ['a', 'b', 'A', '1', '0', ',', '.', '-', ' ', '\t', '\n', '가', '😀', '�', '', '', '', ...LONE, '', ''];

function surrogateText(g: Gen, max: number): string {
  return g.text(TEXT_ALPHABET, g.int(max + 1));
}

function bitsToDouble(hi: number, lo: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, hi);
  view.setUint32(4, lo);
  return view.getFloat64(0);
}

/** 여러 가족의 수: 정수, 소수, 반올림 경계(…5), 큰 수, 작은 수, ±0, NaN, ±Infinity, 무작위 비트 */
function number(g: Gen): number {
  return g.weighted<() => number>([
    [4, () => g.int(100_000)],
    [3, () => g.int(10_000_000_000) / 10 ** g.int(7)],
    [3, () => Number(`${g.int(5000)}.${String(g.int(1000)).padStart(3, '0')}5`)],
    [2, () => Number(`0.${'0'.repeat(g.int(5))}${g.int(100)}5`)],
    [1, () => -g.int(100_000) / 10 ** g.int(5)],
    [1, () => 10 ** (15 + g.int(12))],
    [1, () => 10 ** -(3 + g.int(8))],
    [1, () => g.pick([0, -0, NaN, Infinity, -Infinity, 1e21, 1e-7, 999.9995, 0.0005, 12000, 1000, 1234.5675])],
    [1, () => bitsToDouble(g.int(4294967296), g.int(4294967296))],
  ])();
}

function localeForms(value: number): string[] {
  return [String(value), value.toLocaleString('en-US')];
}

function noise(g: Gen): string {
  return g.text(['가', '나', ' ', 'x', '원', ':', '\n'], g.int(4));
}

function mutateText(g: Gen, text: string): string {
  if (text === '') return g.pick(['a', ',', '1']);
  const cut = g.int(text.length);
  switch (g.int(5)) {
    case 0:
      return text.slice(0, -1);
    case 1:
      return text.slice(1);
    case 2:
      return text.replace(',', '');
    case 3:
      return text.slice(0, cut) + g.pick(['0', ',', ' ', '.']) + text.slice(cut + 1);
    default:
      return text.toUpperCase();
  }
}

const isHigh = (u: number) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number) => u >= 0xdc00 && u <= 0xdfff;
function pairedUnits(text: string): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i + 1 < text.length; i++) {
    if (isHigh(text.charCodeAt(i)) && isLow(text.charCodeAt(i + 1))) {
      out.add(text.charCodeAt(i));
      out.add(text.charCodeAt(i + 1));
    }
  }
  return out;
}
function loneUnits(text: string): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < text.length; i++) {
    const u = text.charCodeAt(i);
    if (isHigh(u) && i + 1 < text.length && isLow(text.charCodeAt(i + 1))) i += 1;
    else if (isHigh(u) || isLow(u)) out.add(u);
  }
  return out;
}
/** B의 짝 없는 서로게이트 단위가 A에서는 짝의 일부인가 — 단사 인코딩이 닫는 쪽으로만 달라지는 유일한 이유 */
function pairSplitReason(a: string, b: string): boolean {
  const paired = pairedUnits(a);
  for (const u of loneUnits(b)) if (paired.has(u)) return true;
  return false;
}

// ── 함수마다 ──
const NAMES = ['abc', 'id', 'slug', 'a-b', 'A_1', 'x', 'orderId'];
const NAMES_WITH_SURROGATE = [...NAMES, '\ud800', 'a\udc00', 'é', '한글', '', ' '];

function pageFile(g: Gen, names: readonly string[] = NAMES_WITH_SURROGATE): string {
  const segment = () =>
    g.weighted<() => string>([
      [4, () => `[${g.pick(names)}]`],
      [2, () => g.pick(['app', 'orders', 'page.tsx', 'src', '(group)', ''])],
      [1, () => `[...${g.pick(names)}]`],
      [1, () => `[[${g.pick(names)}]]`],
      [1, () => g.pick(['[]', '[', ']', '[a[b]', '[a]]', 'x[id]', '[id]x', '[a\nb]', '[ a ]', '[...]', '[....id]'])],
      [1, () => `${g.pick(['x', ''])}[${g.pick(names)}]${g.pick(['y', ''])}`],
    ])();
  return g.list(1, 5, segment).join('/');
}

function compareContains(g: Gen, name: string): void {
  const value = g.chance(0.5) ? number(g) : surrogateText(g, 6);
  let text: string;
  if (typeof value === 'number') {
    const forms = localeForms(value);
    const form = g.pick(forms);
    text = `${noise(g)}${g.chance(0.3) ? mutateText(g, form) : form}${noise(g)}`;
  } else {
    const piece = g.chance(0.6) ? surrogateText(g, 8) : '';
    text = piece + (g.chance(0.5) ? value : mutateText(g, value)) + surrogateText(g, 3);
  }
  if (typeof value === 'number') {
    compare(name, [text, value], () => legacy.containsApiValue(text, value), () => containsApiValue(text, value), (oldValue, newValue) => oldValue === false && newValue === true);
    return;
  }
  // 글자 값: 견줄 두 글자를 단사로 바꿔 보내므로 같고, 다른 경우(옛 있음 → 새 없음)는 짝 없는 서로게이트를 가르는 경우뿐이다. 열린 쪽(옛 없음 → 새 있음)은 0이어야 한다
  const t = tally(name);
  const oldValue = legacy.containsApiValue(text, value);
  const newValue = containsApiValue(text, value);
  t.runs += 1;
  t.kinds.set(kindOf(oldValue), (t.kinds.get(kindOf(oldValue)) ?? 0) + 1);
  if (oldValue === newValue) t.same += 1;
  else if (oldValue && !newValue && pairSplitReason(text, value)) t.closed += 1;
  else t.different += 1;
  if (!oldValue && newValue) t.open += 1;
}

function randomProblem(g: Gen): ViewportTextFinding['problem'] {
  const px = () => g.pick([0, 1, 12.5, 100, -0, NaN, 1e21, g.int(5000), g.int(1000) / 8]);
  const by = () => g.pick(['div.modal', '', 'header', '\ud800', "a'b", '닫기 버튼']);
  switch (g.int(10)) {
    case 0:
      return undefined;
    case 1:
      return { kind: 'absent' };
    case 2:
      return { kind: 'hidden' };
    case 3:
      return { kind: 'covered', by: by() };
    case 4:
      return { kind: 'scrolled', px: px() };
    case 5:
      return { kind: 'clipped', side: g.pick(['top', 'bottom', 'left', 'right'] as const), px: px(), by: by() };
    case 6:
      return { kind: 'below', px: px() };
    case 7:
      return { kind: 'above', px: px() };
    case 8:
      return { kind: 'right', px: px() };
    default:
      return { kind: 'left', px: px() };
  }
}

const VIEWPORT_TEXTS = ['확인', 'A', 'a', ' A', 'A ', '', '\ud800', '\udc00', 'x\ud800', '😀', '\ud83d', '\ude00', '�', 'd800', 'd800'];

function randomReport(g: Gen, expected: readonly string[]): ViewportTextReport | undefined {
  if (g.chance(0.12)) return undefined;
  const findings: ViewportTextFinding[] = g.list(0, 6, () => {
    const text = g.chance(0.7) ? g.pick(expected.length > 0 ? expected : VIEWPORT_TEXTS) : g.pick(VIEWPORT_TEXTS);
    const visible = g.chance(0.4);
    const problem = randomProblem(g);
    return { text, visible, ...(problem ? { problem } : {}) };
  });
  return { width: g.pick([1280, 390, 800, 0, NaN, 1e21, 12.5]), height: g.pick([800, 844, 0, -0, 600.5]), findings };
}

function randomApi(g: Gen): ApiValue {
  return { service: g.pick(['api', 'web', '\ud800x']), jsonPath: g.pick(['$.price', '$.items[0].qty', '$', '']), value: g.chance(0.5) ? number(g) : surrogateText(g, 5) };
}

function randomLatest(g: Gen, keys: readonly string[]): LatestSampleValues {
  const sampleParams: Record<string, string> = {};
  for (const key of keys) if (g.chance(0.7)) sampleParams[key] = g.pick(['1', '7', 'new', '', '\ud800', 'a b']);
  const inRunKeys = new Set<string>();
  if (g.chance(0.7)) for (const key of keys) if (g.chance(0.4)) inRunKeys.add(key);
  const config = {
    service: 'web',
    mode: 'http',
    expectStatus: 200,
    maxPages: 5,
    ...(g.chance(0.85) ? { sampleParams } : {}),
    ...(g.chance(0.5) ? { sampleIdFrom: { service: g.pick(['api', 'web']), path: g.pick(['/items', '/list?x=1']), jsonPath: '$[0].id' } } : {}),
  } as unknown as AutoPageChecks;
  return { config, notes: [], inRunKeys, inRunSampleIdFrom: g.chance(0.5) };
}

const HTML_PIECES = [
  '<script>',
  '</script>',
  '<SCRIPT type="x">',
  '</Script>',
  '<style>',
  '</style>',
  '</STYLE >',
  '<div>',
  '</div>',
  '<',
  '>',
  '<>',
  '<ſcript>',
  '<scrıpt>',
  '<scriptx',
  'text',
  '로딩 중',
  ' ',
  '  ',
  '\t',
  '\n',
  ' ',
  '﻿',
  '\u0085',
  '😀',
  '\ud800',
  '\udc00',
  '"',
];

function randomExpect(g: Gen): ConcurrencyExpect {
  const successCount = g.pick<ConcurrencyExpect['successCount']>([undefined, { exactly: 1 }, { atMost: 0 }, { exactly: 0 }, { exactly: 2, atMost: 3 }, { atMost: 5 }, {}]);
  const allStatusIn = g.pick<number[] | undefined>([undefined, [], [200], [200, 409], [100, 599, 404]]);
  return { ...(successCount ? { successCount } : {}), ...(allStatusIn ? { allStatusIn } : {}) } as ConcurrencyExpect;
}

function randomChecks(g: Gen): WorkflowCheck[] {
  return g.list(0, 4, () => ({
    stage: g.pick(['browser_check', 'test', 'concurrency_check', 'load_check', 'review'] as const),
    name: g.pick(['단위', 'web /orders', "a'b", '', '\ud800']),
    ok: false,
    attempts: g.pick([1, 2, 3, 0, NaN, -0, 1e21, 12.5]),
    ...(g.chance(0.6) ? { detail: g.pick(['실패', '', '줄1\n줄2', '\ud800', '  ']) } : {}),
  }));
}

function randomCompare(g: Gen): { comparison: CompareResult; max: number } {
  const ratio = g.pick([0, 1, 0.00125, 0.0005, 0.125, 0.1255, 0.12345, 0.999999, 1e-9, g.int(10001) / 10000, g.int(1000) / 8000, NaN, -0.01, 1.5]);
  const max = g.pick([0, 0.05, 0.01, 0.1, 1, 0.0005, g.int(1001) / 1000, NaN]);
  const comparison = { ratio, diffPixels: 0, comparedPixels: 0, width: g.pick([1280, 390, 0, NaN, 12.5, 1e21]), height: g.pick([800, 844, 0, -0]), diff: Buffer.alloc(0) } as CompareResult;
  return { comparison, max };
}

const FUNCTIONS: Array<[string, (g: Gen) => void]> = [
  [
    'nextErrorMarker',
    (g) => {
      const pieces = ['Application error: a server-side exception has occurred', 'Unhandled Runtime Error', 'This page could not be found', 'Application error', 'This page could not be foun', 'unhandled runtime error', ' ', '<h1>', ...LONE, '�'];
      const split = g.chance(0.3) ? g.pick(['Unhandled\ud800Runtime Error', 'This page\udc00 could not be found', 'Unhandled Runtime Erro\ud83d']) : '';
      const text = g.list(0, 4, () => g.pick(pieces)).join(g.pick(['', ' '])) + split;
      const status = g.pick([200, 404, 403, 405, 500, 0, NaN, 201, 404.5]);
      compare(
        'nextErrorMarker',
        [text, status],
        () => legacy.nextErrorMarker(text, status),
        () => nextErrorMarker(text, status),
        (oldValue, newValue) => oldValue !== undefined && newValue === undefined,
      );
      // 새 표지가 옛 구현에 없는 것(반대 방향)도 같아야 한다
      const oldValue = legacy.nextErrorMarker(text, status);
      expect(nextErrorMarker(text, status) === undefined).toBe(oldValue === undefined);
    },
  ],
  [
    'autoPageCheck',
    (g) => {
      const viewport = g.chance(0.5) ? g.pick([{ width: 390, height: 844 }, { width: 0, height: 0 }, { width: 1280, height: 800 }]) : undefined;
      const config = { service: g.pick(['web', 'app-1', 'a']), mode: g.pick(['http', 'browser'] as const), expectStatus: g.pick([200, 201, 404, 100, 599]), maxPages: 5, ...(viewport ? { viewport } : {}) } as unknown as AutoPageChecks;
      const routePath = g.pick(['/orders', '/', '/a/b?x=1', '/한글', '/\ud800']);
      compare('autoPageCheck', [config, routePath], () => legacy.autoPageCheck(config, routePath), () => autoPageCheck(config, routePath));
    },
  ],
  ['containsApiValue', (g) => compareContains(g, 'containsApiValue')],
  [
    'missingApiValue',
    (g) => {
      const api = randomApi(g);
      const path = g.pick(['/orders', '/', '\ud800', '/한글']);
      compare('missingApiValue', [api, path], () => legacy.missingApiValue(api, path), () => missingApiValue(api, path));
    },
  ],
  [
    'viewportProblemText',
    (g) => {
      const finding: ViewportTextFinding = { text: g.pick(VIEWPORT_TEXTS), visible: g.chance(0.3), ...(g.chance(0.9) ? (() => { const problem = randomProblem(g); return problem ? { problem } : {}; })() : {}) };
      const width = g.pick([1280, 390, 0, NaN, 12.5, 1e21, -0]);
      const height = g.pick([800, 844, 0, Infinity, 600.5]);
      compare('viewportProblemText', [finding, width, height], () => legacy.viewportProblemText(finding, width, height), () => viewportProblemText(finding, width, height));
    },
  ],
  [
    'viewportProblems',
    (g) => {
      const expected = g.list(0, 4, () => g.pick(VIEWPORT_TEXTS));
      const report = randomReport(g, expected);
      compare(
        'viewportProblems',
        [expected, report],
        () => legacy.viewportProblems(expected, report),
        () => viewportProblems(expected, report),
        (oldValue, newValue) => (oldValue as string[]).length > 0 && (newValue as string[]).length === 0,
      );
      // 글자 하나씩: 옛 "문제 있음"이 새 "문제 없음"으로 뒤집힌 것이 없다
      for (const text of expected) {
        const oldOne = legacy.viewportProblems([text], report);
        const newOne = viewportProblems([text], report);
        compare('viewportProblems(글자 하나)', [text, report], () => oldOne, () => newOne, (oldValue, newValue) => (oldValue as string[]).length > 0 && (newValue as string[]).length === 0);
      }
    },
  ],
  [
    'missingAllText·missingAnyText',
    (g) => {
      const values = g.list(0, 4, () => surrogateText(g, 4));
      compare('missingAllText', values, () => legacy.missingAllText(values), () => missingAllText(values));
      compare('missingAnyText', values, () => legacy.missingAnyText(values), () => missingAnyText(values));
    },
  ],
  [
    'dynamicProbeDataHint',
    (g) => {
      const id = surrogateText(g, 6);
      compare('dynamicProbeDataHint', id, () => legacy.dynamicProbeDataHint(id), () => dynamicProbeDataHint(id));
    },
  ],
  [
    'dynamicNames',
    (g) => {
      const file = pageFile(g);
      compare('dynamicNames', file, () => legacy.dynamicNames(file), () => dynamicNames(file));
      // 이름은 원래 글자에서 잘라 쓰므로 짝 없는 서로게이트까지 그대로다(U+FFFD로 바뀌지 않는다)
      expect(dynamicNames(file)).toStrictEqual(legacy.dynamicNames(file));
    },
  ],
  [
    'acceptedNotes',
    (g) => {
      const latest = randomLatest(g, NAMES);
      compare('acceptedNotes', latest, () => legacy.acceptedNotes(latest), () => acceptedNotes(latest));
    },
  ],
  [
    'usesInRunValue',
    (g) => {
      const keys = g.list(0, 3, () => g.pick(NAMES_WITH_SURROGATE));
      const latest = { ...randomLatest(g, NAMES), inRunKeys: new Set(keys) };
      const route = { file: pageFile(g), ...(g.chance(0.6) ? { usedFallbackParams: g.list(0, 2, () => g.pick(NAMES)) } : {}) };
      compare(
        'usesInRunValue',
        [route, [...keys], latest.inRunSampleIdFrom],
        () => legacy.usesInRunValue(route, latest),
        () => usesInRunValue(route, latest),
        (oldValue, newValue) => oldValue === false && newValue === true,
      );
      // 정확히 같아야 한다(단사로 보내므로 서로 다른 이름이 같아지지 않는다)
      expect(usesInRunValue(route, latest)).toBe(legacy.usesInRunValue(route, latest));
    },
  ],
  [
    'sampledValues',
    (g) => {
      const file = pageFile(g, NAMES);
      const params: Record<string, string> = {};
      for (const name of NAMES) if (g.chance(0.6)) params[name] = g.pick(['1', '7', '', 'new', 'a, b', '\ud800', '한글']);
      const sampleParams = g.chance(0.1) ? undefined : params;
      compare('sampledValues', [file, sampleParams], () => legacy.sampledValues(file, sampleParams), () => sampledValues(file, sampleParams));
    },
  ],
  [
    'stripHtml',
    (g) => {
      const html = g.list(0, 12, () => g.pick(HTML_PIECES)).join(g.pick(['', '', 'x', ' ']));
      compare('stripHtml', html, () => legacy.stripHtml(html), () => stripHtml(html));
    },
  ],
  [
    'formatFailedChecks',
    (g) => {
      const checks = randomChecks(g);
      compare('formatFailedChecks', checks, () => legacy.formatFailedChecks(checks), () => formatFailedChecks(checks));
    },
  ],
  [
    'compareDetail',
    (g) => {
      const { comparison, max } = randomCompare(g);
      compare('compareDetail', [comparison.ratio, max, comparison.width, comparison.height], () => legacy.compareDetail(comparison, max), () => compareDetail(comparison, max));
    },
  ],
  [
    'describeConcurrencyExpect',
    (g) => {
      const expectation = randomExpect(g);
      compare('describeConcurrencyExpect', expectation, () => legacy.describeConcurrencyExpect(expectation), () => describeConcurrencyExpect(expectation));
    },
  ],
];

describe('게이트의 순수 보조 판정: 옛 TS 구현과 새 껍데기의 차등 시험', () => {
  it('무작위 입력에서 결과가 JSON 글자까지 같고, 통과 쪽으로 뒤집힌 것이 없다', () => {
    for (const seed of SEEDS) {
      const g = new Gen(seed);
      for (let i = 0; i < ITERATIONS; i++) for (const [, run] of FUNCTIONS) run(g);
    }
    const lines: string[] = [];
    for (const [name, t] of tallies) {
      const kinds = [...t.kinds.entries()].map(([kind, count]) => `${kind} ${count}`).join(', ');
      lines.push(`${name}: ${t.runs}번, 같음 ${t.same}, 다름 ${t.different}, 던짐 ${t.threw}, 통과 쪽 뒤집힘 ${t.open}, 짝을 가르는 닫는 쪽 ${t.closed} (옛 결과 분포: ${kinds})`);
      expect(t.different, name).toBe(0);
      expect(t.open, name).toBe(0);
      expect(t.runs, name).toBeGreaterThan(0);
      expect(t.threw, name).toBe(0);
    }
    if (REPORT) appendFileSync(REPORT, `${lines.join('\n')}\n`);
    // 분포: 비어 있는 시험이 아니다. 함수마다 결과가 한 종류로 쏠리지 않았다
    const kinds = (name: string) => tallies.get(name)!.kinds;
    expect(kinds('containsApiValue').get('참')).toBeGreaterThan(ITERATIONS / 10);
    expect(kinds('containsApiValue').get('거짓')).toBeGreaterThan(ITERATIONS / 10);
    expect(kinds('nextErrorMarker').get('글자')).toBeGreaterThan(ITERATIONS / 10);
    expect(kinds('nextErrorMarker').get('undefined')).toBeGreaterThan(ITERATIONS / 10);
    expect(kinds('viewportProblems').get('배열')).toBeGreaterThan(ITERATIONS / 10);
    expect(kinds('viewportProblems').get('빈 배열')).toBeGreaterThan(ITERATIONS / 50);
    expect(kinds('usesInRunValue').get('참')).toBeGreaterThan(ITERATIONS / 20);
    expect(kinds('usesInRunValue').get('거짓')).toBeGreaterThan(ITERATIONS / 20);
    expect(kinds('sampledValues').get('글자')).toBeGreaterThan(ITERATIONS / 20);
    expect(kinds('sampledValues').get('undefined')).toBeGreaterThan(ITERATIONS / 20);
    expect(kinds('dynamicNames').get('배열')).toBeGreaterThan(ITERATIONS / 4);
    expect(kinds('dynamicNames').get('빈 배열')).toBeGreaterThan(ITERATIONS / 50);
    expect(kinds('stripHtml').get('글자')).toBeGreaterThan(ITERATIONS / 4);
    expect(kinds('formatFailedChecks').get('빈 글자')).toBeGreaterThan(ITERATIONS / 50);
    expect(kinds('acceptedNotes').get('배열')).toBeGreaterThan(ITERATIONS / 4);
    expect(kinds('acceptedNotes').get('빈 배열')).toBeGreaterThan(ITERATIONS / 50);
    expect(kinds('describeConcurrencyExpect').get('빈 글자')).toBeGreaterThan(ITERATIONS / 50);
  });

  it('대조 장치: 결과 한 글자를 바꾸거나 경계를 ±1 바꾼 옛 구현은 차이로 잡힌다', () => {
    const g = new Gen(99);
    let caught = 0;
    let total = 0;
    const check = (oldFn: () => unknown, newFn: () => unknown): void => {
      total += 1;
      if (!sameOutcome(outcome(oldFn), outcome(newFn))) caught += 1;
    };
    // 옛 결과를 조금 바꾼 값은 어느 함수에서든 새 결과와 달라야 한다
    for (let i = 0; i < 400; i++) {
      const text = surrogateText(g, 6) + g.pick(['1,000', '1000', 'Unhandled Runtime Error', '']);
      const value = g.pick([1000, 12000, 0.5, 'abc', '1,000']);
      check(() => perturb(legacy.containsApiValue(text, value)), () => containsApiValue(text, value));
      check(() => perturb(legacy.nextErrorMarker(text, 200)), () => nextErrorMarker(text, 200));
      check(() => perturb(legacy.stripHtml(text)), () => stripHtml(text));
      const checks = randomChecks(g);
      check(() => perturb(legacy.formatFailedChecks(checks)), () => formatFailedChecks(checks));
    }
    expect(caught).toBe(total);
    // 경계를 ±1 바꾼 옛 구현: 반올림 자리(3→2·4), 404 대신 405, 쉼표 없는 표기만 인정, 가장 짧은 닫는 글자 대신 가장 긴 것
    const mutants = {
      locale2: (text: string, value: number) => text.includes(String(value)) || text.includes(value.toLocaleString('en-US', { maximumFractionDigits: 2 })),
      locale4: (text: string, value: number) => text.includes(String(value)) || text.includes(value.toLocaleString('en-US', { maximumFractionDigits: 4 })),
      noLocale: (text: string, value: number) => text.includes(String(value)),
    };
    const samples = [1234.5675, 0.0005, 1.00049, 12000, 999.9995, 1.23456];
    for (const [name, mutant] of Object.entries(mutants)) {
      const differs = samples.some((value) => {
        const text = `x${value.toLocaleString('en-US')}x`;
        return mutant(text, value) !== containsApiValue(text, value);
      });
      expect(differs, name).toBe(true);
    }
    const status405 = (text: string, status: number) => (status !== 405 && text.includes('This page could not be found') ? 'This page could not be found' : undefined);
    expect(status405('This page could not be found', 404)).not.toBe(nextErrorMarker('This page could not be found', 404));
    const greedy = (html: string) => html.replace(/<script[\s\S]*<\/script>/gi, ' ').replace(/<[^>]*>/g, '\n').replace(/[ \t]+/g, ' ').trim();
    expect(greedy('<script>a</script>b<script>c</script>d')).not.toBe(stripHtml('<script>a</script>b<script>c</script>d'));
    // 같은 값은 같다(대조 장치가 늘 다르다고 하지 않는다)
    expect(sameOutcome(outcome(() => legacy.stripHtml('<b>a</b>')), outcome(() => stripHtml('<b>a</b>')))).toBe(true);
  });
});
