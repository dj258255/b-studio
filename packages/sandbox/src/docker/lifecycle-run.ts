import { tmpdir } from 'node:os';
import type { LoadedProject } from '@b-studio/spec';
import { SandboxError } from '../errors';
import { ExecCheckedError } from '../exec-checked';
import { decodeNative, encodeNative, native } from '../native';
import type { NativeCheckedResult } from '../native';
import type { ExecResult, ExternalCallRequest, ExternalCallResult, LoadRequest, LoadResult } from '../types';
import { LOAD_DEADLINE_MS, LOAD_REQUEST_TIMEOUT_MS, LOAD_RUNNER_IMAGE } from './load-runner';
import { composeRef } from './git-mask';

/**
 * 끝맺음(`removeSandboxImages`·`cleanup`·`destroy`)·사내 API 호출(`callExternal`)·부하 러너(`runLoad`)·런타임 확인(`assertRuntime`)·만들기의 앞뒤(`createWorkDir`·`abortCreate`)의 TS 껍데기(ADR-195 4f A4c-3c).
 * docker를 부르는 순서와 지우는 대상은 Rust(crates/bstudio-io/src/lifecycle_io.rs)가 하고, 여기는 결과를 옛 글 그대로의 오류로 바꾸고 시크릿을 가리기만 한다.
 * 옛 TS는 `lifecycle-legacy.ts`(차등 시험의 기준값).
 *
 * **Rust는 `up`을 부르지 않는다.** `destroy`의 `down`은 옛 코드도 `#compose`를 지났지만 `#compose`는 첫 인자가 `up`일 때만 `#upQueue`에 줄을 세우므로 `down`은 줄을 타지 않았다. 그대로 줄 밖에서 부른다.
 * (진행 중인 `up`과 `down`이 겹칠 수 있다는 뜻이다. 옛 코드와 같고, 줄 세우면 destroy가 기동이 끝날 때까지 막혀 취소가 늦어지므로 바꾸지 않았다. ADR-195 A4c-3c)
 * `#loadRunner`·`#daemonCpus`(캐시)는 상태라 `LoadCache`로 클래스에 남는다. `exec`·`execToFile`·`execFromFile`·`egressDenials`는 이미 Rust인 `runCommand*`·`runCommandLogStream` 한 번 + 시크릿 가림이라 옮기지 않았다.
 */

export interface LifecycleContext {
  id: string;
  dockerBin: string;
  /** compose가 시크릿 자리를 채울 환경(`composeEnvironment`) */
  env: NodeJS.ProcessEnv;
  project: Pick<LoadedProject, 'root' | 'composePath'>;
  overridePath: string;
  redact: (text: string) => string;
  /** `docker compose <command>`가 비0으로 끝났을 때 옛 글 그대로의 오류 */
  composeFailure: (command: string, result: ExecResult) => Error;
}

export interface DestroyContext extends LifecycleContext {
  workDir: string;
  evaluationAssetRoot: string;
}

export interface ExternalContext extends LifecycleContext {
  edgeScript: string;
  edgeService: string;
  external: ReadonlyArray<readonly [string, unknown]>;
}

/** 부하 러너의 캐시. 러너 스크립트 원문과 도커 CPU 수(읽었지만 알 수 없었던 것도 읽은 것이다) */
export interface LoadCache {
  runner?: Promise<string>;
  daemonCpus?: { value: number | undefined };
}

export interface LoadContext extends LifecycleContext {
  /** managed 서비스의 컨테이너 포트. managed가 아니면 던진다 */
  managedPort: (name: string) => number;
  sandboxNetwork: string;
  runtime?: string | undefined;
  readRunner: () => Promise<string>;
  cache: LoadCache;
  /** `docker run`을 기다리는 상한(ms). 러너가 스스로 끝내는 상한(요청 제한 시간 포함) + 여유 */
  limitMs: number;
}

/** 러너가 스스로 끝내는 상한 뒤에도 돌아오지 않으면 도커 쪽이 멈춘 것으로 본다 */
export const LOAD_RUN_GRACE_MS = 30_000;
export const LOAD_LIMIT_MS = LOAD_DEADLINE_MS + LOAD_REQUEST_TIMEOUT_MS + LOAD_RUN_GRACE_MS;

const notSandboxId = (id: string) => new SandboxError(`b-studio가 만든 샌드박스 id가 아닙니다: ${id}`);

