import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LoadedProject } from '@b-studio/spec';
import { SandboxError } from '../errors';
import { withRemovedDirectories } from '../sync-paths';
import type { ExecResult, FileChange, RelayedPath, SyncResult } from '../types';
import { isDockerUnreachable } from '../errors';
import { describeDockerFailure, isPortBindConflict, preallocatePublicUrlPorts } from './compose-provider';
import { parseSyncOutput, SYNC_SCRIPT, SyncObservations } from './format';
import type { EvaluationAssetCopy } from './evaluation-assets';
import type { MaskVolume } from './git-mask';
import { bindMounts, planRelay, RELAY_SCRIPT } from './relay';
import { overrideInputJson, upWithGitMask, writeComposeOverride } from './up-loop';

/**
 * A4c-2 이전의 `LocalDockerSandbox.sync`·`relayChanges`·`#composeUpWithPortRetry`·`#regeneratePorts`(차등 시험의 기준값). 지금 구현은 Rust
 * (crates/bstudio-io/src/{sync_relay,port_retry}.rs)다. 클래스의 비공개 필드는 컨텍스트 객체로 풀어 받는다. 이 파일은 견주는 시험만 쓴다.
 * 견주는 TS를 지우는 PR(4g)에서 함께 지운다.
 */

const SYNC_HELPER_IMAGE = 'busybox:1.37';
const PORT_RETRY_ATTEMPTS = 3;

async function hashOrMissing(file: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(file)).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'MISSING';
    throw error;
  }
}

export interface LegacySyncContext {
  project: LoadedProject;
  /** 옛 `#docker` */
  docker: (args: string[], signal?: AbortSignal) => Promise<ExecResult>;
}

