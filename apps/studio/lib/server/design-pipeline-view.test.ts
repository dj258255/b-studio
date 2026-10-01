import { describe, expect, it, vi } from 'vitest';
import type { DesignDocRecord } from '@b-studio/agent';
import type { ReviewStateView, SessionSnapshot } from '@/lib/studio-events';
import type { TaskPlanView } from '@/lib/task-plan-types';

const fake: { snapshot?: Partial<SessionSnapshot>; designDocs: DesignDocRecord[]; plans: TaskPlanView[] } = { designDocs: [], plans: [] };

vi.mock('./sessions', () => ({ getSnapshot: vi.fn(() => fake.snapshot) }));
vi.mock('./design-pipeline', () => ({ listSessionDesignDocs: vi.fn(async () => fake.designDocs) }));
vi.mock('./task-plans', () => ({ listTaskPlans: vi.fn(() => fake.plans) }));

import { getSessionDesignPipeline } from './design-pipeline-view';

function design(overrides: Partial<DesignDocRecord> = {}): DesignDocRecord {
  return {
    path: 'docs/design/01-a.md',
    number: 1,
    title: '채팅 입력',
    requirementIds: ['R1'],
    bundles: [{ id: 'B1', title: '입력 폼', doneCondition: '됨', estimateMinMinutes: 30, estimateMaxMinutes: 60, deliverable: '폼', writableScope: ['apps/studio/components/x.tsx'] }],
    status: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'kim',
    ...overrides,
  };
}

