import { createHash } from 'node:crypto';
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
  const hash = createHash('sha256').update(`b-studio-snapshot-v1\0${project}\0${service}\0${volume}\0`);
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    // 경로와 길이를 함께 넣어 파일 경계가 달라도 같은 해시가 나오지 않게 한다
    hash.update(`${file.path}\0${file.content ? file.content.length : 'MISSING'}\0`);
    if (file.content) hash.update(file.content);
  }
  return `b-studio-snapshot-${hash.digest('hex').slice(0, 24)}`;
}

export function snapshotSlot(project: string, service: string, volume: string): string {
  return `${project}/${service}/${volume}`;
}

/** compose가 만드는 이름 있는 볼륨의 실제 이름: <프로젝트 이름>_<볼륨 키> */
export function composeVolumeName(composeProject: string, volume: string): string {
  return `${composeProject}_${volume}`;
}

/** `docker volume inspect --format '{{.Name}} {{.CreatedAt}}'` 출력에서 오래된 스냅샷을 골라 지울 이름을 돌려준다 */
export function snapshotsToPrune(inspectOutput: string, keep = SNAPSHOTS_TO_KEEP): string[] {
  return inspectOutput
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts): parts is [string, string] => parts.length >= 2 && Boolean(parts[0]))
    .map(([name, createdAt]) => ({ name, createdAt: Date.parse(createdAt) || 0 }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(keep)
    .map((volume) => volume.name);
}

export function describeSnapshotEvent(event: SnapshotEvent): string {
  const seconds = (ms: number) => `${(ms / 1_000).toFixed(1)}초`;
  switch (event.action) {
    case 'seeded':
      return `${event.volume} 볼륨을 스냅샷에서 채웠습니다 (${seconds(event.elapsedMs)})`;
    case 'missing':
      return `${event.volume} 스냅샷이 없어 처음부터 설치합니다`;
    case 'captured':
      return `${event.volume} 볼륨을 다음 기동용 스냅샷으로 저장했습니다 (${seconds(event.elapsedMs)})`;
    case 'failed':
      return `${event.volume} 스냅샷 ${event.stage === 'seed' ? '복사' : '저장'}에 실패해 스냅샷 없이 진행합니다: ${event.reason}`;
  }
}
