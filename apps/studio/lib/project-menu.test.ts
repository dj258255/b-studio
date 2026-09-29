import { describe, expect, it } from 'vitest';
import { recentSessionsFor, selectableProjects } from './project-menu';

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
