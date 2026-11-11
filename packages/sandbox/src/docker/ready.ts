import { setTimeout as sleep } from 'node:timers/promises';
import type { LoadedProject, ManagedServiceSpec } from '@b-studio/spec';
import { SandboxError } from '../errors';
import { native } from '../native';
import type { NativeAwaitReadyInput, NativeScanInput } from '../native';
import { ReadinessError, type ReadinessPolicy } from '../readiness';
import type { ExecResult, InfraCheckResult, ProbeResult, ServiceEndpoint, StartOptions, StrayProcessReport } from '../types';
import { composeRef } from './git-mask';
import { PROCESS_SCAN_SCRIPT, type ScannedProcess } from './stray-processes';

/**
 * 준비 확인(`#awaitReady`)·모르는 프로세스 검사(`#recordProcessBaseline`·`strayProcesses`)·인프라 확인(`#missingServices`)의 TS 껍데기(ADR-195 4f A4c-3a).
 * 엔드포인트 읽기, HTTP 확인과 컨테이너 상태 읽기의 반복, 죽었을 때 이유 만들기, 프로세스 찾기와 비교는 Rust(crates/bstudio-io/src/readiness_io.rs)가 한다.
 * 여기는 이벤트(`onStatus`·`onTransientRetry`)를 알리고 결과를 옛 글 그대로의 오류로 바꾸기만 한다. 옛 TS는 `ready-legacy.ts`(차등 시험의 기준값).
 *
 * **컨테이너를 다시 만드는 `up`은 Rust가 부르지 않는다.** `up`은 `#compose` → `#upWithGitMask`의 `#upQueue`(한 번에 하나)와 `#gitMask`(마지막으로 쓴 마스크)를 지나야
 * 하는데, 그 상태는 이 클래스가 쥐고 있다. 일시 오류로 죽었으면 Rust가 "다시 만들어 달라"(`recreate`)고 돌려주고, 여기서 `ctx.recreate`(= 옛 경로의 `#composeOrThrow`)로
 * 만든 뒤 시도 횟수를 올려 다시 부른다(옛 재귀와 같다). 인프라 복구의 `up --no-deps <없는 것>`도 같다(`ensureInfra`가 `#compose`로 부르고 `missingServices`만 Rust다).
 */

export interface ReadyContext {
  id: string;
  project: Pick<LoadedProject, 'root' | 'composePath'>;
  dockerBin: string;
  env: NodeJS.ProcessEnv;
  overridePath: string;
  secrets: Record<string, string>;
  edgeService: string;
  /** edge가 이 서비스를 위해 열어 둔 컨테이너 포트 */
  edgePort: (name: string) => number;
  /** managed 서비스의 정의. 아니면 던진다 */
  managed: (name: string) => ManagedServiceSpec;
  policyFor: (service: ManagedServiceSpec) => ReadinessPolicy;
  /** 컨테이너를 다시 만든다. `#upQueue`·`#gitMask`를 지나는 옛 경로(`up --detach --build --no-deps --force-recreate <name>`) */
  recreate: (name: string, signal: AbortSignal | undefined) => Promise<unknown>;
  /** `docker compose <command>`가 비0으로 끝났을 때 옛 글 그대로의 오류 */
  composeFailure: (command: string, result: ExecResult) => Error;
}

function secretLists(secrets: Record<string, string>): { secretNames: string[]; secretValues: string[] } {
  // 같은 길이의 값끼리는 넘긴 순서를 지킨다. JS 객체의 순서(Object.entries)를 그대로 넘긴다
  const entries = Object.entries(secrets);
  return { secretNames: entries.map(([name]) => name), secretValues: entries.map(([, value]) => value) };
}

