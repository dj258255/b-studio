import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(async (projectId: string, owner: string, workspace: string, options: Record<string, unknown>) => ({ id: 'session-1', projectId, owner, workspace, ...options })),
  validateModel: vi.fn(async (modelId: string | undefined) => modelId),
  validateOpenCodeModel: vi.fn(async (modelId: string | undefined) => modelId),
  listSessions: vi.fn(async () => [] as Array<{ id: string; projectId: string }>),
  requireUser: vi.fn((): string => 'kim'),
  projectModelDefault: vi.fn((): string | undefined => undefined),
  projectEffortDefault: vi.fn((): string | undefined => undefined),
  startRoutedSession: vi.fn(async (input: Record<string, unknown>) => ({ session: { id: 'session-r' }, routing: { backend: 'codex', rule: 0 }, runId: 'run-1', input })),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/server/commandcode-models', () => ({ validateCommandCodeModelSelection: mocks.validateModel }));
vi.mock('@/lib/server/opencode-models', () => ({ validateOpenCodeModelSelection: mocks.validateOpenCodeModel }));
vi.mock('@/lib/server/routed-session', () => ({ startRoutedSession: mocks.startRoutedSession }));
vi.mock('@/lib/server/model-defaults', () => ({ projectModelDefault: mocks.projectModelDefault, projectEffortDefault: mocks.projectEffortDefault }));
// createSession·listSessions만 바꿔 끼우고 resolveSessionBackend(허용 목록 검증)는 실제 것을 쓴다
vi.mock('@/lib/server/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/sessions')>();
  return { ...actual, createSession: mocks.createSession, listSessions: mocks.listSessions };
});

import { GET, POST } from './route';

