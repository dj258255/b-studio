/**
 * 요구사항 문서(docs/requirements.md)의 "검증 기록" 무결성(ADR-157).
 *
 * 요구사항이 "검증됨(사람 확인)"인지는 문서 안의 사람 확인 기록(manualVerification — 몸통의 "- 확인:" 줄과 끝의
 * 내장 JSON 블록 둘 다 파서가 읽는다)과, 재확인 필요 판정에 쓰는 hash·revisedAt으로 정해진다. 이 값들은 화면의
 * 동작(markRequirementManualVerification·applySessionRequirements)만 남길 수 있어야 한다. 에이전트가 같은 문서를
 * 쓰기 도구로 고칠 수 있으므로, 실행 전의 문서와 지금 문서를 견주어 "실행이 새로 넣었거나 바꾼" 기록을 찾는다.
 *
 * 요구사항 본문(제목·EARS·시나리오·인수 조건·NFR)을 고치는 것은 정당한 편집이라 여기서 다루지 않는다 — 본문이 바뀌면
 * 저장된 hash와 달라져 요구사항은 저절로 "재확인 필요"가 된다(requirementContentDrifted). 위험한 것은 그 판정을 만드는
 * 기록 자체를 고치는 일이다. 순수 함수만 둔다(파일·git·모델 호출 없음).
 *
 * 판정(기록 읽기·견주기·되돌리기·설명)은 Rust(`crates/bstudio-guard/src/requirement_integrity.rs`, ADR-191 3단계 3x)가 한다. 여기에는 타입과 같은 이름·시그니처의 껍데기가 남았다.
 * `parseRequirementsMarkdown`(zod 스키마로 읽는 요구사항 목록)은 TS에 남아서, 그 결과가 필요한 자리(사람 확인이 있는 요구사항 id, 요구사항 id)만 여기서 읽어 Rust로 넘긴다.
 * 위조를 찾는 막는 판정이라 글은 `encodeLoneSurrogates`해서 보내고 결과는 `decodeLoneSurrogates`로 푼다(짝 없는 서로게이트가 U+FFFD로 합쳐져 다른 기록이 같아지는 것을 막는다).
 */
import { encodeLoneSurrogates, native } from '@b-studio/sandbox';
import { decodeLoneSurrogates } from './lone-surrogates';
import { parseRequirementsMarkdown } from './requirements';
import type { WorkflowCheck } from './workflow';

/** 기록이 있던 자리. 파서는 둘 다 읽으므로 둘 다 본다 */
export type VerificationRecordSource = '본문' | 'JSON 블록';

export interface ForgedVerification {
  /** 요구사항 id. 헤딩 밖에 있는 줄이면 '(요구사항 밖)' */
  id: string;
  source: VerificationRecordSource;
  /** 실행 전에 같은 자리에 다른 값이 있었으면 changed, 없었으면 added */
  kind: 'added' | 'changed';
  /** 새 기록을 한 줄로 */
  record: string;
}

export interface RemovedVerification {
  id: string;
  /** 요구사항째 문서에서 사라졌으면 true. false면 요구사항은 남았는데 사람 확인만 지워졌다 */
  requirementRemoved: boolean;
}

export interface TamperedRecord {
  id: string;
  /** 재확인 판정에 쓰는 필드 */
  field: 'hash' | 'revisedAt';
  kind: 'changed' | 'removed';
}

export interface VerificationRecordDiff {
  /** 실행이 새로 넣었거나 바꾼 사람 확인 기록. 비어 있지 않으면 위조로 본다 */
  forged: ForgedVerification[];
  /** 실행이 지운 사람 확인 기록. 과대평가는 아니지만 조용히 사라지면 안 된다 */
  removed: RemovedVerification[];
  /** 실행이 바꾸거나 지운 hash·revisedAt. 재확인 필요 판정을 피하는 데 쓸 수 있다 */
  tampered: TamperedRecord[];
}

/** 문서에서 `parseRequirementsMarkdown`이 읽은 요구사항 중 사람 확인이 있는 것의 id(읽은 순서) */
function effectiveVerificationIds(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const ids = new Set<string>();
  for (const requirement of parseRequirementsMarkdown(raw).requirements) if (requirement.manualVerification) ids.add(requirement.id);
  return [...ids];
}

function requirementIds(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return [...new Set(parseRequirementsMarkdown(raw).requirements.map((requirement) => requirement.id))];
}

/** Rust로 보낼 id 목록. 판정이 `parseRequirementsMarkdown`으로 읽은 값을 쓰는 자리만 여기서 읽는다(문서가 없으면 지금 문서의 목록은 읽지 않는다) */
function readIds(before: string | undefined, after: string | undefined): { beforeEffective: string[]; afterEffective: string[]; afterIds: string[] } {
  const beforeEffective = effectiveVerificationIds(before).map(encodeLoneSurrogates);
  if (after === undefined) return { beforeEffective, afterEffective: [], afterIds: [] };
  return { beforeEffective, afterEffective: effectiveVerificationIds(after).map(encodeLoneSurrogates), afterIds: requirementIds(after).map(encodeLoneSurrogates) };
}

function encodeText(text: string | undefined): string | undefined {
  return text === undefined ? undefined : encodeLoneSurrogates(text);
}

