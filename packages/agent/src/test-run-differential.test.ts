import { describe, expect, it } from 'vitest';
import { Gen, outcome, perturb, readEnvList, readEnvNumber, sameOutcome, wellFormed, type Outcome } from './differential-kit';
import {
  buildTestRunPlan,
  clearTestReportsCommand,
  detectRunner,
  reportRootsForIncludes,
  runnerLabel,
  splitCollectedReports,
  type DetectRunnerInput,
  type Runner,
  type TestTarget,
} from './test-run';

/**
 * test-run을 Rust로 옮기면서(ADR-191 3d) 옛 TS 구현을 아래 `legacy`에 그대로 두고, 같은 무작위 입력을 옛 구현과 새 껍데기에 넣어
 * 결과를 JSON.stringify 글자(키 순서 포함)와 값(-0·NaN 구별)으로 견준다. `legacy`는 옮기기 전 `test-run.ts`의 본문이다
 * (`export`만 뗐다). 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * 크기는 환경 변수로 바꾼다: TEST_RUN_DIFF_SEEDS(쉼표 목록), TEST_RUN_DIFF_ITERATIONS, TEST_RUN_DIFF_REPORT=1(분포 출력)
 */
const legacy = (() => {
  /**
   * 테스트 탭(ADR-084)의 실행 단계 — 템플릿·실행기에 맞는 테스트 명령을 만들고, 컨테이너 안에 남긴 보고서를
   * 모아오는 명령도 함께 만든다. 순수 함수만 둔다(샌드박스 호출 없음) — studio의 서버 쪽 코드가
   * `sandbox.exec(service, plan.command)`로 실행하고 `sandbox.exec(service, plan.collect)`로 보고서를 모은다.
   */

  type Runner = 'gradle' | 'maven' | 'vitest' | 'jest' | 'pytest';

  /** 좁혀서 돌릴 대상. 아무것도 없으면 서비스의 테스트 전체를 돌린다 */
  interface TestTarget {
    /** 서비스 폴더 기준 상대 경로(JS/TS, pytest에서 쓴다) */
    file?: string;
    /** JVM 전용: Gradle --tests, Maven -Dtest에 쓸 정규화된 클래스명(예: com.example.OrderServiceTest 또는 중첩 클래스 포함 OrderServiceTest$WhenCancelled) */
    className?: string;
    /** 메서드/테스트 이름(JVM은 메서드 이름, JS는 -t 패턴, pytest는 노드 id의 테스트 이름) */
    testName?: string;
  }

  interface TestRunPlan {
    /** 서비스 컨테이너 안에서 실행할 명령(sandbox.exec의 command 인자와 같은 모양 — 셸을 거치지 않는다) */
    command: string[];
    /** 실행 뒤 보고서를 모아오는 명령. stdout을 splitCollectedReports로 나눈다 */
    collect: string[];
    /** 보고서 형식. test-results.ts의 파서를 고르는 데 쓴다 */
    format: 'junit-xml' | 'jest-json';
  }

  /** 컨테이너 안 임시 보고서 경로. 서비스 소스 트리 밖(/tmp)이라 다른 파일과 부딪히지 않는다 */
  const JEST_LIKE_REPORT_PATH = '/tmp/b-studio-test-report.json';
  const PYTEST_REPORT_PATH = '/tmp/b-studio-test-report.xml';
  /** Gradle/Maven은 출력 경로를 정할 수 없어(관례 경로에 남긴다) 찾아서 모은다 */
  const GRADLE_REPORT_GLOB = 'build/test-results/test/*.xml';
  const MAVEN_REPORT_GLOB = 'target/surefire-reports/*.xml';
  /** 여러 보고서 파일을 한 번의 exec로 모아올 때 경계로 쓰는 표지. 실제 보고서 내용에 나타날 일이 없는 문자열이다 */
  const REPORT_BOUNDARY = '@@@b-studio-test-report@@@';

  /** glob 여러 개를 한 번의 exec로 모두 모은다(호출마다 왕복하지 않으려고 한 셸 명령에 합친다) */
  function collectGlobCommand(globExprs: readonly string[]): string[] {
    const body = globExprs.map((glob) => `for f in ${glob}; do [ -f "$f" ] && { echo '${REPORT_BOUNDARY}'"$f"; cat "$f"; echo; }; done`).join('; ');
    return ['sh', '-c', body];
  }

  /**
   * extraReportRoots(studio.yaml의 includes, ADR-139)는 세션 중 에이전트(모델 출력)가 studio.yaml을 직접 고쳐
   * 바꿀 수 있는 값이라, `sh -c` 문자열에 따옴표 없이 그대로 넣으면 `includes: ["media; <임의 명령>"]` 같은 값이
   * 서비스 컨테이너에서 임의 명령을 실행하는 통로가 된다(보안 검토, 다그푸딩 마찰 135). `@b-studio/spec`의
   * PROJECT_RELATIVE_PATH 스키마가 이미 영문·숫자·.·_·-·/만 허용하지만, 이 함수는 그 스키마를 거치지 않고도
   * 안전해야 하므로(순수 함수가 호출자의 검증을 신뢰하지 않는다) 여기서도 같은 문자 집합만 받고, 통과한 경로는
   * 작은따옴표로 감싸 셸 메타문자 해석을 막는다(허용 문자 집합 자체에 `'`가 없어 따옴표를 깨고 나올 수 없다).
   * 글로빙이 필요한 `*.xml` 부분만 따옴표 밖에 남겨 셸이 그 부분만 확장하게 한다. 집합에 없는 문자가 섞인 값은
   * (스키마를 우회해 여기까지 왔다는 뜻이므로) 조용히 버린다 — 떨어뜨리는 쪽이 임의 명령 실행보다 항상 안전하다.
   */
  const SAFE_REPORT_ROOT = /^[A-Za-z0-9._/-]+$/;

  /** pattern(상수 glob, 사용자 입력이 아니다)과, 있으면 extraReportRoots 각각을 작은따옴표로 감싼 glob 식 목록을 만든다 */
  function reportGlobExprs(pattern: string, extraReportRoots: readonly string[]): string[] {
    const roots = extraReportRoots.filter((root) => SAFE_REPORT_ROOT.test(root));
    return [pattern, ...roots.map((root) => `'${root}'/${pattern}`)];
  }

  /**
   * runner·대상에 맞는 테스트 실행 명령과 보고서 수거 명령을 만든다.
   * `wrapper`는 서비스 폴더에 Gradle·Maven 래퍼(gradlew·mvnw)가 있는지다. 없으면 이미지의 gradle·mvn을 쓴다(주지 않으면 이전 동작: Gradle은 래퍼, Maven은 mvn) —
   * 폴더 열기가 래퍼 없는 Spring 서비스를 gradle 이미지로 띄우기 때문이다(pay 복제본에서 `./gradlew`가 없어 실패했다)
   * `extraReportRoots`는 이 서비스의 `includes`(ADR-139, studio.yaml)가 가리키는 서비스 폴더 밖 경로들 — 컨테이너
   * 안에서 그 경로로도 접근할 수 있는 절대/상대 경로를 호출하는 쪽이 만들어 준다. Gradle 멀티 모듈 빌드에서
   * `-p <서비스 폴더> test`가 그 서브프로젝트의 테스트도 함께 돌리지만(ADR-139), 보고서는 서브프로젝트 자신의
   * build/test-results 아래에 남아 서비스 폴더만 보면 놓친다(도그푸딩 마찰 135) — 그 경로의 보고서도 같이 모은다
   */
  function buildTestRunPlan(
    runner: Runner,
    target?: TestTarget,
    { wrapper, extraReportRoots = [] }: { wrapper?: boolean; extraReportRoots?: readonly string[] } = {},
  ): TestRunPlan {
    switch (runner) {
      case 'gradle': {
        const command = [wrapper === false ? 'gradle' : './gradlew', 'test', '--no-daemon', '--console=plain'];
        if (target?.className) command.push('--tests', target.testName ? `${target.className}.${target.testName}` : target.className);
        return { command, collect: collectGlobCommand(reportGlobExprs(GRADLE_REPORT_GLOB, extraReportRoots)), format: 'junit-xml' };
      }
      case 'maven': {
        const command = [wrapper === true ? './mvnw' : 'mvn', '-q', 'test'];
        if (target?.className) command.push(`-Dtest=${target.testName ? `${target.className}#${target.testName}` : target.className}`);
        return { command, collect: collectGlobCommand(reportGlobExprs(MAVEN_REPORT_GLOB, extraReportRoots)), format: 'junit-xml' };
      }
      case 'vitest': {
        const command = ['npx', 'vitest', 'run', '--reporter=json', `--outputFile=${JEST_LIKE_REPORT_PATH}`];
        if (target?.file) command.push(target.file);
        if (target?.testName) command.push('-t', target.testName);
        return { command, collect: ['cat', JEST_LIKE_REPORT_PATH], format: 'jest-json' };
      }
      case 'jest': {
        const command = ['npx', 'jest', '--json', `--outputFile=${JEST_LIKE_REPORT_PATH}`];
        if (target?.file) command.push(target.file);
        if (target?.testName) command.push('-t', target.testName);
        return { command, collect: ['cat', JEST_LIKE_REPORT_PATH], format: 'jest-json' };
      }
      case 'pytest': {
        const command = ['pytest', `--junitxml=${PYTEST_REPORT_PATH}`];
        if (target?.file) {
          const node = target.testName ? `${target.file}::${target.className ? `${target.className}::` : ''}${target.testName}` : target.file;
          command.push(node);
        }
        return { command, collect: ['cat', PYTEST_REPORT_PATH], format: 'junit-xml' };
      }
    }
  }

  /** 서비스 컨테이너 안에서 프로젝트 루트를 마운트한 자리. studio의 CONTAINER_WORKSPACE_ROOT(ADR-088)와 같아야 한다 */
  const CONTAINER_PROJECT_ROOT = '/workspace';

  /** 서비스의 `includes`(ADR-139)를 컨테이너 안 보고서 경로의 뿌리로 바꾼다. 보고서를 모으는 쪽(studio)과 비우는 쪽(게이트)이 같은 경로를 보게 한 곳에 둔다 */
  function reportRootsForIncludes(includes: readonly string[] = [], root: string = CONTAINER_PROJECT_ROOT): string[] {
    return includes.map((include) => `${root}/${include}`);
  }

  /**
   * `collect`가 읽는 보고서 자리를 실행기와 상관없이 모두 지우는 명령(#756). 게이트가 선언된 테스트를 돌리기 직전에 보낸다.
   * 게이트의 테스트 명령(사용자 스크립트)이 이 자리에 보고서를 남기지 않으면, 테스트 탭이 예전에 남긴 보고서나 에이전트가
   * 실행 중에 만든 파일이 그대로 모여 새 체크포인트의 근거가 되기 때문이다. 고정 경로와 상수 glob만 따옴표 없이 두고,
   * `extraReportRoots`는 수거와 같은 규칙(reportGlobExprs)으로 걸러 감싼다
   */
  function clearTestReportsCommand(extraReportRoots: readonly string[] = []): string[] {
    const globs = [GRADLE_REPORT_GLOB, MAVEN_REPORT_GLOB].flatMap((pattern) => reportGlobExprs(pattern, extraReportRoots));
    return ['sh', '-c', `rm -f ${[JEST_LIKE_REPORT_PATH, PYTEST_REPORT_PATH, ...globs].join(' ')}`];
  }

  /** collectGlobCommand의 stdout을 파일별로 나눈다. 경계 표지가 없으면(단일 cat 결과) 파일 하나로 본다 */
  function splitCollectedReports(stdout: string, singleFileLabel = 'report'): Array<{ file: string; content: string }> {
    if (!stdout.includes(REPORT_BOUNDARY)) {
      const trimmed = stdout.trim();
      return trimmed ? [{ file: singleFileLabel, content: trimmed }] : [];
    }
    const parts: Array<{ file: string; content: string }> = [];
    const marker = new RegExp(`${REPORT_BOUNDARY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(.*)\\n`, 'g');
    const matches = [...stdout.matchAll(marker)];
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i]!.index! + matches[i]![0].length;
      const end = i + 1 < matches.length ? matches[i + 1]!.index! : stdout.length;
      parts.push({ file: matches[i]![1]!.trim(), content: stdout.slice(start, end).trim() });
    }
    return parts;
  }

  // ---------------------------------------------------------------------------
  // 실행기 판별
  // ---------------------------------------------------------------------------

  interface PackageJsonInfo {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }

  interface DetectRunnerInput {
    /** studio.yaml services.<name>.template (예: spring-boot, nextjs, vite, fastapi) */
    template: string;
    /** 서비스 폴더에 pom.xml이 있는지(Spring Boot를 Gradle 대신 Maven으로 쓰는 프로젝트) */
    hasPomXml?: boolean;
    /** 서비스 폴더의 package.json(있으면). vitest/jest 중 어느 것을 쓰는지 여기서 가른다 */
    packageJson?: PackageJsonInfo;
  }

  /** studio.yaml의 template과 서비스 폴더 힌트(package.json, pom.xml 유무)로 실행기를 고른다. 판별 못 하면 undefined */
  function detectRunner(input: DetectRunnerInput): Runner | undefined {
    const template = input.template.toLowerCase();
    if (template.includes('spring')) return input.hasPomXml ? 'maven' : 'gradle';
    if (template.includes('fastapi') || template.includes('python') || template.includes('django') || template.includes('flask')) return 'pytest';
    if (template.includes('next') || template.includes('vite') || template.includes('react') || template.includes('node')) {
      const deps = { ...(input.packageJson?.dependencies ?? {}), ...(input.packageJson?.devDependencies ?? {}) };
      if (deps.vitest) return 'vitest';
      if (deps.jest) return 'jest';
      const testScript = input.packageJson?.scripts?.test ?? '';
      if (/\bvitest\b/.test(testScript)) return 'vitest';
      if (/\bjest\b/.test(testScript)) return 'jest';
      return undefined;
    }
    return undefined;
  }

  function runnerLabel(runner: Runner): string {
    switch (runner) {
      case 'gradle':
        return 'Gradle (JUnit)';
      case 'maven':
        return 'Maven (JUnit)';
      case 'vitest':
        return 'Vitest';
      case 'jest':
        return 'Jest';
      case 'pytest':
        return 'pytest';
    }
  }

  return { buildTestRunPlan, clearTestReportsCommand, reportRootsForIncludes, splitCollectedReports, detectRunner, runnerLabel };
})();


