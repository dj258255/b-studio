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

/** 기동 가속용 스냅샷을 쓰거나 만든 결과. 실패해도 기동은 스냅샷 없이 계속된다 */
export type SnapshotEvent =
  | { service: string; volume: string; snapshot: string; action: 'seeded'; elapsedMs: number }
  | { service: string; volume: string; snapshot: string; action: 'missing' }
  | { service: string; volume: string; snapshot: string; action: 'captured'; elapsedMs: number }
  | { service: string; volume: string; snapshot: string; action: 'failed'; stage: 'seed' | 'capture'; reason: string };

export interface StartOptions {
  signal?: AbortSignal;
  onStatus?: (event: ServiceStatusEvent) => void;
  onSnapshot?: (event: SnapshotEvent) => void;
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
  /** false면 지금까지의 로그만 돌려주고 끝난다 (기본: true, 계속 따라감) */
  follow?: boolean;
  signal?: AbortSignal;
}

export interface SyncOptions {
  signal?: AbortSignal;
  /** 이 시간 안에 반영되지 않으면 실패 (기본 60초) */
  timeoutMs?: number;
}

export interface SyncResult {
  /** 샌드박스에서 보일 때까지 걸린 시간 */
  elapsedMs: number;
  /** 확인 횟수 */
  checks: number;
}

/** 샌드박스 컨테이너 하나의 자원 사용량과 상태. 부가 서비스(DB 등)도 포함한다 */
export interface ServiceUsage {
  /** compose 서비스 이름 */
  service: string;
  state: ContainerState;
  /** 실행 중일 때만. 100이 CPU 1개를 다 쓴 것이다 */
  cpuPercent?: number;
  memoryBytes?: number;
  /** 한도를 걸었을 때만 */
  memoryLimitBytes?: number;
  cpuLimit?: number;
  /** 종료된 컨테이너의 종료 코드 */
  exitCode?: number;
  /** 메모리 한도를 넘어 커널이 종료시켰는지 */
  oomKilled: boolean;
}

/** 샌드박스 밖으로 나가려다 막힌 요청 (허용 목록에 없는 호스트, 사설 주소로 풀리는 이름 등) */
export interface EgressDenial {
  host: string;
  port?: number;
  reason: string;
  at: Date;
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
  /**
   * 호스트에서 바꾼 프로젝트 파일(루트 기준 경로)이 샌드박스 안에서 현재 내용 그대로 보일 때까지 기다린다.
   * 파일 공유 계층(sshfs 등)의 캐시 때문에 재시작한 서비스가 옛 코드를 빌드하는 것을 막는 동기화 지점이다.
   * 원격 제공자에서는 업로드 완료를 보장하는 방식으로 구현한다.
   */
  sync(files: string[], options?: SyncOptions): Promise<SyncResult>;
  endpoint(service: string): Promise<ServiceEndpoint>;
  state(service: string): Promise<ContainerState>;
  /** 모든 컨테이너의 자원 사용량. 실행 중이 아닌 컨테이너는 종료 코드와 메모리 부족 종료 여부만 담는다 */
  stats(): Promise<ServiceUsage[]>;
  logs(options?: LogOptions): AsyncIterable<LogLine>;
  /** since 이후 외부 접속이 막힌 기록. 네트워크를 제한하지 않는 제공자는 구현하지 않는다 */
  egressDenials?(options?: { since?: Date }): Promise<EgressDenial[]>;
  /** input은 명령의 표준 입력으로 넘긴다 (예: 데이터베이스 덤프 복원) */
  exec(service: string, command: string[], options?: { signal?: AbortSignal; input?: string }): Promise<ExecResult>;
  destroy(): Promise<void>;
}

/** 샌드박스를 만드는 구현체. 로컬 Docker → 사내 Kubernetes 등으로 교체할 수 있다 */
export interface SandboxProvider {
  readonly name: string;
  create(project: LoadedProject): Promise<Sandbox>;
}
