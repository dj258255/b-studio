import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it, vi } from 'vitest';
import type { ModelClient } from './loop';
import { buildPlannerSystem, DEFAULT_PLAN_LIMITS, isInScope, parsePlannerReply, planAskFromClient, planLanes, planLimitsFromEnv, requestTaskPlan, TaskPlanError } from './task-plan';

const task = (id: string, paths: string[], dependsOn: string[] = []) => ({ id, title: id, request: `${id} 작업`, paths, dependsOn });

describe('작업 계획', () => {
  it('의존 관계로 이어진 작업은 한 레인에서 순서대로, 독립 작업은 다른 레인으로 나눈다', () => {
    const lanes = planLanes({
      tasks: [task('page', ['web/app/orders'], ['api-client']), task('api-client', ['web/lib/orders']), task('badge', ['web/components/badge'])],
    });
    expect(lanes.map((lane) => lane.tasks.map((item) => item.id))).toEqual([['api-client', 'page'], ['badge']]);
    expect(lanes[0]!.paths).toEqual(['web/app/orders', 'web/lib/orders']);
  });

  it('병렬 레인의 쓰기 범위가 겹치면 실행 전에 거부한다 (상위·하위 경로 포함)', () => {
    expect(() => planLanes({ tasks: [task('a', ['web/app']), task('b', ['web/app/orders'])] })).toThrow(/쓰기 범위가 겹칩니다/);
    // 같은 레인 안에서는 겹쳐도 된다. 차례로 돌기 때문이다
    expect(planLanes({ tasks: [task('a', ['web/app']), task('b', ['web/app/orders'], ['a'])] })).toHaveLength(1);
    // 이름 앞부분만 같은 형제 폴더는 겹치지 않는다
    expect(planLanes({ tasks: [task('a', ['web/app/plan']), task('b', ['web/app/plan-b'])] })).toHaveLength(2);
  });

  it('형식·의존성·순환·범위가 틀린 계획은 한 작업으로 바꾸지 않고 거부한다', () => {
    expect(() => planLanes({ tasks: [] })).toThrow(TaskPlanError);
    expect(() => planLanes({ tasks: [task('a', ['web'], ['missing'])] })).toThrow(/없는 작업/);
    expect(() => planLanes({ tasks: [task('a', ['web/a'], ['b']), task('b', ['web/b'], ['a'])] })).toThrow(/순환/);
    expect(() => planLanes({ tasks: [task('a', ['../outside'])] })).toThrow(/상대 경로/);
    expect(() => planLanes({ tasks: [task('a', ['.'])] })).toThrow(/프로젝트 전체/);
    expect(() => planLanes({ tasks: [task('a', ['web/a']), task('a', ['web/b'])] })).toThrow(/중복/);
    expect(() => planLanes({ tasks: ['a', 'b', 'c', 'd'].map((id) => task(id, [`web/${id}`])) })).toThrow(/레인은 3개까지/);
  });

  it('레인 범위 밖 파일을 가려낸다', () => {
    expect(isInScope('web/app/orders/page.tsx', ['web/app/orders'])).toBe(true);
    expect(isInScope('web/app/orders-old/page.tsx', ['web/app/orders'])).toBe(false);
  });

  it('작업마다 backend·model을 실을 수 있고, 한 레인 안에서 다르면 거부한다', () => {
    const withBackend = (id: string, paths: string[], dependsOn: string[], backend?: string, model?: string) => ({
      ...task(id, paths, dependsOn),
      ...(backend ? { backend } : {}),
      ...(model ? { model } : {}),
    });

    // 같은 레인의 작업(의존으로 이어짐)은 같은 backend·model을 공유한다
    const lanes = planLanes({
      tasks: [withBackend('api', ['api'], [], 'claude-code', 'sonnet'), withBackend('web', ['web'], ['api'], 'claude-code', 'sonnet')],
    });
    expect(lanes[0]!.tasks.map((item) => [item.id, item.backend, item.model])).toEqual([
      ['api', 'claude-code', 'sonnet'],
      ['web', 'claude-code', 'sonnet'],
    ]);

    // 독립 레인은 서로 다른 backend를 쓸 수 있다
    const mixed = planLanes({
      tasks: [withBackend('a', ['a'], [], 'claude-code'), withBackend('b', ['b'], [], 'commandcode'), withBackend('c', ['c'], [], 'opencode', 'opencode/mimo-v2.6-flash-free')],
    });
    expect(mixed.map((lane) => lane.tasks[0]!.backend)).toEqual(['claude-code', 'commandcode', 'opencode']);
    expect(mixed[2]!.tasks[0]!.model).toBe('opencode/mimo-v2.6-flash-free');

    // 같은 레인 안에서 backend나 model이 다르면 실행 전에 거부한다
    expect(() => planLanes({ tasks: [withBackend('a', ['api'], [], 'claude-code'), withBackend('b', ['api/sub'], ['a'], 'codex')] })).toThrow(/backend가 같아야/);
    expect(() =>
      planLanes({ tasks: [withBackend('a', ['api'], [], 'claude-code', 'sonnet'), withBackend('b', ['api/sub'], ['a'], 'claude-code', 'opus')] }),
    ).toThrow(/model이 같아야/);
    // 모르는 backend는 스키마가 거부한다
    expect(() => planLanes({ tasks: [withBackend('a', ['api'], [], 'gemini')] })).toThrow(/형식이 올바르지 않습니다/);
  });

  it('모델 응답의 코드 펜스·설명을 걷어내고 JSON을 읽는다', () => {
    expect(parsePlannerReply('계획입니다.\n```json\n{"tasks":[]}\n```')).toEqual({ tasks: [] });
    expect(parsePlannerReply('{"tasks":[{"id":"a"}]}')).toEqual({ tasks: [{ id: 'a' }] });
    expect(() => parsePlannerReply('나눌 수 없습니다')).toThrow(/JSON을 찾지 못했습니다/);
  });

  it('도구 없이 모델에게 계획을 받아 검증한 레인을 돌려준다', async () => {
    const seen: Array<{ tools: number; system: string }> = [];
    const client: ModelClient = {
      async createMessage(request) {
        seen.push({ tools: request.tools.length, system: request.system });
        return {
          content: [{ type: 'text', text: JSON.stringify({ tasks: [task('a', ['web/a']), task('b', ['web/b'])] }), citations: null }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        } as never;
      },
    };
    const project = { spec: { name: 'orders' }, managed: [['web', { template: 'nextjs', path: 'web' }]] } as unknown as LoadedProject;
    const { lanes } = await requestTaskPlan(planAskFromClient(client), project, '두 화면 추가');
    expect(lanes).toHaveLength(2);
    expect(seen[0]!.tools).toBe(0);
    expect(seen[0]!.system).toContain('paths must not overlap');
  });

  it('계획 호출 방법을 바깥에서 주입한다(PlanAsk) — 로컬 CLI도 같은 프롬프트·같은 검증을 쓴다', async () => {
    const seen: Array<{ system: string; user: string }> = [];
    const ask = async ({ system, user }: { system: string; user: string }) => {
      seen.push({ system, user });
      return { text: JSON.stringify({ tasks: [task('a', ['web/a'])] }), usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    };
    const project = { spec: { name: 'orders' }, managed: [['web', { template: 'nextjs', path: 'web' }]] } as unknown as LoadedProject;

    const result = await requestTaskPlan(ask, project, '한 화면 추가');

    expect(result.lanes).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // 프롬프트는 어댑터를 쓸 때와 같다(계획 프롬프트 하나만 있다)
    expect(seen[0]!.system).toContain('You split a web development request');
    expect(seen[0]!.user).toBe('한 화면 추가');
  });

  it('계획 호출의 usage와 걸린 시간을 함께 돌려준다', async () => {
    const client: ModelClient = {
      async createMessage() {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tasks: [task('a', ['web/a'])] }), citations: null }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 5 },
        } as never;
      },
    };
    const project = { spec: { name: 'orders' }, managed: [['web', { template: 'nextjs', path: 'web' }]] } as unknown as LoadedProject;

    const result = await requestTaskPlan(planAskFromClient(client), project, '한 화면 추가');

    expect(result.lanes).toHaveLength(1);
    // addUsage와 같은 모양으로 바꾼다 (캐시 분을 따로 센다)
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5 });
    expect(Number.isInteger(result.durationMs)).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('계획 검증이 실패해도 그때까지 쓴 usage와 시간을 오류에 남긴다', async () => {
    const client: ModelClient = {
      async createMessage() {
        return {
          content: [{ type: 'text', text: '{"tasks":[]}', citations: null }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 },
        } as never;
      },
    };
    const project = { spec: { name: 'orders' }, managed: [['web', { template: 'nextjs', path: 'web' }]] } as unknown as LoadedProject;

    const error = await requestTaskPlan(planAskFromClient(client), project, '빈 계획').then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(TaskPlanError);
    expect((error as TaskPlanError).usage).toEqual({ inputTokens: 7, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 });
    expect((error as TaskPlanError).durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('계획 상한 설정', () => {
  const project = { spec: { name: 'orders' }, managed: [['web', { template: 'nextjs', path: 'web' }]] } as unknown as LoadedProject;
  const independent = (count: number) => [1, 2, 3, 4, 5, 6, 7, 8].slice(0, count).map((n) => task(`t${n}`, [`dir/${n}`]));

  it('기본값은 3·6 그대로다', () => {
    expect(DEFAULT_PLAN_LIMITS).toEqual({ maxLanes: 3, maxTasks: 6 });
    expect(planLimitsFromEnv({})).toEqual({ maxLanes: 3, maxTasks: 6 });
  });

  it('설정값을 그대로 읽는다(절대 상한까지)', () => {
    expect(planLimitsFromEnv({ B_STUDIO_MAX_LANES: ' 5 ', B_STUDIO_MAX_PLAN_TASKS: '12' })).toEqual({ maxLanes: 5, maxTasks: 12 });
    expect(planLimitsFromEnv({ B_STUDIO_MAX_LANES: '8', B_STUDIO_MAX_PLAN_TASKS: '16' })).toEqual({ maxLanes: 8, maxTasks: 16 });
  });

  it('범위 밖 값·정수가 아닌 값은 기본값으로 돌리고 이유를 경고로 남긴다', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let lines: string[] = [];
    try {
      expect(planLimitsFromEnv({ B_STUDIO_MAX_LANES: '9' })).toEqual({ maxLanes: 3, maxTasks: 6 });
      expect(planLimitsFromEnv({ B_STUDIO_MAX_LANES: '0' })).toEqual({ maxLanes: 3, maxTasks: 6 });
      expect(planLimitsFromEnv({ B_STUDIO_MAX_PLAN_TASKS: '3.5' })).toEqual({ maxLanes: 3, maxTasks: 6 });
      expect(planLimitsFromEnv({ B_STUDIO_MAX_PLAN_TASKS: 'many' })).toEqual({ maxLanes: 3, maxTasks: 6 });
      lines = warn.mock.calls.map((call) => String(call[0]));
    } finally {
      warn.mockRestore();
    }

    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.includes('기본값'))).toBe(true);
    expect(lines[0]).toContain('B_STUDIO_MAX_LANES');
    expect(lines[2]).toContain('B_STUDIO_MAX_PLAN_TASKS');
  });

  it('planLanes가 그 실행의 상한을 따른다', () => {
    // 기본은 3·6 그대로다(기존 문구 유지)
    expect(() => planLanes({ tasks: independent(4) })).toThrow(/레인은 3개까지/);
    // 올리면 그만큼 받고, 넘으면 올린 수를 말한다
    expect(planLanes({ tasks: independent(4) }, { maxLanes: 4, maxTasks: 6 })).toHaveLength(4);
    expect(() => planLanes({ tasks: independent(5) }, { maxLanes: 4, maxTasks: 6 })).toThrow(/레인은 4개까지/);
    // 낮추면 그만큼만 받는다
    expect(() => planLanes({ tasks: independent(4) }, { maxLanes: 2, maxTasks: 6 })).toThrow(/레인은 2개까지/);
    // 작업 수 상한도 설정을 따른다(스키마는 절대 상한 16까지만 막는다)
    expect(() => planLanes({ tasks: independent(7) }, { maxLanes: 8, maxTasks: 6 })).toThrow(/작업은 6개까지/);
    expect(planLanes({ tasks: independent(7) }, { maxLanes: 8, maxTasks: 7 })).toHaveLength(7);
  });

  it('계획 프롬프트가 그 실행의 상한을 알린다', () => {
    const prompt = buildPlannerSystem(project, { maxLanes: 6, maxTasks: 12 });
    expect(prompt).toContain('At most 12 tasks');
    expect(prompt).toContain('at most 6 groups');
    // 인자를 주지 않으면 기본값 그대로다
    expect(buildPlannerSystem(project)).toContain('At most 6 tasks');
  });

  it('계획 호출도 그 상한으로 검증하고 프롬프트에 알린다', async () => {
    const seen: string[] = [];
    const ask = async ({ system }: { system: string }) => {
      seen.push(system);
      return { text: JSON.stringify({ tasks: [task('a', ['dir/a']), task('b', ['dir/b'])] }), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    };

    await expect(requestTaskPlan(ask, project, '두 곳 고쳐줘', undefined, { maxLanes: 1, maxTasks: 6 })).rejects.toThrow(/레인은 1개까지/);
    expect(seen[0]).toContain('At most 6 tasks');
    expect(seen[0]).toContain('at most 1 groups');
  });
});
