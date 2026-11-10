import { appendFileSync } from 'node:fs';
import { encodeLoneSurrogates, native } from '@b-studio/sandbox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gen, readEnvList, readEnvNumber } from './differential-kit';
import * as legacyPaths from './path-policy-legacy';
import * as old from './task-plan-legacy';
import { isInScope, planLanes, planLimitsFromEnv, type PlanLimits } from './task-plan';

/**
 * 작업 계획의 판정 셋(planLanes, isInScope, planLimitsFromEnv, ADR-191 3단계 3x)을 옮기기 전의 TS(`task-plan-legacy.ts`)와 지금의 Rust 껍데기에 같은 무작위 입력을 넣어 견준다.
 * 쓰기 범위(isInScope)는 그 아래의 진짜 옛 TS(`path-policy-legacy.ts`의 `isWithinScope`)와도 견준다.
 *
 * **막는 검사라 방향을 센다.** planLanes의 열린 쪽은 "옛 TS가 계획을 거절했는데 새 구현이 레인을 낸 것", isInScope의 열린 쪽은 "옛 TS가 범위 밖이라 했는데 새 구현이 범위 안이라 한 것"이다. 0이어야 한다.
 * 짝 없는 서로게이트가 든 입력은 따로 센다(의도한 차이: 레인 범위의 정렬 순서는 인코딩한 글자의 UTF-16 순서라 다를 수 있다).
 *
 * 크기는 환경 변수로 바꾼다: TASK_PLAN_DIFF_SEEDS(쉼표 목록), TASK_PLAN_DIFF_N(시드마다, 함수마다), TASK_PLAN_DIFF_REPORT=<파일 경로>
 */
const SEEDS = readEnvList('TASK_PLAN_DIFF_SEEDS', [1, 7, 42, 2026]);
const N = readEnvNumber('TASK_PLAN_DIFF_N', 2500);
const REPORT = process.env.TASK_PLAN_DIFF_REPORT;

interface Tally {
  compared: number;
  different: number;
  /** 옛 TS는 거절·범위 밖, 새 구현은 통과·범위 안 */
  openFlips: number;
  /** 반대 방향 */
  closedFlips: number;
  distribution: Map<string, number>;
  examples: string[];
}
const tallies = new Map<string, Tally>();
function tally(name: string): Tally {
  let t = tallies.get(name);
  if (!t) tallies.set(name, (t = { compared: 0, different: 0, openFlips: 0, closedFlips: 0, distribution: new Map(), examples: [] }));
  return t;
}

type Result = { ok: true; json: string } | { ok: false; message: string; kind: string };

function run(fn: () => unknown): Result {
  try {
    return { ok: true, json: JSON.stringify(fn()) ?? 'undefined' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), kind: error instanceof Error ? error.constructor.name : typeof error };
  }
}

function bucket(r: Result): string {
  if (r.ok) return '통과';
  const m = /^[^:(\d]+/.exec(r.message)?.[0]?.trim() ?? r.message;
  return `${r.kind}: ${m.slice(0, 24)}`;
}

const PATHS = [
  'web', 'web/app', 'web/app/orders', 'web/app/orders-old', 'web/app/orders/page.tsx', 'api', 'api/src', 'api/src/a.ts', './web', 'web/', 'Web', 'WEB/app', 'a//b', 'a\\b', 'a\\b\\c', 'C:\\x', '/abs', 'a/../c', '..', '.', './',
  'docs', 'docs/a.md', 'src/é', 'src/e\u0301', 'node_modules', '.git', '.GIT/x', 'x/.git', 'a/./b', ' ', 'a ', 'a.', 'a..', 'ǅ', 'ǆ', 'ß', 'SS', 'İ', 'x/y', 'x/y/z', 'x/yz', 'x', 'X', 'x/', 'lib', 'lib/util', 'lib2', 'a\u200Bb', 'a\u0000b',
];
const INVALID_PATHS = ['C:\\x', '/abs', 'a/../c', '..', '.', './', '/', 'a\\..\\b', '\\x'];
const VALID_PATHS = PATHS.filter((p) => !INVALID_PATHS.includes(p));
const SURROGATE_PATHS = ['x\ud800', 'x\ud801', 'x\ufffd', '\udc00y', 'x\ud800/z', 'x\ufffd/z', 'a\ud83d', '😀', 'x\ud83d\ude00'];
const IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'web', 'api', 'db', 'ui-1', 'job', 'x9'];
const BACKENDS = ['api', 'claude-code', 'codex', 'commandcode', 'opencode', 'gemini'];

