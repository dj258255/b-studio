import { setTimeout as sleep } from 'node:timers/promises';
import { SandboxError } from '../errors';
import type { ExecResult } from '../types';
import { awaitedCondition, startWaves, type DependsOn } from './compose-deps';
import { findPolicyViolations, type InspectedContainerPolicy } from './container-policy';
import type { EvaluationAssetCopy } from './evaluation-assets';
import { EDGE_SERVICE, EGRESS_NETWORK, SANDBOX_NETWORK } from './format';
import type { InspectedMount, MaskVolume } from './git-mask';
import { findMissingMasksLegacy, selectEvaluationAssetVolumesLegacy } from './git-mask-legacy';

/**
 * A4b 이전의 `LocalDockerProvider.#verifyMasks`·`#startVerified`·`#waitForDependency`(차등 시험의 기준값).
 * 지금 구현은 Rust(crates/bstudio-io/src/container_verify.rs)다. 클래스의 비공개 필드는 `LegacyContext`로 풀어 받는다.
 * 이 파일은 견주는 시험만 쓴다. 견주는 TS를 지우는 PR(4g)에서 함께 지운다.
 */
export interface LegacyContext {
  id: string;
  projectRoot: string;
  docker(args: string[], signal?: AbortSignal, input?: string): Promise<ExecResult>;
  composeArgs(args: string[]): string[];
  redact(text: string): string;
  gitMask: Record<string, MaskVolume[]>;
  evaluationAssets: readonly EvaluationAssetCopy[];
  dependencyPollMs: number;
  dependencyWaitMs: number;
  /** `#startVerified`가 읽던 `loadDependsOn`의 결과 */
  dependsOn: DependsOn;
}

const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

export async function startVerifiedLegacy(
  ctx: LegacyContext,
  verified: ReadonlyArray<{ id: string; service: string | undefined }>,
  services: readonly string[],
  signal?: AbortSignal,
): Promise<ExecResult> {
  const idsOf = (names: readonly string[]) => verified.filter((container) => container.service !== undefined && names.includes(container.service)).map((container) => container.id);
  const missing = services.filter((service) => idsOf([service]).length === 0);
  if (missing.length > 0) throw new SandboxError(`만든 컨테이너를 찾지 못해 시작하지 않았습니다 (${ctx.id})`, missing.join(', '), { platform: true });
  if (services.length === 1) return ctx.docker(['start', ...idsOf(services)], signal);

  const dependsOn = ctx.dependsOn;
  const waves = startWaves(services, dependsOn);
  let last: ExecResult = { exitCode: 0, stdout: '', stderr: '' };
  for (const [index, wave] of waves.entries()) {
    last = await ctx.docker(['start', ...idsOf(wave)], signal);
    if (last.exitCode !== 0) return last;
    const later = waves.slice(index + 1).flat();
    for (const service of wave) {
      const condition = awaitedCondition(service, later, dependsOn);
      if (!condition) continue;
      const problem = await waitForDependencyLegacy(ctx, idsOf([service]), service, condition, signal);
      if (problem) return { exitCode: 1, stdout: '', stderr: problem };
    }
  }
  return last;
}

async function waitForDependencyLegacy(ctx: LegacyContext, ids: readonly string[], service: string, condition: 'service_healthy' | 'service_completed_successfully', signal?: AbortSignal): Promise<string | undefined> {
  const deadline = Date.now() + ctx.dependencyWaitMs;
  for (;;) {
    signal?.throwIfAborted();
    const inspected = await ctx.docker(['inspect', '--format', '{{json .State}}', ...ids]);
    if (inspected.exitCode !== 0) return `dependency failed to start: ${service}의 상태를 읽지 못했습니다`;
    let states: Array<{ Status?: string; ExitCode?: number; Health?: { Status?: string } | null }>;
    try {
      states = inspected.stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    } catch {
      return `dependency failed to start: ${service}의 상태를 해석하지 못했습니다`;
    }
    if (states.length === 0) return `dependency failed to start: ${service}의 상태를 읽지 못했습니다`;
    if (condition === 'service_healthy') {
      if (states.some((state) => !state.Health)) return `dependency failed to start: container ${service} has no healthcheck configured`;
      if (states.every((state) => state.Health?.Status === 'healthy')) return undefined;
      if (states.some((state) => state.Health?.Status === 'unhealthy')) return `dependency failed to start: container ${service} is unhealthy`;
      if (states.some((state) => state.Status === 'exited' || state.Status === 'dead')) return `dependency failed to start: container ${service} exited`;
    } else {
      if (states.every((state) => state.Status === 'exited' && state.ExitCode === 0)) return undefined;
      const failed = states.find((state) => state.Status === 'exited' && state.ExitCode !== 0);
      if (failed) return `service "${service}" didn't complete successfully: exit ${failed.ExitCode}`;
    }
    if (Date.now() > deadline) return `dependency failed to start: ${service}이(가) ${Math.round(ctx.dependencyWaitMs / 1000)}초 안에 준비되지 않았습니다`;
    await sleep(ctx.dependencyPollMs, undefined, { signal });
  }
}