export async function awaitReady(
  ctx: ReadyContext,
  name: string,
  { signal, onStatus, onTransientRetry }: Pick<StartOptions, 'signal' | 'onStatus' | 'onTransientRetry'>,
  attempt = 1,
): Promise<ServiceEndpoint> {
  const service = ctx.managed(name);
  const policy = ctx.policyFor(service);
  // 확인 알림을 처리하다 던지면 Rust에 멈추라고 알리고, 그 오류를 옛 `waitForReady`가 던지던 자리(실패 처리)에서 다시 던진다
  let callbackError: { error: unknown } | undefined;
  const input: NativeAwaitReadyInput = {
    compose: composeRef(ctx.project, { dockerBin: ctx.dockerBin, env: ctx.env, projectName: ctx.id }),
    overridePath: ctx.overridePath,
    service: name,
    edgeService: ctx.edgeService,
    edgePort: String(ctx.edgePort(name)),
    hasReady: service.ready !== undefined,
    readyPath: service.ready?.path ?? '',
    expectStatus: service.ready?.expectStatus ?? 0,
    successThreshold: policy.successThreshold,
    timeoutMs: policy.timeoutMs,
    intervalMs: policy.intervalMs,
    attempt,
    ...secretLists(ctx.secrets),
    aborted: signal?.aborted ?? false,
  };
  const result = await native.awaitReadyOnce(
    input,
    (json) => {
      try {
        onStatus?.({ service: name, phase: 'probing', probe: JSON.parse(json) as ProbeResult });
        return true;
      } catch (error) {
        callbackError = { error };
        return false;
      }
    },
    signal ?? null,
  );

  /** 옛 `catch`: 이유는 오류 글이고, 실패를 알린 뒤 같은 오류를 던진다 */
  const fail = (error: unknown): never => {
    onStatus?.({ service: name, phase: 'failed', reason: error instanceof Error ? error.message : String(error) });
    throw error;
  };

  switch (result.kind) {
    case 'ready': {
      // 확인한 포트와 알리는 포트는 Rust가 돌려준 같은 값이다
      const endpoint: ServiceEndpoint = { service: name, containerPort: service.port, url: `http://127.0.0.1:${result.port}` };
      onStatus?.({ service: name, phase: 'ready', endpoint });
      return endpoint;
    }
    case 'endpoint-docker':
      // 엔드포인트를 읽지 못한 것은 확인 전의 오류다(옛 `endpoint()`는 `failed`를 알리지 않고 던졌다)
      throw ctx.composeFailure('port', { exitCode: result.exitCode, stdout: '', stderr: result.stderr });
    case 'endpoint-unparsed':
      throw new Error(result.reason ?? '공개된 호스트 포트를 찾을 수 없습니다');
    case 'invalid-port':
      // 옛 `new URL(path, endpoint.url)`이 던지던 것이다
      return fail(new TypeError('Invalid URL'));
    case 'failed':
      return fail(new ReadinessError(result.reason ?? '준비되지 않았습니다', JSON.parse(result.historyJson) as ProbeResult[]));
    case 'recreate':
      // 트러블슈팅 #90: 일시 오류(ETXTBSY 등)로 죽었으면 같은 컨테이너를 한 번만 다시 띄워 본다(attempt가 1일 때만 Rust가 이렇게 돌려준다)
      onTransientRetry?.({ service: name, reason: result.reason ?? '' });
      onStatus?.({ service: name, phase: 'starting' });
      await ctx.recreate(name, signal);
      return awaitReady(ctx, name, { signal, onStatus, onTransientRetry }, attempt + 1);
    case 'aborted': {
      // 옛 `waitForReady`: 확인 사이는 `signal.throwIfAborted()`, 쉬는 중은 `sleep`의 AbortError
      try {
        if (result.atTop) signal?.throwIfAborted();
        else await sleep(0, undefined, { signal });
      } catch (error) {
        return fail(error);
      }
      return fail(new SandboxError(`준비 확인이 취소됐지만 취소 신호를 읽지 못했습니다 (${ctx.id})`, undefined, { platform: true }));
    }
    case 'stopped':
      return fail(callbackError ? callbackError.error : new SandboxError(`준비 확인이 멈췄습니다 (${ctx.id})`, undefined, { platform: true }));
    default:
      // 모르는 결과는 준비됨이 아니다
      return fail(new SandboxError(`준비 확인 결과를 알 수 없습니다 (${ctx.id})`, String((result as { kind: unknown }).kind), { platform: true }));
  }
}

export interface ScanContext {
  id: string;
  project: Pick<LoadedProject, 'root' | 'composePath'>;
  dockerBin: string;
  env: NodeJS.ProcessEnv;
  overridePath: string;
  secrets: Record<string, string>;
}

function scanInput(ctx: ScanContext): NativeScanInput {
  return {
    compose: composeRef(ctx.project, { dockerBin: ctx.dockerBin, env: ctx.env, projectName: ctx.id }),
    overridePath: ctx.overridePath,
    script: PROCESS_SCAN_SCRIPT,
    ...secretLists(ctx.secrets),
  };
}

