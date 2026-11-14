import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Sandbox } from '@b-studio/sandbox';
import { SPEC_FILE, SpecError, type AutoPageChecks, type LoadedProject, type WorkflowPageCheck, type WorkflowSpec } from '@b-studio/spec';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VerificationGate, type PageFetcher } from './gate';
import { legacyCheck } from './gate-legacy';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT } from './test-helpers';
import { StaticShadowUnknownError } from './next-static-shadow';
import { Workspace } from './workspace';

/**
 * 게이트의 자동 화면 고르기(`#autoPages`와 그 아래: 실행 중 sample 값 받기·고정 경로 가림 확인·밀려난 화면 되살리기·import 따라가기·동적 기본값·선언과 겹침·이름·건너뜀 check)를
 * Rust로 옮기면서(ADR-195 4f A5c-2) 옛 구현(`auto-pages-legacy.ts`를 부르는 `gate-legacy.ts`)과 지금 구현(`VerificationGate.check`)에 **같은 시나리오**를 넣어 견준다.
 * 시나리오마다 임시 폴더에 프로젝트를 새로 만들고(도커·네트워크 없음, 가짜 sandbox·가짜 요청) 옛 쪽과 지금 쪽이 각자의 세계에서 돈다.
 * 견주는 것: ① check 결과 ② 이벤트 전체 ③ 게이트의 공개 상태(`checks` 등: 자동 페이지의 이름·건너뜀 사유가 들어 있다) ④ sandbox·요청 호출 기록(순서와 인자).
 * 파일 시스템을 읽는 `findStaticShadows`·`collectImportGraph`는 진짜(임시 폴더)를 쓰거나, 실패를 만들 때만 가짜로 바꿔 끼운다.
 */

