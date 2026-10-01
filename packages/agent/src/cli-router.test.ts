import { describe, expect, it } from 'vitest';
import { CLI_TIERS, higherCliTier, nextCliTier, routeCliTier } from './cli-router';

describe('routeCliTier', () => {
  it('읽기만 하는 질문은 haiku를 고른다', () => {
    const decision = routeCliTier({ prompt: '이 함수가 뭘 하는지 설명해줘', intent: 'ask' });
    expect(decision.tier).toBe('haiku');
    expect(decision.stuckTo).toBe(false);
  });

  it('단순한 만들기 요청은 sonnet을 고른다', () => {
    const decision = routeCliTier({ prompt: '버튼 문구를 바꿔줘', intent: 'build' });
    expect(decision.tier).toBe('sonnet');
    expect(decision.complexity).toBe('simple');
  });

  it('복잡한 만들기 요청은 opus를 고른다', () => {
    const prompt = ['멀티서비스 마이그레이션 아키텍처를 설계해줘', ...Array.from({ length: 13 }, (_, index) => `${index}. 조건`)].join('\n');
    const decision = routeCliTier({ prompt, intent: 'build' });
    expect(decision.complexity).toBe('complex');
    expect(decision.tier).toBe('opus');
  });

  it('인증·결제처럼 위험한 요청은 짧아도 opus를 고른다', () => {
    const decision = routeCliTier({ prompt: '결제 승인 로직을 고쳐줘', intent: 'build' });
    expect(decision.risk).toBe('high');
    expect(decision.tier).toBe('opus');
  });

  it('만들기 요청에는 haiku를 쓰지 않는다(E9: Haiku 단독은 성공률이 낮았다)', () => {
    const decision = routeCliTier({ prompt: '오타를 고쳐줘', intent: 'build' });
    expect(decision.tier).not.toBe('haiku');
  });

  it('stickiness: opus로 이미 성공한 세션은 단순 요청에도 내리지 않는다', () => {
    const decision = routeCliTier({ prompt: '버튼 문구를 바꿔줘', intent: 'build', stickyTier: 'opus' });
    expect(decision.tier).toBe('opus');
    expect(decision.stuckTo).toBe(true);
  });

  it('stickiness는 읽기만 하는 질문에는 적용하지 않는다(캐시 재사용보다 비용을 우선)', () => {
    const decision = routeCliTier({ prompt: '이 코드가 왜 이렇게 동작하는지 알려줘', intent: 'ask', stickyTier: 'opus' });
    expect(decision.tier).toBe('haiku');
  });

  it('sonnet으로 성공한 세션에서 위험한 요청이 오면 내리지 않고 그대로 opus로 올라간다(승격, 하강 아님)', () => {
    const decision = routeCliTier({ prompt: '인증 토큰 검증 로직을 고쳐줘', intent: 'build', stickyTier: 'sonnet' });
    expect(decision.tier).toBe('opus');
    expect(decision.stuckTo).toBe(false);
  });

  it('빈 요청은 오류를 던진다', () => {
    expect(() => routeCliTier({ prompt: '   ', intent: 'build' })).toThrow();
  });
});

describe('nextCliTier', () => {
  it('haiku 다음은 sonnet, sonnet 다음은 opus다', () => {
    expect(nextCliTier('haiku')).toBe('sonnet');
    expect(nextCliTier('sonnet')).toBe('opus');
  });

  it('opus는 이미 최고 단계라 더 올릴 곳이 없다', () => {
    expect(nextCliTier('opus')).toBeUndefined();
  });
});

describe('higherCliTier', () => {
  it('아직 쓴 적 없으면(undefined) 새 값을 그대로 쓴다', () => {
    expect(higherCliTier(undefined, 'sonnet')).toBe('sonnet');
  });

  it('더 높은(비싼) 쪽을 남긴다', () => {
    expect(higherCliTier('sonnet', 'haiku')).toBe('sonnet');
    expect(higherCliTier('haiku', 'opus')).toBe('opus');
  });
});

describe('CLI_TIERS', () => {
  it('haiku < sonnet < opus 순서를 고정한다', () => {
    expect(CLI_TIERS).toEqual(['haiku', 'sonnet', 'opus']);
  });
});
