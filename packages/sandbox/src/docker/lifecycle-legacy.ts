import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { ExecResult, ExternalCallRequest, ExternalCallResult, LoadRequest, LoadResult } from '../types';
import { SandboxError } from '../errors';
import { execChecked } from '../exec-checked';
import { assertSandboxId } from '../sandbox-id';
import { externalCallScript } from './external-call-legacy';
import { removeEvaluationAssets } from './evaluation-assets';
import { parseContainerState, parseRuntimes } from './format';
import { loadConfig, loadRunArgs, loadScript, loadThreads, parseLoadOutput } from './load-runner-legacy';

/**
 * A4c-3c 이전의 `removeSandboxImages`·`LocalDockerProvider.cleanup`·`LocalDockerSandbox.destroy`·`callExternal`·`runLoad`·`assertRuntime`(차등 시험의 기준값).
 * 지금 구현은 Rust(crates/bstudio-io/src/lifecycle_io.rs)다. 클래스의 비공개 메서드는 컨텍스트 객체로 풀어 받는다. 이 파일은 견주는 시험만 쓴다.
 * 견주는 TS를 지우는 PR(4g)에서 함께 지운다.
 */

export async function removeSandboxImagesLegacy(dockerBin: string, sandboxId: string): Promise<void> {
  assertSandboxId(sandboxId);
  const { stdout } = await execChecked(dockerBin, ['image', 'ls', '--filter', `reference=${sandboxId}-*`, '--format', '{{.Repository}}:{{.Tag}}'], { cwd: tmpdir() });
  const images = stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith(`${sandboxId}-`));
  if (images.length > 0) await execChecked(dockerBin, ['image', 'rm', ...images], { cwd: tmpdir() });
}

export async function cleanupLegacy(options: { dockerBin: string; evaluationAssetRoot: string }, sandboxId: string): Promise<void> {
  // 옛 `cleanupCommand`
  assertSandboxId(sandboxId);
  const command = options.dockerBin;
  const args = ['compose', '--project-name', sandboxId, 'down', '--volumes', '--remove-orphans', '--rmi', 'local'];
  let failure: unknown;
  try {
    await execChecked(command, args, { cwd: tmpdir() });
    await removeSandboxImagesLegacy(command, sandboxId);
  } catch (error) {
    failure = error;
  }
  await removeEvaluationAssets(options.evaluationAssetRoot, sandboxId).catch((error: unknown) => (failure ??= error));
  if (failure) throw new SandboxError(`샌드박스 ${sandboxId}를 정리하지 못했습니다`, failure instanceof Error ? failure.message : String(failure));
}

export interface LegacyLifecycleContext {
  id: string;
  dockerBin: string;
  /** 옛 `#docker` */
  docker: (args: string[], signal?: AbortSignal, input?: string) => Promise<ExecResult>;
  /** 옛 `#composeArgs` */
  composeArgs: (args: string[]) => string[];
  /** 옛 `#composeFailure` */
  composeFailure: (command: string, result: ExecResult) => Error;
  redact: (text: string) => string;
  workDir: string;
  evaluationAssetRoot: string;
  edgeScript: string;
  edgeService: string;
  external: ReadonlyArray<readonly [string, unknown]>;
  managedPort: (name: string) => number;
  runtime?: string;
  sandboxNetwork: string;
  runnerScriptPath: string;
  /** 옛 `#loadRunner`·`#daemonCpus`(상태) */
  loadCache: { runner?: Promise<string>; daemonCpus?: Promise<number | undefined> };
  /** 옛 `LOAD_DEADLINE_MS + LOAD_REQUEST_TIMEOUT_MS + LOAD_RUN_GRACE_MS`(시험이 줄여 줄 수 있다) */
  loadLimitMs: number;
}

export async function destroyLegacy(ctx: LegacyLifecycleContext): Promise<void> {
  try {
    // 옛 `#composeOrThrow(['down', ...])`
    const result = await ctx.docker(ctx.composeArgs(['down', '--volumes', '--remove-orphans', '--rmi', 'local']));
    if (result.exitCode !== 0) throw ctx.composeFailure('down', result);
    await removeSandboxImagesLegacy(ctx.dockerBin, ctx.id);
  } finally {
    try {
      await rm(ctx.workDir, { recursive: true, force: true });
    } finally {
      await removeEvaluationAssets(ctx.evaluationAssetRoot, ctx.id);
    }
  }
}

