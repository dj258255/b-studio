/**
 * 테스트 탭(ADR-084)의 결과 단계 — 실행기가 남긴 보고서(JUnit XML, Vitest/Jest JSON)를 파싱하고,
 * 발견 단계(test-discovery.ts)가 찾은 테스트 케이스와 이어 붙인다.
 *
 * 순수 함수만 둔다(파일 IO·샌드박스 호출 없음) — studio의 서버 쪽 코드가 컨테이너에서 보고서 글자를 읽어 넘긴다.
 * 외부 XML/JSON 파서 라이브러리는 쓰지 않는다(새 의존성 금지) — 보고서 형식이 단순해 가벼운 정규식으로 충분하다.
 */
import type { FlatDiscoveredTest } from './test-discovery';

export type TestStatus = 'pass' | 'fail' | 'skip' | 'not-run';

export interface TestCaseResult {
  status: TestStatus;
  durationMs?: number;
  failureMessage?: string;
  /** 실패 스택의 앞 몇 줄만 */
  stack?: string[];
}

/** 파싱한 보고서 하나의 테스트 케이스 한 건. classOrFile은 매칭에 쓰는 원본 식별자(JUnit classname, Jest/Vitest 파일 경로) */
export interface ParsedTestCase {
  classOrFile: string;
  /** JUnit은 메서드 이름, Jest/Vitest는 ancestorTitles를 포함한 전체 제목 */
  name: string;
  result: TestCaseResult;
}

export interface ParsedTestRun {
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
export function parseJUnitXml(xml: string): ParsedTestRun {
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

function jestLikeStatus(status: string | undefined): TestStatus {
  if (status === 'passed') return 'pass';
  if (status === 'failed') return 'fail';
  if (status === 'skipped' || status === 'pending' || status === 'todo' || status === 'disabled') return 'skip';
  return 'not-run';
}

/** Jest/Vitest json 출력을 공통으로 파싱한다. 형식이 같아 프레임워크를 구분할 필요가 없다 */
export function parseJestLikeJson(json: string): ParsedTestRun {
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
      cases.push({
        classOrFile,
        name: title,
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

export interface TestRow extends FlatDiscoveredTest {
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
export function attachResults(rows: readonly TestRow[], run: ParsedTestRun): TestRow[] {
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
export interface TestCounts {
  pass: number;
  fail: number;
  skip: number;
  notRun: number;
}

export function countByStatus(rows: readonly TestRow[]): TestCounts {
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
export function buildFixTestPrefill(row: Pick<TestRow, 'displayName' | 'file' | 'line' | 'result'>): string {
  const failure = row.result?.failureMessage ? `\n\n실패 메시지:\n${row.result.failureMessage}` : '';
  const stack = row.result?.stack?.length ? `\n\n스택(앞부분):\n${row.result.stack.join('\n')}` : '';
  return `다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: ${row.displayName}\n위치: ${row.file}:${row.line}${failure}${stack}`;
}

/** 요구사항인데 테스트가 없는 항목의 "테스트 추가" 버튼이 채우는 글 */
export function buildAddTestPrefill(requirementId: string, requirementTitle: string): string {
  return `[${requirementId}] ${requirementTitle}\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 ${requirementId}을(를) 넣어 테스트를 추가해 주세요.`;
}
