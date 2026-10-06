import type { AgentEvent, AgentUsage, Checkpoint, DatabaseState, DiscardBackup, Effort, GitHostKind, PrReviewFinding, RunMetrics, ServiceCheck, VerificationReport } from '@b-studio/agent';
import type { BootNetwork, ServiceUsage } from '@b-studio/sandbox';

/** 브라우저와 서버가 주고받는 형태. 서버 전용 객체(샌드박스, 프로세스)는 담지 않는다 */

/**
 * idle: 샌드박스를 아직 켜지 않았다(첫 만들기 요청·지금 켜기로 켠다). 작업 공간과 체크포인트는 준비돼 있다.
 * starting: 켜는 중. ready: 켜짐. failed: 켜지 못함. stopped: 중지했다(이어서 작업하면 다시 켠다)
 */
export type SessionStatus = 'idle' | 'starting' | 'ready' | 'failed' | 'stopped';
/** api: 모델 API 키, claude-code: 이 PC에 로그인한 Claude Code, codex: 이 PC에 로그인한 Codex CLI, commandcode: 이 PC에 로그인한 Command Code, opencode: 이 PC에 설치된 OpenCode CLI, gemini: 이 PC에 로그인한 Gemini CLI, demo: 준비된 스크립트 */
export type SessionMode = 'api' | 'claude-code' | 'codex' | 'commandcode' | 'opencode' | 'gemini' | 'demo';
/** copy: 세션마다 만든 작업 복사본에서 작업한다. local: 사용자의 프로젝트 폴더에서 바로 작업한다 */
export type WorkspaceKind = 'copy' | 'local';
/**
 * stopped: 샌드박스를 중지했거나 이전 스튜디오 프로세스가 남긴 세션이라 서비스가 실행되고 있지 않다.
 * off: 서비스 선택(ADR-083)에서 사용자가 꺼 둬 이번 기동에서 띄우지 않았다 — 실패가 아니다, 언제든 켤 수 있다
 */
export type ServiceState = 'starting' | 'probing' | 'ready' | 'failed' | 'stopped' | 'off';

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

/** 디자인(Figma) 연동 상태. 토큰 값은 넣지 않고 설정 여부만 알린다 */
export interface DesignView {
  /** 지금 쓰는 Figma 파일 URL. 세션 설정이 studio.yaml보다 우선한다 */
  fileUrl: string;
  fileKey: string;
  /** URL이 어디서 왔는지 */
  from: 'session' | 'studio.yaml';
  /** 서버에 FIGMA_TOKEN이 설정돼 있는지 */
  hasToken: boolean;
}

/** 에이전트가 되물은 질문. 사용자가 답을 보내면 지운다 */
export interface PendingQuestion {
  runId: string;
  question: string;
  options: string[];
  allowOther: boolean;
  /** 에이전트가 다른 방식(나눠서 병렬·여러 명 비교)을 제안했으면 그 방식과 넘길 요청(ADR-068) */
  proposal?: { mode: 'split' | 'fleet'; request: string };
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
  /**
   * 이 세션이 실제로 쓰는 백엔드(B_STUDIO_BACKENDS로 고른 값). 없으면 mode를 쓴다(이 필드가 생기기 전 기록).
   * mode는 세션을 만들 때의 서버 모드라, 레인이 백엔드를 고르면 backend가 그 값이고 mode와 다를 수 있다
   */
  backend?: SessionMode;
  /**
   * 이 세션에 고정한 모델. 대화 입력창의 모델 선택(#271 다음 요청)으로 바꾼다.
   * api는 모델 레지스트리 id, claude-code·codex는 CLI에 넘기는 모델 이름(별칭), commandcode·opencode·gemini는 그 CLI의 모델 id다.
   * 없으면 api는 요청마다 라우터가 고르고, 나머지는 계정 기본 모델을 쓴다
   */
  modelId?: string;
  /**
   * 이 세션에 고정한 노력(추론 강도) 단계. 백엔드마다 지원 여부·값이 다르다(model-picker.ts의 effortSupportedFor).
   * 없으면 러너·클라이언트의 기본값을 그대로 쓴다(claude-code·api는 'high')
   */
  effort?: Effort;
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
  /** 프로젝트 studio.yaml에 deploy 절이 있다. 없으면 실행 탭의 "배포" 하위 탭을 숨긴다(로컬 폴더 모드 기본값) */
  hasDeploy?: boolean;
  /** 디자인(Figma) 연동. 설정하지 않았으면 없다 */
  design?: DesignView;
  /** 마지막 실행이 되묻고 멈췄을 때 남긴 질문. 다음 요청을 보내면 지운다 */
  pendingQuestion?: PendingQuestion;
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
  /** 서비스가 준비된 직후 한 번 읽은 컨테이너별 수신/송신 바이트(수명 누계). 못 읽으면 없다 */
  bootNetwork?: BootNetwork;
  /** 프로젝트 폴더의 파일이 바뀔 때마다 늘어난다. 서비스 안에서 명령이 만든 파일도 코드 화면이 다시 불러오는 기준이다 */
  fileRevision?: number;
  /** "테스트" 탭(ADR-084). 테스트를 실행하거나 게이트가 새 결과를 모을 때마다 늘어난다. 탭이 이 값을 보고 다시 불러온다 */
  testsRevision?: number;
  /** 지금 테스트를 실행 중인 서비스 이름. 다른 브라우저 탭에서도 "실행 중"을 보여 준다 */
  testsRunning?: string[];
  /** 이 세션에서 시작한 운영 배포나 되돌리기가 진행 중이다. lines는 최근 진행 줄 */
  deploying?: DeployingView;
  /** PR 자동 리뷰 라운드(ADR-074) 진행 상태. PR을 아직 만들지 않았거나 리뷰를 한 번도 돌리지 않았으면 없다 */
  review?: ReviewStateView;
}

