/**
 * 추적표·시험 파일 훑기를 Rust로 옮기면서(ADR-191 3단계 3z) 옛 TS 구현(`requirements-legacy.ts`)과 같은 무작위 입력(시드 고정)을 견준다.
 *
 * - 추적표는 "시험·체크포인트·게이트·수동 기록이 이 요구사항을 다룬다"를 근거로 검증 상태를 올리는 여는 쪽이다. 그래서 같음과 함께
 *   **열린 쪽 뒤집힘**을 센다: 옛 "검증 안 됨/근거 없음"이 새 "검증됨/근거 있음"으로 바뀐 수(`flips`)는 0이어야 한다.
 * - 입력은 정규식이 걸리는 조각(id 꼴·접두·시나리오 언급·범위·보이지 않는 글자·따옴표 종류·이스케이프·닫히지 않은 따옴표·묶음 제목·메서드 이름)을
 *   이어 붙여 만든다. 짝 없는 서로게이트도 시험 이름·경로·실행 행에 섞는다 — 껍데기가 인코딩해 보내므로 결과는 옛 TS와 글자까지 같아야 한다.
 * - 엄격 시험(`strict`)은 옛 TS가 열린 쪽으로 틀린 자리(메서드 이름 가운데의 r2, 빈 id)를 입력에서 뺀 것이라 옛 TS와 글자까지 같아야 한다.
 *   느슨한 시험(`wild`)은 그런 입력도 섞고, 새 결과가 옛 결과의 부분집합(근거는 줄고 늘지 않는다)인지 본다.
 * - 환경 변수 `REQUIREMENTS_TRACE_DIFF_RUNS`(함수당 입력 수), `REQUIREMENTS_TRACE_DIFF_SEEDS`(쉼표로 이은 시드)로 크게 돌릴 수 있다.
 */
import { native } from '@b-studio/sandbox';
import { describe, expect, it, vi } from 'vitest';
import { Gen, outcome, perturb, readEnvList, readEnvNumber, type Outcome } from './differential-kit';
import * as old from './requirements-legacy';
import * as cur from './requirements';

const SEEDS = readEnvList('REQUIREMENTS_TRACE_DIFF_SEEDS', [20261110, 20261111]);
const RUNS = readEnvNumber('REQUIREMENTS_TRACE_DIFF_RUNS', 600);
vi.setConfig({ testTimeout: 3_600_000 });

// ───────────────────────── 입력 ─────────────────────────

const ID_FRAGS = ['R1', 'R2', 'R10', 'R12', 'R1.1', 'R1.2', 'R1.10', 'R2.1', 'R3', 'R1~R3', 'R1 - R2', 'r1', 'xR1', 'R1x', 'R\u200b1', 'R１', 'R0', 'R01', 'R1.', '\ud800', '\udc00', 'R1\ud800', '😀'];
const WORDS = ['로그인', 'works', 'plain', '담는다', ' ', '  ', "it's", '"q"', '`b`', '\\', '\\\'', '\n', '\u2028', '\u00a0', '(', ')', '{', '}'];
const DATES = ['2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.001Z', '2026-11-10T00:00:00.000Z'];
const STRICT_METHODS = ['testR1Login', 'testR2Logout', 'test_r1_a', 'r2_login', 'testR10Login', 'testR12', 'testR31', 'validateOrderR2Total', 'R1Works', 'check_R1_1', 'plainMethod', 'testR1ThenR10'];
const HAZARD_METHODS = ['calculatesOrder2Total', 'testServer3', 'checkERROR3', 'testError1Case', 'order1', 'getUserR1x', 'testR31ThenR3', 'testr1lower', 'testOrder10Items'];

function label(g: Gen): string {
  const count = 1 + g.int(4);
  let out = '';
  for (let i = 0; i < count; i++) out += (i === 0 ? '' : g.pick([' ', ' ', ''])) + (g.chance(0.55) ? g.pick(ID_FRAGS) : g.pick(WORDS));
  return out;
}

