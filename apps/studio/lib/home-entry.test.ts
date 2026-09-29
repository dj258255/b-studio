import { describe, expect, it } from 'vitest';
import {
  backendLabel,
  backendOptions,
  defaultFleetModels,
  defaultPlanModel,
  inboxPreview,
  initialProjectId,
  methodOptions,
  modelsBackendFor,
  sortInbox,
  submitEntry,
  type InboxSource,
} from './home-entry';

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

describe('methodOptions', () => {
  it('capabilities가 없으면(API 없음·실패) 한 명만 켜고 나머지는 확인하지 못했다고 알린다', () => {
    const options = methodOptions(undefined);
    expect(options.map((option) => [option.id, option.enabled])).toEqual([
      ['single', true],
      ['fleet', false],
      ['split', false],
    ]);
    expect(options[1]!.reason).toBe('이 서버에서 확인하지 못했습니다');
    expect(options[2]!.reason).toBe('이 서버에서 확인하지 못했습니다');
    // 각 방식에 한 줄 설명이 있다
    expect(options[0]!.description).toContain('에이전트 하나');
    expect(options[1]!.description).toContain('따로 만들어');
    expect(options[2]!.description).toContain('나눠');
  });

  it('capabilities가 있으면 방식별 enabled와 이유를 그대로 따른다', () => {
    const options = methodOptions({
      mode: 'api',
      single: { enabled: true },
      fleet: { enabled: true },
      split: { enabled: false, reason: '이 모드에서는 계획을 받을 수 없습니다' },
    });
    expect(options.find((option) => option.id === 'fleet')).toMatchObject({ enabled: true });
    expect(options.find((option) => option.id === 'split')).toMatchObject({ enabled: false, reason: '이 모드에서는 계획을 받을 수 없습니다' });
  });

  it('한 명도 꺼져 있으면 비활성으로 둔다', () => {
    const options = methodOptions({ single: { enabled: false } });
    expect(options[0]).toMatchObject({ id: 'single', enabled: false });
  });
});

describe('initialProjectId', () => {
  it('쓸 수 있는 프로젝트가 하나면 자동으로 고른다', () => {
    expect(initialProjectId([{ id: 'orders' }])).toBe('orders');
    // 오류 난 프로젝트를 빼면 하나뿐일 때도 자동으로 고른다
    expect(initialProjectId([{ id: 'orders' }, { id: 'broken', error: 'studio.yaml 오류' }])).toBe('orders');
  });

  it('여럿이거나 없으면 고르지 않는다', () => {
    expect(initialProjectId([{ id: 'a' }, { id: 'b' }])).toBe('');
    expect(initialProjectId([])).toBe('');
    expect(initialProjectId([{ id: 'broken', error: '오류' }])).toBe('');
  });
});

describe('백엔드 선택', () => {
  it('capabilities의 backends가 둘 이상일 때만 고를 수 있다', () => {
    expect(backendOptions({ backends: ['api', 'commandcode'] })).toEqual(['api', 'commandcode']);
  });

  it('백엔드가 없거나 하나뿐이면 숨긴다(빈 목록)', () => {
    expect(backendOptions(undefined)).toEqual([]);
    expect(backendOptions({ backends: [] })).toEqual([]);
    expect(backendOptions({ backends: ['claude-code'] })).toEqual([]);
  });

  it('백엔드 id를 보여 줄 이름으로 바꾸고, 모르는 값은 그대로 둔다', () => {
    expect(backendLabel('claude-code')).toBe('Claude Code');
    expect(backendLabel('commandcode')).toBe('Command Code');
    expect(backendLabel('gemini')).toBe('gemini');
  });

  it('자기 모델 목록을 내려주는 CLI 백엔드만 모델을 고른다', () => {
    expect(modelsBackendFor('commandcode')).toBe('commandcode');
    expect(modelsBackendFor('opencode')).toBe('opencode');
    expect(modelsBackendFor('claude-code')).toBeUndefined();
    expect(modelsBackendFor(undefined)).toBeUndefined();
  });
});

describe('기본 모델', () => {
  const models = [
    { id: 'a', configured: true, capabilities: ['tools'] },
    { id: 'b', configured: true, enabled: false, capabilities: ['tools'] },
    { id: 'c', configured: false, capabilities: ['tools'] },
    { id: 'd', configured: true, capabilities: [] },
    { id: 'e', configured: true, capabilities: ['tools'] },
    { id: 'f', configured: true, capabilities: ['tools'] },
  ];

  it('설정됨·활성·도구 지원 모델만 앞에서 고른다', () => {
    expect(defaultFleetModels(models)).toEqual(['a', 'e']);
    expect(defaultFleetModels(models, 3)).toEqual(['a', 'e', 'f']);
    expect(defaultPlanModel(models)).toBe('a');
    expect(defaultPlanModel([{ id: 'x', configured: false, capabilities: ['tools'] }])).toBe('');
  });
});

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

describe('진행 중 목록', () => {
  // 목록 항목은 InboxSource 모양에 식별용 id를 더한 것이다(작업 화면의 key, 관제 항목의 id)
  const item = (over: Partial<InboxSource> & { id: string }): InboxSource & { id: string } => ({
    title: `요청 ${over.id}`,
    projectName: 'orders',
    href: `/sessions/${over.id}`,
    state: 'idle',
    lastActivityAt: '2026-09-29T00:00:00.000Z',
    ...over,
  });

  it('개입 필요 → 작업 중 → 나머지 순으로, 같은 순위는 최근 활동 순', () => {
    const items = [
      item({ id: 'idle-new', lastActivityAt: '2026-09-29T03:00:00.000Z' }),
      item({ id: 'working', state: 'working', lastActivityAt: '2026-09-29T01:00:00.000Z' }),
      item({ id: 'attention', attention: 'error', lastActivityAt: '2026-09-29T02:00:00.000Z' }),
      item({ id: 'idle-old', lastActivityAt: '2026-09-29T00:00:00.000Z' }),
    ];
    expect(sortInbox(items).map((entry) => entry.id)).toEqual(['attention', 'working', 'idle-new', 'idle-old']);
  });

  it('앞의 몇 개만 남기고, 빈 목록은 빈 목록이다', () => {
    const items = Array.from({ length: 8 }, (_, index) => item({ id: `s${index}`, lastActivityAt: `2026-09-29T0${index}:00:00.000Z` }));
    const preview = inboxPreview(items, 5);
    expect(preview).toHaveLength(5);
    expect(preview[0]!.id).toBe('s7');
    expect(inboxPreview([], 5)).toEqual([]);
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
