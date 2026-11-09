import { describe, expect, it } from 'vitest';
import { canRead, type Topology } from './coordination/topology';
import { noteBytes, type Note } from './coordination/notes';
import { failureNotesFromEvents, failureNotesFromReport, normalizeMessage, signatureFromCheck, signatureKey, signaturesFromReport } from './coordination/signature';
import { escalationPrompt, retryBudgetFor, shouldEscalate, shouldPromote, signatureSetKey } from './escalation';

/**
 * coordination·escalation을 Rust로 옮기면서(ADR-191 3i) JS와 Rust가 다르게 읽기 쉬운 입력을 고정한다.
 * 기대값은 옮기기 전 TS 구현이 낸 값이다(JSON.stringify 글자 — 키 순서와 선택 필드 생략 포함. 던지면 'throws').
 * 승격 판정의 경계(횟수 임계값 -1·=·+1, `>=`·`<`)와 서명 정규화(해시 6·7글자, 숫자열, 첫 줄, trim, 200자)를 한 칸씩 밟는다.
 * "의도한 차이"라고 적은 테스트만 옛 구현과 다르다. 보이지 않는 글자는 \\u 이스케이프로 적었다.
 */

interface Vector {
  fn: string;
  note: string;
  args: unknown[];
  expected: string;
}

const IMPLS: Record<string, (...args: never[]) => unknown> = {
  normalizeMessage: (text: string) => normalizeMessage(text),
  signatureKey,
  signaturesFromReport,
  signatureFromCheck,
  failureNotesFromReport,
  failureNotesFromEvents,
  signatureSetKey,
  shouldEscalate,
  shouldPromote,
  retryBudgetFor,
  escalationPrompt,
  noteBytes,
} as never;

function run(vector: Vector): string {
  try {
    const result = (IMPLS[vector.fn] as (...args: unknown[]) => unknown)(...vector.args);
    return result === undefined ? 'undefined' : JSON.stringify(result);
  } catch {
    return 'throws';
  }
}

