import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { SandboxError } from '../errors';
import { execChecked } from '../exec-checked';
import type { ExecResult, ServiceUsage, SnapshotEvent, StartOptions } from '../types';
import { SYNC_HELPER_IMAGE } from './sync-relay';
import { composeVolumeName, SNAPSHOT_LABEL, SNAPSHOT_MARKER, snapshotName, SNAPSHOTS_TO_KEEP, snapshotSlot, snapshotsToPrune } from './snapshots';
import { mergeUsage, parseInspectOutput, parseStatsOutput } from './usage';

/**
 * A4c-3b 이전의 `LocalDockerSandbox.#planSnapshots`·`#seedSnapshot`·`#captureSnapshot`·`#pruneSnapshots`·`#ensureSharedVolumes`·`stats()`(차등 시험의 기준값).
 * 지금 구현은 Rust(crates/bstudio-io/src/snapshot_io.rs)다. 클래스의 비공개 메서드는 컨텍스트 객체로 풀어 받는다. 이 파일은 견주는 시험만 쓴다.
 * 견주는 TS를 지우는 PR(4g)에서 함께 지운다.
 */

const SEED_SCRIPT = `[ -f /from/${SNAPSHOT_MARKER} ] || exit 3\ncp -a /from/. /to/ && rm -f /to/${SNAPSHOT_MARKER}`;
const CAPTURE_SCRIPT = `cp -a /from/. /to/ && touch /to/${SNAPSHOT_MARKER}`;

/** 같은 스튜디오 서버에서 두 세션이 같은 스냅샷을 동시에 만들지 않게 한다 */
const capturing = new Set<string>();

export interface LegacySnapshotPlan {
  service: string;
  volume: string;
  snapshot: string;
  slot: string;
  /** compose가 이 샌드박스에 만들 볼륨 이름 */
  sandboxVolume: string;
}

export interface LegacySnapshotContext {
  id: string;
  project: Pick<LoadedProject, 'root' | 'managed' | 'spec' | 'sharedVolumes'>;
  dockerBin: string;
  /** 옛 `#docker` */
  docker: (args: string[], signal?: AbortSignal) => Promise<ExecResult>;
  /** 옛 `#composeArgs` */
  composeArgs: (args: string[]) => string[];
  redact: (text: string) => string;
  statsTimeoutMs: number;
}

export async function planSnapshotsLegacy(ctx: LegacySnapshotContext): Promise<LegacySnapshotPlan[]> {
  const plans: LegacySnapshotPlan[] = [];
  for (const [service, spec] of ctx.project.managed) {
    for (const { volume, key } of spec.snapshots ?? []) {
      const files = await Promise.all(
        key.map(async (file) => ({
          path: file,
          content: await readFile(path.join(ctx.project.root, spec.path, file)).catch(() => undefined),
        })),
      );
      plans.push({
        service,
        volume,
        snapshot: snapshotName({ project: ctx.project.spec.name, service, volume, files }),
        slot: snapshotSlot(ctx.project.spec.name, service, volume),
        sandboxVolume: composeVolumeName(ctx.id, volume),
      });
    }
  }
  return plans;
}

/** 스냅샷이 있으면 이 샌드박스의 볼륨을 미리 만들어 채운다. 실패하면 빈 볼륨으로 평소처럼 설치한다 */
export async function seedSnapshotLegacy(ctx: LegacySnapshotContext, plan: LegacySnapshotPlan, { signal, onSnapshot }: Pick<StartOptions, 'signal' | 'onSnapshot'>): Promise<boolean> {
  const event = { service: plan.service, volume: plan.volume, snapshot: plan.snapshot };
  if ((await ctx.docker(['volume', 'inspect', plan.snapshot], signal)).exitCode !== 0) {
    onSnapshot?.({ ...event, action: 'missing' });
    return false;
  }

  const started = Date.now();
  // compose가 자기 볼륨으로 알아보도록 compose 라벨을 붙인다. 그래야 경고 없이 쓰고 destroy() 때 함께 지운다
  const created = await ctx.docker(
    [
      'volume', 'create',
      '--label', `com.docker.compose.project=${ctx.id}`,
      '--label', `com.docker.compose.volume=${plan.volume}`,
      plan.sandboxVolume,
    ],
    signal,
  );
  const copied =
    created.exitCode === 0
      ? await ctx.docker(
          ['run', '--rm', '--network', 'none', '--volume', `${plan.snapshot}:/from:ro`, '--volume', `${plan.sandboxVolume}:/to`, SYNC_HELPER_IMAGE, 'sh', '-c', SEED_SCRIPT],
          signal,
        )
      : created;

  if (copied.exitCode === 0) {
    onSnapshot?.({ ...event, action: 'seeded', elapsedMs: Date.now() - started });
    return true;
  }

  await ctx.docker(['volume', 'rm', '--force', plan.sandboxVolume]);
  // 끝까지 복사되지 않은 스냅샷은 지워서 이번 기동이 새로 만들게 한다 (다른 샌드박스가 쓰는 중이면 지워지지 않는다)
  if (copied.exitCode === 3) await ctx.docker(['volume', 'rm', plan.snapshot]);
  onSnapshot?.({
    ...event,
    action: 'failed',
    stage: 'seed',
    reason: copied.exitCode === 3 ? '스냅샷이 끝까지 저장되지 않았습니다' : copied.stderr.trim() || `exit ${copied.exitCode}`,
  });
  return false;
}

