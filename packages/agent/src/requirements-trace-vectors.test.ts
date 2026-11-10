import { describe, expect, it } from 'vitest';
import * as old from './requirements-legacy';
import * as cur from './requirements';

/**
 * 추적표·시험 파일 훑기 벡터(ADR-191 3단계 3z). `out`은 새 구현이 내야 할 값이고, `intended`가 아닌 벡터는 옛 TS(requirements-legacy.ts)가 낸 값과 같다.
 * 옛 TS에 돌리면 `intended`가 붙은 벡터(옛 TS가 열린 쪽으로 틀린 자리를 닫은 것)만 실패해야 한다.
 *
 * 경계를 밟는다 — 접두 일치(R1과 R10), 시나리오 언급(R1.2가 R1을 다룬다), 대소문자(r1), 보이지 않는 글자(R​1), 전각 숫자, 범위 표기(R1~R3),
 * 낱말에 붙은 id(xR1·R1x), 묶음 제목의 id, 같은 이름 합침, 메서드 이름(testR1Login·r1_login·testR31ThenR1·calculatesOrder2Total·checkERROR3), 빈 id,
 * 따옴표 처리(이스케이프된 따옴표·닫히지 않은 따옴표·백틱 여러 줄·it.only·it.each), 추적표(검증됨·실패·시나리오 남음·사람 확인·문서 확인·테스트 없는 필수·실행 결과 붙이기).
 * 의도한 차이(`intended`): 메서드 이름 가운데의 `r2`가 R2를 다루는 것으로 읽던 것(`calculatesOrder2Total`·`testServer3`·`checkERROR3`)과 빈 id·`R`+숫자 꼴이 아닌 id가 모든 메서드를 다루는 것으로 읽던 것.
 */
type Mod = typeof old;
interface Vector {
  name: string;
  call: string;
  args: unknown[];
  out: unknown;
  intended?: boolean;
}

interface F {
  path: string;
  content: string;
}
const ts = (content: string, path = 'a.test.ts'): F => ({ path, content });
const java = (body: string, path = 'AT.java'): F => ({ path: path === 'AT.java' ? 'OrderTest.java' : path, content: `class OrderTest {\n${body}\n}\n` });
const hit = (file: string, ...names: string[]) => names.map((name) => ({ file, name }));

const CALLS: Record<string, (m: Mod, ...a: any[]) => unknown> = {
  scanReq: (m, files, id) => m.scanTestFilesForRequirementId(files, id),
  scanScenario: (m, files, id) => m.scanTestFilesForScenarioId(files, id),
  scanOrphans: (m, files) => m.scanTestFilesForOrphans(files),
  scenarioEvidence: (m, params) => m.buildScenarioEvidence(params),
  unverified: (m, requirement, checkpoints, files, gateChecks, rows, parent) => m.findUnverifiedScenarioIds(requirement, checkpoints, files, gateChecks, rows, parent),
  matrix: (m, input) => m.buildTraceabilityMatrix(input),
};

const cp = (message: string, createdAt?: string) => ({ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', message, ...(createdAt ? { createdAt } : {}) });
const gate = (name: string, ok = true) => ({ name, ok });
const run = (id: string, name: string, status: string, extra: Record<string, unknown> = {}) => ({ id, file: 'a.test.ts', name, status, at: '2026-06-01T00:00:00.000Z', sha: 'b'.repeat(40), shortSha: 'bbbbbbb', ...extra });
const req = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `${id} 제목`, kind: 'api', priority: 'must', acceptance: ['동작한다'], ...extra });
const scenario = (id: string) => ({ id, given: 'g', when: 'w', then: 't' });

const A = 'a.test.ts';
const J = 'OrderTest.java';

