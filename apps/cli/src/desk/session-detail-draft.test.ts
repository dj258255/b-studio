import { describe, expect, it } from 'vitest';
import { cardLines } from './cards';
import { detailKey, openDetail, sessionDetailLines, type DetailSnapshot } from './session-detail';
import { stripAnsi } from './screen';
import { defaultSprite } from './sprite';
import { DEFAULT_THEME } from './theme';
import type { DeskItem } from './types';

/** 입력창에 되살리지 못한 "쓰다 만 글"(ADR-237): 카드에 알리고 세션 자세히에서 복사한다 */
const NOW = Date.parse('2026-10-23T12:00:00Z');
const base: DeskItem = { kind: 'session', id: 's1', title: '주문 모듈', projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-23T11:57:00Z' };
const withDraft: DeskItem = { ...base, terminal: { cli: 'up', draft: 'README.md의 첫 줄만 읽어서 알려 줘' } };
const snapshot: DetailSnapshot = { id: 's1', status: 'ready', running: false, checkpoints: [] };

describe('쓰다 만 글', () => {
  it('카드에 쓰다 만 글이 있다고 알린다', () => {
    const text = stripAnsi(cardLines({ item: withDraft, selected: false, flagged: false, withLimits: false, sprite: defaultSprite('claude-code') }, 100, DEFAULT_THEME, NOW).join('\n'));
    expect(text).toContain('쓰다 만 글: README.md의 첫 줄만 읽어서 알려 줘');
  });

  it('글이 없으면 알리지 않는다', () => {
    const text = stripAnsi(cardLines({ item: base, selected: false, flagged: false, withLimits: false, sprite: defaultSprite('claude-code') }, 100, DEFAULT_THEME, NOW).join('\n'));
    expect(text).not.toContain('쓰다 만 글');
  });

  it('세션 자세히에서 C로 복사한다(서버에 보내지 않고 클립보드 동작만)', () => {
    const detail = openDetail(withDraft);
    expect(detail.draft).toBe('README.md의 첫 줄만 읽어서 알려 줘');
    const result = detailKey({ ...detail, snapshot, loading: false }, 'C');
    expect(result.action).toEqual({ kind: 'copyDraft', text: 'README.md의 첫 줄만 읽어서 알려 줘' });
    expect(result.detail?.message).toContain('클립보드');
  });

  it('글이 없으면 복사할 것이 없다고 알린다', () => {
    const result = detailKey({ ...openDetail(base), snapshot, loading: false }, 'C');
    expect(result.action).toBeUndefined();
    expect(result.detail?.message).toContain('없습니다');
  });

  it('확인·리뷰 탭이 쓰다 만 글을 보인다', () => {
    const lines = sessionDetailLines({ ...openDetail(withDraft), snapshot, loading: false, tab: 'review' }, { theme: DEFAULT_THEME, width: 100, height: 20, now: NOW });
    const text = stripAnsi(lines.join('\n'));
    expect(text).toContain('쓰다 만 글');
    expect(text).toContain('README.md의 첫 줄만 읽어서 알려 줘');
  });

  it('서버가 준 글의 ESC·제어 문자·글 방향 문자는 카드와 세션 자세히 화면 줄에 나오지 않는다', () => {
    const evil = '앞\x1b[2J\x1b]0;evil-title\x07가\u202e나\u2066다\x9b31m\x07끝';
    const withEvil: DeskItem = { ...base, terminal: { cli: 'up', draft: evil } };
    const card = cardLines({ item: withEvil, selected: false, flagged: false, withLimits: false, sprite: defaultSprite('claude-code') }, 100, DEFAULT_THEME, NOW).join('\n');
    const detail = sessionDetailLines({ ...openDetail(withEvil), snapshot, loading: false, tab: 'review' }, { theme: DEFAULT_THEME, width: 100, height: 20, now: NOW }).join('\n');
    for (const out of [card, detail]) {
      // 우리가 칠한 색(SGR) 말고 글에서 온 ESC 열이 없다
      expect(out).not.toContain('\x1b[2J');
      expect(out).not.toContain('\x1b]0;');
      expect(out).not.toContain('evil-title');
      expect(out).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u009b\u0007]/u);
      expect(stripAnsi(out)).toContain('앞가나다');
    }
    // 복사하는 글도 걸러서 준다
    const copied = detailKey({ ...openDetail(withEvil), snapshot, loading: false }, 'C').action;
    expect(copied).toEqual({ kind: 'copyDraft', text: '앞가나다끝' });
  });
});
