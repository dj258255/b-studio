import { describe, expect, it } from 'vitest';
import { cardLines } from './cards';
import { stripAnsi } from './screen';
import { detailLines } from './sidebar';
import { defaultSprite } from './sprite';
import { DEFAULT_THEME, fg } from './theme';
import type { DeskAgent, DeskItem } from './types';

// #953: 서버가 싣기 시작한 거절·실패 까닭(now.error), 서브에이전트 결과(result), 모르는 토큰(tokensUnknown)을 카드가 그린다
const NOW = Date.parse('2026-10-26T12:00:00Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const usage = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const item = (patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id: 's', title: '주문 리팩터링', projectName: 'shop', state: 'working', backend: 'claude-code', lastActivityAt: ago(5), ...patch });
const sub = (id: string, patch: Partial<DeskAgent> = {}): DeskAgent => ({ id, name: 'Explore', type: 'Explore', kind: 'subagent', state: 'done', tokens: usage(0), ...patch });
const draw = (target: DeskItem, selected = false) =>
  cardLines({ item: target, selected, flagged: false, withLimits: false, sprite: defaultSprite('claude-code') }, 84, DEFAULT_THEME, NOW);

describe('거절·실패한 도구', () => {
  const denied = item({ now: { tool: 'Bash', target: 'pnpm test', at: ago(17), running: false, error: '거절됨: 샌드박스를 켜지 못했습니다' } });

  it('지금 줄에 정상 진행("실행 pnpm test · 17초 전") 대신 까닭을 빨강으로 보인다', () => {
    const lines = draw(denied);
    const plain = lines.map(stripAnsi).join('\n');
    expect(plain).toContain('거절됨: 샌드박스를 켜지 못했습니다');
    expect(plain).not.toContain('17초 전');
    const line = lines.find((entry) => stripAnsi(entry).includes('거절됨'))!;
    expect(line).toContain(fg(DEFAULT_THEME, 'red'));
  });

  it('권한 대기와 오류가 함께면 머리는 권한 대기, 지금 줄에는 오류를 보인다', () => {
    const both = item({ ...denied, terminal: { cli: 'up', waiting: 'permission', message: 'Bash 허락 필요: rm -rf build' } });
    const plain = draw(both).map(stripAnsi);
    expect(plain[1]).toContain('권한 대기');
    expect(plain.join('\n')).toContain('거절됨: 샌드박스를 켜지 못했습니다');
  });
  it('좁으면 까닭보다 대상(경로)을 먼저 줄인다', () => {
    const long = item({ now: { tool: 'Edit', target: 'infra/terraform/environments/production/modules/network/vpc/subnets/main.tf', at: ago(17), running: false, error: '거절됨: 쓰기 범위 밖입니다' } });
    expect(draw(long).map(stripAnsi).join('\n')).toContain('거절됨: 쓰기 범위 밖입니다');
  });
});

describe('서브에이전트 결과', () => {
  it('고른 카드에 끝난 서브에이전트의 마지막 답을 보인다', () => {
    const target = item({ state: 'idle', agents: [sub('x', { description: '호출부 찾기', result: '주문 호출부는 세 곳입니다' })] });
    expect(draw(target, true).map(stripAnsi).join('\n')).toContain('주문 호출부는 세 곳입니다');
  });
});

describe('모르는 토큰', () => {
  it('tokensUnknown이면 토큰 값이 와도 적지 않는다', () => {
    const text = detailLines(item({ agents: [sub('x', { tokens: usage(1200), tokensUnknown: true })] })).map((line) => line.text).join('\n');
    expect(text).not.toContain('토큰');
  });
});

