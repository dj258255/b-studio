import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as oldGuard from './requirement-integrity-legacy';
import * as curGuard from './requirement-integrity';

/**
 * 요구사항 문서 읽기·쓰기(ADR-191 3단계 3ab)의 벡터. 기대값은 옮기기 전 TS(`requirements-legacy.ts`의 `parseRequirementsMarkdown`·`serializeRequirementsMarkdown`)가 낸 JSON 글자다
 * (`requirements-markdown-vectors.json`). `VECTORS_AGAINST_LEGACY=1`로 돌리면 같은 벡터를 옛 TS에 넣는다(0건 실패해야 한다).
 * 인식하는 줄 꼴마다 거의 같은 거부 입력을 넣었다: 붙여 쓴 것, 탭, 앞 공백, 다른 글머리, 대소문자, 콜론 앞 공백, 빈 값, 숫자 꼴(0·거대한 수·2^53 앞뒤), 스키마 상한의 같음·±1(제목 200, 인수 조건 500, sha 4·40, 의존 20, 가정 300 등),
 * JSON 블록 꼴(표지 붙임·대문자·닫는 표시 없음·둘·`-->` 포함), 두 절의 머리 꼴, 줄 끝 글자(CR·U+2028·BOM).
 * 의도한 차이는 이 파일의 둘째 묶음(3x 읽기 대조)뿐이다. 옛 TS(옛 읽기 + 옛 3x)는 놓치고 새 구현은 잡는다.
 */
interface Vector {
  name: string;
  fn: 'parse' | 'serialize';
  args: unknown[];
  out: string;
}
const { vectors } = JSON.parse(readFileSync(new URL('./requirements-markdown-vectors.json', import.meta.url), 'utf8')) as { vectors: Vector[] };
const impl = (await import(process.env.VECTORS_AGAINST_LEGACY ? './requirements-legacy' : './requirements')) as typeof import('./requirements');

function run(vector: Vector): string {
  try {
    if (vector.fn === 'parse') return JSON.stringify(impl.parseRequirementsMarkdown(vector.args[0] as string)) ?? 'undefined';
    const [requirements, statusById, assumptions, manualSteps] = vector.args as [never, never, never, never];
    return JSON.stringify(impl.serializeRequirementsMarkdown(requirements, statusById, assumptions, manualSteps)) ?? 'undefined';
  } catch {
    return JSON.stringify({ __throws: true });
  }
}

describe('요구사항 문서 읽기·쓰기 벡터', () => {
  it('입력이 비지 않았다', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(250);
    const parses = vectors.filter((v) => v.fn === 'parse');
    expect(parses.length).toBeGreaterThan(200);
    // 읽은 요구사항이 있는 것과 빈 결과가 모두 있다
    expect(parses.filter((v) => (JSON.parse(v.out) as { requirements: unknown[] }).requirements.length > 0).length).toBeGreaterThan(100);
    expect(parses.filter((v) => (JSON.parse(v.out) as { requirements: unknown[] }).requirements.length === 0).length).toBeGreaterThan(20);
    expect(vectors.filter((v) => v.fn === 'serialize').length).toBeGreaterThanOrEqual(40);
    expect(vectors.filter((v) => v.out.includes('__throws')).length).toBeGreaterThan(0);
  });

  it.each(vectors)('$name', (vector) => {
    expect(run(vector)).toBe(vector.out);
  });
});

/**
 * 3x와 읽기의 대조: 헤딩 앞뒤 어디에 둔 "- 확인:" 줄을 읽기가 어느 요구사항에 올리는지, 위조 판정이 그것을 놓치지 않는지.
 * 읽기는 요구사항이 아닌 `## ` 절을 만나도 직전 요구사항 헤딩을 놓지 않는다(`## 가정` 아래의 줄도 R1의 확인이 된다). 옛 3x는 그 줄을 `(요구사항 밖)` 기록으로만 보아,
 * 실행 전 문서의 `(요구사항 밖)` 기록과 글이 같으면 요구사항에 올라간 새 확인을 놓쳤다(트러블슈팅 177).
 */
