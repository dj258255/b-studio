import { describe, expect, it } from 'vitest';
import { aggregateModelStats, estimateCost, routeModel, validateModelProfiles, type ModelProfile } from './model-router';

const models: ModelProfile[] = [
  {
    id: 'fast',
    provider: 'anthropic',
    model: 'fast-model',
    label: '빠른 모델',
    capabilities: ['tools', 'json'],
    contextWindow: 100_000,
    pricing: { inputPerMillion: 1, outputPerMillion: 4 },
    baselineQuality: 0.72,
    baselineLatencyMs: 1_000,
  },
  {
    id: 'strong',
    provider: 'openai',
    model: 'strong-model',
    label: '강한 모델',
    capabilities: ['tools', 'reasoning', 'long-context', 'json'],
    contextWindow: 400_000,
    pricing: { inputPerMillion: 8, outputPerMillion: 32 },
    baselineQuality: 0.96,
    baselineLatencyMs: 5_000,
  },
];

describe('routeModel', () => {
  it('단순 요청은 비용과 지연이 낮은 모델을 선택한다', () => {
    const decision = routeModel(models, { prompt: '버튼 문구를 바꿔줘', intent: 'build' });
    expect(decision.complexity).toBe('simple');
    expect(decision.selected.id).toBe('fast');
  });

  it('결제와 마이그레이션이 포함된 복잡한 요청은 품질을 우선한다', () => {
    const prompt = ['결제 데이터 마이그레이션 아키텍처를 설계해줘', ...Array.from({ length: 13 }, (_, index) => `${index}. 보안 조건`)].join('\n');
    const decision = routeModel(models, { prompt, intent: 'build' });
    expect(decision.risk).toBe('high');
    expect(decision.complexity).toBe('complex');
    expect(decision.selected.id).toBe('strong');
  });

  it('같은 평가셋의 실측 통과 결과를 다음 선택에 반영한다', () => {
    const observations = [
      ...Array.from({ length: 20 }, () => ({ modelId: 'fast', passed: true, latencyMs: 800, costUsd: 0.001 })),
      ...Array.from({ length: 20 }, () => ({ modelId: 'strong', passed: false, latencyMs: 8_000, costUsd: 0.1 })),
    ];
    const decision = routeModel(models, { prompt: '인증 로직을 점검해줘', intent: 'ask' }, aggregateModelStats(observations));
    expect(decision.selected.id).toBe('fast');
    expect(decision.candidates[0]?.reasons.join(' ')).toContain('실측 통과율');
  });

  it('가격표 추정보다 모델의 실제 평균 비용을 우선한다', () => {
    const expensiveInPractice = Array.from({ length: 10 }, () => ({ modelId: 'fast', passed: true, latencyMs: 900, costUsd: 0.5 }));
    const cheapInPractice = Array.from({ length: 10 }, () => ({ modelId: 'strong', passed: true, latencyMs: 900, costUsd: 0.001 }));
    const decision = routeModel(models, { prompt: '문구를 다듬어줘', intent: 'ask' }, aggregateModelStats([...expensiveInPractice, ...cheapInPractice]));
    expect(decision.selected.id).toBe('strong');
    expect(decision.candidates.find((candidate) => candidate.model.id === 'strong')?.reasons.join(' ')).toContain('실측 평균 비용');
  });

  it('도구 기능과 비용 한도를 만족하지 못한 후보를 제외한다', () => {
    const withoutTools = { ...models[0]!, capabilities: ['json'] as ModelProfile['capabilities'] };
    const decision = routeModel([withoutTools, models[1]!], { prompt: '파일을 고쳐줘', intent: 'build', maxCostUsd: 1 });
    expect(decision.selected.id).toBe('strong');
    expect(decision.candidates.find((candidate) => candidate.model.id === 'fast')?.eligible).toBe(false);
  });

  it('지정한 모델이 조건을 만족하면 자동 점수보다 우선한다', () => {
    expect(routeModel(models, { prompt: '문구 수정', intent: 'build', preferredModelId: 'strong' }).selected.id).toBe('strong');
  });
});

describe('model registry', () => {
  it('중복 id와 원격 http 주소를 거부한다', () => {
    expect(() => validateModelProfiles([models[0], models[0]])).toThrow('겹칩니다');
    expect(() => validateModelProfiles([{ ...models[0], baseUrl: 'http://example.com' }])).toThrow('https');
  });

  it('실제 사용량을 단가로 환산한다', () => {
    expect(estimateCost(models[0]!, { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(1.4);
  });
});
