import type { AgentEvent, Checkpoint, DatabaseState, GitHostKind, ServiceCheck, VerificationReport } from '@b-studio/agent';
import type { ServiceUsage } from '@b-studio/sandbox';

/** 브라우저와 서버가 주고받는 형태. 서버 전용 객체(샌드박스, 프로세스)는 담지 않는다 */

export type SessionStatus = 'starting' | 'ready' | 'failed' | 'stopped';
/** api: 모델 API 키, claude-code: 이 PC에 로그인한 Claude Code, demo: 준비된 스크립트 */
export type SessionMode = 'api' | 'claude-code' | 'demo';
/** stopped: 샌드박스를 중지했거나 이전 스튜디오 프로세스가 남긴 세션이라 서비스가 실행되고 있지 않다 */
export type ServiceState = 'starting' | 'probing' | 'ready' | 'failed' | 'stopped';

export interface ServiceView {
  name: string;
  template: string;
  preview: 'browser' | 'openapi' | 'logs';
  state: ServiceState;
  /** 준비된 서비스의 주소. 재시작하면 포트가 바뀐다 */
  url?: string;
  /** 원격 미리보기 게이트웨이를 켰을 때 다른 PC의 브라우저에서도 열리는 주소. 재시작해도 바뀌지 않는다 */
  previewUrl?: string;
  detail?: string;
  hasContract: boolean;
}

/** 등록한 사내 API. 샌드박스 안에서는 http://<name>/으로 부르고 edge가 정책을 적용한다 */
export interface ExternalApiView {
  name: string;
  baseUrl: string;
  /** 사람이 읽을 허용 규칙 요약 */
  access: string[];
  mask: string[];
  /** 인증 헤더를 b-studio가 붙이는지 */
  authenticated: boolean;
}

export interface SessionSnapshot {
  id: string;
  projectId: string;
  projectName: string;
  /** 세션용 작업 복사본 위치 */
  workDir: string;
  status: SessionStatus;
  error?: string;
  mode: SessionMode;
  running: boolean;
  services: ServiceView[];
  /** 등록한 사내 API */
  externals?: ExternalApiView[];
  /** 샌드박스 컨테이너의 Docker 런타임 (예: gVisor의 runsc). 없으면 데몬 기본값 */
  runtime?: string;
  /** 데모 모드에서 다음에 실행할 수 있는 요청 */
  nextDemoRequest?: string;
  /** 게이트를 통과해 남긴 체크포인트. 최신이 먼저 온다 */
  checkpoints: Checkpoint[];
  /** 원본 프로젝트가 Git 저장소일 때만 있다 */
  repository?: RepositoryView;
  /** 가장 최근에 잰 컨테이너별 자원 사용량 */
  usage?: { at: string; services: ServiceUsage[] };
}

/** 원본이 Git 저장소인 세션의 원격 연동 상태 */
export interface RepositoryView {
  /** 자격 증명을 뺀 원격 주소 또는 로컬 경로 */
  remote: string;
  kind: GitHostKind;
  base: string;
  branch: string;
  /** 모노레포 하위 폴더 프로젝트면 저장소 루트 기준 폴더 경로 */
  subdir?: string;
  /** 원본에서 커밋하지 않아 세션에 들어가지 않은 변경 수 */
  sourceDirtyFiles: number;
  /** 스튜디오가 마지막으로 올린 커밋 */
  pushedSha?: string;
  pullRequestUrl?: string;
  /** 토큰이 없을 때 사람이 직접 PR을 만드는 페이지 */
  compareUrl?: string;
  canCreatePullRequest: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  services: Array<{ name: string; template: string; preview: string }>;
  error?: string;
}

/** 원격 세션 브랜치에서 가져온 커밋 (리뷰어가 올린 커밋 등) */
export interface RemoteCommitView {
  shortSha: string;
  subject: string;
  author: string;
}