const fakes = vi.hoisted(() => ({
  collect: undefined as undefined | ((...args: unknown[]) => unknown),
  shadows: undefined as undefined | ((...args: unknown[]) => unknown),
  shadowCalls: [] as string[],
  collectCalls: [] as string[],
}));
vi.mock('./import-graph', async (original) => {
  const actual = await original<typeof import('./import-graph')>();
  return {
    ...actual,
    collectImportGraph: (...args: Parameters<typeof actual.collectImportGraph>) => {
      fakes.collectCalls.push(String(args[1]));
      return (fakes.collect ?? actual.collectImportGraph)(...args);
    },
  };
});
vi.mock('./next-static-shadow', async (original) => {
  const actual = await original<typeof import('./next-static-shadow')>();
  return {
    ...actual,
    findStaticShadows: (...args: Parameters<typeof actual.findStaticShadows>) => {
      const input = args[0];
      fakes.shadowCalls.push(JSON.stringify({ servicePath: input.servicePath, pageFile: input.pageFile, values: input.values, check: [...input.check] }));
      return (fakes.shadows ?? actual.findStaticShadows)(...args);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  fakes.collect = undefined;
  fakes.shadows = undefined;
  fakes.shadowCalls.length = 0;
  fakes.collectCalls.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Mode = 'legacy' | 'current';
type Fetched = { status: number; text: string };

interface Setup {
  /** autoPageChecks와 그 밖의 workflow. `auto`가 시작 때의 autoPageChecks다(service는 `web`) */
  auto?: Partial<AutoPageChecks> | null;
  workflow?: Partial<WorkflowSpec>;
  /** 실행 중에 다시 읽은 설정(`reloadProject`). 던지면 읽기 실패다 */
  reload?: () => unknown;
  endpoint?: (service: string) => string | Promise<string>;
  redact?: (text: string) => string;
  page?: PageFetcher;
  /** 만들 때 미리 심는 파일(바뀐 파일로 세지 않는다): 고정 경로·기존 소스 */
  seed?: Record<string, string>;
  /** 'web' 서비스의 경로(기본 web) */
  servicePath?: string;
  /** 'web'을 관리형 서비스로 두지 않는다 */
  noWeb?: boolean;
  onEvent?: (event: AgentEvent) => void;
}

interface Trace {
  label: string;
  result: { outcome: unknown } | { threw: { name: string; message: string } };
  events: string[];
  state: unknown;
  text: string;
}

interface World {
  root: string;
  calls: string[];
  write(file: string, content: string): Promise<void>;
  run(label: string): Promise<void>;
}

/** 서비스 확인이 읽어도 형식 오류가 아닌 studio.yaml(web은 관리형 Next.js 서비스) */
const VALID_SPEC = 'version: 1\nname: orders\nservices:\n  web: { source: managed, template: nextjs, path: web, port: 3000, preview: browser }\n';

const OK_PAGE: Fetched = { status: 200, text: '<h1>주문 목록</h1>' };

async function createWorld(mode: Mode, setup: Setup, traces: Trace[]): Promise<World> {
  const base = await createOrdersProject('auto-pages-diff-');
  roots.push(base.root);
  const { root } = base;
  const servicePath = setup.servicePath ?? 'web';
  const autoPageChecks = setup.auto === null ? undefined : { service: 'web', mode: 'http', expectStatus: 200, maxPages: 5, ...setup.auto };
  const workflow = { ...(autoPageChecks ? { autoPageChecks } : {}), ...setup.workflow } as Partial<WorkflowSpec>;
  let project = { ...base, spec: { ...base.spec, workflow } } as unknown as LoadedProject;
  if (!setup.noWeb) {
    project = { ...project, managed: [...project.managed, ['web', { source: 'managed', template: 'nextjs', path: servicePath, port: 3000, preview: 'browser' }]] } as unknown as LoadedProject;
  }
  await writeFile(path.join(root, SPEC_FILE), VALID_SPEC);
  await writeFile(path.join(root, 'compose.yaml'), 'services:\n  api: { build: ./api }\n  web: { build: ./web }\n');
  for (const [file, content] of Object.entries(setup.seed ?? {})) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }

  const calls: string[] = [];
  const sandbox: Sandbox = fakeSandbox(project, []);
  sandbox.endpoint = async (service: string) => {
    calls.push(`endpoint:${service}`);
    return { service, containerPort: 8080, url: setup.endpoint ? await setup.endpoint(service) : 'http://127.0.0.1:1' };
  };
  sandbox.redact = (text: string) => {
    calls.push(`redact:${JSON.stringify(text)}`);
    return setup.redact ? setup.redact(text) : text;
  };
  const workspace = new Workspace(root);
  const events: string[] = [];
  const gate = await VerificationGate.create({
    project,
    sandbox,
    workspace,
    allowBreaking: false,
    maxVerifyAttempts: 3,
    platformRetryDelayMs: 1,
    fetcher: async () => ORDERS_CONTRACT,
    pageFetcher: async (url, signal) => {
      calls.push(`page:${url}`);
      return setup.page ? setup.page(url, signal) : OK_PAGE;
    },
    ...(setup.reload
      ? {
          reloadProject: async () => {
            calls.push('reload');
            return setup.reload!() as LoadedProject;
          },
        }
      : {}),
    onEvent: (event) => {
      events.push(JSON.stringify(event));
      setup.onEvent?.(event);
    },
  });

  return {
    root,
    calls,
    write: (file, content) => workspace.write(file, content),
    async run(label) {
      events.length = 0;
      let result: Trace['result'];
      try {
        const outcome = mode === 'legacy' ? await legacyCheck(gate) : await gate.check();
        result = { outcome };
      } catch (error) {
        result = { threw: { name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) } };
      }
      const state = {
        attempts: gate.attempts,
        checks: gate.checks,
        passedStages: [...gate.passedStages].sort(),
        skippedStages: gate.skippedStages,
        verified: gate.verified,
        platformFailure: gate.platformFailure,
        lastOutcome: gate.lastOutcome,
      };
      const text = JSON.stringify({ label, result, events: [...events], state }).replaceAll(root, '<R>');
      traces.push({ ...(JSON.parse(text) as Omit<Trace, 'text'>), text });
    },
  };
}

async function runWorld(mode: Mode, makeSetup: () => Setup, steps: (world: World) => Promise<void>) {
  const traces: Trace[] = [];
  fakes.shadowCalls.length = 0;
  fakes.collectCalls.length = 0;
  const world = await createWorld(mode, makeSetup(), traces);
  await steps(world);
  return { traces, texts: traces.map((trace) => trace.text), calls: world.calls, shadowCalls: [...fakes.shadowCalls], collectCalls: [...fakes.collectCalls] };
}

/** 같은 시나리오를 옛 구현과 지금 구현에 넣어 견주고, 옛 구현의 결과를 돌려준다. 자동 페이지는 둘 이상이면 동시에 돈다 — 호출은 정렬해 견준다 */
async function compare(makeSetup: () => Setup, steps: (world: World) => Promise<void>) {
  const legacy = await runWorld('legacy', makeSetup, steps);
  const current = await runWorld('current', makeSetup, steps);
  expect(current.texts).toEqual(legacy.texts);
  expect([...current.calls].sort()).toEqual([...legacy.calls].sort());
  // 자동 페이지를 고르는 동안의 호출은 순서까지 같아야 한다(요청이 나가기 전 것: endpoint·reload·가림 확인·import 그래프)
  const beforePages = (calls: string[]) => calls.filter((call) => !call.startsWith('page:http://127.0.0.1:1/') || call.includes('/api/')).filter((call) => !call.startsWith('redact:'));
  expect(beforePages(current.calls).filter((call) => call === 'reload' || call.startsWith('endpoint:'))).toEqual(beforePages(legacy.calls).filter((call) => call === 'reload' || call.startsWith('endpoint:')));
  expect(current.shadowCalls).toEqual(legacy.shadowCalls);
  expect(current.collectCalls).toEqual(legacy.collectCalls);
  expect(legacy.traces.length).toBeGreaterThan(0);
  return legacy;
}

const PAGE = 'export default function Page() { return null; }\n';
const checksOf = (trace: Trace) => (trace.state as { checks: Array<Record<string, unknown>> }).checks;
const autoChecks = (trace: Trace) => checksOf(trace).filter((check) => check.stage === 'browser_check');
const names = (trace: Trace): string[] => autoChecks(trace).map((check) => String(check.name));
/** 열기로 한 자동 페이지(건너뜀 check 제외)의 이름 */
const opened = (trace: Trace): string[] => names(trace).filter((name) => !name.endsWith('(자동, 건너뜀)'));
const skippedDetails = (trace: Trace): string[] => autoChecks(trace).filter((check) => String(check.name).endsWith('(자동, 건너뜀)')).map((check) => String(check.detail));
const reloaded = (autoPageChecks: Record<string, unknown>) => () => ({ spec: { workflow: { autoPageChecks: { service: 'web', mode: 'http', expectStatus: 200, maxPages: 5, ...autoPageChecks } } } });
const page = (over: Partial<WorkflowPageCheck> = {}): WorkflowPageCheck =>
  ({ service: 'web', path: '/orders', mode: 'http', expectStatus: 200, allowConsoleErrors: false, noHorizontalScroll: false, ...over }) as WorkflowPageCheck;
const writes = (files: Record<string, string>, label = 'auto') => async (w: World) => {
  for (const [file, content] of Object.entries(files)) await w.write(file, content);
  await w.run(label);
};
const json = (value: unknown): Fetched => ({ status: 200, text: JSON.stringify(value) });
const urlPage = (handler: (url: string) => Fetched): PageFetcher => async (url) => handler(url);

describe('설정과 관리형 서비스', () => {
  it('autoPageChecks가 없으면 자동 페이지를 고르지 않는다', async () => {
    const out = await compare(() => ({ auto: null }), writes({ 'web/app/orders/page.tsx': PAGE }));
    expect(autoChecks(out.traces[0]!)).toEqual([]);
  });

  it('autoPageChecks.service가 관리형 서비스가 아니면 건너뜀 check로 이유를 남긴다', async () => {
    const out = await compare(() => ({ auto: { service: 'ghost' } }), writes({ 'web/app/orders/page.tsx': PAGE }));
    expect(names(out.traces[0]!)).toEqual(['ghost ghost (자동, 건너뜀)']);
    expect(skippedDetails(out.traces[0]!)).toEqual(["autoPageChecks.service 'ghost'를 이 프로젝트의 관리형 서비스에서 찾지 못했습니다"]);
  });

  it('바뀐 파일이 없으면 열 페이지도 건너뜀도 없다', async () => {
    const out = await compare(() => ({}), writes({ 'api/src/Order.java': 'class Order {}\n' }));
    expect(autoChecks(out.traces[0]!)).toEqual([]);
  });
});

describe('바뀐 페이지와 import 따라가기', () => {
  it('바뀐 page 파일만 열고 이름에 cause를 붙이지 않는다', async () => {
    const out = await compare(() => ({}), writes({ 'web/app/orders/page.tsx': PAGE, 'web/app/page.tsx': PAGE }));
    expect(names(out.traces[0]!).sort()).toEqual(['web / (자동)', 'web /orders (자동)']);
  });

  it('바뀐 컴포넌트를 import하는 page를 찾아 열고 이름에 바뀐 파일을 적는다', async () => {
    const out = await compare(
      () => ({ seed: { 'web/app/orders/page.tsx': "import List from '../../components/List';\nexport default function Page() { return null; }\n" } }),
      writes({ 'web/components/List.tsx': 'export default function List() { return null; }\n' }),
    );
    expect(names(out.traces[0]!)).toEqual(['web /orders (자동 · List.tsx 변경)']);
    expect(out.collectCalls).toEqual(['web']);
  });

  it('바뀐 소스가 전부 page 파일이면 import 그래프를 읽지 않는다', async () => {
    const out = await compare(() => ({}), writes({ 'web/app/a/page.tsx': PAGE, 'web/app/b/page.tsx': PAGE }));
    expect(out.collectCalls).toEqual([]);
  });

  it('followImports가 꺼져 있으면 바뀐 컴포넌트만으로는 아무것도 열지 않는다', async () => {
    const out = await compare(
      () => ({ auto: { followImports: false }, seed: { 'web/app/orders/page.tsx': "import List from '../../components/List';\nexport default function Page() { return null; }\n" } }),
      writes({ 'web/components/List.tsx': 'export default function List() { return null; }\n' }),
    );
    expect(out.collectCalls).toEqual([]);
    expect(autoChecks(out.traces[0]!)).toEqual([]);
  });

  it('서비스 폴더 밖 파일이나 소스가 아닌 파일은 따라가지 않는다', async () => {
    const out = await compare(() => ({}), writes({ 'docs/readme.md': '# x\n', 'web/public/logo.png': 'x', 'api/src/Order.java': 'class Order {}\n', 'docs/Widget.tsx': 'export default function W() { return null; }\n', 'web2/components/Other.tsx': 'export default function O() { return null; }\n' }));
    expect(out.collectCalls).toEqual([]);
  });

  it('서비스 경로가 ./ 로 시작하거나 끝에 슬래시가 여러 개여도 같게 본다', async () => {
    for (const servicePath of ['./web', 'web//', 'web\\']) {
      const out = await compare(
        () => ({ servicePath, seed: { 'web/app/orders/page.tsx': "import List from '../../components/List';\nexport default function Page() { return null; }\n" } }),
        writes({ 'web/components/List.tsx': 'export default function List() { return null; }\n' }),
      );
      expect(out.traces.length).toBe(1);
    }
  });

  it('import 사슬이 깊이 상한(5)을 넘으면 멈춘 곳을 건너뜀 check로 남긴다', async () => {
    const seed: Record<string, string> = { 'web/app/orders/page.tsx': "import X from '../../c6';\nexport default function Page() { return null; }\n" };
    for (let i = 1; i <= 6; i += 1) seed[`web/c${i}.tsx`] = `import X from './c${i - 1}';\nexport default X;\n`;
    const out = await compare(() => ({ seed }), writes({ 'web/c0.tsx': 'export default function C() { return null; }\n' }));
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('깊이 상한'))).toBe(true);
  });

  it('그래프가 상한에 걸려 일부만 만들어졌으면 이유를 건너뜀 check로 남긴다', async () => {
    fakes.collect = async () => ({ files: new Set(['app/orders/page.tsx', 'c0.tsx']), reverse: new Map([['c0.tsx', new Set(['app/orders/page.tsx'])]]), readCount: 7, elapsedMs: 12, incomplete: '파일 수 상한(800)을 넘었습니다' });
    const out = await compare(() => ({}), writes({ 'web/c0.tsx': 'export default function C() { return null; }\n' }));
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('(읽은 파일 7개, 12ms)'))).toBe(true);
    expect(opened(out.traces[0]!)).toEqual(['web /orders (자동 · c0.tsx 변경)']);
  });

  it('그래프를 만들다 실패하면 바뀐 page만으로 계속하고 사유를 남긴다(Error와 Error가 아닌 값)', async () => {
    for (const thrown of [new Error('읽기 실패 😀'), 'str', { toString: () => '객체' }]) {
      fakes.collect = async () => {
        throw thrown;
      };
      const out = await compare(() => ({}), writes({ 'web/app/orders/page.tsx': PAGE, 'web/c0.tsx': 'export default function C() { return null; }\n' }));
      expect(opened(out.traces[0]!).some((name) => name.startsWith('web /orders (자동'))).toBe(true);
      expect(skippedDetails(out.traces[0]!).some((detail) => detail.startsWith('import 역추적에 실패해'))).toBe(true);
    }
  });

  it('maxPages를 넘은 page는 건너뜀 check로 남는다', async () => {
    const out = await compare(() => ({ auto: { maxPages: 1 } }), writes({ 'web/app/a/page.tsx': PAGE, 'web/app/b/page.tsx': PAGE }));
    expect(autoChecks(out.traces[0]!).length).toBe(2);
  });
});

