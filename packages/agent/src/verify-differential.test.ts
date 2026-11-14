import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { native, SandboxError, type EgressDenial, type InfraCheckResult, type LogLine, type Sandbox, type ServiceUsage } from '@b-studio/sandbox';
import { loadProject, type LoadedProject } from '@b-studio/spec';
import { afterAll, describe, expect, it } from 'vitest';
import type { OpenApiDocument } from './contract-diff';
import * as current from './verify';
import * as legacy from './verify-legacy';

/**
 * 게이트 검증의 조율(순서·재시도·결과 조립)을 Rust로 옮기면서(ADR-195 4f A5a) 옛 구현(`verify-legacy.ts`)과 지금 구현(`verify.ts`)에 **같은 시나리오**를 넣어 견준다.
 * 시나리오마다 임시 폴더에 프로젝트를 새로 만들고(도커·네트워크 없음, 가짜 sandbox) 옛 쪽과 지금 쪽이 각자의 세계에서 돈다.
 * 견주는 것: ① 샌드박스·계약 가져오기 호출의 순서와 인자(가짜가 `calls`에 적는다) ② 반환값(보고서 전체) ③ 던진 오류의 종류·글. 임시 폴더 경로는 `<R>`로 바꿔 견준다.
 *
 * 정렬하는 자리(옛 코드에서 `Promise.all`이라 호출 순서가 일정하지 않은 구간): 호출 기록 가운데 `~`로 시작하는 줄이 이어진 구간(서비스별 재시작·계약 가져오기·시크릿 검사)은 그 구간 안에서 글자 순으로 정렬해 견준다.
 * 서비스 하나만 도는 시나리오(`strict`)는 정렬하지 않아 한 서비스 안의 호출 순서(restart → stats → logs → egress)도 견준다.
 *
 * 의도한 차이: 병렬 구간에서 둘 이상이 동시에 던질 때 어느 오류가 올라오는지는 시간에 달렸다(옛 `Promise.all`도 같다). 이 시험은 하나만 던지게 짠다.
 * 옛 코드의 빈틈을 그대로 둔 것 하나: 부가 서비스 실패 이유가 빈 글자면 `addonError`가 없다(맨 아래 따로 고정한다).
 */

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const SPEC = (extra = '') =>
  `version: 1\nname: x\nservices:\n  web: { source: managed, template: nextjs, path: web, port: 3000, preview: browser }\n  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi, contract: { extract: /v3/api-docs } }\n${extra}`;
const COMPOSE = (extra = '') => `services:\n  web: { build: ./web }\n  api: { build: ./api }\n${extra}`;

const BASELINE: OpenApiDocument = {
  paths: { '/api/orders': { get: {} } },
  components: { schemas: { Order: { properties: { id: { type: 'integer' }, total: { type: 'integer' } } } } },
};
const ADDED: OpenApiDocument = { paths: { '/api/orders': { get: {} } }, components: { schemas: { Order: { properties: { id: { type: 'integer' }, total: { type: 'integer' }, memo: { type: 'string' } } } } } };
const BREAKING: OpenApiDocument = { paths: {}, components: { schemas: {} } };

interface Plan {
  syncError?: Error;
  /** 서비스별 재시작 오류. n은 그 서비스의 몇 번째 호출인지(0부터) */
  restart?: (service: string, n: number, hooks: { abort: (reason?: unknown) => void }) => Error | undefined;
  logs?: Record<string, string[] | { lines: string[]; error: Error }>;
  stats?: 'throw' | ServiceUsage[];
  egress?: 'absent' | 'throw' | EgressDenial[];
  ensureInfra?: 'absent' | 'throw' | InfraCheckResult;
  secrets?: (text: string) => string[];
  endpointError?: Record<string, Error>;
  fetch?: (url: string) => OpenApiDocument | Error;
}

interface World {
  root: string;
  project: LoadedProject;
  /** 에이전트가 실행 중 바꾼 선언을 반영한 project. stale이다(바뀐 파일은 디스크에만 있다) */
  controller: AbortController;
  calls: string[];
  sandbox: Sandbox;
  fetcher: (url: string) => Promise<OpenApiDocument>;
}

interface Options {
  plan?: Plan;
  /** 디스크에 쓰는 파일(프로젝트 루트 기준) */
  files?: Record<string, string>;
  /** 세션이 시작한 뒤 디스크에서 바뀐 studio.yaml·compose */
  spec?: string;
  compose?: string;
  startSpec?: string;
  startCompose?: string;
  tweak?: (project: LoadedProject) => LoadedProject;
}

const usage = (service: string, extra: Partial<ServiceUsage> = {}): ServiceUsage => ({ service, state: 'exited', ...extra }) as ServiceUsage;

