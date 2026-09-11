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

export interface ExternalCallRequest {
  method: string;
  /** "/"로 시작하는 경로와 쿼리 */
  path: string;
  /** JSON 본문 */
  body?: string;
}

export interface ExternalCallResult {
  decision: 'allow' | 'deny';
  status: number;
  contentType?: string;
  /** 시크릿 값을 가린 응답 본문. 거부했으면 이유 */
  body: string;
  /** 정책으로 가린 필드 수 */
  masked: number;
  reason?: string;
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
  /**
   * input은 명령의 표준 입력으로 넘긴다 (예: 데이터베이스 덤프 복원).
   * 출력의 시크릿 값은 가려서 돌려준다. raw는 덤프처럼 내용을 그대로 옮겨야 하고 사람이나 모델에게 보이지 않을 때만 쓴다
   */
  exec(service: string, command: string[], options?: { signal?: AbortSignal; input?: string; raw?: boolean }): Promise<ExecResult>;
  /** 텍스트의 시크릿 값을 가린다. logs()와 exec() 출력은 이미 가려져 있다 */
  redact(text: string): string;
  /** 텍스트에 값이 들어 있는 시크릿 이름 (체크포인트에 시크릿이 커밋되지 않게 확인할 때) */
  findSecrets(text: string): string[];
  /**
   * 등록한 사내 API를 studio 호출자(에이전트 도구, API 탐색기)로 부른다.
   * 샌드박스 서비스의 호출과 같은 정책·인증·응답 가림·감사 기록을 거친다. via는 감사 기록에 남길 경로다
   */
  callExternal(name: string, request: ExternalCallRequest, options: { via: string; signal?: AbortSignal }): Promise<ExternalCallResult>;
  destroy(): Promise<void>;
}

/** 샌드박스를 만드는 구현체. 로컬 Docker → 사내 Kubernetes 등으로 교체할 수 있다 */
export interface SandboxProvider {
  readonly name: string;
  /** 컨테이너 격리 런타임 (예: runsc, gvisor). 화면에 격리 수준을 표시할 때 쓴다 */
  readonly isolation?: string;
  create(project: LoadedProject, options?: CreateSandboxOptions): Promise<Sandbox>;
  /**
   * 이전 스튜디오 프로세스가 정리하지 못한 샌드박스를 id로 지운다 (서버가 비정상 종료된 뒤 복구할 때).
   * b-studio가 만든 id 형식이 아니면 아무것도 지우지 않고 거부한다
   */
  cleanup?(sandboxId: string): Promise<void>;
  /**
   * cleanup()과 같은 정리를 하는 명령. 스튜디오 프로세스가 곧 강제 종료될 때(종료 신호) 따로 띄워 두는 용도다.
   * 형식이 아닌 id는 거부한다
   */
  cleanupCommand?(sandboxId: string): CleanupCommand;
}

export interface CleanupCommand {
  command: string;
  args: string[];
}

export interface CreateSandboxOptions {
  /** studio.yaml에 선언한 시크릿의 값 (이름 → 값). resolveSecrets()로 준비한다 */
  secrets?: Record<string, string>;
}