describe('동적 경로의 기본값', () => {
  const dynamic = { 'web/app/orders/[id]/page.tsx': PAGE };

  it('기본값 1로 채워 열고 이름에 id 추정을 표시한다', async () => {
    const out = await compare(() => ({}), writes(dynamic));
    expect(names(out.traces[0]!)).toEqual(['web /orders/1 (자동, id 추정 · page.tsx 변경)'.replace(' · page.tsx 변경', '')]);
  });

  it('dynamicRouteProbe가 꺼져 있으면 동적 경로를 건너뛴다', async () => {
    const out = await compare(() => ({ auto: { dynamicRouteProbe: false } }), writes(dynamic));
    expect(skippedDetails(out.traces[0]!).length).toBe(1);
  });

  it('sampleIdFrom이 있으면 api 값을 받아 쓴다(문자열·숫자)', async () => {
    for (const body of [{ id: 'abc-9' }, { id: 42 }, { id: -5 }, { id: 'ABC_def-0' }, { items: [{ id: 7 }] }]) {
      const out = await compare(
        () => ({ auto: { sampleIdFrom: { service: 'api', path: '/api/orders', jsonPath: 'items' in body ? '$.items[0].id' : '$.id' } }, page: urlPage((url) => (url.includes('/api/orders') ? json(body) : OK_PAGE)) }),
        writes(dynamic),
      );
      expect(out.traces.length).toBe(1);
    }
  });

  it('api 값을 받지 못하면(출처 밖·HTTP 오류·값 없음·안전하지 않은 값·예외) 기본값으로 물러난다', async () => {
    const from = { service: 'api', path: '/api/orders', jsonPath: '$.id' };
    const cases: Array<[string, Setup]> = [
      ['출처 밖', { auto: { sampleIdFrom: { ...from, path: 'http://evil.example/x' } } }],
      ['HTTP 오류', { auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? { status: 500, text: '{"id":"x"}' } : OK_PAGE)) }],
      ['HTTP 3xx', { auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? { status: 301, text: '{"id":"x"}' } : OK_PAGE)) }],
      ['값 없음', { auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? json({}) : OK_PAGE)) }],
      ['JSON 아님', { auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? { status: 200, text: 'not json' } : OK_PAGE)) }],
      ['슬래시 포함', { auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? json({ id: 'a/b' }) : OK_PAGE)) }],
      ['공백 포함', { auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? json({ id: 'a b' }) : OK_PAGE)) }],
      ['빈 글자', { auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? json({ id: '' }) : OK_PAGE)) }],
      ['65자', { auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? json({ id: 'a'.repeat(65) }) : OK_PAGE)) }],
      ['소수', { auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? json({ id: 0.5 }) : OK_PAGE)) }],
      ['큰 수', { auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? json({ id: 1e21 }) : OK_PAGE)) }],
      ['객체', { auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? json({ id: { a: 1 } }) : OK_PAGE)) }],
      ['불리언', { auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? json({ id: true }) : OK_PAGE)) }],
      ['개행으로 끝남', { auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? json({ id: 'abc\n' }) : OK_PAGE)) }],
      ['전각 숫자', { auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? json({ id: '１２' }) : OK_PAGE)) }],
      ['아랍 숫자', { auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? json({ id: '٣' }) : OK_PAGE)) }],
      ['페이지 요청 예외', { auto: { sampleIdFrom: from }, page: (url) => (url.includes('/api/orders') ? Promise.reject(new Error('연결 끊김')) : Promise.resolve(OK_PAGE)) }],
    ];
    // endpoint는 서비스 확인도 부른다. 확인이 끝난 뒤(verify_result)부터 실패하게 해 자동 화면 고르기의 호출만 겨눈다
    const afterVerify = (broken: (service: string) => string | Promise<string>): (() => Setup) => () => {
      let armed = false;
      return {
        auto: { sampleIdFrom: from },
        onEvent: (event) => {
          if (event.type === 'verify_result') armed = true;
        },
        endpoint: (service) => (armed && service === 'api' ? broken(service) : 'http://127.0.0.1:1'),
      };
    };
    const lateCases: Array<[string, () => Setup]> = [
      ['endpoint 예외', afterVerify(() => Promise.reject(new Error('endpoint 실패')))],
      ['endpoint 주소가 깨짐', afterVerify(() => 'not a url')],
    ];
    for (const [label, makeSetup] of lateCases) {
      const out = await compare(makeSetup, writes(dynamic));
      expect(opened(out.traces[0]!), label).toEqual(['web /orders/1 (자동, id 추정)']);
    }
    for (const [label, setup] of cases) {
      const out = await compare(() => setup, writes(dynamic));
      expect(opened(out.traces[0]!), label).toEqual(['web /orders/1 (자동, id 추정)']);
    }
  });

  it('값이 안전한 문자 64자 경계면 받는다', async () => {
    const from = { service: 'api', path: '/api/orders', jsonPath: '$.id' };
    for (const id of ['a'.repeat(64), 'a', '_', '-', '0']) {
      const out = await compare(() => ({ auto: { sampleIdFrom: from }, page: urlPage((url) => (url.includes('/api/orders') ? json({ id }) : OK_PAGE)) }), writes(dynamic));
      expect(names(out.traces[0]!)[0]).toContain(`/orders/${id} (자동, id 추정)`);
    }
  });

  it('시작 때의 sampleParams로 연 화면은 추정이 아니라 엄격하게 본다', async () => {
    const out = await compare(() => ({ auto: { sampleParams: { id: '7' } } }), writes(dynamic));
    expect(opened(out.traces[0]!)).toEqual(['web /orders/7 (자동)']);
  });
});