function quoted(g: Gen, text: string): string {
  const q = g.weighted<string>([[5, "'"], [3, '"'], [2, '`']]);
  if (g.chance(0.04)) return `${q}${text}`; // 닫히지 않는다
  return `${q}${text.split(q).join(`\\${q}`)}${q}`;
}

function jsFile(g: Gen): string {
  const lines: string[] = [];
  const count = 1 + g.int(10);
  for (let i = 0; i < count; i++) {
    const kind = g.int(10);
    if (kind < 4) lines.push(`${g.pick(['it', 'test', 'it.only', 'test.skip', 'it', 'it.each([1])', 'xit', 'benefit'])}(${quoted(g, label(g))}, () => {});`);
    else if (kind < 7) lines.push(`describe(${quoted(g, label(g))}, () => {`);
    else if (kind < 8) lines.push('});');
    else if (kind < 9) lines.push(`  ${g.pick(['it', 'test'])}(${quoted(g, label(g))},`);
    else lines.push(`@DisplayName("${label(g).replaceAll('"', '')}")`);
  }
  return lines.join(g.pick(['\n', '\n', '\r\n']));
}

function javaFile(g: Gen, hazards: boolean): string {
  const methods = hazards ? [...STRICT_METHODS, ...HAZARD_METHODS] : STRICT_METHODS;
  const lines = ['class OrderTest {'];
  const count = 1 + g.int(9);
  for (let i = 0; i < count; i++) {
    const kind = g.int(10);
    if (kind < 3) lines.push(`  @DisplayName("${label(g).replaceAll('"', '')}")`);
    else if (kind < 4) lines.push('  @Nested');
    else if (kind < 5) lines.push(`  class ${g.pick(['Flow', 'R1Flow', 'Inner'])} {`);
    else if (kind < 6) lines.push('  }');
    else lines.push(`  ${g.pick(['@Test ', '', '@Test\n  '])}${g.pick(['void', 'public void', 'private void', 'protected Optional<Foo>'])} ${g.pick(methods)}() {}`);
  }
  lines.push('}');
  return lines.join('\n');
}

interface F {
  path: string;
  content: string;
}

function files(g: Gen, hazards: boolean): F[] {
  return g.list(0, 4, () => {
    const path = g.weighted<string>([[4, 'a.test.ts'], [2, 'b.spec.js'], [3, 'OrderTest.java'], [1, 'XTests.java'], [1, 'c.ts'], [1, 'd.py'], [1, 'e\ud800.test.ts'], [1, 'f/IT.java']]);
    const content = path.endsWith('.java') ? javaFile(g, hazards) : jsFile(g);
    return { path, content };
  });
}

const ids = ['R1', 'R2', 'R10', 'R1.1', 'R1.2', 'R2.1', 'R3', 'R1.10', 'R12'];

function checkpoints(g: Gen) {
  return g.list(0, 4, () => ({
    sha: 'a'.repeat(40),
    shortSha: 'aaaaaaa',
    message: `${g.pick(ids)} ${g.pick(['', 'Implements: R1', 'Implements: R2.1@rev2', 'R1~R3', 'x'])}`,
    ...(g.chance(0.7) ? { createdAt: g.pick(DATES) } : {}),
  }));
}

function gateChecks(g: Gen) {
  return g.list(0, 4, () => ({ name: `${g.pick(ids)} ${g.pick(['gate', '', 'R10'])}`, ok: g.chance(0.75) }));
}

function runRows(g: Gen, testNames: string[]) {
  return g.list(0, 7, () => ({
    id: g.pick([...ids, 'R1\ud800', 'R1\udc00']),
    file: g.pick(['a.test.ts', 'OrderTest.java', 'e\ud800.test.ts', 'e\udc00.test.ts']),
    name: g.pick([...testNames, 't1', 't2', 'x\ud800', 'x\udc00']),
    status: g.pick(['pass', 'fail', 'skip', 'not-run']),
    at: g.pick(DATES),
    sha: 'b'.repeat(40),
    shortSha: 'bbbbbbb',
  }));
}

