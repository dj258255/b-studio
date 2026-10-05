import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({ selectableLaneBackends: vi.fn(), listSelectableModels: vi.fn() }));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/task-plans', () => ({ selectableLaneBackends: spies.selectableLaneBackends }));
vi.mock('@/lib/server/model-picker', () => ({ listSelectableModels: spies.listSelectableModels }));

import { GET } from './route';

const PICKER = { backend: 'claude-code', current: undefined, options: [], effort: { supported: true, levels: [] } };

function request(query?: string): Request {
  return new Request(`http://studio.local/api/task-plans/lane-backends${query ? `?${query}` : ''}`);
}

describe('레인 백엔드 목록 라우트', () => {
  beforeEach(() => {
    spies.selectableLaneBackends.mockReset().mockReturnValue(['api', 'claude-code']);
    spies.listSelectableModels.mockReset().mockResolvedValue(PICKER);
  });

  it('backend 없이 부르면 고를 수 있는 백엔드 목록만 돌려준다(목록을 부르지 않는다)', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(spies.listSelectableModels).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ backends: ['api', 'claude-code'] });
  });

  it('backend를 주면 그 백엔드의 모델·노력 목록을 함께 돌려준다', async () => {
    const response = await GET(request('backend=claude-code&current=sonnet&effort=high'));

    expect(response.status).toBe(200);
    expect(spies.listSelectableModels).toHaveBeenCalledWith('claude-code', 'sonnet', 'high');
    expect(await response.json()).toEqual({ backends: ['api', 'claude-code'], picker: PICKER });
  });

  it('이 서버가 허용하지 않는 백엔드를 주면 400을 돌려주고 모델을 불러오지 않는다', async () => {
    const response = await GET(request('backend=codex'));

    expect(response.status).toBe(400);
    expect(spies.listSelectableModels).not.toHaveBeenCalled();
    expect((await response.json()).error).toContain('쓸 수 없는 백엔드');
  });
});
