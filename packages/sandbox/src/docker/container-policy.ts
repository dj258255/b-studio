import { STUDIO_CALLER } from '@b-studio/spec';
import { native } from '../native';

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
    /** tmpfs 마운트(컨테이너 안 경로 → 옵션). 사후 확인이 평가 자산 자리를 덮는지 본다 */
    Tmpfs?: Record<string, string> | null;
  } | null;
  NetworkSettings?: { Networks?: Record<string, unknown> | null } | null;
  Mounts?: Array<{ Type?: string; Source?: string }> | null;
}

/** 판정은 Rust(crates/bstudio-guard/src/container_policy.rs)가 한다. 모양을 모르는 값은 걸린 것으로 센다(거부 목록) */
export function findPolicyViolations(
  container: InspectedContainerPolicy,
  { projectName, sandboxNetwork, egressNetwork, edgeService }: { projectName: string; sandboxNetwork: string; egressNetwork: string; edgeService: string },
): string[] {
  return native.findPolicyViolations(JSON.stringify(container), projectName, sandboxNetwork, egressNetwork, edgeService, STUDIO_CALLER);
}

/**
 * 거부 목록이므로 모양을 모르는 경로(상대 경로 등)는 걸린 것으로 본다.
 * Docker Desktop은 호스트 폴더를 VM의 `/run/desktop/mnt/host/…`, `/host_mnt/…`로 보여 주므로 그 아래는 호스트 폴더로 읽고,
 * Windows 드라이브 경로(`C:\…`)도 호스트 폴더로 본다
 */
export function isSensitiveHostPath(source: string): boolean {
  return native.isSensitiveHostPath(source);
}
