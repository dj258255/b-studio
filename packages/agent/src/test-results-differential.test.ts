import { describe, expect, it } from 'vitest';
import { Gen, outcome, perturb, readEnvList, readEnvNumber, sameOutcome, type Outcome } from './differential-kit';
import type { Requirement } from './requirements';
import type { FlatDiscoveredTest } from './test-discovery';
import { attachResults, buildAddTestPrefill, buildFixTestPrefill, countByStatus, parseJestLikeJson, parseJUnitXml, type ParsedTestRun, type TestRow } from './test-results';

/**
 * test-results를 Rust로 옮기면서(ADR-191 3d) 옛 TS 구현을 아래 `legacy`에 그대로 두고, 같은 무작위 입력을 옛 구현과 새 껍데기에 넣어
 * 결과를 JSON.stringify 글자(키 순서 포함)와 값(-0·NaN 구별)으로 견준다. `legacy`는 옮기기 전 `test-results.ts`의 본문이다
 * (`import`·`export`만 뗐다). 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * 크기는 환경 변수로 바꾼다: TEST_RESULTS_DIFF_SEEDS(쉼표 목록), TEST_RESULTS_DIFF_ITERATIONS, TEST_RESULTS_DIFF_REPORT=1(분포 출력)
 */
const legacy = (() => {
  /**
   * 테스트 탭(ADR-084)의 결과 단계 — 실행기가 남긴 보고서(JUnit XML, Vitest/Jest JSON)를 파싱하고,
   * 발견 단계(test-discovery.ts)가 찾은 테스트 케이스와 이어 붙인다.
   *
   * 순수 함수만 둔다(파일 IO·샌드박스 호출 없음) — studio의 서버 쪽 코드가 컨테이너에서 보고서 글자를 읽어 넘긴다.
   * 외부 XML/JSON 파서 라이브러리는 쓰지 않는다(새 의존성 금지) — 보고서 형식이 단순해 가벼운 정규식으로 충분하다.
   */

  type TestStatus = 'pass' | 'fail' | 'skip' | 'not-run';

  interface TestCaseResult {
    status: TestStatus;
    durationMs?: number;
    failureMessage?: string;
    /** 실패 스택의 앞 몇 줄만 */
    stack?: string[];
  }

  /** 파싱한 보고서 하나의 테스트 케이스 한 건. classOrFile은 매칭에 쓰는 원본 식별자(JUnit classname, Jest/Vitest 파일 경로) */
  interface ParsedTestCase {
    classOrFile: string;
    /** JUnit은 메서드 이름, Jest/Vitest는 ancestorTitles를 포함한 전체 제목 */
    name: string;
    /**
     * 바깥 → 안쪽 순서의 묶음(describe) 제목들. Jest/Vitest 보고서의 ancestorTitles에서 온다. name에는 it 제목만 있어
     * 묶음 제목에 단 요구사항·시나리오 id가 사라지므로 따로 싣는다(이름을 바꾸면 발견 행과의 짝짓기·화면 표시가 흔들린다).
     * 이 필드가 생기기 전에 저장된 결과와 JUnit XML에는 없다 — 없으면 묶음 정보가 없다는 뜻이다
     */
    suitePath?: string[];
    result: TestCaseResult;
  }

  interface ParsedTestRun {
    cases: ParsedTestCase[];
  }

  const MAX_STACK_LINES = 5;
  const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function decodeXmlEntities(text: string): string {
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code: string) => {
      if (code[0] === '#') {
        const codePoint = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : whole;
      }
      return XML_ENTITIES[code] ?? whole;
    });
  }

  function parseXmlAttrs(raw: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const match of raw.matchAll(/([\w:-]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) attrs[match[1]!] = decodeXmlEntities(match[2]!);
    return attrs;
  }

  /**
   * JUnit XML(Gradle build/test-results/test/*.xml, Maven target/surefire-reports/*.xml, pytest --junitxml)을 파싱한다.
   * `<testsuites>`로 감쌌든 `<testsuite>` 하나든 상관없이 모든 `<testcase>`를 찾는다.
   */
  function parseJUnitXml(xml: string): ParsedTestRun {
    const cases: ParsedTestCase[] = [];
    const testcasePattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    for (const match of xml.matchAll(testcasePattern)) {
      const attrs = parseXmlAttrs(match[1]!);
      const body = match[2];
      const name = attrs.name ?? '';
      const classOrFile = attrs.classname ?? attrs.class ?? '';
      const durationMs = attrs.time !== undefined ? Math.round(Number(attrs.time) * 1000) : undefined;

      let result: TestCaseResult = { status: 'pass', ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}) };
      if (body !== undefined) {
        const skipped = /<skipped\b/.exec(body);
        const failure = /<failure\b([^>]*?)(?:\/>|>([\s\S]*?)<\/failure>)/.exec(body);
        const error = !failure ? /<error\b([^>]*?)(?:\/>|>([\s\S]*?)<\/error>)/.exec(body) : null;
        const problem = failure ?? error;
        if (skipped) {
          result = { status: 'skip', ...(durationMs !== undefined ? { durationMs } : {}) };
        } else if (problem) {
          const problemAttrs = parseXmlAttrs(problem[1] ?? '');
          const text = problem[2] ? decodeXmlEntities(problem[2]).trim() : undefined;
          const failureMessage = problemAttrs.message ?? text?.split('\n')[0];
          const stack = text ? text.split('\n').slice(0, MAX_STACK_LINES) : undefined;
          result = {
            status: 'fail',
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(failureMessage ? { failureMessage } : {}),
            ...(stack && stack.length > 0 ? { stack } : {}),
          };
        }
      }
      cases.push({ classOrFile, name, result });
    }
    return { cases };
  }

  // ---------------------------------------------------------------------------
  // Vitest / Jest JSON. 둘 다 `{ testResults: [{ name, assertionResults: [...] }] }` 모양을 쓴다
  // (vitest의 --reporter=json은 jest의 --json과 같은 계통 포맷을 낸다)
  // ---------------------------------------------------------------------------

  interface JestLikeAssertion {
    ancestorTitles?: string[];
    fullName?: string;
    title?: string;
    status?: string;
    duration?: number | null;
    failureMessages?: string[];
  }

  interface JestLikeFileResult {
    name?: string;
    testFilePath?: string;
    assertionResults?: JestLikeAssertion[];
  }

  interface JestLikeReport {
    testResults?: JestLikeFileResult[];
  }

  /** 보고서 한 건의 묶음 제목들. ancestorTitles가 없는 옛 형식은 fullName이 title로 끝나면 그 앞부분을 묶음 하나로 본다 */
  function jestLikeSuitePath(assertion: JestLikeAssertion): string[] {
    if (Array.isArray(assertion.ancestorTitles)) {
      return assertion.ancestorTitles.filter((title): title is string => typeof title === 'string' && title.trim() !== '');
    }
    const { fullName, title } = assertion;
    if (typeof fullName === 'string' && typeof title === 'string' && title !== '' && fullName.length > title.length && fullName.endsWith(title)) {
      const prefix = fullName.slice(0, fullName.length - title.length).trim();
      if (prefix) return [prefix];
    }
    return [];
  }

  function jestLikeStatus(status: string | undefined): TestStatus {
    if (status === 'passed') return 'pass';
    if (status === 'failed') return 'fail';
    if (status === 'skipped' || status === 'pending' || status === 'todo' || status === 'disabled') return 'skip';
    return 'not-run';
  }

  /** Jest/Vitest json 출력을 공통으로 파싱한다. 형식이 같아 프레임워크를 구분할 필요가 없다 */
  function parseJestLikeJson(json: string): ParsedTestRun {
    let report: JestLikeReport;
    try {
      report = JSON.parse(json) as JestLikeReport;
    } catch {
      return { cases: [] };
    }
    const cases: ParsedTestCase[] = [];
    for (const file of report.testResults ?? []) {
      const classOrFile = file.name ?? file.testFilePath ?? '';
      for (const assertion of file.assertionResults ?? []) {
        const title = assertion.title ?? '';
        const status = jestLikeStatus(assertion.status);
        const durationMs = typeof assertion.duration === 'number' ? Math.round(assertion.duration) : undefined;
        const failureText = assertion.failureMessages?.[0];
        const failureMessage = failureText?.split('\n')[0];
        const stack = failureText ? failureText.split('\n').slice(0, MAX_STACK_LINES) : undefined;
        const suitePath = jestLikeSuitePath(assertion);
        cases.push({
          classOrFile,
          name: title,
          ...(suitePath.length > 0 ? { suitePath } : {}),
          result: {
            status,
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(status === 'fail' && failureMessage ? { failureMessage } : {}),
            ...(status === 'fail' && stack && stack.length > 0 ? { stack } : {}),
          },
        });
      }
    }
    return { cases };
  }

  // ---------------------------------------------------------------------------
  // 발견한 테스트와 파싱한 결과를 잇는다(매칭)
  // ---------------------------------------------------------------------------

  interface TestRow extends FlatDiscoveredTest {
    result?: TestCaseResult;
  }

  function normalizeName(text: string): string {
    return text
      .replace(/\(.*$/, '') // JUnit 메서드 이름의 () 꼬리
      .replace(/\[.*$/, '') // 파라미터화된 테스트의 [1] 같은 꼬리
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  /** 표시 이름 비교용: 앞뒤 공백·연속 공백·대소문자만 맞춘다(괄호는 그대로 둔다) */
  function plainName(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function baseName(filePath: string): string {
    const segment = filePath.split(/[/\\]/).pop() ?? filePath;
    return segment.replace(/\.[^.]+$/, '');
  }

  /**
   * 발견한 테스트 행(rows)에 파싱한 결과를 붙인다.
   * 우선 (파일 일치 + 이름 일치)로 정확히 맞춰 보고, 못 맞추면 이름만으로 유일하게 맞는 후보를 찾는다(느슨한 매칭).
   * 결과가 없는 행은 result가 없다(화면에서 "not-run"으로 본다).
   */
  function attachResults(rows: readonly TestRow[], run: ParsedTestRun): TestRow[] {
    const byNormalizedName = new Map<string, ParsedTestCase[]>();
    // Gradle의 JUnit XML은 @DisplayName이 있으면 testcase name에 메서드 이름 대신 표시 이름("R7: 게시글 목록은 …")을 쓴다.
    // 표시 이름에는 괄호가 흔해 normalizeName(괄호 꼬리 제거)을 쓰지 않고 공백·대소문자만 맞춘 키로 따로 찾는다
    const byPlainName = new Map<string, ParsedTestCase[]>();
    for (const testCase of run.cases) {
      for (const [map, key] of [
        [byNormalizedName, normalizeName(testCase.name)],
        [byPlainName, plainName(testCase.name)],
      ] as const) {
        const list = map.get(key) ?? [];
        list.push(testCase);
        map.set(key, list);
      }
    }

    const used = new Set<ParsedTestCase>();
    const pickFor = (row: TestRow): ParsedTestCase | undefined => {
      const rowKey = normalizeName(row.name);
      let candidates = (byNormalizedName.get(rowKey) ?? []).filter((candidate) => !used.has(candidate));
      if (candidates.length === 0 && row.displayName) {
        candidates = (byPlainName.get(plainName(row.displayName)) ?? []).filter((candidate) => !used.has(candidate));
      }
      if (candidates.length === 0) return undefined;
      if (candidates.length === 1) return candidates[0];
      // 이름이 같은 후보가 여럿이면 classOrFile/suite 경로가 파일 이름이나 스위트 이름을 담고 있는 것을 우선한다
      const fileBase = baseName(row.file).toLowerCase();
      const suiteNames = row.suitePath.map((name) => name.toLowerCase());
      const scored = candidates
        .map((candidate) => {
          const haystack = candidate.classOrFile.toLowerCase();
          let score = 0;
          if (haystack.includes(fileBase)) score += 2;
          for (const suite of suiteNames) if (haystack.includes(suite)) score += 1;
          // 보고서가 묶음 경로를 담고 있으면(Jest/Vitest) 발견 행의 묶음 경로와 같을 때 가장 강하게 친다
          if (candidate.suitePath && candidate.suitePath.length === row.suitePath.length && candidate.suitePath.every((title, index) => plainName(title) === plainName(row.suitePath[index]!))) score += 4;
          return { candidate, score };
        })
        .sort((a, b) => b.score - a.score);
      return scored[0]!.candidate;
    };

    return rows.map((row) => {
      const match = pickFor(row);
      if (!match) return row;
      used.add(match);
      return { ...row, result: match.result };
    });
  }

  /** 화면 요약(통과/실패/건너뜀/안 돌림)에 쓰는 개수 */
  interface TestCounts {
    pass: number;
    fail: number;
    skip: number;
    notRun: number;
  }

  function countByStatus(rows: readonly TestRow[]): TestCounts {
    const counts: TestCounts = { pass: 0, fail: 0, skip: 0, notRun: 0 };
    for (const row of rows) {
      const status = row.result?.status ?? 'not-run';
      if (status === 'pass') counts.pass += 1;
      else if (status === 'fail') counts.fail += 1;
      else if (status === 'skip') counts.skip += 1;
      else counts.notRun += 1;
    }
    return counts;
  }

  // ---------------------------------------------------------------------------
  // 대화 입력창 채우기(chat-draft-context.tsx가 채우고, 절대 자동으로 보내지 않는다)
  // ---------------------------------------------------------------------------

  /** 실패한 테스트의 "이 테스트 고쳐 줘" 버튼이 채우는 글 */
  function buildFixTestPrefill(row: Pick<TestRow, 'displayName' | 'file' | 'line' | 'result'>): string {
    const failure = row.result?.failureMessage ? `\n\n실패 메시지:\n${row.result.failureMessage}` : '';
    const stack = row.result?.stack?.length ? `\n\n스택(앞부분):\n${row.result.stack.join('\n')}` : '';
    return `다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: ${row.displayName}\n위치: ${row.file}:${row.line}${failure}${stack}`;
  }

  /**
   * 요구사항인데 테스트가 없는 항목의 "테스트 추가" 버튼이 채우는 글. id·제목만으로는 무엇을 테스트해야 하는지
   * 다시 요구사항 화면을 열어 봐야 했다(버그 리포트 54) — EARS 문장·인수 조건·시나리오(R7.1 같은 id 포함)까지
   * 간결하게 넣어 이 글만 보고 테스트를 쓸 수 있게 한다(requirement-chat-prefill.ts의 "대화에서 묻기"와 같은 모양).
   */
  function buildAddTestPrefill(requirement: Pick<Requirement, 'id' | 'title' | 'acceptance' | 'ears' | 'scenarios'>): string {
    const lines = [
      `[${requirement.id}] ${requirement.title}`,
      '',
      `이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 ${requirement.id}을(를) 넣어 테스트를 추가해 주세요.`,
    ];
    if (requirement.ears) lines.push('', `EARS: ${requirement.ears.statement}`);
    lines.push('', '인수 조건:', ...requirement.acceptance.map((item) => `- ${item}`));
    if (requirement.scenarios && requirement.scenarios.length > 0) {
      lines.push('', '시나리오:');
      for (const scenario of requirement.scenarios) lines.push(`- ${scenario.id}: (Given) ${scenario.given} (When) ${scenario.when} (Then) ${scenario.then}`);
    }
    return lines.join('\n');
  }

  return { parseJUnitXml, parseJestLikeJson, attachResults, countByStatus, buildFixTestPrefill, buildAddTestPrefill };
})();


const SEEDS = readEnvList('TEST_RESULTS_DIFF_SEEDS', [11, 29, 47]);
const ITERATIONS = readEnvNumber('TEST_RESULTS_DIFF_ITERATIONS', 6000);
const REPORT = process.env.TEST_RESULTS_DIFF_REPORT === '1';

// ---------------------------------------------------------------------------
// 입력 만들기
// ---------------------------------------------------------------------------

const WS = ['\n', '\r', '\r\n', ' ', ' ', '\u0085', ' ', '﻿', '　', '\t', ' ', '​'];
const ODD = ['한글', 'é', '😀', '\ud800', 'ſ', 'K', 'İ', 'Σ', 'ΑΣ', '.', '*', '(', ')', '[', ']', '\\', '"', "'", '`', '$', '{', '}', '^', '|', '?', '+', '<', '>', '/', '&', ';', '=', '-', '_', ':', '#'];
const WORD = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'];

function oddText(gen: Gen, max = 6): string {
  return gen.text([...WORD, ...WORD, ...ODD, ...WS], gen.int(max + 1));
}

const ENTITIES = ['&amp;', '&lt;', '&gt;', '&quot;', '&apos;', '&#65;', '&#x41;', '&#X41;', '&#xD83D;&#xDE00;', '&#xD800;', '&#xDE00;', '&#12ab;', '&#1e3;', '&#abc;', '&unknown;', '&Amp;', '&amp', '& amp;', '&#;', '&#x;', '&#0;', '&#x0;', '&#1114111;', '&#x10FFFF;', '&#10;', '&#13;', '&#xA0;', '&#x2028;', '&#9;', '&&amp;', '&#&amp;;', `&#${'9'.repeat(400)};`, `&#x${'f'.repeat(300)};`, `&#x${'0'.repeat(40)}41;`, '&#00065;', '&#xab;', '&#xAB;'];
/** 던지게 하는 엔티티(코드 포인트가 범위 밖) — 드물게만 넣는다 */
const THROWING_ENTITIES = ['&#1114112;', '&#x110000;', '&#99999999999999999999;', `&#x${'f'.repeat(20)};`, '&#4294967296;', '&#x100000000;'];

function xmlString(gen: Gen): string {
  const parts = gen.list(0, 4, () =>
    gen.weighted<() => string>([
      [5, () => gen.text(WORD, 1 + gen.int(8))],
      [4, () => gen.pick(ENTITIES)],
      [gen.chance(0.04) ? 3 : 0.0001, () => gen.pick(THROWING_ENTITIES)],
      [3, () => oddText(gen, 3)],
      [1, () => gen.pick(['\\"', '\\\\', '\\n', '\\', '\\\n', '\\\r', '\\ ', '\\😀', '\\&amp;'])],
      [1, () => gen.pick(['>', '/>', '</testcase>', '<testcase name="x"/>', '<failure>', '</failure>', '<skipped/>', "'", '"'])],
    ])(),
  );
  return parts.join('');
}

const ATTR_NAMES = ['name', 'name', 'classname', 'classname', 'class', 'time', 'time', 'file', 'message', 'type', '__proto__', 'constructor', 'a:b', 'a-b', 'x.y', 'NAME', 'Name', '_x', '한', 'name2'];
const TIME_VALUES = ['0.5', '1', '0', '0.001', '1.2345', '12.0004', '', ' 2 ', '0x10', 'abc', '-0.0001', '-0', 'Infinity', '-Infinity', '1_0', '.5', '5.', '1e3', '1e999', '0.0004', '0.0005', '0.0006', '2.5e-4', '1.0005', '9007199254740993', ' 3 ', '0b11', '0o7', '+1', '--1', '1 2', 'NaN', '３'];

function attribute(gen: Gen, name?: string): string {
  const key = name ?? gen.pick(ATTR_NAMES);
  const eq = gen.weighted<string>([[10, '='], [2, ' = '], [1, '\n=\n'], [1, ' = '], [1, ' = '], [1, ' =']]);
  const value = key === 'time' && gen.chance(0.85) ? gen.pick(TIME_VALUES) : xmlString(gen);
  const quote = gen.weighted<string>([[14, '"'], [2, "'"], [1, ''], [1, '`']]);
  return `${key}${eq}${quote}${value}${quote}`;
}

function attributes(gen: Gen): string {
  const parts: string[] = [];
  if (gen.chance(0.9)) parts.push(attribute(gen, 'name'));
  if (gen.chance(0.7)) parts.push(attribute(gen, 'classname'));
  if (gen.chance(0.35)) parts.push(attribute(gen, 'time'));
  if (gen.chance(0.2)) parts.push(attribute(gen, 'class'));
  while (gen.chance(0.35)) parts.push(attribute(gen));
  return parts.map((part) => gen.pick(['', ' ', '  ', '\n', '\t', ' ']) + part).join('') + gen.pick(['', ' ', '\n']);
}

function problemBody(gen: Gen): string {
  return gen.weighted<() => string>([
    [2, () => ''],
    [3, () => xmlString(gen)],
    [3, () => gen.list(1, 8, () => `at ${oddText(gen, 5)}(${xmlString(gen)})`).join(gen.pick(['\n', '\n', '\r\n', '\n\n']))],
    [1, () => `\n  ${xmlString(gen)}\n  `],
    [1, () => `<![CDATA[${oddText(gen, 5)}]]>`],
    [1, () => gen.text(WS, 1 + gen.int(4))],
  ])();
}

function problemElement(gen: Gen, tag: 'failure' | 'error'): string {
  const attrs = gen.chance(0.6) ? attribute(gen, 'message') + (gen.chance(0.5) ? ' ' + attribute(gen, 'type') : '') : gen.chance(0.2) ? attribute(gen, 'type') : '';
  const form = gen.weighted<string>([[10, 'normal'], [2, 'self'], [1, 'unclosed'], [1, 'sep'], [1, 'suffix']]);
  if (form === 'self') return `<${tag}${attrs ? ' ' + attrs : ''}/>`;
  if (form === 'unclosed') return `<${tag} ${attrs}>${problemBody(gen)}`;
  if (form === 'sep') return `<${tag}\n${attrs}\n>${problemBody(gen)}</${tag}>`;
  if (form === 'suffix') return `<${tag}s ${attrs}>${problemBody(gen)}</${tag}s>`;
  return `<${tag}${attrs ? ' ' + attrs : ''}>${problemBody(gen)}</${tag}>`;
}

function testcaseBody(gen: Gen): string {
  const pieces: string[] = [];
  const roll = gen.int(100);
  if (roll < 22) pieces.push(gen.pick(['<skipped/>', '<skipped message="x"/>', '<skipped>', '<skipped />', '<skippedx/>', '<skipped-x/>', '<skipped_x/>', '< skipped/>', '<![CDATA[<skipped/>]]>']));
  if (roll >= 15 && roll < 60) pieces.push(problemElement(gen, 'failure'));
  if (roll >= 45 && roll < 70) pieces.push(problemElement(gen, 'error'));
  if (gen.chance(0.3)) pieces.push(`<system-out><![CDATA[${oddText(gen, 6)}]]></system-out>`);
  if (gen.chance(0.1)) pieces.push(gen.pick(['<failure/>', '<error message="e"/>']));
  if (gen.chance(0.25)) pieces.unshift(oddText(gen, 4));
  if (gen.chance(0.3) && pieces.length > 1) pieces.reverse();
  return pieces.join(gen.pick(['', '\n', '\n    ']));
}

function testcase(gen: Gen): string {
  const form = gen.weighted<string>([[8, 'self'], [18, 'body'], [2, 'unclosed'], [1, 'wordglue'], [1, 'dash'], [1, 'empty']]);
  const attrs = attributes(gen);
  if (form === 'self') return `<testcase ${attrs}/>`;
  if (form === 'unclosed') return `<testcase ${attrs}>${testcaseBody(gen)}`;
  if (form === 'wordglue') return gen.pick(['<testcases', '<testcase_x', '<testcase1']) + ` ${attrs}/>`;
  if (form === 'dash') return `<testcase-x ${attrs}/>`;
  if (form === 'empty') return `<testcase ${attrs}></testcase>`;
  return `<testcase ${attrs}>${gen.pick(['', '\n  '])}${testcaseBody(gen)}${gen.pick(['', '\n  '])}</testcase>`;
}

function makeXml(gen: Gen): string {
  const parts: string[] = [];
  if (gen.chance(0.5)) parts.push(gen.pick(['<?xml version="1.0" encoding="UTF-8"?>\n', '﻿<?xml version="1.0"?>', '']));
  if (gen.chance(0.7)) parts.push(gen.pick(['<testsuites>', '<testsuite name="a" tests="2" failures="1">', '<testsuites><testsuite name="a>b">']));
  const count = gen.weighted<number>([[1, 0], [3, 1], [5, 2], [6, 3], [5, 6]]);
  for (let i = 0; i < count; i++) {
    parts.push(gen.pick(['', '\n  ', '\r\n', '<!-- c -->', '<properties><property name="k" value="v"/></properties>', 'noise>']));
    parts.push(testcase(gen));
  }
  if (gen.chance(0.5)) parts.push('</testsuite></testsuites>');
  // 입력의 짝 없는 높은 서로게이트 바로 뒤에 엔티티가 낮은 서로게이트를 만들면 JS는 한 글자로 합치지만 Rust는 경계에서 이미 U+FFFD라 합치지 못한다(의도한 차이)
  const text = parts.join('').replace(/[\ud800-\udbff](?![\udc00-\udfff])(?=&)/g, 'X');
  // 깨진 보고서: 잘리거나 한 글자가 바뀐다
  if (gen.chance(0.08) && text.length > 2) return text.slice(0, gen.int(text.length));
  if (gen.chance(0.04) && text.length > 2) {
    const at = gen.int(text.length);
    return text.slice(0, at) + gen.pick(['>', '<', '"', '/', '\\', '&', ' ']) + text.slice(at + 1);
  }
  return text;
}

// -- Jest/Vitest JSON ---------------------------------------------------------

const RAW = (token: string) => `@@RAW:${token}@@`;

function titleValue(gen: Gen): unknown {
  return gen.weighted<() => unknown>([
    [8, () => gen.pick(['creates an order', 'refunds payment', 'R7: 목록', 'does (x) thing', 'a [1]', 'works', 'It handles ' + oddText(gen, 3)])],
    [3, () => oddText(gen, 5)],
    [1, () => ''],
    [1, () => null],
    [1, () => 5],
    [1, () => ['x']],
  ])();
}

function numberValue(gen: Gen): unknown {
  return gen.weighted<() => unknown>([
    [5, () => gen.int(100)],
    [4, () => Math.round(gen.int(100000)) / 1000 + 0.0004],
    [1, () => -gen.int(100) / 100],
    [1, () => RAW('1e999')],
    [1, () => RAW('-1e999')],
    [1, () => RAW('-0')],
    [1, () => RAW('-0.4')],
    [1, () => RAW('0.5')],
    [1, () => RAW('-0.5')],
    [1, () => RAW('2.5')],
    [1, () => RAW('-2.5')],
    [1, () => RAW('1e21')],
    [1, () => RAW('0.49999999999999994')],
    [1, () => null],
    [1, () => '5'],
    [1, () => true],
  ])();
}

function failureMessagesValue(gen: Gen): unknown {
  if (gen.chance(0.04)) return gen.pick(['oops\nline2', '😀boom', { 0: 'obj\nmsg', 1: 'x' }, 5, [5], [['a']], [{ a: 1 }], null, '', [null], ['']]);
  return gen.weighted<() => unknown>([
    [8, () => gen.list(1, 3, () => gen.list(1, 8, () => `at ${oddText(gen, 4)}`).join(gen.pick(['\n', '\n', '\r\n'])))],
    [2, () => []],
  ])();
}

function assertion(gen: Gen): unknown {
  if (gen.chance(0.008)) return gen.pick([null, 5, 'str', true, [], [1]]);
  const a: Record<string, unknown> = {};
  const status = gen.weighted<unknown>([[6, 'passed'], [4, 'failed'], [2, 'skipped'], [1, 'pending'], [1, 'todo'], [1, 'disabled'], [1, 'Passed'], [1, 'running'], [1, ''], [1, null], [1, 5]]);
  if (gen.chance(0.1)) a.fullName = oddText(gen, 5);
  if (gen.chance(0.97)) a.title = titleValue(gen);
  if (gen.chance(0.9)) a.status = status;
  if (gen.chance(0.7)) a.duration = numberValue(gen);
  if (gen.chance(0.8)) a.failureMessages = failureMessagesValue(gen);
  const mode = gen.int(10);
  if (mode < 5) a.ancestorTitles = gen.list(0, 3, () => gen.weighted<unknown>([[6, gen.pick(['OrderService', 'when cancelled', 'R7.1: x', ' ', '', '  A  '])], [1, 5], [1, null]]));
  else if (mode < 7) {
    const title = typeof a.title === 'string' ? a.title : gen.pick(['t', 'creates', '']);
    a.title ??= title;
    a.fullName = gen.pick(['', ' ', 'A ', 'Outer Inner ', ' X ', '😀 ', 'Σ ', ' \n ']) + (gen.chance(0.8) ? title : title.slice(1));
  } else if (mode === 7) a.ancestorTitles = gen.pick(['A', 5, null, {}]);
  return a;
}

function fileResult(gen: Gen): unknown {
  if (gen.chance(0.015)) return gen.pick([null, 5, 'str', true, []]);
  const f: Record<string, unknown> = {};
  if (gen.chance(0.8)) f.name = gen.weighted<unknown>([[8, gen.pick(['/src/order.test.ts', 'tests/Foo.spec.js', '한글.test.ts', 'a\\b.test.ts'])], [1, ''], [1, null], [1, 5]]);
  if (gen.chance(0.3)) f.testFilePath = gen.pick(['/p/x.test.ts', '', null]);
  const roll = gen.int(100);
  if (roll < 88) f.assertionResults = gen.list(gen.chance(0.1) ? 0 : 1, 4, () => assertion(gen));
  else if (roll < 91) f.assertionResults = gen.pick(['abc', '😀é', '', 5, null, {}, true]);
  return f;
}

function makeJestText(gen: Gen): string {
  const roll = gen.int(100);
  let value: unknown;
  if (roll < 3) value = gen.pick([null, [], 5, 'x', true, {}, { testResults: null }, { testResults: 'ab' }, { testResults: 5 }, { testResults: {} }, { testResults: true }, { testResults: [null] }, { testResults: [5, 'x', true, []] }]);
  else value = { testResults: gen.list(gen.chance(0.08) ? 0 : 1, 3, () => fileResult(gen)), ...(gen.chance(0.3) ? { numTotalTests: 3 } : {}) };
  let text = JSON.stringify(value);
  text = text.replace(/"@@RAW:(.*?)@@"/g, '$1');
  if (gen.chance(0.04)) return gen.pick(['', ' ', '{', '[1,', 'nope', '{"testResults":[}', "{'a':1}", '﻿{}', '{"a":1}x', 'NaN']);
  if (gen.chance(0.04) && text.length > 2) return text.slice(0, gen.int(text.length));
  if (gen.chance(0.03)) return ` \n\t${text}\r\n `;
  if (gen.chance(0.02)) return ` ${text}`;
  return text;
}

// -- attachResults ------------------------------------------------------------

const BASE_NAMES = ['creates an order', 'refunds payment', 'R7: 목록은 보인다', 'handles   spaces', 'does thing', 'x', 'Uppercase Name', 'ΑΣ', 'İstanbul', 'K'];

function nameVariant(gen: Gen, base: string): string {
  return gen.weighted<() => string>([
    [8, () => base],
    [2, () => base.toUpperCase()],
    [2, () => `  ${base}  `],
    [2, () => `${base}()`],
    [2, () => `${base}(int, String)`],
    [2, () => `${base} [1]`],
    [1, () => `${base}(a)\n(b`],
    [1, () => `${base}\n(x)`],
    [1, () => `${base}[x] [y]`],
    [1, () => base.replace(' ', gen.pick(WS))],
    [1, () => base + oddText(gen, 2)],
  ])();
}

const FILE_PATHS = ['src/OrderService.test.ts', 'a/b/OrderServiceTest.java', 'x\\y.spec.js', 'tests/test_orders.py', 'Foo', 'a/.hidden', 'a/b.', '', '한글/주문.test.ts', 'dir/Order.Service.Test.kt', 'a/b/c.d.e', '\\a'];
const CLASS_NAMES = ['com.example.OrderServiceTest', '/src/order.test.ts', 'OrderService', '/p/orderservice.test.ts', 'tests/test_orders.py', 'x', '', '주문', 'a/b/Foo', 'com.example.ORDERSERVICETEST'];
const SUITES = ['OrderService', 'when cancelled', 'R7.1: x', ' order service ', 'ORDERSERVICE', '', 'Σ', 'a  b'];

function makeRows(gen: Gen, baseNames: string[]): TestRow[] {
  return gen.list(0, 6, () => {
    const base = gen.pick(baseNames);
    const row: Record<string, unknown> = {
      name: nameVariant(gen, base),
      file: gen.pick(FILE_PATHS),
      line: gen.int(200),
      suitePath: gen.list(0, 2, () => gen.pick(SUITES)),
      framework: gen.pick(['junit', 'vitest', 'jest', 'pytest']),
    };
    if (gen.chance(0.5)) row.displayName = gen.chance(0.7) ? nameVariant(gen, base) : gen.pick(['', 'R7: 목록은 보인다 (x)', '  creates  AN order ']);
    if (gen.chance(0.1)) row.result = { status: 'pass' };
    return row as unknown as TestRow;
  });
}

function makeCases(gen: Gen, baseNames: string[]): ParsedTestRun {
  const cases: ParsedTestRun['cases'] = gen.list(0, 7, () => {
    const c: Record<string, unknown> = {
      classOrFile: gen.pick(CLASS_NAMES),
      name: nameVariant(gen, gen.pick(baseNames)),
      result: { status: gen.pick(['pass', 'fail', 'skip', 'not-run']), ...(gen.chance(0.3) ? { durationMs: gen.int(500) } : {}) },
    };
    if (gen.chance(0.4)) c.suitePath = gen.chance(0.9) ? gen.list(gen.chance(0.1) ? 0 : 1, 3, () => gen.pick(SUITES)) : gen.pick([[], 'ab', 'xy', 5, null, {}]);
    return c as unknown as ParsedTestRun['cases'][number];
  });
  // 같은 객체가 두 번 나오는 목록
  if (cases.length > 0 && gen.chance(0.12)) cases.push(cases[gen.int(cases.length)]!);
  return { cases };
}

function breakAttachInput(gen: Gen, rows: TestRow[], run: ParsedTestRun): void {
  if (!gen.chance(0.02)) return;
  const row = rows[gen.int(rows.length)] as unknown as Record<string, unknown> | undefined;
  const testCase = run.cases[gen.int(run.cases.length)] as unknown as Record<string, unknown> | undefined;
  const which = gen.int(6);
  if (which === 0 && row) row.name = 5;
  else if (which === 1 && row) delete row.suitePath;
  else if (which === 2 && row) row.file = null;
  else if (which === 3 && testCase) testCase.name = null;
  else if (which === 4 && testCase) testCase.classOrFile = 5;
  else if (which === 5 && row) row.displayName = 5;
}

// -- 입력창 채우기 ------------------------------------------------------------

function scalar(gen: Gen): unknown {
  return gen.weighted<() => unknown>([
    [8, () => oddText(gen, 8)],
    [3, () => gen.pick(['', 'Order', 'src/a.test.ts', 'R7: 목록'])],
    [2, () => gen.int(500)],
    [1, () => Number.NaN],
    [1, () => Number.POSITIVE_INFINITY],
    [1, () => -0],
    [1, () => 1e21],
    [1, () => 0.1 + 0.2],
    [1, () => 1e-7],
    [1, () => 123456789012345680000],
    [1, () => null],
    [1, () => true],
    [1, () => undefined],
    [1, () => ['a', null, 'b']],
    [1, () => ({ k: 1 })],
  ])();
}

function makeFixRow(gen: Gen): Pick<TestRow, 'displayName' | 'file' | 'line' | 'result'> {
  const result = gen.weighted<() => unknown>([
    [4, () => undefined],
    [1, () => null],
    [14, () => ({ status: 'fail', ...(gen.chance(0.8) ? { failureMessage: scalar(gen) } : {}), ...(gen.chance(0.8) ? { stack: stackValue(gen) } : {}) })],
    [1, () => 'str'],
    [1, () => 5],
  ])();
  return { displayName: scalar(gen), file: scalar(gen), line: scalar(gen), result } as unknown as Pick<TestRow, 'displayName' | 'file' | 'line' | 'result'>;
}

function stackValue(gen: Gen): unknown {
  return gen.weighted<() => unknown>([
    [6, () => gen.list(1, 5, () => oddText(gen, 5))],
    [2, () => []],
    [1, () => [null, 'a', undefined, 5]],
    [1, () => [['x', 'y'], { a: 1 }]],
    [1, () => 'text'],
    [1, () => ''],
    [1, () => 5],
    [1, () => null],
    [1, () => ({ length: 2 })],
    [1, () => ({ length: 0 })],
    [1, () => true],
  ])();
}

function makeRequirement(gen: Gen): Pick<Requirement, 'id' | 'title' | 'acceptance' | 'ears' | 'scenarios'> {
  const scenario = (): unknown =>
    gen.chance(0.04)
      ? gen.pick([null, 'x', 5])
      : { id: gen.pick(['R1.1', 'R12.3', undefined, 5]), ...(gen.chance(0.9) ? { given: scalar(gen) } : {}), when: scalar(gen), ...(gen.chance(0.9) ? { then: scalar(gen) } : {}), extra: 1 };
  // 배열 안의 undefined는 JSON 경계에서 null이 된다(의도한 차이) — 인수 조건 항목에는 넣지 않는다
  const acceptance = gen.weighted<unknown>([[60, gen.list(0, 4, () => scalar(gen) ?? 'x')], [1, 'text'], [1, undefined], [1, {}], [1, null]]);
  const ears = gen.weighted<() => unknown>([[4, () => undefined], [4, () => ({ statement: scalar(gen), pattern: 'event' })], [1, () => ({})], [1, () => 'str'], [1, () => 0], [1, () => null], [1, () => []]])();
  const scenarios = gen.weighted<() => unknown>([
    [4, () => undefined],
    [1, () => []],
    [8, () => gen.list(1, 3, scenario)],
    [1, () => 'ab'],
    [1, () => ''],
    [1, () => ({ length: 2 })],
    [1, () => ({ length: 0 })],
    [1, () => 5],
    [1, () => null],
  ])();
  return { id: gen.pick(['R1', 'R12', 'R7.1', 5, undefined]), title: scalar(gen), acceptance, ears, scenarios } as unknown as Pick<Requirement, 'id' | 'title' | 'acceptance' | 'ears' | 'scenarios'>;
}

// ---------------------------------------------------------------------------
// 견주기
// ---------------------------------------------------------------------------

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

function compare(stats: Stats, legacyRun: () => unknown, currentRun: () => unknown, classify: (value: unknown) => string, show: () => string): void {
  const expected = outcome(legacyRun);
  const actual = outcome(currentRun);
  stats.total += 1;
  const kind = (expected as Outcome).threw ? 'threw' : classify((expected as { value: unknown }).value);
  stats.kinds.set(kind, (stats.kinds.get(kind) ?? 0) + 1);
  if (!sameOutcome(expected, actual)) {
    stats.mismatches += 1;
    if (stats.mismatches <= 3) console.error(`불일치 ${show()}\n  옛: ${JSON.stringify(expected)}\n  새: ${JSON.stringify(actual)}`);
  }
  if (!actual.threw && stats.total % 5 === 0) {
    stats.controlTried += 1;
    if (!sameOutcome(expected, { threw: false, value: perturb(actual.value) })) stats.controlCaught += 1;
  }
}

function finish(name: string, stats: Stats, minShare: Record<string, number>): void {
  const distribution = [...stats.kinds.entries()].sort().map(([kind, count]) => `${kind} ${count}`).join(', ');
  if (REPORT) console.log(`[${name}] 비교 ${stats.total}, 다른 결과 ${stats.mismatches}, 분포: ${distribution}, 대조 장치 ${stats.controlCaught}/${stats.controlTried}`);
  expect(stats.mismatches).toBe(0);
  expect(stats.controlCaught).toBe(stats.controlTried);
  for (const [kind, share] of Object.entries(minShare)) expect(stats.kinds.get(kind) ?? 0, `${name}의 ${kind} 비율`).toBeGreaterThanOrEqual(stats.total * share);
}

function runKind(value: unknown): string {
  const cases = (value as ParsedTestRun).cases;
  if (cases.length === 0) return 'empty';
  const statuses = new Set(cases.map((c) => c.result.status));
  const parts = [statuses.has('fail') ? 'fail' : '', statuses.has('skip') ? 'skip' : '', statuses.has('pass') ? 'pass' : '', statuses.has('not-run') ? 'not-run' : ''].filter(Boolean);
  return parts.length > 1 ? 'mixed' : `only-${parts[0]}`;
}

describe('test-results 차등 시험(옛 TS와 Rust 껍데기)', () => {
  for (const seed of SEEDS) {
    it(`시드 ${seed}: 입력 ${ITERATIONS}개씩 모든 함수의 결과가 글자까지 같다`, () => {
      const gen = new Gen(seed);
      const junit = newStats();
      const jest = newStats();
      const attach = newStats();
      const counts = newStats();
      const fix = newStats();
      const add = newStats();
      const extraKinds = new Map<string, number>();
      const bump = (key: string) => extraKinds.set(key, (extraKinds.get(key) ?? 0) + 1);
      for (let i = 0; i < ITERATIONS; i++) {
        const xml = makeXml(gen);
        compare(junit, () => legacy.parseJUnitXml(xml), () => parseJUnitXml(xml), runKind, () => JSON.stringify(xml));
        const jsonText = makeJestText(gen);
        compare(jest, () => legacy.parseJestLikeJson(jsonText), () => parseJestLikeJson(jsonText), runKind, () => JSON.stringify(jsonText));

        const baseNames = gen.list(1, 4, () => gen.pick(BASE_NAMES));
        const rows = makeRows(gen, baseNames);
        const run = makeCases(gen, baseNames);
        breakAttachInput(gen, rows, run);
        compare(
          attach,
          () => legacy.attachResults(rows, run),
          () => attachResults(rows, run),
          (value) => {
            const matched = (value as TestRow[]).filter((row, index) => row !== rows[index] || (rows[index] as TestRow).result !== undefined).length;
            const withResult = (value as TestRow[]).filter((row) => row.result !== undefined).length;
            if (rows.length === 0) return 'no-rows';
            if (withResult === 0) return 'none-attached';
            if (matched === rows.length && withResult === rows.length) return 'all-attached';
            return 'some-attached';
          },
          () => JSON.stringify({ rows, run }),
        );
        // 이름이 같은 후보가 여러 개인 경우를 따로 센다
        const names = new Map<string, number>();
        for (const testCase of run.cases) names.set(String(testCase.name).replace(/\(.*$/, '').trim().toLowerCase(), (names.get(String(testCase.name).replace(/\(.*$/, '').trim().toLowerCase()) ?? 0) + 1);
        if ([...names.values()].some((count) => count > 1)) bump('attach-duplicate-names');

        const statusRows = gen.list(0, 6, () => {
          const roll = gen.int(12);
          if (roll === 0) return {} as TestRow;
          if (roll === 1) return { result: null } as unknown as TestRow;
          if (roll === 2) return { result: { status: gen.pick(['weird', 5, null, 'PASS', '']) } } as unknown as TestRow;
          return { result: { status: gen.pick(['pass', 'fail', 'skip', 'not-run']) } } as TestRow;
        });
        compare(counts, () => legacy.countByStatus(statusRows), () => countByStatus(statusRows), (v) => ((v as { notRun: number }).notRun === statusRows.length ? (statusRows.length === 0 ? 'empty' : 'all-notRun') : 'mixed'), () => JSON.stringify(statusRows));

        const fixRow = makeFixRow(gen);
        compare(fix, () => legacy.buildFixTestPrefill(fixRow), () => buildFixTestPrefill(fixRow), (v) => `${(v as string).includes('실패 메시지') ? 'msg' : 'nomsg'}-${(v as string).includes('스택(앞부분)') ? 'stack' : 'nostack'}`, () => JSON.stringify(fixRow));
        const requirement = makeRequirement(gen);
        compare(add, () => legacy.buildAddTestPrefill(requirement), () => buildAddTestPrefill(requirement), (v) => `${(v as string).includes('EARS:') ? 'ears' : 'noears'}-${(v as string).includes('시나리오:') ? 'scn' : 'noscn'}`, () => JSON.stringify(requirement));
      }
      if (REPORT) console.log(`[attach 보조] ${[...extraKinds.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`);
      finish('parseJUnitXml', junit, { empty: 0.03, 'only-pass': 0.05, 'only-fail': 0.05, 'only-skip': 0.02, mixed: 0.15, threw: 0.003 });
      finish('parseJestLikeJson', jest, { empty: 0.05, 'only-pass': 0.02, 'only-fail': 0.008, 'only-skip': 0.01, mixed: 0.3, threw: 0.01 });
      finish('attachResults', attach, { 'no-rows': 0.03, 'none-attached': 0.03, 'all-attached': 0.05, 'some-attached': 0.15, threw: 0.005 });
      finish('countByStatus', counts, { empty: 0.03, mixed: 0.5 });
      finish('buildFixTestPrefill', fix, { 'msg-stack': 0.1, 'nomsg-nostack': 0.05, 'msg-nostack': 0.03, 'nomsg-stack': 0.03, threw: 0.01 });
      finish('buildAddTestPrefill', add, { 'ears-scn': 0.1, 'noears-noscn': 0.05, 'ears-noscn': 0.03, 'noears-scn': 0.03, threw: 0.02 });
      expect(extraKinds.get('attach-duplicate-names') ?? 0).toBeGreaterThan(ITERATIONS * 0.3);
    });
  }

  it('대조 장치: 결과를 조금 바꾸면 차이로 잡히고, -0과 NaN도 구별한다', () => {
    const expected = outcome(() => legacy.parseJUnitXml('<testcase name="a" time="-0.0001"><skipped/></testcase>'));
    const actual = outcome(() => parseJUnitXml('<testcase name="a" time="-0.0001"><skipped/></testcase>'));
    expect(sameOutcome(expected, actual)).toBe(true);
    expect(Object.is(((actual as { value: ParsedTestRun }).value.cases[0]!.result.durationMs), -0)).toBe(true);
    expect(sameOutcome(expected, { threw: false, value: perturb((actual as { value: unknown }).value) })).toBe(false);
    const nan = outcome(() => parseJUnitXml('<testcase name="a" time="x"><skipped/></testcase>'));
    expect(Number.isNaN((nan as { value: ParsedTestRun }).value.cases[0]!.result.durationMs)).toBe(true);
    expect(sameOutcome(outcome(() => legacy.parseJUnitXml('<testcase name="a" time="x"><skipped/></testcase>')), nan)).toBe(true);
    expect(sameOutcome({ threw: false, value: { n: 0 } }, { threw: false, value: { n: -0 } })).toBe(false);
  });
});