/**
 * PR 자동 리뷰 라운드 한 번. running: 리뷰어를 부르는 중. blocked_continue: 차단·중요 지적이 있고 라운드가 남아 고치는 중.
 * fix_failed: 고침 요청이 검증 게이트를 통과하지 못해 멈췄다. resolved_by_human: 라운드 상한(blocked_capped)에 걸렸지만
 * 사람이 막는 지적을 모두 오탐으로 닫아 더는 막지 않는다(resolveReviewFinding, 과제 67-b). 댓글 올리기 실패는 라운드를
 * 막지 않고 commentError에만 남는다
 */
export type ReviewRoundStatus = 'running' | 'passed' | 'blocked_continue' | 'blocked_capped' | 'resolved_by_human' | 'fixing' | 'fix_failed' | 'error';

/** 사람이 지적 하나를 오탐으로 닫으며 남긴 결정(resolveReviewFinding, 과제 67-b). findings 배열의 인덱스로 키를 삼는다 */
export interface ReviewFindingResolution {
  reason: string;
  by?: string;
  at: string;
}

export interface ReviewRoundView {
  round: number;
  status: ReviewRoundStatus;
  findings?: PrReviewFinding[];
  /** 이 라운드의 리뷰어 호출이 쓴 토큰(고침 요청 자체의 토큰은 세션의 보통 실행 토큰에 잡힌다) */
  tokens?: AgentUsage;
  commentUrl?: string;
  commentError?: string;
  /** 고침 요청이 만든 체크포인트(성공했을 때만) */
  fixCheckpoint?: { sha: string; shortSha: string };
  error?: string;
  startedAt: string;
  finishedAt?: string;
  /** 사람이 오탐으로 닫은 지적들. findings 배열 인덱스 → 결정(과제 67-b) */
  humanResolutions?: Record<number, ReviewFindingResolution>;
  /**
   * 이 라운드가 리뷰한 diff의 시작·끝 커밋(전체 sha). 이미 열린 PR에 새 커밋이 쌓여 그 범위만 다시 본
   * 라운드에만 있다(continueReviewAfterNewCommits) — 처음 PR을 열 때의 리뷰는 base...head 전체라 없다.
   * 다음에 또 새 커밋이 쌓이면 이 라운드들 중 가장 최근 것의 headSha가 다음 리뷰의 since가 된다
   */
  sinceSha?: string;
  headSha?: string;
}

/** state: running(진행 중) · passed(리뷰 통과) · capped(라운드 상한) · resolved(라운드 상한에 걸렸지만 사람이 확인해 더는 막지 않음) · stopped(멈춤, 오류·고침 실패) */
export interface ReviewStateView {
  state: 'running' | 'passed' | 'capped' | 'resolved' | 'stopped';
  maxRounds: number;
  rounds: ReviewRoundView[];
  /** 사람이 명시적으로 고른 리뷰어 모델(api 레지스트리 id). 없으면 이 세션의 평소 백엔드·모델로 리뷰했다 */
  reviewerModelId?: string;
  /**
   * 설계 파이프라인(ADR-100): 이 리뷰의 모델 계열이 구현 모델 계열과 다른지. same-family면 "같은 계열
   * 검토(독립성 낮음)"로 보여 주고 파이프라인의 "성공" 판정에 세지 않는다. 계열을 모르면 unknown
   */
  independence?: 'independent' | 'same-family' | 'unknown';
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
  /** 원격 저장소 + 토큰이 있어 작업 분해 계획의 이슈를 올릴 수 있는가 (작업 분해 화면에서만 채운다) */
  canPublishIssues?: boolean;
  error?: string;
  /** 등록한 폴더(ADR-067)면 그 절대 경로. 예제 폴더 아래 프로젝트는 없다 */
  folder?: string;
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
  projectId: string;
  projectName: string;
  status: SessionStatus;
  /** 세션을 만들 때의 서버 모드 */
  mode: SessionMode;
  /** 실제로 쓰는 백엔드. 없으면 mode(레거시) */
  backend?: SessionMode;
  owner?: string;
  workspace: WorkspaceKind;
  checkpoints: number;
  lastRequest?: string;
  updatedAt: string;
}