describe('3x 기록 읽기와 읽기의 대조', () => {
  const rec = '- 확인: 범수 · 2026-10-01 · 체크포인트 abc1234 · 메모 x';
  const req = '## R1. 제목\n- 종류: api · 우선순위: must\n- 인수 조건:\n  - a\n- 상태: 미착수\n';
  const req2 = '## R2. 둘째\n- 종류: api · 우선순위: must\n- 인수 조건:\n  - b\n- 상태: 미착수\n';

  it('옛 3x는 놓치고 새 3x는 잡는다: 첫 헤딩 앞의 기록을 `## 가정` 아래로 옮겨 R1에 붙인다', () => {
    const before = `# 요구사항\n${rec}\n\n${req}`;
    const after = `# 요구사항\n\n${req}\n## 가정\n${rec}\n`;
    const read = (doc: string) => impl.parseRequirementsMarkdown(doc).requirements[0]?.manualVerification;
    expect(read(before)).toBeUndefined();
    expect(read(after)).toMatchObject({ by: '범수', sha: 'abc1234' });
    const diff = curGuard.diffVerificationRecords(before, after);
    expect(diff.forged).toEqual([{ id: 'R1', source: '본문', kind: 'added', record: '범수 · 2026-10-01 · 체크포인트 abc1234 · 메모 x' }]);
    expect(curGuard.hasVerificationTamper(diff)).toBe(true);
    // 옛 3x는 같은 글의 `(요구사항 밖)` 기록이 그대로라고 보았다
    expect(oldGuard.hasVerificationTamper(oldGuard.diffVerificationRecords(before, after))).toBe(false);
  });

  it('요구사항 헤딩을 옮겨 `## 가정` 아래의 같은 기록을 다른 요구사항에 붙인 것도 잡는다', () => {
    const before = `# 요구사항\n\n${req}\n## 가정\n${rec}\n\n${req2}`;
    const after = `# 요구사항\n\n${req}\n${req2}\n## 가정\n${rec}\n`;
    const read = (doc: string) => impl.parseRequirementsMarkdown(doc).requirements.map((r) => [r.id, r.manualVerification?.by]);
    expect(read(before)).toEqual([['R1', '범수'], ['R2', undefined]]);
    expect(read(after)).toEqual([['R1', undefined], ['R2', '범수']]);
    expect(curGuard.diffVerificationRecords(before, after).forged.map((f) => f.id)).toEqual(['R2']);
    expect(oldGuard.hasVerificationTamper(oldGuard.diffVerificationRecords(before, after))).toBe(false);
  });

  it('거부 입력: 읽기가 올리는 요구사항이 그대로면 잡지 않는다(같은 자리·같은 글)', () => {
    const doc = `# 요구사항\n\n${req}\n## 가정\n${rec}\n`;
    expect(curGuard.hasVerificationTamper(curGuard.diffVerificationRecords(doc, doc))).toBe(false);
    expect(curGuard.hasVerificationTamper(curGuard.diffVerificationRecords(doc, `${doc}\n- 가정 하나\n`))).toBe(false);
  });

  it('거부 입력: 읽기가 버리는 줄(첫 헤딩 앞)로 옮긴 기록은 요구사항에 올라가지 않으므로 잡지 않는다', () => {
    const before = `# 요구사항\n\n${req}\n## 가정\n${rec}\n`;
    const after = `# 요구사항\n${rec}\n\n${req}`;
    expect(impl.parseRequirementsMarkdown(after).requirements[0]?.manualVerification).toBeUndefined();
    expect(curGuard.hasVerificationTamper(curGuard.diffVerificationRecords(before, after))).toBe(false);
  });

  it('글이 조금 다르면 기존처럼 위조다(접두·대소문자·한 글자)', () => {
    const before = `# 요구사항\n${rec}\n\n${req}`;
    for (const changed of [rec.replace('abc1234', 'abc12345'), rec.replace('abc1234', 'ABC1234'), rec.replace('x', 'xx'), rec.replace('범수', '범'), `${rec} `.replace('메모 x ', '메모 x ')]) {
      const after = `# 요구사항\n\n${req}\n## 가정\n${changed}\n`;
      expect(curGuard.hasVerificationTamper(curGuard.diffVerificationRecords(before, after)), changed).toBe(true);
    }
  });
});

/** 짝 없는 서로게이트가 napi 경계에서 U+FFFD로 합쳐지지 않는다 */
describe('요구사항 문서의 짝 없는 서로게이트', () => {
  const lone = ['\ud800', '\udbff', '\udc00', '\udfff', '', '', ''];
  const requirement = (title: string, note = 'n') => ({ id: 'R1', title, kind: 'api' as const, priority: 'must' as const, acceptance: ['a'], manualVerification: { by: 'b', at: '2026-10-01', sha: 'abcd', note } });

  it('서로 다른 짝 없는 서로게이트는 쓰고 읽어도 서로 다른 값이다(합쳐지면 다른 글이 같아진다)', () => {
    const seen = new Set<string>();
    for (const unit of lone) {
      const title = `t${unit}`;
      const text = impl.serializeRequirementsMarkdown([requirement(title)]);
      const back = impl.parseRequirementsMarkdown(text).requirements[0]!;
      expect(back.title).toBe(title);
      seen.add(back.title);
      expect(text).not.toContain('�');
    }
    expect(seen.size).toBe(lone.length);
  });

  it('JSON 블록의 `\\ud800` 이스케이프도 글자 그대로 읽는다(몸통이 망가져 블록으로 되돌아갈 때)', () => {
    for (const unit of lone) {
      const written = impl.serializeRequirementsMarkdown([requirement(`t${unit}`)]);
      const broken = written.replace('- 종류: api · 우선순위: must\n', '');
      const back = impl.parseRequirementsMarkdown(broken).requirements[0]!;
      expect(back.title).toBe(`t${unit}`);
    }
  });

  it('3x가 읽는 확인 기록과 같은 글자다: 서로 다른 짝 없는 서로게이트의 기록은 다른 기록이다', () => {
    const doc = (note: string) => impl.serializeRequirementsMarkdown([requirement('t', note)]);
    expect(curGuard.hasVerificationTamper(curGuard.diffVerificationRecords(doc('x\ud800'), doc('x\ud801')))).toBe(true);
    expect(curGuard.hasVerificationTamper(curGuard.diffVerificationRecords(doc('x\ud800'), doc('x\ud800')))).toBe(false);
    expect(curGuard.hasVerificationTamper(curGuard.diffVerificationRecords(doc('x'), doc('x\ud800')))).toBe(true);
  });
});
