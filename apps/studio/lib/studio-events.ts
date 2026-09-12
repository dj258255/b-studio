import type { AgentEvent, AgentUsage, Checkpoint, DatabaseState, GitHostKind, ServiceCheck, VerificationReport } from '@b-studio/agent';
import type { ServiceUsage } from '@b-studio/sandbox';

/** 브라우저와 서버가 주고받는 형태. 서버 전용 객체(샌드박스, 프로세스)는 담지 않는다 */

export type SessionStatus = 'starting' | 'ready' | 'failed' | 'stopped';
/** api: 모델 API 키, claude-code: 이 PC에 로그인한 Claude Code, demo: 준비된 스크립트 */
export type SessionMode = 'api' | 'claude-code' | 'demo';
/** copy: 세션마다 만든 작업 복사본에서 작업한다. local: 사용자의 프로젝트 폴더에서 바로 작업한다 */
export type WorkspaceKind = 'copy' | 'local';
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
  /** 값의 형태로 가리는 패턴 이름 */
  maskPatterns: string[];
  /** 인증 헤더를 b-studio가 붙이는지 */
  authenticated: boolean;
}

export interface SessionSnapshot {
  id: string;
  projectId: string;
  projectName: string;
  /** 에이전트와 샌드박스가 쓰는 폴더. 작업 복사본이거나, 로컬 폴더 세션이면 사용자의 프로젝트 폴더다 */
  workDir: string;
  /** 없으면 copy (이 필드가 생기기 전에 만든 세션) */
  workspace?: WorkspaceKind;
  /** 로컬 폴더 세션의 체크포인트 저장소와 세션 상태를 두는 폴더. 사용자 폴더의 .git과 섞이지 않게 작업 폴더 밖에 둔다 */
  stateDir?: string;
  status: SessionStatus;
  error?: string;
  mode: SessionMode;
  /** 세션을 만든 사람. 인증을 켜면 만든 사람과 관리자만 세션을 바꿀 수 있다 */
  owner?: string;
  running: boolean;
  /** 처리 중인 요청을 멈추고 변경을 되돌리는 중이다. user: 사용자가 취소함, budget: 세션 토큰 한도에 도달함 */
  cancelling?: 'user' | 'budget';
  /** 이 세션의 요청들이 쓴 모델 토큰 합계. 취소하거나 실패한 요청도 그때까지 쓴 양을 더한다 */
  tokens?: AgentUsage;
  /** 운영자가 정한 세션 토큰 한도(B_STUDIO_SESSION_TOKEN_LIMIT). 없으면 한도가 없다 */
  tokenLimit?: number;
  services: ServiceView[];
  /** 등록한 사내 API */
  externals?: ExternalApiView[];
  /** 샌드박스 컨테이너의 Docker 런타임 (예: gVisor의 runsc). 없으면 데몬 기본값 */
  runtime?: string;
  /** 데모 모드에서 다음에 실행할 수 있는 요청 */
  nextDemoRequest?: string;
  /** 데모 모드에서 다음 요청을 보내기 전에 질문 모드로 물어볼 수 있는 준비된 질문 */
  nextDemoQuestion?: string;
  /** 게이트를 통과해 남긴 체크포인트. 최신이 먼저 온다 */
  checkpoints: Checkpoint[];
  /** 원본 프로젝트가 Git 저장소일 때만 있다 */
  repository?: RepositoryView;
  /** 가장 최근에 잰 컨테이너별 자원 사용량 */
  usage?: { at: string; services: ServiceUsage[] };
  /** 프로젝트 폴더의 파일이 바뀔 때마다 늘어난다. 서비스 안에서 명령이 만든 파일도 코드 화면이 다시 불러오는 기준이다 */
  fileRevision?: number;
  /** 이 세션에서 시작한 운영 배포나 되돌리기가 진행 중이다. lines는 최근 진행 줄 */
  deploying?: DeployingView;
}

export type DeployAction = 'deploy' | 'rollback';

