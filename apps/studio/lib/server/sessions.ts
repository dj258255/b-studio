import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import type { Server } from 'node:http';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  AnthropicModelClient,
  buildPullRequest,
  canCreatePullRequest,
  captureBaselines,
  CheckpointError,
  CheckpointStore,
  compareUrl,
  createPullRequest,
  DatabaseBranches,
  describeDatabaseState,
  formatVerificationReport,
  ORDERS_DEMO_SCENARIOS,
  parseRemote,
  preflightClaudeCode,
  RemoteConflictError,
  restartServicesFor,
  runAgent,
  runClaudeCodeAgent,
  ScriptedModelClient,
  verifyChanges,
  Workspace,
  type AgentEvent,
  type AgentResult,
  type AgentUsage,
  type Checkpoint,
  type DatabaseState,
  type DemoScenario,
  type GitAuthor,
  type ModelClient,
  type RemoteSyncResult,
  type ServiceCheck,
  type VerificationReport,
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
import { loadProject, type LoadedProject } from '@b-studio/spec';
import { skipAlreadySeen } from '@/lib/logs';
import { addTokens, formatTokenCount, hasTokens, parseTokenLimit, totalTokens } from '@/lib/usage';
import type {
  CodeFile,
  CodeSearch,
  CodeTree,
  ExportResult,
  ProxyResponse,
  RepositoryView,
  SessionMode,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
  StudioEvent,
  WorkspaceKind,
} from '@/lib/studio-events';
import { authConfig, PREVIEW_COOKIE, signPreviewGrant, verifyPreviewGrant } from './auth';
import { readRevocations } from './auth-state';
import { searchFiles, walkFiles } from './code-files';
import { describe, StudioError } from './errors';
import { isDeniedPath, watchProjectFiles, type FileWatcher } from './file-watch';
import { ACCESS_PATH, createPreviewGateway, previewHost, safePreviewPath, type PreviewAccess, type PreviewTarget } from './preview-gateway';
import { findProject } from './projects';
import {
  archivedSnapshot,
  closeUnfinished,
  isProcessAlive,
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
  /** 사용자가 요청을 취소하면 abort한다. 에이전트가 끝나 체크포인트를 남기기 시작하면 세션에서 떼어 더는 취소를 받지 않는다 */
  cancel: AbortController;
  /** 요청을 시작할 때의 세션 토큰 합계 */
  baseTokens?: AgentUsage;
  tokens: AgentUsage;
  /** 요청을 멈춘 이유. 사용자가 취소했거나 세션 토큰 한도에 도달했다 */
  stopReason?: 'user' | 'budget';
}

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
  };
  /** 원본에서 커밋하지 않아 세션에 들어가지 않은 변경 수 */
  sourceDirtyFiles: number;
  /** 원격에 올리는 동안에는 새 요청과 되돌리기를 받지 않는다 */
  exporting: boolean;
  run?: ActiveRun;
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
    projectName: snapshot.projectName,
    status: snapshot.status,
    mode: snapshot.mode,
    owner: snapshot.owner,
    workspace: snapshot.workspace ?? 'copy',
    checkpoints: snapshot.checkpoints.length,
    lastRequest: lastRequest?.type === 'run_started' ? lastRequest.request : undefined,
    updatedAt,
  };
}

export async function createSession(projectId: string, owner: string, workspace: WorkspaceKind = 'copy'): Promise<SessionSnapshot> {
  const mode = sessionMode();
  const tokenLimit = sessionTokenLimit();
  const preview = previewConfig();
  if (workspace === 'local') assertLocalFolderAllowed();
  const source = await findProject(projectId);
  if (!source) throw new StudioError(404, '프로젝트를 찾을 수 없습니다');
  // 이전 프로세스가 남긴 샌드박스를 먼저 정리해 새 세션과 자원을 다투지 않게 한다
  await recoverSessions();
  const release = workspace === 'local' ? claimFolder(source.root) : undefined;
  try {
    return await startSession({ projectId, owner, workspace, source, mode, tokenLimit, preview });
  } finally {
    // 세션을 만든 뒤에는 실행 중인 세션 목록이 같은 폴더를 막는다
    release?.();
  }
}

