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
 */
import { JSON_BLOCK, MANUAL_VERIFICATION_LINE, parseRequirementsMarkdown, REQUIREMENT_HEADING } from './requirements';
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

interface ScannedRecord {
  id: string;
  source: VerificationRecordSource;
  /** by|at|sha|note */
  value: string;
}

interface JsonItem {
  id: string;
  [key: string]: unknown;
}

const OUTSIDE = '(요구사항 밖)';

function canonical(by: string, at: string, sha: string, note: string): string {
  return `${by} · ${at} · 체크포인트 ${sha} · 메모 ${note}`;
}

/** 내장 JSON 블록의 요구사항 항목. 스키마 검사 없이 느슨하게 읽는다(깨진 값도 기록으로 센다). 읽지 못하면 빈 배열 */
function jsonItems(raw: string): JsonItem[] {
  const match = JSON_BLOCK.exec(raw);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[1]!);
    const list = Array.isArray(parsed) ? parsed : (parsed as { requirements?: unknown } | null)?.requirements;
    if (!Array.isArray(list)) return [];
    return list.filter((item): item is JsonItem => typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string');
  } catch {
    return [];
  }
}

function jsonRecord(item: JsonItem): string | undefined {
  const value = item.manualVerification;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') return String(value);
  const entry = value as Record<string, unknown>;
  return canonical(String(entry.by ?? ''), String(entry.at ?? ''), String(entry.sha ?? ''), String(entry.note ?? ''));
}

