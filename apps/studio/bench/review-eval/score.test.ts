import { describe, expect, it } from 'vitest';
import { scoreCase, summarize } from './score';
import type { EvalCase } from './types';

const defectCase: EvalCase = {
  id: 'c1',
  language: 'typescript',
  request: 'r',
  diff: ['diff --git a/src/a.ts b/src/a.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/a.ts', '@@ -0,0 +1,3 @@', '+one', '+two', '+three', ''].join('\n'),
  expected: [{ file: 'src/a.ts', startLine: 2, endLine: 3, tag: 'off-by-one' }],
};
const cleanCase: EvalCase = { ...defectCase, id: 'c2', language: 'python', expected: [] };

const reply = (...findings: Array<{ file: string; line?: number }>) =>
  JSON.stringify({ findings: findings.map((f) => ({ severity: 'major', title: 't', detail: 'd', ...f })) });

describe('scoreCase', () => {
  it('파일이 같고 줄이 범위 안이면 맞음이다(양 끝 포함)', () => {
    expect(scoreCase(defectCase, reply({ file: 'src/a.ts', line: 2 })).expected[0]!.hit).toBe(true);
    expect(scoreCase(defectCase, reply({ file: 'src/a.ts', line: 3 })).expected[0]!.hit).toBe(true);
  });
  it('범위 바로 밖(1줄 앞·뒤)은 맞지 않고 범위 밖 지적으로 센다', () => {
    for (const line of [1, 4]) {
      const r = scoreCase(defectCase, reply({ file: 'src/a.ts', line }));
      expect(r.expected[0]!.hit).toBe(false);
      expect(r.outOfScope).toBe(1);
    }
  });
  it('다른 파일이면 줄이 맞아도 놓침이다', () => {
    const r = scoreCase(defectCase, reply({ file: 'src/b.ts', line: 2 }));
    expect(r.expected[0]!.hit).toBe(false);
    expect(r.outOfScope).toBe(1);
  });
  it('줄 없는 지적은 맞음으로 세지 않는다', () => {
    const r = scoreCase(defectCase, reply({ file: 'src/a.ts' }));
    expect(r.expected[0]!.hit).toBe(false);
    expect(r.outOfScope).toBe(1);
  });
  it('a/·b/ 접두와 ./, 역슬래시는 같은 경로로 본다', () => {
    expect(scoreCase(defectCase, reply({ file: 'b/src/a.ts', line: 2 })).expected[0]!.hit).toBe(true);
    expect(scoreCase(defectCase, reply({ file: './src\\a.ts', line: 2 })).expected[0]!.hit).toBe(true);
  });
  it('같은 결함을 여러 지적이 가리켜도 한 번만 맞고, 맞은 지적은 범위 밖이 아니다', () => {
    const r = scoreCase(defectCase, reply({ file: 'src/a.ts', line: 2 }, { file: 'src/a.ts', line: 3 }));
    expect(r.expected.filter((e) => e.hit)).toHaveLength(1);
    expect(r.outOfScope).toBe(0);
  });
  it('놓침: 지적이 없으면 hit 없음, 읽은 것으로 센다', () => {
    const r = scoreCase(defectCase, '{"findings":[]}');
    expect(r.readable).toBe(true);
    expect(r.expected[0]!.hit).toBe(false);
  });
  it('결함 없는 diff의 지적은 모두 오탐이다', () => {
    const r = scoreCase(cleanCase, reply({ file: 'src/a.ts', line: 2 }, { file: 'x', line: 1 }));
    expect(r.falsePositives).toBe(2);
    expect(r.outOfScope).toBe(0);
  });
  it('파싱 실패와 응답 없음은 응답 못 읽음이고 통과로 세지 않는다', () => {
    for (const bad of ['안녕하세요', '{"findings":[{"severity":"x"}]}', undefined]) {
      const r = scoreCase(cleanCase, bad);
      expect(r.readable).toBe(false);
      expect(r.parseError).toBeTruthy();
    }
    const t = summarize([scoreCase(cleanCase, '말만 있음')]);
    expect(t.unreadable).toBe(1);
    expect(t.cleanItems).toBe(1);
    expect(t.cleanPassed).toBe(0);
  });
  it('지적의 파일·줄이 diff에 없으면 notInDiff로 센다', () => {
    const r = scoreCase(defectCase, reply({ file: 'src/zzz.ts', line: 1 }, { file: 'src/a.ts', line: 2 }));
    expect(r.notInDiff).toBe(1);
  });
});

describe('summarize', () => {
  it('재현율·오탐·범위 밖·언어별·결함 종류별 합계를 낸다', () => {
    const two: EvalCase = {
      ...defectCase,
      id: 'c3',
      expected: [
        { file: 'src/a.ts', startLine: 1, endLine: 1, tag: 'boundary' },
        { file: 'src/a.ts', startLine: 3, endLine: 3, tag: 'off-by-one' },
      ],
    };
    const t = summarize([
      scoreCase(defectCase, reply({ file: 'src/a.ts', line: 2 }, { file: 'src/a.ts', line: 99 })),
      scoreCase(two, reply({ file: 'src/a.ts', line: 1 })),
      scoreCase(cleanCase, reply({ file: 'src/a.ts', line: 1 })),
      scoreCase(cleanCase, '{"findings":[]}'),
    ]);
    expect(t).toMatchObject({ items: 4, unreadable: 0, expected: 3, hits: 2, falsePositives: 1, cleanItems: 2, cleanPassed: 1, outOfScope: 1 });
    expect(t.recall).toBeCloseTo(2 / 3);
    expect(t.byTag['off-by-one']).toEqual({ expected: 2, hits: 1, recall: 0.5 });
    expect(t.byTag.boundary).toEqual({ expected: 1, hits: 1, recall: 1 });
    expect(t.byLanguage.typescript).toMatchObject({ expected: 3, hits: 2 });
    expect(t.byLanguage.python).toMatchObject({ expected: 0, hits: 0, recall: null });
  });
  it('못 읽은 결함 항목은 분모에 남고 맞음으로 세지 않는다', () => {
    const t = summarize([scoreCase(defectCase, 'nope')]);
    expect(t).toMatchObject({ expected: 1, hits: 0, unreadable: 1, recall: 0 });
  });
  it('기대 지적이 하나도 없으면 재현율은 없다(null)', () => {
    expect(summarize([scoreCase(cleanCase, '{"findings":[]}')]).recall).toBeNull();
  });
});
