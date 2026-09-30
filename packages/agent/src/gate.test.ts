import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { ExecResult } from '@b-studio/sandbox';
import type { LoadedProject, WorkflowConcurrencyCheck, WorkflowPageCheck, WorkflowSpec } from '@b-studio/spec';
import { beforeEach, describe, expect, it } from 'vitest';
import { StepFailedError, type BrowserPageOptions, type BrowserPageResult, type BrowserRunner } from './browser-check';
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
  options: { restarts?: boolean[]; exec?: (command: string[]) => ExecResult; page?: PageFetcher; browser?: BrowserRunner; verify?: 'full' | 'light' } = {},
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
        blockedRequests: [],
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
        return { status: 200, text: '로딩', pageErrors: ['window.missing is undefined'], consoleErrors: ['hydration failed'], failedRequests: ['404 http://127.0.0.1:1/_next/static/chunk.js'], blockedRequests: [], horizontalOverflowPx: 510, steps: [] };
      },
      onEvent: () => {},
    });
    await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');

    const outcome = await gate.check();
    expect(seen).toEqual([{ url: 'http://127.0.0.1:1/orders', viewport: { width: 390, height: 844 } }]);
    expect(outcome.kind).toBe('retry');
    const feedback = outcome.kind === 'retry' ? outcome.feedback : '';
    expect(feedback).toContain('[browser_check] api /orders (browser 390x844)');
    for (const reason of ["렌더링된 화면에 '주문 목록'가 없습니다", '스크립트 예외: window.missing is undefined', 'console.error: hydration failed', '실패한 요청: 404 http://127.0.0.1:1/_next/static/chunk.js', '가로로 510px 넘칩니다']) {
      expect(feedback).toContain(reason);
    }
    expect(gate.passedStages.has('browser_check')).toBe(false);
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
        return { status: 200, text: '주문 목록', pageErrors: [], consoleErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 0, steps: [] };
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
          blockedRequests: [],
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
        blockedRequests: [],
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
    blockedRequests: [],
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
        return { status: 200, text: '주문 목록', pageErrors: [], consoleErrors: [], failedRequests: [], blockedRequests: ['http://evil.example/x'], horizontalOverflowPx: 0, steps: [] };
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
      blockedRequests: ['http://evil.example/a', 'http://evil.example/b'],
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
        return { status: 200, text: '주문 목록', pageErrors: [], consoleErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 0, steps: [], ...result };
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
    const rendered = { status: 200, text: '주문 목록\n홍길동', pageErrors: [], consoleErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 0, steps: [] };
    const passing = await apiGate(target, routingFetcher({ '/api/orders': { status: 200, text: JSON.stringify([{ customerName: '홍길동' }]) } }), rendered);
    expect(await passing.check()).toEqual({ kind: 'pass' });

    const failing = await apiGate(target, routingFetcher({ '/api/orders': { status: 200, text: JSON.stringify([{ customerName: '홍길동' }]) } }), { ...rendered, text: '주문 목록' });
    expect(failFeedback(await failing.check())).toContain("api의 $[0].customerName 값 '홍길동'이 /orders 화면에 없습니다");
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
    const rendered = { status: 200, text: '대시보드', pageErrors: [], consoleErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 0, steps: [] };
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
    const stuck = { status: 200, text: 'Loading...', pageErrors: [], consoleErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 0, steps: [] };
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
      blockedRequests: [],
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
    const stuck = { status: 200, text: '로딩 중입니다...', pageErrors: [], consoleErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 0, steps: [] };
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
