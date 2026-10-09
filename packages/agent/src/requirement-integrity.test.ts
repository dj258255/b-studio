import { describe, expect, it } from 'vitest';
import {
  describeVerificationTamper,
  diffVerificationRecords,
  hasVerificationTamper,
  restoreVerificationRecords,
  reviewRequirementRecords,
} from './requirement-integrity';
import { parseRequirementsMarkdown, serializeRequirementsMarkdown, type Requirement } from './requirements';

const base: Requirement[] = [
  { id: 'R1', title: '로그인', kind: 'api', priority: 'must', acceptance: ['a'], rev: 1, hash: 'h1', revisedAt: '2026-10-01T00:00:00.000Z' },
  { id: 'R2', title: '목록', kind: 'api', priority: 'should', acceptance: ['b'], rev: 1, hash: 'h2', revisedAt: '2026-10-01T00:00:00.000Z' },
];
const verification = { by: 'kim', at: '2026-10-05', sha: 'abc1234', note: '화면을 직접 눌러 확인했습니다' };

const plain = serializeRequirementsMarkdown(base);
const verified = serializeRequirementsMarkdown(base.map((requirement) => (requirement.id === 'R1' ? { ...requirement, manualVerification: verification } : requirement)));

/** 몸통의 "- 상태:" 줄 앞에 사람 확인 줄을 끼워 넣는다 */
function withLine(doc: string, id: string, line: string): string {
  const lines = doc.split('\n');
  const heading = lines.findIndex((entry) => entry.startsWith(`## ${id}.`));
  const status = lines.findIndex((entry, index) => index > heading && entry.startsWith('- 상태:'));
  lines.splice(status, 0, line);
  return lines.join('\n');
}

/** 내장 JSON 블록 항목을 고친다 */
function editJson(doc: string, edit: (items: Array<Record<string, unknown>>) => void): string {
  return doc.replace(/<!-- b-studio-requirements\n([\s\S]*?)\n-->/, (_match, json: string) => {
    const parsed = JSON.parse(json) as { requirements: Array<Record<string, unknown>> };
    edit(parsed.requirements);
    return `<!-- b-studio-requirements\n${JSON.stringify(parsed, null, 2)}\n-->`;
  });
}