export async function captureSnapshotLegacy(ctx: LegacySnapshotContext, plan: LegacySnapshotPlan, { onSnapshot }: Pick<StartOptions, 'onSnapshot'>): Promise<void> {
  if (capturing.has(plan.snapshot)) return;
  capturing.add(plan.snapshot);
  const event = { service: plan.service, volume: plan.volume, snapshot: plan.snapshot };
  const started = Date.now();
  try {
    // 그사이 다른 세션이 만들었으면 그것을 쓴다
    if ((await ctx.docker(['volume', 'inspect', plan.snapshot])).exitCode === 0) return;

    const created = await ctx.docker(['volume', 'create', '--label', `${SNAPSHOT_LABEL}=true`, '--label', `${SNAPSHOT_LABEL}.slot=${plan.slot}`, plan.snapshot]);
    if (created.exitCode !== 0) throw new SandboxError('스냅샷 볼륨을 만들지 못했습니다', created.stderr);

    const copied = await ctx.docker([
      'run', '--rm', '--network', 'none', '--volume', `${plan.sandboxVolume}:/from:ro`, '--volume', `${plan.snapshot}:/to`, SYNC_HELPER_IMAGE, 'sh', '-c', CAPTURE_SCRIPT,
    ]);
    if (copied.exitCode !== 0) {
      await ctx.docker(['volume', 'rm', '--force', plan.snapshot]);
      throw new SandboxError('스냅샷을 복사하지 못했습니다', copied.stderr);
    }

    onSnapshot?.({ ...event, action: 'captured', elapsedMs: Date.now() - started });
    await pruneSnapshotsLegacy(ctx, plan.slot);
  } catch (error) {
    const reason = error instanceof SandboxError && error.detail ? `${error.message}: ${error.detail.trim()}` : String(error);
    onSnapshot?.({ ...event, action: 'failed', stage: 'capture', reason } as SnapshotEvent);
  } finally {
    capturing.delete(plan.snapshot);
  }
}

/** lockfile이 바뀔 때마다 스냅샷이 쌓이므로 같은 자리에서는 최근 것만 남긴다 */
export async function pruneSnapshotsLegacy(ctx: LegacySnapshotContext, slot: string): Promise<void> {
  const listed = await ctx.docker(['volume', 'ls', '--quiet', '--filter', `label=${SNAPSHOT_LABEL}.slot=${slot}`]);
  const names = listed.stdout.split('\n').filter(Boolean);
  if (names.length <= SNAPSHOTS_TO_KEEP) return;
  const inspected = await ctx.docker(['volume', 'inspect', '--format', '{{.Name}} {{.CreatedAt}}', ...names]);
  // 다른 샌드박스가 복사 중인 스냅샷은 지워지지 않고 남는다
  for (const name of snapshotsToPrune(inspected.stdout)) await ctx.docker(['volume', 'rm', name]);
}

/** compose는 external 볼륨을 만들어 주지 않으므로 먼저 만든다. 이미 있으면 그대로 둔다 */
export async function ensureSharedVolumesLegacy(dockerBin: string, sharedVolumes: readonly string[]): Promise<void> {
  await Promise.all(sharedVolumes.map((name) => execChecked(dockerBin, ['volume', 'create', '--label', 'b-studio.cache=true', name])));
}

export async function statsLegacy(ctx: LegacySnapshotContext): Promise<ServiceUsage[]> {
  // 끊긴 소켓에 건 호출은 끝나지 않을 수 있다. 몇 초마다 재는 쪽이 앞선 측정을 기다리다 영영 멈추지 않게 상한을 둔다(트러블슈팅 123)
  const signal = AbortSignal.timeout(ctx.statsTimeoutMs);
  const unanswered = `도커가 ${ctx.statsTimeoutMs / 1000}초 안에 응답하지 않았습니다`;
  const listed = await ctx.docker(ctx.composeArgs(['ps', '--all', '--quiet']), signal);
  // 목록을 읽지 못한 것을 "컨테이너 없음"으로 돌려주면 도커에 닿지 않는 것과 컨테이너가 없는 것을 구분할 수 없다
  if (listed.exitCode !== 0) throw new SandboxError(`컨테이너 목록을 읽지 못했습니다 (${ctx.id})`, signal.aborted ? unanswered : ctx.redact(listed.stderr), { platform: true });
  const ids = listed.stdout.split('\n').filter(Boolean);
  if (ids.length === 0) return [];
  const inspected = await ctx.docker(['inspect', ...ids], signal);
  if (inspected.exitCode !== 0) throw new SandboxError(`컨테이너 상태를 읽지 못했습니다 (${ctx.id})`, signal.aborted ? unanswered : inspected.stderr, { platform: true });
  const rows = parseInspectOutput(inspected.stdout);

  // docker stats는 CPU 사용률을 재느라 1초 남짓 걸리므로 실행 중인 컨테이너만 묻는다
  const running = rows.filter((row) => row.state === 'running').map((row) => row.name);
  const stats = running.length > 0 ? await ctx.docker(['stats', '--no-stream', '--format', '{{json .}}', ...running], signal) : undefined;
  if (signal.aborted) throw new SandboxError(`컨테이너 사용량을 읽지 못했습니다 (${ctx.id})`, unanswered, { platform: true });
  const managedNames = new Set(ctx.project.managed.map(([name]) => name));
  return mergeUsage(rows, stats?.exitCode === 0 ? parseStatsOutput(stats.stdout) : [], managedNames);
}
