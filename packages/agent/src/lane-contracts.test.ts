import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { buildContractSystem, buildContractUser, contractAskFromClient, MAX_LANE_CONTRACTS, requestLaneContracts } from './lane-contracts';
import type { ModelClient } from './loop';
import { buildPlannerSystem, TaskPlanError, type TaskLane } from './task-plan';

const project = {
  spec: { name: 'orders' },
  managed: [
    ['api', { template: 'spring-boot', path: 'api' }],
    ['web', { template: 'nextjs', path: 'web' }],
  ],
} as unknown as LoadedProject;

function lane(id: string, paths: string[], tasks: Array<{ id: string; title?: string; request?: string }>): TaskLane {
  return {
    id,
    paths,
    tasks: tasks.map((task) => ({ id: task.id, title: task.title ?? `${task.id} 제목`, request: task.request ?? `${task.id} 요청`, paths, dependsOn: [] })),
  };
}

const lanes: TaskLane[] = [
  lane('lane-1', ['api'], [{ id: 'api-list', request: '주문 목록 API를 만들어 줘' }]),
  lane('lane-2', ['web'], [{ id: 'web-list', request: '주문 목록 화면을 만들어 줘' }]),
];

/** 정상 계약 하나를 JSON으로 돌려주는 가짜 ask */
function askOf(text: string, usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }) {
  const seen: Array<{ system: string; user: string }> = [];
  return {
    seen,
    ask: async (input: { system: string; user: string }) => {
      seen.push(input);
      return { text, usage };
    },
  };
}

describe('buildContractSystem', () => {
  it('맞물리는 인터페이스만, 필드 이름·형·중첩까지 정확히 쓰게 한다', () => {
    const system = buildContractSystem(project);

    // 프로젝트와 서비스 폴더를 알려 준다
    expect(system).toContain('orders');
    expect(system).toContain('- api: spring-boot, 폴더 api');
    expect(system).toContain('- web: nextjs, 폴더 web');
    // body 형식 예시와 규칙
    expect(system).toContain('GET /api/books/{id} → 200 JSON, 404 if missing. Fields:');
    // 예시는 벤치 과제(주문)와 무관해야 한다. 과제의 필드 이름을 담으면 모델 계약이 답을 베낀 셈이 된다
    expect(system).not.toMatch(/api\/orders|customerName|shippingNote|shippingMemo|statusCount/);
    expect(system).toContain('string, number, boolean, array, object, null');
    expect(system).toContain('list or a map');
    expect(system).toContain('the response status codes');
    // 레인 하나만 쓰는 것은 쓰지 않는다 / 엮인 곳이 없으면 빈 목록
    expect(system).toContain('Do not write anything only one agent uses');
    expect(system).toContain('{"contracts":[]}');
    expect(system).toContain(`At most ${MAX_LANE_CONTRACTS} contracts`);
    // refs에 관련 경로를 적게 한다
    expect(system).toContain('refs are the paths this interface belongs to');
  });

  it('계획 프롬프트와 다른 문구로 시작한다 (벤치 프록시가 계약 요청을 계획 요청으로 보면 안 된다)', () => {
    expect(buildPlannerSystem(project).startsWith('You split a web development request')).toBe(true);
    expect(buildContractSystem(project).startsWith('You split a web development request')).toBe(false);
  });
});

describe('buildContractUser', () => {
  it('원 요청과 레인별 작업 요청·쓰기 경로를 담는다', () => {
    const user = buildContractUser('주문 목록을 만들어 줘', lanes);
    expect(user).toContain('전체 요청: 주문 목록을 만들어 줘');
    expect(user).toContain('- lane-1 · 쓰기 경로: api');
    expect(user).toContain('· api-list (api-list 제목): 주문 목록 API를 만들어 줘');
    expect(user).toContain('- lane-2 · 쓰기 경로: web');
  });
});

