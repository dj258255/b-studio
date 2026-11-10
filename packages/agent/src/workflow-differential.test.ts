import { appendFileSync } from 'node:fs';
import { encodeNative, native } from '@b-studio/sandbox';
import { AUTO_PAGE_MAX, type LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { hasDocsVerifyTrailer, hasEmptyPassedTrailer } from './checkpoints';
import { Gen, outcome, readEnvList, readEnvNumber, sameOutcome, wellFormed, type Outcome } from './differential-kit';
import {
  formatCheckedCoverage,
  formatIncompleteTrailer,
  formatVerifyTrailer,
  formatWorkflowTrailer,
  isDocCheckpointPath,
  maxTurnsFor,
  missingVerificationStages,
  parseIncompleteTrailerValues,
  parseVerifyTrailerValues,
  parseWorkflowTrailerValues,
  protectedPathsFor,
  releaseBlockers,
  reviewChanges,
  uncoveredChangeWarnings,
  workflowReleaseRequirements,
  workflowStages,
} from './workflow';
import { legacy } from './workflow-legacy';

/**
 * 워크플로 판정을 Rust로 옮기면서(ADR-191 3v) 옛 TS 구현을 `workflow-legacy.ts`에 그대로 두고, 같은 무작위 입력을 옛 구현과 새 껍데기에 넣어 결과를 JSON 글자로 견준다.
 *
 * 의도한 차이(각 시험의 `allowed`가 이유를 가린다. 모두 막는 쪽으로만 달라진다):
 * ① `Workflow-Passed` 값의 공백은 git이 지우는 ASCII 공백뿐이다(옛 JS `trim`·`\s`는 NBSP·BOM·U+2028도 지웠다), ② 마지막 `Workflow-Passed` 값이 비면 통과한 단계가 없다(옛 코드는 빈 값을 건너뛰고 앞의 값을 읽었다),
 * ③ 커밋 전 트레일러 확인은 `Workflow-Passed: none`이 하나라도 있으면 막고, 문서 예외는 마지막 `Workflow-Verify` 줄이 docs일 때만 인정한다(옛 코드는 첫 줄·아무 줄),
 * ④ 짝 없는 서로게이트는 경계에서 U+FFFD이고(표시 글자), 서비스 소유·선언 경로의 같음 비교는 단사 인코딩으로 글자 그대로 견준다(커버리지 경고에서만, 입력에 짝 없는 서로게이트가 있을 때만 달라질 수 있다).
 * 열린 쪽(옛 막음·경고 → 새 통과·없음) 뒤집힘은 짝 없는 서로게이트가 없는 입력에서 0이어야 한다.
 *
 * 크기는 환경 변수로 바꾼다: WORKFLOW_DIFF_SEEDS(쉼표 목록), WORKFLOW_DIFF_ITERATIONS, WORKFLOW_DIFF_REPORT=<파일 경로>(분포를 그 파일에 덧붙인다)
 */

const SEEDS = readEnvList('WORKFLOW_DIFF_SEEDS', [1, 2, 3]);
const ITERATIONS = readEnvNumber('WORKFLOW_DIFF_ITERATIONS', 1500);
const REPORT = process.env.WORKFLOW_DIFF_REPORT;

const LONE_UNIT = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
function containsLone(value: unknown): boolean {
  if (typeof value === 'string') return LONE_UNIT.test(value);
  if (Array.isArray(value)) return value.some(containsLone);
  if (value !== null && typeof value === 'object') return Object.entries(value).some(([key, item]) => LONE_UNIT.test(key) || containsLone(item));
  return false;
}
const valueOf = (o: Outcome) => (o.threw ? undefined : o.value);

interface Stats {
  cases: number;
  different: number;
  allowedDifferent: number;
  opened: number;
  /** 입력에 짝 없는 서로게이트가 있는 사례의 열린 쪽 뒤집힘(커버리지 경고에서만 허용) */
  openedWithLone: number;
  distribution: Record<string, number>;
}

interface Options<I> {
  allowed?: (input: I, a: Outcome, b: Outcome) => boolean;
  /** 옛 결과가 막았거나 알렸는데 새 결과가 통과시켰거나 알리지 않았으면 참 */
  opened?: (a: Outcome, b: Outcome) => boolean;
}

function compare<I>(
  name: string,
  generate: (g: Gen) => I,
  oldImpl: (input: I) => unknown,
  newImpl: (input: I) => unknown,
  classify: (a: Outcome, b: Outcome, input: I) => string,
  { allowed = () => false, opened = () => false }: Options<I> = {},
): Stats {
  const stats: Stats = { cases: 0, different: 0, allowedDifferent: 0, opened: 0, openedWithLone: 0, distribution: {} };
  const failures: string[] = [];
  for (const seed of SEEDS) {
    const g = new Gen(seed);
    for (let i = 0; i < ITERATIONS; i++) {
      const input = generate(g);
      const a = outcome(() => oldImpl(input));
      const b = outcome(() => newImpl(input));
      stats.cases++;
      const label = classify(a, b, input);
      stats.distribution[label] = (stats.distribution[label] ?? 0) + 1;
      if (opened(a, b)) {
        if (containsLone(input)) stats.openedWithLone++;
        else stats.opened++;
      }
      if (!sameOutcome(a, b)) {
        if (allowed(input, a, b)) stats.allowedDifferent++;
        else {
          stats.different++;
          if (failures.length < 3) failures.push(`${name} seed=${seed} i=${i}\n입력 ${JSON.stringify(input)}\n옛 ${JSON.stringify(a)}\n새 ${JSON.stringify(b)}\n`);
        }
      }
    }
  }
  const line = `${name}: ${JSON.stringify(stats)}`;
  if (REPORT) appendFileSync(REPORT, `${line}\n`);
  if (failures.length > 0) throw new Error(`${line}\n${failures.join('\n---\n')}`);
  return stats;
}

// ── 무작위 입력 ──────────────────────────────────────────────────────────

const STAGES = ['plan', 'implement', 'run', 'browser_check', 'contract_check', 'test', 'concurrency_check', 'load_check', 'review', 'checkpoint'] as const;
const LONE = ['\ud800', '\udbff', '\udc00', '\udfff', '\ud83d', '\ude00'];
const ASCII_WS = [' ', '\t', '\n', '\r', '\v', '\f'];
const WIDE_WS = ['\u00a0', '\ufeff', '\u2028', '\u2029', '\u3000', '\u2003', '\u0085'];
const ASCII_WS_RE = /^[ \t\n\v\f\r]*$/;

function ws(g: Gen, wide: boolean): string {
  const pool = wide ? [...ASCII_WS, ...WIDE_WS] : ASCII_WS;
  return g.chance(0.5) ? '' : g.text(pool, 1 + g.int(2));
}

function passedValue(g: Gen, wide: boolean): string {
  const word = () =>
    g.weighted<string>([
      [10, g.pick(STAGES)],
      [2, g.pick(STAGES).toUpperCase()],
      [1, `${g.pick(STAGES)}x`],
      [1, 'none'],
      [1, 'NONE'],
      [1, 'None'],
      [1, ''],
      [1, g.pick(['deploy', 'tests', 'a b', 'run test', '\ue010', '\ue011'])],
      [1, g.pick(LONE)],
    ]);
  const parts = g.list(0, 4, word);
  const sep = () => `${ws(g, wide)},${ws(g, wide)}`;
  let text = parts.map((part, i) => (i === 0 ? part : `${sep()}${part}`)).join('');
  text = `${ws(g, wide)}${text}${ws(g, wide)}`;
  return text;
}

function passedValues(g: Gen, wide: boolean): string[] {
  return g.list(0, 4, () => (g.chance(0.15) ? '' : g.chance(0.1) ? g.pick(ASCII_WS) : passedValue(g, wide)));
}

const VERIFY_WORDS = ['light', 'docs', 'unverified', 'Light', 'DOCS', 'UnVerified', 'full', 'lights', 'lig ht', 'light\u00a0', '\ufeffdocs', 'docs\u2028', 'L\u0130GHT', 'unverifieD', 'max_turns', 'MAX_TURNS', 'Max_Turns', 'max_turn', 'max_turns2', 'max-turns', '', ' ', '\t', 'K', '\u212a'];

function verifyValues(g: Gen): string[] {
  return g.list(0, 4, () => `${ws(g, true)}${g.pick(VERIFY_WORDS)}${ws(g, true)}`);
}

const PATH_PARTS = ['docs', 'src', 'a', 'README', 'x.md', '.md', '.github', 'pull_request_template.md', 'docs/', '..', '.', 'é', '가', '😀', 'A.MD', 'b.mdx', 'a\nb', 'a\rb', 'a\u2028b', 'a\u2029b', '\n', ' '];

function docPath(g: Gen): string {
  const candidates = [
    () => `docs/${g.pick(PATH_PARTS)}${g.pick(['', '.md', '.json', '/x.md'])}`,
    () => `${g.pick(PATH_PARTS)}${g.pick(['', '.md', '.MD', '.md ', '.mdx'])}`,
    () => g.pick(['.github/pull_request_template.md', '.GitHub/pull_request_template.md', '.github/pull_request_template.md/', '.github/pull_request_template.mdx', 'x/.github/pull_request_template.md', '.github/Pull_Request_Template.md']),
    () => g.pick(['docs', 'docs/', 'docs//', 'Docs/a', 'doc/a', 'docs/a', 'docs/\n', 'docs/a\nb', 'docs/a\r', 'docs/\u2028', 'docs/.', '.md', 'a.md', 'a/b.md', './a.md', '.hidden.md', '\ud800.md', 'docs/\ud800']),
    () => g.list(1, 4, () => g.pick(PATH_PARTS)).join(g.pick(['/', '', '/'])),
  ];
  return g.pick(candidates)();
}

function trailerEntries(g: Gen): string[] {
  const keyForms = ['Workflow-Passed', 'workflow-passed', 'WORKFLOW-PASSED', 'Wor\u212aflow-Passed', 'Workflow-Verify', 'workflow-verify', 'Wor\u212aflow-Verify', 'Workflow-Incomplete', 'Other'];
  const values = ['none', 'NONE', 'None', 'docs', 'DOCS', 'Docs', 'light', 'test', 'run, test', '', ' none ', 'none x', 'unverified', 'max_turns', 'docs x', 'docs\u00a0'];
  const sep = [': ', ':', ' : ', ':  ', ':\t'];
  return g.list(0, 4, () => `${g.pick(['', '', ' ', '\t', '\u00a0'])}${g.pick(keyForms)}${g.pick(sep)}${g.pick(values)}${g.pick(['', ' ', '\r', '\u00a0'])}`);
}

// ── 프로젝트 ─────────────────────────────────────────────────────────────

const SERVICE_NAMES = ['web', 'api', 'shop', 'a b', 'é', '😀', 'web2', 'Web'];
const SERVICE_PATHS = ['apps/web', 'apps/api', '.', './svc', 'svc/', 'apps', 'shared', 'libs/x', 'é', '😀', 'apps/web2', '', './', 'Apps/Web'];
const TEMPLATES = ['nextjs', 'nextjs', 'spring-boot', 'express', 'nextjs'];

interface ProjectCase {
  workflow: Record<string, unknown> | undefined;
  managed: Array<{ name: string; path: string; includes?: string[]; template: string }> | undefined;
  root: string | undefined;
  composePath: string | undefined;
  files: string[];
  passed: string[] | undefined;
  verify: 'light' | 'docs' | 'unverified' | undefined;
  override: number | undefined;
}

function maybeLone(g: Gen, withLone: boolean, text: string): string {
  return withLone && g.chance(0.25) ? `${text}${g.pick(LONE)}` : text;
}

function projectCase(g: Gen, withLone = false): ProjectCase {
  const names = g.list(0, 3, () => maybeLone(g, withLone, g.pick(SERVICE_NAMES)));
  const managed =
    g.chance(0.1)
      ? undefined
      : names.map((name) => ({
          name,
          path: maybeLone(g, withLone, g.pick(SERVICE_PATHS)),
          ...(g.chance(0.5) ? { includes: g.list(0, 2, () => maybeLone(g, withLone, g.pick(['shared', 'libs/x', 'é', './shared/', 'apps/web', '..', '.']))) } : {}),
          template: g.pick(TEMPLATES),
        }));
  const serviceName = () => (names.length > 0 && g.chance(0.8) ? g.pick(names) : maybeLone(g, withLone, g.pick(SERVICE_NAMES)));
  const stageList = (min: number, max: number) => g.list(min, max, () => g.pick(STAGES));
  const workflow: Record<string, unknown> = {};
  if (g.chance(0.2)) workflow.required = stageList(0, 6);
  if (g.chance(0.3)) workflow.pageChecks = g.list(0, 3, () => ({ service: serviceName(), path: g.pick(['/', '/shorts', '/shop', '/a/1', '/a/[id]', maybeLone(g, withLone, '/p')]) }));
  if (g.chance(0.4)) workflow.tests = g.list(0, 2, () => ({ service: serviceName() }));
  if (g.chance(0.15)) workflow.concurrencyChecks = g.list(0, 2, () => ({}));
  if (g.chance(0.15)) workflow.loadChecks = g.list(0, 2, () => ({}));
  if (g.chance(0.2)) workflow.autoPageChecks = { service: serviceName() };
  if (g.chance(0.3)) workflow.protectedPaths = g.list(0, 3, () => g.pick(['.env', 'infra', 'apps/web', 'STUDIO.YAML', 'a/', './x', '..', '', maybeLone(g, withLone, 'p'), 'é', 'docs/README.md']));
  if (g.chance(0.2)) workflow.evaluationAssets = g.list(0, 2, () => g.pick(['tests', 'apps/api/src/test', 'grader.sh', 'e\u0301', maybeLone(g, withLone, 't')]));
  if (g.chance(0.3)) workflow.maxChangedFiles = g.pick([1, 2, 3, 5, 10]);
  if (g.chance(0.3)) workflow.releaseRequires = stageList(1, 4);
  if (g.chance(0.3)) workflow.maxTurns = g.pick([1, 60, 300]);
  const fileParts = ['app/page.tsx', 'app/shorts/page.tsx', 'app/[id]/page.tsx', 'src/app/(g)/p/page.tsx', 'lib/a.test.ts', 'x.spec.mjs', 'vitest.config.mts', 'jest.config.js', '__tests__/a.ts', 'src/__tests__/b.ts', 'src/main.ts', 'a/b.test.tsx', 'x.test.json', 'app/layout.tsx', 'e2e/playwright.config.ts'];
  const roots = [...SERVICE_PATHS, ...(managed ?? []).flatMap((m) => [m.path, ...(m.includes ?? [])])];
  const files = g.list(0, 6, () =>
    g.weighted<string>([
      [10, `${g.pick(roots)}/${g.pick(fileParts)}`],
      [3, g.pick(['studio.yaml', 'compose.yaml', 'README.md', '.env', 'infra/main.tf', 'docs/a.md', 'apps/web/.env', 'apps/web/ENV', 'tests/a.ts'])],
      [2, g.pick(fileParts)],
      [1, maybeLone(g, withLone, `${g.pick(roots)}/${g.pick(fileParts)}`)],
    ]),
  );
  return {
    workflow: Object.keys(workflow).length > 0 || g.chance(0.5) ? workflow : undefined,
    managed,
    root: g.pick([undefined, '', '/r']),
    composePath: g.pick([undefined, '', '/r/compose.yaml']),
    files,
    passed: g.chance(0.15) ? undefined : g.list(0, 6, () => g.pick(STAGES)),
    verify: g.pick([undefined, undefined, 'light', 'docs', 'unverified']),
    override: g.pick([undefined, undefined, 5, 0, -0, NaN, Infinity]),
  };
}

function toProject(input: ProjectCase): LoadedProject {
  return {
    spec: { name: 'x', ...(input.workflow ? { workflow: input.workflow } : {}) },
    ...(input.managed ? { managed: input.managed.map((m) => [m.name, { source: 'managed', ...m }]) } : {}),
    ...(input.root !== undefined ? { root: input.root } : {}),
    ...(input.composePath !== undefined ? { composePath: input.composePath } : {}),
  } as unknown as LoadedProject;
}

/** 옛 구현은 `detail: undefined` 키를 남긴다. JSON 글자로 견주므로 없는 키와 같게 본다 */
const norm = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const classifyBool = (a: Outcome, b: Outcome) => `${valueOf(a)}/${valueOf(b)}`;
const classifyList = (a: Outcome) => (a.threw ? '던짐' : Array.isArray(a.value) && a.value.length === 0 ? '빈 결과' : a.threw === false && a.value === undefined ? '없음' : '값');

const asArray = (o: Outcome): unknown[] => (!o.threw && Array.isArray(o.value) ? o.value : []);
/** 옛 목록에 있던 항목이 새 목록에 없으면 열린 쪽(막던 단계·알리던 경고를 더 이상 알리지 않는다) */
const lostItem = (a: Outcome, b: Outcome) => {
  const next = asArray(b).map((item) => JSON.stringify(wellFormed(item)));
  return asArray(a).some((item) => !next.includes(JSON.stringify(wellFormed(item))));
};
const checkNames = (o: Outcome) => asArray(o).map((check) => (check as { name: string }).name);

describe('워크플로 차등 시험(옛 TS와 Rust 껍데기)', () => {
  it('트레일러 만들기는 같다', { timeout: 300_000 }, () => {
    const stages = compare('formatWorkflowTrailer', (g) => g.list(0, 4, () => g.pick(STAGES)), (s) => legacy.formatWorkflowTrailer(s), (s) => formatWorkflowTrailer(s), (a) => (String(valueOf(a)).endsWith('none') ? '없음' : '값'));
    expect(stages.distribution['없음']).toBeGreaterThan(0);
    expect(stages.distribution['값']).toBeGreaterThan(stages.cases / 4);
    compare('formatVerifyTrailer', (g) => g.pick(['light', 'docs', 'unverified'] as const), (m) => legacy.formatVerifyTrailer(m), (m) => formatVerifyTrailer(m), classifyBool);
    compare('formatIncompleteTrailer', () => 'max_turns' as const, (r) => legacy.formatIncompleteTrailer(r), (r) => formatIncompleteTrailer(r), classifyBool);
  });

  it('Workflow-Passed 읽기: 열린 쪽 뒤집힘 0, 달라지는 것은 ASCII 공백·빈 마지막 값뿐', { timeout: 300_000 }, () => {
    const subset = (small: unknown, big: unknown) => Array.isArray(small) && Array.isArray(big) && small.every((item) => big.includes(item));
    const stats = compare(
      'parseWorkflowTrailerValues',
      (g) => passedValues(g, g.chance(0.4)),
      (values) => legacy.parseWorkflowTrailerValues(values),
      (values) => parseWorkflowTrailerValues(values),
      (a) => (a.threw ? '던짐' : a.value === undefined ? '없음' : (a.value as unknown[]).length === 0 ? '빈 목록' : '값'),
      {
        // 새 결과가 옛 결과의 부분 집합이고, 입력에 ASCII가 아닌 공백이 있거나 마지막 값이 비었다
        allowed: (values, a, b) => {
          const wide = values.some((v) => !ASCII_WS_RE.test(v.replace(/[^\s]/g, '')) || /[\u00a0\ufeff\u2028\u2029\u3000\u2003\u0085]/.test(v));
          const lastEmpty = values.length > 0 && values[values.length - 1]!.replace(/[ \t\n\v\f\r]/g, '') === '';
          return !a.threw && !b.threw && (a.value === undefined ? (b.value as unknown[]).length === 0 : subset(b.value, a.value)) && (wide || lastEmpty);
        },
        opened: (a, b) => !a.threw && !b.threw && ((a.value === undefined && b.value !== undefined && (b.value as unknown[]).length > 0) || (Array.isArray(a.value) && Array.isArray(b.value) && b.value.some((stage) => !(a.value as unknown[]).includes(stage)))),
      },
    );
    expect(stats.opened).toBe(0);
    expect(stats.different).toBe(0);
    expect(stats.distribution['값']).toBeGreaterThan(stats.cases / 4);
    expect(stats.distribution['없음']).toBeGreaterThan(0);
    expect(stats.distribution['빈 목록']).toBeGreaterThan(0);
    expect(stats.allowedDifferent).toBeGreaterThan(0);
  });

  it('Workflow-Verify·Incomplete 읽기는 같다', { timeout: 300_000 }, () => {
    const verify = compare('parseVerifyTrailerValues', verifyValues, (v) => legacy.parseVerifyTrailerValues(v), (v) => parseVerifyTrailerValues(v), (a) => String(valueOf(a)));
    expect(verify.distribution['light']).toBeGreaterThan(verify.cases / 20);
    expect(verify.distribution['docs']).toBeGreaterThan(verify.cases / 20);
    expect(verify.distribution['unverified']).toBeGreaterThan(verify.cases / 20);
    expect(verify.distribution['undefined']).toBeGreaterThan(verify.cases / 20);
    const incomplete = compare('parseIncompleteTrailerValues', verifyValues, (v) => legacy.parseIncompleteTrailerValues(v), (v) => parseIncompleteTrailerValues(v), (a) => String(valueOf(a)));
    expect(incomplete.distribution['max_turns']).toBeGreaterThan(incomplete.cases / 40);
    expect(incomplete.distribution['undefined']).toBeGreaterThan(incomplete.cases / 4);
  });

  it('문서 체크포인트 경로: 여는 쪽 뒤집힘 0', { timeout: 300_000 }, () => {
    const stats = compare('isDocCheckpointPath', docPath, (f) => legacy.isDocCheckpointPath(f), (f) => isDocCheckpointPath(f), classifyBool, { opened: (a, b) => valueOf(a) === false && valueOf(b) === true });
    expect(stats.opened).toBe(0);
    expect(stats.different).toBe(0);
    expect(stats.distribution['true/true']).toBeGreaterThan(stats.cases / 10);
    expect(stats.distribution['false/false']).toBeGreaterThan(stats.cases / 10);
  });

  it('커밋 전 트레일러 확인: 막던 것을 풀지 않고 문서 예외를 넓히지 않는다', { timeout: 300_000 }, () => {
    const empty = compare('hasEmptyPassedTrailer', trailerEntries, (t) => legacy.hasEmptyPassedTrailer(t), (t) => hasEmptyPassedTrailer(t), classifyBool, {
      allowed: (_t, a, b) => valueOf(a) === false && valueOf(b) === true,
      opened: (a, b) => valueOf(a) === true && valueOf(b) === false,
    });
    expect(empty.opened).toBe(0);
    expect(empty.distribution['true/true']).toBeGreaterThan(empty.cases / 40);
    expect(empty.distribution['false/false']).toBeGreaterThan(empty.cases / 4);
    expect(empty.allowedDifferent).toBeGreaterThan(0);
    const docs = compare('hasDocsVerifyTrailer', trailerEntries, (t) => legacy.hasDocsVerifyTrailer(t), (t) => hasDocsVerifyTrailer(t), classifyBool, {
      allowed: (_t, a, b) => valueOf(a) === true && valueOf(b) === false,
      opened: (a, b) => valueOf(a) === false && valueOf(b) === true,
    });
    expect(docs.opened).toBe(0);
    expect(docs.distribution['true/true']).toBeGreaterThan(docs.cases / 100);
    expect(docs.distribution['false/false']).toBeGreaterThan(docs.cases / 4);
    expect(docs.allowedDifferent).toBeGreaterThan(0);
  });

  it('단계·배포 요구·보호 경로·턴 상한', { timeout: 300_000 }, () => {
    const stages = compare('workflowStages', (g) => projectCase(g), (i) => legacy.workflowStages(toProject(i)), (i) => workflowStages(toProject(i)), classifyList);
    expect(stages.distribution['값']).toBeGreaterThan(stages.cases / 2);
    compare('workflowReleaseRequirements', (g) => projectCase(g), (i) => legacy.workflowReleaseRequirements(toProject(i)), (i) => workflowReleaseRequirements(toProject(i)), classifyList);
    compare('protectedPathsFor', (g) => projectCase(g, true), (i) => legacy.protectedPathsFor(i.workflow as never), (i) => protectedPathsFor(i.workflow as never), classifyList);
    const turns = compare('maxTurnsFor', (g) => projectCase(g), (i) => legacy.maxTurnsFor(toProject(i), i.override), (i) => maxTurnsFor(toProject(i), i.override), (a) => String(valueOf(a)));
    expect(turns.distribution['undefined']).toBeGreaterThan(0);
    expect(turns.distribution['NaN']).toBeGreaterThan(0);
  });

  it('배포 막음·빠진 검증 단계: 열린 쪽 뒤집힘 0', { timeout: 300_000 }, () => {
    const blockers = compare(
      'releaseBlockers',
      (g) => projectCase(g, true),
      (i) => legacy.releaseBlockers(toProject(i), i.passed as never, i.verify),
      (i) => releaseBlockers(toProject(i), i.passed as never, i.verify),
      classifyList,
      { opened: lostItem },
    );
    expect(blockers.opened + blockers.openedWithLone).toBe(0);
    expect(blockers.distribution['값']).toBeGreaterThan(blockers.cases / 10);
    expect(blockers.distribution['빈 결과']).toBeGreaterThan(blockers.cases / 10);
    const missing = compare(
      'missingVerificationStages',
      (g) => projectCase(g, true),
      (i) => legacy.missingVerificationStages(toProject(i), new Set((i.passed ?? []) as never[])),
      (i) => missingVerificationStages(toProject(i), new Set((i.passed ?? []) as never[])),
      classifyList,
      { opened: lostItem },
    );
    expect(missing.opened + missing.openedWithLone).toBe(0);
    expect(missing.distribution['값']).toBeGreaterThan(missing.cases / 10);
    expect(missing.distribution['빈 결과']).toBeGreaterThan(missing.cases / 40);
  });

  it('검토: 보호 경로·변경 크기·커버리지 경고. 막던 것을 풀지 않는다', { timeout: 300_000 }, () => {
    const lostBlock = (a: Outcome, b: Outcome) => {
      const next = new Map(asArray(b).map((c) => [(c as { name: string }).name, (c as { ok: boolean }).ok]));
      return asArray(a).some((c) => !(c as { ok: boolean }).ok && next.get((c as { name: string }).name) !== false);
    };
    const classify = (a: Outcome) => {
      const names = checkNames(a);
      if (a.threw) return '던짐';
      if (asArray(a).some((c) => !(c as { ok: boolean }).ok)) return '막음';
      return names.some((n) => n.startsWith('coverage-gap')) ? '경고' : '통과';
    };
    const stats = compare(
      'reviewChanges',
      (g) => projectCase(g, g.chance(0.2)),
      (i) => norm(legacy.reviewChanges(toProject(i), i.files)),
      (i) => norm(reviewChanges(toProject(i), i.files)),
      classify,
      // ④ 짝 없는 서로게이트가 입력에 있으면 서비스 소유·선언 경로의 같음 비교가 글자 그대로다
      { allowed: (i, a, b) => containsLone(i) && !a.threw && !b.threw, opened: (a, b) => lostBlock(a, b) || lostItem(a, b) },
    );
    expect(stats.opened).toBe(0);
    expect(stats.distribution['막음']).toBeGreaterThan(stats.cases / 20);
    expect(stats.distribution['경고']).toBeGreaterThan(stats.cases / 40);
    expect(stats.distribution['통과']).toBeGreaterThan(stats.cases / 10);
  });

  it('커버리지 경고만', { timeout: 300_000 }, () => {
    const stats = compare(
      'uncoveredChangeWarnings',
      (g) => projectCase(g, g.chance(0.2)),
      (i) => norm(legacy.uncoveredChangeWarnings(toProject(i), i.files)),
      (i) => norm(uncoveredChangeWarnings(toProject(i), i.files)),
      (a) => (a.threw ? '던짐' : asArray(a).length === 0 ? '없음' : checkNames(a).some((n) => n.endsWith('화면')) ? (checkNames(a).some((n) => n.endsWith('테스트')) ? '둘 다' : '화면') : '테스트'),
      { allowed: (i, a, b) => containsLone(i) && !a.threw && !b.threw, opened: lostItem },
    );
    expect(stats.opened).toBe(0);
    for (const label of ['없음', '화면', '테스트']) expect(stats.distribution[label]).toBeGreaterThan(stats.cases / 100);
  });

  it('확인 요약', { timeout: 300_000 }, () => {
    const gen = (g: Gen) =>
      g.chance(0.1)
        ? undefined
        : g.list(0, 5, () => ({
            stage: g.pick(['browser_check', 'test', 'concurrency_check', 'load_check', 'review'] as const),
            name: g.pick(['coverage-gap: web 테스트', 'coverage-gap: web 화면', 'declared-checks', 'unit', 'coverage-gap', 'Coverage-Gap: x', 'protected-paths', 'a\ud800']),
            ok: g.chance(0.7),
            attempts: 1,
            ...(g.chance(0.8) ? { detail: g.pick(['', '설명', '줄\n바꿈', 'x\ud800y']) } : {}),
          }));
    const stats = compare(
      'formatCheckedCoverage',
      gen,
      (checks) => legacy.formatCheckedCoverage(checks),
      (checks) => formatCheckedCoverage(checks as never),
      (a) => {
        const text = String(valueOf(a));
        return text === '' ? '빈 글' : text.includes('확인 안 됨') && text.includes('확인 선언 변경') ? '틈과 선언' : text.includes('확인 선언 변경') ? '선언' : text.includes('확인 안 됨') ? '틈' : '확인만';
      },
    );
    for (const label of ['빈 글', '틈', '선언', '확인만']) expect(stats.distribution[label]).toBeGreaterThan(0);
  });

  describe('대조 장치: 한 곳을 어긋나게 한 옛 구현은 차이로 잡힌다', () => {
    function detects(make: (g: Gen) => { a: unknown; b: unknown }): number {
      // 이 장치 시험은 반복이 많으면 오래 걸린다(시간 제한은 describe 끝에서 늘린다)
      let differences = 0;
      for (const seed of SEEDS) {
        const g = new Gen(seed);
        for (let i = 0; i < ITERATIONS; i++) {
          const { a, b } = make(g);
          if (!sameOutcome({ threw: false, value: a }, { threw: false, value: b })) differences++;
        }
      }
      return differences;
    }

    it('결과 한 글자·경계 ±1', { timeout: 300_000 }, () => {
      expect(detects((g) => { const v = verifyValues(g); return { a: legacy.parseVerifyTrailerValues(v) === 'docs' ? 'light' : legacy.parseVerifyTrailerValues(v), b: parseVerifyTrailerValues(v) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const f = docPath(g); return { a: /^(docs\/.+|[^/]+\.md)$/.test(f), b: isDocCheckpointPath(f) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const f = docPath(g); return { a: /^(docs\/.*|[^/]+\.md|\.github\/pull_request_template\.md)$/.test(f), b: isDocCheckpointPath(f) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const f = docPath(g); return { a: /^(docs\/.+|[^/]*\.md|\.github\/pull_request_template\.md)$/.test(f), b: isDocCheckpointPath(f) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const f = docPath(g); return { a: /(docs\/.+|[^/]+\.md|\.github\/pull_request_template\.md)$/.test(f), b: isDocCheckpointPath(f) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const i = projectCase(g); return { a: legacy.maxTurnsFor(toProject(i), i.override), b: (maxTurnsFor(toProject(i), i.override) ?? 0) + 1 }; })).toBeGreaterThan(0);
      expect(detects((g) => { const s = g.list(0, 4, () => g.pick(STAGES)); return { a: legacy.formatWorkflowTrailer(s).replace('Passed', 'Passd'), b: formatWorkflowTrailer(s) }; })).toBeGreaterThan(0);
    });

    it('판정을 빼거나 넓힌 옛 구현', { timeout: 300_000 }, () => {
      expect(detects((g) => { const i = projectCase(g); return { a: legacy.releaseBlockers(toProject(i), i.passed as never, i.verify).slice(1), b: releaseBlockers(toProject(i), i.passed as never, i.verify) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const i = projectCase(g); return { a: legacy.releaseBlockers(toProject(i), i.passed as never, undefined), b: releaseBlockers(toProject(i), i.passed as never, i.verify) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const i = projectCase(g); return { a: legacy.missingVerificationStages(toProject(i), new Set(['run', 'test', 'review', 'plan'] as never[])), b: missingVerificationStages(toProject(i), new Set((i.passed ?? []) as never[])) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const i = projectCase(g); return { a: legacy.reviewChanges(toProject(i), i.files).filter((c) => c.name !== 'protected-paths'), b: reviewChanges(toProject(i), i.files) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const i = projectCase(g); return { a: legacy.reviewChanges(toProject(i), i.files.slice(1)), b: reviewChanges(toProject(i), i.files) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const i = projectCase(g); return { a: legacy.uncoveredChangeWarnings(toProject(i), i.files).slice(1), b: uncoveredChangeWarnings(toProject(i), i.files) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const t = trailerEntries(g); return { a: t.some((e) => /workflow-passed/i.test(e)), b: hasEmptyPassedTrailer(t) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const t = trailerEntries(g); return { a: t.some((e) => /workflow-verify:\s*docs/i.test(e)), b: hasDocsVerifyTrailer(t) }; })).toBeGreaterThan(0);
    });
  });

  it('상수를 Rust와 같이 쓴다', { timeout: 300_000 }, () => {
    expect(AUTO_PAGE_MAX).toBe(10);
    expect(encodeNative({ a: 1 })).toBe('{"a":1}');
    expect(native.workflowFormatPassedTrailer([])).toBe('Workflow-Passed: none');
  });
});