const SEEDS = readEnvList('TEST_RUN_DIFF_SEEDS', [11, 29, 47]);
const ITERATIONS = readEnvNumber('TEST_RUN_DIFF_ITERATIONS', 6000);
const REPORT = process.env.TEST_RUN_DIFF_REPORT === '1';

const RUNNERS: Runner[] = ['gradle', 'maven', 'vitest', 'jest', 'pytest'];

/** 글자 하나하나가 JS와 Rust에서 다르게 읽힐 만한 것: 줄 끝·공백·서로게이트·정규식 메타·셸 메타·한글 */
const SPECIAL = ['\n', '\r', ' ', ' ', '\u0085', ' ', '﻿', '　', '\t', ' ', '😀', '\ud800', '한', 'é', 'ſ', 'K', "'", '"', '\\', '$', ';', '*', '?', '(', ')', '[', ']', '{', '}', '.', '/', '-', '_', ':', '@', '#', '&', '<', '>', '='];
const SAFE = [...'abcxyzABCXYZ019._/-'];

function weirdString(gen: Gen): string {
  return gen.weighted<() => string>([
    [3, () => ''],
    [4, () => gen.text(SAFE, 1 + gen.int(12))],
    [3, () => gen.text(SPECIAL, 1 + gen.int(5))],
    [3, () => gen.text([...SAFE, ...SPECIAL], 1 + gen.int(14))],
    [2, () => gen.pick(['src/a.test.ts', 'com.example.OrderServiceTest', 'OrderServiceTest$WhenCancelled', 'tests/test_orders.py', 'creates an order', 'R7: 목록(단일)', 'a b', "it's", 'a::b', 'a#b', '-t'])],
  ])();
}

