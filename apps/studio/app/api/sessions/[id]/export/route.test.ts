import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exportSession: vi.fn(async () => ({ repository: {}, sha: 'a'.repeat(40), commits: 1, forced: false })),
  authorizeSession: vi.fn(async () => {}),
  integrationIssues: vi.fn(() => [] as number[]),
  sessionRequirementIssueNumbers: vi.fn(async () => [] as number[]),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/task-plans', () => ({ integrationIssues: mocks.integrationIssues }));
vi.mock('@/lib/server/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/sessions')>();
  return { ...actual, exportSession: mocks.exportSession, sessionRequirementIssueNumbers: mocks.sessionRequirementIssueNumbers };
});

import { POST } from './route';

function post(body: unknown, id = 's1'): Promise<Response> {
  return POST(new Request(`http://localhost/api/sessions/${id}/export`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.exportSession.mockClear();
  mocks.authorizeSession.mockClear().mockImplementation(async () => {});
  mocks.integrationIssues.mockClear().mockReturnValue([]);
  mocks.sessionRequirementIssueNumbers.mockClear().mockResolvedValue([]);
});

describe('POST /api/sessions/[id]/export', () => {
  it('사람이 이슈 번호를 보내면 그대로 쓴다', async () => {
    await post({ pullRequest: true, issues: [3] });
    expect(mocks.exportSession).toHaveBeenCalledWith('s1', { pullRequest: true, issues: [3], review: undefined });
  });

  it('입력이 없으면 통합 계획 이슈 + 발행된 요구사항 이슈를 합쳐 기본값으로 쓴다(ADR-089, 중복 없이)', async () => {
    mocks.integrationIssues.mockReturnValue([10]);
    mocks.sessionRequirementIssueNumbers.mockResolvedValue([10, 12]);
    await post({ pullRequest: true });
    expect(mocks.exportSession).toHaveBeenCalledWith('s1', { pullRequest: true, issues: [10, 12], review: undefined });
  });
});
