import { describe, expect, it } from 'vitest';
import type { DeskItem } from '../desk/types';
import { keyBytes } from './keys';
import { CTL_USAGE } from './main';
import { EXIT, gateOf, judgeWait, matchSession, phaseOf, type WaitTarget } from './phase';

function item(partial: Partial<DeskItem> = {}): DeskItem {
  return { kind: 'session', id: 's1', title: 't', projectName: 'p', state: 'idle', lastActivityAt: '2026-11-28T00:00:00Z', terminal: { cli: 'up', waiting: 'idle' }, ...partial };
}

describe('phaseOf', () => {
  it.each([
    [{ state: 'working' as const }, 'working'],
    [{ state: 'idle' as const }, 'idle'],
    [{ state: 'working' as const, terminal: { cli: 'up' as const, waiting: 'permission' as const } }, 'permission'],
    [{ state: 'working' as const, terminal: { cli: 'up' as const, waiting: 'question' as const } }, 'question'],
    [{ state: 'idle' as const, terminal: { cli: 'up' as const, waiting: 'input' as const } }, 'input'],
    [{ state: 'stopped' as const }, 'done'],
    [{ state: 'done' as const }, 'done'],
    [{ state: 'error' as const }, 'error'],
    [{ state: 'booting' as const, terminal: undefined }, 'booting'],
    [{ state: 'dormant' as const, terminal: undefined }, 'dormant'],
  ])('%j → %s', (partial, expected) => {
    expect(phaseOf(item(partial))).toBe(expected);
  });
});

describe('judgeWait: 종료 코드', () => {
  const gate = (state: 'verifying' | 'passed' | 'failed' | 'none') => ({ gate: { state, checkpoints: 1 } });
  const cases: Array<[string, Partial<DeskItem>, WaitTarget, number | undefined]> = [
    ['작업 중이면 계속 기다린다', { state: 'working' }, 'any', undefined],
    ['쉬는 중 + 게이트 통과 → 0', { ...gate('passed') }, 'idle', EXIT.ok],
    ['쉬는 중 + 게이트 검증 중이면 아직', { ...gate('verifying') }, 'idle', undefined],
    ['쉬는 중 + 게이트 실패 → 1 (idle을 기다려도 0이 아니다)', { ...gate('failed') }, 'idle', EXIT.failed],
    ['쉬는 중 + 게이트 실패 → 1 (any)', { ...gate('failed') }, 'any', EXIT.failed],
    ['쉬는 중 + 판정 없음 + idle → 0', { ...gate('none') }, 'idle', EXIT.ok],
    ['gate: 통과 → 0', { ...gate('passed') }, 'gate', EXIT.ok],
    ['gate: 실패 → 1', { ...gate('failed') }, 'gate', EXIT.failed],
    ['gate: 판정 없음 → 10', { ...gate('none') }, 'gate', EXIT.noVerdict],
    ['gate: 검증 중 → 아직', { ...gate('verifying') }, 'gate', undefined],
    ['권한 대기 → 4', { state: 'working', terminal: { cli: 'up', waiting: 'permission' } }, 'idle', EXIT.permission],
    ['권한 대기 + --for permission → 0', { state: 'working', terminal: { cli: 'up', waiting: 'permission' } }, 'permission', EXIT.ok],
    ['질문 → 5', { state: 'working', terminal: { cli: 'up', waiting: 'question' } }, 'any', EXIT.input],
    ['입력 요구 + --for input → 0', { terminal: { cli: 'up', waiting: 'input' } }, 'input', EXIT.ok],
    ['쉬는 중인데 --for input이면 계속 기다린다', { ...gate('passed') }, 'input', undefined],
    ['오류 → 1', { state: 'error' }, 'done', EXIT.failed],
    ['끝남 + --for done → 0', { state: 'stopped' }, 'done', EXIT.ok],
    ['끝남인데 다른 조건 → 6', { state: 'stopped' }, 'idle', EXIT.ended],
    ['끝남 + gate 판정이 있으면 그 판정', { state: 'done', ...gate('failed') }, 'gate', EXIT.failed],
  ];
  it.each(cases)('%s', (_name, partial, target, code) => {
    expect(judgeWait(item(partial), target)?.code).toBe(code);
  });

  it('쉬는 상태의 판정만 잠깐 그대로일 때 확정한다(settle)', () => {
    expect(judgeWait(item({ gate: { state: 'passed', checkpoints: 1 } }), 'idle')?.settle).toBe(true);
    expect(judgeWait(item({ terminal: { cli: 'up', waiting: 'permission' } }), 'idle')?.settle).toBe(false);
  });

  it('gateOf: 게이트 정보가 없으면 판정 없음', () => {
    expect(gateOf(item())).toBe('none');
  });
});

describe('matchSession', () => {
  const items = [item({ id: 'abc123' }), item({ id: 'abd999' }), item({ id: 'plan:abc' })];
  it('정확한 id가 먼저다', () => expect(matchSession(items, 'abc123')).toMatchObject({ item: { id: 'abc123' } }));
  it('하나에만 맞는 앞부분은 된다', () => expect(matchSession(items, 'abd')).toMatchObject({ item: { id: 'abd999' } }));
  it('여럿에 맞으면 고르지 않는다', () => expect(matchSession(items, 'ab')).toMatchObject({ error: expect.stringContaining('2개') }));
  it('계획 승인 항목(plan:)과 없는 id는 세션이 아니다', () => {
    expect(matchSession(items, 'plan:abc')).toHaveProperty('error');
    expect(matchSession(items, 'zzz')).toHaveProperty('error');
    expect(matchSession(items, '')).toHaveProperty('error');
  });
});

describe('keyBytes', () => {
  it.each([
    ['Enter', '\r'],
    ['esc', '\x1b'],
    ['Up', '\x1b[A'],
    ['Down', '\x1b[B'],
    ['Tab', '\t'],
    ['S-Tab', '\x1b[Z'],
    ['C-c', '\x03'],
    ['ctrl+d', '\x04'],
    ['M-x', '\x1bx'],
    ['1', '1'],
    ['y', 'y'],
    ['Space', ' '],
  ])('%s', (name, bytes) => expect(keyBytes(name)).toBe(bytes));
  it('모르는 이름은 글자 그대로 보내지 않는다', () => {
    expect(keyBytes('Entr')).toBeUndefined();
    expect(keyBytes('hello')).toBeUndefined();
    expect(keyBytes('')).toBeUndefined();
  });
});

describe('USAGE의 종료 코드 표', () => {
  it('EXIT의 모든 코드가 도움말에 있다', () => {
    const table = CTL_USAGE.slice(CTL_USAGE.indexOf('종료 코드:'));
    for (const code of Object.values(EXIT)) expect(table).toMatch(new RegExp(`(^|\\s)${code} `, 'm'));
  });
});
