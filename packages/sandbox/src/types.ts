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
  | { service: string; phase: 'failed'; reason: string }
  /** 사용자가 서비스 선택(ADR-083)에서 꺼 둬 이번 기동에서 띄우지 않았다. 실패가 아니다 */
  | { service: string; phase: 'off' };

/** 기동 가속용 스냅샷을 쓰거나 만든 결과. 실패해도 기동은 스냅샷 없이 계속된다 */
export type SnapshotEvent =
  | { service: string; volume: string; snapshot: string; action: 'seeded'; elapsedMs: number }
  | { service: string; volume: string; snapshot: string; action: 'missing' }
  | { service: string; volume: string; snapshot: string; action: 'captured'; elapsedMs: number }
  | { service: string; volume: string; snapshot: string; action: 'failed'; stage: 'seed' | 'capture'; reason: string };

/**
 * 서비스 컨테이너가 받은/보낸 바이트. 컨테이너 수명 누계라 기동 직후에 읽으면 "기동 중 받은 양"과 같다고 본다.
 * 한계: 이미지 빌드 단계에서 받은 것(docker build가 받는 의존성)은 컨테이너 NetIO에 잡히지 않는다.
 */
export interface ServiceNetwork {
  service: string;
  rxBytes: number;
  txBytes: number;
}

export type BootNetwork = ServiceNetwork[];

