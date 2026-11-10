import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { native } from '@b-studio/sandbox';
import * as legacyPaths from './path-policy-legacy';

/**
 * 작업 계획 판정(planLanes, isInScope, planLimitsFromEnv, ADR-191 3단계 3x)의 벡터. 기대값은 옮기기 전 TS(`task-plan-legacy.ts`)가 낸 값이다(`task-plan-vectors.json`).
 * `VECTORS_AGAINST_LEGACY=1`로 돌리면 같은 벡터를 옛 TS에 넣는다(0건 실패해야 한다).
 * 경계를 밟는다: 상한과 같음·±1, 이름이 접두만 같은 범위, 대소문자·겹친 구분자·역슬래시·`..`, 유니코드 정규화, 짝 없는 서로게이트.
 */
interface PlanVector {
  name: string;
  plan: unknown;
  limits?: { maxLanes: number | string; maxTasks: number | string };
  expected: string;
}
interface Vectors {
  plan: PlanVector[];
  scope: Array<{ file: string; scopes: string[]; expected: boolean; truth: boolean }>;
  limits: Array<{ lanes?: string; tasks?: string; expected: string }>;
}
const vectors = JSON.parse(readFileSync(new URL('./task-plan-vectors.json', import.meta.url), 'utf8')) as Vectors;
const impl = (await import(process.env.VECTORS_AGAINST_LEGACY ? './task-plan-legacy' : './task-plan')) as typeof import('./task-plan');
const revive = (value: number | string): number => (typeof value === 'string' ? Number(value.replace('~', '')) : value);

describe('작업 계획 벡터', () => {
  it('입력이 비지 않았다', () => {
    expect(vectors.plan.length).toBeGreaterThanOrEqual(50);
    expect(vectors.scope.length).toBeGreaterThanOrEqual(40);
    expect(vectors.limits.length).toBeGreaterThanOrEqual(25);
    expect(vectors.plan.filter((v) => v.expected.startsWith('OK:')).length).toBeGreaterThan(10);
    expect(vectors.plan.filter((v) => v.expected.startsWith('ERR:')).length).toBeGreaterThan(30);
    expect(vectors.scope.filter((v) => v.expected).length).toBeGreaterThan(10);
    expect(vectors.scope.filter((v) => !v.expected).length).toBeGreaterThan(10);
  });

  it.each(vectors.plan)('planLanes: $name', ({ plan, limits, expected }) => {
    const parsedLimits = limits === undefined ? undefined : { maxLanes: revive(limits.maxLanes), maxTasks: revive(limits.maxTasks) };
    let actual: string;
    try {
      actual = `OK:${JSON.stringify(impl.planLanes(plan, parsedLimits))}`;
    } catch (error) {
      actual = `ERR:${(error as Error).message}`;
    }
    expect(actual).toBe(expected);
  });

  it.each(vectors.scope.map((v) => ({ ...v, label: JSON.stringify([v.file, v.scopes]) })))('isInScope: $label', ({ file, scopes, expected, truth }) => {
    expect(impl.isInScope(file, scopes)).toBe(expected);
    // 옛 판정이 기대하는 값은 그 아래의 진짜 옛 TS(쓰기 범위 판정)가 낸 값과 같다
    expect(scopes.some((scope) => legacyPaths.isWithinScope(file, scope))).toBe(truth);
    expect(truth).toBe(expected);
  });

  it.each(vectors.limits.map((v) => ({ ...v, label: JSON.stringify([v.lanes, v.tasks]) })))('planLimitsFromEnv: $label', ({ lanes, tasks, expected }) => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: unknown) => void warnings.push(String(message));
    try {
      expect(JSON.stringify({ limits: impl.planLimitsFromEnv({ B_STUDIO_MAX_LANES: lanes, B_STUDIO_MAX_PLAN_TASKS: tasks }), warnings })).toBe(expected);
    } finally {
      console.warn = original;
    }
  });
});

/**
 * 짝 없는 서로게이트 성질 시험: 인코딩 없이 napi로 보내면 서로 다른 서로게이트가 U+FFFD로 합쳐져 범위 밖이 범위 안이 된다(허용 목록이라 열린 쪽).
 * 껍데기(isInScope)는 인코딩해 보내므로 그렇게 되지 않는다. 옛 TS와도 같은 답(범위 밖)이어야 한다.
 */
describe('짝 없는 서로게이트 성질', () => {
  const pairs: Array<[string, string]> = [
    ['web/\uD800', 'web/\uD801'],
    ['web/app/\uDC00x', 'web/app/\uDFFFx'],
    ['web/\uD800', 'web/\uFFFD'],
  ];
  it.each(pairs)('인코딩 없이 보내면 %j 은 합쳐지고 껍데기는 범위 밖으로 둔다', (file, scope) => {
    expect(native.taskPlanIsInScope(file, [scope], false)).toBe(true);
    expect(impl.isInScope(`${file}/a`, [scope])).toBe(false);
    expect(impl.isInScope(file, [scope])).toBe(false);
  });
  it('같은 서로게이트는 범위 안이다', () => {
    expect(impl.isInScope('web/\uD800/a', ['web/\uD800'])).toBe(true);
  });
});
