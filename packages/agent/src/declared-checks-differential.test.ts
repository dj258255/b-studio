import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeLoneSurrogates } from './lone-surrogates';
import { encodeLoneSurrogates, native, SandboxError, type ExecResult, type LoadRequest, type LoadResult, type Sandbox, type ServiceUsage } from '@b-studio/sandbox';
import { SPEC_FILE, type LoadedProject, type WorkflowConcurrencyCheck, type WorkflowLoadCheck, type WorkflowPageCheck, type WorkflowSpec, type WorkflowTest } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import type { BrowserPageResult, BrowserRunner } from './browser-check';
import { readJsonPath, VerificationGate, type PageFetcher, type ServiceRequest } from './gate';
import { Gen } from './differential-kit';
import { legacyCheck } from './gate-legacy';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT } from './test-helpers';
import { Workspace } from './workspace';

/**
 * 게이트의 선언한 검사 실행(`#runDeclaredChecks`와 그 아래: 이름 짓기·작업 그래프·테스트·동시 요청·부하·결과 조립)을 Rust로 옮기면서(ADR-195 4f A5b-2)
 * 옛 구현(`declared-legacy.ts`를 부르는 `gate-legacy.ts`)과 지금 구현(`VerificationGate.check`)에 **같은 시나리오**를 넣어 견준다.
 * 시나리오마다 임시 폴더에 프로젝트를 새로 만들고(도커·네트워크 없음, 가짜 sandbox·가짜 요청) 옛 쪽과 지금 쪽이 각자의 세계에서 돈다.
 * 견주는 것: ① check 결과(`GateOutcome` 또는 던진 오류의 종류·글) ② 이벤트 배열 전체(JSON 글, 키 순서 포함) ③ 게이트의 공개 상태(`checks`·`passedStages`·`platformFailure` 등)
 * ④ sandbox·요청·화면 호출 기록(순서와 인자). 동시에 도는 호출의 **시작 순서**는 같아야 하고, 그 뒤 끼어드는 순서는 견주지 않는다(시나리오가 호출을 한 줄로 만든다).
 */

const roots: string[] = [];

type Mode = 'legacy' | 'current';
type Fetched = { status: number; text: string };

interface Setup {
  workflow?: Partial<WorkflowSpec>;
  /** 'web'(nextjs) 서비스를 더한다. 자동 화면 확인용 */
  nextjs?: boolean;
  exec?: (command: string[], service: string) => ExecResult | Promise<ExecResult>;
  /** 보고서 비우기 명령. 던지면 실패(삼킨다) */
  clear?: (service: string) => ExecResult | Promise<ExecResult>;
  stats?: () => ServiceUsage[] | Promise<ServiceUsage[]>;
  restart?: (service: string) => void | Promise<void>;
  endpoint?: (service: string) => string | Promise<string>;
  runLoad?: Sandbox['runLoad'] | 'none';
  redact?: (text: string) => string;
  request?: (url: string, init: Parameters<ServiceRequest>[1]) => Fetched | Promise<Fetched>;
  page?: PageFetcher;
  browser?: (...args: Parameters<BrowserRunner>) => BrowserPageResult | Promise<BrowserPageResult>;
  signal?: AbortSignal;
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
  gate: VerificationGate;
  calls: string[];
  write(file: string, content: string): Promise<void>;
  run(label: string): Promise<void>;
  last(): Trace;
}

const OK: ExecResult = { exitCode: 0, stdout: '', stderr: '' };
const isClear = (command: string[]): boolean => command[0] === 'sh' && command.join(' ').includes('rm -f ');

const rendered: BrowserPageResult = { status: 200, text: '주문 목록', pageErrors: [], consoleErrors: [], failedRequests: [], mediaErrors: [], blockedRequests: [], horizontalOverflowPx: 0, steps: [] } as unknown as BrowserPageResult;

async function createWorld(mode: Mode, setup: Setup, traces: Trace[]): Promise<World> {
  const base = await createOrdersProject('declared-diff-');
  roots.push(base.root);
  const { root } = base;
  await writeFile(path.join(root, 'compose.yaml'), 'services:\n  api: { build: ./api }\n  web: { build: ./web }\n');
  let project = (setup.workflow ? { ...base, spec: { ...base.spec, workflow: setup.workflow } } : base) as LoadedProject;
  if (setup.nextjs) {
    project = { ...project, managed: [...project.managed, ['web', { source: 'managed', template: 'nextjs', path: 'web', port: 3000, preview: 'browser' }]] } as unknown as LoadedProject;
    await writeFile(path.join(root, SPEC_FILE), 'version: 1\nname: orders\n');
  }

  const calls: string[] = [];
  const sandbox = fakeSandbox(project, []);
  sandbox.exec = async (service, command) => {
    if (isClear(command)) {
      calls.push(`clear:${service}`);
      return setup.clear ? setup.clear(service) : OK;
    }
    calls.push(`exec:${service}:${command.join(' ')}`);
    return setup.exec ? setup.exec(command, service) : OK;
  };
  sandbox.stats = async () => {
    calls.push('stats');
    return setup.stats ? setup.stats() : [];
  };
  sandbox.restart = async (service: string) => {
    calls.push(`restart:${service}`);
    await setup.restart?.(service);
    return { service, containerPort: 8080, url: 'http://127.0.0.1:1' };
  };
  sandbox.endpoint = async (service: string) => {
    calls.push(`endpoint:${service}`);
    return { service, containerPort: 8080, url: setup.endpoint ? await setup.endpoint(service) : 'http://127.0.0.1:1' };
  };
  if (setup.redact) {
    sandbox.redact = (text: string) => {
      calls.push(`redact:${JSON.stringify(text)}`);
      return setup.redact!(text);
    };
  }
  if (setup.runLoad === 'none') delete (sandbox as { runLoad?: unknown }).runLoad;
  else if (setup.runLoad) {
    sandbox.runLoad = async (request: LoadRequest, options?: { signal?: AbortSignal }): Promise<LoadResult> => {
      calls.push(`runLoad:${request.path}`);
      return setup.runLoad === undefined || setup.runLoad === 'none' ? (undefined as never) : setup.runLoad(request, options);
    };
  }

  const workspace = new Workspace(root);
  const events: string[] = [];
  const gate = await VerificationGate.create({
    project,
    sandbox,
    workspace,
    allowBreaking: false,
    maxVerifyAttempts: 3,
    platformRetryDelayMs: 1,
    ...(setup.signal ? { signal: setup.signal } : {}),
    fetcher: async () => ORDERS_CONTRACT,
    pageFetcher: async (url, signal) => {
      calls.push(`page:${url}`);
      return setup.page ? setup.page(url, signal) : { status: 200, text: '<h1>주문 목록</h1>' };
    },
    browserRunner: async (url, options) => {
      calls.push(`browser:${url}:${JSON.stringify(options.viewport ?? null)}`);
      return setup.browser ? setup.browser(url, options) : rendered;
    },
    requestService: async (url, init) => {
      calls.push(`request:${init.method} ${url} ${JSON.stringify(init.headers ?? null)} ${JSON.stringify(init.body ?? null)}`);
      return setup.request ? setup.request(url, init) : { status: 201, text: '{}' };
    },
    onEvent: (event) => {
      events.push(JSON.stringify(event));
      setup.onEvent?.(event);
    },
  });

  return {
    root,
    gate,
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
    last: () => traces[traces.length - 1]!,
  };
}

async function runWorld(mode: Mode, makeSetup: () => Setup, steps: (world: World) => Promise<void>) {
  const traces: Trace[] = [];
  const world = await createWorld(mode, makeSetup(), traces);
  await steps(world);
  return { traces, texts: traces.map((trace) => trace.text), calls: world.calls };
}

