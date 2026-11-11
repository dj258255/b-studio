import type { LoadedProject } from '@b-studio/spec';
import { SandboxError } from '../errors';
import type { EvaluationAssetCopy } from './evaluation-assets';
import type { BindMount } from './relay';
import { native, type NativeComposeRef, type NativeGitEntry, type NativeUpResult } from '../native';
import { definedEnv } from '../stream-exec';

/**
 * 서비스 컨테이너가 프로젝트 폴더의 `.git`을 쓰지 못하게 하는 마운트 계획(ADR-158).
 *
 * 작업 복사본 전체가 서비스 컨테이너에 읽기·쓰기로 마운트되면 컨테이너 안 명령이 `.git`을 고칠 수 있다. `.git`에는
 * 체크포인트 저장소(근거 판정이 믿는 기준)와 b-studio의 상태 폴더(`.git/b-studio`: 세션 기록, 테스트 근거, 미리보기 토큰)가 있어
 * 에이전트가 근거를 위조할 수 있었다. 서비스가 프로젝트를 마운트한 자리마다 더 구체적인 경로의 마운트를 겹쳐 막는다
 * (Docker는 더 깊은 경로의 마운트를 위에 얹는다)
 *  - `.git` 자체: 읽기 전용. 빌드가 git 정보를 읽는 경우는 그대로 된다
 *  - `.git/b-studio`: 빈 폴더를 읽기 전용으로 얹는다. 읽지도 못한다
 */

/** 프로젝트 폴더나 그 상위 폴더에서 찾은 `.git` 하나 */
export interface GitEntry {
  /** `.git`이 든 폴더(호스트 절대 경로) */
  dir: string;
  /** `.git`이 폴더인지, 파일(worktree·submodule의 gitdir 포인터)인지 */
  kind: 'directory' | 'file';
  /** `.git/b-studio`(b-studio의 상태 폴더)가 있는지 */
  hasState: boolean;
  /**
   * `.git`이 파일일 때 호스트가 같은 파일로 읽는 대소문자 변형 이름(`.GIT` 등, #1028). 대소문자를 구분하지 않는 볼륨을 마운트하면
   * 컨테이너는 이 이름들로 같은 호스트 파일에 닿으므로 같은 가림을 얹는다. 대소문자를 구분하는 파일 시스템에서는 비어 있다
   */
  aliases?: readonly string[];
}

/** compose의 긴 문법 마운트 한 개(읽기 전용 bind). override의 services.<이름>.volumes에 그대로 적는다 */
export interface MaskVolume {
  type: 'bind';
  source: string;
  target: string;
  read_only: true;
  bind: { create_host_path: false };
}

const GIT = '.git';
const STATE = 'b-studio';
/** 상태 폴더 자리에 읽기 전용으로 얹을 빈 폴더(`.git` 안). tmpfs는 `volumes_from`으로 물려받는 서비스의 생성을 깨뜨려 쓰지 않는다(ADR-158) */
const STATE_MASK = 'b-studio-empty';

/**
 * 판정을 순수 함수로 둔 계획. 서비스 이름 → 그 서비스에 덧붙일 마운트.
 *  - 서비스가 `.git`이 든 폴더(또는 그 상위)를 마운트하면 그 안의 `.git`을 읽기 전용으로, 상태 폴더는 빈 폴더(읽기 전용)로 덮는다
 *  - 서비스가 `.git` 안쪽(`.git`, `.git/b-studio`, 그 하위)을 직접 마운트하면 같은 자리에서 읽기 전용(상태 폴더는 빈 폴더)로 바꾼다
 *  - 서비스가 프로젝트의 하위 폴더만 마운트해 `.git`이 보이지 않으면 아무것도 하지 않는다
 *  - `.git`이 없으면 아무것도 하지 않는다
 * 마운트의 source·target은 `docker compose config --format json`이 정규화한 값(절대 경로)이다
 */
export function planGitMask(mounts: readonly Pick<BindMount, 'service' | 'source' | 'target'>[], entries: readonly GitEntry[]): Record<string, MaskVolume[]> {
  // 판정은 Rust(crates/bstudio-guard/src/git_mask.rs)가 한다. 경로 규칙은 Node path.posix와 같다
  const plain = mounts.map(({ service, source, target }) => ({ service, source, target }));
  return JSON.parse(native.planGitMask(JSON.stringify(plain), JSON.stringify(entries), process.cwd())) as Record<string, MaskVolume[]>;
}

