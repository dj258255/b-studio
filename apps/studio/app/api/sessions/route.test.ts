import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(async (projectId: string, owner: string, workspace: string, options: Record<string, unknown>) => ({ id: 'session-1', projectId, owner, workspace, ...options })),
  validateModel: vi.fn(async (modelId: string | undefined) => modelId),
  validateOpenCodeModel: vi.fn(async (modelId: string | undefined) => modelId),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/commandcode-models', () => ({ validateCommandCodeModelSelection: mocks.validateModel }));
vi.mock('@/lib/server/opencode-models', () => ({ validateOpenCodeModelSelection: mocks.validateOpenCodeModel }));
// createSession만 바꿔 끼우고 resolveSessionBackend(허용 목록 검증)는 실제 것을 쓴다
vi.mock('@/lib/server/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/sessions')>();
  return { ...actual, createSession: mocks.createSession };
});

import { POST } from './route';

function post(body: unknown): Promise<Response> {
  return POST(new Request('http://localhost/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}

const saved = { mode: process.env.B_STUDIO_MODE, backends: process.env.B_STUDIO_BACKENDS };

beforeEach(() => {
  mocks.createSession.mockClear();
  mocks.validateModel.mockClear();
  mocks.validateOpenCodeModel.mockClear();
  process.env.B_STUDIO_MODE = 'api';
  delete process.env.B_STUDIO_BACKENDS;
});

afterEach(() => {
  for (const [key, value] of [['B_STUDIO_MODE', saved.mode], ['B_STUDIO_BACKENDS', saved.backends]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST /api/sessions', () => {
  it('backend를 넘기면 허용 목록을 확인해 createSession에 그대로 넘긴다', async () => {
    process.env.B_STUDIO_BACKENDS = 'claude-code,commandcode';
    const response = await post({ projectId: 'orders', backend: 'commandcode', modelId: 'free-1' });

    expect(response.status).toBe(201);
    expect(mocks.createSession).toHaveBeenCalledWith('orders', 'kim', 'copy', { modelId: 'free-1', backend: 'commandcode', boot: 'on-demand' });
    // commandcode 백엔드일 때만 모델 목록을 검증한다(서버 모드가 아니라 이 세션의 백엔드를 본다)
    expect(mocks.validateModel).toHaveBeenCalledWith('free-1');
  });

  it('opencode 백엔드도 이 세션의 백엔드를 보고 OpenCode 모델 목록으로 검증한다', async () => {
    process.env.B_STUDIO_BACKENDS = 'opencode';
    const response = await post({ projectId: 'orders', backend: 'opencode', model: 'opencode/mimo-v2.6-flash-free' });

    expect(response.status).toBe(201);
    expect(mocks.createSession).toHaveBeenCalledWith('orders', 'kim', 'copy', { modelId: 'opencode/mimo-v2.6-flash-free', backend: 'opencode', boot: 'on-demand' });
    expect(mocks.validateOpenCodeModel).toHaveBeenCalledWith('opencode/mimo-v2.6-flash-free');
    // 다른 CLI 백엔드의 검증기는 부르지 않는다
    expect(mocks.validateModel).not.toHaveBeenCalled();
  });

  it('허용 목록 밖 백엔드는 400으로 거부하고 세션을 만들지 않는다', async () => {
    const response = await post({ projectId: 'orders', backend: 'codex' });

    expect(response.status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('backend가 없으면 서버 모드로 만들고 Command Code 모델 검증을 하지 않는다', async () => {
    const response = await post({ projectId: 'orders', modelId: 'm' });

    expect(response.status).toBe(201);
    // 서버 모드(api)가 확정되어 넘어간다
    expect(mocks.createSession).toHaveBeenCalledWith('orders', 'kim', 'copy', { modelId: 'm', backend: 'api', boot: 'on-demand' });
    expect(mocks.validateModel).not.toHaveBeenCalled();
  });

  it('backend가 문자열이 아니면 400을 돌려준다', async () => {
    const response = await post({ projectId: 'orders', backend: 3 });
    expect(response.status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
