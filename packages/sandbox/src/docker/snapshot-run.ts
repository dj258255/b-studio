import type { LoadedProject } from '@b-studio/spec';
import { EDGE_SERVICE } from '../edge-config';
import { SandboxError } from '../errors';
import { ExecCheckedError } from '../exec-checked';
import { decodeNative, native } from '../native';
import type { NativeSnapshotPlan, NativeSnapshotScope } from '../native';
import type { ServiceUsage, SnapshotEvent, StartOptions } from '../types';
import { composeRef } from './git-mask';
import { SYNC_HELPER_IMAGE } from './sync-relay';

/**
 * 의존성 스냅샷(`#planSnapshots`·`#seedSnapshot`·`#captureSnapshot`·`#pruneSnapshots`)·공유 볼륨(`#ensureSharedVolumes`)·`stats()`의 TS 껍데기(ADR-195 4f A4c-3b).
 * 키 파일 읽기, docker를 부르는 순서, 지우는 대상 고르기, 사용량 읽기는 Rust(crates/bstudio-io/src/snapshot_io.rs)가 한다.
 * 여기는 이벤트(`onSnapshot`)를 알리고 결과를 옛 글 그대로의 오류로 바꾸기만 한다. 옛 TS는 `snapshot-legacy.ts`(차등 시험의 기준값).
 *
 * **Rust는 `up`을 부르지 않는다.** 스냅샷 채우기는 `build`와 동시에, 저장은 서비스가 준비된 뒤에 도는데, 그 앞뒤의 `up`은 `#composeOrThrow` → `#upQueue`·`#gitMask`를 지난다
 * (순서 조율은 `LocalDockerSandbox.start()`에 남는다).
 *
 * **`capturing`은 여기(TS)에 둔다.** 같은 스냅샷을 프로세스 안에서 두 번 저장하지 않는 집합인데, 보호 범위가 "저장 → `captured` 이벤트 → 정리" 전체다.
 * 이벤트가 TS 콜백이라 저장과 정리 사이에 JS로 돌아와야 하고, 그래서 저장과 정리를 Rust 함수 둘로 나눴다. 집합은 그 둘을 감싸는 이 함수에 있는 것이 옛 모양 그대로다.
 * 클래스 전체를 Rust로 옮기는 C1에서 같이 옮긴다.
 */

export interface SnapshotContext {
  id: string;
  project: Pick<LoadedProject, 'root' | 'composePath' | 'managed' | 'spec' | 'sharedVolumes'>;
  dockerBin: string;
  env: NodeJS.ProcessEnv;
}

export interface StatsContext extends SnapshotContext {
  overridePath: string;
}

export interface SnapshotPlan {
  service: string;
  volume: string;
  snapshot: string;
  slot: string;
  /** compose가 이 샌드박스에 만들 볼륨 이름 */
  sandboxVolume: string;
}

/** 같은 스튜디오 서버에서 두 세션이 같은 스냅샷을 동시에 만들지 않게 한다 */
const capturing = new Set<string>();

const scopeOf = (ctx: SnapshotContext): NativeSnapshotScope => ({ projectName: ctx.project.spec.name, sandboxId: ctx.id });
const composeOf = (ctx: SnapshotContext) => composeRef(ctx.project, { dockerBin: ctx.dockerBin, env: ctx.env, projectName: ctx.id });
const planOf = (plan: SnapshotPlan): NativeSnapshotPlan => ({ service: plan.service, volume: plan.volume, snapshot: plan.snapshot, slot: plan.slot, sandboxVolume: plan.sandboxVolume });

/** 스냅샷을 정한 서비스의 키 파일을 호스트에서 읽어 스냅샷 이름을 만든다. docker를 부르지 않는다 */
export async function planSnapshots(ctx: SnapshotContext): Promise<SnapshotPlan[]> {
  const volumes = ctx.project.managed.flatMap(([service, spec]) => (spec.snapshots ?? []).map(({ volume, key }) => ({ service, volume, specPath: spec.path, key: [...key] })));
  return native.planSnapshots(scopeOf(ctx), ctx.project.root, volumes);
}

/** 스냅샷이 있으면 이 샌드박스의 볼륨을 미리 만들어 채운다. 실패하면 빈 볼륨으로 평소처럼 설치한다(`false`) */
export async function seedSnapshot(ctx: SnapshotContext, plan: SnapshotPlan, { signal, onSnapshot }: Pick<StartOptions, 'signal' | 'onSnapshot'>): Promise<boolean> {
  const event = { service: plan.service, volume: plan.volume, snapshot: plan.snapshot };
  const failed = (reason: string): false => {
    onSnapshot?.({ ...event, action: 'failed', stage: 'seed', reason });
    return false;
  };
  let result;
  try {
    result = await native.seedSnapshot(composeOf(ctx), scopeOf(ctx), planOf(plan), SYNC_HELPER_IMAGE, signal ?? null);
  } catch (error) {
    // 스냅샷을 못 쓰는 것은 기동 실패가 아니다(옛 TS의 docker 호출은 던지지 않았다)
    return failed(error instanceof Error ? error.message : String(error));
  }
  switch (result.kind) {
    case 'missing':
      onSnapshot?.({ ...event, action: 'missing' });
      return false;
    case 'seeded':
      onSnapshot?.({ ...event, action: 'seeded', elapsedMs: result.elapsedMs });
      return true;
    case 'failed':
      return failed(result.reason ?? '');
    default:
      // 모르는 결과는 "채웠다"가 아니다
      return failed(`스냅샷 채우기 결과를 알 수 없습니다: ${String((result as { kind: unknown }).kind)}`);
  }
}