describe('실행 중 sampleParams', () => {
  const dynamic = { 'web/app/orders/[id]/page.tsx': PAGE };

  it('안전한 값은 받아 이번 실행에서 바로 반영하고 알린다', async () => {
    const out = await compare(() => ({ reload: reloaded({ sampleParams: { id: '999001' } }) }), writes(dynamic));
    expect(names(out.traces[0]!).some((name) => name === 'web /orders/999001 (자동)')).toBe(true);
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('바로 반영했습니다'))).toBe(true);
  });

  it('경로 조각으로 쓸 수 없는 값·키는 받지 않고 거절 안내를 남긴다', async () => {
    const bad = {
      'a/b': 'x',
      'x.y': '1',
      id: 'a b',
      n: 5,
      e: '',
      long: 'a'.repeat(65),
      acc: 'é',
      full: '１２',
      arabic: '٣',
      nl: 'abc\n',
      pct: '%2e',
      dots: '..',
      lone: '\ud800',
      [`k\ud83d`]: 'v',
    };
    const out = await compare(() => ({ reload: reloaded({ sampleParams: bad }) }), writes(dynamic));
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('경로 조각으로 쓸 수 없는 값'))).toBe(true);
  });

  it('안전한 값의 경계(64자·_·-)와 숫자 키는 받고 JS 객체 순서(정수 키가 먼저)로 알린다', async () => {
    const good = { zeta: 'z'.repeat(64), '10': 'ten', '2': 'two', a_b: '-', 'c-d': '_', id: '0' };
    const out = await compare(() => ({ reload: reloaded({ sampleParams: good }) }), writes({ ...dynamic, 'web/app/[10]/[2]/page.tsx': PAGE }));
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('바로 반영했습니다'))).toBe(true);
  });

  it('받은 값과 거절한 값이 섞이면 둘 다 알린다', async () => {
    const out = await compare(() => ({ reload: reloaded({ sampleParams: { id: '1234', slug: 'a/b' } }) }), writes(dynamic));
    expect(skippedDetails(out.traces[0]!).length).toBeGreaterThanOrEqual(2);
  });

  it('시작 때와 같은 값은 바뀐 것으로 세지 않는다', async () => {
    const out = await compare(() => ({ auto: { sampleParams: { id: '7' } }, reload: reloaded({ sampleParams: { id: '7' } }) }), writes(dynamic));
    expect(skippedDetails(out.traces[0]!)).toEqual([]);
  });

  it('시작 때의 값을 덮어쓰면 받고, 시작 때의 다른 키는 남긴다', async () => {
    const out = await compare(
      () => ({ auto: { sampleParams: { id: '7', slug: 'abc' } }, reload: reloaded({ sampleParams: { id: '8', slug: 'abc' } }) }),
      writes({ ...dynamic, 'web/app/p/[slug]/page.tsx': PAGE }),
    );
    expect(names(out.traces[0]!).some((name) => name.startsWith('web /orders/8'))).toBe(true);
  });

  it('값을 지운 것(sampleParams 없음)은 바뀐 것으로 세지 않는다', async () => {
    const out = await compare(() => ({ auto: { sampleParams: { id: '7' } }, reload: reloaded({}) }), writes(dynamic));
    expect(opened(out.traces[0]!)).toEqual(['web /orders/7 (자동)']);
  });

  it('다시 읽은 설정에 autoPageChecks가 없으면 시작 때의 설정으로 간다', async () => {
    const out = await compare(() => ({ reload: () => ({ spec: { workflow: {} } }) }), writes(dynamic));
    expect(skippedDetails(out.traces[0]!)).toEqual([]);
  });

  it('값이 문자열이 아니면 받지 않는다', async () => {
    const out = await compare(() => ({ reload: reloaded({ sampleParams: { id: 5, other: null, flag: true } }) }), writes(dynamic));
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('쓸 수 없는 값'))).toBe(true);
  });
});

