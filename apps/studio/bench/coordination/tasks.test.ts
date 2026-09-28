import { planLanes } from '@b-studio/agent';
import path from 'node:path';
import { loadProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { BENCH_TASKS, missingCoordinationTools, planFor, type Strategy } from './tasks';

const STRATEGIES: Strategy[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'];

describe('협업 벤치 과제와 고정 계획', () => {
  it('모든 과제·전략의 계획이 planLanes 검증을 통과한다', () => {
    for (const task of BENCH_TASKS) {
      for (const strategy of STRATEGIES) {
        expect(() => planLanes(planFor(task, strategy)), `${task.id} ${strategy}`).not.toThrow();
      }
    }
  });

  it('S0만 레인 하나에서 api → web 순서, 나머지는 레인 둘로 나뉜다', () => {
    for (const task of BENCH_TASKS) {
      const s0 = planLanes(planFor(task, 'S0'));
      expect(s0).toHaveLength(1);
      expect(s0[0]!.tasks.map((item) => item.id)).toEqual([`${task.id}-api`, `${task.id}-web`]);

      for (const strategy of ['S1', 'S2', 'S3', 'S4', 'S5'] as Strategy[]) {
        const lanes = planLanes(planFor(task, strategy));
        expect(lanes, `${task.id} ${strategy}`).toHaveLength(2);
        expect(lanes.map((lane) => lane.tasks.map((item) => item.id))).toEqual([[`${task.id}-api`], [`${task.id}-web`]]);
      }
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

  it('과제마다 S2용 인터페이스 계약이 있다', () => {
    for (const task of BENCH_TASKS) {
      expect(task.contract.body.length, task.id).toBeGreaterThan(0);
      expect(task.contract.refs.length, task.id).toBeGreaterThan(0);
      // 계약 본문은 과제 요청과 같은 인터페이스를 가리킨다
      expect(task.contract.refs).toEqual(['api']);
    }
    expect(BENCH_TASKS.find((task) => task.id === 'orders-list')?.contract.body).toContain('GET /api/orders');
  });

  it('S2는 계약을, S3는 topology를, S4·S5는 전략만 싣고 S0·S1은 조율이 없다', () => {
    const task = BENCH_TASKS[0]!;
    expect(planFor(task, 'S0').coordination).toBeUndefined();
    expect(planFor(task, 'S1').coordination).toBeUndefined();

    expect(planFor(task, 'S2').coordination).toEqual({ strategy: 'S2', contracts: [{ body: task.contract.body, refs: task.contract.refs }] });
    // topology는 S3에서만 쓰고, 주지 않으면 mesh
    expect(planFor(task, 'S3', 'star').coordination).toEqual({ strategy: 'S3', topology: 'star' });
    expect(planFor(task, 'S3').coordination).toEqual({ strategy: 'S3', topology: 'mesh' });
    expect(planFor(task, 'S4').coordination).toEqual({ strategy: 'S4' });
    expect(planFor(task, 'S5').coordination).toEqual({ strategy: 'S5' });
  });
});

describe('missingCoordinationTools', () => {
  it('전략이 레인에게 보여 줘야 하는 도구가 허용 목록에 없으면 알려 준다', () => {
    const base = ['list_files', 'read_file'];
    expect(missingCoordinationTools('S1', base)).toEqual([]);
    expect(missingCoordinationTools('S4', base)).toEqual([]);
    expect(missingCoordinationTools('S2', base)).toEqual(['read_notes']);
    expect(missingCoordinationTools('S5', base)).toEqual(['read_notes']);
    expect(missingCoordinationTools('S3', base)).toEqual(['post_note', 'read_notes']);
    expect(missingCoordinationTools('S3', [...base, 'post_note', 'read_notes'])).toEqual([]);
  });

  it('허용 목록이 없는 프로젝트는 모든 도구를 쓸 수 있다', () => {
    expect(missingCoordinationTools('S3', undefined)).toEqual([]);
  });

  it('벤치가 쓰는 예제 프로젝트는 모든 전략의 조율 도구를 허용한다', async () => {
    const project = await loadProject(path.resolve(import.meta.dirname, '../../../../examples/orders'));
    const strategies: Strategy[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'];
    expect(strategies.flatMap((strategy) => missingCoordinationTools(strategy, project.spec.workflow?.allowedTools))).toEqual([]);
  });
});
