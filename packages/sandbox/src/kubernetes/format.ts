import type { ContainerState, LogLine, ServiceUsage } from '../types';

/** `kubectl logs --prefix --timestamps` 한 줄: `[pod/web/web] 2026-09-11T04:35:45.419151529Z 메시지` */
const PREFIXED_LOG_LINE = /^\[pod\/(?<pod>[^/\]]+)\/[^\]]*\] (?<timestamp>\d{4}-\d{2}-\d{2}T\S+Z) ?(?<text>.*)$/;
/** 한 Pod의 `kubectl logs --timestamps` 한 줄 */
const LOG_LINE = /^(?<timestamp>\d{4}-\d{2}-\d{2}T\S+Z) ?(?<text>.*)$/;

export function parseKubectlLogLine(raw: string, service?: string): LogLine | undefined {
  if (raw.trim() === '') return undefined;
  const groups = (service ? LOG_LINE : PREFIXED_LOG_LINE).exec(raw)?.groups;
  if (!groups) return { service: service ?? 'unknown', text: raw, at: new Date() };
  return {
    service: service ?? groups.pod!,
    text: groups.text ?? '',
    // 나노초 정밀도는 Date가 다루지 못하므로 밀리초까지만 남긴다
    at: new Date(groups.timestamp!.replace(/(\.\d{3})\d+/, '$1')),
  };
}

/** `kubectl version -o json`에서 클라이언트·서버 버전과 minor 버전 차이 */
export function parseKubectlVersions(json: string): { client?: string; server?: string; minorSkew?: number } {
  try {
    const data = JSON.parse(json) as { clientVersion?: { minor?: string; gitVersion?: string }; serverVersion?: { minor?: string; gitVersion?: string } };
    // 배포판에 따라 minor가 "30+"처럼 온다
    const client = Number.parseInt(data.clientVersion?.minor ?? '', 10);
    const server = Number.parseInt(data.serverVersion?.minor ?? '', 10);
    return {
      client: data.clientVersion?.gitVersion,
      server: data.serverVersion?.gitVersion,
      ...(Number.isFinite(client) && Number.isFinite(server) ? { minorSkew: Math.abs(client - server) } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * port-forward가 망가졌다는 kubectl 에러 줄. 요청이 중간에 끊긴 뒤 프로세스는 살아 있지만
 * 새 연결의 스트림을 만들지 못해(`error creating error stream ... Timeout occurred`) 일부 요청이 멈춘다
 */
export function isPortForwardBroken(line: string): boolean {
  return /error creating (error|data) stream|an error occurred forwarding|lost connection to pod/i.test(line);
}

/** `kubectl port-forward` 출력: `Forwarding from 127.0.0.1:54321 -> 20000` */
export function parsePortForwardLine(line: string): { local: number; remote: number } | undefined {
  const match = /^Forwarding from 127\.0\.0\.1:(\d+) -> (\d+)$/.exec(line.trim());
  return match ? { local: Number(match[1]), remote: Number(match[2]) } : undefined;
}

type ContainerStateJson = Partial<Record<'running' | 'waiting' | 'terminated', { exitCode?: number; reason?: string }>>;

export interface PodJson {
  metadata?: { name?: string; uid?: string; labels?: Record<string, string>; deletionTimestamp?: string };
  spec?: { containers?: Array<{ resources?: { limits?: Record<string, string> } }> };
  status?: {
    phase?: string;
    conditions?: Array<{ type: string; status: string }>;
    containerStatuses?: Array<{ ready?: boolean; restartCount?: number; state?: ContainerStateJson; lastState?: ContainerStateJson }>;
  };
}

export function podState(pod: PodJson | undefined): ContainerState {
  if (!pod) return 'unknown';
  if (pod.metadata?.deletionTimestamp) return 'removing';
  const status = pod.status?.containerStatuses?.[0];
  if (!status?.state) return pod.status?.phase === 'Pending' ? 'created' : 'unknown';
  if (status.state.running) return 'running';
  if (status.state.terminated) return 'exited';
  if (status.state.waiting) return (status.restartCount ?? 0) > 0 ? 'restarting' : 'created';
  return 'unknown';
}

export function podReady(pod: PodJson | undefined): boolean {
  return pod?.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True') ?? false;
}

/**
 * Pod 하나의 상태와 한도. 사용량(CPU, 메모리)은 metrics-server가 있어야 알 수 있어 넣지 않는다.
 * 컨테이너가 다시 시작됐으면 직전 종료(lastState)로 메모리 부족 종료를 알아본다
 */
export function podUsage(pod: PodJson): ServiceUsage {
  const status = pod.status?.containerStatuses?.[0];
  const terminated = status?.state?.terminated ?? status?.lastState?.terminated;
  const limits = pod.spec?.containers?.[0]?.resources?.limits ?? {};
  return {
    service: pod.metadata?.labels?.['b-studio.service'] ?? pod.metadata?.name ?? 'unknown',
    state: podState(pod),
    ...(limits.memory ? { memoryLimitBytes: quantityBytes(limits.memory) } : {}),
    ...(limits.cpu ? { cpuLimit: quantityCpu(limits.cpu) } : {}),
    ...(terminated?.exitCode !== undefined ? { exitCode: terminated.exitCode } : {}),
    oomKilled: terminated?.reason === 'OOMKilled',
  };
}

const BINARY = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 } as const;
const DECIMAL = { k: 1e3, M: 1e6, G: 1e9, T: 1e12 } as const;

/** Kubernetes 수량(1536Mi, 1.5Gi, 512M, 1048576)을 바이트로 */
export function quantityBytes(quantity: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(quantity);
  if (!match) return undefined;
  const unit = match[2] as keyof typeof BINARY | keyof typeof DECIMAL | undefined;
  const factor = !unit ? 1 : unit in BINARY ? BINARY[unit as keyof typeof BINARY] : DECIMAL[unit as keyof typeof DECIMAL];
  return Math.round(Number(match[1]) * factor);
}

/** Kubernetes CPU 수량(500m, 2)을 CPU 개수로 */
export function quantityCpu(quantity: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(m)?$/.exec(quantity);
  if (!match) return undefined;
  return match[2] ? Number(match[1]) / 1000 : Number(match[1]);
}
