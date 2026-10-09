import type { WorkflowPageCheck } from '@b-studio/spec';
import type { BrowserPageResult } from './browser-check';

/**
 * 통과한 확인이 무엇을 쟀는지 사람이 읽을 줄로 남긴다(ADR-161 덧붙임).
 * 실패는 사유가 자세한데 통과는 이름과 "통과"만 남아, 단언이 실제로 재졌는지 화면으로는 알 수 없었다.
 *
 * 판정을 다시 하지 않는다 — 판정에 쓴 것과 같은 결과에서 **잰 값**만 적는다. 건수는 결과에서 직접 세고,
 * 문구는 실제로 있는 것만 적으며, 보지 않았거나 허용한 것은 그렇다고 적는다. 통과했다는 사실에서 거꾸로 채우지 않는다.
 * 모델에게 가는 피드백(실패한 확인의 detail)에는 섞이지 않는다.
 */

/** 한 확인의 근거 줄 수 상한. 결과가 이벤트 기록과 체크포인트 기록에 실리므로 크기를 묶어 둔다 */
export const MAX_EVIDENCE_LINES = 12;
const MAX_LINE_LENGTH = 240;
const MAX_VALUE_LENGTH = 60;

type Redact = (text: string) => string;

/**
 * 값을 따옴표로 감싸 적는다. **가린 뒤에 자른다** — 먼저 자르면 긴 시크릿 값의 앞부분이 가림 대상과 일치하지 않아 그대로 남는다
 */
const quote = (value: string | number, redact: Redact): string => {
  const text = redact(String(value));
  return `'${text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text}'`;
};
const quoteAll = (values: readonly string[], redact: Redact): string => values.map((value) => quote(value, redact)).join(', ');

/** 줄 수와 길이를 묶고 시크릿 값을 가린다. 화면·api에서 온 값이 섞일 수 있다 */
export function finishEvidence(lines: readonly string[], redact: Redact): string[] {
  const capped = lines.length > MAX_EVIDENCE_LINES ? [...lines.slice(0, MAX_EVIDENCE_LINES - 1), `그 밖에 ${lines.length - (MAX_EVIDENCE_LINES - 1)}가지`] : lines;
  return capped.map((line) => {
    const safe = redact(line);
    return safe.length > MAX_LINE_LENGTH ? `${safe.slice(0, MAX_LINE_LENGTH)}…` : safe;
  });
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

function textLines(page: WorkflowPageCheck, text: string, where: string, redact: Redact): string[] {
  const lines: string[] = [];
  if (page.expectText && text.includes(page.expectText)) lines.push(`${quote(page.expectText, redact)} ${where}에 있음`);
  if (page.expectAnyText) {
    const found = page.expectAnyText.filter((candidate) => text.includes(candidate));
    if (found.length > 0) lines.push(`${quoteAll(found, redact)} ${where}에 있음 (적은 ${page.expectAnyText.length}개 중 하나면 통과)`);
  }
  if (page.expectAllText) {
    const found = page.expectAllText.filter((candidate) => text.includes(candidate));
    if (found.length > 0) lines.push(`${quoteAll(found, redact)} ${where}에 ${found.length === page.expectAllText.length ? '모두 ' : ''}있음`);
  }
  return lines;
}

function statusLine(status: number | null, page: WorkflowPageCheck, context: PageEvidenceContext): string {
  const got = `HTTP ${status ?? '응답 없음'}`;
  if (context.probedId !== undefined) return `${got} — 추정한 id(${context.probedId})로 열어 404·500만 실패로 봤습니다`;
  return `${got} (기대 ${page.expectStatus})`;
}

/** browser 모드 화면 확인이 통과했을 때의 근거. 판정에 쓴 result 그대로에서 만든다 */
export function browserPageEvidence(page: WorkflowPageCheck, result: BrowserPageResult, context: PageEvidenceContext = {}): string[] {
  const redact = context.redact ?? ((text: string) => text);
  const lines: string[] = [statusLine(result.status, page, context)];
  lines.push(...textLines(page, result.text, '화면', redact));
  const viewport = result.viewportTexts;
  if (page.expectInViewport && viewport) {
    const visible = viewport.findings.filter((finding) => finding.visible && page.expectInViewport!.includes(finding.text)).map((finding) => finding.text);
    if (visible.length > 0) lines.push(`첫 화면에 온전히 보임 (창 ${viewport.width}x${viewport.height}): ${quoteAll(visible, redact)}`);
  }
  if (context.api) lines.push(`${context.api.service}의 ${context.api.jsonPath} 값 ${quote(context.api.value, redact)} 화면에 있음`);
  const tolerated = `console.error ${result.consoleErrors.length}건 · 실패한 요청 ${result.failedRequests.length}건 · 미디어 오류 ${result.mediaErrors.length}건`;
  lines.push(page.allowConsoleErrors ? `스크립트 예외 ${result.pageErrors.length}건 — ${tolerated}은 실패로 보지 않았습니다(allowConsoleErrors)` : `스크립트 예외 ${result.pageErrors.length}건 · ${tolerated}`);
  if (page.allowLoadingPlaceholder) lines.push('로딩 문구에서 멈췄는지는 보지 않았습니다(allowLoadingPlaceholder)');
  if (page.noHorizontalScroll) lines.push(`가로 넘침 ${result.horizontalOverflowPx}px`);
  if (result.loadMs !== undefined) {
    lines.push(`로드 ${result.loadMs.toLocaleString('ko-KR')}ms${page.maxLoadMs !== undefined ? ` (예산 ${page.maxLoadMs.toLocaleString('ko-KR')}ms)` : ''}`);
  }
  // 첫 항목은 페이지를 연 것(open <경로>)이라 선언한 단계 수와 맞춘다
  const ran = page.steps?.length ? result.steps.slice(1) : [];
  if (ran.length > 0) lines.push(`단계 ${ran.filter((step) => step.ok).length}/${ran.length}개 실행: ${ran.map((step) => step.label).join(' → ')}`);
  if (context.auto) lines.push('Next.js 오류 화면 표지 없음');
  return lines;
}

/** http 모드 화면 확인이 통과했을 때의 근거. 자바스크립트를 실행하지 않았다는 사실을 함께 적는다 */
export function httpPageEvidence(page: WorkflowPageCheck, response: { status: number; text: string }, context: PageEvidenceContext = {}): string[] {
  const redact = context.redact ?? ((text: string) => text);
  const lines: string[] = [statusLine(response.status, page, context)];
  lines.push(...textLines(page, response.text, '응답 본문', redact));
  if (context.api) lines.push(`${context.api.service}의 ${context.api.jsonPath} 값 ${quote(context.api.value, redact)} 응답 본문에 있음`);
  if (context.auto) lines.push('Next.js 오류 화면 표지 없음');
  lines.push('HTTP 확인이라 자바스크립트를 실행하지 않았습니다 — 화면에 그려졌는지, 콘솔 오류·실패한 요청은 보지 않았습니다');
  return lines;
}

/** 테스트 명령이 통과했을 때의 근거. 무엇을 어디서 돌렸고 얼마나 걸렸는지 — 아무것도 돌지 않고 끝난 명령이 시간으로 드러난다 */
export function testEvidence(service: string, command: readonly string[], elapsedMs: number): string[] {
  const seconds = elapsedMs / 1000;
  return [`${service}에서 \`${command.join(' ')}\` 종료 코드 0`, `걸린 시간 ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toLocaleString('ko-KR')}초`];
}