function post(body: unknown): Promise<Response> {
  return POST(new Request('http://localhost/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}

function get(query = ''): Promise<Response> {
  return GET(new Request(`http://localhost/api/sessions${query}`));
}

const saved = { mode: process.env.B_STUDIO_MODE, backends: process.env.B_STUDIO_BACKENDS };

beforeEach(() => {
  mocks.createSession.mockClear();
  mocks.startRoutedSession.mockClear();
  mocks.validateModel.mockClear();
  mocks.validateOpenCodeModel.mockClear();
  mocks.listSessions.mockClear();
  mocks.listSessions.mockResolvedValue([]);
  mocks.requireUser.mockImplementation(() => 'kim');
  mocks.projectModelDefault.mockClear();
  mocks.projectModelDefault.mockReturnValue(undefined);
  mocks.projectEffortDefault.mockClear();
  mocks.projectEffortDefault.mockReturnValue(undefined);
  process.env.B_STUDIO_MODE = 'api';
  delete process.env.B_STUDIO_BACKENDS;
});

afterEach(() => {
  for (const [key, value] of [['B_STUDIO_MODE', saved.mode], ['B_STUDIO_BACKENDS', saved.backends]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST /api/sessions — 규칙으로 고르기(#822)', () => {
  it('route: rules면 첫 요청과 함께 규칙 세션 시작에 넘기고 고른 결과를 201로 돌려준다', async () => {
    const response = await post({ projectId: 'orders', route: 'rules', request: '결제 화면을 고쳐 줘', intent: 'build' });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ session: { id: 'session-r' }, routing: { backend: 'codex' }, runId: 'run-1' });
    expect(mocks.startRoutedSession).toHaveBeenCalledWith({ projectId: 'orders', user: 'kim', workspace: 'copy', request: '결제 화면을 고쳐 줘', intent: 'build' });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('첫 요청이 없거나, backend·model을 함께 주거나, 모르는 route·intent면 400', async () => {
    for (const body of [
      { projectId: 'orders', route: 'rules' },
      { projectId: 'orders', route: 'rules', request: '  ' },
      { projectId: 'orders', route: 'rules', request: '고쳐 줘', backend: 'codex' },
      { projectId: 'orders', route: 'rules', request: '고쳐 줘', model: 'opus' },
      { projectId: 'orders', route: 'auto', request: '고쳐 줘' },
      { projectId: 'orders', route: 'rules', request: '고쳐 줘', intent: 'chat' },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(mocks.startRoutedSession).not.toHaveBeenCalled();
  });

  it('route: direct면 고른 AI·모델을 함께 넘기고, backend가 없거나 모델이 문자열이 아니면 400(#827)', async () => {
    const response = await post({ projectId: 'orders', route: 'direct', backend: 'codex', model: 'gpt-5.5', request: '고쳐 줘' });
    expect(response.status).toBe(201);
    expect(mocks.startRoutedSession).toHaveBeenCalledWith({ projectId: 'orders', user: 'kim', workspace: 'copy', request: '고쳐 줘', intent: 'build', direct: { backend: 'codex', model: 'gpt-5.5' } });
    mocks.startRoutedSession.mockClear();
    for (const body of [
      { projectId: 'orders', route: 'direct', request: '고쳐 줘' },
      { projectId: 'orders', route: 'direct', backend: 'codex' },
      { projectId: 'orders', route: 'direct', backend: 'codex', model: 3, request: '고쳐 줘' },
      { projectId: 'orders', route: 'direct', backend: 'codex', modelId: 'x', request: '고쳐 줘' },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(mocks.startRoutedSession).not.toHaveBeenCalled();
  });
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

  it('모델을 따로 고르지 않으면 이 프로젝트·백엔드에서 대화로 마지막에 고른 모델(model-defaults)을 새 세션 기본값으로 쓴다', async () => {
    mocks.projectModelDefault.mockReturnValue('haiku');
    process.env.B_STUDIO_BACKENDS = 'claude-code';

    const response = await post({ projectId: 'orders', backend: 'claude-code' });

    expect(response.status).toBe(201);
    expect(mocks.projectModelDefault).toHaveBeenCalledWith('orders', 'claude-code');
    expect(mocks.createSession).toHaveBeenCalledWith('orders', 'kim', 'copy', { modelId: 'haiku', backend: 'claude-code', boot: 'on-demand' });
  });

  it('요청이 모델을 고르면 기억한 기본값보다 우선한다', async () => {
    mocks.projectModelDefault.mockReturnValue('haiku');

    const response = await post({ projectId: 'orders', modelId: 'opus' });

    expect(response.status).toBe(201);
    expect(mocks.createSession).toHaveBeenCalledWith('orders', 'kim', 'copy', { modelId: 'opus', backend: 'api', boot: 'on-demand' });
  });

  it('기억한 노력 단계 기본값(model-defaults)도 새 세션 기본값으로 쓴다', async () => {
    mocks.projectEffortDefault.mockReturnValue('high');
    process.env.B_STUDIO_BACKENDS = 'claude-code';

    const response = await post({ projectId: 'orders', backend: 'claude-code' });

    expect(response.status).toBe(201);
    expect(mocks.projectEffortDefault).toHaveBeenCalledWith('orders', 'claude-code');
    expect(mocks.createSession).toHaveBeenCalledWith('orders', 'kim', 'copy', { modelId: undefined, effort: 'high', backend: 'claude-code', boot: 'on-demand' });
  });

  it('기억한 기본값이 "기본"(빈 문자열)이면 오버라이드 없이 만든다', async () => {
    mocks.projectModelDefault.mockReturnValue('');

    const response = await post({ projectId: 'orders' });

    expect(response.status).toBe(201);
    expect(mocks.createSession).toHaveBeenCalledWith('orders', 'kim', 'copy', { modelId: undefined, backend: 'api', boot: 'on-demand' });
  });
});

describe('GET /api/sessions', () => {
  it('projectId가 없으면 전체 목록을 그대로 돌려준다', async () => {
    mocks.listSessions.mockResolvedValue([{ id: 's1', projectId: 'orders' }, { id: 's2', projectId: 'pay' }]);

    const response = await get();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 's1', projectId: 'orders' }, { id: 's2', projectId: 'pay' }]);
  });

  it('projectId를 주면 그 프로젝트의 세션만, limit로 앞의 몇 개만 돌려준다(개발 화면 머리의 최근 세션)', async () => {
    mocks.listSessions.mockResolvedValue([
      { id: 's1', projectId: 'orders' },
      { id: 's2', projectId: 'pay' },
      { id: 's3', projectId: 'orders' },
      { id: 's4', projectId: 'orders' },
    ]);

    const response = await get('?projectId=orders&limit=2');

    expect(await response.json()).toEqual([{ id: 's1', projectId: 'orders' }, { id: 's3', projectId: 'orders' }]);
  });

  it('로그인하지 않았으면 401을 돌려주고 목록을 읽지 않는다', async () => {
    const { StudioError } = await import('@/lib/server/errors');
    mocks.requireUser.mockImplementationOnce(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });

    const response = await get();

    expect(response.status).toBe(401);
    expect(mocks.listSessions).not.toHaveBeenCalled();
  });
});
