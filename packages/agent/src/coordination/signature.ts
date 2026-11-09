/**
 * 실패 서명. 검증기(재기동·계약·테스트·워크플로 확인)가 관측한 실패만 서명으로 만든다.
 *
 * 모델은 실패를 다르게 서술할 뿐이므로 모델 텍스트는 실패의 근거가 아니다.
 * 이 로직은 원래 벤치(apps/studio/bench/coordination/trace.ts)에 있었다. 벤치와 조율이
 * 같은 규칙을 쓰도록 여기로 옮겼고, 벤치는 이 모듈을 import한다(동작은 그대로).
 *
 * 판정은 Rust(crates/bstudio-guard/src/coordination.rs, ADR-191 3단계)가 한다. 이 파일은 타입과
 * 같은 이름·시그니처의 껍데기다. 서명은 "같은 실패"를 가르는 키라서 글자 하나도 옛 구현과 다르면 안 된다.
 */
import { decodeNative, encodeNative, native } from '@b-studio/sandbox';
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
  return native.coordSignatureKey(encodeNative(signature));
}

/**
 * 실패 메시지 정규화: 첫 줄만, 앞뒤 공백 제거, 16진 해시 → H, 숫자열 → N, 200자로 자른다.
 * 같은 원인의 실패가 줄 번호·시각·해시 때문에 다른 서명이 되지 않게 하기 위해서다.
 * 해시는 단어 경계로 찾아 'feedback' 같은 낱말을 잘못 줄이지 않는다.
 */
export function normalizeMessage(text: string): string {
  return native.coordNormalizeMessage(text);
}

/** 검증기가 통과하지 못한 항목만 서명으로 만든다: 준비 못 한 서비스, 어긋난 계약, 반영 확인 실패, 시크릿 검출 */
export function signaturesFromReport(report: VerificationReport): FailureSignature[] {
  return decodeNative<FailureSignature[]>(native.coordSignaturesFromReport(encodeNative(report)));
}

/** 실패한 워크플로 확인(브라우저·테스트·리뷰) 하나를 서명으로 */
export function signatureFromCheck(check: WorkflowCheck): FailureSignature {
  return decodeNative<FailureSignature>(native.coordSignatureFromCheck(encodeNative(check)));
}

/** failure 메모 입력. 플랫폼(검증기)이 Board.post에 그대로 넘긴다 */
export interface FailureNoteInput {
  kind: 'failure';
  body: string;
  refs: string[];
}

/** 검증 보고서와 워크플로 확인에서 failure 메모 입력을 만든다. 실패 서명만 넘긴다 */
export function failureNotesFromReport(report: VerificationReport, checks: readonly WorkflowCheck[] = []): FailureNoteInput[] {
  return decodeNative<FailureNoteInput[]>(native.coordFailureNotesFromReport(encodeNative(report), encodeNative(checks)));
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
  // 세션 기록 전체(글·도구 결과 등 큰 이벤트)를 넘기지 않도록 Rust가 읽는 필드(type·event.type·report·check)만 싣는다
  const slim = events.map((event) => ({ type: event.type, event: event.event && { type: event.event.type, report: event.event.report, check: event.event.check } }));
  return decodeNative<FailureNoteInput[]>(native.coordFailureNotesFromEvents(encodeNative(slim)));
}