export type StudioEvent =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'status'; status: SessionStatus; error?: string }
  /** 플랫폼이 대화에 남기는 한 줄 안내(예: 샌드박스를 켜는 중). 모델 발언이 아니다 */
  | { type: 'notice'; text: string; at: string }
  | { type: 'service'; service: string; state: ServiceState; url?: string; previewUrl?: string; detail?: string }
  /** 서비스가 준비된 직후 기동 중 받은/보낸 바이트를 남긴다. 컨테이너 수명 누계이고, edge 프록시는 뺀다 */
  | { type: 'boot_network'; at: string; network: BootNetwork }
  /** 세션의 디자인(Figma) 설정이 바뀌었다. URL을 지우면 design이 없다 */
  | { type: 'design'; design?: DesignView }
  /** 대화 입력창에서 이 세션이 쓸 모델이나 노력 단계를 바꿨다. 없으면 각각 "기본"(계정·레지스트리 기본)으로 되돌린 것이다 */
  | { type: 'model'; modelId?: string; effort?: Effort }
  /** 에이전트가 만들기 전에 선택지로 되물었다. 실행은 이 질문을 남기고 끝난다. 사용자가 답을 다음 요청으로 보낸다 */
  | { type: 'question'; runId: string; question: string; options: string[]; allowOther: boolean; proposal?: { mode: 'split' | 'fleet'; request: string } }
  /** 사람이 제안을 받아 다른 방식으로 넘겼다. 대화를 이어 가지 않고 질문 카드만 치운다(ADR-068) */
  | { type: 'question_dismissed'; runId: string; to: 'split' | 'fleet'; href: string }
  | { type: 'log'; service: string; text: string; at: string }
  /** 몇 초마다 온다. 기록에 쌓지 않고 스냅샷의 최신 값만 바꾼다 */
  | { type: 'usage'; at: string; services: ServiceUsage[] }
  /** 파일 변경을 모아 알린다. 사용량처럼 기록에 쌓지 않고 스냅샷의 최신 값만 바꾼다 */
  | { type: 'files_changed'; revision: number }
  /** "테스트" 탭(ADR-084)이 다시 불러올 때가 됐다는 신호. 사용량처럼 기록에 쌓지 않고 스냅샷의 최신 값만 바꾼다 */
  | { type: 'tests_changed'; revision: number; running: string[] }
  /** by: 요청을 보낸 사람. intent가 ask면 파일을 바꾸지 않는 질문이다 */
  | { type: 'run_started'; runId: string; request: string; by?: string; intent?: 'ask'; /** 요청을 받은 시각(ISO). 이 필드가 생기기 전 기록에는 없다 */ at?: string }
  /** 계획-실행 분리(ADR-075). 실행 전에 계획 모델이 쓴 짧은 계획. 화면은 "계획(모델명)" 접기 블록으로 보여준다 */
  | { type: 'plan_brief'; runId: string; model: string; text: string; usage: AgentUsage; durationMs: number }
  | { type: 'agent'; runId: string; event: Exclude<AgentEvent, { type: 'tokens' }> }
  /** 실행 중 보낸 지시를 큐에 넣었다. 러너가 이어서 쓰면 agent 이벤트 steer_applied로 온다 */
  | { type: 'steer_queued'; runId: string; text: string }
  /** 실행이 끝났는데 적용되지 못한 지시. 화면에서 다시 보내라고 알린다 */
  | { type: 'steer_dropped'; runId: string; texts: string[] }
  /** API 키 모드는 모델 응답마다, 로컬 로그인 계정 모드는 턴을 끝낼 때마다 온다. 세션 합계를 함께 보내 기록을 다시 재생해도 두 번 더하지 않는다 */
  | { type: 'tokens'; runId: string; usage: AgentUsage; sessionTokens: AgentUsage }
  /** reason이 없으면 사용자가 취소했다 */
  | { type: 'run_cancelling'; runId: string; reason?: 'budget' }
  | {
      type: 'run_finished';
      runId: string;
      /** cancelled: 사용자가 취소했거나 세션 토큰 한도에 도달해 이번 요청의 변경을 되돌렸다. awaiting_input: 답을 기다린다 */
      status: 'done' | 'failed' | 'error' | 'cancelled' | 'awaiting_input';
      summary: string;
      turns?: number;
      /** 이번 요청이 쓴 토큰. 모델을 부르지 않았으면 없다 */
      usage?: AgentUsage;
      /** 실행 지표. 모델을 부르지 않았거나 로컬 Claude Code 러너가 모델 호출을 직접 보지 못해 없을 수 있다 */
      metrics?: RunMetrics;
      /** 요청을 시작한 뒤 끝난 시각까지의 벽시계 시간 */
      durationMs?: number;
      /** 가볍게 확인(light) 실행이면 'light'. 테스트·화면 확인·동시 요청·리뷰를 건너뛰었다 */
      verify?: 'light';
      /** 가볍게 확인이 건너뛴 검증 단계(프로젝트 토큰 보고서가 이 수를 센다). light가 아니면 없다 */
      skippedStages?: string[];
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
  /**
   * 요청·실행과 무관하게 문서만(docs/** 등) 검증 게이트 없이 체크포인트로 남겼다(ADR-096).
   * 요구사항 저장, 이슈 발행·충돌 해결 사이드카가 남긴다. checkpoint.verify === 'docs'다
   */
  | { type: 'docs_checkpoint'; checkpoint: Checkpoint }
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
      /** 버린 변경이 있으면 되살릴 수 있게 남긴 백업(ADR-099). files가 비어 있지 않은데 이것도 없으면 백업하지 못했다는 뜻이다 */
      backup?: DiscardBackup;
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
      /** 되돌리기 전에 아직 체크포인트로 남기지 않은 변경이 있었으면 되살릴 수 있게 남긴 백업(ADR-099) */
      backup?: DiscardBackup;
    }
  | { type: 'restore_failed'; checkpoint: Checkpoint; error: string }
  /** 중지된 세션을 새 샌드박스에서 마지막 체크포인트부터 다시 띄웠다 */
  | {
      type: 'resumed';
      checkpoint: Checkpoint;
      /** 끝내지 못한 요청이 남겨 버린, 체크포인트에 없던 변경(문서는 먼저 체크포인트로 지키고 남은 것만 들어온다) */
      discarded: string[];
      databases: DatabaseState[];
      restarted: ServiceCheck[];
      /** discarded가 있으면 되살릴 수 있게 남긴 백업(ADR-099) */
      backup?: DiscardBackup;
    }
  /** discarded·reverted·restore가 남긴 백업을 작업 복사본에 되살렸다(ADR-099) */
  | { type: 'backup_restored'; backupId: string; files: string[]; restarted: ServiceCheck[] }
  | { type: 'backup_restore_failed'; backupId: string; error: string }
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
      /** 되돌리기 전에 아직 체크포인트로 남기지 않은 변경이 있었으면 되살릴 수 있게 남긴 백업(ADR-099) */
      backup?: DiscardBackup;
    }
  /** main 따라잡기(ADR-076)를 시작했다 */
  | { type: 'base_sync_started' }
  | {
      type: 'base_synced';
      /** up-to-date면 따라잡을 커밋이 없었다 */
      status: 'up-to-date' | 'merged';
      /** 이번에 병합으로 따라잡은 기준 브랜치 커밋 수 */
      commits: number;
      files: string[];
      checkpoint?: Checkpoint;
      report?: VerificationReport;
      checkpoints: Checkpoint[];
      repository: RepositoryView;
    }
  | {
      type: 'base_sync_failed';
      error: string;
      /** 충돌한 파일. 작업 복사본은 병합을 시작하기 전 그대로다 */
      conflicts?: string[];
      /**
       * "에이전트에게 충돌 해결 맡기기"로 시도했을 때만 채운다. 자동으로 보내지 않고 화면이 대화 입력창에 미리 채워
       * 사람이 보고 다듬어 보내게 한다(ADR-076의 안전한 대안 — docs/decisions.md 참고)
       */
      agentRequest?: string;
      files?: string[];
      /** 병합한 변경이 검증을 통과하지 못해 되돌렸을 때의 게이트 결과 */
      report?: VerificationReport;
      restarted?: ServiceCheck[];
      checkpoints?: Checkpoint[];
      /** 되돌리기 전에 아직 체크포인트로 남기지 않은 변경이 있었으면 되살릴 수 있게 남긴 백업(ADR-099) */
      backup?: DiscardBackup;
    }
  | {
      type: 'exported';
      repository: RepositoryView;
      sha: string;
      commits: number;
      /** 되돌린 기록으로 원격 브랜치를 맞췄는지 */
      forced: boolean;
      /** updated: true면 새로 만들지 않고 이미 열려 있던 PR의 본문을 지금 상태로 다시 썼다(제목은 그대로 둔다) */
      pullRequest?: { url: string; created: boolean; updated?: boolean };
      /** 브랜치는 올렸지만 PR을 만들지 못한 이유 */
      pullRequestError?: string;
      /** 이미 열려 있던 PR의 본문을 다시 쓰다 실패했다는 경고(push·PR 자체는 이미 끝난 것으로 본다). 새로 PR을
       * 만든 경우(본문을 생성 요청에 함께 보낸다)에는 생기지 않는다 */
      pullRequestUpdateWarning?: string;
      /** PR에 연결한 이슈 번호들. 연결하지 않았거나 PR을 만들지 않았으면 없다 */
      issues?: number[];
      /** 요구사항 추적 이슈 본문 갱신이 실패했다는 경고(PR 만들기 자체는 막지 않는다). 갱신할 추적 이슈가 없으면(아직
       * "이슈로 발행"을 안 했거나 이 프로젝트가 요구사항 발행을 안 쓰면) 없다 */
      requirementsTrackingWarning?: string;
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
  | { type: 'deploy_failed'; action: DeployAction; target: string; error: string; detail?: string }
  /**
   * PR 자동 리뷰(ADR-074) 상태가 바뀔 때마다 통째로 온다. review 전체를 담아 기록을 다시 재생해도 중간 라운드를 놓치지 않는다.
   * 다만 각 이벤트는 그 순간 값을 담고 있을 뿐이라 재생이 끝난 지금 값과 같다는 보장은 없다 — snapshot_sync가 마지막에 맞춘다
   */
  | { type: 'review_round'; review: ReviewStateView }
  /**
   * 구독을 새로 열 때 replay 맨 끝에서만 보낸다(기록에 쌓지 않는다).
   * exported·remote_synced·base_synced·review_round 같은 기록 이벤트는 그 순간 서버가 계산한 값(예: canCreatePullRequest)을
   * 그대로 담고 있어, 재생하면 지금 스냅샷보다 오래된 값으로 되돌아갈 수 있다(예: 서버가 올라오며 gh 토큰을 새로 찾은 경우).
   * 기록을 다 재생한 뒤 지금 스냅샷의 값으로 다시 한번 맞춰 "마지막 기록 이벤트가 이김" 문제를 없앤다
   */
  | { type: 'snapshot_sync'; repository?: RepositoryView; checkpoints: Checkpoint[]; review?: ReviewStateView };

export type ExportResult = Omit<Extract<StudioEvent, { type: 'exported' }>, 'type'>;

/** 올리기 전 미리보기. PR 생성은 사람이 확인한 뒤 결정하고, 누락은 확인 목록에 보이게만 한다 */
export interface ExportPreview {
  title: string;
  body: string;
  /** 토큰이 있고 호스트가 지원해 실제로 PR을 만들 수 있는가 */
  canCreate: boolean;
  /** 이미 같은 브랜치로 열려 있는 PR 주소 */
  existingPullRequest?: string;
  /** PR에 연결할 이슈 번호들. 통합 세션이면 계획의 하위 이슈가 기본값으로 온다 */
  issues: number[];
  checks: Array<{
    id: 'issue_linked' | 'issue_open' | 'stages_passed' | 'uncheckpointed_changes' | 'running' | 'tracking_issue_refresh';
    /** unknown: 확인하지 못했지만 올리기를 막지는 않는 항목 (예: 원격 이슈 조회 실패) */
    ok: boolean | 'unknown';
    detail: string;
  }>;
  /** PR 자동 리뷰 라운드(ADR-074)의 studio.yaml 기본값. 화면 체크박스·라운드 수 입력의 기본값으로 쓴다 */
  review: { auto: boolean; maxRounds: number };
}

export interface ProxyResponse {
  status: number;
  contentType: string | null;
  body: string;
  truncated: boolean;
  durationMs: number;
  /** 등록한 사내 API를 부른 경우의 정책 결과 */
  policy?: { decision: 'allow' | 'deny'; masked: number; reason?: string };
}
