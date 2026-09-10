import { randomUUID } from 'node:crypto';
import { cp, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  AnthropicModelClient,
  buildPullRequest,
  canCreatePullRequest,
  CheckpointError,
  CheckpointStore,
  compareUrl,
  createPullRequest,
  formatVerificationReport,
  ORDERS_DEMO_SCENARIOS,
  parseRemote,
  preflightClaudeCode,
  restartServicesFor,
  runAgent,
  runClaudeCodeAgent,
  ScriptedModelClient,
  type AgentEvent,
  type AgentResult,
  type Checkpoint,
  type DemoScenario,
  type GitAuthor,
  type ModelClient,
} from '@b-studio/agent';
import { LocalDockerProvider, type Sandbox, type ServiceStatusEvent } from '@b-studio/sandbox';
import { loadProject, type LoadedProject } from '@b-studio/spec';
import type { ExportResult, RepositoryView, SessionMode, SessionSnapshot, SessionStatus, StudioEvent } from '@/lib/studio-events';
import { describe, StudioError } from './errors';
import { findProject } from './projects';

type Conversation = NonNullable<Parameters<typeof runAgent>[0]['conversation']>;
type Listener = (event: StudioEvent) => void;

interface Session {
  snapshot: SessionSnapshot;
  project: LoadedProject;
  sandbox: Sandbox;
  /** 채팅·상태 이벤트. 새로 연결한 브라우저에 다시 보낸다 */
  history: StudioEvent[];
  /** 로그는 양이 많아 따로 최근 것만 둔다 */
  logs: StudioEvent[];
  listeners: Set<Listener>;
  conversation: Conversation;
  stop: AbortController;
  logFollower?: AbortController;
  demoIndex: number;
  checkpoints: CheckpointStore;
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
}

const HISTORY_LIMIT = 5_000;
const LOG_LIMIT = 1_000;
const GENERATED = /[/\\](node_modules|\.next|build|\.gradle|\.venv)([/\\]|$)/;

// 개발 서버의 HMR로 모듈이 다시 로드돼도 실행 중인 샌드박스를 잃지 않도록 전역에 둔다
const globalStore = globalThis as typeof globalThis & {
  __bStudio?: { sessions: Map<string, Session>; cleanupRegistered: boolean };
};
const store = (globalStore.__bStudio ??= { sessions: new Map(), cleanupRegistered: false });

export function getSnapshot(id: string): SessionSnapshot | undefined {
  return store.sessions.get(id)?.snapshot;
}

export async function createSession(projectId: string): Promise<SessionSnapshot> {
  const mode = sessionMode();
  const source = await findProject(projectId);
  if (!source) throw new StudioError(404, '프로젝트를 찾을 수 없습니다');

  const id = randomUUID().slice(0, 8);
  // 에이전트가 원본을 바꾸지 않도록 세션마다 작업 복사본을 만든다. Docker가 마운트할 수 있는 홈 아래에 둔다
  const workDir = path.join(sessionsRoot(), `${projectId}-${id}`);
  await mkdir(path.dirname(workDir), { recursive: true });

  // 게이트를 통과한 변경만 남기고 실패한 변경은 되돌리기 위해 작업 복사본의 시작 상태를 체크포인트로 둔다
  const author = gitAuthor();
  let checkpoints: CheckpointStore;
  let firstCheckpoint: Checkpoint;
  let sourceDirtyFiles = 0;
  if (await CheckpointStore.inspectSource(source.root)) {
    // 원본이 Git 저장소면 커밋된 상태를 복제해 세션 브랜치에서 작업한다. 체크포인트가 곧 원격에 올릴 커밋이 된다
    const cloned = await CheckpointStore.clone(source.root, workDir, { branch: `b-studio/${projectId}-${id}`, author });
    checkpoints = cloned.store;
    firstCheckpoint = cloned.start;
    sourceDirtyFiles = cloned.source.dirtyFiles;
  } else {
    await cp(source.root, workDir, { recursive: true, filter: (file) => !GENERATED.test(file) });
    checkpoints = new CheckpointStore(workDir, { author });
    firstCheckpoint = await checkpoints.init('세션 시작');
  }

  const project = await loadProject(workDir);
  const repository = await describeRepository(checkpoints, sourceDirtyFiles);
  const sandbox = await new LocalDockerProvider().create(project);

  const session: Session = {
    snapshot: {
      id,
      projectId,
      projectName: project.spec.name,
      workDir,
      status: 'starting',
      mode,
      running: false,
      services: project.managed.map(([name, service]) => ({
        name,
        template: service.template,
        preview: service.preview,
        state: 'starting',
        hasContract: Boolean(service.contract),
      })),
      nextDemoRequest: mode === 'demo' ? demoScenarios(project)[0]?.request : undefined,
      checkpoints: [firstCheckpoint],
      repository,
    },
    project,
    sandbox,
    checkpoints,
    history: [],
    logs: [],
    listeners: new Set(),
    conversation: [],
    stop: new AbortController(),
    demoIndex: 0,
    claudeCode: { notes: [] },
    sourceDirtyFiles,
    exporting: false,
  };

  store.sessions.set(id, session);
  registerCleanup();
  void boot(session);
  return session.snapshot;
}