/**
 * 선언된 평가 자산을 서비스 컨테이너에 읽기 전용으로 덧붙이는 마운트 계획(ADR-175 후속, #745).
 *
 * 평가 자산은 사람이 고치는 파일·폴더다. 작업 복사본이 서비스에 쓰기 가능하게 마운트되어 있으면 컨테이너 안 명령이 테스트 중에
 * 자산을 바꿀 수 있었다(게이트의 지문 견줌은 검사 앞뒤만 본다). `.git`과 같은 방식으로 더 구체적인 경로에 읽기 전용 마운트를 겹친다.
 *  - 마운트 소스가 자산을 품으면 그 자산만 읽기 전용으로 덧붙인다
 *  - 마운트 소스가 자산 안쪽(자산 폴더나 그 하위)이면 같은 자리의 마운트를 읽기 전용으로 바꿔 쓴다
 *  - 자산과 무관한 마운트는 건드리지 않는다
 * **원본은 작업 복사본이 아니라 b-studio가 가진 복사본이다.** 작업 복사본의 경로를 붙이면 도커가 그 원본이 링크일 때 링크를
 * 따라가고(서비스 재시작 때도 다시 따라간다), 마스크를 계산할 때 걸러도 막을 수 없다. 복사본은 b-studio만 쓰고, 같은 inode를
 * 유지한 채 안을 바꾸므로 파일 하나를 붙여도 컨테이너가 옛 판을 붙잡지 않는다(evaluation-assets.ts)
 * 마운트의 source·target은 `docker compose config --format json`이 정규화한 값(절대 경로)이다
 */
export function planEvaluationAssetMask(
  mounts: readonly Pick<BindMount, 'service' | 'source' | 'target'>[],
  projectRoot: string,
  assets: readonly EvaluationAssetCopy[],
): Record<string, MaskVolume[]> {
  return JSON.parse(native.planEvaluationAssetMask(JSON.stringify(plainMounts(mounts)), projectRoot, JSON.stringify(plainAssets(assets)), process.cwd())) as Record<string, MaskVolume[]>;
}

function plainMounts(mounts: readonly Pick<BindMount, 'service' | 'source' | 'target'>[]) {
  return mounts.map(({ service, source, target }) => ({ service, source, target }));
}

function plainAssets(assets: readonly EvaluationAssetCopy[]) {
  return assets.map(({ path: assetPath, source }) => ({ path: assetPath, source }));
}

/**
 * 프로젝트 폴더에서 위로 올라가며 `.git`이 든 폴더를 찾는다. 프로젝트 폴더의 상위를 마운트한 서비스가 있으면(모노레포 저장소 루트를
 * 마운트) 가장 위의 그 마운트 소스까지, 없으면 프로젝트 폴더 자신만 본다. 경로는 심볼릭 링크를 풀어 비교한다(macOS의 /tmp → /private/tmp)
 */
export async function detectGitEntries(projectRoot: string, mountSources: readonly string[]): Promise<NativeGitEntry[]> {
  // 링크 풀기·lstat·위로 올라가기는 Rust(bstudio-io::git_mask_fs)가 한다(2c-6)
  return native.detectGitEntries(projectRoot, [...mountSources], process.cwd());
}

/** `docker compose config --format json` 중 마운트를 읽는 데 쓰는 부분 */
export interface ComposeMountConfig {
  services: Record<string, { volumes?: Array<{ type: string; source?: string; target: string }>; tmpfs?: string | string[]; volumes_from?: string[] }>;
  volumes?: Record<string, { driver?: string; driver_opts?: Record<string, string>; external?: unknown } | null>;
}


/** 이름 있는 볼륨이 로컬 드라이버로 호스트 폴더에 묶인 꼴(`driver_opts: { type: none, o: bind, device: <경로> }`)이면 그 호스트 경로 */
export function boundDevice(volume: { driver?: string; driver_opts?: Record<string, string> } | null | undefined): string | undefined {
  return asSandboxError(() => native.boundDevice(JSON.stringify(volume ?? null))) ?? undefined;
}

/** Rust 판정이 compose 설정의 모양을 알아보지 못해 던지면 샌드박스 오류로 바꾼다(보호를 정할 수 없으니 멈춘다) */
function asSandboxError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new SandboxError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 서비스가 호스트 폴더를 붙이는 모든 꼴을 모은다: bind 마운트, 호스트 폴더에 묶은 이름 있는 볼륨, `volumes_from`으로 물려받은 마운트(전이적, 순환은 끊는다).
 * `volumes_from`이 compose 밖 컨테이너(`container:<이름>`)를 가리키면 무엇이 붙는지 알 수 없으므로 던진다
 */
export function collectHostMounts(config: ComposeMountConfig): Array<Pick<BindMount, 'service' | 'source' | 'target'>> {
  return JSON.parse(asSandboxError(() => native.collectHostMounts(JSON.stringify(config), process.cwd()))) as Array<Pick<BindMount, 'service' | 'source' | 'target'>>;
}

