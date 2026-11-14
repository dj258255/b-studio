import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SandboxError, type ExecResult, type LoadRequest, type LoadResult, type Sandbox } from '@b-studio/sandbox';
import { SPEC_FILE, type LoadedProject, type WorkflowLoadCheck, type WorkflowSpec } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import type { OpenApiDocument } from './contract-diff';
import { VerificationGate } from './gate';
import { legacyCheck } from './gate-legacy';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT } from './test-helpers';
import { Workspace } from './workspace';

/**
 * 게이트 check의 상태 기계를 Rust로 옮기면서(ADR-195 4f A5b-1) 옛 구현(`gate-legacy.ts`)과 지금 구현(`VerificationGate.check`)에 **같은 시나리오**를 넣어 견준다.
 * 시나리오마다 임시 폴더에 프로젝트를 새로 만들고(도커·네트워크 없음, 가짜 sandbox) 옛 쪽과 지금 쪽이 각자의 세계에서 돈다.
 * 견주는 것: ① check마다 결과(`GateOutcome` 또는 던진 오류의 종류·글) ② 그 check가 낸 이벤트 배열 전체(JSON 글, 키 순서 포함) ③ check가 끝난 뒤 게이트의 공개 상태
 * (`attempts`·`report`·`checks`·`passedStages`(정렬)·`skippedStages`·`verified`·`platformFailure`·`lastOutcome`) ④ sandbox 호출 기록(순서와 인자).
 * 임시 폴더 경로는 `<R>`로 바꿔 견준다. 서비스 재시작은 병렬이라 이어진 `restart:` 줄은 정렬해 견준다.
 *
 * 하위 단계(선언 정하기·기록 검사·선언한 검사 실행·리뷰 등)는 둘이 같은 게이트 객체의 메서드를 부른다. 이 시험이 견주는 것은 그 단계들을 **부르는 순서·분기·결과 조립**이다.
 */

const roots: string[] = [];

type Mode = 'legacy' | 'current';
type Restart = true | 'code' | 'platform';

interface Setup {
  workflow?: Partial<WorkflowSpec>;
  /** 디스크의 studio.yaml에도 이 workflow를 적는다 */
  yaml?: boolean;
  /** 게이트를 만들기 전에 디스크에 둘 것(프로젝트 루트) */
  seed?: (root: string) => Promise<void>;
  verify?: 'light';
  recheck?: true;
  allowCheckChanges?: boolean;
  maxVerifyAttempts?: number;
  platformRetryDelayMs?: number;
  /** 서비스별 재시작 결과를 부른 순서대로. 다 쓰면 성공 */
  restarts?: Record<string, Restart[]>;
  /** 반영 확인(sync)이 던질 오류. 부를 때마다 */
  syncError?: () => Error | undefined;
  exec?: (command: string[], root: string) => ExecResult | Promise<ExecResult>;
  strays?: Awaited<ReturnType<NonNullable<Sandbox['strayProcesses']>>> | 'throw' | (() => never);
  addons?: boolean;
  runLoad?: Sandbox['runLoad'];
  outsideChanges?: { pendingFiles: () => Promise<readonly string[]> };
  signal?: AbortSignal;
  /** 계약을 가져올 때마다 부른다. 돌려준 문서를 쓴다 */
  contract?: () => OpenApiDocument | Promise<OpenApiDocument>;
  /** 이벤트마다 부른다. 던지면 `onEvent`가 던진 것이다 */
  onEvent?: (event: AgentEvent) => void;
  findSecrets?: () => string[];
  /** `fakeSandbox`를 만든 뒤 바꿀 것 */
  tweak?: (sandbox: Sandbox & { restarts: string[] }) => void;
}

interface Trace {
  label: string;
  result: { outcome: unknown } | { threw: { name: string; message: string } };
  events: string[];
  state: unknown;
  /** 키 순서까지 견주는 글. 임시 폴더 경로는 `<R>`로 바꿨다 */
  text: string;
}

interface World {
  root: string;
  gate: VerificationGate;
  workspace: Workspace;
  calls: string[];
  /** 작업 공간 도구로 쓴다(바뀐 파일로 기록된다) */
  write(file: string, content: string): Promise<void>;
  /** 도구를 거치지 않고 디스크를 직접 고친다 */
  disk(file: string, content: string): Promise<void>;
  run(label: string): Promise<void>;
  /** 마지막 check가 낸 이벤트 */
  last(): Trace;
}

const studioYaml = (workflow: Partial<WorkflowSpec> | undefined): string =>
  JSON.stringify({
    version: 1,
    name: 'orders',
    services: {
      api: { source: 'managed', template: 'spring-boot', path: 'api', port: 8080, preview: 'openapi', contract: { extract: '/v3/api-docs' } },
      web: { source: 'managed', template: 'nextjs', path: 'web', port: 3000, preview: 'browser' },
    },
    ...(workflow ? { workflow } : {}),
  });

