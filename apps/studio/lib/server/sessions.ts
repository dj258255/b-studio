import { randomUUID } from 'node:crypto';
import { cp, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  AnthropicModelClient,
  ORDERS_DEMO_SCENARIOS,
  runAgent,
  ScriptedModelClient,
  type DemoScenario,
  type ModelClient,
} from '@b-studio/agent';
import { LocalDockerProvider, type Sandbox, type ServiceStatusEvent } from '@b-studio/sandbox';
import { loadProject, type LoadedProject } from '@b-studio/spec';
import type { SessionSnapshot, SessionStatus, StudioEvent } from '@/lib/studio-events';
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
  const source = await findProject(projectId);
  if (!source) throw new StudioError(404, '프로젝트를 찾을 수 없습니다');

  const id = randomUUID().slice(0, 8);
  // 에이전트가 원본을 바꾸지 않도록 세션마다 작업 복사본을 만든다. Docker가 마운트할 수 있는 홈 아래에 둔다
  const workDir = path.join(sessionsRoot(), `${projectId}-${id}`);
  await mkdir(path.dirname(workDir), { recursive: true });
  await cp(source.root, workDir, { recursive: true, filter: (file) => !GENERATED.test(file) });

  const project = await loadProject(workDir);
  const sandbox = await new LocalDockerProvider().create(project);
  const mode = process.env.B_STUDIO_MODE === 'demo' ? 'demo' : 'claude';

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
    },
    project,
    sandbox,
    history: [],
    logs: [],
    listeners: new Set(),
    conversation: [],
    stop: new AbortController(),
    demoIndex: 0,
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

interface RunPlan {
  client: ModelClient;
  allowBreaking: boolean;
  maxVerifyAttempts?: number;
}

function planRun(session: Session, request: string, allowBreaking: boolean): RunPlan {
  if (session.snapshot.mode === 'claude') return { client: new AnthropicModelClient(), allowBreaking };

  // 데모 모드는 스크립트이므로 준비된 요청을 순서대로만 실행한다. 다른 요청을 받은 척하지 않는다
  const scenario = demoScenarios(session.project)[session.demoIndex];
  if (!scenario) throw new StudioError(409, '데모 모드에서 실행할 수 있는 요청을 모두 실행했습니다');
  if (scenario.request !== request) {
    throw new StudioError(409, `데모 모드는 준비된 요청을 순서대로 실행합니다. 다음 요청: "${scenario.request}"`);
  }
  return { client: new ScriptedModelClient(scenario.turns), allowBreaking: scenario.allowBreaking ?? false, maxVerifyAttempts: scenario.maxVerifyAttempts };
}

async function execute(session: Session, runId: string, request: string, plan: RunPlan): Promise<void> {
  let finished: Extract<StudioEvent, { type: 'run_finished' }> | undefined;
  try {
    if (plan.client instanceof AnthropicModelClient) {
      const preflight = await plan.client.preflight();
      if (!preflight.ok) {
        finished = { type: 'run_finished', runId, status: 'error', summary: preflight.reason };
        return;
      }
    }

    const result = await runAgent({
      request,
      project: session.project,
      sandbox: session.sandbox,
      client: plan.client,
      conversation: session.conversation,
      allowBreaking: plan.allowBreaking,
      maxVerifyAttempts: plan.maxVerifyAttempts,
      signal: session.stop.signal,
      onEvent: (event) => emit(session, { type: 'agent', runId, event }),
      onServiceStatus: (event) => onServiceStatus(session, event),
    });
    finished = { type: 'run_finished', runId, status: result.status, summary: result.summary, turns: result.turns };
  } catch (error) {
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