/** 같은 시나리오를 옛 구현과 지금 구현에 넣어 견주고, 옛 구현의 결과를 돌려준다 */
async function compare(
  makeSetup: () => Setup,
  steps: (world: World) => Promise<void> = (world) => world.write(...CHANGE).then(() => world.run('check')),
  /** 노드 둘 이상이 동시에 돌며 부르는 호출은 서로 끼어드는 순서가 다를 수 있다(시작 순서만 같다). 그 시나리오는 호출을 정렬해 견준다 */
  options: { interleaved?: true } = {},
) {
  const legacy = await runWorld('legacy', makeSetup, steps);
  const current = await runWorld('current', makeSetup, steps);
  expect(current.texts).toEqual(legacy.texts);
  if (options.interleaved) expect([...current.calls].sort()).toEqual([...legacy.calls].sort());
  else expect(current.calls).toEqual(legacy.calls);
  expect(legacy.traces.length).toBeGreaterThan(0);
  return legacy;
}

const CHANGE = ['api/src/Order.java', 'class Order { String memo; }\n'] as const;
const checksOf = (trace: Trace) => (trace.state as { checks: Array<Record<string, unknown>> }).checks;
const byName = (trace: Trace, name: string) => checksOf(trace).find((check) => check.name === name)!;
const stagesOf = (trace: Trace): string[] => trace.events.map((event) => JSON.parse(event) as { type: string; stage?: string }).filter((event) => event.type === 'stage').map((event) => event.stage!);
const outcomeOf = (trace: Trace) => (trace.result as { outcome: { kind: string; feedback?: string; summary?: string } }).outcome;
const thrownOf = (trace: Trace) => (trace.result as { threw: { name: string; message: string } }).threw;
const declaredOf = (trace: Trace) => checksOf(trace).filter((check) => check.stage !== 'review');
const restarts = (calls: string[]): number => calls.filter((call) => call === 'restart:api').length;
const declaredStages = (trace: Trace): string[] => stagesOf(trace).filter((stage) => ['browser_check', 'test', 'concurrency_check', 'load_check'].includes(stage));

const unit = (over: Partial<WorkflowTest> = {}): WorkflowTest => ({ name: 'unit', service: 'api', command: ['./gradlew', 'test'], maxAttempts: 1, ...over }) as WorkflowTest;
const conc = (over: Partial<WorkflowConcurrencyCheck> = {}): WorkflowConcurrencyCheck =>
  ({ name: 'stock', service: 'api', method: 'POST', path: '/api/products/1/orders', concurrent: 5, expect: { successCount: { exactly: 1 } }, ...over }) as WorkflowConcurrencyCheck;
const page = (over: Partial<WorkflowPageCheck> = {}): WorkflowPageCheck =>
  ({ service: 'api', path: '/orders', mode: 'http', expectStatus: 200, expectText: '주문 목록', allowConsoleErrors: false, noHorizontalScroll: false, ...over }) as WorkflowPageCheck;
const loadCheck = (over: Partial<WorkflowLoadCheck> = {}): WorkflowLoadCheck =>
  ({ name: 'orders-p95', service: 'api', method: 'POST', path: '/api/products/1/orders', concurrent: 100, warmup: 0, expect: { p95Ms: 200, latencyOf: [409] }, ...over }) as WorkflowLoadCheck;
const measured = (over: Partial<LoadResult> = {}): LoadResult => ({
  requests: 100,
  concurrent: 100,
  threads: 4,
  completed: 100,
  elapsedMs: 640,
  statuses: { '201': 5, '409': 95 },
  errors: {},
  latency: { count: 95, p50: 12, p95: 45.6, p99: 60, max: 70 },
  connect: { count: 100, p50: 60, p95: 80, p99: 85, max: 90, errors: 0 },
  loopDelay: { p99: 3, max: 9 },
  warmup: { requests: 0, errors: 0 },
  ...over,
});
const json = (value: unknown): Fetched => ({ status: 200, text: JSON.stringify(value) });
const statusSequence = (statuses: number[], then?: Fetched) => {
  let index = 0;
  return (_url: string, init: Parameters<ServiceRequest>[1]): Fetched => (init.method === 'GET' && then ? then : { status: statuses[index++ % statuses.length]!, text: '{}' });
};

describe('선언이 없는 검증', () => {
  it('workflow가 없으면 선언한 검사 단계를 내지 않고 review 단계로 넘어간다', async () => {
    const out = await compare(() => ({}));
    expect(declaredStages(out.traces[0]!)).toEqual([]);
    expect(outcomeOf(out.traces[0]!).kind).toBe('pass');
  });

  it('workflow는 있지만 비어 있어도 같다', async () => {
    const out = await compare(() => ({ workflow: {} }));
    expect(declaredStages(out.traces[0]!)).toEqual([]);
  });
});