export interface StartOptions {
  signal?: AbortSignal;
  onStatus?: (event: ServiceStatusEvent) => void;
  onSnapshot?: (event: SnapshotEvent) => void;
  /**
   * 서비스가 준비된 직후 한 번 읽은 컨테이너별 수신/송신 바이트(수명 누계). 못 읽으면 부르지 않는다.
   * edge 프록시 컨테이너는 서비스 트래픽이 지나가므로 뺀다(더하면 이중 계산).
   */
  onBootNetwork?: (network: BootNetwork) => void;
  /**
   * 띄울 compose 서비스 이름(ADR-083). 주지 않으면 지금처럼 compose 파일의 모든 서비스를 띄운다(옛 동작과 호환).
   * 주면 이 목록의 서비스만 띄우고(+ 제공자가 항상 필요로 하는 edge 프록시), 목록에 없는 managed 서비스는
   * 'off' 상태로 알린다. 목록에 없는 서비스를 의존하는 서비스가 있으면 compose가 그 의존 서비스를 몰래
   * 따라 띄우지 않도록 --no-deps를 함께 쓴다(선택에서 뺀 의존 서비스를 정말로 띄우지 않기 위해서다)
   */
  services?: readonly string[];
  /**
   * 설치 스크립트가 막 쓴 실행 파일을 실행하다 생기는 것처럼 알려진 일시 오류(ETXTBSY 등, 트러블슈팅 #90)로
   * 컨테이너가 죽어 한 번 다시 띄울 때 알린다. 재시도가 성공하든 실패하든 한 번 불리며, 호출자가 이 사실을
   * 세션 로그·대화에 남기는 데 쓴다(최대 1회 — 무한 재시도는 하지 않는다)
   */
  onTransientRetry?: (event: { service: string; reason: string }) => void;
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

/**
 * 컨테이너를 화면에 묶어 보여 줄 갈래. managed는 studio.yaml에 적은 서비스,
 * supporting은 그 밖의 compose 서비스(DB 등 부가 서비스), platform은 b-studio가 붙이는 edge 프록시다
 */
export type ServiceRole = 'managed' | 'supporting' | 'platform';

/** 컨테이너 헬스체크 상태. 헬스체크를 걸지 않은 컨테이너는 없다(undefined) */
export type ContainerHealth = 'starting' | 'healthy' | 'unhealthy';

/** 샌드박스 컨테이너 하나의 자원 사용량과 상태. 부가 서비스(DB 등)도 포함한다 */
export interface ServiceUsage {
  /** compose 서비스 이름 */
  service: string;
  /** 실제 컨테이너 이름(docker) 또는 Pod 이름(kubernetes). 없으면 service와 같다고 본다 */
  containerName?: string;
  /** 이 컨테이너가 어느 갈래인지. 옛 제공자나 고정 픽스처와 호환하도록 없을 수도 있다 */
  role?: ServiceRole;
  state: ContainerState;
  /** 헬스체크를 건 컨테이너만. 걸지 않았으면 없다 */
  health?: ContainerHealth;
  /** 실행 중일 때만. 100이 CPU 1개를 다 쓴 것이다 */
  cpuPercent?: number;
  memoryBytes?: number;
  /** 한도를 걸었을 때만 */
  memoryLimitBytes?: number;
  cpuLimit?: number;
  /** 컨테이너가 받은 바이트(수명 누계). docker stats의 NetIO 수신 */
  networkRxBytes?: number;
  /** 컨테이너가 보낸 바이트(수명 누계). docker stats의 NetIO 송신 */
  networkTxBytes?: number;
  /** 다시 시작된 횟수. 읽을 수 없으면 없다 */
  restartCount?: number;
  /** 지금 실행이 시작된 시각(ISO). 화면에서 지금 시각과 차이로 가동 시간을 보여줄 때 쓴다 */
  startedAt?: string;
  /** 종료된 컨테이너의 종료 코드 */
  exitCode?: number;
  /** 메모리 한도를 넘어 커널이 종료시켰는지 */
  oomKilled: boolean;
}

/** 샌드박스 밖으로 나가려다 막힌 요청 (허용 목록에 없는 호스트, 사설 주소로 풀리는 이름 등) */
export interface EgressDenial {
  host: string;
  port?: number;
  method?: string;
  path?: string;
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

/** 호스트에서 바뀐 경로(프로젝트 루트 기준). directory·file은 새로 만든 경로, deleted는 지운 경로다 */
export interface FileChange {
  file: string;
  kind: 'directory' | 'file' | 'deleted';
}

/** 서비스 컨테이너에 변경 알림을 전달한 경로 */
export interface RelayedPath {
  service: string;
  /** 프로젝트 루트 기준 경로 */
  file: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecFileOptions {
  signal?: AbortSignal;
  /**
   * 파일은 raw 여부와 상관없이 그대로 읽고 쓴다. 가리면 복원할 데이터가 바뀌기 때문이다.
   * raw는 함께 돌려주는 stdout·stderr만 가리지 않게 한다. 파일을 사람이나 모델에게 보여 주지 않을 때만 쓴다
   */
  raw?: boolean;
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
  /** 출력의 시크릿 값은 가려서 돌려준다. input/raw는 작은 표준 입력을 넘기거나 가리지 않은 출력을 내부에서만 다룰 때 쓴다 */
  exec(service: string, command: string[], options?: { signal?: AbortSignal; input?: string; raw?: boolean }): Promise<ExecResult>;
  /** 명령의 stdout을 파일로 직접 흘린다. 큰 DB 덤프처럼 문자열로 올리면 안 되는 출력에 쓴다. 파일 내용은 가리지 않는다 */
  execToFile(service: string, command: string[], outputFile: string, options?: ExecFileOptions): Promise<ExecResult>;
  /** 파일 내용을 명령의 stdin으로 직접 흘린다. 큰 DB 덤프 복원에 쓴다. 파일 내용은 가리지 않고 넘긴다 */
  execFromFile(service: string, command: string[], inputFile: string, options?: ExecFileOptions): Promise<ExecResult>;
  /**
   * 호스트에서 만들거나 지운 파일과 폴더를, 그 경로를 마운트한 서비스 컨테이너의 파일 감시기가 알아채게 한다.
   * 파일 공유 계층(colima sshfs)이 수정 알림은 전달하지만 생성·삭제 알림은 전달하지 않아 개발 서버가 새 화면을 모르거나 지운 화면을 계속 보여 주기 때문이다(트러블슈팅 29).
   * 알린 경로를 돌려준다. 어느 서비스도 마운트하지 않은 경로는 건너뛴다
   */
  relayChanges?(changes: FileChange[], options?: { signal?: AbortSignal }): Promise<RelayedPath[]>;
  /** 텍스트의 시크릿 값을 가린다. logs()와 exec() 출력은 이미 가려져 있다 */
  redact(text: string): string;
  /** 텍스트에 값이 들어 있는 시크릿 이름 (체크포인트에 시크릿이 커밋되지 않게 확인할 때) */
  findSecrets(text: string): string[];
  /**
   * 등록한 사내 API를 studio 호출자(에이전트 도구, API 탐색기)로 부른다.
   * 샌드박스 서비스의 호출과 같은 정책·인증·응답 가림·감사 기록을 거친다. via는 감사 기록에 남길 경로다
   */
  callExternal(name: string, request: ExternalCallRequest, options: { via: string; signal?: AbortSignal }): Promise<ExternalCallResult>;
  /**
   * 서비스 하나를 켜거나 끈다(ADR-083, 서비스 선택). managed·supporting 어느 쪽이든 쓸 수 있다.
   * 켤 때는 이미지를 빌드하고(managed 서비스가 소스를 바꿨을 수 있어서) 컨테이너를 만들어 기동하되,
   * 다른 서비스를 따라 띄우지 않는다(--no-deps). 끌 때는 컨테이너를 멈추기만 하고 지우지 않는다(볼륨이 남는다).
   * 준비 판정(ready)은 하지 않는다 — managed 서비스를 켠 뒤 화면에 반영하려면 restart()로 기다린다.
   * 구현하지 않는 제공자는 undefined로 둔다(호출자가 지원 여부를 안내한다)
   */
  setServiceRunning?(service: string, running: boolean, options?: { signal?: AbortSignal }): Promise<void>;
  /**
   * edge 프록시와 넘긴 서비스의 컨테이너가 실제로 떠 있는지 보고, 없으면 이 샌드박스의 compose 프로젝트
   * 안에서만(다른 프로젝트는 건드리지 않고) 다시 올린다(트러블슈팅 86, ADR-143). 세션 상태는 ready인데
   * studio 밖에서(사람이나 다른 과정이) 컨테이너를 지운 경우를 겨냥한다 — 이미지를 다시 빌드하지 않는다
   * (코드가 바뀐 게 아니라 컨테이너가 사라진 것뿐이라서 restart()의 force-recreate는 쓰지 않는다).
   * 구현하지 않는 제공자는 undefined로 둔다(호출자가 건너뛴다).
   */
  ensureInfra?(services: readonly string[], options?: { signal?: AbortSignal }): Promise<InfraCheckResult>;
  destroy(): Promise<void>;
}

/** ensureInfra()의 확인·복구 결과 */
export interface InfraCheckResult {
  /** 지금 모든 핵심 컨테이너가 떠 있는지(복구를 시도했다면 복구된 뒤 기준) */
  ok: boolean;
  /** 이번 호출에서 다시 올려 복구한 서비스 이름(없었으면 빈 배열) */
  recovered: string[];
  /** ok가 false일 때, 다시 올려도 여전히 없는 서비스 */
  missing?: string[];
  /** ok가 false일 때 원인(도구 결과·화면 안내에 그대로 쓴다) */
  reason?: string;
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