function requirement(g: Gen, id: string) {
  const scenarios = g.chance(0.6) ? g.list(1, 3, () => ({ id: g.pick([`${id}.1`, `${id}.2`, `${id}.10`, 'R9.1', `${id}.`]), given: 'g', when: 'w', then: 't' })) : g.chance(0.2) ? [] : undefined;
  const value: Record<string, unknown> = { id, title: `${id} ${g.pick(['제목', 'title'])}`, kind: 'api', priority: g.pick(['must', 'must', 'should', 'could']), acceptance: ['동작한다'] };
  if (g.chance(0.4)) value.rev = 1 + g.int(4);
  if (scenarios) value.scenarios = scenarios;
  if (g.chance(0.4)) value.trace = g.chance(0.5) ? { issue: 1 + g.int(40) } : { dependsOn: ['R1'] };
  if (g.chance(0.4)) value.revisedAt = g.pick(DATES);
  if (g.chance(0.3)) value.manualVerification = { by: 'a', at: g.pick(DATES).slice(0, 10), sha: 'abc', note: 'ok' };
  return value;
}

interface Input {
  requirements: Array<Record<string, unknown>>;
  checkpoints: ReturnType<typeof checkpoints>;
  testFiles: F[];
  gateChecks: ReturnType<typeof gateChecks>;
  testRunRows?: ReturnType<typeof runRows>;
  evaluationByRequirementId?: Record<string, unknown>;
}

function genInput(g: Gen, hazards: boolean): Input {
  const testFiles = files(g, hazards);
  const names = old.scanTestFilesForOrphans(testFiles).map((m) => m.name);
  const requirements = g.list(0, 4, () => requirement(g, g.pick(['R1', 'R2', 'R3', 'R10'])));
  const input: Input = { requirements, checkpoints: checkpoints(g), testFiles, gateChecks: gateChecks(g) };
  if (g.chance(0.6)) input.testRunRows = runRows(g, names);
  if (g.chance(0.35)) {
    input.evaluationByRequirementId = Object.fromEntries(
      requirements
        .filter(() => g.chance(0.6))
        .map((r) => [
          r.id as string,
          {
            status: g.pick(['검증됨', '작업 중', '미착수', '실패', '재확인 필요']),
            evidence: {
              checkpoints: checkpoints(g),
              tests: g.list(0, 2, () => ({ file: g.pick(['a.test.ts', 'e\ud800.test.ts']), name: g.pick([...names, 'x\ud800', 'x\udc00', 'zz']) })),
              gateChecks: gateChecks(g).slice(0, 1),
              ...(g.chance(0.3) ? { docEvidence: { matched: ['a'], missing: g.chance(0.5) ? [] : ['b'], satisfied: g.chance(0.6) } } : {}),
            },
            verifiedBy: 'none',
          },
        ]),
    );
  }
  return input;
}

// ───────────────────────── 집계 ─────────────────────────

interface Stat {
  total: number;
  same: number;
  closedOnly: number;
  bothThrew: number;
  threwOneSide: number;
  empty: number;
  filled: number;
  flips: number;
  mismatches: string[];
}
const STATS = new Map<string, Stat>();
const stat = (name: string): Stat => {
  let s = STATS.get(name);
  if (!s) STATS.set(name, (s = { total: 0, same: 0, closedOnly: 0, bothThrew: 0, threwOneSide: 0, empty: 0, filled: 0, flips: 0, mismatches: [] }));
  return s;
};

const text = (value: unknown) => JSON.stringify(value);
const names = (matches: unknown): Set<string> => new Set((matches as Array<{ file: string; name: string }>).map((m) => `${m.file}\u0000${m.name}`));
const subset = (small: Set<string>, big: Set<string>) => [...small].every((item) => big.has(item));

