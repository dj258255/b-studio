import type { AgentEvent, Checkpoint, DatabaseState, GitHostKind, ServiceCheck } from '@b-studio/agent';

/** 브라우저와 서버가 주고받는 형태. 서버 전용 객체(샌드박스, 프로세스)는 담지 않는다 */

export type SessionStatus = 'starting' | 'ready' | 'failed' | 'stopped';
/** api: 모델 API 키, claude-code: 이 PC에 로그인한 Claude Code, demo: 준비된 스크립트 */
export type SessionMode = 'api' | 'claude-code' | 'demo';
export type ServiceState = 'starting' | 'probing' | 'ready' | 'failed';

export interface ServiceView {
  name: string;
  template: string;
  preview: 'browser' | 'openapi' | 'logs';
  state: ServiceState;
  /** 준비된 서비스의 주소. 재시작하면 포트가 바뀐다 */
  url?: string;
  detail?: string;
  hasContract: boolean;
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
  /** 데모 모드에서 다음에 실행할 수 있는 요청 */
  nextDemoRequest?: string;
  /** 게이트를 통과해 남긴 체크포인트. 최신이 먼저 온다 */
  checkpoints: Checkpoint[];
  /** 원본 프로젝트가 Git 저장소일 때만 있다 */
  repository?: RepositoryView;
}

/** 원본이 Git 저장소인 세션의 원격 연동 상태 */
export interface RepositoryView {
  /** 자격 증명을 뺀 원격 주소 또는 로컬 경로 */
  remote: string;
  kind: GitHostKind;
  base: string;
  branch: string;
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

export type StudioEvent =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'status'; status: SessionStatus; error?: string }
  | { type: 'service'; service: string; state: ServiceState; url?: string; detail?: string }
  | { type: 'log'; service: string; text: string; at: string }
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
}
