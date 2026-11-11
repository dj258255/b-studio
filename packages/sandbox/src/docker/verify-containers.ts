import { STUDIO_CALLER } from '@b-studio/spec';
import { SandboxError } from '../errors';
import { encodeNative, native, type NativeVerifyResult } from '../native';
import { definedEnv } from '../stream-exec';
import type { ExecResult } from '../types';
import type { DependsOn } from './compose-deps';
import type { EvaluationAssetCopy } from './evaluation-assets';
import type { MaskVolume } from './git-mask';

/**
 * 만든 컨테이너를 시작하기 전에 확인하고(`verifyContainers`), 확인한 컨테이너만 시작한다(`startVerifiedContainers`).
 * docker를 부르는 순서·판정·위반 컨테이너 지우기는 **모두 Rust 함수 하나**(crates/bstudio-io/src/container_verify.rs)가 한다.
 * 확인한 id 목록과 지우는 id 목록이 그 함수 안의 같은 값이고, 위반이 있으면 확인 결과를 돌려주지 않는다.
 * 여기는 그 결과를 `SandboxError`로 바꾸기만 한다(ADR-195 4f A4b). 옛 TS는 `verify-containers-legacy.ts`.
 *
 * 오류의 구분: 정책 위반은 플랫폼 실패가 아니다(에이전트가 고칠 compose 문제). 가림 빠짐과 확인하지 못한 경우는 `platform: true`.
 * 지우지 못했으면 그 사실을 글에 적는다
 */

/** napi의 선택 필드는 `null`이 아니라 빠진 값(undefined)만 받는다 */
export function envVarsOf(env: NodeJS.ProcessEnv): { envVars?: Record<string, string> } {
  const defined = definedEnv(env);
  return defined === undefined ? {} : { envVars: defined };
}

export interface VerifiedContainer {
  id: string;
  service: string | undefined;
}

export interface VerifyOptions {
  /** 샌드박스 id(compose 프로젝트 이름) */
  id: string;
  dockerBin: string;
  env: NodeJS.ProcessEnv;
  /** `compose ps --all --quiet --no-trunc`의 전체 인자(`docker` 뒤) */
  listArgs: string[];
  projectRoot: string;
  gitMask: Record<string, MaskVolume[]>;
  evaluationAssets: readonly EvaluationAssetCopy[];
  sandboxNetwork: string;
  egressNetwork: string;
  edgeService: string;
  /** compose가 컨테이너에 붙이는 서비스 이름 라벨 */
  serviceLabel: string;
  phase: 'created' | 'started';
  /** docker의 stderr에서 시크릿을 가린다 */
  redact: (text: string) => string;
}

/** 확인한 컨테이너(id와 서비스 이름)를 돌려준다. 확인하지 못했거나 위반이 있으면 던진다(위반 컨테이너는 이미 지웠다) */
export async function verifyContainers(options: VerifyOptions): Promise<VerifiedContainer[]> {
  const { id, redact } = options;
  const result = await native.verifyContainers({
    dockerBin: options.dockerBin,
    ...envVarsOf(options.env),
    listArgs: options.listArgs,
    projectRoot: options.projectRoot,
    cwd: process.cwd(),
    projectName: id,
    sandboxNetwork: options.sandboxNetwork,
    egressNetwork: options.egressNetwork,
    edgeService: options.edgeService,
    studioCaller: STUDIO_CALLER,
    serviceLabel: options.serviceLabel,
    gitMaskJson: JSON.stringify(options.gitMask),
    assetsJson: JSON.stringify(options.evaluationAssets.map(({ path: assetPath, source }) => ({ path: assetPath, source }))),
  });
  if (result.kind === 'verified') return result.containers.map((container) => ({ id: container.id, service: container.service ?? undefined }));
  throw verifyError(result, id, options.phase, redact);
}

