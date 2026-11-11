import { setTimeout as sleep } from 'node:timers/promises';
import type { LoadedProject } from '@b-studio/spec';
import { SandboxError } from '../errors';
import { native } from '../native';
import type { FileChange, RelayedPath, SyncResult } from '../types';
import { SYNC_SCRIPT } from './format';
import { composeRef, type MaskVolume } from './git-mask';
import { RELAY_SCRIPT } from './relay';
import { nativeUpInput, overrideError, upResultToExec, type UpOptions } from './up-loop';

/**
 * 파일 반영 확인(`sync`)·변경 알림(`relayChanges`)·포트 충돌 재시도(`#composeUpWithPortRetry`)의 TS 껍데기(ADR-195 4f A4c-2).
 * 호스트 해시, docker를 부르는 순서, 반복, 판정은 Rust(crates/bstudio-io/src/{sync_relay,port_retry}.rs, crates/bstudio-guard/src/sync_relay.rs)가 한다.
 * 여기는 결과를 옛 글 그대로의 `SandboxError`로 바꾸기만 한다. 옛 TS는 `sync-relay-legacy.ts`(차등 시험의 기준값).
 */

/** 파일 반영 확인에 쓰는 작은 이미지. 서비스 컨테이너가 죽어 있어도 확인할 수 있도록 별도 컨테이너로 돌린다 */
export const SYNC_HELPER_IMAGE = 'busybox:1.37';
/** 반영을 다시 확인하기 전에 쉬는 시간 */
const SYNC_POLL_MS = 250;
/** compose up 포트 충돌 재시도 한도(최초 시도 포함) */
export const PORT_RETRY_ATTEMPTS = 3;

export interface SyncOptions {
  project: Pick<LoadedProject, 'root' | 'composePath'>;
  dockerBin: string;
  env: NodeJS.ProcessEnv;
  files: string[];
  signal?: AbortSignal | undefined;
  timeoutMs: number;
}

export async function syncFiles({ project, dockerBin, env, files, signal, timeoutMs }: SyncOptions): Promise<SyncResult> {
  if (files.length === 0) return { elapsedMs: 0, checks: 0 };
  // 이미 취소됐으면 아무것도 읽거나 부르지 않는다(Rust 쪽 취소 신호는 등록한 뒤의 취소만 안다)
  signal?.throwIfAborted();
  const result = await native.syncFiles(
    { compose: composeRef(project, { dockerBin, env }), files, timeoutMs, script: SYNC_SCRIPT, image: SYNC_HELPER_IMAGE, pollMs: SYNC_POLL_MS },
    signal ?? null,
  );
  switch (result.kind) {
    case 'done':
      return { elapsedMs: result.elapsedMs, checks: result.checks };
    case 'host-read':
      // 호스트 파일을 읽지 못하면 반영됐는지 알 수 없다. 코드가 원인일 수 있으므로(권한·폴더) 플랫폼 실패로 표시하지 않는다
      throw new SandboxError('샌드박스 파일 반영을 확인하려고 호스트 파일을 읽지 못했습니다', result.message ?? result.file ?? undefined);
    case 'docker':
      throw new SandboxError('샌드박스 파일 반영 확인에 실패했습니다', result.stderr, { platform: true });
    case 'timeout':
      // 반영이 끝나지 않은 것은 호스트와 컨테이너 사이의 파일 공유 문제다. 코드를 고쳐서 풀 수 없다
      throw new SandboxError(result.message ?? '샌드박스에 파일 변경이 반영되지 않았습니다', undefined, { platform: true });
    case 'aborted':
      // 기다리는 중의 취소는 옛 `sleep(250, undefined, { signal })`와 같은 AbortError로 끝난다
      await sleep(0, undefined, { signal });
      break;
    default:
      break;
  }
  // 모르는 결과는 통과가 아니라 실패다
  throw new SandboxError('샌드박스 파일 반영 확인 결과를 알 수 없습니다', String(result.kind), { platform: true });
}

export interface RelayOptions {
  id: string;
  project: LoadedProject;
  dockerBin: string;
  env: NodeJS.ProcessEnv;
  overridePath: string;
  /** `compose config --format json`의 stdout 원문(세션 동안 한 번 읽어 캐시한 것) */
  config: string;
  changes: FileChange[];
  signal?: AbortSignal | undefined;
}