/**
 * 준비된 서비스의 프로세스 목록(기준선)을 읽는다(#765). 읽지 못하면 `undefined`다: 부르는 쪽이 그 서비스의 기준선을 지워, 다음 검사가 그 서비스를 다시 띄우게 한다.
 * 기준선 저장소는 상태라 부르는 쪽(`LocalDockerSandbox`)이 쥔다
 */
export async function readProcessBaseline(ctx: ScanContext, name: string): Promise<ScannedProcess[] | undefined> {
  const result = await native.scanServiceProcesses(scanInput(ctx), name, null);
  if (result.kind !== 'processes') return undefined;
  return JSON.parse(result.processesJson) as ScannedProcess[];
}

/**
 * 서비스마다 running인지 보고, running이면 서비스 안에서 PID 1과 세션이 다른 프로세스를 찾아 기준선에 없던 것만 알린다(#765).
 * 멈춘 서비스는 건너뛴다. 컨테이너 상태를 읽지 못하면 던진다(읽지 못한 것을 "멈춘 서비스"로 보면 모르는 프로세스가 통과한다)
 */
export async function strayProcessReports(ctx: ScanContext, services: readonly string[], baseline: ReadonlyMap<string, readonly ScannedProcess[]>, signal: AbortSignal | undefined): Promise<StrayProcessReport[]> {
  const baselineJson = JSON.stringify([...baseline].map(([service, list]) => [service, list.map((process) => [process.pid, process.start])]));
  const result = await native.strayProcesses(scanInput(ctx), [...services], baselineJson, signal ?? null);
  if (result.kind !== 'done') throw new Error(result.message ?? '컨테이너 상태를 읽지 못했습니다');
  return JSON.parse(result.reportsJson) as StrayProcessReport[];
}

/** 넘긴 서비스 이름 중 컨테이너가 running이 아닌(혹은 아예 없는) 것만 돌려준다. `ps` 출력을 해석하지 못하면 모두 running이 아닌 것이다 */
export async function missingServices(ctx: ScanContext, names: readonly string[], signal: AbortSignal | undefined): Promise<string[]> {
  if (names.length === 0) return [];
  return native.missingServices(
    composeRef(ctx.project, { dockerBin: ctx.dockerBin, env: ctx.env, projectName: ctx.id }),
    ctx.overridePath,
    [...names],
    signal ?? null,
  );
}

export interface InfraContext extends ScanContext {
  edgeService: string;
  /** `#compose`: `up`이면 `#upQueue`·`#gitMask`를 지난다 */
  compose: (args: string[], signal?: AbortSignal) => Promise<ExecResult>;
  /** 시크릿을 가린 stderr에 디스크 부족 안내를 붙인다(`describeDockerFailure(redact(...))`) */
  describeFailure: (stderr: string) => string;
}

/**
 * edge 프록시 + 넘긴 서비스가 실제로 running인지 보고, 없으면 이 샌드박스의 compose 프로젝트 안에서만 다시 올린다(트러블슈팅 86, ADR-143).
 * 코드가 바뀐 게 아니라 컨테이너가 사라진 것뿐이므로 이미지는 다시 빌드하지 않는다. `--no-deps`로 넘긴 서비스만 건드린다.
 * 확인("running인가")은 Rust가 하고, 없는 것을 올리는 `up`은 `#compose`를 지나게 여기서 부른다(`#upQueue`·`#gitMask`). 올린 뒤 다시 확인한다
 */
export async function ensureInfra(ctx: InfraContext, services: readonly string[], { signal }: { signal?: AbortSignal } = {}): Promise<InfraCheckResult> {
  const expected = [...new Set([ctx.edgeService, ...services])].sort();
  const missing = await missingServices(ctx, expected, signal);
  if (missing.length === 0) return { ok: true, recovered: [] };

  const result = await ctx.compose(['up', '--detach', '--no-deps', ...missing], signal);
  if (result.exitCode !== 0) {
    return { ok: false, recovered: [], missing, reason: ctx.describeFailure(result.stderr) };
  }

  const stillMissing = await missingServices(ctx, missing, signal);
  if (stillMissing.length > 0) {
    return {
      ok: false,
      recovered: missing.filter((name) => !stillMissing.includes(name)),
      missing: stillMissing,
      reason: `다시 올렸지만 ${stillMissing.join(', ')} 컨테이너가 여전히 running 상태가 아닙니다`,
    };
  }
  return { ok: true, recovered: missing };
}