function plan(overrides: Partial<TaskPlanView> = {}): TaskPlanView {
  return {
    id: 'plan-1',
    owner: 'kim',
    projectId: 'orders',
    request: '[R1] 채팅 입력',
    modelId: 'model-a',
    status: 'done',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceSessionId: 's1',
    lanes: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<SessionSnapshot> = {}): Partial<SessionSnapshot> {
  return { id: 's1', owner: 'kim', workDir: '/tmp/x', checkpoints: [], ...overrides };
}

describe('getSessionDesignPipeline', () => {
  it('설계 문서가 없으면 빈 배열이다', async () => {
    fake.snapshot = snapshot();
    fake.designDocs = [];
    expect(await getSessionDesignPipeline('s1')).toEqual([]);
  });

  it('작업 묶음을 쓰기 범위가 겹치는 레인에 매칭해 예상 vs 실제 시간을 함께 보여 준다', async () => {
    fake.snapshot = snapshot();
    fake.designDocs = [design()];
    fake.plans = [
      plan({
        lanes: [
          {
            id: 'lane-a',
            paths: ['apps/studio/components/x.tsx'],
            backend: 'claude-code',
            model: 'sonnet',
            status: 'done',
            tasks: [{ id: 't1', title: 'x', request: 'x', paths: ['apps/studio/components/x.tsx'], dependsOn: [], status: 'done', run: { status: 'done', durationMs: 45 * 60_000 } }],
          },
        ],
      }),
    ];

    const [doc] = await getSessionDesignPipeline('s1');
    expect(doc!.bundleActuals).toHaveLength(1);
    expect(doc!.bundleActuals[0]).toMatchObject({ actualMinutes: 45, coder: { backend: 'claude-code', model: 'sonnet', escalated: false } });
    expect(doc!.linkedTaskPlanIds).toEqual(['plan-1']);
  });

  it('매칭되는 레인이 없으면 실제 시간 없이 예상만 보여 준다', async () => {
    fake.snapshot = snapshot();
    fake.designDocs = [design()];
    fake.plans = [];

    const [doc] = await getSessionDesignPipeline('s1');
    expect(doc!.bundleActuals[0]).toEqual({ bundle: design().bundles[0] });
    expect(doc!.linkedTaskPlanIds).toEqual([]);
  });

  it('한 작업이 모델을 두 개 이상 썼으면(승격) escalated로 표시한다', async () => {
    fake.snapshot = snapshot();
    fake.designDocs = [design()];
    fake.plans = [
      plan({
        lanes: [
          {
            id: 'lane-a',
            paths: ['apps/studio/components/x.tsx'],
            status: 'done',
            tasks: [
              {
                id: 't1',
                title: 'x',
                request: 'x',
                paths: ['apps/studio/components/x.tsx'],
                dependsOn: [],
                status: 'done',
                run: {
                  status: 'done',
                  metrics: {
                    modelCalls: 2,
                    maxContextTokens: 0,
                    modelMs: 0,
                    toolMs: 0,
                    gateMs: 0,
                    usageByModel: {
                      sonnet: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
                      opus: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
                    },
                  },
                },
              },
            ],
          },
        ],
      }),
    ];

    const [doc] = await getSessionDesignPipeline('s1');
    expect(doc!.bundleActuals[0]?.coder?.escalated).toBe(true);
  });

  it('완료는 승인 뒤 게이트를 거친 체크포인트만 본다 — "docs" 체크포인트는 세지 않는다', async () => {
    fake.snapshot = snapshot({
      checkpoints: [
        { sha: 'a', shortSha: 'a', message: 'docs: 정리', createdAt: '2026-02-01T00:00:00.000Z', files: [], verify: 'docs' },
        { sha: 'b', shortSha: 'b', message: '구현', createdAt: '2026-01-15T00:00:00.000Z', files: [], passedStages: ['run', 'contract_check', 'test'] },
      ],
    });
    fake.designDocs = [design({ status: 'approved', approvedBy: 'owner', approvedAt: '2026-01-10T00:00:00.000Z' })];
    fake.plans = [];

    const [doc] = await getSessionDesignPipeline('s1');
    expect(doc!.implementationCheckpointExists).toBe(true);
    expect(doc!.verification).toEqual({ ran: true, ok: true, testsRerun: true });
  });

  it('승인 전이면 체크포인트가 있어도 "완료"로 보지 않는다', async () => {
    fake.snapshot = snapshot({ checkpoints: [{ sha: 'b', shortSha: 'b', message: '구현', createdAt: '2026-01-15T00:00:00.000Z', files: [], passedStages: ['run'] }] });
    fake.designDocs = [design({ status: 'draft' })];
    fake.plans = [];

    const [doc] = await getSessionDesignPipeline('s1');
    expect(doc!.implementationCheckpointExists).toBe(false);
    expect(doc!.result.completed).toBe(false);
    expect(doc!.result.succeeded).toBe(false);
  });

  it('리뷰를 한 번도 부르지 않았으면 검토 입력이 없고(검토 못 함), 성공이 아니다', async () => {
    fake.snapshot = snapshot({
      checkpoints: [{ sha: 'b', shortSha: 'b', message: '구현', createdAt: '2026-01-15T00:00:00.000Z', files: [], passedStages: ['run', 'test'] }],
    });
    fake.designDocs = [design({ status: 'approved', approvedBy: 'owner', approvedAt: '2026-01-10T00:00:00.000Z' })];
    fake.plans = [];

    const [doc] = await getSessionDesignPipeline('s1');
    expect(doc!.review).toBeUndefined();
    expect(doc!.result.succeeded).toBe(false);
    expect(doc!.result.reasons).toContain('검토 못 함');
  });

  it('같은 계열 검토는 통과해도 성공으로 세지 않는다', async () => {
    const review: ReviewStateView = { state: 'passed', maxRounds: 3, rounds: [{ round: 1, status: 'passed', startedAt: '', findings: [] }], independence: 'same-family' };
    fake.snapshot = snapshot({
      checkpoints: [{ sha: 'b', shortSha: 'b', message: '구현', createdAt: '2026-01-15T00:00:00.000Z', files: [], passedStages: ['run', 'test'] }],
      review,
    });
    fake.designDocs = [design({ status: 'approved', approvedBy: 'owner', approvedAt: '2026-01-10T00:00:00.000Z' })];
    fake.plans = [];

    const [doc] = await getSessionDesignPipeline('s1');
    expect(doc!.review).toMatchObject({ ran: true, passed: true, independence: 'same-family' });
    expect(doc!.result.succeeded).toBe(false);
    expect(doc!.result.reasons).toContain('같은 계열 검토(독립성 낮음)');
  });

  it('독립 검토 + 검증 재실행 통과 + 승인 + 완료가 모두 있으면 성공이다', async () => {
    const review: ReviewStateView = { state: 'passed', maxRounds: 3, rounds: [{ round: 1, status: 'passed', startedAt: '', findings: [] }], independence: 'independent' };
    fake.snapshot = snapshot({
      checkpoints: [{ sha: 'b', shortSha: 'b', message: '구현', createdAt: '2026-01-15T00:00:00.000Z', files: [], passedStages: ['run', 'test'] }],
      review,
    });
    fake.designDocs = [design({ status: 'approved', approvedBy: 'owner', approvedAt: '2026-01-10T00:00:00.000Z' })];
    fake.plans = [];

    const [doc] = await getSessionDesignPipeline('s1');
    expect(doc!.result).toEqual({ designApproved: true, completed: true, succeeded: true, reasons: [] });
  });
});