async function startSession({
  projectId,
  owner,
  workspace,
  source,
  mode,
  tokenLimit,
  preview,
}: {
  projectId: string;
  owner: string;
  workspace: WorkspaceKind;
  source: LoadedProject;
  mode: SessionMode;
  tokenLimit: number | undefined;
  preview: PreviewConfig | undefined;
}): Promise<SessionSnapshot> {
  const id = randomUUID().slice(0, 8);
  const sessionDir = path.join(sessionsRoot(), `${projectId}-${id}`);

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
    if (await CheckpointStore.inspectSource(source.root, { allowSubfolder })) {
      // 원본이 Git 저장소면 커밋된 상태를 복제해 세션 브랜치에서 작업한다. 체크포인트가 곧 원격에 올릴 커밋이 된다
      const cloned = await CheckpointStore.clone(source.root, workDir, { branch: `b-studio/${projectId}-${id}`, author, allowSubfolder });
      checkpoints = cloned.store;
      firstCheckpoint = cloned.start;
      sourceDirtyFiles = cloned.source.dirtyFiles;
    } else {
      await cp(source.root, workDir, { recursive: true, filter: (file) => !GENERATED.test(file) });
      checkpoints = new CheckpointStore(workDir, { author });
      firstCheckpoint = await checkpoints.init('세션 시작');
    }
  }

  const project = await loadProject(await checkpoints.projectRoot());
  const repository = await describeRepository(checkpoints, sourceDirtyFiles);
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
      status: 'starting',
      mode,
      running: false,
      tokenLimit,
      owner,
      ...projectViews(project),
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
    sourceDirtyFiles,
    previewToken: randomBytes(16).toString('hex'),
  });

  store.sessions.set(id, session);
  registerCleanup();
  if (preview) ensurePreviewGateway(preview);
  // 기동 도중에 서버가 멈춰도 다음 실행에서 샌드박스를 찾아 정리할 수 있도록 바로 남긴다
  void flushPersist(session);
  void boot(session);
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
  | 'sourceDirtyFiles'
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

function projectViews(project: LoadedProject): Pick<SessionSnapshot, 'services' | 'externals'> {
  return {
    services: project.managed.map(([name, service]) => ({
      name,
      template: service.template,
      preview: service.preview,
      state: 'starting',
      hasContract: Boolean(service.contract),
    })),
    externals: (project.external ?? []).map(([name, service]) => ({
      name,
      baseUrl: service.baseUrl,
      access: service.policy.allow
        ? service.policy.allow.map((rule) => `${rule.callers.join(', ')}: ${rule.methods.join('/')} ${rule.paths.join(', ')}`)
        : ['모든 호출자: GET/HEAD'],
      mask: service.policy.mask,
      authenticated: Boolean(service.policy.auth),
    })),
  };
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
  listener({ type: 'snapshot', snapshot: target.snapshot });
  for (const event of target.history) listener(event);
  if ('logs' in target) for (const event of target.logs) listener(event);
}