type MatrixLike = { rows: Array<{ id: string; status: string; verifiedBy: string; tests: unknown[]; checkpoints: unknown[]; gateChecks: unknown[] }>; orphanTests: unknown[]; mustHavesWithoutTests: Array<{ id: string }>; mustHavesVerifiedWithoutTests: Array<{ id: string }> };

/** 열린 쪽 뒤집힘: 옛 결과에 없던 근거가 새 결과에 생기거나, 옛 "검증 안 됨"이 새 "검증됨"이 된 것 */
function matrixFlips(a: MatrixLike, b: MatrixLike): number {
  let flips = 0;
  if (a.rows.length !== b.rows.length) return 1;
  a.rows.forEach((before, i) => {
    const after = b.rows[i]!;
    if (after.status === '검증됨' && before.status !== '검증됨') flips++;
    if (after.verifiedBy !== 'none' && before.verifiedBy === 'none') flips++;
    if (!subset(names(after.tests), names(before.tests))) flips++;
    if (after.checkpoints.length > before.checkpoints.length || after.gateChecks.length > before.gateChecks.length) flips++;
  });
  const without = new Set([...a.mustHavesWithoutTests, ...a.mustHavesVerifiedWithoutTests].map((r) => r.id));
  const withoutAfter = new Set([...b.mustHavesWithoutTests, ...b.mustHavesVerifiedWithoutTests].map((r) => r.id));
  for (const id of without) if (!withoutAfter.has(id)) flips++;
  if (!subset(names(b.orphanTests), names(a.orphanTests)) && b.orphanTests.length > a.orphanTests.length) flips += 0; // 주인 없는 시험이 늘어도 근거가 늘지는 않는다
  return flips;
}

interface Options {
  /** 엄격: 글자까지 같아야 한다. 아니면 새 결과가 옛 결과 이하이면(closed-only) 허용 */
  strict: boolean;
  flip?: (legacy: unknown, current: unknown) => number;
}

function compare(name: string, input: () => string, legacy: () => unknown, current: () => unknown, options: Options): void {
  const s = stat(name);
  s.total++;
  const a: Outcome = outcome(legacy);
  const b: Outcome = outcome(current);
  if (a.threw || b.threw) {
    if (a.threw && b.threw) s.bothThrew++;
    else {
      s.threwOneSide++;
      if (s.mismatches.length < 5) s.mismatches.push(`던짐이 다르다(${a.threw ? '옛 TS만' : 'Rust만'}) ${input().slice(0, 300)}`);
    }
    return;
  }
  const flips = options.flip?.(a.value, b.value) ?? 0;
  s.flips += flips;
  if (text(a.value) === text(b.value)) {
    s.same++;
    const v = a.value;
    if (Array.isArray(v) ? v.length === 0 : v === undefined) s.empty++;
    else s.filled++;
    return;
  }
  if (!options.strict && flips === 0) {
    s.closedOnly++;
    return;
  }
  if (s.mismatches.length < 5) s.mismatches.push(`${input().slice(0, 400)}\n  옛: ${text(a.value).slice(0, 300)}\n  새: ${text(b.value).slice(0, 300)}`);
}

const scanFlip = (legacy: unknown, current: unknown) => (subset(names(current), names(legacy)) ? 0 : 1);

