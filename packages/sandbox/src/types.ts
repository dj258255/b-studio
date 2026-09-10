import type { LoadedProject } from '@b-studio/spec';

export type ContainerState = 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead' | 'unknown';

export interface ServiceEndpoint {
  service: string;
  containerPort: number;
  /** 미리보기 iframe이나 API 탐색기가 붙을 주소 */
  url: string;
}

/** 준비 상태를 한 번 확인한 결과 */
export interface ProbeResult {
  /** 확인한 시각 (epoch ms) */
  at: number;
  /** 기대한 HTTP 상태 코드를 받았는지 */
  ok: boolean;
  /** HTTP 상태 코드. 연결 자체가 안 되면 없음 */
  status?: number;
  /** 연결 거부, 타임아웃 등 */
  error?: string;
  /** 같은 시점의 컨테이너 상태. 프로세스가 죽었는지 알 수 있다 */
  containerState: ContainerState;
}

export type ServiceStatusEvent =
  | { service: string; phase: 'starting' }
  | { service: string; phase: 'probing'; probe: ProbeResult }
  | { service: string; phase: 'ready'; endpoint: ServiceEndpoint }
  | { service: string; phase: 'failed'; reason: string };

export interface StartOptions {
  signal?: AbortSignal;
  onStatus?: (event: ServiceStatusEvent) => void;
}

export interface LogLine {
  service: string;
  text: string;
  at: Date;
}

export interface LogOptions {
  /** 비우면 모든 서비스 */
  services?: string[];
  /** 과거 로그를 몇 줄부터 보여줄지 */
  tail?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 프로젝트 하나를 실행하는 격리된 환경 */
export interface Sandbox {
  readonly id: string;
  readonly project: LoadedProject;
  /** 모든 managed 서비스를 띄우고 준비될 때까지 기다린다 */
  start(options?: StartOptions): Promise<ServiceEndpoint[]>;
  /** 코드가 바뀐 서비스 하나만 다시 빌드해서 띄운다 */
  restart(service: string, options?: StartOptions): Promise<ServiceEndpoint>;
  endpoint(service: string): Promise<ServiceEndpoint>;
  state(service: string): Promise<ContainerState>;
  logs(options?: LogOptions): AsyncIterable<LogLine>;
  exec(service: string, command: string[]): Promise<ExecResult>;
  destroy(): Promise<void>;
}

/** 샌드박스를 만드는 구현체. 로컬 Docker → 사내 Kubernetes 등으로 교체할 수 있다 */
export interface SandboxProvider {
  readonly name: string;
  create(project: LoadedProject): Promise<Sandbox>;
}