export function sendMessage(
  id: string,
  text: string,
  { allowBreaking, by, intent = 'build' }: { allowBreaking: boolean; by?: string; intent?: Intent },
): { runId: string } {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 요청할 수 있습니다');
  if (session.snapshot.running) throw new StudioError(409, '이전 요청을 처리하는 중입니다');
  if (session.exporting) throw new StudioError(409, '원격 저장소에 올리는 중입니다');

  const request = text.trim();
  if (!request) throw new StudioError(400, '요청 내용을 입력하세요');
  const limit = session.snapshot.tokenLimit;
  if (limit !== undefined && totalTokens(session.snapshot.tokens) >= limit) {
    throw new StudioError(409, `이 세션은 토큰 한도(${formatTokenCount(limit)})에 도달해 새 요청을 받지 않습니다. 새 세션을 시작해 이어서 작업하세요`);
  }

  const plan = planRun(session, request, allowBreaking, intent);
  const run: ActiveRun = {
    id: randomUUID().slice(0, 8),
    cancel: new AbortController(),
    baseTokens: session.snapshot.tokens,
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
  session.run = run;
  session.snapshot.running = true;
  emit(session, { type: 'run_started', runId: run.id, request, by, intent: intent === 'ask' ? 'ask' : undefined });
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

export async function stopSession(id: string): Promise<SessionSnapshot> {
  const session = requireSession(id);
  if (session.snapshot.status === 'stopped') return session.snapshot;
  session.stop.abort();
  session.logFollower?.abort();
  clearInterval(session.usageTimer);
  session.fileWatcher?.close();
  await session.sandbox.destroy().catch(() => {});
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

    const mode = sessionMode();
    // 이어서 작업하는 세션도 지금 스튜디오 서버에 설정한 한도를 따른다
    const tokenLimit = sessionTokenLimit();
    if (data.snapshot.mode !== mode) {
      throw new StudioError(409, `이 세션은 ${data.snapshot.mode} 모드로 만들었습니다. B_STUDIO_MODE=${data.snapshot.mode}로 스튜디오를 실행한 뒤 이어서 작업하세요`);
    }
    const { workDir } = data.snapshot;
    const local = data.snapshot.workspace === 'local';
    if (local) assertLocalFolderAllowed();
    if (!(await stat(workDir).then((info) => info.isDirectory(), () => false))) {
      throw new StudioError(409, `${local ? '내 폴더가' : '작업 복사본이'} 없어 이어서 작업할 수 없습니다: ${workDir}`);
    }
    if (local) release = claimFolder(workDir, id);

    const checkpoints = new CheckpointStore(workDir, { author: gitAuthor(), ...(local ? { gitDir: path.join(stateDirOf(data.snapshot), '.git') } : {}) });
    const project = await loadProject(await checkpoints.projectRoot());
    const secrets = await resolveSecrets(project);
    const previous = (await checkpoints.list())[0]!;
    let discarded: string[] = [];
    let localEdits: Checkpoint | undefined;
    if (local) {
      // 샌드박스를 멈춘 동안 IDE에서 고친 파일일 수 있어 버리지 않고 체크포인트로 남긴다
      const redactor = new Redactor(secrets);
      localEdits = await commitLocalEdits(checkpoints, (text) => redactor.find(text)).catch((error: unknown) => {
        throw new StudioError(409, `폴더에서 바뀐 파일을 체크포인트로 남기지 못해 이어서 작업하지 않았습니다: ${describe(error)}`);
      });
      if (localEdits) history = [...history, { type: 'local_edits_saved', checkpoint: localEdits, reason: 'resume' }];
    } else {
      // 끝내지 못한 요청이 남긴 변경은 검증 게이트를 통과하지 않았으므로 버리고 마지막 체크포인트에서 시작한다
      ({ files: discarded } = await checkpoints.discard());
    }
    const list = await checkpoints.list();
    const head = list[0]!;
    const provider = providerFromEnv();
    const sandbox = await provider.create(project, { secrets });

    const session = newSession({
      snapshot: {
        ...data.snapshot,
        ...projectViews(project),
        status: 'starting',
        error: undefined,
        running: false,
        cancelling: undefined,
        tokenLimit,
        usage: undefined,
        runtime: provider.isolation,
        checkpoints: list,
        repository: await describeRepository(checkpoints, data.sourceDirtyFiles),
        nextDemoRequest: mode === 'demo' ? demoScenarios(project)[data.demoIndex]?.request : undefined,
        nextDemoQuestion: mode === 'demo' ? demoScenarios(project)[data.demoIndex]?.question?.request : undefined,
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
      claudeCode: { sessionId: data.claudeCode.sessionId, notes: [...data.claudeCode.notes] },
      sourceDirtyFiles: data.sourceDirtyFiles,
      // 이어서 작업해도 열어 둔 미리보기 주소가 그대로 동작하게 같은 토큰을 쓴다
      previewToken: data.previewToken ?? randomBytes(16).toString('hex'),
    });

    // 샌드박스가 바뀌었다는 사실과 버린 변경을 다음 요청에서 알 수 있게 대화에 남긴다
    const note = [
      `[b-studio] 세션을 새 샌드박스에서 이어서 시작했습니다. ${local ? '작업 폴더와' : '작업 복사본과'} 데이터베이스는 체크포인트 ${head.shortSha}("${head.message}") 상태입니다.`,
      ...(discarded.length > 0 ? [`체크포인트에 없던 변경 ${discarded.length}개는 버렸습니다: ${discarded.slice(0, 20).join(', ')}`] : []),
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
    void boot(session, { discarded, databaseFrom: localEdits ? previous.sha : undefined });
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

    const interrupted = data.snapshot.status !== 'stopped';
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
 * resumed가 있으면 이어서 작업하는 세션이다. 새 샌드박스의 데이터베이스를 마지막 체크포인트 상태로 맞춘다.
 * databaseFrom은 이어서 작업하기 전에 폴더의 수정을 새 체크포인트로 남겼을 때, 데이터베이스 상태를 가져올 그 앞 체크포인트다
 */
async function boot(session: Session, resumed?: { discarded: string[]; databaseFrom?: string }): Promise<void> {
  const signal = session.stop.signal;
  const onStatus = (event: ServiceStatusEvent) => onServiceStatus(session, event);
  try {
    await session.sandbox.start({
      signal,
      onStatus,
      // 스냅샷 사용 여부는 로그 탭에서 서비스 로그와 함께 보여 준다
      onSnapshot: (event) =>
        emit(session, { type: 'log', service: event.service, text: `[b-studio] ${describeSnapshotEvent(event)}`, at: new Date().toISOString() }),
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
      emit(session, { type: 'resumed', checkpoint: head, discarded: resumed.discarded, databases: database.states, restarted });
    }
    setStatus(session, 'ready');
  } catch (error) {
    if (!signal.aborted) setStatus(session, 'failed', describe(error));
  }
}

/** build: 파일을 바꾸고 검증 게이트를 거치는 요청, ask: 파일을 바꾸지 않고 답과 계획만 받는 질문 */
type Intent = 'build' | 'ask';

type RunPlan =
  | { kind: 'model'; client: ModelClient; allowBreaking: boolean; maxVerifyAttempts?: number; intent: Intent }
  | { kind: 'claude-code'; allowBreaking: boolean; intent: Intent };

function planRun(session: Session, request: string, allowBreaking: boolean, intent: Intent): RunPlan {
  if (session.snapshot.mode === 'api') return { kind: 'model', client: new AnthropicModelClient(), allowBreaking, intent };
  if (session.snapshot.mode === 'claude-code') return { kind: 'claude-code', allowBreaking, intent };

  // 데모 모드는 스크립트이므로 준비된 요청과 질문만 순서대로 실행한다. 다른 요청을 받은 척하지 않는다
  const scenario = demoScenarios(session.project)[session.demoIndex];
  if (intent === 'ask') {
    const question = scenario?.question;
    if (!question) throw new StudioError(409, '데모 모드에서 지금 물어볼 수 있는 준비된 질문이 없습니다');
    if (question.request !== request) throw new StudioError(409, `데모 모드는 준비된 질문에만 답합니다. 지금 질문: "${question.request}"`);
    return { kind: 'model', client: new ScriptedModelClient(question.turns), allowBreaking: false, intent };
  }
  if (!scenario) throw new StudioError(409, '데모 모드에서 실행할 수 있는 요청을 모두 실행했습니다');
  if (scenario.request !== request) {
    throw new StudioError(409, `데모 모드는 준비된 요청을 순서대로 실행합니다. 다음 요청: "${scenario.request}"`);
  }
  return {
    kind: 'model',
    client: new ScriptedModelClient(scenario.turns),
    allowBreaking: scenario.allowBreaking ?? false,
    maxVerifyAttempts: scenario.maxVerifyAttempts,
    intent,
  };
}

async function execute(session: Session, run: ActiveRun, request: string, plan: RunPlan): Promise<void> {
  const signal = AbortSignal.any([session.stop.signal, run.cancel.signal]);
  let finished: Pick<Extract<StudioEvent, { type: 'run_finished' }>, 'status' | 'summary' | 'turns'> | undefined;
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
    const result = await runPlan(session, run, request, plan, signal);
    // 취소를 받은 직후 에이전트가 먼저 끝났어도 사용자가 원한 대로 되돌린다
    if (run.cancel.signal.aborted) throw run.cancel.signal.reason;
    session.run = undefined;
    if ('preflightError' in result) {
      finished = { status: 'error', summary: result.preflightError };
      return;
    }

    if (!ask) {
      // 게이트를 통과한 변경만 체크포인트로 남기고, 통과하지 못한 변경은 되돌려 샌드박스를 이전 상태로 맞춘다
      if (result.status === 'done') await saveCheckpoint(session, run.id, request, checkpointBody(result, plan.allowBreaking));
      else await revertRun(session, run.id);
    }
    finished = { status: result.status, summary: result.summary, turns: result.turns };
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
    if (!session.stop.signal.aborted && !ask) {
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
    // 데모 시나리오는 앞 단계의 파일을 전제로 하므로, 취소해 되돌린 요청은 다시 보낼 수 있게 남긴다
    if (session.snapshot.mode === 'demo' && !cancelled && !notStarted && !ask) {
      session.demoIndex += 1;
      session.snapshot.nextDemoRequest = demoScenarios(session.project)[session.demoIndex]?.request;
      session.snapshot.nextDemoQuestion = demoScenarios(session.project)[session.demoIndex]?.question?.request;
    }
    session.snapshot.running = false;
    session.snapshot.cancelling = undefined;
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

/** 멈춘 이유와 되돌린 결과. revertError가 있으면 되돌리지 못했다 */
function stoppedSummary(run: ActiveRun, limit: number | undefined, reverted: string[] | undefined, revertError: unknown): string {
  if (run.stopReason === 'budget') {
    const reason = `세션 토큰 한도(${formatTokenCount(limit ?? 0)})에 도달해 요청을 멈췄습니다`;
    if (!reverted) return `${reason}. 변경을 되돌리지 못했습니다: ${describe(revertError)}`;
    return reverted.length > 0 ? `${reason}. 바뀐 파일 ${reverted.length}개를 되돌렸습니다` : `${reason}. 바뀐 파일은 없었습니다`;
  }
  if (!reverted) return `요청을 취소했지만 변경을 되돌리지 못했습니다: ${describe(revertError)}`;
  return reverted.length > 0 ? `요청을 취소하고 바뀐 파일 ${reverted.length}개를 되돌렸습니다` : '요청을 취소했습니다. 바뀐 파일은 없었습니다';
}

/** 질문은 되돌릴 변경이 없으므로 멈춘 이유만 알린다 */
function stoppedQuestionSummary(run: ActiveRun, limit: number | undefined): string {
  return run.stopReason === 'budget' ? `세션 토큰 한도(${formatTokenCount(limit ?? 0)})에 도달해 질문을 멈췄습니다` : '질문을 취소했습니다';
}

/** 샌드박스를 건드리기 전에 인증부터 확인하고, 모드에 맞는 에이전트로 요청을 처리한다 */
async function runPlan(session: Session, run: ActiveRun, request: string, plan: RunPlan, signal: AbortSignal): Promise<AgentResult | { preflightError: string }> {
  const shared = {
    project: session.project,
    sandbox: session.sandbox,
    allowBreaking: plan.allowBreaking,
    intent: plan.intent,
    signal,
    onEvent: (event: AgentEvent) => {
      if (event.type !== 'tokens') return emit(session, { type: 'agent', runId: run.id, event });
      run.tokens = event.usage;
      // 스크립트 모델(데모 모드)은 토큰을 쓰지 않으므로 기록을 늘리지 않는다
      if (!hasTokens(event.usage)) return;
      // 서버가 요청 도중에 멈춰도 그때까지 쓴 양이 세션 파일에 남도록 합계를 바로 바꾼다
      session.snapshot.tokens = addTokens(run.baseTokens, event.usage);
      emit(session, { type: 'tokens', runId: run.id, usage: event.usage, sessionTokens: session.snapshot.tokens });
      const limit = session.snapshot.tokenLimit;
      // 게이트 실패를 되풀이하는 요청이 한도를 넘어 계속 토큰을 쓰지 않도록, 넘는 순간 멈추고 되돌린다
      if (limit !== undefined && totalTokens(session.snapshot.tokens) >= limit && !run.cancel.signal.aborted) {
        run.stopReason = 'budget';
        session.snapshot.cancelling = 'budget';
        emit(session, { type: 'run_cancelling', runId: run.id, reason: 'budget' });
        run.cancel.abort(new DOMException('세션 토큰 한도에 도달했습니다', 'AbortError'));
      }
    },
    onServiceStatus: (event: ServiceStatusEvent) => onServiceStatus(session, event),
  };

  if (plan.kind === 'claude-code') {
    const preflight = await preflightClaudeCode({ cwd: session.project.root });
    if (!preflight.ok) return { preflightError: preflight.reason };

    const { claudeCode } = session;
    const result = await runClaudeCodeAgent({
      ...shared,
      request: [...claudeCode.notes, request].join('\n\n'),
      resume: claudeCode.sessionId,
      account: preflight.account,
    });
    // 예외로 끝나면 여기까지 오지 않으므로 이전 세션과 알림이 그대로 남아 다음 요청이 이어받는다
    claudeCode.notes = [];
    if (result.sessionId) claudeCode.sessionId = result.sessionId;
    return result;
  }

  if (plan.client instanceof AnthropicModelClient) {
    const preflight = await plan.client.preflight();
    if (!preflight.ok) return { preflightError: preflight.reason };
  }
  return runAgent({
    ...shared,
    request,
    client: plan.client,
    conversation: session.conversation,
    maxVerifyAttempts: plan.maxVerifyAttempts,
  });
}

/** PR 리뷰어가 요청마다 무엇을 확인했는지 볼 수 있도록 검증 결과와 에이전트 요약을 커밋 본문에 남긴다 */
function checkpointBody(result: AgentResult, allowBreaking: boolean): string {
  const sections: string[] = [];
  if (result.report) sections.push(formatVerificationReport(result.report, { allowBreaking }));
  if (result.verifyAttempts > 0) sections.push(`검증 게이트 재시도: ${result.verifyAttempts}회`);
  const summary = result.summary.trim();
  if (summary) sections.push(`에이전트 요약:\n${summary.split('\n').slice(0, 30).join('\n')}`);
  return sections.join('\n\n');
}

async function saveCheckpoint(session: Session, runId: string, request: string, body: string): Promise<void> {
  const head = session.snapshot.checkpoints[0]!.sha;
  // 파일은 그대로여도 데이터만 바꾼 요청은 체크포인트로 남겨야 다음 되돌리기에서 사라지지 않는다
  const dataOnly =
    session.databases.enabled &&
    (await session.checkpoints.pendingFiles()).length === 0 &&
    (await session.databases.changedSince(head, session.stop.signal));
  const checkpoint = await session.checkpoints.commit(`요청: ${request}`, body, {
    allowEmpty: dataOnly,
    findSecrets: (text) => session.sandbox.findSecrets(text),
  });
  if (!checkpoint) return;
  await saveDatabases(session, checkpoint.sha);
  session.snapshot.checkpoints = [checkpoint, ...session.snapshot.checkpoints];
  emit(session, { type: 'checkpoint', runId, checkpoint });
}

/** 되돌린 파일을 돌려준다. alsoRestart는 파일과 상관없이 다시 띄울 서비스다 */
async function revertRun(
  session: Session,
  runId: string,
  { cancelled = false, alsoRestart = [] }: { cancelled?: boolean; alsoRestart?: string[] } = {},
): Promise<string[]> {
  const { files, patch } = await session.checkpoints.discard();
  // 실패한 요청이 실행한 마이그레이션과 데이터 변경도 마지막 체크포인트 시점으로 되돌린다
  const database = await session.databases.restore(session.snapshot.checkpoints[0]!.sha, session.stop.signal);
  const databaseTouched = database.states.some((state) => state.action === 'restored' || state.action === 'failed');
  if (files.length === 0 && !databaseTouched && alsoRestart.length === 0) return files;

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

/** 로컬 폴더 세션은 에이전트가 서버의 프로젝트 폴더를 바로 바꾸므로, 인증을 끈 개인 PC에서만 허용한다 */
export function localFolderAllowed(): boolean {
  try {
    return authConfig().mode === 'none';
  } catch {
    return false;
  }
}

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
  if (!session.databases.enabled) return [];
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
  if (session.snapshot.mode === 'claude-code') session.claudeCode.notes.push(text);
  else session.conversation.push({ role: 'user', content: text });
  session.settledConversation = session.conversation.length;
}

/** 이 세션의 이전 체크포인트로 되돌린다. 오래 걸리므로 바로 돌아가고 결과는 이벤트로 알린다 */
export function restoreCheckpoint(id: string, sha: string): void {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 되돌릴 수 있습니다');
  if (session.snapshot.running || session.exporting) throw new StudioError(409, '다른 작업을 처리하는 중입니다');
  const target = session.snapshot.checkpoints.find((checkpoint) => checkpoint.sha === sha);
  if (!target) throw new StudioError(404, '체크포인트를 찾을 수 없습니다');
  if (target.sha === session.snapshot.checkpoints[0]?.sha) throw new StudioError(409, '이미 최신 체크포인트입니다');

  session.snapshot.running = true;
  emit(session, { type: 'restore_started', checkpoint: target });

  void (async () => {
    let event: StudioEvent;
    try {
      await session.relaying;
      const { files } = await session.checkpoints.restore(sha);
      // 파일만 되돌리면 이미 적용된 마이그레이션이 DB에 남아 서비스가 기동하지 못하므로 DB도 같은 시점으로 맞춘다
      const database = await session.databases.restore(sha, session.stop.signal);
      const report = await restartServicesFor(
        session.sandbox,
        session.project,
        files,
        { signal: session.stop.signal, onStatus: (status) => onServiceStatus(session, status) },
        { alsoRestart: database.dependents },
      );
      session.snapshot.checkpoints = await session.checkpoints.list();
      // 이후 요청이 사라진 변경을 전제로 하지 않도록 대화에도 남긴다
      noteForModel(session, `[b-studio] 작업 복사본을 체크포인트 ${target.shortSha}("${target.message}")로 되돌렸습니다. 그 뒤의 변경은 모두 사라졌습니다.`);
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
      };
    } catch (error) {
      event = { type: 'restore_failed', checkpoint: target, error: describe(error) };
    }
    // 새로 연결한 브라우저가 실행 중 상태에 멈추지 않도록 이벤트보다 먼저 푼다
    session.snapshot.running = false;
    if (!session.stop.signal.aborted) emit(session, event);
  })();
}

/** 체크포인트를 세션 브랜치로 올리고, 원하면 PR을 만든다. 몇 초면 끝나므로 결과를 바로 돌려준다 */
export async function exportSession(id: string, { pullRequest }: { pullRequest: boolean }): Promise<ExportResult> {
  const session = requireSession(id);
  if (!session.snapshot.repository) throw new StudioError(409, '원본 프로젝트가 Git 저장소가 아니어서 올릴 곳이 없습니다');
  if (session.snapshot.running) throw new StudioError(409, '작업이 끝난 뒤에 올릴 수 있습니다');
  if (session.exporting) throw new StudioError(409, '이미 올리는 중입니다');

  session.exporting = true;
  try {
    const pushed = await session.checkpoints.push().catch((error: unknown) => {
      // git 명령 자체가 실패하면(인증, 네트워크) 원격 문제이고, 나머지는 지금 상태로는 올릴 수 없다는 뜻이다
      const gitFailure = error instanceof CheckpointError && error.message.startsWith('git ');
      throw new StudioError(gitFailure ? 502 : 409, describe(error));
    });

    const info = (await session.checkpoints.repository())!;
    let created: ExportResult['pullRequest'];
    let pullRequestError: string | undefined;
    if (pullRequest && !info.pullRequestUrl) {
      try {
        const { title, body } = buildPullRequest({
          projectName: session.project.spec.name,
          base: info.base,
          branch: info.branch,
          commits: await session.checkpoints.sessionCommits(),
        });
        const result = await createPullRequest(parseRemote(info.remoteUrl), { title, body, base: info.base, branch: info.branch });
        await session.checkpoints.recordPullRequest(result.url);
        created = { url: result.url, created: result.created };
      } catch (error) {
        // 브랜치는 이미 올라갔으므로 실패 이유를 알리고, 작성 페이지 링크로 직접 만들 수 있게 한다
        pullRequestError = describe(error);
      }
    }

    const repository = (await describeRepository(session.checkpoints, session.sourceDirtyFiles))!;
    session.snapshot.repository = repository;
    const result: ExportResult = {
      repository,
      sha: pushed.sha,
      commits: pushed.commits,
      forced: pushed.forced,
      pullRequest: created,
      pullRequestError,
    };
    emit(session, { type: 'exported', ...result });
    return result;
  } finally {
    session.exporting = false;
  }
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
    const { files } = await session.checkpoints.restore(result.previous);
    const database = await session.databases.restore(result.previous, session.stop.signal);
    const restart = await restartServicesFor(session.sandbox, session.project, files, start, { alsoRestart: database.dependents });
    session.snapshot.checkpoints = await session.checkpoints.list();
    return { type: 'remote_sync_failed', error, commits, files: result.files, report, restarted: restart.restarted, checkpoints: session.snapshot.checkpoints };
  } catch (undoError) {
    return { type: 'remote_sync_failed', error: `${error}. 되돌리지도 못했습니다: ${describe(undoError)}`, commits, files: result.files, report };
  }
}

async function describeRepository(store: CheckpointStore, sourceDirtyFiles: number): Promise<RepositoryView | undefined> {
  const info = await store.repository();
  if (!info) return undefined;
  const remote = parseRemote(info.remoteUrl);
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
    canCreatePullRequest: canCreatePullRequest(remote),
  };
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
  const transient = event.type === 'usage' || event.type === 'files_changed' || event.type === 'deploy_log';
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

/** 오타가 조용히 다른 모드(특히 비용이 드는 모드)로 떨어지지 않도록 모르는 값은 거부한다 */
function sessionMode(): SessionMode {
  const value = process.env.B_STUDIO_MODE?.trim();
  if (!value || value === 'api') return 'api';
  if (value === 'claude-code' || value === 'demo') return value;
  throw new StudioError(500, `B_STUDIO_MODE는 api, claude-code, demo 중 하나여야 합니다 (지금 값: ${value})`);
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