describe('테스트', () => {
  it('통과하면 근거(명령·종료 코드·걸린 시간)를 붙이고 test 단계를 낸다', async () => {
    const out = await compare(() => ({ workflow: { tests: [unit()] } }));
    expect(declaredStages(out.traces[0]!)).toEqual(['test']);
    expect(byName(out.traces[0]!, 'unit')).toMatchObject({ ok: true, attempts: 1, evidence: [expect.stringContaining('종료 코드 0'), expect.stringMatching(/^걸린 시간 0\.\d초$/)] });
    expect(out.calls).toContain('clear:api');
    expect(out.calls).toContain('exec:api:./gradlew test');
  });

  it('실패하면 종료 코드와 출력의 마지막 30줄을 사유로 남기고 근거는 붙이지 않는다', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    const out = await compare(() => ({ workflow: { tests: [unit()] }, exec: () => ({ exitCode: 2, stdout: lines, stderr: 'boom\n' }) }));
    const check = byName(out.traces[0]!, 'unit');
    expect(check.ok).toBe(false);
    expect(check.evidence).toBeUndefined();
    expect(check.detail).toContain('종료 코드 2');
    expect(check.detail).not.toContain('line 10\n');
    expect(check.detail).toContain('line 40');
    expect(outcomeOf(out.traces[0]!).kind).toBe('retry');
  });

  it('종료 코드가 0이 아니면 출력이 비어 있어도 실패다', async () => {
    const out = await compare(() => ({ workflow: { tests: [unit()] }, exec: () => ({ exitCode: 1, stdout: '', stderr: '' }) }));
    expect(byName(out.traces[0]!, 'unit')).toMatchObject({ ok: false, detail: '종료 코드 1\n' });
  });

  it('재시도해 통과하면 시도 횟수를 남기고 실패 사유는 남기지 않는다', async () => {
    let runs = 0;
    const out = await compare(() => {
      runs = 0;
      return { workflow: { tests: [unit({ maxAttempts: 3 })] }, exec: () => (++runs < 3 ? { exitCode: 1, stdout: '', stderr: `실패 ${runs}` } : OK) };
    });
    expect(byName(out.traces[0]!, 'unit')).toMatchObject({ ok: true, attempts: 3 });
    expect(out.calls.filter((call) => call.startsWith('exec:')).length).toBe(3);
  });

  it('재시도를 다 써도 실패하면 마지막 사유와 시도 횟수를 남긴다', async () => {
    const out = await compare(() => ({ workflow: { tests: [unit({ maxAttempts: 2 })] }, exec: () => ({ exitCode: 1, stdout: '', stderr: 'nope' }) }));
    expect(byName(out.traces[0]!, 'unit')).toMatchObject({ ok: false, attempts: 2 });
  });

  it('메모리 한도로 컨테이너가 죽었으면 서비스를 되살리고 환경 문제를 사유에 적는다', async () => {
    const out = await compare(() => ({
      workflow: { tests: [unit()] },
      exec: () => ({ exitCode: 137, stdout: '', stderr: 'Killed' }),
      stats: () => [{ service: 'api', oomKilled: true, memoryLimitBytes: 536_870_912 } as ServiceUsage],
    }));
    expect(byName(out.traces[0]!, 'unit').detail).toContain('환경 문제: api 컨테이너가 메모리 한도 (512MiB)를 넘어 종료됐습니다');
    expect(restarts(out.calls)).toBe(2);
  });

  it('한도 값이 없으면 한도 표기 없이 적고, 다른 서비스가 죽었다면 되살리지 않는다', async () => {
    const withoutLimit = await compare(() => ({ workflow: { tests: [unit()] }, exec: () => ({ exitCode: 137, stdout: '', stderr: '' }), stats: () => [{ service: 'api', oomKilled: true } as ServiceUsage] }));
    expect(byName(withoutLimit.traces[0]!, 'unit').detail).toContain('컨테이너가 메모리 한도를 넘어 종료됐습니다');
    const other = await compare(() => ({ workflow: { tests: [unit()] }, exec: () => ({ exitCode: 137, stdout: '', stderr: '' }), stats: () => [{ service: 'web', oomKilled: true } as ServiceUsage] }));
    expect(restarts(other.calls)).toBe(1);
    expect(byName(other.traces[0]!, 'unit').detail).not.toContain('환경 문제');
  });

  it('되살리기가 실패해도 삼키고 환경 문제 사유는 남긴다', async () => {
    const out = await compare(() => ({
      workflow: { tests: [unit()] },
      exec: () => ({ exitCode: 137, stdout: '', stderr: '' }),
      stats: () => [{ service: 'api', oomKilled: true } as ServiceUsage],
      // 첫 재시작은 서비스 확인이 부른 것이다. 테스트가 되살리려고 부르는 둘째부터 던진다
      restart: (() => {
        let count = 0;
        return () => {
          if (++count > 1) throw new Error('재시작 실패');
        };
      })(),
    }));
    expect(restarts(out.calls)).toBe(2);
    expect(byName(out.traces[0]!, 'unit').detail).toContain('환경 문제');
  });

  it('상태 조회가 실패하면 되살리지 않고 원래 실패만 남긴다', async () => {
    const out = await compare(() => ({
      workflow: { tests: [unit()] },
      exec: () => ({ exitCode: 1, stdout: '', stderr: 'x' }),
      stats: () => {
        throw new Error('stats 실패');
      },
    }));
    expect(out.calls).toContain('stats');
    expect(restarts(out.calls)).toBe(1);
    expect(byName(out.traces[0]!, 'unit').detail).not.toContain('환경 문제');
  });

  it('exec가 던지면 그 메시지가 사유다(Error와 글자 둘 다)', async () => {
    const asError = await compare(() => ({
      workflow: { tests: [unit()] },
      exec: () => {
        throw new Error('컨테이너가 없습니다');
      },
    }));
    expect(byName(asError.traces[0]!, 'unit').detail).toBe('컨테이너가 없습니다');
    const asText = await compare(() => ({
      workflow: { tests: [unit()] },
      exec: () => {
        throw '문자열로 던짐';
      },
    }));
    expect(byName(asText.traces[0]!, 'unit').detail).toBe('문자열로 던짐');
  });

  it('근거를 가리는 함수가 던지면 근거 없이 통과로 남긴다', async () => {
    const out = await compare(() => ({
      workflow: { tests: [unit()] },
      redact: () => {
        throw new Error('가리기 실패');
      },
    }));
    expect(byName(out.traces[0]!, 'unit')).toMatchObject({ ok: true });
    expect(byName(out.traces[0]!, 'unit').evidence).toBeUndefined();
  });

  it('근거의 줄은 가리는 함수를 거친 값으로 남는다', async () => {
    const out = await compare(() => ({ workflow: { tests: [unit()] }, redact: (text) => text.replaceAll('api', '***') }));
    expect(byName(out.traces[0]!, 'unit').evidence).toEqual([expect.stringContaining('***에서'), expect.any(String)]);
  });

  it('짝 없는 서로게이트가 든 출력도 옛 코드와 같은 글자로 남긴다', async () => {
    const out = await compare(() => ({ workflow: { tests: [unit()] }, exec: () => ({ exitCode: 1, stdout: `a${String.fromCharCode(0xd800)}b`, stderr: `${String.fromCharCode(0xe011)}` }) }));
    expect(byName(out.traces[0]!, 'unit').ok).toBe(false);
  });

  it('보고서 비우기가 실패해도 테스트는 돌린다', async () => {
    const out = await compare(() => ({
      workflow: { tests: [unit()] },
      clear: () => {
        throw new Error('비우기 실패');
      },
    }));
    expect(out.calls.filter((call) => call.startsWith('clear:') || call.startsWith('exec:'))).toEqual(['clear:api', 'exec:api:./gradlew test']);
    expect(byName(out.traces[0]!, 'unit').ok).toBe(true);
  });

  it('서비스가 선언에 없으면 비우지 않고, 같은 서비스는 한 번만 비운다', async () => {
    const out = await compare(() => ({ workflow: { tests: [unit(), unit({ name: 'unit2' }), unit({ name: 'ghost', service: 'ghost' })] } }));
    expect(out.calls.filter((call) => call.startsWith('clear:'))).toEqual(['clear:api']);
  });

  it('같은 이름 테스트 둘은 작업 id가 겹쳐 게이트가 던진다', async () => {
    const out = await compare(() => ({ workflow: { tests: [unit(), unit()] } }));
    expect(thrownOf(out.traces[0]!).message).toBe('task id가 중복됩니다');
    expect(out.calls.filter((call) => call.startsWith('clear:') || call.startsWith('exec:'))).toEqual(['clear:api']);
  });
});

describe('화면 확인', () => {
  it('http 선언은 browser_check 단계를 내고 근거를 붙인다', async () => {
    const out = await compare(() => ({ workflow: { pageChecks: [page()] } }));
    expect(declaredStages(out.traces[0]!)).toEqual(['browser_check']);
    expect(byName(out.traces[0]!, 'api /orders')).toMatchObject({ ok: true });
  });

  it('같은 화면을 두 번 선언하면 둘째부터 번호를 붙인다(트러블슈팅 120)', async () => {
    const out = await compare(() => ({ workflow: { pageChecks: [page(), page({ expectText: '없는 글자' }), page()] } }), undefined, { interleaved: true });
    expect(declaredOf(out.traces[0]!).map((check) => check.name)).toEqual(['api /orders', 'api /orders #2', 'api /orders #3']);
    expect(byName(out.traces[0]!, 'api /orders #2').ok).toBe(false);
  });

  it('browser 모드는 창 크기와 단계 수를 이름에 적고 단계·로드 시간을 결과에 싣는다', async () => {
    const out = await compare(() => ({
      workflow: {
        pageChecks: [
          page({ mode: 'browser', viewport: { width: 390, height: 844 }, steps: [{ action: 'click', selector: 'button' }, { action: 'click', selector: 'a' }] as never }),
          page({ mode: 'browser', path: '/b' }),
          page({ mode: 'browser', path: '/c', maxLoadMs: 5000 }),
        ],
      },
      browser: (_url, options) => ({ ...rendered, ...(options.viewport ? {} : {}), loadMs: 120, blockedRequests: ['http://evil/x', 'http://evil/y'] }) as BrowserPageResult,
    }), undefined, { interleaved: true });
    const names = declaredOf(out.traces[0]!).map((check) => check.name);
    expect(names).toEqual(['api /orders (browser 390x844, 단계 2개)', 'api /b (browser)', 'api /c (browser)']);
    expect(byName(out.traces[0]!, 'api /c (browser)')).toMatchObject({ metrics: { loadMs: 120 } });
    expect(String(byName(out.traces[0]!, 'api /b (browser)').detail)).toContain('다른 출처 요청 2건을 막았습니다');
  });

  it('화면 확인 이름이 테스트·동시 요청과 같으면 부산물이 이름으로 섞인다(옛 코드와 같게)', async () => {
    const out = await compare(() => ({
      workflow: { pageChecks: [page({ mode: 'browser' })], tests: [unit({ name: 'api /orders (browser)' })] },
      browser: () => ({ ...rendered, loadMs: 7 }) as BrowserPageResult,
    }), undefined, { interleaved: true });
    expect(declaredOf(out.traces[0]!).map((check) => check.name)).toEqual(['api /orders (browser)', 'api /orders (browser)']);
  });
});

