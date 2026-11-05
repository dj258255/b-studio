import { EDGE_SERVICE } from '../edge-config';
import { decodeNative, encodeNative, native } from '../native';
import type { BootNetwork, ContainerHealth, ContainerState, ServiceUsage } from '../types';

/** `docker stats`의 크기 표기(43.12MiB, 1.2kB, 0B)를 바이트로 바꾼다 */
export function parseDockerBytes(text: string): number | undefined {
  // 해석은 Rust(crates/bstudio-guard/src/usage.rs)가 한다
  return native.parseDockerBytes(text) ?? undefined;
}

interface StatsRow {
  name: string;
  cpuPercent: number;
  memoryBytes?: number;
  networkRxBytes?: number;
  networkTxBytes?: number;
}

/** `docker stats --no-stream --format '{{json .}}'` 출력 (컨테이너마다 JSON 한 줄) */
export function parseStatsOutput(stdout: string): StatsRow[] {
  return decodeNative<StatsRow[]>(native.parseStatsOutput(stdout));
}

interface InspectRow {
  name: string;
  service: string;
  state: ContainerState;
  exitCode: number;
  oomKilled: boolean;
  memoryLimitBytes?: number;
  cpuLimit?: number;
  restartCount?: number;
  startedAt?: string;
  health?: ContainerHealth;
}

/** `docker inspect <컨테이너...>` 출력 (JSON 배열) */
export function parseInspectOutput(stdout: string): InspectRow[] {
  return decodeNative<InspectRow[]>(native.parseInspectOutput(stdout));
}

/**
 * 이 프로젝트의 compose 서비스를 세 갈래(서비스/부가 서비스/플랫폼)로 나눠 사용량과 합친다.
 * managedNames를 비워 두면(옛 호출자 호환) 모두 supporting으로 분류한다
 */
export function mergeUsage(inspected: InspectRow[], stats: StatsRow[], managedNames: ReadonlySet<string> = new Set()): ServiceUsage[] {
  return decodeNative<ServiceUsage[]>(native.mergeUsage(encodeNative(inspected), encodeNative(stats), [...managedNames], EDGE_SERVICE));
}

/**
 * 기동 직후 stats에서 기동 네트워크 지표를 만든다. 값은 컨테이너 수명 누계라 기동 직후에는 "기동 중 받은 양"이다.
 * edge 프록시는 서비스 트래픽이 지나가므로 더하면 이중 계산이라 뺀다. 값이 없는 컨테이너도 뺀다.
 */
export function bootNetworkFromUsage(usage: ServiceUsage[], exclude: string): BootNetwork {
  return decodeNative<BootNetwork>(native.bootNetworkFromUsage(encodeNative(usage), exclude));
}

/** 사람이 읽는 크기. 화면과 에이전트 도구가 같은 표기를 쓴다 */
export function formatBytes(bytes: number | undefined): string {
  return native.formatBytes(bytes);
}

/** 종료 코드 137은 SIGKILL로 끝났다는 뜻이고, 한도를 넘은 경우가 흔하다 */
export function describeUsage(usage: ServiceUsage): string {
  return native.describeUsage(encodeNative(usage));
}
