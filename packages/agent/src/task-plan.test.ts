import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import type { ModelClient } from './loop';
import { isInScope, parsePlannerReply, planLanes, requestTaskPlan, TaskPlanError } from './task-plan';

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
    const { lanes } = await requestTaskPlan(client, project, '두 화면 추가');
    expect(lanes).toHaveLength(2);
    expect(seen[0]!.tools).toBe(0);
    expect(seen[0]!.system).toContain('paths must not overlap');
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

    const result = await requestTaskPlan(client, project, '한 화면 추가');

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

    const error = await requestTaskPlan(client, project, '빈 계획').then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(TaskPlanError);
    expect((error as TaskPlanError).usage).toEqual({ inputTokens: 7, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 });
    expect((error as TaskPlanError).durationMs).toBeGreaterThanOrEqual(0);
  });
});