/** 새 구독자에게 지금 상태와 지금까지의 기록을 보낸 뒤 실시간 이벤트를 전달한다 */
export function subscribe(id: string, listener: Listener): () => void {
  const session = requireSession(id);
  listener({ type: 'snapshot', snapshot: session.snapshot });
  for (const event of session.history) listener(event);
  for (const event of session.logs) listener(event);
  session.listeners.add(listener);
  return () => session.listeners.delete(listener);
}

export function sendMessage(id: string, text: string, { allowBreaking }: { allowBreaking: boolean }): { runId: string } {
  const session = requireSession(id);
  if (session.snapshot.status !== 'ready') throw new StudioError(409, '샌드박스가 준비된 뒤에 요청할 수 있습니다');
  if (session.snapshot.running) throw new StudioError(409, '이전 요청을 처리하는 중입니다');
  if (session.exporting) throw new StudioError(409, '원격 저장소에 올리는 중입니다');

  const request = text.trim();
  if (!request) throw new StudioError(400, '요청 내용을 입력하세요');

  const plan = planRun(session, request, allowBreaking);
  const runId = randomUUID().slice(0, 8);
  session.snapshot.running = true;
  emit(session, { type: 'run_started', runId, request });
  void execute(session, runId, request, plan);
  return { runId };
}