export async function syncLegacy(ctx: LegacySyncContext, files: string[], { signal, timeoutMs = 60_000 }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SyncResult> {
  if (files.length === 0) return { elapsedMs: 0, checks: 0 };

  const targets = await withRemovedDirectories(ctx.project.root, files);
  const expected = new Map(await Promise.all(targets.map(async (file) => [file, await hashOrMissing(path.join(ctx.project.root, file))] as const)));
  const started = Date.now();
  const observations = new SyncObservations();

  for (let checks = 1; ; checks++) {
    const result = await ctx.docker(
      ['run', '--rm', '--network', 'none', '--volume', `${ctx.project.root}:/project:ro`, SYNC_HELPER_IMAGE, 'sh', '-c', SYNC_SCRIPT, 'sh', ...targets],
      signal,
    );
    if (result.exitCode !== 0) throw new SandboxError('샌드박스 파일 반영 확인에 실패했습니다', result.stderr, { platform: true });

    const seen = parseSyncOutput(result.stdout);
    const pending = targets.filter((file) => seen.get(file) !== expected.get(file));
    if (pending.length === 0) return { elapsedMs: Date.now() - started, checks };
    for (const file of pending) observations.record(file, seen.get(file));

    if (Date.now() - started >= timeoutMs) {
      throw new SandboxError(observations.describeTimeout(pending, expected, timeoutMs), undefined, { platform: true });
    }
    await sleep(250, undefined, { signal });
  }
}

type ComposeConfig = { services: Record<string, { volumes?: Array<{ type: string; source?: string; target: string }> }> };

export interface LegacyRelayContext {
  id: string;
  project: LoadedProject;
  /** 옛 `#compose` */
  compose: (args: string[], signal?: AbortSignal) => Promise<ExecResult>;
  redact: (text: string) => string;
  /** 옛 `#composeConfig` */
  state: { config: Promise<ComposeConfig> | undefined };
}

export async function relayChangesLegacy(ctx: LegacyRelayContext, changes: FileChange[], { signal }: { signal?: AbortSignal } = {}): Promise<RelayedPath[]> {
  if (changes.length === 0) return [];
  ctx.state.config ??= ctx.compose(['config', '--format', 'json']).then((result) => {
    if (result.exitCode !== 0) throw new SandboxError(`compose 설정을 읽지 못했습니다 (${ctx.id})`, ctx.redact(result.stderr));
    return JSON.parse(result.stdout) as ComposeConfig;
  });
  const config = await ctx.state.config.catch((error: unknown) => {
    ctx.state.config = undefined;
    throw error;
  });

  const managed = new Set(ctx.project.managed.map(([name]) => name));
  const servicePaths = Object.fromEntries(ctx.project.managed.map(([name, spec]) => [name, spec.path]));
  const relayed: RelayedPath[] = [];
  for (const [service, targets] of planRelay(ctx.project.root, changes, bindMounts(config.services, managed, servicePaths))) {
    const args = targets.map((target) => `${target.action === 'move' ? 'm' : 'n'}:${target.containerPath}`);
    const result = await ctx.compose(['exec', '-T', service, 'sh', '-c', RELAY_SCRIPT, 'sh', ...args], signal);
    const done = new Set(result.stdout.split('\n').filter(Boolean));
    relayed.push(...targets.filter((_, index) => done.has(args[index]!)).flatMap((target) => target.files.map((file) => ({ service, file }))));
  }
  return relayed;
}

export interface LegacyRetryContext {
  id: string;
  project: LoadedProject;
  dockerBin: string;
  env: NodeJS.ProcessEnv;
  overridePath: string;
  edgeScript: string;
  runtime: string | undefined;
  evaluationAssets: readonly EvaluationAssetCopy[];
  dependencyPollMs: number;
  dependencyWaitMs: number;
  redact: (text: string) => string;
  /** 옛 `#docker` */
  docker: (args: string[], signal?: AbortSignal) => Promise<ExecResult>;
  /** 옛 `#gitMask`·`#hostPorts` */
  state: { gitMask: Record<string, MaskVolume[]>; hostPorts: Record<string, number> };
  sandboxNetwork: string;
  egressNetwork: string;
  edgeService: string;
  serviceLabel: string;
}

/** 옛 `#composeUpWithPortRetry`가 `#composeOrThrow(['up', …])`로 부르던 한 번(#upWithGitMask 큐는 뺐다: 줄 세움은 이 시험의 대상이 아니다) */
async function composeUpOrThrow(ctx: LegacyRetryContext, args: string[], signal?: AbortSignal): Promise<ExecResult> {
  const result = await upWithGitMask({
    id: ctx.id,
    project: ctx.project,
    dockerBin: ctx.dockerBin,
    env: ctx.env,
    overridePath: ctx.overridePath,
    overrideInput: overrideInputJson(ctx.project, ctx.id, { edgeScript: ctx.edgeScript, runtime: ctx.runtime, hostPorts: ctx.state.hostPorts }),
    gitMask: ctx.state.gitMask,
    evaluationAssets: ctx.evaluationAssets,
    args,
    sandboxNetwork: ctx.sandboxNetwork,
    egressNetwork: ctx.egressNetwork,
    edgeService: ctx.edgeService,
    serviceLabel: ctx.serviceLabel,
    pollMs: ctx.dependencyPollMs,
    waitMs: ctx.dependencyWaitMs,
    ...(signal ? { signal } : {}),
    redact: ctx.redact,
    onMask: (mask) => {
      ctx.state.gitMask = mask;
    },
  });
  if (result.exitCode !== 0) {
    throw new SandboxError(`docker compose ${args[0]} 실패 (${ctx.id})`, describeDockerFailure(ctx.redact(result.stderr)), { platform: isDockerUnreachable(result.stderr) });
  }
  return result;
}

export async function composeUpWithPortRetryLegacy(ctx: LegacyRetryContext, upArgs: string[], signal?: AbortSignal): Promise<void> {
  const composeArgs = (rest: string[]) => ['compose', '--project-name', ctx.id, '--project-directory', ctx.project.root, '--file', ctx.project.composePath, '--file', ctx.overridePath, ...rest];
  for (let attempt = 1; attempt <= PORT_RETRY_ATTEMPTS; attempt++) {
    try {
      await composeUpOrThrow(ctx, ['up', '--detach', '--remove-orphans', ...upArgs], signal);
      return;
    } catch (error) {
      const detail = error instanceof SandboxError ? (error.detail ?? '') : '';
      const isLastAttempt = attempt === PORT_RETRY_ATTEMPTS;
      if (!isPortBindConflict(detail)) throw error;
      if (isLastAttempt) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SandboxError(`${message}\n포트 충돌이 반복돼 ${PORT_RETRY_ATTEMPTS}회 재시도 후 포기했습니다`, undefined, { platform: true });
      }
      ctx.state.hostPorts = await preallocatePublicUrlPorts(ctx.project);
      await writeComposeOverride(ctx.overridePath, overrideInputJson(ctx.project, ctx.id, { edgeScript: ctx.edgeScript, runtime: ctx.runtime, hostPorts: ctx.state.hostPorts }), ctx.state.gitMask);
      await ctx.docker(composeArgs(['rm', '--stop', '--force', '--volumes']), signal);
    }
  }
}
