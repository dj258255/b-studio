/* eslint-disable @typescript-eslint/no-explicit-any */
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { browserPageEvidence, finishEvidence, httpPageEvidence, testEvidence } from './check-evidence';
import { diffContracts, formatContractChanges, summarizeContract } from './contract-diff';
import { describeDeclaredCheckChange, diffDeclaredChecks, hasDeclaredCheckChange, weakenedDeclarations, withDeclaredChecks } from './declared-checks';
import * as old from './gate-review-legacy';
import { describeLoadExpect, judgeLoad, loadRequestFor } from './load-check';

/**
 * 게이트 리뷰 판정 네 가지(ADR-191 3단계 3e)를 옮기기 전의 TS(`gate-review-legacy.ts`)와 지금의 Rust 껍데기에 같은 무작위 입력을 넣어
 * 결과 글자(`JSON.stringify`, 키 순서 포함)를 견준다. 시드가 같으면 같은 입력이 나온다(mulberry32).
 *
 * 횟수는 `GATE_REVIEW_DIFF_N`(시드마다, 함수마다)과 `GATE_REVIEW_DIFF_SEEDS`로 늘린다. 기본은 빨리 도는 값이다.
 *
 * 규칙: 옛 TS가 던지면 Rust도 던져야 한다. 옛 TS가 값을 냈는데 Rust가 던지는 것은 입력이 일부러 모양을 어긋나게(또는 짝 없는
 * 서로게이트를 넣게) 만든 경우에만 허용한다(의도한 차이, 던지는 쪽 = 거부). 통과/실패 판정이 뒤집힌 경우는 따로 센다.
 */

const N = Number(process.env.GATE_REVIEW_DIFF_N ?? 4000);
const LONG = 3_600_000;
const SEEDS = (process.env.GATE_REVIEW_DIFF_SEEDS ?? '20261110,20261111').split(',').map(Number);

function makeRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

class Gen {
  constructor(readonly rand: () => number) {}
  int = (n: number): number => Math.floor(this.rand() * n);
  chance = (p: number): boolean => this.rand() < p;
  pick = <T>(items: readonly T[]): T => items[this.int(items.length)]!;
  range = (lo: number, hi: number): number => lo + this.int(hi - lo + 1);
  some = <T>(items: readonly T[], max = items.length): T[] => {
    const out: T[] = [];
    for (const item of items) if (this.chance(0.5) && out.length < max) out.push(item);
    return out;
  };
}

/** `obj[key] = value`는 키가 `__proto__`이면 속성이 아니라 프로토타입을 바꾼다. JSON.parse가 만든 객체처럼 자기 속성으로 둔다 */
function setOwn(target: any, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** NaN·Infinity·-0·undefined를 글자로 남기는 직렬화(키 순서는 객체 그대로) */
function ser(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))) return `~${Object.is(item, -0) ? '-0' : String(item)}`;
      // 짝 없는 서로게이트는 Rust로 건너갈 때 U+FFFD가 된다(근거·설명 글자에서만 허용한 차이)
      if (typeof item === 'string') return `"${toWellFormed(item)}`;
      return item;
    }) ?? 'undefined'
  );
}

type Kind = 'ok' | 'wrong' | 'surrogate';
type Outcome = { ok: true; json: string } | { ok: false; error: string };

