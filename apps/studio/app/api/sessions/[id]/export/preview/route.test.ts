import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  previewExport: vi.fn(async () => ({ title: 't', body: 'b', canCreate: true, issues: [] as number[], checks: [], review: { auto: false, maxRounds: 1 } })),
  authorizeSession: vi.fn(async () => {}),
  integrationIssues: vi.fn(() => [] as number[]),
  planRequirementIds: vi.fn(() => [] as string[]),
  sessionRequirementIssueNumbers: vi.fn(async () => [] as number[]),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/task-plans', () => ({ integrationIssues: mocks.integrationIssues, planRequirementIds: mocks.planRequirementIds }));
vi.mock('@/lib/server/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/sessions')>();
  return { ...actual, previewExport: mocks.previewExport, sessionRequirementIssueNumbers: mocks.sessionRequirementIssueNumbers };
});

import { POST } from './route';

function post(body: unknown, id = 's1'): Promise<Response> {
  return POST(new Request(`http://localhost/api/sessions/${id}/export/preview`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.previewExport.mockClear();
  mocks.authorizeSession.mockClear().mockImplementation(async () => {});
  mocks.integrationIssues.mockClear().mockReturnValue([]);
  mocks.planRequirementIds.mockClear().mockReturnValue([]);
  mocks.sessionRequirementIssueNumbers.mockClear().mockResolvedValue([]);
});

describe('POST /api/sessions/[id]/export/preview', () => {
  it('사람이 이슈 번호를 보내면 그대로 쓴다(자동 기본값을 덮어쓴다)', async () => {
    await post({ issues: [7] });
    expect(mocks.previewExport).toHaveBeenCalledWith('s1', { issues: [7], planRequirementIds: [] });
    expect(mocks.sessionRequirementIssueNumbers).not.toHaveBeenCalled();
  });

  it('입력이 없으면 통합 계획 이슈 + 이 세션이 구현한(발행된) 요구사항 이슈를 합쳐 기본값으로 쓴다(ADR-092)', async () => {
    mocks.integrationIssues.mockReturnValue([10]);
    mocks.sessionRequirementIssueNumbers.mockResolvedValue([10, 12]);
    await post({});
    expect(mocks.previewExport).toHaveBeenCalledWith('s1', { issues: [10, 12], planRequirementIds: [] });
  });

  it('통합 세션이면(계획이 요구사항을 언급했으면) 그 id들을 그대로 미리보기에 넘긴다(ADR-113)', async () => {
    mocks.planRequirementIds.mockReturnValue(['R2', 'R5']);
    await post({});
    expect(mocks.sessionRequirementIssueNumbers).toHaveBeenCalledWith('s1', ['R2', 'R5']);
    expect(mocks.previewExport).toHaveBeenCalledWith('s1', { issues: [], planRequirementIds: ['R2', 'R5'] });
  });
});
