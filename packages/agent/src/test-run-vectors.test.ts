import { describe, expect, it } from 'vitest';
import { buildTestRunPlan, clearTestReportsCommand, CONTAINER_PROJECT_ROOT, detectRunner, JEST_LIKE_REPORT_PATH, PYTEST_REPORT_PATH, reportRootsForIncludes, runnerLabel, splitCollectedReports } from './test-run';

/**
 * test-run(ADR-191 3d)의 벡터 시험. 기대값은 Rust로 옮기기 전 TS 구현이 낸 값이다(손으로 고른 입력 — 경계 하나하나를 밟는다:
 * 허용 글자 경계, 빈 문자열, 표지 뒤 줄 끝 글자, 단어 경계의 처음과 끝, `devDependencies`가 같은 키를 덮는 자리).
 * 이 파일을 옛 TS에 돌리면 아래 "의도한 차이" 시험만 실패해야 한다.
 */
type Expected = { value: unknown } | { threw: true };

function check(run: () => unknown, expected: Expected): void {
  if ('threw' in expected) {
    expect(run).toThrow();
    return;
  }
  const actual = run();
  expect(actual).toStrictEqual(expected.value);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected.value));
}

const PLANS: Array<[string, ...unknown[]]> = [
  ["gradle 전체", "gradle", undefined, undefined, { value: { command: ["./gradlew", "test", "--no-daemon", "--console=plain"], collect: ["sh", "-c", "for f in build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["gradle 클래스", "gradle", { className: "com.example.A" }, undefined, { value: { command: ["./gradlew", "test", "--no-daemon", "--console=plain", "--tests", "com.example.A"], collect: ["sh", "-c", "for f in build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["gradle 클래스+메서드", "gradle", { className: "com.example.A", testName: "m" }, undefined, { value: { command: ["./gradlew", "test", "--no-daemon", "--console=plain", "--tests", "com.example.A.m"], collect: ["sh", "-c", "for f in build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["gradle 메서드만(클래스 없음)은 무시", "gradle", { testName: "m" }, undefined, { value: { command: ["./gradlew", "test", "--no-daemon", "--console=plain"], collect: ["sh", "-c", "for f in build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["gradle 빈 클래스는 없는 것", "gradle", { className: "", testName: "m" }, undefined, { value: { command: ["./gradlew", "test", "--no-daemon", "--console=plain"], collect: ["sh", "-c", "for f in build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["gradle 빈 메서드는 클래스만", "gradle", { className: "A", testName: "" }, undefined, { value: { command: ["./gradlew", "test", "--no-daemon", "--console=plain", "--tests", "A"], collect: ["sh", "-c", "for f in build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["gradle 래퍼 없음", "gradle", { className: "A" }, { wrapper: false }, { value: { command: ["gradle", "test", "--no-daemon", "--console=plain", "--tests", "A"], collect: ["sh", "-c", "for f in build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["gradle 래퍼 있음", "gradle", undefined, { wrapper: true }, { value: { command: ["./gradlew", "test", "--no-daemon", "--console=plain"], collect: ["sh", "-c", "for f in build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["gradle 래퍼 모름", "gradle", undefined, { wrapper: undefined }, { value: { command: ["./gradlew", "test", "--no-daemon", "--console=plain"], collect: ["sh", "-c", "for f in build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["maven 전체", "maven", undefined, undefined, { value: { command: ["mvn", "-q", "test"], collect: ["sh", "-c", "for f in target/surefire-reports/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["maven 클래스", "maven", { className: "A" }, undefined, { value: { command: ["mvn", "-q", "test", "-Dtest=A"], collect: ["sh", "-c", "for f in target/surefire-reports/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["maven 클래스+메서드", "maven", { className: "A", testName: "m" }, undefined, { value: { command: ["mvn", "-q", "test", "-Dtest=A#m"], collect: ["sh", "-c", "for f in target/surefire-reports/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["maven 래퍼 있음", "maven", { className: "A" }, { wrapper: true }, { value: { command: ["./mvnw", "-q", "test", "-Dtest=A"], collect: ["sh", "-c", "for f in target/surefire-reports/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["maven 래퍼 없음", "maven", undefined, { wrapper: false }, { value: { command: ["mvn", "-q", "test"], collect: ["sh", "-c", "for f in target/surefire-reports/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["maven 래퍼 모름", "maven", undefined, {  }, { value: { command: ["mvn", "-q", "test"], collect: ["sh", "-c", "for f in target/surefire-reports/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["maven 빈 클래스", "maven", { className: "", testName: "m" }, undefined, { value: { command: ["mvn", "-q", "test"], collect: ["sh", "-c", "for f in target/surefire-reports/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["vitest 전체", "vitest", undefined, undefined, { value: { command: ["npx", "vitest", "run", "--reporter=json", "--outputFile=/tmp/b-studio-test-report.json"], collect: ["cat", "/tmp/b-studio-test-report.json"], format: "jest-json" } }],
  ["vitest 파일", "vitest", { file: "src/a.test.ts" }, undefined, { value: { command: ["npx", "vitest", "run", "--reporter=json", "--outputFile=/tmp/b-studio-test-report.json", "src/a.test.ts"], collect: ["cat", "/tmp/b-studio-test-report.json"], format: "jest-json" } }],
  ["vitest 파일+이름", "vitest", { file: "src/a.test.ts", testName: "creates an order" }, undefined, { value: { command: ["npx", "vitest", "run", "--reporter=json", "--outputFile=/tmp/b-studio-test-report.json", "src/a.test.ts", "-t", "creates an order"], collect: ["cat", "/tmp/b-studio-test-report.json"], format: "jest-json" } }],
  ["vitest 이름만", "vitest", { testName: "x" }, undefined, { value: { command: ["npx", "vitest", "run", "--reporter=json", "--outputFile=/tmp/b-studio-test-report.json", "-t", "x"], collect: ["cat", "/tmp/b-studio-test-report.json"], format: "jest-json" } }],
  ["vitest 빈 파일·빈 이름", "vitest", { file: "", testName: "" }, undefined, { value: { command: ["npx", "vitest", "run", "--reporter=json", "--outputFile=/tmp/b-studio-test-report.json"], collect: ["cat", "/tmp/b-studio-test-report.json"], format: "jest-json" } }],
  ["jest 전체", "jest", undefined, undefined, { value: { command: ["npx", "jest", "--json", "--outputFile=/tmp/b-studio-test-report.json"], collect: ["cat", "/tmp/b-studio-test-report.json"], format: "jest-json" } }],
  ["jest 파일+이름", "jest", { file: "a.test.js", testName: "it(x)" }, undefined, { value: { command: ["npx", "jest", "--json", "--outputFile=/tmp/b-studio-test-report.json", "a.test.js", "-t", "it(x)"], collect: ["cat", "/tmp/b-studio-test-report.json"], format: "jest-json" } }],
  ["jest 클래스는 쓰지 않는다", "jest", { className: "A" }, undefined, { value: { command: ["npx", "jest", "--json", "--outputFile=/tmp/b-studio-test-report.json"], collect: ["cat", "/tmp/b-studio-test-report.json"], format: "jest-json" } }],
  ["pytest 전체", "pytest", undefined, undefined, { value: { command: ["pytest", "--junitxml=/tmp/b-studio-test-report.xml"], collect: ["cat", "/tmp/b-studio-test-report.xml"], format: "junit-xml" } }],
  ["pytest 파일", "pytest", { file: "tests/test_a.py" }, undefined, { value: { command: ["pytest", "--junitxml=/tmp/b-studio-test-report.xml", "tests/test_a.py"], collect: ["cat", "/tmp/b-studio-test-report.xml"], format: "junit-xml" } }],
  ["pytest 파일+이름", "pytest", { file: "tests/test_a.py", testName: "test_x" }, undefined, { value: { command: ["pytest", "--junitxml=/tmp/b-studio-test-report.xml", "tests/test_a.py::test_x"], collect: ["cat", "/tmp/b-studio-test-report.xml"], format: "junit-xml" } }],
  ["pytest 파일+클래스+이름", "pytest", { file: "tests/test_a.py", className: "TestA", testName: "test_x" }, undefined, { value: { command: ["pytest", "--junitxml=/tmp/b-studio-test-report.xml", "tests/test_a.py::TestA::test_x"], collect: ["cat", "/tmp/b-studio-test-report.xml"], format: "junit-xml" } }],
  ["pytest 파일+클래스(이름 없음)는 파일만", "pytest", { file: "tests/test_a.py", className: "TestA" }, undefined, { value: { command: ["pytest", "--junitxml=/tmp/b-studio-test-report.xml", "tests/test_a.py"], collect: ["cat", "/tmp/b-studio-test-report.xml"], format: "junit-xml" } }],
  ["pytest 파일 없이 이름만", "pytest", { testName: "test_x" }, undefined, { value: { command: ["pytest", "--junitxml=/tmp/b-studio-test-report.xml"], collect: ["cat", "/tmp/b-studio-test-report.xml"], format: "junit-xml" } }],
  ["pytest 빈 클래스", "pytest", { file: "f.py", className: "", testName: "t" }, undefined, { value: { command: ["pytest", "--junitxml=/tmp/b-studio-test-report.xml", "f.py::t"], collect: ["cat", "/tmp/b-studio-test-report.xml"], format: "junit-xml" } }],
  ["한글·공백·인용 문자는 그대로 이어 붙인다", "vitest", { file: "한 글/it's.test.ts", testName: "a \"b\" $(c) ; d\n e" }, undefined, { value: { command: ["npx", "vitest", "run", "--reporter=json", "--outputFile=/tmp/b-studio-test-report.json", "한 글/it's.test.ts", "-t", "a \"b\" $(c) ; d\n e"], collect: ["cat", "/tmp/b-studio-test-report.json"], format: "jest-json" } }],
  ["gradle 보고서 뿌리 하나", "gradle", undefined, { extraReportRoots: ["/workspace/lib"] }, { value: { command: ["./gradlew", "test", "--no-daemon", "--console=plain"], collect: ["sh", "-c", "for f in build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done; for f in '/workspace/lib'/build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["maven 보고서 뿌리 둘", "maven", { className: "A" }, { extraReportRoots: ["a/b", "c-d_e.f"] }, { value: { command: ["mvn", "-q", "test", "-Dtest=A"], collect: ["sh", "-c", "for f in target/surefire-reports/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done; for f in 'a/b'/target/surefire-reports/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done; for f in 'c-d_e.f'/target/surefire-reports/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["보고서 뿌리: 허용 문자 경계", "gradle", undefined, { extraReportRoots: ["0", "9", ":", "@", "A", "Z", "[", "`", "a", "z", "{", "/", ".", "_", "-", "\\", "=", "+"] }, { value: { command: ["./gradlew", "test", "--no-daemon", "--console=plain"], collect: ["sh", "-c", "for f in build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done; for f in '0'/build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done; for f in '9'/build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done; for f in 'A'/build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done; for f in 'Z'/build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done; for f in 'a'/build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done; for f in 'z'/build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done; for f in '/'/build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done; for f in '.'/build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done; for f in '_'/build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done; for f in '-'/build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["보고서 뿌리: 위험한 값은 버린다", "gradle", undefined, { extraReportRoots: ["m; rm -rf /", "k'k", "", "한글", "a b", "a\n", "\na", "$HOME", "a*", "`x`", "a|b", "a&b", "a(b)", "a\u00a0"] }, { value: { command: ["./gradlew", "test", "--no-daemon", "--console=plain"], collect: ["sh", "-c", "for f in build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["보고서 뿌리: 버린 값 사이의 값은 남는다", "maven", undefined, { extraReportRoots: ["x y", "ok", "no'no", "fine/dir"] }, { value: { command: ["mvn", "-q", "test"], collect: ["sh", "-c", "for f in target/surefire-reports/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done; for f in 'ok'/target/surefire-reports/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done; for f in 'fine/dir'/target/surefire-reports/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["보고서 뿌리: 빈 목록", "gradle", undefined, { extraReportRoots: [] }, { value: { command: ["./gradlew", "test", "--no-daemon", "--console=plain"], collect: ["sh", "-c", "for f in build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done"], format: "junit-xml" } }],
  ["vitest·pytest·jest는 보고서 뿌리를 쓰지 않는다", "vitest", undefined, { extraReportRoots: ["a"] }, { value: { command: ["npx", "vitest", "run", "--reporter=json", "--outputFile=/tmp/b-studio-test-report.json"], collect: ["cat", "/tmp/b-studio-test-report.json"], format: "jest-json" } }],
  ["pytest는 보고서 뿌리를 쓰지 않는다", "pytest", undefined, { extraReportRoots: ["a"] }, { value: { command: ["pytest", "--junitxml=/tmp/b-studio-test-report.xml"], collect: ["cat", "/tmp/b-studio-test-report.xml"], format: "junit-xml" } }],
];

const CLEARS: Array<[string, ...unknown[]]> = [
  ["뿌리 없음", [], { value: ["sh", "-c", "rm -f /tmp/b-studio-test-report.json /tmp/b-studio-test-report.xml build/test-results/test/*.xml target/surefire-reports/*.xml"] }],
  ["뿌리 하나", ["m"], { value: ["sh", "-c", "rm -f /tmp/b-studio-test-report.json /tmp/b-studio-test-report.xml build/test-results/test/*.xml 'm'/build/test-results/test/*.xml target/surefire-reports/*.xml 'm'/target/surefire-reports/*.xml"] }],
  ["뿌리 둘, 위험한 값 하나", ["m", "x;y", "n/o"], { value: ["sh", "-c", "rm -f /tmp/b-studio-test-report.json /tmp/b-studio-test-report.xml build/test-results/test/*.xml 'm'/build/test-results/test/*.xml 'n/o'/build/test-results/test/*.xml target/surefire-reports/*.xml 'm'/target/surefire-reports/*.xml 'n/o'/target/surefire-reports/*.xml"] }],
  ["허용 문자 경계", ["0", "9", ":", "@", "A", "Z", "[", "`", "a", "z", "{"], { value: ["sh", "-c", "rm -f /tmp/b-studio-test-report.json /tmp/b-studio-test-report.xml build/test-results/test/*.xml '0'/build/test-results/test/*.xml '9'/build/test-results/test/*.xml 'A'/build/test-results/test/*.xml 'Z'/build/test-results/test/*.xml 'a'/build/test-results/test/*.xml 'z'/build/test-results/test/*.xml target/surefire-reports/*.xml '0'/target/surefire-reports/*.xml '9'/target/surefire-reports/*.xml 'A'/target/surefire-reports/*.xml 'Z'/target/surefire-reports/*.xml 'a'/target/surefire-reports/*.xml 'z'/target/surefire-reports/*.xml"] }],
  ["빈 값과 위험한 값만", ["", "'", " ", "\n"], { value: ["sh", "-c", "rm -f /tmp/b-studio-test-report.json /tmp/b-studio-test-report.xml build/test-results/test/*.xml target/surefire-reports/*.xml"] }],
];

const INCLUDES: Array<[string, ...unknown[]]> = [
  ["없음", [], undefined, { value: [] }],
  ["기본 뿌리", ["a", "b/c"], undefined, { value: ["/workspace/a", "/workspace/b/c"] }],
  ["뿌리 지정", ["a"], "/srv", { value: ["/srv/a"] }],
  ["빈 뿌리", ["a"], "", { value: ["/a"] }],
  ["빈 include", [""], "/w", { value: ["/w/"] }],
  ["includes 생략", undefined, undefined, { value: [] }],
];

const SPLITS: Array<[string, ...unknown[]]> = [
  ["표지 없음·빈 글", "", undefined, { value: [] }],
  ["표지 없음·공백뿐", " \n\t\u00a0\ufeff\u2028\u3000 ", undefined, { value: [] }],
  ["표지 없음·U+0085는 공백이 아니다", "\u0085", undefined, { value: [{ file: "report", content: "\u0085" }] }],
  ["표지 없음·한 덩어리", "  {\"testResults\":[]}\n", undefined, { value: [{ file: "report", content: "{\"testResults\":[]}" }] }],
  ["표지 없음·라벨 지정", " x ", "one.json", { value: [{ file: "one.json", content: "x" }] }],
  ["표지 하나", "@@@b-studio-test-report@@@build/a.xml\n<x/>\n", undefined, { value: [{ file: "build/a.xml", content: "<x/>" }] }],
  ["표지 둘", "@@@b-studio-test-report@@@a.xml\n<x/>\n\n@@@b-studio-test-report@@@b.xml\n<y/>\n", undefined, { value: [{ file: "a.xml", content: "<x/>" }, { file: "b.xml", content: "<y/>" }] }],
  ["표지 앞의 글은 버린다", "junk\nmore\n@@@b-studio-test-report@@@a.xml\n<x/>", undefined, { value: [{ file: "a.xml", content: "<x/>" }] }],
  ["표지 뒤 파일 이름의 공백은 다듬는다", "@@@b-studio-test-report@@@ a b.xml \u00a0\n<x/>", undefined, { value: [{ file: "a b.xml", content: "<x/>" }] }],
  ["내용이 비어 있다", "@@@b-studio-test-report@@@a.xml\n@@@b-studio-test-report@@@b.xml\n", undefined, { value: [{ file: "a.xml", content: "" }, { file: "b.xml", content: "" }] }],
  ["표지 뒤 첫 줄 끝이 \\r\\n이면 맞지 않는다", "@@@b-studio-test-report@@@a.xml\r\n<x/>\n", undefined, { value: [] }],
  ["표지 뒤 첫 줄 끝이 \\r이면 맞지 않는다", "@@@b-studio-test-report@@@a.xml\r<x/>\n", undefined, { value: [] }],
  ["표지 뒤 첫 줄 끝이 U+2028이면 맞지 않는다", "@@@b-studio-test-report@@@a.xml\u2028<x/>\n", undefined, { value: [] }],
  ["표지 뒤 첫 줄 끝이 U+2029이면 맞지 않는다", "@@@b-studio-test-report@@@a.xml\u2029<x/>\n", undefined, { value: [] }],
  ["표지 뒤에 줄 끝이 없으면 맞지 않는다", "@@@b-studio-test-report@@@a.xml", undefined, { value: [] }],
  ["맞지 않는 표지 뒤의 맞는 표지", "@@@b-studio-test-report@@@a.xml\r\n@@@b-studio-test-report@@@b.xml\n<y/>", undefined, { value: [{ file: "b.xml", content: "<y/>" }] }],
  ["맞는 표지 뒤의 맞지 않는 표지는 앞 내용에 들어간다", "@@@b-studio-test-report@@@a.xml\n<x/>@@@b-studio-test-report@@@b.xml\r\n<z/>", undefined, { value: [{ file: "a.xml", content: "<x/>@@@b-studio-test-report@@@b.xml\r\n<z/>" }] }],
  ["표지 바로 뒤에 표지", "@@@b-studio-test-report@@@@@@b-studio-test-report@@@z\nq", undefined, { value: [{ file: "@@@b-studio-test-report@@@z", content: "q" }] }],
  ["표지 끝 줄바꿈 바로 뒤에 표지", "@@@b-studio-test-report@@@a\n@@@b-studio-test-report@@@b\nbody", undefined, { value: [{ file: "a", content: "" }, { file: "b", content: "body" }] }],
  ["내용의 앞뒤 공백·BOM을 다듬는다", "@@@b-studio-test-report@@@a\n\ufeff \n body \u00a0\n\n", undefined, { value: [{ file: "a", content: "body" }] }],
  ["표지의 일부만 있으면 표지가 아니다", "@@@b-studio-test-report@@ x\n", undefined, { value: [{ file: "report", content: "@@@b-studio-test-report@@ x" }] }],
  ["표지 하나와 일부 표지", "@@@@@@b-studio-test-report@@@\nx", undefined, { value: [{ file: "", content: "x" }] }],
  ["한글 파일 이름과 이모지", "@@@b-studio-test-report@@@한글/😀.xml\n<한/>", undefined, { value: [{ file: "한글/😀.xml", content: "<한/>" }] }],
  ["표지 없는 줄바꿈 글", "a\r\nb\r\n", undefined, { value: [{ file: "report", content: "a\r\nb" }] }],
];

const DETECTS: Array<[string, ...unknown[]]> = [
  ["spring+pom → maven", { template: "spring-boot", hasPomXml: true }, { value: "maven" }],
  ["spring 래퍼 없음 → gradle", { template: "spring-boot", hasPomXml: false }, { value: "gradle" }],
  ["spring pom 모름 → gradle", { template: "Spring" }, { value: "gradle" }],
  ["spring이 next보다 먼저", { template: "spring-next", hasPomXml: true, packageJson: { devDependencies: { vitest: "1" } } }, { value: "maven" }],
  ["fastapi", { template: "fastapi" }, { value: "pytest" }],
  ["FastAPI 대문자", { template: "FastAPI" }, { value: "pytest" }],
  ["python", { template: "python-app" }, { value: "pytest" }],
  ["django", { template: "django" }, { value: "pytest" }],
  ["flask", { template: "flask-api" }, { value: "pytest" }],
  ["켈빈 기호 K는 소문자 k로 접힌다", { template: "flasK" }, { value: "pytest" }],
  ["pytest가 vite보다 먼저", { template: "flask-vite", packageJson: { devDependencies: { jest: "1" } } }, { value: "pytest" }],
  ["next+vitest 의존성", { template: "nextjs", packageJson: { dependencies: { vitest: "^1" } } }, { value: "vitest" }],
  ["next+jest 개발 의존성", { template: "nextjs", packageJson: { devDependencies: { jest: "^29" } } }, { value: "jest" }],
  ["vitest가 jest보다 먼저", { template: "vite", packageJson: { dependencies: { jest: "1", vitest: "1" } } }, { value: "vitest" }],
  ["react", { template: "react", packageJson: { dependencies: { vitest: "1" } } }, { value: "vitest" }],
  ["node", { template: "node-api", packageJson: { dependencies: { jest: "1" } } }, { value: "jest" }],
  ["devDependencies가 같은 키를 덮는다(빈 값)", { template: "vite", packageJson: { dependencies: { vitest: "1" }, devDependencies: { vitest: "" } } }, { value: undefined }],
  ["devDependencies가 같은 키를 덮는다(참인 값)", { template: "vite", packageJson: { dependencies: { vitest: "" }, devDependencies: { vitest: "1" } } }, { value: "vitest" }],
  ["devDependencies에 키가 없으면 dependencies", { template: "vite", packageJson: { dependencies: { vitest: "1" }, devDependencies: { jest: "" } } }, { value: "vitest" }],
  ["의존성 값이 0·null·false면 없는 것", { template: "vite", packageJson: { dependencies: { vitest: 0, jest: null } } }, { value: undefined }],
  ["의존성 값이 빈 배열이면 있는 것", { template: "vite", packageJson: { dependencies: { vitest: [] } } }, { value: "vitest" }],
  ["의존성이 문자열이면 키가 없다", { template: "vite", packageJson: { dependencies: "vitest" } }, { value: undefined }],
  ["의존성이 배열이면 키가 없다", { template: "vite", packageJson: { dependencies: ["vitest"] } }, { value: undefined }],
  ["의존성이 null", { template: "vite", packageJson: { dependencies: null, devDependencies: { jest: "1" } } }, { value: "jest" }],
  ["스크립트 vitest", { template: "vite", packageJson: { scripts: { test: "vitest run" } } }, { value: "vitest" }],
  ["스크립트 jest", { template: "vite", packageJson: { scripts: { test: "jest --ci" } } }, { value: "jest" }],
  ["스크립트 단어 경계: 앞 글자", { template: "vite", packageJson: { scripts: { test: "xvitest" } } }, { value: undefined }],
  ["스크립트 단어 경계: 뒤 글자", { template: "vite", packageJson: { scripts: { test: "vitestx" } } }, { value: undefined }],
  ["스크립트 단어 경계: 밑줄", { template: "vite", packageJson: { scripts: { test: "_jest jest_" } } }, { value: undefined }],
  ["스크립트 단어 경계: 숫자", { template: "vite", packageJson: { scripts: { test: "1jest jest1" } } }, { value: undefined }],
  ["스크립트 단어 경계: 하이픈은 경계", { template: "vite", packageJson: { scripts: { test: "my-jest-runner" } } }, { value: "jest" }],
  ["스크립트 단어 경계: 한글은 경계", { template: "vite", packageJson: { scripts: { test: "한jest한" } } }, { value: "jest" }],
  ["스크립트 단어 경계: 처음과 끝", { template: "vite", packageJson: { scripts: { test: "vitest" } } }, { value: "vitest" }],
  ["스크립트 단어 경계: 둘째 자리가 맞다", { template: "vite", packageJson: { scripts: { test: "xjest jest" } } }, { value: "jest" }],
  ["스크립트 대문자는 맞지 않는다", { template: "vite", packageJson: { scripts: { test: "VITEST" } } }, { value: undefined }],
  ["스크립트 vitest가 jest보다 먼저", { template: "vite", packageJson: { scripts: { test: "jest && vitest" } } }, { value: "vitest" }],
  ["스크립트 test가 배열", { template: "vite", packageJson: { scripts: { test: ["x", "jest"] } } }, { value: "jest" }],
  ["스크립트 test가 숫자·null", { template: "vite", packageJson: { scripts: { test: 5 } } }, { value: undefined }],
  ["스크립트가 null", { template: "vite", packageJson: { scripts: { test: null } } }, { value: undefined }],
  ["스크립트가 문자열이면 test가 없다", { template: "vite", packageJson: { scripts: "vitest" } }, { value: undefined }],
  ["스크립트가 test 말고 다른 이름", { template: "vite", packageJson: { scripts: { lint: "vitest" } } }, { value: undefined }],
  ["의존성이 스크립트보다 먼저", { template: "vite", packageJson: { dependencies: { jest: "1" }, scripts: { test: "vitest" } } }, { value: "jest" }],
  ["package.json 없음", { template: "next" }, { value: undefined }],
  ["package.json이 null", { template: "next", packageJson: null }, { value: undefined }],
  ["package.json이 문자열", { template: "next", packageJson: "vitest" }, { value: undefined }],
  ["package.json이 배열", { template: "next", packageJson: ["vitest"] }, { value: undefined }],
  ["빈 package.json", { template: "vite", packageJson: {  } }, { value: undefined }],
  ["모르는 템플릿", { template: "go" }, { value: undefined }],
  ["빈 템플릿", { template: "" }, { value: undefined }],
  ["템플릿에 spring이 부분 문자열", { template: "my-springboot-app" }, { value: "gradle" }],
  ["템플릿에 next가 부분 문자열", { template: "nextra" }, { value: undefined }],
  ["템플릿에 node가 부분 문자열", { template: "nodejs", packageJson: { devDependencies: { vitest: "1" } } }, { value: "vitest" }],
  ["의존성 키 이름이 constructor·__proto__", { template: "vite", packageJson: { dependencies: { __proto__: { vitest: "1" }, constructor: "x" } } }, { value: undefined }],
  ["템플릿 전각 문자는 접히지 않는다", { template: "ＳＰＲＩＮＧ" }, { value: undefined }],
];

const LABELS: Array<[string, ...unknown[]]> = [
  ["gradle", "gradle", { value: "Gradle (JUnit)" }],
  ["maven", "maven", { value: "Maven (JUnit)" }],
  ["vitest", "vitest", { value: "Vitest" }],
  ["jest", "jest", { value: "Jest" }],
  ["pytest", "pytest", { value: "pytest" }],
];

describe('test-run 벡터(옛 TS가 낸 값)', () => {
  it.each(PLANS)('buildTestRunPlan: %s', (_label, runner, target, opts, expected) => {
    check(() => buildTestRunPlan(runner as never, target as never, opts as never), expected as Expected);
  });
  it.each(CLEARS)('clearTestReportsCommand: %s', (_label, roots, expected) => {
    check(() => clearTestReportsCommand(roots as string[]), expected as Expected);
  });
  it.each(INCLUDES)('reportRootsForIncludes: %s', (_label, includes, root, expected) => {
    check(() => reportRootsForIncludes(includes as string[] | undefined, root as string | undefined), expected as Expected);
  });
  it.each(SPLITS)('splitCollectedReports: %s', (_label, stdout, label, expected) => {
    check(() => splitCollectedReports(stdout as string, label as string | undefined), expected as Expected);
  });
  it.each(DETECTS)('detectRunner: %s', (_label, input, expected) => {
    check(() => detectRunner(input as never), expected as Expected);
  });
  it.each(LABELS)('runnerLabel: %s', (_label, runner, expected) => {
    check(() => runnerLabel(runner as never), expected as Expected);
  });

  it('상수는 옛 값과 같다', () => {
    expect(JEST_LIKE_REPORT_PATH).toBe('/tmp/b-studio-test-report.json');
    expect(PYTEST_REPORT_PATH).toBe('/tmp/b-studio-test-report.xml');
    expect(CONTAINER_PROJECT_ROOT).toBe('/workspace');
  });

  it('수거 명령의 글자: 경계 표지와 for 반복(한 글자도 다르면 안 된다)', () => {
    const plan = buildTestRunPlan('gradle', undefined, { extraReportRoots: ['m'] });
    expect(plan.collect).toStrictEqual([
      'sh',
      '-c',
      `for f in build/test-results/test/*.xml; do [ -f "$f" ] && { echo '@@@b-studio-test-report@@@'"$f"; cat "$f"; echo; }; done; for f in 'm'/build/test-results/test/*.xml; do [ -f "$f" ] && { echo '@@@b-studio-test-report@@@'"$f"; cat "$f"; echo; }; done`,
    ]);
  });
});

describe('test-run 의도한 차이(옛 TS에 돌리면 실패한다)', () => {
  it('알 수 없는 실행기는 던진다(옛 TS는 undefined를 돌려줬다)', () => {
    expect(() => buildTestRunPlan('go' as never)).toThrow();
    expect(() => runnerLabel('go' as never)).toThrow();
  });

  it('문자열이 아닌 보고서 뿌리는 던진다(옛 TS는 문자열로 바꿔 허용 글자 검사를 통과시켰다)', () => {
    expect(() => buildTestRunPlan('gradle', undefined, { extraReportRoots: [5 as unknown as string] })).toThrow();
    expect(() => clearTestReportsCommand([5 as unknown as string])).toThrow();
  });

  it('짝 없는 서로게이트는 U+FFFD로 읽는다(Node 경계 규칙)', () => {
    expect(buildTestRunPlan('vitest', { file: 'a\ud800b' }).command.at(-1)).toBe('a�b');
  });

  it('NUL로 시작하는 키가 든 package.json은 보내지 않고 던진다(경계의 표시 객체와 겹치지 않게)', () => {
    expect(() => detectRunner({ template: 'vite', packageJson: { '\u0000nf': 'x' } as never })).toThrow();
  });
});
