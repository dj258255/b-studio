import { encodeNative, native } from '@b-studio/sandbox';
import type { WorkflowPageCheck } from '@b-studio/spec';
import type { BrowserPageResult } from './browser-check';

/**
 * 통과한 확인이 무엇을 쟀는지 사람이 읽을 줄로 남기는 규칙은 Rust(crates/bstudio-guard/src/check_evidence.rs, ADR-191 3단계 3e)가 정한다.
 * 여기는 값을 JSON으로 건네고 받는 껍데기다. 시크릿을 가리는 함수(redact)는 JS 쪽 것을 Rust가 부른다 — 값을 적기 전에 가리고, 가린 뒤에 자른다.
 *
 * 판정을 다시 하지 않는다 — 판정에 쓴 것과 같은 결과에서 잰 값만 적는다(ADR-161 덧붙임). 모델에게 가는 피드백에는 섞이지 않는다.
 */

/** 한 확인의 근거 줄 수 상한. 결과가 이벤트 기록과 체크포인트 기록에 실리므로 크기를 묶어 둔다. Rust의 같은 이름 상수와 같은 값이다 */
export const MAX_EVIDENCE_LINES = 12;

type Redact = (text: string) => string;

/** 줄 수와 길이를 묶고 시크릿 값을 가린다. 화면·api에서 온 값이 섞일 수 있다 */
export function finishEvidence(lines: readonly string[], redact: Redact): string[] {
  return native.finishEvidence([...lines], redact);
}

export interface PageEvidenceContext {
  /** autoPageChecks가 스스로 연 화면이면 true. Next.js 오류 화면 표지까지 본다 */
  auto?: boolean;
  /** 추정한 id로 열었으면 그 값. 상태 코드는 404·500만 실패로 본다 */
  probedId?: string;
  /** expectFromApi로 꺼낸 값이 화면에 있었으면 그 값 */
  api?: { service: string; jsonPath: string; value: string | number };
  /** 시크릿 값을 가리는 함수. 화면·api에서 온 값을 적기 전에 거친다 */
  redact?: Redact;
}

const identity: Redact = (text) => text;

/** 결과 객체 그대로 보내면 단계의 스크린샷(Buffer)까지 JSON이 된다. 근거에 쓰는 값만 보낸다 */
function evidenceView(result: BrowserPageResult): unknown {
  return { ...result, blockedRequests: undefined, steps: Array.isArray(result.steps) ? result.steps.map((step) => ({ label: step.label, ok: step.ok })) : result.steps };
}

/** browser 모드 화면 확인이 통과했을 때의 근거. 판정에 쓴 result 그대로에서 만든다 */
export function browserPageEvidence(page: WorkflowPageCheck, result: BrowserPageResult, context: PageEvidenceContext = {}): string[] {
  const { redact, ...rest } = context;
  return native.browserPageEvidence(encodeNative(page), encodeNative(evidenceView(result)), encodeNative(rest), redact ?? identity);
}

/** http 모드 화면 확인이 통과했을 때의 근거. 자바스크립트를 실행하지 않았다는 사실을 함께 적는다 */
export function httpPageEvidence(page: WorkflowPageCheck, response: { status: number; text: string }, context: PageEvidenceContext = {}): string[] {
  const { redact, ...rest } = context;
  return native.httpPageEvidence(encodeNative(page), encodeNative(response), encodeNative(rest), redact ?? identity);
}

/** 테스트 명령이 통과했을 때의 근거. 무엇을 어디서 돌렸고 얼마나 걸렸는지 — 아무것도 돌지 않고 끝난 명령이 시간으로 드러난다 */
export function testEvidence(service: string, command: readonly string[], elapsedMs: number): string[] {
  return native.testEvidence(service, [...command], elapsedMs);
}