const VECTORS: Vector[] = [
  // ── 요구사항 id 훑기: 접두·시나리오·대소문자·보이지 않는 글자
  { name: '정확히 같다', call: 'scanReq', args: [[ts("it('R1 로그인', () => {});")], 'R1'], out: hit(A, 'R1 로그인') },
  { name: 'R1은 R10의 시험을 근거로 삼지 않는다', call: 'scanReq', args: [[ts("it('R10 로그인', () => {});")], 'R1'], out: [] },
  { name: 'R10은 R1의 시험을 근거로 삼지 않는다', call: 'scanReq', args: [[ts("it('R1 로그인', () => {});")], 'R10'], out: [] },
  { name: 'R1은 R12·R100을 근거로 삼지 않는다', call: 'scanReq', args: [[ts("it('R12 a', () => {});\nit('R100 b', () => {});")], 'R1'], out: [] },
  { name: '시나리오 언급 R1.2는 R1을 다룬다', call: 'scanReq', args: [[ts("it('R1.2 담는다', () => {});")], 'R1'], out: hit(A, 'R1.2 담는다') },
  { name: 'R1.2는 R1.20을 근거로 삼지 않는다', call: 'scanReq', args: [[ts("it('R1.20 x', () => {});")], 'R1.2'], out: [] },
  { name: '소문자 r1은 이름에서 id가 아니다', call: 'scanReq', args: [[ts("it('r1 로그인', () => {});")], 'R1'], out: [] },
  { name: '글자 사이의 너비 없는 공백은 id를 끊는다', call: 'scanReq', args: [[ts("it('R​1 로그인', () => {});")], 'R1'], out: [] },
  { name: '전각 숫자는 id가 아니다', call: 'scanReq', args: [[ts("it('R１ 로그인', () => {});")], 'R1'], out: [] },
  { name: '낱말에 붙은 xR1은 id가 아니다', call: 'scanReq', args: [[ts("it('xR1 로그인', () => {});")], 'R1'], out: [] },
  { name: 'R1x는 id가 아니다', call: 'scanReq', args: [[ts("it('R1x 로그인', () => {});")], 'R1'], out: [] },
  { name: '범위 표기 R1~R3는 개별 언급이 아니다', call: 'scanReq', args: [[ts("it('R1~R3 묶음', () => {});")], 'R1'], out: [] },
  { name: '범위 표기 밖의 R1은 센다', call: 'scanReq', args: [[ts("it('R1~R3 와 R1', () => {});")], 'R1'], out: hit(A, 'R1~R3 와 R1') },
  { name: '시험 파일이 아니면 훑지 않는다', call: 'scanReq', args: [[ts("it('R1 x', () => {});", 'a.ts')], 'R1'], out: [] },
  { name: '파일마다 이름이 같으면 한 번씩', call: 'scanReq', args: [[ts("it('R1 a', () => {});\nit('R1 a', () => {});")], 'R1'], out: hit(A, 'R1 a') },
  { name: '앞뒤 공백은 다듬는다', call: 'scanReq', args: [[ts("it('  R1 a  ', () => {});")], 'R1'], out: hit(A, 'R1 a') },
  { name: '빈 이름은 건너뛴다', call: 'scanReq', args: [[ts("it('   ', () => {});\nit('R1 b', () => {});")], 'R1'], out: hit(A, 'R1 b') },
  // ── 묶음 제목의 id, 같은 이름 합침
  { name: '묶음 제목의 id는 안의 시험의 id다', call: 'scanReq', args: [[ts("describe('R1 로그인', () => {\n  it('works', () => {});\n});")], 'R1'], out: hit(A, 'works') },
  { name: '묶음 제목의 id는 다른 요구사항에 닿지 않는다', call: 'scanReq', args: [[ts("describe('R1 로그인', () => {\n  it('works', () => {});\n});")], 'R2'], out: [] },
  { name: '묶음 밖의 시험은 묶음 제목의 id를 받지 않는다', call: 'scanReq', args: [[ts("describe('R1 로그인', () => {\n  it('works', () => {});\n});\nit('other', () => {});")], 'R1'], out: hit(A, 'works') },
  { name: '같은 이름의 시험이 다른 묶음에 있으면 id를 합친다', call: 'scanReq', args: [[ts("describe('R1', () => {\n  it('works', () => {});\n});\ndescribe('R2', () => {\n  it('works', () => {});\n});")], 'R2'], out: hit(A, 'works') },
  { name: '묶음 제목이 범위 표기면 id가 없다', call: 'scanReq', args: [[ts("describe('R1~R3 묶음', () => {\n  it('works', () => {});\n});")], 'R1'], out: [] },
  { name: '자바 클래스 이름의 id는 안의 시험의 id다', call: 'scanReq', args: [[{ path: 'R2Test.java', content: 'class R2Test {\n  @Test void plain() {}\n}\n' }], 'R2'], out: [] },
  { name: '자바 @DisplayName', call: 'scanReq', args: [[java('  @Test\n  @DisplayName("R1 담는다")\n  void adds() {}')], 'R1'], out: hit(J, 'R1 담는다') },
  { name: '자바 @Nested 묶음 제목의 id', call: 'scanReq', args: [[java('  @Nested\n  @DisplayName("R3 주문")\n  class Flow {\n    @Test\n    @DisplayName("담는다")\n    void adds() {}\n  }')], 'R3'], out: hit(J, 'R3 주문', '담는다') },
  { name: '자바 @DisplayName은 괄호가 있어야 한다', call: 'scanReq', args: [[java('  @Test\n  @DisplayName "R1 담는다"\n  void adds() {}')], 'R1'], out: [] },
  // ── 따옴표
  { name: '이스케이프된 따옴표는 이름 안이다', call: 'scanReq', args: [[ts("it('R1 it\\'s', () => {});")], 'R1'], out: hit(A, "R1 it\\'s") },
  { name: '닫히지 않은 따옴표는 이름이 아니다', call: 'scanReq', args: [[ts("it('R1 x, () => {});")], 'R1'], out: [] },
  { name: '뒤에 따옴표가 없으면 백슬래시 하나만 먹는다', call: 'scanReq', args: [[ts("it('R1 a\\')")], 'R1'], out: hit(A, 'R1 a\\') },
  { name: '백틱 이름은 여러 줄이다', call: 'scanReq', args: [[ts('test(`R1 a\nb`, () => {});')], 'R1'], out: hit(A, 'R1 a\nb') },
  { name: 'it.only와 test.skip', call: 'scanReq', args: [[ts("it.only('R1 a', () => {});\ntest.skip('R1 b', () => {});")], 'R1'], out: hit(A, 'R1 a', 'R1 b') },
  { name: 'it.each는 이름 따옴표가 바로 오지 않아 훑지 않는다', call: 'scanReq', args: [[ts("it.each([1])('R1 a %s', () => {});")], 'R1'], out: [] },
  { name: '낱말 가운데의 it(은 호출이 아니다', call: 'scanReq', args: [[ts("split('R1 a');\nbenefit('R1 b');")], 'R1'], out: [] },
  { name: '큰따옴표·백틱 섞어 쓰기', call: 'scanReq', args: [[ts('it("R1 a", () => {});\nit(`R1 b`, () => {});')], 'R1'], out: hit(A, 'R1 a', 'R1 b') },
  // ── 메서드 이름
  { name: '메서드 testR1Login', call: 'scanReq', args: [[java('  @Test\n  void testR1Login() {}')], 'R1'], out: hit(J, 'testR1Login') },
  { name: '메서드 R10은 R1이 아니다', call: 'scanReq', args: [[java('  @Test\n  void testR10Login() {}')], 'R1'], out: [] },
  { name: '메서드 r1_login(맨 앞 소문자)', call: 'scanReq', args: [[java('  @Test\n  void r1_login() {}')], 'R1'], out: hit(J, 'r1_login') },
  { name: '메서드 test_r1_login(밑줄 뒤 소문자)', call: 'scanReq', args: [[java('  @Test\n  void test_r1_login() {}')], 'R1'], out: hit(J, 'test_r1_login') },
  { name: '메서드 안 처음 나온 자리가 R31이면 뒤의 R3은 보지 않는다', call: 'scanReq', args: [[java('  @Test\n  void testR31ThenR3() {}')], 'R3'], out: [] },
  { name: '메서드 testR3Logout(R31과 같은 파일)', call: 'scanReq', args: [[java('  @Test\n  void testR31Login() {}\n  @Test\n  void testR3Logout() {}')], 'R3'], out: hit(J, 'testR3Logout') },
  { name: '메서드 이름의 소문자 id 인자도 대소문자를 무시한다', call: 'scanReq', args: [[java('  @Test\n  void testR3Login() {}')], 'r3'], out: hit(J, 'testR3Login') },
  { name: '메서드 calculatesOrder2Total은 R2가 아니다', call: 'scanReq', args: [[java('  @Test\n  void calculatesOrder2Total() {}')], 'R2'], out: [], intended: true },
  { name: '메서드 testServer3은 R3이 아니다', call: 'scanReq', args: [[java('  @Test\n  void testServer3() {}')], 'R3'], out: [], intended: true },
  { name: '메서드 checkERROR3은 R3이 아니다', call: 'scanReq', args: [[java('  @Test\n  void checkERROR3() {}')], 'R3'], out: [], intended: true },
  { name: '메서드 안의 대문자 R(낱말 시작)은 센다', call: 'scanReq', args: [[java('  @Test\n  void validateOrderR2Total() {}')], 'R2'], out: hit(J, 'validateOrderR2Total') },
  { name: '빈 id는 아무 메서드도 다루지 않는다', call: 'scanReq', args: [[java('  @Test\n  void testR1Login() {}')], ''], out: [], intended: true },
  { name: '"R"만 있는 id는 아무 메서드도 다루지 않는다', call: 'scanReq', args: [[java('  @Test\n  void testOrder2() {}')], 'R'], out: [], intended: true },
  { name: '"R"만 있는 id는 낱말 시작의 r도 다루지 않는다', call: 'scanReq', args: [[java('  @Test\n  void RotateR2() {}')], 'R'], out: [], intended: true },
  { name: '시나리오 꼴 id는 메서드 이름에 없다', call: 'scanReq', args: [[java('  @Test\n  void testR1Login() {}')], 'R1.2'], out: [] },
  { name: '메서드는 public·private·protected 뒤에서도 찾는다', call: 'scanReq', args: [[java('  public void testR1A() {}\n  private void testR1B() {}\n  protected Optional<Foo> testR1C() {}')], 'R1'], out: hit(J, 'testR1A', 'testR1B', 'testR1C') },
  { name: '메서드 이름 뒤에 괄호가 없으면 훑지 않는다', call: 'scanReq', args: [[java('  public void testR1A;')], 'R1'], out: [] },
  { name: '이름과 메서드가 같은 이름이면 한 번만', call: 'scanReq', args: [[java('  @DisplayName("R1x")\n  @Test void a() {}\n  @DisplayName("testR1A")\n  @Test void testR1A() {}')], 'R1'], out: hit(J, 'testR1A') },
  // ── 시나리오 id 훑기
  { name: '시나리오 id를 정확히 언급한 시험', call: 'scanScenario', args: [[ts("it('R1.2 x', () => {});\nit('R1.20 y', () => {});\nit('R1 z', () => {});")], 'R1.2'], out: hit(A, 'R1.2 x') },
  { name: '시나리오 훑기는 묶음 제목의 id도 받는다', call: 'scanScenario', args: [[ts("describe('R1.2 묶음', () => {\n  it('works', () => {});\n});")], 'R1.2'], out: hit(A, 'works') },
  { name: '시나리오 id R1.2는 R1을 찾지 않는다', call: 'scanScenario', args: [[ts("it('R1 z', () => {});")], 'R1.2'], out: [] },
  // ── 주인 없는 시험
  { name: '주인 없는 시험', call: 'scanOrphans', args: [[ts("it('plain', () => {});\nit('R1 owned', () => {});\nit('R1~R3 range', () => {});")]], out: hit(A, 'plain', 'R1~R3 range') },
  { name: '묶음 제목의 id가 주인이다', call: 'scanOrphans', args: [[ts("describe('R1', () => {\n  it('works', () => {});\n});")]], out: [] },
  { name: '시험 파일이 아니면 주인 없는 시험도 없다', call: 'scanOrphans', args: [[ts("it('plain', () => {});", 'a.ts')]], out: [] },
  // ── 시나리오 증거
  {
    name: '시나리오 증거: 이 시나리오의 체크포인트·시험·게이트·실행만 센다',
    call: 'scenarioEvidence',
    args: [
      {
        scenarioId: 'R1.1',
        checkpoints: [cp('R1.1 저장', '2026-06-02T00:00:00.000Z'), cp('R1 저장'), cp('R1.10 다른')],
        testFiles: [ts("it('R1.1 x', () => {});\nit('R1 y', () => {});")],
        gateChecks: [gate('R1.1 게이트'), gate('R1.2 게이트')],
        testRunRows: [run('R1.1', 'R1.1 x', 'pass'), run('R1.1', 'R1.1 x', 'fail', { at: '2026-06-03T00:00:00.000Z' }), run('R1.1', 'z', 'skip'), run('R1', 'R1 y', 'pass')],
      },
    ],
    out: {
      checkpoints: [cp('R1.1 저장', '2026-06-02T00:00:00.000Z')],
      tests: hit(A, 'R1.1 x'),
      gateChecks: [gate('R1.1 게이트')],
      testRun: { at: '2026-06-03T00:00:00.000Z', sha: 'b'.repeat(40), shortSha: 'bbbbbbb', passed: 1, failed: 1 },
    },
  },
  {
    name: '시나리오 증거: 첫 행이 skip이어도 sha는 첫 행 것',
    call: 'scenarioEvidence',
    args: [{ scenarioId: 'R1.1', checkpoints: [], testFiles: [], gateChecks: [], testRunRows: [run('R1.1', 'a', 'skip', { sha: 'c'.repeat(40), shortSha: 'ccccccc' }), run('R1.1', 'b', 'pass')] }],
    out: { checkpoints: [], tests: [], gateChecks: [], testRun: { at: '2026-06-01T00:00:00.000Z', sha: 'c'.repeat(40), shortSha: 'ccccccc', passed: 1, failed: 0 } },
  },
  {
    name: '시나리오 증거: 통과·실패가 없으면 testRun이 없다',
    call: 'scenarioEvidence',
    args: [{ scenarioId: 'R1.1', checkpoints: [], testFiles: [], gateChecks: [], testRunRows: [run('R1.1', 'a', 'skip'), run('R1.1', 'b', 'not-run')] }],
    out: { checkpoints: [], tests: [], gateChecks: [] },
  },
  {
    name: '시나리오 증거: 부모 문서 확인은 전부 만족일 때만 물려받는다',
    call: 'scenarioEvidence',
    args: [{ scenarioId: 'R1.1', checkpoints: [], testFiles: [], gateChecks: [], testRunRows: [], parentEvidence: { checkpoints: [], tests: [], gateChecks: [], docEvidence: { matched: ['a'], missing: ['b'], satisfied: false } } }],
    out: { checkpoints: [], tests: [], gateChecks: [] },
  },
  {
    name: '시나리오 증거: 부모 문서 확인이 만족이면 그대로 물려받는다',
    call: 'scenarioEvidence',
    args: [{ scenarioId: 'R1.1', checkpoints: [], testFiles: [], gateChecks: [], testRunRows: [], parentEvidence: { checkpoints: [], tests: [], gateChecks: [], docEvidence: { matched: ['a'], missing: [], satisfied: true } } }],
    out: { checkpoints: [], tests: [], gateChecks: [], docEvidence: { matched: ['a'], missing: [], satisfied: true } },
  },
  {
    name: '시나리오 증거: 이 id의 실행 행만 센다(R1.1 ≠ R1.10)',
    call: 'scenarioEvidence',
    args: [{ scenarioId: 'R1.1', checkpoints: [], testFiles: [], gateChecks: [], testRunRows: [run('R1.10', 'a', 'pass'), run('R1', 'b', 'pass')] }],
    out: { checkpoints: [], tests: [], gateChecks: [] },
  },
  {
    name: 'U+FFFD가 든 id끼리는 같다고 보지 않는다(짝 없는 서로게이트가 합쳐진 글자)',
    call: 'scenarioEvidence',
    args: [{ scenarioId: 'R1.1\ufffd', checkpoints: [], testFiles: [], gateChecks: [], testRunRows: [run('R1.1\ufffd', 'a', 'pass')] }],
    out: { checkpoints: [], tests: [], gateChecks: [] },
    intended: true,
  },
  // ── 아직 검증되지 않은 시나리오
  { name: '시나리오가 없으면 빈 목록', call: 'unverified', args: [req('R1'), [], [], [], [], { checkpoints: [], tests: [], gateChecks: [] }], out: [] },
  {
    name: '시나리오: 증거가 없으면 모두 남는다',
    call: 'unverified',
    args: [req('R1', { scenarios: [scenario('R1.1'), scenario('R1.2')] }), [], [], [], [], { checkpoints: [], tests: [], gateChecks: [] }],
    out: ['R1.1', 'R1.2'],
  },
  {
    name: '시나리오: 게이트가 통과하면 그 시나리오는 검증됨이다',
    call: 'unverified',
    args: [req('R1', { scenarios: [scenario('R1.1'), scenario('R1.2')] }), [], [], [gate('R1.1 통과')], [], { checkpoints: [], tests: [], gateChecks: [] }],
    out: ['R1.2'],
  },
  {
    name: '시나리오: 게이트가 실패하면 검증됨이 아니다',
    call: 'unverified',
    args: [req('R1', { scenarios: [scenario('R1.1')] }), [], [], [gate('R1.1 실패', false)], [], { checkpoints: [], tests: [], gateChecks: [] }],
    out: ['R1.1'],
  },
  {
    name: '시나리오: 테스트 탭 통과가 있으면 검증됨이다',
    call: 'unverified',
    args: [req('R1', { scenarios: [scenario('R1.1'), scenario('R1.2')] }), [], [], [], [run('R1.1', 'x', 'pass')], { checkpoints: [], tests: [], gateChecks: [] }],
    out: ['R1.2'],
  },
  {
    name: '시나리오: 사람 확인은 시나리오를 검증됨으로 만들지 않는다',
    call: 'unverified',
    args: [req('R1', { scenarios: [scenario('R1.1')], manualVerification: { by: 'a', at: '2026-06-01', sha: 'abc', note: 'ok' } }), [], [], [], [], { checkpoints: [], tests: [], gateChecks: [] }],
    out: ['R1.1'],
  },
  {
    name: '시나리오: 부모의 문서 확인은 시나리오를 검증됨으로 만들지 않는다',
    call: 'unverified',
    args: [req('R1', { scenarios: [scenario('R1.1')] }), [], [], [], [], { checkpoints: [], tests: [], gateChecks: [], docEvidence: { matched: ['a'], missing: [], satisfied: true } }],
    out: ['R1.1'],
  },
  {
    name: '시나리오: 시험만 있고 실행이 없으면 검증됨이 아니다',
    call: 'unverified',
    args: [req('R1', { scenarios: [scenario('R1.1')] }), [], [ts("it('R1.1 x', () => {});")], [], [], { checkpoints: [], tests: [], gateChecks: [] }],
    out: ['R1.1'],
  },
  // ── 추적표
  {
    name: '추적표: 게이트가 통과하면 검증됨·게이트',
    call: 'matrix',
    args: [{ requirements: [req('R1')], checkpoints: [cp('R1 저장')], testFiles: [ts("it('R1 a', () => {});")], gateChecks: [gate('R1 게이트')] }],
    out: {
      rows: [{ kind: 'requirement', id: 'R1', title: 'R1 제목', rev: 1, priority: 'must', checkpoints: [cp('R1 저장')], tests: hit(A, 'R1 a'), gateChecks: [gate('R1 게이트')], status: '검증됨', verifiedBy: '게이트' }],
      orphanTests: [],
      mustHavesWithoutTests: [],
      mustHavesVerifiedWithoutTests: [],
    },
  },
  {
    name: '추적표: R10의 시험은 R1의 근거가 아니다(공백·미착수)',
    call: 'matrix',
    args: [{ requirements: [req('R1')], checkpoints: [], testFiles: [ts("it('R10 a', () => {});")], gateChecks: [gate('R10 게이트')] }],
    out: {
      rows: [{ kind: 'requirement', id: 'R1', title: 'R1 제목', rev: 1, priority: 'must', checkpoints: [], tests: [], gateChecks: [], status: '미착수', verifiedBy: 'none' }],
      orphanTests: [],
      mustHavesWithoutTests: [req('R1')],
      mustHavesVerifiedWithoutTests: [],
    },
  },
  {
    name: '추적표: 시나리오 행과 남은 시나리오(요구사항은 작업 중)',
    call: 'matrix',
    args: [{ requirements: [req('R1', { scenarios: [scenario('R1.1'), scenario('R1.2')], rev: 2, trace: { issue: 7 } })], checkpoints: [], testFiles: [ts("it('R1.1 x', () => {});")], gateChecks: [gate('R1.1 통과')] }],
    out: {
      rows: [
        { kind: 'requirement', id: 'R1', title: 'R1 제목', rev: 2, priority: 'must', issue: 7, checkpoints: [], tests: hit(A, 'R1.1 x'), gateChecks: [gate('R1.1 통과')], status: '작업 중', verifiedBy: 'none' },
        { kind: 'scenario', id: 'R1.1', parentId: 'R1', title: '(Given) g (When) w (Then) t', rev: 2, priority: 'must', issue: 7, checkpoints: [], tests: hit(A, 'R1.1 x'), gateChecks: [gate('R1.1 통과')], status: '검증됨', verifiedBy: '게이트' },
        { kind: 'scenario', id: 'R1.2', parentId: 'R1', title: '(Given) g (When) w (Then) t', rev: 2, priority: 'must', issue: 7, checkpoints: [], tests: [], gateChecks: [], status: '미착수', verifiedBy: 'none' },
      ],
      orphanTests: [],
      mustHavesWithoutTests: [],
      mustHavesVerifiedWithoutTests: [],
    },
  },
  {
    name: '추적표: 테스트 없는 필수가 사람 확인으로 검증됨이면 따로 모은다',
    call: 'matrix',
    args: [{ requirements: [req('R1', { manualVerification: { by: 'a', at: '2026-06-01', sha: 'abc', note: 'ok' } }), req('R2'), req('R3', { priority: 'should' })], checkpoints: [], testFiles: [], gateChecks: [] }],
    out: {
      rows: [
        { kind: 'requirement', id: 'R1', title: 'R1 제목', rev: 1, priority: 'must', checkpoints: [], tests: [], gateChecks: [], status: '검증됨', verifiedBy: '사람 확인' },
        { kind: 'requirement', id: 'R2', title: 'R2 제목', rev: 1, priority: 'must', checkpoints: [], tests: [], gateChecks: [], status: '미착수', verifiedBy: 'none' },
        { kind: 'requirement', id: 'R3', title: 'R3 제목', rev: 1, priority: 'should', checkpoints: [], tests: [], gateChecks: [], status: '미착수', verifiedBy: 'none' },
      ],
      orphanTests: [],
      mustHavesWithoutTests: [req('R2')],
      mustHavesVerifiedWithoutTests: [req('R1', { manualVerification: { by: 'a', at: '2026-06-01', sha: 'abc', note: 'ok' } })],
    },
  },
  {
    name: '추적표: 실행 결과를 이름으로 붙이고 실행에만 있는 시험도 보여 준다(skip은 안 돌림)',
    call: 'matrix',
    args: [
      {
        requirements: [req('R1')],
        checkpoints: [],
        testFiles: [ts("it('R1 a', () => {});\nit('R1 b', () => {});")],
        gateChecks: [],
        testRunRows: [run('R1', 'R1 a', 'pass'), run('R1', 'R1 c', 'fail', { file: 'c.test.ts' }), run('R1', 'R1 d', 'skip', { file: 'd.test.ts' }), run('R10', 'R1 b', 'pass')],
      },
    ],
    out: {
      rows: [
        {
          kind: 'requirement',
          id: 'R1',
          title: 'R1 제목',
          rev: 1,
          priority: 'must',
          checkpoints: [],
          tests: [
            { file: A, name: 'R1 a', result: 'pass' },
            { file: A, name: 'R1 b' },
            { file: 'c.test.ts', name: 'R1 c', result: 'fail' },
            { file: 'd.test.ts', name: 'R1 d', result: 'not-run' },
          ],
          gateChecks: [],
          status: '작업 중',
          verifiedBy: 'none',
        },
      ],
      orphanTests: [],
      mustHavesWithoutTests: [],
      mustHavesVerifiedWithoutTests: [],
    },
  },
  {
    name: '추적표: 같은 이름의 실행 행은 뒤의 것이 이긴다',
    call: 'matrix',
    args: [{ requirements: [req('R1')], checkpoints: [], testFiles: [ts("it('R1 a', () => {});")], gateChecks: [], testRunRows: [run('R1', 'R1 a', 'pass'), run('R1', 'R1 a', 'fail')] }],
    out: {
      rows: [{ kind: 'requirement', id: 'R1', title: 'R1 제목', rev: 1, priority: 'must', checkpoints: [], tests: [{ file: A, name: 'R1 a', result: 'fail' }], gateChecks: [], status: '작업 중', verifiedBy: 'none' }],
      orphanTests: [],
      mustHavesWithoutTests: [],
      mustHavesVerifiedWithoutTests: [],
    },
  },
  {
    name: '추적표: 주인 없는 시험을 모은다',
    call: 'matrix',
    args: [{ requirements: [req('R1')], checkpoints: [], testFiles: [ts("it('plain', () => {});\nit('R1 a', () => {});")], gateChecks: [] }],
    out: {
      rows: [{ kind: 'requirement', id: 'R1', title: 'R1 제목', rev: 1, priority: 'must', checkpoints: [], tests: hit(A, 'R1 a'), gateChecks: [], status: '작업 중', verifiedBy: 'none' }],
      orphanTests: hit(A, 'plain'),
      mustHavesWithoutTests: [],
      mustHavesVerifiedWithoutTests: [],
    },
  },
  {
    name: '추적표: studio 평가가 있으면 증거·상태를 그대로 쓴다',
    call: 'matrix',
    args: [
      {
        requirements: [req('R1', { scenarios: [scenario('R1.1')] })],
        checkpoints: [],
        testFiles: [ts("it('R1.1 x', () => {});")],
        gateChecks: [],
        evaluationByRequirementId: { R1: { status: '검증됨', evidence: { checkpoints: [cp('R1 저장')], tests: hit(A, 'R1 e'), gateChecks: [], docEvidence: { matched: ['a'], missing: [], satisfied: true } }, verifiedBy: 'docs' } },
        testRunRows: [run('R1', 'R1 e', 'pass')],
      },
    ],
    out: {
      rows: [
        { kind: 'requirement', id: 'R1', title: 'R1 제목', rev: 1, priority: 'must', checkpoints: [cp('R1 저장')], tests: [{ file: A, name: 'R1 e', result: 'pass' }], gateChecks: [], status: '검증됨', verifiedBy: '문서 확인' },
        { kind: 'scenario', id: 'R1.1', parentId: 'R1', title: '(Given) g (When) w (Then) t', rev: 1, priority: 'must', checkpoints: [], tests: hit(A, 'R1.1 x'), gateChecks: [], status: '검증됨', verifiedBy: '문서 확인' },
      ],
      orphanTests: [],
      mustHavesWithoutTests: [],
      mustHavesVerifiedWithoutTests: [],
    },
  },
  {
    name: '추적표: 평가가 없는 요구사항만 직접 계산한다',
    call: 'matrix',
    args: [{ requirements: [req('R1'), req('R2')], checkpoints: [cp('R2 저장')], testFiles: [], gateChecks: [], evaluationByRequirementId: { R1: { status: '실패', evidence: { checkpoints: [], tests: [], gateChecks: [gate('x', false)] }, verifiedBy: 'none' } } }],
    out: {
      rows: [
        { kind: 'requirement', id: 'R1', title: 'R1 제목', rev: 1, priority: 'must', checkpoints: [], tests: [], gateChecks: [gate('x', false)], status: '실패', verifiedBy: 'none' },
        { kind: 'requirement', id: 'R2', title: 'R2 제목', rev: 1, priority: 'must', checkpoints: [cp('R2 저장')], tests: [], gateChecks: [], status: '작업 중', verifiedBy: 'none' },
      ],
      orphanTests: [],
      mustHavesWithoutTests: [req('R1'), req('R2')],
      mustHavesVerifiedWithoutTests: [],
    },
  },
  {
    name: '추적표: 내용 해시가 달라지면 재확인 필요',
    call: 'matrix',
    args: [{ requirements: [req('R1', { hash: 'deadbeef00000000' })], checkpoints: [], testFiles: [], gateChecks: [gate('R1 통과')] }],
    out: {
      rows: [{ kind: 'requirement', id: 'R1', title: 'R1 제목', rev: 1, priority: 'must', checkpoints: [], tests: [], gateChecks: [gate('R1 통과')], status: '재확인 필요', verifiedBy: 'none' }],
      orphanTests: [],
      mustHavesWithoutTests: [req('R1', { hash: 'deadbeef00000000' })],
      mustHavesVerifiedWithoutTests: [],
    },
  },
];

