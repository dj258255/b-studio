import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 요구사항 검증 기록 무결성(ADR-191 3단계 3x)의 벡터. 기대값은 옮기기 전 TS(`requirement-integrity-legacy.ts`)가 낸 값이다(`requirement-integrity-vectors.json`).
 * `VECTORS_AGAINST_LEGACY=1`로 돌리면 같은 벡터를 옛 TS에 넣는다(0건 실패해야 한다).
 * 허용·인식하는 꼴마다 거의 같은 거부 입력을 넣는다: 앞 공백, 다른 글머리, 메모 없음, 날짜 꼴, 붙은 낱말, 헤딩 꼴, 닮은 표지, 같음 비교를 접두·대소문자로 넓힐 수 있는 값.
 */
interface Vector {
  name: string;
  before?: string;
  after?: string;
  diff: string;
  tamper: boolean;
  describe: string;
  review: string;
  restore: string | null;
}
const { integrity } = JSON.parse(readFileSync(new URL('./requirement-integrity-vectors.json', import.meta.url), 'utf8')) as { integrity: Vector[] };
const impl = (await import(process.env.VECTORS_AGAINST_LEGACY ? './requirement-integrity-legacy' : './requirement-integrity')) as typeof import('./requirement-integrity');

describe('요구사항 검증 기록 무결성 벡터', () => {
  it('입력이 비지 않았다', () => {
    expect(integrity.length).toBeGreaterThanOrEqual(100);
    expect(integrity.filter((v) => v.tamper).length).toBeGreaterThan(40);
    expect(integrity.filter((v) => !v.tamper).length).toBeGreaterThan(30);
    expect(integrity.filter((v) => JSON.parse(v.diff).removed.length > 0).length).toBeGreaterThan(3);
    expect(integrity.filter((v) => v.restore !== null && v.restore !== v.after).length).toBeGreaterThan(30);
  });

  it.each(integrity)('$name', ({ before, after, diff, tamper, describe: described, review, restore }) => {
    const actual = impl.diffVerificationRecords(before, after);
    expect(JSON.stringify(actual)).toBe(diff);
    expect(impl.hasVerificationTamper(actual)).toBe(tamper);
    expect(JSON.stringify([impl.describeVerificationTamper(actual), impl.describeRemovedVerifications(actual), impl.tamperedRequirementIds(actual)])).toBe(described);
    expect(JSON.stringify(impl.reviewRequirementRecords(before, after))).toBe(review);
    if (after !== undefined) expect(impl.restoreVerificationRecords(before, after)).toBe(restore);
  });
});

/**
 * 의도한 차이(옛 TS와 다르다, `VECTORS_AGAINST_LEGACY=1`에서는 실패해야 한다): 중첩이 2000을 넘는 JSON 블록은 이 구현이 읽지 못한다(옛 TS는 읽는다).
 * 읽지 못한 블록 안의 기록은 볼 수 없으므로 통과로 이어지지 않게 위조로 센다. 되돌릴 때는 그 블록을 없는 것으로 보고 실행 전 항목에서 다시 붙인다.
 */
describe('요구사항 검증 기록 무결성: 의도한 차이', () => {
  const REQ = '## R1. 제목\n- 종류: api · 우선순위: must\n- 인수 조건:\n  - 조건\n- 상태: 미착수\n';
  const head = `# 요구사항\n\n${REQ}`;
  const block = (inner: string) => `<!-- b-studio-requirements\n${inner}\n-->\n`;
  const deep = block(`${'['.repeat(2100)}${']'.repeat(2100)}`);
  const before = head + block(JSON.stringify({ requirements: [{ id: 'R1', hash: 'a' }], assumptions: [], manualSteps: [] }, null, 2));
  const after = head + deep;
  const UNREADABLE = { id: '(요구사항 밖)', source: 'JSON 블록', kind: 'changed', record: '(JSON 블록이 너무 깊어 읽지 못했습니다)' };

  it('너무 깊은 JSON 블록은 위조로 센다', () => {
    const diff = impl.diffVerificationRecords(undefined, after);
    expect(diff.forged).toEqual([UNREADABLE]);
    expect(impl.hasVerificationTamper(diff)).toBe(true);
    expect(impl.reviewRequirementRecords(before, after)[0]?.name).toBe('manual-verification');
    expect(impl.reviewRequirementRecords(before, after)[0]?.ok).toBe(false);
  });

  it('실행 전 문서의 블록이 너무 깊어도 위조로 센다', () => {
    const diff = impl.diffVerificationRecords(after, `${head}${block('{"requirements":[{"id":"R1"}]}')}`);
    expect(diff.forged).toEqual([UNREADABLE]);
  });

  it('되돌릴 때는 읽지 못한 블록을 없는 것으로 보고 실행 전 항목을 다시 붙인다', () => {
    const body = JSON.stringify({ requirements: [{ id: 'R1', hash: 'a' }], assumptions: [], manualSteps: [] }, null, 2);
    expect(impl.restoreVerificationRecords(before, after)).toBe(`${head.trimEnd()}\n\n<!-- b-studio-requirements\n${body}\n-->\n`);
  });

  it('깊이 2000 이하는 읽는다(위조로 세지 않는다)', () => {
    const ok = head + block(`${'['.repeat(1500)}${']'.repeat(1500)}`);
    expect(impl.diffVerificationRecords(undefined, ok).forged).toEqual([]);
  });
});