/**
 * `docker compose config --format json` 결과에서 서비스별 마스크 마운트를 계산한다.
 * 마운트 소스는 심볼릭 링크를 풀어 `.git` 위치와 같은 꼴로 맞춘다.
 * `evaluationAssets`를 주면 git 마스크와 평가 자산 마스크를 한 맵으로 합친다. 같은 target이면 git 쪽 규칙이 이긴다(더 막는 쪽).
 * 계산은 Rust(crates/bstudio-io/src/up_loop.rs)가 한다(ADR-195 4f A4c-1). 옛 TS는 `git-mask-legacy.ts`.
 * 실험 경로인 컨테이너 방식 터미널(`agent-terminal.ts`)이 쓴다
 */
export async function computeGitMask(
  projectRoot: string,
  config: ComposeMountConfig,
  { evaluationAssets = [] }: { evaluationAssets?: readonly EvaluationAssetCopy[] } = {},
): Promise<Record<string, MaskVolume[]>> {
  const result = await native.computeGitMask(projectRoot, JSON.stringify(config), JSON.stringify(plainAssets(evaluationAssets)), process.cwd());
  return maskOrThrow(result, (text) => text);
}

/** Rust 결과를 마스크로 바꾸거나, 실패를 옛 글 그대로의 `SandboxError`로 바꾼다 */
export function maskOrThrow(result: NativeUpResult, redact: (text: string) => string): Record<string, MaskVolume[]> {
  if (result.kind === 'ok') return JSON.parse(result.maskJson) as Record<string, MaskVolume[]>;
  throw loadProblemError(result, redact);
}

/** `compose config`를 읽거나 마스크를 계산하지 못한 결과를 `SandboxError`로 바꾼다. 모르는 결과도 실패다 */
export function loadProblemError(result: NativeUpResult, redact: (text: string) => string): SandboxError {
  switch (result.kind) {
    case 'config-failed':
      return new SandboxError('compose 설정을 읽지 못해 서비스 컨테이너의 .git 보호를 정할 수 없습니다', redact(result.stderr.trim() ? result.stderr : 'docker 실행 실패'));
    case 'config-unparsed':
      return new SandboxError('compose 설정(config --format json)을 해석하지 못해 서비스 컨테이너의 .git 보호를 정할 수 없습니다');
    case 'mask-error':
      return new SandboxError(result.message ?? '.git 보호를 정하지 못했습니다', result.detail ?? undefined, result.platform ? { platform: true } : {});
    default:
      return new SandboxError('서비스 컨테이너의 .git 보호를 정하지 못했습니다', String(result.kind), { platform: true });
  }
}

/**
 * 합친 마스크에서 평가 자산 볼륨만 고른다. 평가 자산 자리의 사후 확인은 **계획**(override에 적은 target·원본)을 기대해야 한다 —
 * 컨테이너의 실제 마운트에서 거꾸로 계산하면, 프로젝트 마운트의 원본을 알아보지 못할 때(Docker Desktop이 `/host_mnt/…`로 알려 주는 등)
 * 기대 목록이 비어 확인이 통과한다(커밋 보안 검토). 볼륨의 원본이 b-studio 복사본(또는 그 안쪽)인 것으로 알아본다
 */
export async function selectEvaluationAssetVolumes(volumes: readonly MaskVolume[], assets: readonly EvaluationAssetCopy[]): Promise<MaskVolume[]> {
  // 링크를 풀어 견주는 일은 Rust(crates/bstudio-io/src/container_verify.rs)가 한다(ADR-195 4f A4b)
  return JSON.parse(await native.selectEvaluationAssetVolumes(JSON.stringify(volumes), JSON.stringify(plainAssets(assets)), process.cwd())) as MaskVolume[];
}

/** `docker inspect`의 Mounts 한 항목 */
export interface InspectedMount {
  Type: string;
  Name?: string;
  Source?: string;
  Destination: string;
  RW?: boolean;
}

export interface MissingMaskOptions {
  /** 샌드박스가 계획한 평가 자산 볼륨(서비스 이름 → target·원본). 실제 마운트에서 거꾸로 계산하지 않는다 */
  evaluationAssetPlan?: Readonly<Record<string, readonly MaskVolume[]>>;
  /** 이 컨테이너의 compose 서비스 이름. 계획에서 그 서비스의 평가 자산 자리를 찾는다 */
  service?: string;
  /** `docker inspect`의 `HostConfig.Tmpfs`(컨테이너 안 경로 → 옵션). tmpfs는 `Mounts`에 나오지 않는다 */
  tmpfs?: Readonly<Record<string, string>>;
}