export async function stopSession(id: string): Promise<SessionSnapshot> {
  const session = requireSession(id);
  if (session.snapshot.status === 'stopped') return session.snapshot;
  session.stop.abort();
  session.logFollower?.abort();
  await session.sandbox.destroy().catch(() => {});
  session.snapshot.running = false;
  setStatus(session, 'stopped');
  return session.snapshot;
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

async function boot(session: Session): Promise<void> {
  try {
    await session.sandbox.start({ signal: session.stop.signal, onStatus: (event) => onServiceStatus(session, event) });
    setStatus(session, 'ready');
  } catch (error) {
    if (!session.stop.signal.aborted) setStatus(session, 'failed', describe(error));
  }
}

type RunPlan =
  | { kind: 'model'; client: ModelClient; allowBreaking: boolean; maxVerifyAttempts?: number }
  | { kind: 'claude-code'; allowBreaking: boolean };

function planRun(session: Session, request: string, allowBreaking: boolean): RunPlan {
  if (session.snapshot.mode === 'api') return { kind: 'model', client: new AnthropicModelClient(), allowBreaking };
  if (session.snapshot.mode === 'claude-code') return { kind: 'claude-code', allowBreaking };

  // 데모 모드는 스크립트이므로 준비된 요청을 순서대로만 실행한다. 다른 요청을 받은 척하지 않는다
  const scenario = demoScenarios(session.project)[session.demoIndex];
  if (!scenario) throw new StudioError(409, '데모 모드에서 실행할 수 있는 요청을 모두 실행했습니다');
  if (scenario.request !== request) {
    throw new StudioError(409, `데모 모드는 준비된 요청을 순서대로 실행합니다. 다음 요청: "${scenario.request}"`);
  }
  return {
    kind: 'model',
    client: new ScriptedModelClient(scenario.turns),
    allowBreaking: scenario.allowBreaking ?? false,
    maxVerifyAttempts: scenario.maxVerifyAttempts,
  };
}

async function execute(session: Session, runId: string, request: string, plan: RunPlan): Promise<void> {
  let finished: Extract<StudioEvent, { type: 'run_finished' }> | undefined;
  try {
    const result = await runPlan(session, runId, request, plan);
    if ('preflightError' in result) {
      finished = { type: 'run_finished', runId, status: 'error', summary: result.preflightError };
      return;
    }

    // 게이트를 통과한 변경만 체크포인트로 남기고, 통과하지 못한 변경은 되돌려 샌드박스를 이전 상태로 맞춘다
    if (result.status === 'done') await saveCheckpoint(session, runId, request, checkpointBody(result, plan.allowBreaking));
    else await revertRun(session, runId);
    finished = { type: 'run_finished', runId, status: result.status, summary: result.summary, turns: result.turns };
  } catch (error) {
    if (!session.stop.signal.aborted) {
      await revertRun(session, runId).catch((revertError: unknown) => console.error('[b-studio] 되돌리기 실패', revertError));
    }
    finished = { type: 'run_finished', runId, status: 'error', summary: describe(error) };
  } finally {
    if (session.snapshot.mode === 'demo') {
      session.demoIndex += 1;
      session.snapshot.nextDemoRequest = demoScenarios(session.project)[session.demoIndex]?.request;
    }
    session.snapshot.running = false;
    if (!session.stop.signal.aborted && finished) {
      emit(session, { ...finished, nextDemoRequest: session.snapshot.nextDemoRequest });
    }
  }
}

/** 샌드박스를 건드리기 전에 인증부터 확인하고, 모드에 맞는 에이전트로 요청을 처리한다 */
async function runPlan(session: Session, runId: string, request: string, plan: RunPlan): Promise<AgentResult | { preflightError: string }> {
  const shared = {
    project: session.project,
    sandbox: session.sandbox,
    allowBreaking: plan.allowBreaking,
    signal: session.stop.signal,
    onEvent: (event: AgentEvent) => emit(session, { type: 'agent', runId, event }),
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
  const checkpoint = await session.checkpoints.commit(`요청: ${request}`, body);
  if (!checkpoint) return;
  session.snapshot.checkpoints = [checkpoint, ...session.snapshot.checkpoints];
  emit(session, { type: 'checkpoint', runId, checkpoint });
}

async function revertRun(session: Session, runId: string): Promise<void> {
  const { files, patch } = await session.checkpoints.discard();
  if (files.length === 0) return;
  const report = await restartServicesFor(session.sandbox, session.project, files, {
    signal: session.stop.signal,
    onStatus: (event) => onServiceStatus(session, event),
  });
  emit(session, { type: 'reverted', runId, files, patch, restarted: report.restarted });
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
      const { files } = await session.checkpoints.restore(sha);
      const report = await restartServicesFor(session.sandbox, session.project, files, {
        signal: session.stop.signal,
        onStatus: (status) => onServiceStatus(session, status),
      });
      session.snapshot.checkpoints = await session.checkpoints.list();
      // 이후 요청이 사라진 변경을 전제로 하지 않도록 대화에도 남긴다
      const note = `[b-studio] 작업 복사본을 체크포인트 ${target.shortSha}("${target.message}")로 되돌렸습니다. 그 뒤의 변경은 모두 사라졌습니다.`;
      if (session.snapshot.mode === 'claude-code') session.claudeCode.notes.push(note);
      else session.conversation.push({ role: 'user', content: note });
      if (session.snapshot.mode === 'demo') {
        // 데모 시나리오는 앞 단계의 파일을 전제로 하므로, 남은 체크포인트 수에 맞춰 다음 요청을 다시 정한다
        session.demoIndex = session.snapshot.checkpoints.length - 1;
        session.snapshot.nextDemoRequest = demoScenarios(session.project)[session.demoIndex]?.request;
      }
      event = {
        type: 'restored',
        checkpoint: target,
        files,
        restarted: report.restarted,
        checkpoints: session.snapshot.checkpoints,
        nextDemoRequest: session.snapshot.nextDemoRequest,
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

async function describeRepository(store: CheckpointStore, sourceDirtyFiles: number): Promise<RepositoryView | undefined> {
  const info = await store.repository();
  if (!info) return undefined;
  const remote = parseRemote(info.remoteUrl);
  return {
    remote: remote.display,
    kind: remote.kind,
    base: info.base,
    branch: info.branch,
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
      Object.assign(service, { state: 'ready', url: event.endpoint.url, detail: undefined });
      // 재시작한 컨테이너는 기존 로그 구독에 잡히지 않으므로 다시 붙는다
      if (session.snapshot.status === 'ready') followLogs(session, 20);
      break;
    case 'failed':
      Object.assign(service, { state: 'failed', detail: event.reason });
      break;
  }
  emit(session, { type: 'service', service: service.name, state: service.state, url: service.url, detail: service.detail });
}

function setStatus(session: Session, status: SessionStatus, error?: string): void {
  session.snapshot.status = status;
  session.snapshot.error = error;
  emit(session, { type: 'status', status, error });
  if (status === 'ready') followLogs(session, 100);
}

function followLogs(session: Session, tail: number): void {
  session.logFollower?.abort();
  const follower = new AbortController();
  session.logFollower = follower;
  const signal = AbortSignal.any([follower.signal, session.stop.signal]);

  void (async () => {
    try {
      for await (const line of session.sandbox.logs({ signal, tail })) {
        emit(session, { type: 'log', service: line.service, text: line.text, at: line.at.toISOString() });
      }
    } catch {
      // 구독을 다시 붙이거나 세션을 멈추면 끊기는 것이 정상이다
    }
  })();
}

function emit(session: Session, event: StudioEvent): void {
  const buffer = event.type === 'log' ? session.logs : session.history;
  buffer.push(event);
  const limit = event.type === 'log' ? LOG_LIMIT : HISTORY_LIMIT;
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
  for (const listener of session.listeners) listener(event);
}

function requireSession(id: string): Session {
  const session = store.sessions.get(id);
  if (!session) throw new StudioError(404, '세션을 찾을 수 없습니다');
  return session;
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

function sessionsRoot(): string {
  return path.resolve(process.env.B_STUDIO_SESSIONS_DIR ?? path.join(homedir(), '.cache/b-studio/sessions'));
}

/** 스튜디오 서버가 종료될 때 띄워 둔 샌드박스를 정리한다 */
function registerCleanup(): void {
  if (store.cleanupRegistered) return;
  store.cleanupRegistered = true;

  let cleaning = false;
  const cleanup = async () => {
    if (cleaning) return;
    cleaning = true;
    const running = [...store.sessions.values()].filter((session) => session.snapshot.status !== 'stopped');
    await Promise.race([
      Promise.allSettled(running.map((session) => stopSession(session.snapshot.id))),
      new Promise((resolve) => setTimeout(resolve, 20_000)),
    ]);
    process.exit(0);
  };
  process.on('SIGINT', () => void cleanup());
  process.on('SIGTERM', () => void cleanup());
}