export async function relayThroughContainers({ id, project, dockerBin, env, overridePath, config, changes, signal }: RelayOptions): Promise<RelayedPath[]> {
  const managed = project.managed;
  const result = await native.relayChanges(
    {
      compose: composeRef(project, { dockerBin, env, projectName: id }),
      overridePath,
      cwd: process.cwd(),
      configJson: config,
      managedNames: managed.map(([name]) => name),
      // ADR-088: managed 서비스가 전부 프로젝트 루트를 통째로 마운트하므로, 서비스 폴더(subroot)로 한 번 더 좁힌다
      managedPaths: managed.map(([, spec]) => spec.path),
      changesJson: JSON.stringify(changes.map(({ file, kind }) => ({ file, kind }))),
      script: RELAY_SCRIPT,
    },
    signal ?? null,
  );
  if (result.kind === 'done') return (JSON.parse(result.relayedJson) as Array<[string, string]>).map(([service, file]) => ({ service, file }));
  throw new SandboxError(result.message ?? `compose 설정을 해석하지 못했습니다 (${id})`);
}

export interface PortRetryOptions extends UpOptions {
  /** 포트를 다시 뽑을 대상 서비스(`publicUrlRefs`의 `targetService`, 중복 없이 처음 나온 순서) */
  publicUrlTargets: string[];
  secrets: Record<string, string>;
  /** `compose up`이 비0으로 끝났을 때 옛 글 그대로의 오류를 만든다 */
  upFailure: (result: { exitCode: number; stdout: string; stderr: string }) => Error;
  /** Rust가 다시 뽑은 포트를 돌려줄 때 부른다(다시 뽑은 적이 없으면 부르지 않는다) */
  onHostPorts: (hostPorts: Record<string, number>) => void;
}

/**
 * `compose up`을 돌리되 포트 바인드 충돌이면 미리 고른 포트를 전부 다시 뽑아 override를 다시 쓰고, 일부만 뜬 컨테이너를 지운 뒤 다시 한다.
 * `options.args`는 `up --detach --remove-orphans …` 전체다. 시도마다 Rust의 `up_with_git_mask`를 부르므로 재시도 전체가 한 번의 호출이다
 */
export async function upWithPortRetry(options: PortRetryOptions): Promise<void> {
  const { id, redact, signal } = options;
  signal?.throwIfAborted();
  const entries = Object.entries(options.secrets);
  const result = await native.upWithPortRetry(
    {
      up: nativeUpInput(options),
      publicUrlTargets: options.publicUrlTargets,
      secretNames: entries.map(([name]) => name),
      secretValues: entries.map(([, value]) => value),
      attempts: PORT_RETRY_ATTEMPTS,
    },
    signal ?? null,
  );
  // 마지막으로 쓴 마스크와 배정한 포트는 실패해도 돌려받는다(상태가 파일과 어긋나지 않게)
  options.onMask(JSON.parse(result.up.maskJson) as Record<string, MaskVolume[]>);
  if (result.hostPortsJson) options.onHostPorts(JSON.parse(result.hostPortsJson) as Record<string, number>);
  switch (result.kind) {
    case 'port-alloc':
      throw new Error(result.message ?? '빈 포트를 찾지 못했습니다');
    case 'regenerate':
      throw overrideError(result.up);
    case 'up':
    case 'exhausted': {
      let failure: unknown;
      try {
        const executed = upResultToExec(result.up, id, redact, signal);
        // 성공은 첫 종류(`up`)에서만 나온다. 포기한 결과가 성공으로 읽히면 모르는 결과다
        if (executed.exitCode === 0 && result.kind === 'up') return;
        failure = executed.exitCode === 0 ? new SandboxError(`컨테이너 만들기 결과를 알 수 없어 시작하지 않았습니다 (${id})`, 'exhausted', { platform: true }) : options.upFailure(executed);
      } catch (error) {
        failure = error;
      }
      if (result.kind === 'up') throw failure;
      const message = failure instanceof Error ? failure.message : String(failure);
      throw new SandboxError(`${message}\n포트 충돌이 반복돼 ${PORT_RETRY_ATTEMPTS}회 재시도 후 포기했습니다`, undefined, { platform: true });
    }
    default:
      break;
  }
  throw new SandboxError(`컨테이너 만들기 결과를 알 수 없어 시작하지 않았습니다 (${id})`, String(result.kind), { platform: true });
}