async function createWorld(options: Options): Promise<World> {
  const root = await mkdtemp(path.join(tmpdir(), 'verify-diff-'));
  roots.push(root);
  await mkdir(path.join(root, 'web'), { recursive: true });
  await mkdir(path.join(root, 'api/src'), { recursive: true });
  await writeFile(path.join(root, 'studio.yaml'), options.startSpec ?? SPEC());
  await writeFile(path.join(root, 'compose.yaml'), options.startCompose ?? COMPOSE());
  await writeFile(path.join(root, 'api/src/Order.java'), 'class Order {}\n');
  const started = await loadProject(root);
  if (options.spec !== undefined) await writeFile(path.join(root, 'studio.yaml'), options.spec);
  if (options.compose !== undefined) await writeFile(path.join(root, 'compose.yaml'), options.compose);
  for (const [file, content] of Object.entries(options.files ?? {})) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  const project = options.tweak ? options.tweak(started) : started;

  const plan = options.plan ?? {};
  const controller = new AbortController();
  const calls: string[] = [];
  const seen = new Map<string, number>();
  const sandbox = {
    id: 'fake',
    project,
    async sync(files: string[], opts?: { signal?: AbortSignal }) {
      calls.push(`sync:${files.join(',')}:signal=${opts?.signal === undefined ? 'none' : opts.signal === controller.signal ? 'start' : 'other'}`);
      if (plan.syncError) throw plan.syncError;
      return { elapsedMs: 1200, checks: 3 };
    },
    async restart(service: string, opts?: { signal?: AbortSignal }) {
      calls.push(`~restart:${service}:signal=${opts?.signal === undefined ? 'none' : opts.signal === controller.signal ? 'start' : 'other'}`);
      const n = seen.get(service) ?? 0;
      seen.set(service, n + 1);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const error = plan.restart?.(service, n, { abort: (reason) => controller.abort(reason) });
      if (error) throw error;
      return { service, containerPort: 0, url: `http://127.0.0.1/${service}/` };
    },
    async endpoint(service: string) {
      calls.push(`~endpoint:${service}`);
      const error = plan.endpointError?.[service];
      if (error) throw error;
      return { service, containerPort: 0, url: `http://127.0.0.1:9000/${service}/` };
    },
    async stats() {
      calls.push('~stats');
      if (plan.stats === 'throw') throw new Error('stats 실패');
      return plan.stats ?? [];
    },
    async *logs(options: { services?: string[]; tail?: number; follow?: boolean }): AsyncIterable<LogLine> {
      calls.push(`~logs:${JSON.stringify(options)}`);
      const service = options.services?.[0] ?? '';
      const entry = plan.logs?.[service] ?? [];
      const lines = Array.isArray(entry) ? entry : entry.lines;
      for (const text of lines) yield { service, text, at: new Date() };
      if (!Array.isArray(entry)) throw entry.error;
    },
    findSecrets(text: string) {
      calls.push(`~findSecrets:${text.length}`);
      return plan.secrets ? plan.secrets(text) : [];
    },
    ...(plan.egress === 'absent'
      ? {}
      : {
          async egressDenials(opts?: { since?: Date }) {
            const age = Date.now() - (opts?.since?.getTime() ?? Date.now());
            calls.push(`~egress:since-age-ok=${age >= 4_900 && age < 7_000}`);
            if (plan.egress === 'throw') throw new Error('egress 실패');
            return plan.egress ?? [];
          },
        }),
    ...(plan.ensureInfra === undefined || plan.ensureInfra === 'absent'
      ? {}
      : {
          async ensureInfra(services: readonly string[], opts?: { signal?: AbortSignal }) {
            calls.push(`ensureInfra:${services.join(',')}:signal=${opts?.signal === undefined ? 'none' : opts.signal === controller.signal ? 'start' : 'other'}`);
            if (plan.ensureInfra === 'throw') throw new Error('ensureInfra 던짐');
            return plan.ensureInfra;
          },
        }),
  } as unknown as Sandbox;

  const fetcher = async (url: string) => {
    calls.push(`~fetch:${url}`);
    const result = plan.fetch ? plan.fetch(url) : ADDED;
    if (result instanceof Error) throw result;
    return result;
  };
  return { root, project, controller, calls, sandbox, fetcher };
}

type Impl = typeof current;

function sortParallel(calls: string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    out.push(...run.sort());
    run = [];
  };
  for (const call of calls) {
    if (call.startsWith('~')) run.push(call);
    else {
      flush();
      out.push(call);
    }
  }
  flush();
  return out;
}

function describeError(error: unknown) {
  if (!(error instanceof Error)) return { thrown: typeof error, value: String(error) };
  return { name: error.name, message: error.message, cause: error.cause instanceof Error ? error.cause.message : error.cause === undefined ? undefined : String(error.cause) };
}

async function runWorld(impl: Impl, options: Options, act: (impl: Impl, world: World) => Promise<unknown>, strict: boolean): Promise<unknown> {
  const world = await createWorld(options);
  let outcome: unknown;
  try {
    outcome = { value: await act(impl, world) };
  } catch (error) {
    outcome = { error: describeError(error) };
  }
  const calls = strict ? world.calls : sortParallel(world.calls);
  return JSON.parse(JSON.stringify({ outcome, calls }, (_key, value: unknown) => (typeof value === 'string' ? value.split(world.root).join('<R>') : value)));
}

/** 옛 구현과 지금 구현이 같은 시나리오에서 같은 결과를 내는지 견준다. 지금 쪽 결과를 돌려준다 */
async function compare(options: Options, act: (impl: Impl, world: World) => Promise<unknown>, { strict = false } = {}) {
  const old = await runWorld(legacy as unknown as Impl, options, act, strict);
  const now = await runWorld(current, options, act, strict);
  expect(now).toEqual(old);
  // 키 순서까지 같다(화면·기준 사진이 JSON 글을 그대로 쓴다)
  expect(JSON.stringify(now)).toBe(JSON.stringify(old));
  return now as { outcome: { value?: any; error?: { name?: string; message?: string } }; calls: string[] };
}

