import type { AgentUsage } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import { costForUsageByModel, estimateCostUsd, matchTokenPrices, parsePriceTable, type TokenPrices } from './token-types';

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0): AgentUsage => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
const prices = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0): TokenPrices => ({ inputPerM: input, outputPerM: output, cacheReadPerM: cacheRead, cacheWritePerM: cacheWrite });

describe('estimateCostUsd', () => {
  it('백만 토큰당 단가로 환산한다', () => {
    expect(estimateCostUsd(usage(1_000_000, 1_000_000, 0, 0), prices(3, 15, 0, 0))).toBeCloseTo(18, 8);
    expect(estimateCostUsd(usage(0, 0, 1_000_000, 1_000_000), prices(0, 0, 0.3, 3.75))).toBeCloseTo(4.05, 8);
  });
});

describe('matchTokenPrices', () => {
  const table = { haiku: prices(1), 'haiku-4-5': prices(2), sonnet: prices(3), 'sonnet-5': prices(4) };

  it('키가 모델 이름에 포함되면 매칭하고, 여러 개면 가장 긴 키를 쓴다', () => {
    expect(matchTokenPrices(table, 'claude-haiku-4-5-20251001')).toBe(table['haiku-4-5']);
    expect(matchTokenPrices(table, 'claude-sonnet-5')).toBe(table['sonnet-5']);
    expect(matchTokenPrices(table, 'claude-sonnet-4-5')).toBe(table.sonnet);
  });

  it('맞는 키가 없으면 undefined', () => {
    expect(matchTokenPrices(table, 'gpt-5-codex')).toBeUndefined();
  });
});

describe('parsePriceTable', () => {
  it('올바른 표를 그대로 돌려준다', () => {
    const table = { 'haiku-4-5': { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 } };
    expect(parsePriceTable(table)).toEqual(table);
  });

  it('형식이 틀리면 오류를 낸다', () => {
    expect(() => parsePriceTable(null)).toThrow(/형식/);
    expect(() => parsePriceTable([])).toThrow(/형식/);
    expect(() => parsePriceTable({})).toThrow(/항목이 없습니다/);
    expect(() => parsePriceTable({ a: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1 } })).toThrow(/cacheWritePerM/);
    expect(() => parsePriceTable({ a: { inputPerM: -1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1 } })).toThrow(/inputPerM/);
  });
});

describe('costForUsageByModel', () => {
  const table = { haiku: prices(1, 5, 0.1, 1.25), sonnet: prices(3, 15, 0.3, 3.75) };

  it('모델별 단가를 찾아 비용을 더한다', () => {
    const cost = costForUsageByModel({ 'claude-haiku-4-5': usage(1_000_000, 0), 'claude-sonnet-5': usage(0, 1_000_000) }, table);
    expect(cost.costUsd).toBeCloseTo(1 + 15, 8);
    expect(cost.costNote).toBeUndefined();
  });

  it('단가가 없는 모델이 하나라도 있으면 비용 대신 사유를 돌려준다', () => {
    const cost = costForUsageByModel({ 'claude-haiku-4-5': usage(1_000_000, 0), 'gpt-5-codex': usage(0, 1_000_000) }, table);
    expect(cost.costUsd).toBeUndefined();
    expect(cost.costNote).toBe('단가 없음: gpt-5-codex');
  });

  it('모델이 없으면 아무것도 돌려주지 않는다', () => {
    expect(costForUsageByModel({}, table)).toEqual({});
  });
});
