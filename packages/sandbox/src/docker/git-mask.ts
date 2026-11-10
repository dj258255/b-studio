import type { LoadedProject } from '@b-studio/spec';
import { SandboxError } from '../errors';
import type { EvaluationAssetCopy } from './evaluation-assets';
import type { BindMount } from './relay';
import { native, type NativeGitEntry } from '../native';
import { runCommand } from '../stream-exec';

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
 * 사용자 compose의 마운트 가운데 평가 자산 자리 안쪽(같은 자리 포함)에 있는 것이 있는지 본다.
 * Docker는 더 깊은 target의 마운트를 위에 얹으므로, 그런 마운트가 있으면 우리가 붙인 복사본 위에 다른 내용이 덮인다.
 * 게이트의 지문은 작업 복사본의 자산을 보므로 소리 없이 어긋난다(컬라임 실측: 복사본의 check.mjs 위에 다른 파일을 얹자
 * 컨테이너는 그 파일을 읽었다). 자산을 직접 마운트한 그 마운트 자신(같은 자리를 복사본으로 바꾸는 경우)만 빼고 **종류를 가리지 않고**
 * 거절한다 — `tmpfs`는 `docker inspect`의 `Mounts`에도, 호스트 마운트 목록에도 나오지 않지만 같은 자리에서 우리 마운트를 덮는다
 */