const verify = (changedFiles: string[], extra: { allowBreaking?: boolean; baselines?: Map<string, OpenApiDocument>; alsoRestart?: string[]; start?: boolean } = {}) =>
  async (impl: Impl, w: World) =>
    impl.verifyChanges({
      sandbox: w.sandbox,
      project: w.project,
      changedFiles,
      baselines: extra.baselines ?? new Map([['api', BASELINE]]),
      allowBreaking: extra.allowBreaking ?? false,
      fetcher: w.fetcher,
      ...(extra.start ? { start: { signal: w.controller.signal } } : {}),
      ...(extra.alsoRestart ? { alsoRestart: extra.alsoRestart } : {}),
    });

const restart = (files: string[], { start = false, delay = 1, alsoRestart }: { start?: boolean; delay?: number; alsoRestart?: string[] } = {}) =>
  async (impl: Impl, w: World) => impl.restartServicesFor(w.sandbox, w.project, files, start ? { signal: w.controller.signal } : undefined, { deletedFileRetryDelayMs: delay, ...(alsoRestart ? { alsoRestart } : {}) });

const API = 'api/src/Order.java';
const WEB = 'web/app/page.tsx';
const failure = (message = '컨테이너가 종료됐습니다 (마지막 확인: ECONNREFUSED, 컨테이너 exited)') => new Error(message);

it('Rust 조율이 로드돼 있다(껍데기만 남은 채로 옛 TS를 돌리지 않는다)', () => {
  expect(typeof (native as unknown as { verifyRun?: unknown }).verifyRun).toBe('function');
});

describe('verifyChanges: 정상·계약', () => {
  it('바뀐 서비스만 재시작하고 선택 필드 추가는 통과한다', async () => {
    const out = await compare({}, verify([API, WEB]));
    expect(out.outcome.value).toMatchObject({ ok: true, sync: { elapsedMs: 1200 } });
    expect(out.calls.some((call) => call === '~fetch:http://127.0.0.1:9000/v3/api-docs')).toBe(true);
  });

  it('서비스 하나만 바뀌면 호출 순서(시크릿 → 반영 확인 → 재시작 → 계약)가 같다', async () => {
    const out = await compare({}, verify([API]), { strict: true });
    const names = out.calls.map((call) => call.split(':')[0]);
    expect(names).toEqual(['~findSecrets', 'sync', '~restart', '~endpoint', '~fetch']);
  });

  it('허용하지 않은 호환 깨짐은 실패, 허용하면 통과', async () => {
    const plan: Plan = { fetch: () => BREAKING };
    const strict = await compare({ plan }, verify([API]));
    expect(strict.outcome.value.ok).toBe(false);
    const allowed = await compare({ plan }, verify([API], { allowBreaking: true }));
    expect(allowed.outcome.value.ok).toBe(true);
  });

  it('기준이 없는 서비스는 모든 항목이 추가로 보인다', async () => {
    await compare({}, verify([API], { baselines: new Map() }));
  });

  it('계약 오류(엔드포인트 실패·가져오기 실패·빈 오류 글)는 모두 오류다(트러블슈팅 171)', async () => {
    const endpoint = await compare({ plan: { endpointError: { api: new Error('엔드포인트 없음') } } }, verify([API]));
    expect(endpoint.outcome.value).toMatchObject({ ok: false, contracts: [{ service: 'api', changes: [], error: '엔드포인트 없음' }] });
    const fetched = await compare({ plan: { fetch: () => new Error('HTTP 500') } }, verify([API]));
    expect(fetched.outcome.value.ok).toBe(false);
    const empty = await compare({ plan: { fetch: () => new Error('') } }, verify([API]));
    expect(empty.outcome.value).toMatchObject({ ok: false, contracts: [{ service: 'api', error: '' }] });
  });

  it('바깥 호스트로 풀리는 계약 경로는 요청하지 않고 실패한다(#1187)', async () => {
    const tweak = (project: LoadedProject): LoadedProject => {
      const managed = project.managed.map(([name, service]) => [name, service.contract ? { ...service, contract: { extract: '/\\evil.example/openapi.json' } } : service]);
      return { ...project, managed } as unknown as LoadedProject;
    };
    const out = await compare({ tweak }, verify([API]));
    expect(out.outcome.value.ok).toBe(false);
    expect(out.outcome.value.contracts[0].error).toContain('서비스 밖 호스트');
    expect(out.calls.some((call) => call.startsWith('~fetch:'))).toBe(false);
  });
});