/** 문서 안의 사람 확인 기록을 요구사항 구조와 상관없이 전부 모은다(구조가 깨져 파서가 못 읽는 자리도 센다) */
function scanRecords(raw: string | undefined): ScannedRecord[] {
  if (raw === undefined) return [];
  const records: ScannedRecord[] = [];
  let currentId = OUTSIDE;
  for (const line of raw.replace(JSON_BLOCK, '').split(/\r?\n/)) {
    const heading = REQUIREMENT_HEADING.exec(line);
    if (heading) {
      currentId = heading[1]!;
      continue;
    }
    if (/^##\s/.test(line)) currentId = OUTSIDE;
    const match = MANUAL_VERIFICATION_LINE.exec(line);
    if (match) records.push({ id: currentId, source: '본문', value: canonical(match[1]!, match[2]!, match[3]!, match[4]!) });
  }
  for (const item of jsonItems(raw)) {
    const value = jsonRecord(item);
    if (value !== undefined) records.push({ id: item.id, source: 'JSON 블록', value });
  }
  return records;
}

function effectiveVerifications(raw: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (raw === undefined) return result;
  for (const requirement of parseRequirementsMarkdown(raw).requirements) {
    if (requirement.manualVerification) {
      const { by, at, sha, note } = requirement.manualVerification;
      result.set(requirement.id, canonical(by, at, sha, note));
    }
  }
  return result;
}

function requirementIds(raw: string | undefined): Set<string> {
  const ids = new Set<string>();
  if (raw === undefined) return ids;
  for (const requirement of parseRequirementsMarkdown(raw).requirements) ids.add(requirement.id);
  return ids;
}

/**
 * 실행 전(before)과 지금(after)의 요구사항 문서를 견주어 검증 기록의 변화를 돌려준다.
 * 문서가 실행 전에 없었으면(undefined) 새 문서에 들어 있는 사람 확인 기록은 전부 위조로 본다.
 * 파싱은 parseRequirementsMarkdown과 같은 정규식을 써서 파서가 읽는 모든 자리를 본다.
 */
export function diffVerificationRecords(before: string | undefined, after: string | undefined): VerificationRecordDiff {
  const diff: VerificationRecordDiff = { forged: [], removed: [], tampered: [] };
  if (after === undefined) {
    // 문서를 지웠다: 있던 사람 확인이 조용히 사라지므로 지운 것으로 남긴다
    for (const id of effectiveVerifications(before).keys()) diff.removed.push({ id, requirementRemoved: true });
    return diff;
  }

  const beforeRecords = scanRecords(before);
  for (const record of scanRecords(after)) {
    if (beforeRecords.some((entry) => entry.id === record.id && entry.source === record.source && entry.value === record.value)) continue;
    const kind = beforeRecords.some((entry) => entry.id === record.id && entry.source === record.source) ? 'changed' : 'added';
    diff.forged.push({ id: record.id, source: record.source, kind, record: record.value });
  }

  const afterIds = requirementIds(after);
  const afterEffective = effectiveVerifications(after);
  for (const id of effectiveVerifications(before).keys()) {
    if (!afterEffective.has(id)) diff.removed.push({ id, requirementRemoved: !afterIds.has(id) });
  }

  const afterItems = new Map(jsonItems(after).map((item) => [item.id, item]));
  for (const item of jsonItems(before ?? '')) {
    if (!afterIds.has(item.id)) continue; // 요구사항째 지운 것은 기록 조작이 아니다
    const next = afterItems.get(item.id);
    for (const field of ['hash', 'revisedAt'] as const) {
      if (item[field] === undefined) continue;
      if (next === undefined || next[field] === undefined) diff.tampered.push({ id: item.id, field, kind: 'removed' });
      else if (next[field] !== item[field]) diff.tampered.push({ id: item.id, field, kind: 'changed' });
    }
  }
  return diff;
}

/** 게이트 리뷰 단계 검사 이름. 위조(실패)와 삭제 기록(통과)을 다른 이름으로 남긴다 */
export const MANUAL_VERIFICATION_CHECK = 'manual-verification';
export const MANUAL_VERIFICATION_REMOVED_CHECK = 'manual-verification-removed';

/** 위조나 기록 조작이 있으면 true — 게이트를 실패시키거나 문서를 되돌려 적어야 한다 */
export function hasVerificationTamper(diff: VerificationRecordDiff): boolean {
  return diff.forged.length > 0 || diff.tampered.length > 0;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** 게이트 실패 안내에 쓰는 한 줄 설명들. 어느 요구사항의 무엇을 되돌려야 하는지 분명히 적는다 */
export function describeVerificationTamper(diff: VerificationRecordDiff): string[] {
  const lines: string[] = [];
  for (const entry of diff.forged) {
    const where = entry.id === OUTSIDE ? '요구사항 헤딩 밖' : entry.id;
    lines.push(`${where}: 이번 실행이 사람 확인 기록을 ${entry.kind === 'added' ? '새로 넣었습니다' : '바꿨습니다'}(${entry.source}) — ${entry.record}`);
  }
  for (const entry of diff.tampered) {
    lines.push(`${entry.id}: 재확인 필요 판정에 쓰는 ${entry.field}을(를) ${entry.kind === 'removed' ? '지웠습니다' : '바꿨습니다'}(JSON 블록)`);
  }
  return lines;
}

/** 지운 사람 확인 기록 설명 */
export function describeRemovedVerifications(diff: VerificationRecordDiff): string[] {
  return diff.removed.map((entry) => `${entry.id}: ${entry.requirementRemoved ? '요구사항과 함께' : '요구사항은 남기고'} 사람 확인 기록이 지워졌습니다`);
}

/** 위조된 요구사항 id 목록(중복 없이). 알림 문구에 쓴다 */
export function tamperedRequirementIds(diff: VerificationRecordDiff): string[] {
  return uniqueIds([...diff.forged.map((entry) => entry.id), ...diff.tampered.map((entry) => entry.id)]);
}

function formatBodyLine(value: string): string {
  return `- 확인: ${value}`;
}

/** 요구사항 id의 구역 안에서 "- 상태:" 줄 앞(없으면 구역 끝)에 줄을 넣을 위치 */
function insertionIndex(lines: readonly string[], id: string): number | undefined {
  const start = lines.findIndex((line) => REQUIREMENT_HEADING.exec(line)?.[1] === id);
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  for (let index = start + 1; index < end; index += 1) {
    if (/^-\s*상태:/.test(lines[index]!)) return index;
  }
  let last = end;
  while (last > start + 1 && lines[last - 1]!.trim() === '') last -= 1;
  return last;
}

/**
 * 실행이 남긴 요구사항 문서에서 검증 기록만 실행 전 값으로 되돌려 적은 문서를 돌려준다(요구사항 본문 편집은 그대로 둔다).
 * 게이트를 거치지 않고 문서를 체크포인트로 남기는 안전망(끊긴 실행을 이어받을 때, 작업 분해 전)이 위조 기록을
 * 보존 커밋에 실어 "검증됨(사람 확인)"으로 굳히지 않게 한다. 되돌릴 것이 없으면 같은 문자열을 돌려준다.
 */
export function restoreVerificationRecords(before: string | undefined, after: string): string {
  const diff = diffVerificationRecords(before, after);
  if (!hasVerificationTamper(diff)) return after;
  let text = after;

  if (diff.forged.some((entry) => entry.source === '본문')) {
    const lines = text.split(/\r?\n/);
    const kept = lines.filter((line) => !MANUAL_VERIFICATION_LINE.test(line));
    // 실행 전 본문 기록을 다시 넣는다(그 요구사항이 아직 문서에 있을 때만)
    for (const record of scanRecords(before).filter((entry) => entry.source === '본문' && entry.id !== OUTSIDE)) {
      const at = insertionIndex(kept, record.id);
      if (at !== undefined) kept.splice(at, 0, formatBodyLine(record.value));
    }
    text = kept.join('\n');
  }

  const jsonTouched = diff.forged.some((entry) => entry.source === 'JSON 블록') || diff.tampered.length > 0;
  if (jsonTouched) {
    const baseItems = new Map(jsonItems(before ?? '').map((item) => [item.id, item]));
    const match = JSON_BLOCK.exec(text);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]!) as unknown;
        const wrapper = Array.isArray(parsed) ? undefined : (parsed as { requirements?: unknown });
        const list = Array.isArray(parsed) ? parsed : wrapper?.requirements;
        if (Array.isArray(list)) {
          for (const item of list as JsonItem[]) {
            if (typeof item !== 'object' || item === null) continue;
            const base = baseItems.get(item.id);
            delete item.manualVerification;
            if (base?.manualVerification !== undefined) item.manualVerification = base.manualVerification;
            if (base) {
              for (const field of ['hash', 'revisedAt'] as const) {
                if (base[field] !== undefined) item[field] = base[field];
                else delete item[field];
              }
            }
          }
          text = text.replace(JSON_BLOCK, () => `<!-- b-studio-requirements\n${JSON.stringify(parsed, null, 2)}\n-->`);
        }
      } catch {
        // 읽을 수 없는 JSON 블록은 파서도 읽지 않으므로 되돌릴 기록이 없다
      }
    } else if (baseItems.size > 0) {
      // JSON 블록을 통째로 지웠다: 실행 전 블록에서 지금 문서에 남은 요구사항의 항목만 다시 붙인다
      const ids = requirementIds(text);
      const restored = [...baseItems.values()].filter((item) => ids.has(item.id));
      if (restored.length > 0) {
        const body = JSON.stringify({ requirements: restored, assumptions: [], manualSteps: [] }, null, 2);
        text = `${text.replace(/\s*$/, '')}\n\n<!-- b-studio-requirements\n${body}\n-->\n`;
      }
    }
  }
  return text;
}

