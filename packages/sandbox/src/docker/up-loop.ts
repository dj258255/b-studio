import type { LoadedProject } from '@b-studio/spec';
import { STUDIO_CALLER } from '@b-studio/spec';
import { nativeProject } from '../edge-config';
import { SandboxError } from '../errors';
import { encodeNative, native, type NativeUpInput, type NativeUpResult } from '../native';
import type { ExecResult } from '../types';
import type { EvaluationAssetCopy } from './evaluation-assets';
import { composeRef, loadProblemError, type MaskVolume } from './git-mask';
import { verifyError } from './verify-containers';

/**
 * 컨테이너 만들기 반복(`up`)과 override 쓰기. 시도마다 compose 파일의 마운트를 읽어 `.git` 마스크를 맞추고, 만들고, 확인하고,
 * 확인한 컨테이너만 시작하는 **반복 전체가 Rust 함수 하나**(crates/bstudio-io/src/up_loop.rs)다. override에 쓴 마스크와 확인한 마스크가
 * 그 함수 안의 같은 값이다. 여기는 결과를 옛 글 그대로의 `SandboxError`로 바꾸기만 한다(ADR-195 4f A4c-1).
 * 옛 TS는 `up-loop-legacy.ts`(차등 시험의 기준값).
 *
 * override는 **JSON**으로 쓴다(YAML 1.2는 JSON을 포함하고 compose가 읽는다). 파일 이름은 `compose.override.yaml` 그대로다
 */

export type OverrideSettings = { edgeScript: string; runtime: string | undefined; hostPorts: Record<string, number> };

/** `buildOverride`의 입력에서 마스크만 뺀 것. 마스크는 Rust가 얹는다 */
export function overrideInputJson(project: LoadedProject, sandboxId: string, { edgeScript, runtime, hostPorts }: OverrideSettings): string {
  return encodeNative({ ...nativeProject(project), sandboxId, edgeScript, runtime, hostPorts }) ?? 'null';
}

function plainAssets(assets: readonly EvaluationAssetCopy[]) {
  return assets.map(({ path: assetPath, source }) => ({ path: assetPath, source }));
}

export function overrideError(result: NativeUpResult): Error {
  // 만들지 못한 것(입력의 모양)은 예전처럼 `buildOverride`가 던지던 오류 그대로
  if (result.kind === 'override-build') return new Error(result.message ?? 'override를 만들지 못했습니다');
  if (result.kind === 'override-write') return new SandboxError('compose override 파일을 쓰지 못했습니다', result.message ?? undefined, { platform: true });
  return new SandboxError('compose override 파일을 쓰지 못했습니다', String(result.kind), { platform: true });
}

/** 마스크를 얹은 override를 임시 파일에 쓰고 rename한다. 쓰지 못하면 던진다(쓰지 못한 마스크로 만들지 않는다) */
export async function writeComposeOverride(overridePath: string, input: string, mask: Readonly<Record<string, readonly MaskVolume[]>>): Promise<void> {
  const result = await native.writeComposeOverride(overridePath, input, JSON.stringify(mask));
  if (result.kind !== 'ok') throw overrideError(result);
}

export interface UpOptions {
  id: string;
  project: Pick<LoadedProject, 'root' | 'composePath'>;
  dockerBin: string;
  env: NodeJS.ProcessEnv;
  overridePath: string;
  overrideInput: string;
  /** 지금 override 파일에 쓰여 있는 마스크 */
  gitMask: Record<string, MaskVolume[]>;
  evaluationAssets: readonly EvaluationAssetCopy[];
  /** `up` 자신과 옵션, 서비스 이름 */
  args: string[];
  sandboxNetwork: string;
  egressNetwork: string;
  edgeService: string;
  serviceLabel: string;
  pollMs: number;
  waitMs: number;
  signal?: AbortSignal;
  redact: (text: string) => string;
  /** Rust가 마지막에 쓴 마스크를 돌려줄 때 부른다(던지기 전에도 부른다) */
  onMask: (mask: Record<string, MaskVolume[]>) => void;
}