function makeTask(g: Gen, id: string, before: string[], surrogate: boolean): Record<string, unknown> {
  const pool = surrogate ? [...VALID_PATHS, ...SURROGATE_PATHS] : VALID_PATHS;
  const task: Record<string, unknown> = { id, title: 'T', request: 'R', paths: g.list(1, 3, () => (g.chance(0.02) ? g.pick(INVALID_PATHS) : g.pick(pool))) };
  const deps: string[] = [];
  if (g.chance(0.5) && before.length > 0) deps.push(g.pick(before));
  if (g.chance(0.12) && before.length > 0) deps.push(g.pick(before));
  if (g.chance(0.05)) deps.push(g.pick(IDS));
  if (g.chance(0.02)) deps.push(id);
  if (g.chance(0.04) && deps.length > 0) deps.push(g.pick(deps));
  if (deps.length > 0 || g.chance(0.1)) task.dependsOn = deps;
  if (g.chance(0.25)) task.backend = g.chance(0.03) ? 'foo' : g.pick(BACKENDS);
  if (g.chance(0.2)) task.model = g.chance(0.03) ? '' : g.pick(surrogate ? ['m1', 'm2', 'm\ud800', 'm\ud801', 'm\ufffd'] : ['m1', 'm2']);
  return task;
}

function makePlan(g: Gen, surrogate: boolean): { plan: unknown; limits: PlanLimits } {
  const roll = g.int(100);
  const count = roll < 3 ? 0 : roll < 8 ? 7 + g.int(11) : 1 + g.int(6);
  const ids: string[] = [];
  const tasks: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    const id = g.chance(0.04) && ids.length > 0 ? g.pick(ids) : g.pick(IDS.filter((x) => !ids.includes(x)).concat(g.chance(0.05) ? ['Bad_Id'] : []));
    tasks.push(makeTask(g, id, ids.slice(), surrogate));
    ids.push(id);
  }
  // 앞 작업이 뒤 작업에 의존하게(순환)
  if (g.chance(0.07) && tasks.length >= 2) {
    const [a, b] = [tasks[0]!, tasks[tasks.length - 1]!];
    a.dependsOn = [...((a.dependsOn as string[] | undefined) ?? []), b.id as string];
  }
  let plan: unknown = { tasks };
  const bad = g.int(100);
  if (bad < 2) plan = null;
  else if (bad < 4) plan = { tasks: 'x' };
  else if (bad < 5) plan = [];
  const limits: PlanLimits = g.chance(0.7) ? { maxLanes: 3, maxTasks: 6 } : { maxLanes: g.pick([1, 2, 3, 4, 8, 0, 2.5, Number.NaN, Infinity]), maxTasks: g.pick([1, 2, 3, 6, 16, 0, 5.5, Number.NaN, Infinity]) };
  return { plan, limits };
}

/** 짝 없는 서로게이트가 든 입력은 레인 범위의 정렬과 겹침 오류 글의 순서가 다를 수 있다(의도한 차이) */
function normalizeSurrogate(r: Result): Result {
  if (!r.ok) return { ...r, message: r.message.startsWith('병렬 레인의 쓰기 범위가 겹칩니다') ? '병렬 레인의 쓰기 범위가 겹칩니다' : r.message };
  const lanes = JSON.parse(r.json) as Array<{ paths: string[] }>;
  for (const lane of lanes) lane.paths = [...lane.paths].sort();
  return { ok: true, json: JSON.stringify(lanes) };
}

function compareLanes(plan: unknown, limits: PlanLimits, surrogate: boolean, name: string, newImpl: (p: unknown, l: PlanLimits) => unknown = planLanes): void {
  const t = tally(name);
  let a = run(() => old.planLanes(plan, limits));
  let b = run(() => newImpl(plan, limits));
  t.compared += 1;
  t.distribution.set(bucket(a), (t.distribution.get(bucket(a)) ?? 0) + 1);
  if (surrogate) [a, b] = [normalizeSurrogate(a), normalizeSurrogate(b)];
  const same = a.ok && b.ok ? a.json === b.json : !a.ok && !b.ok ? a.message === b.message && a.kind === b.kind : false;
  if (same) return;
  t.different += 1;
  if (!a.ok && b.ok) t.openFlips += 1;
  if (a.ok && !b.ok) t.closedFlips += 1;
  if (t.examples.length < 3) t.examples.push(`입력 ${JSON.stringify(plan)} 한도 ${JSON.stringify(limits)}\n옛 ${JSON.stringify(a)}\n새 ${JSON.stringify(b)}`);
}