/**
 * 사후 확인(설정이 아니라 결과를 본다): 실행 중인 컨테이너의 실제 마운트에서 `.git`이 든 호스트 폴더를 덮는 마운트가 있는데
 * 그 안의 `.git` 자리에 읽기 전용 마운트(상태 폴더는 빈 폴더)가 없으면 빠진 자리(컨테이너 안 경로)를 돌려준다.
 * 평가 자산 자리는 **계획**(`evaluationAssetPlan`의 target·원본)을 기대한다 — 실제 마운트에서 계산하면 프로젝트 마운트의 원본을
 * 알아보지 못할 때 기대 목록이 비어 통과한다. 계획에 있는 자리마다 모두 본다: 마운트가 하나뿐, 읽기 전용, 원본이 계획한 복사본,
 * 그 자리 안쪽에 다른 `Mounts` 항목이 없음, `HostConfig.Tmpfs`가 그 자리를 덮지 않음
 * 이름 있는 볼륨은 `volumeOptions`(볼륨 이름 → 로컬 드라이버 옵션)로 호스트 폴더에 묶였는지 본다.
 * 판정과 링크 풀기는 Rust(crates/bstudio-io/src/container_verify.rs)가 한다. 마운트·볼륨 옵션의 모양을 몰라 확인하지 못하면 던진다
 * (`LocalDockerProvider`의 컨테이너 확인은 Rust가 통째로 하며 이 함수를 거치지 않는다. 실험 경로인 컨테이너 방식 터미널이 쓴다)
 */
export async function findMissingMasks(
  projectRoot: string,
  mounts: readonly InspectedMount[],
  volumeOptions: Readonly<Record<string, { driver?: string; driver_opts?: Record<string, string> } | undefined>>,
  { evaluationAssetPlan = {}, service, tmpfs = {} }: MissingMaskOptions = {},
): Promise<string[]> {
  const planned = service === undefined ? [] : (evaluationAssetPlan[service] ?? []);
  try {
    return await native.findMissingMasks(projectRoot, JSON.stringify(mounts), JSON.stringify(volumeOptions), JSON.stringify(planned), Object.keys(tmpfs), process.cwd());
  } catch (error) {
    throw new SandboxError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 사용자의 compose 파일이 정규화된 마운트(`docker compose config --format json`: 짧은 문법·상대 경로·변수 치환을 compose가 푼 결과)를
 * 읽어, 프로젝트 폴더를 마운트한 서비스마다 `.git`을 막는 마운트를 계산한다. 마운트를 읽지 못하면 막을 자리를 알 수 없으므로
 * 보호 없이 띄우지 않고 멈춘다 — 같은 compose 파일을 읽지 못하면 `up`도 어차피 실패한다.
 * `up`을 부르는 `#composeArgs`와 같은 파일·프로젝트 이름·프로젝트 폴더·환경으로 읽는다(프로필만 모두 켠다).
 * `evaluationAssets`(복사본 자리)를 주면 그 마스크도 함께 계산한다.
 * 오류에는 명령줄을 담지 않고 stderr만 `redact`로 가려 담는다(compose의 오류에 치환된 시크릿 값이 섞일 수 있다)
 */
export async function loadGitMask(
  project: Pick<LoadedProject, 'root' | 'composePath'>,
  {
    dockerBin = 'docker',
    env = process.env,
    projectName,
    evaluationAssets = [],
    redact = (text: string) => text,
  }: { dockerBin?: string; env?: NodeJS.ProcessEnv; projectName?: string; evaluationAssets?: readonly EvaluationAssetCopy[]; redact?: (text: string) => string } = {},
): Promise<Record<string, MaskVolume[]>> {
  // 실행·해석·계산은 Rust(crates/bstudio-io/src/up_loop.rs)가 한다. 던지지 않고 결과를 주므로 여기서 같은 오류로 바꾼다(ADR-195 4f A4c-1)
  const result = await native.loadGitMask(composeRef(project, { dockerBin, env, projectName }), JSON.stringify(plainAssets(evaluationAssets)), process.cwd());
  return maskOrThrow(result, redact);
}

/** Rust가 `compose` 명령을 부를 대상. `up`을 부르는 쪽과 같은 파일·프로젝트 이름·프로젝트 폴더·환경이다 */
export function composeRef(project: Pick<LoadedProject, 'root' | 'composePath'>, { dockerBin, env, projectName }: { dockerBin: string; env: NodeJS.ProcessEnv; projectName?: string | undefined }): NativeComposeRef {
  const envVars = definedEnv(env);
  return { dockerBin, ...(envVars === undefined ? {} : { envVars }), projectRoot: project.root, composePath: project.composePath, ...(projectName ? { projectName } : {}) };
}
