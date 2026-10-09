import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { ExecResult, Sandbox, ServiceUsage } from '@b-studio/sandbox';
import { SpecError, type LoadedProject, type WorkflowConcurrencyCheck, type WorkflowPageCheck, type WorkflowSpec } from '@b-studio/spec';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserUnavailableError, StepFailedError, type BrowserPageOptions, type BrowserPageResult, type BrowserRunner } from './browser-check';
import { autoPageCheck, nextErrorMarker, VerificationGate, type PageFetcher, type ServiceRequest } from './gate';
import type { AgentEvent } from './loop';
import { signatureFromCheck, signatureKey } from './coordination/signature';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT } from './test-helpers';
import type { WorkflowCheck } from './workflow';
import { Workspace } from './workspace';

/** 단색 배경에 원하는 색을 칠한 PNG 버퍼를 만든다 */
function image(width: number, height: number, paint: (x: number, y: number) => [number, number, number] = () => [255, 255, 255]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (width * y + x) << 2;
      const [r, g, b] = paint(x, y);
      png.data[index] = r;
      png.data[index + 1] = g;
      png.data[index + 2] = b;
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

let project: LoadedProject;

beforeEach(async () => {
  project = await createOrdersProject('gate-test-');
});

function withWorkflow(workflow: Partial<WorkflowSpec>): LoadedProject {
  return { ...project, spec: { ...project.spec, workflow } } as LoadedProject;
}

async function setup(
  target: LoadedProject,
  options: { restarts?: boolean[]; exec?: (command: string[]) => ExecResult; page?: PageFetcher; browser?: BrowserRunner; verify?: 'full' | 'light'; reload?: () => Promise<LoadedProject> } = {},
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
    ...(options.verify ? { verify: options.verify } : {}),
    ...(options.reload ? { reloadProject: options.reload } : {}),
    fetcher: async () => ORDERS_CONTRACT,
    pageFetcher: options.page ?? (async () => ({ status: 200, text: '<h1>주문 목록</h1>' })),
    ...(options.browser ? { browserRunner: options.browser } : {}),
    onEvent: (event) => events.push(event),
  });
  return { gate, workspace, events, commands };
}

const stages = (events: AgentEvent[]) => events.flatMap((event) => (event.type === 'stage' ? [event.stage] : []));