const VECTORS: Vector[] = [
  { fn: 'normalizeMessage', note: "첫 줄만 남긴다", args: ["first line\nsecond line"], expected: "\"first line\"" },
  { fn: 'normalizeMessage', note: "앞뒤 공백을 지운다", args: ["  \t padded \t "], expected: "\"padded\"" },
  { fn: 'normalizeMessage', note: "줄 번호와 시각의 숫자열을 N으로", args: ["cannot find symbol at line 42 col 7 at 2026-11-10T12:00:00.123Z"], expected: "\"cannot find symbol at line N col N at N-N-NTN:N:N.NZ\"" },
  { fn: 'normalizeMessage', note: "숫자 6자리는 N", args: ["x 123456 y"], expected: "\"x N y\"" },
  { fn: 'normalizeMessage', note: "숫자 7자리는 H(16진 7개 이상)", args: ["x 1234567 y"], expected: "\"x H y\"" },
  { fn: 'normalizeMessage', note: "숫자 20자리는 H", args: ["x 12345678901234567890 y"], expected: "\"x H y\"" },
  { fn: 'normalizeMessage', note: "16진 글자 6개는 그대로(숫자 없음)", args: ["face and decade abcdef"], expected: "\"face and decade abcdef\"" },
  { fn: 'normalizeMessage', note: "16진 글자 7개는 H", args: ["defaced abcdefa"], expected: "\"H H\"" },
  { fn: 'normalizeMessage', note: "대문자 16진은 H(대소문자 무시)", args: ["DEADBEEF DeadBeef"], expected: "\"H H\"" },
  { fn: 'normalizeMessage', note: "16진 7개 뒤에 단어 글자가 붙으면 H가 아니다", args: ["abcdef0g deadbeefx"], expected: "\"abcdefNg deadbeefx\"" },
  { fn: 'normalizeMessage', note: "앞에 단어 글자가 붙으면 H가 아니다", args: ["xdeadbeef _deadbeef"], expected: "\"xdeadbeef _deadbeef\"" },
  { fn: 'normalizeMessage', note: "밑줄은 단어 글자라 경계를 만들지 않는다", args: ["dead_beef1234 deadbeef_"], expected: "\"dead_beefN deadbeef_\"" },
  { fn: 'normalizeMessage', note: "하이픈·점·콜론은 경계다", args: ["a-deadbeef.cafebabe:0123456"], expected: "\"a-H.H:H\"" },
  { fn: 'normalizeMessage', note: "한글 옆에서는 경계다(ASCII \\b)", args: ["해시deadbeef입니다 한글1234567끝"], expected: "\"해시H입니다 한글H끝\"" },
  { fn: 'normalizeMessage', note: "해시가 숫자만이면 N이 아니라 H", args: ["commit 0000000"], expected: "\"commit H\"" },
  { fn: 'normalizeMessage', note: "feedback·decade 같은 낱말은 그대로", args: ["feedback decade accede"], expected: "\"feedback decade accede\"" },
  { fn: 'normalizeMessage', note: "sha256 접두", args: ["sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"], expected: "\"shaN:H\"" },
  { fn: 'normalizeMessage', note: "단어 안의 숫자", args: ["abc123 a1b2c3 v2 3x 4ms"], expected: "\"abcN aNbNcN vN Nx Nms\"" },
  { fn: 'normalizeMessage', note: "경로와 줄 번호", args: ["src/app/page.tsx:42:7 /a/b/c1234567.ts"], expected: "\"src/app/page.tsx:N:N /a/b/H.ts\"" },
  { fn: 'normalizeMessage', note: "전각 숫자는 \\d가 아니다", args: ["１２３ x"], expected: "\"１２３ x\"" },
  { fn: 'normalizeMessage', note: "아라비아 인도 숫자는 \\d가 아니다", args: ["٣٤٥ x"], expected: "\"٣٤٥ x\"" },
  { fn: 'normalizeMessage', note: "전각 16진 글자는 해시가 아니다", args: ["ａｂｃｄｅｆ０ ａｂｃｄｅｆａ"], expected: "\"ａｂｃｄｅｆ０ ａｂｃｄｅｆａ\"" },
  { fn: 'normalizeMessage', note: "켈빈 기호·긴 s는 16진 글자가 아니다", args: ["ab\u212acdef \u017fabcdef0"], expected: "\"ab\u212acdef \u017fH\"" },
  { fn: 'normalizeMessage', note: "BOM을 trim이 지운다", args: ["\ufeff  text 5"], expected: "\"text N\"" },
  { fn: 'normalizeMessage', note: "NBSP를 trim이 지운다", args: ["\u00a0text 5\u00a0"], expected: "\"text N\"" },
  { fn: 'normalizeMessage', note: "U+0085는 trim이 지우지 않는다", args: ["\u0085text 5\u0085"], expected: "\"\u0085text N\u0085\"" },
  { fn: 'normalizeMessage', note: "U+2028·U+2029는 trim이 지운다", args: ["\u2028text 5\u2029"], expected: "\"text N\"" },
  { fn: 'normalizeMessage', note: "U+2028은 줄 끝이 아니다(\\n만 자른다)", args: ["a\u2028b 5\nc"], expected: "\"a\u2028b N\"" },
  { fn: 'normalizeMessage', note: "CRLF: \\n 앞의 \\r은 trim이 지운다", args: ["first 5\r\nsecond"], expected: "\"first N\"" },
  { fn: 'normalizeMessage', note: "\\n 없이 \\r만 있으면 첫 줄이 전체다", args: ["a 5\rb 6"], expected: "\"a N\\rb N\"" },
  { fn: 'normalizeMessage', note: "앞의 빈 줄이면 첫 줄이 비어 있다", args: ["\nsecond 5"], expected: "\"\"" },
  { fn: 'normalizeMessage', note: "빈 글자", args: [""], expected: "\"\"" },
  { fn: 'normalizeMessage', note: "공백만", args: [" \t\u00a0\ufeff"], expected: "\"\"" },
  { fn: 'normalizeMessage', note: "\\0 글자", args: ["a\u00005b"], expected: "\"a\\u0000Nb\"" },
  { fn: 'normalizeMessage', note: "특수 대소문자 글자는 그대로", args: ["İstanbul ΑΣ ẞ ß ǅ 12"], expected: "\"İstanbul ΑΣ ẞ ß ǅ N\"" },
  { fn: 'normalizeMessage', note: "정확히 200 코드 단위", args: ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"], expected: "\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"" },
  { fn: 'normalizeMessage', note: "201 코드 단위는 200으로", args: ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"], expected: "\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"" },
  { fn: 'normalizeMessage', note: "한글 250자", args: ["가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가"], expected: "\"가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가\"" },
  { fn: 'normalizeMessage', note: "이모지 쌍이 200 안에 끝난다", args: ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx😀tail"], expected: "\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx😀\"" },
  { fn: 'normalizeMessage', note: "이모지 쌍이 199에서 끝나 200 경계 전에 닫힌다", args: ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx😀"], expected: "\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx😀\"" },
  { fn: 'normalizeMessage', note: "앞에서 자른 뒤 숫자가 N이 된 길이(자르기는 치환 뒤)", args: ["123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890"], expected: "\"H\"" },
  { fn: 'normalizeMessage', note: "치환 뒤 길이로 자른다: 16진 해시 40자 여러 개", args: ["0123456789abcdef0123456789abcdef01234567 0123456789abcdef0123456789abcdef01234567 0123456789abcdef0123456789abcdef01234567 0123456789abcdef0123456789abcdef01234567 0123456789abcdef0123456789abcdef01234567 0123456789abcdef0123456789abcdef01234567 0123456789abcdef0123456789abcdef01234567 0123456789abcdef0123456789abcdef01234567 0123456789abcdef0123456789abcdef01234567 0123456789abcdef0123456789abcdef01234567 "], expected: "\"H H H H H H H H H H\"" },
  { fn: 'normalizeMessage', note: "치환 뒤 길이로 자른다: 숫자 덩어리 여러 개", args: ["12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 12 "], expected: "\"N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N N\"" },
  { fn: 'normalizeMessage', note: "쉼표·파이프는 그대로", args: ["a|b,c"], expected: "\"a|b,c\"" },
  { fn: 'signatureKey', note: "단계·서비스·메시지", args: [{ stage: "run", service: "api", message: "boom" }], expected: "\"run|api|boom|\"" },
  { fn: 'signatureKey', note: "서비스가 없으면 빈 글자", args: [{ stage: "sync", message: "x" }], expected: "\"sync||x|\"" },
  { fn: 'signatureKey', note: "files를 쉼표로", args: [{ stage: "secret_leak", message: "x", files: ["a.ts", "b.ts"] }], expected: "\"secret_leak||x|a.ts,b.ts\"" },
  { fn: 'signatureKey', note: "files가 빈 배열", args: [{ stage: "secret_leak", message: "x", files: [] }], expected: "\"secret_leak||x|\"" },
  { fn: 'signatureKey', note: "서비스가 빈 글자", args: [{ stage: "run", service: "", message: "x" }], expected: "\"run||x|\"" },
  { fn: 'signatureKey', note: "서비스가 null", args: [{ stage: "run", service: null, message: "x" }], expected: "\"run||x|\"" },
  { fn: 'signatureKey', note: "구분자가 값에 든 경우", args: [{ stage: "a|b", service: "c,d", message: "e|f", files: ["g,h", "i|j"] }], expected: "\"a|b|c,d|e|f|g,h,i|j\"" },
  { fn: 'signatureKey', note: "files 항목이 빈 글자·null", args: [{ stage: "a", message: "b", files: ["", null, "c"] }], expected: "\"a||b|,,c\"" },
  { fn: 'signatureKey', note: "필드 순서가 바뀌어도 키는 같다", args: [{ message: "m", files: ["f"], service: "s", stage: "st" }], expected: "\"st|s|m|f\"" },
  { fn: 'signatureKey', note: "단계가 없다", args: [{ message: "x" }], expected: "\"||x|\"" },
  { fn: 'signaturesFromReport', note: "통과한 항목만 있으면 비어 있다", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "web", ready: true }], contracts: [{ service: "web", changes: [] }], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[]" },
  { fn: 'signaturesFromReport', note: "준비 못 한 서비스: 오류 메시지", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "api", ready: false, error: "cannot find symbol at line 42" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"run\",\"service\":\"api\",\"message\":\"cannot find symbol at line N\"}]" },
  { fn: 'signaturesFromReport', note: "오류가 없으면 logTail 첫 줄", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "api", ready: false, logTail: ["first 1", "second 2"] }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"run\",\"service\":\"api\",\"message\":\"first N\"}]" },
  { fn: 'signaturesFromReport', note: "오류도 logTail도 없으면 기본 문구", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "api", ready: false }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"run\",\"service\":\"api\",\"message\":\"서비스를 준비하지 못했습니다\"}]" },
  { fn: 'signaturesFromReport', note: "logTail이 빈 배열이면 기본 문구", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "api", ready: false, logTail: [] }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"run\",\"service\":\"api\",\"message\":\"서비스를 준비하지 못했습니다\"}]" },
  { fn: 'signaturesFromReport', note: "오류가 빈 글자이면 빈 글자(??는 빈 글자를 넘기지 않는다)", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "api", ready: false, error: "", logTail: ["x"] }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"run\",\"service\":\"api\",\"message\":\"\"}]" },
  { fn: 'signaturesFromReport', note: "ready가 true이면 오류가 있어도 건너뛴다", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "api", ready: true, error: "x" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[]" },
  { fn: 'signaturesFromReport', note: "통과한 서비스와 섞인 순서", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "a", ready: false, error: "e1" }, { service: "b", ready: true }, { service: "c", ready: false, error: "e2" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"run\",\"service\":\"a\",\"message\":\"eN\"},{\"stage\":\"run\",\"service\":\"c\",\"message\":\"eN\"}]" },
  { fn: 'signaturesFromReport', note: "계약: 호환을 깨는 변경만", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [{ service: "api", changes: [{ kind: "property-removed", target: "Order.memo", breaking: true }, { kind: "property-added", target: "Order.note", breaking: false }] }], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"contract_check\",\"service\":\"api\",\"message\":\"property-removed Order.memo\"}]" },
  { fn: 'signaturesFromReport', note: "계약: 여러 변경을 \"; \"로 잇고 detail은 \": \"로", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [{ service: "api", changes: [{ kind: "a", target: "T1", breaking: true, detail: "because 5" }, { kind: "b", target: "T2", breaking: true }, { kind: "c", target: "T3", breaking: true, detail: "" }] }], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"contract_check\",\"service\":\"api\",\"message\":\"a TN: because N; b TN; c TN\"}]" },
  { fn: 'signaturesFromReport', note: "계약: 호환을 깨지 않는 변경만이면 서명 없음", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [{ service: "api", changes: [{ kind: "a", target: "T", breaking: false }] }], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[]" },
  { fn: 'signaturesFromReport', note: "계약: 오류가 있으면 오류", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [{ service: "api", changes: [], error: "spec parse failed at 3" }], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"contract_check\",\"service\":\"api\",\"message\":\"spec parse failed at N\"}]" },
  { fn: 'signaturesFromReport', note: "계약: 오류와 깨는 변경이 함께면 오류가 이긴다", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [{ service: "api", changes: [{ kind: "a", target: "T", breaking: true }], error: "err 9" }], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"contract_check\",\"service\":\"api\",\"message\":\"err N\"}]" },
  { fn: 'signaturesFromReport', note: "계약: 오류가 빈 글자이고 깨는 변경이 있으면 빈 메시지", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [{ service: "api", changes: [{ kind: "a", target: "T", breaking: true }], error: "" }], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"contract_check\",\"service\":\"api\",\"message\":\"\"}]" },
  { fn: 'signaturesFromReport', note: "계약: 오류가 빈 글자이고 깨는 변경이 없으면 건너뛴다", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [{ service: "api", changes: [], error: "" }], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[]" },
  { fn: 'signaturesFromReport', note: "반영 실패", args: [{ ok: false, sync: { error: "파일 반영 실패 3" }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"sync\",\"message\":\"파일 반영 실패 N\"}]" },
  { fn: 'signaturesFromReport', note: "반영 실패와 platform 표시", args: [{ ok: false, sync: { error: "x", platform: true }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"sync\",\"message\":\"x\"}]" },
  { fn: 'signaturesFromReport', note: "시크릿 검출: 파일과 이름만", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [{ file: "api/app.yaml", secrets: ["DATABASE_PASSWORD", "TOKEN_2"] }], skippedOff: [] }], expected: "[{\"stage\":\"secret_leak\",\"message\":\"api/app.yaml: DATABASE_PASSWORD, TOKEN_N\",\"files\":[\"api/app.yaml\"]}]" },
  { fn: 'signaturesFromReport', note: "시크릿 검출: 이름이 없다", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [{ file: "a.env", secrets: [] }], skippedOff: [] }], expected: "[{\"stage\":\"secret_leak\",\"message\":\"a.env:\",\"files\":[\"a.env\"]}]" },
  { fn: 'signaturesFromReport', note: "네 종류가 한 보고서에: 순서", args: [{ ok: false, sync: { error: "s" }, restarted: [{ service: "r", ready: false, error: "e" }], contracts: [{ service: "c", changes: [], error: "ce" }], unverifiedFiles: [], secretLeaks: [{ file: "f", secrets: ["K"] }], skippedOff: [] }], expected: "[{\"stage\":\"run\",\"service\":\"r\",\"message\":\"e\"},{\"stage\":\"contract_check\",\"service\":\"c\",\"message\":\"ce\"},{\"stage\":\"sync\",\"message\":\"s\"},{\"stage\":\"secret_leak\",\"message\":\"f: K\",\"files\":[\"f\"]}]" },
  { fn: 'signaturesFromReport', note: "메시지가 200자를 넘는다", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "r", ready: false, error: "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"run\",\"service\":\"r\",\"message\":\"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\"}]" },
  { fn: 'signaturesFromReport', note: "여러 줄 오류는 첫 줄", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "r", ready: false, error: "line one 1\nline two 2" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"run\",\"service\":\"r\",\"message\":\"line one N\"}]" },
  { fn: 'signaturesFromReport', note: "해시가 든 오류", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "r", ready: false, error: "image sha256:deadbeefcafe failed at 1234567" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"run\",\"service\":\"r\",\"message\":\"image shaN:H failed at H\"}]" },
  { fn: 'signaturesFromReport', note: "서비스 이름이 없다", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ ready: false, error: "x" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"run\",\"message\":\"x\"}]" },
  { fn: 'signaturesFromReport', note: "경로에 \\r·한글", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [{ file: "한글/파일 12.ts", secrets: ["비밀"] }], skippedOff: [] }], expected: "[{\"stage\":\"secret_leak\",\"message\":\"한글/파일 N.ts: 비밀\",\"files\":[\"한글/파일 12.ts\"]}]" },
  { fn: 'signaturesFromReport', note: "restarted가 null이면 던진다", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: null, contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "throws" },
  { fn: 'signaturesFromReport', note: "contracts의 changes가 없으면 던진다", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [{ service: "a" }], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "throws" },
  { fn: 'signaturesFromReport', note: "오류가 숫자이면 던진다(.split)", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "a", ready: false, error: 5 }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "throws" },
  { fn: 'signaturesFromReport', note: "sync가 null이면 던진다(in)", args: [{ ok: false, sync: null, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "throws" },
  { fn: 'signaturesFromReport', note: "sync가 숫자이면 던진다(in)", args: [{ ok: false, sync: 5, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "throws" },
  { fn: 'signaturesFromReport', note: "secrets가 없으면 던진다", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [{ file: "a" }], skippedOff: [] }], expected: "throws" },
  { fn: 'signaturesFromReport', note: "restarted가 문자열이면 글자마다 준비 못 한 것으로 읽는다", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: "ab", contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"run\",\"message\":\"서비스를 준비하지 못했습니다\"},{\"stage\":\"run\",\"message\":\"서비스를 준비하지 못했습니다\"}]" },
  { fn: 'signaturesFromReport', note: "logTail이 문자열이면 첫 글자", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "a", ready: false, logTail: "xyz" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }], expected: "[{\"stage\":\"run\",\"service\":\"a\",\"message\":\"x\"}]" },
  { fn: 'signatureFromCheck', note: "detail이 있다", args: [{ stage: "test", name: "web-lint", ok: false, attempts: 1, detail: "eslint found 3 problems" }], expected: "{\"stage\":\"test\",\"message\":\"eslint found N problems\"}" },
  { fn: 'signatureFromCheck', note: "detail이 없으면 이름", args: [{ stage: "review", name: "review", ok: false, attempts: 1 }], expected: "{\"stage\":\"review\",\"message\":\"review\"}" },
  { fn: 'signatureFromCheck', note: "detail이 빈 글자이면 빈 메시지", args: [{ stage: "review", name: "review", ok: false, attempts: 1, detail: "" }], expected: "{\"stage\":\"review\",\"message\":\"\"}" },
  { fn: 'signatureFromCheck', note: "이름의 숫자도 정규화", args: [{ stage: "browser_check", name: "api /orders 42", ok: false, attempts: 1 }], expected: "{\"stage\":\"browser_check\",\"message\":\"api /orders N\"}" },
  { fn: 'signatureFromCheck', note: "여러 줄 detail", args: [{ stage: "browser_check", name: "n", ok: false, attempts: 1, detail: "렌더링된 화면에 '주문 목록'가 없습니다\n자세히 12" }], expected: "{\"stage\":\"browser_check\",\"message\":\"렌더링된 화면에 '주문 목록'가 없습니다\"}" },
  { fn: 'signatureFromCheck', note: "detail이 null이면 이름", args: [{ stage: "test", name: "nm", ok: false, attempts: 1, detail: null }], expected: "{\"stage\":\"test\",\"message\":\"nm\"}" },
  { fn: 'signatureFromCheck', note: "이름도 detail도 없으면 던진다", args: [{ stage: "test", ok: false, attempts: 1 }], expected: "throws" },
  { fn: 'failureNotesFromReport', note: "보고서와 실패한 확인만", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "api", ready: false, error: "boom 42" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }, [{ stage: "test", name: "web-lint", ok: false, attempts: 1, detail: "eslint found 3 problems" }, { stage: "review", name: "review", ok: true, attempts: 1 }]], expected: "[{\"kind\":\"failure\",\"body\":\"[run api] boom N\",\"refs\":[]},{\"kind\":\"failure\",\"body\":\"[test] eslint found N problems\",\"refs\":[]}]" },
  { fn: 'failureNotesFromReport', note: "시크릿 검출은 refs에 파일", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [{ file: "api/app.yaml", secrets: ["DATABASE_PASSWORD"] }], skippedOff: [] }, []], expected: "[{\"kind\":\"failure\",\"body\":\"[secret_leak] api/app.yaml: DATABASE_PASSWORD\",\"refs\":[\"api/app.yaml\"]}]" },
  { fn: 'failureNotesFromReport', note: "실패가 없으면 빈 목록", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }, []], expected: "[]" },
  { fn: 'failureNotesFromReport', note: "서비스 이름이 있는 단계는 \"단계 서비스\"", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [{ service: "web", changes: [], error: "x" }], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }, []], expected: "[{\"kind\":\"failure\",\"body\":\"[contract_check web] x\",\"refs\":[]}]" },
  { fn: 'failureNotesFromReport', note: "서비스 이름이 빈 글자이면 단계만", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "", ready: false, error: "x" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }, []], expected: "[{\"kind\":\"failure\",\"body\":\"[run] x\",\"refs\":[]}]" },
  { fn: 'failureNotesFromReport', note: "확인 순서는 보고서 서명 뒤", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "a", ready: false, error: "r" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }, [{ stage: "test", name: "a", ok: false, attempts: 1, detail: "ta" }, { stage: "review", name: "b", ok: false, attempts: 1, detail: "rb" }]], expected: "[{\"kind\":\"failure\",\"body\":\"[run a] r\",\"refs\":[]},{\"kind\":\"failure\",\"body\":\"[test] ta\",\"refs\":[]},{\"kind\":\"failure\",\"body\":\"[review] rb\",\"refs\":[]}]" },
  { fn: 'failureNotesFromReport', note: "확인 목록이 null이면 던진다", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }, null], expected: "throws" },
  { fn: 'failureNotesFromEvents', note: "검증 결과와 실패한 확인만", args: [[{ type: "log" }, { type: "agent", event: { type: "verify_result", report: { ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "api", ready: false, error: "boom 42" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] } } }, { type: "agent", event: { type: "workflow_check", check: { stage: "test", name: "web-lint", ok: false, attempts: 1, detail: "eslint found 3 problems" } } }, { type: "agent", event: { type: "workflow_check", check: { stage: "review", name: "review", ok: true, attempts: 1 } } }, { type: "agent", event: { type: "text" } }, { type: "snapshot" }]], expected: "[{\"kind\":\"failure\",\"body\":\"[run api] boom N\",\"refs\":[]},{\"kind\":\"failure\",\"body\":\"[test] eslint found N problems\",\"refs\":[]}]" },
  { fn: 'failureNotesFromEvents', note: "report가 없는 verify_result와 check가 없는 workflow_check", args: [[{ type: "agent", event: { type: "verify_result" } }, { type: "agent", event: { type: "workflow_check" } }]], expected: "[]" },
  { fn: 'failureNotesFromEvents', note: "event가 거짓 값이면 건너뛴다", args: [[{ type: "a", event: null }, { type: "a", event: 0 }, { type: "a", event: "" }]], expected: "[]" },
  { fn: 'failureNotesFromEvents', note: "빈 목록", args: [[]], expected: "[]" },
  { fn: 'failureNotesFromEvents', note: "이벤트가 null이면 던진다", args: [[null]], expected: "throws" },
  { fn: 'failureNotesFromEvents', note: "verify_result의 report 모양이 어긋나면 던진다", args: [[{ type: "a", event: { type: "verify_result", report: { restarted: null } } }]], expected: "throws" },
  { fn: 'signatureSetKey', note: "보고서도 확인도 없다", args: [undefined, []], expected: "\"\"" },
  { fn: 'signatureSetKey', note: "같은 실패 둘은 한 번", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "a", ready: false, error: "x 1" }, { service: "a", ready: false, error: "x 2" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }, undefined], expected: "\"run|a|x N|\"" },
  { fn: 'signatureSetKey', note: "정렬한다", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "b", ready: false, error: "x" }, { service: "a", ready: false, error: "y" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }, [{ stage: "test", name: "n", ok: false, attempts: 1, detail: "z" }]], expected: "\"run|a|y|\\nrun|b|x|\\ntest||z|\"" },
  { fn: 'signatureSetKey', note: "입력 순서가 달라도 같은 글자", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "a", ready: false, error: "y" }, { service: "b", ready: false, error: "x" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }, [{ stage: "test", name: "n", ok: false, attempts: 1, detail: "z" }]], expected: "\"run|a|y|\\nrun|b|x|\\ntest||z|\"" },
  { fn: 'signatureSetKey', note: "통과한 확인은 넣지 않는다", args: [undefined, [{ stage: "test", name: "n", ok: true, attempts: 1, detail: "z" }, { stage: "test", name: "m", ok: false, attempts: 1, detail: "w" }]], expected: "\"test||w|\"" },
  { fn: 'signatureSetKey', note: "줄 번호만 다른 실패는 같은 키", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "a", ready: false, error: "err at line 10" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }, undefined], expected: "\"run|a|err at line N|\"" },
  { fn: 'signatureSetKey', note: "줄 번호만 다른 실패는 같은 키(둘째)", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "a", ready: false, error: "err at line 99" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }, undefined], expected: "\"run|a|err at line N|\"" },
  { fn: 'signatureSetKey', note: "UTF-16 순서: 한글·서로게이트 쌍·BMP 끝 글자", args: [{ ok: false, sync: { elapsedMs: 1 }, restarted: [{ service: "가", ready: false, error: "a" }, { service: "😀", ready: false, error: "a" }, { service: "～", ready: false, error: "a" }, { service: "z", ready: false, error: "a" }, { service: "", ready: false, error: "a" }], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }, undefined], expected: "\"run|z|a|\\nrun|가|a|\\nrun|😀|a|\\nrun||a|\\nrun|～|a|\"" },
  { fn: 'signatureSetKey', note: "보고서가 null", args: [null, [{ stage: "test", name: "n", ok: false, attempts: 1, detail: "w" }]], expected: "\"test||w|\"" },
  { fn: 'signatureSetKey', note: "확인 목록이 문자열이면 글자마다", args: [undefined, "ab"], expected: "throws" },
  { fn: 'signatureSetKey', note: "확인 목록이 빈 문자열", args: [undefined, ""], expected: "\"\"" },
  { fn: 'signatureSetKey', note: "확인에 이름이 없으면 던진다", args: [undefined, [{ stage: "x", ok: false }]], expected: "throws" },
  { fn: 'shouldEscalate', note: "두 번 같다", args: [["a", "a"], 2], expected: "true" },
  { fn: 'shouldEscalate', note: "두 번 다르다", args: [["a", "b"], 2], expected: "false" },
  { fn: 'shouldEscalate', note: "앞이 다르고 뒤 둘이 같다", args: [["a", "b", "b"], 2], expected: "true" },
  { fn: 'shouldEscalate', note: "뒤 둘이 다르다", args: [["a", "a", "b"], 2], expected: "false" },
  { fn: 'shouldEscalate', note: "기록이 times보다 한 개 짧다", args: [["a"], 2], expected: "false" },
  { fn: 'shouldEscalate', note: "기록이 times와 같고 모두 같다", args: [["a", "a", "a"], 3], expected: "true" },
  { fn: 'shouldEscalate', note: "기록이 times와 같고 하나 다르다", args: [["a", "b", "a"], 3], expected: "false" },
  { fn: 'shouldEscalate', note: "times가 기록보다 크다", args: [["a", "a"], 3], expected: "false" },
  { fn: 'shouldEscalate', note: "빈 기록", args: [[], 2], expected: "false" },
  { fn: 'shouldEscalate', note: "times 1에 기록 한 개", args: [["a"], 1], expected: "true" },
  { fn: 'shouldEscalate', note: "times 1에 기록 둘(마지막만 본다)", args: [["a", "b"], 1], expected: "true" },
  { fn: 'shouldEscalate', note: "times 0", args: [["a"], 0], expected: "false" },
  { fn: 'shouldEscalate', note: "times -1", args: [["a", "a"], -1], expected: "false" },
  { fn: 'shouldEscalate', note: "times 0.5", args: [["a"], 0.5], expected: "false" },
  { fn: 'shouldEscalate', note: "times 1.5(정수가 아니라 history[소수]가 undefined)", args: [["a", "a"], 1.5], expected: "false" },
  { fn: 'shouldEscalate', note: "times 2.5", args: [["a", "a", "a"], 2.5], expected: "false" },
  { fn: 'shouldEscalate', note: "times NaN은 반복문이 돌지 않아 참", args: [["a", "b"], Number.NaN], expected: "true" },
  { fn: 'shouldEscalate', note: "times NaN에 빈 기록도 참", args: [[], Number.NaN], expected: "true" },
  { fn: 'shouldEscalate', note: "times Infinity", args: [["a", "a"], Number.POSITIVE_INFINITY], expected: "false" },
  { fn: 'shouldEscalate', note: "times 1e9", args: [["a"], 1000000000], expected: "false" },
  { fn: 'shouldEscalate', note: "빈 글자 서명이 이어진다", args: [["", ""], 2], expected: "true" },
  { fn: 'shouldEscalate', note: "긴 기록의 끝 셋", args: [["x", "y", "q", "q", "q"], 3], expected: "true" },
  { fn: 'shouldEscalate', note: "긴 기록의 끝 셋이 다르다", args: [["x", "y", "q", "r", "q"], 3], expected: "false" },
  { fn: 'shouldPromote', note: "기본 2번: 같은 서명이 두 번", args: [{ to: "m" }, ["a", "a"]], expected: "true" },
  { fn: 'shouldPromote', note: "기본 2번: 한 번뿐", args: [{ to: "m" }, ["a"]], expected: "false" },
  { fn: 'shouldPromote', note: "기본 2번: 두 번 다르다", args: [{ to: "m" }, ["a", "b"]], expected: "false" },
  { fn: 'shouldPromote', note: "times 3: 두 번만", args: [{ to: "m", sameSignatureTimes: 3 }, ["a", "a"]], expected: "false" },
  { fn: 'shouldPromote', note: "times 3: 세 번", args: [{ to: "m", sameSignatureTimes: 3 }, ["a", "a", "a"]], expected: "true" },
  { fn: 'shouldPromote', note: "afterFailures 2: 기록 2(경계 =)", args: [{ to: "m", afterFailures: 2 }, ["a", "b"]], expected: "true" },
  { fn: 'shouldPromote', note: "afterFailures 3: 기록 2(경계 -1)", args: [{ to: "m", afterFailures: 3 }, ["a", "b"]], expected: "false" },
  { fn: 'shouldPromote', note: "afterFailures 3: 기록 3", args: [{ to: "m", afterFailures: 3 }, ["a", "b", "c"]], expected: "true" },
  { fn: 'shouldPromote', note: "afterFailures 3: 기록 4(경계 +1)", args: [{ to: "m", afterFailures: 3 }, ["a", "b", "c", "d"]], expected: "true" },
  { fn: 'shouldPromote', note: "afterFailures 0: 빈 기록(0 >= 0)", args: [{ to: "m", afterFailures: 0 }, []], expected: "true" },
  { fn: 'shouldPromote', note: "afterFailures 1: 기록 1", args: [{ to: "m", afterFailures: 1 }, ["a"]], expected: "true" },
  { fn: 'shouldPromote', note: "afterFailures가 NaN이면 거짓", args: [{ to: "m", afterFailures: Number.NaN }, ["a", "b"]], expected: "false" },
  { fn: 'shouldPromote', note: "afterFailures 2.5: 기록 3", args: [{ to: "m", afterFailures: 2.5 }, ["a", "b", "c"]], expected: "true" },
  { fn: 'shouldPromote', note: "afterFailures 2.5: 기록 2", args: [{ to: "m", afterFailures: 2.5 }, ["a", "b"]], expected: "false" },
  { fn: 'shouldPromote', note: "afterFailures Infinity", args: [{ to: "m", afterFailures: Number.POSITIVE_INFINITY }, ["a", "b"]], expected: "false" },
  { fn: 'shouldPromote', note: "afterFailures -1", args: [{ to: "m", afterFailures: -1 }, []], expected: "true" },
  { fn: 'shouldPromote', note: "afterFailures 없음이고 서명이 달라도 승격 없음", args: [{ to: "m", sameSignatureTimes: 5 }, ["a", "b", "c"]], expected: "false" },
  { fn: 'shouldPromote', note: "두 규칙의 OR", args: [{ to: "m", afterFailures: 5, sameSignatureTimes: 2 }, ["a", "a"]], expected: "true" },
  { fn: 'shouldPromote', note: "sameSignatureTimes NaN이면 승격", args: [{ to: "m", sameSignatureTimes: Number.NaN }, ["a", "b"]], expected: "true" },
  { fn: 'shouldPromote', note: "sameSignatureTimes 0이면 서명 규칙 없음", args: [{ to: "m", sameSignatureTimes: 0 }, ["a", "a"]], expected: "false" },
  { fn: 'shouldPromote', note: "sameSignatureTimes 1.5이면 서명 규칙 없음", args: [{ to: "m", sameSignatureTimes: 1.5 }, ["a", "a"]], expected: "false" },
  { fn: 'retryBudgetFor', note: "정책에 없으면 기본 2", args: [{ to: "m" }], expected: "2" },
  { fn: 'retryBudgetFor', note: "4", args: [{ to: "m", retryBudget: 4 }], expected: "4" },
  { fn: 'retryBudgetFor', note: "0은 예산 없음", args: [{ to: "m", retryBudget: 0 }], expected: "0" },
  { fn: 'retryBudgetFor', note: "-1", args: [{ to: "m", retryBudget: -1 }], expected: "0" },
  { fn: 'retryBudgetFor', note: "2.9는 내림", args: [{ to: "m", retryBudget: 2.9 }], expected: "2" },
  { fn: 'retryBudgetFor', note: "0.5는 내림해서 0", args: [{ to: "m", retryBudget: 0.5 }], expected: "0" },
  { fn: 'retryBudgetFor', note: "1은 1", args: [{ to: "m", retryBudget: 1 }], expected: "1" },
  { fn: 'retryBudgetFor', note: "NaN은 0", args: [{ to: "m", retryBudget: Number.NaN }], expected: "0" },
  { fn: 'retryBudgetFor', note: "Infinity는 0", args: [{ to: "m", retryBudget: Number.POSITIVE_INFINITY }], expected: "0" },
  { fn: 'retryBudgetFor', note: "-Infinity는 0", args: [{ to: "m", retryBudget: Number.NEGATIVE_INFINITY }], expected: "0" },
  { fn: 'retryBudgetFor', note: "1e21은 그대로", args: [{ to: "m", retryBudget: 1e+21 }], expected: "1e+21" },
  { fn: 'retryBudgetFor', note: "5e-324는 0", args: [{ to: "m", retryBudget: 5e-324 }], expected: "0" },
  { fn: 'escalationPrompt', note: "피드백이 있다", args: ["요약", "실패 12"], expected: "\"요약\\n\\n직전 검증 결과를 다시 보냅니다.\\n\\n실패 12\"" },
  { fn: 'escalationPrompt', note: "피드백이 없다", args: ["요약", undefined], expected: "\"요약\"" },
  { fn: 'escalationPrompt', note: "피드백이 빈 글자", args: ["요약", ""], expected: "\"요약\"" },
  { fn: 'escalationPrompt', note: "요약이 비어 있다", args: ["", "실패"], expected: "\"\\n\\n직전 검증 결과를 다시 보냅니다.\\n\\n실패\"" },
  { fn: 'escalationPrompt', note: "줄바꿈이 든 글자", args: ["a\n", "\nb"], expected: "\"a\\n\\n\\n직전 검증 결과를 다시 보냅니다.\\n\\n\\nb\"" },
  { fn: 'noteBytes', note: "빈 글자", args: [""], expected: "0" },
  { fn: 'noteBytes', note: "ASCII", args: ["abc"], expected: "3" },
  { fn: 'noteBytes', note: "한글 3바이트", args: ["한글"], expected: "6" },
  { fn: 'noteBytes', note: "이모지 4바이트", args: ["😀"], expected: "4" },
  { fn: 'noteBytes', note: "2바이트", args: ["é"], expected: "2" },
  { fn: 'noteBytes', note: "NUL", args: ["\u0000"], expected: "1" },
  { fn: 'noteBytes', note: "BOM 3바이트", args: ["\ufeff"], expected: "3" },
  { fn: 'noteBytes', note: "U+2028", args: ["\u2028"], expected: "3" },
  { fn: 'noteBytes', note: "2048 경계", args: ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"], expected: "2048" },
  { fn: 'noteBytes', note: "혼합", args: ["a한😀é"], expected: "10" },
];
const CAN_READ_BITS = '111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111000000000000111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111000001000001111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111000000000000111111111111111111111111111111111111';

