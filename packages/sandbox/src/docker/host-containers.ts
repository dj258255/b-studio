import path from 'node:path';
import { parseStatsOutput } from './usage';

/** compose가 리소스마다 자동으로 붙이는 라벨(사실상 표준, docker/compose의 pkg/api/labels.go) */
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const COMPOSE_WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';
const COMPOSE_ONEOFF_LABEL = 'com.docker.compose.oneoff';

/** b-studio가 스스로 띄운 샌드박스·운영 배포 스택에 붙이는 라벨(packages/sandbox/src/docker/format.ts, deploy.ts) */
const SANDBOX_LABEL = 'b-studio.sandbox';
const DEPLOY_LABEL = 'b-studio.deploy';

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

const STATES: ReadonlySet<string> = new Set(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']);
const HEALTH_STATUSES: ReadonlySet<string> = new Set(['starting', 'healthy', 'unhealthy']);

/** `docker inspect <컨테이너...>` 출력(JSON 배열)을 파싱해, 소유자·compose 라벨·포트까지 뽑아낸다 */
export function parseHostContainers(stdout: string): HostContainer[] {
  const rows = JSON.parse(stdout.trim() || '[]') as Array<{
    Id?: string;
    Name?: string;
    State?: { Status?: string; Health?: { Status?: string } };
    Config?: { Labels?: Record<string, string> };
    NetworkSettings?: { Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> };
  }>;

  return rows.map((row) => {
    const labels = row.Config?.Labels ?? {};
    return {
      id: row.Id ?? '',
      name: (row.Name ?? '').replace(/^\//, ''),
      owner: classifyOwnership(labels),
      composeProject: labels[COMPOSE_PROJECT_LABEL],
      composeService: labels[COMPOSE_SERVICE_LABEL],
      composeWorkingDir: labels[COMPOSE_WORKING_DIR_LABEL],
      oneOff: labels[COMPOSE_ONEOFF_LABEL] === 'True' || labels[COMPOSE_ONEOFF_LABEL] === 'true',
      state: STATES.has(row.State?.Status ?? '') ? row.State!.Status! : 'unknown',
      health: HEALTH_STATUSES.has(row.State?.Health?.Status ?? '') ? (row.State!.Health!.Status as HostContainer['health']) : undefined,
      ports: parsePorts(row.NetworkSettings?.Ports),
      labels,
    };
  });
}

function parsePorts(ports: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | undefined): HostContainerPort[] {
  if (!ports) return [];
  const result: HostContainerPort[] = [];
  for (const [key, bindings] of Object.entries(ports)) {
    const [portText, protocol = 'tcp'] = key.split('/');
    const containerPort = Number.parseInt(portText ?? '', 10);
    if (!Number.isFinite(containerPort)) continue;
    if (!bindings || bindings.length === 0) {
      result.push({ containerPort, protocol });
      continue;
    }
    // IPv4(0.0.0.0)와 IPv6(::)에 같은 포트가 중복으로 잡히므로 IPv4 바인딩을 대표로 하나만 남긴다
    const ipv4 = bindings.find((binding) => binding.HostIp !== '::') ?? bindings[0];
    result.push({ containerPort, protocol, hostIp: ipv4?.HostIp, hostPort: ipv4?.HostPort ? Number.parseInt(ipv4.HostPort, 10) : undefined });
  }
  return result;
}

/** b-studio 자신이 띄운 샌드박스·운영 배포 스택인지, 아니면 사용자가 직접 띄운 컨테이너인지 */
export function classifyOwnership(labels: Record<string, string>): ContainerOwner {
  if (SANDBOX_LABEL in labels) return 'sandbox';
  if (DEPLOY_LABEL in labels) return 'deploy';
  return 'user';
}

/**
 * compose working_dir 라벨이 프로젝트 원본 폴더이거나 그 하위 폴더를 가리키는지 본다.
 * 세션 작업 복사본 경로가 아니라 사용자가 연 원본 폴더(apps/studio/lib/server/projects.ts의 projectPath())와 비교해야 한다.
 */
export function matchesProjectRoot(workingDir: string | undefined, projectRoot: string): boolean {
  if (!workingDir) return false;
  const a = path.resolve(workingDir);
  const b = path.resolve(projectRoot);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : `${b}${path.sep}`);
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
  const groups = new Map<string, ComposeProjectGroup>();
  for (const container of containers) {
    if (container.owner !== 'user') continue;
    if (container.oneOff) continue;
    if (!container.composeProject || !matchesProjectRoot(container.composeWorkingDir, projectRoot)) continue;

    const existing = groups.get(container.composeProject);
    if (existing) {
      existing.services.push(container);
    } else {
      groups.set(container.composeProject, {
        project: container.composeProject,
        workingDir: container.composeWorkingDir!,
        matchReason: `com.docker.compose.project.working_dir="${container.composeWorkingDir}" (프로젝트 폴더와 일치)`,
        services: [container],
      });
    }
  }
  return [...groups.values()].sort((a, b) => (a.project < b.project ? -1 : 1));
}

export interface HostContainerWithStats extends HostContainer {
  cpuPercent?: number;
  memoryBytes?: number;
}

/** `docker stats --no-stream --format '{{json .}}'` 출력을 컨테이너 이름으로 맞춰 CPU·메모리를 붙인다(죽은 컨테이너는 그대로 둔다) */
export function mergeHostContainerStats(containers: readonly HostContainer[], statsStdout: string): HostContainerWithStats[] {
  const stats = parseStatsOutput(statsStdout);
  return containers.map((container) => {
    const live = stats.find((row) => row.name === container.name);
    return { ...container, cpuPercent: live?.cpuPercent, memoryBytes: live?.memoryBytes };
  });
}
