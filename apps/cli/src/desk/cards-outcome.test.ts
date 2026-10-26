import { describe, expect, it } from 'vitest';
import { cardLines, headStatus, needsYou, remainingText, spaceScreen } from './cards';
import { initialState, type DeskState } from './keys';
import { stripAnsi } from './screen';
import { agentStatus, detailLines } from './sidebar';
import { defaultSprite } from './sprite';
import { DEFAULT_THEME } from './theme';
import type { DeskItem } from './types';

// #956: 2차 실사용 점검에서 나온 카드 문제. 쓰기가 모두 거절된 요청이 끝나면 성공처럼 보였다(완료 선언을 믿지 않는다)
const NOW = Date.parse('2026-10-26T12:00:00Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const item = (patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id: 's', title: '결제 실패 경로', projectName: 'broken', state: 'idle', backend: 'claude-code', lastActivityAt: ago(50), ...patch });
const draw = (target: DeskItem, options: { selected?: boolean; unseen?: boolean } = {}) =>
  cardLines({ item: target, selected: options.selected ?? false, unseen: options.unseen ?? false, flagged: false, withLimits: false, sprite: defaultSprite('claude-code') }, 84, DEFAULT_THEME, NOW).map(stripAnsi);

describe('쓰기가 거절된 채 끝난 요청', () => {
  const denied = item({
    terminal: { cli: 'up', waiting: 'idle' },
    turnDenied: 3,
    todos: { done: 7, total: 7 },
    lastMessage: '주문 상태를 한 곳에서 바꾸게 묶었습니다.',
    gate: { state: 'none', checkpoints: 0 },
  });

  it('머리에 "쓰기 N번 거절"을 보이고 흐린 CLI 대기로 두지 않는다', () => {
    const head = headStatus(denied);
    expect(head.label).toBe('쓰기 3번 거절');
    expect(head.tone).toBe('fail');
    expect(draw(denied)[1]).toContain('쓰기 3번 거절');
    expect(draw(denied)[1]).not.toContain('CLI 대기');
  });

  it('지금 줄에 검증하지 않았다는 것을 적는다', () => {
    expect(draw(denied).join('\n')).toContain('검증하지 않음');
  });

  it('확인 필요 줄에 오르고 거절 까닭을 적는다', () => {
    expect(needsYou({ items: [denied] }).map((entry) => entry.item.id)).toEqual(['s']);
    const withWhy = { ...denied, now: { tool: 'Bash', at: ago(60), running: false, error: '거절됨: 샌드박스를 켜지 못했습니다' } };
    const screen = spaceScreen({ ...initialState(), items: [withWhy], view: 'space' } as DeskState, { x: 0, y: 0, w: 120, h: 30 }, NOW).lines.map(stripAnsi).join('\n');
    expect(screen).toContain('쓰기 3번 거절 · 거절됨: 샌드박스를 켜지 못했습니다');
  });

  it('검증을 통과했으면 머리는 검증 통과이고 거절 수는 지금 줄에 남긴다', () => {
    const passed = { ...denied, gate: { state: 'passed' as const, checkpoints: 1 } };
    expect(headStatus(passed).label).toBe('검증 통과');
    expect(draw(passed).join('\n')).toContain('쓰기 3번 거절');
  });

  it('작업 중이면 머리는 그대로 작업 중이다(끝난 뒤에만 결과로 올린다)', () => {
    const working = { ...denied, state: 'working' as const, terminal: { cli: 'up' as const }, workingSince: ago(90) };
    expect(headStatus(working).label).toBe('작업 중');
  });
});

describe('검증하지 않고 끝난 요청', () => {
  it('마지막 답이 있고 게이트가 판정하지 않았으면 지금 줄에 "검증하지 않음"을 흐리게 적는다', () => {
    const quiet = item({ terminal: { cli: 'up', waiting: 'idle' }, lastMessage: '고쳤습니다.', gate: { state: 'none', checkpoints: 0 } });
    expect(draw(quiet)[2]).toContain('검증하지 않음');
  });

  it('검증을 통과했으면 적지 않는다', () => {
    const passed = item({ terminal: { cli: 'up', waiting: 'idle' }, lastMessage: '고쳤습니다.', gate: { state: 'passed', checkpoints: 1 } });
    expect(draw(passed).join('\n')).not.toContain('검증하지 않음');
  });
});

describe('끝난 카드의 결과 머리', () => {
  it('끝났지만 아직 안 본 세션도 검증을 통과했으면 머리에 "검증 통과"를 보인다', () => {
    const done = item({ terminal: { cli: 'up', waiting: 'idle' }, gate: { state: 'passed', checkpoints: 1 } });
    const head = headStatus(done, true);
    expect(head.label).toBe('검증 통과');
    expect(head.tone).toBe('ok');
  });
});

describe('소식 없음일 때 남은 시간 추정', () => {
  it('작업 중이어도 도구가 돌지 않고 3분 넘게 조용하면 추정을 적지 않는다', () => {
    const stale = item({ state: 'working', workingSince: ago(600), lastActivityAt: ago(300), todos: { done: 3, total: 7 }, now: { tool: 'Edit', at: ago(300), running: false } });
    expect(remainingText(stale, NOW)).toBe('');
  });

  it('소식이 이어지면 지금처럼 추정한다', () => {
    const fresh = item({ state: 'working', workingSince: ago(600), lastActivityAt: ago(10), todos: { done: 3, total: 7 }, now: { tool: 'Edit', at: ago(10), running: false } });
    expect(remainingText(fresh, NOW)).toContain('남음(추정)');
  });
});

describe('펼친 카드의 범위 문구', () => {
  it('"도구 CLI 기본 · 쓸 곳", "검사 CLI 권한 확인 + …" 대신 사람이 알아듣는 말로 적는다', () => {
    const lines = detailLines(item({ capabilities: { backend: 'claude-code', tools: 'cli-default', writeScope: '세션 작업 복사본 전체', permission: 'CLI 권한 확인 + 쓰기 직전 관문 + 턴 끝 게이트' } })).map((line) => line.text);
    const text = lines.join('\n');
    expect(text).not.toContain('도구 CLI 기본');
    expect(text).not.toContain('검사 CLI 권한 확인');
    expect(text).toContain('쓸 수 있는 곳 세션 작업 복사본 전체');
    expect(text).toContain('끝나면 검증');
  });
});

describe('샌드박스를 아직 켜지 않은 새 세션', () => {
  it('CLI가 떠 있으면 "꺼짐"으로 보이지 않는다', () => {
    expect(agentStatus(item({ state: 'dormant', terminal: { cli: 'up' } })).label).not.toBe('꺼짐');
    expect(agentStatus(item({ state: 'dormant', terminal: { cli: 'up' }, workingSince: ago(20) })).label).toBe('작업 중');
  });

  it('CLI도 떠 있지 않으면 지금처럼 꺼짐이다', () => {
    expect(agentStatus(item({ state: 'dormant' })).label).toBe('꺼짐');
  });
});
