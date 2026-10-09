/**
 * 테스트 탭(ADR-084)의 발견 단계 — 세션 작업 복사본의 테스트 파일에서 실제 테스트 케이스를 한 줄 한 줄 읽어 낸다.
 *
 * 순수 함수만 둔다(파일 IO 없음) — studio의 서버 쪽 코드가 파일을 읽어 이 모듈에 내용을 넘기고,
 * 여기서는 정규식 기반의 가벼운 토큰화로 스위트(클래스·describe)·테스트(메서드·it/test·def test_)를
 * 줄 번호와 함께 트리로 뽑는다. 지원 프레임워크: JUnit4/5(Java·Kotlin), Vitest/Jest/Playwright(ts/js/tsx/jsx), pytest.
 * 포맷이 흔들려도(들여쓰기, 줄바꿈 위치) 최대한 잡아내되, 완벽한 파서가 아니므로 못 잡는 형태는 조용히 건너뛴다.
 */

export type TestFramework = 'junit' | 'vitest' | 'jest' | 'playwright' | 'pytest';

export interface DiscoveredTestCase {
  /** 실행기(gradle --tests, jest -t 등)에 넘길 이름 */
  name: string;
  /** 사람이 보는 이름. @DisplayName이나 it()/test()의 문자열. 없으면 name과 같다 */
  displayName: string;
  line: number;
  skipped: boolean;
  /** 이름·표시 이름에서 찾은 요구사항 id(R1 등) */
  requirementIds: string[];
  /**
   * 이 테스트에 걸린 실행 환경 조건부 표시의 정적 추정(다그푸딩 마찰 152): JUnit `@Tag("…")`·`@Testcontainers`·
   * `@EnabledIf…`/`@DisabledIf…` 류, pytest의 스킵·파라미터화가 아닌 커스텀 마커(`@pytest.mark.integration` 등).
   * 게이트의 기본 test 태스크가 이런 테스트를 제외하도록 설정돼 있을 수 있다는 뜻일 뿐, 실제로 돌았는지는 이것만으로
   * 알 수 없다 — "이유 추정"으로만 쓴다(findUnexecutedTests, requirements.ts). 없으면 undefined(빈 배열을 넣지 않는다)
   */
  envConditionalReasons?: string[];
}

export interface DiscoveredSuite {
  name: string;
  displayName: string;
  line: number;
  /** 스위트 자체가 꺼져 있는지(@Disabled 클래스, describe.skip 등). 개별 테스트의 skipped와 별개다 */
  skipped: boolean;
  suites: DiscoveredSuite[];
  tests: DiscoveredTestCase[];
  /** 클래스(스위트) 자체에 걸린 실행 환경 조건부 표시. 안의 모든 테스트가 물려받는다(flattenDiscoveredFile) */
  envConditionalReasons?: string[];
}

export interface DiscoveredFile {
  path: string;
  framework: TestFramework;
  /** 파일 최상위 스위트(클래스, 최상위 describe) */
  suites: DiscoveredSuite[];
  /** 어느 스위트에도 속하지 않은 최상위 테스트(예: describe 없이 쓴 it()) */
  tests: DiscoveredTestCase[];
}

/** 요구사항 id(R1)뿐 아니라 시나리오 id(R4.1)도 통째로 한 토큰으로 잡는다(requirements.ts의 REQUIREMENT_MENTION_PATTERN과 같은 모양) */
const REQUIREMENT_ID_PATTERN = /\bR\d+(?:\.\d+)?\b/g;

/** 이름·표시 이름 글자에서 요구사항 id(R1, R2…)·시나리오 id(R4.1…)를 찾는다. 중복은 뺀다 */
export function extractRequirementIds(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(REQUIREMENT_ID_PATTERN)) found.add(match[0]);
  return [...found];
}

/**
 * 묶음(describe·클래스) 제목 경로에 단 id까지 합쳐 테스트 하나의 id를 구한다. `describe('R11.2: …')` 아래 `it('…')`처럼
 * 시나리오 id를 묶음 제목에만 다는 것은 vitest·jest에서 흔한 쓰기 방식이라, 묶음 제목의 id는 그 안의 모든 테스트의 id다
 * (중첩 묶음은 바깥 것까지). 테스트 자신의 제목에 단 id가 앞에 오고, 묶음 id는 바깥에서 안쪽 순서로 뒤따르며,
 * 같은 id를 둘 다에서 받아도 한 번만 센다. 발견 단계(flattenDiscoveredFile)와 보고서 단계(sessions.ts)가 같은 규칙을 쓴다
 */
