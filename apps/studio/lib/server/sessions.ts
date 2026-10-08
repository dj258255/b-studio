import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import type { Server } from 'node:http';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  appendPlanToRequest,
  AssumptionSchema,
  attachResults,
  buildAddTestPrefill,
  buildAllMustHavesPrefill,
  buildFixTestPrefill,
  buildMatrixCsv,
  buildMissingReferenceQuestion,
  buildPrReviewExternalContext,
  buildPrReviewResolvedContext,
  buildPullRequest,
  buildReferencedFilesContext,
  buildRequirementsAddendum,
  buildRequirementWorkPrefill,
  buildReviewRequirementsContext,
  buildReviewResolutionComment,
  buildTestRunPlan,
  buildTraceabilityMatrix,
  canCreatePullRequest,
  captureBaselines,
  alignScenarioIds,
  carryForwardRequirementRevision,
  CheckpointError,
  CheckpointStore,
  compareUrl,
  computeRequirementStatus,
  countByStatus,
  createPullRequest,
  generateCommitSubject,
  DatabaseBranches,
  describeDatabaseState,
  detectRunner,
  diffFilePaths,
  discardRevisionIfNeverSaved,
  discoverTestsInFile,
  draftManagedRequirement,
  draftRequirementFromIssue,
  estimateCost,
  extractDiffReferencedNames,
  extractImplementsTrailers,
  extractTrackingSubIssueNumbers,
  extractRequirementIds,
  extractRequirementMentions,
  extractRequirementsHeuristically,
  findMentionedIds,
  fetchIssue,
  fetchPullRequestDetail,
  findCheckpointMentions,
  findGateCheckMentions,
  flattenDiscoveredFile,
  formatCheckedCoverage,
  formatVerificationReport,
  formatVerifyTrailer,
  formatWorkflowTrailer,
  isBlockingFinding,
  isDocCheckpointPath,
  isLikelyTestFile,
  labelRecommendationSource,
  listIssues,
  managedRequirementToRequirement,
  ManualStepItemSchema,
  MAX_ASSUMPTIONS,
  MAX_CLARIFYING_QUESTIONS,
  MAX_MANUAL_STEPS,
  MAX_REQUIREMENTS,
  mergeManagedPullRequestBody,
  mergeReextractedRequirements,
  ORDERS_DEMO_SCENARIOS,
  parseJestLikeJson,
  parseJUnitXml,
  parsePullRequestNumber,
  parseRemote,
  parseRequirementsMarkdown,
  partitionManualSteps,
  planAskFromClient,
  postComment,
  PR_REVIEW_EXTERNAL_CONTEXT_MAX_FILES,
  REFERENCED_FILES_CONTEXT_MAX_CHARS,
  REQUIREMENT_LABEL,
  RecommendationSchema,
  requestPlanBrief,
  requestQuestionRecommendations,
  requestRequirementsExtraction,
  REQUIREMENTS_FILE,
  RequirementSchema,
  requirementConfidence,
  requirementVerificationSource,
  reviseRequirementIfChanged,
  resolveReferencedFiles,
  runnerLabel,
  updatePullRequestBody,
  scanTestFilesForRequirementId,
  serializeRequirementsMarkdown,
  shouldPlanBrief,
  splitCollectedReports,
  summarizeCoverage,
  preflightClaudeCode,
  preflightCodex,
  preflightCommandCode,
  preflightOpenCode,
  preflightGemini,
  releaseBlockers,
  RemoteConflictError,
  reviewIndependence,
  scopedExecutionPolicy,
  maxTurnsFor,
  restartServicesFor,
  runAgent,
  runClaudeCodeAgent,
  runCodexAgent,
  runCommandCodeAgent,
  runOpenCodeAgent,
  runGeminiAgent,
  ScriptedModelClient,
  type ScriptedTurn,
  CLI_TIERS,
  higherCliTier,
  nextCliTier,
  routeCliTier,
  tierLabel,
  type CliRouteDecision,
  type CliTier,
  verifyChanges,
  workflowStages,
  Workspace,
  adrFilePath,
  appendExperimentEntry,
  appendRoadmapTradeoffEntry,
  appendTroubleshootingEntry,
  appendVerificationEntry,
  buildAdrTemplate,
  buildDesignDocTemplate,
  buildDocSummary,
  buildExperimentEntry,
  buildProjectStatus,
  buildRoadmapTemplate,
  buildRoadmapTradeoffEntry,
  buildTroubleshootingEntry,
  buildVerificationEntry,
  designDocFilePath,
  DOCS_README_PATH,
  EXPERIMENT_LOG_PATH,
  lintText,
  nextAdrNumber,
  nextDesignDocNumber,
  regenerateDocsReadme,
  regenerateRoadmapStatus,
  ROADMAP_PATH,
  ROADMAP_TRADEOFFS_PATH,
  TROUBLESHOOTING_LOG_PATH,
  VERIFICATION_LOG_PATH,
  type DocLintFinding,
  type DocSummary,
  type ProjectStatusInput,
  type ProjectStatusView,
  type AgentEvent,
  type AgentResult,
  type AgentUsage,
  type BaseStatus,
  type BoardAccess,
  type BrowserFrame,
  type CheckpointRef,
  type Checkpoint,
  type ConflictResolution,
  type DatabaseState,
  type DemoScenario,
  type DiscardBackup,
  type DesignFrameInfo,
  type DesignSource,
  type DocEvidence,
  type Effort,
  type EscalationPolicy,
  type GateCheckResult,
  type GitAuthor,
  type ImplementedRequirementRef,
  type IssueSummary,
  type ManualVerification,
  type MatrixTestRunRow,
  type ModelAsk,
  type ModelClient,
  type ModelClientInfo,
  type PullRequestDraft,
  type ReferencedFile,
  type Recommendation,
  type RemoteLocation,
  type Requirement,
  type RequirementCoverage,
  type RequirementDiffEntry,
  type RequirementEvaluation,
  type RequirementEvidence,
  type RequirementIssueDraft,
  type RequirementStatus,
  type RepositoryInfo,
  type RoutingDecision,
  type RunMetrics,
  type ParsedTestCase,
  type ParsedTestRun,
  type RemoteSyncResult,
  type Runner,
  type ScannedFile,
  type ServiceCheck,
  type SessionCommit,
  type VerificationReport,
  type SelfCheckMode,
  type TestFramework,
  type TestRow,
  type TestRunEvidence,
  type TestTarget,
  type TraceabilityMatrix,
  type VerifyMode,
  type WorkflowCheck,
} from '@b-studio/agent';
import {
  defaultDeployRoot,
  describeSnapshotEvent,
  DockerDeployer,
  providerFromEnv,
  Redactor,
  resolveSecrets,
  type DeployLog,
  type DeployResult,
  type FileChange,
  type Sandbox,
  type ServiceStatusEvent,
  type StartOptions,
} from '@b-studio/sandbox';
import { dependentsOf, loadProject, figmaFileKey, SPEC_FILE, type LoadedProject, type WorkflowPageCheck } from '@b-studio/spec';
import { skipAlreadySeen } from '@/lib/logs';
import {
  buildSubmissionChecklist,
  matchAcceptanceAgainstDocs,
  type ChecklistService,
  type ChecklistStatus,
  type ChecklistTestEvidence,
  type DocMatchSource,
  type SubmissionReport,
} from '@/lib/submission-checklist';
import {
  addTokens,
  describeWindow,
  formatTokenCount,
  hasTokens,
  parseTokenLimit,
  parseUsageWindow,
  parseUserTokenLimit,
  subtractTokens,
  totalTokens,
  type UsageWindow,
} from '@/lib/usage';
import type {
  CodeFile,
  CodeSearch,
  CodeTree,
  DesignView,
  ExportPreview,
  ExportResult,
  ProxyResponse,
  RepositoryView,
  ReviewRoundView,
  ReviewStateView,
  SessionMode,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
  StudioEvent,
  WorkspaceKind,
} from '@/lib/studio-events';
import { authConfig, PREVIEW_COOKIE, signPreviewGrant, verifyPreviewGrant } from './auth';
import { readRevocations } from './auth-state';
import { resolveArtifact, saveArtifact } from './artifacts';
import { claudeCodeAsk } from './claude-code-ask';
import { compareExample, designPathFor, writeDesignPng } from './design-files';
import { modelFamily } from './model-family';
import { FigmaClient } from './figma';
import { clearFrames, publish } from './live-frames';
import { closeAllRemoteBrowsers, closeRemoteBrowser } from './remote-browsers';
import { closeAllServicePreviewProxies, closeServicePreviewProxies, ensureServicePreviewProxy } from './service-preview-proxy';
import { codexContextBlock, rememberCodexRun, type CodexRunSummary } from './codex-context';
import { resolveCommandCodeModel } from './commandcode-models';
import { resolveOpenCodeModel } from './opencode-models';
import { resolveGeminiModel } from './gemini-models';
import { cachedRepositoryToken, localFolderAllowed, resolveRepositoryToken } from './repo-token';
import { collectHumanResolvedFindings, runReviewRounds, type ReviewFixResult, type ReviewRoundDeps } from './review-round';
import { SteeringQueue } from './steering';
import { searchFiles, walkFiles } from './code-files';
import { readServicePackageJson, serviceHasPomXml, walkServiceTestFiles } from './test-files';
import { addUserUsage, userTokens } from './usage-state';
import { clientForModel, modelById, routingDecision } from './model-registry';
import { recordObservation } from './model-observations';
import {
  planRequirementIssuePublish,
  publishedIssueNumbers,
  publishedTrackingIssue,
  publishRequirementIssues,
  refreshTrackingIssueBody,
  REQUIREMENT_ISSUES_FILE,
  resolveRequirementConflict,
  syncRequirementIssueStatus,
  type ConflictResolutionResult,
  type RequirementIssuesContext,
  type RequirementPlanResult,
  type RequirementPublishResult,
  type RequirementSyncEvidence,
  type RequirementSyncResult,
} from './requirement-issues';
import { isSelectableEffort, isSelectableModel, listSelectableModels, type ModelPickerView } from './model-picker';
import { rememberProjectEffortDefault, rememberProjectModelDefault } from './model-defaults';
import { describe, StudioError } from './errors';
import { isDeniedPath, watchProjectFiles, type FileWatcher } from './file-watch';
import { ACCESS_PATH, createPreviewGateway, previewHost, safePreviewPath, type PreviewAccess, type PreviewTarget } from './preview-gateway';
import { findProject } from './projects';
import { applyGeneratedFilesToWorkingCopy, findRegisteredProject, generatedFilePaths, overlayGeneratedFiles } from './project-registry';
import { offManagedServices, serviceSelectionFor, writeServiceSelection } from './service-selection';
import {
  archivedSnapshot,
  closeUnfinished,
  commandCodeStateDirOf,
  geminiStateDirOf,
  isProcessAlive,
  openCodeStateDirOf,
  readSessions,
  stateDirOf,
  trimHistory,
  writeSession,
  writeSessionSync,
  type PersistedSession,
} from './session-store';

type Conversation = NonNullable<Parameters<typeof runAgent>[0]['conversation']>;
type Listener = (event: StudioEvent) => void;

/** 처리 중인 에이전트 요청 */
interface ActiveRun {
  id: string;
  /** 요청을 시작한 시각(ISO). 관제 화면이 진행 시간을 잰다 */
  startedAt: string;
  /** 사용자가 요청을 취소하면 abort한다. 에이전트가 끝나 체크포인트를 남기기 시작하면 세션에서 떼어 더는 취소를 받지 않는다 */
  cancel: AbortController;
  /** 요청을 시작할 때의 세션 토큰 합계 */
  baseTokens?: AgentUsage;
  tokens: AgentUsage;
  /** 요청을 보낸 사람. 사용량을 세션을 만든 사람이 아니라 이 사람에게 붙인다 */
  by?: string;
  /** 이미 이 사람 몫으로 더한 양. 토큰 이벤트는 실행 누적값을 주므로 늘어난 만큼만 더한다 */
  charged?: AgentUsage;
  /** 요청을 멈춘 이유. 사용자가 취소했거나 토큰 한도에 도달했다 */
  stopReason?: 'user' | 'budget';
  /** 한도로 멈췄을 때 어느 한도인지 */
  limitKind?: 'session' | 'user';
  /**
   * 실행 중 지시 큐. 사람이 보는 단일 세션이 이 실행을 시작했을 때만 있다(작업 분해 레인·플릿은 없다).
   * 러너가 다음 모델 호출 직전에 꺼내 가고, 남은 지시는 실행이 끝날 때 버림으로 기록한다
   */
  steering?: SteeringQueue;
}

/** eager: 세션을 만들 때 샌드박스를 바로 켠다(레인·플릿·벤치·이어서 하기). on-demand: 첫 필요 때 켠다(사람이 만든 일반 세션) */
export type BootMode = 'eager' | 'on-demand';

interface Session {
  snapshot: SessionSnapshot;
  project: LoadedProject;
  sandbox: Sandbox;
  /** 샌드박스를 만든 제공자 이름. 서버가 비정상 종료된 뒤 남은 샌드박스를 정리할 때 쓴다 */
  provider: string;
  /** 원격 미리보기 주소에 넣는 128비트 토큰. 스튜디오에 사용자 인증이 없어 주소를 추측할 수 없게 한다 */
  previewToken: string;
  /** 채팅·상태 이벤트. 새로 연결한 브라우저에 다시 보낸다 */
  history: StudioEvent[];
  /** 로그는 양이 많아 따로 최근 것만 둔다 */
  logs: StudioEvent[];
  listeners: Set<Listener>;
  conversation: Conversation;
  /**
   * 요청이 끝난 시점의 대화 길이. 요청 도중의 대화에는 결과가 없는 도구 호출이 있어,
   * 그 상태로 저장했다가 이어서 작업하면 다음 요청이 API 오류로 실패한다
   */
  settledConversation: number;
  stop: AbortController;
  logFollower?: AbortController;
  demoIndex: number;
  checkpoints: CheckpointStore;
  /** 체크포인트마다 저장한 개발용 데이터베이스 상태 */
  databases: DatabaseBranches;
  /** 로컬 Claude Code 모드의 대화. 기록은 Claude Code가 들고 있고 여기에는 이어받을 세션만 둔다 */
  claudeCode: {
    sessionId?: string;
    /** 체크포인트 복원처럼 대화 밖에서 바뀐 사실. 다음 요청 앞에 붙여 알린다 */
    notes: string[];
    /** claude-code 자동 모델 선택(ADR-091)의 stickiness: 이 세션에서 이미 성공적으로 쓴 가장 높은 단계 */
    autoTier?: CliTier;
  };
  /**
   * 로컬 ChatGPT Agent(Codex) 모드의 짧은 이전 맥락. 러너가 대화를 이어받지 못해(설치된 SDK에 fork가 없다)
   * 전체 기록 대신 최근 요청의 요약만 넘긴다
   */
  codex: {
    /** 체크포인트 복원처럼 대화 밖에서 바뀐 사실. 다음 요청 앞에 붙여 알린다 */
    notes: string[];
    /** 지난 요청의 요약. 최근 3개만 둔다 */
    recent: CodexRunSummary[];
  };
  /**
   * 로컬 Command Code Agent 모드의 대화. Command Code가 대화를 들고 있고,
   * 이어받기는 세션을 갈라(fork) 하므로 여기에는 이어받을 세션 id와 알림만 둔다
   */
  commandCode: {
    sessionId?: string;
    /** 체크포인트 복원처럼 대화 밖에서 바뀐 사실. 다음 요청 앞에 붙여 알린다 */
    notes: string[];
  };
  /**
   * 로컬 OpenCode Agent 모드의 대화. OpenCode가 대화를 들고 있고,
   * 이어받기는 세션을 갈라(fork) 하므로 여기에는 이어받을 세션 id와 알림만 둔다
   */
  openCode: {
    sessionId?: string;
    /** 체크포인트 복원처럼 대화 밖에서 바뀐 사실. 다음 요청 앞에 붙여 알린다 */
    notes: string[];
  };
  /**
   * 로컬 Gemini Agent 모드의 대화. 세션 id가 실제로 응답에 실리는지는 확인하지 못했다(gemini-cli-runner.ts 머리말 참고) —
   * 실리면 받아서 이어받고, 아니면 매번 새 대화로 시작한다
   */
  gemini: {
    sessionId?: string;
    /** 체크포인트 복원처럼 대화 밖에서 바뀐 사실. 다음 요청 앞에 붙여 알린다 */
    notes: string[];
  };
  /** 원본에서 커밋하지 않아 세션에 들어가지 않은 변경 수 */
  sourceDirtyFiles: number;
  /** 세션 단위로 설정한 디자인(Figma) URL. studio.yaml의 설정보다 우선한다 */
  design?: { fileUrl: string; fileKey: string };
  /** 원격에 올리는 동안에는 새 요청과 되돌리기를 받지 않는다 */
  exporting: boolean;
  run?: ActiveRun;
  /**
   * 샌드박스를 필요할 때 켜는 세션인지(사람이 만든 일반 세션). 켜기 전까지 snapshot.status는 idle이다.
   * 켜는 중에는 bootPromise를 공유해 동시 호출에도 한 번만 켠다
   */
  lazy: boolean;
  bootPromise?: Promise<void>;
  usageTimer?: NodeJS.Timeout;
  /** 에이전트 도구를 거치지 않은 파일 변경(서비스 안에서 명령이 만든 파일 등)을 코드 화면에 알린다 */
  fileWatcher?: FileWatcher;
  /** 내 폴더에서 새로 만든 폴더를 서비스 컨테이너 안에서 옮겼다 되돌린 시각. 그 이동이 다시 변경 알림으로 오는 것을 거른다 */
  relayed: Map<string, number>;
  /** 진행 중인 변경 알림 전달. 잠깐 쓰는 이름이 체크포인트에 들어가지 않도록 체크포인트를 남기기 전에 기다린다 */
  relaying: Promise<void>;
  /** 마지막으로 대화나 상태가 바뀐 시각. 세션 목록 정렬에 쓴다 */
  updatedAt: string;
  persist: { timer?: NodeJS.Timeout; chain: Promise<void> };
  /**
   * 가장 최근 체크포인트를 만든 실행의 게이트 확인 결과(테스트·화면 확인 등 이름 붙은 확인, AgentResult.checks).
   * "명세" 탭(ADR-079)이 이름에 요구사항 id가 들어간 확인의 통과·실패를 증거로 삼는다. 체크포인트를 남기지 못한
   * 실행(질문·되돌림)에서는 갱신하지 않는다 — "최근 체크포인트"의 결과여야 하기 때문이다
   */
  lastGateChecks?: WorkflowCheck[];
  /**
   * 이 세션이 띄울 compose 서비스 이름(managed·부가 서비스 모두, ADR-083). project.offServices(managed 중 꺼 둔 것)와
   * 함께 쓰인다 — 여기서 뺀 managed 서비스가 project.offServices에 들어간다. 프로젝트별 저장 선택이 없으면 기본값
   * (관리형 + 기댐 닫힘)이다. sandbox.start()에 그대로 넘겨 그 서비스만 compose up한다
   */
  serviceSelection: Set<string>;
  /**
   * "테스트" 탭(ADR-084)이 서비스마다 저장해 둔 마지막 실행 결과. 사람이 직접 돌렸거나(run) 검증 게이트의
   * test 단계가 남긴 보고서를 다시 실행하지 않고 모았을 때(gate) 채운다. 서버를 다시 시작하면 사라진다(체크포인트처럼 영속하지 않는다)
   */
  testResults?: Map<string, StoredTestRun>;
  /**
   * testResults를 사이드카 파일(.git/b-studio/test-results.json)에서 읽어 오는 중(또는 읽은) 약속. 세션
   * 객체가 막 만들어졌을 때(새로 만들거나 이어서 작업할 때)는 비어 있다가 testResults를 처음 찾을 때 한 번만 채운다
   * — 동시에 여러 서비스를 조회해도(Promise.all) 파일을 두 번 읽거나 서로의 결과를 덮어쓰지 않는다
   */
  testResultsLoadPromise?: Promise<void>;
  /** 서비스별로 지금 도는 테스트를 취소할 수 있게 든 컨트롤러. 서비스 하나당 한 번에 하나만 돈다 */
  testControllers?: Map<string, AbortController>;
}

/** 서비스 하나의 마지막 테스트 실행 결과 */
interface StoredTestRun {
  at: string;
  source: 'run' | 'gate';
  runner?: Runner;
  run: ParsedTestRun;
  /** 실행기 자체가 실패했을 때(컴파일 오류 등 보고서를 하나도 남기지 못한 경우)의 원인 요약 */
  error?: string;
  /**
   * 이 실행 시점의 체크포인트(HEAD) SHA. 지금 체크포인트와 같을 때만(그리고 그 뒤 커밋하지 않은 변경이 없을
   * 때만) "올리기 전 점검"의 테스트 항목과 요구사항 증거가 이 실행을 믿을 수 있는 증거로 센다(버그 리포트:
   * 테스트 탭에서 직접 돌린 결과가 증거로 치지 않던 문제). 체크포인트가 하나도 없는 세션이면 undefined
   */
  sha?: string;
}

/** 이전 스튜디오 프로세스가 남긴 세션. 샌드박스 없이 기록만 보여 주고, 이어서 작업하면 Session으로 바뀐다 */
interface ArchivedSession {
  data: PersistedSession;
  snapshot: SessionSnapshot;
  history: StudioEvent[];
  listeners: Set<Listener>;
  /** 남은 샌드박스 정리. 끝난 뒤에 이어서 작업한다 */
  cleanup: Promise<void>;
}

const HISTORY_LIMIT = 5_000;
/** docker stats 한 번이 1초 남짓 걸리므로 넉넉히 둔다 */
const USAGE_INTERVAL_MS = 5_000;
const LOG_LIMIT = 1_000;
/** 도구 호출마다 이벤트가 오므로 모아서 쓴다 */
const PERSIST_DELAY_MS = 500;
const GENERATED = /[/\\](node_modules|\.next|build|\.gradle|\.venv)([/\\]|$)/;
const INTERRUPTED_BY_RESTART = '스튜디오 서버가 멈춰 끝내지 못했습니다';
const INTERRUPTED_BY_STOP = '샌드박스를 중지해 끝내지 못했습니다';

// 개발 서버의 HMR로 모듈이 다시 로드돼도 실행 중인 샌드박스를 잃지 않도록 전역에 둔다
interface Store {
  sessions: Map<string, Session>;
  /** 이전 버전 모듈이 만든 전역 객체에는 없을 수 있다 */
  archived?: Map<string, ArchivedSession>;
  resuming?: Set<string>;
  /** 로컬 폴더 세션을 만들거나 이어서 작업하려고 잡아 둔 폴더 */
  claimedFolders?: Set<string>;
  recovery?: Promise<void>;
  previewGateway?: Server;
  /** Figma 클라이언트. 파일·노드 캐시를 요청 사이에도 유지한다 */
  figma?: FigmaClient;
  /** 이미 쓴 미리보기 티켓의 임의 값과 만료 시각 */
  previewTickets?: Map<string, number>;
  cleanupRegistered: boolean;
}
const globalStore = globalThis as typeof globalThis & { __bStudio?: Store };
const store: Store = (globalStore.__bStudio ??= { sessions: new Map(), cleanupRegistered: false });
const archived = (store.archived ??= new Map());
const resuming = (store.resuming ??= new Set());
const claimedFolders = (store.claimedFolders ??= new Set());

export function getSnapshot(id: string): SessionSnapshot | undefined {
  return (store.sessions.get(id) ?? archived.get(id))?.snapshot;
}

/** 실행 중이거나 중지된 세션. 최근에 바뀐 것부터 */
export async function listSessions(): Promise<SessionSummary[]> {
  await recoverSessions();
  const summaries = [
    ...[...store.sessions.values()].map((session) => summarize(session.snapshot, session.history, session.updatedAt)),
    ...[...archived.values()].map((entry) => summarize(entry.snapshot, entry.history, entry.data.savedAt)),
  ];
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function summarize(snapshot: SessionSnapshot, history: readonly StudioEvent[], updatedAt: string): SessionSummary {
  const lastRequest = history.findLast((event) => event.type === 'run_started');
  return {
    id: snapshot.id,
    projectId: snapshot.projectId,
    projectName: snapshot.projectName,
    status: snapshot.status,
    mode: snapshot.mode,
    backend: sessionBackend(snapshot),
    owner: snapshot.owner,
    workspace: snapshot.workspace ?? 'copy',
    checkpoints: snapshot.checkpoints.length,
    lastRequest: lastRequest?.type === 'run_started' ? lastRequest.request : undefined,
    updatedAt,
  };
}

/** 관제 화면이 세션마다 받는 최근 이벤트 수. 전체 기록을 복사하지 않고 마지막 것만 준다 */
const OVERVIEW_TAIL = 40;

/**
 * 관제 화면용: 세션마다 스냅샷과 최근 이벤트 몇 개만 준다(전체 기록을 복사하지 않는다).
 * 실행 중이면 runningSince(요청 시작 시각)를 함께 준다. 진행 시간과 마지막 활동을 여기서 계산한다.
 */
export async function overviewSessions(): Promise<Array<{ snapshot: SessionSnapshot; recent: StudioEvent[]; updatedAt: string; runningSince?: string; lastRequest?: string }>> {
  await recoverSessions();
  const tail = (events: readonly StudioEvent[]): StudioEvent[] => events.slice(-OVERVIEW_TAIL);
  // 마지막 요청은 최근 이벤트에 없을 수 있어(도구 호출이 많으면 잘린다) 전체 기록에서 찾는다
  const lastRequestOf = (events: readonly StudioEvent[]): string | undefined => {
    const started = events.findLast((event) => event.type === 'run_started');
    return started?.type === 'run_started' ? started.request : undefined;
  };
  return [
    ...[...store.sessions.values()].map((session) => ({
      snapshot: session.snapshot,
      recent: tail(session.history),
      lastRequest: lastRequestOf(session.history),
      updatedAt: session.updatedAt,
      ...(session.run ? { runningSince: session.run.startedAt } : {}),
    })),
    ...[...archived.values()].map((entry) => ({ snapshot: entry.snapshot, recent: tail(entry.history), lastRequest: lastRequestOf(entry.history), updatedAt: entry.data.savedAt })),
  ];
}

export async function createSession(
  projectId: string,
  owner: string,
  workspace: WorkspaceKind = 'copy',
  options: {
    modelId?: string;
    effort?: string;
    backend?: string;
    boot?: BootMode;
    extraPageChecks?: readonly WorkflowPageCheck[];
    /**
     * 서버 안에서만 넘긴다(작업 분해 레인·통합, ADR-096). 이 세션의 최신 체크포인트에서 작업 복사본을 시작한다
     * (원본 세션이 로컬 폴더이거나 git 저장소가 아니면 조용히 무시하고 지금처럼 프로젝트 원본에서 시작한다)
     */
    seedFromSessionId?: string;
  } = {},
): Promise<SessionSnapshot> {
  const mode = sessionMode();
  // 요청이 백엔드를 고르면 허용 목록에서만 받는다. 없으면 서버 모드라 지금과 같다
  const backend = resolveSessionBackend(options.backend);
  const tokenLimit = sessionTokenLimit();
  const preview = previewConfig();
  if (workspace === 'local') assertLocalFolderAllowed();
  const source = await findProject(projectId);
  if (!source) throw new StudioError(404, '프로젝트를 찾을 수 없습니다');
  // 이전 프로세스가 남긴 샌드박스를 먼저 정리해 새 세션과 자원을 다투지 않게 한다
  await recoverSessions();
  const release = workspace === 'local' ? claimFolder(source.root) : undefined;
  try {
    // 기본은 eager(지금과 같다). 사람이 만든 일반 세션의 라우트만 on-demand를 넘긴다
    const boot = options.boot ?? 'eager';
    const seed = options.seedFromSessionId ? await resolveSessionSeed(options.seedFromSessionId) : undefined;
    return await startSession({
      projectId,
      owner,
      workspace,
      source,
      mode,
      backend,
      boot,
      tokenLimit,
      preview,
      modelId: options.modelId,
      effort: options.effort,
      extraPageChecks: options.extraPageChecks,
      seed,
    });
  } finally {
    // 세션을 만든 뒤에는 실행 중인 세션 목록이 같은 폴더를 막는다
    release?.();
  }
}

/**
 * 작업 분해(레인·통합)가 세션에서 시작할 때(ADR-096) 그 세션의 작업 복사본 경로와 최신 체크포인트 sha를 찾는다.
 * 로컬 폴더 세션은 체크포인트가 사용자 폴더 밖 별도 git(gitDir)에 있어 평범한 clone 원본으로 쓸 수 없고,
 * 원본이 git 저장소가 아닌 세션은 기준 브랜치·원격 메타가 없어 복제해도 의미가 없다 — 두 경우 모두 undefined를 돌려줘
 * 부르는 쪽이 지금처럼 프로젝트 원본에서 새로 시작하게 한다(세션이 이미 사라졌어도 마찬가지로 안전하게 건너뛴다).
 */
async function resolveSessionSeed(sessionId: string): Promise<{ workDir: string; sha: string } | undefined> {
  try {
    const session = requireSession(sessionId);
    if (session.snapshot.workspace === 'local') return undefined;
    const info = await session.checkpoints.repository();
    if (!info) return undefined;
    // 분해 시점에 아직 체크포인트로 남기지 않은 문서(요구사항 저장 등)가 있으면 레인·통합이 시작하기 전에 먼저
    // 남긴다 — 그래야 요구사항·이슈 번호·발행 기록이 레인·통합 세션에도 실린다. createTaskPlan이 이미 한 번
    // 남기지만(ADR-096), 다른 경로로 seedFromSessionId를 넘길 수도 있어 여기서도 한 번 더 안전망을 둔다
    // (이미 커밋했으면 pendingFiles가 비어 있어 아무것도 하지 않는다)
    await commitPendingWorkingCopyDocs(sessionId, 'docs: 나눠서 병렬로 하기 전에 문서를 정리한다').catch((error: unknown) => {
      console.error(`[b-studio] 세션 ${sessionId}의 분해 전 문서 체크포인트를 남기지 못했습니다`, error);
    });
    const sha = session.snapshot.checkpoints[0]?.sha;
    return sha ? { workDir: session.snapshot.workDir, sha } : undefined;
  } catch {
    return undefined;
  }
}

async function startSession({
  projectId,
  owner,
  workspace,
  source,
  mode,
  backend,
  boot,
  tokenLimit,
  preview,
  modelId,
  effort,
  extraPageChecks,
  seed,
}: {
  projectId: string;
  owner: string;
  workspace: WorkspaceKind;
  source: LoadedProject;
  /** 세션을 만들 때의 서버 모드(B_STUDIO_MODE). 화면·레거시 호환용으로 남긴다 */
  mode: SessionMode;
  /** 이 세션이 실제로 쓰는 백엔드. 실행 경로가 이 값을 본다 */
  backend: SessionMode;
  boot: BootMode;
  tokenLimit: number | undefined;
  preview: PreviewConfig | undefined;
  modelId?: string;
  /** 새 세션의 노력 단계 기본값(model-defaults.ts에 기억된 값). 고른 적이 없으면 없다 */
  effort?: string;
  /** 이 세션에만 덧붙일 pageChecks(작업 분해 통합 게이트). HTTP 라우트는 넘기지 않는다 */
  extraPageChecks?: readonly WorkflowPageCheck[];
  /** 작업 분해 레인·통합이 다른 세션의 체크포인트에서 시작할 때(ADR-096). resolveSessionSeed가 만든다 */
  seed?: { workDir: string; sha: string };
}): Promise<SessionSnapshot> {
  const id = randomUUID().slice(0, 8);
  const sessionDir = path.join(sessionsRoot(), `${projectId}-${id}`);
  // 지연 기동 세션은 샌드박스를 켜지 않고 idle로 둔다
  const lazy = boot === 'on-demand';
  // 승격 대상 모델 id가 레지스트리에 없으면 샌드박스를 띄우기 전에 거부한다(조용히 승격 없이 돌지 않게)
  if (backend === 'api') apiEscalation();

  // 게이트를 통과한 변경만 남기고 실패한 변경은 되돌리기 위해 작업 폴더의 시작 상태를 체크포인트로 둔다
  const author = gitAuthor();
  let workDir = sessionDir;
  let stateDir: string | undefined;
  let checkpoints: CheckpointStore;
  let firstCheckpoint: Checkpoint;
  let sourceDirtyFiles = 0;
  if (workspace === 'local') {
    // 사용자의 폴더에서 바로 작업해 IDE의 수정과 에이전트의 수정이 같은 파일에 반영되게 한다.
    // 체크포인트 저장소와 세션 상태는 사용자 폴더의 .git과 섞이지 않게 세션 폴더에 둔다
    workDir = source.root;
    stateDir = sessionDir;
    checkpoints = new CheckpointStore(workDir, { author, gitDir: path.join(stateDir, '.git') });
    firstCheckpoint = await checkpoints.init('세션 시작 (내 폴더)');
  } else {
    // 에이전트가 원본을 바꾸지 않도록 세션마다 작업 복사본을 만든다. Docker가 마운트할 수 있는 홈 아래에 둔다
    await mkdir(path.dirname(workDir), { recursive: true });
    // 모노레포 하위 폴더 프로젝트는 studio.yaml에서 켰을 때만 상위 저장소를 복제한다
    const allowSubfolder = source.spec.repository?.monorepo === true;
    if (seed) {
      // 작업 분해 레인·통합(ADR-096): 프로젝트 원본이 아니라 그 세션의 작업 복사본에서, 그 세션의 최신 체크포인트
      // sha로 시작한다. 기준 브랜치·원격은 그 세션이 이미 기록해 둔 값을 그대로 물려받는다(inspectSource가 읽는다)
      const cloned = await CheckpointStore.clone(seed.workDir, workDir, {
        branch: sessionBranchName(projectId, id),
        author,
        allowSubfolder,
        ref: seed.sha,
        excludedFiles: generatedFilePaths,
      });
      checkpoints = cloned.store;
      firstCheckpoint = cloned.start;
      sourceDirtyFiles = cloned.source.dirtyFiles;
      await overlayGeneratedFiles(source.root, await checkpoints.projectRoot(), workDir);
      // 체크포인트가 만들어진 뒤에 끼워 넣은 파일이라, 세션 시작 체크포인트의 생성 파일 스냅샷을 여기서 따로 맞춘다(도그푸딩 마찰 127)
      await checkpoints.refreshExcludedSnapshot(firstCheckpoint.sha);
    } else if (await CheckpointStore.inspectSource(source.root, { allowSubfolder })) {
      // 원본이 Git 저장소면 커밋된 상태를 복제해 세션 브랜치에서 작업한다. 체크포인트가 곧 원격에 올릴 커밋이 된다
      const cloned = await CheckpointStore.clone(source.root, workDir, {
        branch: sessionBranchName(projectId, id),
        author,
        allowSubfolder,
        excludedFiles: generatedFilePaths,
      });
      checkpoints = cloned.store;
      firstCheckpoint = cloned.start;
      sourceDirtyFiles = cloned.source.dirtyFiles;
      // 폴더 열기로 등록한 프로젝트(ADR-067)는 b-studio가 만든 설정 파일이 커밋돼 있지 않아 복제에 빠진다. 복사본에 넣고 추적에서 뺀다
      await overlayGeneratedFiles(source.root, await checkpoints.projectRoot(), workDir);
      await checkpoints.refreshExcludedSnapshot(firstCheckpoint.sha);
    } else {
      await cp(source.root, workDir, { recursive: true, filter: (file) => !GENERATED.test(file) });
      checkpoints = new CheckpointStore(workDir, { author });
      firstCheckpoint = await checkpoints.init('세션 시작');
    }
  }

  const project = await loadProject(await checkpoints.projectRoot());
  // 이 세션에만 pageChecks를 덧붙인다(작업 분해 통합 게이트). 프로젝트 객체는 세션마다 새로 읽으므로 다른 세션·레인에는 새지 않는다
  if (extraPageChecks && extraPageChecks.length > 0) {
    project.spec.workflow = { ...project.spec.workflow, pageChecks: [...(project.spec.workflow?.pageChecks ?? []), ...extraPageChecks] };
  }
  // CLI 백엔드는 샌드박스를 띄우기 전에 로그인을 확인한다. 실패하면 세션을 만들지 않고 이유를 돌려준다
  await assertBackendReady(backend, project.root);
  const repository = await describeRepository(checkpoints, sourceDirtyFiles);
  // 이 프로젝트에서 띄울 서비스를 정한다(ADR-083). 저장한 선택이 없으면 기본값(관리형 + 기댐 닫힘)이다
  const serviceSelection = await resolveServiceSelection(project, projectId);
  // 시크릿 값은 스튜디오 서버의 환경 변수나 시크릿 파일에서만 읽는다 (복제한 작업 폴더에서는 읽지 않는다)
  const provider = providerFromEnv();
  const sandbox = await provider.create(project, { secrets: await resolveSecrets(project) });

  const session = newSession({
    snapshot: {
      id,
      projectId,
      projectName: project.spec.name,
      workDir,
      workspace,
      stateDir,
      // 지연 기동 세션은 샌드박스가 꺼진 채 idle로 시작한다. 서비스도 꺼진 것으로 보여 준다
      status: lazy ? 'idle' : 'starting',
      mode,
      backend,
      modelId,
      effort: effort as Effort | undefined,
      running: false,
      tokenLimit,
      owner,
      ...projectViews(project, lazy ? 'stopped' : 'starting', project.offServices),
      nextDemoRequest: mode === 'demo' ? demoScenarios(project)[0]?.request : undefined,
      nextDemoQuestion: mode === 'demo' ? demoScenarios(project)[0]?.question?.request : undefined,
      runtime: provider.isolation,
      checkpoints: [firstCheckpoint],
      repository,
    },
    project,
    sandbox,
    provider: provider.name,
    checkpoints,
    history: [],
    listeners: new Set(),
    conversation: [],
    demoIndex: 0,
    claudeCode: { notes: [] },
    codex: { notes: [], recent: [] },
    commandCode: { notes: [] },
    openCode: { notes: [] },
    gemini: { notes: [] },
    sourceDirtyFiles,
    lazy,
    serviceSelection,
    previewToken: randomBytes(16).toString('hex'),
  });
  // studio.yaml에 design.figma가 있으면 그 설정을 화면에도 보여 준다(세션 단위 설정이 아직 없다)
  session.snapshot.design = sessionDesignView(session);

  store.sessions.set(id, session);
  registerCleanup();
  if (preview) ensurePreviewGateway(preview);
  // 기동 도중에 서버가 멈춰도 다음 실행에서 샌드박스를 찾아 정리할 수 있도록 바로 남긴다
  void flushPersist(session);
  // 지연 기동 세션은 여기서 켜지 않는다. 첫 만들기 요청·샌드박스 도구·"지금 켜기"가 켠다
  if (!lazy) session.bootPromise = startBoot(session);
  return session.snapshot;
}

type NewSession = Pick<
  Session,
  | 'snapshot'
  | 'project'
  | 'sandbox'
  | 'provider'
  | 'previewToken'
  | 'checkpoints'
  | 'history'
  | 'listeners'
  | 'conversation'
  | 'demoIndex'
  | 'claudeCode'
  | 'codex'
  | 'commandCode'
  | 'openCode'
  | 'gemini'
  | 'sourceDirtyFiles'
  | 'lazy'
  | 'serviceSelection'
>;

function newSession(fields: NewSession): Session {
  return {
    ...fields,
    // 덤프는 에이전트 도구가 접근할 수 없고 커밋에도 들어가지 않는 .git 아래에 둔다
    databases: new DatabaseBranches(fields.sandbox, fields.project, path.join(fields.checkpoints.gitDir, 'b-studio', 'databases')),
    logs: [],
    settledConversation: fields.conversation.length,
    stop: new AbortController(),
    exporting: false,
    relayed: new Map(),
    relaying: Promise.resolve(),
    updatedAt: new Date().toISOString(),
    persist: { chain: Promise.resolve() },
  };
}

function projectViews(
  project: LoadedProject,
  state: 'starting' | 'stopped' = 'starting',
  offManaged: ReadonlySet<string> = new Set(),
): Pick<SessionSnapshot, 'services' | 'externals' | 'hasDeploy'> {
  return {
    // project.deploy(로더가 채운 값)는 선언하지 않은 서비스도 기본값(Dockerfile)으로 채우므로 늘 비어 있지 않다.
    // "배포" 하위 탭을 보일지는 spec.deploy(원본, 선언했을 때만 있음)로 판단해야 한다
    hasDeploy: project.spec.deploy !== undefined,
    services: project.managed.map(([name, service]) => ({
      name,
      template: service.template,
      preview: service.preview,
      // 지연 기동 세션(idle)은 샌드박스가 꺼져 있으므로 서비스도 꺼진 것으로 시작한다.
      // 서비스 선택(ADR-083)에서 꺼 둔 서비스는 샌드박스가 켜져도 계속 off다(실패가 아니다)
      state: offManaged.has(name) ? 'off' : state,
      hasContract: Boolean(service.contract),
    })),
    externals: (project.external ?? []).map(([name, service]) => ({
      name,
      baseUrl: service.baseUrl,
      access: service.policy.allow
        ? service.policy.allow.map((rule) => `${rule.callers.join(', ')}: ${rule.methods.join('/')} ${rule.paths.join(', ')}`)
        : ['모든 호출자: GET/HEAD'],
      mask: service.policy.mask,
      maskPatterns: service.policy.maskPatterns,
      authenticated: Boolean(service.policy.auth),
    })),
  };
}

/**
 * 이 세션이 띄울 서비스를 정하고, 검증 게이트가 보도록 project.offServices에 남긴다(ADR-083).
 * project는 세션 동안 계속 같은 객체를 쓰므로(체크포인트 복원·되돌리기도 같은 project를 넘겨받는다),
 * 한 번 붙이면 이후의 재시작·검증이 모두 최신 선택을 본다
 */
async function resolveServiceSelection(project: LoadedProject, projectId: string): Promise<Set<string>> {
  const resolved = await serviceSelectionFor(project, projectId);
  const selected = new Set(resolved.selected);
  project.offServices = offManagedServices(project, selected);
  return selected;
}

/** 새 구독자에게 지금 상태와 지금까지의 기록을 보낸 뒤 실시간 이벤트를 전달한다 */
export function subscribe(id: string, listener: Listener): () => void {
  const target = store.sessions.get(id) ?? archived.get(id);
  if (!target) throw new StudioError(404, '세션을 찾을 수 없습니다');
  replay(target, listener);
  target.listeners.add(listener);
  // 이어서 작업하면 같은 Set을 새 세션이 넘겨받으므로 구독 해제도 그대로 동작한다
  return () => target.listeners.delete(listener);
}

function replay(target: Session | ArchivedSession, listener: Listener): void {
  // exported·remote_synced·base_synced·review_round 같은 기록 이벤트는 그 순간 서버가 계산한 값
  // (예: canCreatePullRequest — gh CLI 토큰을 찾았는지)을 그대로 담고 있다. 기록을 재생하면 reduceSession이
  // 그 옛 값으로 다시 덮어써, 서버가 그사이 다시 계산해 지금 스냅샷엔 맞게 들어 있는 값을 화면이 놓칠 수 있다.
  // snapshot부터 보낸 뒤 그 값을 기억해 뒀다가, 기록과 로그를 다 보낸 끝에 다시 한번 맞춰 "마지막 기록 이벤트가
  // 이기는" 문제를 없앤다. 체크포인트 수와 리뷰 라운드도 같은 식으로 통째로 덮어써지므로 함께 맞춘다
  const { repository, checkpoints, review } = target.snapshot;
  listener({ type: 'snapshot', snapshot: target.snapshot });
  for (const event of target.history) listener(event);
  if ('logs' in target) for (const event of target.logs) listener(event);
  listener({ type: 'snapshot_sync', repository, checkpoints, review });
}

/**
 * 세션 기록을 통째로 읽는다. 구독을 등록해 replay(스냅샷 + 기록 + 로그)를 받은 뒤 바로 푼다.
 * 토큰 탭이 이 기록에서 실행별 보고서를 만든다(token-report). 없는 세션은 subscribe가 404로 알린다.
 */
export function sessionHistory(id: string): StudioEvent[] {
  const events: StudioEvent[] = [];
  const unsubscribe = subscribe(id, (event) => events.push(event));
  unsubscribe();
  return events;
}

export function sendMessage(
  id: string,
  text: string,
  {
    allowBreaking,
    by,
    intent = 'build',
    research = false,
    writableScope,
    scriptedTurns,
    scriptedInfo,
    board,
    steering,
    interactive = false,
    verify,
    maxTurns,
  }: {
    allowBreaking: boolean;
    by?: string;
    intent?: Intent;
    /** "조사" 모드(ADR-094). intent가 ask일 때만 뜻이 있다 — claude-code 백엔드만 이번 턴 WebSearch·WebFetch를 실제로 연다 */
    research?: boolean;
    /** 서버 안에서만 쓴다(작업 분해). 이 경로 밖의 파일 쓰기를 실행기가 막는다. HTTP로는 받지 않는다 */
    writableScope?: readonly string[];
    /** 서버 안에서만 쓴다(레인 결과 통합·테스트 대본). 모델 대신 미리 만든 도구 호출을 같은 루프·게이트로 실행한다. HTTP로는 받지 않는다 */
    scriptedTurns?: ScriptedTurn[];
    /**
     * scriptedTurns와 함께 쓴다. 채팅의 "backend" 카드가 보여줄 문구를 덮어쓴다(예: 레인 결과 통합은
     * "데모 스크립트에서 scripted 모델로 실행합니다"가 실제와 달라 보여 "레인 결과 합치기"로 덮어쓴다).
     * 생략하면 ScriptedModelClient의 기본값("데모 스크립트")을 그대로 쓴다(벤치·테스트 대본 등 그 밖의 쓰임)
     */
    scriptedInfo?: Partial<ModelClientInfo>;
    /** 서버 안에서만 쓴다(레인 조율). 레인 신원으로 감싼 게시판. HTTP로는 받지 않는다 */
    board?: BoardAccess;
    /** 실행 중 지시를 받을 실행인지. 사람이 보는 단일 세션(메시지 라우트)만 켠다. 레인·플릿·벤치는 켜지 않는다 */
    steering?: boolean;
    /** 서버 안에서만 쓴다. true면 되묻기(ask_user) 도구를 넣는다. 사람이 보낸 단일 세션 요청(messages 라우트)만 켠다 */
    interactive?: boolean;
    /** 검증 범위. 'light'(가볍게 확인)면 재시작·준비·계약만 돌린다. 생략하면 full */
    verify?: VerifyMode;
    /** 턴 상한 요청 옵션(ADR-131). studio.yaml(workflow.maxTurns)보다 우선한다 */
    maxTurns?: number;
  },
): { runId: string } {
  const session = requireSession(id);
  // 지연 기동 세션(idle)은 요청을 받아들인다. 읽기만 하면 이대로 끝나고, 필요하면 실행 중에 샌드박스를 켠다
  if (session.snapshot.status !== 'ready' && session.snapshot.status !== 'idle') throw new StudioError(409, '샌드박스가 준비된 뒤에 요청할 수 있습니다');
  if (session.snapshot.running) throw new StudioError(409, '이전 요청을 처리하는 중입니다');
  if (session.exporting) throw new StudioError(409, '원격 저장소에 올리는 중입니다');

  const request = text.trim();
  if (!request) throw new StudioError(400, '요청 내용을 입력하세요');
  const limit = session.snapshot.tokenLimit;
  if (limit !== undefined && totalTokens(session.snapshot.tokens) >= limit) {
    throw new StudioError(409, `이 세션은 토큰 한도(${formatTokenCount(limit)})에 도달해 새 요청을 받지 않습니다. 새 세션을 시작해 이어서 작업하세요`);
  }
  // 사람 한도는 세션과 따로 센다. 새 세션을 만들어도 같은 사람이면 그 기간 안에서는 더 쓸 수 없다
  const personal = userTokenBudget(by);
  if (personal && personal.used >= personal.limit) {
    throw new StudioError(
      409,
      `${describeWindow(personal.window)} 쓸 수 있는 토큰 한도(${formatTokenCount(personal.limit)})에 도달해 새 요청을 받지 않습니다. 기간이 바뀐 뒤에 다시 요청하세요`,
    );
  }

  // 되묻기(ask_user)는 사람이 보낸 단일 세션 요청에만 켠다. 레인·플릿·벤치·CLI는 도구 목록이 그대로다
  const plan = {
    ...(scriptedTurns
      ? ({ kind: 'model', client: new ScriptedModelClient(scriptedTurns, scriptedInfo), allowBreaking, intent } as const)
      : planRun(session, request, allowBreaking, intent)),
    writableScope,
    board,
    interactive,
    // 가볍게 확인은 검증 범위만 바꾼다. 질문(intent ask)은 게이트를 돌리지 않으므로 뜻이 없다
    ...(verify === 'light' ? { verify: 'light' as const } : {}),
    // "조사" 모드는 질문(ask)에만 뜻이 있다. 만들기 요청에 섞여 와도 각 러너가 다시 한번 ask와 함께 걸러 무시한다
    ...(intent === 'ask' && research ? { research: true as const } : {}),
    // 턴 상한 요청 옵션(ADR-131). 생략하면 studio.yaml(workflow.maxTurns)이나 실행기 기본값을 쓴다
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
  const run: ActiveRun = {
    id: randomUUID().slice(0, 8),
    startedAt: new Date().toISOString(),
    cancel: new AbortController(),
    baseTokens: session.snapshot.tokens,
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    by,
    // 데모(스크립트)는 실행 중 지시를 반영할 모델 호출이 없어 큐를 만들지 않는다
    ...(steering && session.snapshot.mode !== 'demo' ? { steering: new SteeringQueue() } : {}),
  };
  session.run = run;
  session.snapshot.running = true;
  // 새 요청을 보내면 지난 질문은 답이 온 것으로 보고 지운다
  session.snapshot.pendingQuestion = undefined;
  emit(session, { type: 'run_started', runId: run.id, request, by, intent: intent === 'ask' ? 'ask' : undefined, at: new Date().toISOString() });
  void execute(session, run, request, plan);
  return { runId: run.id };
}

/**
 * 처리 중인 요청을 취소한다. 샌드박스는 그대로 두고, 에이전트를 멈춘 뒤 이번 요청의 변경을 마지막 체크포인트로 되돌린다.
 * 되돌리기는 실행 쪽에서 이어서 하므로 바로 돌아가고 결과는 run_finished로 알린다
 */
export function cancelRun(id: string, runId: string): void {
  const session = requireSession(id);
  const run = session.run;
  if (!run || run.id !== runId) throw new StudioError(409, '취소할 수 있는 요청이 없습니다. 이미 끝났거나 결과를 저장하는 중입니다');
  if (run.cancel.signal.aborted) return;
  run.stopReason = 'user';
  session.snapshot.cancelling = 'user';
  emit(session, { type: 'run_cancelling', runId });
  run.cancel.abort(new DOMException('요청을 취소했습니다', 'AbortError'));
}

/**
 * 실행 중인 요청에 진행 중 지시를 넣는다. 러너가 다음 모델 호출(또는 다음 턴)에 대화로 넣는다.
 * 지금 하던 도구 호출을 끊지 않는다. 사람이 보는 단일 세션(steering 큐가 있는 실행)만 받는다.
 */
/**
 * 에이전트의 제안(propose_mode)을 받아 요청을 나눠서 병렬·여러 명 비교로 넘겼다고 남긴다(ADR-068).
 * 넘기기 자체(비교·계획 만들기)는 화면이 기존 API로 하고, 여기서는 질문 카드를 치우고 대화에 넘긴 곳을 남긴다.
 * 제안이 없는 질문이거나 다른 질문이면 거부한다(늦게 온 요청이 새 질문을 치우지 않게)
 */
export function recordHandoff(id: string, input: { runId: string; to: 'split' | 'fleet'; href: string }): SessionSnapshot {
  const session = requireSession(id);
  const pending = session.snapshot.pendingQuestion;
  if (!pending?.proposal || pending.runId !== input.runId) throw new StudioError(409, '넘길 제안이 없습니다');
  if (pending.proposal.mode !== input.to) throw new StudioError(409, '제안한 방식과 다릅니다');
  if (!/^\/(fleets|task-plans)\?id=[\w%-]+$/.test(input.href)) throw new StudioError(400, '넘긴 곳 주소가 올바르지 않습니다');
  session.snapshot.pendingQuestion = undefined;
  emit(session, { type: 'question_dismissed', runId: input.runId, to: input.to, href: input.href });
  return session.snapshot;
}

export function steerRun(id: string, text: string): { runId: string } {
  const session = requireSession(id);
  if (session.snapshot.mode === 'demo') throw new StudioError(409, '이 모드는 실행 중 지시를 지원하지 않습니다');
  const run = session.run;
  if (!run) throw new StudioError(409, '실행 중이 아닙니다. 새 요청으로 보내세요');
  if (!run.steering) throw new StudioError(409, '이 실행은 진행 중 지시를 받지 않습니다');
  const directive = text.trim();
  if (!directive) throw new StudioError(400, '지시 내용을 입력하세요');
  run.steering.push(directive);
  emit(session, { type: 'steer_queued', runId: run.id, text: directive });
  return { runId: run.id };
}

export async function stopSession(id: string): Promise<SessionSnapshot> {
  const session = requireSession(id);
  if (session.snapshot.status === 'stopped') return session.snapshot;
  session.stop.abort();
  session.logFollower?.abort();
  clearInterval(session.usageTimer);
  session.fileWatcher?.close();
  await session.sandbox.destroy().catch(() => {});
  // 원격 브라우저는 샌드박스 화면을 중계하므로 샌드박스와 함께 내린다
  await closeRemoteBrowser(id).catch(() => {});
  // 로컬 미리보기 프록시(ADR-113)도 가리키던 서비스가 없어지므로 함께 닫는다
  await closeServicePreviewProxies(id).catch(() => {});
  clearFrames(id);
  session.snapshot.running = false;
  // 사라진 주소로 미리보기를 계속 띄우지 않게 한다
  for (const service of session.snapshot.services) {
    Object.assign(service, { state: 'stopped', url: undefined, previewUrl: undefined, detail: undefined });
    emit(session, { type: 'service', service: service.name, state: 'stopped' });
  }
  setStatus(session, 'stopped');
  await flushPersist(session);
  return session.snapshot;
}

/**
 * 작업 목록에서 세션 기록 자체를 지운다(중지와 다르다 — 중지는 샌드박스만 내리고 기록은 남긴다).
 * 실행 중(샌드박스가 떠 있거나 준비 중)이면 지우지 않고 먼저 멈추라고 알린다. 세션 하나만 지우는 화면 동작은
 * 사용자가 실행 중인 세션을 실수로 잃지 않도록 명시적으로 멈춘 뒤에만 허용한다(플릿·작업 계획을 통째로 지울 때는
 * stopAndDeleteSession으로 먼저 멈추고 지운다 — 그 경우는 상위 묶음을 지우겠다는 의사가 이미 분명하다).
 * 지운 뒤에는 작업 복사본(또는 내 폴더 세션의 상태 폴더)도 디스크에서 지운다. 내 폴더 세션은 사용자의 폴더 자체를
 * 지우면 안 되므로 항상 상태 폴더(stateDir)만 지운다.
 */
export async function deleteSession(id: string): Promise<void> {
  await recoverSessions();
  const live = store.sessions.get(id);
  const entry = archived.get(id);
  if (!live && !entry) throw new StudioError(404, '세션을 찾을 수 없습니다');
  // 켜지 못한(failed) 세션은 목록에 멈출 버튼이 없다. 남은 컨테이너를 먼저 정리(중지)하고 지운다
  if (live?.snapshot.status === 'failed') await stopSession(id).catch(() => {});
  const snapshot = (live ?? entry)!.snapshot;
  // idle(지연 기동, 아직 켜지 않음)은 지울 샌드박스가 없어 그대로 지울 수 있다. 그 밖의 실행 중 상태는 먼저 멈춰야 한다
  if (snapshot.status !== 'stopped' && snapshot.status !== 'idle') {
    throw new StudioError(409, '실행 중인 세션은 지울 수 없습니다. 먼저 샌드박스를 중지한 뒤 지우세요');
  }

  const workspace = snapshot.workspace ?? 'copy';
  const dir = stateDirOf(snapshot);
  // 내 폴더 세션은 사용자 폴더를 지우면 안 된다. stateDir이 없어 workDir과 같아지면(있어야 하는데 없으면) 안전하게 멈춘다
  if (workspace === 'local' && dir === snapshot.workDir) {
    throw new StudioError(500, '내 폴더 세션의 상태 폴더를 확인하지 못해 지우지 않았습니다');
  }
  assertWithinSessionsRoot(dir);

  if (live) {
    clearTimeout(live.persist.timer);
    store.sessions.delete(id);
  }
  if (entry) archived.delete(id);
  // 두 세션이 같은 폴더를 잡지 못하게 막는 표시. 남아 있으면 그 폴더로 새 세션을 영영 시작하지 못한다
  claimedFolders.delete(snapshot.workDir);

  await rm(dir, { recursive: true, force: true });
}

/** 지울 폴더가 세션 저장소 루트 밖이거나 루트 그 자체면 거부한다(경로 조작·설정 오류 방어) */
function assertWithinSessionsRoot(dir: string): void {
  const root = path.resolve(sessionsRoot());
  const target = path.resolve(dir);
  const relative = path.relative(root, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new StudioError(500, `삭제할 폴더가 세션 저장소 밖에 있습니다: ${dir}`);
  }
}

/**
 * 세션을 멈추고 b-studio 기록까지 지운다(최선 노력, 실패해도 던지지 않는다).
 * 플릿·작업 계획을 통째로 지울 때 구성원 세션을 함께 정리하는 데 쓴다 — 상위 묶음을 지우겠다는 의사가
 * 이미 분명하므로, 화면에서 낱개 세션을 지울 때와 달리 실행 중이어도 먼저 멈추고 지운다.
 */
export async function stopAndDeleteSession(id: string): Promise<void> {
  await stopSession(id).catch(() => {});
  await deleteSession(id).catch(() => {});
}

/**
 * 중지된 세션을 같은 작업 복사본과 체크포인트로 새 샌드박스에서 다시 띄운다.
 * 이 프로세스에서 중지한 세션과 이전 스튜디오 프로세스가 남긴 세션 모두 같은 id로 이어진다
 */
export async function resumeSession(id: string): Promise<SessionSnapshot> {
  await recoverSessions();
  const live = store.sessions.get(id);
  const entry = archived.get(id);
  if (!live && !entry) throw new StudioError(404, '세션을 찾을 수 없습니다');
  if (live && live.snapshot.status !== 'stopped') throw new StudioError(409, '샌드박스를 중지한 세션만 이어서 작업할 수 있습니다');
  if (resuming.has(id)) throw new StudioError(409, '이미 이어서 작업할 준비를 하는 중입니다');

  resuming.add(id);
  let release: (() => void) | undefined;
  try {
    let data: PersistedSession;
    let history: StudioEvent[];
    if (live) {
      // 중지한 세션의 늦은 저장이 새 세션의 파일을 덮어쓰지 않게 기다린다
      clearTimeout(live.persist.timer);
      await live.persist.chain;
      data = toPersisted(live);
      history = closeUnfinished(data.history, INTERRUPTED_BY_STOP);
    } else {
      await entry!.cleanup;
      data = entry!.data;
      history = entry!.history;
    }

    // 이어서 작업하는 세션도 지금 스튜디오 서버에 설정한 한도를 따른다
    const tokenLimit = sessionTokenLimit();
    // 실행 경로는 이 세션이 저장한 backend를 따른다. 다만 **지금 서버가 허용하는 백엔드**여야 한다.
    // 예전의 "만들 때 모드와 같아야 한다" 검사가 막던 것(예: 개인 PC에서 claude-code로 만든 세션을 API 모드 공유 서버에서
    // 이어서 돌리면 서버에서 로컬 CLI를 부르게 된다)을 허용 목록으로 계속 막는다
    const backend = assertResumableBackend(data.snapshot);
    const { workDir } = data.snapshot;
    const local = data.snapshot.workspace === 'local';
    if (local) assertLocalFolderAllowed();
    if (!(await stat(workDir).then((info) => info.isDirectory(), () => false))) {
      throw new StudioError(409, `${local ? '내 폴더가' : '작업 복사본이'} 없어 이어서 작업할 수 없습니다: ${workDir}`);
    }
    if (local) release = claimFolder(workDir, id);

    const checkpoints = new CheckpointStore(workDir, {
      author: gitAuthor(),
      ...(local ? { gitDir: path.join(stateDirOf(data.snapshot), '.git') } : { excludedFiles: generatedFilePaths }),
    });
    const project = await loadProject(await checkpoints.projectRoot());
    const secrets = await resolveSecrets(project);
    const previous = (await checkpoints.list())[0]!;
    let discarded: string[] = [];
    let discardBackup: DiscardBackup | undefined;
    let localEdits: Checkpoint | undefined;
    if (local) {
      // 샌드박스를 멈춘 동안 IDE에서 고친 파일일 수 있어 버리지 않고 체크포인트로 남긴다
      const redactor = new Redactor(secrets);
      localEdits = await commitLocalEdits(checkpoints, (text) => redactor.find(text)).catch((error: unknown) => {
        throw new StudioError(409, `폴더에서 바뀐 파일을 체크포인트로 남기지 못해 이어서 작업하지 않았습니다: ${describe(error)}`);
      });
      if (localEdits) history = [...history, { type: 'local_edits_saved', checkpoint: localEdits, reason: 'resume' }];
    } else {
      // 끝내지 못한 요청이 남긴 변경은 검증 게이트를 통과하지 않았으므로 버리지만, 문서는 먼저 지키고(ADR-099)
      // 남은 변경은 되살릴 수 있게 백업한 뒤에야 마지막 체크포인트에서 시작한다
      const redactor = new Redactor(secrets);
      const { docsCheckpoint, files, backup } = await discardWorkingCopy(checkpoints, (text) => redactor.find(text));
      discarded = files;
      discardBackup = backup;
      if (docsCheckpoint) history = [...history, { type: 'docs_checkpoint', checkpoint: docsCheckpoint }];
    }
    const list = await checkpoints.list();
    const head = list[0]!;
    // 이어서 작업해도 프로젝트에서 저장한 서비스 선택(ADR-083)을 다시 따른다(세션이 멈춰 있는 동안 화면에서 바꿨을 수 있다)
    const serviceSelection = await resolveServiceSelection(project, data.snapshot.projectId);
    const provider = providerFromEnv();
    const sandbox = await provider.create(project, { secrets });

    const session = newSession({
      snapshot: {
        ...data.snapshot,
        ...projectViews(project, 'starting', project.offServices),
        status: 'starting',
        error: undefined,
        running: false,
        cancelling: undefined,
        tokenLimit,
        usage: undefined,
        runtime: provider.isolation,
        checkpoints: list,
        repository: await describeRepository(checkpoints, data.sourceDirtyFiles),
        nextDemoRequest: backend === 'demo' ? demoScenarios(project)[data.demoIndex]?.request : undefined,
        nextDemoQuestion: backend === 'demo' ? demoScenarios(project)[data.demoIndex]?.question?.request : undefined,
      },
      project,
      sandbox,
      provider: provider.name,
      checkpoints,
      history,
      // 열려 있는 화면의 구독을 그대로 넘겨받는다
      listeners: live?.listeners ?? entry!.listeners,
      conversation: data.conversation as Conversation,
      demoIndex: data.demoIndex,
      claudeCode: { sessionId: data.claudeCode.sessionId, notes: [...data.claudeCode.notes], autoTier: data.claudeCode.autoTier },
      // 이 필드가 생기기 전에 저장한 기록에는 없다
      codex: { notes: [...(data.codex?.notes ?? [])], recent: [...(data.codex?.recent ?? [])] },
      commandCode: { sessionId: data.commandCode?.sessionId, notes: [...(data.commandCode?.notes ?? [])] },
      // 이 필드가 생기기 전에 저장한 기록에는 없다
      openCode: { sessionId: data.openCode?.sessionId, notes: [...(data.openCode?.notes ?? [])] },
      // 이 필드가 생기기 전에 저장한 기록에는 없다
      gemini: { sessionId: data.gemini?.sessionId, notes: [...(data.gemini?.notes ?? [])] },
      sourceDirtyFiles: data.sourceDirtyFiles,
      // 이어서 작업하기는 샌드박스를 바로 켠다(지연 기동이 아니다)
      lazy: false,
      serviceSelection,
      // 이어서 작업해도 열어 둔 미리보기 주소가 그대로 동작하게 같은 토큰을 쓴다
      previewToken: data.previewToken ?? randomBytes(16).toString('hex'),
    });
    // 세션 단위 디자인 설정을 되살리고, 화면 상태를 다시 계산한다(studio.yaml 설정이 바뀌었을 수 있다)
    session.design = data.design;
    session.snapshot.design = sessionDesignView(session);

    // 샌드박스가 바뀌었다는 사실과 버린 변경을 다음 요청에서 알 수 있게 대화에 남긴다
    const note = [
      `[b-studio] 세션을 새 샌드박스에서 이어서 시작했습니다. ${local ? '작업 폴더와' : '작업 복사본과'} 데이터베이스는 체크포인트 ${head.shortSha}("${head.message}") 상태입니다.`,
      ...(discarded.length > 0 ? [discardedNote(discarded, discardBackup)] : []),
      ...(localEdits
        ? [`중지한 동안 폴더에서 바뀐 파일 ${localEdits.files.length}개를 이 체크포인트로 남겼습니다: ${localEdits.files.slice(0, 20).join(', ')}. 이 파일을 다루기 전에 다시 읽으세요.`]
        : []),
    ].join(' ');
    noteForModel(session, note);

    archived.delete(id);
    store.sessions.set(id, session);
    registerCleanup();
    const preview = previewConfig();
    if (preview) ensurePreviewGateway(preview);
    for (const listener of session.listeners) replay(session, listener);
    void flushPersist(session);
    // 이어서 작업하기는 만들자마자 켠다. bootPromise를 남겨 지연 기동 경로(ensureBooted)와 같은 규칙을 쓴다
    // DB 복원 기준점은 항상 previous.sha(이 함수 맨 위, localEdits·discardWorkingCopy가 새 체크포인트를 남기기 전에
    // 잡아 둔 값)를 쓴다. localEdits·discardWorkingCopy가 만드는 체크포인트는 saveDatabases를 부르지 않아 DB 덤프가
    // 없으므로, boot()가 그 체크포인트의 sha로 복원하면 덤프를 찾지 못해 DB가 그대로 남는다(ADR-018·ADR-131 실측)
    session.bootPromise = boot(session, { discarded, discardBackup, databaseFrom: previous.sha });
    return session.snapshot;
  } finally {
    resuming.delete(id);
    release?.();
  }
}

/**
 * 프로세스마다 한 번, 세션 폴더에 남은 세션을 읽는다.
 * 비정상 종료로 샌드박스가 남은 세션은 샌드박스를 정리하고, 모든 세션을 중지 상태로 보여 준다
 */
export function recoverSessions(): Promise<void> {
  store.recovery ??= recover().catch((error: unknown) => console.error('[b-studio] 이전 세션을 읽지 못했습니다', error));
  return store.recovery;
}

async function recover(): Promise<void> {
  for (const data of await readSessions(sessionsRoot())) {
    const { id } = data.snapshot;
    if (store.sessions.has(id) || archived.has(id)) continue;
    // 같은 세션 폴더를 쓰는 다른 스튜디오 프로세스가 실행 중이면 그 세션은 건드리지 않는다
    if (data.owner.pid !== process.pid && isProcessAlive(data.owner.pid)) continue;

    // idle은 샌드박스를 한 번도 켜지 않은 세션이라 정리할 컨테이너가 없다. 끼어든 요청도 없다
    const interrupted = data.snapshot.status !== 'stopped' && data.snapshot.status !== 'idle';
    const entry: ArchivedSession = {
      data,
      snapshot: archivedSnapshot(data, interrupted ? '스튜디오 서버가 다시 시작돼 이전 샌드박스를 정리하는 중입니다.' : undefined),
      history: closeUnfinished(data.history, interrupted ? INTERRUPTED_BY_RESTART : INTERRUPTED_BY_STOP),
      listeners: new Set(),
      cleanup: Promise.resolve(),
    };
    archived.set(id, entry);
    if (interrupted) entry.cleanup = cleanupSandbox(entry);
  }
}

async function cleanupSandbox(entry: ArchivedSession): Promise<void> {
  const { id: sandboxId, provider: providerName } = entry.data.sandbox;
  let error: string;
  let cleaned = false;
  try {
    const provider = providerFromEnv();
    if (provider.name !== providerName || !provider.cleanup) {
      throw new Error(`지금 설정한 샌드박스 제공자(${provider.name})가 이 세션을 만든 제공자(${providerName})와 다릅니다`);
    }
    await provider.cleanup(sandboxId);
    cleaned = true;
    error = '스튜디오 서버가 다시 시작돼 이전 샌드박스를 정리했습니다. 작업 복사본과 체크포인트는 남아 있어 이어서 작업할 수 있습니다.';
  } catch (cause) {
    error = `이전 샌드박스 ${sandboxId}를 정리하지 못했습니다: ${describe(cause)}`;
  }

  entry.snapshot = { ...entry.snapshot, error };
  for (const listener of entry.listeners) listener({ type: 'status', status: 'stopped', error });
  // 정리하지 못했으면 파일을 그대로 두어 다음 실행에서 다시 정리한다
  if (cleaned) {
    entry.data = { ...entry.data, savedAt: new Date().toISOString(), owner: { pid: process.pid }, snapshot: entry.snapshot, history: entry.history };
    await writeSession(entry.data).catch((cause: unknown) => console.error('[b-studio] 세션 상태를 저장하지 못했습니다', cause));
  }
}

export async function contractFor(id: string, service: string): Promise<unknown> {
  const session = requireSession(id);
  const spec = session.project.managed.find(([name]) => name === service)?.[1];
  if (!spec?.contract) throw new StudioError(404, `${service} 서비스는 API 계약을 제공하지 않습니다`);
  const endpoint = await session.sandbox.endpoint(service);
  const response = await fetch(new URL(spec.contract.extract, endpoint.url), { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new StudioError(502, `계약을 가져오지 못했습니다 (HTTP ${response.status})`);
  return response.json();
}

export async function endpointFor(id: string, service: string): Promise<string> {
  const session = requireSession(id);
  if (!session.project.managed.some(([name]) => name === service)) throw new StudioError(404, `${service} 서비스가 없습니다`);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비되지 않았습니다');
  return (await session.sandbox.endpoint(service)).url;
}

/** 헤더의 "+N" 팝오버·서비스 메뉴가 보여 줄 서비스 목록 한 줄 */
export interface ServiceSelectionView {
  name: string;
  role: 'managed' | 'supporting';
  selected: boolean;
  /** 이 서비스가 기대는(compose depends_on) 서비스 이름 */
  dependsOn: string[];
  /** 지금 선택 중 이 서비스에 기대는 서비스 이름. 끄기 전 경고에 쓴다(비어 있으면 안전하게 끌 수 있다) */
  dependents: string[];
}

/** 이 세션이 띄울 수 있는 서비스와 지금 선택 상태(ADR-083) */
export function listServiceSelection(id: string): ServiceSelectionView[] {
  const session = requireSession(id);
  const { project, serviceSelection } = session;
  const managedNames = new Set(project.managed.map(([name]) => name));
  return [...project.composeServices]
    .sort((a, b) => Number(managedNames.has(b)) - Number(managedNames.has(a)) || a.localeCompare(b))
    .map((name) => ({
      name,
      role: managedNames.has(name) ? 'managed' : 'supporting',
      selected: serviceSelection.has(name),
      dependsOn: project.dependsOn[name] ?? [],
      dependents: dependentsOf(name, serviceSelection, project.dependsOn),
    }));
}

/**
 * 서비스 하나를 켜거나 끈다(ADR-083). 껐는데 다른 선택된 서비스가 기대고 있어도 막지 않고 경고 문구만 돌려준다.
 * 선택은 프로젝트 상태 폴더에 저장해 다음 세션·기동에도 이어진다. 세션이 떠 있으면 컨테이너도 바로 켜거나 끈다
 * (관리형 서비스를 켤 때는 restart()로 다시 빌드하고 준비될 때까지 기다린다. 끌 때·부가 서비스는 setServiceRunning을 쓴다)
 */
export async function setSessionServiceSelection(id: string, service: string, on: boolean): Promise<{ selection: ServiceSelectionView[]; warning?: string }> {
  const session = requireSession(id);
  const { project } = session;
  if (!project.composeServices.includes(service)) throw new StudioError(404, `'${service}'은(는) 이 프로젝트의 서비스가 아닙니다`);
  const isManaged = project.managed.some(([name]) => name === service);
  const dependents = !on ? dependentsOf(service, session.serviceSelection, project.dependsOn) : [];
  const warning = dependents.length > 0 ? `${dependents.join(', ')}가 ${service}에 기댑니다 — 끄면 ${dependents.join(', ')}가 여기에 붙지 못할 수 있습니다` : undefined;

  const next = new Set(session.serviceSelection);
  if (on) next.add(service);
  else next.delete(service);
  session.serviceSelection = next;
  project.offServices = offManagedServices(project, next);
  await writeServiceSelection(session.snapshot.projectId, [...next]);

  // 세션이 아직 켜지지 않았으면(idle) 다음 기동 때 선택이 반영되므로 지금 컨테이너를 건드리지 않는다
  if (session.snapshot.status === 'ready' || session.snapshot.status === 'starting') {
    if (isManaged && on) {
      // restart()가 빌드하고 준비 판정까지 기다리며, 화면 상태(starting → probing → ready/failed)도 직접 알린다
      await session.sandbox.restart(service, { signal: session.stop.signal, onStatus: (event) => onServiceStatus(session, event) });
    } else if (!session.sandbox.setServiceRunning) {
      throw new StudioError(501, '이 샌드박스 제공자는 서비스를 켜고 끄는 것을 지원하지 않습니다');
    } else {
      await session.sandbox.setServiceRunning(service, on, { signal: session.stop.signal });
      // 관리형 서비스를 껐을 때만 화면 상태가 있다(부가 서비스는 ServiceView가 없다)
      if (isManaged) onServiceStatus(session, { service, phase: 'off' });
    }
  }

  return { selection: listServiceSelection(id), ...(warning ? { warning } : {}) };
}

/**
 * "이 세션에도 적용"(ADR-101): "생성 파일 다시 만들기"가 프로젝트 원본 폴더에 막 다시 쓴 파일(studio.yaml·
 * compose.b-studio.yaml·Dockerfile.b-studio)을 이미 떠 있는 이 세션에도 반영한다.
 *
 * 내 폴더 세션(workspace: local)은 작업 폴더가 원본 폴더 그 자체라 이미 최신이므로 파일을 복사하지 않는다.
 * 작업 복사본 세션은 overlayGeneratedFiles와 같은 자리(세션 복제 폴더)에 지정한 파일만 덮어쓴다.
 * 그다음 restartServicesFor로 — 에이전트가 파일을 바꿨을 때와 똑같은 경로로 — 영향받은 서비스를 다시 빌드해 띄운다.
 * 새로 만드는 세션은 이미 자동으로 최신 파일을 받으므로(overlayGeneratedFiles가 세션 시작 때 원본에서 그대로 복사한다)
 * 이 함수가 필요한 것은 이미 떠 있는 세션뿐이다.
 */
export async function applyRegeneratedFilesToSession(id: string, files: readonly string[]): Promise<{ restarted: ServiceCheck[]; skippedOff: string[] }> {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 적용할 수 있습니다');
  if (session.snapshot.running || session.exporting) throw new StudioError(409, '다른 작업을 처리하는 중입니다');
  if (files.length === 0) return { restarted: [], skippedOff: [] };

  const registered = await findRegisteredProject(session.snapshot.projectId);
  if (!registered) throw new StudioError(409, '폴더로 연 프로젝트가 아니라 적용할 생성 파일이 없습니다');

  if (session.snapshot.workspace !== 'local') {
    await applyGeneratedFilesToWorkingCopy(registered.path, session.project.root, session.checkpoints.root, files);
  }
  // 바뀐 studio.yaml·compose를 읽어야 새 환경 변수·마운트·pageChecks가 재시작에 반영된다. 못 읽으면(일시적인 디스크 문제 등)
  // 지금 쓰던 설정을 그대로 두고 재시작만 시도한다 — 세션을 깨뜨리는 대신 다음에 다시 시도할 여지를 남긴다
  await reloadSessionProject(session);

  session.snapshot.running = true;
  try {
    const start: StartOptions = { signal: session.stop.signal, onStatus: (event) => onServiceStatus(session, event) };
    const result = await restartServicesFor(session.sandbox, session.project, [...files], start);
    return { restarted: result.restarted, skippedOff: result.skippedOff };
  } finally {
    session.snapshot.running = false;
  }
}

/** 화면 확인 스크린샷과 요소 선택 스크린샷을 세션 폴더에 저장한다. 저장 위치는 agent가 모른다 */
function saveSessionArtifact(session: Session, runId: string, input: { name: string; data: Buffer; contentType: 'image/png' | 'image/jpeg' }): Promise<string> {
  return saveArtifact(stateDirOf(session.snapshot), runId, input);
}

/** 라우트가 산출물을 내려줄 때 쓴다. 중지된 세션의 산출물도 볼 수 있게 스냅샷으로 세션 폴더를 찾는다 */
export async function readSessionArtifact(id: string, segments: readonly string[]): Promise<{ file: string; contentType: 'image/png' | 'image/jpeg' }> {
  const snapshot = getSnapshot(id);
  if (!snapshot) throw new StudioError(404, '세션을 찾을 수 없습니다');
  return resolveArtifact(stateDirOf(snapshot), segments);
}

/** 탐색형 QA 행동마다 찍은 썸네일을 산출물로 저장하고 식별자를 돌려준다 */
export async function saveExploreQaArtifact(id: string, input: { name: string; data: Buffer; contentType: 'image/png' | 'image/jpeg' }): Promise<string> {
  const session = requireSession(id);
  return saveArtifact(stateDirOf(session.snapshot), 'explore-qa', input);
}

/** 요소 선택 스크린샷을 산출물로 저장하고 식별자를 돌려준다 */
export async function saveElementArtifact(id: string, input: { name: string; data: Buffer; contentType: 'image/png' | 'image/jpeg' }): Promise<string> {
  const session = requireSession(id);
  return saveArtifact(stateDirOf(session.snapshot), 'pick', input);
}

/**
 * 화면 미리보기 iframe이 열 로컬 프록시 주소(ADR-113). 원격 미리보기 게이트웨이(previewUrl)를 켰으면 그 주소가
 * 이미 studio와 다른 출처로 위치 알림을 스크립트로 심어 보내므로, 이 로컬 프록시는 게이트웨이를 안 쓸 때만 부른다.
 * 서비스가 재시작해 포트가 바뀌어도 프록시는 유지하고 가리키는 주소만 바꾼다
 */
export async function localPreviewUrl(id: string, service: string): Promise<string> {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 미리보기를 열 수 있습니다');
  const view = session.snapshot.services.find((candidate) => candidate.name === service);
  if (!view?.url) throw new StudioError(409, `${service} 서비스의 주소가 없습니다. 서비스가 준비된 뒤 다시 시도하세요`);
  return ensureServicePreviewProxy(id, service, view.url);
}

/**
 * 원격 브라우저가 열 미리보기 주소. iframe 미리보기와 같은 규칙(게이트웨이 주소가 있으면 그것, 없으면 서비스 주소)을 쓴다.
 * 서버가 직접 여는 주소이므로 다른 출처로 나가지 않도록 이 값만 넘긴다
 */
export function remoteBrowserUrl(id: string, service: string): string {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 원격 브라우저를 열 수 있습니다');
  const view = session.snapshot.services.find((candidate) => candidate.name === service);
  if (!view) throw new StudioError(404, `${service} 서비스가 없습니다`);
  const url = view.previewUrl ?? view.url;
  if (!url) throw new StudioError(409, `${service} 서비스의 미리보기 주소가 없습니다. 서비스가 준비된 뒤 다시 시도하세요`);
  return url;
}

/**
 * 원격 브라우저가 요청해도 되는 출처 목록. 세션의 모든 서비스 주소(루프백·미리보기 게이트웨이)의 출처를 모은다.
 * 프론트가 다른 포트의 백엔드를 부르므로 한 서비스만 허용하면 앱이 망가지고, 그 밖의 출처로는 나가지 못하게 한다
 */
export function remoteBrowserAllowedOrigins(id: string): string[] {
  const session = requireSession(id);
  const origins = new Set<string>();
  for (const service of session.snapshot.services) {
    for (const url of [service.url, service.previewUrl]) {
      if (!url) continue;
      try {
        origins.add(new URL(url).origin);
      } catch {
        // 준비 중 잠깐 이상한 값이 있어도 다른 서비스 주소는 살린다
      }
    }
  }
  return [...origins];
}

/**
 * 탐색형 QA가 세션의 백엔드·모델 선택을 그대로 물려받기 위한 정보. api 백엔드는 세션이 고른 모델로 바로 쓸 ModelClient를
 * 만들어 주고, claude-code 백엔드는 작업 디렉터리와 넘길 모델 이름만 돌려준다(실행은 explore-qa-runs.ts가 한다).
 * 그 밖의 백엔드(codex·commandcode·opencode·gemini)는 아직 지원하지 않는다 — 각 CLI의 b-studio 도구 연결 방식이
 * 서로 달라(스트리밍 입력·MCP 구성이 제각각) 탐색형 QA까지 넓히는 일은 이후 과제로 남긴다.
 */
export type ExploreQaBackend =
  | { kind: 'api'; client: ModelClient }
  | { kind: 'claude-code'; cwd: string; model?: string }
  | { kind: 'unsupported'; backend: SessionMode };

export function exploreQaBackendFor(id: string): { projectRoot: string; backend: ExploreQaBackend } {
  const session = requireSession(id);
  const backend = sessionBackend(session.snapshot);
  const projectRoot = session.project.root;
  if (backend === 'api') {
    let model;
    try {
      model = modelById(session.snapshot.modelId ?? 'anthropic-default');
    } catch {
      model = modelById('anthropic-default');
    }
    return { projectRoot, backend: { kind: 'api', client: clientForModel(model, session.snapshot.effort) } };
  }
  if (backend === 'claude-code') {
    const model = cliModelOverride(session.snapshot.modelId);
    return { projectRoot, backend: { kind: 'claude-code', cwd: projectRoot, ...(model ? { model } : {}) } };
  }
  return { projectRoot, backend: { kind: 'unsupported', backend } };
}

/** 세션 단위 Figma 파일 키가 있으면 그걸, 없으면 studio.yaml의 design.figma를 쓴다 */
function effectiveDesign(session: Pick<Session, 'design' | 'project'>): { fileUrl: string; fileKey: string } | undefined {
  if (session.design) return session.design;
  const figma = session.project.spec.design?.figma;
  return figma ? { fileUrl: figma.fileUrl, fileKey: figma.fileKey } : undefined;
}

/** 화면에 보여 줄 디자인 상태. 토큰 값은 넣지 않고 설정 여부만 알린다 */
function sessionDesignView(session: Pick<Session, 'design' | 'project'>): DesignView | undefined {
  const design = effectiveDesign(session);
  if (!design) return undefined;
  return { fileUrl: design.fileUrl, fileKey: design.fileKey, from: session.design ? 'session' : 'studio.yaml', hasToken: Boolean(process.env.FIGMA_TOKEN) };
}

/** HMR로 모듈이 다시 로드돼도 같은 캐시를 쓰도록 전역에 둔다. 토큰은 만들 때 읽으므로 바꾸려면 서버를 다시 시작한다 */
function figmaClient(): FigmaClient {
  return (store.figma ??= new FigmaClient({ token: process.env.FIGMA_TOKEN, baseUrl: process.env.B_STUDIO_FIGMA_API }));
}

/** 세션 단위로 Figma URL을 저장한다(studio.yaml은 스튜디오가 고치지 않는다). 빈 값이면 세션 설정을 지운다 */
export function setSessionDesign(id: string, fileUrl: string): DesignView | undefined {
  const session = requireSession(id);
  const trimmed = fileUrl.trim();
  if (trimmed === '') {
    session.design = undefined;
  } else {
    const fileKey = figmaFileKey(trimmed);
    if (!fileKey) throw new StudioError(400, 'Figma 디자인 URL(https://www.figma.com/design/<key>/...)이어야 합니다');
    session.design = { fileUrl: trimmed, fileKey };
  }
  const design = sessionDesignView(session);
  session.snapshot.design = design;
  emit(session, { type: 'design', design });
  return design;
}

/** 대화 입력창의 모델 선택 화면용. 이 세션 백엔드에서 고를 수 있는 목록과 지금 고른 값(모델·노력 단계)을 함께 돌려준다 */
export async function sessionModelPicker(id: string): Promise<ModelPickerView> {
  const session = requireSession(id);
  return listSelectableModels(sessionBackend(session.snapshot), session.snapshot.modelId, session.snapshot.effort);
}

/**
 * 대화 입력창에서 이 세션이 쓸 모델·노력 단계를 바꾼다. 다음 요청부터 적용된다
 * (planRun이 매번 session.snapshot.modelId·effort를 다시 읽는다).
 * 요청을 처리하는 동안에는 바꾸지 못한다(실행 중인 요청과 엇갈리지 않게).
 *
 * modelId·effort 둘 다 **넘기지 않으면(undefined) 지금 값을 그대로 둔다** — 팝오버가 둘 중 하나만 바꿀 수 있다(PATCH와 같은 규칙).
 * 값을 넘기면(빈 문자열 포함) 그 필드를 그 값으로 바꾼다. 빈 문자열은 "기본"(오버라이드 없음)으로 되돌리는 명시적 요청이다.
 * 바뀐 값은 이 프로젝트·백엔드의 다음 새 세션 기본값으로도 남긴다(model-defaults.ts)
 */
export async function setSessionModel(id: string, modelId: string | undefined, effort?: string): Promise<ModelPickerView> {
  const session = requireSession(id);
  if (session.snapshot.running) throw new StudioError(409, '요청을 처리하는 동안에는 모델을 바꿀 수 없습니다');
  const backend = sessionBackend(session.snapshot);
  if (modelId !== undefined) {
    const trimmedModel = modelId.trim();
    const modelCheck = await isSelectableModel(backend, trimmedModel);
    if (!modelCheck.ok) throw new StudioError(400, modelCheck.reason ?? `이 백엔드에서 고를 수 없는 모델입니다: ${trimmedModel}`);
    session.snapshot.modelId = trimmedModel || undefined;
    rememberProjectModelDefault(session.snapshot.projectId, backend, session.snapshot.modelId);
  }
  if (effort !== undefined) {
    const trimmedEffort = effort.trim();
    // modelId도 이번 호출에서 함께 바뀌었으면 그 새 모델을 기준으로 노력 단계를 확인한다(api 백엔드는 모델마다 지원이 다르다)
    const effortCheck = await isSelectableEffort(backend, session.snapshot.modelId, trimmedEffort);
    if (!effortCheck.ok) throw new StudioError(400, effortCheck.reason ?? `이 백엔드에서 고를 수 없는 노력 단계입니다: ${trimmedEffort}`);
    session.snapshot.effort = (trimmedEffort || undefined) as Effort | undefined;
    rememberProjectEffortDefault(session.snapshot.projectId, backend, session.snapshot.effort);
  }
  emit(session, { type: 'model', modelId: session.snapshot.modelId, effort: session.snapshot.effort });
  return listSelectableModels(backend, session.snapshot.modelId, session.snapshot.effort);
}

/** 디자인 목록 화면용. 설정·토큰이 없으면 빈 목록을 돌려주고, 있으면 Figma에서 프레임을 읽는다 */
export async function sessionDesignFrames(id: string): Promise<{ design?: DesignView; frames: DesignFrameInfo[] }> {
  const session = requireSession(id);
  const design = effectiveDesign(session);
  if (!design || !process.env.FIGMA_TOKEN) return { design: sessionDesignView(session), frames: [] };
  const frames = await figmaClient().listFrames(design.fileKey, session.stop.signal);
  return { design: sessionDesignView(session), frames: frames.map((frame) => ({ id: frame.id, name: frame.name, page: frame.page, width: frame.width, height: frame.height })) };
}

/** 디자인 패널의 프레임 썸네일. 비교용이 아니라 목록용이라 작은 배율로 받는다 */
export async function sessionDesignThumbnail(id: string, frameId: string): Promise<Buffer> {
  const session = requireSession(id);
  const design = effectiveDesign(session);
  if (!design) throw new StudioError(409, '디자인(Figma)이 설정되지 않았습니다');
  const images = await figmaClient().exportImages(design.fileKey, [frameId], { scale: 0.5 }, session.stop.signal);
  const png = images.get(frameId);
  if (!png) throw new StudioError(404, '프레임 이미지를 찾지 못했습니다');
  return png;
}

export interface DesignImportResult {
  files: Array<{ frameId: string; name: string; path: string; width: number; height: number }>;
  /** pageChecks.compare에 붙여 넣을 예시. scale이 1일 때만 만든다 */
  examples: string[];
  note?: string;
}

/**
 * 고른 프레임을 PNG로 받아 세션 작업 복사본의 `design/`에 저장한다(=세션 변경으로 남아 체크포인트·게이트를 탄다).
 * 시각 비교 기준으로 쓰려면 화면 스크린샷과 픽셀 너비가 같아야 하므로 scale 1을 기본으로 한다
 */
export async function importDesign(id: string, frameIds: readonly string[], scale: 1 | 2 = 1): Promise<DesignImportResult> {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 디자인을 가져올 수 있습니다');
  if (session.snapshot.running) throw new StudioError(409, '작업이 끝난 뒤에 디자인을 가져올 수 있습니다');
  const design = effectiveDesign(session);
  if (!design) throw new StudioError(409, '디자인(Figma)이 설정되지 않았습니다');

  const client = figmaClient();
  const frames = (await client.listFrames(design.fileKey, session.stop.signal)).filter((frame) => frameIds.includes(frame.id));
  if (frames.length === 0) throw new StudioError(400, '가져올 프레임을 찾지 못했습니다');
  const images = await client.exportImages(design.fileKey, frames.map((frame) => frame.id), { scale }, session.stop.signal);

  const files: DesignImportResult['files'] = [];
  const examples: string[] = [];
  for (const frame of frames) {
    const png = images.get(frame.id);
    if (!png) throw new StudioError(502, `프레임 ${frame.id} 이미지를 내보내지 못했습니다`);
    const relative = designPathFor(frame);
    await writeDesignPng(session.project, relative, png);
    files.push({ frameId: frame.id, name: frame.name, path: relative, width: frame.width, height: frame.height });
    if (scale === 1) examples.push(compareExample(relative, frame));
  }
  return { files, examples, ...(scale !== 1 ? { note: 'scale 2로 저장한 이미지는 시각 비교 기준(compare)에 쓰려면 scale 1로 다시 가져오세요' } : {}) };
}

/** 디자인 도구가 쓸 자료원. 세션에 디자인이 설정됐을 때만 runPlan이 넘긴다 */
function designSourceFor(session: Session, runId: string): DesignSource | undefined {
  const design = effectiveDesign(session);
  if (!design) return undefined;
  const client = figmaClient();
  return {
    frames: () => client.listFrames(design.fileKey, session.stop.signal),
    frame: (id) => client.summarizeFrame(design.fileKey, id, session.stop.signal),
    // 이미지는 세션 산출물로 저장하고 참조 경로만 모델에 돌려준다(모델에 이미지를 넘기지 않는다)
    saveArtifact: (name, data) => saveArtifact(stateDirOf(session.snapshot), runId, { name, data, contentType: 'image/png' }),
  };
}

const MAX_PROXY_BODY = 200_000;

/** API 탐색기에서 등록한 사내 API를 부른다. 샌드박스 서비스와 같은 정책·인증·가림을 거치고 감사 기록은 edge 로그에 남는다 */
export async function externalRequest(id: string, name: string, input: { method: string; path: string; body: string }): Promise<ProxyResponse> {
  const session = requireSession(id);
  if (!(session.project.external ?? []).some(([external]) => external === name)) throw new StudioError(404, `${name} 사내 API가 없습니다`);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비되지 않았습니다');

  const started = performance.now();
  const result = await session.sandbox.callExternal(
    name,
    { method: input.method, path: input.path, body: input.body || undefined },
    { via: 'explorer', signal: AbortSignal.any([session.stop.signal, AbortSignal.timeout(40_000)]) },
  );
  return {
    status: result.status,
    contentType: result.contentType ?? null,
    body: result.body.slice(0, MAX_PROXY_BODY),
    truncated: result.body.length > MAX_PROXY_BODY,
    durationMs: Math.round(performance.now() - started),
    policy: { decision: result.decision, masked: result.masked, ...(result.reason ? { reason: result.reason } : {}) },
  };
}

/**
 * 샌드박스를 켠다. 동시에 여러 번 불려도 한 번만 켜도록 bootPromise를 공유한다.
 * 이미 켜져 있으면 그냥 돌아오고, 중지 상태면 이유와 함께 거부한다.
 * 실패(failed) 상태는 여기서 끝내지 않는다 — Docker 데몬이 잠깐 죽어 있다가 돌아온 경우(콜리마 재시작 등)
 * 실패를 캐시해 버리면 데몬이 살아난 뒤에도 영원히 같은 옛 오류만 돌려주게 된다. 실패 뒤 다음 시도는
 * 항상 새 bootPromise로 compose build/up을 실제로 다시 밟아 지금 데몬 상태를 묻는다(스튜디오 서버 재시작 없이도)
 * 지연 기동 세션의 첫 필요(샌드박스 도구·첫 파일 변경·게이트·"지금 켜기")가 모두 이 한 곳을 지난다
 */
async function ensureBooted(session: Session): Promise<void> {
  if (session.snapshot.status === 'ready') return;
  if (session.snapshot.status === 'stopped') throw new StudioError(409, '중지된 세션입니다. 이어서 작업하면 새 샌드박스를 띄웁니다');
  if (!session.bootPromise || session.snapshot.status === 'failed') {
    // 처음 켤 때는 의존성 설치 때문에 몇 분 걸릴 수 있다. 켜는 동안 도구 호출·게이트는 이 promise를 기다린다
    emit(session, { type: 'notice', text: '샌드박스를 켜는 중입니다 (처음이면 1분 안팎)', at: new Date().toISOString() });
    session.bootPromise = startBoot(session);
  }
  await session.bootPromise;
  // boot가 실패하면 상태가 failed로 바뀐다(위 가드의 타입 좁히기를 피하려고 단언한다)
  if ((session.snapshot.status as SessionStatus) !== 'ready') throw new StudioError(502, `샌드박스를 켜지 못했습니다: ${session.snapshot.error ?? '알 수 없는 이유'}`);
}

/** 상태를 starting으로 옮기고 boot를 시작한다. 이미 starting이면(즉시 기동 세션) 다시 알리지 않는다 */
function startBoot(session: Session): Promise<void> {
  if (session.snapshot.status !== 'starting') setStatus(session, 'starting');
  return boot(session);
}

/** "지금 켜기": 샌드박스를 지금 켠다. 진행은 이벤트로 알린다(boot API가 쓴다) */
export async function bootSession(id: string): Promise<SessionSnapshot> {
  const session = requireSession(id);
  await ensureBooted(session);
  return session.snapshot;
}

/**
 * 첫 화면(바로 개발, ADR-066)이 쓴다. 지연 기동 세션의 샌드박스 켜기를 **시작만** 하고 기다리지 않는다.
 * 켜는 동안 사람은 개발 화면에서 요청을 적는다. 진행과 실패는 이벤트로 화면에 간다(여기서 던지지 않는다)
 */
export function startBooting(id: string): SessionSnapshot {
  const session = requireSession(id);
  if (session.snapshot.status === 'idle') {
    ensureBooted(session).catch((error: unknown) => {
      console.error(`[b-studio] 세션 ${id}의 샌드박스를 켜지 못했습니다: ${describe(error)}`);
    });
  }
  return session.snapshot;
}

/**
 * resumed가 있으면 이어서 작업하는 세션이다. 새 샌드박스의 데이터베이스를 마지막 체크포인트 상태로 맞춘다.
 * databaseFrom은 이어서 작업하기 전에 폴더의 수정을 새 체크포인트로 남겼을 때, 데이터베이스 상태를 가져올 그 앞 체크포인트다
 */
async function boot(session: Session, resumed?: { discarded: string[]; discardBackup?: DiscardBackup; databaseFrom?: string }): Promise<void> {
  const signal = session.stop.signal;
  const onStatus = (event: ServiceStatusEvent) => onServiceStatus(session, event);
  try {
    await session.sandbox.start({
      signal,
      onStatus,
      // 이 세션이 고른 서비스만 띄운다(ADR-083). 목록에 없는 managed 서비스는 onStatus가 'off'로 알린다
      services: [...session.serviceSelection],
      // 스냅샷 사용 여부는 로그 탭에서 서비스 로그와 함께 보여 준다
      onSnapshot: (event) =>
        emit(session, { type: 'log', service: event.service, text: `[b-studio] ${describeSnapshotEvent(event)}`, at: new Date().toISOString() }),
      // 트러블슈팅 #90: 알려진 일시 오류(ETXTBSY 등)로 죽어 한 번 다시 띄운 사실도 로그 탭에 남긴다 —
      // 성공·실패와 무관하게 재시도했다는 사실 자체를 조용히 넘기지 않는다
      onTransientRetry: (event) =>
        emit(session, {
          type: 'log',
          service: event.service,
          text: `[b-studio] ${event.service} 서비스가 일시 오류로 죽어 한 번 더 띄웁니다: ${event.reason}`,
          at: new Date().toISOString(),
        }),
      // 서비스가 준비된 직후 읽은 기동 중 수신/송신 바이트를 세션 기록에 남긴다(작업 분해 지표도 이 스냅샷에서 읽는다)
      onBootNetwork: (network) => {
        session.snapshot.bootNetwork = network;
        emit(session, { type: 'boot_network', at: new Date().toISOString(), network });
      },
    });
    const head = session.snapshot.checkpoints[0]!;
    if (!resumed) {
      // 서비스가 마이그레이션까지 마친 상태를 세션 시작 체크포인트의 데이터베이스 상태로 남긴다
      await saveDatabases(session, head.sha);
    } else {
      const from = resumed.databaseFrom ?? head.sha;
      const database = await session.databases.restore(from, signal);
      // 기동 전에 서버가 멈춰 저장한 상태가 없거나 폴더의 수정을 새 체크포인트로 남겼으면, 지금 상태를 그 체크포인트의 상태로 남긴다
      if (from !== head.sha || database.states.some((state) => state.action === 'missing')) await saveDatabases(session, head.sha);
      let restarted: ServiceCheck[] = [];
      if (database.dependents.length > 0) {
        // 복원한 데이터베이스에 붙어 있던 연결과 캐시를 버리도록 의존 서비스를 다시 띄운다
        restarted = (await restartServicesFor(session.sandbox, session.project, [], { signal, onStatus }, { alsoRestart: database.dependents })).restarted;
      }
      emit(session, { type: 'resumed', checkpoint: head, discarded: resumed.discarded, databases: database.states, restarted, backup: resumed.discardBackup });
    }
    setStatus(session, 'ready');
  } catch (error) {
    if (!signal.aborted) setStatus(session, 'failed', describe(error));
  }
}

/** build: 파일을 바꾸고 검증 게이트를 거치는 요청, ask: 파일을 바꾸지 않고 답과 계획만 받는 질문 */
type Intent = 'build' | 'ask';

type RunPlan = (
  | {
      kind: 'model';
      client: ModelClient;
      route?: RoutingDecision;
      allowBreaking: boolean;
      maxVerifyAttempts?: number;
      intent: Intent;
      /** 게이트 실패 서명이 반복되면 쓸 승격 클라이언트. 설정하지 않으면 승격 없음 */
      escalation?: EscalationPolicy & { client: ModelClient };
    }
  | {
      kind: 'claude-code';
      allowBreaking: boolean;
      intent: Intent;
      escalation?: EscalationPolicy;
      /** 계획-실행 분리(ADR-075)로 정한 실행 모델. session.snapshot.modelId(레인이 고른 모델)보다는 아래고, B_STUDIO_CLAUDE_CODE_MODEL보다는 위다 */
      executeModel?: string;
      /** claude-code 자동 모델 선택(ADR-091). 세션에서 고른 모델이 'auto'일 때만 있다. tier가 실제로 넘길 모델 이름이다 */
      autoRoute?: CliRouteDecision;
    }
  | { kind: 'codex'; allowBreaking: boolean; intent: Intent }
  | { kind: 'commandcode'; allowBreaking: boolean; intent: Intent }
  | { kind: 'opencode'; allowBreaking: boolean; intent: Intent }
  | { kind: 'gemini'; allowBreaking: boolean; intent: Intent }
) & {
  writableScope?: readonly string[];
  board?: BoardAccess;
  interactive?: boolean;
  verify?: VerifyMode;
  research?: boolean;
  /** 턴 상한 요청 옵션(ADR-131). studio.yaml(workflow.maxTurns)보다 우선한다. 생략하면 studio.yaml 값이나 실행기 기본값(60)을 쓴다 */
  maxTurns?: number;
};

/**
 * 세션 백엔드 → 실행 방식. 데모는 준비된 대본이라 여기 없다(호출자가 시나리오를 고른다).
 * 실행 방식이 늘어나면 이 표를 먼저 늘린다 — 빠뜨리면 아래 데모 경로로 조용히 떨어지므로 테스트로 고정한다.
 */
export function planKindForBackend(backend: SessionMode): RunPlan['kind'] | undefined {
  if (backend === 'api') return 'model';
  if (backend === 'claude-code') return 'claude-code';
  if (backend === 'codex') return 'codex';
  if (backend === 'commandcode') return 'commandcode';
  if (backend === 'opencode') return 'opencode';
  if (backend === 'gemini') return 'gemini';
  return undefined;
}

function planRun(session: Session, request: string, allowBreaking: boolean, intent: Intent): RunPlan {
  // 실행 경로는 서버 모드(B_STUDIO_MODE)가 아니라 **세션의 backend**를 본다. 이 필드가 없으면 mode가 곧 서버 모드다
  const backend = sessionBackend(session.snapshot);
  const kind = planKindForBackend(backend);
  // 계획-실행 분리(ADR-075) 설정. 둘 다 없으면 아래 로직은 지금과 한 글자도 다르지 않게 움직인다
  const split = planExecuteConfig(session.project);
  if (kind === 'model') {
    // 세션이 고른 모델(사람이 직접 선택)이 실행 모델 설정보다 우선한다
    const route = routingDecision(request, intent, session.snapshot.modelId ?? split.execute);
    // 사람이 대화에서 직접 고른 모델일 때만 "같은 모델로 승격" no-op을 본다. 라우터가 고른 값은 다음 요청에서 바뀔 수 있어 대상이 아니다
    const escalation = apiEscalation(split.plan, process.env, session.snapshot.modelId ? route.selected.id : undefined);
    // effort는 Anthropic 모델에만 실제로 전달된다(clientForModel의 anthropic 분기만 받는다). 다른 공급자는 조용히 무시한다
    return { kind: 'model', client: clientForModel(route.selected, session.snapshot.effort), route, allowBreaking, intent, ...(escalation ? { escalation } : {}) };
  }
  if (kind === 'claude-code') {
    const chosenModel = cliModelOverride(session.snapshot.modelId);
    // 자동 모델 선택(ADR-091). 대화에서 고르거나(session.snapshot.modelId === 'auto') 서버 기본값(B_STUDIO_CLAUDE_CODE_MODEL=auto)으로 켤 수 있다
    // — 벤치(apps/studio/bench)가 세션마다 고르는 대신 서버 기본값으로 시작 모델을 넘기므로, 두 경로가 같은 규칙을 따라야 한다.
    // 질문(intent === 'ask')도 읽기만 하는 요청으로 그대로 분류에 넘긴다(routeCliTier가 haiku로 고른다)
    const effectiveModel = chosenModel ?? split.execute ?? (process.env.B_STUDIO_CLAUDE_CODE_MODEL?.trim() || undefined);
    if (effectiveModel === 'auto') {
      const autoRoute = routeCliTier({ prompt: request, intent, stickyTier: session.claudeCode.autoTier });
      const escalation = claudeCodeAutoEscalation(autoRoute.tier);
      return { kind: 'claude-code', allowBreaking, intent, autoRoute, ...(escalation ? { escalation } : {}) };
    }
    const escalation = claudeCodeEscalation(split.plan, process.env, chosenModel);
    return { kind: 'claude-code', allowBreaking, intent, ...(split.execute ? { executeModel: split.execute } : {}), ...(escalation ? { escalation } : {}) };
  }
  if (kind === 'codex') return { kind: 'codex', allowBreaking, intent };
  if (kind === 'commandcode') return { kind: 'commandcode', allowBreaking, intent };
  if (kind === 'opencode') return { kind: 'opencode', allowBreaking, intent };
  if (kind === 'gemini') return { kind: 'gemini', allowBreaking, intent };

  // 데모 모드는 스크립트이므로 준비된 요청과 질문만 순서대로 실행한다. 다른 요청을 받은 척하지 않는다
  const scenario = demoScenarios(session.project)[session.demoIndex];
  if (intent === 'ask') {
    const question = scenario?.question;
    if (!question) throw new StudioError(409, '데모 모드에서 지금 물어볼 수 있는 준비된 질문이 없습니다');
    if (question.request !== request) throw new StudioError(409, `데모 모드는 준비된 질문에만 답합니다. 지금 질문: "${question.request}"`);
    return { kind: 'model', client: new ScriptedModelClient(question.turns), allowBreaking: false, intent };
  }
  if (!scenario) throw new StudioError(409, '데모 모드에서 실행할 수 있는 요청을 모두 실행했습니다');
  // 되묻기 답: 대본의 질문에 대한 답이면 이어서 대본을 실행한다(모델 없이 화면 흐름을 확인하는 용도)
  if (scenario.ask && isDemoAnswer(request, scenario.ask.question)) {
    return { kind: 'model', client: new ScriptedModelClient(scenario.turns), allowBreaking: scenario.allowBreaking ?? false, maxVerifyAttempts: scenario.maxVerifyAttempts, intent };
  }
  if (scenario.request !== request) {
    throw new StudioError(409, `데모 모드는 준비된 요청을 순서대로 실행합니다. 다음 요청: "${scenario.request}"`);
  }
  // 되묻기 단계가 있으면 먼저 ask_user를 부르는 대본을 돌려, 모델 없이 질문 카드를 보여 준다
  if (scenario.ask) {
    return {
      kind: 'model',
      client: new ScriptedModelClient([{ text: scenario.ask.question, toolCalls: [{ name: 'ask_user', input: { ...scenario.ask } }] }]),
      allowBreaking: false,
      intent,
    };
  }
  return {
    kind: 'model',
    client: new ScriptedModelClient(scenario.turns),
    allowBreaking: scenario.allowBreaking ?? false,
    maxVerifyAttempts: scenario.maxVerifyAttempts,
    intent,
  };
}

/** 데모 모드에서 질문 카드의 답으로 보낸 요청인지. 화면은 `[질문] …\n[답] …` 형식으로 보낸다 */
function isDemoAnswer(request: string, question: string): boolean {
  return request.startsWith('[질문]') && request.includes('[답]') && request.includes(question);
}

/**
 * 승격한 뒤 게이트 재시도를 새로 주는 횟수(기본 2). 승격을 켠 실행에서만 뜻이 있다.
 * 0이면 새 예산을 주지 않는다(승격해도 남은 횟수만 쓴다 — 승격 규칙을 넣기 전과 같은 동작)
 */
function escalateRetryBudget(): number {
  return integerEnv('B_STUDIO_ESCALATE_RETRY_BUDGET', 0) ?? 2;
}

/** 서명과 무관하게 게이트 실패가 이만큼이면 올린다. 설정하지 않으면 그 규칙을 쓰지 않는다 */
function escalateAfterFailures(): number | undefined {
  return integerEnv('B_STUDIO_ESCALATE_AFTER_FAILURES', 1);
}

/** 승격 임계치. 같은 실패 서명 집합이 이만큼 연속으로 나오면 올린다(기본 2) */
function escalateAfter(): number {
  return integerEnv('B_STUDIO_ESCALATE_AFTER', 1) ?? 2;
}

/**
 * 에이전트의 자가 확인 범위(B_STUDIO_SELF_CHECK=lean|full, 기본 lean — ADR-064).
 * lean은 게이트가 하는 전체 빌드·테스트와 끝난 변경의 재시작·HTTP 확인을 되풀이하지 말라고 안내하고, 성공한 명령 출력을 짧게 돌려준다.
 * E7에서 성공은 9/9로 같고 성공 1건당 토큰은 41% 적었다. full은 이전 동작이다
 */
export function selfCheckMode(env: Record<string, string | undefined> = process.env): SelfCheckMode {
  const raw = env.B_STUDIO_SELF_CHECK?.trim();
  if (!raw || raw === 'lean') return 'lean';
  if (raw === 'full') return 'full';
  throw new StudioError(500, `B_STUDIO_SELF_CHECK는 full 또는 lean이어야 합니다 (지금 값: ${raw})`);
}

function integerEnv(name: string, min: number): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new StudioError(500, `${name}은 ${min} 이상의 정수여야 합니다 (지금 값: ${raw})`);
  return value;
}

/**
 * API 모드 승격 대상. 모델 레지스트리 id(B_STUDIO_ESCALATE_MODEL_ID)로 지정한다.
 * 없는 id면 기동 시 오류를 내고, 설정하지 않으면 승격하지 않는다(지금 동작과 같다).
 * planModelId: 계획-실행 분리(ADR-075)의 계획 모델 id. 명시적 승격 대상이 없으면 이쪽으로 올린다
 * (이미 계획을 세운 큰 모델이니 실행 모델이 게이트를 반복해서 실패하면 다시 불러오는 것이 자연스럽다).
 */
export function apiEscalation(
  planModelId?: string,
  env: Record<string, string | undefined> = process.env,
  skipIfSameAs?: string,
): (EscalationPolicy & { client: ModelClient }) | undefined {
  const id = env.B_STUDIO_ESCALATE_MODEL_ID?.trim() || planModelId;
  if (!id) return undefined;
  // 사람이 대화에서 이미 이 모델을 실행 모델로 골랐으면, 올려도 같은 모델이라 승격은 아무 효과가 없다(no-op)
  if (skipIfSameAs && id === skipIfSameAs) return undefined;
  const model = (() => {
    try {
      return modelById(id);
    } catch (error) {
      throw new StudioError(500, `B_STUDIO_ESCALATE_MODEL_ID=${id}: ${describe(error)}`);
    }
  })();
  // 로컬 Claude 모드와 같은 임계치를 쓴다. 사람이 읽는 이름은 모델 라벨을 쓴다
  return { ...escalationRules(), to: model.label || model.id, client: clientForModel(model) };
}

/**
 * 로컬 Claude 모드 승격 대상. Claude Code에 넘기는 모델 이름이다(예: sonnet).
 * planModel: 계획-실행 분리(ADR-075)의 계획 모델 이름. 명시적 승격 대상(B_STUDIO_CLAUDE_CODE_ESCALATE_MODEL)이
 * 없으면 이쪽으로 올린다 — 계획 모델로 기본 승격 대상을 삼는다.
 */
export function claudeCodeEscalation(
  planModel?: string,
  env: Record<string, string | undefined> = process.env,
  skipIfSameAs?: string,
): EscalationPolicy | undefined {
  const to = env.B_STUDIO_CLAUDE_CODE_ESCALATE_MODEL?.trim() || planModel;
  if (!to) return undefined;
  // 사람이 대화에서 이미 이 모델(별칭)을 실행 모델로 골랐으면, 올려도 같은 모델이라 승격은 아무 효과가 없다(no-op)
  if (skipIfSameAs && to === skipIfSameAs) return undefined;
  return { ...escalationRules(), to };
}

/**
 * claude-code 자동 모델 선택(ADR-091)의 승격 대상. 계획 모델이나 환경 변수가 아니라 고른 단계의 바로 위 단계로 올린다
 * (haiku→sonnet, sonnet→opus). 이미 opus(최고 단계)면 더 올릴 곳이 없어 승격하지 않는다(fable은 자동 후보가 아니다).
 * 두 승격 러너와 같은 임계치(escalationRules)를 쓴다 — 서명이 반복되는 규칙은 단계 선택 방식과 무관하다.
 */
export function claudeCodeAutoEscalation(tier: CliTier): EscalationPolicy | undefined {
  const to = nextCliTier(tier);
  if (!to) return undefined;
  return { ...escalationRules(), to };
}

/**
 * 자동 모델 선택(ADR-091)의 stickiness 갱신. 요청이 끝난 뒤 한 번 부른다.
 * 질문(ask)이거나 검증 게이트를 통과하지 못했으면(done이 아니면) 아무것도 기억하지 않고 지금 값을 그대로 돌려준다
 * (ADR-047과 같은 원칙 — 질문 완료·실패한 시도는 구현 품질의 증거가 아니다).
 * 승격이 일어났으면(게이트가 반복 실패해 한 단계 올렸으면) 그 올라간 단계를 기억한다.
 */
export function nextAutoTier(current: CliTier | undefined, autoRoute: CliRouteDecision, outcome: { intent: Intent; status: 'done' | 'failed' | 'awaiting_input'; escalated: boolean }): CliTier | undefined {
  if (outcome.intent !== 'build' || outcome.status !== 'done') return current;
  const usedTier = outcome.escalated ? (nextCliTier(autoRoute.tier) ?? autoRoute.tier) : autoRoute.tier;
  return higherCliTier(current, usedTier);
}

/**
 * 계획-실행 분리(ADR-075) 설정. studio.yaml의 `models`가 같은 이름의 환경 변수보다 우선한다.
 * 값의 뜻은 세션 백엔드에 따라 다르다 — claude-code는 Claude Code에 넘기는 모델 이름, api는 모델 레지스트리 id다.
 * 둘 다 없으면(기본) 이 함수가 항상 undefined만 돌려주므로 나머지 로직은 지금과 같이 움직인다.
 */
export function planExecuteConfig(project: LoadedProject, env: Record<string, string | undefined> = process.env): { plan?: string; execute?: string; always?: boolean } {
  const models = project.spec.models;
  const plan = models?.plan?.trim() || env.B_STUDIO_PLAN_MODEL?.trim() || undefined;
  const execute = models?.execute?.trim() || env.B_STUDIO_EXECUTE_MODEL?.trim() || undefined;
  // B_STUDIO_PLAN_BRIEF=always면 요청 복잡도와 무관하게 계획을 세운다(실험·짧은 요청이 많은 프로젝트용). 기본 auto는 simple을 건너뛴다
  const when = env.B_STUDIO_PLAN_BRIEF?.trim() || 'auto';
  if (when !== 'auto' && when !== 'always') throw new StudioError(500, `B_STUDIO_PLAN_BRIEF는 auto 또는 always여야 합니다 (지금 값: ${when})`);
  return { ...(plan ? { plan } : {}), ...(execute ? { execute } : {}), ...(when === 'always' ? { always: true } : {}) };
}

/** 두 러너가 함께 쓰는 승격 규칙(임계치·실패 횟수·재시도 예산) */
function escalationRules(): Pick<EscalationPolicy, 'sameSignatureTimes' | 'afterFailures' | 'retryBudget'> {
  const afterFailures = escalateAfterFailures();
  return {
    sameSignatureTimes: escalateAfter(),
    ...(afterFailures === undefined ? {} : { afterFailures }),
    retryBudget: escalateRetryBudget(),
  };
}

/** 계획 호출(ADR-075)을 할 수 있는 세션 백엔드. 도구 없이 한 번 묻는 경로가 있는 api·claude-code만 되고, 데모·그 밖의 백엔드는 undefined */
export function planBriefBackend(backend: SessionMode): 'api' | 'claude-code' | undefined {
  return backend === 'api' || backend === 'claude-code' ? backend : undefined;
}

/**
 * 계획-실행 분리(ADR-075). 계획 모델이 설정돼 있고, 이 요청이 만들기(build) 요청이며(질문은 대상이 아니다),
 * 백엔드가 claude-code·api 중 하나이고(PR 리뷰·작업 계획과 같은 제약 — 그 밖의 백엔드는 도구 없는 단발 호출 경로가 없다),
 * 라우팅 복잡도가 simple이 아니면(shouldPlanBrief), 실행 전에 도구 없이 한 번 계획 모델을 불러 짧은 계획을 받는다.
 * 계획은 `plan_brief` 이벤트로 대화에 남기고(화면은 "계획(모델명)" 접기 블록으로 보여준다), 실행기에 넘길 요청 끝에
 * 구분선으로 붙인다. 원래 요청(request)은 손대지 않으므로 체크포인트 제목·기록에는 계획이 섞이지 않는다.
 * 계획 호출이 실패해도(모델 오류·빈 응답 등) 원래 요청 그대로 실행을 이어간다 — 계획은 돕는 역할이지 필수 관문이 아니다.
 */
async function withPlanBrief(
  session: Session,
  run: ActiveRun,
  request: string,
  plan: RunPlan,
  signal: AbortSignal,
): Promise<{ request: string; planUsage?: { model: string; usage: AgentUsage } }> {
  // 실행 계획 종류(plan.kind)가 아니라 세션 백엔드로 고른다. 데모·대본 세션(작업 계획의 통합 단계 등)도 plan.kind가 'model'이라
  // 그대로 두면 API 모델 레지스트리에서 계획 모델을 찾다가 실패한다(E8 첫 실행에서 드러남)
  const backend = planBriefBackend(sessionBackend(session.snapshot));
  if (plan.intent === 'ask' || !backend) return { request };
  const split = planExecuteConfig(session.project);
  if (!split.plan || (!split.always && !shouldPlanBrief(request))) return { request };

  try {
    // 계획 호출 준비(모델 조회)도 실패할 수 있으므로 try 안에 둔다 — 계획은 돕는 역할이라 실패하면 계획 없이 실행한다
    const ask: ModelAsk =
      backend === 'claude-code' ? claudeCodeAsk({ cwd: session.project.root, model: split.plan }) : planAskFromClient(clientForModel(modelById(split.plan)));
    const brief = await requestPlanBrief(ask, session.project, request, signal);
    emit(session, { type: 'plan_brief', runId: run.id, model: split.plan, text: brief.text, usage: brief.usage, durationMs: brief.durationMs });
    return { request: appendPlanToRequest(request, brief.text), planUsage: { model: split.plan, usage: brief.usage } };
  } catch (error) {
    emit(session, { type: 'notice', text: `계획 호출이 실패해 계획 없이 실행합니다: ${describe(error)}`, at: new Date().toISOString() });
    return { request };
  }
}

async function execute(session: Session, run: ActiveRun, request: string, plan: RunPlan): Promise<void> {
  const signal = AbortSignal.any([session.stop.signal, run.cancel.signal]);
  let finished: Pick<Extract<StudioEvent, { type: 'run_finished' }>, 'status' | 'summary' | 'turns' | 'metrics' | 'durationMs' | 'verify'> | undefined;
  let cancelled = false;
  /** 요청을 시작하지 못했다. 되돌릴 변경이 없고 데모 요청도 쓰지 않았다 */
  let notStarted = false;
  // 질문은 파일을 바꾸지 않으므로 직접 수정을 남기거나, 체크포인트를 만들거나, 되돌리지 않는다
  const ask = plan.intent === 'ask';
  try {
    let edits: Checkpoint | undefined;
    try {
      await session.relaying;
      // 요청이 실패하거나 취소돼 마지막 체크포인트로 되돌릴 때 사람이 고친 파일까지 지우지 않도록 먼저 남긴다
      if (!ask) edits = await saveLocalEdits(session);
    } catch (error) {
      throw new LocalEditsError(`스튜디오 밖에서 바꾼 파일을 체크포인트로 남기지 못해 요청을 시작하지 않았습니다: ${describe(error)}`);
    }
    if (edits) {
      emit(session, { type: 'local_edits_saved', checkpoint: edits, reason: 'request' });
      noteForModel(
        session,
        `[b-studio] 사용자가 스튜디오 밖에서 파일 ${edits.files.length}개를 바꿔 체크포인트 ${edits.shortSha}로 남겼습니다: ${edits.files.slice(0, 20).join(', ')}. 이 파일을 다루기 전에 다시 읽으세요.`,
      );
    }
    const agentStarted = performance.now();
    // 계획-실행 분리(ADR-075). 설정이 없거나 이 요청이 대상이 아니면 원래 요청 그대로 돌려준다(지금과 같은 동작)
    const { request: executionRequest, planUsage } = await withPlanBrief(session, run, request, plan, signal);
    const result = await runPlan(session, run, executionRequest, plan, signal);
    // 취소를 받은 직후 에이전트가 먼저 끝났어도 사용자가 원한 대로 되돌린다
    if (run.cancel.signal.aborted) throw run.cancel.signal.reason;
    session.run = undefined;
    if ('preflightError' in result) {
      finished = { status: 'error', summary: result.preflightError };
      return;
    }
    // 계획 호출 토큰을 이 실행의 모델별 사용량에 "계획: <모델>"로 합친다(토큰 탭이 그대로 표로 보여준다).
    // 세션·사람 토큰 한도에는 반영하지 않는다(계획 호출은 실행 루프 밖의 별도 호출이라 그 예산 계산과 겹치면 부정확해진다) — 알려진 한계로 남긴다
    if (planUsage) {
      const metrics: RunMetrics = result.metrics ?? { modelCalls: 0, maxContextTokens: 0, modelMs: 0, toolMs: 0, gateMs: 0 };
      result.metrics = { ...metrics, usageByModel: { ...metrics.usageByModel, [`계획: ${planUsage.model}`]: planUsage.usage } };
    }

    // 외부 검증 게이트가 있는 만들기 요청만 품질 실측으로 쓴다. 질문 완료는 정답을 뜻하지 않는다.
    // 입력이 하나로 합쳐진 뒤로는 "바꾼 파일 없이 답만 한" 만들기 요청도 여기 오므로, 파일을 바꾼 실행만 관측값으로 남긴다
    if (!ask && result.changedFiles.length > 0 && plan.kind === 'model' && plan.route) {
      try {
        recordObservation({
          modelId: plan.route.selected.id,
          passed: result.status === 'done',
          latencyMs: Math.round(performance.now() - agentStarted),
          costUsd: estimateCost(plan.route.selected, result.usage),
        });
      } catch (error) {
        // 관측 파일 오류 때문에 검증을 통과한 사용자 변경을 실패·되돌리면 안 된다
        console.error('[b-studio] 모델 실측 기록을 남기지 못했습니다', error);
      }
    }

    // 되묻고 멈췄으면 질문을 스냅샷에 남겨 화면이 카드로 그린다. 답은 다음 요청으로 온다
    if (result.status === 'awaiting_input' && result.question) {
      session.snapshot.pendingQuestion = {
        runId: run.id,
        question: result.question.question,
        options: result.question.options,
        allowOther: result.question.allowOther,
        ...(result.question.proposal ? { proposal: result.question.proposal } : {}),
      };
    }
    if (!ask) {
      // 지연 기동 세션이 샌드박스를 켜지 않았다면 바뀐 것이 없다(바뀌었으면 도구/게이트가 켰다).
      // 체크포인트도 되돌리기도 샌드박스가 필요하므로, 켠 세션에서만 한다
      if (session.bootPromise && (result.status === 'done' || (result.status === 'awaiting_input' && result.report?.ok))) {
        // 게이트를 통과한 변경만 체크포인트로 남긴다. 질문 전에 쓴 파일이 게이트를 통과했으면 그것도 남기고,
        // 답을 기다리는 실행이 남긴 미검증 변경은 되돌리지 않는다(다음 요청이 이어서 다룬다)
        await saveCheckpoint(session, run.id, request, checkpointBody(result, plan.allowBreaking), checkpointTrailers(result), result.summary);
        if (result.checks) session.lastGateChecks = result.checks;
        // 게이트가 test 단계를 돌렸다면 그 보고서를 다시 실행하지 않고 모아 "테스트" 탭에 반영한다(실패해도 요청 결과에 영향 없음)
        void collectGateTestReports(session).catch(() => {});
        // 요구사항을 이슈로 발행해 뒀다면(사이드카 파일이 있으면) 상태를 반영한다. 발행한 적이 없으면 거의 비용 없이 건너뛴다
        void syncSessionRequirementIssueStatus(session.snapshot.id).catch(() => {});
      } else if (session.snapshot.status === 'ready' && result.status !== 'awaiting_input') {
        await revertRun(session, run.id);
      }
    }
    finished = {
      status: result.status,
      summary: result.summary,
      turns: result.turns,
      metrics: result.metrics,
      durationMs: Math.round(performance.now() - agentStarted),
      ...(result.verify === 'light' ? { verify: 'light' as const } : {}),
      // 가볍게 확인이 건너뛴 단계를 함께 남긴다(프로젝트 토큰 보고서가 이 수를 센다)
      ...(result.skippedStages && result.skippedStages.length > 0 ? { skippedStages: [...result.skippedStages] } : {}),
    };
  } catch (error) {
    if (error instanceof LocalEditsError) {
      // 되돌리면 체크포인트로 남기지 못한 사람의 수정이 지워지므로 그대로 두고 끝낸다
      notStarted = true;
      session.run = undefined;
      finished = { status: 'error', summary: error.message };
      return;
    }
    cancelled = run.cancel.signal.aborted && !session.stop.signal.aborted;
    // 취소해 되돌리는 동안 다시 누른 취소는 받아들인다. 오류로 되돌리는 중에는 취소를 받지 않는다
    if (!cancelled) session.run = undefined;
    let reverted: string[] | undefined;
    let revertError: unknown;
    // 샌드박스가 켜져 있을 때만 되돌린다. 지연 기동 세션이 켜지기 전에 실패하면 되돌릴 샌드박스가 없다
    if (!session.stop.signal.aborted && !ask && session.snapshot.status === 'ready') {
      // 취소하면 게이트나 도구가 다시 띄우던 서비스가 중간에 멈춰 있을 수 있어 준비되지 않은 서비스도 함께 다시 띄운다
      const unsettled = cancelled ? session.snapshot.services.filter((service) => service.state !== 'ready').map((service) => service.name) : [];
      reverted = await revertRun(session, run.id, { cancelled, alsoRestart: unsettled }).catch((cause: unknown) => {
        revertError = cause;
        console.error('[b-studio] 되돌리기 실패', cause);
        return undefined;
      });
    }
    if (!cancelled) finished = { status: 'error', summary: describe(error) };
    else {
      const summary = ask ? stoppedQuestionSummary(run, session.snapshot.tokenLimit) : stoppedSummary(run, session.snapshot.tokenLimit, reverted, revertError);
      finished = { status: 'cancelled', summary };
    }
  } finally {
    session.run = undefined;
    // 데모 시나리오는 앞 단계의 파일을 전제로 하므로, 취소해 되돌린 요청은 다시 보낼 수 있게 남긴다.
    // 되묻고 멈춘 경우는 아직 시나리오가 끝나지 않았으므로 다음 단계로 넘기지 않는다(답을 받아 이어서 실행한다)
    if (session.snapshot.mode === 'demo' && !cancelled && !notStarted && !ask && finished?.status !== 'awaiting_input') {
      session.demoIndex += 1;
      session.snapshot.nextDemoRequest = demoScenarios(session.project)[session.demoIndex]?.request;
      session.snapshot.nextDemoQuestion = demoScenarios(session.project)[session.demoIndex]?.question?.request;
    }
    session.snapshot.running = false;
    session.snapshot.cancelling = undefined;
    // 실행이 끝났는데 러너가 꺼내 가지 않은 지시는 적용되지 못한 것이다. 화면에 다시 보내라고 알린다
    const dropped = run.steering?.take() ?? [];
    if (!session.stop.signal.aborted && dropped.length > 0) emit(session, { type: 'steer_dropped', runId: run.id, texts: dropped });
    if (!session.stop.signal.aborted && finished) {
      session.settledConversation = session.conversation.length;
      emit(session, {
        type: 'run_finished',
        runId: run.id,
        ...finished,
        usage: hasTokens(run.tokens) ? run.tokens : undefined,
        sessionTokens: session.snapshot.tokens,
        nextDemoRequest: session.snapshot.nextDemoRequest,
        nextDemoQuestion: session.snapshot.nextDemoQuestion,
      });
    }
  }
}

/** 사람 한도 설정과 지금까지 쓴 양. 한도를 정하지 않았거나 누가 보냈는지 모르면 undefined */
function userTokenBudget(by: string | undefined): { used: number; limit: number; window: UsageWindow } | undefined {
  if (!by) return undefined;
  const limit = parseUserTokenLimit(process.env.B_STUDIO_USER_TOKEN_LIMIT);
  if (limit === undefined) return undefined;
  const window = parseUsageWindow(process.env.B_STUDIO_USER_TOKEN_WINDOW);
  return { used: userTokens(by, window), limit, window };
}

/** 사람 몫에 늘어난 만큼만 더한다. 기록을 쓰지 못해도 요청은 계속한다 */
async function chargeUser(run: ActiveRun, usage: AgentUsage): Promise<void> {
  if (!run.by || parseUserTokenLimit(process.env.B_STUDIO_USER_TOKEN_LIMIT) === undefined) return;
  const delta = subtractTokens(usage, run.charged);
  run.charged = usage;
  if (!hasTokens(delta)) return;
  try {
    await addUserUsage(run.by, delta, parseUsageWindow(process.env.B_STUDIO_USER_TOKEN_WINDOW));
  } catch (error) {
    console.error('[b-studio] 사람별 토큰 사용량을 기록하지 못했습니다', error);
  }
}

/** 한도로 멈췄을 때 어느 한도인지 알린다. 사람 한도는 새 세션을 만들어도 풀리지 않으므로 구분해서 말한다 */
function limitReason(run: ActiveRun, limit: number | undefined): string {
  if (run.limitKind === 'user') {
    const personal = userTokenBudget(run.by);
    return `${describeWindow(personal?.window ?? 'day')} 쓸 수 있는 토큰 한도(${formatTokenCount(personal?.limit ?? 0)})에 도달해`;
  }
  return `세션 토큰 한도(${formatTokenCount(limit ?? 0)})에 도달해`;
}

/** 멈춘 이유와 되돌린 결과. revertError가 있으면 되돌리지 못했다 */
function stoppedSummary(run: ActiveRun, limit: number | undefined, reverted: string[] | undefined, revertError: unknown): string {
  if (run.stopReason === 'budget') {
    const reason = `${limitReason(run, limit)} 요청을 멈췄습니다`;
    if (!reverted) return `${reason}. 변경을 되돌리지 못했습니다: ${describe(revertError)}`;
    return reverted.length > 0 ? `${reason}. 바뀐 파일 ${reverted.length}개를 되돌렸습니다` : `${reason}. 바뀐 파일은 없었습니다`;
  }
  if (!reverted) return `요청을 취소했지만 변경을 되돌리지 못했습니다: ${describe(revertError)}`;
  return reverted.length > 0 ? `요청을 취소하고 바뀐 파일 ${reverted.length}개를 되돌렸습니다` : '요청을 취소했습니다. 바뀐 파일은 없었습니다';
}

/** 질문은 되돌릴 변경이 없으므로 멈춘 이유만 알린다 */
function stoppedQuestionSummary(run: ActiveRun, limit: number | undefined): string {
  return run.stopReason === 'budget' ? `${limitReason(run, limit)} 질문을 멈췄습니다` : '질문을 취소했습니다';
}

/**
 * 세션 상태는 ready인데 studio 밖에서(사람·다른 과정이) edge·부가 서비스 컨테이너를 지운 경우를 겨냥한다
 * (도그푸딩 마찰 130, 트러블슈팅 86). 상태 필드만 보고 그대로 요청을 보내면 첫 샌드박스 도구부터
 * "service ... is not running"으로 실패하고, 에이전트는 원인을 몰라 restart_service·service_stats 같은
 * 도구를 턴 상한까지 반복한다. 모델을 부르기 전에 한 번 확인해, 없으면 이 세션의 compose 프로젝트 안에서만
 * 다시 올린다(ADR-143). 복구에 실패하면 모델을 아예 부르지 않고 바로 알려 턴을 한 개도 쓰지 않는다 —
 * ensureInfra가 없는 제공자(지연 기동으로 아직 한 번도 안 띄운 세션 포함)는 건너뛴다
 */
async function ensureReadySessionInfra(session: Session, signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (session.snapshot.status !== 'ready' || !session.sandbox.ensureInfra) return { ok: true };
  let result: Awaited<ReturnType<NonNullable<Sandbox['ensureInfra']>>>;
  try {
    result = await session.sandbox.ensureInfra([...session.serviceSelection], { signal });
  } catch (error) {
    return { ok: false, reason: `샌드박스 인프라 문제라 코드로 고칠 수 없습니다 — 컨테이너 상태를 확인하지 못했습니다: ${describe(error)}` };
  }
  if (result.recovered.length > 0) {
    emit(session, {
      type: 'notice',
      text: `세션 상태는 준비됨이었지만 컨테이너가 없어 이 세션 범위에서 다시 올렸습니다: ${result.recovered.join(', ')}`,
      at: new Date().toISOString(),
    });
  }
  if (!result.ok) {
    return {
      ok: false,
      reason: `샌드박스 인프라 문제라 코드로 고칠 수 없습니다 — ${(result.missing ?? []).join(', ') || '일부 컨테이너'}를 다시 올리지 못했습니다: ${result.reason ?? '알 수 없는 이유'}`,
    };
  }
  return { ok: true };
}

/** 샌드박스를 건드리기 전에 인증부터 확인하고, 모드에 맞는 에이전트로 요청을 처리한다 */
async function runPlan(session: Session, run: ActiveRun, request: string, plan: RunPlan, signal: AbortSignal): Promise<AgentResult | { preflightError: string }> {
  // 세션 상태(ready)만 보고 핵심 컨테이너가 실제로 있다고 가정하지 않는다(도그푸딩 마찰 130). 이 확인은
  // 모델 호출·게이트보다 먼저다 — 실패하면 턴을 하나도 쓰지 않고 바로 알린다
  const infra = await ensureReadySessionInfra(session, signal);
  if (!infra.ok) return { preflightError: infra.reason };

  // 이번 요청 전부터 작업 트리에 있던 변경(보관본 되살리기, 사람이 편집기로 바꾼 것 등 출처를 가리지 않는다).
  // 에이전트가 이번 실행에서 파일을 하나도 건드리지 않아도 게이트가 이 변경을 검증 대상으로 보게 한다(ADR-131:
  // 게이트 없이 체크포인트가 생기던 사고 — session 5b640fd3, 체크포인트 15ba740).
  const externalChanges = await session.checkpoints.pendingFiles();
  const shared = {
    project: session.project,
    sandbox: session.sandbox,
    externalChanges,
    allowBreaking: plan.allowBreaking,
    intent: plan.intent,
    // "조사" 모드(ADR-094): 질문(ask)에서 웹으로 찾아 답하라는 뜻. claude-code 러너만 실제로 WebSearch·WebFetch를 연다
    research: plan.research === true,
    // 가볍게 확인(light)이면 게이트가 재시작·준비·계약만 돈다. 생략(full)이면 지금과 같다
    verify: plan.verify,
    // 턴 상한(ADR-131). 요청 옵션이 studio.yaml(workflow.maxTurns)보다 우선하고, 둘 다 없으면 각 실행기 기본값(60)을 쓴다
    ...(maxTurnsFor(session.project, plan.maxTurns) !== undefined ? { maxTurns: maxTurnsFor(session.project, plan.maxTurns) } : {}),
    // 자가 확인 범위(B_STUDIO_SELF_CHECK). 기본 lean(게이트와 겹치는 확인을 줄이게 안내, ADR-064). full이면 이전 동작
    selfCheck: selfCheckMode(),
    // 쓰기 범위는 studio.yaml 정책에 더한다. 정책을 통째로 바꾸면 금지 명령·보호 경로가 빠진다
    policy: scopedExecutionPolicy(session.project, plan.writableScope),
    // 레인 조율 게시판. 없으면 도구 목록이 지금과 같다(기본값: 공유 없음)
    board: plan.board,
    // 화면 확인이 찍은 스크린샷은 세션 폴더에 남기고, 실시간 프레임은 채널로만 보낸다(기록에 쌓지 않는다)
    saveArtifact: (input: { name: string; data: Buffer; contentType: 'image/png' | 'image/jpeg' }) => saveSessionArtifact(session, run.id, input),
    onBrowserFrame: ({ check, frame }: { check: string; frame: BrowserFrame }) =>
      publish(session.snapshot.id, {
        source: 'qa',
        check,
        mime: 'image/jpeg',
        data: frame.data.toString('base64'),
        width: frame.width,
        height: frame.height,
        at: frame.at,
      }),
    // 세션이 Figma 디자인을 설정했을 때만 디자인 도구를 넘긴다(없으면 도구 목록이 그대로다)
    design: designSourceFor(session, run.id),
    // 되묻기(ask_user) 도구는 사람이 있는 단일 세션 요청에만 넣는다
    interactive: plan.interactive === true,
    signal,
    onEvent: (event: AgentEvent) => {
      // 질문은 세션 기록에 따로 남겨 화면이 카드로 그린다(대화 흐름에 남는다)
      if (event.type === 'question')
        return emit(session, { type: 'question', runId: run.id, question: event.question, options: event.options, allowOther: event.allowOther, ...(event.proposal ? { proposal: event.proposal } : {}) });
      if (event.type !== 'tokens') return emit(session, { type: 'agent', runId: run.id, event });
      run.tokens = event.usage;
      // 스크립트 모델(데모 모드)은 토큰을 쓰지 않으므로 기록을 늘리지 않는다
      if (!hasTokens(event.usage)) return;
      // 서버가 요청 도중에 멈춰도 그때까지 쓴 양이 세션 파일에 남도록 합계를 바로 바꾼다
      session.snapshot.tokens = addTokens(run.baseTokens, event.usage);
      emit(session, { type: 'tokens', runId: run.id, usage: event.usage, sessionTokens: session.snapshot.tokens });
      // 사람 몫에는 늘어난 만큼만 더한다. 세션이 여러 개여도 한 사람의 합계는 한 곳에 쌓인다
      void chargeUser(run, event.usage);
      const limit = session.snapshot.tokenLimit;
      const personal = userTokenBudget(run.by);
      const overSession = limit !== undefined && totalTokens(session.snapshot.tokens) >= limit;
      const overUser = personal !== undefined && personal.used + totalTokens(event.usage) >= personal.limit;
      // 게이트 실패를 되풀이하는 요청이 한도를 넘어 계속 토큰을 쓰지 않도록, 넘는 순간 멈추고 되돌린다
      if ((overSession || overUser) && !run.cancel.signal.aborted) {
        run.stopReason = 'budget';
        run.limitKind = overSession ? 'session' : 'user';
        session.snapshot.cancelling = 'budget';
        emit(session, { type: 'run_cancelling', runId: run.id, reason: 'budget' });
        run.cancel.abort(new DOMException(overSession ? '세션 토큰 한도에 도달했습니다' : '사람별 토큰 한도에 도달했습니다', 'AbortError'));
      }
    },
    onServiceStatus: (event: ServiceStatusEvent) => onServiceStatus(session, event),
  };

  // 지연 기동 세션은 러너에게 ensureSandbox를 넘겨, 첫 파일 변경·샌드박스 도구일 때 샌드박스를 켠다(게이트는 그 뒤에 만든다).
  // API·데모(model)·CLI(claude-code·codex·commandcode·opencode) 경로가 같은 규칙을 쓴다
  const lazyEnsureSandbox = session.lazy ? () => ensureBooted(session) : undefined;

  if (plan.kind === 'claude-code') {
    const preflight = await preflightClaudeCode({ cwd: session.project.root });
    if (!preflight.ok) return { preflightError: preflight.reason };

    // 자동 모델 선택(ADR-091). 대화에 한 줄 안내를 남긴다(같은 'route' 이벤트를 api 라우터(ADR-047)와 공유한다 — auto:true만 다르다)
    if (plan.autoRoute) {
      shared.onEvent({
        type: 'route',
        selectedId: plan.autoRoute.tier,
        reason: plan.autoRoute.reason,
        complexity: plan.autoRoute.complexity,
        risk: plan.autoRoute.risk,
        candidates: CLI_TIERS.map((tier) => ({ id: tier, label: tierLabel(tier), eligible: tier === plan.autoRoute!.tier, score: 0 })),
        auto: true,
      });
    }

    const { claudeCode } = session;
    const result = await runClaudeCodeAgent({
      ...shared,
      ...(lazyEnsureSandbox ? { ensureSandbox: lazyEnsureSandbox } : {}),
      request: [...claudeCode.notes, request].join('\n\n'),
      resume: claudeCode.sessionId,
      // 세션(레인)에서 고른 모델 → 자동 선택이 고른 단계 → 계획-실행 분리(ADR-075)의 실행 모델 → 환경 변수(계획 기본). 기록용 id는 무시한다
      model: plan.autoRoute ? plan.autoRoute.tier : (cliModelOverride(session.snapshot.modelId) ?? plan.executeModel ?? (process.env.B_STUDIO_CLAUDE_CODE_MODEL?.trim() || undefined)),
      // 세션에서 고른 노력 단계. 없으면 러너 기본값('high')을 그대로 쓴다
      ...(session.snapshot.effort ? { effort: session.snapshot.effort } : {}),
      // 실행 중 지시 큐. 없으면(레인·플릿) 지시를 받지 않는다
      steering: run.steering,
      // 설정하지 않으면 승격하지 않는다(지금 동작과 같다)
      escalation: plan.escalation,
      account: preflight.account,
    });
    // 예외로 끝나면 여기까지 오지 않으므로 이전 세션과 알림이 그대로 남아 다음 요청이 이어받는다
    claudeCode.notes = [];
    if (result.sessionId) claudeCode.sessionId = result.sessionId;
    // 자동 모델 선택의 stickiness(ADR-091). 다음 요청도 이번에 실제로 쓴 단계부터 시작해 모델을 다시 낮췄다
    // 올리는 캐시 재생성을 피한다(E8/E9). status가 'awaiting_input'(되묻고 멈춤)이면 아직 끝나지 않아 기억하지 않는다
    if (plan.autoRoute && (result.status === 'done' || result.status === 'failed')) {
      claudeCode.autoTier = nextAutoTier(claudeCode.autoTier, plan.autoRoute, {
        intent: plan.intent,
        status: result.status,
        escalated: Boolean(result.metrics?.escalatedAt),
      });
    }
    return result;
  }

  if (plan.kind === 'codex') {
    const preflight = await preflightCodex();
    if (!preflight.ok) return { preflightError: preflight.reason };

    // 러너가 대화를 이어받지 못하므로 전체 기록 대신 지난 요청의 요약을 짧게 붙인다
    const { codex } = session;
    const result = await runCodexAgent({
      ...shared,
      ...(lazyEnsureSandbox ? { ensureSandbox: lazyEnsureSandbox } : {}),
      request: [...codex.notes, codexContextBlock(codex.recent), request].filter(Boolean).join('\n\n'),
      // 세션(레인)에서 고른 모델이 있으면 그 값, 없으면 환경 변수를 쓴다. 기록용 id는 무시한다
      model: cliModelOverride(session.snapshot.modelId) ?? (process.env.B_STUDIO_CODEX_MODEL?.trim() || undefined),
      // 세션에서 고른 노력 단계. 없으면 넘기지 않는다(계정 기본값)
      ...(session.snapshot.effort ? { effort: session.snapshot.effort } : {}),
      // 실행 중 지시 큐. Codex는 턴 사이에만 넣는다
      steering: run.steering,
    });
    // 예외로 끝나면 여기까지 오지 않으므로 알림과 이전 맥락이 그대로 남는다
    codex.notes = [];
    codex.recent = rememberCodexRun(codex.recent, { request, summary: result.summary, status: result.status });
    return result;
  }

  if (plan.kind === 'commandcode') {
    const preflight = await preflightCommandCode();
    if (!preflight.ok) return { preflightError: preflight.reason };

    // Command Code는 세션을 갈라(fork) 이어받으므로 Codex처럼 요약 블록을 붙이지 않는다.
    // 이 러너는 아직 main이 새로 넣은 interactive(되묻기 ask_user)·board(레인 조율 게시판)·steering(실행 중 지시)을 받지 않는다.
    // shared의 interactive·board는 CommandCodeRunOptions에서 쓰이지 않아 무시되고, steering은 넘기지 않는다.
    // 실행 중 지시를 넣으면 main의 steer_dropped 안내가 실행 끝에 적용되지 못했다고 알린다(기능을 새로 만들지 않는다).
    const { commandCode } = session;
    const result = await runCommandCodeAgent({
      ...shared,
      ...(lazyEnsureSandbox ? { ensureSandbox: lazyEnsureSandbox } : {}),
      request: [...commandCode.notes, request].join('\n\n'),
      resume: commandCode.sessionId,
      // cmd는 세션을 HOME과 cwd로 찾는다. 둘을 세션마다 고정해 다음 요청이 이어받게 한다(세션 기록·아티팩트와 같은 폴더 아래)
      stateDir: commandCodeStateDirOf(session.snapshot),
      // 세션에서 고른 모델 → B_STUDIO_CMD_MODEL → 없음(계정 기본)
      model: resolveCommandCodeModel(session.snapshot.modelId, process.env.B_STUDIO_CMD_MODEL),
      // 세션에서 고른 노력 단계. 없으면 넘기지 않는다(계정 기본값)
      ...(session.snapshot.effort ? { effort: session.snapshot.effort } : {}),
    });
    // 예외로 끝나면 여기까지 오지 않으므로 이전 세션과 알림이 그대로 남아 다음 요청이 이어받는다
    commandCode.notes = [];
    if (result.sessionId) commandCode.sessionId = result.sessionId;
    return result;
  }

  if (plan.kind === 'opencode') {
    const preflight = await preflightOpenCode();
    if (!preflight.ok) return { preflightError: preflight.reason };

    // OpenCode는 세션을 갈라(fork) 이어받으므로 Codex처럼 요약 블록을 붙이지 않는다.
    // 이 러너는 아직 main이 새로 넣은 interactive(되묻기 ask_user)·board(레인 조율 게시판)·steering(실행 중 지시)을 받지 않는다.
    // shared의 interactive·board는 OpenCodeRunOptions에서 쓰이지 않아 무시되고, steering은 넘기지 않는다.
    // 실행 중 지시를 넣으면 main의 steer_dropped 안내가 실행 끝에 적용되지 못했다고 알린다(기능을 새로 만들지 않는다).
    const { openCode } = session;
    const result = await runOpenCodeAgent({
      ...shared,
      ...(lazyEnsureSandbox ? { ensureSandbox: lazyEnsureSandbox } : {}),
      request: [...openCode.notes, request].join('\n\n'),
      resume: openCode.sessionId,
      // opencode는 세션 DB를 HOME·XDG 아래에 둔다. 둘을 세션마다 고정해 다음 요청이 이어받게 한다(세션 기록·아티팩트와 같은 폴더 아래)
      stateDir: openCodeStateDirOf(session.snapshot),
      // 세션에서 고른 모델 → B_STUDIO_OPENCODE_MODEL → 없음(러너가 "모델을 골라야 합니다" 오류를 낸다)
      model: resolveOpenCodeModel(session.snapshot.modelId, process.env.B_STUDIO_OPENCODE_MODEL),
      // 세션에서 고른 노력 단계. 없으면 넘기지 않는다(`--variant`를 붙이지 않는다)
      ...(session.snapshot.effort ? { effort: session.snapshot.effort } : {}),
      // 무료 Zen 모델은 이 구성에서 거절되므로, 로그인 파일이 있으면 링크해 로그인한 제공자의 모델을 쓴다(없으면 링크하지 않는다)
      linkAuth: true,
    });
    // 예외로 끝나면 여기까지 오지 않으므로 이전 세션과 알림이 그대로 남아 다음 요청이 이어받는다
    openCode.notes = [];
    if (result.sessionId) openCode.sessionId = result.sessionId;
    return result;
  }

  if (plan.kind === 'gemini') {
    const preflight = await preflightGemini();
    if (!preflight.ok) return { preflightError: preflight.reason };

    // Gemini CLI도 세션 id가 실리면(확인 못 함, gemini-cli-runner.ts 머리말 참고) 이어받으므로 opencode·commandcode처럼
    // 요약 블록을 붙이지 않는다. 이 러너는 아직 main이 새로 넣은 interactive·board·steering을 받지 않는다(다른 CLI 러너와 같다).
    const { gemini } = session;
    const result = await runGeminiAgent({
      ...shared,
      ...(lazyEnsureSandbox ? { ensureSandbox: lazyEnsureSandbox } : {}),
      request: [...gemini.notes, request].join('\n\n'),
      resume: gemini.sessionId,
      // Gemini CLI는 세션을 cwd 해시로 HOME 아래에 저장한다고 문서에 적혀 있다. 둘을 세션마다 고정해 다음 요청이 이어받게 한다
      stateDir: geminiStateDirOf(session.snapshot),
      // 세션에서 고른 모델 → B_STUDIO_GEMINI_MODEL → 없음(러너가 "모델을 골라야 합니다" 오류를 낸다)
      model: resolveGeminiModel(session.snapshot.modelId, process.env.B_STUDIO_GEMINI_MODEL),
      // 세션에서 고른 노력 단계가 있어도 그대로 넘긴다 — 지원 여부 판단은 러너가 한다(경고 이벤트로 알린다)
      ...(session.snapshot.effort ? { effort: session.snapshot.effort } : {}),
    });
    // 예외로 끝나면 여기까지 오지 않으므로 이전 세션과 알림이 그대로 남아 다음 요청이 이어받는다
    gemini.notes = [];
    if (result.sessionId) gemini.sessionId = result.sessionId;
    return result;
  }

  if (plan.route) {
    shared.onEvent({
      type: 'route',
      selectedId: plan.route.selected.id,
      reason: plan.route.reason,
      complexity: plan.route.complexity,
      risk: plan.route.risk,
      candidates: plan.route.candidates.map((candidate) => ({
        id: candidate.model.id,
        label: candidate.model.label,
        eligible: candidate.eligible,
        score: candidate.score,
        estimatedCostUsd: candidate.estimatedCostUsd,
      })),
    });
  }
  if (plan.client.preflight) {
    const preflight = await plan.client.preflight();
    if (!preflight.ok) return { preflightError: preflight.reason };
  }
  return runAgent({
    ...shared,
    request,
    client: plan.client,
    conversation: session.conversation,
    maxVerifyAttempts: plan.maxVerifyAttempts,
    // 실행 중 지시 큐. 없으면(레인·플릿·데모) 지시를 받지 않는다
    steering: run.steering,
    // 설정하지 않으면 승격하지 않는다(지금 동작과 같다)
    escalation: plan.escalation,
    // 지연 기동 세션이면 샌드박스 도구·첫 파일 변경 때 runAgent가 이걸로 켠다
    ...(session.lazy ? { ensureSandbox: () => ensureBooted(session) } : {}),
  });
}

/** PR 리뷰어가 요청마다 무엇을 확인했는지 볼 수 있도록 검증 결과와 에이전트 요약을 커밋 본문에 남긴다 */
function checkpointBody(result: AgentResult, allowBreaking: boolean): string {
  const sections: string[] = [];
  if (result.report) sections.push(formatVerificationReport(result.report, { allowBreaking }));
  const coverage = formatCheckedCoverage(result.checks);
  if (coverage) sections.push(coverage);
  if (result.verifyAttempts > 0) sections.push(`검증 게이트 재시도: ${result.verifyAttempts}회`);
  const summary = result.summary.trim();
  if (summary) sections.push(`에이전트 요약:\n${summary.split('\n').slice(0, 30).join('\n')}`);
  return sections.join('\n\n');
}

/** 배포할 때 releaseRequires와 대조하는 통과 단계. 게이트 기록이 없는 실행이면 트레일러를 남기지 않는다 */
function checkpointTrailers(result: AgentResult): string[] {
  if (!result.passedStages) return [];
  const trailers = [formatWorkflowTrailer(result.passedStages)];
  // 가볍게 확인한 체크포인트는 건너뛴 단계를 채우지 못한다(배포 조건이 막는다). 화면이 안내를 바꾸도록 표시를 남긴다
  if (result.verify === 'light') trailers.push(formatVerifyTrailer('light'));
  return trailers;
}

async function saveCheckpoint(session: Session, runId: string, request: string, body: string, trailers: string[] = [], summary?: string): Promise<void> {
  const head = session.snapshot.checkpoints[0]!.sha;
  // 파일은 그대로여도 데이터만 바꾼 요청은 체크포인트로 남겨야 다음 되돌리기에서 사라지지 않는다
  const dataOnly =
    session.databases.enabled &&
    (await session.checkpoints.pendingFiles()).length === 0 &&
    (await session.databases.changedSince(head, session.stop.signal));
  const changes = await session.checkpoints.pendingChanges();
  const specChanged = changes.some((change) => change.file === SPEC_FILE);
  // studio.yaml 등 생성 파일(ADR-067)은 git 추적 밖이라 pendingChanges에 보이지 않는다. 체크포인트를 남기기 전에
  // 마지막 체크포인트 스냅샷과 따로 비교해 둔다(도그푸딩 마찰 127) — commit()이 체크포인트를 새로 만들면 그 안에서
  // 스냅샷을 알아서 다시 찍으므로, 여기서는 "바뀌었는지"만 먼저 본다
  const excludedChanged = await session.checkpoints.pendingExcludedFiles();
  const subject = session.project.spec.checkpoints.conventionalCommits ? generateCommitSubject(request, changes, summary) : `요청: ${request}`;
  const checkpoint = await session.checkpoints.commit(subject, body, {
    allowEmpty: dataOnly,
    findSecrets: (text) => session.sandbox.findSecrets(text),
    trailers,
  });
  if (!checkpoint) {
    // 추적한 파일은 그대로였지만 생성 파일만 바뀐 성공한 실행도, 그 내용을 마지막 체크포인트 곁에 남긴다(그래야 다음
    // 되돌리기가 이번에 바꾼 내용을 "이전 상태"로 잘못 알지 않는다)
    if (excludedChanged.length > 0) {
      await session.checkpoints.refreshExcludedSnapshot(head);
      if (excludedChanged.includes(SPEC_FILE)) await reloadSessionProject(session);
    }
    return;
  }
  await saveDatabases(session, checkpoint.sha);
  session.snapshot.checkpoints = [checkpoint, ...session.snapshot.checkpoints];
  emit(session, { type: 'checkpoint', runId, checkpoint });
  // 에이전트가 이번 실행에서 studio.yaml을 바꿨으면(includes·systemPackages·workflow 등) 다음 요청부터 그 선언을 쓴다(도그푸딩 마찰 121)
  if (specChanged || excludedChanged.includes(SPEC_FILE)) await reloadSessionProject(session);
}

/**
 * studio.yaml을 다시 읽어 세션의 project를 바꾼다. 못 읽으면 지금 project를 그대로 둔다. 서비스 선택(offServices, ADR-083)은
 * 파일이 아니라 세션 상태라 다시 읽은 project에 그대로 옮긴다 — 옮기지 않으면 꺼 둔 서비스가 다음 재시작에서 다시 켜진다
 */
async function reloadSessionProject(session: Session): Promise<void> {
  const off = session.project.offServices;
  session.project = await loadProject(session.project.root).catch(() => session.project);
  if (off) session.project.offServices = off;
}

/**
 * 되돌린 파일을 돌려준다. alsoRestart는 파일과 상관없이 다시 띄울 서비스다.
 *
 * DB 복원 기준점(ADR-018·ADR-131 실측): discardWorkingCopy가 문서를 지키려고 새 체크포인트(docsCheckpoint)를
 * 남기면 session.snapshot.checkpoints[0]이 그 문서 체크포인트로 바뀐다. 그 체크포인트는 saveDatabases를 부르지
 * 않아 DB 덤프가 없으므로, discardWorkingCopy **뒤**의 checkpoints[0]으로 복원하면 덤프를 찾지 못해(action:
 * 'missing') DB가 조용히 그대로 남는다 — 되돌린 파일(마이그레이션 SQL)과 실제 DB 스키마가 어긋나 다음 기동이
 * Flyway "적용된 마이그레이션 파일이 없다" 오류로 실패한 사고가 있었다(세션 5b640fd3, 체크포인트 57cced6).
 * 그래서 DB 복원 기준점은 discardWorkingCopy를 부르기 **전**의 checkpoints[0](실제로 덤프가 있는 체크포인트)으로 고정한다.
 */
async function revertRun(
  session: Session,
  runId: string,
  { cancelled = false, alsoRestart = [] }: { cancelled?: boolean; alsoRestart?: string[] } = {},
): Promise<string[]> {
  const dbRestorePoint = session.snapshot.checkpoints[0]!.sha;
  // 문서는 먼저 지키고(ADR-099), 남은 변경은 되살릴 수 있게 백업한 뒤에 버린다
  const { docsCheckpoint, files, patch, backup } = await discardWorkingCopy(session.checkpoints, (text) => session.sandbox.findSecrets(text));
  if (docsCheckpoint) {
    session.snapshot.checkpoints = [docsCheckpoint, ...session.snapshot.checkpoints];
    emit(session, { type: 'docs_checkpoint', checkpoint: docsCheckpoint });
  }
  // 실패한 요청이 실행한 마이그레이션과 데이터 변경도 마지막 체크포인트 시점으로 되돌린다(위 dbRestorePoint 기준)
  const database = await session.databases.restore(dbRestorePoint, session.stop.signal);
  // 문서 체크포인트가 새로 생겼으면, 복원한(바른) DB 상태를 그 체크포인트의 덤프로도 남겨 다음 되돌리기가
  // 같은 "덤프 없음" 문제를 반복하지 않게 한다(연속 실패 시나리오)
  if (docsCheckpoint) await saveDatabases(session, docsCheckpoint.sha);
  const databaseTouched = database.states.some((state) => state.action === 'restored' || state.action === 'failed');
  if (files.length === 0 && !databaseTouched && alsoRestart.length === 0) return files;
  // 되돌린 파일에 studio.yaml(생성 파일 포함, 도그푸딩 마찰 127)이 있으면 재시작 전에 project를 다시 읽는다
  if (files.includes(SPEC_FILE)) await reloadSessionProject(session);

  const report = await restartServicesFor(
    session.sandbox,
    session.project,
    files,
    { signal: session.stop.signal, onStatus: (event) => onServiceStatus(session, event) },
    { alsoRestart: [...new Set([...database.dependents, ...alsoRestart])] },
  );
  emit(session, {
    type: 'reverted',
    runId,
    cancelled: cancelled || undefined,
    files,
    patch,
    restarted: report.restarted,
    databases: database.states,
    sync: report.sync,
    backup,
  });
  return files;
}

/** 요청 전에 로컬 폴더의 수정을 체크포인트로 남기지 못했다 */
class LocalEditsError extends Error {}

/**
 * 로컬 폴더 세션에서 스튜디오 밖(IDE 등)에서 바꾼 파일을 체크포인트로 남긴다.
 * 요청이 실패하거나 취소되면 마지막 체크포인트로 되돌리므로, 그 전에 사람이 고친 파일을 기록에 넣어 지우지 않게 한다
 */
async function saveLocalEdits(session: Session): Promise<Checkpoint | undefined> {
  if (session.snapshot.workspace !== 'local') return undefined;
  const checkpoint = await commitLocalEdits(session.checkpoints, (text) => session.sandbox.findSecrets(text));
  if (!checkpoint) return undefined;
  await saveDatabases(session, checkpoint.sha);
  session.snapshot.checkpoints = [checkpoint, ...session.snapshot.checkpoints];
  return checkpoint;
}

/** 검증 게이트 없이 체크포인트로 남긴다. 시크릿 값이 든 파일이 있으면 남기지 않고 오류를 낸다 */
async function commitLocalEdits(checkpoints: CheckpointStore, findSecrets: (text: string) => string[]): Promise<Checkpoint | undefined> {
  const files = await checkpoints.pendingFiles();
  if (files.length === 0) return undefined;
  return checkpoints.commit(`직접 수정: 파일 ${files.length}개`, '스튜디오 밖(IDE 등)에서 바꾼 파일입니다. 검증 게이트를 거치지 않았습니다.', { findSecrets });
}

// ---------------------------------------------------------------------------
// 문서 체크포인트(ADR-096): 요구사항 저장·이슈 발행 사이드카처럼 docs/** 안의 변경만 검증 게이트 없이 체크포인트로
// 남긴다. 문서는 서비스를 재시작하거나 빌드를 깨뜨리지 않으므로 전체 검증(run·test·review…)을 거칠 이유가 없다.
// 그대로 두면 "나눠서 병렬로 하기"가 project 원본에서 레인을 시작해 저장한 요구사항·이슈 번호·발행 기록이 사라지는
// 문제가 있어(docs/가 세션 작업 복사본에 커밋되지 않은 채로 남는다), 저장 직후 여기서 체크포인트로 남긴다.
// ---------------------------------------------------------------------------

/** docs/** 전부(마크다운·JSON 사이드카 모두), 저장소 루트의 *.md, .github/pull_request_template.md만 문서 경로로 인정한다.
 * 규칙 자체는 packages/agent(isDocCheckpointPath)에 두고 여기서는 이름만 studio 쪽 호출부에 익숙한 대로 다시 내보낸다 —
 * buildPullRequest(repository.ts)가 문서 체크포인트를 PR 본문에서 다시 확인할 때도 같은 규칙을 쓴다(ADR-110) */
export function isDocPath(file: string): boolean {
  return isDocCheckpointPath(file);
}

// ---------------------------------------------------------------------------
// 절대 조용히 지우지 않는다(ADR-099): 끝내지 못한 요청이 남긴 변경을 "이어서 작업"이 체크포인트로 되돌리며 버리던
// 중, 문서(docs/requirements.md 등 — 문서 체크포인트 커밋이 실패해 아직 커밋되지 않은 채였다)까지 함께 사라지는
// 사고가 있었다(2026-10-01, docs/troubleshooting.md 50). CheckpointStore.discard()/restore()가 버리기 직전에
// 백업을 남기는 것과 짝을 이뤄, 여기서는 "HEAD로 되돌리는(discard) 경로"에서 문서 경로만 먼저 체크포인트로
// 지킨다 — discard()는 HEAD를 그대로 두고 pending만 지우므로, 미리 커밋한 문서는 되돌린 뒤에도 그대로 남는다.
// restore(sha)로 더 이전 체크포인트로 되돌리는 경로(restoreCheckpoint·원격·기준 브랜치 되돌리기 실패 처리)는
// 문서를 미리 커밋해도 그 커밋 자체가 되돌리는 대상보다 뒤에 있어 함께 사라지므로(오히려 백업에서도 빠져 더
// 나쁘다) 여기서 손대지 않고, CheckpointStore.restore()의 백업만으로 지킨다.
// ---------------------------------------------------------------------------

/** discard() 직전에 문서 경로(docs/** 등)만 먼저 체크포인트로 남긴다. 남길 문서가 없으면 아무것도 하지 않는다(undefined) */
async function protectPendingDocsBeforeDiscard(checkpoints: CheckpointStore, findSecrets: (text: string) => string[]): Promise<Checkpoint | undefined> {
  const pending = (await checkpoints.pendingFiles()).filter(isDocPath);
  if (pending.length === 0) return undefined;
  return checkpoints.commitPaths(pending, '지키기: 되돌리기 전에 문서를 체크포인트로 남긴다', undefined, {
    findSecrets,
    trailers: [formatVerifyTrailer('docs')],
  });
}

/**
 * discard()로 되돌리기 전에 문서를 지키고(protectPendingDocsBeforeDiscard), 남은 변경은 discard() 자신이
 * 백업한 뒤에 버리게 한다. resumeSession·revertRun처럼 "HEAD로 되돌리는" 모든 경로가 이 순서를 따른다.
 */
async function discardWorkingCopy(
  checkpoints: CheckpointStore,
  findSecrets: (text: string) => string[],
): Promise<{ docsCheckpoint?: Checkpoint; files: string[]; patch: string; backup?: DiscardBackup }> {
  const docsCheckpoint = await protectPendingDocsBeforeDiscard(checkpoints, findSecrets);
  const { files, patch, backup } = await checkpoints.discard();
  return { docsCheckpoint, files, patch, backup };
}

/** "체크포인트에 없던 변경 N개를 버렸습니다/백업했습니다" 안내문. files가 비어 있으면 빈 문자열 */
function discardedNote(files: readonly string[], backup?: DiscardBackup): string {
  if (files.length === 0) return '';
  const list = files.slice(0, 20).join(', ');
  return backup
    ? `체크포인트에 없던 변경 ${files.length}개를 백업했습니다: ${list} · 되살리기 id: ${backup.id}`
    : `체크포인트에 없던 변경 ${files.length}개는 버렸습니다(백업하지 못했습니다): ${list}`;
}

/**
 * 문서만 바뀐 변경(요구사항 저장, 이슈 발행·충돌 해결 사이드카 등)을 검증 게이트 없이 체크포인트로 남긴다.
 * paths 중 문서 경로(docs/**, 루트 *.md, .github/pull_request_template.md)가 아닌 것이 하나라도 있으면 아무것도
 * 커밋하지 않고 거부한다(호출하는 쪽의 실수로 코드 변경까지 게이트 없이 커밋되는 구멍을 막는다).
 * paths로 좁혀 커밋하므로(CheckpointStore.commitPaths) 작업 복사본에 다른 변경이 함께 있어도 그 변경은 건드리지
 * 않고 그대로 pending으로 남는다. 범위 안에 바뀐 파일이 없으면 조용히 건너뛴다(undefined).
 * Workflow-Verify 트레일러에 'docs'를 남겨 이 체크포인트가 게이트 통과 증거로 쓰이지 않게 한다(requirements.ts의
 * computeRequirementStatus는 애초에 체크포인트만으로 "검증됨"을 매기지 않지만, 배포 조건·체크포인트 화면이 이
 * 표시로 "문서" 체크포인트를 가볍게 확인·직접 수정과 같은 방식으로 구분해 보여 준다).
 * 다른 화면(문서 탭 등)도 Workspace로 docs/를 쓴 뒤 그대로 재사용할 수 있게 공개한다.
 */
export async function commitWorkingCopyDocs(sessionId: string, paths: readonly string[], message: string): Promise<Checkpoint | undefined> {
  const session = requireSession(sessionId);
  const bad = paths.filter((file) => !isDocPath(file));
  if (bad.length > 0) throw new StudioError(400, `문서 경로가 아니어서 문서 체크포인트로 남기지 않았습니다: ${bad.join(', ')}`);
  if (paths.length === 0) return undefined;
  const checkpoint = await session.checkpoints.commitPaths(paths, message, undefined, {
    findSecrets: (text) => session.sandbox.findSecrets(text),
    trailers: [formatVerifyTrailer('docs')],
  });
  if (!checkpoint) return undefined;
  session.snapshot.checkpoints = [checkpoint, ...session.snapshot.checkpoints];
  emit(session, { type: 'docs_checkpoint', checkpoint });
  return checkpoint;
}

/**
 * 지금 바뀐 파일 중 문서 경로만 골라 문서 체크포인트로 남긴다. 어떤 문서 파일이 바뀌었는지 미리 모르는 곳(작업
 * 분해가 레인을 시작하기 전 안전망 등)에서 쓴다 — 문서가 아닌 변경은 손대지 않고 그대로 둔다. 바뀐 문서 파일이
 * 없으면 조용히 건너뛴다(undefined).
 */
export async function commitPendingWorkingCopyDocs(sessionId: string, message: string): Promise<Checkpoint | undefined> {
  const session = requireSession(sessionId);
  const pending = (await session.checkpoints.pendingFiles()).filter(isDocPath);
  return commitWorkingCopyDocs(sessionId, pending, message);
}

/** "docs: 요구사항을 정리한다 (R2~R20)"처럼 커밋 메시지에 붙일 범위. 숫자 id가 하나도 없으면 빈 문자열 */
function requirementRangeLabel(ids: readonly string[]): string {
  const numbers = ids.map((id) => /^R(\d+)/.exec(id)?.[1]).filter((value): value is string => value !== undefined).map(Number);
  if (numbers.length === 0) return '';
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  return min === max ? ` (R${min})` : ` (R${min}~R${max})`;
}

/** b-studio 세션이 만드는 브랜치 이름. 저장소 화면이 PR 목록에서 b-studio가 만든 브랜치를 찾을 때도 같은 규칙을 쓴다 */
export function sessionBranchName(projectId: string, sessionId: string): string {
  return `b-studio/${projectId}-${sessionId}`;
}

/** branch가 이 프로젝트의 b-studio 세션 브랜치면 그 세션 id, 아니면 undefined */
export function sessionIdFromBranch(projectId: string, branch: string): string | undefined {
  const prefix = `b-studio/${projectId}-`;
  return branch.startsWith(prefix) ? branch.slice(prefix.length) : undefined;
}

// localFolderAllowed는 repo-token.ts에 있다(이 파일과 projects.ts가 서로를 가져오지 않도록, ADR-107).
// 이 파일 밖의 기존 가져오기(@/lib/server/sessions)가 계속 되도록 다시 내보낸다
export { localFolderAllowed };

function assertLocalFolderAllowed(): void {
  if (!localFolderAllowed()) {
    throw new StudioError(403, '내 폴더에서 바로 작업하기는 인증을 끈 개인 PC(B_STUDIO_AUTH=none)에서만 쓸 수 있습니다. 여러 사람이 쓰는 서버에서는 복사본으로 시작하세요');
  }
}

/**
 * 로컬 폴더 세션이 쓸 폴더를 잡는다. 두 세션이 같은 폴더를 바꾸면 한쪽의 되돌리기가 다른 쪽의 변경을 지우므로 거부한다.
 * sessionId는 이어서 작업하는 세션 자신이다. 돌려준 함수로 푼다
 */
function claimFolder(root: string, sessionId?: string): () => void {
  const busy = [...store.sessions.values()].find(
    (session) =>
      session.snapshot.workspace === 'local' && session.snapshot.workDir === root && session.snapshot.status !== 'stopped' && session.snapshot.id !== sessionId,
  );
  if (busy) throw new StudioError(409, `이 폴더는 세션 ${busy.snapshot.id}에서 작업하고 있습니다. 그 세션의 샌드박스를 중지한 뒤 시작하세요`);
  if (claimedFolders.has(root)) throw new StudioError(409, '이 폴더로 다른 세션을 시작하는 중입니다. 끝난 뒤 다시 시도하세요');
  claimedFolders.add(root);
  return () => claimedFolders.delete(root);
}

/** 체크포인트 시점의 데이터베이스 상태를 남긴다. 실패해도 작업은 계속하고 로그로 알린다 */
async function saveDatabases(session: Session, sha: string): Promise<DatabaseState[]> {
  // 샌드박스를 한 번도 켜지 않은 지연 기동 세션은 덤프를 뜰 컨테이너가 없다. 켜는 중(bootPromise)이거나 켜진 뒤에만 뜬다
  if (!session.databases.enabled || !session.bootPromise) return [];
  const states = await session.databases.save(sha, session.stop.signal);
  for (const state of states) {
    emit(session, {
      type: 'log',
      service: state.service,
      text: `[b-studio] ${describeDatabaseState(state)} (체크포인트 ${sha.slice(0, 7)})`,
      at: new Date().toISOString(),
    });
  }
  return states;
}

/** 대화 밖에서 바뀐 사실(되돌리기, 새 샌드박스, 가져온 원격 커밋)을 다음 요청에서 모델이 알게 한다 */
function noteForModel(session: Session, text: string): void {
  // 알림을 어디에 넣을지는 이 세션이 실제로 쓰는 백엔드를 따른다(레인이 서버 모드와 다른 백엔드를 쓸 수 있다)
  const backend = sessionBackend(session.snapshot);
  if (backend === 'claude-code') session.claudeCode.notes.push(text);
  else if (backend === 'codex') session.codex.notes.push(text);
  else if (backend === 'commandcode') session.commandCode.notes.push(text);
  else if (backend === 'opencode') session.openCode.notes.push(text);
  else if (backend === 'gemini') session.gemini.notes.push(text);
  else session.conversation.push({ role: 'user', content: text });
  session.settledConversation = session.conversation.length;
}

/**
 * 이 세션의 이전 체크포인트로 되돌린다. 오래 걸리므로 바로 돌아가고 결과는 이벤트로 알린다.
 *
 * 지금(head) 체크포인트를 가리켜도 거부하지 않는다(ADR-131 실측: 세션 5b640fd3). 실행 실패·중단으로 되돌릴 때
 * 파일은 되돌아갔지만(revertRun) 그 전에 이미 적용된 마이그레이션이 DB에 남는 경우가 있었는데, 그때 유일한
 * 출구가 "다른 체크포인트로 되돌리기"뿐이었고 그 체크포인트가 지금(head) 체크포인트이면 "이미 최신
 * 체크포인트입니다"로 막혀 DB를 되돌릴 길이 없었다(사용자가 체크포인트 57cced6으로 되돌리려다 겪은 409).
 * 기존 되돌리기 버튼을 그대로 쓰는 쪽을 택했다 — 새 API·새 화면 대신, CheckpointStore.restore(sha)가 파일이
 * 이미 그 상태면 아무것도 하지 않는 안전한 연산이고 DatabaseBranches.restore도 어긋나지 않았으면 'unchanged'로
 * 조용히 끝나므로, "지금 체크포인트로 되돌리기"를 "DB만 다시 맞추기"의 안전한 특수 경우로 다룰 수 있다.
 * DB를 선언하지 않은 프로젝트는 지금 체크포인트를 가리키면 정말 할 일이 없으므로 그때만 거부한다.
 */
export function restoreCheckpoint(id: string, sha: string): void {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 되돌릴 수 있습니다');
  if (session.snapshot.running || session.exporting) throw new StudioError(409, '다른 작업을 처리하는 중입니다');
  const target = session.snapshot.checkpoints.find((checkpoint) => checkpoint.sha === sha);
  if (!target) throw new StudioError(404, '체크포인트를 찾을 수 없습니다');
  const isHead = target.sha === session.snapshot.checkpoints[0]?.sha;
  if (isHead && !session.databases.enabled) throw new StudioError(409, '이미 최신 체크포인트이고 되돌릴 데이터베이스도 없습니다');

  session.snapshot.running = true;
  emit(session, { type: 'restore_started', checkpoint: target });

  void (async () => {
    let event: StudioEvent;
    try {
      await session.relaying;
      // restore()가 아직 체크포인트로 남기지 않은 변경을 버리기 전에 되살릴 수 있게 백업한다(ADR-099).
      // 지금 체크포인트를 가리켰으면(isHead) 보통 버릴 파일이 없어 이 단계는 사실상 아무것도 하지 않는다
      const { files, backup } = await session.checkpoints.restore(sha);
      // 되돌린 파일에 studio.yaml(생성 파일 포함, 도그푸딩 마찰 127)이 있으면 재시작 전에 project를 다시 읽는다
      if (files.includes(SPEC_FILE)) await reloadSessionProject(session);
      // 파일만 되돌리면 이미 적용된 마이그레이션이 DB에 남아 서비스가 기동하지 못하므로 DB도 같은 시점으로 맞춘다.
      // 어긋나지 않았으면(action: 'unchanged') 아무 것도 하지 않고 조용히 끝난다
      const database = await session.databases.restore(sha, session.stop.signal);
      const report = await restartServicesFor(
        session.sandbox,
        session.project,
        files,
        { signal: session.stop.signal, onStatus: (status) => onServiceStatus(session, status) },
        { alsoRestart: database.dependents },
      );
      session.snapshot.checkpoints = await session.checkpoints.list();
      const databaseResynced = database.states.some((state) => state.action === 'restored');
      // 이후 요청이 사라진 변경을 전제로 하지 않도록 대화에도 남긴다. 지금 체크포인트를 가리켰으면
      // "되돌렸다"는 말 대신 무엇을 다시 맞췄는지만 말한다(뒤의 체크포인트가 사라진 게 아니므로)
      noteForModel(
        session,
        isHead
          ? `[b-studio] 체크포인트 ${target.shortSha}("${target.message}") 기준으로 데이터베이스를 다시 맞췄습니다.${databaseResynced ? '' : ' (이미 맞는 상태였습니다)'}`
          : `[b-studio] 작업 복사본을 체크포인트 ${target.shortSha}("${target.message}")로 되돌렸습니다. 그 뒤의 체크포인트는 모두 사라졌습니다.${
              backup ? ` 아직 체크포인트로 남기지 않았던 변경 ${backup.files.length}개는 백업했습니다(되살리기 id: ${backup.id}).` : ''
            }`,
      );
      if (session.snapshot.mode === 'demo') {
        // 데모 시나리오는 앞 단계의 파일을 전제로 하므로, 남은 요청 체크포인트 수에 맞춰 다음 요청을 다시 정한다.
        // 내 폴더 세션의 직접 수정 체크포인트는 요청이 아니므로 세지 않는다
        session.demoIndex = session.snapshot.checkpoints.filter((checkpoint) => checkpoint.message.startsWith('요청: ')).length;
        session.snapshot.nextDemoRequest = demoScenarios(session.project)[session.demoIndex]?.request;
        session.snapshot.nextDemoQuestion = demoScenarios(session.project)[session.demoIndex]?.question?.request;
      }
      event = {
        type: 'restored',
        checkpoint: target,
        files,
        restarted: report.restarted,
        databases: database.states,
        sync: report.sync,
        checkpoints: session.snapshot.checkpoints,
        nextDemoRequest: session.snapshot.nextDemoRequest,
        nextDemoQuestion: session.snapshot.nextDemoQuestion,
        backup,
      };
    } catch (error) {
      event = { type: 'restore_failed', checkpoint: target, error: describe(error) };
    }
    // 새로 연결한 브라우저가 실행 중 상태에 멈추지 않도록 이벤트보다 먼저 푼다
    session.snapshot.running = false;
    if (!session.stop.signal.aborted) emit(session, event);
  })();
}

/**
 * discard()·restore()가 버리기 직전에 남긴 백업(ADR-099)을 작업 복사본에 되살린다. 그 사이에 같은 파일이
 * 다시 바뀌어 깨끗하게 들어가지 않으면(git apply 충돌) 거부한다 — 일부만 들어가 상태를 더 헷갈리게 만들지 않는다.
 */
export function restoreDiscardedBackup(id: string, backupId: string): void {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 되살릴 수 있습니다');
  if (session.snapshot.running || session.exporting) throw new StudioError(409, '다른 작업을 처리하는 중입니다');

  void (async () => {
    let event: StudioEvent;
    try {
      const { files } = await session.checkpoints.restoreBackup(backupId);
      const report =
        files.length > 0
          ? await restartServicesFor(session.sandbox, session.project, files, { signal: session.stop.signal, onStatus: (status) => onServiceStatus(session, status) })
          : undefined;
      noteForModel(session, `[b-studio] 백업을 되살렸습니다. 파일 ${files.length}개: ${files.slice(0, 20).join(', ')}. 다루기 전에 다시 읽으세요.`);
      event = { type: 'backup_restored', backupId, files, restarted: report?.restarted ?? [] };
    } catch (error) {
      event = { type: 'backup_restore_failed', backupId, error: describe(error) };
    }
    if (!session.stop.signal.aborted) emit(session, event);
  })();
}

/** PR에 연결할 이슈 번호. 생략은 undefined, 잘못된 값은 400이다 */
export function parseIssueInput(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10_000_000) {
    throw new StudioError(400, 'issue는 1 이상 10,000,000 이하의 정수여야 합니다');
  }
  return value;
}

/**
 * 요청 본문에서 연결할 이슈 번호 목록을 만든다. 이전 형식 issue(단수)와 issues(배열)를 합치고 중복을 없앤다.
 * 이슈 입력이 아예 없으면 undefined를 돌려줘, 부르는 쪽이 기본값(통합 세션의 하위 이슈)을 쓸지 정하게 한다
 */
export function parseIssueList({ issue, issues }: { issue?: unknown; issues?: unknown }): number[] | undefined {
  if (issue === undefined && issues === undefined) return undefined;
  const list: number[] = [];
  const single = parseIssueInput(issue);
  if (single !== undefined) list.push(single);
  if (issues !== undefined && issues !== null) {
    if (!Array.isArray(issues)) throw new StudioError(400, 'issues는 이슈 번호 배열이어야 합니다');
    for (const value of issues) {
      const parsed = parseIssueInput(value);
      if (parsed === undefined) throw new StudioError(400, 'issues의 각 항목은 1 이상 10,000,000 이하의 정수여야 합니다');
      list.push(parsed);
    }
  }
  return [...new Set(list)];
}

type IssueLookupResult = { ok: true; state: 'open' | 'closed'; title: string } | { ok: false; error: string };

/** 이 개수를 넘는 이슈를 연결하면 한 줄에 전부 나열하지 않고 개수로 요약한다(버그 리포트: 요구사항 20개를 묶은
 * 통합 세션에서 이슈 목록 한 줄이 너무 길었다) */
const SUMMARIZE_ISSUE_LIST_THRESHOLD = 5;

/**
 * 미리보기의 확인 목록을 만든다. 세션 없이 계산할 수 있도록 순수 함수로 둔다.
 * 어떤 항목이 false여도 올리기를 막지는 않는다. 사람이 보고 판단한다
 */
export function buildExportChecks({
  issues,
  issueLookups,
  missing,
  uncheckpointed,
  running,
  trackingIssue,
}: {
  issues: readonly number[];
  /** 이슈 번호별 원격 조회 결과. 없는 번호는 확인하지 못한 것으로 둔다 */
  issueLookups?: ReadonlyArray<{ issue: number; lookup: IssueLookupResult }>;
  missing: ReadonlyArray<{ shortSha: string; subject: string; stages: readonly string[] }>;
  uncheckpointed: number;
  running: boolean;
  /** 이미 발행한 추적 이슈 번호(있으면). "PR 만들기"가 그 본문을 지금 상태로 다시 쓴다는 사실만 알려준다 —
   * 미리보기는 원격에 아무것도 쓰지 않는다(안내만 한다) */
  trackingIssue?: number;
}): ExportPreview['checks'] {
  const checks: ExportPreview['checks'] = [
    {
      id: 'issue_linked',
      ok: issues.length > 0,
      detail:
        issues.length === 0
          ? '이슈 번호를 넣지 않았습니다. 선택 사항입니다'
          : issues.length > SUMMARIZE_ISSUE_LIST_THRESHOLD
            ? `이슈 ${issues.length}개를 PR에 연결합니다: ${issues.map((number) => `#${number}`).join(', ')}`
            : `${issues.map((number) => `#${number}`).join(', ')} 이슈를 PR에 연결합니다`,
    },
  ];

  if (issues.length === 0) {
    checks.push({ id: 'issue_open', ok: 'unknown', detail: '이슈 번호를 넣으면 원격 이슈 상태를 확인합니다' });
  } else {
    const parts = issues.map((issue) => {
      const lookup = issueLookups?.find((entry) => entry.issue === issue)?.lookup;
      if (lookup?.ok) return { issue, ok: lookup.state === 'open', title: lookup.title };
      return { issue, ok: 'unknown' as const, reason: lookup?.error ?? '알 수 없는 오류' };
    });
    const closed = parts.filter((part): part is { issue: number; ok: false; title: string } => part.ok === false);
    const unknown = parts.filter((part): part is { issue: number; ok: 'unknown'; reason: string } => part.ok === 'unknown');
    const ok: boolean | 'unknown' = unknown.length > 0 ? 'unknown' : closed.length === 0;
    // 많은 이슈가 전부 열려 있으면 한 줄로 요약하고, 문제가 있으면(닫힘·확인 못함) 그 이슈만 짚어 보여준다 —
    // 열려 있는 이슈까지 전부 나열하지 않는다(19개를 전부 적으면 오히려 무엇이 문제인지 묻힌다)
    const detail =
      ok === true
        ? issues.length > SUMMARIZE_ISSUE_LIST_THRESHOLD
          ? `연결한 이슈 ${issues.length}개 모두 열려 있습니다`
          : parts.map((part) => `#${part.issue} ${(part as { title: string }).title} (열림)`).join(', ')
        : [
            closed.length > 0 ? `닫힘: ${closed.map((part) => `#${part.issue} ${part.title}`).join(', ')}` : '',
            unknown.length > 0 ? `확인 못함: ${unknown.map((part) => `#${part.issue}(${part.reason})`).join(', ')}` : '',
          ]
            .filter(Boolean)
            .join(' · ');
    checks.push({ id: 'issue_open', ok, detail });
  }

  checks.push({
    id: 'stages_passed',
    ok: missing.length === 0,
    detail: missing.length === 0 ? '모든 커밋이 필수 단계를 통과했습니다' : `필수 단계 기록이 없는 커밋 ${missing.length}개가 있습니다`,
  });
  checks.push({
    id: 'uncheckpointed_changes',
    ok: uncheckpointed === 0,
    detail: uncheckpointed === 0 ? '체크포인트 밖 변경이 없습니다' : `체크포인트로 남기지 않은 변경 ${uncheckpointed}개가 있습니다. 올리기 전에 체크포인트로 남겨야 합니다`,
  });
  checks.push({
    id: 'running',
    ok: !running,
    detail: running ? '작업이 진행 중입니다. 끝난 뒤에 올릴 수 있습니다' : '진행 중인 작업이 없습니다',
  });
  if (trackingIssue !== undefined) {
    checks.push({ id: 'tracking_issue_refresh', ok: true, detail: `PR을 만들면 요구사항 추적 이슈 #${trackingIssue} 본문 표를 지금 상태로 다시 씁니다` });
  }
  return checks;
}

const CHECKLIST_STATUS_ICON: Record<ChecklistStatus, string> = { pass: '✓', warn: '!', fail: '✗', skip: '–' };

/**
 * PR 본문에 "올리기 전 점검"(저장소 탭의 SubmissionPanel과 같은 점검표, submissionReport) 요약을 덧붙인다.
 * 점검을 다시 계산하지 않고 그 결과(통과 수·항목별 한 줄 이유)만 옮긴다(ADR-107) — 저장소 탭 어디에서 PR을 만들든
 * 본문이 같아야 한다(pullRequestDraft가 미리보기·실제 생성에 함께 쓰는 것과 같은 이유)
 */
export function buildChecklistAddendum(report: SubmissionReport): string {
  const lines = report.items.map((item) => `- ${CHECKLIST_STATUS_ICON[item.status]} ${item.title}: ${item.reason}`);
  return `\n\n## 올리기 전 점검 ${report.score.passed}/${report.score.total} 통과\n\n${lines.join('\n')}`;
}

/** 미리보기와 실제 생성이 어긋나지 않도록 PR 제목·본문을 한 곳에서 만든다 */
async function pullRequestDraft(
  session: Session,
  issues: readonly number[],
  planRequirementIds: readonly string[] = [],
  { assumePushed = false }: { assumePushed?: boolean } = {},
): Promise<PullRequestDraft & { info: RepositoryInfo }> {
  const info = (await session.checkpoints.repository())!;
  const commits = await session.checkpoints.sessionCommits();
  // 지금 세션 HEAD에서 검증됨이고 이번 세션 범위 안인 요구사항(ADR-115, ADR-092 개정) — 제목·Closes·
  // Implements가 모두 이 기준을 쓴다
  const { refs, closedIssues, closesTracking } = await verifiedRequirementSummary(session, commits, info, planRequirementIds);
  const draft = buildPullRequest({
    projectName: session.project.spec.name,
    base: info.base,
    branch: info.branch,
    commits,
    issues,
    requirementIds: refs.map((ref) => ref.id),
    requiredStages: workflowStages(session.project),
  });
  // Closes는 위 draft.body 맨 위(issues 인자)가 이미 책임지므로, 여기서는 Implements: Rn@revN만 덧붙인다 —
  // 같은 이슈 번호를 두 번 Closes로 적지 않는다(버그 리포트: Closes #20이 본문에 두 번 나왔다)
  const requirementsAddendum = buildRequirementsAddendum(refs, { includeCloses: false });
  // 검증됐지만 이슈가 이미 닫혀 있는 요구사항(이전 세션의 PR이 머지되며 자동으로 닫힌 이슈 등)은 Closes로
  // 다시 올리지 않고 "관련:"으로만 가리킨다(버그 리포트: 머지돼 닫힌 이슈 19개가 그대로 Closes로 다시 올라왔다)
  // — 이미 위 issues 인자에 들어 있으면(사람이 직접 골랐으면) 다시 적지 않는다
  const relatedClosed = [...new Set(closedIssues)].filter((issue) => !issues.includes(issue));
  // 요구사항을 이슈로 발행했으면(ADR-092) 추적 이슈도 가리킨다. 이 PR이 연결하는 이슈들이 추적 이슈의 남은
  // 마지막 열린 하위 이슈면 추적 이슈도 함께 닫고(Closes), 아니면 "관련:" 줄로 PR에서 추적 이슈로 돌아갈 수
  // 있게 한다(이미 위 Closes 목록에 들어 있으면 — 사람이 직접 추적 이슈를 골랐으면 — 다시 적지 않는다)
  const tracking = await publishedTrackingIssue(session.project.root).catch(() => undefined);
  const trackingRelated = tracking && !closesTracking && !issues.includes(tracking.issue) ? tracking.issue : undefined;
  const trackingClosesAddendum = tracking && closesTracking && !issues.includes(tracking.issue) ? `\n\nCloses #${tracking.issue}` : '';
  // "관련: #16"·"관련: #19"처럼 같은 접두를 줄마다 반복해 붙이면 PR 본문이 지저분해진다(버그 리포트) — 닫힌
  // 하위 이슈·추적 이슈를 한 줄 "관련: #16, #19"로 합친다(GitHub는 한 줄에 여러 #n이 있어도 전부 링크한다).
  // `Closes`는 GitHub가 한 줄에 여러 개를 다루는 방식이 `관련:`과 달라 건드리지 않는다
  const relatedIssues = trackingRelated !== undefined ? [...relatedClosed, trackingRelated] : relatedClosed;
  const relatedAddendum = relatedIssues.length > 0 ? `\n\n관련: ${relatedIssues.map((issue) => `#${issue}`).join(', ')}` : '';
  // 올리기 전 점검표 요약(ADR-107, 56번 버그: "올리기 전 점검" 탭에서 PR을 만들어도 본문이 같은 점검을 보여 준다).
  // assumePushed(previewExport만 true로 준다, 버그 리포트 84): 미리보기는 아직 올리지 않은 채로 점검을 계산해
  // "작업 트리·원격"이 경고로 남는데, 실제로 PR을 만들면 그 사이 올라가 그 항목만 통과로 바뀐다 — 미리보기
  // 본문이 실제로 만든 PR 본문과 같은 점검 결과를 보이도록, 미리보기도 "곧 올릴 것"을 미리 반영해 계산한다
  const checklistAddendum = await submissionReport(session.snapshot.id, { assumePushed })
    .then((report) => buildChecklistAddendum(report))
    .catch(() => '');
  return { info, ...draft, body: `${draft.body}${requirementsAddendum}${relatedAddendum}${trackingClosesAddendum}${checklistAddendum}` };
}

/**
 * 미리보기가 연결할 이슈들의 열림·닫힘을 확인한다. GitHub·Gitea는 목록 조회 한 번으로 끝내고(저장소 탭이
 * 쓰는 토큰 캐시(cachedRepositoryToken, ADR-107)를 재사용 — 버그 리포트: fetchIssue가 토큰을 안 받아
 * B_STUDIO_GITHUB_TOKEN이 없으면 매번 실패했다), 그 목록에 없는 번호(여러 페이지에 걸치는 경우)나
 * GitLab은 이슈별로 따로 확인한다(그래도 병렬로, 순서대로 하나씩 묻지 않는다).
 */
async function lookupIssues(remote: RemoteLocation, issues: readonly number[], token: string | undefined): Promise<Array<{ issue: number; lookup: IssueLookupResult }>> {
  if (issues.length === 0) return [];
  const byNumber = new Map<number, IssueLookupResult>();
  if (remote.kind === 'github' || remote.kind === 'gitea') {
    try {
      for (const item of await listIssues(remote, { state: 'all', token })) byNumber.set(item.number, { ok: true, state: item.state, title: item.title });
    } catch {
      // 목록 조회가 실패해도(토큰 없음 등) 아래에서 이슈별로 다시 시도해 이유를 남긴다
    }
  }
  return Promise.all(
    issues.map(async (issue) => {
      const cached = byNumber.get(issue);
      if (cached) return { issue, lookup: cached };
      const lookup = await fetchIssue(remote, issue, { token }).then(
        (result): IssueLookupResult => ({ ok: true, state: result.state, title: result.title }),
        (error: unknown): IssueLookupResult => ({ ok: false, error: describe(error) }),
      );
      return { issue, lookup };
    }),
  );
}

/**
 * 올리기 전 미리보기. 제목·본문과 확인 목록(이슈 연결·원격 이슈 상태·누락 단계·체크포인트 밖 변경)을 돌려준다.
 * 누락을 보여 주기만 하고 막지는 않는다. 실제 생성은 exportSession이 같은 함수로 본문을 다시 만들어 한다
 */
export async function previewExport(
  id: string,
  { issues = [], planRequirementIds = [] }: { issues?: readonly number[]; planRequirementIds?: readonly string[] } = {},
): Promise<ExportPreview> {
  const session = requireSession(id);
  if (!session.snapshot.repository) throw new StudioError(409, '원본 프로젝트가 Git 저장소가 아니어서 올릴 곳이 없습니다');

  // assumePushed: true(버그 리포트 84) — 미리보기는 아직 올리지 않았지만, "PR 만들기"를 누르면 먼저 올리고 나서
  // 이 본문을 다시 계산하므로(exportSession) 작업 트리가 깨끗한 한 점검표의 "작업 트리·원격" 항목은 실제로
  // 만들어질 본문과 같이 통과로 보여야 미리보기 ≡ 실제 본문이 유지된다
  const { info, title, body, missing } = await pullRequestDraft(session, issues, planRequirementIds, { assumePushed: true });
  const remote = parseRemote(info.remoteUrl);
  // PR 생성(exportSession)과 같은 토큰을 먼저 찾아 이슈 확인에도 그대로 쓴다(ADR-107) — 이슈 조회만 토큰 없이
  // 돌다 실패하고 PR 생성은 되던 어긋남을 막는다
  const token = await repositoryPullRequestToken(remote);
  const issueLookups = await lookupIssues(remote, issues, token);
  // 추적 이슈를 이미 발행했으면(ADR-092) "PR 만들기"가 그 본문을 갱신할 거라는 사실만 안내한다 — 미리보기는
  // 원격에 아무것도 쓰지 않는다(읽기만 한다)
  const trackingIssue = await publishedTrackingIssue(session.project.root).catch(() => undefined);

  return {
    title,
    body,
    canCreate: canCreatePullRequest(remote, process.env, token),
    existingPullRequest: info.pullRequestUrl,
    issues: [...issues],
    checks: buildExportChecks({
      issues,
      issueLookups,
      missing,
      uncheckpointed: (await session.checkpoints.pendingFiles()).length,
      running: session.snapshot.running,
      trackingIssue: trackingIssue?.issue,
    }),
    review: { auto: session.project.spec.review.auto, maxRounds: session.project.spec.review.maxRounds },
  };
}

/**
 * "저장소" 탭의 "올리기 전 점검" 하위 탭(ADR-080, ADR-087)의 점검표. 요구사항·테스트·실행·환경 변수·데이터·비밀 값·
 * 커밋 기록·작업 트리/원격·문서를 한 번에 확인한다. 실제 점검 규칙은 세션을 모르는 순수 함수(lib/submission-checklist.ts)에
 * 있고, 여기서는 세션이 들고 있는 프로젝트 폴더·체크포인트·저장소 상태를 그 함수가 받는 모양으로 조립하기만 한다
 */
/** compose 파일에 DB 이미지(postgres·mysql·mariadb·mongo 등)를 쓰는 서비스가 있는지 */
async function composeHasDatabase(composePath: string): Promise<boolean> {
  const text = await readFile(composePath, 'utf8').catch(() => '');
  return /^\s*image:\s*["']?[^\s"']*\b(postgres|postgis|timescaledb|mysql|mariadb|mongo|mongodb)\b/im.test(text);
}

export async function submissionReport(id: string, { assumePushed = false }: { assumePushed?: boolean } = {}): Promise<SubmissionReport> {
  const session = requireSession(id);
  const services: ChecklistService[] = session.project.managed.map(([name, service]) => ({
    name,
    template: service.template,
    path: service.path,
    port: service.port,
  }));
  const [pendingFilesCount, commits, repository, testServices] = await Promise.all([
    session.checkpoints.pendingFiles().then((files) => files.length),
    session.checkpoints.sessionCommits(),
    session.checkpoints.repository(),
    Promise.all(session.project.managed.map(([name]) => buildTestServiceView(session, name))),
  ]);
  return buildSubmissionChecklist({
    root: session.project.root,
    services,
    // studio.yaml의 databases(스냅샷 대상)만 보면 compose에서 가져온 mysql·mongo를 놓친다. compose 파일의 DB 이미지도 본다
    hasDatabase: session.project.databases.length > 0 || (await composeHasDatabase(session.project.composePath)),
    latestPassedStages: session.snapshot.checkpoints[0]?.passedStages,
    pendingFilesCount,
    repository: repository && { hasRemote: true, pushed: repository.pushedSha === session.snapshot.checkpoints[0]?.sha },
    commits: commits.map((commit) => ({ subject: commit.subject, stat: commit.stat ?? { insertions: 0, deletions: 0 }, filesChanged: commit.files.length })),
    // 명세 탭이 지금 계산한 상태를 넘긴다. 요구사항 파일을 못 읽으면 점검표가 파일의 상태 줄로 대신한다
    requirements: await getSessionRequirements(id)
      .then((snapshot) => snapshot.requirements.map(({ id: requirementId, title, priority, status, verifiedBy }) => ({ id: requirementId, title, priority, status, verifiedBy })))
      .catch(() => undefined),
    // 게이트가 test 단계를 통과한 기록이 없어도, 테스트 탭에서 지금 체크포인트(HEAD)에 직접 돌린 결과가 있으면
    // 증거로 센다(버그 리포트: "전체 실행"으로 백엔드·프런트엔드 모두 통과했는데 "확인 필요"로 남던 문제)
    testEvidence: buildChecklistTestEvidence(testServices, session.snapshot.checkpoints[0]?.sha, pendingFilesCount),
    assumePushed,
  });
}

/** 체크포인트를 세션 브랜치로 올리고, 원하면 PR을 만든다. 몇 초면 끝나므로 결과를 바로 돌려준다 */
export async function exportSession(
  id: string,
  {
    pullRequest,
    issues = [],
    review,
    planRequirementIds = [],
  }: {
    pullRequest: boolean;
    issues?: readonly number[];
    /** 생략하면 studio.yaml의 review.auto를 따른다(화면 체크박스가 명시하면 그 값) */
    review?: boolean;
    planRequirementIds?: readonly string[];
  },
): Promise<ExportResult> {
  const session = requireSession(id);
  if (!session.snapshot.repository) throw new StudioError(409, '원본 프로젝트가 Git 저장소가 아니어서 올릴 곳이 없습니다');
  if (session.snapshot.running) throw new StudioError(409, '작업이 끝난 뒤에 올릴 수 있습니다');
  if (session.exporting) throw new StudioError(409, '이미 올리는 중입니다');

  session.exporting = true;
  try {
    // main 따라잡기(ADR-076): 기준 브랜치가 앞서 있고 깨끗하게 병합할 수 있으면 올리기 전에 조용히 먼저 따라잡는다
    await autoCatchUpBase(session);
    const pushed = await session.checkpoints.push().catch((error: unknown) => {
      // git 명령 자체가 실패하면(인증, 네트워크) 원격 문제이고, 나머지는 지금 상태로는 올릴 수 없다는 뜻이다
      const gitFailure = error instanceof CheckpointError && error.message.startsWith('git ');
      throw new StudioError(gitFailure ? 502 : 409, describe(error));
    });

    const info = (await session.checkpoints.repository())!;
    let created: ExportResult['pullRequest'];
    let pullRequestError: string | undefined;
    let pullRequestUpdateWarning: string | undefined;
    // 이번 export로 PR을 "새로" 연결했는지(브랜드 뉴 생성이거나, 올리기 전엔 몰랐던 원격 PR을 이번에 처음 찾아
    // 연결한 경우) — 자동 리뷰를 처음부터 시작할지(runReviewRound), 이미 하던 리뷰를 새 커밋만큼만 이어갈지
    // (continueReviewAfterNewCommits) 가른다. 아래 두 분기가 배타적이라(PR이 이미 있었는지로 나눈다) 상호
    // 혼동 없이 하나만 참이다
    let newlyConnectedPullRequest = false;
    if (pullRequest && !info.pullRequestUrl) {
      try {
        const { title, body } = await pullRequestDraft(session, issues, planRequirementIds);
        const remote = parseRemote(info.remoteUrl);
        // 미리보기(canCreate)가 "만들 수 있다"고 본 것과 같은 토큰으로 실제로 만든다(ADR-107)
        const token = await repositoryPullRequestToken(remote);
        // 본문을 b-studio 관리 영역 마커로 감싸 만든다(버그 리포트 85) — 다음에 같은 PR에 새 커밋이 올라가도
        // 이 마커 사이만 다시 쓰고, 사람이 PR 설명에 마커 밖으로 보탠 내용은 건드리지 않는다
        const result = await createPullRequest(remote, { title, body: mergeManagedPullRequestBody(undefined, body), base: info.base, branch: info.branch }, { token });
        await session.checkpoints.recordPullRequest(result.url);
        created = { url: result.url, created: result.created };
        newlyConnectedPullRequest = true;
      } catch (error) {
        // 브랜치는 이미 올라갔으므로 실패 이유를 알리고, 작성 페이지 링크로 직접 만들 수 있게 한다
        pullRequestError = describe(error);
      }
    } else if (pullRequest && info.pullRequestUrl) {
      // 이미 열려 있던 PR에 이번 export로 커밋을 더 올렸다 — 본문을 지금 상태(새 커밋·점검표)로 다시 쓴다
      // (버그 리포트 85: PR을 다시 만들 때 본문이 첫 커밋 그대로였다). 제목은 사람이 GitHub에서 바꿨을 수 있어
      // 건드리지 않는다. 실패해도 경고만 남기고 push·PR 자체는 이미 끝난 것으로 본다
      try {
        const { body } = await pullRequestDraft(session, issues, planRequirementIds);
        const remote = parseRemote(info.remoteUrl);
        const token = await repositoryPullRequestToken(remote);
        const number = parsePullRequestNumber(info.pullRequestUrl);
        if (number === undefined) throw new Error('PR 주소에서 번호를 읽지 못했습니다');
        await updatePullRequestBody(remote, number, body, { token });
        created = { url: info.pullRequestUrl, created: false, updated: true };
      } catch (error) {
        pullRequestUpdateWarning = describe(error);
      }
    }
    // PR을 만들라고 했으면(이미 열려 있던 PR에 커밋만 더 올린 경우도 포함) 추적 이슈 본문도 지금 상태로 다시 쓴다.
    // 실패해도 경고만 남기고 PR 만들기 결과 자체는 그대로 돌려준다(위 pullRequestError와 독립된 문제다)
    const requirementsTrackingWarning = pullRequest ? await refreshTrackingIssueAfterExport(session) : undefined;

    const repository = (await describeRepository(session.checkpoints, session.sourceDirtyFiles))!;
    session.snapshot.repository = repository;
    const result: ExportResult = {
      repository,
      sha: pushed.sha,
      commits: pushed.commits,
      forced: pushed.forced,
      pullRequest: created,
      pullRequestError,
      pullRequestUpdateWarning,
      issues: created && issues.length > 0 ? [...issues] : undefined,
      requirementsTrackingWarning,
    };
    emit(session, { type: 'exported', ...result });
    // 이번에 이 세션이 PR을 새로 연결했고(이미 있던 PR을 이어서 쓰는 export가 아니고) 설정이 켜져 있으면 AI 리뷰를 자동으로 시작한다(ADR-074).
    if (newlyConnectedPullRequest && (review ?? session.project.spec.review.auto)) {
      void runReviewRound(id).catch((error: unknown) => console.error('[b-studio] AI 리뷰 자동 시작 실패', describe(error)));
    } else if (pullRequest && info.pullRequestUrl && (review ?? session.project.spec.review.auto)) {
      // 이미 열려 있던 PR에 새 커밋이 쌓였다 — 처음부터 다시 돌리지 않고(사람이 이미 확인한 라운드는 그대로
      // 두고) 그 뒤 범위만 리뷰 라운드를 이어 돈다(버그 리포트 86). 리뷰를 한 번도 돌린 적 없거나 새 커밋이
      // 없으면 continueReviewAfterNewCommits 안에서 조용히 아무 일도 하지 않는다(돌 일이 없다)
      void continueReviewAfterNewCommits(id).catch((error: unknown) => console.error('[b-studio] 새 커밋에 대한 AI 리뷰 이어가기 실패', describe(error)));
    }
    return result;
  } finally {
    session.exporting = false;
  }
}

/** PR 자동 리뷰 라운드(ADR-074)의 고침 요청 대기 시간 상한. 계획 실행의 레인 시간 상한(task-plans.ts RUN_TIMEOUT_MS)과 같다 */
const REVIEW_FIX_TIMEOUT_MS = 30 * 60_000;

/** 세션의 원래 요청 문구들. 체크포인트 커밋 제목에서 "요청: " 접두어를 뗀다(repository.ts가 PR 본문에 쓰는 것과 같은 규칙) */
async function sessionRequestTexts(session: Session): Promise<string[]> {
  const commits = await session.checkpoints.sessionCommits();
  return commits.map((commit) => commit.subject.replace(/^요청:\s*/, ''));
}

/** 세션 브랜치 지금 HEAD의 커밋 sha. 리뷰 라운드가 이번에 본 diff의 끝 지점을 기록해(ReviewRoundView.headSha)
 * 다음에 새 커밋이 쌓이면 continueReviewAfterNewCommits가 그 지점부터만 다시 보게 한다 */
async function sessionHeadSha(session: Session): Promise<string | undefined> {
  const commits = await session.checkpoints.sessionCommits();
  return commits[commits.length - 1]?.sha;
}

/**
 * 리뷰어를 부르는 방법. 도구 없이 한 번만 묻는 호출 경로가 claude-code(로컬 CLI)·api(모델 레지스트리) 두 모드에만 있어
 * (계획 호출과 같은 제약, task-plans.ts의 PLANNER_MODES) 그 밖의 백엔드에서는 undefined를 돌려준다 —
 * review-round.ts의 runReviewRounds가 이를 보고 라운드를 시작하기 전에 바로 멈춘다(stopped)
 */
function reviewAsk(session: Session, reviewerModelId?: string): ModelAsk | undefined {
  // 설계 파이프라인(ADR-100): 사람이 리뷰어 모델을 명시적으로 고르면(구현과 다른 계열을 고르는 용도) 세션 백엔드와 무관하게
  // 모델 레지스트리(api 호출 경로)로 그 모델을 부른다. api는 공급자가 여러 개라 레지스트리만으로도 다른 계열 리뷰어를 둘 수 있다
  if (reviewerModelId) {
    try {
      return planAskFromClient(clientForModel(modelById(reviewerModelId)));
    } catch (error) {
      console.error(`[b-studio] 리뷰어 모델 ${reviewerModelId}을 쓸 수 없어 세션의 평소 리뷰 경로로 돌아갑니다`, describe(error));
    }
  }
  const backend = sessionBackend(session.snapshot);
  if (backend === 'claude-code') return claudeCodeAsk({ cwd: session.project.root });
  if (backend === 'api') return planAskFromClient(clientForModel(routingDecision('AI 리뷰', 'build', session.snapshot.modelId).selected));
  return undefined;
}

/** PR에 리뷰 코멘트를 올린다. review-round.ts가 실패를 잡아 commentError로만 남기므로 여기서는 그대로 던진다 */
async function reviewPostComment(session: Session, body: string): Promise<{ url?: string }> {
  const info = await session.checkpoints.repository();
  if (!info?.pullRequestUrl) throw new Error('PR 주소가 없습니다');
  const remote = parseRemote(info.remoteUrl);
  const number = parsePullRequestNumber(info.pullRequestUrl);
  if (number === undefined) throw new Error('PR 주소에서 번호를 읽지 못했습니다');
  // GitLab은 postComment가 환경 변수 토큰을 직접 읽는다. gh CLI 대체는 GitHub·Gitea에서만 뜻이 있다(저장소 화면과 같은 경계)
  const token = remote.kind === 'github' || remote.kind === 'gitea' ? await resolveRepositoryToken(remote.kind, { allowGhCli: localFolderAllowed() }) : undefined;
  return postComment(remote, number, body, { token });
}

/**
 * diff가 가리키지만 보여주지 않는 바깥 파일을 짧게 읽어 리뷰어에게 더 준다(과제 67-a) — 리뷰어는 diff만 보고
 * SeedLoader 같은 바깥 코드가 이미 처리하는 것을 모르는 채로 같은 거짓 지적을 라운드마다 반복하던 문제를 줄인다.
 * extractDiffReferencedNames(순수 함수, diff 텍스트만 본다)가 고른 이름마다 파일명이 정확히 일치하는 파일을
 * 작업 복사본에서 찾아 앞부분만 읽는다. 못 찾거나 못 읽으면 조용히 건너뛴다(리뷰 자체를 막을 이유가 아니다)
 */
async function reviewExternalContext(session: Session, diff: string): Promise<string | undefined> {
  const names = extractDiffReferencedNames(diff);
  if (names.length === 0) return undefined;
  const diffFiles = new Set(diffFilePaths(diff));
  const walk = await walkFiles(session.project.root).catch(() => undefined);
  if (!walk) return undefined;
  const workspace = new Workspace(session.project.root);
  const excerpts: Array<{ path: string; excerpt: string }> = [];
  for (const name of names) {
    if (excerpts.length >= PR_REVIEW_EXTERNAL_CONTEXT_MAX_FILES) break;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = walk.files.find((file) => !diffFiles.has(file) && new RegExp(`(^|/)${escaped}\\.[A-Za-z0-9]+$`).test(file));
    if (!match || excerpts.some((excerpt) => excerpt.path === match)) continue;
    try {
      const content = await workspace.read(match);
      if (content.includes('\u0000')) continue; // 바이너리는 건너뛴다
      excerpts.push({ path: match, excerpt: content.split('\n').slice(0, 60).join('\n') });
    } catch {
      // 너무 크거나 못 읽는 파일은 건너뛴다
    }
  }
  return excerpts.length > 0 ? buildPrReviewExternalContext(excerpts) : undefined;
}

/** sendMessage로 고침을 보내고 이 요청의 run_finished를 기다린다(task-plans.ts의 runAndWait·waitForEvent와 같은 방법) */
async function reviewRequestFix(session: Session, request: string): Promise<ReviewFixResult> {
  const id = session.snapshot.id;
  let finished: Extract<StudioEvent, { type: 'run_finished' }> | undefined;
  let runId: string | undefined;
  const unsubscribe = subscribe(id, (event) => {
    if (event.type === 'run_finished' && (runId === undefined || event.runId === runId)) finished = event;
  });
  try {
    ({ runId } = sendMessage(id, request, { allowBreaking: false, by: 'ai-review' }));
    const started = Date.now();
    while (finished?.runId !== runId) {
      if (Date.now() - started > REVIEW_FIX_TIMEOUT_MS) {
        return { ok: false, error: `AI 리뷰의 고침 요청이 ${Math.round(REVIEW_FIX_TIMEOUT_MS / 60_000)}분 안에 끝나지 않았습니다` };
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (finished.status !== 'done') return { ok: false, error: finished.summary };
    const checkpoint = session.snapshot.checkpoints[0];
    return { ok: true, checkpoint: checkpoint ? { sha: checkpoint.sha, shortSha: checkpoint.shortSha } : undefined };
  } finally {
    unsubscribe();
  }
}

/**
 * PR 자동 리뷰 라운드(ADR-074)를 시작한다. exportSession이 PR을 새로 연결한 뒤 설정(auto)이 켜져 있으면 자동으로,
 * 화면의 "AI 리뷰 돌리기"·"다시 돌리기" 버튼으로 사람이 부른다. 실제 순서(리뷰 → 댓글 → 필요하면 고침 → 다음 라운드)는
 * review-round.ts의 runReviewRounds(순수 상태 기계, vitest로 따로 검증)가 정하고, 여기서는 세션의 diff·댓글·고침 요청·올리기를
 * 함수로 이어 준다. 한 번 부르면 1라운드부터 상한까지(또는 통과·오류까지) 안에서 이어간다. 절대 병합하지 않고, 강제 푸시도 하지 않는다.
 * 리뷰어 호출 토큰은 token-report.ts의 reviewTokenReports가 스냅샷의 review.rounds[].tokens를 그대로 읽어 "review"로 표시한다.
 */
export async function runReviewRound(id: string, { restart = false, reviewerModelId }: { restart?: boolean; reviewerModelId?: string } = {}): Promise<void> {
  const session = requireSession(id);
  const info = await session.checkpoints.repository();
  if (!info?.pullRequestUrl) throw new StudioError(409, 'PR을 먼저 만들어야 AI 리뷰를 돌릴 수 있습니다');
  if (session.snapshot.review?.state === 'running') throw new StudioError(409, '이미 AI 리뷰를 돌리는 중입니다');
  // 이미 끝난(통과·상한·멈춤) 리뷰가 있으면 "다시 돌리기"로만 새로 돈다(위에서 running은 이미 걸렀다). 실수로 다시 누르는 것을 막는다
  if (session.snapshot.review && !restart) {
    throw new StudioError(409, '이미 리뷰가 끝났습니다. 다시 돌리려면 "다시 돌리기"를 누르세요');
  }

  // main 따라잡기(ADR-076): 기준 브랜치가 앞서 있고 깨끗하게 병합할 수 있으면 리뷰 라운드를 돌리기 전에 조용히 먼저 따라잡는다
  await autoCatchUpBase(session);

  const cfg = session.project.spec.review;
  const requests = await sessionRequestTexts(session);
  // 요구사항 문맥은 한 번만 계산해 클로저로 넘긴다(리뷰 라운드마다 다시 계산할 필요가 없다 — 같은 세션 안에서 바뀌지 않는다)
  const requirementsContext = await reviewRequirementsContext(session, requests);
  // "다시 돌리기"로 새 리뷰를 시작하면 session.snapshot.review를 곧 rounds: []로 덮어쓴다 — 그 전에 사람이 오탐으로
  // 닫은 지적을 모아 둬야 다음 라운드의 리뷰어가 "이미 확인했다"고 알 수 있다(과제 67-b)
  const resolvedFindings = collectHumanResolvedFindings(session.snapshot.review);
  const resolvedContext = resolvedFindings.length > 0 ? buildPrReviewResolvedContext(resolvedFindings) : undefined;
  const deps: ReviewRoundDeps = {
    ask: reviewAsk(session, reviewerModelId),
    diff: () => session.checkpoints.sessionDiff(),
    requests: () => requests,
    requirementsContext: () => requirementsContext,
    externalContext: (diff) => reviewExternalContext(session, diff),
    ...(resolvedContext ? { resolvedContext: () => resolvedContext } : {}),
    // since 없이 head만 기록한다(세션 시작부터 보는 첫 리뷰라 범위를 코멘트에 적지 않는다) — 이 head가 남아야
    // 나중에 새 커밋이 쌓였을 때 continueReviewAfterNewCommits가 그 지점부터만 다시 볼 수 있다(버그 리포트 86)
    commitRange: async () => {
      const head = await sessionHeadSha(session);
      return head ? { head } : undefined;
    },
    postComment: (body) => reviewPostComment(session, body),
    requestFix: (text) => reviewRequestFix(session, text),
    push: async () => {
      await session.checkpoints.push();
      const repository = await describeRepository(session.checkpoints, session.sourceDirtyFiles);
      if (repository) session.snapshot.repository = repository;
    },
  };
  // 설계 파이프라인(ADR-100): 구현 모델 계열과 리뷰어 계열이 같으면 "같은 계열 검토(독립성 낮음)"로 남긴다 — 통과해도
  // 파이프라인의 "성공" 판정에는 세지 않는다(reviewIndependence). 리뷰어를 따로 고르지 않으면 이 세션의 평소 경로를
  // 그대로 쓰므로(reviewAsk) 구현과 같은 계열이다
  const implementerFamily = modelFamily(sessionBackend(session.snapshot), session.snapshot.modelId);
  const reviewerFamily = reviewerModelId ? modelFamily('api', reviewerModelId) : implementerFamily;
  const independence = reviewIndependence(implementerFamily, reviewerFamily);

  session.snapshot.review = { state: 'running', maxRounds: cfg.maxRounds, rounds: [], ...(reviewerModelId ? { reviewerModelId } : {}), independence };
  void runReviewRounds(deps, cfg.maxRounds, (state) => {
    session.snapshot.review = { ...state, ...(reviewerModelId ? { reviewerModelId } : {}), independence };
    emit(session, { type: 'review_round', review: session.snapshot.review });
  }).catch((error: unknown) => {
    session.snapshot.review = { state: 'stopped', maxRounds: cfg.maxRounds, rounds: session.snapshot.review?.rounds ?? [], ...(reviewerModelId ? { reviewerModelId } : {}), independence };
    emit(session, { type: 'review_round', review: session.snapshot.review });
    console.error('[b-studio] AI 리뷰 라운드가 예기치 않게 실패했습니다', describe(error));
  });
}

/**
 * 이미 열려 있던 PR에 이번 export로 새 커밋이 쌓였고 AI 리뷰 자동(auto)이 켜져 있을 때, 마지막으로 리뷰한
 * 커밋(review.rounds의 가장 최근 라운드의 headSha) 이후의 diff만으로 리뷰를 이어 돈다(버그 리포트 86: PR을
 * 다시 만들 때 리뷰가 다시 돌지 않아 새 코드 123줄이 리뷰 없이 들어갔다). exportSession이 PR을 "새로" 연결한
 * 경우(runReviewRound가 처음부터 돈다)와 달리, 여기는 처음부터 다시 돌지 않고 review-round.ts의 runReviewRounds에
 * resume으로 기존 rounds를 넘겨 라운드 번호를 이어간다 — 라운드 상한(maxRounds)도 이 PR이 지금까지 돈 리뷰
 * 호출 전체에 걸친 값이라, 이미 상한에 닿아 있으면 runReviewRounds가 새로 리뷰를 부르지 않고 그 사실만 남긴다.
 *
 * 다음 중 하나라도 해당하면 아무것도 하지 않는다(모두 "돌 일이 없다"는 뜻이지 실패가 아니다):
 *  - 리뷰를 한 번도 돌린 적이 없다(review 없음) — 이 PR은 애초에 AI 리뷰를 쓴 적이 없다
 *  - 지금 리뷰가 도는 중이다 — 겹쳐 돌지 않는다
 *  - 마지막 라운드가 headSha를 남기지 않았다(이 기능이 생기기 전에 끝난 리뷰) — 범위를 모르니 섣불리 전체를
 *    다시 보지 않는다(사람이 "다시 돌리기"로 명시적으로 새로 시작할 수 있다)
 *  - 마지막으로 리뷰한 커밋과 지금 HEAD가 같다 — 새 커밋이 없다
 */
export async function continueReviewAfterNewCommits(id: string): Promise<void> {
  const session = requireSession(id);
  const review = session.snapshot.review;
  if (!review || review.state === 'running') return;
  const info = await session.checkpoints.repository();
  if (!info?.pullRequestUrl) return;

  const lastRound = review.rounds[review.rounds.length - 1];
  if (!lastRound) return;
  // headSha가 없는 라운드는 이 기록이 생기기 전에 끝난 리뷰다. 그 라운드가 시작될 때의 HEAD(그 전에 만든 마지막 커밋)를
  // 기준점으로 삼는다. 커밋 시각은 초 단위라 라운드 시작과 같은 초에 만든 커밋은 그 라운드가 본 것으로 친다(리뷰 뒤
  // 고침 커밋은 보통 분 단위로 늦게 생긴다). 그래도 못 정하면 조용히 넘어가지 않고 대화에 알린다(도그푸딩 마찰 87)
  const sinceSha = lastRound.headSha ?? (await session.checkpoints.commitBefore(lastRound.startedAt));
  if (!sinceSha) {
    emit(session, { type: 'notice', text: `PR에 새 커밋을 올렸지만 이전 리뷰 라운드 ${lastRound.round}가 어느 커밋까지 봤는지 알 수 없어 AI 리뷰를 이어 돌리지 않았습니다. 리뷰를 다시 돌리려면 PR 리뷰의 다시 돌리기를 누르세요`, at: new Date().toISOString() });
    return;
  }
  const headSha = await sessionHeadSha(session);
  if (!headSha || sinceSha === headSha) return;

  // main 따라잡기(ADR-076): 리뷰를 이어 돌리기 전에 조용히 먼저 따라잡는다(runReviewRound와 같은 이유)
  await autoCatchUpBase(session);

  const cfg = session.project.spec.review;
  const requests = await sessionRequestTexts(session);
  const requirementsContext = await reviewRequirementsContext(session, requests);
  const resolvedFindings = collectHumanResolvedFindings(review);
  const resolvedContext = resolvedFindings.length > 0 ? buildPrReviewResolvedContext(resolvedFindings) : undefined;
  const deps: ReviewRoundDeps = {
    ask: reviewAsk(session, review.reviewerModelId),
    // 세션 시작부터가 아니라 마지막으로 리뷰한 커밋부터 지금 HEAD까지만 본다 — 이미 통과한 변경을 다시 지적하지 않는다.
    // 라운드 안에서 고침 커밋이 쌓여도 since는 그대로라 다음 라운드는 그 고침까지 포함한 diff를 본다(처음 리뷰가
    // 매 라운드 base...head 전체를 다시 보는 것과 같은 모양, 기준점만 세션 시작이 아니라 sinceSha다)
    diff: () => session.checkpoints.diffSince(sinceSha),
    requests: () => requests,
    requirementsContext: () => requirementsContext,
    externalContext: (diff) => reviewExternalContext(session, diff),
    ...(resolvedContext ? { resolvedContext: () => resolvedContext } : {}),
    commitRange: async () => {
      const head = await sessionHeadSha(session);
      return head ? { since: sinceSha, head } : undefined;
    },
    postComment: (body) => reviewPostComment(session, body),
    requestFix: (text) => reviewRequestFix(session, text),
    push: async () => {
      await session.checkpoints.push();
      const repository = await describeRepository(session.checkpoints, session.sourceDirtyFiles);
      if (repository) session.snapshot.repository = repository;
    },
  };
  const independence = review.independence ?? 'unknown';
  const reviewerModelId = review.reviewerModelId;

  session.snapshot.review = { ...review, state: 'running' };
  emit(session, { type: 'review_round', review: session.snapshot.review });
  void runReviewRounds(
    deps,
    cfg.maxRounds,
    (state) => {
      session.snapshot.review = { ...state, ...(reviewerModelId ? { reviewerModelId } : {}), independence };
      emit(session, { type: 'review_round', review: session.snapshot.review });
    },
    { rounds: review.rounds },
  ).catch((error: unknown) => {
    session.snapshot.review = { state: 'stopped', maxRounds: cfg.maxRounds, rounds: review.rounds, ...(reviewerModelId ? { reviewerModelId } : {}), independence };
    emit(session, { type: 'review_round', review: session.snapshot.review });
    console.error('[b-studio] 새 커밋에 대한 AI 리뷰 이어가기 라운드가 예기치 않게 실패했습니다', describe(error));
  });
}

/**
 * 사람이 리뷰 라운드의 지적 하나를 오탐으로 닫는다(과제 67-b) — 리뷰어는 diff만 보고 실제 PostgreSQL 시퀀스가
 * 이미 복원됐다는 증거를 볼 수 없어 같은 거짓 지적을 라운드마다 되풀이할 수 있다. 사람이 직접 확인한 이유를 남기면
 * (1) 그 라운드가 막는 지적을 모두 사람이 확인했을 때 "라운드 상한"처럼 사람을 기다리던 상태를 "사람이 확인함"으로
 * 바꾸고, (2) 다음 라운드의 리뷰어 문맥에 "이미 확인했다"고 전해 되풀이를 막는다(runReviewRound의 resolvedContext).
 * 원래 그 라운드가 PR에 댓글을 남겼으면(commentUrl) 같은 댓글 API로 이유를 답글처럼 남긴다 — 실패해도 결정 자체는 막지 않는다
 */
export async function resolveReviewFinding(
  id: string,
  { round: roundNumber, findingIndex, reason, by }: { round: number; findingIndex: number; reason: string; by?: string },
): Promise<SessionSnapshot> {
  const session = requireSession(id);
  const review = session.snapshot.review;
  if (!review) throw new StudioError(409, 'AI 리뷰를 아직 돌리지 않았습니다');
  const round = review.rounds.find((candidate) => candidate.round === roundNumber);
  if (!round) throw new StudioError(404, `${roundNumber}라운드를 찾을 수 없습니다`);
  const finding = round.findings?.[findingIndex];
  if (!finding) throw new StudioError(404, '지적을 찾을 수 없습니다');
  const trimmedReason = reason.trim();
  if (!trimmedReason) throw new StudioError(400, '오탐으로 닫는 이유를 입력하세요');

  const humanResolutions = { ...round.humanResolutions, [findingIndex]: { reason: trimmedReason, by, at: new Date().toISOString() } };
  const blockingIndexes = (round.findings ?? []).reduce<number[]>((acc, candidate, index) => (isBlockingFinding(candidate) ? [...acc, index] : acc), []);
  const allBlockingResolved = blockingIndexes.length > 0 && blockingIndexes.every((index) => humanResolutions[index] !== undefined);
  const updatedRound: ReviewRoundView = { ...round, humanResolutions, status: allBlockingResolved ? 'resolved_by_human' : round.status };
  const rounds = review.rounds.map((candidate) => (candidate.round === roundNumber ? updatedRound : candidate));
  const state: ReviewStateView['state'] = allBlockingResolved && (review.state === 'capped' || review.state === 'stopped') ? 'resolved' : review.state;
  session.snapshot.review = { ...review, rounds, state };
  emit(session, { type: 'review_round', review: session.snapshot.review });

  if (round.commentUrl) {
    try {
      await reviewPostComment(session, buildReviewResolutionComment(finding, trimmedReason));
    } catch (error) {
      // 댓글 실패는 결정 자체를 막지 않는다(라운드 코멘트와 같은 규칙, review-round.ts의 commentError)
      console.error('[b-studio] 리뷰 지적 해소 댓글을 남기지 못했습니다', describe(error));
    }
  }
  return session.snapshot;
}

/** 배포 진행 줄은 최근 것만 스냅샷에 둔다. 빌드 출력이 수백 줄이라 전부 두면 새로 연결할 때 무겁다 */
const DEPLOY_LOG_LIMIT = 200;

/**
 * 세션의 체크포인트를 운영 배포한다. 작업 폴더가 아니라 체크포인트를 꺼내 빌드하므로 게이트를 통과한 상태만 배포된다.
 * 샌드박스와 따로 돌고 오래 걸리므로 바로 돌아가며, 진행과 결과는 이벤트로 알린다
 */
export function deploySession(id: string, { by, sha }: { by?: string; sha?: string }): void {
  const session = requireSession(id);
  if (session.snapshot.deploying) throw new StudioError(409, '이 세션에서 이미 배포하는 중입니다');
  const checkpoint = sha ? session.snapshot.checkpoints.find((candidate) => candidate.sha === sha) : session.snapshot.checkpoints[0];
  if (!checkpoint) throw new StudioError(404, '체크포인트를 찾을 수 없습니다');
  // 규칙은 체크포인트 안의 studio.yaml이 아니라 실행 중인 세션의 것을 쓴다. 같은 변경에서 규칙을 느슨하게 고쳐 배포하지 못하게 한다
  const blockers = releaseBlockers(session.project, checkpoint.passedStages);
  if (blockers.length > 0) {
    // 가볍게 확인한 체크포인트는 건너뛴 단계가 통과 기록에 없어 여기서 자연히 막힌다. 이유를 분명히 알려 준다
    const light = checkpoint.verify === 'light' ? ' 가볍게 확인한 체크포인트는 전체 검증 뒤 배포할 수 있습니다.' : '';
    throw new StudioError(
      409,
      `체크포인트 ${checkpoint.shortSha}는 배포 조건을 채우지 못했습니다. 통과 기록이 없는 단계: ${blockers.join(', ')}${checkpoint.passedStages ? '' : ' (검증 게이트를 거치지 않은 체크포인트입니다)'}${light}`,
    );
  }

  runDeployJob(session, { action: 'deploy', target: checkpoint.shortSha, by }, async (onLog) => {
    // 같은 체크포인트를 동시에 배포해도 폴더가 겹치지 않게 한다
    const sourceRoot = path.join(defaultDeployRoot(), session.project.spec.name, 'sources', `${checkpoint.shortSha}-${randomBytes(3).toString('hex')}`);
    try {
      onLog({ stage: 'prepare', text: `체크포인트 ${checkpoint.shortSha}의 파일을 꺼냅니다` });
      const project = await loadProject(await session.checkpoints.exportTree(checkpoint.sha, sourceRoot));
      const deployer = new DockerDeployer(project, { secrets: await resolveSecrets(project) });
      return await deployer.deploy({ label: `체크포인트 ${checkpoint.shortSha} ${checkpoint.message}`, sha: checkpoint.sha }, { onLog, by });
    } finally {
      // 이미지를 만든 뒤에는 꺼낸 파일이 필요 없다. 릴리스 compose 파일은 배포 상태 폴더에 따로 있다
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });
}

/** 이미지를 남긴 이전 릴리스로 빌드 없이 되돌린다 */
export function rollbackSessionDeploy(id: string, releaseId: string, { by }: { by?: string }): void {
  const session = requireSession(id);
  if (session.snapshot.deploying) throw new StudioError(409, '이 세션에서 이미 배포하는 중입니다');
  runDeployJob(session, { action: 'rollback', target: releaseId, by }, async (onLog) => {
    const deployer = new DockerDeployer(session.project, { secrets: await resolveSecrets(session.project) });
    return deployer.rollback(releaseId, { onLog, by });
  });
}

function runDeployJob(
  session: Session,
  { action, target, by }: { action: 'deploy' | 'rollback'; target: string; by?: string },
  job: (onLog: (log: DeployLog) => void) => Promise<DeployResult>,
): void {
  const at = new Date().toISOString();
  session.snapshot.deploying = { action, target, startedAt: at, by, lines: [] };
  emit(session, { type: 'deploy_started', action, target, at, by });
  const onLog = (log: DeployLog) => {
    const deploying = session.snapshot.deploying;
    if (!deploying) return;
    const line = `${log.service ? `[${log.service}] ` : ''}${log.text}`;
    deploying.lines.push(line);
    if (deploying.lines.length > DEPLOY_LOG_LIMIT) deploying.lines.splice(0, deploying.lines.length - DEPLOY_LOG_LIMIT);
    emit(session, { type: 'deploy_log', line });
  };

  void (async () => {
    let event: StudioEvent;
    try {
      const result = await job(onLog);
      event = { type: 'deploy_finished', action, release: result.release.id, label: result.release.source.label, urls: result.urls, previous: result.previous };
    } catch (error) {
      const detail = (error as { detail?: unknown }).detail;
      event = { type: 'deploy_failed', action, target, error: describe(error).split('\n')[0]!, ...(typeof detail === 'string' && detail.trim() ? { detail: detail.trim().slice(-4_000) } : {}) };
    }
    // 새로 연결한 브라우저가 배포 중 상태에 멈추지 않도록 이벤트보다 먼저 푼다
    session.snapshot.deploying = undefined;
    emit(session, event);
  })();
}

/**
 * 원격 세션 브랜치에 다른 사람(리뷰어)이 올린 커밋을 가져온다. 오래 걸리므로 바로 돌아가고 결과는 이벤트로 알린다.
 * 가져온 변경도 에이전트의 변경처럼 게이트를 거치고, 통과하지 못하면 파일과 데이터베이스를 가져오기 전으로 되돌린다
 */
export function syncRemote(id: string): void {
  const session = requireSession(id);
  if (!session.snapshot.repository) throw new StudioError(409, '원본 프로젝트가 Git 저장소가 아니어서 가져올 원격 브랜치가 없습니다');
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 가져올 수 있습니다');
  if (session.snapshot.running || session.exporting) throw new StudioError(409, '다른 작업을 처리하는 중입니다');

  session.snapshot.running = true;
  emit(session, { type: 'remote_sync_started' });
  void (async () => {
    const event = await runRemoteSync(session);
    // 새로 연결한 브라우저가 실행 중 상태에 멈추지 않도록 이벤트보다 먼저 푼다
    session.snapshot.running = false;
    if (!session.stop.signal.aborted) emit(session, event);
  })();
}

async function runRemoteSync(session: Session): Promise<StudioEvent> {
  const start: StartOptions = { signal: session.stop.signal, onStatus: (status) => onServiceStatus(session, status) };
  let baselines: Awaited<ReturnType<typeof captureBaselines>>;
  let result: RemoteSyncResult;
  try {
    // 계약 비교 기준은 가져온 파일이 반영되기 전에 잡는다
    baselines = await captureBaselines(session.sandbox, session.project);
    result = await session.checkpoints.integrateRemote();
  } catch (error) {
    return { type: 'remote_sync_failed', error: describe(error), conflicts: error instanceof RemoteConflictError ? error.conflicts : undefined };
  }

  const commits = result.commits.map(({ shortSha, subject, author }) => ({ shortSha, subject, author }));
  if (result.status === 'up-to-date') {
    const repository = (await describeRepository(session.checkpoints, session.sourceDirtyFiles))!;
    session.snapshot.repository = repository;
    return { type: 'remote_synced', status: 'up-to-date', commits, files: [], checkpoints: session.snapshot.checkpoints, repository };
  }

  let report: VerificationReport | undefined;
  try {
    // 리뷰어가 의도한 API 변경은 막지 않고 결과로 보여 준다. 기동 실패와 시크릿 값은 막는다
    report = await verifyChanges({ sandbox: session.sandbox, project: session.project, changedFiles: result.files, baselines, allowBreaking: true, start });
    if (!report.ok) return await undoRemoteSync(session, result, commits, report, '가져온 변경이 검증 게이트를 통과하지 못해 가져오기 전 체크포인트로 되돌렸습니다', start);

    await session.checkpoints.acceptRemote(result);
    const checkpoint = result.checkpoint!;
    await saveDatabases(session, checkpoint.sha);
    session.snapshot.checkpoints = await session.checkpoints.list();
    const repository = (await describeRepository(session.checkpoints, session.sourceDirtyFiles))!;
    session.snapshot.repository = repository;
    noteForModel(
      session,
      `[b-studio] 원격 브랜치에서 다른 사람이 올린 커밋 ${commits.length}개(${commits.map((commit) => commit.subject).join(', ')})를 가져와 체크포인트 ${checkpoint.shortSha}로 남겼습니다. 바뀐 파일: ${result.files.slice(0, 20).join(', ')}. 다음 작업은 이 변경을 전제로 하세요.`,
    );
    return { type: 'remote_synced', status: result.status, commits, files: result.files, checkpoint, report, checkpoints: session.snapshot.checkpoints, repository };
  } catch (error) {
    return undoRemoteSync(session, result, commits, report, `가져온 변경을 확인하지 못해 가져오기 전 체크포인트로 되돌렸습니다: ${describe(error)}`, start);
  }
}

/** 검증된 체크포인트만 남긴다. 파일과 데이터베이스를 가져오기 전으로 되돌리고 바뀐 서비스를 다시 띄운다 */
async function undoRemoteSync(
  session: Session,
  result: RemoteSyncResult,
  commits: Array<{ shortSha: string; subject: string; author: string }>,
  report: VerificationReport | undefined,
  error: string,
  start: StartOptions,
): Promise<StudioEvent> {
  try {
    // 되돌리기 전에 아직 체크포인트로 남기지 않은 변경이 있었으면 버리기 전에 백업한다(ADR-099)
    const { files, backup } = await session.checkpoints.restore(result.previous);
    if (files.includes(SPEC_FILE)) await reloadSessionProject(session);
    const database = await session.databases.restore(result.previous, session.stop.signal);
    const restart = await restartServicesFor(session.sandbox, session.project, files, start, { alsoRestart: database.dependents });
    session.snapshot.checkpoints = await session.checkpoints.list();
    return {
      type: 'remote_sync_failed',
      error,
      commits,
      files: result.files,
      report,
      restarted: restart.restarted,
      checkpoints: session.snapshot.checkpoints,
      backup,
    };
  } catch (undoError) {
    return { type: 'remote_sync_failed', error: `${error}. 되돌리지도 못했습니다: ${describe(undoError)}`, commits, files: result.files, report };
  }
}

/**
 * 기준 브랜치(main 등)가 이 세션보다 얼마나 앞서 있는지 확인한다(ADR-076). 원격 연동이 없는 세션은 확인할 것이 없다.
 * 화면(repository-bar)이 가볍게(예: 60초마다) 물어 "N커밋 앞서 있습니다 · 따라잡기"를 보여 준다
 */
export async function baseStatus(id: string, options: { force?: boolean } = {}): Promise<BaseStatus> {
  const session = requireSession(id);
  if (!session.snapshot.repository) throw new StudioError(409, '원본 프로젝트가 Git 저장소가 아니어서 확인할 기준 브랜치가 없습니다');
  return session.checkpoints.baseStatus(options);
}

/**
 * 세션 브랜치가 갈라져 나온 기준 브랜치(main 등)를 병합으로 따라잡는다(ADR-076, "main 따라잡기").
 * 원격 세션 브랜치 가져오기(syncRemote)와 같은 흐름이다: 병합 결과도 에이전트의 변경처럼 검증 게이트를 거치고,
 * 통과하지 못하면 파일과 데이터베이스를 병합 전으로 되돌린다. 충돌하면 병합을 시작하기 전 상태 그대로 두고 사람에게
 * 넘긴다(기본 정책). "에이전트에게 충돌 해결 맡기기"는 resolveBaseConflictsWithAgent가 맡는다
 */
export function catchUpBase(id: string): void {
  const session = requireSession(id);
  if (!session.snapshot.repository) throw new StudioError(409, '원본 프로젝트가 Git 저장소가 아니어서 따라잡을 기준 브랜치가 없습니다');
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 따라잡을 수 있습니다');
  if (session.snapshot.running || session.exporting) throw new StudioError(409, '다른 작업을 처리하는 중입니다');

  session.snapshot.running = true;
  emit(session, { type: 'base_sync_started' });
  void (async () => {
    const event = await runBaseCatchUp(session);
    session.snapshot.running = false;
    if (!session.stop.signal.aborted) emit(session, event);
  })();
}

/**
 * "에이전트에게 충돌 해결 맡기기"(ADR-076). 병합을 시도해 충돌 없이 따라잡을 수 있으면 catchUpBase와 똑같이 끝낸다.
 * 충돌하면(병합은 이미 시도 전으로 되돌아간 뒤) 자동으로 고치게 보내는 대신, 충돌한 파일과 무엇을 할지 알려 주는
 * 요청 문구를 만들어 돌려준다 — 화면이 이 문구를 대화 입력창에 미리 채워 사람이 보고 다듬어 보내게 한다.
 * 병합 커밋을 충돌 표시(conflict marker)째로 만들어 곧바로 에이전트에게 보내는 방식은 체크포인트 커밋 경계
 * (#checkpoint, MERGE_HEAD 처리)를 크게 건드려야 해서, 더 안전한 이 대안을 택했다(docs/decisions.md ADR-076 참고)
 */
export async function resolveBaseConflictsWithAgent(id: string): Promise<{ request?: string; conflicts?: string[] }> {
  const session = requireSession(id);
  if (!session.snapshot.repository) throw new StudioError(409, '원본 프로젝트가 Git 저장소가 아니어서 따라잡을 기준 브랜치가 없습니다');
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 따라잡을 수 있습니다');
  if (session.snapshot.running || session.exporting) throw new StudioError(409, '다른 작업을 처리하는 중입니다');

  session.snapshot.running = true;
  emit(session, { type: 'base_sync_started' });
  const event = await runBaseCatchUp(session);
  session.snapshot.running = false;
  if (event.type !== 'base_sync_failed' || !event.conflicts || event.conflicts.length === 0) {
    if (!session.stop.signal.aborted) emit(session, event);
    return {};
  }

  const info = (await session.checkpoints.repository())!;
  const request = buildBaseConflictRequest(info.base, event.conflicts);
  if (!session.stop.signal.aborted) emit(session, { ...event, agentRequest: request });
  return { request, conflicts: event.conflicts };
}

/** "에이전트에게 충돌 해결 맡기기"가 화면 대화 입력창에 미리 채울 문구. 자동으로 보내지 않고 사람이 보고 다듬어 보낸다 */
function buildBaseConflictRequest(base: string, conflicts: readonly string[]): string {
  return (
    `${base} 브랜치를 병합해 따라잡으려 했지만 다음 파일에서 이 세션의 변경과 충돌했습니다: ${conflicts.join(', ')}. ` +
    `병합은 시도하기 전으로 되돌려 두었습니다. 각 파일에서 ${base} 브랜치가 그사이 바꾼 내용을 확인하고(예: git show origin/${base}:<파일 경로>), ` +
    `이 세션의 의도를 지키면서 그 변경을 손으로 반영해 주세요. 자동 병합은 다시 시도하지 말고 코드를 직접 맞춰 주세요.`
  );
}

async function runBaseCatchUp(session: Session): Promise<StudioEvent> {
  const start: StartOptions = { signal: session.stop.signal, onStatus: (status) => onServiceStatus(session, status) };
  let baselines: Awaited<ReturnType<typeof captureBaselines>>;
  let result: RemoteSyncResult;
  try {
    // 계약 비교 기준은 병합한 변경이 반영되기 전에 잡는다
    baselines = await captureBaselines(session.sandbox, session.project);
    result = await session.checkpoints.integrateBase();
  } catch (error) {
    return { type: 'base_sync_failed', error: describe(error), conflicts: error instanceof RemoteConflictError ? error.conflicts : undefined };
  }

  if (result.status === 'up-to-date') {
    const repository = (await describeRepository(session.checkpoints, session.sourceDirtyFiles))!;
    session.snapshot.repository = repository;
    return { type: 'base_synced', status: 'up-to-date', commits: 0, files: [], checkpoints: session.snapshot.checkpoints, repository };
  }

  let report: VerificationReport | undefined;
  try {
    // 기준 브랜치가 의도한 API 변경은 막지 않고 결과로 보여 준다(리뷰어 커밋 가져오기와 같은 이유). 기동 실패와 시크릿 값은 막는다
    report = await verifyChanges({ sandbox: session.sandbox, project: session.project, changedFiles: result.files, baselines, allowBreaking: true, start });
    if (!report.ok) return await undoBaseSync(session, result, report, '따라잡은 변경이 검증 게이트를 통과하지 못해 따라잡기 전 체크포인트로 되돌렸습니다', start);

    const checkpoint = result.checkpoint!;
    await saveDatabases(session, checkpoint.sha);
    session.snapshot.checkpoints = await session.checkpoints.list();
    let repository = (await describeRepository(session.checkpoints, session.sourceDirtyFiles))!;
    // PR이 이미 있는 세션은 뒤처진 채 두지 않고 바로 밀어 둔다(다음 리뷰·머지가 최신 기준으로 돈다). PR을 새로 만들지는 않는다
    if (repository.pullRequestUrl) {
      await session.checkpoints.push();
      repository = (await describeRepository(session.checkpoints, session.sourceDirtyFiles))!;
    }
    session.snapshot.repository = repository;
    noteForModel(
      session,
      `[b-studio] ${repository.base} 브랜치가 앞서 있던 커밋 ${result.commits.length}개를 병합으로 따라잡아 체크포인트 ${checkpoint.shortSha}로 남겼습니다. 바뀐 파일: ${result.files.slice(0, 20).join(', ')}. 다음 작업은 이 변경을 전제로 하세요.`,
    );
    return {
      type: 'base_synced',
      status: 'merged',
      commits: result.commits.length,
      files: result.files,
      checkpoint,
      report,
      checkpoints: session.snapshot.checkpoints,
      repository,
    };
  } catch (error) {
    return undoBaseSync(session, result, report, `따라잡은 변경을 확인하지 못해 따라잡기 전 체크포인트로 되돌렸습니다: ${describe(error)}`, start);
  }
}

/** 검증된 체크포인트만 남긴다. 파일과 데이터베이스를 병합 전으로 되돌리고 바뀐 서비스를 다시 띄운다 */
async function undoBaseSync(
  session: Session,
  result: RemoteSyncResult,
  report: VerificationReport | undefined,
  error: string,
  start: StartOptions,
): Promise<StudioEvent> {
  try {
    // 되돌리기 전에 아직 체크포인트로 남기지 않은 변경이 있었으면 버리기 전에 백업한다(ADR-099)
    const { files, backup } = await session.checkpoints.restore(result.previous);
    if (files.includes(SPEC_FILE)) await reloadSessionProject(session);
    const database = await session.databases.restore(result.previous, session.stop.signal);
    const restart = await restartServicesFor(session.sandbox, session.project, files, start, { alsoRestart: database.dependents });
    session.snapshot.checkpoints = await session.checkpoints.list();
    return {
      type: 'base_sync_failed',
      error,
      files: result.files,
      report,
      restarted: restart.restarted,
      checkpoints: session.snapshot.checkpoints,
      backup,
    };
  } catch (undoError) {
    return { type: 'base_sync_failed', error: `${error}. 되돌리지도 못했습니다: ${describe(undoError)}`, files: result.files, report };
  }
}

/**
 * repository.autoCatchUp(기본 켬)이 켜져 있고 기준 브랜치가 앞서 있으면, AI 리뷰 라운드를 돌리거나 올리기 전에
 * 조용히 먼저 따라잡는다(ADR-076). 충돌하면(사람이 따로 처리해야 하면) 건드리지 않고 그대로 진행한다 —
 * 리뷰나 올리기 자체를 막지 않는다. 이미 다른 작업이 진행 중이면(드문 경쟁) 이번에는 건너뛴다
 */
async function autoCatchUpBase(session: Session): Promise<void> {
  if (!session.snapshot.repository) return;
  if (session.project.spec.repository?.autoCatchUp === false) return;
  if (session.snapshot.running) return;

  const status = await session.checkpoints.baseStatus().catch(() => undefined);
  if (!status || status.behind === 0) return;

  session.snapshot.running = true;
  emit(session, { type: 'base_sync_started' });
  const event = await runBaseCatchUp(session);
  session.snapshot.running = false;
  emit(session, event);
}

async function describeRepository(store: CheckpointStore, sourceDirtyFiles: number): Promise<RepositoryView | undefined> {
  const info = await store.repository();
  if (!info) return undefined;
  const remote = parseRemote(info.remoteUrl);
  // 이슈 발행(requirementIssuesContext)과 같은 토큰 찾기를 쓴다(ADR-107) — gh CLI 로그인만으로도 "올리고 PR 만들기"가 보여야 한다
  const token = await repositoryPullRequestToken(remote);
  return {
    remote: remote.display,
    kind: remote.kind,
    base: info.base,
    branch: info.branch,
    subdir: info.subdir,
    sourceDirtyFiles,
    pushedSha: info.pushedSha,
    pullRequestUrl: info.pullRequestUrl,
    compareUrl: compareUrl(remote, info.base, info.branch),
    canCreatePullRequest: canCreatePullRequest(remote, process.env, token),
  };
}

/** PR 생성에 쓸 토큰(개인 PC 모드면 gh CLI 로그인 대체까지). GitLab 등 gh CLI 대체가 뜻 없는 호스트는 undefined(canCreatePullRequest·createPullRequest가 환경 변수만 본다) */
async function repositoryPullRequestToken(remote: RemoteLocation): Promise<string | undefined> {
  if (remote.kind !== 'github' && remote.kind !== 'gitea') return undefined;
  return cachedRepositoryToken(remote.kind, { allowGhCli: localFolderAllowed() });
}

/** 사내 저장소가 커밋 작성자를 검사하면 체크포인트 작성자를 실제 계정으로 바꿔야 한다 */
function gitAuthor(): GitAuthor | undefined {
  const name = process.env.B_STUDIO_GIT_AUTHOR_NAME?.trim();
  const email = process.env.B_STUDIO_GIT_AUTHOR_EMAIL?.trim();
  return name && email ? { name, email } : undefined;
}

/** 한 번에 보내는 파일 수. 더 보기로 이어서 받는다 */
const CODE_PAGE_SIZE = 500;

/**
 * 코드 화면의 파일 목록과 마지막 체크포인트 이후 바뀐 파일. 생성물과 .env는 빼고, 경로로 좁힌 뒤 쪽 단위로 보낸다.
 * 에이전트 도구의 목록 한도(500개)와 달리 화면은 큰 저장소의 파일도 모두 센다
 */
export async function listCodeFiles(id: string, { query = '', offset = 0, limit = CODE_PAGE_SIZE }: { query?: string; offset?: number; limit?: number } = {}): Promise<CodeTree> {
  const session = requireSession(id);
  const walk = await walkFiles(session.project.root);
  const needle = query.trim().toLowerCase();
  const matched = needle ? walk.files.filter((file) => file.toLowerCase().includes(needle)) : walk.files;
  return {
    files: matched.slice(offset, offset + limit),
    offset,
    total: matched.length,
    changes: (await session.checkpoints.pendingChanges()).filter((change) => !isDeniedPath(change.file)),
    truncated: walk.truncated,
  };
}

/** 코드 화면의 내용 찾기. 도구 결과와 같게 시크릿 값을 가려서 보내고, 가리면서 자리가 바뀌면 다시 찾는다 */
export async function searchCodeFiles(id: string, query: string): Promise<CodeSearch> {
  const session = requireSession(id);
  const needle = query.trim();
  if (needle.length < 2) throw new StudioError(400, '내용 찾기는 두 글자 이상으로 합니다');
  const walk = await walkFiles(session.project.root);
  const found = await searchFiles(session.project.root, needle, walk.files);
  return {
    query: needle,
    results: found.results.map(({ file, matches }) => ({
      file,
      matches: matches.map((match) => {
        const text = session.sandbox.redact(match.text);
        if (text === match.text) return match;
        const start = text.toLowerCase().indexOf(needle.toLowerCase());
        return start < 0 ? { ...match, text, start: 0, length: 0 } : { ...match, text, start };
      }),
    })),
    truncated: found.truncated || walk.truncated,
  };
}

/** 코드 화면에서 연 파일. 에이전트 도구 결과처럼 시크릿 값을 가려서 돌려준다 */
export async function readCodeFile(id: string, file: string): Promise<CodeFile> {
  const session = requireSession(id);
  const change = (await session.checkpoints.pendingChanges()).find((candidate) => candidate.file === file)?.change;
  if (change === 'deleted') {
    if (isDeniedPath(file)) throw new StudioError(400, `${file}: 생성물이나 비밀 파일 경로는 볼 수 없습니다`);
    return { path: file, change, patch: session.sandbox.redact(await session.checkpoints.pendingPatch(file)) };
  }
  const content = await new Workspace(session.project.root).read(file);
  const binary = content.includes('\u0000');
  return {
    path: file,
    content: binary ? undefined : session.sandbox.redact(content),
    binary: binary || undefined,
    change,
    patch: change === 'modified' ? session.sandbox.redact(await session.checkpoints.pendingPatch(file)) : undefined,
  };
}

export async function checkpointPatch(id: string, sha: string): Promise<string> {
  const session = requireSession(id);
  if (!session.snapshot.checkpoints.some((checkpoint) => checkpoint.sha === sha)) {
    throw new StudioError(404, '체크포인트를 찾을 수 없습니다');
  }
  return session.checkpoints.patch(sha);
}

// ---------------------------------------------------------------------------
// 명세 → 요구사항 → 검증 추적(ADR-079). "명세" 탭이 쓴다.
// ---------------------------------------------------------------------------

/** docs/requirements.md를 다시 읽을 때, 화면이 요구사항마다 보여 줄 근거·상태·확신 표시·대화창 채우기 글을 합친 모양 */
export interface RequirementView extends Requirement {
  status: RequirementStatus;
  confidence: '🟢' | '🟡' | '🔴';
  evidence: RequirementEvidence;
  /** "이 요구사항 작업" 버튼이 채운다(서버가 만든 글을 그대로 쓴다 — 화면은 조립하지 않는다). 발행된 이슈가 있으면 번호를 함께 안내한다(ADR-092) */
  workPrefill: string;
  /** 이슈로 발행했을 때 생긴 하위 이슈 번호. 발행하지 않았으면 없다 */
  issue?: number;
  /** "검증됨"을 만든 증거의 종류(ADR-103). 검증됨이 아니면 'none' */
  verifiedBy: 'test' | 'docs' | 'manual' | 'none';
}

export interface RequirementsSnapshot {
  /** docs/requirements.md가 세션 작업 복사본에 있는지. 없으면 requirements는 항상 빈 배열이다 */
  exists: boolean;
  requirements: RequirementView[];
  coverage?: RequirementCoverage;
  /** "전체 계획 세우기" 버튼이 채운다. must 요구사항이 하나도 없으면 없다 */
  allMustHavesPrefill?: string;
  /** "## 가정" 절(데이터 규모·동시성/트래픽·성능 관련 제약). docs/requirements.md가 없거나 절이 없으면 빈 배열 */
  assumptions: string[];
  /** "## 사람이 할 일" 절(저장소 권한·협업자 추가, 이메일 제출 등) — 요구사항이 아니다, 에이전트가 절대 하지 않는다 */
  manualSteps: string[];
  /**
   * 마지막 추출 결과가 세션 상태 폴더에 남아 있으면 있다(버그 리포트 A, ADR-097 개정). "추출 결과" 하위 화면이
   * 배너 없이 항상 그대로 보여준다 — 페이지를 새로고침하거나 "뽑는 중"에 개발 서버가 재시작돼도, docs/requirements.md로
   * 저장(apply)한 뒤에도 "지우기"를 직접 누르기 전까지 잃지 않는다.
   */
  draft?: PersistedRequirementsExtractionDraft;
}

const TEST_SCAN_IGNORED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.gradle', '.venv', '__pycache__', 'coverage', 'design']);
/** 테스트 파일 스캔이 너무 오래 걸리지 않게 두는 안전판(대부분의 과제 저장소는 이 안에 다 들어온다) */
const TEST_SCAN_MAX_FILES = 400;
const TEST_SCAN_MAX_FILE_BYTES = 200_000;

/**
 * 세션 작업 복사본에서 테스트로 보이는 파일을 찾아 읽는다(JUnit *.Test.java, Jest/Vitest/Playwright *.test.ts 등).
 * node_modules·생성물 폴더는 건너뛰고, 파일 수·크기에 안전판을 둔다 — 요구사항 탭을 열 때마다 도는 동기 스캔이라
 * 과제 저장소 크기를 벗어나면 값싸게 멈춰야 한다.
 */
async function scanWorkingCopyTestFiles(root: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  async function walk(dir: string): Promise<void> {
    if (files.length >= TEST_SCAN_MAX_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return; // 권한 없음 등은 조용히 건너뛴다 — 증거 하나 놓치는 것이 탭 전체를 실패시키는 것보다 낫다
    }
    for (const entry of entries) {
      if (files.length >= TEST_SCAN_MAX_FILES) return;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || TEST_SCAN_IGNORED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && isLikelyTestFile(entry.name)) {
        const absolute = path.join(dir, entry.name);
        try {
          const stats = await stat(absolute);
          if (stats.size > TEST_SCAN_MAX_FILE_BYTES) continue;
          const content = await readFile(absolute, 'utf8');
          files.push({ path: path.relative(root, absolute).replaceAll(path.sep, '/'), content });
        } catch {
          // 읽는 사이 지워졌거나 이진 파일이면 건너뛴다
        }
      }
    }
  }
  await walk(root);
  return files;
}

/**
 * kind: 'docs' 요구사항의 인수 조건을 맞춰볼 문서(README.md·docs/**\/*.md)를 읽는다(ADR-103). "문서" 탭(ADR-094)이
 * 이미 같은 범위를 다루므로 그 탭의 listDocsDirFiles를 그대로 재사용한다 — 실제 매칭(키워드 추출·제목/문단 비교)은
 * 순수 함수(submission-checklist.ts의 matchAcceptanceAgainstDocs)에 맡기고 여기서는 파일만 모은다.
 */
async function scanWorkingCopyDocSources(root: string): Promise<DocMatchSource[]> {
  const workspace = new Workspace(root);
  const rootFiles = await workspace.list('.', 1).catch(() => [] as string[]);
  const readmeName = rootFiles.find((file) => /^readme\.md$/i.test(file));
  const docsFiles = await listDocsDirFiles(workspace);
  const paths = [...(readmeName ? [readmeName] : []), ...docsFiles];
  const sources = await Promise.all(paths.map(async (docPath) => ({ path: docPath, content: await workspace.read(docPath).catch(() => '') })));
  return sources.filter((source) => source.content.length > 0);
}

/**
 * 추출 모델을 부르는 방법. 도구 없이 한 번만 묻는 호출 경로가 claude-code(로컬 CLI)·api(모델 레지스트리) 두 모드에만 있어
 * (계획·PR 리뷰 호출과 같은 제약) 그 밖의 백엔드에서는 undefined를 돌려준다 — 호출하는 쪽이 결정론적 대체 파서로 넘어간다.
 */
function requirementsAsk(session: Session): ModelAsk | undefined {
  const backend = sessionBackend(session.snapshot);
  if (backend === 'claude-code') return claudeCodeAsk({ cwd: session.project.root });
  if (backend === 'api') return planAskFromClient(clientForModel(routingDecision('요구사항 추출', 'build', session.snapshot.modelId).selected));
  return undefined;
}

/**
 * "모호한 점"에 추천 값을 물을 때만 쓰는 호출. claude-code 백엔드에서는 이 호출 하나만 WebSearch·WebFetch를 연다
 * (`claude-code-ask.ts`의 `webTools`, 파일·명령 도구는 절대 열지 않는다) — 실제 업계 관례 출처를 붙이기 위해서다.
 * api 백엔드는 기존 모델 호출 그대로(도구 없음)라 웹 검색이 없고, 호출하는 쪽이 "출처 확인 필요"로 표시한다.
 */
function requirementsRecommendationAsk(session: Session): { ask: ModelAsk; webSearchAvailable: boolean } | undefined {
  const backend = sessionBackend(session.snapshot);
  if (backend === 'claude-code') return { ask: claudeCodeAsk({ cwd: session.project.root, webTools: true }), webSearchAvailable: true };
  if (backend === 'api') return { ask: planAskFromClient(clientForModel(routingDecision('모호한 점 추천', 'build', session.snapshot.modelId).selected)), webSearchAvailable: false };
  return undefined;
}

/** 이 세션의 원격 저장소에서 이슈 목록을 읽을 수 있게 준비한다(원격·토큰 확인까지). repository-panel.ts와 같은 자료원(listIssues)을
 * 쓰지만, 그 모듈은 sessions.ts를 가져오므로 순환을 피해 직접 부른다. 원격이 없거나 지원하지 않거나 토큰이 없으면 던진다 */
async function remoteIssuesForSession(session: Session): Promise<{ remote: RemoteLocation; token: string; issues: IssueSummary[] }> {
  const info = await session.checkpoints.repository();
  if (!info) throw new StudioError(409, '이 프로젝트는 원격 저장소가 없어 이슈를 가져올 수 없습니다');
  const remote = parseRemote(info.remoteUrl);
  if (remote.kind !== 'github' && remote.kind !== 'gitea') {
    throw new StudioError(400, `${remote.display}는 이슈 가져오기를 지원하지 않습니다(GitHub·Gitea만 지원합니다)`);
  }
  const token = await resolveRepositoryToken(remote.kind, { allowGhCli: localFolderAllowed() });
  if (!token) throw new StudioError(400, '이슈를 가져올 토큰이 없습니다');
  const issues = await listIssues(remote, { state: 'all', token });
  return { remote, token, issues };
}

/** 저장소 이슈 본문을 가져온다("요구사항 뽑기"가 이슈를 명세 글로 쓸 때) */
async function fetchIssueBodyForSession(session: Session, issueNumber: number): Promise<string> {
  const { issues } = await remoteIssuesForSession(session);
  const issue = issues.find((candidate) => candidate.number === issueNumber);
  if (!issue) throw new StudioError(404, `이슈 #${issueNumber}을 찾지 못했습니다(최근 이슈 목록 안에 없습니다)`);
  const body = issue.body?.trim();
  return body ? `${issue.title}\n\n${body}` : issue.title;
}

/**
 * "저장소 이슈"로 요구사항을 뽑을 때, 그 이슈(또는 추적 이슈의 하위 이슈)가 b-studio 관리형 영역을 담고 있으면
 * 모델을 부르지 않고 결정론적으로 요구사항을 되읽는다(ADR-097, dogfooding 발견 C — 추적 이슈의 표를 모델에
 * 그대로 넘기면 모델이 인수 조건을 지어냈다). 관리형 영역이 전혀 없으면 undefined를 돌려줘 호출하는 쪽이
 * 평소대로 모델 추출(또는 결정론적 대체 파서)로 넘어가게 한다.
 */
async function tryImportManagedRequirements(session: Session, issueNumber: number): Promise<Requirement[] | undefined> {
  const { issues } = await remoteIssuesForSession(session);
  const issue = issues.find((candidate) => candidate.number === issueNumber);
  if (!issue) throw new StudioError(404, `이슈 #${issueNumber}을 찾지 못했습니다(최근 이슈 목록 안에 없습니다)`);
  const body = issue.body ?? '';

  const toRequirement = (draft: ReturnType<typeof draftManagedRequirement>): Requirement | undefined => {
    if (!draft) return undefined;
    const parsed = RequirementSchema.safeParse(managedRequirementToRequirement(draft));
    return parsed.success ? parsed.data : undefined;
  };

  // 1) 이슈 자신이 관리형 하위 이슈다
  const own = toRequirement(draftManagedRequirement(issue.title, body));
  if (own) return [own];

  // 2) 추적 이슈다(b-studio:req 라벨 + 하위 이슈 번호 표) — 하위 이슈를 따라가 하나씩 되읽는다
  if (!issue.labels.includes(REQUIREMENT_LABEL)) return undefined;
  const subNumbers = extractTrackingSubIssueNumbers(body);
  if (subNumbers.length === 0) return undefined;
  const byNumber = new Map(issues.map((candidate) => [candidate.number, candidate]));
  const requirements = subNumbers
    .map((number) => byNumber.get(number))
    .filter((candidate): candidate is IssueSummary => candidate !== undefined)
    .map((candidate) => toRequirement(draftManagedRequirement(candidate.title, candidate.body ?? '')))
    .filter((requirement): requirement is Requirement => requirement !== undefined);
  return requirements.length > 0 ? requirements : undefined;
}

/** managed 서비스 템플릿·데이터베이스 엔진을 한 줄로 요약한다("추천 값으로 채우기"가 스택에 맞는 답을 내도록 프롬프트에 붙인다) */
function buildProjectStackSummary(project: LoadedProject): string {
  const services = project.managed.map(([name, service]) => `${name}(${service.template})`).join(', ');
  const databases = project.databases.map(([name, database]) => `${name}(${database.engine})`).join(', ');
  const parts: string[] = [];
  if (services) parts.push(`서비스: ${services}`);
  if (databases) parts.push(`데이터베이스: ${databases}`);
  return parts.join(' · ');
}

export interface RequirementsExtractionInput {
  /** 붙여넣은 명세 글 */
  specText?: string;
  /** 세션 작업 복사본의 파일 경로(예: 과제.md, README.md, docs/spec.md) */
  filePath?: string;
  /** 저장소 이슈 번호. 있으면 이슈 제목·본문을 명세로 쓴다 */
  issueNumber?: number;
  /** "스펙을 고치고 다시 뽑기": 지난 추출의 질문과 답을 스펙 끝에 덧붙여 다시 추출한다(Spec Kit의 /clarify 응답 반영과 같은 자리) */
  answers?: Array<{ question: string; answer: string }>;
}

async function resolveSpecText(session: Session, input: RequirementsExtractionInput): Promise<string> {
  let text: string;
  if (input.specText?.trim()) {
    text = input.specText;
  } else if (input.filePath) {
    text = await new Workspace(session.project.root).read(input.filePath);
  } else if (input.issueNumber !== undefined) {
    text = await fetchIssueBodyForSession(session, input.issueNumber);
  } else {
    throw new StudioError(400, '명세 글, 파일 경로, 이슈 번호 중 하나가 필요합니다');
  }
  if (input.answers && input.answers.length > 0) {
    const answered = input.answers.map((item, index) => `${index + 1}. ${item.question}\n   답: ${item.answer}`).join('\n');
    text = `${text}\n\n---\n[질문 답변]\n${answered}`;
  }
  if (!text.trim()) throw new StudioError(400, '명세 글이 비어 있습니다');
  return text;
}

export interface RequirementsExtractionPreview {
  requirements: Requirement[];
  questions: string[];
  /**
   * 추출 모델을 불러 얻었는지(model), 도구 없는 단발 호출을 지원하지 않는 백엔드거나 모델 호출이 실패해 결정론적
   * 파서로 대신했는지(fallback), b-studio가 이미 발행한 이슈(관리형 영역)를 모델 호출 없이 그대로 되읽었는지(managed —
   * 저장소 이슈 가져오기가 추적 이슈의 표까지 모델에 넘기면 모델이 인수 조건을 지어냈다, 버그 리포트 참고)
   */
  source: 'model' | 'fallback' | 'managed';
  /** source가 fallback·managed일 때만 있다. 화면이 그대로 보여 준다 */
  reason?: string;
  /** 명세가 경로처럼 언급한 파일(seed/seed.json 등)이 작업 복사본에 있는지·크기·미리보기 */
  referencedFiles: ReferencedFile[];
  /** 요구사항으로 만들지 않고 뺀 "범위 밖" 항목(결정론적 대체 파서는 만들지 못한다) */
  outOfScope: string[];
  /** "## 가정" 절 초안(데이터 규모·동시성/트래픽·성능 관련 제약, 결정론적 대체 파서는 만들지 못한다) */
  assumptions: string[];
  /** "사람이 할 일"로 걸러낸 절차(저장소 권한·협업자 추가, 이메일 제출 등) — 요구사항이 아니다, 읽기 전용으로만 보여 준다 */
  manualSteps: string[];
  /** docs/requirements.md가 이미 있어 재추출 병합(제목·EARS 유사도로 기존 id를 지킨다)을 했을 때만 있다. 화면의 "무엇이 바뀌는가" 미리보기가 쓴다 */
  diff?: RequirementDiffEntry[];
}

/** 참조 파일이 없을 때 자동으로 덧붙이는 질문과, 모델이 직접 낸 질문을 합쳐 상한(5개) 안으로 자른다 */
function mergeQuestionsWithMissingReferences(questions: readonly string[], referencedFiles: readonly ReferencedFile[]): string[] {
  const missing = referencedFiles.filter((file) => !file.exists).map((file) => buildMissingReferenceQuestion(file.path));
  const merged: string[] = [];
  for (const question of [...questions, ...missing]) {
    if (merged.length >= MAX_CLARIFYING_QUESTIONS) break;
    if (!merged.includes(question)) merged.push(question);
  }
  return merged;
}

/** 지금 저장된 docs/requirements.md가 있으면 그 요구사항 목록을, 없으면 빈 배열을 읽는다(재추출 병합 기준점) */
async function readSavedRequirements(session: Session): Promise<Requirement[]> {
  const raw = await new Workspace(session.project.root).read(REQUIREMENTS_FILE).catch(() => undefined);
  if (raw === undefined) return [];
  return parseRequirementsMarkdown(raw).requirements;
}

/**
 * 재추출로 막 뽑은 요구사항을 이미 저장된 문서가 있으면 제목·EARS 유사도로 병합해 id를 지킨다(mergeReextractedRequirements).
 * 저장된 문서가 없으면(첫 추출) 병합할 대상이 없으므로 그대로 돌려준다.
 */
async function mergeWithSavedRequirements(session: Session, extracted: readonly Requirement[]): Promise<{ requirements: Requirement[]; diff?: RequirementDiffEntry[] }> {
  const saved = await readSavedRequirements(session);
  if (saved.length === 0) return { requirements: [...extracted] };
  const { merged, diff } = mergeReextractedRequirements(extracted, saved);
  return { requirements: merged, diff };
}

/** "요구사항 뽑기"(모델 추출)의 제한 시간. EARS·시나리오까지 뽑는 호출이라 3~6분씩 걸려, 10분을 넘으면 멈추고 분명한 오류로 알린다 */
const REQUIREMENTS_EXTRACTION_TIMEOUT_MS = 10 * 60_000;
/** "추천 값으로 채우기"의 제한 시간. 추출보다 짧게 끝나야 정상이라 3분으로 둔다 */
const REQUIREMENTS_RECOMMENDATION_TIMEOUT_MS = 3 * 60_000;

const REQUIREMENTS_DRAFT_FILE = path.join('.git', 'b-studio', 'requirements-draft.json');

/**
 * 추출 결과를 세션 상태 폴더에 남긴 모양. `.git/` 아래라 커밋에도, 에이전트 도구에도, 체크포인트로
 * 되돌리기(`git reset --hard`·`git clean -fd`는 `.git/` 안을 건드리지 않는다, ADR-099)에도 걸리지 않는다.
 *
 * ADR-097 개정: 처음에는 "저장(apply)하지 않은 추출 결과"만 담아 apply에 성공하면 지웠다(배너로 "이어서
 * 보기/버리기"만 보여줬다). 이제는 "지우기"를 직접 누르기 전까지 끝까지 보관해, apply한 뒤에도 사람이
 * 답한 질문·추천 값·편집 내용까지 그대로 남긴다(요구사항 탭의 "추출 결과" 하위 화면이 항상 보여준다).
 */
export interface PersistedRequirementsExtractionDraft extends RequirementsExtractionPreview {
  /** 이 추출(또는 재추출)이 완료된 시각. 재추출하면 그 시점으로 갱신되고 answers·recommendations는 비워진다 */
  savedAt: string;
  /** 이 파일에 가장 마지막으로 쓴 시각(재추출·자동 저장·apply 모두 갱신한다) — 상태줄이 "저장한 뒤 바뀜"을 판단하는 기준 */
  updatedAt: string;
  /** docs/requirements.md로 저장(apply)한 시각. 저장한 적이 없으면 없다("아직 저장 안 함") */
  appliedAt?: string;
  /**
   * 이 추출에 쓴 원래 입력(답변은 뺀다 — answers로 따로 관리한다). "스펙을 고치고 다시 뽑기"가 새로고침·서버
   * 재시작 뒤에도 같은 명세로 재추출할 수 있게 한다(ImportFlow가 들고 있던 specText 등 화면 상태에 더는 의존하지 않는다)
   */
  sourceInput?: Pick<RequirementsExtractionInput, 'specText' | 'filePath' | 'issueNumber'>;
  /** "모호한 점" 질문 인덱스(문자열 키) → 사람이 입력한 답. 자동 저장(PATCH)이 채운다 */
  answers?: Record<string, string>;
  /** 질문 인덱스(문자열 키) → "추천 값으로 채우기"가 받은 추천. 자동 저장이 채운다 */
  recommendations?: Record<string, Recommendation>;
  /** recommendations를 받았을 때 그 출처(web=실제 검색, model=모델 지식만) */
  recommendationSource?: 'web' | 'model';
}

function requirementsDraftFile(session: Session): string {
  return path.join(stateDirOf(session.snapshot), REQUIREMENTS_DRAFT_FILE);
}

async function readRequirementExtractionDraftFile(session: Session): Promise<PersistedRequirementsExtractionDraft | undefined> {
  try {
    return JSON.parse(await readFile(requirementsDraftFile(session), 'utf8')) as PersistedRequirementsExtractionDraft;
  } catch {
    return undefined;
  }
}

async function writeRequirementExtractionDraftFile(session: Session, draft: PersistedRequirementsExtractionDraft): Promise<void> {
  const file = requirementsDraftFile(session);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
}

/** finishExtractionPreview가 draft에 함께 남길 원래 입력(답변은 뺀다). 아무것도 없으면 undefined */
function sanitizeDraftSourceInput(input: RequirementsExtractionInput): PersistedRequirementsExtractionDraft['sourceInput'] {
  const { specText, filePath, issueNumber } = input;
  if (specText === undefined && filePath === undefined && issueNumber === undefined) return undefined;
  return { ...(specText !== undefined ? { specText } : {}), ...(filePath !== undefined ? { filePath } : {}), ...(issueNumber !== undefined ? { issueNumber } : {}) };
}

/**
 * 추출 미리보기를 세션 상태 폴더에 남긴다(사이드카 — docs/ 밖이라 git 작업 복사본에도, 커밋에도 안 들어간다).
 * "요구사항 뽑기"가 3~6분 걸리는 동안 개발 서버가 재시작되면 화면은 "뽑는 중"에 멈춰 있어도 서버 쪽 작업은
 * 통째로 사라진다(버그 리포트 A) — 적어도 끝까지 마친 추출 결과는 다시 열었을 때 보이도록 남긴다.
 * 재추출(이 함수를 다시 부르는 것)은 이전 draft를 통째로 대신한다 — answers·recommendations·appliedAt은 새 결과에는
 * 아직 없으므로 비워진다(화면이 재추출 전에 "이전 추출 결과를 새 결과로 바꿉니다"를 확인받는다, ADR-097 개정).
 */
async function saveRequirementExtractionDraft(
  session: Session,
  preview: RequirementsExtractionPreview,
  sourceInput?: PersistedRequirementsExtractionDraft['sourceInput'],
): Promise<void> {
  const now = new Date().toISOString();
  const draft: PersistedRequirementsExtractionDraft = { ...preview, savedAt: now, updatedAt: now, ...(sourceInput ? { sourceInput } : {}) };
  await writeRequirementExtractionDraftFile(session, draft);
}

/** 지금 남아 있는 추출 결과를 돌려준다("추출 결과" 하위 화면이 항상 보여준다). 없으면 undefined */
export async function getSessionRequirementExtractionDraft(id: string): Promise<PersistedRequirementsExtractionDraft | undefined> {
  return readRequirementExtractionDraftFile(requireSession(id));
}

/** 추출 결과를 지운다("지우기" 버튼, 확인을 거친 뒤 호출된다 — 확인 자체는 화면이 맡는다) */
export async function discardSessionRequirementExtractionDraft(id: string): Promise<void> {
  const session = requireSession(id);
  await rm(requirementsDraftFile(session), { force: true });
}

const RequirementExtractionDraftPatchSchema = z.object({
  requirements: z.array(RequirementSchema).max(MAX_REQUIREMENTS).optional(),
  assumptions: z.array(AssumptionSchema).max(MAX_ASSUMPTIONS).optional(),
  manualSteps: z.array(ManualStepItemSchema).max(MAX_MANUAL_STEPS).optional(),
  answers: z.record(z.string(), z.string().max(2_000)).optional(),
  recommendations: z.record(z.string(), RecommendationSchema).optional(),
  recommendationSource: z.enum(['web', 'model']).optional(),
});

/**
 * 추출 결과를 부분적으로 고쳐 쓴다(자동 저장, ADR-097 개정). "추출 결과" 화면에서 요구사항·가정·사람이 할 일을
 * 고치거나, 질문에 답하거나, 추천 값을 받으면 800ms 정지 뒤 이 함수로 자동 저장한다 — 새로고침·서버 재시작 뒤에도
 * 편집 내용을 잃지 않는다. 저장 안 한 추출 결과가 아예 없으면(이미 지웠거나 한 번도 추출한 적 없음) 404.
 */
export async function updateSessionRequirementExtractionDraft(id: string, patch: unknown): Promise<PersistedRequirementsExtractionDraft> {
  const session = requireSession(id);
  const parsed = RequirementExtractionDraftPatchSchema.safeParse(patch);
  if (!parsed.success) throw new StudioError(400, `자동 저장할 내용의 형식이 올바르지 않습니다: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  const current = await readRequirementExtractionDraftFile(session);
  if (!current) throw new StudioError(404, '저장 안 한 추출 결과가 없습니다');
  const next: PersistedRequirementsExtractionDraft = { ...current, ...parsed.data, updatedAt: new Date().toISOString() };
  await writeRequirementExtractionDraftFile(session, next);
  return next;
}

/**
 * docs/requirements.md로 저장(apply)한 내용을 추출 결과에 그대로 반영하고 appliedAt을 남긴다(ADR-097 개정 — apply는
 * 더는 추출 결과를 지우지 않는다). 저장 안 한 추출 결과가 아예 없었다면(드문 경로 — 가져오기 화면을 거치지 않고 다른
 * 자리에서 바로 적용한 경우) 지금 저장한 내용 그대로 새 draft를 만든다, 지어내지 않고 있는 값만 채운다.
 */
async function markRequirementExtractionDraftApplied(
  session: Session,
  applied: { requirements: Requirement[]; assumptions: string[]; manualSteps: string[] },
): Promise<void> {
  const now = new Date().toISOString();
  const current = await readRequirementExtractionDraftFile(session);
  const next: PersistedRequirementsExtractionDraft = current
    ? { ...current, ...applied, appliedAt: now, updatedAt: now }
    : { ...applied, questions: [], source: 'model', referencedFiles: [], outOfScope: [], savedAt: now, updatedAt: now, appliedAt: now };
  await writeRequirementExtractionDraftFile(session, next);
}

/** previewSessionRequirementsExtraction의 모든 반환 경로가 거친다: 완료된 결과를 드래프트로 남기고 그대로 돌려준다 */
async function finishExtractionPreview(
  session: Session,
  preview: RequirementsExtractionPreview,
  sourceInput?: PersistedRequirementsExtractionDraft['sourceInput'],
): Promise<RequirementsExtractionPreview> {
  await saveRequirementExtractionDraft(session, preview, sourceInput).catch((error: unknown) => {
    console.error(`[b-studio] 세션 ${session.snapshot.id}의 요구사항 추출 임시 결과를 남기지 못했습니다`, error);
  });
  return preview;
}

/**
 * 명세 글을 요구사항 미리보기로 바꾼다(아직 파일에 쓰지 않는다 — POST apply가 따로 있다).
 * "저장소 이슈"로 가져올 때는 그 이슈(또는 추적 이슈의 하위 이슈)가 b-studio 관리형 영역을 담고 있으면 모델을
 * 부르지 않고 그대로 되읽는다(ADR-097, 버그 리포트 C — 추적 이슈의 표를 모델에 그대로 넘기면 인수 조건을 지어냈다).
 * 그 밖에는: 명세가 경로처럼 언급한 파일을 먼저 작업 복사본에서 찾아(참조 파일) 존재하는 것은 압축 요약을 추출
 * 모델 문맥에 붙이고(데이터 규모를 지어내지 않고 실제 값으로 "가정"을 쓰게 한다), 없는 것은 질문으로 올린다.
 * 추출 모델을 부를 수 있는 백엔드면 모델에 한 번 묻고, 아니거나 실패하면 결정론적 대체 파서로 넘어가며 이유를 분명히 남긴다
 * (단, 호출하는 쪽이 취소했거나 제한 시간(10분)을 넘겼으면 대체 파서로 넘기지 않고 분명한 오류를 던진다 — 버그 리포트 A).
 * 어느 경로든 "사람이 할 일"(저장소 권한·협업자 추가, 이메일 제출 등)로 보이는 항목은 결정론적 가드로 한 번 더 걸러내고,
 * 이미 저장된 문서가 있으면 제목·EARS 유사도로 병합해 기존 id를 지킨다(재추출해도 같은 요구사항이 같은 id를 유지한다).
 */
export async function previewSessionRequirementsExtraction(
  id: string,
  input: RequirementsExtractionInput,
  options: { signal?: AbortSignal } = {},
): Promise<RequirementsExtractionPreview> {
  const session = requireSession(id);

  if (input.issueNumber !== undefined) {
    const managed = await tryImportManagedRequirements(session, input.issueNumber).catch(() => undefined);
    if (managed) {
      return finishExtractionPreview(session, {
        requirements: managed,
        questions: [],
        source: 'managed',
        reason: `b-studio가 발행한 이슈에서 그대로 가져왔습니다 (${managed.length}개)`,
        referencedFiles: [],
        outOfScope: [],
        assumptions: [],
        manualSteps: [],
      }, { issueNumber: input.issueNumber });
    }
  }

  const specText = await resolveSpecText(session, input);
  const referencedFiles = await resolveReferencedFiles(session.project.root, specText);
  const referencedFilesContext = buildReferencedFilesContext(referencedFiles, REFERENCED_FILES_CONTEXT_MAX_CHARS);
  const backend = sessionBackend(session.snapshot);
  const ask = requirementsAsk(session);
  if (!ask) {
    const { requirements: kept, manualSteps } = partitionManualSteps(extractRequirementsHeuristically(specText));
    const { requirements, diff } = await mergeWithSavedRequirements(session, kept);
    return finishExtractionPreview(session, {
      requirements,
      questions: mergeQuestionsWithMissingReferences([], referencedFiles),
      source: 'fallback',
      reason: `이 세션 백엔드(${backend})는 도구 없이 한 번만 묻는 모델 호출을 지원하지 않아, 헤딩·글머리 기호로 요구사항을 나누는 결정론적 방식으로 대신했습니다`,
      referencedFiles,
      outOfScope: [],
      assumptions: [],
      manualSteps,
      ...(diff ? { diff } : {}),
    }, sanitizeDraftSourceInput(input));
  }
  const timeoutSignal = AbortSignal.timeout(REQUIREMENTS_EXTRACTION_TIMEOUT_MS);
  const signal = AbortSignal.any([session.stop.signal, timeoutSignal, ...(options.signal ? [options.signal] : [])]);
  try {
    const result = await requestRequirementsExtraction(ask, specText, signal, referencedFilesContext);
    const { requirements, diff } = await mergeWithSavedRequirements(session, result.requirements);
    return finishExtractionPreview(session, {
      requirements,
      questions: mergeQuestionsWithMissingReferences(result.questions, referencedFiles),
      source: 'model',
      referencedFiles,
      outOfScope: result.outOfScope,
      assumptions: result.assumptions,
      manualSteps: result.manualSteps,
      ...(diff ? { diff } : {}),
    }, sanitizeDraftSourceInput(input));
  } catch (error) {
    if (options.signal?.aborted) throw new StudioError(400, '요청을 취소했습니다');
    if (timeoutSignal.aborted) {
      throw new StudioError(408, `요구사항 추출이 제한 시간(${Math.round(REQUIREMENTS_EXTRACTION_TIMEOUT_MS / 60_000)}분)을 넘어 자동으로 멈췄습니다. 명세를 줄이거나 다시 시도해 주세요`);
    }
    if (session.stop.signal.aborted) throw new StudioError(409, '세션이 멈춰 요구사항 추출을 이어갈 수 없습니다');
    // 모델 답을 쓸 수 없을 때 헤딩으로 나누는 대체 파서로 몰래 바꾸지 않는다 — 긴 명세에서는 "2. 기술 스택" 같은 목차가
    // 그대로 요구사항이 되어, 사람이 이유 줄을 놓치면 엉뚱한 목록이 저장·발행됐다(대체 파서는 모델이 없는 백엔드에서만 쓴다)
    throw new StudioError(502, `추출 모델의 답을 쓸 수 없었습니다: ${describe(error)} — 다시 시도해 주세요`);
  }
}

export interface RequirementRecommendationsInput {
  questions: string[];
  specText?: string;
}

export interface RequirementRecommendations {
  recommendations: Recommendation[];
  /** 'web'이면 claude-code 백엔드가 이 호출에 한해 WebSearch로 찾은 출처, 'model'이면 도구 없이 모델 지식만으로 답해 "출처 확인 필요" */
  sourced: 'web' | 'model';
}

/**
 * "모호한 점" 질문마다 업계 관례에 근거한 추천 답·근거·출처를 한 번에 받는다. claude-code 백엔드만 이 호출에서
 * WebSearch를 열어 실제 링크를 찾고(그 밖의 도구는 열지 않는다), 그 밖의 백엔드는 모델 지식만으로 답해
 * `sourced: 'model'`로 표시한다(화면이 "출처 확인 필요"로 보여 준다). 추천 호출을 지원하지 않는 백엔드는 오류를 던진다.
 * 명세(또는 참조 파일)가 이미 답을 정해 준 질문은 "스펙 먼저" 원칙으로 명세 원문을 인용해 답하고(basis: 'spec',
 * requestQuestionRecommendations가 서버에서 인용문이 실제로 스펙에 있는지 검증한다), 프로젝트 스택(서비스 템플릿·DB
 * 엔진)을 함께 알려줘 스택과 어긋나는 추천(예: Postgres 프로젝트에 MySQL 제안)을 막는다.
 */
export async function recommendSessionRequirementQuestions(
  id: string,
  input: RequirementRecommendationsInput,
  options: { signal?: AbortSignal } = {},
): Promise<RequirementRecommendations> {
  const session = requireSession(id);
  if (input.questions.length === 0) throw new StudioError(400, '추천을 받을 질문이 없습니다');
  const resolved = requirementsRecommendationAsk(session);
  if (!resolved) throw new StudioError(400, `이 세션 백엔드(${sessionBackend(session.snapshot)})는 추천 답 호출을 지원하지 않습니다`);
  const specText = input.specText?.trim() ?? '';
  const stackSummary = buildProjectStackSummary(session.project);
  const timeoutSignal = AbortSignal.timeout(REQUIREMENTS_RECOMMENDATION_TIMEOUT_MS);
  const signal = AbortSignal.any([session.stop.signal, timeoutSignal, ...(options.signal ? [options.signal] : [])]);
  try {
    const result = await requestQuestionRecommendations(resolved.ask, input.questions, specText, resolved.webSearchAvailable, signal, stackSummary);
    return { recommendations: result.recommendations, sourced: labelRecommendationSource(resolved.webSearchAvailable) };
  } catch (error) {
    if (options.signal?.aborted) throw new StudioError(400, '요청을 취소했습니다');
    if (timeoutSignal.aborted) {
      throw new StudioError(408, `추천 값 찾기가 제한 시간(${Math.round(REQUIREMENTS_RECOMMENDATION_TIMEOUT_MS / 60_000)}분)을 넘어 자동으로 멈췄습니다. 다시 시도해 주세요`);
    }
    if (session.stop.signal.aborted) throw new StudioError(409, '세션이 멈춰 추천 값 찾기를 이어갈 수 없습니다');
    throw error;
  }
}

/**
 * 요구사항 하나의 증거를 모아 상태·확신·대화창 채우기 글까지 합친다. 내용이 드리프트됐거나(hash 불일치) 개정 후 새 증거가 없으면
 * "재확인 필요"로 매긴다. 발행된 이슈 번호가 있으면(ADR-092) 프리필에 안내를 덧붙이고 issue 필드를 채운다.
 * kind: 'docs' 요구사항은 docSources(README.md·docs/**\/*.md)가 있으면 인수 조건을 그 문서와 맞춰 docEvidence를
 * 만든다(ADR-103) — 그 밖의 kind는 문서 매칭을 하지 않는다(테스트·게이트가 있는데 억지로 문서로도 통과시키지 않는다).
 */
function evaluateRequirement(
  requirement: Requirement,
  checkpoints: readonly CheckpointRef[],
  testFiles: readonly ScannedFile[],
  gateChecks: readonly GateCheckResult[],
  issueNumber?: number,
  testRun?: TestRunEvidence,
  docSources?: readonly DocMatchSource[],
): RequirementView {
  const docEvidence: DocEvidence | undefined = requirement.kind === 'docs' && docSources ? matchAcceptanceAgainstDocs(requirement.acceptance, docSources) : undefined;
  const evidence: RequirementEvidence = {
    checkpoints: findCheckpointMentions(checkpoints, requirement.id),
    tests: scanTestFilesForRequirementId(testFiles, requirement.id),
    gateChecks: findGateCheckMentions(gateChecks, requirement.id),
    ...(testRun ? { testRun } : {}),
    ...(docEvidence ? { docEvidence } : {}),
  };
  const status = computeRequirementStatus(evidence, requirement);
  const workPrefill = annotateWithIssue(buildRequirementWorkPrefill(requirement), requirement, issueNumber);
  return {
    ...requirement,
    status,
    confidence: requirementConfidence(status),
    evidence,
    workPrefill,
    verifiedBy: requirementVerificationSource(evidence, requirement),
    ...(issueNumber !== undefined ? { issue: issueNumber } : {}),
  };
}

/** 세션의 지금 체크포인트(HEAD)와 커밋하지 않은 변경 수를 한 번에 모은다. 테스트 탭 실행이 그 체크포인트의 증거인지 비교하는 데 쓴다 */
async function headForTestEvidence(session: Session): Promise<{ head?: { sha: string; shortSha: string }; pendingFilesCount: number }> {
  const checkpoint = session.snapshot.checkpoints[0];
  const pendingFilesCount = (await session.checkpoints.pendingFiles()).length;
  return { head: checkpoint && { sha: checkpoint.sha, shortSha: checkpoint.shortSha }, pendingFilesCount };
}

/**
 * 프리필 글의 "[R4] 제목" 첫머리에 발행된 이슈 번호를 "(#12)"로 붙인다("이 요구사항 작업"·"전체 계획 세우기" 프리필,
 * ADR-092) — 세션이 이 텍스트로 커밋을 남기면 PR 본문의 `Closes #12`로 이어진다. requirements.ts의 공용 프리필
 * 함수는 건드리지 않고(다른 에이전트가 동시에 그 파일을 고치는 중이라 충돌을 줄인다) 결과 문자열만 studio 쪽에서 덧붙인다.
 */
export function annotateWithIssue(prefill: string, requirement: Pick<Requirement, 'id' | 'title'>, issueNumber: number | undefined): string {
  if (issueNumber === undefined) return prefill;
  const bullet = `[${requirement.id}] ${requirement.title}`;
  return prefill.replace(bullet, `${bullet} (#${issueNumber})`);
}

/** 세션의 체크포인트를 requirements.ts의 CheckpointRef 모양(createdAt 포함)으로 옮긴다. 증거 신선도(재확인 필요 해제) 판정에 쓴다 */
function sessionCheckpointRefs(session: Session): CheckpointRef[] {
  return session.snapshot.checkpoints.map((checkpoint) => ({ sha: checkpoint.sha, shortSha: checkpoint.shortSha, message: checkpoint.message, createdAt: checkpoint.createdAt }));
}

interface RequirementEvaluationContext {
  checkpoints: CheckpointRef[];
  testFiles: ScannedFile[];
  gateChecks: GateCheckResult[];
  docSources: DocMatchSource[];
  testServices: TestServiceView[];
  head?: { sha: string; shortSha: string };
  pendingFilesCount: number;
}

/**
 * 요구사항 평가(evaluateRequirement)가 요구사항마다 되풀이해 쓰는 입력(체크포인트·테스트 파일·게이트 결과·문서
 * 소스·테스트 탭 실행 증거)을 한 번만 모은다. getSessionRequirements·applySessionRequirements·사람 확인
 * 저장/취소가 모두 이 자리를 쓴다(저장소 I/O를 세 번 따로 하지 않는다)
 */
async function buildRequirementEvaluationContext(session: Session): Promise<RequirementEvaluationContext> {
  const [testFiles, docSources, testServices, headInfo] = await Promise.all([
    scanWorkingCopyTestFiles(session.project.root),
    scanWorkingCopyDocSources(session.project.root),
    Promise.all(session.project.managed.map(([name]) => buildTestServiceView(session, name))),
    headForTestEvidence(session),
  ]);
  return {
    checkpoints: sessionCheckpointRefs(session),
    testFiles,
    gateChecks: (session.lastGateChecks ?? []).map((check) => ({ name: check.name, ok: check.ok })),
    docSources,
    testServices,
    head: headInfo.head,
    pendingFilesCount: headInfo.pendingFilesCount,
  };
}

function evaluateRequirementWithContext(requirement: Requirement, context: RequirementEvaluationContext, issueNumber?: number): RequirementView {
  return evaluateRequirement(
    requirement,
    context.checkpoints,
    context.testFiles,
    context.gateChecks,
    issueNumber,
    buildRequirementTestRunEvidence(context.testServices, requirement.id, context.head, context.pendingFilesCount),
    context.docSources,
  );
}

/** 세션의 docs/requirements.md를 읽어 체크포인트·테스트 파일·게이트 결과·문서에서 증거를 모으고 상태를 매긴다. "명세" 탭이 연다 */
export async function getSessionRequirements(id: string): Promise<RequirementsSnapshot> {
  const session = requireSession(id);
  const draft = await getSessionRequirementExtractionDraft(id);
  const raw = await new Workspace(session.project.root).read(REQUIREMENTS_FILE).catch(() => undefined);
  if (raw === undefined) return { exists: false, requirements: [], assumptions: [], manualSteps: [], ...(draft ? { draft } : {}) };
  const { requirements, assumptions, manualSteps } = parseRequirementsMarkdown(raw);
  if (requirements.length === 0) return { exists: true, requirements: [], assumptions, manualSteps, ...(draft ? { draft } : {}) };

  // 사이드카 파일만 읽는다(원격·토큰 없이도 동작한다) — 발행한 적이 없으면 빈 채로 빠르게 끝난다
  const [issueNumbers, context] = await Promise.all([
    publishedIssueNumbers(session.project.root, requirements.map((requirement) => requirement.id)).catch(() => ({}) as Record<string, number>),
    buildRequirementEvaluationContext(session),
  ]);

  const views = requirements.map((requirement) => evaluateRequirementWithContext(requirement, context, issueNumbers[requirement.id]));
  const statusById = Object.fromEntries(views.map((view) => [view.id, view.status]));
  const mustHaves = requirements.filter((requirement) => requirement.priority === 'must');
  return {
    exists: true,
    requirements: views,
    coverage: summarizeCoverage(requirements, statusById),
    ...(mustHaves.length > 0 ? { allMustHavesPrefill: annotateAllMustHavesPrefill(buildAllMustHavesPrefill(requirements), requirements, issueNumbers) } : {}),
    assumptions,
    manualSteps,
    ...(draft ? { draft } : {}),
  };
}

/** buildAllMustHavesPrefill의 "- [R4] 제목" 줄마다 발행된 이슈 번호가 있으면 "(#12)"를 붙인다(annotateWithIssue와 같은 이유) */
export function annotateAllMustHavesPrefill(prefill: string, requirements: readonly Requirement[], issueNumbers: Readonly<Record<string, number>>): string {
  let text = prefill;
  for (const requirement of requirements) {
    const issue = issueNumbers[requirement.id];
    if (issue === undefined) continue;
    text = annotateWithIssue(text, requirement, issue);
  }
  return text;
}

const ApplyRequirementSchema = RequirementSchema;
const ApplyRequirementsSchema = z.object({
  requirements: z.array(ApplyRequirementSchema).min(1).max(MAX_REQUIREMENTS),
  assumptions: z.array(AssumptionSchema).max(MAX_ASSUMPTIONS).default([]),
  manualSteps: z.array(ManualStepItemSchema).max(MAX_MANUAL_STEPS).default([]),
});

/**
 * 요구사항(+가정+사람이 할 일)을 docs/requirements.md로 저장한다(세션 작업 복사본 — 다음 체크포인트·PR에 그대로 실린다).
 * 저장 전에 이미 저장돼 있던 값을 id로 찾아 개정 관련 필드(rev·hash·revisedAt)를 물려받고(carryForwardRequirementRevision),
 * 내용 해시가 달라졌으면 개정을 올린다(reviseRequirementIfChanged) — 클라이언트가 이 필드들을 안 보내도(대개 그렇다)
 * 서버가 기준점을 잃지 않는다. "사람이 할 일"로 보이는 요구사항은 결정론적 가드로 한 번 더 걸러 manualSteps로 옮긴다
 * (화면이 걸러 보내지 않았어도 파일에 요구사항으로 남지 않는다). 저장 시점의 증거로 상태를 다시 매겨 사람이 읽는 상태
 * 줄에 스냅샷으로 남긴다(다시 열 때는 항상 증거로 새로 계산한다).
 */
/** 저장 요청의 요구사항마다 시나리오 id 앞부분을 요구사항 id에 맞춘다. 모양이 다르면(검증이 거를 값) 그대로 둔다 */
function alignScenarioIdsInInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || !Array.isArray((input as { requirements?: unknown }).requirements)) return input;
  const requirements = (input as { requirements: unknown[] }).requirements.map((requirement) => {
    if (!requirement || typeof requirement !== 'object') return requirement;
    const candidate = requirement as { id?: unknown; scenarios?: unknown };
    if (typeof candidate.id !== 'string' || !Array.isArray(candidate.scenarios)) return requirement;
    if (!candidate.scenarios.every((scenario) => scenario && typeof scenario === 'object' && typeof (scenario as { id?: unknown }).id === 'string')) return requirement;
    return alignScenarioIds(candidate as { id: string; scenarios: Array<{ id: string }> });
  });
  return { ...(input as object), requirements };
}

export async function applySessionRequirements(id: string, input: unknown): Promise<RequirementsSnapshot> {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 저장할 수 있습니다');
  // 화면이 보낸 시나리오 id가 요구사항 id와 어긋나면(재추출 병합이 요구사항 id만 바꾼 경우) 검증 전에 맞춘다
  const parsed = ApplyRequirementsSchema.safeParse(alignScenarioIdsInInput(input));
  if (!parsed.success) throw new StudioError(400, `요구사항 형식이 올바르지 않습니다: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  const ids = parsed.data.requirements.map((requirement) => requirement.id);
  if (new Set(ids).size !== ids.length) throw new StudioError(400, '요구사항 id가 중복됩니다');

  const savedById = new Map((await readSavedRequirements(session)).map((requirement) => [requirement.id, requirement]));
  const now = new Date().toISOString();
  const { requirements: guarded, manualSteps: guardedManualSteps } = partitionManualSteps(parsed.data.requirements, parsed.data.manualSteps);
  // 이 id로 docs/requirements.md에 저장된 적이 한 번도 없으면(savedById에 없다), 들어온 값이 들고 있는
  // rev·hash·revisedAt은 이 파일의 이전 상태가 아니다(다른 세션의 추출 결과 사이드카를 이어받았을 수 있다) —
  // carryForwardRequirementRevision에 넘기기 전에 버려서 진짜 첫 저장(개정 1, revisedAt 없음)으로 본다
  const revisedRequirements = guarded.map((requirement) => {
    const previouslySaved = savedById.get(requirement.id);
    return reviseRequirementIfChanged(carryForwardRequirementRevision(discardRevisionIfNeverSaved(requirement, previouslySaved), previouslySaved), now);
  });

  const context = await buildRequirementEvaluationContext(session);
  const statusById = Object.fromEntries(revisedRequirements.map((requirement) => [requirement.id, evaluateRequirementWithContext(requirement, context).status]));

  const markdown = serializeRequirementsMarkdown(revisedRequirements, statusById, parsed.data.assumptions, guardedManualSteps);
  await new Workspace(session.project.root).write(REQUIREMENTS_FILE, markdown);
  // 작업 복사본에만 쓰고 끝나면 "나눠서 병렬로 하기"가 프로젝트 원본에서 레인을 시작할 때 이 저장이 통째로 사라진다
  // (docs/가 git status에 커밋 안 된 채로 남는다). 검증 게이트 없이 바로 체크포인트로 남겨 다음 체크포인트·분해·PR에
  // 그대로 실리게 한다. 실패해도(시크릿 오탐 등) 저장 자체는 이미 끝났으므로 화면에는 알리지 않고 로그만 남긴다
  await commitWorkingCopyDocs(id, [REQUIREMENTS_FILE], `docs: 요구사항을 정리한다${requirementRangeLabel(revisedRequirements.map((requirement) => requirement.id))}`).catch(
    (error: unknown) => {
      console.error(`[b-studio] 세션 ${id}의 요구사항 문서 체크포인트를 남기지 못했습니다`, error);
    },
  );
  // 저장했다고 추출 결과를 지우지 않는다(ADR-097 개정) — appliedAt만 남겨 "추출 결과" 화면이 계속 보여준다.
  // 실패해도 docs/requirements.md 저장 자체는 이미 끝났으므로 화면에는 알리지 않고 로그만 남긴다
  await markRequirementExtractionDraftApplied(session, { requirements: revisedRequirements, assumptions: parsed.data.assumptions, manualSteps: guardedManualSteps }).catch(
    (error: unknown) => {
      console.error(`[b-studio] 세션 ${id}의 요구사항 추출 결과에 저장 시각을 남기지 못했습니다`, error);
    },
  );
  return getSessionRequirements(id);
}

const MANUAL_VERIFICATION_NOTE_MAX = 500;

/** 요구사항 목록을 다시 저장하고 문서 체크포인트를 남긴다(사람 확인 남기기·취소가 공유하는 마무리 단계) */
async function writeAndCommitRequirements(
  id: string,
  session: Session,
  requirements: readonly Requirement[],
  assumptions: readonly string[],
  manualSteps: readonly string[],
  commitMessage: string,
): Promise<void> {
  const context = await buildRequirementEvaluationContext(session);
  const statusById = Object.fromEntries(requirements.map((requirement) => [requirement.id, evaluateRequirementWithContext(requirement, context).status]));
  const markdown = serializeRequirementsMarkdown(requirements, statusById, assumptions, manualSteps);
  await new Workspace(session.project.root).write(REQUIREMENTS_FILE, markdown);
  await commitWorkingCopyDocs(id, [REQUIREMENTS_FILE], commitMessage).catch((error: unknown) => {
    console.error(`[b-studio] 세션 ${id}의 요구사항 문서 체크포인트를 남기지 못했습니다`, error);
  });
}

/**
 * 사람이 "직접 확인함"을 누른다(owner/admin만, 라우트의 authorizeSession이 막는다, ADR-103). 테스트·게이트가 돌지
 * 않는 요구사항(문서, 디자인과 눈으로 맞춰 봐야 하는 UI, could 우선순위 항목 등)도 사람이 직접 보고 확인했다는
 * 사실을 "누가·언제·어느 체크포인트·무엇을 어떻게"로 docs/requirements.md에 남긴다(저장소에 같이 커밋돼 PR에도
 * 실린다). 지금 체크포인트(HEAD)가 없으면 가리킬 시점이 없으므로 받지 않는다. 실패한 테스트·게이트는 이 기록으로
 * 절대 뒤집지 않는다 — computeRequirementStatus가 게이트·테스트 탭 실행을 항상 먼저 본다.
 */
export async function markRequirementManualVerification(id: string, requirementId: string, input: { note: string }, by: string): Promise<RequirementsSnapshot> {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 확인할 수 있습니다');
  const note = input.note?.trim() ?? '';
  if (!note) throw new StudioError(400, '무엇을 어떻게 확인했는지 메모를 적어야 합니다');
  if (note.length > MANUAL_VERIFICATION_NOTE_MAX) throw new StudioError(400, `메모는 ${MANUAL_VERIFICATION_NOTE_MAX}자 이내로 적어 주세요`);
  const checkpoint = session.snapshot.checkpoints[0];
  if (!checkpoint) throw new StudioError(409, '체크포인트가 하나도 없어 확인한 시점을 남길 수 없습니다 — 먼저 체크포인트를 만들어 주세요');

  const raw = await new Workspace(session.project.root).read(REQUIREMENTS_FILE).catch(() => undefined);
  if (raw === undefined) throw new StudioError(404, 'docs/requirements.md가 없습니다');
  const { requirements, assumptions, manualSteps } = parseRequirementsMarkdown(raw);
  if (!requirements.some((requirement) => requirement.id === requirementId)) throw new StudioError(404, '요구사항을 찾을 수 없습니다');

  const manualVerification: ManualVerification = { by, at: new Date().toISOString().slice(0, 10), sha: checkpoint.shortSha, note };
  const updated = requirements.map((requirement) => (requirement.id === requirementId ? { ...requirement, manualVerification } : requirement));
  await writeAndCommitRequirements(id, session, updated, assumptions, manualSteps, `docs: ${requirementId} 사람 확인을 남긴다`);
  return getSessionRequirements(id);
}

/** "확인 취소" — manualVerification을 지운다. 이미 없으면(두 번 눌렀거나 다른 사람이 먼저 지웠으면) 그냥 지금 상태를 돌려준다 */
export async function clearRequirementManualVerification(id: string, requirementId: string): Promise<RequirementsSnapshot> {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 확인을 취소할 수 있습니다');
  const raw = await new Workspace(session.project.root).read(REQUIREMENTS_FILE).catch(() => undefined);
  if (raw === undefined) throw new StudioError(404, 'docs/requirements.md가 없습니다');
  const { requirements, assumptions, manualSteps } = parseRequirementsMarkdown(raw);
  const target = requirements.find((requirement) => requirement.id === requirementId);
  if (!target) throw new StudioError(404, '요구사항을 찾을 수 없습니다');
  if (!target.manualVerification) return getSessionRequirements(id);

  const updated = requirements.map((requirement) => (requirement.id === requirementId ? { ...requirement, manualVerification: undefined } : requirement));
  await writeAndCommitRequirements(id, session, updated, assumptions, manualSteps, `docs: ${requirementId} 사람 확인을 취소한다`);
  return getSessionRequirements(id);
}

/**
 * 추적 매트릭스(ADR-090, 요구사항 행의 증거는 ADR-106): 요구사항·시나리오 행마다 개정·우선순위·이슈·커밋·테스트·게이트·
 * 검증 출처·상태를 모으고, 역방향 목록(주인 없는 테스트, 테스트 없는 필수 요구사항)을 함께 돌려준다. "요구사항" 탭의
 * 추적 매트릭스 하위 화면이 연다. 요구사항 행의 증거·상태는 "명세" 탭 목록과 똑같은 평가 맥락(buildRequirementEvaluationContext
 * · evaluateRequirementWithContext)으로 계산한다 — 그래야 테스트 탭 실행·문서 확인·사람 확인까지 목록과 완전히 같은
 * 값으로 반영된다(매트릭스가 체크포인트·테스트 파일 이름·게이트만 보고 따로 계산해 목록과 다른 상태를 보여주던 문제).
 */
export async function getSessionRequirementsMatrix(id: string): Promise<TraceabilityMatrix> {
  const session = requireSession(id);
  const requirements = await readSavedRequirements(session);
  const context = await buildRequirementEvaluationContext(session);
  const evaluationByRequirementId: Record<string, RequirementEvaluation> = {};
  for (const requirement of requirements) {
    const view = evaluateRequirementWithContext(requirement, context);
    evaluationByRequirementId[requirement.id] = { status: view.status, evidence: view.evidence, verifiedBy: view.verifiedBy };
  }
  const testRunRows = buildMatrixTestRunRows(context.testServices, context.head, context.pendingFilesCount);
  return buildTraceabilityMatrix({
    requirements,
    checkpoints: context.checkpoints,
    testFiles: context.testFiles,
    gateChecks: context.gateChecks,
    evaluationByRequirementId,
    testRunRows,
  });
}

/** 추적 매트릭스를 CSV로 내려받는다("CSV로 내보내기" 버튼) */
export async function getSessionRequirementsMatrixCsv(id: string): Promise<string> {
  return buildMatrixCsv(await getSessionRequirementsMatrix(id));
}

// ---------------------------------------------------------------------------
// "문서" 탭(ADR-094): 세션 작업 복사본의 docs/**/*.md·README.md·CHANGELOG.md·CONTRIBUTING.md를 보여 주고,
// 그 자리에서 고쳐 쓰거나(저장 즉시 작업 복사본에 반영 — 다음 체크포인트·PR에 그대로 실린다) 템플릿으로 새 문서를
// 만든다. "색인 갱신"은 docs/README.md의 관리 구간(DOCS_INDEX_START~END)만 다시 만들고, 그 밖의 손으로 쓴 글은
// 그대로 둔다(packages/agent/src/docs.ts가 템플릿·색인을 만드는 순수 함수를 맡고, 여기는 파일 IO만 한다).
// ---------------------------------------------------------------------------

/** 문서로 보는 세션 작업 복사본 루트의 파일 이름(docs/ 밖에서는 이 세 개만) */
const ROOT_DOC_NAMES = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md'];

export interface DocEntry {
  path: string;
  title: string;
}

export interface DocsTree {
  docs: DocEntry[];
}

/** 세션의 docs 디렉터리가 아직 없으면(새 프로젝트) 빈 배열로 본다 */
async function listDocsDirFiles(workspace: Workspace): Promise<string[]> {
  try {
    return (await workspace.list('docs', 10)).filter((entry) => !entry.endsWith('/') && entry.endsWith('.md'));
  } catch {
    return [];
  }
}

/**
 * 문서 경로가 이 탭이 다루는 범위 안인지(docs/**\/*.md 또는 루트의 세 파일). 그 밖은 코드 탭이 다룬다.
 * 문서 체크포인트의 isDocPath(사이드카 JSON 등 docs/** 전부)보다 좁다
 */
function isDocsTabPath(file: string): boolean {
  if (ROOT_DOC_NAMES.includes(file)) return true;
  return /^docs\/.+\.md$/.test(file);
}

/** "문서" 탭의 파일 목록. 각 파일의 첫 H1을 제목으로 보여 준다(없으면 파일 이름) */
export async function listSessionDocs(id: string): Promise<DocsTree> {
  const session = requireSession(id);
  const workspace = new Workspace(session.project.root);
  const rootFiles = await workspace.list('.', 1);
  const rootDocs = ROOT_DOC_NAMES.filter((name) => rootFiles.includes(name));
  const docsDirFiles = await listDocsDirFiles(workspace);
  const paths = [...rootDocs, ...docsDirFiles].sort();
  const docs = await Promise.all(
    paths.map(async (docPath) => {
      const content = await workspace.read(docPath).catch(() => '');
      return { path: docPath, title: buildDocSummary(docPath, content).title };
    }),
  );
  return { docs };
}

/** 문서 하나의 내용. 경로는 이 탭이 다루는 범위(docs/**\/*.md·루트 세 파일) 안이어야 한다 */
export async function readSessionDoc(id: string, file: string): Promise<{ path: string; content: string }> {
  const session = requireSession(id);
  if (!isDocsTabPath(file)) throw new StudioError(400, `${file}: 문서 탭은 docs/ 아래 마크다운과 README.md·CHANGELOG.md·CONTRIBUTING.md만 다룹니다`);
  const content = await new Workspace(session.project.root).read(file).catch(() => {
    throw new StudioError(404, '문서를 찾을 수 없습니다');
  });
  return { path: file, content };
}

/** 문서를 고쳐 쓴다(작업 복사본에 바로 반영 — 다음 체크포인트·PR에 그대로 실린다). 새 문서는 "새 문서"로 만든다 */
export async function writeSessionDoc(id: string, file: string, content: string): Promise<{ path: string; content: string }> {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 저장할 수 있습니다');
  if (!isDocsTabPath(file)) throw new StudioError(400, `${file}: 문서 탭은 docs/ 아래 마크다운과 README.md·CHANGELOG.md·CONTRIBUTING.md만 다룹니다`);
  await new Workspace(session.project.root).write(file, content);
  await commitDocTabChange(id, file, `docs: ${file} 내용을 고친다`);
  return { path: file, content };
}

/**
 * 문서 탭의 저장·새 문서·색인 갱신을 곧바로 문서 체크포인트로 남긴다(ADR-096). 커밋하지 않으면 작업 분해 레인이
 * 이 문서를 물려받지 못하고 PR에도 늦게 실린다. 실패해도(비밀 값 감지 등) 저장 자체는 되돌리지 않고 알림만 남긴다
 */
async function commitDocTabChange(id: string, file: string, message: string): Promise<void> {
  await commitWorkingCopyDocs(id, [file], message).catch((error: unknown) => {
    console.error(`[docs] ${file} 문서 체크포인트를 남기지 못했습니다: ${describe(error)}`);
  });
}

export type NewDocKind = 'design' | 'adr' | 'troubleshooting' | 'roadmap' | 'verification' | 'experiment' | 'roadmap-plan';

export interface NewDocInput {
  kind: NewDocKind;
  title: string;
  /** 템플릿 본문 대신 쓸 내용("문서로 저장"이 대화 메시지 내용을 싣는다). 설계 문서·ADR에서만 쓴다 */
  body?: string;
}

/** "새 문서" 버튼: 템플릿으로 다음 번호의 설계 문서·ADR을 만들거나, 트러블슈팅·로드맵 항목을 이어 붙인다 */
export async function createSessionDoc(id: string, input: NewDocInput): Promise<{ path: string; content: string }> {
  const created = await createSessionDocFile(id, input);
  await commitDocTabChange(id, created.path, `docs: ${input.title.trim()} 문서를 더한다`);
  return created;
}

async function createSessionDocFile(id: string, input: NewDocInput): Promise<{ path: string; content: string }> {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 만들 수 있습니다');
  const title = input.title.trim();
  if (!title) throw new StudioError(400, '제목이 필요합니다');
  const workspace = new Workspace(session.project.root);

  if (input.kind === 'design') {
    const existing = await listDocsDirFiles(workspace);
    const path = designDocFilePath(nextDesignDocNumber(existing), title);
    const content = input.body?.trim() || buildDesignDocTemplate(nextDesignDocNumber(existing), title);
    await workspace.write(path, content);
    return { path, content };
  }
  if (input.kind === 'adr') {
    const existing = await listDocsDirFiles(workspace);
    const number = nextAdrNumber(existing);
    const path = adrFilePath(number, title);
    const content = input.body?.trim() || buildAdrTemplate(number, title);
    await workspace.write(path, content);
    return { path, content };
  }
  if (input.kind === 'troubleshooting') {
    const existing = await workspace.read(TROUBLESHOOTING_LOG_PATH).catch(() => undefined);
    const entry = input.body?.trim() || buildTroubleshootingEntry(title);
    const content = appendTroubleshootingEntry(existing, entry);
    await workspace.write(TROUBLESHOOTING_LOG_PATH, content);
    return { path: TROUBLESHOOTING_LOG_PATH, content };
  }
  if (input.kind === 'roadmap') {
    const existing = await workspace.read(ROADMAP_TRADEOFFS_PATH).catch(() => undefined);
    const entry = input.body?.trim() || buildRoadmapTradeoffEntry(title);
    const content = appendRoadmapTradeoffEntry(existing, entry);
    await workspace.write(ROADMAP_TRADEOFFS_PATH, content);
    return { path: ROADMAP_TRADEOFFS_PATH, content };
  }
  if (input.kind === 'verification') {
    const existing = await workspace.read(VERIFICATION_LOG_PATH).catch(() => undefined);
    const entry = input.body?.trim() || buildVerificationEntry(title);
    const content = appendVerificationEntry(existing, entry);
    await workspace.write(VERIFICATION_LOG_PATH, content);
    return { path: VERIFICATION_LOG_PATH, content };
  }
  if (input.kind === 'experiment') {
    const existing = await workspace.read(EXPERIMENT_LOG_PATH).catch(() => undefined);
    const entry = input.body?.trim() || buildExperimentEntry(title);
    const content = appendExperimentEntry(existing, entry);
    await workspace.write(EXPERIMENT_LOG_PATH, content);
    return { path: EXPERIMENT_LOG_PATH, content };
  }
  // 'roadmap-plan': docs/ROADMAP.md 자체는 이미 있으면 손대지 않는다(단계·마일스톤처럼 손으로 쓴 글이 있을 수 있다) — 없을 때만 템플릿으로 만든다
  const existingRoadmap = await workspace.read(ROADMAP_PATH).catch(() => undefined);
  if (existingRoadmap !== undefined) return { path: ROADMAP_PATH, content: existingRoadmap };
  const content = input.body?.trim() || buildRoadmapTemplate();
  await workspace.write(ROADMAP_PATH, content);
  return { path: ROADMAP_PATH, content };
}

/** "색인 갱신": docs/README.md의 관리 구간만 다시 만든다(문서마다 첫 H1·첫 문단을 읽어 표를 채운다) */
export async function regenerateSessionDocsIndex(id: string): Promise<{ path: string; content: string }> {
  const regenerated = await regenerateSessionDocsIndexFile(id);
  await commitDocTabChange(id, regenerated.path, 'docs: 문서 색인을 갱신한다');
  return regenerated;
}

async function regenerateSessionDocsIndexFile(id: string): Promise<{ path: string; content: string }> {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 갱신할 수 있습니다');
  const workspace = new Workspace(session.project.root);
  // 색인 표 자신(docs/README.md)은 표에 넣지 않는다
  const docsDirFiles = (await listDocsDirFiles(workspace)).filter((docPath) => docPath !== DOCS_README_PATH);
  const summaries: DocSummary[] = await Promise.all(
    docsDirFiles.map(async (docPath) => buildDocSummary(docPath, await workspace.read(docPath).catch(() => ''))),
  );
  const existingReadme = await workspace.read(DOCS_README_PATH).catch(() => undefined);
  const content = regenerateDocsReadme(existingReadme, summaries);
  await workspace.write(DOCS_README_PATH, content);
  return { path: DOCS_README_PATH, content };
}

/**
 * "ROADMAP 갱신": `docs/ROADMAP.md`의 "진행 현황" 구간만 저장된 요구사항 상태(상태별 개수, 필수(must)·권장(should)
 * 진행도)로 다시 만든다 — 단계(POC/MVP/Beta/v1)·마일스톤·현재 위치처럼 손으로 쓴 글은 그대로 둔다(색인 갱신과 같은
 * 관리되는 구간 방식, ADR-098). 요구사항이 저장돼 있지 않아도 실패하지 않고 "집계할 수 없다"는 안내로 채운다.
 */
export async function regenerateSessionRoadmap(id: string): Promise<{ path: string; content: string }> {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 갱신할 수 있습니다');
  const snapshot = await getSessionRequirements(id);
  const byStatus: Record<string, number> = {};
  for (const requirement of snapshot.requirements) byStatus[requirement.status] = (byStatus[requirement.status] ?? 0) + 1;
  const mustHaves = snapshot.requirements.filter((requirement) => requirement.priority === 'must');
  const shouldHaves = snapshot.requirements.filter((requirement) => requirement.priority === 'should');
  const summary = {
    byStatus,
    must: { total: mustHaves.length, done: mustHaves.filter((requirement) => requirement.status === '검증됨').length },
    should: { total: shouldHaves.length, done: shouldHaves.filter((requirement) => requirement.status === '검증됨').length },
  };
  const workspace = new Workspace(session.project.root);
  const existing = await workspace.read(ROADMAP_PATH).catch(() => undefined);
  const content = regenerateRoadmapStatus(existing, summary);
  await workspace.write(ROADMAP_PATH, content);
  await commitDocTabChange(id, ROADMAP_PATH, 'docs: 로드맵 진행 현황을 갱신한다');
  return { path: ROADMAP_PATH, content };
}

/**
 * "문서" 탭의 모호한 표현 린트와 "올리기" 미리보기의 "모호한 표현" 경고가 함께 쓴다(ADR-098) — 세션별 계정 확인만
 * 하고 나머지는 packages/agent의 순수 함수(lintText)에 그대로 맡긴다. 세션을 몰라도 되는 계산이지만, 그 밖의
 * 문서 탭 API와 같은 인가 경계를 쓰려고 세션 id를 받는다.
 */
export function lintSessionDocText(id: string, text: string): DocLintFinding[] {
  requireSession(id);
  return lintText(text);
}

// ---------------------------------------------------------------------------
// "현황" 탭(ADR-098): 세션·요구사항·체크포인트를 다시 재지 않고 있는 그대로 재배열한다(읽기 전용 집계).
// 실제 모양 맞추기는 packages/agent의 순수 함수(buildProjectStatus)가 하고, 여기서는 세션이 들고 있는 조각들을
// 그 함수가 받는 모양으로 모으기만 한다.
// ---------------------------------------------------------------------------

/** 세션 기록에서 마지막으로 시작한 요청 글(관제 화면의 overviewSessions와 같은 방식 — run_started를 뒤에서 찾는다) */
function lastRunStartedRequest(history: readonly StudioEvent[]): string | undefined {
  const started = history.findLast((event) => event.type === 'run_started');
  return started?.type === 'run_started' ? started.request : undefined;
}

export async function getSessionStatus(id: string): Promise<ProjectStatusView> {
  const session = requireSession(id);
  const snapshot = session.snapshot;
  const requirementsSnapshot = await getSessionRequirements(id).catch(() => ({ exists: false, requirements: [], assumptions: [], manualSteps: [] }) as RequirementsSnapshot);

  const input: ProjectStatusInput = {
    projectName: snapshot.projectName,
    running: snapshot.running,
    currentRequestSummary: snapshot.running ? lastRunStartedRequest(session.history) : undefined,
    requirements: requirementsSnapshot.requirements.map((requirement) => ({
      id: requirement.id,
      title: requirement.title,
      priority: requirement.priority,
      status: requirement.status,
      ...(requirement.issue !== undefined ? { issue: requirement.issue } : {}),
    })),
    openQuestion: snapshot.pendingQuestion?.question,
    manualSteps: requirementsSnapshot.manualSteps,
    checkpoints: snapshot.checkpoints.slice(0, 5).map((checkpoint) => ({ shortSha: checkpoint.shortSha, message: checkpoint.message, createdAt: checkpoint.createdAt })),
    pullRequestUrl: snapshot.repository?.pullRequestUrl,
    reviewState: snapshot.review ? { state: snapshot.review.state, rounds: snapshot.review.rounds.length } : undefined,
    failedServices: snapshot.services.filter((service) => service.state === 'failed').map((service) => service.name),
    // 작업 분해 계획에 작업별 예상 시간 입력이 아직 없다 — 지어내지 않고 생략한다(buildProjectStatus가 "추정 없음"으로 보여준다)
    links: { roadmap: ROADMAP_PATH, changelog: 'CHANGELOG.md', docsIndex: DOCS_README_PATH },
  };
  return buildProjectStatus(input);
}

// ---------------------------------------------------------------------------
// 요구사항 → GitHub 이슈 발행·동기화(ADR-092). 순수 계산은 requirement-issues.ts(agent 패키지)가,
// 원격 읽기/쓰기·발행 기록은 apps/studio/lib/server/requirement-issues.ts(orchestrator)가 맡는다.
// 이 절은 세션 상태(작업 복사본·원격·토큰)를 그 orchestrator가 받는 모양으로 조립하기만 한다.
// ---------------------------------------------------------------------------

/** 발행·동기화에 쓸 원격·토큰을 찾는다. 원격이 없거나 지원하지 않는 호스트거나 토큰이 없으면 undefined(조용히 건너뛴다) */
async function requirementIssuesContext(session: Session): Promise<RequirementIssuesContext | undefined> {
  const info = await session.checkpoints.repository();
  if (!info) return undefined;
  const remote = parseRemote(info.remoteUrl);
  if (remote.kind !== 'github' && remote.kind !== 'gitea') return undefined;
  const token = await resolveRepositoryToken(remote.kind, { allowGhCli: localFolderAllowed() });
  if (!token) return undefined;
  return { root: session.project.root, remote, token, projectName: session.project.spec.name };
}

function requireRequirementIssuesContext(context: RequirementIssuesContext | undefined): RequirementIssuesContext {
  if (!context) throw new StudioError(409, '원격 저장소가 없거나, 지원하지 않는 호스트이거나(GitHub·Gitea만 지원합니다), 토큰이 없어 이슈로 발행할 수 없습니다');
  return context;
}

/**
 * 발행에 쓸 요구사항 전체(ears·scenarios·nfr·rev·hash·trace까지)와 상태를 모은다. 전에는 snapshot.requirements의
 * id·title·kind·priority·acceptance만 추려 써서(평가용 view 모양) EARS·시나리오·NFR이 몸통에 전혀 안 실렸다
 * (B 버그 — 이슈 본문이 항상 "(정의되지 않음)"/"(없음)"으로 찍혔다). 같은 docs/requirements.md를 다시 읽어
 * (readSavedRequirements) 전체 필드를 들고, 상태만 snapshot의 평가 결과에서 가져온다.
 */
async function requirementsForIssues(id: string): Promise<{ requirements: Requirement[]; statusById: Record<string, RequirementStatus> }> {
  const session = requireSession(id);
  const snapshot = await getSessionRequirements(id);
  if (!snapshot.exists || snapshot.requirements.length === 0) throw new StudioError(400, '저장된 요구사항이 없습니다. 먼저 "명세" 탭에서 요구사항을 저장하세요');
  const requirements = await readSavedRequirements(session);
  const statusById = Object.fromEntries(snapshot.requirements.map((requirement) => [requirement.id, requirement.status]));
  return { requirements, statusById };
}

/**
 * PR을 실제로 만들 때(exportSession, pullRequest:true) 추적 이슈 본문의 표를 지금 요구사항 상태로 다시 쓴다
 * (버그 리포트: 발행 때 만든 표가 "주기적으로 갱신"된다는 문구와 달리, 그 표를 다시 쓰는 경로가 실제로는
 * 없어 발행 당시 상태로 멈춰 있었다 — PR이 추적 이슈를 가리키는데 정작 그 이슈는 낡은 채로 남았다).
 *
 * 원격·토큰이 없거나(GitHub·Gitea가 아니거나 토큰을 못 찾음), 요구사항을 저장한 적이 없거나, 아직 "이슈로
 * 발행"을 한 적이 없어 추적 이슈가 없으면 조용히 건너뛴다(이 프로젝트가 애초에 쓰지 않는 기능이다 — 경고가
 * 아니다). 그 밖의 실패(네트워크·권한 등)만 경고 문구로 돌려준다 — PR은 이미 만들어졌으므로 갱신 실패가
 * PR 만들기 결과를 뒤집지 않는다(실패해도 올리기는 끝난 것으로 본다).
 */
async function refreshTrackingIssueAfterExport(session: Session): Promise<string | undefined> {
  const ctx = await requirementIssuesContext(session).catch(() => undefined);
  if (!ctx) return undefined;
  try {
    const snapshot = await getSessionRequirements(session.snapshot.id);
    if (!snapshot.exists || snapshot.requirements.length === 0) return undefined;
    const requirements = await readSavedRequirements(session);
    const statusById = Object.fromEntries(snapshot.requirements.map((requirement) => [requirement.id, requirement.status]));
    await refreshTrackingIssueBody(ctx, requirements, statusById);
    return undefined;
  } catch (error) {
    return `요구사항 추적 이슈 본문을 갱신하지 못했습니다: ${describe(error)}`;
  }
}

/** "이슈로 발행" 미리보기(dry-run). 원격 이슈를 읽기만 하고 아무것도 쓰지 않는다 */
export async function previewRequirementIssuePublish(id: string): Promise<RequirementPlanResult> {
  const session = requireSession(id);
  const ctx = requireRequirementIssuesContext(await requirementIssuesContext(session));
  const { requirements, statusById } = await requirementsForIssues(id);
  return planRequirementIssuePublish(ctx, requirements, statusById);
}

/** publishSessionRequirementIssues·resolveSessionRequirementConflict가 사이드카(docs/requirements.issues.json)를 쓴 뒤 공통으로 부른다 */
async function commitRequirementIssuesSidecar(id: string, message: string): Promise<void> {
  await commitWorkingCopyDocs(id, [REQUIREMENT_ISSUES_FILE], message).catch((error: unknown) => {
    console.error(`[b-studio] 세션 ${id}의 이슈 발행 기록 문서 체크포인트를 남기지 못했습니다`, error);
  });
}

/** 미리보기를 확인한 뒤 실제로 발행한다(하위 이슈·추적 이슈를 만들거나 갱신한다) */
export async function publishSessionRequirementIssues(id: string): Promise<RequirementPublishResult> {
  const session = requireSession(id);
  const ctx = requireRequirementIssuesContext(await requirementIssuesContext(session));
  const { requirements, statusById } = await requirementsForIssues(id);
  const result = await publishRequirementIssues(ctx, requirements, statusById);
  // 발행 기록(이슈 번호·발행 해시)도 작업 복사본에만 남으면 레인·통합 세션이 이어받지 못한다. 요구사항 저장과 같은 이유로 바로 체크포인트로 남긴다
  await commitRequirementIssuesSidecar(id, 'docs: 요구사항을 이슈로 발행한 기록을 남긴다');
  return result;
}

/** 발행된 요구사항 하나의 충돌(이슈가 GitHub에서 직접 수정됨)을 가져오기·덮어쓰기·무시 중 하나로 푼다 */
export async function resolveSessionRequirementConflict(id: string, requirementId: string, resolution: ConflictResolution): Promise<ConflictResolutionResult> {
  const session = requireSession(id);
  const ctx = requireRequirementIssuesContext(await requirementIssuesContext(session));
  const { requirements, statusById } = await requirementsForIssues(id);
  const requirement = requirements.find((candidate) => candidate.id === requirementId);
  if (!requirement) throw new StudioError(404, `요구사항 ${requirementId}을 찾지 못했습니다`);
  const result = await resolveRequirementConflict(ctx, requirement, statusById[requirementId] ?? '미착수', resolution);
  // overwrite·ignore만 사이드카를 고친다(import는 초안만 돌려주고 쓰지 않는다, requirement-issues.ts 참고)
  if (result.action === 'overwrite' || result.action === 'ignore') {
    await commitRequirementIssuesSidecar(id, `docs: ${requirementId} 이슈 충돌을 ${result.action === 'overwrite' ? '덮어써' : '무시해'} 해결한다`);
  }
  return result;
}

/**
 * 발행된 하위 이슈마다 상태(고정 댓글·라벨)를 반영한다. 세션의 PR이 이미 병합됐으면(검증됨인 요구사항만) 이슈도 닫는다.
 * 원격·토큰이 없거나 발행된 요구사항이 없으면 조용히 건너뛴다(호출하는 쪽이 매 체크포인트마다 fire-and-forget으로 부른다).
 */
export async function syncSessionRequirementIssueStatus(id: string): Promise<RequirementSyncResult> {
  const session = requireSession(id);
  const ctx = await requirementIssuesContext(session);
  if (!ctx) return { updated: [], errors: [] };
  const snapshot = await getSessionRequirements(id);
  if (!snapshot.exists || snapshot.requirements.length === 0) return { updated: [], errors: [] };

  const info = await session.checkpoints.repository();
  const prNumber = info?.pullRequestUrl ? parsePullRequestNumber(info.pullRequestUrl) : undefined;
  const prMerged =
    prNumber !== undefined
      ? await fetchPullRequestDetail(ctx.remote, prNumber, { token: ctx.token })
          .then((pull) => pull.merged === true)
          .catch(() => false)
      : false;

  const evidences: RequirementSyncEvidence[] = snapshot.requirements.map((requirement) => ({
    id: requirement.id,
    kind: requirement.kind,
    priority: requirement.priority,
    status: requirement.status,
    checkpoints: requirement.evidence.checkpoints,
    tests: requirement.evidence.tests,
    gateChecks: requirement.evidence.gateChecks,
  }));
  return syncRequirementIssueStatus(ctx, evidences, { prMerged });
}

/**
 * 요청 문구(커밋 제목 등)가 "[R4]" 형태로 언급한 요구사항들의 참조(id·rev·발행된 이슈 번호·상태)를 모은다.
 * PR 본문의 `Closes #n`·`Implements: Rn`(exportSession)과 AI 리뷰 문맥(runReviewRound)이 함께 쓴다.
 * 실패해도(원격 없음, 요구사항 파일 없음 등) 빈 배열 — 이 기능이 꺼져 있어도 PR·리뷰 흐름은 그대로 동작해야 한다.
 */
async function implementedRequirementRefs(session: Session, requestTexts: readonly string[]): Promise<ImplementedRequirementRef[]> {
  const mentioned = extractRequirementMentions(requestTexts);
  if (mentioned.length === 0) return [];
  try {
    const snapshot = await getSessionRequirements(session.snapshot.id);
    if (!snapshot.exists) return [];
    const byId = new Map(snapshot.requirements.map((requirement) => [requirement.id, requirement]));
    return mentioned.flatMap((id): ImplementedRequirementRef[] => {
      const requirement = byId.get(id);
      if (!requirement) return [];
      return [
        { id, ...(requirement.rev !== undefined ? { rev: requirement.rev } : {}), ...(requirement.issue !== undefined ? { issue: requirement.issue } : {}), status: requirement.status },
      ];
    });
  } catch {
    return [];
  }
}

/** implementedRequirementRefs의 결과를 AI 리뷰 프롬프트에 붙일 압축 문맥(제목·시나리오)으로 바꾼다. 리뷰가 요구사항을 몰라도 그만이라 실패는 삼킨다 */
async function reviewRequirementsContext(session: Session, requestTexts: readonly string[]): Promise<string> {
  try {
    const refs = await implementedRequirementRefs(session, requestTexts);
    if (refs.length === 0) return '';
    const snapshot = await getSessionRequirements(session.snapshot.id);
    const byId = new Map(snapshot.requirements.map((requirement) => [requirement.id, requirement]));
    const entries = refs.flatMap((ref) => {
      const requirement = byId.get(ref.id);
      return requirement ? [{ id: requirement.id, title: requirement.title, scenarios: requirement.scenarios }] : [];
    });
    return buildReviewRequirementsContext(entries);
  } catch {
    return '';
  }
}

/**
 * "[R4]" 모양의 id를 "R4"(소속 요구사항)로 되접는다 — 시나리오 언급(R4.1)도 상위 요구사항을 가리킨 것으로 본다.
 */
function baseRequirementId(id: string): string {
  return id.split('.')[0]!.toUpperCase();
}

/**
 * 이 세션 커밋(세션 시작 체크포인트 이후, sessionCommits가 이미 `start..HEAD`로 좁혀 둔 범위)이 실제로 건드린
 * 요구사항 id들. 커밋 제목·본문의 "[R4]" 언급·"Implements: R4" 트레일러를 먼저 보고, 그걸로 못 찾은 요구사항도
 * 이 세션에서 바뀐 테스트 파일에 그 id를 가리키는 테스트가 있으면 후보로 더한다(버그 리포트: PR #21이 머지돼
 * R2~R20 이슈가 전부 닫힌 뒤 새로 시작한 후속 세션이 R17 하나만 커밋했는데, 요구사항 상태는 main에 남은
 * 이전 커밋 기록을 그대로 봐 19개 모두 "검증됨"으로 남아 있었다 — 이 함수가 "이번 세션이 실제로 쓴 커밋"으로
 * 범위를 좁힌다).
 */
async function sessionTouchedRequirementIds(session: Session, commits: readonly SessionCommit[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const commit of commits) {
    const text = `${commit.subject}\n${commit.body}`;
    for (const mention of findMentionedIds(text)) ids.add(baseRequirementId(mention));
    for (const trailer of extractImplementsTrailers(text)) ids.add(baseRequirementId(trailer.id));
  }

  const changedTestFiles = [...new Set(commits.flatMap((commit) => commit.files))].filter(isLikelyTestFile);
  if (changedTestFiles.length === 0) return ids;
  try {
    const snapshot = await getSessionRequirements(session.snapshot.id);
    if (!snapshot.exists) return ids;
    const changedSet = new Set(changedTestFiles);
    const testFiles = (await scanWorkingCopyTestFiles(session.project.root)).filter((file) => changedSet.has(file.path));
    for (const requirement of snapshot.requirements) {
      if (!ids.has(requirement.id) && scanTestFilesForRequirementId(testFiles, requirement.id).length > 0) ids.add(requirement.id);
    }
  } catch {
    // 작업 복사본을 못 읽어도(세션이 사라졌거나 권한 문제) 커밋 제목·트레일러로 찾은 후보는 그대로 쓴다
  }
  return ids;
}

/** verifiedRequirementSummary가 돌려주는 값 */
interface VerifiedRequirementSummary {
  /** 지금 HEAD에서 "검증됨"이고 이번 세션 범위 안에 든 요구사항들의 참조(id·rev·이슈 번호·상태). 이슈가 없어도
   * 들어간다 — `Implements:` 절은 이슈 발행 여부와 무관하게 구현한 요구사항 전부를 적는다 */
  refs: ImplementedRequirementRef[];
  /** refs 중 이슈가 열려 있어(또는 확인하지 못해 모르는 채로) 기본으로 연결할 이슈 번호 */
  openIssues: number[];
  /** refs 중 이슈가 이미 닫혀 있는 것(머지로 자동으로 닫힌 이전 이슈 등) — 본문에서 `Closes`가 아니라 `관련:`으로만 가리킨다 */
  closedIssues: number[];
  /** 이 PR이 연결하는 이슈들이 "추적 이슈의 남은 마지막 열린 하위 이슈"인지 — 맞으면 추적 이슈도 Closes로 함께 닫는다 */
  closesTracking: boolean;
}

const EMPTY_VERIFIED_REQUIREMENT_SUMMARY: VerifiedRequirementSummary = { refs: [], openIssues: [], closedIssues: [], closesTracking: false };

/**
 * 지금 세션 HEAD의 요구사항 상태(getSessionRequirements — computeRequirementStatus가 체크포인트·테스트·게이트·
 * 문서 증거로 다시 매긴 값)에서 "검증됨 + 이번 세션 범위 안"인 것만 추린다.
 *
 * 범위는 두 가지 중 하나다: `planRequirementIds`(작업 분해 계획의 레인·요청 글이 언급한 요구사항 id, task-plans.ts의
 * planRequirementIds — 통합 세션 신호)가 하나라도 있으면 "검증됨 + 이슈 발행" 전부를 후보로 본다(ADR-110 원래
 * 규칙 — 레인을 하나로 합친 병합 커밋 하나로는 모든 요구사항이 제목에 안 남기 때문이다). 아니면 이 세션 커밋이
 * 실제로 언급·테스트한 요구사항(sessionTouchedRequirementIds)으로만 좁힌다(버그 리포트: PR #21 머지 뒤 시작한
 * 후속 세션이 R17 하나만 커밋했는데 이전에 머지돼 닫힌 R2~R20 이슈까지 그대로 다시 내세웠다).
 *
 * 이슈 번호가 있는 후보는 열림·닫힘을 확인해(ADR-107의 토큰) 열려 있거나 확인하지 못한 것만 기본으로 연결하고,
 * 이미 닫힌 것은 `관련:`으로만 가리킨다. PR 본문의 기본 연결 이슈(sessionRequirementIssueNumbers)·`Closes #n`·
 * `Implements: Rn`(pullRequestDraft)이 모두 이 함수를 쓴다. 실패해도(원격 없음, 요구사항 파일 없음 등) 빈 결과 —
 * 이 기능이 꺼져 있어도 PR 흐름은 그대로 동작해야 한다.
 */
async function verifiedRequirementSummary(
  session: Session,
  commits: readonly SessionCommit[],
  info: RepositoryInfo,
  planRequirementIds: readonly string[],
): Promise<VerifiedRequirementSummary> {
  try {
    const snapshot = await getSessionRequirements(session.snapshot.id);
    if (!snapshot.exists || snapshot.requirements.length === 0) return EMPTY_VERIFIED_REQUIREMENT_SUMMARY;

    const scopeAll = planRequirementIds.length > 0;
    const touched = scopeAll ? undefined : await sessionTouchedRequirementIds(session, commits);
    const inScope = (id: string): boolean => scopeAll || touched!.has(id);

    const refs: ImplementedRequirementRef[] = snapshot.requirements
      .filter((requirement) => requirement.status === '검증됨' && inScope(requirement.id))
      .map((requirement) => ({
        id: requirement.id,
        ...(requirement.rev !== undefined ? { rev: requirement.rev } : {}),
        ...(requirement.issue !== undefined ? { issue: requirement.issue } : {}),
        status: requirement.status,
      }));

    const withIssue = refs.filter((ref): ref is ImplementedRequirementRef & { issue: number } => ref.issue !== undefined);
    const remote = parseRemote(info.remoteUrl);
    const lookups = withIssue.length > 0 ? await lookupIssues(remote, withIssue.map((ref) => ref.issue), await repositoryPullRequestToken(remote)) : [];
    const stateByIssue = new Map(lookups.map((entry) => [entry.issue, entry.lookup]));
    const openIssues: number[] = [];
    const closedIssues: number[] = [];
    for (const ref of withIssue) {
      // 확인하지 못했으면(토큰 없음 등) 모르는 채로 열려 있다고 보고 그대로 연결한다 — 올리기 전 점검표가
      // 따로 "확인할 수 없습니다"로 보여준다
      const lookup = stateByIssue.get(ref.issue);
      (lookup?.ok && lookup.state === 'closed' ? closedIssues : openIssues).push(ref.issue);
    }

    // 추적 이슈: 이 PR이 연결하는 이슈들이 "남은 마지막 열린 하위 이슈"면 함께 닫는다. 범위를 좁히지 않은(scopeAll)
    // 통합 세션이고 요구사항이 전부 검증됐으며, 그중 이미 닫혀 있던 이슈(이 PR이 닫는 게 아닌 것)가 없을 때만
    // 그렇다고 본다(ADR-110의 "전부 검증됨" 규칙을 이슈의 실제 열림 상태로 다시 평가한다)
    const closesTracking = scopeAll && snapshot.requirements.every((requirement) => requirement.status === '검증됨') && closedIssues.length === 0;

    return { refs, openIssues, closedIssues, closesTracking };
  } catch {
    return EMPTY_VERIFIED_REQUIREMENT_SUMMARY;
  }
}

/**
 * 이 세션 HEAD에서 검증됨이고(이번 세션 범위 안이고) 이슈가 열려 있는 요구사항들의 이슈 번호(중복 없이). 올리기
 * (export) 미리보기·생성 라우트가 사람이 이슈 번호를 입력하지 않았을 때 기본값으로 쓴다(ADR-092) — 그래야 PR
 * 본문에 그 요구사항들의 `Closes #n`이 자동으로 실린다. 실패해도(원격 없음 등) 빈 배열.
 */
export async function sessionRequirementIssueNumbers(id: string, planRequirementIds: readonly string[] = []): Promise<number[]> {
  const session = requireSession(id);
  const info = await session.checkpoints.repository();
  if (!info) return [];
  const commits = await session.checkpoints.sessionCommits();
  const { openIssues } = await verifiedRequirementSummary(session, commits, info, planRequirementIds);
  return [...new Set(openIssues)];
}

/** 저장소 이슈 하나(제목+본문)를 요구사항 초안으로 가져온다("이슈에서 가져오기" — docs/requirements.md에는 쓰지 않는다, 화면이 "적용"으로 반영한다) */
export async function importRequirementDraftFromIssue(id: string, issueNumber: number): Promise<RequirementIssueDraft> {
  const session = requireSession(id);
  const info = await session.checkpoints.repository();
  if (!info) throw new StudioError(409, '이 프로젝트는 원격 저장소가 없어 이슈를 가져올 수 없습니다');
  const remote = parseRemote(info.remoteUrl);
  if (remote.kind !== 'github' && remote.kind !== 'gitea') throw new StudioError(400, `${remote.display}는 이슈 가져오기를 지원하지 않습니다(GitHub·Gitea만 지원합니다)`);
  const token = await resolveRepositoryToken(remote.kind, { allowGhCli: localFolderAllowed() });
  if (!token) throw new StudioError(400, '이슈를 가져올 토큰이 없습니다');
  const issues = await listIssues(remote, { state: 'all', token });
  const issue = issues.find((candidate) => candidate.number === issueNumber);
  if (!issue) throw new StudioError(404, `이슈 #${issueNumber}을 찾지 못했습니다(최근 이슈 목록 안에 없습니다)`);
  return draftRequirementFromIssue(issue.title, issue.body ?? '');
}

// ---------------------------------------------------------------------------
// "테스트" 탭(ADR-084): 백엔드·프론트 테스트 케이스를 한 줄씩 보여 주고 돌린다.
// ---------------------------------------------------------------------------

/** 한 번에 도는 테스트 실행의 상한. 게이트의 TEST_TIMEOUT_MS와 같은 값(느린 Gradle 첫 실행도 버틴다) */
const TEST_RUN_TIMEOUT_MS = 10 * 60_000;
/** 보고서를 모아오는 cat/find 명령은 테스트 자체보다 훨씬 짧게 끝나야 한다 */
const REPORT_COLLECT_TIMEOUT_MS = 30_000;
const GATE_REPORT_COLLECT_TIMEOUT_MS = 15_000;
/** 실행기가 보고서를 하나도 남기지 못했을 때(컴파일 오류 등) 사람에게 보여 줄 출력 꼬리 줄 수 */
const RUN_FAILURE_TAIL_LINES = 30;

type ManagedSpec = LoadedProject['managed'][number][1];

/** test-discovery.ts의 결과에 framework를 함께 붙인 행. attachResults는 구조적으로 호환되는 TestRow만 보고 돌려주므로, 돌아온 값도 이 모양 그대로다(as로 되돌린다) */
interface ServiceTestRow extends TestRow {
  framework: TestFramework;
}

export interface TestRowView {
  file: string;
  framework: TestFramework;
  suitePath: string[];
  name: string;
  displayName: string;
  line: number;
  skipped: boolean;
  requirementIds: string[];
  status: 'pass' | 'fail' | 'skip' | 'not-run';
  durationMs?: number;
  failureMessage?: string;
  stack?: string[];
  /** 실패한 테스트에서만 있다. "이 테스트 고쳐 줘" 버튼이 그대로 채운다 */
  fixPrefill?: string;
}

export interface TestServiceView {
  service: string;
  template: string;
  /** 지금 이 서비스에서 테스트가 도는 중인지 */
  running: boolean;
  /**
   * 지금 테스트를 돌릴 수 있는지(false면 실행 버튼을 숨기고 이유를 error에 남긴다). 테스트 실행기를 못
   * 알아냈을 때뿐 아니라, 서비스가 꺼져 있어 사이드카의 마지막 실행 결과만 보여 주는 동안도 false다(58번 버그)
   */
  supported: boolean;
  /** 사람이 읽는 실행기 이름(예: "Gradle (JUnit)") */
  runner?: string;
  counts: { pass: number; fail: number; skip: number; notRun: number };
  lastRunAt?: string;
  lastRunSource?: 'run' | 'gate';
  /**
   * 이 실행 시점의 체크포인트(HEAD) SHA. "올리기 전 점검"의 테스트 항목·요구사항 증거가 지금 체크포인트와
   * 같은지 비교하는 값이다(buildChecklistTestEvidence·buildRequirementTestRunEvidence). 체크포인트가 없던
   * 세션에서 돈 실행이면 undefined
   */
  lastRunSha?: string;
  error?: string;
  /**
   * 뭔가 잘못됐다는 뜻은 아니지만 알아 둘 만한 안내(예: 서비스가 아직 뜨는 중이라 마지막 실행 결과만 보여 줌).
   * error와 달리 화면이 경고색으로 그리지 않는다(58번 버그)
   */
  notice?: string;
  rows: TestRowView[];
}

export interface RequirementWithoutTest {
  id: string;
  title: string;
  /** "테스트 추가" 버튼이 채우는 글 */
  prefill: string;
}

export interface TestsSnapshot {
  services: TestServiceView[];
  requirementsWithoutTests: RequirementWithoutTest[];
}

/** 서비스 폴더 안에서 테스트 파일을 찾아 케이스를 뽑는다. 파일 IO만 하고 판정은 하지 않는다(순수 함수는 test-discovery.ts에 있다) */
async function discoverServiceTestRows(session: Session, spec: ManagedSpec): Promise<ServiceTestRow[]> {
  const files = await walkServiceTestFiles(session.project.root, spec.path);
  const rows: ServiceTestRow[] = [];
  for (const file of files) {
    const discovered = discoverTestsInFile(file.path, file.content);
    if (!discovered) continue;
    for (const row of flattenDiscoveredFile(discovered)) rows.push({ ...row, framework: discovered.framework });
  }
  return rows;
}

/** 서비스 폴더의 힌트(템플릿, package.json, pom.xml)로 테스트 실행기를 고른다 */
async function detectServiceRunner(session: Session, spec: ManagedSpec): Promise<Runner | undefined> {
  const [packageJson, hasPomXml] = await Promise.all([
    readServicePackageJson(session.project.root, spec.path),
    serviceHasPomXml(session.project.root, spec.path),
  ]);
  return detectRunner({ template: spec.template, hasPomXml, packageJson });
}

// ---------------------------------------------------------------------------
// 테스트 결과 사이드카(.git/b-studio/test-results.json, 다그푸딩 불편 55): testResults는 지금까지 세션 메모리에만
// 있어 스튜디오 서버가 재시작하면 통째로 사라졌다 — 체크포인트 sha가 같아 "올리기 전 점검"·요구사항 증거로 치던
// 실행 결과까지 전부 "재확인 필요"로 되돌아갔다. requirements-draft.json(ADR-097 개정)과 같은 자리(.git/ 아래라
// 커밋에도, 에이전트 도구에도, 체크포인트 되돌리기에도 걸리지 않는다)에 서비스별 마지막 실행을 남겨 서버가
// 다시 떠도 이어서 보이게 한다. 복원한 실행이 지금 체크포인트와 다른 sha면(testRunMatchesHead) 증거로는 치지
// 않지만 "테스트" 탭에는 그대로 보인다 — 화면이 이미 lastRunSha로만 증거 여부를 가리고 행 자체는 항상 보여주므로
// 따로 "이전 실행" 표시를 덧붙이지 않는다.
// ---------------------------------------------------------------------------

const TEST_RESULTS_FILE = path.join('.git', 'b-studio', 'test-results.json');

interface PersistedTestResults {
  version: 1;
  savedAt: string;
  results: Record<string, StoredTestRun>;
}

function testResultsFile(session: Session): string {
  return path.join(stateDirOf(session.snapshot), TEST_RESULTS_FILE);
}

/** 사이드카 파일을 읽는다. 없거나(아직 돈 테스트가 없음) 읽을 수 없으면(깨진 파일 등) 조용히 무시하고 undefined */
async function readTestResultsFile(session: Session): Promise<Record<string, StoredTestRun> | undefined> {
  let raw: string;
  try {
    raw = await readFile(testResultsFile(session), 'utf8');
  } catch {
    return undefined; // 파일이 없다 — 아직 테스트를 돈 적이 없는 세션의 정상 상태
  }
  try {
    const parsed = JSON.parse(raw) as PersistedTestResults;
    if (parsed?.version !== 1 || typeof parsed.results !== 'object' || parsed.results === null) throw new Error('알 수 없는 형식');
    return parsed.results;
  } catch (error) {
    console.error(`[b-studio] 세션 ${session.snapshot.id}의 테스트 결과 파일이 깨져 있어 무시합니다`, error);
    return undefined;
  }
}

/** 지금 메모리의 testResults를 사이드카 파일에 남긴다(requirements-draft.json과 같은 임시 파일 + rename 방식) */
async function writeTestResultsFile(session: Session): Promise<void> {
  const file = testResultsFile(session);
  await mkdir(path.dirname(file), { recursive: true });
  const data: PersistedTestResults = {
    version: 1,
    savedAt: new Date().toISOString(),
    results: Object.fromEntries(session.testResults ?? new Map()),
  };
  // 임시 파일 이름은 호출마다 달라야 한다 — 같으면 겹쳐 쓰는 두 저장이 서로의 임시 파일을 지우고 rename이 ENOENT로 깨진다
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2));
  await rename(temp, file);
}

/** 실행이 끝난 뒤 사이드카에 남긴다. 남기지 못해도(디스크 문제 등) 방금 돈 실행 자체는 그대로 쓸 수 있어야 하므로 던지지 않는다 */
async function persistTestResults(session: Session): Promise<void> {
  await writeTestResultsFile(session).catch((error: unknown) => {
    console.error(`[b-studio] 세션 ${session.snapshot.id}의 테스트 결과를 남기지 못했습니다`, error);
  });
}

/**
 * testResults를 처음 찾을 때 사이드카 파일에서 복원한다("테스트" 탭을 열 때·테스트를 돌릴 때 모두 거친다).
 * 이미 메모리에 있으면(이번 프로세스에서 이미 돌렸거나 이미 복원했음) 다시 읽지 않는다. 동시에 여러 서비스를
 * 조회해도(Promise.all) session.testResultsLoadPromise를 공유해 파일을 한 번만 읽는다.
 */
function ensureTestResultsLoaded(session: Session): Promise<void> {
  session.testResultsLoadPromise ??= (async () => {
    if (session.testResults) return;
    const restored = await readTestResultsFile(session);
    if (restored) session.testResults = new Map(Object.entries(restored));
  })();
  return session.testResultsLoadPromise;
}

function testRowStatus(row: ServiceTestRow): TestRowView['status'] {
  return row.result?.status ?? 'not-run';
}

function toTestRowView(row: ServiceTestRow): TestRowView {
  const status = testRowStatus(row);
  return {
    file: row.file,
    framework: row.framework,
    suitePath: row.suitePath,
    name: row.name,
    displayName: row.displayName,
    line: row.line,
    skipped: row.skipped || row.suiteSkipped,
    requirementIds: row.requirementIds,
    status,
    ...(row.result?.durationMs !== undefined ? { durationMs: row.result.durationMs } : {}),
    ...(row.result?.failureMessage ? { failureMessage: row.result.failureMessage } : {}),
    ...(row.result?.stack ? { stack: row.result.stack } : {}),
    ...(status === 'fail' ? { fixPrefill: buildFixTestPrefill(row) } : {}),
  };
}

/** stored.runner(gradle·maven·vitest·jest·pytest)를 화면 행의 framework로 옮긴다. 화면은 이 값을 그리지 않아(타입에만 있다) 몰라도 안전하다 */
function runnerFramework(runner: Runner | undefined): TestFramework {
  switch (runner) {
    case 'vitest':
      return 'vitest';
    case 'jest':
      return 'jest';
    case 'pytest':
      return 'pytest';
    case 'gradle':
    case 'maven':
    default:
      return 'junit';
  }
}

/**
 * 서비스가 꺼져 있어도(재시작 직후 샌드박스가 뜨는 중 등) 사이드카(test-results.json)에 남은 마지막 실행
 * 보고서만으로 행을 만든다(58번 버그). 소스 파일을 다시 읽어 발견한 행(discoverServiceTestRows)과 붙이지
 * 않고, 보고서가 담은 케이스를 그대로 한 행씩 삼는다 — file·line·suitePath는 보고서에 없어 비워 두지만,
 * 요구사항 id는 발견 단계(test-discovery.ts)와 같은 방식(extractRequirementIds)으로 케이스 이름에서 뽑아,
 * 서비스가 떠야만 나오던 요구사항 증거가 재시작 직후에도 끊기지 않게 한다
 */
function storedCaseToRow(testCase: ParsedTestCase, framework: TestFramework): ServiceTestRow {
  return {
    file: testCase.classOrFile,
    framework,
    suitePath: [],
    suiteSkipped: false,
    name: testCase.name,
    displayName: testCase.name,
    line: 0,
    skipped: testCase.result.status === 'skip',
    requirementIds: extractRequirementIds(testCase.name),
    result: testCase.result,
  };
}

async function buildTestServiceView(session: Session, serviceName: string): Promise<TestServiceView> {
  const entry = session.project.managed.find(([name]) => name === serviceName);
  const template = entry?.[1].template ?? '';
  const running = session.testControllers?.has(serviceName) ?? false;
  const serviceState = session.snapshot.services.find((candidate) => candidate.name === serviceName);
  if (!entry || serviceState?.state !== 'ready') {
    // 서비스는 꺼져 있지만 사이드카에 이 서비스의 마지막 실행 결과가 남아 있으면, 빈 행으로 되돌리지 않고
    // 그 결과를 그대로 보여준다 — 그래야 서버 재시작 직후(샌드박스가 뜨는 몇 분 동안) 이미 검증된 요구사항이
    // "재확인 필요"로 잠깐 되돌아가지 않는다. 테스트를 다시 도는 것은 여전히 서비스가 떠야만 할 수 있다(supported: false)
    await ensureTestResultsLoaded(session);
    const stored = entry && session.testResults?.get(serviceName);
    if (stored) {
      const rows = stored.run.cases.map((testCase) => storedCaseToRow(testCase, runnerFramework(stored.runner)));
      return {
        service: serviceName,
        template,
        running: false,
        supported: false,
        counts: countByStatus(rows),
        lastRunAt: stored.at,
        lastRunSource: stored.source,
        ...(stored.sha !== undefined ? { lastRunSha: stored.sha } : {}),
        // 마지막 실행 자체가 실패했으면(컴파일 오류 등) 그 이유를 먼저 보여준다 — "꺼져 있다"는 안내보다 더 급하다
        ...(stored.error ? { error: stored.error } : { notice: '서비스가 꺼져 있어 마지막 실행 결과만 보여 줍니다' }),
        rows: rows.map(toTestRowView),
      };
    }
    return {
      service: serviceName,
      template,
      running,
      supported: false,
      counts: { pass: 0, fail: 0, skip: 0, notRun: 0 },
      rows: [],
      error: '서비스가 꺼져 있습니다',
    };
  }

  const [rawRows, runner] = await Promise.all([discoverServiceTestRows(session, entry[1]), detectServiceRunner(session, entry[1]), ensureTestResultsLoaded(session)]);
  const stored = session.testResults?.get(serviceName);
  // attachResults는 TestRow[]를 돌려주지만 spread로 원래 값(framework 포함)을 그대로 옮기므로 형태를 되돌려도 안전하다
  const attached = (stored ? attachResults(rawRows, stored.run) : rawRows) as ServiceTestRow[];
  return {
    service: serviceName,
    template,
    running,
    supported: runner !== undefined,
    ...(runner ? { runner: runnerLabel(runner) } : {}),
    counts: countByStatus(attached),
    ...(stored ? { lastRunAt: stored.at, lastRunSource: stored.source, ...(stored.sha !== undefined ? { lastRunSha: stored.sha } : {}) } : {}),
    ...(!runner ? { error: '이 서비스의 테스트 실행기를 알아내지 못했습니다(vitest·jest devDependency나 pom.xml/build.gradle을 확인하세요)' } : stored?.error ? { error: stored.error } : {}),
    rows: attached.map(toTestRowView),
  };
}

/** docs/requirements.md에는 있지만 어느 서비스 테스트 이름에도 id가 나타나지 않는 요구사항 */
async function requirementsWithoutTests(session: Session, services: readonly TestServiceView[]): Promise<RequirementWithoutTest[]> {
  const raw = await new Workspace(session.project.root).read(REQUIREMENTS_FILE).catch(() => undefined);
  if (!raw) return [];
  const { requirements } = parseRequirementsMarkdown(raw);
  if (requirements.length === 0) return [];
  const covered = new Set<string>();
  for (const service of services) for (const row of service.rows) for (const id of row.requirementIds) covered.add(id);
  return requirements
    .filter((requirement) => !covered.has(requirement.id))
    .map((requirement) => ({ id: requirement.id, title: requirement.title, prefill: buildAddTestPrefill(requirement) }));
}

/** "테스트" 탭이 연다: 서비스마다 테스트를 찾고 마지막으로 저장해 둔 결과를 이어 붙인다 */
export async function getSessionTests(id: string): Promise<TestsSnapshot> {
  const session = requireSession(id);
  const services = await Promise.all(session.project.managed.map(([name]) => buildTestServiceView(session, name)));
  return { services, requirementsWithoutTests: await requirementsWithoutTests(session, services) };
}

// ---------------------------------------------------------------------------
// 테스트 탭 실행을 체크포인트 증거로 쓰기(버그 리포트): 게이트가 test 단계를 돌리지 않았어도, 사람이 "테스트" 탭에서
// 지금 체크포인트(HEAD)에서 직접 돌린 결과는 "올리기 전 점검"의 테스트 항목과 요구사항 증거로 센다. 그 사이 커밋하지
// 않은 변경이 있으면(코드가 바뀌었을 수 있다) 믿지 않는다. 순수 함수라 session을 몰라도 TestServiceView만으로 테스트한다.
// ---------------------------------------------------------------------------

/** 서비스의 마지막 실행이 지금 체크포인트(HEAD)에서 돈 것이고, 그 뒤로 커밋하지 않은 변경이 없는지 */
function testRunMatchesHead(service: Pick<TestServiceView, 'lastRunSha'>, headSha: string | undefined, pendingFilesCount: number): boolean {
  return headSha !== undefined && pendingFilesCount === 0 && service.lastRunSha === headSha;
}

/** "올리기 전 점검"의 테스트 항목(submission-checklist.ts checkTests)이 쓸 체크포인트 증거 목록을 만든다 */
export function buildChecklistTestEvidence(services: readonly TestServiceView[], headSha: string | undefined, pendingFilesCount: number): ChecklistTestEvidence[] {
  return services.map((service) => ({
    service: service.service,
    matchesHead: testRunMatchesHead(service, headSha, pendingFilesCount),
    counts: service.counts,
    ...(service.lastRunAt !== undefined ? { at: service.lastRunAt } : {}),
  }));
}

/**
 * 요구사항 하나의 테스트 탭 증거(RequirementEvidence.testRun, @b-studio/agent). 지금 체크포인트에서 돈 실행
 * 중에서 이 요구사항 id가 붙은 행만 모아 통과·실패 수를 센다. 하나도 없으면(테스트가 없거나 실행한 적이
 * 없거나 체크포인트가 다르면) undefined — computeRequirementStatus가 "증거 없음"으로 받아들인다.
 */
export function buildRequirementTestRunEvidence(
  services: readonly TestServiceView[],
  requirementId: string,
  head: { sha: string; shortSha: string } | undefined,
  pendingFilesCount: number,
): TestRunEvidence | undefined {
  if (!head) return undefined;
  let passed = 0;
  let failed = 0;
  let at: string | undefined;
  for (const service of services) {
    if (!testRunMatchesHead(service, head.sha, pendingFilesCount)) continue;
    for (const row of service.rows) {
      if (!row.requirementIds.includes(requirementId)) continue;
      if (row.status === 'pass') passed++;
      else if (row.status === 'fail') failed++;
    }
    if (service.lastRunAt !== undefined && (at === undefined || service.lastRunAt > at)) at = service.lastRunAt;
  }
  if (passed === 0 && failed === 0) return undefined;
  return { at: at ?? new Date().toISOString(), sha: head.sha, shortSha: head.shortSha, passed, failed };
}

/**
 * 추적 매트릭스의 테스트 열(MatrixTestRunRow, @b-studio/agent)이 쓸, 지금 체크포인트에서 돈 테스트 탭 실행 결과를
 * 테스트 하나하나 단위로 펼친 목록. buildRequirementTestRunEvidence와 같은 "지금 체크포인트와 맞는 실행만 증거로
 * 친다" 규칙(testRunMatchesHead)을 쓰되, 집계한 통과·실패 수가 아니라 테스트 한 줄 한 줄의 결과를 그대로 남긴다 —
 * 매트릭스는 "이 테스트가 통과했는지 실패했는지"를 보여줘야 하지, 요구사항 전체의 통과 개수만으로는 부족하다.
 * 한 테스트 이름에 여러 id(예: "R1과 R2를 함께 확인한다")가 붙어 있으면 id마다 한 행씩 낸다.
 */
export function buildMatrixTestRunRows(
  services: readonly TestServiceView[],
  head: { sha: string; shortSha: string } | undefined,
  pendingFilesCount: number,
): MatrixTestRunRow[] {
  if (!head) return [];
  const rows: MatrixTestRunRow[] = [];
  for (const service of services) {
    if (!testRunMatchesHead(service, head.sha, pendingFilesCount)) continue;
    const at = service.lastRunAt ?? new Date().toISOString();
    for (const row of service.rows) {
      for (const id of row.requirementIds) {
        rows.push({ id, file: row.file, name: row.displayName, status: row.status, at, sha: head.sha, shortSha: head.shortSha });
      }
    }
  }
  return rows;
}

function markTestsChanged(session: Session): void {
  const revision = (session.snapshot.testsRevision ?? 0) + 1;
  const running = session.testControllers ? [...session.testControllers.keys()] : [];
  session.snapshot.testsRevision = revision;
  session.snapshot.testsRunning = running;
  emit(session, { type: 'tests_changed', revision, running });
}

function testFilePathBase(filePath: string): string {
  const segment = filePath.split('/').pop() ?? filePath;
  return segment.replace(/\.[^.]+$/, '');
}

/**
 * 화면이 보낸 "무엇을 좁혀 돌릴지"(파일·스위트 경로·테스트 이름)를 실행기별 대상으로 바꾼다.
 * JVM(Gradle/Maven)은 파일 경로를 받지 않으므로 파일 이름에서 클래스 이름을 되짚고, 중첩 스위트(@Nested)는
 * 파일의 대표 클래스 뒤에 `$`로 붙인다. pytest는 마지막 스위트(class Test*)만 본다(중첩 클래스를 쓰지 않는 관례라서다)
 */
function toTestTarget(runner: Runner, input: { file?: string; suitePath?: string[]; testName?: string }): TestTarget | undefined {
  if (!input.file && !input.testName) return undefined;
  if (runner === 'gradle' || runner === 'maven') {
    if (!input.file) return input.testName ? { testName: input.testName } : undefined;
    const nested = (input.suitePath ?? []).slice(1);
    const className = nested.length > 0 ? [testFilePathBase(input.file), ...nested].join('$') : testFilePathBase(input.file);
    return { className, ...(input.testName ? { testName: input.testName } : {}) };
  }
  if (runner === 'pytest') {
    return {
      ...(input.file ? { file: input.file } : {}),
      ...(input.suitePath && input.suitePath.length > 0 ? { className: input.suitePath[input.suitePath.length - 1] } : {}),
      ...(input.testName ? { testName: input.testName } : {}),
    };
  }
  return { ...(input.file ? { file: input.file } : {}), ...(input.testName ? { testName: input.testName } : {}) };
}

/** 컨테이너 안에서 명령을 돌려 보고서 글자를 모으고 파싱한다. 실패해도(취소 포함) 던지지 않고 결과만 돌려준다 */
async function collectParsedRun(
  session: Session,
  serviceName: string,
  plan: ReturnType<typeof buildTestRunPlan>,
  signal: AbortSignal,
): Promise<ParsedTestRun> {
  const collected = await session.sandbox.exec(serviceName, plan.collect, { signal }).catch(() => undefined);
  if (!collected) return { cases: [] };
  const reportText = splitCollectedReports(collected.stdout)
    .map((part) => part.content)
    .join('\n\n');
  if (!reportText.trim()) return { cases: [] };
  return plan.format === 'junit-xml' ? parseJUnitXml(reportText) : parseJestLikeJson(reportText);
}

/**
 * 서비스 하나의 테스트를 돌린다(서비스당 한 번에 하나만). 좁힐 대상이 없으면 서비스의 테스트 전체를 돌린다.
 * 실행기 자체가 실패해도(컴파일 오류 등) 예외를 던지지 않고 결과에 원인을 담아 돌려준다 — 사람이 "테스트" 탭에서 바로 보게 하려는 것이다.
 * 취소하면(cancelSessionTests) 저장된 결과를 건드리지 않고 그대로 돌아온다.
 */
export async function runSessionTests(
  id: string,
  input: { service: string; file?: string; suitePath?: string[]; testName?: string },
): Promise<TestsSnapshot> {
  const session = requireSession(id);
  const entry = session.project.managed.find(([name]) => name === input.service);
  if (!entry) throw new StudioError(404, `${input.service} 서비스가 없습니다`);
  const serviceState = session.snapshot.services.find((candidate) => candidate.name === input.service);
  if (serviceState?.state !== 'ready') throw new StudioError(409, '서비스가 꺼져 있습니다');

  // 사이드카에 남겨 둔 다른 서비스의 결과를 잃지 않으려면, 이번 실행 결과를 쓰기 전에 먼저 복원해 둬야 한다
  await ensureTestResultsLoaded(session);
  session.testControllers ??= new Map();
  if (session.testControllers.has(input.service)) throw new StudioError(409, '이미 테스트를 실행하는 중입니다');

  const runner = await detectServiceRunner(session, entry[1]);
  if (!runner) throw new StudioError(400, `${input.service} 서비스의 테스트 실행기를 알아내지 못했습니다`);

  const plan = buildTestRunPlan(runner, toTestTarget(runner, input), { wrapper: await hasBuildWrapper(session, entry[1].path, runner) });
  const controller = new AbortController();
  session.testControllers.set(input.service, controller);
  markTestsChanged(session);
  try {
    const runSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(TEST_RUN_TIMEOUT_MS)]);
    let execResult: Awaited<ReturnType<Sandbox['exec']>> | undefined;
    try {
      execResult = await session.sandbox.exec(input.service, plan.command, { signal: runSignal });
    } catch (error) {
      if (controller.signal.aborted) return getSessionTests(id); // 취소됐다 — 저장된 결과는 그대로 둔다
      throw error;
    }

    const run = await collectParsedRun(session, input.service, plan, AbortSignal.timeout(REPORT_COLLECT_TIMEOUT_MS));
    const sha = session.snapshot.checkpoints[0]?.sha;
    session.testResults ??= new Map();
    if (run.cases.length > 0) {
      session.testResults.set(input.service, { at: new Date().toISOString(), source: 'run', runner, run, sha });
    } else {
      const tail = `${execResult.stdout}\n${execResult.stderr}`.trim().split('\n').slice(-RUN_FAILURE_TAIL_LINES).join('\n');
      session.testResults.set(input.service, {
        at: new Date().toISOString(),
        source: 'run',
        runner,
        run: { cases: [] },
        sha,
        ...(execResult.exitCode !== 0
          ? { error: session.sandbox.redact(`테스트 실행이 실패했습니다(종료 코드 ${execResult.exitCode})\n${tail}`) }
          : {}),
      });
    }
    await persistTestResults(session);
  } finally {
    session.testControllers.delete(input.service);
    markTestsChanged(session);
  }
  return getSessionTests(id);
}

/** 도는 중인 테스트를 취소한다. 실행 중이 아니면 404 */
export function cancelSessionTests(id: string, service: string): void {
  const session = requireSession(id);
  const controller = session.testControllers?.get(service);
  if (!controller) throw new StudioError(404, '실행 중인 테스트가 없습니다');
  controller.abort();
}

/**
 * 검증 게이트가 test 단계를 돌린 뒤(runAgent 결과에 checks가 있을 때) 다시 실행하지 않고 같은 보고서 파일을 모아 본다.
 * 사람이 지금 그 서비스의 테스트를 돌리고 있으면 건드리지 않는다. 무엇을 모으든 실패해도 요청 결과에 영향이 없다(최선만 한다)
 */
/** 서비스 폴더에 빌드 도구 래퍼(gradlew·mvnw)가 있는지. 없으면 테스트도 이미지의 gradle·mvn으로 돌린다 */
async function hasBuildWrapper(session: Session, servicePath: string, runner: string): Promise<boolean> {
  const name = runner === 'gradle' ? 'gradlew' : runner === 'maven' ? 'mvnw' : undefined;
  if (!name) return true;
  return stat(path.join(session.project.root, servicePath, name)).then(() => true, () => false);
}

async function collectGateTestReports(session: Session): Promise<void> {
  if (session.snapshot.status !== 'ready') return;
  await ensureTestResultsLoaded(session);
  let changed = false;
  for (const [name, spec] of session.project.managed) {
    if (session.testControllers?.has(name)) continue;
    const serviceState = session.snapshot.services.find((candidate) => candidate.name === name);
    if (serviceState?.state !== 'ready') continue;
    const runner = await detectServiceRunner(session, spec);
    if (!runner) continue;
    const plan = buildTestRunPlan(runner, undefined, { wrapper: await hasBuildWrapper(session, spec.path, runner) });
    const run = await collectParsedRun(session, name, plan, AbortSignal.timeout(GATE_REPORT_COLLECT_TIMEOUT_MS));
    if (run.cases.length === 0) continue;
    session.testResults ??= new Map();
    session.testResults.set(name, { at: new Date().toISOString(), source: 'gate', runner, run, sha: session.snapshot.checkpoints[0]?.sha });
    changed = true;
  }
  if (changed) {
    await persistTestResults(session);
    markTestsChanged(session);
  }
}

function onServiceStatus(session: Session, event: ServiceStatusEvent): void {
  const service = session.snapshot.services.find((candidate) => candidate.name === event.service);
  if (!service) return;

  switch (event.phase) {
    case 'starting':
      Object.assign(service, { state: 'starting', detail: undefined });
      break;
    case 'probing': {
      const detail = event.probe.error ?? `HTTP ${event.probe.status}`;
      // 같은 결과가 1초마다 반복되므로 바뀔 때만 알린다
      if (service.state === 'probing' && service.detail === detail) return;
      Object.assign(service, { state: 'probing', detail });
      break;
    }
    case 'ready':
      Object.assign(service, { state: 'ready', url: event.endpoint.url, previewUrl: previewUrlFor(session, service.name), detail: undefined });
      // 재시작한 컨테이너는 기존 로그 구독에 잡히지 않으므로 다시 붙는다
      if (session.snapshot.status === 'ready') followLogs(session, 20);
      break;
    case 'failed':
      Object.assign(service, { state: 'failed', detail: event.reason });
      break;
    case 'off':
      // 서비스 선택(ADR-083)에서 꺼 둔 서비스. 실패가 아니므로 url을 지워 미리보기가 "꺼 둔 서비스" 안내로 바뀌게 한다
      Object.assign(service, { state: 'off', url: undefined, previewUrl: undefined, detail: undefined });
      break;
  }
  emit(session, { type: 'service', service: service.name, state: service.state, url: service.url, previewUrl: service.previewUrl, detail: service.detail });
}

function setStatus(session: Session, status: SessionStatus, error?: string): void {
  session.snapshot.status = status;
  session.snapshot.error = error;
  emit(session, { type: 'status', status, error });
  if (status === 'ready') {
    followLogs(session, 100);
    watchUsage(session);
    watchFiles(session);
  }
}

/** 서비스 안에서 명령이 만든 파일처럼 에이전트 도구를 거치지 않은 변경도 코드 화면이 다시 불러오게 한다 */
function watchFiles(session: Session): void {
  if (session.fileWatcher) return;
  try {
    session.fileWatcher = watchProjectFiles(session.project.root, (_files, renamed) => {
      if (session.stop.signal.aborted) return;
      session.snapshot.fileRevision = (session.snapshot.fileRevision ?? 0) + 1;
      emit(session, { type: 'files_changed', revision: session.snapshot.fileRevision });
      if (session.snapshot.workspace === 'local') relayChanges(session, renamed);
    });
  } catch (error) {
    // 감시하지 못해도 에이전트 쓰기와 요청 완료 때는 코드 화면이 계속 다시 불러온다
    console.error('[b-studio] 파일 변경을 감시하지 못했습니다', error);
  }
}

/** 옮겼다 되돌린 폴더의 변경 알림이 돌아오는 동안 같은 폴더를 다시 옮기지 않는다 */
const RELAY_ECHO_MS = 5_000;

/**
 * 내 폴더에서 IDE로 만들거나 지운 파일과 폴더를 서비스의 개발 서버가 알아채게 한다(트러블슈팅 29).
 * 요청·되돌리기·가져오기를 처리하는 중에는 검증 게이트의 반영 확인과 재시작에 끼어들지 않도록 건너뛴다. 그때는 게이트가 서비스를 다시 띄워 반영한다
 */
function relayChanges(session: Session, renamed: string[]): void {
  const { sandbox, snapshot } = session;
  if (!sandbox.relayChanges || snapshot.running || snapshot.status !== 'ready' || renamed.length === 0) return;
  const now = Date.now();
  for (const [file, at] of session.relayed) if (now - at > RELAY_ECHO_MS) session.relayed.delete(file);
  const changes = renamed.flatMap((file): FileChange[] => {
    if (session.relayed.has(file)) return [];
    const info = statSync(path.join(session.project.root, file), { throwIfNoEntry: false });
    return [{ file, kind: info === undefined ? 'deleted' : info.isDirectory() ? 'directory' : 'file' }];
  });
  if (changes.length === 0) return;
  for (const change of changes) if (change.kind === 'directory') session.relayed.set(change.file, now);

  session.relaying = session.relaying
    .then(async () => {
      const relayed = await sandbox.relayChanges!(changes, { signal: session.stop.signal });
      const at = new Date().toISOString();
      for (const [service, paths] of Map.groupBy(relayed, (entry) => entry.service)) {
        emit(session, { type: 'log', service, text: `[b-studio] 폴더에서 만들거나 지운 경로를 개발 서버에 알렸습니다: ${paths.map((entry) => entry.file).join(', ')}`, at });
      }
    })
    .catch((error: unknown) => {
      if (!session.stop.signal.aborted) console.error('[b-studio] 폴더의 변경을 서비스에 알리지 못했습니다', error);
    });
}

/** 샌드박스가 준비되면 컨테이너별 자원 사용량을 주기적으로 잰다. 실패하면 다음 주기에 다시 잰다 */
function watchUsage(session: Session): void {
  if (session.usageTimer) return;
  let measuring = false;
  const measure = async () => {
    if (measuring || session.stop.signal.aborted) return;
    measuring = true;
    try {
      const usage = { at: new Date().toISOString(), services: await session.sandbox.stats() };
      session.snapshot.usage = usage;
      emit(session, { type: 'usage', ...usage });
    } catch {
      // 재시작 중이면 컨테이너가 잠깐 없을 수 있다
    } finally {
      measuring = false;
    }
  };
  void measure();
  session.usageTimer = setInterval(() => void measure(), USAGE_INTERVAL_MS);
  session.usageTimer.unref();
}

function followLogs(session: Session, tail: number): void {
  session.logFollower?.abort();
  const follower = new AbortController();
  session.logFollower = follower;
  const signal = AbortSignal.any([follower.signal, session.stop.signal]);
  // 다시 붙을 때 --tail이 재시작하지 않은 컨테이너(DB, edge)의 줄까지 다시 보내므로 이미 받은 줄은 건너뛴다
  const isNew = skipAlreadySeen(session.logs.flatMap((event) => (event.type === 'log' ? [event] : [])));

  void (async () => {
    try {
      for await (const line of session.sandbox.logs({ signal, tail })) {
        const event = { type: 'log', service: line.service, text: line.text, at: line.at.toISOString() } as const;
        if (isNew(event)) emit(session, event);
      }
    } catch {
      // 구독을 다시 붙이거나 세션을 멈추면 끊기는 것이 정상이다
    }
  })();
}

function emit(session: Session, event: StudioEvent): void {
  // 사용량과 파일 변경 알림은 자주 오므로 기록에 쌓지 않는다. 새로 연결한 브라우저는 스냅샷에서 최신 값을 받는다
  const transient = event.type === 'usage' || event.type === 'files_changed' || event.type === 'tests_changed' || event.type === 'deploy_log';
  if (!transient) {
    const buffer = event.type === 'log' ? session.logs : session.history;
    buffer.push(event);
    const limit = event.type === 'log' ? LOG_LIMIT : HISTORY_LIMIT;
    if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
  }
  if (!transient && event.type !== 'log') {
    session.updatedAt = new Date().toISOString();
    schedulePersist(session);
  }
  for (const listener of session.listeners) listener(event);
}

function toPersisted(session: Session): PersistedSession {
  return {
    version: 1,
    savedAt: session.updatedAt,
    owner: { pid: process.pid },
    snapshot: session.snapshot,
    history: trimHistory(session.history),
    conversation: session.conversation.slice(0, session.settledConversation),
    demoIndex: session.demoIndex,
    claudeCode: session.claudeCode,
    design: session.design,
    codex: session.codex,
    commandCode: session.commandCode,
    openCode: session.openCode,
    gemini: session.gemini,
    sourceDirtyFiles: session.sourceDirtyFiles,
    sandbox: { id: session.sandbox.id, provider: session.provider },
    previewToken: session.previewToken,
  };
}

function schedulePersist(session: Session): void {
  if (session.persist.timer) return;
  session.persist.timer = setTimeout(() => void flushPersist(session), PERSIST_DELAY_MS);
  session.persist.timer.unref();
}

/** 쓰기를 차례로 이어 붙여 같은 임시 파일을 동시에 쓰지 않는다. 저장에 실패해도 세션은 계속한다 */
function flushPersist(session: Session): Promise<void> {
  clearTimeout(session.persist.timer);
  session.persist.timer = undefined;
  session.persist.chain = session.persist.chain
    .then(() => writeSession(toPersisted(session)))
    .catch((error: unknown) => console.error('[b-studio] 세션 상태를 저장하지 못했습니다', error));
  return session.persist.chain;
}

interface PreviewConfig {
  domain: string;
  port: number;
  bind: string;
}

/**
 * B_STUDIO_PREVIEW_DOMAIN을 정하면 원격 미리보기 게이트웨이를 켠다.
 * 기본 바인드 주소는 루프백이라, 다른 PC에 공개하려면 운영자가 B_STUDIO_PREVIEW_BIND를 명시해야 한다
 */
function previewConfig(): PreviewConfig | undefined {
  const domain = process.env.B_STUDIO_PREVIEW_DOMAIN?.trim().toLowerCase();
  if (!domain) return undefined;
  const port = Number(process.env.B_STUDIO_PREVIEW_PORT ?? 4100);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new StudioError(500, `B_STUDIO_PREVIEW_DOMAIN은 점이 들어간 호스트 이름, B_STUDIO_PREVIEW_PORT는 포트 번호여야 합니다 (지금 값: ${domain}, ${process.env.B_STUDIO_PREVIEW_PORT ?? 4100})`);
  }
  return { domain, port, bind: process.env.B_STUDIO_PREVIEW_BIND?.trim() || '127.0.0.1' };
}

/** HMR로 모듈이 다시 불러와져도 같은 포트를 두 번 열지 않도록 전역에 둔다 */
function ensurePreviewGateway(config: PreviewConfig): void {
  if (store.previewGateway) return;
  const server = createPreviewGateway({ domain: config.domain, resolve: resolvePreview, access: previewAccess() });
  server.on('error', (error) => console.error('[b-studio] 미리보기 게이트웨이를 열지 못했습니다', error));
  server.listen(config.port, config.bind);
  store.previewGateway = server;
}

/** 준비된 세션의 managed 서비스로만 넘긴다. 토큰은 시간 차로 추측하지 못하게 비교한다 */
async function resolvePreview(target: PreviewTarget): Promise<string | undefined> {
  const session = store.sessions.get(target.sessionId);
  if (!session || session.snapshot.status !== 'ready') return undefined;
  const expected = Buffer.from(session.previewToken);
  const given = Buffer.from(target.token);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  if (!session.project.managed.some(([name]) => name === target.service)) return undefined;
  return (await session.sandbox.endpoint(target.service)).url;
}

function previewUrlFor(session: Session, service: string): string | undefined {
  const config = previewConfig();
  if (!config) return undefined;
  return `http://${previewHost({ service, sessionId: session.snapshot.id, token: session.previewToken }, config.domain)}:${config.port}`;
}

/** 티켓은 iframe이 곧바로 여는 데만 쓰므로 짧게 둔다 */
const PREVIEW_TICKET_MS = 60_000;

/**
 * 스튜디오 인증을 켰을 때 게이트웨이의 접근 확인. 인증을 끈 개인 PC에서는 호스트 이름의 토큰만으로 연다.
 * 티켓은 한 번만 쓰도록 사용한 값을 만료 때까지 기억하고, 확인 중 오류가 나면 열지 않는 쪽으로 실패한다
 */
function previewAccess(): PreviewAccess | undefined {
  if (authConfig().mode === 'none') return undefined;
  const used = (store.previewTickets ??= new Map());
  return {
    cookieName: PREVIEW_COOKIE,
    redeem(host, ticket) {
      const now = Date.now();
      for (const [nonce, expiresAt] of used) if (expiresAt <= now) used.delete(nonce);
      try {
        const config = authConfig();
        const grant = verifyPreviewGrant(ticket, 'ticket', host, config, now, readRevocations());
        if (!grant?.nonce || used.has(grant.nonce)) return undefined;
        used.set(grant.nonce, grant.expiresAt);
        // 미리보기 쿠키가 스튜디오 로그인보다 오래가지 않게 한다
        const expiresAt = Math.min(now + config.sessionHours * 3_600_000, grant.sessionExpiresAt ?? Number.POSITIVE_INFINITY);
        const cookie = signPreviewGrant('cookie', { host: grant.host, user: grant.user, sid: grant.sid, issuedAt: now, expiresAt }, config);
        return { cookie, maxAgeSeconds: Math.max(1, Math.floor((expiresAt - now) / 1_000)) };
      } catch (error) {
        console.error('[b-studio] 미리보기 티켓을 확인하지 못했습니다', error);
        return undefined;
      }
    },
    allows(host, cookie) {
      try {
        return verifyPreviewGrant(cookie, 'cookie', host, authConfig(), Date.now(), readRevocations()) !== undefined;
      } catch (error) {
        console.error('[b-studio] 미리보기 쿠키를 확인하지 못했습니다', error);
        return false;
      }
    },
  };
}

/** 미리보기 iframe이 열 주소. 인증을 켰으면 게이트웨이가 그 호스트 전용 쿠키로 바꿔 줄 1회용 티켓을 붙인다 */
export function previewAccessUrl(id: string, service: string, requestedPath: string, viewer: { user: string; sid?: string; sessionExpiresAt?: number }): string {
  const session = requireSession(id);
  const base = session.snapshot.services.find((candidate) => candidate.name === service)?.previewUrl;
  if (!base) throw new StudioError(409, `${service} 서비스의 미리보기 주소가 없습니다. 원격 미리보기를 켜고 서비스가 준비된 뒤 다시 여세요`);
  const target = safePreviewPath(requestedPath);
  const config = authConfig();
  if (config.mode === 'none') return new URL(target, base).toString();
  const url = new URL(ACCESS_PATH, base);
  const now = Date.now();
  const ticket = signPreviewGrant(
    'ticket',
    { host: url.hostname, user: viewer.user, sid: viewer.sid, issuedAt: now, expiresAt: now + PREVIEW_TICKET_MS, nonce: randomBytes(16).toString('hex'), sessionExpiresAt: viewer.sessionExpiresAt },
    config,
  );
  url.searchParams.set('ticket', ticket);
  url.searchParams.set('next', target);
  return url.toString();
}

function requireSession(id: string): Session {
  const session = store.sessions.get(id);
  if (session) return session;
  if (archived.has(id)) throw new StudioError(409, '중지된 세션입니다. 이어서 작업하면 새 샌드박스를 띄웁니다');
  throw new StudioError(404, '세션을 찾을 수 없습니다');
}

function demoScenarios(project: LoadedProject): readonly DemoScenario[] {
  return project.spec.name === 'orders' ? ORDERS_DEMO_SCENARIOS : [];
}

/**
 * 지금 서버 모드. 오타가 조용히 다른 모드(특히 비용이 드는 모드)로 떨어지지 않도록 모르는 값은 거부한다.
 * capabilities가 같은 값을 읽어 "지금 쓸 수 있는 방식"을 알린다 — 두 곳이 갈라지지 않게 한 곳에서 읽는다
 */
export function sessionMode(env: Record<string, string | undefined> = process.env): SessionMode {
  const value = env.B_STUDIO_MODE?.trim();
  if (!value || value === 'api') return 'api';
  if (value === 'claude-code' || value === 'codex' || value === 'commandcode' || value === 'opencode' || value === 'gemini' || value === 'demo') return value;
  throw new StudioError(500, `B_STUDIO_MODE는 api, claude-code, codex, commandcode, opencode, gemini, demo 중 하나여야 합니다 (지금 값: ${value})`);
}

/** 세션 백엔드로 고를 수 있는 값(demo 제외). 서버 모드는 기본값이고 B_STUDIO_BACKENDS가 허용 목록을 넓힌다 */
export const SESSION_BACKENDS = ['api', 'claude-code', 'codex', 'commandcode', 'opencode', 'gemini'] as const;

/**
 * 이 서버에서 쓸 수 있는 백엔드. 서버 모드는 언제나 포함하고(계획 기본·통합 세션) B_STUDIO_BACKENDS가 더한다.
 * 비우면 서버 모드 하나뿐이라 지금과 한 글자도 다르지 않다. demo면 고를 수 없다(데모는 섞지 않는다).
 */
/**
 * 저장된 세션을 이어서 돌려도 되는 백엔드인지 확인하고 그 백엔드를 돌려준다. 지금 서버가 허용하지 않으면 409.
 * 저장된 backend가 없는 옛 기록은 만들 때의 서버 모드(mode)로 본다
 */
export function assertResumableBackend(
  snapshot: Pick<SessionSnapshot, 'mode' | 'backend'>,
  serverMode: SessionMode = sessionMode(),
  env: Record<string, string | undefined> = process.env,
): SessionMode {
  const backend = sessionBackend(snapshot);
  if (!allowedBackends(serverMode, env).has(backend)) {
    throw new StudioError(
      409,
      `이 세션은 ${backend} 백엔드로 만들었는데, 지금 스튜디오는 이 백엔드를 허용하지 않습니다. B_STUDIO_MODE=${backend}로 실행하거나 B_STUDIO_BACKENDS에 ${backend}를 넣은 뒤 이어서 작업하세요`,
    );
  }
  return backend;
}

export function allowedBackends(serverMode: SessionMode = sessionMode(), env: Record<string, string | undefined> = process.env): Set<SessionMode> {
  if (serverMode === 'demo') return new Set<SessionMode>(['demo']);
  const allowed = new Set<SessionMode>([serverMode]);
  for (const raw of (env.B_STUDIO_BACKENDS ?? '').split(',')) {
    const value = raw.trim();
    if (!value) continue;
    if (!(SESSION_BACKENDS as readonly string[]).includes(value)) {
      throw new StudioError(500, `B_STUDIO_BACKENDS에 알 수 없는 백엔드가 있습니다: ${value} (api, claude-code, codex, commandcode, opencode, gemini)`);
    }
    allowed.add(value as SessionMode);
  }
  return allowed;
}

/**
 * 세션 백엔드를 확정한다. 요청이 없으면 서버 모드, 있으면 허용 목록에서만 받는다(HTTP 400).
 * demo 서버에서는 백엔드를 고를 수 없다(데모는 섞지 않는다).
 */
export function resolveSessionBackend(requested: string | undefined, env: Record<string, string | undefined> = process.env): SessionMode {
  const serverMode = sessionMode(env);
  const allowed = allowedBackends(serverMode, env);
  if (serverMode === 'demo') {
    // 라우트가 확정한 값('demo')을 createSession이 다시 확정하므로, 같은 값은 통과시켜야 한다(두 번 불러도 같은 결과).
    // 이 검사가 없던 때 데모 서버에서 세션을 하나도 만들 수 없었다(#128 화면 확인에서 발견)
    if (requested && requested !== 'demo') throw new StudioError(400, '데모 모드에서는 백엔드를 고를 수 없습니다');
    return 'demo';
  }
  if (!requested) return serverMode;
  if (!allowed.has(requested as SessionMode)) {
    throw new StudioError(400, `이 서버에서 쓸 수 없는 백엔드입니다: ${requested} (쓸 수 있는 백엔드: ${[...allowed].join(', ')})`);
  }
  return requested as SessionMode;
}

/** 이 세션이 실제로 쓰는 백엔드. 이 필드가 생기기 전 기록은 mode를 쓴다(그때 mode가 곧 서버 모드였다) */
export function sessionBackend(snapshot: Pick<SessionSnapshot, 'mode' | 'backend'>): SessionMode {
  return snapshot.backend ?? snapshot.mode;
}

/**
 * CLI 러너에 넘길 모델. 레인 세션은 고른 모델을 snapshot.modelId에 담는다(예: `sonnet`).
 * 계획의 기록용 id(`local-cli:...`)는 실제 모델 이름이 아니므로 넘기지 않고 환경 변수로 떨어진다.
 */
export function cliModelOverride(modelId: string | undefined): string | undefined {
  const value = modelId?.trim();
  return value && !value.startsWith('local-cli') ? value : undefined;
}

export interface BackendPreflights {
  claudeCode?: (input: { cwd: string }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  codex?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  commandCode?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  openCode?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  gemini?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
}

/**
 * CLI 백엔드는 세션을 만들기 전에 로그인을 확인한다. 실패하면 샌드박스를 띄우지 않고 이유를 돌려준다.
 * 확인 함수를 주입할 수 있게 빼 두어(테스트) 실제 CLI를 부르지 않고 검사할 수 있다.
 */
export async function assertBackendReady(backend: SessionMode, cwd: string, preflights: BackendPreflights = {}): Promise<void> {
  if (backend === 'claude-code') {
    const result = await (preflights.claudeCode ?? preflightClaudeCode)({ cwd });
    if (!result.ok) throw new StudioError(409, `로컬 Claude Code를 쓸 수 없습니다: ${result.reason}`);
    return;
  }
  if (backend === 'codex') {
    const result = await (preflights.codex ?? preflightCodex)();
    if (!result.ok) throw new StudioError(409, `로컬 Codex를 쓸 수 없습니다: ${result.reason}`);
    return;
  }
  if (backend === 'commandcode') {
    const result = await (preflights.commandCode ?? preflightCommandCode)();
    if (!result.ok) throw new StudioError(409, `로컬 Command Code를 쓸 수 없습니다: ${result.reason}`);
    return;
  }
  if (backend === 'opencode') {
    const result = await (preflights.openCode ?? preflightOpenCode)();
    if (!result.ok) throw new StudioError(409, `로컬 OpenCode를 쓸 수 없습니다: ${result.reason}`);
    return;
  }
  if (backend === 'gemini') {
    const result = await (preflights.gemini ?? preflightGemini)();
    if (!result.ok) throw new StudioError(409, `로컬 Gemini를 쓸 수 없습니다: ${result.reason}`);
  }
}

/** 운영자가 정한 세션 토큰 한도. 잘못 적은 값이 "한도 없음"으로 넘어가지 않도록 샌드박스를 만들기 전에 거부한다 */
function sessionTokenLimit(): number | undefined {
  try {
    return parseTokenLimit(process.env.B_STUDIO_SESSION_TOKEN_LIMIT);
  } catch (error) {
    throw new StudioError(500, describe(error));
  }
}

function sessionsRoot(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.B_STUDIO_SESSIONS_DIR ?? path.join(homedir(), '.cache/b-studio/sessions'));
}

/**
 * 스튜디오 서버가 종료 신호를 받으면 샌드박스 정리 명령을 따로 띄워 두고 마지막 상태를 남긴다.
 * next dev는 신호를 넘긴 자식 프로세스를 100ms 뒤 강제 종료하므로(NEXT_EXIT_TIMEOUT_MS) 정리를 기다릴 수 없다.
 * 상태를 중지로 바꾸지 않으므로, 따로 띄운 정리가 실패해도 다음 실행의 복구가 다시 정리한다
 */
function registerCleanup(): void {
  if (store.cleanupRegistered) return;
  store.cleanupRegistered = true;

  let cleaning = false;
  const cleanup = (signal: NodeJS.Signals) => {
    // 터미널의 Ctrl+C와 next dev가 넘긴 신호가 함께 온다
    if (cleaning) return;
    cleaning = true;
    // 남은 원격 브라우저 프로세스를 함께 내린다. 기다릴 수 없으므로 최선 노력으로 끝낸다
    void closeAllRemoteBrowsers();
    void closeAllServicePreviewProxies();
    for (const session of store.sessions.values()) {
      if (session.snapshot.status === 'stopped') continue;
      session.stop.abort();
      clearTimeout(session.persist.timer);
      try {
        const command = providerFromEnv().cleanupCommand?.(session.sandbox.id);
        if (command) {
          // 새 프로세스 그룹으로 띄워 터미널의 신호와 스튜디오의 강제 종료가 닿지 않게 한다
          const child = spawn(command.command, command.args, { cwd: tmpdir(), detached: true, stdio: 'ignore' });
          child.on('error', (error) => console.error('[b-studio] 샌드박스 정리 명령을 실행하지 못했습니다', error));
          child.unref();
        }
        writeSessionSync(toPersisted(session));
      } catch (error) {
        console.error('[b-studio] 종료할 때 세션을 정리하지 못했습니다', session.snapshot.id, error);
      }
    }
    // Next의 신호 처리를 끈 실행(NEXT_MANUAL_SIG_HANDLE)에서는 직접 끝낸다
    if (process.env.NEXT_MANUAL_SIG_HANDLE) process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));
}
