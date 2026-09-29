import { planLanes } from '@b-studio/agent';
import path from 'node:path';
import { loadProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { BENCH_TASKS, integrationChecksFor, missingCoordinationTools, planFor, STRATEGIES as ALL_STRATEGIES, STRATEGY_LABELS, type Strategy } from './tasks';

const LANE_STRATEGIES: Strategy[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'];

describe('협업 벤치 과제와 고정 계획', () => {
  it('모든 과제·전략의 계획이 planLanes 검증을 통과한다', () => {
    for (const task of BENCH_TASKS) {
      for (const strategy of LANE_STRATEGIES) {
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

describe('P0 기준선 전략', () => {
  it('전략 목록에 P0가 있고 표시 이름이 "그냥 Claude Code"다', () => {
    expect(ALL_STRATEGIES).toContain('P0');
    expect(STRATEGY_LABELS.P0).toBe('그냥 Claude Code');
  });

  it('planFor는 P0에 작업 분해 계획을 만들지 않는다', () => {
    expect(() => planFor(BENCH_TASKS[0]!, 'P0')).toThrow(/P0/);
  });

  it('P0는 조율 도구가 필요 없다', () => {
    expect(missingCoordinationTools('P0', ['read_file', 'write_file'])).toEqual([]);
  });
});

describe('레인 백엔드(--lane-backend)', () => {
  it('laneBackends를 주면 그 그룹 레인 작업에만 backend·model을 싣는다', () => {
    const laneBackends = new Map([
      ['api', { backend: 'claude-code' as const, model: 'sonnet' }],
      ['web', { backend: 'commandcode' as const }],
    ]);
    const plan = planFor(BENCH_TASKS[0]!, 'S1', 'mesh', laneBackends);
    expect(plan.tasks.map((task) => [task.paths[0], task.backend, task.model])).toEqual([
      ['api', 'claude-code', 'sonnet'],
      ['web', 'commandcode', undefined],
    ]);
    // 주지 않으면 지금과 같다(backend 없음 → 서버 모드)
    expect(planFor(BENCH_TASKS[0]!, 'S1').tasks.every((task) => task.backend === undefined)).toBe(true);
  });

  it('레인 백엔드를 실은 계획도 planLanes 검증을 통과한다(S1)', () => {
    const laneBackends = new Map([
      ['api', { backend: 'claude-code' as const }],
      ['web', { backend: 'commandcode' as const }],
    ]);
    expect(() => planLanes(planFor(BENCH_TASKS[0]!, 'S1', 'mesh', laneBackends))).not.toThrow();
  });
});

describe('integrationChecksFor (통합 게이트 샘플 값 확인)', () => {
  const task = (id: string) => BENCH_TASKS.find((candidate) => candidate.id === id)!;

  it('엮인 과제마다 과제 요청의 샘플 값을 web 화면에서 확인한다(필드 이름을 쓰지 않는다)', () => {
    expect(integrationChecksFor(task('orders-list'))?.pageChecks).toEqual([
      { service: 'web', path: '/orders', mode: 'http', expectStatus: 200, expectText: '김민수', allowConsoleErrors: false, noHorizontalScroll: false },
    ]);
    expect(integrationChecksFor(task('order-detail'))?.pageChecks[0]).toMatchObject({ path: '/orders/1', mode: 'http', expectText: '문 앞에 놓아 주세요' });
    expect(integrationChecksFor(task('order-summary'))?.pageChecks[0]).toMatchObject({ path: '/dashboard', mode: 'http', expectAnyText: ['45000', '45,000'] });
    // 필드 이름 대신 샘플 값만 본다
    for (const coupled of BENCH_TASKS.filter((candidate) => candidate.coupled)) {
      expect(integrationChecksFor(coupled)!.pageChecks[0]!.expectFromApi, coupled.id).toBeUndefined();
    }
  });

  it('독립 과제는 확인을 두지 않는다', () => {
    expect(integrationChecksFor(task('independent'))).toBeUndefined();
  });

  it('확인 값은 그 과제의 web 인수 검사 기대값과 같다(H10 판정 기준)', () => {
    for (const coupled of BENCH_TASKS.filter((candidate) => candidate.coupled)) {
      const check = integrationChecksFor(coupled)!.pageChecks[0]!;
      const acceptance = coupled.acceptance.find((item) => item.service === 'web')!;
      expect(acceptance.path, coupled.id).toBe(check.path);
      const values = check.expectAnyText ?? [check.expectText!];
      const expected = acceptance.expectAny ?? acceptance.expectAll ?? [];
      expect(values.length, coupled.id).toBeGreaterThan(0);
      expect(values.every((value) => expected.includes(value)), coupled.id).toBe(true);
    }
  });
});