export function extractRequirementIdsWithSuites(suitePath: readonly string[] | undefined, title: string): string[] {
  return [...new Set([...extractRequirementIds(title), ...(suitePath ?? []).flatMap((suite) => extractRequirementIds(suite))])];
}

function countBraceDelta(line: string): number {
  // 문자열 리터럴 안의 중괄호까지 정확히 가리려면 전체 토크나이저가 필요하다. 여기서는 규모상 줄 단위로 단순히 센다(가벼운 토큰화 허용)
  return (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
}

// ---------------------------------------------------------------------------
// JUnit 4/5 (Java/Kotlin)
// ---------------------------------------------------------------------------

// 인자가 큰따옴표 문자열이면 그 안의 괄호까지 통째로 읽는다(@DisplayName("상세(단일 객체)…")) — 첫 ")"에서 끊으면 표시 이름을 놓쳤다
const JUNIT_ANNOTATION = /@(Test|ParameterizedTest|RepeatedTest|Nested|Disabled|DisplayName|Tag)\b(?:\((\s*"(?:\\.|[^"\\])*"\s*|[^)]*)\))?/g;
const JUNIT_CLASS = /\bclass\s+(\w+)/;
// public void testFoo(), void testFoo() throws Exception, fun testFoo() (Kotlin)
const JUNIT_METHOD = /(?:^|\s)(?:fun|void|[\w<>[\],.]+)\s+(\w+)\s*\(/;
/** Testcontainers 사용을 알리는 클래스 수준 표지. 보통 @Tag("integration")와 함께 붙어, 게이트 샌드박스에 Docker가
 * 없으면 이 클래스의 테스트는 기본 test 태스크에서 돌아도 Testcontainers가 멈춘다(다그푸딩 마찰 152) */
const JUNIT_TESTCONTAINERS = /@Testcontainers\b/;
/** `@Disabled`(무조건 꺼짐, pendingDisabled가 따로 다룬다)는 제외하고, `@EnabledIf…`/`@DisabledIf…` 류(환경 변수·시스템
 * 프로퍼티·OS·JRE 조건)만 잡는다 — 이름 뒤에 글자가 더 있어야 하므로 bare `@Disabled`는 이 패턴에 걸리지 않는다 */
const JUNIT_CONDITIONAL_ANNOTATION = /@((?:Enabled|Disabled)[A-Za-z]+)\b/g;

/** 인자가 여러 줄에 걸쳐도 이어 읽는 최대 줄 수. 닫는 괄호를 못 찾으면 표시 이름 없이 넘어간다 */
const ANNOTATION_ARGUMENT_MAX_LINES = 20;

/**
 * `@DisplayName(` 뒤 인자를 닫는 괄호까지 읽는다. `@DisplayName("앞" + "뒤")`처럼 문자열을 이어 붙이거나 여러 줄에
 * 걸쳐 써도 받는다 — 한 줄만 보면 첫 문자열만 읽거나(같은 줄) 아예 놓쳐서(여러 줄) 표시 이름이 메서드 이름으로
 * 남고, 실행 결과(JUnit 보고서의 표시 이름)와 이어지지 않아 "안 돌림"으로 보였다. 문자열 안의 괄호는 세지 않는다
 */
function readAnnotationArgument(lines: readonly string[], startLine: number, openIndex: number): { text: string; endLine: number } | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let text = '';
  const lastLine = Math.min(lines.length - 1, startLine + ANNOTATION_ARGUMENT_MAX_LINES);
  for (let lineIndex = startLine; lineIndex <= lastLine; lineIndex++) {
    const line = lines[lineIndex]!;
    for (let col = lineIndex === startLine ? openIndex : 0; col < line.length; col++) {
      const char = line[col]!;
      if (inString) {
        text += char;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        text += char;
      } else if (char === '(') {
        if (depth > 0) text += char;
        depth++;
      } else if (char === ')') {
        depth--;
        if (depth === 0) return { text, endLine: lineIndex };
        text += char;
      } else if (depth > 0) text += char;
    }
    text += '\n';
  }
  return undefined;
}

/** 인자 안의 문자열 조각을 모두 이어 붙인다(`"앞" + "뒤"` → `앞뒤`) */
function joinStringLiterals(argument: string): string | undefined {
  const parts = [...argument.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) => match[1]!);
  return parts.length > 0 ? parts.join('') : undefined;
}

interface JunitStackFrame {
  suite: DiscoveredSuite;
  /** 이 스위트 본문이 끝나는 중괄호 깊이(이 값 아래로 내려가면 스위트를 닫는다) */
  closeAtDepth: number;
}

/** JUnit 4/5 테스트 파일(Java·Kotlin)에서 클래스(@Nested 포함)·테스트 메서드를 찾는다 */
export function discoverJunitFile(filePath: string, content: string): DiscoveredFile {
  const lines = content.split(/\r?\n/);
  const root: DiscoveredSuite[] = [];
  const stack: JunitStackFrame[] = [];
  let depth = 0;
  let pendingDisplayName: string | undefined;
  let pendingDisabled = false;
  let pendingIsTest = false;
  let pendingEnvReasons: string[] = [];

  const currentList = () => (stack.length > 0 ? stack[stack.length - 1]!.suite.suites : root);
  const takeEnvReasons = (): string[] | undefined => {
    if (pendingEnvReasons.length === 0) return undefined;
    const unique = [...new Set(pendingEnvReasons)];
    return unique;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    let argumentEndLine: number | undefined;
    for (const match of line.matchAll(JUNIT_ANNOTATION)) {
      const name = match[1];
      if (name === 'Test' || name === 'ParameterizedTest' || name === 'RepeatedTest') pendingIsTest = true;
      else if (name === 'Disabled') pendingDisabled = true;
      else if (name === 'DisplayName') {
        const openIndex = line.indexOf('(', match.index + match[0].indexOf('DisplayName'));
        const argument = openIndex >= 0 ? readAnnotationArgument(lines, i, openIndex) : undefined;
        const text = argument ? joinStringLiterals(argument.text) : undefined;
        if (text !== undefined) pendingDisplayName = text;
        if (argument && argument.endLine > i) argumentEndLine = argument.endLine;
      } else if (name === 'Tag') {
        const openIndex = line.indexOf('(', match.index + match[0].indexOf('Tag'));
        const argument = openIndex >= 0 ? readAnnotationArgument(lines, i, openIndex) : undefined;
        const text = argument ? joinStringLiterals(argument.text) : undefined;
        if (text !== undefined) pendingEnvReasons.push(`@Tag("${text}")`);
        if (argument && argument.endLine > i && (argumentEndLine === undefined || argument.endLine > argumentEndLine)) argumentEndLine = argument.endLine;
      }
    }
    if (JUNIT_TESTCONTAINERS.test(line)) pendingEnvReasons.push('@Testcontainers');
    for (const match of line.matchAll(JUNIT_CONDITIONAL_ANNOTATION)) pendingEnvReasons.push(`@${match[1]}`);
    // 여러 줄에 걸친 인자는 이어지는 줄까지 읽었으므로 건너뛴다(그 줄의 문자열 속 중괄호·괄호를 코드로 세지 않게)
    if (argumentEndLine !== undefined) {
      i = argumentEndLine;
      continue;
    }

    const classMatch = JUNIT_CLASS.exec(line);
    const methodMatch = !classMatch && pendingIsTest ? JUNIT_METHOD.exec(line) : null;

    if (classMatch) {
      const name = classMatch[1]!;
      const classEnvReasons = takeEnvReasons();
      const suite: DiscoveredSuite = {
        name,
        displayName: pendingDisplayName ?? name,
        line: lineNo,
        skipped: pendingDisabled,
        suites: [],
        tests: [],
        ...(classEnvReasons ? { envConditionalReasons: classEnvReasons } : {}),
      };
      currentList().push(suite);
      const delta = countBraceDelta(line);
      depth += delta;
      stack.push({ suite, closeAtDepth: depth });
      pendingDisplayName = undefined;
      pendingDisabled = false;
      pendingIsTest = false;
      pendingEnvReasons = [];
      continue;
    }

    if (methodMatch) {
      const name = methodMatch[1]!;
      const displayName = pendingDisplayName ?? name;
      const envReasons = takeEnvReasons();
      const test: DiscoveredTestCase = {
        name,
        displayName,
        line: lineNo,
        skipped: pendingDisabled,
        requirementIds: extractRequirementIds(`${displayName} ${name}`),
        ...(envReasons ? { envConditionalReasons: envReasons } : {}),
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.suite.tests.push(test);
      pendingDisplayName = undefined;
      pendingEnvReasons = [];
      pendingDisabled = false;
      pendingIsTest = false;
      depth += countBraceDelta(line);
      while (stack.length > 0 && depth < stack[stack.length - 1]!.closeAtDepth) stack.pop();
      continue;
    }

    depth += countBraceDelta(line);
    while (stack.length > 0 && depth < stack[stack.length - 1]!.closeAtDepth) stack.pop();
  }

  return { path: filePath, framework: 'junit', suites: root, tests: [] };
}

// ---------------------------------------------------------------------------
// Vitest / Jest / Playwright (ts/js/tsx/jsx)
// ---------------------------------------------------------------------------

// describe('x', ...), describe.skip('x', ...), test.describe('x', ...)(Playwright)
const JS_DESCRIBE = /\b(?:test\.)?describe(?:\.(skip|only|todo))?(?:\.each\([^)]*\))?\s*\(\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/;
// it('x', ...), test('x', ...), it.skip/.only/.todo, it.each([...])('x', ...)
const JS_TEST = /\b(it|test)(?:\.(skip|only|todo))?(?:\.each\([^)]*\))?\s*\(\s*(['"`])((?:\\.|(?!\3)[\s\S])*?)\3/;

interface JsStackFrame {
  suite: DiscoveredSuite;
  closeAtDepth: number;
}

/** 파일 내용에서 프레임워크를 짐작한다(@playwright/test import가 있으면 playwright, vitest import가 있으면 vitest, 그 밖은 jest로 본다) */
export function detectJsFramework(content: string): TestFramework {
  if (/from\s+['"]@playwright\/test['"]/.test(content) || /\btest\.describe\s*\(/.test(content)) return 'playwright';
  if (/from\s+['"]vitest['"]/.test(content)) return 'vitest';
  return 'jest';
}

/** Vitest/Jest/Playwright 테스트 파일에서 describe·it/test를 찾는다. 제목 문자열은 같은 줄에 있다고 가정한다(여러 줄 제목은 지원하지 않는다) */
export function discoverJsFile(filePath: string, content: string, framework: TestFramework = detectJsFramework(content)): DiscoveredFile {
  const lines = content.split(/\r?\n/);
  const root: DiscoveredSuite[] = [];
  const topTests: DiscoveredTestCase[] = [];
  const stack: JsStackFrame[] = [];
  let depth = 0;

  const currentSuiteList = () => (stack.length > 0 ? stack[stack.length - 1]!.suite.suites : root);
  const currentTestList = () => (stack.length > 0 ? stack[stack.length - 1]!.suite.tests : topTests);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    const describeMatch = JS_DESCRIBE.exec(line);
    const testMatch = !describeMatch ? JS_TEST.exec(line) : null;

    if (describeMatch) {
      const modifier = describeMatch[1];
      const title = unescapeJsString(describeMatch[3]!);
      const suite: DiscoveredSuite = { name: title, displayName: title, line: lineNo, skipped: modifier === 'skip' || modifier === 'todo', suites: [], tests: [] };
      currentSuiteList().push(suite);
      const delta = countBraceDelta(line);
      depth += delta;
      stack.push({ suite, closeAtDepth: depth });
      continue;
    }

    if (testMatch) {
      const modifier = testMatch[2];
      const title = unescapeJsString(testMatch[4]!);
      const test: DiscoveredTestCase = { name: title, displayName: title, line: lineNo, skipped: modifier === 'skip' || modifier === 'todo', requirementIds: extractRequirementIds(title) };
      currentTestList().push(test);
      depth += countBraceDelta(line);
      while (stack.length > 0 && depth < stack[stack.length - 1]!.closeAtDepth) stack.pop();
      continue;
    }

    depth += countBraceDelta(line);
    while (stack.length > 0 && depth < stack[stack.length - 1]!.closeAtDepth) stack.pop();
  }

  return { path: filePath, framework, suites: root, tests: topTests };
}

function unescapeJsString(raw: string): string {
  return raw.replace(/\\(.)/g, '$1');
}

// ---------------------------------------------------------------------------
// pytest
// ---------------------------------------------------------------------------

const PYTEST_CLASS = /^(\s*)class\s+(Test\w*)\b/;
const PYTEST_DEF = /^(\s*)(?:async\s+)?def\s+(test_\w+)\s*\(/;
const PYTEST_SKIP_MARK = /@pytest\.mark\.(?:skip|skipif)\b/;
const PYTEST_PARAMETRIZE = /@pytest\.mark\.parametrize\b/;
/** 스킵·파라미터화·흔한 비환경 마커는 "실행 환경 조건부 표시"로 보지 않는다. 그 밖의 커스텀 마커(`integration`·
 * `docker` 등, 보통 `-m "not …"`으로 걸러진다)만 다그푸딩 마찰 152의 "이유 추정"으로 잡는다 */
const PYTEST_MARK = /@pytest\.mark\.(\w+)/g;
const PYTEST_NON_ENV_MARKS = new Set(['parametrize', 'skip', 'skipif', 'usefixtures', 'asyncio', 'xfail', 'filterwarnings']);

interface PytestStackFrame {
  suite: DiscoveredSuite;
  indent: number;
}

/** pytest 테스트 파일(test_*.py, *_test.py)에서 class Test*와 def test_*를 찾는다. 들여쓰기로 중첩을 판단한다(탭은 스페이스 하나로 센다) */
export function discoverPytestFile(filePath: string, content: string): DiscoveredFile {
  const lines = content.split(/\r?\n/);
  const root: DiscoveredSuite[] = [];
  const topTests: DiscoveredTestCase[] = [];
  const stack: PytestStackFrame[] = [];
  let pendingSkip = false;
  let pendingParametrized = false;
  let pendingEnvReasons: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    if (PYTEST_SKIP_MARK.test(line)) pendingSkip = true;
    if (PYTEST_PARAMETRIZE.test(line)) pendingParametrized = true;
    for (const match of line.matchAll(PYTEST_MARK)) {
      const mark = match[1]!;
      if (!PYTEST_NON_ENV_MARKS.has(mark)) pendingEnvReasons.push(`@pytest.mark.${mark}`);
    }

    const classMatch = PYTEST_CLASS.exec(line);
    const defMatch = !classMatch ? PYTEST_DEF.exec(line) : null;

    if (classMatch) {
      const indent = classMatch[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const name = classMatch[2]!;
      const envReasons = pendingEnvReasons.length > 0 ? [...new Set(pendingEnvReasons)] : undefined;
      const suite: DiscoveredSuite = { name, displayName: name, line: lineNo, skipped: pendingSkip, suites: [], tests: [], ...(envReasons ? { envConditionalReasons: envReasons } : {}) };
      (stack.length > 0 ? stack[stack.length - 1]!.suite.suites : root).push(suite);
      stack.push({ suite, indent });
      pendingSkip = false;
      pendingParametrized = false;
      pendingEnvReasons = [];
      continue;
    }

    if (defMatch) {
      const indent = defMatch[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const name = defMatch[2]!;
      const displayName = pendingParametrized ? `${name} (매개변수화됨)` : name;
      const envReasons = pendingEnvReasons.length > 0 ? [...new Set(pendingEnvReasons)] : undefined;
      const test: DiscoveredTestCase = {
        name,
        displayName,
        line: lineNo,
        skipped: pendingSkip,
        requirementIds: extractRequirementIds(name),
        ...(envReasons ? { envConditionalReasons: envReasons } : {}),
      };
      (stack.length > 0 ? stack[stack.length - 1]!.suite.tests : topTests).push(test);
      pendingSkip = false;
      pendingParametrized = false;
      pendingEnvReasons = [];
      continue;
    }

    // 장식자도 아니고 class/def도 아닌 코드 줄을 만나면(빈 줄·주석 제외) 대기 중이던 장식자는 버린다
    if (line.trim() && !line.trim().startsWith('#') && !line.trim().startsWith('@')) {
      pendingSkip = false;
      pendingParametrized = false;
      pendingEnvReasons = [];
    }
  }

  return { path: filePath, framework: 'pytest', suites: root, tests: topTests };
}

// ---------------------------------------------------------------------------
// 파일 선택·디스패치
// ---------------------------------------------------------------------------

export const JUNIT_FILE_PATTERN = /(Test|Tests|IT)\.(java|kt)$/;
export const JS_TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;
export const PYTEST_FILE_PATTERN = /(^|\/)(test_\w+\.py|\w+_test\.py)$/;

/** 경로만 보고 테스트 파일로 볼지 정한다. 세 프레임워크의 관례적인 이름 규칙을 모두 본다 */
export function isTestFilePath(filePath: string): boolean {
  return JUNIT_FILE_PATTERN.test(filePath) || JS_TEST_FILE_PATTERN.test(filePath) || PYTEST_FILE_PATTERN.test(filePath);
}

/** 경로·내용을 보고 알맞은 파서로 테스트를 찾는다. 테스트 파일로 보이지 않으면 undefined */
export function discoverTestsInFile(filePath: string, content: string): DiscoveredFile | undefined {
  if (JUNIT_FILE_PATTERN.test(filePath)) return discoverJunitFile(filePath, content);
  if (JS_TEST_FILE_PATTERN.test(filePath)) return discoverJsFile(filePath, content);
  if (PYTEST_FILE_PATTERN.test(filePath)) return discoverPytestFile(filePath, content);
  return undefined;
}

/** 파일의 스위트·테스트 트리를 한 줄씩 펴서 화면이 그리기 쉬운 평평한 목록으로 만든다 */
export interface FlatDiscoveredTest extends DiscoveredTestCase {
  file: string;
  /** 바깥 → 안쪽 순서의 스위트 이름(사람이 읽는 표시 이름) */
  suitePath: string[];
  suiteSkipped: boolean;
}

/** 부모 스위트(클래스)의 환경 조건부 표시와 테스트 자신의 표시를 합친다(순서·중복 없이). 둘 다 없으면 undefined */
function mergeEnvConditionalReasons(...groups: Array<readonly string[] | undefined>): string[] | undefined {
  const merged = [...new Set(groups.flatMap((group) => group ?? []))];
  return merged.length > 0 ? merged : undefined;
}

export function flattenDiscoveredFile(file: DiscoveredFile): FlatDiscoveredTest[] {
  const rows: FlatDiscoveredTest[] = [];
  const walkSuite = (suite: DiscoveredSuite, path: string[], ancestorSkipped: boolean, ancestorEnvReasons: string[] | undefined) => {
    const suiteSkipped = ancestorSkipped || suite.skipped;
    const suiteEnvReasons = mergeEnvConditionalReasons(ancestorEnvReasons, suite.envConditionalReasons);
    const nextPath = [...path, suite.displayName];
    for (const test of suite.tests) {
      const envConditionalReasons = mergeEnvConditionalReasons(suiteEnvReasons, test.envConditionalReasons);
      // 묶음 제목에 단 id도 이 테스트의 id다(extractRequirementIdsWithSuites). 테스트 자신의 id가 앞에 온다
      const requirementIds = [...new Set([...test.requirementIds, ...extractRequirementIdsWithSuites(nextPath, '')])];
      rows.push({ ...test, requirementIds, file: file.path, suitePath: nextPath, suiteSkipped, ...(envConditionalReasons ? { envConditionalReasons } : {}) });
    }
    for (const child of suite.suites) walkSuite(child, nextPath, suiteSkipped, suiteEnvReasons);
  };
  for (const test of file.tests) rows.push({ ...test, file: file.path, suitePath: [], suiteSkipped: false });
  for (const suite of file.suites) walkSuite(suite, [], false, undefined);
  return rows;
}
