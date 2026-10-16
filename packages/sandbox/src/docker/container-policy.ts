import path from 'node:path';
import { STUDIO_CALLER } from '@b-studio/spec';

/**
 * 만든 컨테이너가 샌드박스 격리를 벗어나는 설정을 가졌는지 본다(이슈 #701).
 *
 * compose 파일은 에이전트가 세션 중에 고칠 수 있다(ADR-158). 그래서 compose 파일을 읽어 판단하지 않고, `.git` 마스크처럼
 * **만들어진 컨테이너의 실제 설정**(`docker inspect`)을 본다. 보간·프로필·병합·`service:` 참조를 compose가 푼 뒤의 결과라
 * 확인하는 쪽과 실제로 동작하는 쪽이 같은 값을 읽는다.
 *
 * 거부 목록이다. 아래에 걸리면 시작하지 않는다.
 *  - 권한: `privileged`, `cap_add`, `devices`, seccomp·AppArmor·SELinux를 끄는 `security_opt`
 *  - 호스트·다른 컨테이너의 네임스페이스: `pid`·`ipc`·`uts`·`userns_mode`·`cgroup`의 `host`, `network_mode`·`pid`·`ipc`의 `container:`/`host`
 *  - 네트워크: 서비스는 `b-studio-sandbox` 하나, edge는 그것과 `b-studio-egress`만. 사용자가 더한 네트워크(`default` 포함)는 internal 격리와 edge를 비켜 간다
 *  - 포트 공개: edge만. 다른 서비스가 포트를 공개하면 edge를 거치지 않고 호스트에 열린다
 *  - 호스트 경로 마운트: Docker·containerd 소켓, 시스템 폴더(`/`, `/etc`, `/proc`, `/sys`, `/dev`, `/run`, `/var/run`, `/var/lib/docker`, `/boot`)
 *  - 서비스 이름 `studio`: edge 정책이 이 이름을 studio 자신의 호출로 본다
 *
 * 프로젝트 밖의 다른 바인드는 막지 않는다. 모노레포 저장소 루트처럼 프로젝트의 상위 폴더를 마운트하는 구성을 지원한다(git-mask.ts)
 */

export interface InspectedContainerPolicy {
  Id: string;
  Name?: string;
  Config?: { Labels?: Record<string, string> | null } | null;
  HostConfig?: {
    Privileged?: boolean;
    CapAdd?: string[] | null;
    Devices?: unknown[] | null;
    DeviceRequests?: unknown[] | null;
    SecurityOpt?: string[] | null;
    PidMode?: string;
    IpcMode?: string;
    UTSMode?: string;
    UsernsMode?: string;
    CgroupnsMode?: string;
    NetworkMode?: string;
    PortBindings?: Record<string, unknown[] | null> | null;
  } | null;
  NetworkSettings?: { Networks?: Record<string, unknown> | null } | null;
  Mounts?: Array<{ Type?: string; Source?: string }> | null;
}

const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

/** 마운트하면 컨테이너가 호스트(또는 Docker VM)를 다룰 수 있게 되는 폴더. 이 폴더 자신과 그 아래가 걸린다 */
const SYSTEM_DIRS = ['/etc', '/proc', '/sys', '/dev', '/run', '/var/run', '/var/lib/docker', '/var/lib/containerd', '/boot'];
const SOCKET_NAME = /(^|[/\\])(docker|containerd|podman|buildkitd|colima)[^/\\]*\.sock$/i;

export function findPolicyViolations(
  container: InspectedContainerPolicy,
  { projectName, sandboxNetwork, egressNetwork, edgeService }: { projectName: string; sandboxNetwork: string; egressNetwork: string; edgeService: string },
): string[] {
  const problems: string[] = [];
  const host = container.HostConfig ?? {};
  const service = container.Config?.Labels?.[COMPOSE_SERVICE_LABEL];
  const isEdge = service === edgeService;

  if (service === STUDIO_CALLER) problems.push(`서비스 이름 '${STUDIO_CALLER}'는 쓸 수 없습니다(edge가 studio의 호출로 봅니다)`);
  if (host.Privileged) problems.push('privileged');
  if ((host.CapAdd ?? []).length > 0) problems.push(`cap_add: ${host.CapAdd!.join(', ')}`);
  if ((host.Devices ?? []).length > 0) problems.push('devices');
  if ((host.DeviceRequests ?? []).length > 0) problems.push('device_requests(gpus)');
  for (const option of host.SecurityOpt ?? []) {
    if (/unconfined/i.test(option) || /^label[=:]disable$/i.test(option) || /^no-new-privileges[=:]false$/i.test(option)) problems.push(`security_opt: ${option}`);
  }
  const namespaces: Array<[string, string | undefined]> = [
    ['pid', host.PidMode],
    ['ipc', host.IpcMode],
    ['uts', host.UTSMode],
    ['userns_mode', host.UsernsMode],
    ['cgroup', host.CgroupnsMode],
    ['network_mode', host.NetworkMode],
  ];
  for (const [name, mode] of namespaces) {
    if (mode === 'host' || mode?.startsWith('container:')) problems.push(`${name}: ${mode}`);
  }

  // compose는 네트워크 이름 앞에 프로젝트 이름을 붙인다
  const allowed = new Set([`${projectName}_${sandboxNetwork}`, ...(isEdge ? [`${projectName}_${egressNetwork}`] : [])]);
  const networks = Object.keys(container.NetworkSettings?.Networks ?? {});
  const extra = networks.filter((network) => !allowed.has(network));
  if (extra.length > 0) problems.push(`networks: ${extra.join(', ')}`);

  if (!isEdge) {
    const published = Object.entries(host.PortBindings ?? {}).filter(([, bindings]) => (bindings ?? []).length > 0).map(([port]) => port);
    if (published.length > 0) problems.push(`ports: ${published.join(', ')}`);
  }

  for (const mount of container.Mounts ?? []) {
    if (mount.Type !== 'bind' || !mount.Source) continue;
    if (isSensitiveHostPath(mount.Source)) problems.push(`호스트 경로 마운트: ${mount.Source}`);
  }
  return problems;
}

/**
 * 거부 목록이므로 모양을 모르는 경로(상대 경로 등)는 걸린 것으로 본다.
 * Docker Desktop은 호스트 폴더를 VM의 `/run/desktop/mnt/host/…`, `/host_mnt/…`로 보여 주므로 그 아래는 호스트 폴더로 읽고,
 * Windows 드라이브 경로(`C:\…`)도 호스트 폴더로 본다
 */
export function isSensitiveHostPath(source: string): boolean {
  if (SOCKET_NAME.test(source)) return true;
  if (/^[A-Za-z]:[\\/]/.test(source)) return false;
  if (/^\/(run\/desktop\/mnt\/host|host_mnt)\/[^/]/.test(source) && !source.split('/').includes('..')) return false;
  if (!path.posix.isAbsolute(source)) return true;
  const normalized = path.posix.normalize(source).replace(/\/+$/, '') || '/';
  if (normalized === '/') return true;
  return SYSTEM_DIRS.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`));
}