describe('실행 중 sampleIdFrom', () => {
  const dynamic = { 'web/app/orders/[id]/page.tsx': PAGE };
  const from = { service: 'api', path: '/api/orders', jsonPath: '$.id' };
  const idPage = (id: unknown) => urlPage((url) => (url.includes('/api/orders') ? json({ id }) : OK_PAGE));

  it('관리형 서비스를 가리키면 받아 그 값으로 id를 추정한다', async () => {
    const out = await compare(() => ({ reload: reloaded({ sampleIdFrom: from }), page: idPage('live-7') }), writes(dynamic));
    expect(names(out.traces[0]!).some((name) => name === 'web /orders/live-7 (자동, id 추정)')).toBe(true);
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('sampleIdFrom(api /api/orders)'))).toBe(true);
  });

  it('관리형 서비스가 아니면 받지 않고 알린다', async () => {
    const out = await compare(() => ({ reload: reloaded({ sampleIdFrom: { ...from, service: 'ghost' } }), page: idPage('live-7') }), writes(dynamic));
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes("'ghost'은(는) 이 프로젝트의 관리형 서비스가 아니라"))).toBe(true);
    expect(opened(out.traces[0]!)).toEqual(['web /orders/1 (자동, id 추정)']);
  });

  it('시작 때 dynamicRouteProbe가 꺼져 있으면 받지 않는다', async () => {
    const out = await compare(() => ({ auto: { dynamicRouteProbe: false }, reload: reloaded({ sampleIdFrom: from }), page: idPage('live-7') }), writes(dynamic));
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('dynamicRouteProbe가 실행을 시작할 때 꺼져 있어'))).toBe(true);
  });

  it('시작 때와 같은 sampleIdFrom은 바뀐 것으로 세지 않지만 키 순서만 달라도 바뀐 것이다(JSON 글자 비교)', async () => {
    const same = await compare(() => ({ auto: { sampleIdFrom: from }, reload: reloaded({ sampleIdFrom: { ...from } }), page: idPage('live-7') }), writes(dynamic));
    expect(skippedDetails(same.traces[0]!)).toEqual([]);
    const reordered = { jsonPath: '$.id', path: '/api/orders', service: 'api' };
    const out = await compare(() => ({ auto: { sampleIdFrom: from }, reload: reloaded({ sampleIdFrom: reordered }), page: idPage('live-7') }), writes(dynamic));
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('sampleIdFrom(api /api/orders)'))).toBe(true);
  });

  it('받은 값이 안전하지 않으면 기본값으로 물러난다', async () => {
    const out = await compare(() => ({ reload: reloaded({ sampleIdFrom: from }), page: idPage('a/b') }), writes(dynamic));
    expect(opened(out.traces[0]!)).toEqual(['web /orders/1 (자동, id 추정)']);
  });

  it('sampleParams와 sampleIdFrom을 함께 바꿔도 각각 따로 받는다', async () => {
    const out = await compare(() => ({ reload: reloaded({ sampleParams: { slug: 'abc' }, sampleIdFrom: from }), page: idPage('live-7') }), writes({ ...dynamic, 'web/app/p/[slug]/page.tsx': PAGE }));
    expect(opened(out.traces[0]!).length).toBe(2);
  });
});