/**
 * 게이트의 리뷰 단계 검사. 실행 전 문서(before)와 지금 문서(after)를 견주어
 * - 새로 넣었거나 바꾼 사람 확인 기록, 바꾸거나 지운 hash·revisedAt이 있으면 실패 검사(manual-verification),
 * - 사람 확인이 지워졌으면 통과 검사(manual-verification-removed — 과대평가는 아니지만 조용히 사라지지 않게 남긴다)
 * 를 돌려준다. 바뀐 것이 없으면 빈 배열이다.
 */
export function reviewRequirementRecords(before: string | undefined, after: string | undefined): WorkflowCheck[] {
  const diff = diffVerificationRecords(before, after);
  const checks: WorkflowCheck[] = [];
  if (hasVerificationTamper(diff)) {
    const ids = tamperedRequirementIds(diff).join(', ');
    checks.push({
      stage: 'review',
      name: MANUAL_VERIFICATION_CHECK,
      ok: false,
      attempts: 1,
      detail: `docs/requirements.md의 검증 기록이 이번 실행에서 바뀌었습니다(${ids}). 사람 확인은 화면에서 사람만 남길 수 있습니다. 이 기록을 되돌리세요(요구사항 본문은 그대로 고쳐도 됩니다):\n${describeVerificationTamper(diff)
        .map((line) => `  - ${line}`)
        .join('\n')}`,
    });
  }
  if (diff.removed.length > 0) {
    checks.push({
      stage: 'review',
      name: MANUAL_VERIFICATION_REMOVED_CHECK,
      ok: true,
      attempts: 1,
      detail: `이번 실행에서 사람 확인 기록이 지워져 해당 요구사항은 검증됨에서 내려갑니다. 의도한 것이 아니면 되돌리세요:\n${describeRemovedVerifications(diff)
        .map((line) => `  - ${line}`)
        .join('\n')}`,
    });
  }
  return checks;
}