/** 홈 화면의 세션 목록. 중지된 세션도 작업 복사본이 남아 있어 이어서 작업할 수 있다 */
export interface SessionSummary {
  id: string;
  projectName: string;
  status: SessionStatus;
  mode: SessionMode;
  checkpoints: number;
  lastRequest?: string;
  updatedAt: string;
}

export type StudioEvent =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'status'; status: SessionStatus; error?: string }
  | { type: 'service'; service: string; state: ServiceState; url?: string; previewUrl?: string; detail?: string }
  | { type: 'log'; service: string; text: string; at: string }
  /** 몇 초마다 온다. 기록에 쌓지 않고 스냅샷의 최신 값만 바꾼다 */
  | { type: 'usage'; at: string; services: ServiceUsage[] }
  | { type: 'run_started'; runId: string; request: string }
  | { type: 'agent'; runId: string; event: AgentEvent }
  | {
      type: 'run_finished';
      runId: string;
      status: 'done' | 'failed' | 'error';
      summary: string;
      turns?: number;
      nextDemoRequest?: string;
    }
  | { type: 'checkpoint'; runId: string; checkpoint: Checkpoint }
  | {
      type: 'reverted';
      runId: string;
      files: string[];
      patch: string;
      restarted: ServiceCheck[];
      databases: DatabaseState[];
      /** 재시작 전에 샌드박스가 바뀐 파일을 보게 될 때까지 기다린 결과 */
      sync?: { elapsedMs: number } | { error: string };
    }
  | { type: 'restore_started'; checkpoint: Checkpoint }
  | {
      type: 'restored';
      checkpoint: Checkpoint;
      files: string[];
      restarted: ServiceCheck[];
      /** 데이터베이스를 체크포인트 시점으로 맞춘 결과 */
      databases: DatabaseState[];
      sync?: { elapsedMs: number } | { error: string };
      checkpoints: Checkpoint[];
      nextDemoRequest?: string;
    }
  | { type: 'restore_failed'; checkpoint: Checkpoint; error: string }
  /** 중지된 세션을 새 샌드박스에서 마지막 체크포인트부터 다시 띄웠다 */
  | {
      type: 'resumed';
      checkpoint: Checkpoint;
      /** 끝내지 못한 요청이 남겨 버린, 체크포인트에 없던 변경 */
      discarded: string[];
      databases: DatabaseState[];
      restarted: ServiceCheck[];
    }
  | { type: 'remote_sync_started' }
  | {
      type: 'remote_synced';
      /** up-to-date면 가져온 커밋이 없다. picked는 되돌린 기록이라 원격에만 있던 변경만 옮겨 왔다는 뜻이다 */
      status: 'up-to-date' | 'merged' | 'picked';
      commits: RemoteCommitView[];
      files: string[];
      checkpoint?: Checkpoint;
      report?: VerificationReport;
      checkpoints: Checkpoint[];
      repository: RepositoryView;
    }
  | {
      type: 'remote_sync_failed';
      error: string;
      /** 충돌한 파일. 작업 복사본은 가져오기 전 그대로다 */
      conflicts?: string[];
      commits?: RemoteCommitView[];
      files?: string[];
      /** 가져온 변경이 검증을 통과하지 못해 되돌렸을 때의 게이트 결과 */
      report?: VerificationReport;
      restarted?: ServiceCheck[];
      checkpoints?: Checkpoint[];
    }
  | {
      type: 'exported';
      repository: RepositoryView;
      sha: string;
      commits: number;
      /** 되돌린 기록으로 원격 브랜치를 맞췄는지 */
      forced: boolean;
      pullRequest?: { url: string; created: boolean };
      /** 브랜치는 올렸지만 PR을 만들지 못한 이유 */
      pullRequestError?: string;
    };

export type ExportResult = Omit<Extract<StudioEvent, { type: 'exported' }>, 'type'>;

export interface ProxyResponse {
  status: number;
  contentType: string | null;
  body: string;
  truncated: boolean;
  durationMs: number;
  /** 등록한 사내 API를 부른 경우의 정책 결과 */
  policy?: { decision: 'allow' | 'deny'; masked: number; reason?: string };
}