describe('studio.yaml 다시 읽기', () => {
  const dynamic = { 'web/app/orders/[id]/page.tsx': PAGE };

  it('형식 오류(SpecError)는 항목을 가려서 알리고 시작 때의 설정으로 간다', async () => {
    const out = await compare(
      () => ({
        reload: () => {
          throw new SpecError('studio.yaml 형식 오류', ['workflow.autoPageChecks.sampleParams.id: 안 됩니다', '두 번째 항목']);
        },
        redact: (text) => text.replaceAll('안 됩니다', '[가림]'),
      }),
      writes(dynamic),
    );
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('[가림]'))).toBe(true);
  });

  it('그 밖의 오류는 문구를 싣지 않는다', async () => {
    const out = await compare(
      () => ({
        reload: () => {
          throw new Error('비밀 경로 /etc/passwd 의 내용');
        },
      }),
      writes(dynamic),
    );
    expect(skippedDetails(out.traces[0]!).every((detail) => !detail.includes('/etc/passwd'))).toBe(true);
    expect(skippedDetails(out.traces[0]!).length).toBe(1);
  });

  it('reloadProject가 없고 studio.yaml이 바뀌지 않았으면 읽지 않는다', async () => {
    const out = await compare(() => ({}), writes(dynamic));
    expect(skippedDetails(out.traces[0]!)).toEqual([]);
  });

  it('reloadProject가 없고 studio.yaml이 바뀌었으면 디스크에서 읽는다(형식이 맞으면 시작 때의 설정으로 간다)', async () => {
    const out = await compare(() => ({}), writes({ [SPEC_FILE]: VALID_SPEC, ...dynamic }));
    expect(out.traces.length).toBe(1);
  });

  it('studio.yaml이 일반 파일이 아니면(링크) 읽지 않고 이유를 남긴다', async () => {
    const out = await compare(
      () => ({}),
      async (w) => {
        await w.write(SPEC_FILE, VALID_SPEC);
        await w.write('web/app/orders/[id]/page.tsx', PAGE);
        await writeFile(path.join(w.root, 'elsewhere.yaml'), VALID_SPEC);
        await rm(path.join(w.root, SPEC_FILE));
        await symlink(path.join(w.root, 'elsewhere.yaml'), path.join(w.root, SPEC_FILE));
        await w.run('link');
      },
    );
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('일반 파일로 읽을 수 없어'))).toBe(true);
  });
});

describe('고정 경로 가림 확인', () => {
  const dynamic = { 'web/app/orders/[id]/page.tsx': PAGE };
  const sibling = { 'web/app/orders/new/page.tsx': PAGE };

  it('실행 중 값이 다른 고정 경로와 겹치면 받지 않고 시작 때의 값으로 연다', async () => {
    const out = await compare(() => ({ seed: sibling, reload: reloaded({ sampleParams: { id: 'new' } }) }), writes(dynamic));
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('먼저 받아 그 화면이 대신 열립니다'))).toBe(true);
    expect(names(out.traces[0]!).some((name) => name.includes('/orders/new'))).toBe(false);
    expect(out.shadowCalls.length).toBe(1);
  });

  it('겹치는 값과 겹치지 않는 값이 함께 오면 겹치는 것만 되돌린다', async () => {
    const out = await compare(
      () => ({ seed: sibling, reload: reloaded({ sampleParams: { id: 'new', slug: 'abc' } }) }),
      writes({ ...dynamic, 'web/app/p/[slug]/page.tsx': PAGE }),
    );
    expect(names(out.traces[0]!).some((name) => name.includes('/p/abc'))).toBe(true);
  });

  it('시작 때 값이 있던 키를 겹치는 값으로 바꾸면 시작 때의 값으로 되돌린다', async () => {
    const out = await compare(() => ({ seed: sibling, auto: { sampleParams: { id: '7' } }, reload: reloaded({ sampleParams: { id: 'new' } }) }), writes(dynamic));
    expect(opened(out.traces[0]!)).toEqual(['web /orders/7 (자동)']);
  });

  it('public 파일과 같은 주소도 겹침이다', async () => {
    const out = await compare(() => ({ seed: { 'web/public/orders/new': 'x' }, reload: reloaded({ sampleParams: { id: 'new' } }) }), writes(dynamic));
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('고정 경로'))).toBe(true);
  });

  it('실행 중 sampleIdFrom으로 얻은 값이 고정 경로와 겹치면 받지 않는다', async () => {
    const out = await compare(
      () => ({
        seed: sibling,
        reload: reloaded({ sampleIdFrom: { service: 'api', path: '/api/orders', jsonPath: '$.id' } }),
        page: urlPage((url) => (url.includes('/api/orders') ? json({ id: 'new' }) : OK_PAGE)),
      }),
      writes(dynamic),
    );
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('sampleIdFrom으로 얻은 값(new)은 반영하지 않았습니다'))).toBe(true);
  });

  it('시작 때 sampleIdFrom이 있던 경우 겹치면 시작 때의 sampleIdFrom으로 되돌린다', async () => {
    const out = await compare(
      () => ({
        seed: sibling,
        auto: { sampleIdFrom: { service: 'api', path: '/api/start', jsonPath: '$.id' } },
        reload: reloaded({ sampleIdFrom: { service: 'api', path: '/api/orders', jsonPath: '$.id' } }),
        page: urlPage((url) => (url.includes('/api/orders') ? json({ id: 'new' }) : url.includes('/api/start') ? json({ id: 'start-1' }) : OK_PAGE)),
      }),
      writes(dynamic),
    );
    expect(names(out.traces[0]!).some((name) => name.includes('/orders/start-1'))).toBe(true);
  });

  it('끝까지 확인하지 못하면(알 수 없음 오류) 받지 않는다', async () => {
    fakes.shadows = async () => {
      throw new StaticShadowUnknownError('폴더가 너무 많습니다(2000개 상한)');
    };
    const out = await compare(() => ({ reload: reloaded({ sampleParams: { id: '555' } }) }), writes(dynamic));
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('확인하지 못했습니다(폴더가 너무 많습니다(2000개 상한))'))).toBe(true);
    expect(names(out.traces[0]!).some((name) => name.includes('/orders/555'))).toBe(false);
  });

  it('폴더를 읽다 다른 오류가 나도 받지 않는다', async () => {
    fakes.shadows = async () => {
      throw new Error('EACCES');
    };
    const out = await compare(() => ({ reload: reloaded({ sampleParams: { id: '555' } }) }), writes(dynamic));
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('(폴더를 읽지 못했습니다)'))).toBe(true);
  });

  it('겹침이 없으면 받는다', async () => {
    fakes.shadows = async () => [];
    const out = await compare(() => ({ reload: reloaded({ sampleParams: { id: '555' } }) }), writes(dynamic));
    expect(opened(out.traces[0]!)).toEqual(['web /orders/555 (자동)']);
  });

  it('겹침 확인은 실행 중 값을 쓰는 라우트에만 한다', async () => {
    const out = await compare(() => ({ seed: sibling, reload: reloaded({ sampleParams: { slug: 'abc' } }) }), writes({ ...dynamic, 'web/app/p/[slug]/page.tsx': PAGE, 'web/app/q/page.tsx': PAGE }));
    expect(out.shadowCalls.length).toBe(1);
  });

  it('두 라우트가 같은 키를 쓰는데 둘 다 겹치면 하나로 모아 알린다(이름이 열쇠)', async () => {
    fakes.shadows = async (...args) => {
      const input = args[0] as { check: Set<string>; values: Record<string, string> };
      return [...input.check].map((name) => ({ name, value: input.values[name], where: 'web/app/fixed' }));
    };
    const out = await compare(() => ({ reload: reloaded({ sampleParams: { id: 'abc' } }) }), writes({ 'web/app/a/[id]/page.tsx': PAGE, 'web/app/b/[id]/page.tsx': PAGE }));
    expect(skippedDetails(out.traces[0]!).filter((detail) => detail.includes('sampleParams.id=abc')).length).toBe(1);
  });

  it('이름이 sampleIdFrom인 세그먼트와 sampleIdFrom 값 겹침은 같은 열쇠다(옛 코드와 같게)', async () => {
    fakes.shadows = async (...args) => {
      const input = args[0] as { check: Set<string>; values: Record<string, string> };
      return [...input.check].map((name) => ({ name, value: input.values[name], where: 'web/app/fixed' }));
    };
    const out = await compare(
      () => ({
        reload: reloaded({ sampleParams: { sampleIdFrom: 'abc' }, sampleIdFrom: { service: 'api', path: '/api/orders', jsonPath: '$.id' } }),
        page: urlPage((url) => (url.includes('/api/orders') ? json({ id: 'live' }) : OK_PAGE)),
      }),
      writes({ 'web/app/a/[sampleIdFrom]/page.tsx': PAGE, 'web/app/b/[order_id]/page.tsx': PAGE }),
    );
    expect(out.traces.length).toBe(1);
  });
});