export async function verifyMasksLegacy(ctx: LegacyContext, phase: 'created' | 'started'): Promise<Array<{ id: string; service: string | undefined }>> {
  const listed = await ctx.docker(ctx.composeArgs(['ps', '--all', '--quiet', '--no-trunc']));
  if (listed.exitCode !== 0) throw new SandboxError(`컨테이너 목록을 확인하지 못했습니다 (${ctx.id})`, ctx.redact(listed.stderr), { platform: true });
  const ids = listed.stdout.split('\n').map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) throw new SandboxError(`컨테이너가 보이지 않아 .git 보호를 확인하지 못했습니다 (${ctx.id})`, undefined, { platform: true });
  const inspected = await ctx.docker(['inspect', ...ids]);
  if (inspected.exitCode !== 0) throw new SandboxError(`컨테이너 마운트를 확인하지 못했습니다 (${ctx.id})`, ctx.redact(inspected.stderr), { platform: true });
  let containers: Array<Omit<InspectedContainerPolicy, 'Mounts' | 'Config'> & { Id: string; Name?: string; Mounts?: InspectedMount[]; Config?: { Labels?: Record<string, string> } }>;
  try {
    containers = JSON.parse(inspected.stdout);
  } catch {
    throw new SandboxError(`컨테이너 마운트(docker inspect)를 해석하지 못했습니다 (${ctx.id})`, undefined, { platform: true });
  }
  const seen = new Set(Array.isArray(containers) ? containers.map((container) => container?.Id) : []);
  if (!Array.isArray(containers) || ids.some((id) => !seen.has(id))) {
    throw new SandboxError(`컨테이너 마운트를 일부만 확인했습니다 (${ctx.id})`, undefined, { platform: true });
  }
  const names = [...new Set(containers.flatMap((container) => (container.Mounts ?? []).filter((mount) => mount.Type === 'volume' && mount.Name).map((mount) => mount.Name!)))];
  const volumeOptions: Record<string, { driver?: string; driver_opts?: Record<string, string> }> = {};
  if (names.length > 0) {
    const volumes = await ctx.docker(['volume', 'inspect', ...names]);
    if (volumes.exitCode !== 0) throw new SandboxError(`볼륨 정보를 확인하지 못했습니다 (${ctx.id})`, ctx.redact(volumes.stderr), { platform: true });
    try {
      for (const volume of JSON.parse(volumes.stdout) as Array<{ Name: string; Driver?: string; Options?: Record<string, string> | null }>) {
        volumeOptions[volume.Name] = { ...(volume.Driver ? { driver: volume.Driver } : {}), driver_opts: volume.Options ?? {} };
      }
    } catch {
      throw new SandboxError(`볼륨 정보(docker volume inspect)를 해석하지 못했습니다 (${ctx.id})`, undefined, { platform: true });
    }
    const unknown = names.filter((name) => volumeOptions[name] === undefined);
    if (unknown.length > 0) throw new SandboxError(`볼륨 정보를 일부만 확인했습니다 (${ctx.id})`, unknown.join(', '), { platform: true });
  }
  const failures: string[] = [];
  const violations: string[] = [];
  const remove: string[] = [];
  const evaluationAssetPlan: Record<string, MaskVolume[]> = {};
  for (const [service, volumes] of Object.entries(ctx.gitMask)) {
    const planned = await selectEvaluationAssetVolumesLegacy(volumes, ctx.evaluationAssets);
    if (planned.length > 0) evaluationAssetPlan[service] = planned;
  }
  for (const container of containers) {
    const service = container.Config?.Labels?.[COMPOSE_SERVICE_LABEL];
    const name = service ?? container.Name ?? container.Id;
    const escalated = findPolicyViolations(container, { projectName: ctx.id, sandboxNetwork: SANDBOX_NETWORK, egressNetwork: EGRESS_NETWORK, edgeService: EDGE_SERVICE });
    const missing = await findMissingMasksLegacy(ctx.projectRoot, container.Mounts ?? [], volumeOptions, {
      evaluationAssetPlan,
      service,
      tmpfs: container.HostConfig?.Tmpfs ?? {},
    });
    if (escalated.length === 0 && missing.length === 0) continue;
    remove.push(container.Id);
    if (escalated.length > 0) violations.push(`${name}: ${escalated.join(', ')}`);
    if (missing.length > 0) failures.push(`${name}: ${missing.join(', ')}`);
  }
  if (remove.length === 0) return containers.map((container) => ({ id: container.Id, service: container.Config?.Labels?.[COMPOSE_SERVICE_LABEL] }));
  const removed = await ctx.docker(['rm', '--force', ...remove]);
  const left = removed.exitCode === 0 ? '' : ' 그 컨테이너를 지우지 못했습니다 — 아직 돌고 있을 수 있습니다';
  if (violations.length > 0) {
    throw new SandboxError(
      phase === 'created'
        ? `컨테이너에 샌드박스 격리를 벗어나는 설정이 있어 시작하지 않았습니다 (${ctx.id})${left}`
        : `컨테이너에 샌드박스 격리를 벗어나는 설정이 있어 내렸습니다 (${ctx.id})${left}`,
      [...violations, ...failures].join('\n'),
    );
  }
  throw new SandboxError(
    phase === 'created'
      ? `컨테이너에 .git 읽기 전용 마운트가 빠져 시작하지 않았습니다 (${ctx.id})${left}`
      : `컨테이너에 .git 읽기 전용 마운트가 빠져 내렸습니다 (${ctx.id})${left}`,
    failures.join('\n'),
    { platform: true },
  );
}