/** JSON 값 안의 모든 글자(키는 제외 — 이 모듈의 값은 키가 고정이다)에 `map`을 적용한다 */
function mapStrings<T>(value: T, map: (text: string) => string): T {
  if (typeof value === 'string') return map(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map)) as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)])) as T;
  return value;
}

function encodeDiff(diff: VerificationRecordDiff): string {
  return JSON.stringify(mapStrings(diff, encodeLoneSurrogates));
}

/**
 * 실행 전(before)과 지금(after)의 요구사항 문서를 견주어 검증 기록의 변화를 돌려준다.
 * 문서가 실행 전에 없었으면(undefined) 새 문서에 들어 있는 사람 확인 기록은 전부 위조로 본다.
 * 파싱은 parseRequirementsMarkdown과 같은 정규식을 써서 파서가 읽는 모든 자리를 본다.
 */
export function diffVerificationRecords(before: string | undefined, after: string | undefined): VerificationRecordDiff {
  const ids = readIds(before, after);
  const decided = JSON.parse(native.reqIntegrityDiff(encodeText(before), encodeText(after), ids.beforeEffective, ids.afterEffective, ids.afterIds)) as VerificationRecordDiff;
  return mapStrings(decided, decodeLoneSurrogates);
}

/** 게이트 리뷰 단계 검사 이름. 위조(실패)와 삭제 기록(통과)을 다른 이름으로 남긴다 */
export const MANUAL_VERIFICATION_CHECK = 'manual-verification';
export const MANUAL_VERIFICATION_REMOVED_CHECK = 'manual-verification-removed';

/** 위조나 기록 조작이 있으면 true — 게이트를 실패시키거나 문서를 되돌려 적어야 한다 */
export function hasVerificationTamper(diff: VerificationRecordDiff): boolean {
  return native.reqIntegrityHasTamper(encodeDiff(diff));
}

/** 게이트 실패 안내에 쓰는 한 줄 설명들. 어느 요구사항의 무엇을 되돌려야 하는지 분명히 적는다 */
export function describeVerificationTamper(diff: VerificationRecordDiff): string[] {
  return native.reqIntegrityDescribeTamper(encodeDiff(diff)).map(decodeLoneSurrogates);
}

/** 지운 사람 확인 기록 설명 */
export function describeRemovedVerifications(diff: VerificationRecordDiff): string[] {
  return native.reqIntegrityDescribeRemoved(encodeDiff(diff)).map(decodeLoneSurrogates);
}

/** 위조된 요구사항 id 목록(중복 없이). 알림 문구에 쓴다 */
export function tamperedRequirementIds(diff: VerificationRecordDiff): string[] {
  return native.reqIntegrityTamperedIds(encodeDiff(diff)).map(decodeLoneSurrogates);
}

/**
 * 실행이 남긴 요구사항 문서에서 검증 기록만 실행 전 값으로 되돌려 적은 문서를 돌려준다(요구사항 본문 편집은 그대로 둔다).
 * 게이트를 거치지 않고 문서를 체크포인트로 남기는 안전망(끊긴 실행을 이어받을 때, 작업 분해 전)이 위조 기록을
 * 보존 커밋에 실어 "검증됨(사람 확인)"으로 굳히지 않게 한다. 되돌릴 것이 없으면 같은 문자열을 돌려준다.
 */
export function restoreVerificationRecords(before: string | undefined, after: string): string {
  const ids = readIds(before, after);
  const call = (textIds: string[] | undefined) =>
    JSON.parse(native.reqIntegrityRestore(encodeText(before), encodeLoneSurrogates(after), ids.beforeEffective, ids.afterEffective, ids.afterIds, textIds)) as
      | { unchanged: true }
      | { needsIds: string }
      | { text: string };
  let decided = call(undefined);
  // JSON 블록을 통째로 지웠으면 되돌리는 도중의 글에서 요구사항 id를 읽어 줘야 한다(zod 스키마로 읽는 것은 TS에 남아 있다)
  if ('needsIds' in decided) decided = call(requirementIds(decodeLoneSurrogates(decided.needsIds)).map(encodeLoneSurrogates));
  if ('unchanged' in decided) return after;
  if ('text' in decided) return decodeLoneSurrogates(decided.text);
  throw new Error('검증 기록을 되돌리는 판정이 끝나지 않았습니다');
}

/**
 * 게이트의 리뷰 단계 검사. 실행 전 문서(before)와 지금 문서(after)를 견주어
 * - 새로 넣었거나 바꾼 사람 확인 기록, 바꾸거나 지운 hash·revisedAt이 있으면 실패 검사(manual-verification),
 * - 사람 확인이 지워졌으면 통과 검사(manual-verification-removed — 과대평가는 아니지만 조용히 사라지지 않게 남긴다)
 * 를 돌려준다. 바뀐 것이 없으면 빈 배열이다.
 */
export function reviewRequirementRecords(before: string | undefined, after: string | undefined): WorkflowCheck[] {
  const ids = readIds(before, after);
  const checks = JSON.parse(native.reqIntegrityReview(encodeText(before), encodeText(after), ids.beforeEffective, ids.afterEffective, ids.afterIds)) as WorkflowCheck[];
  return checks.map((check) => (check.detail === undefined ? check : { ...check, detail: decodeLoneSurrogates(check.detail) }));
}