const ROOT_POOL = ['m', 'a/b', '/workspace/m', '../x', '.', '..', '/', 'a//b', 'a-b_c.d', 'ABC123', 'x; rm -rf /', "k'k", '', '한글', 'a b', 'a\n', '\na', '$HOME', 'a*', 'a/../b?', 'a ', 'a ', '`x`', 'a|b', 'a&b', 'a(b)', '\ud800a'];

function rootString(gen: Gen): string {
  if (gen.chance(0.45)) return gen.pick(ROOT_POOL);
  const base = gen.text(SAFE, 1 + gen.int(10));
  if (gen.chance(0.35)) {
    const at = gen.int(base.length + 1);
    return base.slice(0, at) + gen.pick(SPECIAL) + base.slice(at);
  }
  return base;
}

function optionalString(gen: Gen): string | undefined {
  return gen.weighted<() => string | undefined>([
    [3, () => undefined],
    [1, () => ''],
    [6, () => weirdString(gen)],
  ])();
}

function makeTarget(gen: Gen): TestTarget | undefined {
  if (gen.chance(0.2)) return undefined;
  return { file: optionalString(gen), className: optionalString(gen), testName: optionalString(gen) };
}

function makeRoots(gen: Gen): string[] {
  return gen.list(0, 4, () => rootString(gen));
}

