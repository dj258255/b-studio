import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import type { LoadedProject } from '@b-studio/spec';
import { stringify } from 'yaml';
import { SandboxError } from '../errors';
import { runCommand } from '../stream-exec';
import type { ExecResult } from '../types';
import { loadDependsOn } from './compose-deps';
import type { EvaluationAssetCopy } from './evaluation-assets';
import { buildOverride } from './format';
import type { MaskVolume } from './git-mask';
import { loadGitMaskLegacy } from './git-mask-legacy';
import { splitUpArgs } from './compose-provider';
import { startVerifiedLegacy, verifyMasksLegacy, type LegacyContext } from './verify-containers-legacy';

/**
 * A4c-1 이전의 `LocalDockerProvider.#upOnce`·`#refreshGitMask`·`#writeOverride`(차등 시험의 기준값). 지금 구현은 Rust(crates/bstudio-io/src/up_loop.rs)다.
 * 클래스의 비공개 필드는 `LegacyUpContext`로 풀어 받는다. 이 파일은 견주는 시험만 쓴다. 견주는 TS를 지우는 PR(4g)에서 함께 지운다.
 */
export interface LegacyUpContext {
  id: string;
  project: LoadedProject;
  dockerBin: string;
  env: NodeJS.ProcessEnv;
  overridePath: string;
  edgeScript: string;
  runtime: string | undefined;
  hostPorts: Record<string, number>;
  evaluationAssets: readonly EvaluationAssetCopy[];
  dependencyPollMs: number;
  dependencyWaitMs: number;
  redact: (text: string) => string;
  /** 옛 `#gitMask` */
  state: { gitMask: Record<string, MaskVolume[]> };
}

/** 옛 `GIT_MASK_ATTEMPTS` */
const GIT_MASK_ATTEMPTS = 3;

export async function upOnceLegacy(ctx: LegacyUpContext, args: string[], signal?: AbortSignal): Promise<ExecResult> {
  const docker = (dockerArgs: string[], abort?: AbortSignal) => runCommand(ctx.dockerBin, dockerArgs, { signal: abort, env: ctx.env });
  const composeArgs = (rest: string[]) => ['compose', '--project-name', ctx.id, '--project-directory', ctx.project.root, '--file', ctx.project.composePath, '--file', ctx.overridePath, ...rest];
  const writeOverride = async () => {
    const yaml = stringify(buildOverride(ctx.project, ctx.id, { edgeScript: ctx.edgeScript, runtime: ctx.runtime, hostPorts: ctx.hostPorts, gitMask: ctx.state.gitMask }));
    const temporary = `${ctx.overridePath}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, yaml);
    await rename(temporary, ctx.overridePath);
  };
  const refresh = async () => {
    const mask = await loadGitMaskLegacy(ctx.project, { dockerBin: ctx.dockerBin, env: ctx.env, projectName: ctx.id, evaluationAssets: ctx.evaluationAssets, redact: ctx.redact });
    if (JSON.stringify(mask) === JSON.stringify(ctx.state.gitMask)) return;
    ctx.state.gitMask = mask;
    await writeOverride();
  };
  const verifyContext = (dependsOn = {}): LegacyContext => ({
    id: ctx.id,
    projectRoot: ctx.project.root,
    docker: (dockerArgs, abort) => docker(dockerArgs, abort),
    composeArgs,
    redact: ctx.redact,
    gitMask: ctx.state.gitMask,
    evaluationAssets: ctx.evaluationAssets,
    dependencyPollMs: ctx.dependencyPollMs,
    dependencyWaitMs: ctx.dependencyWaitMs,
    dependsOn,
  });

  const { create, services, byId } = splitUpArgs(args);
  for (let attempt = 1; attempt <= GIT_MASK_ATTEMPTS; attempt++) {
    signal?.throwIfAborted();
    await refresh();
    const created = await docker(composeArgs(create), signal);
    if (created.exitCode !== 0) return created;
    const before = JSON.stringify(ctx.state.gitMask);
    await refresh();
    if (JSON.stringify(ctx.state.gitMask) !== before) continue;
    const verified = await verifyMasksLegacy(verifyContext(), 'created');
    let started: ExecResult;
    if (byId) {
      const dependsOn = services.length === 1 ? {} : await loadDependsOn(ctx.project, { dockerBin: ctx.dockerBin, env: ctx.env, projectName: ctx.id, redact: ctx.redact });
      started = await startVerifiedLegacy(verifyContext(dependsOn), verified, services, signal);
    } else {
      started = await docker(composeArgs(['start', ...services]), signal);
    }
    if (started.exitCode !== 0) return started;
    await verifyMasksLegacy(verifyContext(), 'started');
    return started;
  }
  await docker(composeArgs(['down', '--remove-orphans']), signal);
  throw new SandboxError(`compose 파일이 계속 바뀌어 .git 보호를 확정하지 못했습니다. 서비스를 내렸습니다 (${ctx.id})`);
}
