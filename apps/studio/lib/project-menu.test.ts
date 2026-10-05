import { describe, expect, it } from 'vitest';
import { collapseEmptySessions, recentSessionsFor, relativeTime, selectableProjects, shortSessionId } from './project-menu';

describe('selectableProjects', () => {
  it('오류 없는 프로젝트만 남긴다', () => {
    const projects = [{ id: 'orders' }, { id: 'broken', error: 'studio.yaml 오류' }, { id: 'pay' }];
    expect(selectableProjects(projects, 'orders').map((p) => p.id)).toEqual(['orders', 'pay']);
  });

  it('지금 보는 프로젝트는 오류가 있어도 남긴다', () => {
    const projects = [{ id: 'orders' }, { id: 'broken', error: '오류' }];
    expect(selectableProjects(projects, 'broken').map((p) => p.id)).toEqual(['orders', 'broken']);
  });
});

describe('recentSessionsFor', () => {
  const sessions = [
    { id: 's1', projectId: 'orders' },
    { id: 's2', projectId: 'pay' },
    { id: 's3', projectId: 'orders' },
    { id: 's4', projectId: 'orders' },
  ];

  it('이 프로젝트의 세션만 남긴다', () => {
    expect(recentSessionsFor(sessions, 'orders', 10).map((s) => s.id)).toEqual(['s1', 's3', 's4']);
  });

  it('앞의 몇 개만 남긴다(순서는 그대로 — 목록이 이미 최근 순)', () => {
    expect(recentSessionsFor(sessions, 'orders', 2).map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('없으면 빈 목록', () => {
    expect(recentSessionsFor(sessions, 'nope', 5)).toEqual([]);
  });
});

describe('collapseEmptySessions', () => {
  it('요청을 보낸 세션은 그대로 남긴다', () => {
    const sessions = [{ id: 's1', lastRequest: '버그 고쳐줘' }, { id: 's2', lastRequest: '테스트 추가' }];
    expect(collapseEmptySessions(sessions).map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('빈 세션이 여러 개면 가장 최근(맨 앞) 것 하나만 남긴다', () => {
    const sessions: Array<{ id: string; lastRequest?: string }> = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
    expect(collapseEmptySessions(sessions).map((s) => s.id)).toEqual(['s1']);
  });

  it('빈 세션과 요청 있는 세션이 섞여 있으면 빈 세션 중 가장 최근 것만 남기고 순서는 그대로', () => {
    const sessions = [{ id: 's1', lastRequest: '요청' }, { id: 's2' }, { id: 's3' }, { id: 's4', lastRequest: '다른 요청' }];
    expect(collapseEmptySessions(sessions).map((s) => s.id)).toEqual(['s1', 's2', 's4']);
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-01-01T12:00:00Z');

  it('1분 미만은 방금', () => {
    expect(relativeTime('2026-01-01T11:59:31Z', now)).toBe('방금');
  });

  it('분 단위', () => {
    expect(relativeTime('2026-01-01T11:55:00Z', now)).toBe('5분 전');
  });

  it('시간 단위', () => {
    expect(relativeTime('2026-01-01T09:00:00Z', now)).toBe('3시간 전');
  });

  it('날짜 단위', () => {
    expect(relativeTime('2025-12-30T12:00:00Z', now)).toBe('2일 전');
  });

  it('파싱할 수 없으면 빈 문자열', () => {
    expect(relativeTime('이상한 값', now)).toBe('');
  });
});

describe('shortSessionId', () => {
  it('앞 8자만 남긴다', () => {
    expect(shortSessionId('abcdefgh12345678')).toBe('abcdefgh');
  });

  it('8자보다 짧으면 그대로', () => {
    expect(shortSessionId('ab12')).toBe('ab12');
  });
});