describe('자동 페이지', () => {
  const nextjs = (over: Partial<WorkflowSpec> = {}) => ({ nextjs: true, workflow: { autoPageChecks: { service: 'web', mode: 'http', expectStatus: 200, maxPages: 5 }, ...over } as Partial<WorkflowSpec> });
  const pageFile = 'export default function Page() { return null; }\n';

  it('바뀐 Next.js 페이지를 열어 browser_check로 남기고 오류 화면 표지가 있으면 실패한다', async () => {
    const out = await compare(
      () => ({ ...nextjs(), page: async (url) => (url.endsWith('/orders') ? { status: 200, text: 'Unhandled Runtime Error' } : { status: 200, text: 'ok' }) }),
      async (w) => {
        await w.write('web/app/orders/page.tsx', pageFile);
        await w.write('web/app/page.tsx', pageFile);
        await w.run('auto');
      },
      { interleaved: true },
    );
    expect(declaredStages(out.traces[0]!)).toEqual(['browser_check']);
    expect(byName(out.traces[0]!, 'web /orders (자동)').ok).toBe(false);
    expect(byName(out.traces[0]!, 'web / (자동)').ok).toBe(true);
  });

  it('건너뛴 자동 페이지만 있으면 browser_check 단계는 내지 않고 건너뜀 check는 남긴다', async () => {
    const out = await compare(
      () => nextjs({ autoPageChecks: { service: 'web', mode: 'http', expectStatus: 200, maxPages: 5, sampleParams: { id: '1' } } as never }),
      async (w) => {
        await w.write('web/app/orders/[id]/page.tsx', pageFile);
        await w.write(SPEC_FILE, 'version: 1\nname: orders\nservices:\n  web: { source: managed, template: nextjs, path: web, port: 3000, preview: browser }\n');
        await w.run('skipped-only');
      },
    );
    expect(out.traces.length).toBe(1);
  });

  it('선언한 화면과 같은 자동 페이지는 건너뛰고 건너뜀 check를 남기며 이름은 다시 짓지 않는다', async () => {
    const out = await compare(
      () => ({ ...nextjs({ pageChecks: [page({ service: 'web', path: '/orders' })] }) }),
      async (w) => {
        await w.write('web/app/orders/page.tsx', pageFile);
        await w.run('declared-and-auto');
      },
    );
    expect(checksOf(out.traces[0]!).some((check) => String(check.name).includes('건너뜀'))).toBe(true);
  });
});