export async function callExternalLegacy(ctx: LegacyLifecycleContext, name: string, request: ExternalCallRequest, { via, signal }: { via: string; signal?: AbortSignal }): Promise<ExternalCallResult> {
  if (!ctx.external.some(([external]) => external === name)) throw new SandboxError(`'${name}'은(는) 등록한 사내 API가 아닙니다`);
  if (!request.path.startsWith('/')) throw new SandboxError('경로는 "/"로 시작해야 합니다');

  const script = externalCallScript(ctx.edgeScript, { name, via, ...request });
  const result = await ctx.docker(ctx.composeArgs(['exec', '-T', ctx.edgeService, 'node', '--input-type=module', '-']), signal, script);
  const last = result.stdout.trim().split('\n').at(-1);
  if (result.exitCode !== 0 || !last) throw new SandboxError('사내 API 호출을 실행하지 못했습니다', ctx.redact(result.stderr));
  const parsed = JSON.parse(last) as ExternalCallResult;
  return { ...parsed, body: ctx.redact(parsed.body) };
}

export async function runLoadLegacy(ctx: LegacyLifecycleContext, request: LoadRequest, { signal }: { signal?: AbortSignal } = {}): Promise<LoadResult> {
  const port = ctx.managedPort(request.service);
  // 옛 `state()`
  const psResult = await ctx.docker(ctx.composeArgs(['ps', '--all', '--format', 'json', request.service]));
  const state = parseContainerState(psResult.stdout);
  if (state !== 'running') throw new SandboxError(`'${request.service}' 서비스가 실행 중이 아니어서 부하 확인을 돌릴 수 없습니다 (상태: ${state})`);

  ctx.loadCache.runner ??= readFile(ctx.runnerScriptPath, 'utf8');
  ctx.loadCache.daemonCpus ??= ctx.docker(['info', '--format', '{{.NCPU}}']).then((info) => (info.exitCode === 0 ? Number.parseInt(info.stdout.trim(), 10) || undefined : undefined));
  const threads = loadThreads(request.concurrent, await ctx.loadCache.daemonCpus);
  const name = `${ctx.id}-load-${randomBytes(4).toString('hex')}`;
  const script = loadScript(await ctx.loadCache.runner, loadConfig(request, { port, threads }));
  const limit = AbortSignal.timeout(ctx.loadLimitMs);
  const args = loadRunArgs({ name, network: `${ctx.id}_${ctx.sandboxNetwork}`, sandboxId: ctx.id, threads, ...(ctx.runtime ? { runtime: ctx.runtime } : {}) });
  const result = await ctx.docker(args, signal ? AbortSignal.any([signal, limit]) : limit, script);

  if (signal?.aborted || limit.aborted) {
    await ctx.docker(['rm', '--force', name]).catch(() => undefined);
    signal?.throwIfAborted();
    throw new SandboxError('부하 러너가 제한 시간 안에 끝나지 않았습니다', undefined, { platform: true });
  }
  if (result.exitCode !== 0) {
    const reason = result.exitCode === 137 ? '러너가 메모리 한도(512MB)를 넘어 종료됐습니다' : ctx.redact(result.stderr.trim().split('\n').slice(-5).join('\n'));
    throw new SandboxError(`부하 러너를 실행하지 못했습니다 (종료 코드 ${result.exitCode})`, reason, { platform: true });
  }
  const parsed = parseLoadOutput(result.stdout, request);
  if (!parsed) throw new SandboxError('부하 러너의 결과를 읽지 못했습니다', ctx.redact(result.stdout.trim().split('\n').slice(-3).join('\n')), { platform: true });
  return parsed;
}

export async function assertRuntimeLegacy(dockerBin: string, runtime: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execChecked(dockerBin, ['info', '--format', '{{json .Runtimes}}']));
  } catch (error) {
    throw new SandboxError('Docker 데몬 정보를 읽지 못해 컨테이너 런타임을 확인하지 못했습니다', error instanceof Error ? error.message : String(error));
  }
  const available = parseRuntimes(stdout);
  if (!available.includes(runtime)) {
    throw new SandboxError(`컨테이너 런타임 '${runtime}'이 Docker 데몬에 등록되지 않았습니다 (등록된 런타임: ${available.join(', ') || '없음'})`);
  }
}