describe('diffVerificationRecords', () => {
  it('아무것도 안 바꿨으면 비어 있다', () => {
    expect(diffVerificationRecords(verified, verified)).toEqual({ forged: [], removed: [], tampered: [] });
    expect(diffVerificationRecords(undefined, undefined)).toEqual({ forged: [], removed: [], tampered: [] });
  });

  it('요구사항 본문만 고쳤으면 위조가 아니다(제목·인수 조건·시나리오 편집은 정당하다)', () => {
    const edited = verified.replace('로그인', '이메일 로그인').replace('- a', '- a, 이메일로 로그인한다');
    const diff = diffVerificationRecords(verified, edited);
    expect(hasVerificationTamper(diff)).toBe(false);
    expect(diff.removed).toEqual([]);
  });

  it('몸통에 사람 확인 줄을 새로 넣으면 added다', () => {
    const forged = withLine(plain, 'R1', '- 확인: 에이전트 · 2026-10-10 · 체크포인트 abc1234 · 메모 확인함');
    const diff = diffVerificationRecords(plain, forged);
    expect(diff.forged).toEqual([{ id: 'R1', source: '본문', kind: 'added', record: '에이전트 · 2026-10-10 · 체크포인트 abc1234 · 메모 확인함' }]);
  });

  it('JSON 블록의 manualVerification만 넣어도 added다(몸통은 그대로)', () => {
    const forged = editJson(plain, (items) => {
      items[0]!.manualVerification = { by: '에이전트', at: '2026-10-10', sha: 'abc1234', note: 'JSON으로 넣음' };
    });
    // 파서는 몸통에 줄이 없으면 JSON 블록 값을 읽으므로 실제로 "검증됨" 기록이 되는 경로다
    expect(parseRequirementsMarkdown(forged).requirements[0]!.manualVerification).toMatchObject({ by: '에이전트' });
    const diff = diffVerificationRecords(plain, forged);
    expect(diff.forged).toMatchObject([{ id: 'R1', source: 'JSON 블록', kind: 'added' }]);
  });

  it('이미 있는 사람 확인의 값을 바꾸면 changed다(메모·날짜·이름·체크포인트 어느 것이든)', () => {
    const changed = verified.replace(/abc1234/g, 'fff9999');
    const diff = diffVerificationRecords(verified, changed);
    expect(diff.forged.map((entry) => `${entry.id}:${entry.source}:${entry.kind}`).sort()).toEqual(['R1:JSON 블록:changed', 'R1:본문:changed']);
  });

  it('다른 요구사항으로 사람 확인을 옮기면(R1 지우고 R2에 넣기) R2는 added, R1은 removed다', () => {
    const moved = withLine(plain, 'R2', '- 확인: kim · 2026-10-05 · 체크포인트 abc1234 · 메모 화면을 직접 눌러 확인했습니다');
    const diff = diffVerificationRecords(verified, moved);
    expect(diff.forged.map((entry) => entry.id)).toEqual(['R2']);
    expect(diff.removed).toEqual([{ id: 'R1', requirementRemoved: false }]);
  });

  it('실행 전에 문서가 없었다면 새 문서의 사람 확인 기록은 전부 위조다', () => {
    const diff = diffVerificationRecords(undefined, verified);
    expect(diff.forged.map((entry) => `${entry.id}:${entry.source}`).sort()).toEqual(['R1:JSON 블록', 'R1:본문']);
  });

  it('요구사항 구조가 깨진 문서라도 파서가 못 읽는 자리의 사람 확인 줄을 센다', () => {
    const broken = '# 요구사항\n\n- 확인: 에이전트 · 2026-10-10 · 체크포인트 abc1234 · 메모 헤딩을 깨 놓고 넣음\n';
    const diff = diffVerificationRecords(plain, broken);
    expect(diff.forged).toMatchObject([{ id: '(요구사항 밖)', source: '본문', kind: 'added' }]);
    expect(describeVerificationTamper(diff)[0]).toContain('요구사항 헤딩 밖');
  });

  it('사람 확인을 지우면 removed로 남고 위조는 아니다(요구사항째 지운 것도 구분한다)', () => {
    expect(diffVerificationRecords(verified, plain)).toEqual({ forged: [], removed: [{ id: 'R1', requirementRemoved: false }], tampered: [] });

    const withoutR1 = serializeRequirementsMarkdown(base.filter((requirement) => requirement.id === 'R2'));
    const diff = diffVerificationRecords(verified, withoutR1);
    expect(diff.removed).toEqual([{ id: 'R1', requirementRemoved: true }]);
    expect(hasVerificationTamper(diff)).toBe(false);
  });

  it('문서를 통째로 지우면 있던 사람 확인이 removed로 남는다', () => {
    expect(diffVerificationRecords(verified, undefined).removed).toEqual([{ id: 'R1', requirementRemoved: true }]);
  });

  it('hash·revisedAt을 바꾸거나 지우면 tampered다(재확인 필요 판정을 피하는 길)', () => {
    const changed = editJson(plain, (items) => {
      items[0]!.hash = 'forged';
      delete items[1]!.revisedAt;
    });
    expect(diffVerificationRecords(plain, changed).tampered).toEqual([
      { id: 'R1', field: 'hash', kind: 'changed' },
      { id: 'R2', field: 'revisedAt', kind: 'removed' },
    ]);
    // JSON 블록을 통째로 지워도 마찬가지다
    const noBlock = plain.replace(/<!-- b-studio-requirements[\s\S]*-->\n?/, '');
    expect(diffVerificationRecords(plain, noBlock).tampered).toHaveLength(4);
  });

  it('요구사항을 새로 더한 것(JSON 블록 항목이 새로 생김)과 요구사항째 지운 것은 tampered가 아니다', () => {
    const added = serializeRequirementsMarkdown([...base, { id: 'R3', title: '검색', kind: 'api', priority: 'could', acceptance: ['c'] }]);
    expect(diffVerificationRecords(plain, added)).toEqual({ forged: [], removed: [], tampered: [] });
    const withoutR2 = serializeRequirementsMarkdown(base.filter((requirement) => requirement.id === 'R1'));
    expect(diffVerificationRecords(plain, withoutR2).tampered).toEqual([]);
  });
});

