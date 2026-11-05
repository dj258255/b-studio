import { decodeNative, encodeNative, native } from '../native';

export type ContainerOwner = 'sandbox' | 'deploy' | 'user';

export interface HostContainerPort {
  containerPort: number;
  protocol: string;
  hostIp?: string;
  hostPort?: number;
}

export interface HostContainer {
  id: string;
  name: string;
  owner: ContainerOwner;
  composeProject?: string;
  composeService?: string;
  composeWorkingDir?: string;
  oneOff: boolean;
  state: string;
  health?: 'healthy' | 'unhealthy' | 'starting';
  ports: HostContainerPort[];
  labels: Record<string, string>;
}

/** `docker inspect <컨테이너...>` 출력(JSON 배열)을 파싱해, 소유자·compose 라벨·포트까지 뽑아낸다(판정은 Rust: crates/bstudio-guard/src/host_containers.rs) */
export function parseHostContainers(stdout: string): HostContainer[] {
  return decodeNative<HostContainer[]>(native.parseHostContainers(stdout));
}

/** b-studio 자신이 띄운 샌드박스·운영 배포 스택인지, 아니면 사용자가 직접 띄운 컨테이너인지 */
export function classifyOwnership(labels: Record<string, string>): ContainerOwner {
  return native.classifyOwnership(Object.keys(labels)) as ContainerOwner;
}

/**
 * compose working_dir 라벨이 프로젝트 원본 폴더이거나 그 하위 폴더를 가리키는지 본다.
 * 세션 작업 복사본 경로가 아니라 사용자가 연 원본 폴더(apps/studio/lib/server/projects.ts의 projectPath())와 비교해야 한다.
 */
export function matchesProjectRoot(workingDir: string | undefined, projectRoot: string): boolean {
  // path.resolve가 쓰는 프로세스의 현재 폴더는 여기서 넘긴다
  return native.matchesProjectRoot(workingDir, projectRoot, process.cwd());
}

export interface ComposeProjectGroup {
  project: string;
  workingDir: string;
  /** 어떤 라벨·경로로 이 그룹을 골랐는지 화면에 작게 보여 줄 문구 */
  matchReason: string;
  services: HostContainer[];
}

/**
 * 전체 컨테이너 목록에서 "사용자가 이 프로젝트 폴더에서 docker compose up으로 직접 띄운" 컨테이너만 골라
 * compose 프로젝트 단위로 묶는다. b-studio 자신의 샌드박스·배포 스택과, 일회성(run) 컨테이너는 뺀다.
 */
export function discoverUserContainers(containers: readonly HostContainer[], projectRoot: string): ComposeProjectGroup[] {
  // 판정에 쓰는 네 필드만 보낸다. 묶음에는 입력의 인덱스가 오고, 원래 객체를 그대로 끼운다
  const slim = containers.map(({ owner, oneOff, composeProject, composeWorkingDir }) => ({ owner, oneOff, composeProject, composeWorkingDir }));
  const groups = decodeNative<Array<Omit<ComposeProjectGroup, 'services'> & { services: number[] }>>(native.discoverUserContainers(encodeNative(slim), projectRoot, process.cwd()));
  return groups.map((group) => ({ ...group, services: group.services.map((index) => containers[index]!) }));
}

export interface HostContainerWithStats extends HostContainer {
  cpuPercent?: number;
  memoryBytes?: number;
}

/** `docker stats --no-stream --format '{{json .}}'` 출력을 컨테이너 이름으로 맞춰 CPU·메모리를 붙인다(죽은 컨테이너는 그대로 둔다) */
export function mergeHostContainerStats(containers: readonly HostContainer[], statsStdout: string): HostContainerWithStats[] {
  const live = decodeNative<Array<{ cpuPercent: number; memoryBytes?: number } | null>>(native.mergeHostContainerStats(encodeNative(containers.map((container) => container.name)), statsStdout));
  return containers.map((container, index) => ({ ...container, cpuPercent: live[index]?.cpuPercent, memoryBytes: live[index]?.memoryBytes }));
}