describe('벡터: 옛 TS 구현이 낸 값과 같은 글자를 낸다', () => {
  it('벡터 수와 함수별 분포', () => {
    const counts = new Map<string, number>();
    for (const vector of VECTORS) counts.set(vector.fn, (counts.get(vector.fn) ?? 0) + 1);
    expect(VECTORS.length).toBeGreaterThanOrEqual(190);
    for (const fn of Object.keys(IMPLS)) expect(counts.get(fn) ?? 0, fn).toBeGreaterThanOrEqual(5);
    // 던지는 벡터와 값을 내는 벡터가 모두 있다
    expect(VECTORS.some((vector) => vector.expected === 'throws')).toBe(true);
    expect(VECTORS.filter((vector) => vector.expected !== 'throws').length).toBeGreaterThan(150);
  });

  for (const vector of VECTORS) {
    it(`${vector.fn}: ${vector.note}`, () => {
      expect(run(vector)).toBe(vector.expected);
    });
  }

  it('canRead: topology·허브·작성자·레인·그룹의 모든 조합(576개)이 옛 구현과 같다', () => {
    const bits: string[] = [];
    for (const topology of ['star', 'hierarchical', 'mesh', 'ring'])
      for (const readerLane of ['hub', 'a'])
        for (const by of ['model', 'platform'] as const)
          for (const noteLane of ['hub', 'a', 'b'])
            for (const readerGroup of [undefined, 'g', ''])
              for (const noteGroup of [undefined, 'g', 'h', '']) {
                const note = { id: 'n', kind: 'fact', body: 'x', refs: [], author: { lane: noteLane, by }, ...(noteGroup === undefined ? {} : { group: noteGroup }), priority: 1, at: 't' } as Note;
                bits.push(canRead(topology as Topology, { lane: readerLane, ...(readerGroup === undefined ? {} : { group: readerGroup }) }, note, 'hub') ? '1' : '0');
              }
    expect(bits.join('')).toBe(CAN_READ_BITS);
    // 참과 거짓이 모두 충분히 있다(표가 한쪽으로 쏠리지 않았다)
    expect(CAN_READ_BITS.split('1').length - 1).toBeGreaterThan(100);
    expect(CAN_READ_BITS.split('0').length - 1).toBeGreaterThan(30);
  });

  it('noteBytes: 짝 없는 서로게이트는 Buffer.byteLength와 같이 3바이트다', () => {
    expect(noteBytes('\uD800')).toBe(Buffer.byteLength('\uD800', 'utf8'));
    expect(noteBytes('\uD800')).toBe(3);
  });
});