function runVector(m: Mod, vector: Vector): unknown {
  try {
    return JSON.parse(JSON.stringify(CALLS[vector.call]!(m, ...vector.args)) ?? 'null');
  } catch (error) {
    return { __throws: error instanceof Error ? error.message : String(error) };
  }
}

const same = (vector: Vector, actual: unknown) => JSON.stringify(actual) === JSON.stringify(vector.out);

describe('추적표·시험 훑기 벡터 (ADR-191 3z)', () => {
  it('모든 벡터가 기대한 값과 글자까지 같다', () => {
    const failures = VECTORS.filter((vector) => !same(vector, runVector(cur as unknown as Mod, vector))).map((vector) => `${vector.name}: ${JSON.stringify(runVector(cur as unknown as Mod, vector)).slice(0, 300)}`);
    expect(failures).toEqual([]);
  });

  it('옛 TS에 돌리면 의도한 차이만 실패한다', () => {
    const failed = VECTORS.filter((vector) => !same(vector, runVector(old, vector)));
    expect(failed.filter((vector) => vector.intended !== true).map((vector) => vector.name)).toEqual([]);
    expect(failed.map((vector) => vector.name)).toEqual(VECTORS.filter((vector) => vector.intended).map((vector) => vector.name));
  });

  it('함수마다 값이 있는 결과와 빈 결과를 둘 다 담는다', () => {
    const slots = new Map<string, { empty: number; filled: number }>();
    for (const vector of VECTORS) {
      const slot = slots.get(vector.call) ?? { empty: 0, filled: 0 };
      const out = vector.out as { rows?: unknown[] } | unknown[];
      const empty = Array.isArray(out) && out.length === 0;
      if (empty) slot.empty++;
      else slot.filled++;
      slots.set(vector.call, slot);
    }
    expect([...slots.keys()].sort()).toEqual(Object.keys(CALLS).sort());
    for (const [call, slot] of slots) expect(slot.filled, call).toBeGreaterThan(0);
    for (const call of ['scanReq', 'scanScenario', 'scanOrphans', 'unverified']) expect(slots.get(call)!.empty, call).toBeGreaterThan(0);
  });
});