const OK: ExecResult = { exitCode: 0, stdout: '', stderr: '' };

async function createWorld(mode: Mode, setup: Setup, traces: Trace[]): Promise<World> {
  const base = await createOrdersProject('gate-check-diff-');
  roots.push(base.root);
  const root = base.root;
  await writeFile(path.join(root, 'compose.yaml'), 'services:\n  api: { build: ./api }\n  web: { build: ./web }\n');
  if (setup.yaml) await writeFile(path.join(root, SPEC_FILE), studioYaml(setup.workflow));
  if (setup.seed) await setup.seed(root);
  let project = (setup.workflow ? { ...base, spec: { ...base.spec, workflow: setup.workflow } } : base) as LoadedProject;
  if (setup.addons) {
    await writeFile(path.join(root, SPEC_FILE), 'version: 1\nname: orders\nservices:\n  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi, contract: { extract: "/v3/api-docs" } }\n');
    await writeFile(path.join(root, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
    project = { ...project, composePath: path.join(root, 'compose.yaml') } as unknown as LoadedProject;
  }

  const calls: string[] = [];
  const sandbox = fakeSandbox(project, []);
  const outcomes = Object.fromEntries(Object.entries(setup.restarts ?? {}).map(([service, list]) => [service, [...list]]));
  sandbox.restart = async (service: string) => {
    calls.push(`restart:${service}`);
    const outcome = outcomes[service]?.shift() ?? true;
    if (outcome === 'platform') throw new SandboxError('/work/.git/b-studio 폴더를 가릴 빈 폴더를 준비하지 못했습니다', "EEXIST: file already exists, mkdir '/work/.git/b-studio-empty'", { platform: true });
    if (outcome === 'code') throw new Error('컨테이너가 종료됐습니다');
    return { service, containerPort: 8080, url: 'http://127.0.0.1:1' };
  };
  sandbox.sync = async (files: string[]) => {
    calls.push(`sync:${files.join(',')}`);
    const error = setup.syncError?.();
    if (error) throw error;
    return { elapsedMs: 0, checks: 1 };
  };
  sandbox.exec = async (service, command) => {
    calls.push(`exec:${service}:${command.join(' ')}`);
    return setup.exec ? setup.exec(command, root) : OK;
  };
  if (setup.findSecrets) {
    sandbox.findSecrets = () => {
      calls.push('findSecrets');
      return setup.findSecrets!();
    };
  }
  if (setup.strays !== undefined) {
    sandbox.strayProcesses = async () => {
      calls.push('scan');
      if (setup.strays === 'throw') throw new Error('도커가 응답하지 않습니다');
      if (typeof setup.strays === 'function') return setup.strays();
      return setup.strays!;
    };
  }
  if (setup.addons) {
    sandbox.ensureInfra = async (services) => {
      calls.push(`ensureInfra:${services.join(',')}`);
      return { ok: true, recovered: [...services] };
    };
  }
  if (setup.runLoad) sandbox.runLoad = async (request: LoadRequest): Promise<LoadResult> => setup.runLoad!(request);
  setup.tweak?.(sandbox);

  const workspace = new Workspace(root);
  const events: string[] = [];
  const gate = await VerificationGate.create({
    project,
    sandbox,
    workspace,
    allowBreaking: false,
    maxVerifyAttempts: setup.maxVerifyAttempts ?? 3,
    platformRetryDelayMs: setup.platformRetryDelayMs ?? 1,
    ...(setup.verify ? { verify: setup.verify } : {}),
    ...(setup.recheck ? { recheck: setup.recheck } : {}),
    ...(setup.allowCheckChanges ? { allowCheckChanges: true } : {}),
    ...(setup.outsideChanges ? { outsideChanges: setup.outsideChanges } : {}),
    ...(setup.signal ? { signal: setup.signal } : {}),
    fetcher: async () => (setup.contract ? setup.contract() : ORDERS_CONTRACT),
    pageFetcher: async () => ({ status: 200, text: '<h1>주문 목록</h1>' }),
    onEvent: (event) => {
      events.push(JSON.stringify(event));
      setup.onEvent?.(event);
    },
  });

  return {
    root,
    gate,
    workspace,
    calls,
    write: (file, content) => workspace.write(file, content),
    disk: async (file, content) => {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    },
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
        report: gate.report,
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

/** 이어진 `restart:` 줄(병렬)은 정렬한다 */
function normalizeCalls(calls: string[]): string[] {
  const out: string[] = [];
  let group: string[] = [];
  const flush = () => {
    out.push(...group.sort());
    group = [];
  };
  for (const call of calls) {
    if (call.startsWith('restart:')) group.push(call);
    else {
      flush();
      out.push(call);
    }
  }
  flush();
  return out;
}

async function runWorld(mode: Mode, makeSetup: () => Setup, steps: (world: World) => Promise<void>) {
  const traces: Trace[] = [];
  const world = await createWorld(mode, makeSetup(), traces);
  await steps(world);
  return { traces, texts: traces.map((trace) => trace.text), calls: normalizeCalls(world.calls), gate: world.gate };
}

/** 같은 시나리오를 옛 구현과 지금 구현에 넣어 견주고, 옛 구현의 결과를 돌려준다 */
async function compare(makeSetup: () => Setup, steps: (world: World) => Promise<void>) {
  const legacy = await runWorld('legacy', makeSetup, steps);
  const current = await runWorld('current', makeSetup, steps);
  expect(current.texts).toEqual(legacy.texts);
  expect(current.calls).toEqual(legacy.calls);
  expect(legacy.traces.length).toBeGreaterThan(0);
  return legacy;
}

const types = (trace: Trace): string[] => trace.events.map((event) => (JSON.parse(event) as { type: string }).type);
const stagesOf = (trace: Trace): string[] => trace.events.map((event) => JSON.parse(event) as { type: string; stage?: string }).filter((event) => event.type === 'stage').map((event) => event.stage!);
const outcomeOf = (trace: Trace) => (trace.result as { outcome: { kind: string; feedback?: string; summary?: string } }).outcome;
const thrownOf = (trace: Trace) => (trace.result as { threw: { name: string; message: string } }).threw;

const CHANGE = ['api/src/Order.java', 'class Order { String memo; }\n'] as const;
const unit = { name: 'unit', service: 'api', command: ['./gradlew', 'test'], maxAttempts: 1 };
const failing = (): ExecResult => ({ exitCode: 1, stdout: '', stderr: 'FAILED OrderTest' });
const REQ = 'docs/requirements.md';
const PLAIN = '# 요구사항\n\n## R1. 로그인\n- 종류: api · 우선순위: must\n- 인수 조건:\n  - a\n- 상태: 미착수\n';
const forge = (doc: string) => doc.replace('- 상태:', '- 확인: 에이전트 · 2026-10-10 · 체크포인트 abc1234 · 메모 확인함\n- 상태:');
const seedDoc = (root: string) => mkdir(path.join(root, 'docs'), { recursive: true }).then(() => writeFile(path.join(root, REQ), PLAIN));

describe('바뀐 파일이 없는 턴', () => {
  it('기록 검사가 모두 통과하면 이벤트도 상태도 건드리지 않고 통과한다', async () => {
    const out = await compare(() => ({ seed: seedDoc }), async (w) => {
      await w.run('empty');
    });
    expect(outcomeOf(out.traces[0]!)).toEqual({ kind: 'pass' });
    expect(out.traces[0]!.events).toEqual([]);
    expect(out.calls).toEqual([]);
  });

  it('사람 확인 기록을 도구 밖에서 위조하면 검사 결과만으로 실패하고, 상한에서 사유 첫 줄을 적는다', async () => {
    const out = await compare(() => ({ seed: seedDoc, maxVerifyAttempts: 2 }), async (w) => {
      await w.disk(REQ, forge(PLAIN));
      await w.run('first');
      await w.run('second');
    });
    expect(outcomeOf(out.traces[0]!).kind).toBe('retry');
    expect(types(out.traces[0]!)).toEqual(['workflow_check']);
    expect(outcomeOf(out.traces[1]!)).toMatchObject({ kind: 'exhausted', summary: expect.stringContaining('검증 게이트를 2번 통과하지 못했습니다 — ') });
  });

  it('도구 밖에서 평가 자산을 고치면 test 단계로 실패한다', async () => {
    const out = await compare(
      () => ({
        workflow: { tests: [unit], evaluationAssets: ['tests/acceptance'] },
        seed: async (root) => {
          await mkdir(path.join(root, 'tests/acceptance'), { recursive: true });
          await writeFile(path.join(root, 'tests/acceptance/a.test.js'), 'expect(1).toBe(1)\n');
        },
      }),
      async (w) => {
        await w.disk('tests/acceptance/a.test.js', 'expect(1).toBe(2)\n');
        await w.run('assets');
      },
    );
    expect(outcomeOf(out.traces[0]!).kind).toBe('retry');
    expect(out.calls).toEqual([]);
  });

  it('게이트가 다룰 수 없는 경로가 바뀌었으면 outside-tool-changes로 실패한다', async () => {
    const pending = { list: [] as string[] };
    const out = await compare(
      () => {
        pending.list = [];
        return { outsideChanges: { pendingFiles: async () => pending.list } };
      },
      async (w) => {
        const { symlink } = await import('node:fs/promises');
        await symlink(path.join(w.root, 'api/src/Order.java'), path.join(w.root, 'link-order.java'));
        pending.list = ['link-order.java'];
        await w.run('rejected');
      },
    );
    expect(outcomeOf(out.traces[0]!).kind).toBe('retry');
    expect(out.traces[0]!.events.join('')).toContain('outside-tool-changes');
  });

  it('recheck면 바뀐 파일이 없어도 검증을 건너뛰지 않는다(studio.yaml을 바뀐 파일로 넘긴다)', async () => {
    const out = await compare(() => ({ recheck: true, yaml: true, workflow: { tests: [unit] } }), async (w) => {
      await w.run('recheck');
    });
    expect(stagesOf(out.traces[0]!)).toContain('run');
    expect(out.calls).toContain('exec:api:./gradlew test');
    expect(out.calls.filter((call) => call.startsWith('restart:')).sort()).toEqual(['restart:api', 'restart:web']);
  });
});

describe('정상 경로', () => {
  it('통과하면 단계·이벤트·상태를 옛 코드와 같게 남긴다', async () => {
    const out = await compare(() => ({ workflow: { tests: [unit] } }), async (w) => {
      await w.write(...CHANGE);
      await w.run('pass');
    });
    const trace = out.traces[0]!;
    expect(outcomeOf(trace)).toEqual({ kind: 'pass' });
    expect(stagesOf(trace)).toEqual(['run', 'contract_check', 'test', 'review']);
    expect(types(trace).slice(0, 4)).toEqual(['stage', 'verify_start', 'stage', 'verify_result']);
    expect(types(trace).at(-1)).toBe('gate_done');
    expect(JSON.parse(trace.events[3]!)).toMatchObject({ moreChecks: true });
    expect((trace.state as { verified: boolean }).verified).toBe(true);
  });

  it('선언이 없어도(필수 단계만) 통과한다', async () => {
    await compare(() => ({}), async (w) => {
      await w.write(...CHANGE);
      await w.run('pass');
    });
  });

  it('계약이 깨지면 gate_done 없이 실패 안내를 돌려주고 상한에서 멈춘다', async () => {
    const out = await compare(
      () => {
        let phase = 0;
        return { contract: () => (phase++ === 0 ? ORDERS_CONTRACT : { paths: {}, components: { schemas: {} } }) };
      },
      async (w) => {
        await w.write(...CHANGE);
        await w.run('1');
        await w.run('2');
        await w.run('3');
      },
    );
    expect(outcomeOf(out.traces[0]!).kind).toBe('retry');
    expect(outcomeOf(out.traces[0]!).feedback).toContain('검증 실패');
    expect(types(out.traces[0]!)).toEqual(['stage', 'verify_start', 'stage', 'verify_result']);
    expect(JSON.parse(out.traces[0]!.events[3]!).moreChecks).toBeUndefined();
    expect(outcomeOf(out.traces[2]!)).toEqual({ kind: 'exhausted', summary: '검증 게이트를 3번 통과하지 못했습니다' });
  });

  it('서비스가 준비되지 않으면 실패하고, 다음 check는 실패한 서비스의 파일도 다시 본다', async () => {
    const out = await compare(() => ({ restarts: { api: ['code'] } }), async (w) => {
      await w.write(...CHANGE);
      await w.run('not-ready');
      await w.run('fixed');
    });
    expect(outcomeOf(out.traces[0]!).kind).toBe('retry');
    expect(outcomeOf(out.traces[1]!).kind).toBe('pass');
  });

  it('선언한 검사가 실패하면 실패를 앞에 쓰고 서비스 확인 통과를 참고로 덧붙인다(#1155)', async () => {
    const out = await compare(() => ({ workflow: { tests: [unit] }, exec: failing }), async (w) => {
      await w.write(...CHANGE);
      await w.run('failed-test');
    });
    const feedback = outcomeOf(out.traces[0]!).feedback!;
    expect(feedback).toContain('[참고] 서비스 재시작·계약 확인은 통과했습니다.');
    expect(feedback.indexOf('워크플로 검사 실패')).toBeLessThan(feedback.indexOf('검증 통과'));
    expect(types(out.traces[0]!).at(-1)).toBe('gate_done');
    expect(JSON.parse(out.traces[0]!.events.at(-1)!)).toEqual({ type: 'gate_done', ok: false });
  });

  it('필수 단계가 돌지 않았으면 완료로 인정하지 않는다', async () => {
    const out = await compare(() => ({ workflow: { required: ['plan', 'implement', 'test', 'checkpoint'] } }), async (w) => {
      await w.write(...CHANGE);
      await w.run('missing');
    });
    expect(outcomeOf(out.traces[0]!)).toEqual({ kind: 'exhausted', summary: '워크플로 필수 단계가 실행되지 않아 완료로 인정하지 않습니다: test' });
    expect(JSON.parse(out.traces[0]!.events.at(-1)!)).toEqual({ type: 'gate_done', ok: false });
  });

  it('보호 경로를 바꾸면 review 단계가 실패한다', async () => {
    const out = await compare(() => ({ workflow: { protectedPaths: ['api/src/Order.java'] } }), async (w) => {
      await w.write(...CHANGE);
      await w.run('protected');
    });
    expect(outcomeOf(out.traces[0]!).kind).toBe('retry');
  });

  it('승격이 준 예산으로 상한을 늘리면 그만큼 다시 돈다', async () => {
    await compare(() => ({ restarts: { api: ['code', 'code', 'code', 'code', 'code'] } }), async (w) => {
      await w.write(...CHANGE);
      await w.run('1');
      await w.run('2');
      await w.run('3');
      expect(w.gate.grantRetryBudget(2)).toBe(true);
      await w.run('4');
      await w.run('5');
    });
  });
});

describe('플랫폼 실패', () => {
  it('한 번 다시 해서 통과하면 모델은 실패를 보지 않는다', async () => {
    const out = await compare(() => ({ restarts: { api: ['platform'] } }), async (w) => {
      await w.write(...CHANGE);
      await w.run('retried');
    });
    expect(outcomeOf(out.traces[0]!)).toEqual({ kind: 'pass' });
    expect(out.calls.filter((call) => call === 'restart:api')).toHaveLength(2);
  });

  it('다시 해도 실패면 재시도 횟수를 쓰지 않고 exhausted로 멈춘다', async () => {
    const out = await compare(() => ({ restarts: { api: ['platform', 'platform'] } }), async (w) => {
      await w.write(...CHANGE);
      await w.run('platform');
    });
    expect(outcomeOf(out.traces[0]!).kind).toBe('exhausted');
    expect((out.traces[0]!.state as { attempts: number; platformFailure: string }).attempts).toBe(0);
    expect((out.traces[0]!.state as { platformFailure: string }).platformFailure).toContain('가릴 빈 폴더');
    expect(types(out.traces[0]!)).toEqual(['stage', 'verify_start', 'stage', 'verify_result']);
  });

  it('플랫폼 실패 뒤 다음 check가 통과하면 platformFailure를 비운다', async () => {
    const out = await compare(() => ({ restarts: { api: ['platform', 'platform'] } }), async (w) => {
      await w.write(...CHANGE);
      await w.run('platform');
      await w.run('recovered');
    });
    expect((out.traces[0]!.state as { platformFailure?: string }).platformFailure).toContain('가릴 빈 폴더');
    expect(outcomeOf(out.traces[1]!)).toEqual({ kind: 'pass' });
    expect((out.traces[1]!.state as { platformFailure?: string }).platformFailure).toBeUndefined();
  });

  it('부하 확인을 b-studio 쪽 문제로 재지 못하면 gate_done(false) 뒤 exhausted다', async () => {
    const load: WorkflowLoadCheck = { name: 'orders-p95', service: 'api', method: 'POST', path: '/api/orders', concurrent: 10, warmup: 0, expect: { p95Ms: 200 } } as WorkflowLoadCheck;
    const out = await compare(
      () => ({
        workflow: { loadChecks: [load] },
        runLoad: async () => {
          throw new SandboxError('부하 러너를 실행하지 못했습니다', 'network not found', { platform: true });
        },
      }),
      async (w) => {
        await w.write(...CHANGE);
        await w.run('load');
      },
    );
    expect(outcomeOf(out.traces[0]!).kind).toBe('exhausted');
    expect(outcomeOf(out.traces[0]!).summary).toContain('바꾼 코드의 문제가 아닙니다');
    expect((out.traces[0]!.state as { attempts: number }).attempts).toBe(0);
    expect(JSON.parse(out.traces[0]!.events.at(-1)!)).toEqual({ type: 'gate_done', ok: false });
    expect(stagesOf(out.traces[0]!)).not.toContain('review');
  });
});

describe('남은 프로세스(#765)', () => {
  const found = [
    { service: 'api', processes: [{ pid: 15, command: 'sh -c while true; do cp b a; done' }, { pid: 16, command: '' }, { pid: 17, command: 'c' }, { pid: 18, command: 'd' }, { pid: 19, command: 'e' }, { pid: 20, command: 'lone \ud800 x' }] },
    { service: 'web', error: '확인하지 못했습니다' },
  ];

  it('찾으면 그 서비스도 다시 띄우고 무엇을 찾았는지 review 기록으로 남긴다', async () => {
    const out = await compare(() => ({ strays: found, workflow: { tests: [unit] } }), async (w) => {
      await w.write('web/app/page.tsx', 'export default function Page() { return null; }\n');
      await w.run('strays');
    });
    expect(out.calls.indexOf('scan')).toBeLessThan(out.calls.indexOf('restart:api'));
    const detail = (out.traces[0]!.state as { checks: Array<{ name: string; detail?: string }> }).checks.find((check) => check.name === 'background-processes')!.detail!;
    expect(detail).toContain('api: sh -c while true; do cp b a; done, pid 16, c 외 3개 / web: 확인하지 못했습니다');
  });

  it('찾지 못하면(빈 목록) 아무것도 더하지 않는다', async () => {
    await compare(() => ({ strays: [] }), async (w) => {
      await w.write(...CHANGE);
      await w.run('none');
    });
  });

  it('조회가 실패하면 managed 서비스를 모두 다시 띄우고 사유를 남긴다', async () => {
    const out = await compare(() => ({ strays: 'throw' }), async (w) => {
      await w.write(...CHANGE);
      await w.run('throws');
    });
    expect(out.calls.filter((call) => call.startsWith('restart:'))).toEqual(['restart:api']);
    expect(JSON.stringify(out.traces[0]!.state)).toContain('서비스 안의 백그라운드 프로세스를 확인하지 못해 서비스를 모두 다시 띄웠습니다: 도커가 응답하지 않습니다');
  });

  it('문자열이 아닌 오류로 실패해도 글자로 읽는다', async () => {
    await compare(
      () => ({
        strays: (() => {
          throw 'plain';
        }) as () => never,
      }),
      async (w) => {
        await w.write(...CHANGE);
        await w.run('throws-string');
      },
    );
  });
});

describe('compose에 새로 생긴 부가 서비스', () => {
  it('올렸으면 warning 이벤트를 verify_result 바로 뒤에 낸다', async () => {
    const out = await compare(() => ({ addons: true }), async (w) => {
      await w.write('compose.yaml', 'services:\n  api: { build: ./api }\n  mediamtx: { image: bluenviron/mediamtx:latest }\n');
      await w.run('addons');
    });
    expect(types(out.traces[0]!).slice(0, 5)).toEqual(['stage', 'verify_start', 'stage', 'verify_result', 'warning']);
  });
});

describe('light', () => {
  it('재시작·준비·계약만 돌고 건너뛴 단계를 기록한다', async () => {
    const out = await compare(() => ({ verify: 'light', workflow: { tests: [unit] } }), async (w) => {
      await w.write(...CHANGE);
      await w.run('light');
    });
    expect(outcomeOf(out.traces[0]!)).toEqual({ kind: 'pass' });
    expect((out.traces[0]!.state as { skippedStages: string[] }).skippedStages).toContain('test');
    expect(out.calls.some((call) => call.startsWith('exec:'))).toBe(false);
  });

  it('light에서도 기록 검사가 실패하면 통과하지 않는다', async () => {
    const out = await compare(() => ({ verify: 'light', seed: seedDoc }), async (w) => {
      await w.write(...CHANGE);
      await w.disk(REQ, forge(PLAIN));
      await w.run('light-forged');
    });
    expect(outcomeOf(out.traces[0]!).kind).toBe('retry');
    expect((out.traces[0]!.state as { verified: boolean }).verified).toBe(false);
  });
});

describe('확인 선언', () => {
  it('허용하지 않은 선언 변경이 있으면 실패 안내와 상한 사유에 그 사실을 싣는다', async () => {
    const out = await compare(() => ({ yaml: true, workflow: { tests: [unit] }, exec: failing, maxVerifyAttempts: 2 }), async (w) => {
      await w.write(...CHANGE);
      await w.write(SPEC_FILE, studioYaml({}));
      await w.run('1');
      await w.run('2');
    });
    expect(outcomeOf(out.traces[0]!).feedback).toContain('이번 실행에서 studio.yaml의 확인 선언을 바꿨지만(삭제: 테스트 unit)');
    expect(outcomeOf(out.traces[1]!).summary).toContain("확인의 선언을 바꾸려던 것이면 '확인 선언 변경 허용'을 켜고 다시 요청하세요(이번 실행에서 바뀐 선언: 삭제: 테스트 unit)");
  });

  it('허용하면 바뀐 선언으로 검증하고 declared-checks 기록을 남긴다', async () => {
    const latest = { tests: [{ ...unit, command: ['./gradlew', 'test', '--tests', 'OrderTest'] }, { name: 'lint', service: 'api', command: ['lint'], maxAttempts: 1 }] };
    const out = await compare(() => ({ yaml: true, workflow: { tests: [unit] }, allowCheckChanges: true }), async (w) => {
      await w.write(...CHANGE);
      await w.write(SPEC_FILE, studioYaml(latest));
      await w.run('allowed');
    });
    expect(outcomeOf(out.traces[0]!)).toEqual({ kind: 'pass' });
    expect(out.calls.filter((call) => call.startsWith('exec:')).length).toBeGreaterThanOrEqual(2);
  });

  it('선언을 약하게 바꾸면 허용하지 않은 실행은 통과하지 않는다', async () => {
    const out = await compare(() => ({ yaml: true, workflow: { tests: [unit] } }), async (w) => {
      await w.write(...CHANGE);
      await w.write(SPEC_FILE, studioYaml({}));
      await w.run('weakened');
    });
    expect(outcomeOf(out.traces[0]!).kind).toBe('retry');
  });
});

describe('검사 뒤 다시 견줌(TOCTOU)', () => {
  it('테스트가 도는 동안 평가 자산이 바뀌면 같은 실패로 바꾼다', async () => {
    const out = await compare(
      () => ({
        workflow: { tests: [unit], evaluationAssets: ['tests/acceptance'] },
        seed: async (root) => {
          await mkdir(path.join(root, 'tests/acceptance'), { recursive: true });
          await writeFile(path.join(root, 'tests/acceptance/a.test.js'), 'expect(1).toBe(1)\n');
        },
        exec: async (_command, root) => {
          await writeFile(path.join(root, 'tests/acceptance/a.test.js'), 'expect(1).toBe(2)\n');
          return OK;
        },
      }),
      async (w) => {
        await w.write(...CHANGE);
        await w.run('toctou-assets');
      },
    );
    expect(outcomeOf(out.traces[0]!).kind).toBe('retry');
    expect(JSON.stringify(out.traces[0]!.state)).toContain('"name":"evaluation-assets","ok":false');
  });

  it('테스트가 도는 동안 도구 밖에서 파일이 바뀌면 outside-tool-changes로 바꾼다', async () => {
    const out = await compare(
      () => {
        let pending: string[] = [];
        return {
          workflow: { tests: [unit] },
          outsideChanges: { pendingFiles: async () => pending },
          exec: async (_command, root) => {
            await writeFile(path.join(root, 'api/src/Generated.java'), 'class Generated {}\n');
            pending = ['api/src/Generated.java'];
            return OK;
          },
        };
      },
      async (w) => {
        await w.write(...CHANGE);
        await w.run('toctou-outside');
      },
    );
    expect(outcomeOf(out.traces[0]!).kind).toBe('retry');
    expect(JSON.stringify(out.traces[0]!.state)).toContain('검사하는 동안 파일이 바뀌었습니다');
  });
});

describe('취소', () => {
  const reason = new Error('중단');

  it('플랫폼 실패 뒤 다시 하기 전에 취소됐으면 그 자리에서 끊긴다', async () => {
    const out = await compare(
      () => {
        const controller = new AbortController();
        return { signal: controller.signal, syncError: () => { controller.abort(reason); return new SandboxError('반영 확인 실패', 'x', { platform: true }); } };
      },
      async (w) => {
        await w.write(...CHANGE);
        await w.run('before-retry-sleep');
      },
    );
    expect(thrownOf(out.traces[0]!)).toEqual({ name: 'Error', message: '중단' });
    expect(types(out.traces[0]!)).toEqual(['stage', 'verify_start']);
    expect((out.traces[0]!.state as { lastOutcome?: string }).lastOutcome).toBeUndefined();
  });

  it('다시 하기 전에 기다리는 중 취소되면 AbortError로 끊긴다', async () => {
    const out = await compare(
      () => {
        const controller = new AbortController();
        return {
          signal: controller.signal,
          platformRetryDelayMs: 2000,
          syncError: () => {
            setTimeout(() => controller.abort(reason), 80);
            return new SandboxError('반영 확인 실패', 'x', { platform: true });
          },
        };
      },
      async (w) => {
        await w.write(...CHANGE);
        await w.run('during-sleep');
      },
    );
    expect(thrownOf(out.traces[0]!).name).toBe('AbortError');
    expect(types(out.traces[0]!)).toEqual(['stage', 'verify_start']);
  });

  it('서비스 확인 뒤 취소됐으면 contract_check 단계를 내지 않고 끊긴다', async () => {
    const out = await compare(
      () => {
        const controller = new AbortController();
        return { signal: controller.signal, contract: () => { controller.abort(reason); return ORDERS_CONTRACT; } };
      },
      async (w) => {
        await w.write(...CHANGE);
        await w.run('after-verify');
      },
    );
    expect(thrownOf(out.traces[0]!).message).toBe('중단');
    expect(stagesOf(out.traces[0]!)).toEqual(['run']);
    expect((out.traces[0]!.state as { report?: unknown }).report).toBeUndefined();
  });

  it('선언한 검사가 끝난 뒤 취소됐으면 다시 견줌·리뷰 없이 끊기고 gate_done도 없다', async () => {
    const out = await compare(
      () => {
        const controller = new AbortController();
        return {
          signal: controller.signal,
          workflow: { tests: [unit] },
          exec: () => {
            controller.abort(reason);
            return OK;
          },
        };
      },
      async (w) => {
        await w.write(...CHANGE);
        await w.run('after-declared');
      },
    );
    expect(out.traces[0]!.result).toHaveProperty('threw');
    expect(types(out.traces[0]!)).not.toContain('gate_done');
    expect(stagesOf(out.traces[0]!)).not.toContain('review');
  });

  it('남은 프로세스 조회가 취소로 끊겼으면 signal.reason을 그대로 던진다', async () => {
    const out = await compare(
      () => {
        const controller = new AbortController();
        return {
          signal: controller.signal,
          strays: (() => {
            controller.abort(reason);
            throw new Error('끊김');
          }) as () => never,
        };
      },
      async (w) => {
        await w.write(...CHANGE);
        await w.run('strays-abort');
      },
    );
    expect(thrownOf(out.traces[0]!)).toEqual({ name: 'Error', message: '중단' });
    expect(types(out.traces[0]!)).toEqual(['stage', 'verify_start']);
  });

  it('재시작이 취소 때문에 끊기면 signal.reason을 그대로 던진다', async () => {
    const out = await compare(
      () => {
        const controller = new AbortController();
        return {
          signal: controller.signal,
          tweak: (sandbox) => {
            const restart = sandbox.restart.bind(sandbox);
            sandbox.restart = async (service, options) => {
              controller.abort(reason);
              return restart(service, options).then(() => { throw new Error('끊김'); });
            };
          },
        };
      },
      async (w) => {
        await w.write(...CHANGE);
        await w.run('restart-abort');
      },
    );
    expect(thrownOf(out.traces[0]!).message).toBe('중단');
  });
});

describe('콜백이 던지면 게이트도 던지고 통과로 읽히지 않는다', () => {
  for (const type of ['stage', 'verify_start', 'verify_result', 'workflow_check', 'gate_done'] as const) {
    it(`onEvent가 ${type} 이벤트에서 던지면 그대로 던진다`, async () => {
      const out = await compare(() => ({ workflow: { tests: [unit] }, onEvent: (event) => { if (event.type === type) throw new Error(`${type} 던짐`); } }), async (w) => {
        await w.write(...CHANGE);
        await w.run('first');
        await w.run('second');
      });
      expect(thrownOf(out.traces[0]!).message).toBe(`${type} 던짐`);
      expect((out.traces[0]!.state as { lastOutcome?: string }).lastOutcome).toBeUndefined();
    });
  }

  it('시크릿 검사가 던지면(서비스 확인이 던지면) 그대로 던진다', async () => {
    const out = await compare(() => ({ findSecrets: () => { throw new Error('가림 실패'); } }), async (w) => {
      await w.write(...CHANGE);
      await w.run('secrets-throw');
    });
    expect(thrownOf(out.traces[0]!).message).toBe('가림 실패');
    expect(types(out.traces[0]!)).toEqual(['stage', 'verify_start']);
  });

  it('시크릿이 파일에 들어가면 서비스 확인이 실패한다', async () => {
    const out = await compare(() => ({ findSecrets: () => ['DB_PASSWORD'] }), async (w) => {
      await w.write(...CHANGE);
      await w.run('secrets');
    });
    expect(outcomeOf(out.traces[0]!).kind).toBe('retry');
  });
});

describe('짝 없는 서로게이트', () => {
  it('실패한 검사의 출력에 든 짝 없는 서로게이트는 옛 코드와 같은 글이 된다', async () => {
    const out = await compare(
      () => ({ workflow: { tests: [unit] }, exec: () => ({ exitCode: 1, stdout: '', stderr: 'bad \ud800 output \udc00' }), maxVerifyAttempts: 2 }),
      async (w) => {
        await w.write(...CHANGE);
        await w.run('lone');
      },
    );
    expect(outcomeOf(out.traces[0]!).kind).toBe('retry');
    // 옛 코드는 실패한 검사 목록 글을 napi 경계에서 만들어 짝 없는 서로게이트가 U+FFFD가 됐다. 검사 기록(이벤트·상태)에는 그대로 남는다
    expect(outcomeOf(out.traces[0]!).feedback).toContain('bad \ufffd output \ufffd');
    expect(out.texts[0]).toContain('bad \\ud800 output \\udc00');
  });

  it('사람 확인 기록의 메모에 짝 없는 서로게이트가 있어도 옛 코드와 같다', async () => {
    const lone = '\ud83d';
    const out = await compare(
      () => ({ seed: seedDoc, maxVerifyAttempts: 1 }),
      async (w) => {
        await w.disk(REQ, forge(PLAIN).replace('메모 확인함', `메모 ${lone} 확인함`));
        await w.run('lone-reason');
      },
    );
    expect(outcomeOf(out.traces[0]!).kind).toBe('exhausted');
    // 파일은 UTF-8로 읽으므로 디스크에 쓴 짝 없는 서로게이트는 읽는 쪽에서 이미 U+FFFD다. 사유는 첫 줄만 적는다
    expect(outcomeOf(out.traces[0]!).summary).not.toContain('메모');
  });
});
