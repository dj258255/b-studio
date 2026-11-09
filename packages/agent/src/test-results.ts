/**
 * 테스트 탭(ADR-084)의 결과 단계 — 실행기가 남긴 보고서(JUnit XML, Vitest/Jest JSON)를 파싱하고,
 * 발견 단계(test-discovery.ts)가 찾은 테스트 케이스와 이어 붙인다.
 *
 * 순수 함수만 둔다(파일 IO·샌드박스 호출 없음) — studio의 서버 쪽 코드가 컨테이너에서 보고서 글자를 읽어 넘긴다.
 * 외부 XML/JSON 파서 라이브러리는 쓰지 않는다(새 의존성 금지) — 보고서 형식이 단순해 가벼운 정규식으로 충분하다.
 *
 * 판정은 Rust(crates/bstudio-guard/src/test_results.rs, ADR-191 3단계 3d)가 한다. 이 파일은 같은 이름·시그니처의 껍데기와 타입 선언이다.
 */
import { decodeNative, encodeNative, native } from '@b-studio/sandbox';
import type { Requirement } from './requirements';
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
  /**
   * 바깥 → 안쪽 순서의 묶음(describe) 제목들. Jest/Vitest 보고서의 ancestorTitles에서 온다. name에는 it 제목만 있어
   * 묶음 제목에 단 요구사항·시나리오 id가 사라지므로 따로 싣는다(이름을 바꾸면 발견 행과의 짝짓기·화면 표시가 흔들린다).
   * 이 필드가 생기기 전에 저장된 결과와 JUnit XML에는 없다 — 없으면 묶음 정보가 없다는 뜻이다
   */
  suitePath?: string[];
  result: TestCaseResult;
}

export interface ParsedTestRun {
  cases: ParsedTestCase[];
}

/**
 * JUnit XML(Gradle build/test-results/test/*.xml, Maven target/surefire-reports/*.xml, pytest --junitxml)을 파싱한다.
 * `<testsuites>`로 감쌌든 `<testsuite>` 하나든 상관없이 모든 `<testcase>`를 찾는다.
 */
export function parseJUnitXml(xml: string): ParsedTestRun {
  return decodeNative<ParsedTestRun>(native.parseJUnitXml(xml));
}

// ---------------------------------------------------------------------------
// Vitest / Jest JSON. 둘 다 `{ testResults: [{ name, assertionResults: [...] }] }` 모양을 쓴다
// (vitest의 --reporter=json은 jest의 --json과 같은 계통 포맷을 낸다)
// ---------------------------------------------------------------------------

/** Jest/Vitest json 출력을 공통으로 파싱한다. 형식이 같아 프레임워크를 구분할 필요가 없다 */
export function parseJestLikeJson(json: string): ParsedTestRun {
  return decodeNative<ParsedTestRun>(native.parseJestLikeJson(json));
}

// ---------------------------------------------------------------------------
// 발견한 테스트와 파싱한 결과를 잇는다(매칭)
// ---------------------------------------------------------------------------

export interface TestRow extends FlatDiscoveredTest {
  result?: TestCaseResult;
}

/**
 * 발견한 테스트 행(rows)에 파싱한 결과를 붙인다.
 * 우선 (파일 일치 + 이름 일치)로 정확히 맞춰 보고, 못 맞추면 이름만으로 유일하게 맞는 후보를 찾는다(느슨한 매칭).
 * 결과가 없는 행은 result가 없다(화면에서 "not-run"으로 본다).
 */
export function attachResults(rows: readonly TestRow[], run: ParsedTestRun): TestRow[] {
  // 같은 객체가 케이스 목록에 두 번 있으면 하나를 쓴 것이 둘 다 쓴 것이다(옛 코드는 Set으로 객체를 셌다). 객체마다 번호를 매겨 넘긴다
  const identity = new Map<unknown, number>();
  const ids = run.cases.map((testCase) => {
    const known = identity.get(testCase);
    if (known !== undefined) return known;
    identity.set(testCase, identity.size);
    return identity.size - 1;
  });
  const picked = native.attachResults(
    encodeNative(rows.map((row) => ({ name: row.name, displayName: row.displayName, file: row.file, suitePath: row.suitePath }))),
    encodeNative(run.cases.map((testCase) => ({ name: testCase.name, classOrFile: testCase.classOrFile, suitePath: testCase.suitePath }))),
    ids,
  );
  return rows.map((row, index) => {
    const matched = picked[index]!;
    return matched < 0 ? row : { ...row, result: run.cases[matched]!.result };
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
  return JSON.parse(native.countByStatus(JSON.stringify(rows.map((row) => row.result?.status)))) as TestCounts;
}

// ---------------------------------------------------------------------------
// 대화 입력창 채우기(chat-draft-context.tsx가 채우고, 절대 자동으로 보내지 않는다)
// ---------------------------------------------------------------------------

/** 실패한 테스트의 "이 테스트 고쳐 줘" 버튼이 채우는 글 */
export function buildFixTestPrefill(row: Pick<TestRow, 'displayName' | 'file' | 'line' | 'result'>): string {
  return native.buildFixTestPrefill(encodeNative({ displayName: row.displayName, file: row.file, line: row.line, result: row.result }));
}

/**
 * 요구사항인데 테스트가 없는 항목의 "테스트 추가" 버튼이 채우는 글. id·제목만으로는 무엇을 테스트해야 하는지
 * 다시 요구사항 화면을 열어 봐야 했다(버그 리포트 54) — EARS 문장·인수 조건·시나리오(R7.1 같은 id 포함)까지
 * 간결하게 넣어 이 글만 보고 테스트를 쓸 수 있게 한다(requirement-chat-prefill.ts의 "대화에서 묻기"와 같은 모양).
 */
export function buildAddTestPrefill(requirement: Pick<Requirement, 'id' | 'title' | 'acceptance' | 'ears' | 'scenarios'>): string {
  return native.buildAddTestPrefill(
    encodeNative({ id: requirement.id, title: requirement.title, acceptance: requirement.acceptance, ears: requirement.ears, scenarios: requirement.scenarios }),
  );
}