describe('의도한 차이: 옛 TS 구현과 다르다', () => {
  // 옛 구현이 낸 값은 각 테스트의 주석에 적었다
  it('200자 경계가 서로게이트 쌍을 가르면 짝 없는 서로게이트가 아니라 U+FFFD가 된다', () => {
    // 옛: 'x' * 199 + '\ud83d'(짝 없는 앞 절반). Rust 문자열은 짝 없는 서로게이트를 담지 못하고 Node 경계에서 U+FFFD가 된다
    expect(normalizeMessage('x'.repeat(199) + '\u{1F600} tail')).toBe('x'.repeat(199) + '\uFFFD');
    expect(signatureKey({ stage: 'run', message: normalizeMessage('x'.repeat(199) + '\u{1F600}') })).toBe('run||' + 'x'.repeat(199) + '\uFFFD|');
  });

  it('입력의 짝 없는 서로게이트는 U+FFFD가 된다', () => {
    // 옛: 'a\ud83d b' 그대로
    expect(normalizeMessage('a\uD83D b 5')).toBe('a\uFFFD b N');
  });

  it('값이 undefined인 키는 JSON에 실리지 않아 키가 없는 것과 같다', () => {
    // 옛: `'error' in report.sync`가 참이라 normalizeMessage(undefined)에서 던진다. 새: 키가 없어 서명을 만들지 않는다(선언한 타입은 error: string)
    const report = { ok: false, sync: { error: undefined }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] };
    expect(signaturesFromReport(report as never)).toEqual([]);
  });

  it('afterFailures가 null이면 없는 것으로 읽는다', () => {
    // 옛: `null !== undefined`가 참이고 `length >= null`(0)이 참이라 승격한다. 새: 없다. 선언한 타입은 number | undefined
    expect(shouldPromote({ to: 'm', afterFailures: null as never }, ['a', 'b'])).toBe(false);
  });
});