function makeStdout(gen: Gen): string {
  const boundary = '@@@b-studio-test-report@@@';
  const parts: string[] = [];
  const shape = gen.int(10);
  if (shape < 2) return gen.chance(0.35) ? gen.text(['\n', ' ', '\t', '\u00a0', '\ufeff', '\u2028', '\u0085'], gen.int(6)) : gen.text([...SAFE, ...SPECIAL, '\n', ' '], gen.int(20)); // 표지 없음
  const count = 1 + gen.int(4);
  for (let i = 0; i < count; i++) {
    if (gen.chance(0.2)) parts.push(gen.pick(['@@@', '@@@b-studio-test-report', 'b-studio-test-report@@@', '@@@b-studio-test-report@@', '@@']));
    parts.push(boundary);
    parts.push(gen.pick(['build/a.xml', ' target/x.xml ', '', '한글.xml', 'a b', '﻿x', 'f\rg', 'f g', "it's", '😀', '\ud800']));
    parts.push(gen.weighted<string>([[7, '\n'], [2, '\r\n'], [1, '\r'], [1, ' '], [1, ' '], [1, '']]));
    parts.push(gen.pick(['<testsuite/>', '{"a":1}', '', '  \n ', 'x\n\n', '﻿<x/> ', 'a\r\nb', 'line1\nline2\n', '@@@', boundary]));
    if (gen.chance(0.3)) parts.push(gen.text(SPECIAL, 1 + gen.int(3)));
  }
  return parts.join('');
}