describe('verifyChanges·restartServicesFor: 반영 확인과 재시작 실패', () => {
  it('반영 확인에 실패하면 재시작하지 않고 돌아간다(platform 표시 포함)', async () => {
    const plain = await compare({ plan: { syncError: new Error('60초 안에 반영되지 않았습니다') } }, verify([API]));
    expect(plain.outcome.value).toMatchObject({ ok: false, sync: { error: '60초 안에 반영되지 않았습니다' }, restarted: [], contracts: [] });
    expect(plain.outcome.value.platformFailure).toBeUndefined();
    const platform = await compare({ plan: { syncError: new SandboxError('도커에 닿지 못했습니다', '세부', { platform: true }) } }, verify([API]));
    expect(platform.outcome.value.sync).toEqual({ error: '도커에 닿지 못했습니다\n세부', platform: true });
    expect(platform.outcome.value.platformFailure).toBe('도커에 닿지 못했습니다');
    expect(platform.calls.some((call) => call.startsWith('~restart'))).toBe(false);
    await compare({ plan: { syncError: new Error('x') } }, restart([API]));
  });

  it('재시작 실패는 로그·막힌 접속을 담고 그 서비스의 계약은 건너뛴다', async () => {
    const out = await compare(
      { plan: { restart: (s) => (s === 'api' ? failure() : undefined), logs: { api: ['error: cannot find symbol memo'] }, egress: [{ host: 'registry.example.com', port: 443, reason: '허용 목록에 없음', at: new Date() }] } },
      verify([API]),
      { strict: true },
    );
    expect(out.outcome.value).toMatchObject({ ok: false, restarted: [{ service: 'api', ready: false, logTail: ['error: cannot find symbol memo'], blockedEgress: ['registry.example.com:443 (허용 목록에 없음)'] }], contracts: [] });
    expect(out.calls.map((call) => call.split(':')[0])).toEqual(['~findSecrets', 'sync', '~restart', '~stats', '~logs', '~egress']);
  });

  it('메모리 한도를 넘어 죽으면 원인을 먼저 알린다(한도 있음·없음)', async () => {
    const limited = await compare({ plan: { restart: () => failure('종료'), stats: [usage('web'), usage('api', { oomKilled: true, memoryLimitBytes: 1536 * 1024 ** 2 })] } }, restart([API]));
    expect(limited.outcome.value.restarted[0]).toMatchObject({ oomKilled: true });
    expect(limited.outcome.value.restarted[0].error).toMatch(/^메모리 한도 \(1\.50GiB\)를 넘어 종료됐습니다\. 종료$/);
    const unlimited = await compare({ plan: { restart: () => failure('종료'), stats: [usage('api', { oomKilled: true })] } }, restart([API]));
    expect(unlimited.outcome.value.restarted[0].error).toBe('메모리 한도를 넘어 종료됐습니다. 종료');
    // 다른 서비스가 OOM이면 이 서비스에는 알리지 않는다
    await compare({ plan: { restart: () => failure('종료'), stats: [usage('web', { oomKilled: true })] } }, restart([API]));
    // oomKilled가 거짓이면 알리지 않는다
    await compare({ plan: { restart: () => failure('종료'), stats: [usage('api', { oomKilled: false })] } }, restart([API]));
  });

  it('통계·로그·막힌 접속을 가져오지 못해도 재시작 실패 보고는 나온다(삼키는 자리가 옛 값과 같다)', async () => {
    const stats = await compare({ plan: { restart: () => failure(), stats: 'throw', logs: { api: ['한 줄'] } } }, restart([API]));
    expect(stats.outcome.value.restarted[0]).toMatchObject({ ready: false, logTail: ['한 줄'] });
    const logs = await compare({ plan: { restart: () => failure(), logs: { api: { lines: ['앞 줄', '둘째 줄'], error: new Error('로그 끊김') } } } }, restart([API]));
    expect(logs.outcome.value.restarted[0].logTail).toEqual(['앞 줄', '둘째 줄']);
    const egress = await compare({ plan: { restart: () => failure(), egress: 'throw' } }, restart([API]));
    expect(egress.outcome.value.restarted[0].blockedEgress).toBeUndefined();
    const absent = await compare({ plan: { restart: () => failure(), egress: 'absent' } }, restart([API]));
    expect(absent.outcome.value.restarted[0].blockedEgress).toBeUndefined();
  });

  it('막힌 접속은 메서드·포트·경로를 붙이고 같은 글은 한 번만 적는다', async () => {
    const at = new Date();
    const out = await compare(
      {
        plan: {
          restart: () => failure(),
          egress: [
            { host: 'a.example', port: 443, method: 'GET', path: '/x', reason: 'r1', at },
            { host: 'a.example', port: 443, method: 'GET', path: '/x', reason: 'r1', at },
            { host: 'b.example', reason: 'r2', at },
            { host: 'c.example', port: 0, path: '', reason: 'r3', at },
            { host: 'd.example', method: '', path: '/y', reason: 'r4', at },
          ],
        },
      },
      restart([API]),
    );
    expect(out.outcome.value.restarted[0].blockedEgress).toEqual(['GET a.example:443/x (r1)', 'b.example (r2)', 'c.example (r3)', 'd.example/y (r4)']);
  });

  it('platform 표시가 붙은 재시작 실패는 platformFailure로 올라온다', async () => {
    const out = await compare({ plan: { restart: () => new SandboxError('도커 데몬에 닿지 못했습니다', '세부 줄', { platform: true }) } }, verify([API]));
    expect(out.outcome.value.restarted[0].platform).toBe(true);
    expect(out.outcome.value.platformFailure).toBe('api: 도커 데몬에 닿지 못했습니다');
    // SandboxError라도 platform이 아니면 올리지 않는다
    const plain = await compare({ plan: { restart: () => new SandboxError('서비스가 뜨지 않았습니다') } }, verify([API]));
    expect(plain.outcome.value.platformFailure).toBeUndefined();
  });

  it('두 서비스가 함께 돌고 하나만 실패해도 나머지는 그대로 결과에 든다', async () => {
    const out = await compare({ plan: { restart: (s) => (s === 'web' ? failure('web 실패') : undefined), logs: { web: ['web 로그'] } } }, verify([WEB, API]));
    expect(out.outcome.value.restarted.map((check: { service: string; ready: boolean }) => [check.service, check.ready])).toEqual([['web', false], ['api', true]]);
    expect(out.outcome.value.ok).toBe(false);
  });
});

