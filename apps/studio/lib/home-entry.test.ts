import { describe, expect, it } from 'vitest';
import { submitEntry } from './home-entry';

/** 방식별 순서대로 돌려줄 응답을 준비한 가짜 fetch. 어떤 요청이 갔는지 calls에 남긴다 */
function fakeFetch(routes: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const route = routes.shift();
    if (!route) throw new Error(`예상하지 못한 요청: ${url}`);
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

const base = { projectId: 'orders', text: '주문 목록에 필터 추가', workspace: 'copy' as const, fleetModelIds: ['a', 'b'], planModelId: 'plan-model' };

describe('submitEntry', () => {
  it('한 명은 세션을 만든 뒤 그 세션에 요청을 보내고 세션 주소를 돌려준다', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 201, body: { id: 's1' } },
      { status: 202, body: { runId: 'r1' } },
    ]);

    const result = await submitEntry(fetchImpl, { ...base, method: 'single' });

    expect(result).toEqual({ ok: true, href: '/sessions/s1' });
    expect(calls.map((call) => call.url)).toEqual(['/api/sessions', '/api/sessions/s1/messages']);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ projectId: 'orders', workspace: 'copy' });
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ text: base.text, intent: 'build' });
  });

  it('한 명은 고른 백엔드·모델을 세션 만들기 본문에 그대로 싣는다', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 201, body: { id: 's9' } },
      { status: 202, body: { runId: 'r9' } },
    ]);

    const result = await submitEntry(fetchImpl, { ...base, method: 'single', backend: 'commandcode', model: 'anthropic/claude-x' });

    expect(result).toEqual({ ok: true, href: '/sessions/s9' });
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      projectId: 'orders',
      workspace: 'copy',
      backend: 'commandcode',
      model: 'anthropic/claude-x',
    });
  });

  it('한 명에서 요청 보내기가 실패하면 만든 세션 id와 이유를 돌려준다', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 201, body: { id: 's1' } },
      { status: 409, body: { error: '샌드박스가 준비된 뒤에 요청할 수 있습니다' } },
    ]);

    const result = await submitEntry(fetchImpl, { ...base, method: 'single' });

    expect(result).toEqual({ ok: false, error: '샌드박스가 준비된 뒤에 요청할 수 있습니다', sessionId: 's1' });
  });

  it('여러 명 비교는 Fleet을 만들고 그 비교 화면으로 간다', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: { id: 'f1' } }]);

    const result = await submitEntry(fetchImpl, { ...base, method: 'fleet' });

    expect(result).toEqual({ ok: true, href: '/fleets?id=f1' });
    expect(calls[0]!.url).toBe('/api/fleets');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ projectId: 'orders', request: base.text, modelIds: ['a', 'b'] });
  });

  it('여러 명 비교는 모델이 2개 미만이면 서버를 부르지 않고 이유를 돌려준다', async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const result = await submitEntry(fetchImpl, { ...base, method: 'fleet', fleetModelIds: ['a'] });
    expect(result).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it('나눠서 병렬은 작업 분해를 만들고 그 계획 화면으로 간다', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: { id: 'p1' } }]);

    const result = await submitEntry(fetchImpl, { ...base, method: 'split' });

    expect(result).toEqual({ ok: true, href: '/task-plans?id=p1' });
    expect(calls[0]!.url).toBe('/api/task-plans');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ projectId: 'orders', request: base.text, modelId: 'plan-model' });
  });

  it('세션에서 넘긴 나눠서 병렬(sourceSessionId)은 계획 만들기 본문에 그대로 싣고, 안 넘기면 아예 담지 않는다(ADR-096)', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: { id: 'p2' } }]);

    const result = await submitEntry(fetchImpl, { ...base, method: 'split', sourceSessionId: 'origin-1' });

    expect(result).toEqual({ ok: true, href: '/task-plans?id=p2' });
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ projectId: 'orders', request: base.text, modelId: 'plan-model', sourceSessionId: 'origin-1' });
  });

  it('응답에 id가 없으면 목록 화면으로 간다', async () => {
    const { fetchImpl } = fakeFetch([{ status: 201, body: {} }]);

    expect(await submitEntry(fetchImpl, { ...base, method: 'split' })).toEqual({ ok: true, href: '/task-plans' });
  });

  it('프로젝트나 요청이 없으면 서버를 부르지 않는다', async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    expect(await submitEntry(fetchImpl, { ...base, method: 'single', projectId: '' })).toMatchObject({ ok: false });
    expect(await submitEntry(fetchImpl, { ...base, method: 'single', text: '   ' })).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it('서버 오류 문구를 그대로 돌려주고, 네트워크 오류도 이유로 남긴다', async () => {
    const { fetchImpl } = fakeFetch([{ status: 400, body: { error: 'projectId가 필요합니다' } }]);
    expect(await submitEntry(fetchImpl, { ...base, method: 'fleet' })).toEqual({ ok: false, error: 'projectId가 필요합니다' });

    const failing = async (): Promise<Response> => {
      throw new Error('네트워크 오류');
    };
    expect(await submitEntry(failing, { ...base, method: 'split' })).toEqual({ ok: false, error: '네트워크 오류' });
  });
});