function makePackageJson(gen: Gen): unknown {
  const depValue = (): unknown => gen.pick(['^1.0.0', '1', '', 0, 1, null, false, true, [], ['x'], {}, { a: 1 }, '0']);
  const deps = (): unknown => {
    if (gen.chance(0.12)) return gen.pick([null, 'vitest', 5, ['vitest'], true]);
    const out: Record<string, unknown> = {};
    for (const name of ['vitest', 'jest', 'react', '__proto__', 'constructor']) if (gen.chance(name === 'vitest' || name === 'jest' ? 0.35 : 0.2)) out[name] = depValue();
    return out;
  };
  const scriptText = (): unknown =>
    gen.weighted<() => unknown>([
      [5, () => gen.pick(['vitest run', 'jest', 'npx vitest', 'jest --ci', 'vitest', 'xvitest', 'vitestx', 'my-jest-runner', 'jest_x', 'node test.js', 'vitest-jest', '', ' jest ', '한jest한', 'jest\nvitest', ' vitest', 'VITEST', 'ｊest'])],
      [1, () => null],
      [1, () => 5],
      [1, () => ['x', 'jest']],
      [1, () => [['vitest']]],
      [1, () => ({ a: 'jest' })],
    ])();
  const pj: Record<string, unknown> = {};
  if (gen.chance(0.6)) pj.dependencies = deps();
  if (gen.chance(0.6)) pj.devDependencies = deps();
  if (gen.chance(0.75)) pj.scripts = gen.chance(0.1) ? gen.pick(['jest', ['jest'], 5, null]) : gen.chance(0.85) ? { test: scriptText() } : { lint: 'x' };
  return JSON.parse(JSON.stringify(pj)) as unknown;
}