describe('requestLaneContracts', () => {
  it('계약을 받아 그대로 돌려주고 usage·시간을 함께 남긴다', async () => {
    const contracts = [{ body: 'GET /api/orders → 200 JSON 배열. 항목: id(number), customerName(string)', refs: ['api'] }];
    const { ask, seen } = askOf(JSON.stringify({ contracts }));

    const result = await requestLaneContracts(ask, project, '주문 목록', lanes);

    expect(result.contracts).toEqual([{ body: contracts[0]!.body, refs: ['api'] }]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(typeof result.durationMs).toBe('number');
    // 시스템·사용자 메시지를 그대로 넘긴다 (제품과 벤치가 같은 프롬프트를 쓴다)
    expect(seen).toHaveLength(1);
    expect(seen[0]!.system).toBe(buildContractSystem(project));
    expect(seen[0]!.user).toContain('전체 요청: 주문 목록');
  });

  it('엮인 곳이 없으면 빈 목록을 그대로 받는다', async () => {
    const { ask } = askOf('설명입니다.\n```json\n{"contracts":[]}\n```');
    const result = await requestLaneContracts(ask, project, '독립 작업', lanes);
    expect(result.contracts).toEqual([]);
  });

  it('refs를 빼면 버리지 않고 모든 레인의 첫 쓰기 경로로 채운다 (게시판은 refs 없는 계약을 거부한다)', async () => {
    const { ask } = askOf(JSON.stringify({ contracts: [{ body: 'GET /api/time → 200 JSON. time(string)' }, { body: 'GET /api/x → 200', refs: [] }] }));
    const result = await requestLaneContracts(ask, project, '시각', lanes);
    expect(result.contracts).toEqual([
      { body: 'GET /api/time → 200 JSON. time(string)', refs: ['api', 'web'] },
      { body: 'GET /api/x → 200', refs: ['api', 'web'] },
    ]);
  });

  it('형식이 틀리면 계약 호출의 usage·시간을 남겨 다시 던진다', async () => {
    const { ask } = askOf('{"tasks":[{"id":"a"}]}');
    const error = await requestLaneContracts(ask, project, '주문 목록', lanes).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(TaskPlanError);
    expect((error as TaskPlanError).message).toContain('레인 계약 형식이 올바르지 않습니다');
    expect((error as TaskPlanError).usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(typeof (error as TaskPlanError).durationMs).toBe('number');
  });

  it('본문이 너무 길거나 계약이 너무 많으면 거부한다', async () => {
    const long = askOf(JSON.stringify({ contracts: [{ body: '가'.repeat(1_201), refs: ['api'] }] }));
    await expect(requestLaneContracts(long.ask, project, '요청', lanes)).rejects.toThrow(TaskPlanError);

    const many = askOf(JSON.stringify({ contracts: Array.from({ length: MAX_LANE_CONTRACTS + 1 }, () => ({ body: 'GET /api/x → 200', refs: ['api'] })) }));
    await expect(requestLaneContracts(many.ask, project, '요청', lanes)).rejects.toThrow(TaskPlanError);
  });

  it('JSON을 찾지 못하면 계획 응답과 같은 오류로 알린다', async () => {
    const { ask } = askOf('계약을 쓸 수 없습니다');
    await expect(requestLaneContracts(ask, project, '요청', lanes)).rejects.toThrow(/JSON을 찾지 못했습니다/);
  });

  it('레인이 하나면 모델을 부르지 않고 빈 목록을 돌려준다', async () => {
    const { ask, seen } = askOf('{"contracts":[{"body":"쓰면 안 됨"}]}');
    const result = await requestLaneContracts(ask, project, '요청', [lanes[0]!]);

    expect(seen).toHaveLength(0);
    expect(result).toEqual({ contracts: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, durationMs: 0 });
  });
});

describe('contractAskFromClient', () => {
  it('도구 없이 모델을 부르고 usage를 세션 지표 모양으로 옮긴다', async () => {
    const requests: Array<{ tools: number; system: string; content: unknown }> = [];
    const client: ModelClient = {
      async createMessage(request) {
        requests.push({ tools: request.tools.length, system: request.system, content: request.messages[0]!.content });
        return {
          content: [{ type: 'text', text: '{"contracts":[]}', citations: null }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
        } as never;
      },
    };

    const answer = await contractAskFromClient(client)({ system: '시스템', user: '사용자' });

    expect(answer.text).toBe('{"contracts":[]}');
    expect(answer.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 });
    expect(requests).toEqual([{ tools: 0, system: '시스템', content: '사용자' }]);
  });
});