describe('지운 파일 재시도', () => {
  const deleted = 'api/src/main/resources/db/migration/V2__memo.sql';
  const noSuch = 'java.nio.file.NoSuchFileException: /app/src/main/resources/db/migration/V2__memo.sql';

  it('로그가 지운 파일을 말하면 한 번 더 띄우고 retried를 적는다', async () => {
    const out = await compare({ plan: { restart: (_s, n) => (n === 0 ? failure() : undefined), logs: { api: [noSuch] } } }, restart([deleted]), { strict: true });
    expect(out.outcome.value.restarted).toEqual([{ service: 'api', ready: true, retried: true }]);
    expect(out.calls.map((call) => call.split(':')[0])).toEqual(['sync', '~restart', '~stats', '~logs', '~egress', '~restart']);
  });

  it('두 번째도 실패하면 두 번째 실패를 적는다(세 번째는 없다)', async () => {
    const out = await compare({ plan: { restart: () => failure(), logs: { api: [noSuch] } } }, restart([deleted]));
    expect(out.outcome.value.restarted[0]).toMatchObject({ ready: false, retried: true });
    expect(out.calls.filter((call) => call.startsWith('~restart:api')).length).toBe(2);
  });

  it('지운 파일과 무관한 실패·지운 파일이 아닌 경우·"없음"이 없는 로그는 다시 시도하지 않는다', async () => {
    for (const logs of [{ api: ['error: cannot find symbol memo'] }, { api: ['Flyway migrated V2__memo.sql'] }, { api: ['NoSuchFileException: /app/other.sql'] }]) {
      const out = await compare({ plan: { restart: () => failure(), logs } }, restart([deleted]));
      expect(out.outcome.value.restarted[0].retried).toBeUndefined();
    }
    // 파일이 있으면(지운 것이 아니면) 로그에 이름이 나와도 다시 시도하지 않는다
    const present = await compare({ plan: { restart: () => failure(), logs: { api: ['NoSuchFileException: /app/Order.java'] } } }, restart([API]));
    expect(present.outcome.value.restarted[0].retried).toBeUndefined();
  });

  it('성공한 서비스는 지운 파일이 있어도 다시 시도하지 않는다', async () => {
    const out = await compare({ plan: { logs: { api: [noSuch] } } }, restart([deleted]));
    expect(out.outcome.value.restarted).toEqual([{ service: 'api', ready: true }]);
  });

  it('짝 없는 서로게이트가 든 파일 이름과 U+FFFD가 든 로그는 같다고 보지 않는다', async () => {
    const lone = 'api/src/x\ud800y.sql';
    const out = await compare({ plan: { restart: () => failure(), logs: { api: ['NoSuchFileException: /app/src/x�y.sql'] } } }, restart([lone]));
    expect(out.outcome.value.restarted[0].retried).toBeUndefined();
    // 같은 짝 없는 글자끼리는 같다
    const same = await compare({ plan: { restart: () => failure(), logs: { api: ['NoSuchFileException: /app/src/x\ud800y.sql'] } } }, restart([lone]));
    expect(same.outcome.value.restarted[0].retried).toBe(true);
  });
});

describe('취소', () => {
  it('취소로 끊긴 재시작은 실패로 기록하지 않고 로그를 모으지 않은 채 signal.reason을 던진다', async () => {
    const reason = new Error('요청을 취소했습니다');
    const out = await compare({ plan: { restart: (_s, _n, { abort }) => (abort(reason), failure('끊김')) } }, restart([API], { start: true }), { strict: true });
    expect(out.outcome.error).toMatchObject({ message: '요청을 취소했습니다' });
    expect(out.calls.map((call) => call.split(':')[0])).toEqual(['sync', '~restart']);
  });

  it('verifyChanges도 같다(보고서를 만들지 않고 던진다)', async () => {
    const out = await compare({ plan: { restart: (_s, _n, { abort }) => (abort(new Error('중지')), failure('끊김')) } }, verify([API], { start: true }));
    expect(out.outcome.error).toMatchObject({ message: '중지' });
  });

  it('취소가 아니면 signal이 있어도 실패로 기록한다', async () => {
    const out = await compare({ plan: { restart: () => failure() } }, restart([API], { start: true }));
    expect(out.outcome.value.restarted[0]).toMatchObject({ ready: false });
  });

  it('지운 파일 재시도의 대기도 취소로 끊긴다', async () => {
    const deleted = 'api/src/gone.sql';
    const out = await compare(
      { plan: { restart: (_s, _n, { abort }) => (setTimeout(() => abort(new Error('중지')), 20), failure()), logs: { api: ['NoSuchFileException: /app/gone.sql'] } } },
      restart([deleted], { start: true, delay: 5_000 }),
    );
    expect(out.outcome.error).toMatchObject({ name: 'AbortError' });
    expect(out.calls.filter((call) => call.startsWith('~restart:api')).length).toBe(1);
  });

  it('start가 없으면 signal을 넘기지 않는다', async () => {
    const out = await compare({}, restart([API]));
    expect(out.calls.filter((call) => call.startsWith('sync:') || call.startsWith('~restart')).every((call) => call.endsWith('signal=none'))).toBe(true);
  });
});