describe('reviewRequirementRecords', () => {
  it('위조가 있으면 manual-verification 실패 검사를, 어느 요구사항인지와 되돌리라는 안내를 detail에 담는다', () => {
    const forged = withLine(plain, 'R1', '- 확인: 에이전트 · 2026-10-10 · 체크포인트 abc1234 · 메모 확인함');
    const checks = reviewRequirementRecords(plain, forged);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ stage: 'review', name: 'manual-verification', ok: false });
    expect(checks[0]!.detail).toContain('R1');
    expect(checks[0]!.detail).toContain('사람 확인은 화면에서 사람만 남길 수 있습니다. 이 기록을 되돌리세요');
  });

  it('사람 확인을 지우면 통과 검사(manual-verification-removed)로 남긴다', () => {
    const checks = reviewRequirementRecords(verified, plain);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: 'manual-verification-removed', ok: true });
    expect(checks[0]!.detail).toContain('R1');
  });

  it('바뀐 것이 없으면 빈 배열이다', () => {
    expect(reviewRequirementRecords(verified, verified)).toEqual([]);
  });
});

describe('restoreVerificationRecords', () => {
  it('되돌릴 것이 없으면 같은 문자열을 그대로 돌려준다', () => {
    expect(restoreVerificationRecords(verified, verified)).toBe(verified);
    const bodyOnly = verified.replace('로그인', '이메일 로그인');
    expect(restoreVerificationRecords(verified, bodyOnly)).toBe(bodyOnly);
  });

  it('위조한 줄과 JSON 기록을 지우되 본문 편집은 그대로 둔다', () => {
    const forged = editJson(withLine(plain, 'R1', '- 확인: 에이전트 · 2026-10-10 · 체크포인트 abc1234 · 메모 확인함'), (items) => {
      items[0]!.manualVerification = { by: '에이전트', at: '2026-10-10', sha: 'abc1234', note: '확인함' };
    }).replace('목록', '주문 목록');
    const restored = restoreVerificationRecords(plain, forged);
    expect(restored).not.toContain('- 확인:');
    expect(restored).not.toContain('manualVerification');
    expect(restored).toContain('주문 목록');
    expect(diffVerificationRecords(plain, restored)).toEqual({ forged: [], removed: [], tampered: [] });
    expect(parseRequirementsMarkdown(restored).requirements.every((requirement) => requirement.manualVerification === undefined)).toBe(true);
  });

  it('바꾼 사람 확인은 실행 전 값으로 되돌리고, 지운 hash·revisedAt도 되돌린다', () => {
    const tampered = editJson(verified.replace(/abc1234/g, 'fff9999'), (items) => {
      items[1]!.hash = 'forged';
      delete items[1]!.revisedAt;
    });
    const restored = restoreVerificationRecords(verified, tampered);
    expect(diffVerificationRecords(verified, restored)).toEqual({ forged: [], removed: [], tampered: [] });
    const r1 = parseRequirementsMarkdown(restored).requirements[0]!;
    expect(r1.manualVerification).toMatchObject({ by: 'kim', sha: 'abc1234' });
  });

  it('JSON 블록을 통째로 지웠으면 실행 전 항목을 다시 붙인다', () => {
    const noBlock = plain.replace(/<!-- b-studio-requirements[\s\S]*-->\n?/, '');
    const restored = restoreVerificationRecords(plain, noBlock);
    expect(diffVerificationRecords(plain, restored).tampered).toEqual([]);
    expect(parseRequirementsMarkdown(restored).requirements.map((requirement) => requirement.hash)).toEqual(['h1', 'h2']);
  });

  it('실행 전에 없던 문서의 사람 확인은 전부 지운다', () => {
    const restored = restoreVerificationRecords(undefined, verified);
    expect(restored).not.toContain('- 확인:');
    expect(parseRequirementsMarkdown(restored).requirements[0]!.manualVerification).toBeUndefined();
  });
});