describe('구독 CLI 모드에서는 모델을 고르지 않고 서버 기본을 쓴다', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  it('여러 명 비교·나눠서 병렬은 modelIds·modelId 없이 보낸다(레지스트리 모델이 없어도 막지 않는다)', async () => {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      bodies.push({ url, body: JSON.parse(String(init?.body)) });
      return ok({ id: 'x' });
    };
    const base = { projectId: 'orders', text: '주문 목록', workspace: 'copy' as const, fleetModelIds: [], planModelId: '', mode: 'claude-code' };
    expect(await submitEntry(fetcher, { ...base, method: 'fleet' })).toEqual({ ok: true, href: '/fleets?id=x' });
    expect(await submitEntry(fetcher, { ...base, method: 'split' })).toEqual({ ok: true, href: '/task-plans?id=x' });
    expect(bodies[0]!.body).not.toHaveProperty('modelIds');
    expect(bodies[1]!.body).not.toHaveProperty('modelId');
  });
});

describe('나눠서 병렬은 대화에서 이어받은 세션 모델·노력 단계를 계획 만들기에 그대로 싣는다', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('로컬 CLI 모드: 세션이 고른 별칭·노력 단계를 modelId·effort로 보낸다', async () => {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      bodies.push({ url, body: JSON.parse(String(init?.body)) });
      return ok({ id: 'p1' });
    };

    const result = await submitEntry(fetcher, {
      ...base,
      method: 'split',
      mode: 'claude-code',
      planModelId: '',
      sessionModelId: 'sonnet',
      sessionEffort: 'medium',
    });

    expect(result).toEqual({ ok: true, href: '/task-plans?id=p1' });
    expect(bodies[0]!.body).toEqual({ projectId: 'orders', request: base.text, modelId: 'sonnet', effort: 'medium' });
  });

  it('로컬 CLI 모드: 세션이 "기본"이었으면(빈 문자열) modelId를 빈 문자열로 그대로 보낸다(안 보내는 것과 다르다)', async () => {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      bodies.push({ url, body: JSON.parse(String(init?.body)) });
      return ok({ id: 'p2' });
    };

    await submitEntry(fetcher, { ...base, method: 'split', mode: 'claude-code', planModelId: '', sessionModelId: '' });

    expect(bodies[0]!.body).toMatchObject({ modelId: '' });
  });

  it('API 모드: 세션 모델이 있으면 새로 시작 화면 없이도 그 모델로 계획을 만든다(planModelId 없이도 된다)', async () => {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      bodies.push({ url, body: JSON.parse(String(init?.body)) });
      return ok({ id: 'p3' });
    };

    const result = await submitEntry(fetcher, { ...base, method: 'split', mode: 'api', planModelId: '', sessionModelId: 'claude-sonnet-5', sessionEffort: 'high' });

    expect(result).toEqual({ ok: true, href: '/task-plans?id=p3' });
    expect(bodies[0]!.body).toEqual({ projectId: 'orders', request: base.text, modelId: 'claude-sonnet-5', effort: 'high' });
  });

  it('API 모드: 세션 모델도 없으면(자동 라우터) 예전처럼 모델을 고를 수 없다는 이유를 돌려주고 서버를 부르지 않는다', async () => {
    const { fetchImpl, calls } = fakeFetch([]);

    const result = await submitEntry(fetchImpl, { ...base, method: 'split', mode: 'api', planModelId: '', sessionModelId: '' });

    expect(result).toEqual({ ok: false, error: '계획에 쓸 모델을 고를 수 없습니다' });
    expect(calls).toEqual([]);
  });
});