describe('studio.yaml·compose·꺼 둔 서비스·알려 주기', () => {
  it('studio.yaml이 스키마에 맞지 않으면 specError를 적고 ok가 거짓이다. 옛 project로 재시작은 계속한다', async () => {
    const out = await compare({ spec: 'version: 1\nname: x\nservices:\n  web: { source: managed, template: nextjs, path: web, port: 3000, preview: browser }\nworkflow:\n  autoPageChecks: [web]\n' }, verify(['studio.yaml']));
    expect(out.outcome.value.ok).toBe(false);
    expect(out.outcome.value.specError).toContain('workflow.autoPageChecks');
    expect(out.calls.some((call) => call.startsWith('~restart:'))).toBe(true);
  });

  it('studio.yaml이 읽히면 specError가 없다', async () => {
    const out = await compare({ spec: SPEC() }, verify(['studio.yaml']));
    expect(out.outcome.value.specError).toBeUndefined();
  });

  it('다시 읽은 선언으로 소유를 판정한다(includes를 더한 뒤)', async () => {
    const spec = SPEC().replace('path: api,', 'path: api, includes: [shared],');
    const out = await compare({ spec, files: { 'shared/lib.txt': 'x' } }, restart(['studio.yaml', 'shared/lib.txt']));
    expect(out.outcome.value.unverifiedFiles).toEqual([]);
    // 옛 선언(includes 없음)으로 판정하면 shared/lib.txt는 어느 서비스에도 속하지 않는다
    const stale = await compare({ files: { 'shared/lib.txt': 'x' } }, restart(['shared/lib.txt']));
    expect(stale.outcome.value.unverifiedFiles).toEqual(['shared/lib.txt']);
  });

  it('꺼 둔 서비스는 재시작도 계약 확인도 하지 않고 건너뛴 것으로 남긴다', async () => {
    const tweak = (project: LoadedProject) => ({ ...project, offServices: new Set(['api']) }) as unknown as LoadedProject;
    const out = await compare({ tweak }, verify([WEB, API]));
    expect(out.outcome.value).toMatchObject({ skippedOff: ['api'], restarted: [{ service: 'web', ready: true }], contracts: [] });
    expect(out.calls.some((call) => call.startsWith('~restart:api'))).toBe(false);
    const allOff = { tweak: (project: LoadedProject) => ({ ...project, offServices: new Set<string>() }) as unknown as LoadedProject };
    await compare(allOff, verify([WEB, API]));
  });

  it('alsoRestart는 바뀐 파일과 무관하게 더하고 중복은 한 번만 띄운다', async () => {
    const out = await compare({}, verify([API], { alsoRestart: ['web', 'api', 'web'] }));
    expect(out.outcome.value.restarted.map((check: { service: string }) => check.service)).toEqual(['api', 'web']);
  });

  it('서비스에 속하지 않은 파일은 unverifiedFiles에 모으고, 바뀐 파일이 없으면 재시작하지 않는다', async () => {
    const out = await compare({}, verify(['docs/readme.md']));
    expect(out.outcome.value).toMatchObject({ ok: true, unverifiedFiles: ['docs/readme.md'], restarted: [] });
    await compare({}, verify([]));
  });

  describe('compose에 새로 생긴 부가 서비스', () => {
    // 일부러 이름 순이 아닌 순서로 쓴다(올리는 순서는 UTF-16 정렬)
    const compose = COMPOSE('  redis: { image: redis:7 }\n  mediamtx: { image: bluenviron/mediamtx:latest }\n');

    it('이름 순으로 올리고 성공하면 addedAddons에 적는다', async () => {
      const out = await compare({ compose, plan: { ensureInfra: { ok: true, recovered: ['mediamtx', 'redis'] } } }, restart(['compose.yaml']));
      expect(out.outcome.value.addedAddons).toEqual(['mediamtx', 'redis']);
      expect(out.calls.filter((call) => call.startsWith('ensureInfra:'))).toEqual(['ensureInfra:mediamtx,redis:signal=none']);
    });

    it('올리지 못하면 addonError로 남기지만 managed 재시작은 그대로 진행한다(이유가 없으면 알 수 없는 이유)', async () => {
      const failed = await compare({ compose, plan: { ensureInfra: { ok: false, recovered: [], missing: ['mediamtx'], reason: '이미지를 받지 못했습니다' } } }, restart(['compose.yaml']));
      expect(failed.outcome.value.addonError).toBe('이미지를 받지 못했습니다');
      expect(failed.outcome.value.restarted.length).toBe(2);
      const noReason = await compare({ compose, plan: { ensureInfra: { ok: false, recovered: [] } } }, restart(['compose.yaml']));
      expect(noReason.outcome.value.addonError).toBe('알 수 없는 이유');
      const thrown = await compare({ compose, plan: { ensureInfra: 'throw' } }, restart(['compose.yaml']));
      expect(thrown.outcome.value.addonError).toBe('ensureInfra 던짐');
    });

    it('옛 코드의 빈틈을 그대로 둔다: 이유가 빈 글자면 addonError를 적지 않는다(ok에는 영향이 없다)', async () => {
      const out = await compare({ compose, plan: { ensureInfra: { ok: false, recovered: [], reason: '' } } }, verify(['compose.yaml'], { baselines: new Map() }));
      expect(out.outcome.value.addonError).toBeUndefined();
    });

    it('꺼 둔 부가 서비스는 올리지 않고, 올릴 것이 없으면 부르지 않는다', async () => {
      const tweak = (project: LoadedProject) => ({ ...project, offServices: new Set(['mediamtx', 'redis']) }) as unknown as LoadedProject;
      const off = await compare({ compose, tweak, plan: { ensureInfra: { ok: true, recovered: [] } } }, restart(['compose.yaml']));
      expect(off.calls.some((call) => call.startsWith('ensureInfra:'))).toBe(false);
      const partial = await compare(
        { compose, tweak: (project) => ({ ...project, offServices: new Set(['redis']) }) as unknown as LoadedProject, plan: { ensureInfra: { ok: true, recovered: ['mediamtx'] } } },
        restart(['compose.yaml']),
      );
      expect(partial.calls.filter((call) => call.startsWith('ensureInfra:'))).toEqual(['ensureInfra:mediamtx:signal=none']);
    });

    it('compose가 바뀌지 않았거나(studio.yaml만) ensureInfra가 없는 제공자는 건너뛴다', async () => {
      const spec = await compare({ compose, plan: { ensureInfra: { ok: true, recovered: ['x'] } } }, restart(['studio.yaml']));
      expect(spec.calls.some((call) => call.startsWith('ensureInfra:'))).toBe(false);
      const absent = await compare({ compose, plan: { ensureInfra: 'absent' } }, restart(['compose.yaml']));
      expect(absent.outcome.value.addedAddons).toBeUndefined();
    });

    it('signal을 넘긴다', async () => {
      const out = await compare({ compose, plan: { ensureInfra: { ok: true, recovered: ['mediamtx', 'redis'] } } }, restart(['compose.yaml'], { start: true }));
      expect(out.calls.filter((call) => call.startsWith('ensureInfra:'))).toEqual(['ensureInfra:mediamtx,redis:signal=start']);
    });

    it('반영 확인에 실패하면 부가 서비스를 올리지 않는다', async () => {
      const out = await compare({ compose, plan: { syncError: new Error('반영 안 됨'), ensureInfra: { ok: true, recovered: ['mediamtx'] } } }, restart(['compose.yaml']));
      expect(out.calls.some((call) => call.startsWith('ensureInfra:'))).toBe(false);
    });
  });
});