function runAll(seed: number, strict: boolean): void {
  const g = new Gen(seed);
  for (let i = 0; i < RUNS; i++) {
    const input = genInput(g, !strict);
    const id = g.pick(['R1', 'R2', 'R10', 'R3', 'R1.1', 'R12', 'R', '']);
    const scenarioId = g.pick(['R1.1', 'R1.2', 'R1.10', 'R2.1', 'R1', '']);
    const describe = () => text({ id, files: input.testFiles });
    const opts: Options = { strict, flip: scanFlip };
    compare('scanTestFilesForRequirementId', describe, () => old.scanTestFilesForRequirementId(input.testFiles, id), () => cur.scanTestFilesForRequirementId(input.testFiles, id), strict && (id === '' || id === 'R') ? { strict: false, flip: scanFlip } : opts);
    compare('scanTestFilesForScenarioId', describe, () => old.scanTestFilesForScenarioId(input.testFiles, scenarioId), () => cur.scanTestFilesForScenarioId(input.testFiles, scenarioId), { strict: true, flip: scanFlip });
    compare('scanTestFilesForOrphans', describe, () => old.scanTestFilesForOrphans(input.testFiles), () => cur.scanTestFilesForOrphans(input.testFiles), { strict: true, flip: scanFlip });

    const parent = { checkpoints: [], tests: [], gateChecks: [], ...(g.chance(0.4) ? { docEvidence: { matched: ['a'], missing: [], satisfied: g.chance(0.6) } } : {}) };
    const rows = input.testRunRows ?? [];
    const params = { scenarioId, checkpoints: input.checkpoints, testFiles: input.testFiles, gateChecks: input.gateChecks, testRunRows: rows, parentEvidence: g.chance(0.7) ? parent : undefined };
    const evidenceFlip = (legacy: unknown, current: unknown): number => {
      const a = legacy as { tests: unknown[]; checkpoints: unknown[]; gateChecks: unknown[]; testRun?: unknown };
      const b = current as { tests: unknown[]; checkpoints: unknown[]; gateChecks: unknown[]; testRun?: unknown };
      return (subset(names(b.tests), names(a.tests)) ? 0 : 1) + (b.checkpoints.length > a.checkpoints.length || b.gateChecks.length > a.gateChecks.length ? 1 : 0) + (b.testRun && !a.testRun ? 1 : 0);
    };
    compare('buildScenarioEvidence', () => text(params), () => old.buildScenarioEvidence(params as never), () => cur.buildScenarioEvidence(params as never), { strict: true, flip: evidenceFlip });

    const req = input.requirements[0] ?? requirement(g, 'R1');
    const unverifiedFlip = (legacy: unknown, current: unknown) => ((current as string[]).every((x) => (legacy as string[]).includes(x)) ? 0 : 1);
    // 시나리오가 "검증됨"이 되면 남은 시나리오가 줄어든다 — 새 결과에 옛 결과에 없는 id가 생기는 것은 닫는 쪽이고, 옛 결과에 있던 id가 사라지는 것이 여는 쪽이다
    const unverifiedOpen = (legacy: unknown, current: unknown) => ((legacy as string[]).every((x) => (current as string[]).includes(x)) ? 0 : 1);
    void unverifiedFlip;
    compare(
      'findUnverifiedScenarioIds',
      () => text({ req, files: input.testFiles }),
      () => old.findUnverifiedScenarioIds(req as never, input.checkpoints, input.testFiles, input.gateChecks, rows as never, parent as never),
      () => cur.findUnverifiedScenarioIds(req as never, input.checkpoints, input.testFiles, input.gateChecks, rows as never, parent as never),
      { strict, flip: unverifiedOpen },
    );

    compare(
      'buildTraceabilityMatrix',
      () => text(input),
      () => old.buildTraceabilityMatrix(input as never),
      () => cur.buildTraceabilityMatrix(input as never),
      { strict, flip: (legacy, current) => matrixFlips(legacy as MatrixLike, current as MatrixLike) },
    );
  }
}

