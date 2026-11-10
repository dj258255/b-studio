import { readFileSync } from 'node:fs';
import { encodeLoneSurrogates, native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { Gen } from './differential-kit';
import * as old from './requirements-replies-legacy';
import * as cur from './requirements';
import { parsePlannerReply } from './task-plan';

/**
 * 모델 답 읽기(ADR-191 3단계 3ad)의 벡터. 기대값은 옮기기 전 TS(`requirements-replies-legacy.ts`)가 낸 JSON 글자다(`requirements-replies-vectors.json`).
 * `VECTORS_AGAINST_LEGACY=1`로 돌리면 같은 벡터를 옛 TS에 넣는다. 그러면 `intended`(의도한 차이: 낱말 중간을 자른 ASCII 인용을 옛 TS는 "명세에 있음"으로 읽는다, 트러블슈팅 179)만 실패해야 한다.
 * 인식하는 꼴마다 거의 같은 거부 입력을 넣었다: 펜스(표지 없음·대문자·붙임·하나뿐·네 개·안의 펜스), 목록 상한의 같음·±1(60·5·20·10·20, 시나리오 20), 인용의 대소문자·공백 종류·보이지 않는 글자·앞부분만·일부 낱말만·낱말 중간,
 * 코드 단위 300 경계(두 단위 글자·짝 없는 서로게이트·예약 글자), 상한 문구의 접두·접미·구분자·전각 숫자, JSON 이름의 대소문자·덧붙임·유니코드 접힘 글자.
 */
interface Vector { name: string; fn: string; args: unknown[]; out: unknown; intended?: boolean }
const { vectors } = JSON.parse(readFileSync(new URL('./requirements-replies-vectors.json', import.meta.url), 'utf8')) as { vectors: Vector[] };
const legacy = Boolean(process.env.VECTORS_AGAINST_LEGACY);

function recommendLegacy(text: string, spec: string): unknown {
  const raw = old.parsePlannerReplyLegacy(text);
  const result = cur.RecommendationReplySchema.safeParse(raw);
  if (!result.success) throw new Error(`추천 응답 형식이 올바르지 않습니다: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return { recommendations: old.enforceSpecQuoteEvidenceLegacy(result.data.recommendations as old.Recommendation[], spec) };
}

function call(vector: Vector): unknown {
  const [a, b] = vector.args as [never, never];
  switch (vector.fn) {
    case 'planner': return legacy ? old.parsePlannerReplyLegacy(a) : parsePlannerReply(a);
    case 'repair': return legacy ? old.repairExtractionReplyLegacy(a) : cur.repairExtractionReply(a);
    case 'recommend': return legacy ? recommendLegacy(a, b) : cur.parseRecommendationReply(a, b);
    case 'preview': return legacy ? old.firstLinesPreviewLegacy(a) : cur.buildReferencedFilePreview('x.txt', a, 1).preview;
    case 'jsonPath': return legacy ? old.isJsonPathLegacy(a) : native.reqReplyIsJsonPath(a);
    case 'tooBig': {
      if (legacy) {
        const match = old.REFERENCE_FILE_TOO_BIG.exec(a);
        return match ? Number(match[1]) : null;
      }
      return native.reqReplyTooBigBytes(a) ?? null;
    }
    case 'usage': {
      const [x, y] = vector.args as [number[], number[]];
      if (legacy) {
        const r = old.addUsageLegacy({ inputTokens: x[0]!, outputTokens: x[1]!, cacheReadTokens: x[2]!, cacheWriteTokens: x[3]! }, { inputTokens: y[0]!, outputTokens: y[1]!, cacheReadTokens: y[2]!, cacheWriteTokens: y[3]! });
        return [r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens];
      }
      return native.reqReplyAddUsage(x, y);
    }
    default: throw new Error(`모르는 fn ${vector.fn}`);
  }
}

function run(vector: Vector): string {
  try {
    return JSON.stringify(call(vector)) ?? JSON.stringify({ __undefined: true });
  } catch (error) {
    return JSON.stringify({ __throws: error instanceof Error ? error.message : String(error) });
  }
}

describe('모델 답 읽기 벡터', () => {
  it('입력이 비지 않았다', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(250);
    for (const fn of ['planner', 'repair', 'recommend', 'preview', 'jsonPath', 'tooBig', 'usage']) expect(vectors.filter((v) => v.fn === fn).length, fn).toBeGreaterThanOrEqual(6);
    // 값과 던짐이 모두 있다
    expect(vectors.filter((v) => JSON.stringify(v.out).includes('__throws')).length).toBeGreaterThan(5);
    expect(vectors.filter((v) => !JSON.stringify(v.out).includes('__throws')).length).toBeGreaterThan(200);
    // 근거가 유지된 추천과 강등된 추천이 모두 있다
    const recommends = vectors.filter((v) => v.fn === 'recommend' && !JSON.stringify(v.out).includes('__throws'));
    const bases = recommends.flatMap((v) => (v.out as { recommendations: Array<{ basis: string }> }).recommendations.map((r) => r.basis));
    expect(bases.filter((b) => b === 'spec').length).toBeGreaterThan(8);
    expect(bases.filter((b) => b === 'practice').length).toBeGreaterThan(30);
    expect(vectors.filter((v) => v.intended).length).toBeGreaterThanOrEqual(10);
  });

  it(legacy ? '옛 TS: 의도한 차이(intended)만 실패한다' : '새 구현은 모든 벡터와 같다', () => {
    const failed = vectors.filter((vector) => run(vector) !== JSON.stringify(vector.out));
    if (legacy) {
      expect(failed.filter((v) => !v.intended).map((v) => v.name)).toEqual([]);
      expect(failed.length).toBe(vectors.filter((v) => v.intended).length);
    } else {
      expect(failed.map((v) => v.name)).toEqual([]);
    }
  });

  it('입력을 고쳐 쓰지 않는다', () => {
    const raw = JSON.parse('{"requirements":[{"id":"R1","acceptance":["a",{"b":1}],"scenarios":[{"id":"R9.1"}],"nfr":null}],"questions":null}') as unknown;
    const before = JSON.stringify(raw);
    cur.repairExtractionReply(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe('짝 없는 서로게이트 성질', () => {
  it('인코딩하지 않고 보내면 서로 다른 짝 없는 서로게이트가 합쳐져 인용이 있다로 뒤집힌다(재현)', () => {
    // 경계에서 둘 다 U+FFFD가 되어 같은 글자가 된다 — 인코딩 없이 보낸 판정은 열린다
    expect(native.reqCoreVerifySpecQuote('\ud800', 'x\udc00y')).toBe(true);
    expect(old.verifySpecQuote('\ud800', 'x\udc00y')).toBe(false);
    // 껍데기는 인코딩해서 보내므로 열리지 않는다
    expect(cur.verifySpecQuote('\ud800', 'x\udc00y')).toBe(false);
    const text = `\`\`\`json\n${JSON.stringify({ recommendations: [{ question: 'q', answer: 'a', rationale: 'r', basis: 'spec', specQuote: '\ud800' }] })}\n\`\`\``;
    expect(cur.parseRecommendationReply(text, 'x\udc00y').recommendations[0]).toMatchObject({ basis: 'practice' });
    expect(cur.parseRecommendationReply(text, 'x\ud800y').recommendations[0]).toMatchObject({ basis: 'spec', specQuote: '\ud800' });
  });

  it('짝 없는 서로게이트만으로 만든 인용·명세 무작위: 열린 쪽 뒤집힘 0, 인코딩 없이 보낸 판정은 열린 쪽이 생긴다', () => {
    const pool = ['\ud800', '\ud801', '\udc00', '\udc01', '', '', 'a', ' ', '😀'];
    const g = new Gen(3);
    let flips = 0;
    let rawOpened = 0;
    let both = 0;
    for (let i = 0; i < 20000; i++) {
      const quote = g.text(pool, 1 + g.int(3));
      const spec = g.text(pool, 1 + g.int(6));
      const before = old.verifySpecQuote(quote, spec);
      const after = cur.verifySpecQuote(quote, spec);
      if (!before && after) flips += 1;
      if (before && after) both += 1;
      if (!before && native.reqCoreVerifySpecQuote(quote, spec)) rawOpened += 1;
      // 인코딩한 두 글자의 비교는 옛 TS(코드 단위 비교)와 같다. 예외는 문서에 적힌 닫는 쪽(옛 "있음" → 새 "없음": 짝의 일부)뿐이다
      if (before !== after) expect(before && !after, JSON.stringify([quote, spec])).toBe(true);
      void encodeLoneSurrogates;
    }
    expect(flips).toBe(0);
    expect(both).toBeGreaterThan(500);
    expect(rawOpened).toBeGreaterThan(100);
  });

  it('고친 답과 미리보기의 짝 없는 서로게이트가 글자 그대로 돌아온다', () => {
    const fixed = cur.repairExtractionReply({ requirements: [{ id: 'R1', title: '\ud800', acceptance: [{ a: '\udc00', '\ud800': 1 }], scenarios: [{ id: 'R9.1', then: 'x' }] }], questions: null }) as { requirements: Array<Record<string, unknown>>; questions: unknown[] };
    expect(fixed.questions).toEqual([]);
    expect(fixed.requirements[0]!.title).toBe('\ud800');
    expect(fixed.requirements[0]!.acceptance).toEqual(['{"a":"\\udc00","\\ud800":1}']);
    expect((fixed.requirements[0]!.scenarios as Array<Record<string, unknown>>)[0]).toEqual({ id: 'R1.1', then: 'x' });
    expect(cur.buildReferencedFilePreview('x.txt', `${'a'.repeat(299)}😀`, 1).preview).toBe(`${'a'.repeat(299)}\ud83d…`);
    expect(cur.buildReferencedFilePreview('x.txt', '\ud800\n\udc00', 1).preview).toBe('\ud800\n\udc00');
  });
});

describe('두 번 부른 사용량 합', () => {
  it('다시 물은 비용까지 더한다', async () => {
    const answers = ['형식이 틀린 답', JSON.stringify({ requirements: [{ id: 'R1', title: 't', kind: 'api', priority: 'must', acceptance: ['a'] }], questions: [] })];
    const usages = [
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
    ];
    let call = 0;
    const result = await cur.requestRequirementsExtraction(async () => {
      const index = call++;
      return { text: answers[index]!, usage: usages[index]! };
    }, '명세');
    expect(call).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 });
  });
});