const TEMPLATES = ['spring-boot', 'Spring', 'SPRING', 'nextjs', 'Next.js', 'vite', 'react', 'node', 'express-node', 'fastapi', 'FastAPI', 'python', 'django', 'flask', 'go', 'rails', '', 'sprİng', 'flasK', 'fastKapi', 'ＳＰＲＩＮＧ', 'Ηνεξ', 'ΣΝΟDΕ', 'spring', 'İ', 'static', 'reactive', 'nodejs', 'springnext', 'flaskvite'];

function makeDetectInput(gen: Gen): DetectRunnerInput {
  const template = gen.chance(0.7) ? gen.pick(TEMPLATES) : gen.pick(TEMPLATES) + gen.text([...SAFE, ...SPECIAL], gen.int(3)) + gen.pick(TEMPLATES);
  const input: DetectRunnerInput = { template };
  const pom = gen.int(3);
  if (pom === 1) input.hasPomXml = true;
  if (pom === 2) input.hasPomXml = false;
  const kind = gen.int(10);
  if (kind < 6) input.packageJson = makePackageJson(gen) as DetectRunnerInput['packageJson'];
  else if (kind === 6) input.packageJson = gen.pick([null, 'x', 5, [], ['vitest'], true]) as unknown as DetectRunnerInput['packageJson'];
  return input;
}

function outcomeKind(result: Outcome, classify: (value: unknown) => string): string {
  return result.threw ? 'threw' : classify(result.value);
}

interface Stats {
  total: number;
  mismatches: number;
  kinds: Map<string, number>;
  controlTried: number;
  controlCaught: number;
}

function newStats(): Stats {
  return { total: 0, mismatches: 0, kinds: new Map(), controlTried: 0, controlCaught: 0 };
}

/** 함수 하나를 옛 구현과 새 껍데기에 같은 입력으로 돌려 결과를 견주고, 결과 종류를 센다. 대조 장치: 새 결과를 조금 바꿔서 차이로 잡히는지 */
function compare(stats: Stats, legacyRun: () => unknown, currentRun: () => unknown, classify: (value: unknown) => string, show: string): void {
  const expected = outcome(legacyRun);
  const actual = outcome(currentRun);
  stats.total += 1;
  const kind = outcomeKind(expected, classify);
  stats.kinds.set(kind, (stats.kinds.get(kind) ?? 0) + 1);
  if (!sameOutcome(expected, actual)) {
    stats.mismatches += 1;
    if (stats.mismatches <= 3) console.error(`불일치 ${show}\n  옛: ${JSON.stringify(expected)}\n  새: ${JSON.stringify(actual)}`);
  }
  if (!actual.threw && stats.total % 5 === 0) {
    stats.controlTried += 1;
    if (!sameOutcome(expected, { threw: false, value: perturb(actual.value) })) stats.controlCaught += 1;
  }
}

function finish(name: string, stats: Stats, minShare: Record<string, number>): void {
  const distribution = [...stats.kinds.entries()].map(([kind, count]) => `${kind} ${count}`).join(', ');
  if (REPORT) console.log(`[${name}] 비교 ${stats.total}, 다른 결과 ${stats.mismatches}, 분포: ${distribution}, 대조 장치 ${stats.controlCaught}/${stats.controlTried}`);
  expect(stats.mismatches).toBe(0);
  expect(stats.controlCaught).toBe(stats.controlTried);
  for (const [kind, share] of Object.entries(minShare)) expect(stats.kinds.get(kind) ?? 0, `${name}의 ${kind} 비율`).toBeGreaterThanOrEqual(stats.total * share);
}

