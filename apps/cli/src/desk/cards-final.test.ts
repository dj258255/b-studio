import { describe, expect, it } from 'vitest';
import { cardLines, needsYou, spaceScreen } from './cards';
import { initialState, type DeskState } from './keys';
import { renderScreen } from './render';
import { stripAnsi } from './screen';
import { defaultSprite } from './sprite';
import { DEFAULT_THEME } from './theme';
import type { DeskItem } from './types';

// #959: 3차 실사용 점검에서 남은 것. 권한 대기 중에 이미 쓰기가 거절됐는데 카드는 "Bash 허락 필요"만 보여
// 쓰기가 막힌 줄 모르고 허락하게 됐다. 칸 머리는 카드와 다른 판정("CLI 대기")을 썼다
const NOW = Date.parse('2026-10-26T12:00:00Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const item = (patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id: 's', title: '결제 실패 경로', projectName: 'broken', state: 'working', backend: 'claude-code', lastActivityAt: ago(20), ...patch });
const draw = (target: DeskItem) =>
  cardLines({ item: target, selected: false, unseen: false, flagged: false, withLimits: false, sprite: defaultSprite('claude-code') }, 84, DEFAULT_THEME, NOW).map(stripAnsi);

describe('권한 대기 중에 이미 쓰기가 거절됐다', () => {
  const waiting = item({
    terminal: { cli: 'up', waiting: 'permission', message: 'Bash 허락 필요: rm -rf build' },
    turnDenied: 2,
  });

  it('카드 지금 줄에 묻는 것과 함께 "쓰기 2번 거절"을 보인다', () => {
    const text = draw(waiting).join('\n');
    expect(text).toContain('권한 대기');
    expect(text).toContain('Bash 허락 필요');
    expect(text).toContain('쓰기 2번 거절');
  });

  it('확인 필요 줄에도 "쓰기 2번 거절"을 보인다', () => {
    expect(needsYou({ items: [waiting] })).toHaveLength(1);
    const state: DeskState = { ...initialState(), items: [waiting], view: 'space' } as DeskState;
    const lines = spaceScreen(state, { x: 0, y: 0, w: 140, h: 30 }, NOW).lines.map(stripAnsi);
    const row = lines.find((line) => line.includes('1  결제 실패 경로'));
    expect(row).toBeDefined();
    expect(row).toContain('쓰기 2번 거절');
  });

  it('거절이 없으면 지금처럼 묻는 것만 보인다', () => {
    const text = draw({ ...waiting, turnDenied: 0 }).join('\n');
    expect(text).toContain('Bash 허락 필요');
    expect(text).not.toContain('거절');
  });
});

describe('칸 머리와 카드는 같은 판정을 쓴다', () => {
  const size = { cols: 120, rows: 16 };
  const header = (target: DeskItem) => {
    const state: DeskState = { ...initialState(), items: [target], slots: [target.id, undefined, undefined, undefined] };
    return renderScreen(state, size, [{ lines: [] }]).lines.map(stripAnsi)[1]!;
  };

  it('쓰기가 거절된 채 끝났으면 칸 머리도 "쓰기 N번 거절"이고 "CLI 대기"가 아니다', () => {
    const line = header(item({ state: 'idle', terminal: { cli: 'up', waiting: 'idle' }, turnDenied: 3, gate: { state: 'none', checkpoints: 0 }, lastMessage: '묶었습니다.' }));
    expect(line).toContain('쓰기 3번 거절');
    expect(line).not.toContain('CLI 대기');
  });

  it('검증을 통과해 끝났으면 칸 머리는 "검증 통과" 하나다(판정을 두 번 적지 않는다)', () => {
    const line = header(item({ state: 'idle', terminal: { cli: 'up', waiting: 'idle' }, gate: { state: 'passed', checkpoints: 1 } }));
    expect(line).toContain('검증 통과');
    expect(line).not.toContain('CLI 대기');
    expect(line.match(/통과/g)).toHaveLength(1);
  });
});
