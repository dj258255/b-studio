import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * 계획 상한은 시작할 때 설정에서 한 번 읽는다. 그 반영을 보려면 모듈을 새로 불러와야 한다
 * (다른 테스트는 기본값 3·6을 그대로 쓴다 — 여기서만 환경 변수를 세운다).
 */
const saved = { lanes: process.env.B_STUDIO_MAX_LANES, tasks: process.env.B_STUDIO_MAX_PLAN_TASKS };

afterAll(() => {
  for (const [key, value] of [
    ['B_STUDIO_MAX_LANES', saved.lanes],
    ['B_STUDIO_MAX_PLAN_TASKS', saved.tasks],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('작업 분해 계획 상한', () => {
  it('설정한 값을 시작할 때 읽는다', async () => {
    process.env.B_STUDIO_MAX_LANES = '4';
    process.env.B_STUDIO_MAX_PLAN_TASKS = '9';
    vi.resetModules();

    const { PLAN_LIMITS } = await import('./task-plans');

    expect(PLAN_LIMITS).toEqual({ maxLanes: 4, maxTasks: 9 });
  });

  it('설정하지 않았으면 기본값 3·6이다', async () => {
    delete process.env.B_STUDIO_MAX_LANES;
    delete process.env.B_STUDIO_MAX_PLAN_TASKS;
    vi.resetModules();

    const { PLAN_LIMITS } = await import('./task-plans');

    expect(PLAN_LIMITS).toEqual({ maxLanes: 3, maxTasks: 6 });
  });

  it('범위 밖 값이면 기본값으로 돌린다(경고는 에이전트가 남긴다)', async () => {
    process.env.B_STUDIO_MAX_LANES = '99';
    process.env.B_STUDIO_MAX_PLAN_TASKS = '0';
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { PLAN_LIMITS } = await import('./task-plans');

      expect(PLAN_LIMITS).toEqual({ maxLanes: 3, maxTasks: 6 });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
