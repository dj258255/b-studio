import { describe, expect, it } from 'vitest';
import {
  detectJsFramework,
  discoverJsFile,
  discoverJunitFile,
  discoverPytestFile,
  discoverTestsInFile,
  extractRequirementIds,
  extractRequirementIdsWithSuites,
  flattenDiscoveredFile,
  isTestFilePath,
  type DiscoveredFile,
  type DiscoveredSuite,
  type DiscoveredTestCase,
  type FlatDiscoveredTest,
  type TestFramework,
} from './test-discovery';

/**
 * test-discovery를 Rust로 옮기면서(ADR-191 3a) 옛 TS 구현을 아래 `legacy`에 그대로 두고, 같은 무작위 입력을 옛 구현과
 * 새 껍데기에 넣어 결과를 JSON.stringify 글자(키 순서 포함)로 견준다. `legacy`는 옮기기 전 `test-discovery.ts`의 본문이다
 * (`export`만 뗐다). 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * 크기는 환경 변수로 바꾼다: TEST_DISCOVERY_DIFF_SEEDS(쉼표 목록), TEST_DISCOVERY_DIFF_ITERATIONS, TEST_DISCOVERY_DIFF_REPORT=1(분포 출력)
 */
const legacy = (() => {
  /** 요구사항 id(R1)뿐 아니라 시나리오 id(R4.1)도 통째로 한 토큰으로 잡는다(requirements.ts의 REQUIREMENT_MENTION_PATTERN과 같은 모양) */
  const REQUIREMENT_ID_PATTERN = /\bR\d+(?:\.\d+)?\b/g;

  /** 이름·표시 이름 글자에서 요구사항 id(R1, R2…)·시나리오 id(R4.1…)를 찾는다. 중복은 뺀다 */
  function extractRequirementIds(text: string): string[] {
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
  function extractRequirementIdsWithSuites(suitePath: readonly string[] | undefined, title: string): string[] {
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
  function discoverJunitFile(filePath: string, content: string): DiscoveredFile {
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
  function detectJsFramework(content: string): TestFramework {
    if (/from\s+['"]@playwright\/test['"]/.test(content) || /\btest\.describe\s*\(/.test(content)) return 'playwright';
    if (/from\s+['"]vitest['"]/.test(content)) return 'vitest';
    return 'jest';
  }

  /** Vitest/Jest/Playwright 테스트 파일에서 describe·it/test를 찾는다. 제목 문자열은 같은 줄에 있다고 가정한다(여러 줄 제목은 지원하지 않는다) */
  function discoverJsFile(filePath: string, content: string, framework: TestFramework = detectJsFramework(content)): DiscoveredFile {
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
  function discoverPytestFile(filePath: string, content: string): DiscoveredFile {
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

  const JUNIT_FILE_PATTERN = /(Test|Tests|IT)\.(java|kt)$/;
  const JS_TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;
  const PYTEST_FILE_PATTERN = /(^|\/)(test_\w+\.py|\w+_test\.py)$/;

  /** 경로만 보고 테스트 파일로 볼지 정한다. 세 프레임워크의 관례적인 이름 규칙을 모두 본다 */
  function isTestFilePath(filePath: string): boolean {
    return JUNIT_FILE_PATTERN.test(filePath) || JS_TEST_FILE_PATTERN.test(filePath) || PYTEST_FILE_PATTERN.test(filePath);
  }

  /** 경로·내용을 보고 알맞은 파서로 테스트를 찾는다. 테스트 파일로 보이지 않으면 undefined */
  function discoverTestsInFile(filePath: string, content: string): DiscoveredFile | undefined {
    if (JUNIT_FILE_PATTERN.test(filePath)) return discoverJunitFile(filePath, content);
    if (JS_TEST_FILE_PATTERN.test(filePath)) return discoverJsFile(filePath, content);
    if (PYTEST_FILE_PATTERN.test(filePath)) return discoverPytestFile(filePath, content);
    return undefined;
  }

  /** 부모 스위트(클래스)의 환경 조건부 표시와 테스트 자신의 표시를 합친다(순서·중복 없이). 둘 다 없으면 undefined */
  function mergeEnvConditionalReasons(...groups: Array<readonly string[] | undefined>): string[] | undefined {
    const merged = [...new Set(groups.flatMap((group) => group ?? []))];
    return merged.length > 0 ? merged : undefined;
  }

  function flattenDiscoveredFile(file: DiscoveredFile): FlatDiscoveredTest[] {
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

  return {
    extractRequirementIds,
    extractRequirementIdsWithSuites,
    discoverJunitFile,
    detectJsFramework,
    discoverJsFile,
    discoverPytestFile,
    isTestFilePath,
    discoverTestsInFile,
    flattenDiscoveredFile,
  };
})();

// ---------------------------------------------------------------------------
// 차등 시험: 같은 무작위 입력을 옛 TS(위 legacy)와 새 껍데기(Rust)에 넣어 JSON.stringify 글자(키 순서 포함)로 견준다
// ---------------------------------------------------------------------------

/** 선형 합동은 입력이 쏠려(ADR-191 2b-1) mulberry32를 쓴다 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const chance = (rng: Rng, p: number): boolean => rng() < p;
const between = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

/** JS와 Rust가 다르게 읽기 쉬운 글자. 서로게이트는 쌍으로만 넣는다(짝 없는 절반은 napi 경계에서 U+FFFD로 바뀐다 — 의도한 차이) */
const SPECIAL = ['\u{1F600}', '𝒳', '﻿', ' ', '\u0085', ' ', ' ', '　', ' ', '한글', 'é', '\r', '\t', '\v', '\f', '\0', '\\', '\\\\', '"', "'", '`', '{', '}', '(', ')'];

function sprinkle(rng: Rng, text: string, rate: number): string {
  if (!chance(rng, rate)) return text;
  const count = between(rng, 1, 3);
  let out = text;
  for (let n = 0; n < count; n++) {
    const at = between(rng, 0, out.length);
    // 서로게이트 쌍의 가운데를 자르지 않는다
    const safeAt = at > 0 && at < out.length && /[\uD800-\uDBFF]/.test(out[at - 1]!) ? at - 1 : at;
    if (chance(rng, 0.8)) out = out.slice(0, safeAt) + pick(rng, SPECIAL) + out.slice(safeAt);
    else if (safeAt < out.length && !/[\uD800-\uDFFF]/.test(out[safeAt]!)) out = out.slice(0, safeAt) + out.slice(safeAt + 1);
  }
  return out;
}

const WORDS = ['create', 'Order', 'R1', 'R12', 'R4.1', 'R2.', 'R', 'R10.5.6', 'xR1', 'R1x', '주문', '[R3]', 'user', 'login', 'a b', 'it', 'test', 'describe', 'class', 'Test', 'Tests', 'IT', '_x9', 'x-y', '😀', 'R٣', 'Ｒ1'];
const phrase = (rng: Rng): string => Array.from({ length: between(rng, 0, 4) }, () => pick(rng, WORDS)).join(pick(rng, [' ', ' ', '', '_', ' ', ': ']));
const ident = (rng: Rng): string => pick(rng, ['create', 'Order', 'test', 'Foo', 'a1', '_x', 'R1', 'x']) + pick(rng, ['', 'Test', '2', '_ok', 'é', '한']);
const indent = (rng: Rng): string => pick(rng, ['', '  ', '    ', '\t', ' ', '　 ', ' \t', '﻿  ', '\u0085 ', '        ']);

function javaString(rng: Rng): string {
  const body = phrase(rng) + pick(rng, ['', '', '\\"q\\"', '(paren)', ')', '(', '\\\\', '\\', ' \\n', '{', '}']) + phrase(rng);
  return `"${body}"`;
}

function junitLine(rng: Rng): string {
  const pad = indent(rng);
  switch (between(rng, 0, 27)) {
    case 0: return `${pad}@Test`;
    case 1: return `${pad}@ParameterizedTest`;
    case 2: return `${pad}@RepeatedTest(${between(rng, 1, 5)})`;
    case 3: return `${pad}@Nested`;
    case 4: return `${pad}@Disabled`;
    case 5: return `${pad}@Disabled(${javaString(rng)})`;
    case 6: return `${pad}@DisplayName(${javaString(rng)})`;
    case 7: return `${pad}@DisplayName(${javaString(rng)} + ${javaString(rng)})`;
    case 8: return `${pad}@DisplayName(`;
    case 9: return `${pad}    ${javaString(rng)}${pick(rng, ['', ' +', ')', ' + ' + javaString(rng) + ')'])}`;
    case 10: return `${pad}@Tag(${javaString(rng)})`;
    case 11: return `${pad}@Tag(${javaString(rng)}) @Test @DisplayName(${javaString(rng)})`;
    case 12: return `${pad}@Testcontainers`;
    case 13: return `${pad}@EnabledIfEnvironmentVariable(named = ${javaString(rng)}, matches = ${javaString(rng)})`;
    case 14: return `${pad}@DisabledOnOs(OS.WINDOWS) @Test`;
    case 15: return `${pad}@DisplayName ${pick(rng, ['', ' ', ' '])}(${javaString(rng)})`;
    case 16: return `${pad}${pick(rng, ['', 'public ', 'static ', 'final ', 'internal ', 'open '])}class ${ident(rng)}${pick(rng, ['', ' {', ' extends B {', '() {', ' { void m() {} }'])}`;
    case 17: return `${pad}@Nested class ${ident(rng)} {`;
    case 18: return `${pad}${pick(rng, ['public ', '', 'private '])}void ${ident(rng)}() ${pick(rng, ['{', 'throws Exception {', '{ }', '{}}'])}`;
    case 19: return `${pad}fun ${ident(rng)}() {`;
    case 20: return `${pad}@Test fun \`${phrase(rng)}\`() {`;
    case 21: return `${pad}${pick(rng, ['List<String>', 'Map<K,V>', 'int[]', 'String.Foo'])} ${ident(rng)}(int x) {`;
    case 22: return `${pad}}`;
    case 23: return `${pad}{`;
    case 24: return `${pad}${pick(rng, ['}', '{', '} {', '}}', '{{', ''])}`;
    case 25: return `${pad}// ${phrase(rng)} ${pick(rng, ['{', '}', '(', ')', '@Test', 'class X'])}`;
    case 26: return `${pad}@Test @Disabled ${pick(rng, ['@Tag("a")', '@Nested', ''])}`;
    default: return `${pad}${phrase(rng)}`;
  }
}

function joinLines(rng: Rng, lines: string[]): string {
  const sep = pick(rng, ['\n', '\n', '\n', '\r\n', '\n\r', '\r']);
  return lines.join(chance(rng, 0.85) ? '\n' : sep);
}

function junitContent(rng: Rng): string {
  const count = between(rng, 0, 28);
  const lines: string[] = [];
  // 실제 JUnit 파일 모양의 뼈대를 자주 쓴다
  if (chance(rng, 0.5)) lines.push('package com.example;', '', 'import org.junit.jupiter.api.*;', '');
  for (let n = 0; n < count; n++) lines.push(sprinkle(rng, junitLine(rng), 0.15));
  return joinLines(rng, lines);
}

const QUOTES = ["'", '"', '`'];
function jsTitle(rng: Rng, quote: string): string {
  let body = phrase(rng);
  if (chance(rng, 0.3)) body += pick(rng, ['\\' + quote, '\\\\', '\\n', '\\', quote, '\\ ', '\\\u{1F600}', '\\\\\\' + quote, '${x}', '(', ')', '{', '}']);
  if (chance(rng, 0.2)) body += phrase(rng);
  return body;
}

function jsLine(rng: Rng): string {
  const pad = indent(rng);
  const q = pick(rng, QUOTES);
  const mod = pick(rng, ['', '', '', '.skip', '.only', '.todo']);
  const each = pick(rng, ['', '', '', '.each([1, 2])', '.each(table)', '.each([[1, (2)]])', '.each(`a`)']);
  const sp = pick(rng, ['', '', ' ', ' ', '\n', '　']);
  const open = pick(rng, ['(', '(', ' (', '( ', '( ']);
  const closeQ = chance(rng, 0.9) ? q : pick(rng, QUOTES);
  const tail = pick(rng, [', () => {', ', async () => {', ', function () {', ', () => {});', ', () => {', '', ')', ", () => { expect('a').toBe('b') });"]);
  switch (between(rng, 0, 16)) {
    case 0: case 1: case 2: return `${pad}describe${mod}${each}${sp}${open}${q}${jsTitle(rng, q)}${closeQ}${tail}`;
    case 3: return `${pad}test.describe${mod}${open}${q}${jsTitle(rng, q)}${closeQ}${tail}`;
    case 4: case 5: case 6: case 7: return `${pad}it${mod}${each}${sp}${open}${q}${jsTitle(rng, q)}${closeQ}${tail}`;
    case 8: case 9: return `${pad}test${mod}${each}${sp}${open}${q}${jsTitle(rng, q)}${closeQ}${tail}`;
    case 10: return `${pad}${pick(rng, ['}', '});', '})', '{', '}, () => {', '{ {', '} }', ''])}`;
    case 11: return `${pad}import { describe, it, expect } from ${pick(rng, ["'vitest'", '"vitest"', "'@playwright/test'", '"@playwright/test"', "'jest'"])};`;
    case 12: return `${pad}const x = ${q}${jsTitle(rng, q)}${q}; ${pick(rng, ['it(', 'test(', 'describe(', 'xit(', 'fit('])}${q}${jsTitle(rng, q)}${closeQ}`;
    case 13: return `${pad}${pick(rng, ['xit', 'fit', 'beforeEach', 'myit', 'it2', 'atest', 'test_', 'subdescribe', 'describe2'])}(${q}${jsTitle(rng, q)}${closeQ}`;
    case 14: return `${pad}// ${pick(rng, ['it', 'test', 'describe'])}(${q}${phrase(rng)}${q}`;
    case 15: return `${pad}foo.${pick(rng, ['it', 'test', 'describe'])}${mod}(${q}${jsTitle(rng, q)}${closeQ}`;
    default: return `${pad}${phrase(rng)}`;
  }
}

function jsContent(rng: Rng): string {
  const count = between(rng, 0, 26);
  const lines: string[] = [];
  if (chance(rng, 0.3)) lines.push(pick(rng, ["import { describe, it } from 'vitest';", "import { test } from '@playwright/test';", 'import "vitest"']));
  for (let n = 0; n < count; n++) lines.push(sprinkle(rng, jsLine(rng), 0.15));
  return joinLines(rng, lines);
}

function pyLine(rng: Rng): string {
  const pad = pick(rng, ['', '', '    ', '        ', '\t', '  ', '  ', '　', ' \t ', '﻿']);
  switch (between(rng, 0, 20)) {
    case 0: case 1: return `${pad}class ${pick(rng, ['Test', 'TestFoo', 'Test_a1', 'Tester', 'testFoo', 'Foo', 'Testé', 'Test한'])}${pick(rng, ['', '(Base):', ':', '() :', '(object)'])}`;
    case 2: case 3: case 4: return `${pad}${pick(rng, ['', 'async '])}def ${pick(rng, ['test_a', 'test_R1_x', 'test_', 'testb', 'test_한', 'helper', 'test_R4_1'])}${pick(rng, ['(self):', '(', ' (self):', ' (x):', ''])}`;
    case 5: return `${pad}@pytest.mark.skip${pick(rng, ['', '(reason="x")'])}`;
    case 6: return `${pad}@pytest.mark.skipif(sys.platform == "win32", reason="w")`;
    case 7: return `${pad}@pytest.mark.parametrize("a", [1, 2])`;
    case 8: return `${pad}@pytest.mark.${pick(rng, ['integration', 'docker', 'slow', 'usefixtures("x")', 'asyncio', 'xfail', 'filterwarnings("ignore")', 'skipper', 'parametrized', 'skip_it', 'R1'])}`;
    case 9: return `${pad}@pytest.mark.integration @pytest.mark.docker`;
    case 10: return `${pad}@pytest.fixture`;
    case 11: return `${pad}# ${phrase(rng)}`;
    case 12: return `${pad}${pick(rng, ['x = 1', 'pass', 'return', 'assert True', ''])}`;
    case 13: return `${pad}@${pick(rng, ['staticmethod', 'pytest.mark', 'pytest.mark.', 'pytest.mark.skip_x'])}`;
    default: return `${pad}${phrase(rng)}`;
  }
}

function pyContent(rng: Rng): string {
  const lines: string[] = [];
  const count = between(rng, 0, 26);
  for (let n = 0; n < count; n++) lines.push(sprinkle(rng, pyLine(rng), 0.15));
  return joinLines(rng, lines);
}

function filePath(rng: Rng): string {
  const dir = pick(rng, ['', 'src/', 'a/b/', '/abs/', 'dir\\win/', '한글/', '😀/', 'x.test/']);
  const base = pick(rng, ['FooTest', 'Foo', 'BarTests', 'OrderIT', 'order.test', 'a.spec', 'x.test', 'test_a', 'a_test', 'test_', 'unit_test', 'conftest', 'my-test', 'IT', 'Test', 'x.spec.d', 'a.b.test']);
  const ext = pick(rng, ['.java', '.kt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cts', '.mts', '.py', '.pyi', '.java\n', '.kt ', '.TS', '.test.ts', '.test.١s', '.rs', '']);
  return sprinkle(rng, dir + base + ext, 0.05);
}

/** 종류에 맞는 이름을 자주 만들어 파서가 실제로 돌게 한다(나머지는 무작위 이름) */
function pathFor(rng: Rng, kind: 'junit' | 'js' | 'py'): string {
  if (chance(rng, 0.25)) return filePath(rng);
  const dir = pick(rng, ['', 'src/', 'a/b/', '한글/']);
  const name =
    kind === 'junit' ? pick(rng, ['FooTest.java', 'BarTests.kt', 'OrderIT.java']) : kind === 'js' ? pick(rng, ['a.test.ts', 'b.spec.tsx', 'c.test.mjs', 'd.spec.js']) : pick(rng, ['test_a.py', 'a_test.py', 'test_x1.py']);
  return dir + name;
}

function contentFor(rng: Rng, kind: 'junit' | 'js' | 'py'): string {
  return kind === 'junit' ? junitContent(rng) : kind === 'js' ? jsContent(rng) : pyContent(rng);
}

const KINDS = ['junit', 'js', 'py'] as const;
const FRAMEWORKS: Array<TestFramework | undefined> = [undefined, undefined, undefined, 'vitest', 'jest', 'playwright', 'junit'];

function text(rng: Rng): string {
  const parts = Array.from({ length: between(rng, 0, 8) }, () => pick(rng, [...WORDS, '\n', ' ', ',', '.', '1', '2.5', ' R3.1 ', 'R1', 'R1.2.3', '(R5)', 'R٠']));
  return sprinkle(rng, parts.join(pick(rng, [' ', '', '\n'])), 0.2);
}

function stringify(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function outcome(fn: () => unknown): string {
  try {
    return stringify(fn());
  } catch (error) {
    return `throws:${(error as Error).constructor.name}`;
  }
}

interface Tally {
  runs: number;
  differ: number;
  /** 결과 분포: 빈 결과, 값 있는 결과, 오류 */
  empty: number;
  valued: number;
  threw: number;
  first: string[];
}

function newTally(): Tally {
  return { runs: 0, differ: 0, empty: 0, valued: 0, threw: 0, first: [] };
}

function isEmptyResult(serialized: string): boolean {
  return serialized === 'undefined' || serialized === '[]' || serialized === 'false' || /^\{"path":"[^]*?","framework":"[a-z]+","suites":\[\],"tests":\[\]\}$/.test(serialized);
}

function compare(tally: Tally, label: string, input: unknown, expected: string, actual: string): void {
  tally.runs++;
  if (expected.startsWith('throws:')) tally.threw++;
  else if (isEmptyResult(expected)) tally.empty++;
  else tally.valued++;
  if (expected !== actual) {
    tally.differ++;
    if (tally.first.length < 3) tally.first.push(`${label}\n입력 ${JSON.stringify(input)}\n옛   ${expected}\n새   ${actual}`);
  }
}

const SEEDS = (process.env['TEST_DISCOVERY_DIFF_SEEDS'] ?? '1,7,42,2026').split(',').map(Number);
const ITERATIONS = Number(process.env['TEST_DISCOVERY_DIFF_ITERATIONS'] ?? 4000);
const REPORT = process.env['TEST_DISCOVERY_DIFF_REPORT'] === '1';

interface Case {
  name: string;
  run: (rng: Rng, tally: Tally) => void;
}

const cases: Case[] = [
  {
    name: 'extractRequirementIds',
    run: (rng, tally) => {
      const input = text(rng);
      compare(tally, 'extractRequirementIds', input, outcome(() => legacy.extractRequirementIds(input)), outcome(() => extractRequirementIds(input)));
    },
  },
  {
    name: 'extractRequirementIdsWithSuites',
    run: (rng, tally) => {
      const path = chance(rng, 0.15) ? undefined : Array.from({ length: between(rng, 0, 4) }, () => text(rng));
      const title = text(rng);
      compare(tally, 'extractRequirementIdsWithSuites', { path, title }, outcome(() => legacy.extractRequirementIdsWithSuites(path, title)), outcome(() => extractRequirementIdsWithSuites(path, title)));
    },
  },
  {
    name: 'discoverJunitFile',
    run: (rng, tally) => {
      const content = junitContent(rng);
      const p = filePath(rng);
      compare(tally, 'discoverJunitFile', { p, content }, outcome(() => legacy.discoverJunitFile(p, content)), outcome(() => discoverJunitFile(p, content)));
    },
  },
  {
    name: 'detectJsFramework',
    run: (rng, tally) => {
      const content = jsContent(rng);
      compare(tally, 'detectJsFramework', content, outcome(() => legacy.detectJsFramework(content)), outcome(() => detectJsFramework(content)));
    },
  },
  {
    name: 'discoverJsFile',
    run: (rng, tally) => {
      const content = jsContent(rng);
      const p = filePath(rng);
      const framework = pick(rng, FRAMEWORKS);
      compare(tally, 'discoverJsFile', { p, content, framework }, outcome(() => legacy.discoverJsFile(p, content, framework)), outcome(() => discoverJsFile(p, content, framework)));
    },
  },
  {
    name: 'discoverPytestFile',
    run: (rng, tally) => {
      const content = pyContent(rng);
      const p = filePath(rng);
      compare(tally, 'discoverPytestFile', { p, content }, outcome(() => legacy.discoverPytestFile(p, content)), outcome(() => discoverPytestFile(p, content)));
    },
  },
  {
    name: 'isTestFilePath',
    run: (rng, tally) => {
      const p = filePath(rng);
      compare(tally, 'isTestFilePath', p, outcome(() => legacy.isTestFilePath(p)), outcome(() => isTestFilePath(p)));
    },
  },
  {
    name: 'discoverTestsInFile',
    run: (rng, tally) => {
      const kind = pick(rng, KINDS);
      const p = pathFor(rng, kind);
      const content = contentFor(rng, kind);
      compare(tally, 'discoverTestsInFile', { p, content }, outcome(() => legacy.discoverTestsInFile(p, content)), outcome(() => discoverTestsInFile(p, content)));
    },
  },
  {
    name: 'flattenDiscoveredFile',
    run: (rng, tally) => {
      const kind = pick(rng, KINDS);
      const content = contentFor(rng, kind);
      const p = pathFor(rng, kind);
      const file = kind === 'junit' ? legacy.discoverJunitFile(p, content) : kind === 'js' ? legacy.discoverJsFile(p, content) : legacy.discoverPytestFile(p, content);
      // 발견 결과를 손으로 바꾼 입력도 섞는다: 테스트의 다른 필드, 빈 envConditionalReasons, 스위트 표시의 id
      const mutated = JSON.parse(JSON.stringify(file)) as typeof file;
      if (chance(rng, 0.4)) {
        const visit = (suite: (typeof file.suites)[number]): void => {
          for (const test of suite.tests) {
            if (chance(rng, 0.3)) (test as unknown as Record<string, unknown>)['extra'] = pick(rng, [1, 'x', null, { a: 1 }]);
            if (chance(rng, 0.2)) test.envConditionalReasons = pick(rng, [[], ['@Tag("a")', '@Tag("a")'], ['@X']]);
            if (chance(rng, 0.2)) test.requirementIds = [...test.requirementIds, 'R9', ...test.requirementIds];
          }
          if (chance(rng, 0.3)) suite.displayName += ` ${pick(rng, ['R1', 'R2.1', '[R3]', 'R1'])}`;
          if (chance(rng, 0.2)) suite.skipped = !suite.skipped;
          if (chance(rng, 0.2)) suite.envConditionalReasons = pick(rng, [['@Tag("p")'], ['@Testcontainers', '@X'], []]);
          suite.suites.forEach(visit);
        };
        mutated.suites.forEach(visit);
      }
      compare(tally, 'flattenDiscoveredFile', mutated, outcome(() => legacy.flattenDiscoveredFile(mutated)), outcome(() => flattenDiscoveredFile(mutated)));
    },
  },
];

describe('차등 시험: 옛 TS 구현과 Rust 껍데기는 같은 입력에 같은 글자를 낸다', () => {
  for (const { name, run } of cases) {
    it(name, () => {
      const total = newTally();
      for (const seed of SEEDS) {
        const rng = mulberry32(seed * 1000 + name.length);
        const tally = newTally();
        for (let n = 0; n < ITERATIONS; n++) run(rng, tally);
        for (const key of ['runs', 'differ', 'empty', 'valued', 'threw'] as const) total[key] += tally[key];
        total.first.push(...tally.first);
        if (REPORT) console.log(`[차등] ${name} 시드 ${seed}: 비교 ${tally.runs}, 다름 ${tally.differ}, 빈 결과 ${tally.empty}, 값 ${tally.valued}, 오류 ${tally.threw}`);
      }
      expect(total.first.join('\n---\n')).toBe('');
      expect(total.differ).toBe(0);
      // 입력이 한쪽으로 쏠리지 않았는지(빈 결과만, 값만 나오지 않았는지)
      if (name !== 'isTestFilePath' && name !== 'extractRequirementIds' && name !== 'extractRequirementIdsWithSuites') {
        expect(total.valued).toBeGreaterThan(total.runs * 0.2);
      }
      if (name !== 'detectJsFramework' && name !== 'isTestFilePath') expect(total.empty).toBeGreaterThan(total.runs * 0.01);
    });
  }

  it('대조 장치: 결과 한 글자만 달라도 잡는다', () => {
    const rng = mulberry32(9);
    const tally = newTally();
    for (let n = 0; n < 200; n++) {
      const content = junitContent(rng);
      const expected = outcome(() => legacy.discoverJunitFile('AT.java', content));
      // 줄 번호를 하나 올려 일부러 다르게 만든 "새 결과"
      const tampered = expected.replace(/"line":(\d+)/, (_m, d: string) => `"line":${Number(d) + 1}`);
      compare(tally, 'tamper', content, expected, tampered);
      // 키 순서만 바꿔도 잡는다
      const reordered = expected.replace('"suites":[],"tests":[]', '"tests":[],"suites":[]');
      compare(tally, 'reorder', content, expected, reordered);
    }
    expect(tally.differ).toBeGreaterThan(20);
  });
});