/** 설치 단계만 끝난 볼륨을 스냅샷으로 남기고, 같은 자리의 오래된 스냅샷을 정리한다. 실패해도 기동은 계속된다(`failed` 이벤트) */
export async function captureSnapshot(ctx: SnapshotContext, plan: SnapshotPlan, { onSnapshot }: Pick<StartOptions, 'onSnapshot'>): Promise<void> {
  if (capturing.has(plan.snapshot)) return;
  capturing.add(plan.snapshot);
  const event = { service: plan.service, volume: plan.volume, snapshot: plan.snapshot };
  try {
    const result = await native.captureSnapshot(composeOf(ctx), scopeOf(ctx), planOf(plan), SYNC_HELPER_IMAGE);
    switch (result.kind) {
      case 'existing':
        // 그사이 다른 세션이 만들었으면 그것을 쓴다
        return;
      case 'captured':
        onSnapshot?.({ ...event, action: 'captured', elapsedMs: result.elapsedMs });
        await pruneSnapshots(ctx, plan);
        return;
      case 'failed':
        throw new SandboxError(result.message ?? '스냅샷을 저장하지 못했습니다', result.detail ?? undefined);
      default:
        throw new SandboxError(`스냅샷 저장 결과를 알 수 없습니다: ${String((result as { kind: unknown }).kind)}`);
    }
  } catch (error) {
    const reason = error instanceof SandboxError && error.detail ? `${error.message}: ${error.detail.trim()}` : String(error);
    onSnapshot?.({ ...event, action: 'failed', stage: 'capture', reason } as SnapshotEvent);
  } finally {
    capturing.delete(plan.snapshot);
  }
}

/** lockfile이 바뀔 때마다 스냅샷이 쌓이므로 같은 자리에서는 최근 것만 남긴다. 지울 이름은 Rust가 라벨 필터 결과에서만 고른다 */
export async function pruneSnapshots(ctx: SnapshotContext, plan: SnapshotPlan): Promise<void> {
  // 만든 시각은 옛 TS와 같은 해석(`Date.parse`)으로 읽는다. 읽을 수 없으면 null이고, 읽는 것 자체가 실패하면 Rust가 지우지 않는다
  const parseDates = (texts: string): string => JSON.stringify((JSON.parse(texts) as string[]).map((text) => {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : ms;
  }));
  await native.pruneSnapshots(composeOf(ctx), scopeOf(ctx), planOf(plan), parseDates);
}

/** compose는 external 볼륨을 만들어 주지 않으므로 먼저 만든다. 이미 있으면 그대로 둔다. 실패하면 옛 `execChecked`처럼 던진다 */
export async function ensureSharedVolumes(dockerBin: string, names: readonly string[]): Promise<void> {
  const result = await native.ensureSharedVolumes(dockerBin, [...names]);
  if (!result.failed) return;
  if (result.code === null || result.code === undefined) {
    throw new ExecCheckedError(`maxBuffer length exceeded: ${result.command}`, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', result.stdout, result.stderr);
  }
  throw new ExecCheckedError(`Command failed: ${result.command}\n${result.stderr}`, result.code, result.stdout, result.stderr);
}

/**
 * `compose ps` → `inspect` → 실행 중인 것만 `stats --no-stream`을 상한 시간 안에 읽는다(트러블슈팅 123). 목록·inspect를 읽지 못하면 "컨테이너 없음"이 아니라 오류다.
 * 시크릿은 `redact`로 가린다(옛 TS는 목록 오류만 가렸다. inspect 오류도 가린다)
 */
export async function readStats(ctx: StatsContext, { statsTimeoutMs, redact }: { statsTimeoutMs: number; redact: (text: string) => string }): Promise<ServiceUsage[]> {
  const result = await native.readStats({
    compose: composeOf(ctx),
    overridePath: ctx.overridePath,
    managed: ctx.project.managed.map(([name]) => name),
    edgeService: EDGE_SERVICE,
    timeoutMs: statsTimeoutMs,
  });
  const unanswered = `도커가 ${statsTimeoutMs / 1000}초 안에 응답하지 않았습니다`;
  switch (result.kind) {
    case 'done':
      return decodeNative<ServiceUsage[]>(result.json);
    case 'list-failed':
      // 목록을 읽지 못한 것을 "컨테이너 없음"으로 돌려주면 도커에 닿지 않는 것과 컨테이너가 없는 것을 구분할 수 없다
      throw new SandboxError(`컨테이너 목록을 읽지 못했습니다 (${ctx.id})`, result.timedOut ? unanswered : redact(result.stderr), { platform: true });
    case 'inspect-failed':
      throw new SandboxError(`컨테이너 상태를 읽지 못했습니다 (${ctx.id})`, result.timedOut ? unanswered : redact(result.stderr), { platform: true });
    case 'timed-out':
      throw new SandboxError(`컨테이너 사용량을 읽지 못했습니다 (${ctx.id})`, unanswered, { platform: true });
    case 'parse':
      throw new Error(result.message ?? '컨테이너 출력을 읽지 못했습니다');
    default:
      throw new SandboxError(`컨테이너 사용량을 읽지 못했습니다 (${ctx.id})`, `결과를 알 수 없습니다: ${String((result as { kind: unknown }).kind)}`, { platform: true });
  }
}