function run(fn: () => unknown, normalize: (json: string) => string = (x) => x): Outcome {
  try {
    return { ok: true, json: normalize(ser(fn())) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

class Tally {
  total = 0;
  same = 0;
  bothThrew = 0;
  /** 옛 TS는 값을 냈고 Rust는 던졌다: 입력이 일부러 어긋났을 때만 허용 */
  rustOnlyThrew = 0;
  /** 입력이 어긋나지 않았는데 Rust만 던졌다 */
  unexpectedRustThrew = 0;
  /** 옛 TS는 던졌는데 Rust는 값을 냈다 */
  legacyOnlyThrew = 0;
  mismatches: string[] = [];
  /** 옛 TS는 실패·거부(false)인데 Rust는 통과(true)로 판정한 경우 */
  flipsToPass = 0;
  /** 반대 방향(옛 TS 통과, Rust 실패) */
  flipsToFail = 0;
  /** 옛 TS 판정 분포 */
  passes = 0;
  fails = 0;
  extra: Record<string, number> = {};
  count(name: string, amount = 1): void {
    this.extra[name] = (this.extra[name] ?? 0) + amount;
  }
}

/** 한 입력을 옛 TS와 Rust에 넣고 견준다. verdict는 결과 글자에서 통과 여부를 읽는 함수(있으면 뒤집힘을 센다) */
function compare(tally: Tally, description: () => string, kind: Kind, legacy: () => unknown, rust: () => unknown, verdict?: (json: string) => boolean, normalize?: (json: string) => string): void {
  tally.total += 1;
  const a = run(legacy, normalize);
  const b = run(rust, normalize);
  if (a.ok && b.ok) {
    if (a.json === b.json) tally.same += 1;
    else {
      if (process.env.GATE_REVIEW_DUMP) appendFileSync(process.env.GATE_REVIEW_DUMP, `${description()}\n`);
      if (tally.mismatches.length < 5) tally.mismatches.push(`${description()}\n  옛 TS: ${a.json.slice(0, 600)}\n  Rust : ${b.json.slice(0, 600)}`);
    }
    if (a.json !== b.json) tally.count('다른 결과');
    if (verdict) {
      const [x, y] = [verdict(a.json), verdict(b.json)];
      if (x) tally.passes += 1;
      else tally.fails += 1;
      if (!x && y) tally.flipsToPass += 1;
      if (x && !y) tally.flipsToFail += 1;
    }
    return;
  }
  if (!a.ok && !b.ok) {
    tally.bothThrew += 1;
    return;
  }
  if (a.ok && !b.ok) {
    if (kind === 'ok') {
      tally.unexpectedRustThrew += 1;
      if (tally.mismatches.length < 5) tally.mismatches.push(`${description()}\n  옛 TS: ${a.json.slice(0, 300)}\n  Rust 오류: ${b.error}`);
    } else tally.rustOnlyThrew += 1;
    return;
  }
  tally.legacyOnlyThrew += 1;
  if (tally.mismatches.length < 5) tally.mismatches.push(`${description()}\n  옛 TS 오류: ${(a as { error: string }).error}\n  Rust: ${(b as { json: string }).json.slice(0, 300)}`);
}

function report(name: string, tally: Tally): void {
  if (process.env.GATE_REVIEW_REPORT) appendFileSync(process.env.GATE_REVIEW_REPORT, `${JSON.stringify({ name, ...tally, mismatches: undefined })}\n`);
  // eslint-disable-next-line no-console
  console.log(`[차등] ${name}: 비교 ${tally.total}, 같음 ${tally.same}, 둘 다 던짐 ${tally.bothThrew}, 어긋난 입력에서 Rust만 던짐 ${tally.rustOnlyThrew}, 판정 뒤집힘(실패→통과 ${tally.flipsToPass}, 통과→실패 ${tally.flipsToFail}), 분포 ${JSON.stringify({ 통과: tally.passes, 실패: tally.fails, ...tally.extra })}`);
}

function assertClean(tally: Tally): void {
  expect(tally.mismatches).toEqual([]);
  expect(tally.unexpectedRustThrew).toBe(0);
  expect(tally.legacyOnlyThrew).toBe(0);
  expect(tally.flipsToPass).toBe(0);
  expect(tally.total).toBe(tally.same + tally.bothThrew + tally.rustOnlyThrew);
}

const toWellFormed = (text: string): string => (text as unknown as { toWellFormed(): string }).toWellFormed();
const wellFormed = toWellFormed;

// ───────────────────────── 확인 선언 변경 ─────────────────────────

const NAMES = ['unit', 'e2e', 'web', 'api', 'a b', '가나다', '😀', '__proto__', 'constructor', '1', '2', '10', '', 'a #2', 'x', 'orders-p95', 'toString', ' '];
const POLICY = ['api/src', '.env', 'tests/acceptance', 'git push', 'write_file', 'run', 'test', 'checkpoint', '', '😀', 'é', 'é', '1', '__proto__'];
const NUMBERS = [0, -0, 1, 3, 10, 99, 100, 0.1 + 0.2, 1e21, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e-7, 5e-324];

function genItem(g: Gen, kind: 'test' | 'page' | 'concurrency' | 'load'): any {
  const common: any = {};
  if (g.chance(0.5)) common.maxAttempts = g.pick([1, 2, 3, 0.5, Number.NaN]);
  if (g.chance(0.3)) setOwn(common, g.pick(['7', '3', 'zz', '__proto__', 'a']), g.pick([1, 'x', null, [1, 2], { a: 1 }, true]));
  if (kind === 'test') return { name: g.pick(NAMES), service: g.pick(NAMES), command: g.some(['./gradlew', 'test', 'npm', 'run', '😀'], 4), ...common };
  if (kind === 'page') return { service: g.pick(NAMES), path: g.pick(['/', '/cart', '/a b', '/😀', '']), mode: g.pick(['http', 'browser']), expectStatus: g.pick([200, 404, 500]), ...(g.chance(0.4) ? { expectText: g.pick(NAMES) } : {}), ...common };
  if (kind === 'concurrency') return { name: g.pick(NAMES), service: g.pick(NAMES), concurrent: g.pick([1, 10, 100]), ...common };
  return { name: g.pick(NAMES), service: g.pick(NAMES), method: g.pick(['GET', 'POST']), path: g.pick(['/o', '/p']), concurrent: g.pick([10, 100]), warmup: g.pick([0, 5]), expect: { p95Ms: g.pick([100, 200, 0.1 + 0.2]) }, ...common };
}

function genWorkflow(g: Gen): any {
  const w: any = {};
  const list = (kind: Parameters<typeof genItem>[1], max: number) => Array.from({ length: g.int(max + 1) }, () => genItem(g, kind));
  if (g.chance(0.7)) w.tests = list('test', 3);
  if (g.chance(0.5)) w.pageChecks = list('page', 3);
  if (g.chance(0.3)) w.concurrencyChecks = list('concurrency', 2);
  if (g.chance(0.4)) w.loadChecks = list('load', 3);
  if (g.chance(0.4)) w.autoPageChecks = { service: g.pick(NAMES), mode: 'http', maxPages: g.pick([1, 5]), expectStatus: 200, ...(g.chance(0.4) ? { sampleParams: { id: g.pick(['7', '8']) } } : {}), ...(g.chance(0.3) ? { sampleIdFrom: g.pick(['a', 'b']) } : {}), ...(g.chance(0.2) ? { '12': 'z' } : {}) };
  if (g.chance(0.4)) w.required = g.some(['run', 'review', 'test'], 3);
  if (g.chance(0.6)) w.protectedPaths = g.some(POLICY, 4);
  if (g.chance(0.4)) w.evaluationAssets = g.some(POLICY, 3);
  if (g.chance(0.5)) w.deniedCommands = g.some(POLICY, 3);
  if (g.chance(0.4)) w.requireApprovalFor = g.some(POLICY, 3);
  if (g.chance(0.5)) w.releaseRequires = g.some(POLICY, 3);
  if (g.chance(0.4)) w.allowedTools = g.some(['read_file', 'write_file', 'run', '😀', '1'], 4);
  if (g.chance(0.5)) w.maxChangedFiles = g.pick(NUMBERS);
  if (g.chance(0.4)) w.maxTurns = g.pick([20, 300]);
  return w;
}

/** 시작 선언에서 몇 군데를 바꾼 지금 선언 */
function mutateWorkflow(g: Gen, started: any): any {
  const latest: any = structuredClone(started);
  const steps = g.int(4);
  for (let i = 0; i < steps; i++) {
    const field = g.pick(['tests', 'pageChecks', 'concurrencyChecks', 'loadChecks'] as const);
    switch (g.int(13)) {
      case 0:
        delete latest[field];
        break;
      case 1:
        latest[field] = [...(latest[field] ?? []), genItem(g, field === 'tests' ? 'test' : field === 'pageChecks' ? 'page' : field === 'loadChecks' ? 'load' : 'concurrency')];
        break;
      case 2:
        if (latest[field]?.length) latest[field].splice(g.int(latest[field].length), 1);
        break;
      case 3:
        if (latest[field]?.length) latest[field][g.int(latest[field].length)] = { ...latest[field][0], changed: g.pick([1, 'a', null]) };
        break;
      case 4:
        if (latest[field]?.length > 1) latest[field].reverse();
        break;
      case 5: {
        const key = g.pick(['protectedPaths', 'evaluationAssets', 'deniedCommands', 'requireApprovalFor', 'releaseRequires'] as const);
        if (latest[key]?.length) latest[key].splice(g.int(latest[key].length), 1);
        else latest[key] = g.some(POLICY, 3);
        break;
      }
      case 6:
        latest.allowedTools = g.chance(0.4) ? undefined : g.some(['read_file', 'write_file', 'run', '😀', '1'], 4);
        break;
      case 7:
        latest.maxChangedFiles = g.chance(0.3) ? undefined : g.pick(NUMBERS);
        break;
      case 8:
        if (latest.autoPageChecks) latest.autoPageChecks = { ...latest.autoPageChecks, sampleParams: { id: g.pick(['9', '10']) }, sampleIdFrom: g.pick(['q', undefined]) };
        break;
      case 9:
        latest.required = g.chance(0.4) ? undefined : g.some(['run', 'review', 'test'], 3);
        break;
      case 10:
        if (latest.autoPageChecks) latest.autoPageChecks = { ...latest.autoPageChecks, maxPages: g.pick([1, 5, 9]) };
        else latest.autoPageChecks = { service: 'web', mode: 'http', maxPages: 5, expectStatus: 200 };
        break;
      case 11:
        // 같은 화면을 두 번 확인
        if (latest.pageChecks?.length) latest.pageChecks.push(structuredClone(latest.pageChecks[0]), structuredClone(latest.pageChecks[0]));
        break;
      default:
        latest.maxTurns = g.pick([20, 300, undefined]);
    }
  }
  return latest;
}

function wrongWorkflow(g: Gen, w: any): { workflow: any; kind: Kind } {
  const copy = structuredClone(w ?? {});
  switch (g.int(10)) {
    case 0:
      copy.tests = g.pick(['abc', 5, { name: 'x' }, [null], [undefined]]);
      break;
    case 1:
      copy.autoPageChecks = g.pick(['x', [1, 2], 5, true]);
      break;
    case 2:
      copy.protectedPaths = g.pick(['api/src', 5, { a: 1 }, true]);
      break;
    case 3:
      copy.allowedTools = g.pick(['read_file', 5, { a: 1 }, true]);
      break;
    case 4:
      copy.pageChecks = [null];
      break;
    case 5:
      return { workflow: g.pick(['abc', [1], 5, true]), kind: 'wrong' };
    case 6:
      // 짝 없는 서로게이트가 든 이름
      copy.tests = [{ name: g.pick(['\ud800', 'a\udc00', '\ud800x']), service: 's' }];
      return { workflow: copy, kind: 'surrogate' };
    case 7:
      copy.releaseRequires = ['\ud800'];
      return { workflow: copy, kind: 'surrogate' };
    case 8:
      copy.deniedCommands = [5, null, 'x', Number.NaN, true];
      return { workflow: copy, kind: 'ok' };
    default:
      copy.requireApprovalFor = 'write_file';
  }
  return { workflow: copy, kind: 'wrong' };
}

function declaredPair(g: Gen): { started: any; latest: any; kind: Kind } {
  if (g.chance(0.04)) return { started: g.pick([undefined, {}, null]), latest: g.chance(0.5) ? genWorkflow(g) : undefined, kind: 'ok' };
  const started = genWorkflow(g);
  let latest = g.chance(0.18) ? structuredClone(started) : mutateWorkflow(g, started);
  let kind: Kind = 'ok';
  if (g.chance(0.04)) {
    const wrong = wrongWorkflow(g, latest);
    latest = wrong.workflow;
    kind = wrong.kind;
  } else if (g.chance(0.03)) {
    const wrong = wrongWorkflow(g, started);
    return { started: wrong.workflow, latest, kind: wrong.kind };
  }
  return { started, latest, kind };
}

describe.each(SEEDS)('차등 시험: 확인 선언 변경 (시드 %i)', (seed) => {
  it('diffDeclaredChecks·weakenedDeclarations·hasDeclaredCheckChange·describeDeclaredCheckChange·withDeclaredChecks가 옛 TS와 글자까지 같다', () => {
    const g = new Gen(makeRandom(seed));
    const diff = new Tally();
    const weak = new Tally();
    const merge = new Tally();
    const text = new Tally();
    for (let i = 0; i < N; i++) {
      const { started, latest, kind } = declaredPair(g);
      const desc = () => JSON.stringify({ started, latest }).slice(0, 800);
      // 선언 변경 판정: 바뀐 것이 있으면 "실패 쪽"(통과가 아니다)
      const changed = (json: string): boolean => !json.includes('"added":[],"removed":[],"changed":[]');
      compare(diff, desc, kind, () => old.diffDeclaredChecks(started, latest), () => diffDeclaredChecks(started, latest), (json) => !changed(json));
      compare(weak, desc, kind, () => old.weakenedDeclarations(started, latest), () => weakenedDeclarations(started, latest), (json) => json === '[]');
      compare(merge, desc, kind, () => old.withDeclaredChecks(started, latest), () => withDeclaredChecks(started, latest));
      // hasDeclaredCheckChange·describe는 diff 결과를 받는다
      let legacyChange: old.DeclaredCheckChange | undefined;
      try {
        legacyChange = old.diffDeclaredChecks(started, latest);
      } catch {
        continue;
      }
      const change = legacyChange;
      compare(text, desc, 'ok', () => [old.hasDeclaredCheckChange(change), old.describeDeclaredCheckChange(change)], () => [hasDeclaredCheckChange(change), describeDeclaredCheckChange(change)], (json) => json.startsWith('[false'), wellFormed);
    }
    for (const [name, tally] of [['diffDeclaredChecks', diff], ['weakenedDeclarations', weak], ['withDeclaredChecks', merge], ['has/describeDeclaredCheckChange', text]] as const) {
      report(`${name} 시드 ${seed}`, tally);
      assertClean(tally);
    }
    // 입력이 한쪽으로 쏠리지 않았다: 바뀐 것도 같은 것도 있고, 약해진 것도 아닌 것도 있다
    expect(diff.passes).toBeGreaterThan(N * 0.05);
    expect(diff.fails).toBeGreaterThan(N * 0.2);
    expect(weak.passes).toBeGreaterThan(N * 0.1);
    expect(weak.fails).toBeGreaterThan(N * 0.15);
    expect(merge.same).toBeGreaterThan(N * 0.8);
  }, LONG);
});

// ───────────────────────── 부하 판정 ─────────────────────────

const STATUS_KEYS = ['200', '201', '204', '299', '301', '400', '404', '409', '429', '500', '502', '503', '2xx', '5xx', '20', '2'];
const ERROR_KEYS = ['TIMEOUT', 'ECONNRESET', 'DEADLINE', 'ECONNREFUSED', 'EPIPE', '7'];
const LIMITS = [0, 1, 5, 50, 100, 200, 1000, 0.1, 0.1 + 0.2, 1e21, 1234.5];
const ELAPSED = [0, 0.4, 0.5, 1, 999, 999.4, 999.5, 1000, 1000.04, 1000.05, 1234.5, 12_345.678, 59_999.99, 1e9, -5, -0, Number.NaN, Number.POSITIVE_INFINITY, 1e-320];

function count(g: Gen): number {
  if (g.chance(0.02)) return g.pick([Number.NaN, 0.5, -1, 1e21, -0]);
  return g.chance(0.3) ? 0 : g.range(1, 500);
}

function genLoadCase(g: Gen): { check: any; result: any; kind: Kind } {
  // 깨끗한 응답(2xx뿐, 오류 없음)이 모자라면 통과가 거의 안 나온다: 따로 비율을 둔다
  const clean = g.chance(0.4);
  const expectBlock: any = {};
  for (const key of ['p50Ms', 'p95Ms', 'p99Ms', 'maxMs'] as const) if (g.chance(0.45)) expectBlock[key] = g.chance(0.03) ? g.pick([Number.NaN, -1]) : g.pick(LIMITS);
  if (g.chance(0.3)) expectBlock.latencyOf = g.pick([[200], [200, 201], [409], [], [1e21, Number.NaN]]);
  if (g.chance(0.5)) expectBlock.allStatusIn = clean ? g.pick([[200, 201, 204], [200, 201, 204, 409]]) : g.pick([[200], [200, 409], [200, 201, 204], [], [404, 500, 503]]);
  const statuses: Record<string, number> = {};
  for (const key of clean ? ['200', ...g.some(['201', '204'])] : g.some(STATUS_KEYS, 5)) statuses[key] = clean ? g.range(1, 300) : count(g);
  const errors: Record<string, number> = {};
  if (!clean && g.chance(0.35)) for (const key of g.some(ERROR_KEYS, 3)) errors[key] = count(g);
  const successes = Object.entries(statuses).reduce((sum, [key, amount]) => (key.startsWith('2') ? sum + amount : sum), 0);
  if (g.chance(0.4)) {
    const around = g.pick([0, 0, 0, 1, -1]);
    const successCount: any = {};
    if (g.chance(0.6)) successCount.exactly = Number.isFinite(successes) ? successes + around : g.pick([0, 1]);
    if (g.chance(0.6)) successCount.atMost = Number.isFinite(successes) ? successes + around : g.pick([0, 1]);
    expectBlock.successCount = successCount;
  }
  // 응답 시간: 기준과 같은 값·바로 위·바로 아래가 많이 나오게 한다
  const latencyCount = g.chance(0.1) ? 0 : g.chance(0.03) ? g.pick([Number.NaN, -1, 0.5]) : g.range(1, 400);
  const latency: any = { count: latencyCount };
  const near = (limit: number | undefined): number => {
    if (limit === undefined || !Number.isFinite(limit)) return g.pick([0, 1, 5, 100, 1e21, 250.5]);
    if (clean) return g.pick([limit, limit, limit - 1, limit - 0.1, 0, limit / 2, limit + 1]);
    return g.pick([limit, limit, limit, limit + 1, limit - 1, limit + 0.1, limit - 0.1, limit * 1.0000001, limit * 0.9999999, limit + Number.EPSILON * limit, 0, limit + 0.1 + 0.2]);
  };
  for (const [key, label] of [['p50Ms', 'p50'], ['p95Ms', 'p95'], ['p99Ms', 'p99'], ['maxMs', 'max']] as const) if (g.chance(0.92)) latency[label] = near(expectBlock[key]);
  // 러너 밀림: 기준을 넘겼을 때의 문턱 max(5, 가장 작은 기준 * 0.1)과 같은 값·바로 위·아래
  const limitsGiven = Object.values(expectBlock).filter((v): v is number => typeof v === 'number');
  const threshold = Math.max(5, Math.min(...(limitsGiven.length ? limitsGiven : [50])) * 0.1);
  const loopP99 = g.chance(0.5) ? g.pick([threshold, threshold, threshold + 0.001, threshold - 0.001, threshold * 1.0000001, 0, 5, 4.999, 5.001, 100]) : g.pick([0, 0.5, 3, 10, 80, 1e21, Number.NaN]);
  const requests = g.pick([count(g), g.range(1, 600)]);
  const result: any = {
    requests,
    concurrent: g.pick([1, 10, 100]),
    threads: g.pick([1, 4]),
    completed: g.chance(0.9) ? g.range(0, 600) : g.pick([Number.NaN, 0.5, 1e21]),
    elapsedMs: g.pick(ELAPSED),
    statuses,
    errors,
    latency,
    connect: { count: g.range(0, 100), ...(g.chance(0.8) ? { p95: g.pick([1, 3.5, 0, 1e21]) } : {}), errors: g.range(0, 3) },
    loopDelay: { p99: loopP99, max: g.pick([0, 50]) },
    warmup: { requests: g.pick([0, 0, 5, 20, -1, Number.NaN]), errors: g.pick([0, 0, 1, 3, Number.NaN]) },
  };
  const check: any = {
    name: 'orders',
    service: g.pick(['api', 'web']),
    method: g.pick(['GET', 'POST']),
    path: g.pick(['/orders', '/😀']),
    concurrent: g.pick([1, 100]),
    warmup: 0,
    ...(g.chance(0.5) ? { requests: g.pick([100, 0, 1000]) } : {}),
    expect: expectBlock,
  };
  let kind: Kind = 'ok';
  if (g.chance(0.04)) {
    switch (g.int(7)) {
      case 0:
        result.latency = null;
        break;
      case 1:
        result.statuses = [1, 2];
        break;
      case 2:
        result.errors = { TIMEOUT: '5' };
        break;
      case 3:
        result.connect = undefined;
        break;
      case 4:
        check.expect = undefined;
        break;
      case 5:
        latency.p95 = '300';
        expectBlock.p95Ms = 200;
        break;
      default:
        check.expect.allStatusIn = '200';
    }
    kind = 'wrong';
  } else if (g.chance(0.02)) {
    result.statuses['2\ud800'] = 3;
    kind = 'surrogate';
  }
  return { check, result, kind };
}

describe.each(SEEDS)('차등 시험: 부하 판정 (시드 %i)', (seed) => {
  it('judgeLoad·loadRequestFor·describeLoadExpect가 옛 TS와 글자까지 같다', () => {
    const g = new Gen(makeRandom(seed));
    const judge = new Tally();
    const request = new Tally();
    const describe_ = new Tally();
    const exceeded: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const { check, result, kind } = genLoadCase(g);
      const desc = () => JSON.stringify({ check, result }).slice(0, 900);
      compare(judge, desc, kind, () => old.judgeLoad(check, result), () => judgeLoad(check, result), (json) => json.includes('"problems":[]'));
      compare(request, desc, kind === 'surrogate' ? 'ok' : kind, () => old.loadRequestFor(check), () => loadRequestFor(check));
      compare(describe_, desc, kind === 'surrogate' ? 'ok' : kind, () => old.describeLoadExpect(check.expect), () => describeLoadExpect(check.expect));
      const verdict = run(() => old.judgeLoad(check, result));
      if (verdict.ok) {
        for (const tag of ['응답을 받지 못한', '성공 ', '기대 밖 상태 코드', '서버 오류 응답', 'ms (기준:', '러너 자신이', '잴 ', '없습니다']) if (verdict.json.includes(tag)) exceeded[tag] = (exceeded[tag] ?? 0) + 1;
      }
    }
    judge.extra = { ...judge.extra, ...exceeded };
    for (const [name, tally] of [['judgeLoad', judge], ['loadRequestFor', request], ['describeLoadExpect', describe_]] as const) {
      report(`${name} 시드 ${seed}`, tally);
      assertClean(tally);
    }
    // 통과와 실패가 모두 충분하고, 문제 종류가 고르게 나온다
    expect(judge.passes).toBeGreaterThan(N * 0.03);
    expect(judge.fails).toBeGreaterThan(N * 0.3);
    for (const tag of ['응답을 받지 못한', '성공 ', '기대 밖 상태 코드', '서버 오류 응답', 'ms (기준:', '러너 자신이']) expect(exceeded[tag] ?? 0, tag).toBeGreaterThan(N * 0.005);
  }, LONG);
});

// ───────────────────────── 근거 줄 ─────────────────────────

const SECRET = 'S3CR3T';
const redactors: Array<[string, (text: string) => string]> = [
  ['시크릿', (t) => t.split(SECRET).join('***')],
  ['그대로', (t) => t],
  ['대문자', (t) => t.replace(/abc/g, 'X')],
];

const WORDS = ['바로 주문', '12,000원', 'abc', 'S3CR3T', '😀', '가나다', '', ' ', 'ab', 'x'.repeat(59), 'x'.repeat(60), 'x'.repeat(61), '가'.repeat(239), '가'.repeat(241), `${'x'.repeat(59)}😀`, `${'y'.repeat(58)}S3CR3T`, `${'y'.repeat(238)}😀😀`, ' ', "it's"];

function genText(g: Gen, words: string[]): string {
  return [...words.filter(() => g.chance(0.6)), ...Array.from({ length: g.int(3) }, () => g.pick(WORDS))].join(g.pick(['', ' ', '\n']));
}

const LOCALE_NUMBERS = [0, -0, 1, 12, 999, 1000, 1234, 12_345.5, 0.0005, 0.0004, 0.9995, 1.0005, 2.5e-4, 0.1 + 0.2, 1e6, 1e21, 1.2345678901234567e25, 1e-7, 5e-324, Number.MAX_VALUE, -1, -1234.5678, -0.0001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 123_456_789.123_456, 4.9995, 99.9995, 999_999.9995];

function randomNumber(g: Gen): number {
  if (g.chance(0.35)) return g.pick(LOCALE_NUMBERS);
  if (g.chance(0.4)) return Math.round(g.rand() * 10 ** g.int(9)) / 10 ** g.int(5);
  return (g.rand() - 0.3) * 10 ** (g.int(30) - 8);
}

function genPageCase(g: Gen, mode: 'browser' | 'http'): { page: any; result: any; context: any; kind: Kind } {
  const candidates = ['바로 주문', '12,000원', 'abc', 'S3CR3T', '😀', 'x'.repeat(61), '가'.repeat(100), '없는 문구'];
  const page: any = { service: 'web', path: '/live/1', mode, expectStatus: g.pick([200, 404]), allowConsoleErrors: g.chance(0.3), noHorizontalScroll: g.chance(0.5) };
  if (g.chance(0.4)) page.expectText = g.pick(candidates);
  if (g.chance(0.4)) page.expectAnyText = g.some(candidates, 4);
  if (g.chance(0.4)) page.expectAllText = g.some(candidates, 4);
  if (g.chance(0.4)) page.expectInViewport = g.some(candidates, 3);
  if (g.chance(0.2)) page.allowLoadingPlaceholder = true;
  if (g.chance(0.3)) page.maxLoadMs = randomNumber(g);
  if (g.chance(0.4)) page.steps = Array.from({ length: g.range(0, 3) }, () => ({ action: 'click', selector: 'a' }));
  const result: any = {
    status: g.pick([200, 200, 404, null, 500]),
    text: genText(g, candidates),
    pageErrors: Array.from({ length: g.int(3) }, () => 'e'),
    consoleErrors: Array.from({ length: g.int(3) }, () => 'c'),
    failedRequests: Array.from({ length: g.int(3) }, () => 'f'),
    mediaErrors: Array.from({ length: g.int(2) }, () => 'm'),
    blockedRequests: [],
    horizontalOverflowPx: g.pick([0, 0, 3, 3.5, -0, Number.NaN]),
    steps: [{ label: 'open /live/1', ok: true, ...(g.chance(0.2) ? { screenshot: Buffer.from('png') } : {}) }, ...Array.from({ length: g.int(4) }, (_, k) => ({ label: g.pick([`click ${k}`, '가나', '😀', `${'z'.repeat(70)}`]), ok: g.chance(0.7) }))],
  };
  if (g.chance(0.5)) result.loadMs = randomNumber(g);
  if (g.chance(0.5)) {
    result.viewportTexts = {
      width: g.pick([390, 1280]),
      height: g.pick([844, 720]),
      findings: Array.from({ length: g.int(5) }, () => ({ text: g.pick(candidates), visible: g.chance(0.6), ...(g.chance(0.3) ? { problem: { kind: 'below', px: 4 } } : {}) })),
    };
  }
  const context: any = {};
  if (g.chance(0.3)) context.auto = true;
  if (g.chance(0.3)) context.probedId = g.pick(['1', '7', '😀', 'S3CR3T']);
  if (g.chance(0.4)) context.api = { service: 'api', jsonPath: '$.id', value: g.pick(['S3CR3T', 'x'.repeat(75), 42, 0.5, 1e21, '😀'.repeat(40), '가나']) };
  let kind: Kind = 'ok';
  if (g.chance(0.03)) {
    switch (g.int(5)) {
      case 0:
        result.text = null;
        break;
      case 1:
        result.consoleErrors = undefined;
        break;
      case 2:
        page.expectAnyText = 'abc';
        break;
      case 3:
        result.loadMs = null;
        break;
      default:
        page.maxLoadMs = null;
        result.loadMs = 5;
    }
    kind = 'wrong';
  }
  return { page, result, context, kind };
}

describe.each(SEEDS)('차등 시험: 근거 줄 (시드 %i)', (seed) => {
  it('browserPageEvidence·httpPageEvidence·finishEvidence·testEvidence가 옛 TS와 글자까지 같고 redact를 같은 순서로 부른다', () => {
    const g = new Gen(makeRandom(seed));
    const browser = new Tally();
    const http = new Tally();
    const finish = new Tally();
    const tests = new Tally();
    for (let i = 0; i < N; i++) {
      const [, redact] = g.pick(redactors);
      const { page, result, context, kind } = genPageCase(g, 'browser');
      // redact 호출 순서까지 견준다(가린 뒤에 자르는지, 몇 번 부르는지)
      const calls: { old: string[]; rust: string[] } = { old: [], rust: [] };
      const track = (side: 'old' | 'rust') => (text: string) => {
        calls[side].push(text);
        return redact(text);
      };
      const desc = () => JSON.stringify({ page, result: { ...result, steps: undefined }, context }).slice(0, 700);
      compare(
        browser,
        desc,
        kind,
        () => {
          calls.old = [];
          return old.finishEvidence(old.browserPageEvidence(page, result, { ...context, redact: track('old') }), track('old'));
        },
        () => {
          calls.rust = [];
          return finishEvidence(browserPageEvidence(page, result, { ...context, redact: track('rust') }), track('rust'));
        },
        undefined,
        wellFormed,
      );
      if (kind === 'ok') {
        expect(calls.rust.map(toWellFormed), desc()).toEqual(calls.old.map(toWellFormed));
        browser.count('redact 호출 비교', 1);
      }
      const http_ = genPageCase(g, 'http');
      const response = { status: g.pick([200, 404, 500]), text: http_.result.text };
      compare(
        http,
        () => JSON.stringify({ page: http_.page, response, context: http_.context }).slice(0, 700),
        http_.kind,
        () => old.finishEvidence(old.httpPageEvidence(http_.page, response, { ...http_.context, redact }), redact),
        () => finishEvidence(httpPageEvidence(http_.page, response, { ...http_.context, redact }), redact),
        undefined,
        wellFormed,
      );
      const lines = Array.from({ length: g.pick([0, 1, 5, 11, 12, 13, 14, 30]) }, () => g.pick(WORDS) + g.pick(['', 'S3CR3T', 'abc']));
      const [, redact2] = g.pick(redactors);
      compare(finish, () => JSON.stringify(lines).slice(0, 500), 'ok', () => old.finishEvidence(lines, redact2), () => finishEvidence(lines, redact2), undefined, wellFormed);
      const command = Array.from({ length: g.int(4) }, () => g.pick(['npm', 'run', 'test', '--', 'a b', '😀', '`x`']));
      const elapsed = g.chance(0.5) ? randomNumber(g) * 1000 : g.pick([0, 9999, 9999.9, 10_000, 9950, 9949.999, 9500, 10_500, 10_499.9999, 1e12, -5000, 12_345_678, 0.04, 49, 50, 99.5]);
      const service = g.pick(['api', '😀', '가', 'a b']);
      compare(tests, () => JSON.stringify({ service, command, elapsed }), 'ok', () => old.testEvidence(service, command, elapsed), () => testEvidence(service, command, elapsed));
      const okLines = run(() => old.browserPageEvidence(page, result, context));
      if (okLines.ok) browser.count(`줄 ${Math.min(10, JSON.parse(okLines.json.replace(/~/g, '')).length)}`);
    }
    for (const [name, tally] of [['browserPageEvidence', browser], ['httpPageEvidence', http], ['finishEvidence', finish], ['testEvidence', tests]] as const) {
      report(`${name} 시드 ${seed}`, tally);
      expect(tally.mismatches).toEqual([]);
      expect(tally.unexpectedRustThrew).toBe(0);
      expect(tally.legacyOnlyThrew).toBe(0);
    }
    expect(browser.same).toBeGreaterThan(N * 0.9);
  }, LONG);

  it('toLocaleString(ko-KR)과 같게 수를 적는다: 로드 시간·예산·걸린 시간', () => {
    const g = new Gen(makeRandom(seed + 1));
    let compared = 0;
    for (let i = 0; i < N * 5; i++) {
      const x = randomNumber(g);
      const page: any = { service: 'web', path: '/', mode: 'browser', expectStatus: 200, maxLoadMs: x };
      const result: any = { status: 200, text: '', pageErrors: [], consoleErrors: [], failedRequests: [], mediaErrors: [], horizontalOverflowPx: 0, steps: [], loadMs: randomNumber(g) };
      expect(ser(browserPageEvidence(page, result)), String(x)).toBe(ser(old.browserPageEvidence(page, result)));
      compared += 1;
    }
    expect(compared).toBe(N * 5);
  }, LONG);
});

// ───────────────────────── 계약 비교 ─────────────────────────

const SCHEMA_NAMES = ['Order', 'User', 'Item', 'constructor', 'toString', '__proto__', 'valueOf', '404', '0', '12', 'a.b', '가나', '😀', 'hasOwnProperty', '', 'order'];
const PROP_NAMES = ['id', 'memo', 'name', 'constructor', 'valueOf', 'toString', '__proto__', '1', '2', '10', 'a b', '가', '😀', 'isPrototypeOf', 'items', 'propertyIsEnumerable'];
const ROUTES = ['/orders', '/orders/{id}', '/users', '/a b', '/😀', '/404', '/'];
const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace', 'GET', 'Post', 'pArAmEtErs', 'parameters', 'summary', 'x-extra', 'İ', 'K', 'geT', 'ǆ', 'connect'];

function genSchema(g: Gen, depth = 0): any {
  const s: any = {};
  const form = g.int(9);
  if (form === 0) return { $ref: g.pick(['#/components/schemas/Order', '#/components/schemas/User', 'Item', '', '#/definitions/a/b/c', '/', 'x/']) };
  if (form === 1 && depth < 3) return { type: 'array', items: genSchema(g, depth + 1), ...(g.chance(0.3) ? { format: 'x' } : {}) };
  if (form === 2) return { type: g.pick([['string', 'null'], ['null'], ['integer', 'string'], ['array'], [], ['string', null], [1, 2]]) };
  if (form === 3 && depth < 2) {
    s.type = 'object';
    s.properties = genProps(g, depth + 1);
    return s;
  }
  if (g.chance(0.85)) s.type = g.pick(['string', 'integer', 'number', 'boolean', 'object', 'array']);
  if (g.chance(0.4)) s.format = g.pick(['int64', 'date-time', 'uuid', '', 0, 5]);
  if (g.chance(0.1)) s.enum = ['a', 'b'];
  if (g.chance(0.05)) s.items = { type: 'string' };
  return s;
}

function genProps(g: Gen, depth = 0): any {
  const props: any = {};
  for (const name of g.some(PROP_NAMES, 6)) setOwn(props, name, genSchema(g, depth));
  return props;
}

function genDoc(g: Gen): any {
  const doc: any = {};
  if (g.chance(0.9)) {
    doc.paths = {};
    for (const route of g.some(ROUTES, 4)) {
      const item: any = {};
      for (const method of g.some(METHODS, 5)) item[method] = g.pick([{}, { operationId: 'x' }, [], 'x']);
      setOwn(doc.paths, route, item);
    }
  }
  if (g.chance(0.9)) {
    doc.components = { schemas: {} };
    for (const name of g.some(SCHEMA_NAMES, 5)) {
      const schema: any = { type: 'object', properties: genProps(g) };
      if (g.chance(0.6)) schema.required = g.some(PROP_NAMES, 3);
      setOwn(doc.components.schemas, name, schema);
    }
  }
  return doc;
}

function mutateDoc(g: Gen, before: any): any {
  const after: any = structuredClone(before);
  const steps = g.int(5);
  for (let i = 0; i < steps; i++) {
    const schemas: any = after.components?.schemas;
    const names = Object.keys(schemas ?? {}).filter((n) => typeof schemas[n] === 'object' && schemas[n] !== null && !Array.isArray(schemas[n]));
    const name = names.length ? g.pick(names) : undefined;
    switch (g.int(12)) {
      case 0:
        if (name) delete schemas[name];
        break;
      case 1:
        if (schemas) setOwn(schemas, g.pick(SCHEMA_NAMES), { type: 'object', properties: genProps(g) });
        break;
      case 2:
        if (name && schemas[name].properties) delete schemas[name].properties[g.pick(PROP_NAMES)];
        break;
      case 3:
        if (name) setOwn((schemas[name].properties ??= {}), g.pick(PROP_NAMES), genSchema(g));
        break;
      case 4:
        if (name) {
          const props = schemas[name].properties ?? {};
          const prop = Object.keys(props).length ? g.pick(Object.keys(props)) : undefined;
          if (prop) props[prop] = genSchema(g);
        }
        break;
      case 5:
        if (name) schemas[name].required = g.some(PROP_NAMES, 3);
        break;
      case 6:
        if (name && schemas[name].required) schemas[name].required.push(g.pick(PROP_NAMES));
        break;
      case 7:
        if (after.paths) delete after.paths[g.pick(ROUTES)];
        break;
      case 8:
        if (after.paths) setOwn((after.paths[g.pick(ROUTES)] ??= {}), g.pick(METHODS), {});
        break;
      case 9:
        if (after.paths) for (const route of Object.keys(after.paths)) if (g.chance(0.5)) delete after.paths[route][g.pick(METHODS)];
        break;
      case 10:
        if (name) schemas[name] = g.pick([null, 0, '', {}, [], 'x']);
        break;
      default:
        if (name && schemas[name]?.properties) {
          const props = schemas[name].properties;
          const keys = Object.keys(props);
          if (keys.length) props[g.pick(keys)] = g.pick([null, 0, '', {}, 'x', { type: 'string', format: 'int64' }, { $ref: '#/components/schemas/Order' }]);
        }
    }
  }
  return after;
}

function wrongDoc(g: Gen, doc: any): { doc: any; kind: Kind } {
  const copy = structuredClone(doc);
  switch (g.int(8)) {
    case 0:
      copy.paths = g.pick(['x', [{ get: {} }], 5, true]);
      break;
    case 1:
      copy.components = { schemas: g.pick(['abc', [], 5]) };
      break;
    case 2:
      copy.paths = { '/a': null };
      break;
    case 3:
      copy.components = { schemas: { A: { type: 'object', properties: 'abc' } } };
      break;
    case 4:
      copy.components = { schemas: { A: { required: 'id' } } };
      break;
    case 5:
      copy.components = { schemas: { A: { properties: { p: { $ref: 5 } } } } };
      break;
    case 6:
      copy.components = { schemas: { '\ud800': { properties: {} } } };
      return { doc: copy, kind: 'surrogate' };
    default:
      copy.components = { schemas: { A: { properties: { p: { type: 5 } } } } };
  }
  return { doc: copy, kind: 'wrong' };
}

describe.each(SEEDS)('차등 시험: 계약 비교 (시드 %i)', (seed) => {
  it('diffContracts·summarizeContract·formatContractChanges가 옛 TS와 글자까지 같다', () => {
    const g = new Gen(makeRandom(seed));
    const diff = new Tally();
    const summary = new Tally();
    const format = new Tally();
    const kinds: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      let before: any = genDoc(g);
      let after: any = g.chance(0.12) ? structuredClone(before) : mutateDoc(g, before);
      let kind: Kind = 'ok';
      if (g.chance(0.04)) {
        const wrong = wrongDoc(g, g.chance(0.5) ? before : after);
        if (g.chance(0.5)) before = wrong.doc;
        else after = wrong.doc;
        kind = wrong.kind;
      }
      if (g.chance(0.05)) before = undefined;
      const desc = () => JSON.stringify({ before, after }).slice(0, Number(process.env.GATE_REVIEW_DESC ?? 900));
      // 호환 깨짐이 없으면 통과, 있으면 실패
      compare(diff, desc, kind, () => old.diffContracts(before, after), () => diffContracts(before, after), (json) => !json.includes('"breaking":true'));
      compare(summary, desc, kind, () => old.summarizeContract(after), () => summarizeContract(after));
      let changes: old.ContractChange[] | undefined;
      try {
        changes = old.diffContracts(before, after);
      } catch {
        continue;
      }
      const list = changes;
      for (const change of list) kinds[change.kind] = (kinds[change.kind] ?? 0) + 1;
      compare(format, desc, 'ok', () => old.formatContractChanges(list), () => formatContractChanges(list));
    }
    diff.extra = { ...diff.extra, ...kinds };
    for (const [name, tally] of [['diffContracts', diff], ['summarizeContract', summary], ['formatContractChanges', format]] as const) {
      report(`${name} 시드 ${seed}`, tally);
      assertClean(tally);
    }
    expect(diff.passes).toBeGreaterThan(N * 0.05);
    expect(diff.fails).toBeGreaterThan(N * 0.3);
    for (const kind of ['operation-added', 'operation-removed', 'schema-added', 'schema-removed', 'property-added', 'property-removed', 'property-type-changed', 'property-became-required']) expect(kinds[kind] ?? 0, kind).toBeGreaterThan(N * 0.02);
  }, LONG);
});

describe.each(SEEDS)('차등 시험: 수를 글자로 쓰는 규칙 (시드 %i)', (seed) => {
  it('Number#toString과 같다: 임의의 비트 무늬, 정수·소수 가운데(.25·.75), 2의 거듭제곱 둘레', () => {
    const g = new Gen(makeRandom(seed + 2));
    const view = new DataView(new ArrayBuffer(8));
    const text = (x: number): string => describeLoadExpect({ p50Ms: x } as never);
    const samples = 5 * N;
    for (let i = 0; i < samples; i++) {
      let x: number;
      const mode = g.int(4);
      if (mode === 0) {
        view.setUint32(0, Math.floor(g.rand() * 2 ** 32));
        view.setUint32(4, Math.floor(g.rand() * 2 ** 32));
        x = view.getFloat64(0);
      } else if (mode === 1) {
        // 16~17자리에서 정확한 값이 가운데가 되기 쉬운 수: 큰 정수 + .25/.5/.75
        x = Math.floor(g.rand() * 2 ** 53) / 2 ** g.int(4) + g.pick([0, 0.25, 0.5, 0.75]);
      } else if (mode === 2) {
        // 2의 거듭제곱 바로 위아래(간격이 비대칭인 곳)
        const e = g.int(120) - 20;
        x = 2 ** e * g.pick([1, 1 + Number.EPSILON, 1 - Number.EPSILON / 2, 1.5]);
      } else {
        x = Number((g.rand() * 10 ** (g.int(40) - 15)).toPrecision(g.range(14, 17)));
      }
      if (!Number.isFinite(x)) continue;
      expect(text(x), String(x)).toBe(`p50 ${x}ms 이하`);
    }
  }, LONG);
});

// ───────────────────────── 대조 장치 ─────────────────────────

describe('대조 장치: 이 시험이 다른 결과를 잡는지', () => {
  it('옛 TS의 경계를 한 칸 바꾼 구현과 견주면 다른 결과를 센다', () => {
    const g = new Gen(makeRandom(99));
    const tally = new Tally();
    for (let i = 0; i < 2000; i++) {
      const { check, result } = genLoadCase(g);
      // 기준과 같은 값을 실패로 보는 틀린 판정(> 대신 >=)을 흉내 낸다: 문제 목록에 한 줄을 더 얹는다
      compare(
        tally,
        () => JSON.stringify({ check, result }).slice(0, 200),
        'ok',
        () => {
          const judged = old.judgeLoad(check, result);
          const equalAtLimit = (['p50', 'p95', 'p99', 'max'] as const).some((label, k) => result.latency[label] !== undefined && check.expect[['p50Ms', 'p95Ms', 'p99Ms', 'maxMs'][k]!] === result.latency[label]);
          return equalAtLimit ? { ...judged, problems: [...judged.problems, '경계'] } : judged;
        },
        () => judgeLoad(check, result),
      );
    }
    expect(tally.mismatches.length + (tally.extra['다른 결과'] ?? 0)).toBeGreaterThan(50);
  });

  it('선언 변경을 못 보는 틀린 구현과 견주면 다른 결과를 센다', () => {
    const g = new Gen(makeRandom(98));
    const tally = new Tally();
    for (let i = 0; i < 1000; i++) {
      const { started, latest } = declaredPair(g);
      compare(
        tally,
        () => JSON.stringify({ started, latest }).slice(0, 200),
        'ok',
        () => ({ added: [], removed: [], changed: [] }),
        () => diffDeclaredChecks(started, latest),
      );
    }
    expect(tally.extra['다른 결과'] ?? 0).toBeGreaterThan(200);
  });
});