describe('동시 요청', () => {
  it('정확히 한 건 성공하면 통과하고 요약(성공 건수·상태 분포)을 사유에 남긴다', async () => {
    const out = await compare(() => ({ workflow: { concurrencyChecks: [conc()] }, request: statusSequence([201, 409, 409, 409, 409]) }));
    expect(declaredStages(out.traces[0]!)).toEqual(['concurrency_check']);
    const check = byName(out.traces[0]!, 'stock');
    expect(check).toMatchObject({ ok: true, attempts: 1, detail: '성공 1/5 (기대: 정확히 1) · 상태 201:1, 409:4' });
    expect(out.calls.filter((call) => call.startsWith('request:')).length).toBe(5);
  });

  it('성공 수가 기대와 다르면 숫자만 남기고 실패한다(정확히·최대)', async () => {
    const exactly = await compare(() => ({ workflow: { concurrencyChecks: [conc()] }, request: statusSequence([201]) }));
    expect(byName(exactly.traces[0]!, 'stock')).toMatchObject({ ok: false });
    expect(String(byName(exactly.traces[0]!, 'stock').detail)).toContain('성공 5/5 (기대: 정확히 1)');
    const atMost = await compare(() => ({ workflow: { concurrencyChecks: [conc({ expect: { successCount: { atMost: 2 } } })] }, request: statusSequence([200, 200, 200, 500, 500]) }));
    expect(String(byName(atMost.traces[0]!, 'stock').detail)).toContain('성공 3/5 (기대: 최대 2)');
    const both = await compare(() => ({ workflow: { concurrencyChecks: [conc({ expect: { successCount: { exactly: 2, atMost: 2 } } })] }, request: statusSequence([200]) }));
    expect(String(byName(both.traces[0]!, 'stock').detail).split('\n').length).toBe(1 + 2);
  });

  it('최대·정확히 경계: 정확히 같은 값이면 통과, 하나 넘으면 실패', async () => {
    const pass = await compare(() => ({ workflow: { concurrencyChecks: [conc({ expect: { successCount: { atMost: 2 } } })] }, request: statusSequence([200, 200, 409, 409, 409]) }));
    expect(byName(pass.traces[0]!, 'stock').ok).toBe(true);
    const zero = await compare(() => ({ workflow: { concurrencyChecks: [conc({ expect: { successCount: { exactly: 0 } } })] }, request: statusSequence([409]) }));
    expect(byName(zero.traces[0]!, 'stock').ok).toBe(true);
  });

  it('allStatusIn: 목록 밖 상태 코드는 중복 없이 처음 나온 순서로 적는다', async () => {
    const out = await compare(() => ({ workflow: { concurrencyChecks: [conc({ expect: { allStatusIn: [201, 409] } })] }, request: statusSequence([201, 500, 503, 500, 409]) }));
    expect(String(byName(out.traces[0]!, 'stock').detail)).toContain('기대 밖 상태 코드: 500, 503 (기대: 201, 409)');
    const ok = await compare(() => ({ workflow: { concurrencyChecks: [conc({ expect: { allStatusIn: [201, 409] } })] }, request: statusSequence([201, 409]) }));
    expect(byName(ok.traces[0]!, 'stock').ok).toBe(true);
  });

  it('상태 분포는 상태 코드 오름차순으로 적는다', async () => {
    const out = await compare(() => ({ workflow: { concurrencyChecks: [conc({ concurrent: 6, expect: { allStatusIn: [200, 404, 500, 409] } })] }, request: statusSequence([500, 200, 409, 404, 200, 500]) }));
    expect(byName(out.traces[0]!, 'stock').detail).toBe('성공 2/6 (기대: 상태 200/404/500/409) · 상태 200:2, 404:1, 409:1, 500:2');
  });

  it('then: 값이 같으면 통과하고 그 값을 사유에 남긴다. 다르면 실패한다', async () => {
    const then = { method: 'GET', path: '/api/products/1', jsonPath: '$.stock', equals: 0 } as const;
    const pass = await compare(() => ({ workflow: { concurrencyChecks: [conc({ expect: { successCount: { exactly: 1 }, then } })] }, request: statusSequence([201, 409, 409, 409, 409], json({ stock: 0 })) }));
    expect(String(byName(pass.traces[0]!, 'stock').detail)).toContain('$.stock = 0');
    expect(byName(pass.traces[0]!, 'stock').ok).toBe(true);
    const fail = await compare(() => ({ workflow: { concurrencyChecks: [conc({ expect: { successCount: { exactly: 1 }, then } })] }, request: statusSequence([201, 409, 409, 409, 409], json({ stock: 3 })) }));
    expect(String(byName(fail.traces[0]!, 'stock').detail)).toContain('$.stock 값이 3 (기대: 0)');
    const text = await compare(() => ({ workflow: { concurrencyChecks: [conc({ expect: { then: { ...then, equals: '0' } } })] }, request: statusSequence([201], json({ stock: 0 })) }));
    expect(String(byName(text.traces[0]!, 'stock').detail)).toContain('값이 0 (기대: "0")');
  });

  it('then 응답이 JSON이 아니거나 값이 없으면 undefined로 읽어 실패한다', async () => {
    const then = { method: 'GET', path: '/s', jsonPath: '$.a.b', equals: 1 } as const;
    for (const text of ['not json', '{}', '{"a":null}', '{"a":[1]}', '']) {
      const out = await compare(() => ({ workflow: { concurrencyChecks: [conc({ expect: { then } })] }, request: statusSequence([201], { status: 200, text }) }));
      expect(byName(out.traces[0]!, 'stock').ok).toBe(false);
      expect(String(byName(out.traces[0]!, 'stock').detail)).toContain('$.a.b = undefined');
    }
  });

  it('then의 jsonPath: 배열 length·숫자 키·상속 속성·중복 키·정밀도·-0을 JS처럼 읽는다', async () => {
    const cases: Array<[string, string, number | string]> = [
      ['{"items":[5,6,7]}', '$.items.length', 3],
      ['{"items":[5,6,7]}', '$.items.1', 6],
      ['{"items":[5,6,7]}', '$.items[2]', 7],
      ['{"items":[5,6,7]}', '$.items[3]', 7],
      ['{"items":[[1,2],[3]]}', '$.items[1][0]', 3],
      ['{"a":{"constructor":1}}', '$.a.constructor', 1],
      ['{"a":{}}', '$.a.constructor', 'x'],
      ['{"a":{}}', '$.a.toString', 'x'],
      ['{"a":{}}', '$.a.__proto__', 'x'],
      ['{"a":{}}', '$.a.__proto__.__proto__', 'x'],
      ['{"a":[]}', '$.a.__proto__', 'x'],
      ['{"a":[]}', '$.a.__proto__.length', 0],
      ['{"a":{"__proto__":7}}', '$.a.__proto__', 7],
      ['{"a":1,"a":2}', '$.a', 2],
      ['{"a":0.1}', '$.a', 0.1],
      ['{"a":9007199254740993}', '$.a', 9007199254740992],
      ['{"a":-0}', '$.a', 0],
      ['{"a":1e21}', '$.a', 1e21],
      ['{"a":"x"}', '$.a.length', 1],
      ['{"a":[1]}', '$.a[99999999999999999999]', 1],
      ['{"a":[1]}', '$.a[00]', 1],
      ['[10,20]', '$[1]', 20],
      ['[10,20]', '$.1', 20],
      ['{"a":1}', 'a', 1],
      ['{"a":1}', '$a', 1],
      ['{"a":1}', '$', 1],
      ['{"":1}', '$..', 1],
      ['{"a b":2}', '$.a b', 2],
      ['{"a":{"b":3}}', '$.a..b', 3],
      ['{"a":[{"b":4}]}', '$.a[0].b', 4],
      ['{"a":1}', '$.a[', 1],
      ['{"a":1}', '$.a]', 1],
      ['{"a":[1]}', '$.a[0]x', 1],
      ['{"a":[1]}', '$.a[-1]', 1],
      ['{"a":"\\ud800"}', '$.a', '\ud800'],
      ['{"\\u0000nf":5}', '$.\u0000nf', 5],
      ['{"a":{"b":[1,{"c":"d"}]}}', '$.a.b[1].c', 'd'],
    ];
    for (const [text, jsonPath, equals] of cases) {
      const result = await compare(() => ({ workflow: { concurrencyChecks: [conc({ expect: { then: { method: 'GET', path: '/s', jsonPath, equals } } })] }, request: statusSequence([201], { status: 200, text }) }));
      expect(result.traces.length).toBe(1);
    }
  });

  it('요청 헤더·본문을 그대로 보내고 GET에는 본문을 보내지 않는다', async () => {
    const post = await compare(() => ({ workflow: { concurrencyChecks: [conc({ headers: { 'content-type': 'application/json', 'x-a': 'b' }, body: '{"qty":1}' })] } }));
    expect(post.calls.find((call) => call.startsWith('request:'))).toContain('qty');
    const get = await compare(() => ({ workflow: { concurrencyChecks: [conc({ method: 'GET', body: '{"qty":1}', expect: { allStatusIn: [201] } })] } }));
    expect(get.calls.find((call) => call.startsWith('request:'))).toContain('null');
  });

  it('서비스 출처 밖으로 나가는 경로는 요청하지 않고 실패한다(여러 꼴)', async () => {
    const paths = ['//evil.example/x', 'http://evil.example/x', '\\\\evil.example\\x', '/\\evil.example/x', '\t//evil.example', '/\t/evil.example', 'http://127.0.0.1:2/x', 'http://127.0.0.1:1/ok', 'http://127.0.0.1:1@evil.example/', 'http://user@127.0.0.1:1/x', '/a/../../b', '/%2e%2e/x', '/x?y=//evil', 'http://[::1]:1/x', '//127.0.0.1:1/x'];
    for (const pathText of paths) {
      const out = await compare(() => ({ workflow: { concurrencyChecks: [conc({ path: pathText })] } }));
      expect(out.traces.length).toBe(1);
    }
    const out = await compare(() => ({ workflow: { concurrencyChecks: [conc({ path: '//evil.example/x' })] } }));
    expect(byName(out.traces[0]!, 'stock')).toMatchObject({ ok: false, detail: 'path must stay on the service host' });
    expect(out.calls.filter((call) => call.startsWith('request:'))).toEqual([]);
  });

  it('endpoint 주소가 다른 포트·IPv6·기본 포트여도 같은 규칙으로 판정한다', async () => {
    for (const endpoint of ['http://127.0.0.1:80', 'http://127.0.0.1', 'http://[::1]:8080', 'https://svc.local:443', 'http://svc.local:8080/base/']) {
      for (const pathText of ['/api/x', 'http://svc.local:8080/y', '//svc.local:8080/y', 'http://[::1]:8080/z', '//[::1]:8080/z', 'https://svc.local/z']) {
        await compare(() => ({ workflow: { concurrencyChecks: [conc({ path: pathText })] }, endpoint: () => endpoint }));
      }
    }
  });

  it('then 경로가 출처 밖이면 요청을 다 보낸 뒤에 실패한다', async () => {
    const out = await compare(() => ({ workflow: { concurrencyChecks: [conc({ expect: { then: { method: 'GET', path: '//evil.example/x', jsonPath: '$.a', equals: 1 } } })] } }));
    expect(byName(out.traces[0]!, 'stock')).toMatchObject({ ok: false, detail: 'path must stay on the service host' });
    expect(out.calls.filter((call) => call.startsWith('request:')).length).toBe(5);
  });

  it('endpoint 조회·요청이 던지면 그 메시지가 사유이고, 일부 요청이 이미 나갔어도 첫 거절을 올린다', async () => {
    // 앞의 두 조회는 서비스 확인(준비 판정·계약)이 부른 것이다. 동시 요청 확인의 조회부터 던진다
    const afterVerify = (make: () => string) => () => {
      let count = 0;
      return () => (++count > 2 ? make() : 'http://127.0.0.1:1');
    };
    const endpoint = await compare(() => ({
      workflow: { concurrencyChecks: [conc()] },
      endpoint: afterVerify(() => {
        throw new Error('endpoint 없음');
      })(),
    }));
    expect(byName(endpoint.traces[0]!, 'stock').detail).toBe('endpoint 없음');
    const invalid = await compare(() => ({ workflow: { concurrencyChecks: [conc()] }, endpoint: afterVerify(() => 'not a url')() }));
    expect(byName(invalid.traces[0]!, 'stock').detail).toBe('Invalid URL');
    let count = 0;
    const request = await compare(() => {
      count = 0;
      return {
        workflow: { concurrencyChecks: [conc()] },
        request: () => {
          if (++count === 3) throw new Error('연결 끊김');
          return { status: 201, text: '{}' };
        },
      };
    });
    expect(byName(request.traces[0]!, 'stock').detail).toBe('연결 끊김');
    expect(request.calls.filter((call) => call.startsWith('request:')).length).toBe(5);
  });

  it('실패 사유는 가리는 함수를 거친다. 가리는 함수가 던지면 그 오류가 사유다', async () => {
    const masked = await compare(() => ({ workflow: { concurrencyChecks: [conc()] }, request: statusSequence([201]), redact: (text) => text.replaceAll('성공', '***') }));
    expect(String(byName(masked.traces[0]!, 'stock').detail)).toContain('*** 5/5');
    const broken = await compare(() => ({
      workflow: { concurrencyChecks: [conc()] },
      request: statusSequence([201]),
      redact: () => {
        throw new Error('가리기 실패');
      },
    }));
    expect(byName(broken.traces[0]!, 'stock').detail).toBe('가리기 실패');
  });

  it('실패 사유에 짝 없는 서로게이트가 있어도 가리는 함수에 같은 글자가 간다', async () => {
    const lone = String.fromCharCode(0xd800);
    const out = await compare(() => ({ workflow: { concurrencyChecks: [conc({ expect: { then: { method: 'GET', path: '/s', jsonPath: `$.${lone}`, equals: 1 } } })] }, request: statusSequence([201], json({ [lone]: 2 })) }));
    expect(byName(out.traces[0]!, 'stock').ok).toBe(false);
    expect(out.calls.some((call) => call.startsWith('redact:'))).toBe(false);
    const masked = await compare(() => ({ workflow: { concurrencyChecks: [conc({ expect: { then: { method: 'GET', path: '/s', jsonPath: `$.${lone}`, equals: 1 } } })] }, request: statusSequence([201], json({ [lone]: 2 })), redact: (text) => text }));
    expect(masked.calls.some((call) => call.includes('\\ud800'))).toBe(true);
  });

  it('통과한 확인의 요약은 가리지 않고 남긴다(옛 코드와 같게)', async () => {
    const out = await compare(() => ({ workflow: { concurrencyChecks: [conc()] }, request: statusSequence([201, 409, 409, 409, 409]), redact: () => '가림' }));
    expect(byName(out.traces[0]!, 'stock').detail).toContain('성공 1/5');
  });

  it('요청 N개를 같이 보낸다(응답을 기다리지 않고 모두 먼저 시작한다)', async () => {
    let inFlight = 0;
    let max = 0;
    const out = await compare(() => {
      inFlight = 0;
      max = 0;
      return {
        workflow: { concurrencyChecks: [conc({ concurrent: 8, expect: { allStatusIn: [201] } })] },
        request: async () => {
          inFlight += 1;
          max = Math.max(max, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 20));
          inFlight -= 1;
          return { status: 201, text: '{}' };
        },
      };
    });
    expect(max).toBe(8);
    expect(byName(out.traces[0]!, 'stock').ok).toBe(true);
  });

  it('같은 이름 동시 요청 둘은 작업 id가 겹쳐 던진다', async () => {
    const out = await compare(() => ({ workflow: { concurrencyChecks: [conc(), conc()] } }));
    expect(thrownOf(out.traces[0]!).message).toBe('task id가 중복됩니다');
  });

  it('테스트와 동시 요청의 이름이 같으면 요약이 이름으로 섞인다(옛 코드와 같게)', async () => {
    const out = await compare(() => ({ workflow: { tests: [unit({ name: 'stock' })], concurrencyChecks: [conc()] }, request: statusSequence([201, 409, 409, 409, 409]) }));
    expect(byName(out.traces[0]!, 'stock').detail).toContain('성공 1/5');
  });
});

