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
}

export interface DiscoveredSuite {
  name: string;
  displayName: string;
  line: number;
  /** 스위트 자체가 꺼져 있는지(@Disabled 클래스, describe.skip 등). 개별 테스트의 skipped와 별개다 */
  skipped: boolean;
  suites: DiscoveredSuite[];
  tests: DiscoveredTestCase[];
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

function countBraceDelta(line: string): number {
  // 문자열 리터럴 안의 중괄호까지 정확히 가리려면 전체 토크나이저가 필요하다. 여기서는 규모상 줄 단위로 단순히 센다(가벼운 토큰화 허용)
  return (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
}

// ---------------------------------------------------------------------------
// JUnit 4/5 (Java/Kotlin)
// ---------------------------------------------------------------------------

const JUNIT_ANNOTATION = /@(Test|ParameterizedTest|RepeatedTest|Nested|Disabled|DisplayName)\b(?:\(([^)]*)\))?/g;
const JUNIT_CLASS = /\bclass\s+(\w+)/;
// public void testFoo(), void testFoo() throws Exception, fun testFoo() (Kotlin)
const JUNIT_METHOD = /(?:^|\s)(?:fun|void|[\w<>[\],.]+)\s+(\w+)\s*\(/;

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

  const currentList = () => (stack.length > 0 ? stack[stack.length - 1]!.suite.suites : root);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    for (const match of line.matchAll(JUNIT_ANNOTATION)) {
      const name = match[1];
      if (name === 'Test' || name === 'ParameterizedTest' || name === 'RepeatedTest') pendingIsTest = true;
      else if (name === 'Disabled') pendingDisabled = true;
      else if (name === 'DisplayName') {
        const text = /"((?:\\.|[^"\\])*)"/.exec(match[2] ?? '');
        if (text) pendingDisplayName = text[1];
      }
    }

    const classMatch = JUNIT_CLASS.exec(line);
    const methodMatch = !classMatch && pendingIsTest ? JUNIT_METHOD.exec(line) : null;

    if (classMatch) {
      const name = classMatch[1]!;
      const suite: DiscoveredSuite = {
        name,
        displayName: pendingDisplayName ?? name,
        line: lineNo,
        skipped: pendingDisabled,
        suites: [],
        tests: [],
      };
      currentList().push(suite);
      const delta = countBraceDelta(line);
      depth += delta;
      stack.push({ suite, closeAtDepth: depth });
      pendingDisplayName = undefined;
      pendingDisabled = false;
      pendingIsTest = false;
      continue;
    }

    if (methodMatch) {
      const name = methodMatch[1]!;
      const displayName = pendingDisplayName ?? name;
      const test: DiscoveredTestCase = { name, displayName, line: lineNo, skipped: pendingDisabled, requirementIds: extractRequirementIds(`${displayName} ${name}`) };
      const parent = stack[stack.length - 1];
      if (parent) parent.suite.tests.push(test);
      pendingDisplayName = undefined;
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    if (PYTEST_SKIP_MARK.test(line)) pendingSkip = true;
    if (PYTEST_PARAMETRIZE.test(line)) pendingParametrized = true;

    const classMatch = PYTEST_CLASS.exec(line);
    const defMatch = !classMatch ? PYTEST_DEF.exec(line) : null;

    if (classMatch) {
      const indent = classMatch[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const name = classMatch[2]!;
      const suite: DiscoveredSuite = { name, displayName: name, line: lineNo, skipped: pendingSkip, suites: [], tests: [] };
      (stack.length > 0 ? stack[stack.length - 1]!.suite.suites : root).push(suite);
      stack.push({ suite, indent });
      pendingSkip = false;
      pendingParametrized = false;
      continue;
    }

    if (defMatch) {
      const indent = defMatch[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const name = defMatch[2]!;
      const displayName = pendingParametrized ? `${name} (매개변수화됨)` : name;
      const test: DiscoveredTestCase = { name, displayName, line: lineNo, skipped: pendingSkip, requirementIds: extractRequirementIds(name) };
      (stack.length > 0 ? stack[stack.length - 1]!.suite.tests : topTests).push(test);
      pendingSkip = false;
      pendingParametrized = false;
      continue;
    }

    // 장식자도 아니고 class/def도 아닌 코드 줄을 만나면(빈 줄·주석 제외) 대기 중이던 장식자는 버린다
    if (line.trim() && !line.trim().startsWith('#') && !line.trim().startsWith('@')) {
      pendingSkip = false;
      pendingParametrized = false;
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

export function flattenDiscoveredFile(file: DiscoveredFile): FlatDiscoveredTest[] {
  const rows: FlatDiscoveredTest[] = [];
  const walkSuite = (suite: DiscoveredSuite, path: string[], ancestorSkipped: boolean) => {
    const suiteSkipped = ancestorSkipped || suite.skipped;
    const nextPath = [...path, suite.displayName];
    for (const test of suite.tests) rows.push({ ...test, file: file.path, suitePath: nextPath, suiteSkipped });
    for (const child of suite.suites) walkSuite(child, nextPath, suiteSkipped);
  };
  for (const test of file.tests) rows.push({ ...test, file: file.path, suitePath: [], suiteSkipped: false });
  for (const suite of file.suites) walkSuite(suite, [], false);
  return rows;
}