export interface DeployingView {
  action: DeployAction;
  /** 배포할 체크포인트나 되돌릴 릴리스 */
  target: string;
  startedAt: string;
  by?: string;
  lines: string[];
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

/** 코드 화면의 파일 목록. 생성물과 .env는 에이전트 작업 공간과 같은 규칙으로 뺀다 */
export interface CodeTree {
  /** 이번 쪽의 파일. 찾는 말을 넘기면 경로가 맞는 파일만 담는다 */
  files: string[];
  /** files가 시작하는 위치 */
  offset: number;
  /** 조건에 맞는 전체 파일 수 */
  total: number;
  /** 마지막 체크포인트 이후 바뀐 파일. 삭제한 파일은 files에 없다 */
  changes: Array<{ file: string; change: 'added' | 'modified' | 'deleted' }>;
  /** 파일이 아주 많아 전체를 세지 못한 경우 */
  truncated: boolean;
}

/** 내용 찾기에서 맞은 한 줄 */
export interface CodeSearchMatch {
  line: number;
  text: string;
  /** text 안에서 맞은 자리 (가린 값 때문에 자리를 찾지 못하면 0) */
  start: number;
  length: number;
}

export interface CodeSearch {
  query: string;
  results: Array<{ file: string; matches: CodeSearchMatch[] }>;
  /** 결과나 파일 수 상한에 걸려 멈춘 경우 */
  truncated: boolean;
}

/** 코드 화면에서 연 파일. 내용과 diff의 시크릿 값은 가려서 보낸다 */
export interface CodeFile {
  path: string;
  /** 삭제한 파일이거나 바이너리면 없다 */
  content?: string;
  binary?: boolean;
  change?: 'added' | 'modified' | 'deleted';
  /** 마지막 체크포인트 대비 변경 내용 (수정·삭제한 파일) */
  patch?: string;
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
  owner?: string;
  workspace: WorkspaceKind;
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
  /** 파일 변경을 모아 알린다. 사용량처럼 기록에 쌓지 않고 스냅샷의 최신 값만 바꾼다 */
  | { type: 'files_changed'; revision: number }
  /** by: 요청을 보낸 사람. intent가 ask면 파일을 바꾸지 않는 질문이다 */
  | { type: 'run_started'; runId: string; request: string; by?: string; intent?: 'ask' }
  | { type: 'agent'; runId: string; event: Exclude<AgentEvent, { type: 'tokens' }> }
  /** API 키 모드는 모델 응답마다, 로컬 로그인 계정 모드는 턴을 끝낼 때마다 온다. 세션 합계를 함께 보내 기록을 다시 재생해도 두 번 더하지 않는다 */
  | { type: 'tokens'; runId: string; usage: AgentUsage; sessionTokens: AgentUsage }
  /** reason이 없으면 사용자가 취소했다 */
  | { type: 'run_cancelling'; runId: string; reason?: 'budget' }
  | {
      type: 'run_finished';
      runId: string;
      /** cancelled: 사용자가 취소했거나 세션 토큰 한도에 도달해 이번 요청의 변경을 되돌렸다 */
      status: 'done' | 'failed' | 'error' | 'cancelled';
      summary: string;
      turns?: number;
      /** 이번 요청이 쓴 토큰. 모델을 부르지 않았으면 없다 */
      usage?: AgentUsage;
      sessionTokens?: AgentUsage;
      nextDemoRequest?: string;
      nextDemoQuestion?: string;
    }
  | { type: 'checkpoint'; runId: string; checkpoint: Checkpoint }
  /**
   * 로컬 폴더 세션에서 스튜디오 밖(IDE 등)에서 바꾼 파일을 체크포인트로 남겼다. 검증 게이트는 거치지 않았다.
   * request: 요청을 시작하기 전에, resume: 중지한 세션을 이어서 작업하기 전에 남겼다
   */
  | { type: 'local_edits_saved'; checkpoint: Checkpoint; reason: 'request' | 'resume' }
  | {
      type: 'reverted';
      runId: string;
      /** 게이트 실패가 아니라 사용자가 취소해서 되돌렸다 */
      cancelled?: boolean;
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
      nextDemoQuestion?: string;
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
    }
  | { type: 'deploy_started'; action: DeployAction; target: string; at: string; by?: string }
  /** 기록에 쌓지 않는다. 새로 연결한 브라우저는 스냅샷의 deploying.lines에서 최근 줄을 받는다 */
  | { type: 'deploy_log'; line: string }
  | {
      type: 'deploy_finished';
      action: DeployAction;
      release: string;
      /** 배포한 체크포인트 설명 */
      label: string;
      /** 서비스 이름 → 운영 주소 */
      urls: Record<string, string>;
      previous?: string;
    }
  | { type: 'deploy_failed'; action: DeployAction; target: string; error: string; detail?: string };

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