describe('test-run 차등 시험(옛 TS와 Rust 껍데기)', () => {
  for (const seed of SEEDS) {
    it(`시드 ${seed}: 입력 ${ITERATIONS}개씩 모든 함수의 결과가 글자까지 같다`, () => {
      const gen = new Gen(seed);
      const plan = newStats();
      const clear = newStats();
      const includes = newStats();
      const split = newStats();
      const detect = newStats();
      for (let i = 0; i < ITERATIONS; i++) {
        const runner = gen.pick(RUNNERS);
        const target = makeTarget(gen);
        const roots = makeRoots(gen);
        const wrapper = gen.pick([undefined, true, false]);
        compare(plan, () => legacy.buildTestRunPlan(runner, target, { wrapper, extraReportRoots: roots }), () => buildTestRunPlan(runner, target, { wrapper, extraReportRoots: roots }), (v) => `${runner}${(v as { collect: string[] }).collect.join('').includes("'/") ? '+roots' : ''}`, JSON.stringify({ runner, target, roots, wrapper }));
        // extraReportRoots 인자를 아예 주지 않는 호출도 같다
        compare(plan, () => legacy.buildTestRunPlan(runner, target), () => buildTestRunPlan(runner, target), (v) => `${runner}${(v as { collect: string[] }).collect.join('').includes("'/") ? '+roots' : ''}`, JSON.stringify({ runner, target }));
        compare(clear, () => legacy.clearTestReportsCommand(roots), () => clearTestReportsCommand(roots), (v) => ((v as string[])[2]!.includes("'/") ? 'roots-kept' : 'roots-dropped'), JSON.stringify(roots));

        const incs = gen.list(0, 4, () => weirdString(gen));
        const root = gen.chance(0.4) ? undefined : weirdString(gen);
        compare(includes, () => legacy.reportRootsForIncludes(incs, root), () => reportRootsForIncludes(incs, root), (v) => ((v as string[]).length === 0 ? 'empty' : 'value'), JSON.stringify({ incs, root }));
        if (gen.chance(0.1)) compare(includes, () => legacy.reportRootsForIncludes(undefined, root), () => reportRootsForIncludes(undefined, root), () => 'undefined-includes', 'undefined');

        const stdout = makeStdout(gen);
        const label = gen.chance(0.6) ? undefined : weirdString(gen);
        compare(split, () => legacy.splitCollectedReports(stdout, label), () => splitCollectedReports(stdout, label), (v) => ((v as unknown[]).length === 0 ? (stdout.includes('@@@b-studio-test-report@@@') ? 'boundary-no-match' : 'empty') : stdout.includes('@@@b-studio-test-report@@@') ? 'parts' : 'single'), JSON.stringify({ stdout, label }));

        const input = makeDetectInput(gen);
        compare(detect, () => legacy.detectRunner(input), () => detectRunner(input), (v) => String(v), JSON.stringify(input));
        if (i % 50 === 0) {
          const label2 = gen.pick(RUNNERS);
          expect(runnerLabel(label2)).toBe(legacy.runnerLabel(label2));
        }
      }
      finish('buildTestRunPlan', plan, { gradle: 0.05, maven: 0.05, vitest: 0.05, jest: 0.05, pytest: 0.05 });
      finish('clearTestReportsCommand', clear, { 'roots-kept': 0.3, 'roots-dropped': 0.02 });
      finish('reportRootsForIncludes', includes, { empty: 0.03, value: 0.5 });
      finish('splitCollectedReports', split, { empty: 0.01, single: 0.05, parts: 0.1, 'boundary-no-match': 0.01 });
      finish('detectRunner', detect, { maven: 0.01, gradle: 0.01, pytest: 0.03, vitest: 0.03, jest: 0.03, undefined: 0.1 });
    });
  }

  it('대조 장치: 새 결과를 조금 바꾸면 차이로 잡힌다', () => {
    const expected = outcome(() => legacy.buildTestRunPlan('gradle', { className: 'A' }));
    const actual = outcome(() => buildTestRunPlan('gradle', { className: 'A' }));
    expect(sameOutcome(expected, actual)).toBe(true);
    expect(sameOutcome(expected, { threw: false, value: perturb((actual as { value: unknown }).value) })).toBe(false);
    expect(sameOutcome(expected, { threw: true })).toBe(false);
    expect(wellFormed('a\ud800')).toBe('a�');
  });
});
