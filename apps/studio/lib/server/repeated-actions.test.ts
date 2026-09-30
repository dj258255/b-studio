import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

const fake = vi.hoisted(() => ({
  project: { spec: { name: 'orders' } } as unknown,
  sessions: [] as Array<{ id: string; projectId: string }>,
  histories: new Map<string, StudioEvent[]>(),
}));

vi.mock('./projects', () => ({ findProject: vi.fn(async (id: string) => (id === 'orders' ? fake.project : undefined)) }));
vi.mock('./sessions', () => ({
  listSessions: vi.fn(async () => fake.sessions),
  sessionHistory: vi.fn((id: string) => fake.histories.get(id) ?? []),
}));

import { ignoreRepeatedAction, projectRepeatedActions } from './repeated-actions';

const directory = mkdtempSync(path.join(tmpdir(), 'b-studio-repeated-actions-'));
const saved = process.env.B_STUDIO_REPEATED_ACTIONS_DIR;

/** run_in_service 명령을 한 번 실행하는 최소 이벤트 묶음(러너와 같은 tool_call/tool_result 짝) */
function commandRun(runId: string, service: string, command: string[], chars = 100): StudioEvent[] {
  return [
    { type: 'run_started', runId, request: '테스트 요청' },
    { type: 'agent', runId, event: { type: 'tool_call', name: 'run_in_service', input: { service, command } } },
    { type: 'agent', runId, event: { type: 'tool_result', name: 'run_in_service', ok: true, content: 'x'.repeat(chars), chars } },
    { type: 'run_finished', runId, status: 'done', summary: '끝' },
  ];
}

beforeEach(() => {
  process.env.B_STUDIO_REPEATED_ACTIONS_DIR = directory;
  fake.sessions = [];
  fake.histories.clear();
});

afterAll(() => {
  if (saved === undefined) delete process.env.B_STUDIO_REPEATED_ACTIONS_DIR;
  else process.env.B_STUDIO_REPEATED_ACTIONS_DIR = saved;
  rmSync(directory, { recursive: true, force: true });
});

describe('projectRepeatedActions', () => {
  it('없는 프로젝트는 404다', async () => {
    await expect(projectRepeatedActions('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('세션 기록을 모아 되풀이 후보를 찾고, 무시한 후보는 뺀다', async () => {
    fake.sessions = [
      { id: 's1', projectId: 'orders' },
      { id: 's2', projectId: 'orders' },
      { id: 's3', projectId: 'other' },
    ];
    fake.histories.set('s1', [...commandRun('r1', 'web', ['pnpm', 'test']), ...commandRun('r2', 'web', ['pnpm', 'test'])]);
    fake.histories.set('s2', commandRun('r3', 'web', ['pnpm', 'test']));

    const before = await projectRepeatedActions('orders', { now: '2026-09-30T00:00:00.000Z' });
    expect(before.projectName).toBe('orders');
    expect(before.sessionsAnalyzed).toBe(2);
    expect(before.candidates).toHaveLength(1);
    expect(before.ignoredCount).toBe(0);

    const candidateId = before.candidates[0]!.id;
    ignoreRepeatedAction('orders', candidateId);
    // 다시 부르면 파일에 남은 무시 목록을 읽어 뺀다
    ignoreRepeatedAction('orders', candidateId); // 멱등: 두 번 무시해도 그대로

    const after = await projectRepeatedActions('orders');
    expect(after.candidates).toHaveLength(0);
    expect(after.ignoredCount).toBe(1);
  });
});
