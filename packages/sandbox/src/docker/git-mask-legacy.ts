import { native } from '../native';
import type { EvaluationAssetCopy } from './evaluation-assets';
import { boundDevice, detectGitEntries, planGitMask, type InspectedMount, type MaskVolume } from './git-mask';

/**
 * A4b 이전의 TS `findMissingMasks`·`selectEvaluationAssetVolumes`(차등 시험의 기준값). 지금 구현은 Rust(crates/bstudio-io/src/container_verify.rs)다.
 * 이 파일은 견주는 시험만 쓴다. 견주는 TS를 지우는 PR(4g)에서 함께 지운다.
 */

/**
 * 합친 마스크에서 평가 자산 볼륨만 고른다. 평가 자산 자리의 사후 확인은 **계획**(override에 적은 target·원본)을 기대해야 한다 —
 * 컨테이너의 실제 마운트에서 거꾸로 계산하면, 프로젝트 마운트의 원본을 알아보지 못할 때(Docker Desktop이 `/host_mnt/…`로 알려 주는 등)
 * 기대 목록이 비어 확인이 통과한다(커밋 보안 검토). 볼륨의 원본이 b-studio 복사본(또는 그 안쪽)인 것으로 알아본다
 */
export async function selectEvaluationAssetVolumesLegacy(volumes: readonly MaskVolume[], assets: readonly EvaluationAssetCopy[]): Promise<MaskVolume[]> {
  const roots = await Promise.all(assets.map((asset) => real(asset.source)));
  const picked: MaskVolume[] = [];
  for (const volume of volumes) {
    const source = await real(volume.source);
    if (roots.some((root) => isInside(root, source))) picked.push(volume);
  }
  return picked;
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
export async function findMissingMasksLegacy(
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
