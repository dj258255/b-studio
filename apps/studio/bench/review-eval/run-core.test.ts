import { describe, expect, it } from 'vitest';
import type { ModelAsk } from '@b-studio/agent';
import { EVAL_CASES } from './cases';
import { parseArgs } from './args';
import { compareResults, formatComparison } from './compare';
import { oracleAsk, promptHash, runEval } from './run-core';

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const now = () => new Date('2026-01-01T00:00:00Z');
const emptyAsk: ModelAsk = async () => ({ text: '{"findings":[]}', usage });

describe('runEval', () => {
  it('기대 지적을 그대로 돌려주는 가짜 리뷰어는 재현율 100%, 오탐·범위 밖·못 읽음 0이다', async () => {
    const r = await runEval({ ask: oracleAsk(), askName: 'fake', now });
    expect(r.totals).toMatchObject({ recall: 1, falsePositives: 0, outOfScope: 0, unreadable: 0, notInDiff: 0 });
    expect(r.totals.cleanPassed).toBe(r.totals.cleanItems);
    expect(r).toMatchObject({ ask: 'fake', model: null, startedAt: '2026-01-01T00:00:00.000Z' });
    expect(r.items).toHaveLength(EVAL_CASES.length);
  });
  it('아무것도 지적하지 않으면 재현율 0이고 결함 없는 항목은 통과한다', async () => {
    const r = await runEval({ ask: emptyAsk, askName: 'fake', model: 'm1', now });
    expect(r.totals.recall).toBe(0);
    expect(r.totals.cleanPassed).toBe(r.totals.cleanItems);
    expect(r.model).toBe('m1');
  });
  it('모델 호출이 던지면 그 항목만 응답 못 읽음이고 나머지는 계속 돈다', async () => {
    let n = 0;
    const flaky: ModelAsk = async (input, signal) => {
      n += 1;
      if (n === 1) throw new Error('구독 한도');
      return emptyAsk(input, signal);
    };
    const r = await runEval({ ask: flaky, askName: 'fake', now });
    expect(r.items[0]).toMatchObject({ readable: false, askError: '구독 한도' });
    expect(r.totals.unreadable).toBe(1);
    expect(r.items.slice(1).every((i) => i.readable)).toBe(true);
  });
  it('JSON이 아닌 응답은 응답 못 읽음이다(결함 없는 항목도 통과로 세지 않는다)', async () => {
    const r = await runEval({ ask: async () => ({ text: '문제 없어 보입니다', usage }), askName: 'fake', now });
    expect(r.totals.unreadable).toBe(EVAL_CASES.length);
    expect(r.totals.cleanPassed).toBe(0);
    expect(r.totals.recall).toBe(0);
  });
  it('프롬프트 해시는 항목 구성이 같으면 같다', () => {
    expect(promptHash()).toBe(promptHash(EVAL_CASES));
    expect(promptHash(EVAL_CASES.slice(1))).not.toBe(promptHash());
  });
});

describe('compareResults', () => {
  it('같은 세트의 전후를 견주고 달라진 항목을 알려 준다', async () => {
    const before = await runEval({ ask: emptyAsk, askName: 'fake', now });
    const after = await runEval({ ask: oracleAsk(), askName: 'fake', model: 'm2', now });
    const c = compareResults(before, after);
    expect(c.comparable).toBe(true);
    expect(c.recall).toMatchObject({ before: 0, after: 1, delta: 1 });
    expect(c.modelChanged).toBe(true);
    expect(c.changed.length).toBe(EVAL_CASES.filter((x) => x.expected.length > 0).length);
    expect(formatComparison(c)).toContain('0.0% → 100.0%');
  });
  it('세트 해시가 다르면 비교하지 않는다', async () => {
    const a = await runEval({ ask: emptyAsk, askName: 'fake', now });
    const b = { ...a, evalSetHash: 'other' };
    const c = compareResults(a, b);
    expect(c.comparable).toBe(false);
    expect(formatComparison(c)).toContain('비교할 수 없습니다');
  });
});

describe('parseArgs', () => {
  it('기본은 claude-code이고 --ask·--model·--out을 읽는다', () => {
    expect(parseArgs([])).toEqual({ ask: 'claude-code' });
    expect(parseArgs(['--ask', 'fake', '--model', 'x', '--out', 'o.json'])).toEqual({ ask: 'fake', model: 'x', out: 'o.json' });
  });
  it('모르는 값·인자·값 빠짐은 던진다', () => {
    expect(() => parseArgs(['--ask', 'gpt'])).toThrow();
    expect(() => parseArgs(['--x'])).toThrow();
    expect(() => parseArgs(['--model'])).toThrow();
  });
});