describe('systemPackages 동기화', () => {
  it('재시작 전에 다시 읽은 선언으로 Dockerfile을 맞춘다', async () => {
    const dockerfile = 'FROM eclipse-temurin:21-jdk\n\nWORKDIR /workspace\n';
    const spec = SPEC().replace('preview: openapi,', 'preview: openapi, systemPackages: [ffmpeg],');
    const out = await compare({ spec, files: { 'api/Dockerfile.b-studio': dockerfile } }, async (impl, w) => {
      await impl.restartServicesFor(w.sandbox, w.project, ['studio.yaml']);
      return (await readFile(path.join(w.root, 'api/Dockerfile.b-studio'), 'utf8')).includes('ffmpeg');
    });
    expect(out.outcome.value).toBe(true);
  });
});

describe('findSecretLeaks', () => {
  it('값이 든 파일만 이름과 함께 찾는다. 없는 파일·폴더는 시크릿 없음으로 본다', async () => {
    const out = await compare(
      { files: { 'api/src/Pay.java': 'String key = "sk_live_1";\n', 'api/src/Clean.java': 'class Clean {}\n' }, plan: { secrets: (text) => (text.includes('sk_live_1') ? ['PAYMENT_API_KEY', 'OTHER'] : []) } },
      async (impl, w) => impl.findSecretLeaks(w.sandbox, w.root, ['api/src/Pay.java', 'api/src/Clean.java', 'api/src/Deleted.java', 'api']),
    );
    expect(out.outcome.value).toEqual([{ file: 'api/src/Pay.java', secrets: ['PAYMENT_API_KEY', 'OTHER'] }]);
  });

  it('읽지 못하는 파일은 검사에 넘기지 않는다', async () => {
    const out = await compare({ plan: { secrets: () => ['X'] } }, async (impl, w) => impl.findSecretLeaks(w.sandbox, w.root, ['api/src/Deleted.java', 'api']));
    expect(out.outcome.value).toEqual([]);
    expect(out.calls).toEqual([]);
  });

  it('파일 내용은 그대로 넘긴다(예약 글자·유니코드·잘못된 UTF-8 포함)', async () => {
    const seen: string[] = [];
    const body = `한글   ${'x'.repeat(10)} 😀\n`;
    await compare({ files: { 'api/src/Weird.java': body }, plan: { secrets: (text) => (seen.push(text), []) } }, async (impl, w) => impl.findSecretLeaks(w.sandbox, w.root, ['api/src/Weird.java']));
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[0]).toBe(body);
  });

  it('경로를 정규화해 읽는다(.. 와 겹친 구분자)', async () => {
    const out = await compare({ files: { 'api/src/Pay.java': 'sk' }, plan: { secrets: (text) => (text === 'sk' ? ['K'] : []) } }, async (impl, w) => impl.findSecretLeaks(w.sandbox, w.root, ['api/../api//src/Pay.java']));
    expect(out.outcome.value).toEqual([{ file: 'api/../api//src/Pay.java', secrets: ['K'] }]);
  });

  it('시크릿 검사가 던지면 그대로 던진다', async () => {
    const out = await compare({ files: { 'api/src/Pay.java': 'sk' }, plan: { secrets: () => { throw new Error('검사 실패'); } } }, async (impl, w) => impl.findSecretLeaks(w.sandbox, w.root, ['api/src/Pay.java']));
    expect(out.outcome.error).toMatchObject({ message: '검사 실패' });
  });

  it('verifyChanges에서는 시크릿이 있으면 ok가 거짓이다', async () => {
    const out = await compare({ files: { 'api/src/Pay.java': 'sk' }, plan: { secrets: () => ['K'] } }, verify(['api/src/Pay.java']));
    expect(out.outcome.value).toMatchObject({ ok: false, secretLeaks: [{ file: 'api/src/Pay.java', secrets: ['K'] }] });
  });
});

