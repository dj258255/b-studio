/**
 * 실패 서명. 검증기(재기동·계약·테스트·워크플로 확인)가 관측한 실패만 서명으로 만든다.
 *
 * 모델은 실패를 다르게 서술할 뿐이므로 모델 텍스트는 실패의 근거가 아니다.
 * 이 로직은 원래 벤치(apps/studio/bench/coordination/trace.ts)에 있었다. 벤치와 조율이
 * 같은 규칙을 쓰도록 여기로 옮겼고, 벤치는 이 모듈을 import한다(동작은 그대로).
 */
import type { VerificationReport } from '../verify';
import type { WorkflowCheck } from '../workflow';

export interface FailureSignature {
  /** 게이트 단계(run, contract_check, browser_check, test, review, sync, secret_leak) */
  stage: string;
  service?: string;
  /** 정규화한 오류 첫 줄 */
  message: string;
  files?: string[];
}

/** 같은 원인의 실패를 하나로 묶는 키 */
export function signatureKey(signature: FailureSignature): string {
  return [signature.stage, signature.service ?? '', signature.message, (signature.files ?? []).join(',')].join('|');
}

/**
 * 실패 메시지 정규화: 첫 줄만, 앞뒤 공백 제거, 16진 해시 → H, 숫자열 → N, 200자로 자른다.
 * 같은 원인의 실패가 줄 번호·시각·해시 때문에 다른 서명이 되지 않게 하기 위해서다.
 * 해시는 단어 경계로 찾아 'feedback' 같은 낱말을 잘못 줄이지 않는다.
 */
export function normalizeMessage(text: string): string {
  return text
    .split('\n', 1)[0]!
    .trim()
    .replace(/\b[0-9a-f]{7,}\b/gi, 'H')
    .replace(/\d+/g, 'N')
    .slice(0, 200);
}

/** 검증기가 통과하지 못한 항목만 서명으로 만든다: 준비 못 한 서비스, 어긋난 계약, 반영 확인 실패, 시크릿 검출 */
export function signaturesFromReport(report: VerificationReport): FailureSignature[] {
  const signatures: FailureSignature[] = [];
  for (const check of report.restarted) {
    if (check.ready) continue;
    signatures.push({
      stage: 'run',
      service: check.service,
      message: normalizeMessage(check.error ?? check.logTail?.[0] ?? '서비스를 준비하지 못했습니다'),
    });
  }
  for (const check of report.contracts) {
    const breaking = check.changes.filter((change) => change.breaking);
    // 오류도 없고 호환을 깨는 변경도 없으면 통과한 계약 확인이다
    if (!check.error && breaking.length === 0) continue;
    const message = check.error ?? breaking.map((change) => `${change.kind} ${change.target}${change.detail ? `: ${change.detail}` : ''}`).join('; ');
    signatures.push({ stage: 'contract_check', service: check.service, message: normalizeMessage(message) });
  }
  // 샌드박스에 바뀐 파일이 반영되지 않으면 게이트는 여기서 멈춘다
  if ('error' in report.sync) signatures.push({ stage: 'sync', message: normalizeMessage(report.sync.error) });
  for (const leak of report.secretLeaks) {
    // 시크릿 값은 넣지 않는다. 파일 경로와 시크릿 이름만 남긴다(verify.ts의 SecretLeak.secrets는 값이 아니라 이름이다)
    signatures.push({ stage: 'secret_leak', message: normalizeMessage(`${leak.file}: ${leak.secrets.join(', ')}`), files: [leak.file] });
  }
  return signatures;
}

/** 실패한 워크플로 확인(브라우저·테스트·리뷰) 하나를 서명으로 */
export function signatureFromCheck(check: WorkflowCheck): FailureSignature {
  return { stage: check.stage, message: normalizeMessage(check.detail ?? check.name) };
}

/** failure 메모 입력. 플랫폼(검증기)이 Board.post에 그대로 넘긴다 */
export interface FailureNoteInput {
  kind: 'failure';
  body: string;
  refs: string[];
}

/** 검증 보고서와 워크플로 확인에서 failure 메모 입력을 만든다. 실패 서명만 넘긴다 */
export function failureNotesFromReport(report: VerificationReport, checks: readonly WorkflowCheck[] = []): FailureNoteInput[] {
  const signatures = [...signaturesFromReport(report), ...checks.filter((check) => !check.ok).map(signatureFromCheck)];
  return signatures.map(toNoteInput);
}

/**
 * 세션 기록에서 failure 메모 입력을 만든다(S5). StudioEvent 전체에 의존하지 않도록
 * 필요한 부분만 구조적으로 받는다 — 검증 결과와 실패한 워크플로 확인만 본다.
 */
export interface FailureEvent {
  type: string;
  event?: { type: string; report?: VerificationReport; check?: WorkflowCheck };
}

export function failureNotesFromEvents(events: readonly FailureEvent[]): FailureNoteInput[] {
  const signatures: FailureSignature[] = [];
  for (const event of events) {
    const agent = event.event;
    if (!agent) continue;
    if (agent.type === 'verify_result' && agent.report) signatures.push(...signaturesFromReport(agent.report));
    else if (agent.type === 'workflow_check' && agent.check && !agent.check.ok) signatures.push(signatureFromCheck(agent.check));
  }
  return signatures.map(toNoteInput);
}

function toNoteInput(signature: FailureSignature): FailureNoteInput {
  return { kind: 'failure', body: formatSignature(signature), refs: signature.files ? [...signature.files] : [] };
}

function formatSignature(signature: FailureSignature): string {
  const where = signature.service ? `${signature.stage} ${signature.service}` : signature.stage;
  return `[${where}] ${signature.message}`;
}
