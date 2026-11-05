import { encodeNative, native } from '../native';
import type { SnapshotEvent } from '../types';

/** 스냅샷 볼륨에 붙이는 라벨. 정리할 때 이 라벨로 찾는다 */
export const SNAPSHOT_LABEL = 'b-studio.snapshot';
/** 복사가 끝까지 끝난 스냅샷에만 남기는 표시 파일. 중간에 끊긴 스냅샷으로 시작하지 않게 한다 */
export const SNAPSHOT_MARKER = '.b-studio-snapshot-complete';
/** 같은 자리(프로젝트·서비스·볼륨)에 남길 스냅샷 수. lockfile을 바꾸고 되돌리는 경우를 위해 하나 더 둔다 */
export const SNAPSHOTS_TO_KEEP = 2;

export interface SnapshotKeyInput {
  project: string;
  service: string;
  volume: string;
  /** 키 파일 내용. 파일이 없으면 undefined */
  files: Array<{ path: string; content: Buffer | undefined }>;
}

/**
 * 스냅샷 볼륨 이름. 같은 프로젝트·서비스·볼륨에서 키 파일 내용이 모두 같을 때만 같은 이름이 된다.
 * 프로젝트를 키에 넣어, 한 프로젝트의 설치 결과가 lockfile이 같은 다른 프로젝트로 넘어가지 않게 한다.
 */
export function snapshotName({ project, service, volume, files }: SnapshotKeyInput): string {
  // 해시는 Rust(crates/bstudio-guard/src/snapshots.rs)가 낸다. 같은 알고리즘(SHA-256), 같은 입력 순서, 같은 출력 형식이다
  return native.snapshotName(
    project,
    service,
    volume,
    files.map((file) => file.path),
    files.map((file) => Boolean(file.content)),
    files.map((file) => file.content ?? Buffer.alloc(0)),
  );
}

export function snapshotSlot(project: string, service: string, volume: string): string {
  return native.snapshotSlot(project, service, volume);
}

/** compose가 만드는 이름 있는 볼륨의 실제 이름: <프로젝트 이름>_<볼륨 키> */
export function composeVolumeName(composeProject: string, volume: string): string {
  return native.composeVolumeName(composeProject, volume);
}

/** `docker volume inspect --format '{{.Name}} {{.CreatedAt}}'` 출력에서 오래된 스냅샷을 골라 지울 이름을 돌려준다 */
export function snapshotsToPrune(inspectOutput: string, keep = SNAPSHOTS_TO_KEEP): string[] {
  // 시각은 JS가 읽어야 같은 값이 나오므로 Date.parse를 넘긴다
  return native.snapshotsToPrune(inspectOutput, keep, (text) => Date.parse(text));
}

export function describeSnapshotEvent(event: SnapshotEvent): string {
  // 알 수 없는 action이면 옛 TS처럼 undefined를 돌려준다(타입은 모든 경우를 덮는다)
  return (native.describeSnapshotEvent(encodeNative(event)) ?? undefined) as string;
}
