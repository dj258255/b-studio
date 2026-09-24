import { describe, expect, it } from 'vitest';
import type { TaskPlanLaneView, TaskPlanView } from '../../lib/task-plan-types';
import { classify } from './classify';

function lane(over: Partial<TaskPlanLaneView> = {}): TaskPlanLaneView {
  return { id: 'lane-1', paths: ['api'], status: 'done', tasks: [], ...over };
}

function plan(over: Partial<TaskPlanView> = {}): TaskPlanView {
  return { id: 'plan-1', owner: 'kim', projectId: 'bench-orders', request: '요청', modelId: 'm', status: 'done', createdAt: '', lanes: [], ...over };
}

const acceptanceFail = [{ check: 'web /orders', ok: false, status: 200, detail: '문구 누락: 김민수' }];
const acceptanceOk = [{ check: 'web /orders', ok: true, status: 200, detail: 'HTTP 200' }];

describe('실패 원인 분류', () => {
  it('하네스 시간 초과는 timeout, 그 밖의 하네스 오류는 environment', () => {
    expect(classify(plan(), undefined, '시간 초과: 계획이 10분 안에 승인 대기에 이르지 않았습니다').category).toBe('timeout');
    expect(classify(plan(), undefined, '예상하지 못한 하네스 오류').category).toBe('environment');
  });

  it('환경 문제 문구가 있으면 environment (계획 실패보다 먼저 본다)', () => {
    const result = classify(plan({ status: 'failed', error: '세션을 준비하지 못했습니다 (failed: no space left on device)' }), undefined);
    expect(result.category).toBe('environment');
    expect(result.detail).toContain('no space left');
  });

  it('승인 전에 계획 단계에서 실패하면 plan_rejected', () => {
    expect(classify(plan({ status: 'failed', error: '작업 계획을 만들지 못했습니다: JSON을 찾지 못했습니다' }), undefined).category).toBe('plan_rejected');
  });

  it('레인 오류에 writable scope가 있으면 scope_violation', () => {
    const target = plan({ status: 'failed', approvedAt: '2026-09-24T00:00:00Z', lanes: [lane({ status: 'failed', error: 'lane-1가 쓰기 범위 밖 파일을 바꿨습니다: writable scope' })] });
    expect(classify(target, undefined).category).toBe('scope_violation');
  });

  it('레인이 실패하면 lane_gate, 통합이 실패하면 integration_gate', () => {
    const laneFailed = plan({ status: 'failed', approvedAt: 'x', lanes: [lane({ status: 'failed', error: '검증 게이트를 통과하지 못했습니다' })] });
    expect(classify(laneFailed, undefined).category).toBe('lane_gate');

    const integrationFailed = plan({
      status: 'failed',
      approvedAt: 'x',
      lanes: [lane({ status: 'done' })],
      integration: { status: 'failed', files: [], deleted: [], error: '합친 결과가 게이트를 통과하지 못했습니다' },
    });
    expect(classify(integrationFailed, undefined).category).toBe('integration_gate');
  });

  it('계획이 끝났는데 수용 확인이 실패하면 acceptance, 모두 통과하면 none', () => {
    expect(classify(plan({ status: 'done' }), acceptanceFail).category).toBe('acceptance');
    expect(classify(plan({ status: 'done' }), acceptanceOk).category).toBe('none');
  });

  it('그 밖의 상태는 unknown', () => {
    expect(classify(plan({ status: 'interrupted' }), undefined).category).toBe('unknown');
    expect(classify(plan({ status: 'rejected', rejectedReason: '쓰기 범위가 이상함' }), undefined).category).toBe('unknown');
  });
});
