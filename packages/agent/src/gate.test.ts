import type { ExecResult } from '@b-studio/sandbox';
import type { LoadedProject, WorkflowSpec } from '@b-studio/spec';
import { beforeEach, describe, expect, it } from 'vitest';
import { VerificationGate, type PageFetcher } from './gate';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT } from './test-helpers';
import { Workspace } from './workspace';

let project: LoadedProject;

beforeEach(async () => {
  project = await createOrdersProject('gate-test-');
});

function withWorkflow(workflow: Partial<WorkflowSpec>): LoadedProject {
  return { ...project, spec: { ...project.spec, workflow } } as LoadedProject;
}

async function setup(
  target: LoadedProject,
  options: { restarts?: boolean[]; exec?: (command: string[]) => ExecResult; page?: PageFetcher } = {},
) {
  const sandbox = fakeSandbox(target, options.restarts ?? [true, true, true]);
  const commands: string[][] = [];
  sandbox.exec = async (_service, command) => {
    commands.push(command);
    return options.exec?.(command) ?? { exitCode: 0, stdout: '', stderr: '' };
  };
  const workspace = new Workspace(target.root);
  const events: AgentEvent[] = [];
  const gate = await VerificationGate.create({
    project: target,
    sandbox,
    workspace,
    allowBreaking: false,
    maxVerifyAttempts: 3,
    fetcher: async () => ORDERS_CONTRACT,
    pageFetcher: options.page ?? (async () => ({ status: 200, text: '<h1>주문 목록</h1>' })),
    onEvent: (event) => events.push(event),
  });
  return { gate, workspace, events, commands };
}

const stages = (events: AgentEvent[]) => events.flatMap((event) => (event.type === 'stage' ? [event.stage] : []));

describe('VerificationGate 워크플로 단계', () => {
  it('선언한 화면 확인·테스트·리뷰를 모두 실행하고 통과한 단계를 기록한다', async () => {
    const target = withWorkflow({
      tests: [{ name: 'unit', service: 'api', command: ['./gradlew', 'test'], maxAttempts: 1 }],
      pageChecks: [{ service: 'api', path: '/orders', expectStatus: 200, expectText: '주문 목록' }],
    });
    const { gate, workspace, events, commands } = await setup(target);
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(gate.verified).toBe(true);
    expect([...gate.passedStages].sort()).toEqual(['browser_check', 'contract_check', 'review', 'run', 'test']);
    expect(stages(events)).toEqual(['run', 'contract_check', 'browser_check', 'test', 'review']);
    expect(commands).toEqual([['./gradlew', 'test']]);
    expect(gate.checks.map((check) => `${check.stage}:${check.name}:${check.ok}`)).toEqual([
      'browser_check:api /orders:true',
      'test:unit:true',
      'review:protected-paths:true',
    ]);
  });

  it('실패한 테스트는 선언한 횟수만큼 다시 돌리고, 출력 끝부분을 모델에게 돌려준다', async () => {
    const target = withWorkflow({ tests: [{ name: 'unit', service: 'api', command: ['./gradlew', 'test'], maxAttempts: 2 }] });
    const { gate, workspace, commands } = await setup(target, {
      exec: () => ({ exitCode: 1, stdout: 'OrderTest > memo FAILED', stderr: 'expected memo' }),
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    const outcome = await gate.check();
    expect(outcome.kind).toBe('retry');
    expect(commands).toHaveLength(2);
    expect(gate.passedStages.has('test')).toBe(false);
    expect(gate.verified).toBe(false);
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('[test] unit (시도 2회)');
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('OrderTest > memo FAILED');
  });

  it('화면 응답에 기대 문구가 없으면 통과시키지 않는다', async () => {
    const target = withWorkflow({ pageChecks: [{ service: 'api', path: '/orders', expectStatus: 200, expectText: '주문 목록' }] });
    const { gate, workspace } = await setup(target, { page: async () => ({ status: 200, text: '<h1>Error</h1>' }) });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    const outcome = await gate.check();
    expect(outcome.kind === 'retry' && outcome.feedback).toContain("응답 본문에 '주문 목록'가 없습니다");
  });

  it('도구 게이트를 거치지 않고 바뀐 보호 경로도 리뷰 단계에서 막는다', async () => {
    const target = withWorkflow({ protectedPaths: ['api/src'] });
    const { gate, workspace } = await setup(target);
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    const outcome = await gate.check();
    expect(outcome.kind).toBe('retry');
    expect(gate.passedStages.has('review')).toBe(false);
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('보호 경로');
  });

  it('서비스가 뜨지 않으면 그 위에서 테스트를 돌리지 않는다', async () => {
    const target = withWorkflow({ tests: [{ name: 'unit', service: 'api', command: ['./gradlew', 'test'], maxAttempts: 1 }] });
    const { gate, workspace, commands } = await setup(target, { restarts: [false] });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect((await gate.check()).kind).toBe('retry');
    expect(commands).toEqual([]);
    expect(gate.passedStages.size).toBe(0);
  });

  it('바뀐 파일이 없으면 검증 없이 통과하되 체크포인트 대상으로 표시하지 않는다', async () => {
    const { gate, events } = await setup(withWorkflow({}));
    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(gate.verified).toBe(false);
    expect(stages(events)).toEqual([]);
  });

  it('필수 단계를 실행할 수단이 없으면 완료로 인정하지 않는다', async () => {
    // 스키마를 거치지 않은 설정. 게이트가 마지막에 한 번 더 막는지 확인한다
    const target = withWorkflow({ required: ['plan', 'implement', 'test', 'checkpoint'] });
    const { gate, workspace } = await setup(target);
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    const outcome = await gate.check();
    expect(outcome).toEqual({ kind: 'exhausted', summary: '워크플로 필수 단계가 실행되지 않아 완료로 인정하지 않습니다: test' });
    expect(gate.verified).toBe(false);
  });
});