describe('작업 계획 차등 시험', () => {
  it('planLanes: 옛 TS와 같은 레인·같은 오류 글을 내고, 거절한 계획을 통과시키지 않는다', () => {
    for (const seed of SEEDS) {
      const g = new Gen(seed);
      for (let i = 0; i < N; i++) {
        const { plan, limits } = makePlan(g, false);
        compareLanes(plan, limits, false, 'planLanes');
      }
      const gs = new Gen(seed + 1000);
      for (let i = 0; i < Math.ceil(N / 3); i++) {
        const { plan, limits } = makePlan(gs, true);
        compareLanes(plan, limits, true, 'planLanes(짝 없는 서로게이트)');
      }
    }
    const t = tally('planLanes');
    expect(t.compared).toBeGreaterThan(0);
    expect(t.distribution.get('통과') ?? 0).toBeGreaterThan(t.compared / 10);
    expect(t.examples).toEqual([]);
    expect(t.openFlips).toBe(0);
    expect(t.closedFlips).toBe(0);
    expect(t.different).toBe(0);
    const s = tally('planLanes(짝 없는 서로게이트)');
    expect(s.examples).toEqual([]);
    expect(s.openFlips).toBe(0);
    expect(s.different).toBe(0);
  });

  it('대조 장치: 레인 상한을 하나 느슨하게 만든 새 구현은 열린 쪽 뒤집힘으로 잡힌다', () => {
    const mutantLimits = (limits: PlanLimits): PlanLimits => ({ ...limits, maxLanes: limits.maxLanes + 1 });
    for (const seed of SEEDS) {
      const g = new Gen(seed + 77);
      for (let i = 0; i < N; i++) {
        const { plan, limits } = makePlan(g, false);
        compareLanes(plan, limits, false, '대조(레인 상한 +1)', (p, l) => planLanes(p, mutantLimits(l)));
      }
    }
    expect(tally('대조(레인 상한 +1)').openFlips).toBeGreaterThan(0);
  });

  it('대조 장치: 작업 상한을 하나 줄인 새 구현은 닫힌 쪽 차이로 잡힌다', () => {
    for (const seed of SEEDS) {
      const g = new Gen(seed + 78);
      for (let i = 0; i < N; i++) {
        const { plan, limits } = makePlan(g, false);
        compareLanes(plan, limits, false, '대조(작업 상한 -1)', (p, l) => planLanes(p, { ...l, maxTasks: l.maxTasks - 1 }));
      }
    }
    expect(tally('대조(작업 상한 -1)').different).toBeGreaterThan(0);
  });

  it('isInScope: 옛 TS와 같고(진짜 옛 isWithinScope와도), 범위 밖을 범위 안으로 뒤집지 않는다', () => {
    const NAMES = [...PATHS, ...SURROGATE_PATHS, 'web/app/orders/../x', 'web/app//orders', 'web\\app\\orders', 'web/app/Orders', 'WEB/APP/ORDERS/page.tsx', 'web/app/orders\u200B/x', 'web/app/orders.'];
    const pick = (g: Gen) => (g.chance(0.5) ? g.pick(NAMES) : `${g.pick(NAMES)}/${g.pick(['page.tsx', 'a', 'b/c', '..', '.', 'orders', '', 'é', 'e\u0301'])}`);
    const t = tally('isInScope');
    const w = tally('isInScope(Windows 구분자, 옛 isWithinScope와)');
    for (const seed of SEEDS) {
      const g = new Gen(seed + 5);
      for (let i = 0; i < N * 2; i++) {
        const file = pick(g);
        const scopes = g.list(0, 3, () => (g.chance(0.5) ? g.pick(NAMES) : pick(g)));
        const a = old.isInScope(file, scopes);
        const b = isInScope(file, scopes);
        const truth = scopes.some((scope) => legacyPaths.isWithinScope(file, scope));
        t.compared += 1;
        t.distribution.set(a ? '안' : '밖', (t.distribution.get(a ? '안' : '밖') ?? 0) + 1);
        if (a !== b || a !== truth) {
          t.different += 1;
          if (!a && b) t.openFlips += 1;
          if (a && !b) t.closedFlips += 1;
          if (t.examples.length < 3) t.examples.push(JSON.stringify({ file, scopes, a, b, truth }));
        }
        // Windows 구분자: 껍데기는 이 기계의 값만 넘기므로 Rust 함수를 직접 부르고 옛 구현의 sep 인자와 견준다
        const win = native.taskPlanIsInScope(encodeLoneSurrogates(file), scopes.map(encodeLoneSurrogates), true);
        const winTruth = scopes.some((scope) => legacyPaths.isWithinScope(file, scope, '\\'));
        w.compared += 1;
        if (win !== winTruth) {
          w.different += 1;
          if (!winTruth && win) w.openFlips += 1;
          if (w.examples.length < 3) w.examples.push(JSON.stringify({ file, scopes, win, winTruth }));
        }
      }
    }
    for (const x of [t, w]) {
      expect(x.examples).toEqual([]);
      expect(x.openFlips).toBe(0);
      expect(x.different).toBe(0);
    }
    expect(t.distribution.get('안') ?? 0).toBeGreaterThan(t.compared / 20);
    expect(t.distribution.get('밖') ?? 0).toBeGreaterThan(t.compared / 20);
  });

  it('대조 장치: 접두 비교로 넓힌 쓰기 범위는 열린 쪽 뒤집힘으로 잡힌다', () => {
    let opened = 0;
    const g = new Gen(9);
    for (let i = 0; i < N * 2; i++) {
      const scope = g.pick(['web/app/orders', 'api', 'x/y', 'lib']);
      const file = `${scope}${g.pick(['', '/a', '-old/a', 'x', '2/a', '/'])}`;
      const mutant = file.startsWith(scope);
      if (!old.isInScope(file, [scope]) && mutant) opened += 1;
    }
    expect(opened).toBeGreaterThan(0);
  });

  describe('planLimitsFromEnv', () => {
    afterEach(() => vi.restoreAllMocks());

    it('옛 TS와 같은 값과 같은 경고를 낸다', () => {
      const VALUES = [undefined, '', ' ', '1', '2', '3', '4', '5', '6', '7', '8', '9', '16', '17', '0', '-1', '+3', '3.0', '3.5', '1e0', '0x3', '0b11', '0o7', '١', '３', 'abc', 'NaN', 'Infinity', '-Infinity', '1_0', ' 5 ', '\t5\n', '\u00A05', '5\u00A0', '\uFEFF5', '\u00855', '5\u0085', '0.5e1', '.5e1', '5.', '00', '08', '0x', '1,2', '٣', '３'];
      const t = tally('planLimitsFromEnv');
      const capture = (fn: () => PlanLimits) => {
        const warnings: string[] = [];
        const spy = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => void warnings.push(String(message)));
        try {
          return JSON.stringify({ limits: fn(), warnings });
        } finally {
          spy.mockRestore();
        }
      };
      const g = new Gen(3);
      for (const lanes of VALUES) {
        for (const tasks of VALUES) {
          for (let k = 0; k < 2; k++) {
            const env = { B_STUDIO_MAX_LANES: lanes, B_STUDIO_MAX_PLAN_TASKS: tasks };
            const a = capture(() => old.planLimitsFromEnv(env));
            const b = capture(() => planLimitsFromEnv(env));
            t.compared += 1;
            t.distribution.set(a.includes('warnings":[]') ? '경고 없음' : '경고', (t.distribution.get(a.includes('warnings":[]') ? '경고 없음' : '경고') ?? 0) + 1);
            if (a !== b) {
              t.different += 1;
              if (t.examples.length < 3) t.examples.push(`${JSON.stringify(env)}\n옛 ${a}\n새 ${b}`);
            }
          }
        }
      }
      // 무작위 글자도 몇 개
      for (let i = 0; i < N; i++) {
        const v = g.text([...'0123456789 .-+eExXbB_\u00A0\u0085\uFEFFa'], g.int(6));
        const env = { B_STUDIO_MAX_LANES: v, B_STUDIO_MAX_PLAN_TASKS: g.chance(0.5) ? v : undefined };
        const a = capture(() => old.planLimitsFromEnv(env));
        const b = capture(() => planLimitsFromEnv(env));
        t.compared += 1;
        if (a !== b) {
          t.different += 1;
          if (t.examples.length < 3) t.examples.push(`${JSON.stringify(env)}\n옛 ${a}\n새 ${b}`);
        }
      }
      expect(t.examples).toEqual([]);
      expect(t.different).toBe(0);
      expect(t.distribution.get('경고') ?? 0).toBeGreaterThan(0);
      expect(t.distribution.get('경고 없음') ?? 0).toBeGreaterThan(0);
    });
  });

  it('결과를 보고한다', () => {
    const lines = [...tallies].map(([name, t]) => `[차등] ${name}: 비교 ${t.compared}, 다름 ${t.different}, 열린 쪽 뒤집힘 ${t.openFlips}, 닫힌 쪽 뒤집힘 ${t.closedFlips}, 분포 ${JSON.stringify(Object.fromEntries(t.distribution))}`);
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    if (REPORT) appendFileSync(REPORT, `${lines.join('\n')}\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});