/** Rust가 돌려준 `execChecked` 실패를 옛 오류 그대로 만든다 */
function checkedError(result: NativeCheckedResult): ExecCheckedError {
  if (result.code === null || result.code === undefined) {
    return new ExecCheckedError(result.message, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', result.stdout, result.stderr);
  }
  return new ExecCheckedError(result.message, result.code, result.stdout, result.stderr);
}

/** 이 샌드박스가 빌드한 이미지(`<샌드박스 id>-<서비스>`)를 지운다. 빌드 캐시는 지우지 않는다. 지울 이름은 `image ls --filter reference=<id>-*` 결과 가운데 `<id>-`로 시작하는 것뿐이다 */
export async function removeSandboxImages(dockerBin: string, sandboxId: string): Promise<void> {
  const result = await native.removeSandboxImages(dockerBin, sandboxId, tmpdir());
  if (result.kind === 'invalid-id') throw notSandboxId(sandboxId);
  if (result.kind === 'failed') throw checkedError(result);
}

/**
 * compose 파일 없이 프로젝트 이름(라벨)으로 컨테이너·볼륨·네트워크·이 샌드박스가 빌드한 이미지를 지우고 평가 자산 복사본 폴더를 지운다. external 공유 캐시는 지우지 않는다.
 * 작업 디렉터리의 compose 파일을 읽지 않도록 임시 디렉터리에서 실행한다. 지우기 실패는 모아 던진다
 */
export async function cleanupSandbox(options: { dockerBin: string; evaluationAssetRoot: string }, sandboxId: string): Promise<void> {
  const result = await native.cleanupSandbox(options.dockerBin, sandboxId, options.evaluationAssetRoot, tmpdir());
  if (result.kind === 'invalid-id') throw notSandboxId(sandboxId);
  if (result.failure) throw new SandboxError(`샌드박스 ${sandboxId}를 정리하지 못했습니다`, result.failure);
}

/**
 * `down` → 이 샌드박스가 빌드한 이미지 → 작업 폴더 → 평가 자산 복사본. 앞 단계가 실패해도 뒤 단계는 한다. 던지는 오류는 옛 `try/finally`처럼 뒤 단계의 것이 앞 단계의 것을 대신한다
 * (평가 자산 > 작업 폴더 > down·이미지)
 */
export async function destroySandbox(ctx: DestroyContext): Promise<void> {
  const result = await native.destroySandbox({
    compose: composeRef(ctx.project, { dockerBin: ctx.dockerBin, env: ctx.env, projectName: ctx.id }),
    overridePath: ctx.overridePath,
    workDir: ctx.workDir,
    assetRoot: ctx.evaluationAssetRoot,
    cwd: tmpdir(),
  });
  if (result.kind === 'invalid-id') throw notSandboxId(ctx.id);
  let failure: Error | undefined;
  if (result.downFailed) failure = ctx.composeFailure('down', { exitCode: 1, stdout: '', stderr: result.downStderr });
  else if (result.images.kind === 'invalid-id') failure = notSandboxId(ctx.id);
  else if (result.images.kind === 'failed') failure = checkedError(result.images);
  if (result.workDir) failure = new Error(result.workDir);
  if (result.assets) failure = new Error(result.assets);
  if (failure) throw failure;
}

/**
 * 사내 API를 부른다. 등록하지 않은 이름·`/`로 시작하지 않는 경로는 docker를 부르기 전에 거절한다(Rust). edge 컨테이너 안에서 실행해 샌드박스 서비스와 같은 네트워크 위치·정책·인증 시크릿으로 부른다.
 * 스튜디오용 포트를 따로 열면 샌드박스 서비스가 그 포트로 studio를 사칭할 수 있어 docker exec를 쓴다. 결과 본문은 시크릿을 가린다
 */
export async function callExternalApi(ctx: ExternalContext, name: string, request: ExternalCallRequest, { via, signal }: { via: string; signal?: AbortSignal }): Promise<ExternalCallResult> {
  const result = await native.callExternal(
    {
      compose: composeRef(ctx.project, { dockerBin: ctx.dockerBin, env: ctx.env, projectName: ctx.id }),
      overridePath: ctx.overridePath,
      edgeService: ctx.edgeService,
      externals: ctx.external.map(([external]) => external),
      name,
      path: request.path,
      edgeScript: ctx.edgeScript,
      // 요청의 JSON 글자는 여기서 만들어 그대로 넘긴다(같은 JSON.stringify라 옛 코드와 바이트가 같고, 짝 없는 서로게이트도 \udXXX로 쓰여 napi 경계에서 바뀌지 않게)
      requestJson: JSON.stringify({ name, via, ...request }),
    },
    signal ?? null,
  );
  switch (result.kind) {
    case 'not-registered':
      throw new SandboxError(`'${name}'은(는) 등록한 사내 API가 아닙니다`);
    case 'path-not-absolute':
      throw new SandboxError('경로는 "/"로 시작해야 합니다');
    case 'failed':
      throw new SandboxError('사내 API 호출을 실행하지 못했습니다', ctx.redact(result.stderr));
    case 'done': {
      const parsed = JSON.parse(result.last) as ExternalCallResult;
      return { ...parsed, body: ctx.redact(parsed.body) };
    }
    default:
      throw new SandboxError('사내 API 호출을 실행하지 못했습니다', `결과를 알 수 없습니다: ${String((result as { kind: unknown }).kind)}`);
  }
}

/** 시크릿을 **먼저 가린 뒤** 마지막 `lines`줄만 남긴다(자른 뒤에 가리면 여러 줄 시크릿의 잘린 조각이 가림 대상과 일치하지 않아 남는다. 트러블슈팅 194) */
function redactedTail(text: string, lines: number, redact: (text: string) => string): string {
  return redact(text).trim().split('\n').slice(-lines).join('\n');
}

/**
 * 부하 러너를 돌린다: 서비스 상태 확인 → 도커 CPU 수 → `docker run`(상한 시간) → 취소·시간 초과면 **이 실행이 만든 이름으로만** `rm --force` → 결과 읽기(Rust).
 * 러너 스크립트와 CPU 수는 한 번만 읽도록 `cache`에 둔다. 시간 초과는 성공이 아니고 결과를 읽지 못해도 성공이 아니다
 */
export async function runLoadTest(ctx: LoadContext, request: LoadRequest, { signal }: { signal?: AbortSignal } = {}): Promise<LoadResult> {
  const port = ctx.managedPort(request.service);
  ctx.cache.runner ??= ctx.readRunner();
  const runnerScript = await ctx.cache.runner;
  const cached = ctx.cache.daemonCpus;
  const result = await native.runLoad(
    {
      compose: composeRef(ctx.project, { dockerBin: ctx.dockerBin, env: ctx.env, projectName: ctx.id }),
      overridePath: ctx.overridePath,
      service: request.service,
      port,
      sandboxNetwork: ctx.sandboxNetwork,
      ...(ctx.runtime ? { runtime: ctx.runtime } : {}),
      image: LOAD_RUNNER_IMAGE,
      requestJson: encodeNative(request),
      requests: request.requests,
      concurrent: request.concurrent,
      runnerScript,
      cpusKnown: cached !== undefined,
      ...(cached?.value === undefined ? {} : { daemonCpus: cached.value }),
      limitMs: ctx.limitMs,
      signalAlreadyAborted: signal?.aborted ?? false,
    },
    signal ?? null,
  );
  if (result.cpusRead) ctx.cache.daemonCpus = { value: result.daemonCpus ?? undefined };
  switch (result.kind) {
    case 'invalid-id':
      throw notSandboxId(ctx.id);
    case 'state-unreadable':
    case 'config-invalid':
      throw new Error(result.message);
    case 'not-running':
      throw new SandboxError(`'${request.service}' 서비스가 실행 중이 아니어서 부하 확인을 돌릴 수 없습니다 (상태: ${result.message})`);
    case 'aborted':
      signal?.throwIfAborted();
      throw new SandboxError('부하 러너가 제한 시간 안에 끝나지 않았습니다', undefined, { platform: true });
    case 'timed-out':
      throw new SandboxError('부하 러너가 제한 시간 안에 끝나지 않았습니다', undefined, { platform: true });
    case 'runner-failed': {
      const reason = result.exitCode === 137 ? '러너가 메모리 한도(512MB)를 넘어 종료됐습니다' : redactedTail(result.stderr, 5, ctx.redact);
      throw new SandboxError(`부하 러너를 실행하지 못했습니다 (종료 코드 ${result.exitCode})`, reason, { platform: true });
    }
    case 'unreadable':
      throw new SandboxError('부하 러너의 결과를 읽지 못했습니다', redactedTail(result.stdout, 3, ctx.redact), { platform: true });
    case 'done':
      return decodeNative<LoadResult>(result.json);
    default:
      throw new SandboxError('부하 러너를 실행하지 못했습니다', `결과를 알 수 없습니다: ${String((result as { kind: unknown }).kind)}`, { platform: true });
  }
}

/** 런타임이 Docker 데몬에 등록돼 있는지 만들기 전에 알린다 */
export async function assertRuntime(dockerBin: string, runtime: string): Promise<void> {
  const result = await native.assertRuntime(dockerBin, runtime);
  if (result.kind === 'info-failed') throw new SandboxError('Docker 데몬 정보를 읽지 못해 컨테이너 런타임을 확인하지 못했습니다', result.message);
  if (result.kind === 'missing') {
    throw new SandboxError(`컨테이너 런타임 '${runtime}'이 Docker 데몬에 등록되지 않았습니다 (등록된 런타임: ${result.available.join(', ') || '없음'})`);
  }
}

/** 이 샌드박스의 작업 폴더를 임시 폴더 아래에 만든다(`b-studio-` + 무작위 6자, 권한 0700) */
export async function createWorkDir(): Promise<string> {
  return native.makeWorkDir();
}

/**
 * 샌드박스를 돌려주지 못하면 destroy도 불리지 않는다. 이 create가 만든 작업 폴더와 그 샌드박스 id의 복사본 폴더를 지운다.
 * 지우기 실패가 원래 오류(만들기를 거절한 이유)를 가리지 않게 던지지 않는다
 */
export async function abortCreate(workDir: string, evaluationAssetRoot: string, sandboxId: string): Promise<void> {
  await native.abortCreate(workDir, evaluationAssetRoot, sandboxId).catch(() => undefined);
}
