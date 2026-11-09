import { describe, expect, it } from 'vitest';
import { attachResults, buildAddTestPrefill, buildFixTestPrefill, countByStatus, parseJestLikeJson, parseJUnitXml, type ParsedTestRun, type TestRow } from './test-results';

/**
 * test-results(ADR-191 3d)의 벡터 시험. 기대값은 Rust로 옮기기 전 TS 구현이 낸 값이다(손으로 고른 입력 — 경계 하나하나를 밟는다:
 * 코드 포인트 상한 10FFFF ± 1, 16진 무한대 반올림 경계, 스택 5줄·6줄, 시간 반올림의 .5와 음수, 줄 끝 글자 뒤 괄호, 점수 동점과 앞 순서,
 * 묶음 경로 길이 ± 1). 이 파일을 옛 TS에 돌리면 아래 "의도한 차이" 시험만 실패해야 한다.
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

const ENTITIES: Array<[string, ...unknown[]]> = [
  ["이름 있는 엔티티 다섯", "<testcase name=\"&amp;&lt;&gt;&quot;&apos;\"/>", { value: { cases: [{ classOrFile: "", name: "&<>\"'", result: { status: "pass" } }] } }],
  ["대문자·모르는 이름은 그대로", "<testcase name=\"&AMP; &Lt; &unknown; &amp &;\"/>", { value: { cases: [{ classOrFile: "", name: "&AMP; &Lt; &unknown; &amp &;", result: { status: "pass" } }] } }],
  ["10진 수", "<testcase name=\"&#65;&#66;&#0065;\"/>", { value: { cases: [{ classOrFile: "", name: "ABA", result: { status: "pass" } }] } }],
  ["16진 수(소문자 x만)", "<testcase name=\"&#x41;&#x4a;&#x4A;&#X41;\"/>", { value: { cases: [{ classOrFile: "", name: "AJJ&#X41;", result: { status: "pass" } }] } }],
  ["10진 자리에 16진 글자가 섞이면 앞 숫자까지만", "<testcase name=\"&#12ab;|&#1e3;|&#abc;|&#a1;\"/>", { value: { cases: [{ classOrFile: "", name: "\f|\u0001|&#abc;|&#a1;", result: { status: "pass" } }] } }],
  ["코드 포인트 0", "<testcase name=\"a&#0;b&#x0;c\"/>", { value: { cases: [{ classOrFile: "", name: "a\u0000b\u0000c", result: { status: "pass" } }] } }],
  ["BMP 끝과 별면 처음", "<testcase name=\"&#65535;|&#x10000;\"/>", { value: { cases: [{ classOrFile: "", name: "\uffff|\ud800\udc00", result: { status: "pass" } }] } }],
  ["서로게이트 앞 경계 0xD7FF와 뒤 경계 0xE000", "<testcase name=\"&#xD7FF;|&#xE000;\"/>", { value: { cases: [{ classOrFile: "", name: "\ud7ff|\ue000", result: { status: "pass" } }] } }],
  ["짝이 맞는 서로게이트 두 엔티티는 한 글자", "<testcase name=\"&#xD83D;&#xDE00;\"/>", { value: { cases: [{ classOrFile: "", name: "😀", result: { status: "pass" } }] } }],
  ["최대 코드 포인트 10FFFF", "<testcase name=\"&#1114111;|&#x10FFFF;\"/>", { value: { cases: [{ classOrFile: "", name: "\udbff\udfff|\udbff\udfff", result: { status: "pass" } }] } }],
  ["10FFFF + 1(10진)은 던진다", "<testcase name=\"&#1114112;\"/>", { threw: true }],
  ["10FFFF + 1(16진)은 던진다", "<testcase name=\"&#x110000;\"/>", { threw: true }],
  ["아주 큰 10진 수는 던진다", "<testcase name=\"&#99999999999999999999;\"/>", { threw: true }],
  ["아주 큰 16진 수는 던진다", "<testcase name=\"&#xFFFFFFFFFFFFFFFFFFFF;\"/>", { threw: true }],
  ["앞에 0이 많은 16진 수", "<testcase name=\"&#x000000000000000000000000000000000000000041;\"/>", { value: { cases: [{ classOrFile: "", name: "A", result: { status: "pass" } }] } }],
  ["10진 400자리는 무한대라 그대로", "<testcase name=\"&#9999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999;\"/>", { value: { cases: [{ classOrFile: "", name: "&#9999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999;", result: { status: "pass" } }] } }],
  ["16진 300자리는 무한대라 그대로", "<testcase name=\"&#xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;\"/>", { value: { cases: [{ classOrFile: "", name: "&#xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;", result: { status: "pass" } }] } }],
  ["16진 255자리는 유한이라 던진다", "<testcase name=\"&#xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;\"/>", { threw: true }],
  ["16진 256자리 FFFF…FC0…은 반올림하면 무한대라 그대로", "<testcase name=\"&#xFFFFFFFFFFFFFC00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000;\"/>", { value: { cases: [{ classOrFile: "", name: "&#xFFFFFFFFFFFFFC00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000;", result: { status: "pass" } }] } }],
  ["그보다 한 자리 작은 수는 유한이라 던진다", "<testcase name=\"&#xFFFFFFFFFFFFFBFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;\"/>", { threw: true }],
  ["16진 반올림 경계 바로 아래", "<testcase name=\"&#xFFFFFFFFFFFFF800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000;\"/>", { threw: true }],
  ["빈 숫자 엔티티는 엔티티가 아니다", "<testcase name=\"&#;|&#x;|&#xx41;|&#x4g;|&#4 1;\"/>", { value: { cases: [{ classOrFile: "", name: "&#;|&#x;|&#xx41;|&#x4g;|&#4 1;", result: { status: "pass" } }] } }],
  ["세미콜론이 없으면 엔티티가 아니다", "<testcase name=\"&#65 &#x41 &amp\"/>", { value: { cases: [{ classOrFile: "", name: "&#65 &#x41 &amp", result: { status: "pass" } }] } }],
  ["앞의 &가 뒤 엔티티를 막지 않는다", "<testcase name=\"&&amp;&#&amp;;&\"/>", { value: { cases: [{ classOrFile: "", name: "&&&#&;&", result: { status: "pass" } }] } }],
  ["풀린 결과는 다시 풀지 않는다", "<testcase name=\"&amp;amp;&amp;#65;\"/>", { value: { cases: [{ classOrFile: "", name: "&amp;&#65;", result: { status: "pass" } }] } }],
];

const ATTRIBUTES: Array<[string, ...unknown[]]> = [
  ["큰따옴표 속성", "<testcase name=\"a\" classname=\"b.C\" time=\"1\"/>", { value: { cases: [{ classOrFile: "b.C", name: "a", result: { status: "pass", durationMs: 1000 } }] } }],
  ["작은따옴표 속성은 읽지 않는다", "<testcase name='a' classname=\"b\"/>", { value: { cases: [{ classOrFile: "b", name: "", result: { status: "pass" } }] } }],
  ["따옴표 없는 속성은 읽지 않는다", "<testcase name=a classname=\"b\"/>", { value: { cases: [{ classOrFile: "b", name: "", result: { status: "pass" } }] } }],
  ["등호 둘레의 공백", "<testcase name = \"a\"  classname\n=\n\"b\"/>", { value: { cases: [{ classOrFile: "b", name: "a", result: { status: "pass" } }] } }],
  ["등호 둘레의 NBSP·U+2028·BOM은 공백이다", "<testcase name\u00a0=\u2028\"a\" classname=\ufeff\"b\"/>", { value: { cases: [{ classOrFile: "b", name: "a", result: { status: "pass" } }] } }],
  ["등호 둘레의 U+0085는 공백이 아니다", "<testcase name\u0085=\"a\" classname=\"b\"/>", { value: { cases: [{ classOrFile: "b", name: "", result: { status: "pass" } }] } }],
  ["같은 이름이 다시 나오면 뒤의 값", "<testcase name=\"a\" name=\"b\" classname=\"c\" class=\"d\"/>", { value: { cases: [{ classOrFile: "c", name: "b", result: { status: "pass" } }] } }],
  ["classname이 없으면 class", "<testcase name=\"a\" class=\"d\"/>", { value: { cases: [{ classOrFile: "d", name: "a", result: { status: "pass" } }] } }],
  ["classname이 빈 글자여도 class를 쓰지 않는다", "<testcase name=\"a\" classname=\"\" class=\"d\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }] } }],
  ["이름 속성이 없으면 빈 글자", "<testcase classname=\"c\"/>", { value: { cases: [{ classOrFile: "c", name: "", result: { status: "pass" } }] } }],
  ["속성이 하나도 없다", "<testcase/>", { value: { cases: [{ classOrFile: "", name: "", result: { status: "pass" } }] } }],
  ["대소문자는 구별한다", "<testcase NAME=\"a\" Name=\"b\" name=\"c\"/>", { value: { cases: [{ classOrFile: "", name: "c", result: { status: "pass" } }] } }],
  ["이름 글자: 콜론·하이픈·밑줄·숫자", "<testcase a:b=\"1\" c-d=\"2\" _e=\"3\" f9=\"4\" name=\"n\"/>", { value: { cases: [{ classOrFile: "", name: "n", result: { status: "pass" } }] } }],
  ["이름 글자 밖(점·한글)은 이름이 끊긴다", "<testcase x.name=\"1\" 한name=\"2\" name=\"n\"/>", { value: { cases: [{ classOrFile: "", name: "n", result: { status: "pass" } }] } }],
  ["__proto__·constructor 속성", "<testcase __proto__=\"x\" constructor=\"y\" name=\"n\"/>", { value: { cases: [{ classOrFile: "", name: "n", result: { status: "pass" } }] } }],
  ["값 안의 역슬래시 따옴표", "<testcase name=\"a\\\"b\" classname=\"c\"/>", { value: { cases: [{ classOrFile: "c", name: "a\\\"b", result: { status: "pass" } }] } }],
  ["값 안의 역슬래시 역슬래시", "<testcase name=\"a\\\\\" classname=\"c\"/>", { value: { cases: [{ classOrFile: "c", name: "a\\\\", result: { status: "pass" } }] } }],
  ["값 끝의 홀수 역슬래시는 따옴표를 먹어 실패", "<testcase name=\"a\\\" classname=\"c\"/>", { value: { cases: [{ classOrFile: "", name: "a\\\" classname=", result: { status: "pass" } }] } }],
  ["역슬래시 다음 줄바꿈은 실패하고 안의 속성은 읽는다", "<testcase x=\"a\\\n\" name=\"b\"/>", { value: { cases: [{ classOrFile: "", name: "b", result: { status: "pass" } }] } }],
  ["역슬래시 다음 \\r은 실패", "<testcase x=\"a\\\r\" name=\"b\"/>", { value: { cases: [{ classOrFile: "", name: "b", result: { status: "pass" } }] } }],
  ["역슬래시 다음 U+2028은 실패", "<testcase x=\"a\\\u2028\" name=\"b\"/>", { value: { cases: [{ classOrFile: "", name: "b", result: { status: "pass" } }] } }],
  ["역슬래시 다음 U+0085는 이스케이프 쌍이다", "<testcase name=\"a\\\u0085b\"/>", { value: { cases: [{ classOrFile: "", name: "a\\\u0085b", result: { status: "pass" } }] } }],
  ["역슬래시 다음 이모지는 이스케이프 쌍이다", "<testcase name=\"a\\😀b\"/>", { value: { cases: [{ classOrFile: "", name: "a\\😀b", result: { status: "pass" } }] } }],
  ["닫는 따옴표가 없으면 실패하고 그 뒤 속성을 읽는다", "<testcase name=\"abc classname=\"x\"/>", { value: { cases: [{ classOrFile: "", name: "abc classname=", result: { status: "pass" } }] } }],
  ["값 안의 줄바꿈", "<testcase name=\"a\nb\"/>", { value: { cases: [{ classOrFile: "", name: "a\nb", result: { status: "pass" } }] } }],
  ["값 안의 > 는 속성을 끊는다", "<testcase name=\"a>b\" classname=\"c\">x</testcase>", { value: { cases: [{ classOrFile: "", name: "", result: { status: "pass" } }] } }],
  ["값 안의 /> 는 태그를 끊는다", "<testcase name=\"a/>b\" classname=\"c\"/>", { value: { cases: [{ classOrFile: "", name: "", result: { status: "pass" } }] } }],
  ["속성 값에서도 엔티티를 푼다", "<testcase name=\"&lt;A&gt;\" classname=\"&#x42;\"/>", { value: { cases: [{ classOrFile: "B", name: "<A>", result: { status: "pass" } }] } }],
  ["한글 값", "<testcase name=\"주문을 만든다\" classname=\"주문.테스트\"/>", { value: { cases: [{ classOrFile: "주문.테스트", name: "주문을 만든다", result: { status: "pass" } }] } }],
  ["이름 글자 경계: 콜론 앞 접두사가 붙으면 다른 속성", "<testcase x:name=\"v\"/>", { value: { cases: [{ classOrFile: "", name: "", result: { status: "pass" } }] } }],
  ["이름 글자 경계: 밑줄 앞 접두사", "<testcase _name=\"v\"/>", { value: { cases: [{ classOrFile: "", name: "", result: { status: "pass" } }] } }],
  ["이름 글자 경계: 하이픈 앞 접두사", "<testcase a-name=\"v\"/>", { value: { cases: [{ classOrFile: "", name: "", result: { status: "pass" } }] } }],
  ["이름 글자 경계: 숫자 앞 접두사", "<testcase 9name=\"v\"/>", { value: { cases: [{ classOrFile: "", name: "", result: { status: "pass" } }] } }],
  ["이름 글자 경계: 점은 이름 글자가 아니라 name이 읽힌다", "<testcase x.name=\"v\"/>", { value: { cases: [{ classOrFile: "", name: "v", result: { status: "pass" } }] } }],
  ["이름 글자 경계: 한글은 이름 글자가 아니라 name이 읽힌다", "<testcase 한name=\"v\"/>", { value: { cases: [{ classOrFile: "", name: "v", result: { status: "pass" } }] } }],
  ["역슬래시 다음 \\n에서 실패하면 그 뒤 속성을 읽는다", "<testcase x=\"a\\\n name=\"b\"/>", { value: { cases: [{ classOrFile: "", name: "b", result: { status: "pass" } }] } }],
  ["역슬래시 다음 \\r에서 실패하면 그 뒤 속성을 읽는다", "<testcase x=\"a\\\r name=\"b\"/>", { value: { cases: [{ classOrFile: "", name: "b", result: { status: "pass" } }] } }],
  ["역슬래시 다음 U+2028에서 실패하면 그 뒤 속성을 읽는다", "<testcase x=\"a\\\u2028 name=\"b\"/>", { value: { cases: [{ classOrFile: "", name: "b", result: { status: "pass" } }] } }],
  ["역슬래시 다음 U+2029에서 실패하면 그 뒤 속성을 읽는다", "<testcase x=\"a\\\u2029 name=\"b\"/>", { value: { cases: [{ classOrFile: "", name: "b", result: { status: "pass" } }] } }],
  ["역슬래시 다음 U+0085는 이스케이프 쌍이라 닫는 따옴표까지 값이다", "<testcase x=\"a\\\u0085 name=\"b\"/>", { value: { cases: [{ classOrFile: "", name: "", result: { status: "pass" } }] } }],
  ["역슬래시 다음 일반 글자도 이스케이프 쌍이다", "<testcase x=\"a\\q name=\"b\"/>", { value: { cases: [{ classOrFile: "", name: "", result: { status: "pass" } }] } }],
];

const ELEMENTS: Array<[string, ...unknown[]]> = [
  ["빈 글", "", { value: { cases: [] } }],
  ["testcase가 없다", "<testsuite name=\"a\"/>", { value: { cases: [] } }],
  ["testsuites로 감싼다", "<testsuites><testsuite name=\"a\"><testcase name=\"x\" classname=\"A\"/></testsuite></testsuites>", { value: { cases: [{ classOrFile: "A", name: "x", result: { status: "pass" } }] } }],
  ["자기 닫힘과 닫는 태그", "<testcase name=\"a\"/><testcase name=\"b\"></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }, { classOrFile: "", name: "b", result: { status: "pass" } }] } }],
  ["단어 경계: testcases", "<testcases name=\"a\"/>", { value: { cases: [] } }],
  ["단어 경계: testcase_x", "<testcase_x name=\"a\"/>", { value: { cases: [] } }],
  ["단어 경계: testcase1", "<testcase1 name=\"a\"/>", { value: { cases: [] } }],
  ["단어 경계: testcase-x는 testcase다", "<testcase-x name=\"a\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }] } }],
  ["단어 경계: testcase:x는 testcase다", "<testcase:x name=\"a\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }] } }],
  ["단어 경계: 한글이 이어지면 testcase다", "<testcase한 name=\"a\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }] } }],
  ["태그 이름 바로 뒤가 />", "<testcase/>", { value: { cases: [{ classOrFile: "", name: "", result: { status: "pass" } }] } }],
  ["태그 이름 바로 뒤가 >", "<testcase></testcase>", { value: { cases: [{ classOrFile: "", name: "", result: { status: "pass" } }] } }],
  ["글 끝에서 잘린 태그", "<testcase", { value: { cases: [] } }],
  ["글 끝에서 잘린 속성", "<testcase name=\"a\"", { value: { cases: [] } }],
  ["닫는 태그 없는 testcase는 건너뛴다", "<testcase name=\"a\">", { value: { cases: [] } }],
  ["닫는 태그 없는 testcase 뒤의 자기 닫힘", "<testcase name=\"a\"><testcase name=\"b\"/>", { value: { cases: [{ classOrFile: "", name: "b", result: { status: "pass" } }] } }],
  ["닫는 태그가 있는 testcase 안의 testcase는 본문이다", "<testcase name=\"a\"><testcase name=\"b\"/></testcase><testcase name=\"c\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }, { classOrFile: "", name: "c", result: { status: "pass" } }] } }],
  ["첫 닫는 태그에서 끝난다", "<testcase name=\"a\">x</testcase>y</testcase><testcase name=\"b\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }, { classOrFile: "", name: "b", result: { status: "pass" } }] } }],
  ["여러 줄 본문", "<testcase name=\"a\">\n  <system-out>x</system-out>\n</testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }] } }],
  ["주석 안의 testcase도 읽는다", "<!-- <testcase name=\"c\"/> -->", { value: { cases: [{ classOrFile: "", name: "c", result: { status: "pass" } }] } }],
  ["XML 선언과 BOM", "\ufeff<?xml version=\"1.0\"?>\n<testsuite><testcase name=\"a\"/></testsuite>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }] } }],
  ["첫 > 이전의 / 는 속성 글자다", "<testcase name=\"a\" x=/y>body</testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }] } }],
  ["첫 /> 가 먼저면 자기 닫힘", "<testcase x=/>body</testcase>", { value: { cases: [{ classOrFile: "", name: "", result: { status: "pass" } }] } }],
  ["끝 글자: 닫는 태그 뒤에 바로 testcase", "<testcase name=\"a\"></testcase><testcase name=\"b\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }, { classOrFile: "", name: "b", result: { status: "pass" } }] } }],
  ["tag 이름 대소문자", "<TestCase name=\"a\"/><testcase name=\"b\"/>", { value: { cases: [{ classOrFile: "", name: "b", result: { status: "pass" } }] } }],
];

const JUNIT: Array<[string, ...unknown[]]> = [
  ["통과(자기 닫힘)", "<testcase name=\"a\" classname=\"A\" time=\"0.5\"/>", { value: { cases: [{ classOrFile: "A", name: "a", result: { status: "pass", durationMs: 500 } }] } }],
  ["통과(본문 있음)", "<testcase name=\"a\" classname=\"A\" time=\"0.5\"><system-out>x</system-out></testcase>", { value: { cases: [{ classOrFile: "A", name: "a", result: { status: "pass", durationMs: 500 } }] } }],
  ["통과(빈 본문)", "<testcase name=\"a\"></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }] } }],
  ["건너뜀", "<testcase name=\"a\" time=\"1\"><skipped/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip", durationMs: 1000 } }] } }],
  ["건너뜀 message 속성", "<testcase name=\"a\"><skipped message=\"x\"/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip" } }] } }],
  ["건너뜀: 단어 경계 skippedx는 아니다", "<testcase name=\"a\"><skippedx/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }] } }],
  ["건너뜀: skipped-x는 건너뜀이다", "<testcase name=\"a\"><skipped-x/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip" } }] } }],
  ["건너뜀: 본문의 어디든", "<testcase name=\"a\">text<system-out>&lt;skipped</system-out></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }] } }],
  ["건너뜀: CDATA 안의 <skipped도 센다", "<testcase name=\"a\"><![CDATA[<skipped/>]]></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip" } }] } }],
  ["건너뜀: 글 끝의 <skipped", "<testcase name=\"a\">x<skipped</testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip" } }] } }],
  ["건너뜀이 실패보다 앞선다", "<testcase name=\"a\"><failure message=\"m\">t</failure><skipped/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip" } }] } }],
  ["실패: message 속성", "<testcase name=\"a\"><failure message=\"boom\" type=\"E\">trace</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "boom", stack: ["trace"] } }] } }],
  ["실패: 본문 첫 줄이 메시지", "<testcase name=\"a\"><failure>first\nsecond\nthird</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "first", stack: ["first", "second", "third"] } }] } }],
  ["실패: message 속성이 본문보다 앞선다", "<testcase name=\"a\"><failure message=\"m\">first\nsecond</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "m", stack: ["first", "second"] } }] } }],
  ["실패: 빈 message 속성은 본문으로 넘어가지 않고 생략", "<testcase name=\"a\"><failure message=\"\">first\nsecond</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", stack: ["first", "second"] } }] } }],
  ["실패: 자기 닫힘 failure", "<testcase name=\"a\" time=\"2\"><failure message=\"m\"/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", durationMs: 2000, failureMessage: "m" } }] } }],
  ["실패: 속성 없는 자기 닫힘 failure", "<testcase name=\"a\"><failure/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail" } }] } }],
  ["실패: 빈 failure", "<testcase name=\"a\"><failure></failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail" } }] } }],
  ["실패: 공백뿐인 본문", "<testcase name=\"a\"><failure>  \n \t </failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail" } }] } }],
  ["실패: 본문 앞뒤 공백을 다듬는다", "<testcase name=\"a\"><failure>\n   at A\n   at B\n  </failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "at A", stack: ["at A", "   at B"] } }] } }],
  ["실패: 스택 4줄", "<testcase name=\"a\"><failure>1\n2\n3\n4</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "1", stack: ["1", "2", "3", "4"] } }] } }],
  ["실패: 스택 5줄(딱 상한)", "<testcase name=\"a\"><failure>1\n2\n3\n4\n5</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "1", stack: ["1", "2", "3", "4", "5"] } }] } }],
  ["실패: 스택 6줄(상한 + 1)", "<testcase name=\"a\"><failure>1\n2\n3\n4\n5\n6</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "1", stack: ["1", "2", "3", "4", "5"] } }] } }],
  ["실패: 스택 7줄", "<testcase name=\"a\"><failure>1\n2\n3\n4\n5\n6\n7</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "1", stack: ["1", "2", "3", "4", "5"] } }] } }],
  ["실패: \\r\\n 줄바꿈은 \\r이 남는다", "<testcase name=\"a\"><failure>1\r\n2\r\n3</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "1\r", stack: ["1\r", "2\r", "3"] } }] } }],
  ["실패: 본문에서 엔티티를 푼다", "<testcase name=\"a\"><failure>a &amp; b\n&lt;c&gt;</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "a & b", stack: ["a & b", "<c>"] } }] } }],
  ["실패: 본문 첫 줄이 빈 글이 되면 생략", "<testcase name=\"a\"><failure>&#10;x</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "x", stack: ["x"] } }] } }],
  ["실패: 줄 끝 글자 U+2028은 줄을 나누지 않는다", "<testcase name=\"a\"><failure>a\u2028b\nc</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "a\u2028b", stack: ["a\u2028b", "c"] } }] } }],
  ["오류도 실패다", "<testcase name=\"a\"><error message=\"E\" type=\"X\">trace</error></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "E", stack: ["trace"] } }] } }],
  ["오류: 본문만", "<testcase name=\"a\"><error>only\nbody</error></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "only", stack: ["only", "body"] } }] } }],
  ["failure가 있으면 error는 보지 않는다", "<testcase name=\"a\"><error message=\"E\">e</error><failure message=\"F\">f</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "F", stack: ["f"] } }] } }],
  ["failure가 닫히지 않으면 error를 본다", "<testcase name=\"a\"><failure message=\"F\">f<error message=\"E\">e</error></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "E", stack: ["e"] } }] } }],
  ["failures는 failure가 아니다", "<testcase name=\"a\"><failures message=\"F\">f</failures></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }] } }],
  ["errors는 error가 아니다", "<testcase name=\"a\"><errors message=\"E\">e</errors></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }] } }],
  ["failure 속성 사이 줄바꿈", "<testcase name=\"a\"><failure\nmessage=\"m\"\n>t</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "m", stack: ["t"] } }] } }],
  ["시간: 정수", "<testcase name=\"a\" time=\"3\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 3000 } }] } }],
  ["시간: 소수 반올림 0.0004", "<testcase name=\"a\" time=\"0.0004\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 0 } }] } }],
  ["시간: 0.0005는 올림", "<testcase name=\"a\" time=\"0.0005\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 1 } }] } }],
  ["시간: 0.0015", "<testcase name=\"a\" time=\"0.0015\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 2 } }] } }],
  ["시간: 1.2345", "<testcase name=\"a\" time=\"1.2345\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 1235 } }] } }],
  ["시간: 음수 -0.0004는 -0", "<testcase name=\"a\" time=\"-0.0004\"><skipped/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip", durationMs: -0 } }] } }],
  ["시간: -0.0005는 -0", "<testcase name=\"a\" time=\"-0.0005\"><skipped/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip", durationMs: -0 } }] } }],
  ["시간: -0.0015는 -1", "<testcase name=\"a\" time=\"-0.0015\"><skipped/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip", durationMs: -1 } }] } }],
  ["시간: -0.0006은 -1", "<testcase name=\"a\" time=\"-0.0006\"><skipped/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip", durationMs: -1 } }] } }],
  ["시간: 음수 통과", "<testcase name=\"a\" time=\"-2\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: -2000 } }] } }],
  ["시간: 빈 글은 0", "<testcase name=\"a\" time=\"\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 0 } }] } }],
  ["시간: 공백뿐인 글은 0", "<testcase name=\"a\" time=\"  \"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 0 } }] } }],
  ["시간: 앞뒤 공백은 무시", "<testcase name=\"a\" time=\" 2 \"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 2000 } }] } }],
  ["시간: NBSP 공백", "<testcase name=\"a\" time=\"\u00a03\u00a0\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 3000 } }] } }],
  ["시간: 지수 표기", "<testcase name=\"a\" time=\"1e3\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 1000000 } }] } }],
  ["시간: 16진 표기", "<testcase name=\"a\" time=\"0x10\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 16000 } }] } }],
  ["시간: 2진·8진 표기", "<testcase name=\"a\" time=\"0b11\"/><testcase name=\"b\" time=\"0o7\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 3000 } }, { classOrFile: "", name: "b", result: { status: "pass", durationMs: 7000 } }] } }],
  ["시간: 글자가 섞이면 NaN(통과는 생략)", "<testcase name=\"a\" time=\"abc\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }] } }],
  ["시간: NaN 건너뜀", "<testcase name=\"a\" time=\"abc\"><skipped/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip", durationMs: Number.NaN } }] } }],
  ["시간: NaN 실패", "<testcase name=\"a\" time=\"1_0\"><failure message=\"m\"/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", durationMs: Number.NaN, failureMessage: "m" } }] } }],
  ["시간: 무한대 통과는 생략", "<testcase name=\"a\" time=\"Infinity\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass" } }] } }],
  ["시간: 무한대 건너뜀", "<testcase name=\"a\" time=\"Infinity\"><skipped/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip", durationMs: Number.POSITIVE_INFINITY } }] } }],
  ["시간: 음의 무한대 실패", "<testcase name=\"a\" time=\"-Infinity\"><failure/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", durationMs: Number.NEGATIVE_INFINITY } }] } }],
  ["시간: 범위를 넘는 지수는 무한대", "<testcase name=\"a\" time=\"1e999\"><skipped/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip", durationMs: Number.POSITIVE_INFINITY } }] } }],
  ["시간: 점으로 끝나는 수", "<testcase name=\"a\" time=\"5.\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 5000 } }] } }],
  ["시간: 점으로 시작하는 수", "<testcase name=\"a\" time=\".5\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 500 } }] } }],
  ["시간: 부호", "<testcase name=\"a\" time=\"+1\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 1000 } }] } }],
  ["시간: 부호 둘은 NaN", "<testcase name=\"a\" time=\"--1\"><skipped/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip", durationMs: Number.NaN } }] } }],
  ["시간: 두 수는 NaN", "<testcase name=\"a\" time=\"1 2\"><skipped/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip", durationMs: Number.NaN } }] } }],
  ["시간: 전각 숫자는 NaN", "<testcase name=\"a\" time=\"３\"><skipped/></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "skip", durationMs: Number.NaN } }] } }],
  ["시간: 아주 큰 수", "<testcase name=\"a\" time=\"9007199254740993\"/>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "pass", durationMs: 9007199254740992000 } }] } }],
  ["여러 케이스(Gradle 모양)", "<?xml version=\"1.0\"?><testsuite name=\"com.example.OrderServiceTest\" tests=\"3\" skipped=\"1\" failures=\"1\"><testcase name=\"creates order()\" classname=\"com.example.OrderServiceTest\" time=\"0.012\"/><testcase name=\"refunds()\" classname=\"com.example.OrderServiceTest\" time=\"0\"><skipped/></testcase><testcase name=\"cancels()\" classname=\"com.example.OrderServiceTest\" time=\"0.5\"><failure message=\"expected: &lt;1&gt; but was: &lt;2&gt;\" type=\"org.opentest4j.AssertionFailedError\">org.opentest4j.AssertionFailedError: expected\n\tat A.b(A.java:1)\n\tat C.d(C.java:2)</failure></testcase></testsuite>", { value: { cases: [{ classOrFile: "com.example.OrderServiceTest", name: "creates order()", result: { status: "pass", durationMs: 12 } }, { classOrFile: "com.example.OrderServiceTest", name: "refunds()", result: { status: "skip", durationMs: 0 } }, { classOrFile: "com.example.OrderServiceTest", name: "cancels()", result: { status: "fail", durationMs: 500, failureMessage: "expected: <1> but was: <2>", stack: ["org.opentest4j.AssertionFailedError: expected", "\tat A.b(A.java:1)", "\tat C.d(C.java:2)"] } }] } }],
  ["pytest 모양", "<testsuites><testsuite name=\"pytest\" errors=\"0\" failures=\"1\" skipped=\"0\" tests=\"2\"><testcase classname=\"tests.test_orders.TestOrders\" name=\"test_creates\" time=\"0.001\"/><testcase classname=\"tests.test_orders\" name=\"test_fail\" time=\"0.002\"><failure message=\"assert 1 == 2\">def test_fail():\n&gt;       assert 1 == 2\nE       assert 1 == 2</failure></testcase></testsuite></testsuites>", { value: { cases: [{ classOrFile: "tests.test_orders.TestOrders", name: "test_creates", result: { status: "pass", durationMs: 1 } }, { classOrFile: "tests.test_orders", name: "test_fail", result: { status: "fail", durationMs: 2, failureMessage: "assert 1 == 2", stack: ["def test_fail():", ">       assert 1 == 2", "E       assert 1 == 2"] } }] } }],
  ["한글 이름", "<testcase name=\"주문을 만든다 (R7)\" classname=\"주문.테스트\"/>", { value: { cases: [{ classOrFile: "주문.테스트", name: "주문을 만든다 (R7)", result: { status: "pass" } }] } }],
  ["CDATA 본문", "<testcase name=\"a\"><failure message=\"m\"><![CDATA[at <x>\nat y]]></failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "m", stack: ["<![CDATA[at <x>", "at y]]>"] } }] } }],
  ["깨진 보고서: 잘림", "<testsuite><testcase name=\"a\" time=\"1\"><failure message=\"m\">tr", { value: { cases: [] } }],
  ["깨진 보고서: 속성 따옴표 열림", "<testcase name=\"a classname=\"b\"/>", { value: { cases: [{ classOrFile: "", name: "a classname=", result: { status: "pass" } }] } }],
  ["실패 본문 앞뒤: BOM은 다듬고 U+0085는 남긴다", "<testcase name=\"a\"><failure>\ufeff\u00a0boom\u0085\ufeff</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "boom\u0085", stack: ["boom\u0085"] } }] } }],
  ["실패 본문 줄 끝: U+0085로 끝나는 줄", "<testcase name=\"a\"><failure>first\u0085\nsecond \u2028</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "first\u0085", stack: ["first\u0085", "second"] } }] } }],
  ["실패 본문이 BOM뿐이면 비어 있다", "<testcase name=\"a\"><failure>\ufeff</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail" } }] } }],
  ["실패 본문이 U+0085뿐이면 비어 있지 않다", "<testcase name=\"a\"><failure>\u0085</failure></testcase>", { value: { cases: [{ classOrFile: "", name: "a", result: { status: "fail", failureMessage: "\u0085", stack: ["\u0085"] } }] } }],
];

const JEST_LIKE: Array<[string, ...unknown[]]> = [
  ["통과·실패·건너뜀·안 돌림", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\"},{\"title\":\"t\",\"status\":\"failed\"},{\"title\":\"t\",\"status\":\"skipped\"},{\"title\":\"t\",\"status\":\"zzz\"}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "pass" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "fail" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "skip" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "not-run" } }] } }],
  ["상태 pending·todo·disabled는 건너뜀", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"pending\"},{\"title\":\"t\",\"status\":\"todo\"},{\"title\":\"t\",\"status\":\"disabled\"}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "skip" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "skip" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "skip" } }] } }],
  ["상태 error·timedOut·공백이 붙은 값은 안 돌림", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"error\"},{\"title\":\"t\",\"status\":\"timedOut\"},{\"title\":\"t\",\"status\":\"failed \"},{\"title\":\"t\",\"status\":\" passed\"},{\"title\":\"t\",\"status\":\"skip\"}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "not-run" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "not-run" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "not-run" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "not-run" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "not-run" } }] } }],
  ["상태 대문자·빈 글·없음·수·null은 안 돌림", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"Passed\"},{\"title\":\"t\",\"status\":\"\"},{\"title\":\"t\"},{\"title\":\"t\",\"status\":5},{\"title\":\"t\",\"status\":null}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "not-run" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "not-run" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "not-run" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "not-run" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "not-run" } }] } }],
  ["시간 반올림 0.4·0.5·1.5·2.5", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\",\"duration\":0.4},{\"title\":\"t\",\"status\":\"passed\",\"duration\":0.5},{\"title\":\"t\",\"status\":\"passed\",\"duration\":1.5},{\"title\":\"t\",\"status\":\"passed\",\"duration\":2.5}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "pass", durationMs: 0 } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "pass", durationMs: 1 } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "pass", durationMs: 2 } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "pass", durationMs: 3 } }] } }],
  ["시간 음수 -0.4·-0.5·-1.5·-2.5", "{\"testResults\":[{\"assertionResults\":[{\"duration\":-0.4},{\"duration\":-0.5},{\"duration\":-1.5},{\"duration\":-2.5}]}]}", { value: { cases: [{ classOrFile: "", name: "", result: { status: "not-run", durationMs: -0 } }, { classOrFile: "", name: "", result: { status: "not-run", durationMs: -0 } }, { classOrFile: "", name: "", result: { status: "not-run", durationMs: -1 } }, { classOrFile: "", name: "", result: { status: "not-run", durationMs: -2 } }] } }],
  ["시간 0·-0·큰 수", "{\"testResults\":[{\"assertionResults\":[{\"duration\":0},{\"duration\":-0},{\"duration\":1e21},{\"duration\":0.49999999999999994}]}]}", { value: { cases: [{ classOrFile: "", name: "", result: { status: "not-run", durationMs: 0 } }, { classOrFile: "", name: "", result: { status: "not-run", durationMs: -0 } }, { classOrFile: "", name: "", result: { status: "not-run", durationMs: 1e+21 } }, { classOrFile: "", name: "", result: { status: "not-run", durationMs: 0 } }] } }],
  ["시간 무한대", "{\"testResults\":[{\"assertionResults\":[{\"duration\":1e999},{\"duration\":-1e999}]}]}", { value: { cases: [{ classOrFile: "", name: "", result: { status: "not-run", durationMs: Number.POSITIVE_INFINITY } }, { classOrFile: "", name: "", result: { status: "not-run", durationMs: Number.NEGATIVE_INFINITY } }] } }],
  ["시간이 수가 아니면 생략", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\",\"duration\":\"5\"},{\"title\":\"t\",\"status\":\"passed\",\"duration\":null},{\"title\":\"t\",\"status\":\"passed\",\"duration\":true},{\"title\":\"t\",\"status\":\"passed\"}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "pass" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "pass" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "pass" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "pass" } }] } }],
  ["실패 메시지는 failed일 때만", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"failed\",\"failureMessages\":[\"boom\\nline2\"]},{\"title\":\"t\",\"status\":\"passed\",\"failureMessages\":[\"boom\\nline2\"]},{\"title\":\"t\",\"status\":\"skipped\",\"failureMessages\":[\"x\"]}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "fail", failureMessage: "boom", stack: ["boom", "line2"] } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "pass" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "skip" } }] } }],
  ["실패 스택 4·5·6·7줄", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"failed\",\"failureMessages\":[\"1\\n2\\n3\\n4\"]},{\"title\":\"t\",\"status\":\"failed\",\"failureMessages\":[\"1\\n2\\n3\\n4\\n5\"]},{\"title\":\"t\",\"status\":\"failed\",\"failureMessages\":[\"1\\n2\\n3\\n4\\n5\\n6\"]},{\"title\":\"t\",\"status\":\"failed\",\"failureMessages\":[\"1\\n2\\n3\\n4\\n5\\n6\\n7\"]}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "fail", failureMessage: "1", stack: ["1", "2", "3", "4"] } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "fail", failureMessage: "1", stack: ["1", "2", "3", "4", "5"] } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "fail", failureMessage: "1", stack: ["1", "2", "3", "4", "5"] } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "fail", failureMessage: "1", stack: ["1", "2", "3", "4", "5"] } }] } }],
  ["실패 메시지 목록의 첫 항목만", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"failed\",\"failureMessages\":[\"first\",\"second\"]}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "fail", failureMessage: "first", stack: ["first"] } }] } }],
  ["실패 메시지가 빈 글·빈 배열·없음이면 생략", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"failed\",\"failureMessages\":[\"\"]},{\"title\":\"t\",\"status\":\"failed\",\"failureMessages\":[]},{\"title\":\"t\",\"status\":\"failed\"},{\"title\":\"t\",\"status\":\"failed\",\"failureMessages\":[null]}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "fail" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "fail" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "fail" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "fail" } }] } }],
  ["실패 메시지의 \\r\\n은 \\r이 남는다", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"failed\",\"failureMessages\":[\"a\\r\\nb\"]}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "fail", failureMessage: "a\r", stack: ["a\r", "b"] } }] } }],
  ["실패 메시지가 문자열이면 첫 글자", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"failed\",\"failureMessages\":\"oops\\nline2\"}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "fail", failureMessage: "o", stack: ["o"] } }] } }],
  ["실패 메시지가 객체면 \"0\" 키", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"failed\",\"failureMessages\":{\"0\":\"obj\\nmsg\",\"1\":\"x\"}}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "fail", failureMessage: "obj", stack: ["obj", "msg"] } }] } }],
  ["실패 메시지의 첫 항목이 문자열이 아니면 던진다", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"failed\",\"failureMessages\":[5]}]}]}", { threw: true }],
  ["실패 메시지의 첫 항목이 배열이면 던진다", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\",\"failureMessages\":[[\"a\"]]}]}]}", { threw: true }],
  ["실패 메시지가 수·null이면 없는 것", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"failed\",\"failureMessages\":5},{\"title\":\"t\",\"status\":\"failed\",\"failureMessages\":null}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "fail" } }, { classOrFile: "/a.test.ts", name: "t", result: { status: "fail" } }] } }],
  ["ancestorTitles → suitePath", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\",\"ancestorTitles\":[\"Outer\",\"Inner\"]}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", suitePath: ["Outer", "Inner"], result: { status: "pass" } }] } }],
  ["ancestorTitles의 빈 제목·공백뿐인 제목·문자열이 아닌 값은 거른다", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\",\"ancestorTitles\":[\"A\",\"\",\"  \",\"\u00a0\ufeff\",5,null,\" B \"]}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", suitePath: ["A", " B "], result: { status: "pass" } }] } }],
  ["ancestorTitles가 비면 suitePath 생략", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\",\"ancestorTitles\":[]}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "pass" } }] } }],
  ["ancestorTitles가 배열이 아니면 fullName으로", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\",\"ancestorTitles\":\"x\",\"fullName\":\"Outer t\"}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", suitePath: ["Outer"], result: { status: "pass" } }] } }],
  ["fullName이 title로 끝나면 앞부분이 묶음", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\",\"fullName\":\"Outer Inner t\"}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", suitePath: ["Outer Inner"], result: { status: "pass" } }] } }],
  ["fullName 앞부분을 다듬는다", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\",\"fullName\":\"  Outer \u00a0t\"}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", suitePath: ["Outer"], result: { status: "pass" } }] } }],
  ["fullName이 title과 같으면 묶음 없음", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\",\"fullName\":\"t\"}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "pass" } }] } }],
  ["fullName 앞부분이 공백뿐이면 묶음 없음", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\",\"fullName\":\" \\n t\"}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "pass" } }] } }],
  ["fullName이 title로 끝나지 않으면 묶음 없음", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\",\"fullName\":\"Outer other\"}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "t", result: { status: "pass" } }] } }],
  ["fullName이 title보다 짧으면 묶음 없음", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"long title\",\"status\":\"passed\",\"fullName\":\"title\"}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "long title", result: { status: "pass" } }] } }],
  ["title이 빈 글이면 fullName을 보지 않는다", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":\"\",\"status\":\"passed\",\"fullName\":\"Outer\"}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "", result: { status: "pass" } }] } }],
  ["title이 없으면 이름은 빈 글", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"status\":\"passed\",\"fullName\":\"x\"}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: "", result: { status: "pass" } }] } }],
  ["title이 수·null·배열이면 그대로 싣는다", "{\"testResults\":[{\"name\":\"/a.test.ts\",\"assertionResults\":[{\"title\":5,\"status\":\"passed\"},{\"title\":null,\"status\":\"passed\"},{\"title\":[\"x\"],\"status\":\"passed\"}]}]}", { value: { cases: [{ classOrFile: "/a.test.ts", name: 5, result: { status: "pass" } }, { classOrFile: "/a.test.ts", name: "", result: { status: "pass" } }, { classOrFile: "/a.test.ts", name: ["x"], result: { status: "pass" } }] } }],
  ["파일 이름: name", "{\"testResults\":[{\"name\":\"/n\",\"testFilePath\":\"/p\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\"}]}]}", { value: { cases: [{ classOrFile: "/n", name: "t", result: { status: "pass" } }] } }],
  ["파일 이름: testFilePath", "{\"testResults\":[{\"testFilePath\":\"/p\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\"}]}]}", { value: { cases: [{ classOrFile: "/p", name: "t", result: { status: "pass" } }] } }],
  ["파일 이름: name이 null이면 testFilePath", "{\"testResults\":[{\"name\":null,\"testFilePath\":\"/p\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\"}]}]}", { value: { cases: [{ classOrFile: "/p", name: "t", result: { status: "pass" } }] } }],
  ["파일 이름: 둘 다 null이면 빈 글", "{\"testResults\":[{\"name\":null,\"testFilePath\":null,\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\"}]}]}", { value: { cases: [{ classOrFile: "", name: "t", result: { status: "pass" } }] } }],
  ["파일 이름: 빈 name은 그대로", "{\"testResults\":[{\"name\":\"\",\"testFilePath\":\"/p\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\"}]}]}", { value: { cases: [{ classOrFile: "", name: "t", result: { status: "pass" } }] } }],
  ["파일 이름: 수", "{\"testResults\":[{\"name\":5,\"assertionResults\":[{\"title\":\"t\",\"status\":\"passed\"}]}]}", { value: { cases: [{ classOrFile: 5, name: "t", result: { status: "pass" } }] } }],
  ["여러 파일", "{\"testResults\":[{\"name\":\"a\",\"assertionResults\":[{\"title\":\"x\",\"status\":\"passed\"}]},{\"name\":\"b\",\"assertionResults\":[{\"title\":\"y\",\"status\":\"passed\"},{\"title\":\"z\",\"status\":\"passed\"}]},{\"name\":\"c\"}]}", { value: { cases: [{ classOrFile: "a", name: "x", result: { status: "pass" } }, { classOrFile: "b", name: "y", result: { status: "pass" } }, { classOrFile: "b", name: "z", result: { status: "pass" } }] } }],
  ["assertionResults가 없거나 null이면 건너뜀", "{\"testResults\":[{\"name\":\"a\"},{\"name\":\"b\",\"assertionResults\":null}]}", { value: { cases: [] } }],
  ["assertionResults가 문자열이면 글자마다 한 건", "{\"testResults\":[{\"name\":\"a\",\"assertionResults\":\"ab😀\"}]}", { value: { cases: [{ classOrFile: "a", name: "", result: { status: "not-run" } }, { classOrFile: "a", name: "", result: { status: "not-run" } }, { classOrFile: "a", name: "", result: { status: "not-run" } }] } }],
  ["assertionResults가 수면 던진다", "{\"testResults\":[{\"name\":\"a\",\"assertionResults\":5}]}", { threw: true }],
  ["assertionResults가 객체면 던진다", "{\"testResults\":[{\"name\":\"a\",\"assertionResults\":{}}]}", { threw: true }],
  ["assertionResults 항목이 null이면 던진다", "{\"testResults\":[{\"name\":\"a\",\"assertionResults\":[null]}]}", { threw: true }],
  ["assertionResults 항목이 수·문자열·배열이면 빈 케이스", "{\"testResults\":[{\"name\":\"a\",\"assertionResults\":[5,\"x\",[],true]}]}", { value: { cases: [{ classOrFile: "a", name: "", result: { status: "not-run" } }, { classOrFile: "a", name: "", result: { status: "not-run" } }, { classOrFile: "a", name: "", result: { status: "not-run" } }, { classOrFile: "a", name: "", result: { status: "not-run" } }] } }],
  ["testResults가 없거나 null", "{}", { value: { cases: [] } }],
  ["testResults가 null", "{\"testResults\":null}", { value: { cases: [] } }],
  ["testResults가 문자열이면 글자마다 빈 파일", "{\"testResults\":\"ab\"}", { value: { cases: [] } }],
  ["testResults가 수·객체·참이면 던진다", "{\"testResults\":5}", { threw: true }],
  ["testResults가 객체면 던진다", "{\"testResults\":{}}", { threw: true }],
  ["testResults가 참이면 던진다", "{\"testResults\":true}", { threw: true }],
  ["testResults 항목이 null이면 던진다", "{\"testResults\":[null]}", { threw: true }],
  ["testResults 항목이 수·문자열·배열이면 빈 파일", "{\"testResults\":[5,\"x\",[],true]}", { value: { cases: [] } }],
  ["최상위가 null이면 던진다", "null", { threw: true }],
  ["최상위가 배열·수·문자열·참이면 빈 결과", "[]", { value: { cases: [] } }],
  ["최상위가 수", "5", { value: { cases: [] } }],
  ["최상위가 문자열", "\"x\"", { value: { cases: [] } }],
  ["JSON이 아니면 빈 결과", "{oops", { value: { cases: [] } }],
  ["빈 글", "", { value: { cases: [] } }],
  ["공백뿐", "  \n", { value: { cases: [] } }],
  ["앞뒤 공백이 있는 JSON", " \n\t{\"testResults\":[]}\r\n ", { value: { cases: [] } }],
  ["BOM 붙은 JSON은 읽지 못한다", "\ufeff{\"testResults\":[]}", { value: { cases: [] } }],
  ["NBSP 붙은 JSON은 읽지 못한다", "\u00a0{\"testResults\":[]}", { value: { cases: [] } }],
  ["뒤에 글이 남으면 읽지 못한다", "{\"testResults\":[]}x", { value: { cases: [] } }],
  ["잘린 JSON", "{\"testResults\":[{\"name\":\"a\",\"assertionResults\":[{\"title\":\"t\"", { value: { cases: [] } }],
  ["중복 키는 뒤의 값", "{\"testResults\":[{\"name\":\"a\",\"name\":\"b\",\"assertionResults\":[{\"title\":\"x\",\"title\":\"y\"}]}]}", { value: { cases: [{ classOrFile: "b", name: "y", result: { status: "not-run" } }] } }],
  ["\\u 이스케이프", "{\"testResults\":[{\"name\":\"\\u0041\\ud83d\\ude00\",\"assertionResults\":[{\"title\":\"\\u00e9\"}]}]}", { value: { cases: [{ classOrFile: "A😀", name: "é", result: { status: "not-run" } }] } }],
  ["실제 Vitest 모양", "{\"numTotalTests\":2,\"testResults\":[{\"assertionResults\":[{\"ancestorTitles\":[\"OrderService\"],\"fullName\":\"OrderService creates an order\",\"status\":\"passed\",\"title\":\"creates an order\",\"duration\":3.2,\"failureMessages\":[],\"location\":{\"line\":1,\"column\":1}},{\"ancestorTitles\":[\"OrderService\",\"when cancelled\"],\"fullName\":\"OrderService when cancelled refunds\",\"status\":\"failed\",\"title\":\"refunds\",\"duration\":10.7,\"failureMessages\":[\"AssertionError: expected 1 to be 2\\n    at a.test.ts:10:5\\n    at b\"]}],\"startTime\":1,\"status\":\"failed\",\"name\":\"/work/src/order.test.ts\"}]}", { value: { cases: [{ classOrFile: "/work/src/order.test.ts", name: "creates an order", suitePath: ["OrderService"], result: { status: "pass", durationMs: 3 } }, { classOrFile: "/work/src/order.test.ts", name: "refunds", suitePath: ["OrderService", "when cancelled"], result: { status: "fail", durationMs: 11, failureMessage: "AssertionError: expected 1 to be 2", stack: ["AssertionError: expected 1 to be 2", "    at a.test.ts:10:5", "    at b"] } }] } }],
  ["실제 Jest 모양", "{\"testResults\":[{\"assertionResults\":[{\"ancestorTitles\":[\"R7.1: 목록\"],\"failureMessages\":[],\"fullName\":\"R7.1: 목록 보인다\",\"location\":null,\"status\":\"passed\",\"title\":\"보인다\"}],\"endTime\":2,\"message\":\"\",\"name\":\"/work/Order.test.js\",\"startTime\":1,\"status\":\"passed\",\"summary\":\"\"}],\"success\":true}", { value: { cases: [{ classOrFile: "/work/Order.test.js", name: "보인다", suitePath: ["R7.1: 목록"], result: { status: "pass" } }] } }],
];

const ATTACHES: Array<[string, ...unknown[]]> = [
  ["파일·이름이 하나뿐이면 바로", [{ name: "creates", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "creates", classOrFile: "/x/Order.test.ts", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "creates", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["이름이 달라 짝이 없다", [{ name: "creates", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "other", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "creates", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }] }],
  ["빈 행·빈 케이스", [], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [] }],
  ["케이스가 없다", [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [], { value: [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }] }],
  ["이름 비교는 대소문자·공백을 무시", [{ name: "  Creates   An  Order ", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "creates an order", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "  Creates   An  Order ", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["이름 비교는 NBSP·BOM·U+2028도 공백", [{ name: "a\u00a0b", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a\ufeff\u2028b", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a\u00a0b", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["이름 비교: U+0085는 공백이 아니다", [{ name: "a\u0085b", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a b", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a\u0085b", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }] }],
  ["소괄호 꼬리를 떼고 비교", [{ name: "creates()", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "creates(int, String)", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "creates()", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["대괄호 꼬리를 떼고 비교", [{ name: "creates", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "creates [1]", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "creates", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["대괄호가 소괄호 뒤에 있어도 소괄호부터 뗀다", [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a(b)[c]", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["소괄호가 대괄호 뒤에 있으면 대괄호부터 뗀다", [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a[b](c)", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["줄 끝 글자 뒤의 괄호만 뗀다", [{ name: "a(b c", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a(b\nc(d", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a(b c", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }] }],
  ["마지막 줄 끝 글자 바로 앞의 괄호는 그대로", [{ name: "a(b", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a(b\n", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a(b", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }] }],
  ["\\r이 줄 끝이다", [{ name: "a(b", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a(b\rc(d", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a(b", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }] }],
  ["U+2028이 줄 끝이다", [{ name: "a(b", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a(b\u2028c(d", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a(b", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }] }],
  ["U+0085는 줄 끝이 아니다", [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a(b\u0085c(d", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["대괄호 줄 끝", [{ name: "a[b", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a[b\nc[d", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a[b", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }] }],
  ["표시 이름으로 잇는다(이름으로 못 맞췄을 때만)", [{ name: "method", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", displayName: "R7: 목록은 (x) 보인다" }], [{ name: "R7: 목록은 (x) 보인다", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "method", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", displayName: "R7: 목록은 (x) 보인다", result: { status: "pass", durationMs: 0 } }] }],
  ["이름으로 맞으면 표시 이름은 보지 않는다", [{ name: "m", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", displayName: "other" }], [{ name: "m", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "other", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "m", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", displayName: "other", result: { status: "pass", durationMs: 0 } }] }],
  ["표시 이름은 괄호를 떼지 않는다", [{ name: "zzz", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", displayName: "a (b)" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a (b)", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "zzz", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", displayName: "a (b)", result: { status: "pass", durationMs: 1 } }] }],
  ["빈 표시 이름은 쓰지 않는다", [{ name: "zzz", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", displayName: "" }], [{ name: "", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "zzz", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", displayName: "" }] }],
  ["표시 이름이 문자열이 아니면(참인 값) 던진다", [{ name: "zzz", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", displayName: 5 }], [{ name: "", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { threw: true }],
  ["표시 이름이 0이면 쓰지 않는다", [{ name: "zzz", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", displayName: 0 }], [{ name: "", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "zzz", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", displayName: 0 }] }],
  ["이미 쓴 케이스는 다시 쓰지 않는다", [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }, { name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }, { name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }] }],
  ["같은 이름이면 앞 행이 앞 케이스를 쓴다", [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }, { name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }, { name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }, { name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 1 } }, { name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }] }],
  ["같은 이름 후보 둘: 파일 이름이 든 쪽", [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "other", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "/x/order.test.ts", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 1 } }] }],
  ["점수가 같으면 앞의 것", [{ name: "a", file: "zzz", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "p", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "q", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "zzz", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수가 같으면 앞의 것(뒤가 점수가 높지 않을 때)", [{ name: "a", file: "src/X.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "has x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "has x too", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "src/X.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["파일 이름이 빈 글이면 모두 +2", [{ name: "a", file: "", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "p", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "q", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["파일 이름 기본: 확장자를 뗀 마지막 부분", [{ name: "a", file: "a/b/Foo.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "foo.test", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "a/b/Foo.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 1 } }] }],
  ["파일 이름 기본: 역슬래시 구분", [{ name: "a", file: "a\\b\\Foo.java", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "FOO", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "a\\b\\Foo.java", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 1 } }] }],
  ["파일 이름 기본: 점으로 끝나면 그대로", [{ name: "a", file: "a/b.", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "b.", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "a/b.", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 1 } }] }],
  ["파일 이름 기본: 숨김 파일(점으로 시작)은 빈 글", [{ name: "a", file: "a/.hidden", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "a/.hidden", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["파일 이름 기본: 점이 여럿이면 마지막만 뗀다", [{ name: "a", file: "a/b.c.d", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "b.c", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "a/b.c.d", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 1 } }] }],
  ["파일 이름 기본: 구분자가 끝에 있으면 빈 글", [{ name: "a", file: "a/", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "a/", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 파일 +2가 묶음 +1보다 크다", [{ name: "a", file: "F.ts", line: 1, suitePath: ["s"], framework: "vitest" }], [{ name: "a", classOrFile: "s only", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "f only", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "F.ts", line: 1, suitePath: ["s"], framework: "vitest", result: { status: "pass", durationMs: 1 } }] }],
  ["점수: 묶음 둘(+2)과 파일(+2)은 같다(앞의 것)", [{ name: "a", file: "F.ts", line: 1, suitePath: ["s", "t"], framework: "vitest" }], [{ name: "a", classOrFile: "s t", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "f", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "F.ts", line: 1, suitePath: ["s", "t"], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 묶음 둘(+2)과 파일(+2)은 같다(앞의 것, 순서 반대)", [{ name: "a", file: "F.ts", line: 1, suitePath: ["s", "t"], framework: "vitest" }], [{ name: "a", classOrFile: "f", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "s t", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "F.ts", line: 1, suitePath: ["s", "t"], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 묶음 하나(+1)보다 파일(+2)", [{ name: "a", file: "F.ts", line: 1, suitePath: ["s"], framework: "vitest" }], [{ name: "a", classOrFile: "s", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "f", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "F.ts", line: 1, suitePath: ["s"], framework: "vitest", result: { status: "pass", durationMs: 1 } }] }],
  ["점수: 파일(+2)보다 묶음 하나가 앞이어도 파일이 이긴다", [{ name: "a", file: "F.ts", line: 1, suitePath: ["s"], framework: "vitest" }], [{ name: "a", classOrFile: "x s", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "x f", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "F.ts", line: 1, suitePath: ["s"], framework: "vitest", result: { status: "pass", durationMs: 1 } }] }],
  ["점수: 묶음 제목 대소문자 무시", [{ name: "a", file: "zz", line: 1, suitePath: ["SUITE"], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "my suite", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "zz", line: 1, suitePath: ["SUITE"], framework: "vitest", result: { status: "pass", durationMs: 1 } }] }],
  ["점수: 같은 묶음 제목이 두 번이면 두 번 센다", [{ name: "a", file: "zz", line: 1, suitePath: ["s", "s"], framework: "vitest" }], [{ name: "a", classOrFile: "f zz", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "s", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "zz", line: 1, suitePath: ["s", "s"], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 보고서 묶음 경로가 같으면 +4", [{ name: "a", file: "zz", line: 1, suitePath: ["A", "B"], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 }, suitePath: ["a", "b"] }], { value: [{ name: "a", file: "zz", line: 1, suitePath: ["A", "B"], framework: "vitest", result: { status: "pass", durationMs: 1 } }] }],
  ["점수: +4와 (+2 파일 +1 +1 묶음)은 같다(앞의 것)", [{ name: "a", file: "F.ts", line: 1, suitePath: ["s", "t"], framework: "vitest" }], [{ name: "a", classOrFile: "f s t", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 }, suitePath: ["s", "t"] }], { value: [{ name: "a", file: "F.ts", line: 1, suitePath: ["s", "t"], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: +4와 (+2 파일 +1 +1 묶음)은 같다(앞의 것, 순서 반대)", [{ name: "a", file: "F.ts", line: 1, suitePath: ["s", "t"], framework: "vitest" }], [{ name: "a", classOrFile: "y", result: { status: "pass", durationMs: 0 }, suitePath: ["s", "t"] }, { name: "a", classOrFile: "f s t", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "F.ts", line: 1, suitePath: ["s", "t"], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 묶음 경로 길이가 다르면 +4 없음(보고서가 더 짧다)", [{ name: "a", file: "zz", line: 1, suitePath: ["A", "B"], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 }, suitePath: ["a"] }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "zz", line: 1, suitePath: ["A", "B"], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 묶음 경로 길이가 다르면 +4 없음(보고서가 더 길다)", [{ name: "a", file: "zz", line: 1, suitePath: ["A"], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 }, suitePath: ["a", "b"] }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "zz", line: 1, suitePath: ["A"], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 묶음 경로 한 칸이 다르면 +4 없음", [{ name: "a", file: "zz", line: 1, suitePath: ["A", "B"], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 }, suitePath: ["a", "c"] }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "zz", line: 1, suitePath: ["A", "B"], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 첫 칸만 다르면 +4 없음", [{ name: "a", file: "zz", line: 1, suitePath: ["A", "B"], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 }, suitePath: ["c", "b"] }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "zz", line: 1, suitePath: ["A", "B"], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 묶음 경로 비교는 공백·대소문자를 무시", [{ name: "a", file: "zz", line: 1, suitePath: ["  Outer  "], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 }, suitePath: ["outer"] }], { value: [{ name: "a", file: "zz", line: 1, suitePath: ["  Outer  "], framework: "vitest", result: { status: "pass", durationMs: 1 } }] }],
  ["점수: 둘 다 빈 묶음 경로면 +4", [{ name: "a", file: "zz", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 }, suitePath: [] }], { value: [{ name: "a", file: "zz", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 1 } }] }],
  ["점수: 보고서에 묶음 경로가 없으면 +4 없음", [{ name: "a", file: "zz", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 }, suitePath: [] }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "zz", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 보고서 묶음 경로가 null이면 없는 것", [{ name: "a", file: "zz", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 }, suitePath: null }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 }, suitePath: [] }], { value: [{ name: "a", file: "zz", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 1 } }] }],
  ["점수: 보고서 묶음 경로가 문자열이고 길이가 다르면 없는 것", [{ name: "a", file: "zz", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 }, suitePath: "ab" }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "zz", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 보고서 묶음 경로가 문자열이고 길이가 같으면 던진다", [{ name: "a", file: "zz", line: 1, suitePath: ["x", "y"], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 }, suitePath: "ab" }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { threw: true }],
  ["점수: 하나뿐인 후보는 점수를 보지 않는다(파일이 숫자여도)", [{ name: "a", file: 5, line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a", file: 5, line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 후보가 여럿일 때 행의 file이 문자열이 아니면 던진다", [{ name: "a", file: null, line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { threw: true }],
  ["점수: 후보가 여럿일 때 행의 suitePath가 없으면 던진다", [{ name: "a", file: "f" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { threw: true }],
  ["점수: 후보가 여럿일 때 케이스 classOrFile이 수면 던진다", [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: 5, result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { threw: true }],
  ["점수: 묶음 제목이 문자열이 아니면 던진다", [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [5], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "y", result: { status: "pass", durationMs: 1 } }], { threw: true }],
  ["행 이름이 수면 던진다", [{ name: 5, file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { threw: true }],
  ["케이스 이름이 null이면 던진다", [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: null, classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { threw: true }],
  ["케이스 이름이 수면 던진다", [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: 5, classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { threw: true }],
  ["행의 다른 필드는 그대로, result는 덮어쓴다", [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "fail" }, extra: [1] }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 }, extra: [1] }] }],
  ["result 키가 없던 행은 끝에 붙는다", [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", displayName: "d" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", displayName: "d", result: { status: "pass", durationMs: 0 } }] }],
  ["짝이 없는 행은 같은 객체", [{ name: "zzz", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "zzz", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }] }],
  ["파일 이름 기본: 점으로 끝나면 점까지 그대로(뒤 케이스는 점 없는 b)", [{ name: "a", file: "a/b.", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "b", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "a/b.", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["파일 이름 기본: 점으로 끝나면 점까지 그대로(뒤 케이스가 b.)", [{ name: "a", file: "a/b.", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "b.", result: { status: "pass", durationMs: 1 } }], { value: [{ name: "a", file: "a/b.", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 1 } }] }],
  ["이름 앞뒤의 BOM은 공백이다", [{ name: "\ufeffa\ufeff", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "\ufeffa\ufeff", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["이름 앞의 U+0085는 공백이 아니다", [{ name: "\u0085a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "\u0085a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }] }],
  ["이름 뒤의 U+0085는 공백이 아니다", [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a\u0085", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }] }],
  ["표시 이름 앞뒤의 BOM은 공백이다", [{ name: "zzz", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", displayName: "\ufeffx y\ufeff" }], [{ name: "x y", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "zzz", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", displayName: "\ufeffx y\ufeff", result: { status: "pass", durationMs: 0 } }] }],
  ["줄 끝 글자가 둘이면 마지막 줄 끝 글자 뒤의 괄호부터 뗀다", [{ name: "a(b\nc(d\ne", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a(b\nc(d\ne(f", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a(b\nc(d\ne", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["줄 끝 글자가 둘이면(앞쪽 괄호는 남는다)", [{ name: "a(b\nc(d", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a(b\nc(d\ne(f", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "a(b\nc(d", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }] }],
  ["점수: 묶음 경로 길이가 다르면 +4 없음(보고서가 더 짧다, 평범한 후보가 앞)", [{ name: "a", file: "zz", line: 1, suitePath: ["A", "B"], framework: "vitest" }], [{ name: "a", classOrFile: "y", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "x", result: { status: "pass", durationMs: 1 }, suitePath: ["a"] }], { value: [{ name: "a", file: "zz", line: 1, suitePath: ["A", "B"], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 묶음 경로 길이가 다르면 +4 없음(보고서가 더 길다, 평범한 후보가 앞)", [{ name: "a", file: "zz", line: 1, suitePath: ["A"], framework: "vitest" }], [{ name: "a", classOrFile: "y", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "x", result: { status: "pass", durationMs: 1 }, suitePath: ["a", "b"] }], { value: [{ name: "a", file: "zz", line: 1, suitePath: ["A"], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 묶음 경로 길이가 다르면 +4 없음(행이 비었다)", [{ name: "a", file: "zz", line: 1, suitePath: [], framework: "vitest" }], [{ name: "a", classOrFile: "y", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "x", result: { status: "pass", durationMs: 1 }, suitePath: ["a"] }], { value: [{ name: "a", file: "zz", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 보고서 묶음 경로가 비었고 행은 하나(길이가 다르다)", [{ name: "a", file: "zz", line: 1, suitePath: ["A"], framework: "vitest" }], [{ name: "a", classOrFile: "y", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "x", result: { status: "pass", durationMs: 1 }, suitePath: [] }], { value: [{ name: "a", file: "zz", line: 1, suitePath: ["A"], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 묶음 경로 한 칸이 다르면 +4 없음(평범한 후보가 앞)", [{ name: "a", file: "zz", line: 1, suitePath: ["A", "B"], framework: "vitest" }], [{ name: "a", classOrFile: "y", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "x", result: { status: "pass", durationMs: 1 }, suitePath: ["a", "c"] }], { value: [{ name: "a", file: "zz", line: 1, suitePath: ["A", "B"], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["점수: 묶음 경로 첫 칸만 다르면 +4 없음(평범한 후보가 앞)", [{ name: "a", file: "zz", line: 1, suitePath: ["A", "B"], framework: "vitest" }], [{ name: "a", classOrFile: "y", result: { status: "pass", durationMs: 0 } }, { name: "a", classOrFile: "x", result: { status: "pass", durationMs: 1 }, suitePath: ["c", "b"] }], { value: [{ name: "a", file: "zz", line: 1, suitePath: ["A", "B"], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["이름 정규화: 괄호만 있는 이름", [{ name: "()", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "()", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["이름 정규화: 유니코드 소문자(터키어 İ·그리스 Σ)", [{ name: "İSTANBUL ΑΣ", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "i̇stanbul ας", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "İSTANBUL ΑΣ", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
  ["이름 정규화: 켈빈 기호", [{ name: "K", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest" }], [{ name: "k", classOrFile: "x", result: { status: "pass", durationMs: 0 } }], { value: [{ name: "K", file: "src/Order.test.ts", line: 1, suitePath: [], framework: "vitest", result: { status: "pass", durationMs: 0 } }] }],
];

const COUNTS: Array<[string, ...unknown[]]> = [
  ["빈 목록", [], { value: { pass: 0, fail: 0, skip: 0, notRun: 0 } }],
  ["모두 안 돌림", [{  }, { result: null }, { result: { status: "x" } }], { value: { pass: 0, fail: 0, skip: 0, notRun: 3 } }],
  ["통과·실패·건너뜀·안 돌림", [{ result: { status: "pass" } }, { result: { status: "fail" } }, { result: { status: "skip" } }, { result: { status: "not-run" } }], { value: { pass: 1, fail: 1, skip: 1, notRun: 1 } }],
  ["여럿", [{ result: { status: "pass" } }, { result: { status: "pass" } }, { result: { status: "fail" } }, { result: { status: "pass" } }, { result: { status: "skip" } }, { result: { status: "skip" } }], { value: { pass: 3, fail: 1, skip: 2, notRun: 0 } }],
  ["대소문자·수는 안 돌림", [{ result: { status: "PASS" } }, { result: { status: 5 } }, { result: { status: null } }, { result: {  } }], { value: { pass: 0, fail: 0, skip: 0, notRun: 4 } }],
];

const FIXES: Array<[string, ...unknown[]]> = [
  ["실패 메시지와 스택", { displayName: "creates", file: "src/a.test.ts", line: 12, result: { status: "fail", failureMessage: "boom", stack: ["at a", "at b"] } }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: creates\n위치: src/a.test.ts:12\n\n실패 메시지:\nboom\n\n스택(앞부분):\nat a\nat b" }],
  ["실패 메시지만", { displayName: "creates", file: "f", line: 1, result: { status: "fail", failureMessage: "boom" } }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: creates\n위치: f:1\n\n실패 메시지:\nboom" }],
  ["스택만", { displayName: "d", file: "f", line: 1, result: { status: "fail", stack: ["at a"] } }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: d\n위치: f:1\n\n스택(앞부분):\nat a" }],
  ["결과 없음", { displayName: "d", file: "f", line: 1 }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: d\n위치: f:1" }],
  ["결과가 null", { displayName: "d", file: "f", line: 1, result: null }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: d\n위치: f:1" }],
  ["빈 실패 메시지·빈 스택은 절을 만들지 않는다", { displayName: "d", file: "f", line: 1, result: { failureMessage: "", stack: [] } }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: d\n위치: f:1" }],
  ["스택에 null·중첩 배열", { displayName: "d", file: "f", line: 1, result: { stack: ["a", null, ["x", "y"], 5] } }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: d\n위치: f:1\n\n스택(앞부분):\na\n\nx,y\n5" }],
  ["줄 번호 0", { displayName: "d", file: "f", line: 0, result: undefined }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: d\n위치: f:0" }],
  ["줄 번호 NaN", { displayName: "d", file: "f", line: Number.NaN }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: d\n위치: f:NaN" }],
  ["줄 번호 -0", { displayName: "d", file: "f", line: -0 }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: d\n위치: f:0" }],
  ["줄 번호 1e21·소수", { displayName: "d", file: "f", line: 1e+21 }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: d\n위치: f:1e+21" }],
  ["줄 번호가 없다", { displayName: "d", file: "f" }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: d\n위치: f:undefined" }],
  ["표시 이름이 없다", { file: "f", line: 1 }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: undefined\n위치: f:1" }],
  ["표시 이름이 null", { displayName: null, file: "f", line: 1 }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: null\n위치: f:1" }],
  ["스택이 문자열이면 던진다", { displayName: "d", file: "f", line: 1, result: { stack: "text" } }, { threw: true }],
  ["스택이 빈 문자열이면 없는 것", { displayName: "d", file: "f", line: 1, result: { stack: "" } }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: d\n위치: f:1" }],
  ["스택이 length가 있는 객체면 던진다", { displayName: "d", file: "f", line: 1, result: { stack: { length: 2 } } }, { threw: true }],
  ["스택이 length가 0인 객체면 없는 것", { displayName: "d", file: "f", line: 1, result: { stack: { length: 0 } } }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: d\n위치: f:1" }],
  ["한글·줄바꿈", { displayName: "주문을\n만든다", file: "한글.ts", line: 3, result: { failureMessage: "실패\n합니다", stack: ["줄1", "줄2"] } }, { value: "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: 주문을\n만든다\n위치: 한글.ts:3\n\n실패 메시지:\n실패\n합니다\n\n스택(앞부분):\n줄1\n줄2" }],
];

const ADDS: Array<[string, ...unknown[]]> = [
  ["인수 조건만", { id: "R1", title: "제목", acceptance: ["a", "b"] }, { value: "[R1] 제목\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R1을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:\n- a\n- b" }],
  ["인수 조건 없음", { id: "R1", title: "t", acceptance: [] }, { value: "[R1] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R1을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:" }],
  ["EARS와 시나리오", { id: "R7", title: "t", acceptance: ["a"], ears: { statement: "WHEN x THE y SHALL z", pattern: "event" }, scenarios: [{ id: "R7.1", given: "g", when: "w", then: "t" }, { id: "R7.2", given: "g2", when: "w2", then: "t2" }] }, { value: "[R7] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R7을(를) 넣어 테스트를 추가해 주세요.\n\nEARS: WHEN x THE y SHALL z\n\n인수 조건:\n- a\n\n시나리오:\n- R7.1: (Given) g (When) w (Then) t\n- R7.2: (Given) g2 (When) w2 (Then) t2" }],
  ["EARS 없음", { id: "R7", title: "t", acceptance: ["a"], scenarios: [{ id: "R7.1", given: "g", when: "w", then: "t" }] }, { value: "[R7] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R7을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:\n- a\n\n시나리오:\n- R7.1: (Given) g (When) w (Then) t" }],
  ["시나리오 없음", { id: "R7", title: "t", acceptance: ["a"], ears: { statement: "s" } }, { value: "[R7] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R7을(를) 넣어 테스트를 추가해 주세요.\n\nEARS: s\n\n인수 조건:\n- a" }],
  ["시나리오 빈 목록", { id: "R7", title: "t", acceptance: ["a"], scenarios: [] }, { value: "[R7] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R7을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:\n- a" }],
  ["EARS가 빈 객체면 statement가 undefined", { id: "R7", title: "t", acceptance: [], ears: {  } }, { value: "[R7] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R7을(를) 넣어 테스트를 추가해 주세요.\n\nEARS: undefined\n\n인수 조건:" }],
  ["EARS가 null·0이면 절이 없다", { id: "R7", title: "t", acceptance: [], ears: null }, { value: "[R7] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R7을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:" }],
  ["EARS가 문자열이면 statement가 undefined", { id: "R7", title: "t", acceptance: [], ears: "x" }, { value: "[R7] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R7을(를) 넣어 테스트를 추가해 주세요.\n\nEARS: undefined\n\n인수 조건:" }],
  ["시나리오 필드가 빠지면 undefined", { id: "R7", title: "t", acceptance: [], scenarios: [{ id: "R7.1" }, { given: "g" }] }, { value: "[R7] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R7을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:\n\n시나리오:\n- R7.1: (Given) undefined (When) undefined (Then) undefined\n- undefined: (Given) g (When) undefined (Then) undefined" }],
  ["시나리오 항목이 null이면 던진다", { id: "R7", title: "t", acceptance: [], scenarios: [null] }, { threw: true }],
  ["시나리오 항목이 문자열이면 undefined", { id: "R7", title: "t", acceptance: [], scenarios: ["x"] }, { value: "[R7] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R7을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:\n\n시나리오:\n- undefined: (Given) undefined (When) undefined (Then) undefined" }],
  ["시나리오가 문자열이면 글자마다", { id: "R7", title: "t", acceptance: [], scenarios: "ab" }, { value: "[R7] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R7을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:\n\n시나리오:\n- undefined: (Given) undefined (When) undefined (Then) undefined\n- undefined: (Given) undefined (When) undefined (Then) undefined" }],
  ["시나리오가 빈 문자열이면 절이 없다", { id: "R7", title: "t", acceptance: [], scenarios: "" }, { value: "[R7] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R7을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:" }],
  ["시나리오가 length 양수인 객체면 던진다", { id: "R7", title: "t", acceptance: [], scenarios: { length: 2 } }, { threw: true }],
  ["시나리오가 length 0인 객체면 없다", { id: "R7", title: "t", acceptance: [], scenarios: { length: 0 } }, { value: "[R7] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R7을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:" }],
  ["시나리오가 수면 없다", { id: "R7", title: "t", acceptance: [], scenarios: 5 }, { value: "[R7] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R7을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:" }],
  ["인수 조건이 문자열이면 던진다", { id: "R7", title: "t", acceptance: "x" }, { threw: true }],
  ["인수 조건이 없으면 던진다", { id: "R7", title: "t" }, { threw: true }],
  ["인수 조건 항목이 수·null·중첩 배열", { id: "R7", title: "t", acceptance: [5, null, ["a", "b"], Number.NaN, -0, 1e+21] }, { value: "[R7] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R7을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:\n- 5\n- null\n- a,b\n- NaN\n- 0\n- 1e+21" }],
  ["id가 없다", { title: "t", acceptance: [] }, { value: "[undefined] t\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 undefined을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:" }],
  ["제목이 없다", { id: "R1", acceptance: [] }, { value: "[R1] undefined\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R1을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:" }],
  ["id가 수", { id: 5, title: 7, acceptance: [] }, { value: "[5] 7\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 5을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:" }],
  ["한글", { id: "R7", title: "주문", acceptance: ["목록이 보인다"], ears: { statement: "주문이 있으면 목록을 보인다" }, scenarios: [{ id: "R7.1", given: "주문", when: "열면", then: "보인다" }] }, { value: "[R7] 주문\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R7을(를) 넣어 테스트를 추가해 주세요.\n\nEARS: 주문이 있으면 목록을 보인다\n\n인수 조건:\n- 목록이 보인다\n\n시나리오:\n- R7.1: (Given) 주문 (When) 열면 (Then) 보인다" }],
];

describe('test-results 벡터(옛 TS가 낸 값)', () => {
  it.each(ENTITIES)('엔티티: %s', (_label, xml, expected) => {
    check(() => parseJUnitXml(xml as string), expected as Expected);
  });
  it.each(ATTRIBUTES)('속성: %s', (_label, xml, expected) => {
    check(() => parseJUnitXml(xml as string), expected as Expected);
  });
  it.each(ELEMENTS)('태그 찾기: %s', (_label, xml, expected) => {
    check(() => parseJUnitXml(xml as string), expected as Expected);
  });
  it.each(JUNIT)('JUnit: %s', (_label, xml, expected) => {
    check(() => parseJUnitXml(xml as string), expected as Expected);
  });
  it.each(JEST_LIKE)('Jest/Vitest: %s', (_label, json, expected) => {
    check(() => parseJestLikeJson(json as string), expected as Expected);
  });
  it.each(ATTACHES)('짝짓기: %s', (_label, rows, cases, expected) => {
    check(() => attachResults(rows as TestRow[], { cases } as ParsedTestRun), expected as Expected);
  });
  it.each(COUNTS)('개수: %s', (_label, rows, expected) => {
    check(() => countByStatus(rows as TestRow[]), expected as Expected);
  });
  it.each(FIXES)('고쳐 줘 글: %s', (_label, row, expected) => {
    check(() => buildFixTestPrefill(row as never), expected as Expected);
  });
  it.each(ADDS)('테스트 추가 글: %s', (_label, requirement, expected) => {
    check(() => buildAddTestPrefill(requirement as never), expected as Expected);
  });

  it('짝짓기: 짝이 없는 행은 같은 객체를, 짝이 있는 행은 새 객체를 돌려준다', () => {
    const a = { name: 'a', file: 'f', line: 1, suitePath: [] } as unknown as TestRow;
    const b = { name: 'b', file: 'f', line: 2, suitePath: [] } as unknown as TestRow;
    const out = attachResults([a, b], { cases: [{ name: 'a', classOrFile: 'x', result: { status: 'pass' } }] });
    expect(out[0]).not.toBe(a);
    expect(out[1]).toBe(b);
    expect(a.result).toBeUndefined();
  });

  it('짝짓기: 같은 객체가 케이스 목록에 두 번 있으면 하나를 쓴 것이 둘 다 쓴 것이다', () => {
    const shared = { name: 'a', classOrFile: 'x', result: { status: 'pass' as const, durationMs: 7 } };
    const rows = [{ name: 'a', file: 'f', line: 1, suitePath: [] }, { name: 'a', file: 'f', line: 2, suitePath: [] }] as unknown as TestRow[];
    expect(attachResults(rows, { cases: [shared, shared] }).map((row) => row.result)).toStrictEqual([{ status: 'pass', durationMs: 7 }, undefined]);
    // 같은 값을 가진 서로 다른 객체면 둘 다 쓴다
    const other = { ...shared };
    expect(attachResults(rows, { cases: [shared, other] }).map((row) => row.result)).toStrictEqual([{ status: 'pass', durationMs: 7 }, { status: 'pass', durationMs: 7 }]);
  });

  it('결과 객체의 키 순서', () => {
    const run = parseJUnitXml('<testcase name="a" classname="C" time="1"><failure message="m">t</failure></testcase>');
    expect(JSON.stringify(run)).toBe('{"cases":[{"classOrFile":"C","name":"a","result":{"status":"fail","durationMs":1000,"failureMessage":"m","stack":["t"]}}]}');
    const jest = parseJestLikeJson('{"testResults":[{"name":"f","assertionResults":[{"title":"t","status":"failed","duration":1,"ancestorTitles":["A"],"failureMessages":["x\\ny"]}]}]}');
    expect(JSON.stringify(jest)).toBe('{"cases":[{"classOrFile":"f","name":"t","suitePath":["A"],"result":{"status":"fail","durationMs":1,"failureMessage":"x","stack":["x","y"]}}]}');
    expect(JSON.stringify(countByStatus([]))).toBe('{"pass":0,"fail":0,"skip":0,"notRun":0}');
  });
});

describe('test-results 의도한 차이(옛 TS에 돌리면 실패한다)', () => {
  it('&constructor;는 엔티티가 아니다(옛 TS는 상속된 Object 함수의 글자로 바꿨다)', () => {
    const run = parseJUnitXml('<testcase name="a&constructor;b"/>');
    expect(run.cases[0]!.name).toBe('a&constructor;b');
  });

  it('엔티티가 만든 짝 없는 서로게이트는 U+FFFD가 된다(옛 TS는 홀로 선 서로게이트를 남겼다)', () => {
    expect(parseJUnitXml('<testcase name="a&#xD800;b&#xDE00;c"/>').cases[0]!.name).toBe('a�b�c');
    expect(parseJUnitXml('<testcase name="x&#xD83D;y&#xDE00;"/>').cases[0]!.name).toBe('x�y�');
  });

  it('입력의 짝 없는 서로게이트도 U+FFFD가 된다', () => {
    expect(parseJUnitXml('<testcase name="a\ud800b"/>').cases[0]!.name).toBe('a�b');
    expect(parseJestLikeJson('{"testResults":[{"name":"n","assertionResults":[{"title":"t\\ud800"}]}]}').cases[0]!.name).toBe('t�');
  });

  it('키가 NUL로 시작하는 JSON은 읽지 못한 JSON으로 본다(경계의 표시 객체와 겹치지 않게)', () => {
    const json = '{"\\u0000a":1,"testResults":[{"name":"n","assertionResults":[{"title":"t"}]}]}';
    expect(parseJestLikeJson(json).cases).toStrictEqual([]);
  });

  it('중첩이 2,000단계를 넘는 JSON은 읽지 못한 JSON으로 본다', () => {
    const deep = `{"testResults":[{"name":"n","assertionResults":[{"title":"t","x":${'['.repeat(2100)}${']'.repeat(2100)}}]}]}`;
    expect(parseJestLikeJson(deep).cases).toStrictEqual([]);
    const shallow = `{"testResults":[{"name":"n","assertionResults":[{"title":"t","x":${'['.repeat(100)}${']'.repeat(100)}}]}]}`;
    expect(parseJestLikeJson(shallow).cases).toHaveLength(1);
  });

  it('배열 안의 undefined는 JSON 경계에서 null이 된다', () => {
    const text = buildAddTestPrefill({ id: 'R1', title: 't', acceptance: ['a', undefined as unknown as string] } as never);
    expect(text.endsWith('- a\n- null')).toBe(true);
  });

  it('NUL로 시작하는 키가 든 입력은 보내지 않고 던진다', () => {
    expect(() => buildFixTestPrefill({ displayName: 'd', file: 'f', line: 1, result: { '\u0000x': 1 } } as never)).toThrow();
  });
});