describe('밀려난 화면 되살리기', () => {
  /** 값이 바뀌면 경로 이름순이 달라져 `[id]` 화면이 maxPages 밖으로 밀리는 구성 */
  const crowded = { 'web/app/m/[id]/page.tsx': PAGE, 'web/app/m/b/page.tsx': PAGE, 'web/app/m/c/page.tsx': PAGE };

  it('실행 중 값 때문에 목록에서 빠진 화면을 시작 때의 값으로 되살려 연다', async () => {
    const out = await compare(() => ({ auto: { maxPages: 2 }, reload: reloaded({ maxPages: 2, sampleParams: { id: 'zzz' } }) }), writes(crowded));
    expect(names(out.traces[0]!).some((name) => name.startsWith('web /m/1 (자동, id 추정'))).toBe(true);
  });

  it('되살린 화면은 선언한 pageChecks와 같은 경로여도 건너뛴다', async () => {
    const out = await compare(
      () => ({ auto: { maxPages: 2 }, workflow: { pageChecks: [page({ path: '/m/1' })] }, reload: reloaded({ maxPages: 2, sampleParams: { id: 'zzz' } }) }),
      writes(crowded),
    );
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.includes('/m/1은(는) 이미 선언한 pageChecks에 있어 두 번 열지 않았습니다'))).toBe(true);
  });

  it('시작 때 sampleParams로 열었을 화면은 되살려도 엄격하게 본다', async () => {
    const out = await compare(
      () => ({ auto: { maxPages: 2, sampleParams: { id: '1' } }, reload: reloaded({ maxPages: 2, sampleParams: { id: 'zzz' } }) }),
      writes(crowded),
    );
    expect(names(out.traces[0]!).some((name) => name === 'web /m/1 (자동)')).toBe(true);
  });

  it('실행 중 sampleIdFrom이 이름순을 바꿔 화면이 밀려도 되살린다', async () => {
    const out = await compare(
      () => ({
        auto: { maxPages: 2 },
        reload: reloaded({ maxPages: 2, sampleIdFrom: { service: 'api', path: '/api/orders', jsonPath: '$.id' } }),
        page: urlPage((url) => (url.includes('/api/orders') ? json({ id: 'zzz' }) : OK_PAGE)),
      }),
      writes(crowded),
    );
    expect(names(out.traces[0]!).some((name) => name.startsWith('web /m/1 (자동, id 추정'))).toBe(true);
  });

  it('되살린 화면이 밀어낸 건너뜀 안내는 지운다', async () => {
    const out = await compare(() => ({ auto: { maxPages: 2 }, reload: reloaded({ maxPages: 2, sampleParams: { id: 'zzz' } }) }), writes(crowded));
    expect(skippedDetails(out.traces[0]!).every((detail) => !detail.includes('[id]'))).toBe(true);
  });

  it('두 파일이 같은 경로가 돼 하나가 빠져도 되살린다(값이 고정 경로 이름과 같아지는 경우는 가림 확인이 먼저 거른다)', async () => {
    const out = await compare(
      () => ({ reload: reloaded({ sampleParams: { id: 'b' } }), seed: {} }),
      writes({ 'web/app/m/[id]/page.tsx': PAGE, 'web/app/m/b/page.tsx': PAGE }),
    );
    expect(out.traces.length).toBe(1);
  });
});