describe('부하 확인', () => {
  it('러너가 없는 제공자는 통과로 세지 않고 b-studio 쪽 문제로 멈춘다', async () => {
    const out = await compare(() => ({ workflow: { loadChecks: [loadCheck()] }, runLoad: 'none' }));
    expect(outcomeOf(out.traces[0]!)).toMatchObject({ kind: 'exhausted', summary: expect.stringContaining("부하 확인 'orders-p95': 이 샌드박스 제공자는 부하 확인") });
    expect((out.traces[0]!.state as { platformFailure: string }).platformFailure).toContain('orders-p95');
    expect(declaredStages(out.traces[0]!)).toEqual(['load_check']);
  });

  it('기준 안이면 근거와 함께 통과하고, 기준을 넘으면 사유를 남긴다', async () => {
    const pass = await compare(() => ({ workflow: { loadChecks: [loadCheck()] }, runLoad: async () => measured() }));
    expect(byName(pass.traces[0]!, 'orders-p95')).toMatchObject({ ok: true, attempts: 1 });
    expect(byName(pass.traces[0]!, 'orders-p95').evidence).toBeDefined();
    const slow = await compare(() => ({ workflow: { loadChecks: [loadCheck()] }, runLoad: async () => measured({ latency: { count: 95, p50: 12, p95: 450, p99: 600, max: 700 } }) }));
    expect(byName(slow.traces[0]!, 'orders-p95').ok).toBe(false);
    expect(byName(slow.traces[0]!, 'orders-p95').evidence).toBeUndefined();
  });

  it('응답을 받지 못한 요청이 있으면 실패다', async () => {
    const out = await compare(() => ({ workflow: { loadChecks: [loadCheck()] }, runLoad: async () => measured({ errors: { timeout: 3 }, completed: 97 }) }));
    expect(byName(out.traces[0]!, 'orders-p95').ok).toBe(false);
    expect(String(byName(out.traces[0]!, 'orders-p95').detail)).toContain('응답을 받지 못한 요청 3건');
  });

  it('여러 개는 하나씩 차례로 잰다', async () => {
    let inFlight = 0;
    let max = 0;
    const out = await compare(() => {
      inFlight = 0;
      max = 0;
      return {
        workflow: { loadChecks: [loadCheck({ name: 'a' }), loadCheck({ name: 'b', path: '/b' })] },
        runLoad: async () => {
          inFlight += 1;
          max = Math.max(max, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return measured();
        },
      };
    });
    expect(max).toBe(1);
    expect(out.calls.filter((call) => call.startsWith('runLoad:'))).toEqual(['runLoad:/api/products/1/orders', 'runLoad:/b']);
  });

  it('b-studio 쪽(platform) 예외는 사유를 기록하고 멈춘다. 일반 예외는 실패 check만 남긴다', async () => {
    const platform = await compare(() => ({
      workflow: { loadChecks: [loadCheck({ name: 'a' }), loadCheck({ name: 'b' })] },
      runLoad: async () => {
        throw new SandboxError('러너를 띄우지 못했습니다', 'detail', { platform: true });
      },
    }));
    expect(outcomeOf(platform.traces[0]!).kind).toBe('exhausted');
    expect((platform.traces[0]!.state as { platformFailure: string }).platformFailure).toContain("부하 확인 'a'");
    const plain = await compare(() => ({
      workflow: { loadChecks: [loadCheck()] },
      runLoad: async () => {
        throw new Error('러너 오류');
      },
    }));
    expect(byName(plain.traces[0]!, 'orders-p95')).toMatchObject({ ok: false, detail: '러너 오류' });
    expect((plain.traces[0]!.state as { platformFailure?: string }).platformFailure).toBeUndefined();
    const text = await compare(() => ({
      workflow: { loadChecks: [loadCheck()] },
      runLoad: async () => {
        throw '글자 오류';
      },
    }));
    expect(byName(text.traces[0]!, 'orders-p95').detail).toBe('글자 오류');
  });

  it('판정을 못 하는 결과(모양이 어긋남)는 통과가 아니라 실패다', async () => {
    const out = await compare(() => ({ workflow: { loadChecks: [loadCheck()] }, runLoad: async () => ({ requests: 1 }) as unknown as LoadResult }));
    expect(byName(out.traces[0]!, 'orders-p95').ok).toBe(false);
  });

  it('가리는 함수가 성공 경로에서 던지면 같은 오류로 실패 경로를 탄다', async () => {
    let calls = 0;
    const out = await compare(() => {
      calls = 0;
      return {
        workflow: { loadChecks: [loadCheck()] },
        runLoad: async () => measured(),
        redact: (text: string) => {
          if (++calls === 3) throw new Error('가리기 실패');
          return text;
        },
      };
    });
    expect(out.traces.length).toBe(1);
  });

  it('가리는 함수가 실패 경로에서도 던지면 게이트가 그 오류를 던진다', async () => {
    const out = await compare(() => ({
      workflow: { loadChecks: [loadCheck()] },
      runLoad: async () => {
        throw new Error('러너 오류');
      },
      redact: () => {
        throw new Error('가리기 실패');
      },
    }));
    expect(thrownOf(out.traces[0]!).message).toBe('가리기 실패');
  });

  it('다른 확인이 모두 끝난 뒤에 잰다(테스트 → 부하 순서)', async () => {
    const out = await compare(() => ({ workflow: { tests: [unit()], loadChecks: [loadCheck()] }, runLoad: async () => measured() }));
    expect(out.calls.indexOf('exec:api:./gradlew test')).toBeLessThan(out.calls.indexOf('runLoad:/api/products/1/orders'));
    expect(checksOf(out.traces[0]!).map((check) => check.stage)).toEqual(['test', 'load_check', 'review']);
  });
});

describe('취소', () => {
  it('작업 그래프 도중 취소되면 게이트가 취소 사유를 던진다', async () => {
    const out = await compare(() => {
      const controller = new AbortController();
      return {
        signal: controller.signal,
        workflow: { tests: [unit({ name: 'a' }), unit({ name: 'b' }), unit({ name: 'c' })] },
        exec: async (command: string[]) => {
          // 노드 둘이 먼저 시작한 뒤(둘 다 exec를 부른 뒤)에 취소한다. 취소가 다른 노드의 시작과 같은 동기 구간에 끼지 않게 한다
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (command.join(' ') === './gradlew test') controller.abort(new Error('사용자가 취소했습니다'));
          return OK;
        },
      };
    });
    expect(thrownOf(out.traces[0]!).message).toBe('사용자가 취소했습니다');
  });

  it('마지막 작업이 취소 중 끝나면 그래프는 던지지 않고 실패한 check를 돌려준다', async () => {
    const out = await compare(() => {
      const controller = new AbortController();
      return {
        signal: controller.signal,
        workflow: { tests: [unit()] },
        exec: async () => {
          controller.abort(new Error('취소'));
          throw new Error('취소됨');
        },
      };
    });
    expect(out.traces.length).toBe(1);
  });

  it('재시도 사이에 취소되면 던진다', async () => {
    const out = await compare(() => {
      const controller = new AbortController();
      return {
        signal: controller.signal,
        workflow: { tests: [unit({ maxAttempts: 3 })] },
        exec: async () => {
          controller.abort(new Error('취소'));
          return { exitCode: 1, stdout: '', stderr: 'x' };
        },
      };
    });
    expect(thrownOf(out.traces[0]!).message).toBe('취소');
  });

  it('부하 확인 도중 취소되면 던진다(성공한 러너가 끝난 뒤에도 다음 확인 앞에서)', async () => {
    const out = await compare(() => {
      const controller = new AbortController();
      return {
        signal: controller.signal,
        workflow: { loadChecks: [loadCheck({ name: 'a' }), loadCheck({ name: 'b' })] },
        runLoad: async () => {
          controller.abort(new Error('취소'));
          return measured();
        },
      };
    });
    expect(thrownOf(out.traces[0]!).message).toBe('취소');
    expect(out.calls.filter((call) => call.startsWith('runLoad:')).length).toBe(1);
  });

  it('부하 러너가 예외로 끝났는데 취소된 상태면 예외 대신 취소를 던진다', async () => {
    const out = await compare(() => {
      const controller = new AbortController();
      return {
        signal: controller.signal,
        workflow: { loadChecks: [loadCheck()] },
        runLoad: async () => {
          controller.abort(new Error('취소'));
          throw new Error('러너가 끊겼습니다');
        },
      };
    });
    expect(thrownOf(out.traces[0]!).message).toBe('취소');
  });

  it('시작 전에 이미 취소됐으면 첫 작업 앞에서 던진다', async () => {
    const out = await compare(() => {
      const controller = new AbortController();
      controller.abort(new Error('미리 취소'));
      return { signal: controller.signal, workflow: { tests: [unit()] } };
    });
    expect(out.traces.length).toBe(1);
  });
});

describe('콜백 실패와 이벤트', () => {
  it('이벤트 처리기가 단계 이벤트에서 던지면 그 오류가 올라가고 그 뒤 호출은 없다', async () => {
    const out = await compare(() => ({
      workflow: { tests: [unit()] },
      onEvent: (event) => {
        if (event.type === 'stage' && event.stage === 'test') throw new Error('이벤트 처리 실패');
      },
    }));
    expect(thrownOf(out.traces[0]!).message).toBe('이벤트 처리 실패');
    expect(out.calls.filter((call) => call.startsWith('exec:'))).toEqual([]);
  });

  it('여러 종류를 함께 선언하면 단계 순서는 browser_check → test → concurrency_check → load_check다', async () => {
    const out = await compare(() => ({
      workflow: { pageChecks: [page()], tests: [unit()], concurrencyChecks: [conc()], loadChecks: [loadCheck()] },
      runLoad: async () => measured(),
      request: statusSequence([201, 409, 409, 409, 409]),
    }), undefined, { interleaved: true });
    expect(declaredStages(out.traces[0]!)).toEqual(['browser_check', 'test', 'concurrency_check', 'load_check']);
    expect(checksOf(out.traces[0]!).map((check) => check.stage)).toEqual(['browser_check', 'test', 'concurrency_check', 'load_check', 'review']);
  });
});

describe('동시 실행 상한', () => {
  it('동시에 둘까지만 돌고 노드 순서대로 시작한다', async () => {
    let inFlight = 0;
    let max = 0;
    const started: string[] = [];
    const out = await compare(() => {
      inFlight = 0;
      max = 0;
      started.length = 0;
      return {
        workflow: { tests: ['t1', 't2', 't3', 't4', 't5'].map((name) => unit({ name, command: ['run', name] })) },
        exec: async (command) => {
          started.push(command.join(' '));
          inFlight += 1;
          max = Math.max(max, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight -= 1;
          return OK;
        },
      };
    });
    expect(max).toBeLessThanOrEqual(2);
    expect(started).toEqual(['run t1', 'run t2', 'run t3', 'run t4', 'run t5']);
    expect(checksOf(out.traces[0]!).slice(0, 5).map((check) => check.name)).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('결과는 끝난 순서가 아니라 노드 순서다', async () => {
    const out = await compare(() => ({
      workflow: { tests: [unit({ name: 'slow', command: ['slow'] }), unit({ name: 'fast', command: ['fast'] })] },
      exec: async (command) => {
        await new Promise((resolve) => setTimeout(resolve, command[0] === 'slow' ? 30 : 1));
        return OK;
      },
    }));
    expect(checksOf(out.traces[0]!).slice(0, 2).map((check) => check.name)).toEqual(['slow', 'fast']);
  });
});

/** Rust의 `read_json_path`가 JS `readJsonPath`와 같은 값을 읽는지. 돌려주는 값은 `JSON.stringify(actual)`(없으면 "undefined")과 `actual === equals`다 */
function rustRead(text: string, jsonPath: string, equals: number | string): { shown: string; equal: boolean } {
  const out = JSON.parse(native.gateReadJsonPath(encodeLoneSurrogates(text), encodeLoneSurrogates(jsonPath), JSON.stringify(typeof equals === 'string' ? encodeLoneSurrogates(equals) : equals))) as { shown: string; equal: boolean };
  return { shown: decodeLoneSurrogates(out.shown), equal: out.equal };
}

function jsRead(text: string, jsonPath: string, equals: number | string): { shown: string; equal: boolean } {
  const actual = readJsonPath(text, jsonPath);
  return { shown: JSON.stringify(actual) ?? 'undefined', equal: actual === equals };
}

describe('readJsonPath: Rust가 JS와 같은 값을 읽는다', () => {
  const EQUALS: Array<number | string> = [0, 1, 2, 3, 6, 7, 0.1, 1e21, 9007199254740992, '', 'x', 'd', '1', '\ud800'];
  const FIXED: Array<[string, string]> = [
    ['{"items":[5,6,7]}', '$.items.length'],
    ['{"items":[5,6,7]}', '$.items.1'],
    ['{"items":[5,6,7]}', '$.items[2]'],
    ['{"items":[5,6,7]}', '$.items[3]'],
    ['{"items":[5,6,7]}', '$.items.01'],
    ['{"items":[5,6,7]}', '$.items.-0'],
    ['{"items":[5,6,7]}', '$.items.4294967295'],
    ['{"items":[[1,2],[3]]}', '$.items[1][0]'],
    ['{"a":{}}', '$.a.constructor'],
    ['{"a":{}}', '$.a.toString'],
    ['{"a":{}}', '$.a.hasOwnProperty'],
    ['{"a":{}}', '$.a.valueOf'],
    ['{"a":{}}', '$.a.__proto__'],
    ['{"a":{}}', '$.a.__proto__.__proto__'],
    ['{"a":{}}', '$.a.__proto__.__proto__.x'],
    ['{"a":{}}', '$.a.__proto__.toString'],
    ['{"a":{}}', '$.a.__proto__.constructor'],
    ['{"a":[]}', '$.a.__proto__'],
    ['{"a":[]}', '$.a.__proto__.length'],
    ['{"a":[]}', '$.a.__proto__[0]'],
    ['{"a":[]}', '$.a.__proto__.__proto__'],
    ['{"a":[]}', '$.a.map'],
    ['{"a":[]}', '$.a.constructor'],
    ['{"a":{"__proto__":7}}', '$.a.__proto__'],
    ['{"a":{"__proto__":{"b":1}}}', '$.a.__proto__.b'],
    ['{"a":{"constructor":6}}', '$.a.constructor'],
    ['{"a":{"length":3}}', '$.a.length'],
    ['{"a":1,"a":2}', '$.a'],
    ['{"a":1,"b":2,"a":3}', '$.a'],
    ['{"a":0.1}', '$.a'],
    ['{"a":9007199254740993}', '$.a'],
    ['{"a":-0}', '$.a'],
    ['{"a":0.0}', '$.a'],
    ['{"a":1e21}', '$.a'],
    ['{"a":1e999}', '$.a'],
    ['{"a":-1e999}', '$.a'],
    ['{"a":1E2}', '$.a'],
    ['{"a":"x"}', '$.a.length'],
    ['{"a":[1]}', '$.a[99999999999999999999]'],
    ['{"a":[1]}', '$.a[00]'],
    ['{"a":[1]}', '$.a[0][0]'],
    ['[10,20]', '$[1]'],
    ['[10,20]', '$.1'],
    ['[10,20]', '$'],
    ['{"a":1}', 'a'],
    ['{"a":1}', '$a'],
    ['{"a":1}', '$'],
    ['{"a":1}', '$.'],
    ['{"a":1}', ''],
    ['{"":1}', '$..'],
    ['{"":1}', '$.'],
    ['{"a b":2}', '$.a b'],
    ['{"a":{"b":3}}', '$.a..b'],
    ['{"a":[{"b":4}]}', '$.a[0].b'],
    ['{"a":1}', '$.a['],
    ['{"a":1}', '$.a]'],
    ['{"a":[1]}', '$.a[0]x'],
    ['{"a":[1]}', '$.a[-1]'],
    ['{"a":[1]}', '$.a[0'],
    ['{"a":[1]}', '$.[0]'],
    ['{"a":[1]}', '$.a[0][]'],
    ['{"a":[1]}', '$.a[ 0 ]'],
    ['{"a":[1]}', '$.a[٠]'],
    ['{"a":"\\\\ud800"}', '$.a'],
    ['{"a":"\\ud800"}', '$.a'],
    ['{"a":"\\ud83d\\ude00"}', '$.a'],
    ['{"a":"\\u0000\\u001f\\"\\\\/"}', '$.a'],
    ['{"\\u0000nf":5}', '$.\u0000nf'],
    ['{"a":{"b":[1,{"c":"d"}]}}', '$.a.b[1].c'],
    ['{"a":{"b":[1,{"c":"d"}]}}', '$.a.b[1]'],
    ['{"a":{"b":[1,{"c":"d"}]}}', '$.a'],
    ['{"2":"x","1":"y","a":"z"}', '$'],
    ['{"b":1,"2":{"y":1,"1":2},"a":3,"1":0}', '$'],
    ['{"a":null}', '$.a'],
    ['{"a":null}', '$.a.b'],
    ['{"a":true}', '$.a'],
    ['{"a":false}', '$.a.b'],
    ['null', '$'],
    ['null', '$.a'],
    ['5', '$'],
    ['5', '$.a'],
    ['"str"', '$'],
    ['"str"', '$.length'],
    ['', '$'],
    ['not json', '$'],
    ['{', '$'],
    ['{"a":1}x', '$.a'],
    ['  {"a":1}  ', '$.a'],
    ['{"a":1,}', '$.a'],
    ["{'a':1}", '$.a'],
    ['{"a":01}', '$.a'],
    ['{"a":.5}', '$.a'],
    ['{"a":NaN}', '$.a'],
    ['{"a":"\\x"}', '$.a'],
    ['{"a":"\\u12"}', '$.a'],
    ['{"a":"\\n"}', '$.a'],
    ['{"a":"\\u2028"}', '$.a'],
    ['{"a":"\\u007f"}', '$.a'],
    ['{"a":"<>&"}', '$.a'],
    ['{"a":"한글\\ud83d"}', '$.a'],
    ['{"\\ud800":1}', '$.\ud800'],
    ['{"é":1}', '$.é'],
    ['{"a":""}', '$.a'],
    ['{"a":""}', '$.a'],
    ['{"a":"\ud800"}', '$.a'],
    ['{"a":""}', '$.a'],
  ];

  it('고정한 사례(상속 속성·길이·숫자 키·중복 키·정밀도·잘못된 JSON·경로 꼴)', () => {
    for (const [text, jsonPath] of FIXED) {
      for (const equals of EQUALS) {
        expect(rustRead(text, jsonPath, equals), `${JSON.stringify(text)} ${JSON.stringify(jsonPath)} ${JSON.stringify(equals)}`).toEqual(jsRead(text, jsonPath, equals));
      }
    }
  });

  it('무작위 문서와 경로(시드 고정)', () => {
    const gen = new Gen(20261114);
    const keys = ['a', 'b', 'c', '0', '1', '2', 'length', 'constructor', '__proto__', 'toString', 'x y', '', '01', 'é', '\\ud800'];
    const scalar = (): string =>
      gen.weighted<() => string>([
        [3, () => String(gen.int(10))],
        [2, () => JSON.stringify(gen.pick(['x', 'd', '', '1', 'é']))],
        [1, () => 'null'],
        [1, () => 'true'],
        [1, () => '-0'],
        [1, () => '1e21'],
        [1, () => '0.1'],
      ])();
    const doc = (depth: number): string => {
      if (depth <= 0 || gen.chance(0.3)) return scalar();
      if (gen.chance(0.5)) return `[${gen.list(0, 3, () => doc(depth - 1)).join(',')}]`;
      return `{${gen.list(0, 4, () => `${JSON.stringify(gen.pick(keys))}:${doc(depth - 1)}`).join(',')}}`;
    };
    const segment = (): string => {
      const key = gen.pick([...keys, 'a', 'b', '']);
      const indexes = gen.list(0, 2, () => `[${gen.pick(['0', '1', '2', '00', '9', '99999999999999999999'])}]`).join('');
      return `${key.replaceAll('.', '')}${indexes}`;
    };
    for (let i = 0; i < 400; i += 1) {
      const text = doc(4);
      const jsonPath = `${gen.pick(['$.', '$', '', '$.'])}${gen.list(0, 4, segment).join('.')}`;
      const equals = gen.pick(EQUALS);
      expect(rustRead(text, jsonPath, equals), `${text} ${jsonPath} ${JSON.stringify(equals)}`).toEqual(jsRead(text, jsonPath, equals));
    }
  });
});