describe('VerificationGate 워크플로 단계', () => {
  it('선언한 화면 확인·테스트·리뷰를 모두 실행하고 통과한 단계를 기록한다', async () => {
    const target = withWorkflow({
      tests: [{ name: 'unit', service: 'api', command: ['./gradlew', 'test'], maxAttempts: 1 }],
      pageChecks: [{ service: 'api', path: '/orders', mode: 'http', expectStatus: 200, expectText: '주문 목록', allowConsoleErrors: false, noHorizontalScroll: false }],
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

  it('테스트 중 서비스가 메모리 한도를 넘어 종료되면 코드 문제로 보지 않고 되살린 뒤 다음 시도에서 통과한다(트러블슈팅 116)', async () => {
    const target = withWorkflow({ tests: [{ name: 'unit', service: 'api', command: ['./gradlew', 'test'], maxAttempts: 2 }] });
    const sandbox = fakeSandbox(target, [true]);
    let execCalls = 0;
    sandbox.exec = async () => {
      execCalls += 1;
      return execCalls === 1 ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' };
    };
    sandbox.stats = async (): Promise<ServiceUsage[]> =>
      execCalls === 1 ? [{ service: 'api', state: 'exited', oomKilled: true, memoryLimitBytes: 2 * 1024 ** 3, exitCode: 1 }] : [];
    const workspace = new Workspace(target.root);
    const gate = await VerificationGate.create({
      project: target,
      sandbox,
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      fetcher: async () => ORDERS_CONTRACT,
      pageFetcher: async () => ({ status: 200, text: '<h1>주문 목록</h1>' }),
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    const outcome = await gate.check();
    expect(outcome).toEqual({ kind: 'pass' });
    expect(execCalls).toBe(2);
    // 첫 번째는 바뀐 파일 때문에 게이트가 거치는 평소 재시작(run 단계), 두 번째가 OOM을 보고 되살린 것
    expect(sandbox.restarts).toEqual(['api', 'api']);
  });

  it('메모리 한도 초과가 재시도에서도 이어지면 환경 문제라고 알리고(코드 문제라고 말하지 않는다) 되살리려 한 사실을 남긴다', async () => {
    const target = withWorkflow({ tests: [{ name: 'unit', service: 'api', command: ['./gradlew', 'test'], maxAttempts: 2 }] });
    const sandbox = fakeSandbox(target, [true]);
    sandbox.exec = async () => ({ exitCode: 1, stdout: '', stderr: '' });
    sandbox.stats = async (): Promise<ServiceUsage[]> => [{ service: 'api', state: 'exited', oomKilled: true, memoryLimitBytes: 2 * 1024 ** 3, exitCode: 1 }];
    const workspace = new Workspace(target.root);
    const gate = await VerificationGate.create({
      project: target,
      sandbox,
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      fetcher: async () => ORDERS_CONTRACT,
      pageFetcher: async () => ({ status: 200, text: '<h1>주문 목록</h1>' }),
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    const outcome = await gate.check();
    expect(outcome.kind).toBe('retry');
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('환경 문제');
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('메모리 한도 (2.00GiB)를 넘어');
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('코드 문제가 아닐 수 있습니다');
    // 평소 재시작(run 단계) 1번 + 두 시도 각각의 OOM 복구 재시작 2번
    expect(sandbox.restarts).toEqual(['api', 'api', 'api']);
  });

  it('화면 응답에 기대 문구가 없으면 통과시키지 않는다', async () => {
    const target = withWorkflow({ pageChecks: [{ service: 'api', path: '/orders', mode: 'http', expectStatus: 200, expectText: '주문 목록', allowConsoleErrors: false, noHorizontalScroll: false }] });
    const { gate, workspace } = await setup(target, { page: async () => ({ status: 200, text: '<h1>Error</h1>' }) });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    const outcome = await gate.check();
    expect(outcome.kind === 'retry' && outcome.feedback).toContain("응답 본문에 '주문 목록'가 없습니다");
  });

  it('expectAllText는 모두 있어야 통과하고, 빠진 문구만 알린다', async () => {
    const target = withWorkflow({
      pageChecks: [{ service: 'api', path: '/orders', mode: 'http', expectStatus: 200, expectAllText: ['김민수', '이영희', '박철수'], allowConsoleErrors: false, noHorizontalScroll: false }],
    });

    const passing = await setup(target, { page: async () => ({ status: 200, text: '<td>김민수</td><td>이영희</td><td>박철수</td>' }) });
    await passing.workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    expect(await passing.gate.check()).toEqual({ kind: 'pass' });

    // E4 첫 묶음의 실패: 한 사람만 보이고 나머지가 없다. 값 하나만 보는 확인은 이것을 통과시켰다
    const failing = await setup(target, { page: async () => ({ status: 200, text: '<td>김민수</td><td>박도윤</td>' }) });
    await failing.workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    const outcome = await failing.gate.check();
    expect(outcome.kind === 'retry' && outcome.feedback).toContain("화면에 '이영희', '박철수'가 없습니다");
  });

  it('expectAnyText는 하나라도 있으면 통과하고, 어느 것도 없으면 문구를 알린다', async () => {
    const target = withWorkflow({
      pageChecks: [{ service: 'api', path: '/dashboard', mode: 'http', expectStatus: 200, expectAnyText: ['45000', '45,000'], allowConsoleErrors: false, noHorizontalScroll: false }],
    });

    const passing = await setup(target, { page: async () => ({ status: 200, text: '<p>총매출 45,000원</p>' }) });
    await passing.workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    expect(await passing.gate.check()).toEqual({ kind: 'pass' });

    const failing = await setup(target, { page: async () => ({ status: 200, text: '<p>총매출 없음</p>' }) });
    await failing.workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    const outcome = await failing.gate.check();
    expect(outcome.kind === 'retry' && outcome.feedback).toContain("화면에 '45000', '45,000' 중 어느 것도 없습니다");
  });

  it('browser 모드에서도 expectAnyText를 렌더링된 글자에 대해 확인한다', async () => {
    const target = withWorkflow({
      pageChecks: [{ service: 'api', path: '/dashboard', mode: 'browser', expectStatus: 200, expectAnyText: ['45000', '45,000'], allowConsoleErrors: false, noHorizontalScroll: false }],
    });
    const workspace = new Workspace(target.root);
    const gate = await VerificationGate.create({
      project: target,
      sandbox: fakeSandbox(target, [true]),
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      fetcher: async () => ORDERS_CONTRACT,
      browserRunner: async () => ({
        status: 200,
        text: '총매출 45,000원',
        pageErrors: [],
        consoleErrors: [],
        failedRequests: [],
        mediaErrors: [], blockedRequests: [],
        horizontalOverflowPx: 0,
        steps: [],
      }),
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
  });

  it('browser 모드는 렌더링 결과의 문구·스크립트 예외·console.error·가로 넘침을 모두 실패 사유로 돌려준다', async () => {
    const target = withWorkflow({
      pageChecks: [
        { service: 'api', path: '/orders', mode: 'browser', expectStatus: 200, expectText: '주문 목록', viewport: { width: 390, height: 844 }, allowConsoleErrors: false, noHorizontalScroll: true },
      ],
    });
    const sandbox = fakeSandbox(target, [true]);
    const workspace = new Workspace(target.root);
    const seen: Array<{ url: string; viewport?: { width: number; height: number } }> = [];
    const gate = await VerificationGate.create({
      project: target,
      sandbox,
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      fetcher: async () => ORDERS_CONTRACT,
      pageFetcher: async () => {
        throw new Error('browser 모드에서 HTTP 확인을 쓰면 안 된다');
      },
      browserRunner: async (url, options) => {
        seen.push({ url, viewport: options.viewport });
        return {
          status: 200,
          text: '로딩',
          pageErrors: ['window.missing is undefined'],
          consoleErrors: ['hydration failed'],
          failedRequests: ['404 http://127.0.0.1:1/_next/static/chunk.js'],
          mediaErrors: ['video MEDIA_ERR_SRC_NOT_SUPPORTED http://127.0.0.1:1/media/master.m3u8'],
          blockedRequests: [],
          horizontalOverflowPx: 510,
          steps: [],
        };
      },
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    const outcome = await gate.check();
    expect(seen).toEqual([{ url: 'http://127.0.0.1:1/orders', viewport: { width: 390, height: 844 } }]);
    expect(outcome.kind).toBe('retry');
    const feedback = outcome.kind === 'retry' ? outcome.feedback : '';
    expect(feedback).toContain('[browser_check] api /orders (browser 390x844)');
    for (const reason of [
      "렌더링된 화면에 '주문 목록'가 없습니다",
      '스크립트 예외: window.missing is undefined',
      'console.error: hydration failed',
      '실패한 요청: 404 http://127.0.0.1:1/_next/static/chunk.js',
      '미디어 오류: video MEDIA_ERR_SRC_NOT_SUPPORTED http://127.0.0.1:1/media/master.m3u8',
      '가로로 510px 넘칩니다',
    ]) {
      expect(feedback).toContain(reason);
    }
    expect(gate.passedStages.has('browser_check')).toBe(false);
  });

  it('allowConsoleErrors를 켜면 미디어 오류가 있어도 실패시키지 않는다', async () => {
    const target = withWorkflow({
      pageChecks: [{ service: 'api', path: '/shorts', mode: 'browser', expectStatus: 200, expectText: '숏폼', allowConsoleErrors: true, noHorizontalScroll: false }],
    });
    const workspace = new Workspace(target.root);
    const gate = await VerificationGate.create({
      project: target,
      sandbox: fakeSandbox(target, [true]),
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      fetcher: async () => ORDERS_CONTRACT,
      browserRunner: async () => ({
        status: 200,
        text: '숏폼',
        pageErrors: [],
        consoleErrors: [],
        failedRequests: ['404 http://127.0.0.1:1/api/v1/shorts/1/media/master.m3u8'],
        mediaErrors: ['video MEDIA_ERR_SRC_NOT_SUPPORTED http://127.0.0.1:1/api/v1/shorts/1/media/master.m3u8'],
        blockedRequests: [],
        horizontalOverflowPx: 0,
        steps: [],
      }),
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
  });

  it('browser 모드는 steps를 러너에 그대로 넘기고 검사 이름에 단계 수를 넣는다', async () => {
    const target = withWorkflow({
      pageChecks: [
        {
          service: 'api',
          path: '/orders',
          mode: 'browser',
          expectStatus: 200,
          viewport: { width: 390, height: 844 },
          steps: [{ click: '#go' }, { fill: { selector: '#q', text: '김토스' } }],
          allowConsoleErrors: false,
          noHorizontalScroll: false,
        },
      ],
    });
    const sandbox = fakeSandbox(target, [true]);
    const workspace = new Workspace(target.root);
    const seen: Array<BrowserPageOptions['steps']> = [];
    const gate = await VerificationGate.create({
      project: target,
      sandbox,
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      fetcher: async () => ORDERS_CONTRACT,
      browserRunner: async (_url, options) => {
        seen.push(options.steps);
        return { status: 200, text: '주문 목록', pageErrors: [], consoleErrors: [], failedRequests: [], mediaErrors: [], blockedRequests: [], horizontalOverflowPx: 0, steps: [] };
      },
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(seen).toEqual([[{ click: '#go' }, { fill: { selector: '#q', text: '김토스' } }]]);
    expect(gate.checks.filter((check) => check.stage === 'browser_check').map((check) => check.name)).toEqual(['api /orders (browser 390x844, 단계 2개)']);
  });

  it('브라우저를 띄울 수 없으면 화면 확인을 통과시키지 않는다', async () => {
    const target = withWorkflow({
      pageChecks: [{ service: 'api', path: '/', mode: 'browser', expectStatus: 200, allowConsoleErrors: false, noHorizontalScroll: false }],
    });
    const { gate, workspace } = await setup(target);
    // setup은 기본 러너를 쓰지 않도록 browserRunner를 넘기지 않으므로, 여기서만 실패하는 러너로 바꾼다
    Object.assign(gate, {});
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    const failing = await VerificationGate.create({
      project: target,
      sandbox: fakeSandbox(target, [true]),
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      fetcher: async () => ORDERS_CONTRACT,
      browserRunner: async () => {
        throw new Error('헤드리스 브라우저를 실행할 수 없습니다: executable not found');
      },
      onEvent: () => {},
    });
    const outcome = await failing.check();
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('헤드리스 브라우저를 실행할 수 없습니다');
    expect(failing.passedStages.has('browser_check')).toBe(false);
  });

  it('fallbackProbe가 있으면 헤드리스 브라우저를 못 띄워도 그 자리로 HTTP 확인을 대신하고, 응답을 받으면 통과시킨다(fix/frontend-backend-url)', async () => {
    const target = withWorkflow({
      pageChecks: [
        {
          service: 'api',
          path: '/',
          mode: 'browser',
          expectStatus: 200,
          allowConsoleErrors: false,
          noHorizontalScroll: false,
          fallbackProbe: { service: 'api', path: '/actuator/health' },
        },
      ],
    });
    const probed: string[] = [];
    const { gate, workspace } = await setup(target, {
      browser: async () => {
        throw new BrowserUnavailableError('executable not found');
      },
      page: async (url) => {
        probed.push(url);
        return { status: 503, text: '' };
      },
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(probed).toEqual(['http://127.0.0.1:1/actuator/health']);
    const check = gate.checks.find((entry) => entry.stage === 'browser_check')!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('헤드리스 브라우저를 쓸 수 없어');
    expect(check.detail).toContain('응답 503');
  });

  it('fallbackProbe도 연결하지 못하면(연결 거부 등) 화면 확인을 실패시킨다(fix/frontend-backend-url)', async () => {
    const target = withWorkflow({
      pageChecks: [{ service: 'api', path: '/', mode: 'browser', expectStatus: 200, allowConsoleErrors: false, noHorizontalScroll: false, fallbackProbe: { service: 'api', path: '/actuator/health' } }],
    });
    const { gate, workspace } = await setup(target, {
      browser: async () => {
        throw new BrowserUnavailableError('executable not found');
      },
      page: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1');
      },
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    const outcome = await gate.check();
    expect(outcome.kind).toBe('retry');
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('연결하지 못했습니다');
    expect(gate.passedStages.has('browser_check')).toBe(false);
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

  it('승격이 준 재시도 예산만큼 게이트를 더 돌리고, 다 쓰면 exhausted가 된다', async () => {
    const target = withWorkflow({});
    // 재시작이 계속 실패해 게이트가 매번 실패한다(기본 상한 3)
    const { gate, workspace } = await setup(target, { restarts: Array.from({ length: 10 }, () => false) });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toMatchObject({ kind: 'retry' });
    expect(await gate.check()).toMatchObject({ kind: 'retry' });
    expect(await gate.check()).toMatchObject({ kind: 'exhausted' });
    expect(gate.attempts).toBe(3);

    // 승격이 예산 2를 주면 "지금까지 3 + 2"까지 다시 시도할 수 있다(남은 횟수에 더하는 게 아니다)
    expect(gate.grantRetryBudget(2)).toBe(true);
    expect(await gate.check()).toMatchObject({ kind: 'retry' });
    expect(await gate.check()).toMatchObject({ kind: 'exhausted' });
    expect(gate.attempts).toBe(5);
  });

  it('예산이 0이거나 이미 남아 있으면 상한을 늘리지 않는다', async () => {
    const target = withWorkflow({});
    const { gate, workspace } = await setup(target, { restarts: Array.from({ length: 10 }, () => false) });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toMatchObject({ kind: 'retry' });
    // 예산 0은 상한을 늘리지 않는다. 다만 아직 남은 횟수가 있으면 다음 시도는 가능하다고 알린다
    expect(gate.grantRetryBudget(0)).toBe(true);
    expect(await gate.check()).toMatchObject({ kind: 'retry' });
    expect(await gate.check()).toMatchObject({ kind: 'exhausted' });
    // 상한을 다 쓴 뒤 예산 0이면 다음 시도가 불가능하다
    expect(gate.grantRetryBudget(0)).toBe(false);
    expect(await gate.check()).toMatchObject({ kind: 'exhausted' });
  });

  it('화면 확인 단계 스크린샷을 저장해 steps[].artifact로 남기고 프레임을 전달한다', async () => {
    const target = withWorkflow({
      pageChecks: [{ service: 'api', path: '/orders', mode: 'browser', expectStatus: 200, expectText: '주문 목록', viewport: { width: 390, height: 844 }, allowConsoleErrors: false, noHorizontalScroll: false }],
    });
    const workspace = new Workspace(target.root);
    const saved: Array<{ name: string; contentType: string }> = [];
    const frames: Array<{ check: string; frame: unknown }> = [];
    const gate = await VerificationGate.create({
      project: target,
      sandbox: fakeSandbox(target, [true]),
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      fetcher: async () => ORDERS_CONTRACT,
      browserRunner: async (_url, options) => {
        // 저장할 곳이 있으면 게이트가 capture를 켠다
        expect(options.capture).toBe(true);
        options.onFrame?.({ data: Buffer.from([9]), width: 390, height: 844, at: 7 });
        return {
          status: 200,
          text: '주문 목록',
          pageErrors: [],
          consoleErrors: [],
          failedRequests: [],
          mediaErrors: [], blockedRequests: [],
          horizontalOverflowPx: 0,
          steps: [
            { label: 'open /orders', ok: true, screenshot: Buffer.from([1]) },
            { label: 'click #go', ok: true, screenshot: Buffer.from([2]) },
          ],
        };
      },
      saveArtifact: async ({ name, contentType }) => {
        saved.push({ name, contentType });
        return `artifact-${saved.length}`;
      },
      onBrowserFrame: ({ check, frame }) => frames.push({ check, frame }),
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(gate.checks.find((entry) => entry.stage === 'browser_check')?.steps).toEqual([
      { label: 'open /orders', ok: true, artifact: 'artifact-1' },
      { label: 'click #go', ok: true, artifact: 'artifact-2' },
    ]);
    expect(saved.map((entry) => entry.contentType)).toEqual(['image/png', 'image/png']);
    expect(frames).toEqual([{ check: 'api /orders (browser 390x844)', frame: { data: Buffer.from([9]), width: 390, height: 844, at: 7 } }]);
  });

  it('스크린샷 저장이 실패해도 화면 확인 결과는 바뀌지 않는다', async () => {
    const target = withWorkflow({
      pageChecks: [{ service: 'api', path: '/orders', mode: 'browser', expectStatus: 200, expectText: '주문 목록', allowConsoleErrors: false, noHorizontalScroll: false }],
    });
    const workspace = new Workspace(target.root);
    const gate = await VerificationGate.create({
      project: target,
      sandbox: fakeSandbox(target, [true]),
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      fetcher: async () => ORDERS_CONTRACT,
      browserRunner: async () => ({
        status: 200,
        text: '주문 목록',
        pageErrors: [],
        consoleErrors: [],
        failedRequests: [],
        mediaErrors: [], blockedRequests: [],
        horizontalOverflowPx: 0,
        steps: [
          { label: 'open /orders', ok: true, screenshot: Buffer.from([1]) },
          { label: 'click #go', ok: true, screenshot: Buffer.from([2]) },
        ],
      }),
      saveArtifact: async () => {
        throw new Error('디스크가 꽉 찼습니다');
      },
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    const check = gate.checks.find((entry) => entry.stage === 'browser_check');
    expect(check?.ok).toBe(true);
    expect(check?.steps?.map((step) => step.label)).toEqual(['open /orders', 'click #go']);
    expect(check?.steps?.every((step) => step.artifact === undefined)).toBe(true);
  });

  it('실패한 단계의 스크린샷도 저장해 실패 결과에 남긴다', async () => {
    const target = withWorkflow({
      pageChecks: [{ service: 'api', path: '/orders', mode: 'browser', expectStatus: 200, allowConsoleErrors: false, noHorizontalScroll: false }],
    });
    const workspace = new Workspace(target.root);
    const saved: string[] = [];
    const gate = await VerificationGate.create({
      project: target,
      sandbox: fakeSandbox(target, [true]),
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      fetcher: async () => ORDERS_CONTRACT,
      browserRunner: async () => {
        throw new StepFailedError('2번째 단계 실패 (click #missing): timeout', [
          { label: 'open /orders', ok: true, screenshot: Buffer.from([1]) },
          { label: 'click #missing', ok: false, detail: 'timeout', screenshot: Buffer.from([2]) },
        ]);
      },
      saveArtifact: async () => `artifact-${saved.push('saved')}`,
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    const outcome = await gate.check();
    expect(outcome.kind).toBe('retry');
    const check = gate.checks.find((entry) => entry.stage === 'browser_check');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('2번째 단계 실패');
    expect(check?.steps).toEqual([
      { label: 'open /orders', ok: true, artifact: 'artifact-1' },
      { label: 'click #missing', ok: false, detail: 'timeout', artifact: 'artifact-2' },
    ]);
  });
});

describe('VerificationGate 디자인 비교', () => {
  const compare = (overrides: Partial<NonNullable<WorkflowPageCheck['compare']>> = {}): NonNullable<WorkflowPageCheck['compare']> => ({
    reference: 'design.png',
    maxDiffRatio: 0.02,
    threshold: 0.1,
    ...overrides,
  });
  const comparePage = (value: NonNullable<WorkflowPageCheck['compare']>): WorkflowPageCheck => ({
    service: 'api',
    path: '/orders',
    mode: 'browser',
    expectStatus: 200,
    allowConsoleErrors: false,
    noHorizontalScroll: false,
    compare: value,
  });
  const browserResult = (actual: Buffer) => ({
    status: 200,
    text: '주문 목록',
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
    mediaErrors: [], blockedRequests: [],
    horizontalOverflowPx: 0,
    steps: [{ label: 'open /orders', ok: true, screenshot: actual }],
  });

  async function compareGate(target: LoadedProject, actual: Buffer, saved: string[] = []) {
    const workspace = new Workspace(target.root);
    const gate = await VerificationGate.create({
      project: target,
      sandbox: fakeSandbox(target, [true]),
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      fetcher: async () => ORDERS_CONTRACT,
      browserRunner: async () => browserResult(actual),
      saveArtifact: async ({ name }) => `a${saved.push(name)}`,
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    return gate;
  }

  it('기준 이미지와 같으면 통과하고 비교 이미지 세 장을 저장한다', async () => {
    const target = withWorkflow({ pageChecks: [comparePage(compare({ reference: 'design/list.png' }))] });
    const shot = image(60, 40);
    await mkdir(path.join(target.root, 'design'), { recursive: true });
    await writeFile(path.join(target.root, 'design/list.png'), shot);
    const saved: string[] = [];
    const gate = await compareGate(target, shot, saved);

    expect(await gate.check()).toEqual({ kind: 'pass' });
    const check = gate.checks.find((entry) => entry.stage === 'browser_check');
    expect(check?.ok).toBe(true);
    // 단계 스크린샷(a1)에 이어 기준·실제·차이 이미지를 저장한다
    expect(check?.compare).toEqual({ ratio: 0, max: 0.02, reference: 'a2', actual: 'a3', diff: 'a4' });
    expect(saved).toEqual([
      'api /orders (browser) 1. open /orders',
      'api /orders (browser) 디자인 이미지',
      'api /orders (browser) 실제 이미지',
      'api /orders (browser) 차이 이미지',
    ]);
  });

  it('허용 비율을 넘으면 실패로 알리고 비교 결과를 남긴다', async () => {
    const target = withWorkflow({ pageChecks: [comparePage(compare())] });
    await writeFile(path.join(target.root, 'design.png'), image(100, 100));
    // 20×20만 다른 색이라 4%가 다르다
    const gate = await compareGate(target, image(100, 100, (x, y) => (x < 20 && y < 20 ? [0, 0, 0] : [255, 255, 255])));

    const outcome = await gate.check();
    expect(outcome.kind).toBe('retry');
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('디자인 차이 4.0% (허용 2.0%, 비교 100×100)');
    const check = gate.checks.find((entry) => entry.stage === 'browser_check');
    expect(check?.ok).toBe(false);
    expect(check?.compare?.ratio).toBeCloseTo(0.04, 4);
    expect(check?.compare?.max).toBe(0.02);
    expect(gate.passedStages.has('browser_check')).toBe(false);
  });

  it('기준 이미지가 없으면 건너뛰지 않고 실패로 알린다', async () => {
    const target = withWorkflow({ pageChecks: [comparePage(compare({ reference: 'missing.png' }))] });
    const gate = await compareGate(target, image(100, 100));

    const outcome = await gate.check();
    expect(outcome.kind).toBe('retry');
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('디자인 기준 이미지를 읽지 못했습니다: missing.png');
    expect(gate.checks.find((entry) => entry.stage === 'browser_check')?.compare).toBeUndefined();
  });

  it('기준 이미지와 너비가 다르면 자동 조정 없이 실패로 알린다', async () => {
    const target = withWorkflow({ pageChecks: [comparePage(compare())] });
    await writeFile(path.join(target.root, 'design.png'), image(100, 100));
    const gate = await compareGate(target, image(120, 100));

    const outcome = await gate.check();
    expect(outcome.kind).toBe('retry');
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('이미지 너비가 다릅니다 (실제 120px, 디자인 100px)');
    expect(gate.checks.find((entry) => entry.stage === 'browser_check')?.compare).toBeUndefined();
  });
});

describe('VerificationGate 출처 제한', () => {
  const browserPage = (extra: Partial<WorkflowPageCheck> = {}): WorkflowPageCheck => ({
    service: 'api',
    path: '/orders',
    mode: 'browser',
    expectStatus: 200,
    allowConsoleErrors: false,
    noHorizontalScroll: false,
    ...extra,
  });

  async function originGate(target: LoadedProject, result: BrowserPageResult) {
    const workspace = new Workspace(target.root);
    const gate = await VerificationGate.create({
      project: target,
      sandbox: fakeSandbox(target, [true]),
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 2,
      fetcher: async () => ORDERS_CONTRACT,
      browserRunner: async () => result,
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    return gate;
  }

  it('화면 확인에 세션 서비스 출처를 넘기고, 막은 요청을 detail에 남긴다', async () => {
    const target = withWorkflow({ pageChecks: [browserPage()] });
    const workspace = new Workspace(target.root);
    let origins: string[] | undefined;
    const gate = await VerificationGate.create({
      project: target,
      sandbox: fakeSandbox(target, [true]),
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 2,
      fetcher: async () => ORDERS_CONTRACT,
      browserRunner: async (_url, options) => {
        origins = options.allowedOrigins;
        return { status: 200, text: '주문 목록', pageErrors: [], consoleErrors: [], failedRequests: [], mediaErrors: [], blockedRequests: ['http://evil.example/x'], horizontalOverflowPx: 0, steps: [] };
      },
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    // fakeSandbox는 서비스마다 http://127.0.0.1:1을 돌려준다
    expect(origins).toEqual(['http://127.0.0.1:1']);
    const check = gate.checks.find((entry) => entry.stage === 'browser_check');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toBe('다른 출처 요청 1건을 막았습니다');
  });

  it('실패 사유에 막은 요청 수를 덧붙인다', async () => {
    const target = withWorkflow({ pageChecks: [browserPage({ expectText: '없는 문구' })] });
    const gate = await originGate(target, {
      status: 200,
      text: '주문 목록',
      pageErrors: [],
      consoleErrors: [],
      failedRequests: [],
      mediaErrors: [], blockedRequests: ['http://evil.example/a', 'http://evil.example/b'],
      horizontalOverflowPx: 0,
      steps: [],
    });

    const outcome = await gate.check();
    expect(outcome.kind).toBe('retry');
    expect(outcome.kind === 'retry' && outcome.feedback).toContain("렌더링된 화면에 '없는 문구'가 없습니다");
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('다른 출처 요청 2건을 막았습니다');
    const check = gate.checks.find((entry) => entry.stage === 'browser_check');
    expect(check?.detail).toContain("렌더링된 화면에 '없는 문구'가 없습니다");
    expect(check?.detail).toContain('다른 출처 요청 2건을 막았습니다');
  });
});

describe('VerificationGate 동시 요청 확인', () => {
  const check = (over: Partial<WorkflowConcurrencyCheck> = {}): WorkflowConcurrencyCheck => ({
    name: 'stock',
    service: 'api',
    method: 'POST',
    path: '/api/products/1/orders',
    concurrent: 10,
    expect: { successCount: { exactly: 1 }, then: { method: 'GET', path: '/api/products/1', jsonPath: '$.stock', equals: 0 } },
    ...over,
  });

  async function concurrencyGate(target: LoadedProject, requestService: ServiceRequest) {
    const workspace = new Workspace(target.root);
    const gate = await VerificationGate.create({
      project: target,
      sandbox: fakeSandbox(target, [true]),
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      fetcher: async () => ORDERS_CONTRACT,
      requestService,
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    return gate;
  }

  it('선언한 동시 요청을 한 번에 보내고, 성공 건수·상태 분포·then 값을 남긴다', async () => {
    const target = withWorkflow({ concurrencyChecks: [check()] });
    const calls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let posts = 0;
    const gate = await concurrencyGate(target, async (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (init.method === 'POST') {
        posts += 1;
        return { status: posts === 1 ? 201 : 409, text: '' };
      }
      return { status: 200, text: JSON.stringify({ stock: 0 }) };
    });

    expect(await gate.check()).toEqual({ kind: 'pass' });
    // 10개를 실제로 동시에 보냈다
    expect(maxInFlight).toBe(10);
    expect(calls.filter((call) => call === 'POST /api/products/1/orders')).toHaveLength(10);
    expect(calls).toContain('GET /api/products/1');
    const result = gate.checks.find((entry) => entry.stage === 'concurrency_check');
    expect(result?.ok).toBe(true);
    expect(result?.detail).toContain('성공 1/10 (기대: 정확히 1)');
    expect(result?.detail).toContain('상태 201:1, 409:9');
    expect(result?.detail).toContain('$.stock = 0');
    expect(gate.passedStages.has('concurrency_check')).toBe(true);
  });

  it('성공 건수나 then 값이 기대와 다르면 실패로 알린다', async () => {
    const target = withWorkflow({ concurrencyChecks: [check()] });
    let posts = 0;
    const gate = await concurrencyGate(target, async (_url, init) => {
      if (init.method === 'POST') {
        posts += 1;
        return { status: posts <= 3 ? 201 : 409, text: '' };
      }
      return { status: 200, text: JSON.stringify({ stock: 1 }) };
    });

    const outcome = await gate.check();
    expect(outcome.kind).toBe('retry');
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('성공 3/10 (기대: 정확히 1)');
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('$.stock 값이 1 (기대: 0)');
    expect(gate.passedStages.has('concurrency_check')).toBe(false);
  });

  it('세션 서비스 출처 밖 경로는 요청하지 않고 거부한다', async () => {
    const target = withWorkflow({ concurrencyChecks: [check({ path: '//evil.example/x' })] });
    let called = 0;
    const gate = await concurrencyGate(target, async () => {
      called += 1;
      return { status: 200, text: '{}' };
    });

    const outcome = await gate.check();
    expect(called).toBe(0);
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('path must stay on the service host');
  });

  it('요청이 타임아웃으로 실패하면 그대로 게이트 실패로 알린다', async () => {
    const target = withWorkflow({ concurrencyChecks: [check({ expect: { allStatusIn: [200, 201, 409] } })] });
    const gate = await concurrencyGate(target, async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    const outcome = await gate.check();
    expect(outcome.kind).toBe('retry');
    expect(outcome.kind === 'retry' && outcome.feedback).toMatch(/timeout/i);
    expect(gate.passedStages.has('concurrency_check')).toBe(false);
  });
});

describe('VerificationGate 로드 시간 예산', () => {
  const browserPage = (extra: Partial<WorkflowPageCheck> = {}): WorkflowPageCheck => ({
    service: 'api',
    path: '/orders',
    mode: 'browser',
    expectStatus: 200,
    allowConsoleErrors: false,
    noHorizontalScroll: false,
    ...extra,
  });

  async function loadGate(target: LoadedProject, result: Partial<BrowserPageResult>) {
    const workspace = new Workspace(target.root);
    let measure: boolean | undefined;
    const gate = await VerificationGate.create({
      project: target,
      sandbox: fakeSandbox(target, [true]),
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      fetcher: async () => ORDERS_CONTRACT,
      browserRunner: async (_url, options) => {
        measure = options.measureLoad;
        return { status: 200, text: '주문 목록', pageErrors: [], consoleErrors: [], failedRequests: [], mediaErrors: [], blockedRequests: [], horizontalOverflowPx: 0, steps: [], ...result };
      },
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    return { gate, measure: () => measure };
  }

  it('예산을 넘으면 실패로 알리고, 잰 값을 metrics에 남긴다', async () => {
    const over = await loadGate(withWorkflow({ pageChecks: [browserPage({ maxLoadMs: 2000 })] }), { loadMs: 2340 });
    const outcome = await over.gate.check();
    // 게이트는 로드 시간을 재도록 러너에 요청한다
    expect(over.measure()).toBe(true);
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('로드 2,340ms (예산 2,000ms)');
    expect(over.gate.passedStages.has('browser_check')).toBe(false);

    const noBudget = await loadGate(withWorkflow({ pageChecks: [browserPage()] }), { loadMs: 1500 });
    expect(await noBudget.gate.check()).toEqual({ kind: 'pass' });
    expect(noBudget.gate.checks.find((entry) => entry.stage === 'browser_check')?.metrics).toEqual({ loadMs: 1500 });
  });

  it('예산 안이면 통과하고 metrics.loadMs를 남긴다', async () => {
    const { gate } = await loadGate(withWorkflow({ pageChecks: [browserPage({ maxLoadMs: 3000 })] }), { loadMs: 2340 });
    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(gate.checks.find((entry) => entry.stage === 'browser_check')?.metrics).toEqual({ loadMs: 2340 });
  });

  it('예산을 적었는데 재지 못하면 통과로 보지 않는다', async () => {
    const { gate } = await loadGate(withWorkflow({ pageChecks: [browserPage({ maxLoadMs: 2000 })] }), {});
    const outcome = await gate.check();
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('로드 시간을 재지 못했습니다 (예산 2,000ms)');
  });
});

describe('VerificationGate api 값 확인', () => {
  const pageCheck = (extra: Partial<WorkflowPageCheck> = {}): WorkflowPageCheck => ({
    service: 'api',
    path: '/orders',
    mode: 'http',
    expectStatus: 200,
    allowConsoleErrors: false,
    noHorizontalScroll: false,
    expectFromApi: { service: 'api', path: '/api/orders', jsonPath: '$[0].customerName' },
    ...extra,
  });

  /** api 경로는 JSON을, 페이지 경로는 HTML을 돌려주는 fetcher. fakeSandbox의 서비스 주소는 http://127.0.0.1:1이다 */
  function routingFetcher(routes: Record<string, { status: number; text: string }>): PageFetcher {
    return async (url) => {
      const route = routes[new URL(url).pathname];
      if (!route) throw new Error(`예상하지 못한 요청: ${url}`);
      return route;
    };
  }

  async function apiGate(target: LoadedProject, pageFetcher: PageFetcher, browserResult?: BrowserPageResult) {
    const workspace = new Workspace(target.root);
    const gate = await VerificationGate.create({
      project: target,
      sandbox: fakeSandbox(target, [true]),
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      fetcher: async () => ORDERS_CONTRACT,
      pageFetcher,
      ...(browserResult ? { browserRunner: async () => browserResult } : {}),
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    return gate;
  }

  const failFeedback = (outcome: Awaited<ReturnType<VerificationGate['check']>>) => (outcome.kind === 'retry' ? outcome.feedback : '');

  it('api에서 꺼낸 값이 화면 글자에 있으면 통과한다', async () => {
    const target = withWorkflow({ pageChecks: [pageCheck()] });
    const gate = await apiGate(
      target,
      routingFetcher({
        '/api/orders': { status: 200, text: JSON.stringify([{ customerName: '홍길동' }]) },
        '/orders': { status: 200, text: '<table><tr><td>홍길동</td></tr></table>' },
      }),
    );

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(gate.checks.find((entry) => entry.stage === 'browser_check')?.ok).toBe(true);
  });

  it('화면이 다른 필드 이름을 읽으면 값이 없음을 구체적으로 알린다', async () => {
    const target = withWorkflow({ pageChecks: [pageCheck()] });
    const gate = await apiGate(
      target,
      routingFetcher({
        '/api/orders': { status: 200, text: JSON.stringify([{ customerName: '홍길동' }]) },
        '/orders': { status: 200, text: '<td>이름 없음</td>' },
      }),
    );

    const outcome = await gate.check();
    expect(failFeedback(outcome)).toContain("api의 $[0].customerName 값 '홍길동'이 /orders 화면에 없습니다 — 화면이 다른 필드 이름을 읽고 있을 수 있습니다");
    expect(gate.passedStages.has('browser_check')).toBe(false);
  });

  it('api 상태가 2xx가 아니면 상태 코드를 알리고 화면을 열지 않는다', async () => {
    const target = withWorkflow({ pageChecks: [pageCheck()] });
    // 페이지 경로를 주지 않아, api가 실패하면 페이지를 부르지 않는 것까지 확인한다
    const gate = await apiGate(target, routingFetcher({ '/api/orders': { status: 500, text: 'boom' } }));

    const outcome = await gate.check();
    expect(failFeedback(outcome)).toContain('api GET /api/orders가 HTTP 500을 돌려줬습니다');
  });

  it('api 응답에 값이 없으면 응답 앞부분과 함께 알린다', async () => {
    const target = withWorkflow({ pageChecks: [pageCheck()] });
    const body = JSON.stringify({ items: [] });
    const gate = await apiGate(target, routingFetcher({ '/api/orders': { status: 200, text: body } }));

    const outcome = await gate.check();
    expect(failFeedback(outcome)).toContain('api 응답에 $[0].customerName이 없습니다. 응답 앞부분: ');
    expect(failFeedback(outcome)).toContain(body);
  });

  it('가리킨 값이 배열·객체·빈 문자열이면 확인 설정 오류로 알린다', async () => {
    const withValue = async (value: unknown, jsonPath: string) => {
      const target = withWorkflow({ pageChecks: [pageCheck({ expectFromApi: { service: 'api', path: '/api/orders', jsonPath } })] });
      const gate = await apiGate(target, routingFetcher({ '/api/orders': { status: 200, text: JSON.stringify(value) } }));
      return failFeedback(await gate.check());
    };

    expect(await withValue({ statusCounts: [1, 2] }, '$.statusCounts')).toContain('$.statusCounts는 배열입니다. 화면에 그려질 문자열·숫자 값을 가리키세요');
    expect(await withValue({ shippingNote: { text: 'x' } }, '$.shippingNote')).toContain('$.shippingNote는 객체입니다. 화면에 그려질 문자열·숫자 값을 가리키세요');
    expect(await withValue({ customerName: '   ' }, '$.customerName')).toContain('$.customerName 값이 빈 문자열입니다. 화면에 그려질 문자열·숫자 값을 가리키세요');
  });

  it('숫자 값은 원문과 천 단위 구분으로 그린 화면을 둘 다 인정한다', async () => {
    const target = withWorkflow({ pageChecks: [pageCheck({ expectFromApi: { service: 'api', path: '/api/orders/summary', jsonPath: '$.totalRevenue' } })] });
    const gate = await apiGate(
      target,
      routingFetcher({
        '/api/orders/summary': { status: 200, text: JSON.stringify({ totalRevenue: 45000 }) },
        '/orders': { status: 200, text: '<p>총매출 45,000원</p>' },
      }),
    );

    expect(await gate.check()).toEqual({ kind: 'pass' });
  });

  it('browser 모드에서도 렌더링된 글자에 같은 확인을 한다', async () => {
    const target = withWorkflow({ pageChecks: [pageCheck({ mode: 'browser' })] });
    const rendered = { status: 200, text: '주문 목록\n홍길동', pageErrors: [], consoleErrors: [], failedRequests: [], mediaErrors: [], blockedRequests: [], horizontalOverflowPx: 0, steps: [] };
    const passing = await apiGate(target, routingFetcher({ '/api/orders': { status: 200, text: JSON.stringify([{ customerName: '홍길동' }]) } }), rendered);
    expect(await passing.check()).toEqual({ kind: 'pass' });

    const failing = await apiGate(target, routingFetcher({ '/api/orders': { status: 200, text: JSON.stringify([{ customerName: '홍길동' }]) } }), { ...rendered, text: '주문 목록' });
    expect(failFeedback(await failing.check())).toContain("api의 $[0].customerName 값 '홍길동'이 /orders 화면에 없습니다");
  });
});

describe('자동 페이지 확인: 실행 중 바뀐 sample 값 (ADR-159)', () => {
  function nextjs(target: LoadedProject, workflow: Partial<WorkflowSpec>): LoadedProject {
    return {
      ...target,
      spec: { ...target.spec, workflow },
      managed: [...target.managed, ['web', { source: 'managed', template: 'nextjs', path: 'web', port: 3000, preview: 'browser' }]],
    } as unknown as LoadedProject;
  }
  function auto(over: Partial<NonNullable<WorkflowSpec['autoPageChecks']>> = {}): NonNullable<WorkflowSpec['autoPageChecks']> {
    return { service: 'web', mode: 'http', expectStatus: 200, maxPages: 5, ...over };
  }
  /** 실행 중 에이전트가 studio.yaml을 고친 상태. 다시 읽으면 시작 때의 설정 위에 workflow 일부가 바뀌어 있다 */
  function edited(target: LoadedProject, workflow: Partial<WorkflowSpec>): () => Promise<LoadedProject> {
    return async () => ({ ...target, spec: { ...target.spec, workflow: { ...target.spec.workflow, ...workflow } } }) as LoadedProject;
  }
  const page = 'export default function Page() { return null; }\n';
  /** id 1만 데이터가 없는 앱: /orders/1은 404, 나머지는 통과 */
  const ordersApp =
    (requested: string[]): PageFetcher =>
    async (url) => {
      requested.push(url);
      return url.endsWith('/orders/1') ? { status: 404, text: 'Not Found' } : { status: 200, text: '주문 상세' };
    };

  it('실행 중 sampleParams가 들어오면 다음 검증은 추정한 id 대신 그 값으로 열어 통과한다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const requested: string[] = [];
    let current = target;
    const { gate, workspace } = await setup(target, { page: ordersApp(requested), reload: async () => current });
    await workspace.write('web/app/orders/[id]/page.tsx', page);

    expect((await gate.check()).kind).toBe('retry');
    expect(requested.filter((url) => url.includes('/orders/'))).toEqual([expect.stringMatching(/\/orders\/1$/)]);
    expect(gate.checks.find((c) => c.name === 'web /orders/1 (자동, id 추정)')!.ok).toBe(false);

    // 에이전트가 안내대로 studio.yaml에 sampleParams를 넣었다
    current = await edited(target, { autoPageChecks: auto({ sampleParams: { id: '7' } }) })();
    requested.length = 0;
    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(requested.filter((url) => url.includes('/orders/'))).toEqual([expect.stringMatching(/\/orders\/7$/)]);
    expect(gate.checks.find((c) => c.name === 'web /orders/7 (자동)')!.ok).toBe(true);
    expect(gate.checks.find((c) => c.name === 'web studio.yaml (자동, 건너뜀)')!.detail).toContain('sampleParams(id=7)를 이번 실행에서 바로 반영했습니다');
  });

  it('sampleParams로 연 화면은 추정이 아니라 엄격하게 판정하고, 사유가 어느 값으로 열었는지 말한다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const { gate, workspace } = await setup(target, {
      page: async () => ({ status: 404, text: 'Not Found' }),
      reload: edited(target, { autoPageChecks: auto({ sampleParams: { id: '999001' } }) }),
    });
    await workspace.write('web/app/orders/[id]/page.tsx', page);

    expect((await gate.check()).kind).toBe('retry');
    const check = gate.checks.find((c) => c.name === 'web /orders/999001 (자동)')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('HTTP 404 (기대 200)');
    expect(check.detail).toContain('sampleParams로 알려 준 값(id=999001)');
    expect(check.detail).not.toContain('추정한 id');
  });

  it('browser 모드에서도 sampleParams로 연 화면이 데이터 요청 404로 실패하면 같은 안내를 붙인다', async () => {
    const target = nextjs(project, { autoPageChecks: auto({ mode: 'browser' }) });
    const { gate, workspace } = await setup(target, {
      browser: async (url) => ({
        status: 200,
        text: '방송',
        pageErrors: [],
        consoleErrors: [],
        failedRequests: url.endsWith('/live/999001') ? ['404 http://127.0.0.1:1/api/v1/live/broadcasts/999001/playback'] : [],
        mediaErrors: [],
        blockedRequests: [],
        horizontalOverflowPx: 0,
        steps: [],
      }),
      reload: edited(target, { autoPageChecks: auto({ mode: 'browser', sampleParams: { id: '999001' } }) }),
    });
    await workspace.write('web/app/live/[id]/page.tsx', page);

    expect((await gate.check()).kind).toBe('retry');
    const check = gate.checks.find((c) => c.name === 'web /live/999001 (자동)')!;
    expect(check.detail).toContain('실패한 요청: 404');
    expect(check.detail).toContain('sampleParams로 알려 준 값(id=999001)');
  });

  it('실행 중에 넣은 값이 선언한 pageChecks와 같은 경로가 돼도 자동 확인을 건너뛰지 않는다(느슨한 선언으로 바꿔치기하지 못한다)', async () => {
    // 선언한 /orders/7은 기대 상태를 500으로 적어 둔(자동 확인보다 느슨한) 확인이다. 자동 확인은 200을 기대한다
    const target = nextjs(project, { autoPageChecks: auto(), pageChecks: [{ service: 'web', path: '/orders/7', mode: 'http', expectStatus: 500 }] as WorkflowSpec['pageChecks'] });
    let current = target;
    const { gate, workspace } = await setup(target, {
      page: async (url) => (url.includes('/orders/') ? { status: 500, text: 'Internal Server Error' } : { status: 200, text: 'ok' }),
      reload: async () => current,
    });
    await workspace.write('web/app/orders/[id]/page.tsx', page);
    current = await edited(target, { autoPageChecks: auto({ sampleParams: { id: '7' } }) })();

    const outcome = await gate.check();

    // 자동 확인이 /orders/7을 직접 열어 500을 실패로 본다. "이미 선언돼 있다"로 건너뛰면 느슨한 선언만 남아 통과했을 것이다
    expect(outcome.kind).toBe('retry');
    expect(gate.checks.find((c) => c.name === 'web /orders/7 (자동)')).toMatchObject({ ok: false });
    expect(gate.checks.some((c) => (c.detail ?? '').includes('두 번 열지 않았습니다'))).toBe(false);
  });

  it('값이 같은 자리의 고정 경로 폴더 이름과 같으면 반영하지 않는다(그 화면이 대신 열려 동적 화면 확인이 사라진다)', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: ordersApp(requested),
      reload: edited(target, { autoPageChecks: auto({ sampleParams: { id: 'new' } }) }),
    });
    // 고정 경로 /orders/new는 이번 실행에서 바뀐 파일이 아니어도 디스크에 있으면 라우터가 먼저 받는다
    await mkdir(path.join(workspace.root, 'web/app/orders/(forms)/new'), { recursive: true });
    await writeFile(path.join(workspace.root, 'web/app/orders/(forms)/new/page.tsx'), page);
    await workspace.write('web/app/orders/[id]/page.tsx', page);

    expect((await gate.check()).kind).toBe('retry');
    // 값을 반영하지 않았으므로 시작 때처럼 추정한 id로 연다. /orders/new는 열지 않는다
    expect(requested.filter((url) => url.includes('/orders/'))).toEqual([expect.stringMatching(/\/orders\/1$/)]);
    const note = gate.checks.find((c) => c.name === 'web studio.yaml (자동, 건너뜀)')!.detail!;
    expect(note).toContain('sampleParams.id=new은(는) 반영하지 않았습니다');
    expect(note).toContain('web/app/orders/(forms)/new');
    expect(gate.checks.some((c) => (c.detail ?? '').includes('이번 실행에서 바로 반영했습니다'))).toBe(false);
  });

  it('고정 경로가 다른 그룹 가지에 있거나 링크·public 파일이어도 같은 주소면 값을 반영하지 않는다', async () => {
    for (const shadow of ['group', 'symlink', 'public'] as const) {
      const target = nextjs(project, { autoPageChecks: auto() });
      const requested: string[] = [];
      const { gate, workspace } = await setup(target, {
        page: ordersApp(requested),
        reload: edited(target, { autoPageChecks: auto({ sampleParams: { id: 'new' } }) }),
      });
      if (shadow === 'group') {
        await mkdir(path.join(workspace.root, 'web/app/(admin)/orders/new'), { recursive: true });
        await workspace.write('web/app/(shop)/orders/[id]/page.tsx', page);
      } else {
        await workspace.write('web/app/orders/[id]/page.tsx', page);
        if (shadow === 'symlink') {
          await mkdir(path.join(workspace.root, 'web/elsewhere'), { recursive: true });
          await symlink(path.join(workspace.root, 'web/elsewhere'), path.join(workspace.root, 'web/app/orders/new'));
        } else {
          await mkdir(path.join(workspace.root, 'web/public/orders'), { recursive: true });
          await writeFile(path.join(workspace.root, 'web/public/orders/new'), 'static');
        }
      }

      expect((await gate.check()).kind, shadow).toBe('retry');
      expect(requested.filter((url) => url.includes('/orders/')), shadow).toEqual([expect.stringMatching(/\/orders\/1$/)]);
      expect(gate.checks.find((c) => c.name === 'web studio.yaml (자동, 건너뜀)')!.detail, shadow).toContain('sampleParams.id=new은(는) 반영하지 않았습니다');
    }
  });

  it('값이 경로 이름순을 바꿔도 시작 때의 값이었다면 열었을 화면은 maxPages 밖으로 밀려나지 않는다', async () => {
    // 시작 때: /m, /z 중 이름순 첫 번째인 /m만 연다. 실행 중 id=a가 들어오면 /a가 앞서지만 /m도 그대로 연다
    const target = nextjs(project, { autoPageChecks: auto({ maxPages: 1, followImports: false, sampleParams: { id: 'z' } }) });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: async (url) => {
        requested.push(new URL(url).pathname);
        return { status: 200, text: '화면' };
      },
      reload: edited(target, { autoPageChecks: auto({ maxPages: 1, followImports: false, sampleParams: { id: 'a' } }) }),
    });
    await workspace.write('web/app/m/page.tsx', page);
    await workspace.write('web/app/[id]/page.tsx', page);

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(requested.filter((pathname) => pathname === '/a' || pathname === '/m').sort()).toEqual(['/a', '/m']);
    expect(gate.checks.find((c) => c.name === 'web /m (자동)')!.ok).toBe(true);
    expect(gate.checks.some((c) => (c.detail ?? '').includes('상한(1개)을 넘었습니다') && c.name.includes('m/page.tsx'))).toBe(false);
  });

  it('경로 조각으로 쓸 수 없는 값은 반영하지 않고 이유를 남긴다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const requested: string[] = [];
    let current = target;
    const { gate, workspace } = await setup(target, { page: ordersApp(requested), reload: async () => current });
    await workspace.write('web/app/orders/[id]/page.tsx', page);
    // 스키마를 거치지 않은 값(주입된 다시 읽기)이 경로를 바꾸려는 문자를 담고 있다
    current = await edited(target, { autoPageChecks: auto({ sampleParams: { id: '../../admin' } }) })();

    await gate.check();

    // 추정한 id로 그대로 열고, 다른 경로는 열지 않는다
    expect(requested.filter((url) => url.includes('/orders/'))).toEqual([expect.stringMatching(/\/orders\/1$/)]);
    expect(requested.some((url) => url.includes('admin'))).toBe(false);
    expect(gate.checks.some((c) => (c.detail ?? '').includes('경로 조각으로 쓸 수 없는 값'))).toBe(true);
  });

  it('studio.yaml이 다른 파일로 가는 링크면 읽지 않고, 그 파일의 내용이 사유에 실리지 않는다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, { page: ordersApp(requested) });
    await workspace.write('web/app/orders/[id]/page.tsx', page);
    await workspace.write('studio.yaml', 'version: 1\n');
    // 설정 파일 자리를 프로젝트 밖의 파일로 가는 링크로 바꾼다
    const outside = path.join(project.root, '..', `outside-${Date.now()}.txt`);
    await writeFile(outside, 'TOP-SECRET-HOST-CONTENT: not yaml {{{');
    await rm(path.join(project.root, 'studio.yaml'));
    await symlink(outside, path.join(project.root, 'studio.yaml'));

    const outcome = await gate.check();

    // 설정을 읽는 쪽(loadProject)이 프로젝트 밖을 가리키는 링크를 거절하고, 그 파일의 내용은 어디에도 실리지 않는다
    const everything = `${JSON.stringify(outcome)}\n${JSON.stringify(gate.report)}\n${JSON.stringify(gate.checks)}`;
    expect(outcome.kind).toBe('retry');
    expect(everything).toContain('프로젝트 폴더 밖을 가리키는 링크');
    expect(everything).not.toContain('TOP-SECRET-HOST-CONTENT');
    await rm(outside, { force: true });
  });

  it('같은 키는 새 값으로 덮어 쓰고 시작 때의 다른 키는 그대로 둔다', async () => {
    const target = nextjs(project, { autoPageChecks: auto({ sampleParams: { id: '1', slug: 'a' } }) });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: ordersApp(requested),
      reload: edited(target, { autoPageChecks: auto({ sampleParams: { id: '9' } }) }),
    });
    await workspace.write('web/app/orders/[id]/page.tsx', page);
    await workspace.write('web/app/tags/[slug]/page.tsx', page);

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(requested.some((url) => url.endsWith('/orders/9'))).toBe(true);
    expect(requested.some((url) => url.endsWith('/tags/a'))).toBe(true);
  });

  it('실행 중 sampleIdFrom이 들어오면 그 api에서 꺼낸 값으로 연다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: async (url) => {
        requested.push(url);
        if (url.includes('/api/orders')) return { status: 200, text: '[{"id": 42}]' };
        return { status: 200, text: '주문 상세' };
      },
      reload: edited(target, { autoPageChecks: auto({ sampleIdFrom: { service: 'api', path: '/api/orders', jsonPath: '$[0].id' } }) }),
    });
    await workspace.write('web/app/orders/[id]/page.tsx', page);

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(requested.some((url) => url.endsWith('/orders/42'))).toBe(true);
    expect(gate.checks.find((c) => c.name === 'web studio.yaml (자동, 건너뜀)')!.detail).toContain('sampleIdFrom(api /api/orders)');
  });

  it('실행 중 들어온 sampleIdFrom이 관리형 서비스가 아니면 반영하지 않고 이유를 남긴다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: ordersApp(requested),
      reload: edited(target, { autoPageChecks: auto({ sampleIdFrom: { service: 'internal-admin', path: '/ids', jsonPath: '$[0]' } }) }),
    });
    await workspace.write('web/app/orders/[id]/page.tsx', page);

    expect((await gate.check()).kind).toBe('retry');
    expect(requested.some((url) => url.includes('/ids'))).toBe(false);
    expect(requested.some((url) => url.endsWith('/orders/1'))).toBe(true);
    expect(gate.checks.find((c) => c.name === 'web studio.yaml (자동, 건너뜀)')!.detail).toContain("'internal-admin'은(는) 이 프로젝트의 관리형 서비스가 아니라 반영하지 않았습니다");
  });

  it('시작 때 dynamicRouteProbe가 꺼져 있으면 실행 중 들어온 sampleIdFrom은 쓰지 않는다', async () => {
    const target = nextjs(project, { autoPageChecks: auto({ dynamicRouteProbe: false }) });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: ordersApp(requested),
      reload: edited(target, { autoPageChecks: auto({ sampleIdFrom: { service: 'api', path: '/api/orders', jsonPath: '$[0].id' } }) }),
    });
    await workspace.write('web/app/orders/[id]/page.tsx', page);

    await gate.check();
    expect(requested.some((url) => url.includes('/api/orders'))).toBe(false);
    expect(gate.checks.find((c) => c.name === 'web studio.yaml (자동, 건너뜀)')!.detail).toContain('dynamicRouteProbe가 실행을 시작할 때 꺼져 있어');
  });

  it('실행 중 dynamicRouteProbe·followImports·maxPages·service·pageChecks를 바꿔도 같은 실행에서는 적용되지 않는다(확인이 줄지 않는다)', async () => {
    const declared = { service: 'web', path: '/dashboard', mode: 'http', expectStatus: 200, allowConsoleErrors: false, noHorizontalScroll: false } as const;
    const target = nextjs(project, { pageChecks: [declared], autoPageChecks: auto() });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: ordersApp(requested),
      // 확인을 끄거나 줄이려는 변경 전부와 지워 버린 pageChecks. sampleParams는 함께 들어온 정상 변경이다
      reload: edited(target, {
        pageChecks: [],
        autoPageChecks: auto({ dynamicRouteProbe: false, followImports: false, maxPages: 1, service: 'api', expectStatus: 404, sampleParams: { id: '7' } }),
      }),
    });
    await workspace.write('web/components/OrderCard.tsx', 'export const OrderCard = () => null;\n');
    await workspace.write('web/app/orders/[id]/page.tsx', "import { OrderCard } from '../../../components/OrderCard';\nexport default function Page() { return OrderCard(); }\n");
    await workspace.write('web/app/dashboard/page.tsx', page);
    await workspace.write('web/app/reports/page.tsx', page);
    await workspace.write('web/app/settings/page.tsx', page);

    expect(await gate.check()).toEqual({ kind: 'pass' });
    // 선언한 pageChecks(/dashboard)가 그대로 돌고, 자동 확인은 web 서비스에서 maxPages 5로 모든 페이지를 연다. 값만 바뀌었다
    const opened = requested.map((url) => new URL(url).pathname);
    expect(opened).toEqual(expect.arrayContaining(['/dashboard', '/orders/7', '/reports', '/settings']));
    expect(gate.checks.some((c) => c.name === 'web /dashboard')).toBe(true);
    expect(gate.checks.find((c) => c.name === 'web web/app/dashboard/page.tsx (자동, 건너뜀)')!.detail).toContain('이미 선언한 pageChecks');
  });

  it('실행 중 dynamicRouteProbe: false가 들어와도 추정 id 확인은 그대로 돈다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: ordersApp(requested),
      reload: edited(target, { autoPageChecks: auto({ dynamicRouteProbe: false }) }),
    });
    await workspace.write('web/app/orders/[id]/page.tsx', page);

    expect((await gate.check()).kind).toBe('retry');
    expect(gate.checks.find((c) => c.name === 'web /orders/1 (자동, id 추정)')!.ok).toBe(false);
  });

  it('실행 중 followImports: false가 들어와도 import 역추적은 그대로 돈다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: async (url) => {
        requested.push(url);
        return { status: 200, text: '주문 목록' };
      },
      reload: edited(target, { autoPageChecks: auto({ followImports: false }) }),
    });
    await mkdir(path.join(target.root, 'web/app/orders'), { recursive: true });
    await mkdir(path.join(target.root, 'web/components'), { recursive: true });
    await writeFile(path.join(target.root, 'web/app/orders/page.tsx'), "import { Card } from '../../components/Card';\nexport default function Page() { return Card(); }\n");
    await workspace.write('web/components/Card.tsx', 'export const Card = () => null;\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(requested.some((url) => url.endsWith('/orders'))).toBe(true);
  });

  it('studio.yaml을 다시 읽지 못하면 시작 때의 값으로 돌고, 읽지 못했다는 사실을 건너뜀 check에 남긴다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: ordersApp(requested),
      reload: async () => {
        throw new SpecError('studio.yaml 형식이 올바르지 않습니다', ['workflow.autoPageChecks.sampleParams.id: 경로 조각으로 안전한 문자만 쓸 수 있습니다']);
      },
    });
    await workspace.write('web/app/orders/[id]/page.tsx', page);

    expect((await gate.check()).kind).toBe('retry');
    expect(requested.some((url) => url.endsWith('/orders/1'))).toBe(true);
    const note = gate.checks.find((c) => c.name === 'web studio.yaml (자동, 건너뜀)')!;
    expect(note.ok).toBe(true);
    expect(note.detail).toContain('새 값을 읽지 못해');
    expect(note.detail).toContain('sampleParams.id');
  });

  it('reloadProject를 넘기지 않으면 이번 실행에서 studio.yaml이 바뀐 때만 디스크를 읽는다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    // 디스크에 studio.yaml이 없는 가짜 프로젝트: 바뀌지 않았으면 읽지 않으므로 건너뜀 check가 생기지 않는다
    const { gate, workspace } = await setup(target, { page: ordersApp([]) });
    await workspace.write('web/app/orders/[id]/page.tsx', page);

    await gate.check();
    expect(gate.checks.some((c) => c.name === 'web studio.yaml (자동, 건너뜀)')).toBe(false);
  });
});

describe('자동 페이지 확인 (autoPageChecks)', () => {
  /** 자동 페이지 확인은 Next.js(nextjs) 관리형 서비스가 필요하다. 예제 픽스처에 web 서비스를 더한다 */
  function nextjs(target: LoadedProject, workflow: Partial<WorkflowSpec>): LoadedProject {
    return {
      ...target,
      spec: { ...target.spec, workflow },
      managed: [...target.managed, ['web', { source: 'managed', template: 'nextjs', path: 'web', port: 3000, preview: 'browser' }]],
    } as unknown as LoadedProject;
  }

  /** 설정의 기본값을 채운 autoPageChecks. 테스트마다 필요한 값만 바꾼다 */
  function auto(over: Partial<NonNullable<WorkflowSpec['autoPageChecks']>> = {}): NonNullable<WorkflowSpec['autoPageChecks']> {
    return { service: 'web', mode: 'http', expectStatus: 200, maxPages: 5, ...over };
  }

  it('이번 실행에서 바뀐 페이지를 찾아 열어 보고, 500이면 자동 표시와 함께 실패로 남긴다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: async (url) => {
        requested.push(url);
        return url.includes('/dashboard') ? { status: 500, text: 'Internal Server Error' } : { status: 200, text: '주문 목록' };
      },
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    await workspace.write('web/app/dashboard/page.tsx', 'export default function Page() { return null; }\n');
    await workspace.write('web/app/orders/page.tsx', 'export default function Page() { return null; }\n');

    const outcome = await gate.check();

    expect(outcome.kind).toBe('retry');
    expect(requested.some((url) => url.endsWith('/dashboard'))).toBe(true);
    expect(requested.some((url) => url.endsWith('/orders'))).toBe(true);
    const autoCheck = gate.checks.find((check) => check.name === 'web /dashboard (자동)')!;
    expect(autoCheck).toMatchObject({ stage: 'browser_check', ok: false });
    expect(autoCheck.detail).toContain('자동 페이지 /dashboard: HTTP 500 (기대 200)');
    expect(gate.checks.find((check) => check.name === 'web /orders (자동)')!.ok).toBe(true);
    expect(gate.passedStages.has('browser_check')).toBe(false);
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('자동 페이지 /dashboard: HTTP 500 (기대 200)');
  });

  it('상태가 200이어도 본문이 Next.js 오류 화면이면 실패한다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const { gate, workspace } = await setup(target, {
      page: async () => ({ status: 200, text: '<main><h2>Application error: a server-side exception has occurred</h2></main>' }),
    });
    await workspace.write('web/app/dashboard/page.tsx', 'export default function Page() { return null; }\n');

    const outcome = await gate.check();

    expect(outcome.kind).toBe('retry');
    expect(gate.checks.find((check) => check.name === 'web /dashboard (자동)')!.detail).toContain(
      "Next.js 오류 화면: 'Application error: a server-side exception has occurred'",
    );
  });

  it('동적 세그먼트는 sampleParams 값으로 채워 열고, id로 보이지 않는 이름은 값이 없으면 건너뜀 check로 남긴다', async () => {
    const target = nextjs(project, { autoPageChecks: auto({ sampleParams: { id: '7' } }) });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: async (url) => {
        requested.push(url);
        return { status: 200, text: '주문 상세' };
      },
    });
    await workspace.write('web/app/orders/[id]/page.tsx', 'export default function Page() { return null; }\n');
    await workspace.write('web/app/tags/[slug]/page.tsx', 'export default function Page() { return null; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    // 값이 있는 동적 세그먼트는 채워서 열고, id로 보이지 않는 이름(slug)은 값이 없으면 열지 않는다
    expect(requested.some((url) => url.endsWith('/orders/7'))).toBe(true);
    expect(requested.some((url) => url.includes('slug'))).toBe(false);
    const skipped = gate.checks.find((check) => check.name === 'web web/app/tags/[slug]/page.tsx (자동, 건너뜀)')!;
    expect(skipped).toMatchObject({ stage: 'browser_check', ok: true });
    expect(skipped.detail).toContain("동적 세그먼트 'slug'의 값이 없습니다");
  });

  it('id로 보이는 세그먼트는 sampleParams가 없어도(ADR-078) "1"로 채워 열고, 404·500만 실패로 본다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: async (url) => {
        requested.push(url);
        return url.endsWith('/orders/1') ? { status: 404, text: 'Not Found' } : { status: 200, text: '주문 상세' };
      },
    });
    await workspace.write('web/app/orders/[id]/page.tsx', 'export default function Page() { return null; }\n');

    const outcome = await gate.check();

    expect(requested.some((url) => url.endsWith('/orders/1'))).toBe(true);
    expect(outcome.kind).toBe('retry');
    const check = gate.checks.find((c) => c.name === 'web /orders/1 (자동, id 추정)')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('추정한 id(1)로 열었더니 HTTP 404');
  });

  it('추정한 id로 연 화면이 그 id의 데이터를 못 받아 실패하면, 사유에 id가 추정값이라는 것과 실제 id를 알려 주는 방법을 붙인다', async () => {
    const target = nextjs(project, { autoPageChecks: auto({ mode: 'browser' }) });
    const { gate, workspace } = await setup(target, {
      browser: async (url) => ({
        status: 200,
        text: '방송',
        pageErrors: [],
        consoleErrors: [],
        // 화면은 떴지만, 추정한 id(1)의 방송이 없어 데이터 요청이 404다
        failedRequests: url.endsWith('/live/1') ? ['404 http://127.0.0.1:1/api/v1/live/broadcasts/1/playback'] : [],
        mediaErrors: [],
        blockedRequests: [],
        horizontalOverflowPx: 0,
        steps: [],
      }),
    });
    await workspace.write('web/app/live/[id]/page.tsx', 'export default function Page() { return null; }\n');

    const outcome = await gate.check();

    expect(outcome.kind).toBe('retry');
    const check = gate.checks.find((c) => c.name === 'web /live/1 (자동, id 추정)')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('실패한 요청: 404');
    expect(check.detail).toContain('추정한 id(1)로 열었습니다');
    expect(check.detail).toContain('autoPageChecks.sampleParams');
  });

  it('page가 아닌 컴포넌트만 바뀌어도 그 컴포넌트를 쓰는 페이지를 열고, 500이면 실패한다(import 역추적)', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: async (url) => {
        requested.push(url);
        return url.endsWith('/orders/1') ? { status: 500, text: 'Internal Server Error' } : { status: 200, text: '주문 상세' };
      },
    });
    // page 파일은 이번 실행에서 바뀌지 않았다(디스크에만 있다). 바뀐 것은 그 페이지가 쓰는 컴포넌트뿐이다
    const pageFile = path.join(workspace.root, 'web/app/orders/[id]/page.tsx');
    await mkdir(path.dirname(pageFile), { recursive: true });
    await writeFile(pageFile, "import { OrderSummary } from '@/components/OrderSummary';\nexport default function Page() { return <OrderSummary />; }\n");
    await workspace.write('web/components/OrderSummary.tsx', 'export function OrderSummary() { return <p>매진</p>; }\n');

    const outcome = await gate.check();

    expect(requested.some((url) => url.endsWith('/orders/1'))).toBe(true);
    expect(outcome.kind).toBe('retry');
    const check = gate.checks.find((c) => c.name === 'web /orders/1 (자동, id 추정 · OrderSummary.tsx 변경)')!;
    expect(check).toMatchObject({ stage: 'browser_check', ok: false });
    expect(check.detail).toContain('HTTP 500');
  });

  /** page 파일을 이번 실행의 변경으로 기록하지 않고 디스크에만 둔다(이미 있던 페이지) */
  async function existing(workspace: Workspace, file: string, content: string): Promise<void> {
    const absolute = path.join(workspace.root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }

  it('유틸만 바뀌면 컴포넌트를 거쳐 2단계 떨어진 페이지를 열고, 사슬이 깊이 상한(5단계)을 넘으면 건너뜀 check로 남긴다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: async (url) => {
        requested.push(url);
        return { status: 200, text: '주문 상세' };
      },
    });
    await existing(workspace, 'web/app/orders/[id]/page.tsx', "import { Viewer } from '../../../components/Viewer';\nexport default Viewer;\n");
    await existing(workspace, 'web/components/Viewer.tsx', "import { pin } from '../lib/pin';\nexport const Viewer = () => pin;\n");
    await workspace.write('web/lib/pin.ts', 'export const pin = 1;\n');
    // 사슬이 긴 쪽: deep0 <- deep1 <- ... <- deep6 <- 페이지(7단계)
    for (let i = 0; i < 7; i++) await existing(workspace, `web/lib/deep${i}.ts`, i === 0 ? '' : `import './deep${i - 1}';\n`);
    await existing(workspace, 'web/app/far/page.tsx', "import '../../lib/deep6';\nexport default function P() { return null; }\n");
    await workspace.write('web/lib/deep0.ts', 'export const deep = 1;\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });

    expect(requested.some((url) => url.endsWith('/orders/1'))).toBe(true);
    expect(requested.some((url) => url.endsWith('/far'))).toBe(false);
    expect(gate.checks.find((c) => c.name === 'web /orders/1 (자동, id 추정 · pin.ts 변경)')!.ok).toBe(true);
    const stopped = gate.checks.find((c) => c.name === 'web web/lib/deep0.ts (자동, 건너뜀)')!;
    expect(stopped).toMatchObject({ stage: 'browser_check', ok: true });
    expect(stopped.detail).toContain('5단계까지 따라갔고');
    expect(stopped.detail).toContain('깊이 상한');
  });

  it('공용 파일이 여러 페이지에 쓰이면 maxPages 안에서 가까운 것부터 열고 못 연 경로를 건너뜀 check에 남긴다', async () => {
    const target = nextjs(project, { autoPageChecks: auto({ maxPages: 2 }) });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: async (url) => {
        requested.push(url);
        return { status: 200, text: 'ok' };
      },
    });
    for (const name of ['a', 'b', 'c', 'd']) {
      await existing(workspace, `web/app/${name}/page.tsx`, "import { fmt } from '@/lib/format';\nexport default function P() { return fmt; }\n");
    }
    await workspace.write('web/lib/format.ts', 'export const fmt = 1;\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });

    expect(requested.filter((url) => /\/[a-d]$/.test(url)).sort()).toEqual([expect.stringMatching(/\/a$/), expect.stringMatching(/\/b$/)]);
    const skipped = gate.checks.find((c) => c.name === 'web web/lib/format.ts (자동, 건너뜀)')!;
    expect(skipped.ok).toBe(true);
    expect(skipped.detail).toContain('페이지 2개');
    expect(skipped.detail).toContain('/c, /d');
  });

  it('followImports: false이면 바뀐 컴포넌트를 쓰는 페이지를 찾지 않는다', async () => {
    const target = nextjs(project, { autoPageChecks: auto({ followImports: false }) });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: async (url) => {
        requested.push(url);
        return { status: 500, text: 'Internal Server Error' };
      },
    });
    await existing(workspace, 'web/app/orders/page.tsx', "import { V } from '@/components/V';\nexport default V;\n");
    await workspace.write('web/components/V.tsx', 'export const V = () => null;\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(requested.some((url) => url.endsWith('/orders'))).toBe(false);
  });

  it('layout이 바뀌면 그 폴더의 페이지를 연다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: async (url) => {
        requested.push(url);
        return { status: 200, text: 'ok' };
      },
    });
    await existing(workspace, 'web/app/page.tsx', 'export default function P() { return null; }\n');
    await existing(workspace, 'web/app/shop/page.tsx', 'export default function P() { return null; }\n');
    await workspace.write('web/app/layout.tsx', 'export default function L({ children }) { return children; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(requested.filter((url) => url.endsWith('/') || url.endsWith('/shop')).length).toBe(2);
    expect(gate.checks.some((c) => c.name === 'web /shop (자동 · layout.tsx 변경)' && c.ok)).toBe(true);
  });

  it('id를 추정해 연 동적 경로는 404·500이 아니면 다른 상태 코드라도 실패로 보지 않는다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const { gate, workspace } = await setup(target, { page: async () => ({ status: 403, text: '접근 권한이 없습니다' }) });
    await workspace.write('web/app/orders/[id]/page.tsx', 'export default function Page() { return null; }\n');

    // id를 짐작한 것이라 403·401 같은 상태는 실제 버그일 수도, id가 없어서일 수도 있어 관대하게 통과시킨다
    expect(await gate.check()).toEqual({ kind: 'pass' });
  });

  it('dynamicRouteProbe: false면 예전처럼 값이 없는 동적 세그먼트를 건너뛴다', async () => {
    const target = nextjs(project, { autoPageChecks: auto({ dynamicRouteProbe: false }) });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, { page: async (url) => (requested.push(url), { status: 200, text: '주문 상세' }) });
    await workspace.write('web/app/orders/[id]/page.tsx', 'export default function Page() { return null; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(requested).toEqual([]);
    const skipped = gate.checks.find((check) => check.name === 'web web/app/orders/[id]/page.tsx (자동, 건너뜀)')!;
    expect(skipped.detail).toContain("동적 세그먼트 'id'의 값이 없습니다");
  });

  it('sampleIdFrom을 적으면 그 api에서 꺼낸 값으로 동적 경로를 연다', async () => {
    const target = nextjs(project, { autoPageChecks: auto({ sampleIdFrom: { service: 'api', path: '/api/orders', jsonPath: '$[0].id' } }) });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: async (url) => {
        requested.push(url);
        if (url.includes('/api/orders')) return { status: 200, text: '[{"id": 42}]' };
        return { status: 200, text: '주문 상세' };
      },
    });
    await workspace.write('web/app/orders/[id]/page.tsx', 'export default function Page() { return null; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(requested.some((url) => url.endsWith('/orders/42'))).toBe(true);
  });

  it('sampleIdFrom 조회가 실패하면 기본값 "1"로 물러난다', async () => {
    const target = nextjs(project, { autoPageChecks: auto({ sampleIdFrom: { service: 'api', path: '/api/orders', jsonPath: '$[0].id' } }) });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: async (url) => {
        requested.push(url);
        if (url.includes('/api/orders')) return { status: 500, text: 'boom' };
        return { status: 200, text: '주문 상세' };
      },
    });
    await workspace.write('web/app/orders/[id]/page.tsx', 'export default function Page() { return null; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(requested.some((url) => url.endsWith('/orders/1'))).toBe(true);
  });

  it('이미 선언한 같은 경로는 두 번 열지 않고 건너뜀 check로 남긴다', async () => {
    const target = nextjs(project, {
      pageChecks: [{ service: 'web', path: '/dashboard', mode: 'http', expectStatus: 200, allowConsoleErrors: false, noHorizontalScroll: false }],
      autoPageChecks: auto(),
    });
    const requested: string[] = [];
    const { gate, workspace } = await setup(target, {
      page: async (url) => {
        requested.push(url);
        return { status: 200, text: '대시보드' };
      },
    });
    await workspace.write('web/app/dashboard/page.tsx', 'export default function Page() { return null; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(requested.filter((url) => url.endsWith('/dashboard'))).toHaveLength(1);
    expect(gate.checks.find((check) => check.name === 'web web/app/dashboard/page.tsx (자동, 건너뜀)')!.detail).toContain('두 번 열지 않았습니다');
    expect(gate.checks.some((check) => check.name === 'web /dashboard (자동)')).toBe(false);
  });

  it('바뀐 페이지가 없으면 자동 check를 만들지 않는다', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const { gate, workspace, events } = await setup(target);
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(gate.checks.some((check) => check.name.includes('자동'))).toBe(false);
    // 열어 볼 페이지가 없으면 browser_check 단계를 돌았다고 세지도 않는다
    expect(stages(events)).not.toContain('browser_check');
  });

  it('browser 모드면 정한 창 크기로 열고, 오류 표지도 렌더링된 글자에서 본다', async () => {
    const target = nextjs(project, { autoPageChecks: auto({ mode: 'browser', viewport: { width: 390, height: 844 } }) });
    const seen: Array<{ url: string; viewport?: { width: number; height: number } }> = [];
    const rendered = { status: 200, text: '대시보드', pageErrors: [], consoleErrors: [], failedRequests: [], mediaErrors: [], blockedRequests: [], horizontalOverflowPx: 0, steps: [] };
    const passing = await setup(target, {
      browser: async (url, options) => {
        seen.push({ url, viewport: options.viewport });
        return rendered;
      },
    });
    await passing.workspace.write('web/app/dashboard/page.tsx', 'export default function Page() { return null; }\n');

    expect(await passing.gate.check()).toEqual({ kind: 'pass' });
    expect(seen[0]!.viewport).toEqual({ width: 390, height: 844 });

    const failing = await setup(target, { browser: async (url, options) => ({ ...rendered, url, viewport: options.viewport, text: 'Unhandled Runtime Error' }) });
    await failing.workspace.write('web/app/dashboard/page.tsx', 'export default function Page() { return null; }\n');
    expect(await failing.gate.check()).not.toEqual({ kind: 'pass' });
    expect(failing.gate.checks.find((check) => check.name === 'web /dashboard (자동)')!.detail).toContain("Next.js 오류 화면: 'Unhandled Runtime Error'");
  });

  it('browser 모드에서 렌더링된 글자가 로딩 문구뿐이면 실패로 본다(E8 haiku의 "Loading..."만 남은 화면, ADR-078)', async () => {
    const target = nextjs(project, { autoPageChecks: auto({ mode: 'browser' }) });
    const stuck = { status: 200, text: 'Loading...', pageErrors: [], consoleErrors: [], failedRequests: [], mediaErrors: [], blockedRequests: [], horizontalOverflowPx: 0, steps: [] };
    const { gate, workspace } = await setup(target, { browser: async () => stuck });
    await workspace.write('web/app/dashboard/page.tsx', 'export default function Page() { return null; }\n');

    const outcome = await gate.check();

    expect(outcome.kind).toBe('retry');
    const check = gate.checks.find((c) => c.name === 'web /dashboard (자동)')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('화면이 로딩 문구만 보여 준 채 멈췄습니다');
  });

  it('browser 모드에서 빈 화면은 실패한 요청 같은 증거가 있을 때만 실패로 본다', async () => {
    const target = nextjs(project, { autoPageChecks: auto({ mode: 'browser' }) });
    const emptyWithFailure = {
      status: 200,
      text: '',
      pageErrors: [],
      consoleErrors: [],
      failedRequests: ['404 http://127.0.0.1:1/api/orders'],
      mediaErrors: [], blockedRequests: [],
      horizontalOverflowPx: 0,
      steps: [],
    };
    const { gate, workspace } = await setup(target, { browser: async () => emptyWithFailure });
    await workspace.write('web/app/dashboard/page.tsx', 'export default function Page() { return null; }\n');

    const outcome = await gate.check();
    expect(outcome.kind).toBe('retry');
    const check = gate.checks.find((c) => c.name === 'web /dashboard (자동)')!;
    // 실패한 요청도, 빈 화면 사유도 함께 남는다
    expect(check.detail).toContain('실패한 요청');
    expect(check.detail).toContain('화면에 표시된 내용이 없습니다');
  });

  it('바뀐 페이지의 <video>가 미디어 주소 404로 재생되지 않으면 상태 코드가 200이어도 실패로 본다(트러블슈팅 83, BE-commerce /shorts)', async () => {
    const target = nextjs(project, { autoPageChecks: auto({ mode: 'browser' }) });
    const brokenShorts = {
      status: 200,
      text: '숏폼 피드',
      pageErrors: [],
      consoleErrors: [],
      failedRequests: [
        '404 http://127.0.0.1:1/api/v1/shorts/1/media/master.m3u8',
        '404 http://127.0.0.1:1/api/v1/shorts/1/media/thumb.jpg',
      ],
      mediaErrors: ['video MEDIA_ERR_SRC_NOT_SUPPORTED http://127.0.0.1:1/api/v1/shorts/1/media/master.m3u8'],
      blockedRequests: [],
      horizontalOverflowPx: 0,
      steps: [],
    };
    const { gate, workspace } = await setup(target, { browser: async () => brokenShorts });
    await workspace.write('web/app/shorts/page.tsx', 'export default function Page() { return null; }\n');

    const outcome = await gate.check();

    expect(outcome.kind).toBe('retry');
    const check = gate.checks.find((c) => c.name === 'web /shorts (자동)')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('실패한 요청: 404 http://127.0.0.1:1/api/v1/shorts/1/media/master.m3u8');
    expect(check.detail).toContain('미디어 오류: video MEDIA_ERR_SRC_NOT_SUPPORTED http://127.0.0.1:1/api/v1/shorts/1/media/master.m3u8');
  });

  it('allowLoadingPlaceholder를 켜면 로딩 문구만 있는 화면도 통과시킨다(선언한 pageChecks)', async () => {
    const target = withWorkflow({
      pageChecks: [
        {
          service: 'api',
          path: '/progress',
          mode: 'browser',
          expectStatus: 200,
          allowConsoleErrors: false,
          noHorizontalScroll: false,
          allowLoadingPlaceholder: true,
        },
      ],
    });
    const stuck = { status: 200, text: '로딩 중입니다...', pageErrors: [], consoleErrors: [], failedRequests: [], mediaErrors: [], blockedRequests: [], horizontalOverflowPx: 0, steps: [] };
    const { gate, workspace } = await setup(target, { browser: async () => stuck });
    await workspace.write('api/src/Progress.java', 'class Progress {}\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
  });

  it('HTTP 모드의 자동 페이지 확인은 로딩 문구로 보이는 본문을 실패시키지 않고 참고 문구로만 남긴다(보수적 판정)', async () => {
    const target = nextjs(project, { autoPageChecks: auto() });
    const { gate, workspace } = await setup(target, { page: async () => ({ status: 200, text: '<html><body><div id="root">Loading...</div></body></html>' }) });
    await workspace.write('web/app/dashboard/page.tsx', 'export default function Page() { return null; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    const check = gate.checks.find((c) => c.name === 'web /dashboard (자동)')!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('[참고]');
    expect(check.detail).toContain('화면이 로딩 문구만 보여 준 채 멈췄습니다');
  });

  it('관리형 서비스에 없는 이름이면 이유를 남기고 넘어간다', async () => {
    // web 서비스가 없는 프로젝트(설정 오류를 게이트가 조용히 삼키지 않는지)
    const target = { ...project, spec: { ...project.spec, workflow: { autoPageChecks: auto() } } } as LoadedProject;
    const { gate, workspace } = await setup(target);
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    const skipped = gate.checks.find((check) => check.name.includes('자동'))!;
    expect(skipped).toMatchObject({ stage: 'browser_check', ok: true });
    expect(skipped.detail).toContain("autoPageChecks.service 'web'를 이 프로젝트의 관리형 서비스에서 찾지 못했습니다");
  });

  it('nextjs가 아닌 서비스를 가리키면(불러올 때 막는 조합) 열어 볼 페이지를 찾지 못해 check를 만들지 않는다', async () => {
    const target = { ...project, spec: { ...project.spec, workflow: { autoPageChecks: auto({ service: 'api' }) } } } as LoadedProject;
    const { gate, workspace } = await setup(target);
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(gate.checks.some((check) => check.name.includes('자동'))).toBe(false);
  });

  it('자동 페이지 설정이 없으면 이전과 똑같이 돈다', async () => {
    const target = nextjs(project, {});
    const { gate, workspace, events } = await setup(target);
    await workspace.write('web/app/dashboard/page.tsx', 'export default function Page() { return null; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(gate.checks.some((check) => check.name.includes('자동'))).toBe(false);
    expect(stages(events)).not.toContain('browser_check');
  });
});

describe('자동 페이지 확인의 오류 표지와 서명', () => {
  it('서버·클라이언트 예외 표지를 찾고, 404 화면은 404를 기대할 때만 통과시킨다', () => {
    expect(nextErrorMarker('<h2>Application error: a server-side exception has occurred</h2>', 200)).toBe('Application error: a server-side exception has occurred');
    expect(nextErrorMarker('<nextjs-portal>Unhandled Runtime Error</nextjs-portal>', 200)).toBe('Unhandled Runtime Error');
    expect(nextErrorMarker('<h1>This page could not be found</h1>', 200)).toBe('This page could not be found');
    // 404를 기대한 확인에서는 404 화면이 오류가 아니다
    expect(nextErrorMarker('<h1>This page could not be found</h1>', 404)).toBeUndefined();
    expect(nextErrorMarker('<h1>주문 목록</h1>', 200)).toBeUndefined();
  });

  it('autoPageChecks를 pageChecks 모양으로 바꾼다', () => {
    expect(autoPageCheck({ service: 'web', mode: 'browser', expectStatus: 201, maxPages: 5, viewport: { width: 390, height: 844 } }, '/orders')).toEqual({
      service: 'web',
      path: '/orders',
      mode: 'browser',
      expectStatus: 201,
      allowConsoleErrors: false,
      noHorizontalScroll: false,
      viewport: { width: 390, height: 844 },
    });
    // http 모드에서는 viewport를 넘기지 않는다
    expect(autoPageCheck({ service: 'web', mode: 'http', expectStatus: 200, maxPages: 5 }, '/orders')).toEqual({
      service: 'web',
      path: '/orders',
      mode: 'http',
      expectStatus: 200,
      allowConsoleErrors: false,
      noHorizontalScroll: false,
    });
  });

  it('자동 페이지 실패는 경로를 앞에 붙여 선언한 pageChecks 실패와 서명이 갈린다', () => {
    const declared: WorkflowCheck = { stage: 'browser_check', name: 'web /dashboard', ok: false, attempts: 1, detail: 'HTTP 500 (기대 200)' };
    const auto: WorkflowCheck = { stage: 'browser_check', name: 'web /dashboard (자동)', ok: false, attempts: 1, detail: '자동 페이지 /dashboard: HTTP 500 (기대 200)' };

    // 서명은 첫 줄만 남기고 숫자를 N으로 바꾼다(같은 원인의 실패를 하나로 묶기 위해)
    expect(signatureFromCheck(auto).message).toBe('자동 페이지 /dashboard: HTTP N (기대 N)');
    expect(signatureKey(signatureFromCheck(auto))).not.toBe(signatureKey(signatureFromCheck(declared)));
    // 이름에만 "(자동)"이 붙고 detail이 같으면 서명은 갈리지 않는다(그래서 자동 실패에는 경로를 앞에 붙인다)
    const namedOnly: WorkflowCheck = { ...auto, detail: declared.detail };
    expect(signatureKey(signatureFromCheck(namedOnly))).toBe(signatureKey(signatureFromCheck(declared)));
  });
});

describe('가볍게 확인(verify light)', () => {
  const target = () =>
    withWorkflow({
      tests: [{ name: 'unit', service: 'api', command: ['./gradlew', 'test'], maxAttempts: 1 }],
      pageChecks: [{ service: 'api', path: '/orders', mode: 'http', expectStatus: 200, expectText: '주문 목록', allowConsoleErrors: false, noHorizontalScroll: false }],
    });

  it('테스트·화면 확인·리뷰를 건너뛰고 재시작·준비 판정·계약만 돌린다', async () => {
    const { gate, workspace, events, commands } = await setup(target(), { verify: 'light' });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(gate.verified).toBe(true);
    // 통과한 단계는 재시작(run)·계약(contract_check)뿐이다. 건너뛴 단계는 실패가 아니라 기록으로 남는다
    expect([...gate.passedStages].sort()).toEqual(['contract_check', 'run']);
    expect([...gate.skippedStages].sort()).toEqual(['browser_check', 'review', 'test']);
    expect(stages(events)).toEqual(['run', 'contract_check']);
    expect(commands).toEqual([]);
    expect(gate.checks).toEqual([]);
  });

  it('full(기본)은 지금처럼 선언한 테스트·화면 확인·리뷰를 모두 돌린다', async () => {
    const { gate, workspace, commands } = await setup(target());
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(commands).toEqual([['./gradlew', 'test']]);
    expect(gate.skippedStages).toEqual([]);
    expect([...gate.passedStages].sort()).toEqual(['browser_check', 'contract_check', 'review', 'run', 'test']);
  });
});

describe('VerificationGate와 compose에 새로 생긴 부가 서비스(도그푸딩 마찰 138, ADR-146)', () => {
  it('에이전트가 실행 중 compose에 더한 새 부가 서비스(depends_on 없음)를 올리면 warning 이벤트로도 알린다', async () => {
    // compose·studio.yaml을 실제로 디스크에 둔다 — restartServicesFor가 compose가 바뀐 재시작에서
    // declared 프로젝트를 다시 읽어 지금 compose 서비스 전체를 보기 때문이다
    await writeFile(path.join(project.root, 'studio.yaml'), 'version: 1\nname: orders\nservices:\n  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi, contract: { extract: "/v3/api-docs" } }\n');
    await writeFile(path.join(project.root, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
    const target = { ...project, composePath: path.join(project.root, 'compose.yaml') } as unknown as LoadedProject;

    const sandbox = fakeSandbox(target, [true]) as Sandbox & { restarts: string[]; ensureInfra?: NonNullable<Sandbox['ensureInfra']> };
    const ensureInfraCalls: string[][] = [];
    sandbox.ensureInfra = async (services) => {
      ensureInfraCalls.push([...services]);
      return { ok: true, recovered: [...services] };
    };

    const workspace = new Workspace(target.root);
    // 에이전트가 실행 중 compose에 mediamtx를 더한다. 실측(BE-commerce)처럼 api는 mediamtx에 기대지 않는다
    // (MediaMTX가 commerce의 훅을 부르는 반대 방향이라 depends_on이 없다) — depends_on 없이도 올려야 한다
    await workspace.write('compose.yaml', 'services:\n  api: { build: ./api }\n  mediamtx: { image: bluenviron/mediamtx:latest }\n');

    const events: AgentEvent[] = [];
    const gate = await VerificationGate.create({
      project: target,
      sandbox,
      workspace,
      allowBreaking: false,
      maxVerifyAttempts: 3,
      fetcher: async () => ORDERS_CONTRACT,
      pageFetcher: async () => ({ status: 200, text: '' }),
      onEvent: (event) => events.push(event),
    });

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(ensureInfraCalls).toEqual([['mediamtx']]);
    expect(events).toContainEqual({ type: 'warning', message: 'compose에 새로 생긴 부가 서비스를 켰습니다(끄려면 서비스 메뉴에서): mediamtx' });
  });
});

describe('VerificationGate 요구사항 문서의 검증 기록(ADR-157)', () => {
  const REQ = 'docs/requirements.md';
  const PLAIN = '# 요구사항\n\n## R1. 로그인\n- 종류: api · 우선순위: must\n- 인수 조건:\n  - a\n- 상태: 미착수\n';
  const FORGED_LINE = '- 확인: 에이전트 · 2026-10-10 · 체크포인트 abc1234 · 메모 확인함';
  const forge = (doc: string) => doc.replace('- 상태:', `${FORGED_LINE}\n- 상태:`);

  async function seedDoc(content: string): Promise<void> {
    await mkdir(path.join(project.root, 'docs'), { recursive: true });
    await writeFile(path.join(project.root, REQ), content);
  }

  it('실행이 사람 확인 줄을 써넣으면 manual-verification 검사가 실패하고, 되돌릴 기록을 모델에게 알린다', async () => {
    await seedDoc(PLAIN);
    const { gate, workspace, events } = await setup(project);
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    await workspace.write(REQ, forge(PLAIN));

    const outcome = await gate.check();

    expect(outcome.kind).toBe('retry');
    expect(gate.verified).toBe(false);
    expect(gate.passedStages.has('review')).toBe(false);
    const check = gate.checks.find((entry) => entry.name === 'manual-verification');
    expect(check).toMatchObject({ stage: 'review', ok: false });
    expect(events).toContainEqual({ type: 'workflow_check', check });
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('R1');
    expect(outcome.kind === 'retry' && outcome.feedback).toContain('사람 확인은 화면에서 사람만 남길 수 있습니다. 이 기록을 되돌리세요');
  });

  it('기록을 되돌린 다음 검증에서는 통과한다', async () => {
    await seedDoc(PLAIN);
    const { gate, workspace } = await setup(project, { restarts: [true, true, true, true] });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    await workspace.write(REQ, forge(PLAIN));
    expect((await gate.check()).kind).toBe('retry');

    await workspace.write(REQ, PLAIN);

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(gate.checks.some((entry) => entry.name === 'manual-verification')).toBe(false);
  });

  it('요구사항 본문만 고친 실행은 통과한다', async () => {
    await seedDoc(PLAIN);
    const { gate, workspace } = await setup(project);
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    await workspace.write(REQ, PLAIN.replace('로그인', '이메일 로그인'));

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(gate.checks.some((entry) => entry.name.startsWith('manual-verification'))).toBe(false);
  });

  it('실행 전부터 있던 사람 확인(사용자가 직접 남긴 것)은 건드리지 않으면 통과한다', async () => {
    await seedDoc(forge(PLAIN));
    const { gate, workspace } = await setup(project);
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    expect(await gate.check()).toEqual({ kind: 'pass' });
  });

  it('작업 공간이 모르는 경로(서비스 안 명령 등)로 문서를 고쳐 바뀐 파일 목록이 비어도 막는다', async () => {
    await seedDoc(PLAIN);
    const { gate, workspace, events } = await setup(project);
    await writeFile(path.join(project.root, REQ), forge(PLAIN));
    expect(workspace.changedFiles()).toEqual([]);

    const outcome = await gate.check();

    expect(outcome.kind).toBe('retry');
    expect(gate.checks.map((entry) => entry.name)).toEqual(['manual-verification']);
    expect(events.some((event) => event.type === 'workflow_check' && event.check.name === 'manual-verification')).toBe(true);
  });

  it('문서 자리에 링크를 놓아 바꿔치기하면, 링크 너머의 내용을 읽지 않고 막는다', async () => {
    await seedDoc(PLAIN);
    const { gate } = await setup(project);
    // 위조한 문서를 다른 곳에 두고 요구사항 문서를 그리로 가는 링크로 바꾼다
    await writeFile(path.join(project.root, 'docs/elsewhere.md'), forge(PLAIN));
    await rm(path.join(project.root, REQ));
    await symlink(path.join(project.root, 'docs/elsewhere.md'), path.join(project.root, REQ));

    const outcome = await gate.check();

    expect(outcome.kind).toBe('retry');
    const check = gate.checks.find((entry) => entry.name === 'manual-verification');
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain('읽을 수 없어');
  });

  it('문서 폴더 자체를 위조한 문서가 든 폴더로 가는 링크로 바꿔도 막는다', async () => {
    await seedDoc(PLAIN);
    const { gate } = await setup(project);
    await mkdir(path.join(project.root, 'elsewhere'), { recursive: true });
    await writeFile(path.join(project.root, 'elsewhere', path.basename(REQ)), forge(PLAIN));
    await rm(path.join(project.root, path.dirname(REQ)), { recursive: true });
    await symlink(path.join(project.root, 'elsewhere'), path.join(project.root, path.dirname(REQ)));

    const outcome = await gate.check();

    expect(outcome.kind).toBe('retry');
    expect(gate.checks.find((entry) => entry.name === 'manual-verification')).toMatchObject({ ok: false, detail: expect.stringContaining('상위 폴더') });
  });

  it('바뀐 것이 전혀 없으면 예전처럼 검증 없이 통과한다', async () => {
    await seedDoc(PLAIN);
    const { gate } = await setup(project);

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(gate.verified).toBe(false);
  });

  it('가볍게 확인(light)에서도 같은 검사로 막는다', async () => {
    await seedDoc(PLAIN);
    const { gate, workspace } = await setup(project, { verify: 'light' });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    await workspace.write(REQ, forge(PLAIN));

    const outcome = await gate.check();

    expect(outcome.kind).toBe('retry');
    expect(gate.verified).toBe(false);
    expect(gate.checks.find((entry) => entry.name === 'manual-verification')).toMatchObject({ ok: false });
  });

  it('재시도 상한까지 못 고치면 사유에 사람 확인 기록을 적고 중단한다', async () => {
    await seedDoc(PLAIN);
    const { gate, workspace } = await setup(project, { restarts: [true, true, true, true] });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    await workspace.write(REQ, forge(PLAIN));

    expect((await gate.check()).kind).toBe('retry');
    expect((await gate.check()).kind).toBe('retry');
    const last = await gate.check();

    expect(last.kind).toBe('exhausted');
    expect(last.kind === 'exhausted' && last.summary).toContain('사람 확인');
  });

  it('사람 확인을 지우면 막지 않고 manual-verification-removed 검사로 남긴다', async () => {
    await seedDoc(forge(PLAIN));
    const { gate, workspace } = await setup(project);
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
    await workspace.write(REQ, PLAIN);

    expect(await gate.check()).toEqual({ kind: 'pass' });
    expect(gate.checks.find((entry) => entry.name === 'manual-verification-removed')).toMatchObject({ ok: true, stage: 'review' });
  });
});