function assertNoNestedAssetMounts(
  composeMounts: readonly ComposeMount[],
  mounts: readonly Pick<BindMount, 'service' | 'source' | 'target'>[],
  projectRoot: string,
  assets: readonly EvaluationAssetCopy[],
): void {
  const problem = native.nestedAssetMountError(JSON.stringify(composeMounts), JSON.stringify(plainMounts(mounts)), projectRoot, JSON.stringify(plainAssets(assets)), process.cwd());
  if (problem != null) throw new SandboxError(problem);
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

/** compose 설정의 마운트 한 개. 평가 자산 자리를 덮는지 볼 때는 종류를 가리지 않는다 */
interface ComposeMount {
  service: string;
  type: string;
  target: string;
  /** 호스트 경로인 원본(bind, 호스트에 묶인 이름 있는 볼륨). tmpfs와 보통 볼륨에는 없다 */
  hostSource?: string;
}

/**
 * 서비스의 모든 종류 마운트(bind·volume·tmpfs·npipe 등)를 모은다. `tmpfs`는 `Mounts`에 나오지 않고 서비스 설정에만 있으므로
 * `volumes`와 따로 더한다(tmpfs는 volumes_from으로 물려받지 않는다). 무엇을 모을지는 Rust가 정하고, 호스트 원본의 링크 풀기만 여기서 한다
 */
async function collectComposeMounts(config: ComposeMountConfig): Promise<ComposeMount[]> {
  const specs = JSON.parse(asSandboxError(() => native.composeMountSpecs(JSON.stringify(config), process.cwd()))) as Array<{ service: string; type: string; target: string; host?: string }>;
  const mounts: ComposeMount[] = [];
  for (const { service, type, target, host } of specs) {
    const hostSource = host === undefined ? undefined : await real(host);
    mounts.push({ service, type, target, ...(hostSource === undefined ? {} : { hostSource }) });
  }
  return mounts;
}

/**
 * `docker compose config --format json` 결과에서 서비스별 마스크 마운트를 계산한다.
 * 마운트 소스는 심볼릭 링크를 풀어 `.git` 위치와 같은 꼴로 맞춘다.
 * `evaluationAssets`를 주면 git 마스크와 평가 자산 마스크를 한 맵으로 합친다. 같은 target이면 git 쪽 규칙이 이긴다(더 막는 쪽)
 */
export async function computeGitMask(
  projectRoot: string,
  config: ComposeMountConfig,
  { evaluationAssets = [] }: { evaluationAssets?: readonly EvaluationAssetCopy[] } = {},
): Promise<Record<string, MaskVolume[]>> {
  const root = await real(projectRoot);
  const mounts = await Promise.all(collectHostMounts(config).map(async (mount) => ({ ...mount, source: await real(mount.source) })));
  const entries = await detectGitEntries(root, mounts.map((mount) => mount.source));
  // b-studio가 만든 체크포인트 저장소(저장소 설정에 `[b-studio]` 절이 있다)인데 상태 폴더가 아직 없으면 미리 빈 폴더로 만들어 둔다.
  // 마운트 지점이 있어야 하고(읽기 전용 `.git` 아래에서는 만들 수 없다), 없다고 건너뛰면 나중에 b-studio가 만든 폴더가 컨테이너에
  // 그대로 보인다. 사용자 자신의 저장소(내 폴더 모드)에는 흔적을 남기지 않는다. 만들지 못하면 멈춘다.
  // 빈 폴더 준비는 Rust가 한다: 없으면 만들고 있으면 그대로 두며(서비스 여럿이 함께 재시작돼 동시에 불려도 엇갈리지 않게, 마찰 187),
  // 링크·파일이면 그 항목 하나만 지우고(링크를 따라가지 않는다), 내용이 들어 있으면 지우지 않고 멈춘다(재귀 삭제 없음)
  const prepared = await native.prepareStateMasks(entries);
  if (prepared.failure) {
    throw new SandboxError(`${prepared.failure.state} 폴더를 가릴 빈 폴더를 준비하지 못했습니다`, prepared.failure.detail, { platform: true });
  }
  entries.splice(0, entries.length, ...prepared.entries);
  const gitMask = planGitMask(mounts, entries);
  // 목록은 선언에서만 정한다(작업 복사본의 지금 상태를 보지 않는다). 그래야 자산이 지워지거나 링크로 바뀌어도 기대가 줄지 않는다
  if (evaluationAssets.length === 0) return gitMask;
  // 사용자 compose가 평가 자산 자리 위에 더 깊은 마운트를 얹으면 우리 복사본 위에 그 내용이 덮인다. 만들지 않고 멈춘다.
  // bind뿐 아니라 tmpfs·이름 있는 볼륨까지 본다(그것들은 collectHostMounts에 나오지 않는다)
  assertNoNestedAssetMounts(await collectComposeMounts(config), mounts, root, evaluationAssets);
  return mergeMasks(planEvaluationAssetMask(mounts, root, evaluationAssets), gitMask);
}

/**
 * 합친 마스크에서 평가 자산 볼륨만 고른다. 평가 자산 자리의 사후 확인은 **계획**(override에 적은 target·원본)을 기대해야 한다 —
 * 컨테이너의 실제 마운트에서 거꾸로 계산하면, 프로젝트 마운트의 원본을 알아보지 못할 때(Docker Desktop이 `/host_mnt/…`로 알려 주는 등)
 * 기대 목록이 비어 확인이 통과한다(커밋 보안 검토). 볼륨의 원본이 b-studio 복사본(또는 그 안쪽)인 것으로 알아본다
 */
export async function selectEvaluationAssetVolumes(volumes: readonly MaskVolume[], assets: readonly EvaluationAssetCopy[]): Promise<MaskVolume[]> {
  const roots = await Promise.all(assets.map((asset) => real(asset.source)));
  const picked: MaskVolume[] = [];
  for (const volume of volumes) {
    const source = await real(volume.source);
    if (roots.some((root) => isInside(root, source))) picked.push(volume);
  }
  return picked;
}

/** 마스크 계획을 서비스·target으로 합친다. 뒤에 오는 계획이 같은 target에서 이긴다 */
function mergeMasks(...plans: ReadonlyArray<Record<string, readonly MaskVolume[]>>): Record<string, MaskVolume[]> {
  return JSON.parse(native.mergeMasks(JSON.stringify(plans))) as Record<string, MaskVolume[]>;
}

/** `docker inspect`의 Mounts 한 항목 */
export interface InspectedMount {
  Type: string;
  Name?: string;
  Source?: string;
  Destination: string;
  RW?: boolean;
}

/**
 * Docker Desktop은 bind 마운트의 Source를 호스트 경로 앞에 `/host_mnt` 또는 `/run/desktop/mnt/host`를 붙여 알려 주기도 한다.
 * 맨 앞이 **정확히** 그 접두어이고, 뗀 나머지가 절대 경로이며 `..` 요소가 없을 때만 그 경로로 본다.
 * 그 밖의 꼴(접미어만 같은 다른 경로 등)은 받지 않는다
 */
function dockerDesktopHostPath(source: string): string | undefined {
  return native.dockerDesktopHostPath(source) ?? undefined;
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
 * 알아보지 못할 때 기대 목록이 비어 통과한다. 계획에 있는 자리마다 셋을 모두 본다: 읽기 전용이고 원본이 계획한 복사본,
 * 그 자리 안쪽에 다른 `Mounts` 항목이 없음, `HostConfig.Tmpfs`가 그 자리를 덮지 않음
 * 이름 있는 볼륨은 `volumeDevices`(볼륨 이름 → 로컬 드라이버 옵션)로 호스트 폴더에 묶였는지 본다
 */
export async function findMissingMasks(
  projectRoot: string,
  mounts: readonly InspectedMount[],
  volumeOptions: Readonly<Record<string, { driver?: string; driver_opts?: Record<string, string> } | undefined>>,
  { evaluationAssetPlan = {}, service, tmpfs = {} }: MissingMaskOptions = {},
): Promise<string[]> {
  const root = await real(projectRoot);
  const missing: string[] = [];
  const record = (target: string) => {
    if (!missing.includes(target)) missing.push(target);
  };

  // `.git`은 지금처럼 컨테이너의 실제 마운트에서 본다
  const hostMounts = await Promise.all(
    mounts.flatMap((mount) => {
      const source = mount.Type === 'bind' ? mount.Source : mount.Type === 'volume' && mount.Name ? boundDevice(volumeOptions[mount.Name]) : undefined;
      return source ? [real(source).then((resolved) => ({ service: 'container', source: resolved, target: mount.Destination }))] : [];
    }),
  );
  if (hostMounts.length > 0) {
    const entries = await detectGitEntries(root, hostMounts.map((mount) => mount.source));
    for (const volume of planGitMask(hostMounts, entries).container ?? []) {
      const actual = mounts.find((mount) => mount.Destination === volume.target);
      if (actual === undefined || actual.RW !== false) record(volume.target);
    }
  }

  // 평가 자산 자리는 계획에 있는 것을 전부 본다. "읽기 전용 마운트가 있다"만 보면 더 깊은 사용자 마운트나 같은 자리의 tmpfs가
  // 위에 내용을 덮어도 통과한다(커밋 보안 검토)
  const planned = service === undefined ? [] : (evaluationAssetPlan[service] ?? []);
  const tmpfsPaths = Object.keys(tmpfs);
  for (const volume of planned) {
    // 같은 자리에 마운트가 여럿이면 어느 것이 이겼는지 알 수 없다. 하나뿐일 때만 그 마운트를 본다
    const actuals = mounts.filter((mount) => mount.Destination === volume.target);
    const actual = actuals[0];
    const raw = actual?.Type === 'bind' ? actual.Source : actual?.Type === 'volume' && actual.Name ? boundDevice(volumeOptions[actual.Name]) : undefined;
    // Docker Desktop이 붙여 알려 주는 접두어만 뗀다. 그 밖의 꼴은 받지 않는다
    const source = raw === undefined ? undefined : dockerDesktopHostPath(raw);
    const nested = mounts.some((mount) => mount.Destination !== volume.target && isInsidePosix(volume.target, mount.Destination));
    const overwritten = tmpfsPaths.some((path) => isInsidePosix(volume.target, path));
    const ok =
      actuals.length === 1 && actual !== undefined && actual.RW === false && source !== undefined && (await real(source)) === (await real(volume.source)) && !nested && !overwritten;
    if (!ok) record(volume.target);
  }
  return missing;
}

function real(target: string): Promise<string> {
  return native.realPath(target, process.cwd());
}

/** 호스트 경로 비교(Node path.relative와 같은 규칙, 판정은 Rust) */
function isInside(parent: string, target: string): boolean {
  return native.isInsideHostPath(process.cwd(), parent, target);
}

/** 컨테이너 안 경로(target)를 비교한다. 호스트 경로가 아니라 항상 POSIX 규칙이다 */
function isInsidePosix(parent: string, target: string): boolean {
  return native.isInsidePosix(parent, target);
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
  const args = ['compose', ...(projectName ? ['--project-name', projectName] : []), '--profile', '*', '--project-directory', project.root, '--file', project.composePath, 'config', '--format', 'json'];
  // 실행은 Rust(run_command)가 한다. 던지지 않고 결과를 주므로 비0 종료·spawn 실패·출력 상한 초과를 여기서 같은 오류로 바꾼다
  const result = await runCommand(dockerBin, args, { env });
  if (result.exitCode !== 0) {
    throw new SandboxError('compose 설정을 읽지 못해 서비스 컨테이너의 .git 보호를 정할 수 없습니다', redact(result.stderr.trim() ? result.stderr : 'docker 실행 실패'));
  }
  const stdout = result.stdout;
  let config: ComposeMountConfig;
  try {
    const parsed = JSON.parse(stdout) as Partial<ComposeMountConfig>;
    config = { services: parsed.services ?? {}, ...(parsed.volumes ? { volumes: parsed.volumes } : {}) };
  } catch {
    throw new SandboxError('compose 설정(config --format json)을 해석하지 못해 서비스 컨테이너의 .git 보호를 정할 수 없습니다');
  }
  return computeGitMask(project.root, config, { evaluationAssets });
}
