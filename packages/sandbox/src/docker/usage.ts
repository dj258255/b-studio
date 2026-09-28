import type { BootNetwork, ContainerState, ServiceUsage } from '../types';

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1_000,
  mb: 1_000 ** 2,
  gb: 1_000 ** 3,
  tb: 1_000 ** 4,
  kib: 1_024,
  mib: 1_024 ** 2,
  gib: 1_024 ** 3,
  tib: 1_024 ** 4,
};

/** `docker stats`의 크기 표기(43.12MiB, 1.2kB, 0B)를 바이트로 바꾼다 */
export function parseDockerBytes(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b)$/i.exec(text.trim());
  if (!match) return undefined;
  const unit = BYTE_UNITS[match[2]!.toLowerCase()];
  return unit === undefined ? undefined : Math.round(Number(match[1]) * unit);
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
  return stdout
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => {
      const row = JSON.parse(line) as { Name?: string; CPUPerc?: string; MemUsage?: string; NetIO?: string };
      // NetIO는 "수신 / 송신"이다(예: "28.8kB / 23.4kB"). docker가 값을 못 주면 "--"라 둘 다 undefined가 된다
      const [rx, tx] = (row.NetIO ?? '').split('/');
      return {
        name: row.Name ?? '',
        cpuPercent: Number.parseFloat(row.CPUPerc ?? '') || 0,
        // "사용량 / 한도"에서 한도는 한도를 걸지 않으면 VM 전체 메모리이므로 inspect 값을 쓴다
        memoryBytes: parseDockerBytes((row.MemUsage ?? '').split('/')[0] ?? ''),
        networkRxBytes: parseDockerBytes(rx ?? ''),
        networkTxBytes: parseDockerBytes(tx ?? ''),
      };
    });
}

interface InspectRow {
  name: string;
  service: string;
  state: ContainerState;
  exitCode: number;
  oomKilled: boolean;
  memoryLimitBytes?: number;
  cpuLimit?: number;
}

const STATES: ReadonlySet<string> = new Set(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']);

/** `docker inspect <컨테이너...>` 출력 (JSON 배열) */
export function parseInspectOutput(stdout: string): InspectRow[] {
  const rows = JSON.parse(stdout.trim() || '[]') as Array<{
    Name?: string;
    State?: { Status?: string; ExitCode?: number; OOMKilled?: boolean };
    HostConfig?: { Memory?: number; NanoCpus?: number };
    Config?: { Labels?: Record<string, string> };
  }>;
  return rows.map((row) => ({
    name: (row.Name ?? '').replace(/^\//, ''),
    service: row.Config?.Labels?.['com.docker.compose.service'] ?? 'unknown',
    state: STATES.has(row.State?.Status ?? '') ? (row.State!.Status as ContainerState) : 'unknown',
    exitCode: row.State?.ExitCode ?? 0,
    oomKilled: row.State?.OOMKilled ?? false,
    memoryLimitBytes: row.HostConfig?.Memory ? row.HostConfig.Memory : undefined,
    cpuLimit: row.HostConfig?.NanoCpus ? row.HostConfig.NanoCpus / 1e9 : undefined,
  }));
}

export function mergeUsage(inspected: InspectRow[], stats: StatsRow[]): ServiceUsage[] {
  return inspected
    .map((row): ServiceUsage => {
      const live = row.state === 'running' ? stats.find((candidate) => candidate.name === row.name) : undefined;
      return {
        service: row.service,
        state: row.state,
        cpuPercent: live?.cpuPercent,
        memoryBytes: live?.memoryBytes,
        memoryLimitBytes: row.memoryLimitBytes,
        cpuLimit: row.cpuLimit,
        networkRxBytes: live?.networkRxBytes,
        networkTxBytes: live?.networkTxBytes,
        exitCode: row.state === 'exited' || row.state === 'dead' ? row.exitCode : undefined,
        oomKilled: row.oomKilled,
      };
    })
    .sort((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0));
}

/**
 * 기동 직후 stats에서 기동 네트워크 지표를 만든다. 값은 컨테이너 수명 누계라 기동 직후에는 "기동 중 받은 양"이다.
 * edge 프록시는 서비스 트래픽이 지나가므로 더하면 이중 계산이라 뺀다. 값이 없는 컨테이너도 뺀다.
 */
export function bootNetworkFromUsage(usage: ServiceUsage[], exclude: string): BootNetwork {
  return usage.flatMap((entry) =>
    entry.service === exclude || entry.networkRxBytes === undefined || entry.networkTxBytes === undefined
      ? []
      : [{ service: entry.service, rxBytes: entry.networkRxBytes, txBytes: entry.networkTxBytes }],
  );
}

/** 사람이 읽는 크기. 화면과 에이전트 도구가 같은 표기를 쓴다 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '-';
  if (bytes >= 1_024 ** 3) return `${(bytes / 1_024 ** 3).toFixed(2)}GiB`;
  if (bytes >= 1_024 ** 2) return `${Math.round(bytes / 1_024 ** 2)}MiB`;
  return `${Math.round(bytes / 1_024)}KiB`;
}

/** 종료 코드 137은 SIGKILL로 끝났다는 뜻이고, 한도를 넘은 경우가 흔하다 */
export function describeUsage(usage: ServiceUsage): string {
  const memory = `${formatBytes(usage.memoryBytes)}${usage.memoryLimitBytes ? ` / ${formatBytes(usage.memoryLimitBytes)}` : ''}`;
  const cpu = usage.cpuPercent === undefined ? '-' : `${usage.cpuPercent.toFixed(1)}%${usage.cpuLimit ? ` / ${usage.cpuLimit * 100}%` : ''}`;
  const ended =
    usage.exitCode === undefined
      ? ''
      : `, 종료 코드 ${usage.exitCode}${usage.oomKilled ? ' (메모리 한도를 넘어 종료됨)' : usage.exitCode === 137 ? ' (강제 종료, 메모리 부족일 수 있음)' : ''}`;
  return `${usage.service}: ${usage.state}, CPU ${cpu}, 메모리 ${memory}${ended}`;
}