describe('선언한 pageChecks와 겹침', () => {
  it('정적 경로가 선언과 같으면 건너뛰고 건너뜀 check를 남긴다', async () => {
    const out = await compare(() => ({ workflow: { pageChecks: [page({ path: '/orders' })] } }), writes({ 'web/app/orders/page.tsx': PAGE, 'web/app/page.tsx': PAGE }));
    expect(skippedDetails(out.traces[0]!)).toEqual(['/orders은(는) 이미 선언한 pageChecks에 있어 두 번 열지 않았습니다']);
  });

  it('다른 서비스의 선언과는 겹치지 않는다', async () => {
    const out = await compare(() => ({ workflow: { pageChecks: [page({ service: 'api', path: '/orders' })] } }), writes({ 'web/app/orders/page.tsx': PAGE }));
    expect(skippedDetails(out.traces[0]!)).toEqual([]);
  });

  it('실행 중 값으로 채운 동적 경로는 선언과 같아도 건너뛰지 않는다(선언한 느슨한 확인으로 바뀌지 않게)', async () => {
    const out = await compare(
      () => ({ workflow: { pageChecks: [page({ path: '/orders/999001', allowConsoleErrors: true })] }, reload: reloaded({ sampleParams: { id: '999001' } }) }),
      writes({ 'web/app/orders/[id]/page.tsx': PAGE }),
    );
    expect(names(out.traces[0]!).filter((name) => name === 'web /orders/999001 (자동)').length).toBe(1);
  });

  it('실행 중 sampleIdFrom으로 추정한 경로도 선언과 같아도 건너뛰지 않는다', async () => {
    const out = await compare(
      () => ({
        workflow: { pageChecks: [page({ path: '/orders/live-7' })] },
        reload: reloaded({ sampleIdFrom: { service: 'api', path: '/api/orders', jsonPath: '$.id' } }),
        page: urlPage((url) => (url.includes('/api/orders') ? json({ id: 'live-7' }) : OK_PAGE)),
      }),
      writes({ 'web/app/orders/[id]/page.tsx': PAGE }),
    );
    expect(names(out.traces[0]!).some((name) => name === 'web /orders/live-7 (자동, id 추정)')).toBe(true);
  });

  it('값과 무관한 동적 경로(시작 때 값)는 선언과 같으면 건너뛴다', async () => {
    const out = await compare(
      () => ({ workflow: { pageChecks: [page({ path: '/orders/1' })] }, reload: reloaded({ sampleParams: { slug: 'abc' } }) }),
      writes({ 'web/app/orders/[id]/page.tsx': PAGE, 'web/app/p/[slug]/page.tsx': PAGE }),
    );
    expect(skippedDetails(out.traces[0]!).some((detail) => detail.startsWith('/orders/1은(는) 이미 선언한'))).toBe(true);
  });
});

describe('이름과 건너뜀 순서', () => {
  it('건너뜀은 받아들인 안내·import 안내·라우트 안내·선언과 겹침 순서로 남는다', async () => {
    fakes.collect = async () => ({ files: new Set(['app/a/[id]/page.tsx', 'app/b/page.tsx', 'c0.tsx']), reverse: new Map([['c0.tsx', new Set(['app/a/[id]/page.tsx', 'app/b/page.tsx'])]]), readCount: 3, elapsedMs: 1, incomplete: '상한' });
    const out = await compare(
      () => ({ auto: { maxPages: 1 }, workflow: { pageChecks: [page({ path: '/b' })] }, reload: reloaded({ maxPages: 1, sampleParams: { id: '123', bad: 'a/b' } }) }),
      writes({ 'web/c0.tsx': 'export default function C() { return null; }\n' }),
    );
    expect(skippedDetails(out.traces[0]!).length).toBeGreaterThanOrEqual(3);
  });

  it('cause의 마지막 / 뒤만 이름에 쓴다(깊은 폴더, 유니코드)', async () => {
    fakes.collect = async () => ({ files: new Set(['app/한글/page.tsx', 'components/deep/이름 😀.tsx']), reverse: new Map([['components/deep/이름 😀.tsx', new Set(['app/한글/page.tsx'])]]), readCount: 2, elapsedMs: 1 });
    const out = await compare(() => ({}), writes({ 'web/components/deep/이름 😀.tsx': 'export default function C() { return null; }\n' }));
    expect(names(out.traces[0]!)).toEqual(['web /한글 (자동 · 이름 😀.tsx 변경)']);
  });

  it('page와 같은 이름이 둘이면 둘째에 번호가 붙는다(자동 이름 중복)', async () => {
    const out = await compare(() => ({ workflow: { pageChecks: [] } }), writes({ 'web/app/(a)/x/page.tsx': PAGE, 'web/app/(b)/x/page.tsx': PAGE }));
    expect(out.traces.length).toBe(1);
  });

  it('쓰이지 않은 sampleParams 값은 sampled로 표시하지 않는다(정적 경로)', async () => {
    const out = await compare(() => ({ auto: { sampleParams: { id: '7' } } }), writes({ 'web/app/orders/page.tsx': PAGE }));
    expect(names(out.traces[0]!)).toEqual(['web /orders (자동)']);
  });

  it('여러 세그먼트가 모두 sampleParams로 채워지면 sampled가 이름=값 목록이다', async () => {
    const out = await compare(() => ({ auto: { sampleParams: { id: '7', slug: 'abc' } }, page: urlPage(() => ({ status: 404, text: '' })) }), writes({ 'web/app/p/[slug]/[id]/page.tsx': PAGE }));
    expect(String(autoChecks(out.traces[0]!)[0]!.detail)).toContain('id=7');
  });

  it('추정한 id로 연 화면이 404를 돌려주면 안내를 붙이고 sampleParams로 연 화면은 엄격하다', async () => {
    const out = await compare(() => ({ page: urlPage(() => ({ status: 404, text: '' })) }), writes({ 'web/app/orders/[id]/page.tsx': PAGE }));
    expect(autoChecks(out.traces[0]!)[0]!.ok).toBe(false);
  });
});