/** 확인 실패 결과를 옛 글 그대로의 `SandboxError`로 바꾼다(만들기 반복도 쓴다, ADR-195 4f A4c-1) */
export function verifyError(result: Pick<NativeVerifyResult, 'kind' | 'stderr' | 'detail' | 'removalFailed'>, id: string, phase: 'created' | 'started', redact: (text: string) => string): SandboxError {
  const stderr = redact(result.stderr ?? '');
  const detail = result.detail ?? undefined;
  switch (result.kind) {
    case 'list-failed':
      return new SandboxError(`컨테이너 목록을 확인하지 못했습니다 (${id})`, stderr, { platform: true });
    case 'no-containers':
      return new SandboxError(`컨테이너가 보이지 않아 .git 보호를 확인하지 못했습니다 (${id})`, undefined, { platform: true });
    case 'inspect-failed':
      return new SandboxError(`컨테이너 마운트를 확인하지 못했습니다 (${id})`, stderr, { platform: true });
    case 'inspect-unparsed':
      return new SandboxError(`컨테이너 마운트(docker inspect)를 해석하지 못했습니다 (${id})`, undefined, { platform: true });
    case 'inspect-partial':
      return new SandboxError(`컨테이너 마운트를 일부만 확인했습니다 (${id})`, undefined, { platform: true });
    case 'volume-failed':
      return new SandboxError(`볼륨 정보를 확인하지 못했습니다 (${id})`, stderr, { platform: true });
    case 'volume-unparsed':
      return new SandboxError(`볼륨 정보(docker volume inspect)를 해석하지 못했습니다 (${id})`, undefined, { platform: true });
    case 'volume-partial':
      return new SandboxError(`볼륨 정보를 일부만 확인했습니다 (${id})`, detail, { platform: true });
    case 'policy': {
      // 에이전트가 고친 compose 파일이 원인이므로 플랫폼 실패로 표시하지 않는다. 에이전트가 사유를 읽고 compose를 되돌릴 수 있다
      const left = result.removalFailed ? REMOVAL_FAILED : '';
      return new SandboxError(
        phase === 'created' ? `컨테이너에 샌드박스 격리를 벗어나는 설정이 있어 시작하지 않았습니다 (${id})${left}` : `컨테이너에 샌드박스 격리를 벗어나는 설정이 있어 내렸습니다 (${id})${left}`,
        detail,
      );
    }
    case 'mask': {
      const left = result.removalFailed ? REMOVAL_FAILED : '';
      return new SandboxError(
        phase === 'created' ? `컨테이너에 .git 읽기 전용 마운트가 빠져 시작하지 않았습니다 (${id})${left}` : `컨테이너에 .git 읽기 전용 마운트가 빠져 내렸습니다 (${id})${left}`,
        detail,
        { platform: true },
      );
    }
    default:
      // 모르는 결과는 통과가 아니라 실패다
      return new SandboxError(`컨테이너 확인 결과를 알 수 없어 시작하지 않았습니다 (${id})`, String(result.kind), { platform: true });
  }
}

const REMOVAL_FAILED = ' 그 컨테이너를 지우지 못했습니다 — 아직 돌고 있을 수 있습니다';

export interface StartOptions {
  id: string;
  dockerBin: string;
  env: NodeJS.ProcessEnv;
  verified: readonly VerifiedContainer[];
  services: readonly string[];
  /** 서비스가 둘 이상일 때만 읽는다 */
  dependsOn: DependsOn | undefined;
  pollMs: number;
  waitMs: number;
  signal?: AbortSignal;
}

/**
 * 확인한 컨테이너를 id로 시작한다. 서비스가 여럿이면 `up --no-deps a b`가 하던 대로 목록 안의 의존 순서를 지키고
 * `service_healthy`·`service_completed_successfully`는 그 상태가 될 때까지 기다린다. 실패는 compose의 실패처럼 종료 코드와 stderr로 돌려준다.
 * 확인한 목록에 없는 서비스가 있으면 아무것도 시작하지 않고 던진다. 기다리는 중에 취소되면 취소를 그대로 던진다
 */
export async function startVerifiedContainers(options: StartOptions): Promise<ExecResult> {
  const result = await native.startVerifiedContainers(
    {
      dockerBin: options.dockerBin,
      ...envVarsOf(options.env),
      verified: options.verified.map((container) => ({ id: container.id, ...(container.service === undefined ? {} : { service: container.service }) })),
      services: [...options.services],
      ...(options.dependsOn === undefined ? {} : { dependsOnJson: encodeNative(options.dependsOn) }),
      pollMs: options.pollMs,
      waitMs: options.waitMs,
    },
    options.signal ?? null,
  );
  if (result.missing.length > 0) {
    throw new SandboxError(`만든 컨테이너를 찾지 못해 시작하지 않았습니다 (${options.id})`, result.missing.join(', '), { platform: true });
  }
  if (result.aborted) options.signal?.throwIfAborted();
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}