describe('추적표·시험 훑기: 옛 TS와 같다 (ADR-191 3z)', () => {
  for (const seed of SEEDS) {
    it(`엄격: 옛 TS가 열린 쪽으로 틀린 입력을 뺀 입력은 글자까지 같다 (시드 ${seed})`, () => {
      runAll(seed, true);
    });
    it(`느슨: 낱말 가운데의 r2·빈 id까지 섞어도 근거는 늘지 않는다 (시드 ${seed})`, () => {
      runAll(seed + 1000, false);
    });
  }

  it('함수마다 같음·던짐·뒤집힘 수를 낸다', () => {
    const lines = [...STATS].map(([name, s]) => `${name}\t합계 ${s.total}\t같음 ${s.same}\t닫는쪽만달라짐 ${s.closedOnly}\t둘다던짐 ${s.bothThrew}\t한쪽만던짐 ${s.threwOneSide}\t빈결과 ${s.empty}\t값있음 ${s.filled}\t뒤집힘 ${s.flips}`);
    console.log(`추적표 차등 시험 분포\n${lines.join('\n')}`);
    for (const [name, s] of STATS) {
      expect(s.mismatches, name).toEqual([]);
      expect(s.flips, `${name} 열린 쪽 뒤집힘`).toBe(0);
      expect(s.threwOneSide, `${name} 한쪽만 던짐`).toBe(0);
      expect(s.total, name).toBeGreaterThan(0);
      expect(s.filled, `${name}: 값이 있는 결과가 있어야 한다`).toBeGreaterThan(0);
    }
    expect(STATS.get('buildTraceabilityMatrix')!.same).toBeGreaterThan(0);
  });

  it('대조 장치: 결과 한 글자를 바꾼 옛 구현은 차이로 잡힌다', () => {
    const g = new Gen(7);
    let caught = 0;
    let tried = 0;
    for (let i = 0; i < 200; i++) {
      const input = genInput(g, false);
      const expected = old.buildTraceabilityMatrix(input as never);
      if (expected.rows.length === 0) continue;
      tried++;
      if (text(perturb(expected)) !== text(cur.buildTraceabilityMatrix(input as never))) caught++;
    }
    expect(tried).toBeGreaterThan(20);
    expect(caught).toBe(tried);
  });

  it('성질: 인코딩 없이 보내면 서로 다른 짝 없는 서로게이트 이름이 합쳐지지만, 껍데기의 판정은 그렇지 않다', () => {
    // 같은 이름 'x?'를 두 시험이 다른 짝 없는 서로게이트로 가지고, 실행 행은 한쪽에만 있다
    const content = "it('R1 x\ud800', () => {});\nit('R1 x\udc00', () => {});\n";
    const rows = [{ id: 'R1', file: 'a.test.ts', name: 'R1 x\ud800', status: 'pass', at: '2026-06-01T00:00:00.000Z', sha: 'b'.repeat(40), shortSha: 'bbbbbbb' }];
    const input = { requirements: [{ id: 'R1', title: 't', kind: 'api', priority: 'must', acceptance: ['a'] }], checkpoints: [], testFiles: [{ path: 'a.test.ts', content }], gateChecks: [], testRunRows: rows };
    const result = cur.buildTraceabilityMatrix(input as never);
    expect(result.rows[0]!.tests).toEqual([
      { file: 'a.test.ts', name: 'R1 x\ud800', result: 'pass' },
      { file: 'a.test.ts', name: 'R1 x\udc00' },
    ]);
    expect(text(result)).toBe(text(old.buildTraceabilityMatrix(input as never)));
    // 인코딩 없이 Rust로 곧장 보내면 두 이름이 모두 U+FFFD가 되어 합쳐지고, 실행 결과 pass가 엉뚱한 시험에도 붙는다(이 성질이 인코딩이 필요한 이유)
    const raw = JSON.parse(
      native.reqTraceMatrix(
        JSON.stringify({ ...input, testFiles: [{ path: 'a.test.ts', index: JSON.parse(native.reqTraceFileIndex('a.test.ts', content)!) }] }),
      ),
    ) as { rows: Array<{ tests: Array<{ name: string; result?: string }> }> };
    expect(raw.rows[0]!.tests.length).toBe(1);
    expect(raw.rows[0]!.tests[0]!.result).toBe('pass');
  });
});
