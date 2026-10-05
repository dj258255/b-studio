import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({ setLaneBackend: vi.fn(), listSelectableModels: vi.fn() }));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/task-plans', () => ({ setLaneBackend: spies.setLaneBackend }));
vi.mock('@/lib/server/model-picker', () => ({ listSelectableModels: spies.listSelectableModels }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

const PLAN_WITH_BACKEND = { id: 'plan-1', lanes: [{ id: 'lane-1', backend: 'claude-code', model: 'sonnet', effort: 'high' }] };
const PLAN_INHERITED = { id: 'plan-1', lanes: [{ id: 'lane-1' }] };
const PICKER = { backend: 'claude-code', current: 'sonnet', options: [], effort: { supported: true, levels: [] } };

function request(body: unknown): Request {
  return new Request('http://studio.local/api/task-plans/plan-1/lanes/lane-1/backend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: 'plan-1', laneId: 'lane-1' }) } as Parameters<typeof POST>[1];

describe('레인 백엔드 라우트', () => {
  beforeEach(() => {
    spies.setLaneBackend.mockReset();
    spies.listSelectableModels.mockReset();
  });

  it('backend·model·effort를 그대로 전달하고, 바뀐 계획과 그 백엔드의 모델 목록을 돌려준다', async () => {
    spies.setLaneBackend.mockReturnValue(PLAN_WITH_BACKEND);
    spies.listSelectableModels.mockResolvedValue(PICKER);

    const response = await POST(request({ backend: 'claude-code', model: 'sonnet', effort: 'high' }), context);

    expect(response.status).toBe(200);
    expect(spies.setLaneBackend).toHaveBeenCalledWith('plan-1', 'kim', 'lane-1', { backend: 'claude-code', model: 'sonnet', effort: 'high' });
    expect(spies.listSelectableModels).toHaveBeenCalledWith('claude-code', 'sonnet', 'high');
    const body = await response.json();
    expect(body).toEqual({ plan: PLAN_WITH_BACKEND, picker: PICKER });
  });

  it('레인이 "세션과 같음"으로 돌아가면 picker를 부르지 않고, picker 없이 계획만 돌려준다', async () => {
    spies.setLaneBackend.mockReturnValue(PLAN_INHERITED);

    const response = await POST(request({ backend: '' }), context);

    expect(response.status).toBe(200);
    expect(spies.listSelectableModels).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ plan: PLAN_INHERITED });
  });

  it('backend·model·effort가 문자열이 아니면 400이고 저장하지 않는다', async () => {
    const response = await POST(request({ backend: 5 }), context);

    expect(response.status).toBe(400);
    expect(spies.setLaneBackend).not.toHaveBeenCalled();
  });

  it('서버가 던진 오류(모르는 백엔드·승인 대기 아님 등)를 그대로 전한다', async () => {
    spies.setLaneBackend.mockImplementation(() => {
      throw new StudioError(400, '이 서버에서 쓸 수 없는 백엔드입니다: codex');
    });

    const response = await POST(request({ backend: 'codex' }), context);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('쓸 수 없는 백엔드');
  });
});
