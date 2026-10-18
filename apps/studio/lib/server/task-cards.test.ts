import { planLanes } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import { StudioError } from './errors';
import { cardsToPlan } from './task-cards';

const card = (paths: string[], extra: Record<string, unknown> = {}) => ({ title: '카드', request: '무엇을 한다', paths, ...extra });

function statusOf(action: () => unknown): number {
  try {
    action();
  } catch (error) {
    if (error instanceof StudioError) return error.status;
    throw error;
  }
  throw new Error('오류가 나지 않았습니다');
}

describe('작업 카드 → 계획', () => {
  it('카드 순서대로 card-1, card-2, … id를 주고 완료 검사를 만든다', () => {
    const { plan, done } = cardsToPlan([card(['web/a'], { doneCommand: 'pnpm test', doneService: 'web' }), card(['web/b'])], ['web']);

    expect(plan.tasks.map((task) => task.id)).toEqual(['card-1', 'card-2']);
    expect(plan.tasks[0]).toMatchObject({ title: '카드', request: '무엇을 한다', paths: ['web/a'], dependsOn: [] });
    expect(done).toEqual({ 'card-1': { name: 'done-card-1', service: 'web', command: ['sh', '-c', 'pnpm test'] } });
  });

  it('doneService를 생략하면 이 프로젝트의 첫 관리형 서비스를 쓴다', () => {
    const { done } = cardsToPlan([card(['web/a'], { doneCommand: 'pnpm test' })], ['api', 'web']);

    expect(done['card-1']).toEqual({ name: 'done-card-1', service: 'api', command: ['sh', '-c', 'pnpm test'] });
  });

  it('겹치는 카드는 앞선 카드 모두에 의존해 한 레인에 순서대로, 겹치지 않으면 다른 레인으로 묶인다', () => {
    const { plan } = cardsToPlan([card(['api/']), card(['api/src']), card(['web/lib/x.ts'])], ['api', 'web']);

    // A·B는 같은 폴더라 겹친다 — B는 A에 의존하고, C는 독립이다
    expect(plan.tasks.map((task) => [task.id, task.dependsOn])).toEqual([
      ['card-1', []],
      ['card-2', ['card-1']],
      ['card-3', []],
    ]);
    const lanes = planLanes(plan);
    expect(lanes.map((lane) => lane.tasks.map((task) => task.id))).toEqual([['card-1', 'card-2'], ['card-3']]);
  });

  it('상위·하위 경로(api/ ↔ api/src/A.java)도 겹침으로 본다', () => {
    const { plan } = cardsToPlan([card(['api/']), card(['api/src/A.java'])], ['api']);

    expect(plan.tasks[1]!.dependsOn).toEqual(['card-1']);
    expect(planLanes(plan)).toHaveLength(1);
  });

  it('형제 폴더처럼 이름 앞부분만 같은 경로는 겹치지 않는다', () => {
    const { plan } = cardsToPlan([card(['web/app/plan']), card(['web/app/plan-b'])], ['web']);

    expect(plan.tasks[1]!.dependsOn).toEqual([]);
    expect(planLanes(plan)).toHaveLength(2);
  });

  it('없는 서비스를 완료 조건 서비스로 주면 400으로 알린다', () => {
    expect(statusOf(() => cardsToPlan([card(['web/a'], { doneCommand: 'pnpm test', doneService: 'nope' })], ['web']))).toBe(400);
    expect(() => cardsToPlan([card(['web/a'], { doneCommand: 'pnpm test', doneService: 'nope' })], ['web'])).toThrow('완료 조건의 서비스를 찾을 수 없습니다: nope');
  });

  it('관리형 서비스가 하나도 없는데 완료 조건이 있으면 400', () => {
    expect(statusOf(() => cardsToPlan([card(['web/a'], { doneCommand: 'pnpm test' })], []))).toBe(400);
  });

  it('빈 배열·모르는 필드는 400으로 거절한다', () => {
    expect(statusOf(() => cardsToPlan([], ['web']))).toBe(400);
    expect(statusOf(() => cardsToPlan([card(['web/a'], { unknown: true })], ['web']))).toBe(400);
    expect(statusOf(() => cardsToPlan([card([])], ['web']))).toBe(400);
    expect(statusOf(() => cardsToPlan([card(['web/a'], { doneCommand: 'a\nb' })], ['web']))).toBe(400);
    expect(statusOf(() => cardsToPlan('not-an-array', ['web']))).toBe(400);
  });
});