describe('captureBaselines', () => {
  const capture = (extra: { fetcher?: (url: string) => Promise<OpenApiDocument> } = {}) => async (impl: Impl, w: World) => {
    const map = await impl.captureBaselines(w.sandbox, w.project, extra.fetcher ?? w.fetcher);
    return [...map.entries()];
  };

  it('계약 선언이 있는 서비스만 순서대로 저장한다', async () => {
    const out = await compare({}, capture(), { strict: true });
    expect(out.outcome.value).toEqual([['api', ADDED]]);
    expect(out.calls.map((call) => call.split(':')[0])).toEqual(['~endpoint', '~fetch']);
  });

  it('꺼 둔 서비스와 실패한 서비스는 기준 없이 건너뛴다', async () => {
    const off = await compare({ tweak: (project) => ({ ...project, offServices: new Set(['api']) }) as unknown as LoadedProject }, capture());
    expect(off.outcome.value).toEqual([]);
    expect(off.calls).toEqual([]);
    expect((await compare({ plan: { endpointError: { api: new Error('없음') } } }, capture())).outcome.value).toEqual([]);
    expect((await compare({ plan: { fetch: () => new Error('HTTP 500') } }, capture())).outcome.value).toEqual([]);
    expect((await compare({ plan: { fetch: () => new Error('') } }, capture())).outcome.value).toEqual([]);
  });

  it('바깥 호스트로 풀리는 경로는 요청하지 않는다(#1187)', async () => {
    const tweak = (project: LoadedProject) => ({ ...project, managed: project.managed.map(([name, service]) => [name, service.contract ? { ...service, contract: { extract: '//evil.example/x' } } : service]) }) as unknown as LoadedProject;
    const out = await compare({ tweak }, capture());
    expect(out.outcome.value).toEqual([]);
    expect(out.calls.some((call) => call.startsWith('~fetch:'))).toBe(false);
  });

  it('같은 서비스가 여럿이어도 순서대로 하나씩 가져온다', async () => {
    const spec = SPEC().replace('  api:', '  api2: { source: managed, template: spring-boot, path: api, port: 8081, preview: openapi, contract: { extract: /docs2 } }\n  api:');
    const out = await compare({ startSpec: spec, startCompose: COMPOSE('  api2: { build: ./api }\n') }, capture(), { strict: true });
    expect(out.calls.map((call) => call.split(':')[0])).toEqual(['~endpoint', '~fetch', '~endpoint', '~fetch']);
  });
});

/** 껍데기의 오류 경로: Rust 쪽이 알아볼 수 없는 응답을 받으면 통과가 아니라 던진다 */
describe('콜백이 어긋나면 통과가 아니라 오류다', () => {
  it('콜백이 응답하지 않으면(알 수 없는 연산) 오류를 던진다', async () => {
    await expect(native.verifyRun('verifyChanges', JSON.stringify({ root: '/', files: [], offServices: null, managed: [], specFile: 'studio.yaml', composeChanged: false, hasEnsureInfra: false }), async () => 'not json')).resolves.toContain('"kind":"hook"');
    await expect(native.verifyRun('모르는 연산', JSON.stringify({ root: '/', files: [], managed: [] }), async () => '{}')).resolves.toContain('"kind":"input"');
    await expect(native.verifyRun('verifyChanges', 'not json', async () => '{}')).resolves.toContain('"kind":"input"');
  });

  it('응답이 ok를 말하지 않으면 통과로 읽지 않는다', async () => {
    const input = JSON.stringify({ root: '/nonexistent-root', files: ['a.txt'], offServices: null, managed: [], specFile: 'studio.yaml', composeChanged: false, hasEnsureInfra: false });
    expect(await native.verifyRun('restartServicesFor', input, async () => JSON.stringify({ services: [], unmatched: [] }))).toContain('"kind":"hook"');
    expect(await native.verifyRun('restartServicesFor', input, async () => JSON.stringify({ ok: 'yes' }))).toContain('"kind":"hook"');
    expect(await native.verifyRun('restartServicesFor', input, async () => JSON.stringify({ ok: true, services: 'api', unmatched: [] }))).toContain('"kind":"hook"');
    expect(await native.verifyRun('restartServicesFor', input, async () => JSON.stringify({ fatal: true }))).toContain('"kind":"hook"');
    // 실패해도 되는 자리가 아닌 콜백이 실패 응답을 주면 통과로 읽지 않는다
    expect(await native.verifyRun('restartServicesFor', input, async () => JSON.stringify({ ok: false, error: { message: '실패' } }))).toContain('"kind":"hook"');
    expect(await native.verifyRun('restartServicesFor', input, async () => JSON.stringify({ ok: false }))).toContain('"kind":"hook"');
    // 실패 응답에 성공 때의 필드가 함께 와도 성공으로 읽지 않는다
    expect(await native.verifyRun('restartServicesFor', input, async () => JSON.stringify({ ok: false, error: { message: '실패' }, services: [], unmatched: [] }))).toContain('"kind":"hook"');
  });
});