/** Rust 함수에 넘길 입력. `upWithGitMask`와 포트 충돌 재시도(`upWithPortRetry`)가 같은 모양을 쓴다 */
export function nativeUpInput(options: UpOptions): NativeUpInput {
  const envVars = composeRef(options.project, { dockerBin: options.dockerBin, env: options.env, projectName: options.id });
  return {
    compose: envVars,
    cwd: process.cwd(),
    overridePath: options.overridePath,
    overrideInputJson: options.overrideInput,
    maskJson: JSON.stringify(options.gitMask),
    assetsJson: JSON.stringify(plainAssets(options.evaluationAssets)),
    args: options.args,
    sandboxNetwork: options.sandboxNetwork,
    egressNetwork: options.egressNetwork,
    edgeService: options.edgeService,
    studioCaller: STUDIO_CALLER,
    serviceLabel: options.serviceLabel,
    pollMs: options.pollMs,
    waitMs: options.waitMs,
  };
}

/** 만들고 확인하고 시작한 결과(또는 compose의 실패 결과). 확인하지 못했거나 위반이 있으면 던진다 */
export async function upWithGitMask(options: UpOptions): Promise<ExecResult> {
  const { id, redact, signal } = options;
  // 이미 취소됐으면 아무것도 부르지 않는다(Rust 쪽 취소 신호는 등록한 뒤의 취소만 안다)
  signal?.throwIfAborted();
  const result = await native.upWithGitMask(nativeUpInput(options), signal ?? null);
  // 쓴 마스크는 실패해도 돌려받는다(상태가 파일과 어긋나지 않게)
  options.onMask(JSON.parse(result.maskJson) as Record<string, MaskVolume[]>);
  return upResultToExec(result, id, redact, signal);
}

/** Rust가 돌려준 결과를 `ExecResult`로(compose의 실패 결과 포함), 확인하지 못했거나 위반이 있으면 옛 글 그대로의 오류로 던진다 */
export function upResultToExec(result: NativeUpResult, id: string, redact: (text: string) => string, signal: AbortSignal | undefined): ExecResult {
  switch (result.kind) {
    case 'done':
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    case 'aborted':
      signal?.throwIfAborted();
      throw new SandboxError(`컨테이너 만들기가 취소됐습니다 (${id})`);
    case 'config-failed':
    case 'config-unparsed':
    case 'mask-error':
      throw loadProblemError(result, redact);
    case 'override-build':
    case 'override-write':
      throw overrideError(result);
    case 'verify':
      if (result.verifyKind == null || result.phase == null) break;
      throw verifyError({ kind: result.verifyKind, stderr: result.stderr, detail: result.detail, removalFailed: result.removalFailed }, id, result.phase, redact);
    case 'missing':
      throw new SandboxError(`만든 컨테이너를 찾지 못해 시작하지 않았습니다 (${id})`, result.missing.join(', '), { platform: true });
    case 'deps-failed':
      throw new SandboxError('compose 설정을 읽지 못해 서비스를 시작할 순서를 정할 수 없습니다', redact(result.stderr.trim() ? result.stderr : 'docker 실행 실패'), { platform: true });
    case 'deps-unparsed':
      throw new SandboxError('compose 설정(config --format json)을 해석하지 못해 서비스를 시작할 순서를 정할 수 없습니다', undefined, { platform: true });
    case 'not-stable':
      throw new SandboxError(`compose 파일이 계속 바뀌어 .git 보호를 확정하지 못했습니다. 서비스를 내렸습니다 (${id})`);
    default:
      break;
  }
  // 모르는 결과는 통과가 아니라 실패다
  throw new SandboxError(`컨테이너 만들기 결과를 알 수 없어 시작하지 않았습니다 (${id})`, String(result.kind), { platform: true });
}
