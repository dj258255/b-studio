import { planLanes } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import { BENCH_TASKS, planFor, type Strategy } from './tasks';

const STRATEGIES: Strategy[] = ['S0', 'S1'];

describe('협업 벤치 과제와 고정 계획', () => {
  it('모든 과제·전략의 계획이 planLanes 검증을 통과한다', () => {
    for (const task of BENCH_TASKS) {
      for (const strategy of STRATEGIES) {
        expect(() => planLanes(planFor(task, strategy)), `${task.id} ${strategy}`).not.toThrow();
      }
    }
  });

  it('S0은 레인 하나에서 api → web 순서, S1은 레인 둘로 나뉜다', () => {
    for (const task of BENCH_TASKS) {
      const s0 = planLanes(planFor(task, 'S0'));
      expect(s0).toHaveLength(1);
      expect(s0[0]!.tasks.map((item) => item.id)).toEqual([`${task.id}-api`, `${task.id}-web`]);

      const s1 = planLanes(planFor(task, 'S1'));
      expect(s1).toHaveLength(2);
      expect(s1.map((lane) => lane.tasks.map((item) => item.id))).toEqual([[`${task.id}-api`], [`${task.id}-web`]]);
    }
  });

  it('작업 id·쓰기 범위·작업 표지가 규칙을 지킨다', () => {
    for (const task of BENCH_TASKS) {
      const planned = planFor(task, 'S1').tasks;
      expect(planned).toHaveLength(2);
      for (const item of planned) {
        expect(item.id).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
        expect(item.request).toContain(`[task:${item.id}]`);
      }
      // api는 api 폴더만, web은 web 폴더만 쓰게 한다
      expect(planned[0]!.paths).toEqual(['api']);
      expect(planned[1]!.paths).toEqual(['web']);
    }
  });

  it('엮인 과제는 coupled, 대조군은 아니다', () => {
    expect(BENCH_TASKS.filter((task) => task.coupled).map((task) => task.id)).toEqual(['orders-list', 'order-detail', 'order-summary']);
    expect(BENCH_TASKS.find((task) => task.id === 'independent')?.coupled).toBe(false);
  });
});
