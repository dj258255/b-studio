import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  appendPageCheckToYaml,
  buildPageCheckFromExploreQa,
  runClaudeCodeExploreQa,
  runExploreQa,
  type BrowserFrame,
  type ExploreQaEvent,
  type ExploreQaGoal,
  type ExploreQaResult,
  type QaActionRecord,
  type QaExpectedRejection,
  type QaFinding,
  type QaViewport,
} from '@b-studio/agent';
import { SPEC_FILE } from '@b-studio/spec';
import { publish } from './live-frames';
import { EXPLORE_QA_RUN_FILE, readExploreQaRunFile, writeExploreQaRunFile } from './explore-qa-run-file';
import { exploreQaBackendFor, remoteBrowserAllowedOrigins, remoteBrowserUrl, saveExploreQaArtifact, sessionStateDir } from './sessions';

/**
 * 세션마다 탐색형 QA 실행 하나를 관리한다(원격 브라우저의 remote-browsers.ts와 같은 모양).
 * 실행은 시작 요청에 바로 응답하지 않고 백그라운드로 돌며(목표에 따라 수십 초~분 단위), 상태는 폴링으로 조회한다.
 * 프레임은 기존 실시간 채널(live-frames.ts)의 새 source('explore')로 중계해 QA 탭이 같은 방식으로 받는다.
 */
export class ExploreQaError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ExploreQaError';
    this.status = status;
  }
}

export type ExploreQaRunStatus = 'running' | 'done';

export interface ExploreQaRun {
  id: string;
  service: string;
  goal: ExploreQaGoal;
  status: ExploreQaRunStatus;
  actions: QaActionRecord[];
  /** 모델이 화면을 보고 보고한 문제. 실행 중에도 쌓인다(끝나면 result.findings와 같다) */
  findings: QaFinding[];
  /** 모델이 미리 선언해 서버가 거절한 시험. 실행 중에도 쌓인다(끝나면 result.expectedRejections와 같다) */
  expectedRejections: QaExpectedRejection[];
  texts: string[];
  result?: ExploreQaResult;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

interface RunEntry {
  run: ExploreQaRun;
  abort: AbortController;
}

const globalStore = globalThis as typeof globalThis & { __bStudioExploreQaRuns?: Map<string, RunEntry> };
const store = (globalStore.__bStudioExploreQaRuns ??= new Map());

const DEFAULT_VIEWPORT: QaViewport = { width: 1280, height: 800 };

export interface StartExploreQaInput {
  service: string;
  goal: string;
  startPath: string;
  confirmText?: string;
  maxActions?: number;
  maxMs?: number;
}

/** 이미 도는 실행이 있으면 거부한다(세션당 하나). 끝난 실행은 새로 시작하면 덮어쓴다 */
export function startExploreQa(sessionId: string, input: StartExploreQaInput): ExploreQaRun {
  const existing = store.get(sessionId);
  if (existing?.run.status === 'running') throw new ExploreQaError(409, '이미 탐색형 QA가 실행 중입니다. 끝나거나 멈춘 뒤 다시 시작하세요');

  const goal: ExploreQaGoal = {
    goal: input.goal,
    startPath: input.startPath,
    ...(input.confirmText ? { confirmText: input.confirmText } : {}),
    ...(input.maxActions !== undefined ? { maxActions: input.maxActions } : {}),
    ...(input.maxMs !== undefined ? { maxMs: input.maxMs } : {}),
  };
  const run: ExploreQaRun = { id: `explore-${Date.now()}`, service: input.service, goal, status: 'running', actions: [], findings: [], expectedRejections: [], texts: [], startedAt: Date.now() };
  const abort = new AbortController();
  store.set(sessionId, { run, abort });

  const startUrl = new URL(input.startPath, remoteBrowserUrl(sessionId, input.service)).toString();
  const allowedOrigins = remoteBrowserAllowedOrigins(sessionId);
  const onEvent = (event: ExploreQaEvent): void => {
    if (event.type === 'action') run.actions.push(event.record);
    else if (event.type === 'finding') run.findings.push(event.finding);
    else if (event.type === 'rejection' && event.rejection.requests.length > 0) run.expectedRejections.push(event.rejection);
    else if (event.type === 'text') run.texts.push(event.text);
  };
  const onFrame = (frame: BrowserFrame): void => {
    publish(sessionId, { source: 'explore', mime: 'image/jpeg', data: frame.data.toString('base64'), width: frame.width, height: frame.height, at: frame.at });
  };
  const saveArtifact = (artifactInput: { name: string; data: Buffer; contentType: 'image/png' | 'image/jpeg' }): Promise<string> =>
    saveExploreQaArtifact(sessionId, artifactInput);

  const { projectRoot, backend } = exploreQaBackendFor(sessionId);
  // 끝난 실행은 세션 상태 폴더에 남긴다. studio를 다시 띄워도 판정·발견 목록을 볼 수 있다(이슈 #602).
  // 남기지 못해도 실행 결과에는 영향이 없다(메모리의 기록은 그대로다)
  const runFile = path.join(sessionStateDir(sessionId), EXPLORE_QA_RUN_FILE);
  const persist = (): void => {
    void writeExploreQaRunFile(runFile, run).catch((error: unknown) => console.error('[b-studio] 탐색형 QA 실행 기록을 저장하지 못했습니다', error));
  };
  const finish = (result: ExploreQaResult): void => {
    run.status = 'done';
    run.result = result;
    run.finishedAt = Date.now();
    persist();
  };
  const fail = (error: unknown): void => {
    run.status = 'done';
    run.error = error instanceof Error ? error.message : String(error);
    run.finishedAt = Date.now();
    persist();
  };

  if (backend.kind === 'api') {
    runExploreQa({ client: backend.client, goal, startUrl, allowedOrigins, viewport: DEFAULT_VIEWPORT, onFrame, onEvent, saveArtifact, signal: abort.signal }).then(finish, fail);
  } else if (backend.kind === 'claude-code') {
    runClaudeCodeExploreQa({
      goal,
      startUrl,
      allowedOrigins,
      viewport: DEFAULT_VIEWPORT,
      onFrame,
      onEvent,
      saveArtifact,
      cwd: projectRoot,
      ...(backend.model ? { model: backend.model } : {}),
      signal: abort.signal,
    }).then(finish, fail);
  } else {
    fail(new Error(`이 세션의 백엔드(${backend.backend})는 아직 탐색형 QA를 지원하지 않습니다. api나 로컬 CLI 백엔드로 바꾸세요`));
  }

  return run;
}

export function getExploreQaRun(sessionId: string): ExploreQaRun | undefined {
  return store.get(sessionId)?.run;
}

/**
 * 지금 도는(또는 마지막으로 끝난) 실행. 메모리에 없으면(studio를 다시 띄운 뒤) 세션 상태 폴더에 남겨 둔 마지막 실행을 읽어 온다.
 * 읽어 온 실행은 메모리에 올려 두어, 다음 조회와 "게이트 화면 확인으로 저장"이 같은 실행을 본다
 */
export async function loadExploreQaRun(sessionId: string): Promise<ExploreQaRun | undefined> {
  const current = getExploreQaRun(sessionId);
  if (current) return current;
  const saved = await readExploreQaRunFile(path.join(sessionStateDir(sessionId), EXPLORE_QA_RUN_FILE));
  // 읽는 사이에 새 실행이 시작됐으면 그쪽이 먼저다
  const started = getExploreQaRun(sessionId);
  if (started) return started;
  if (saved) store.set(sessionId, { run: saved, abort: new AbortController() });
  return saved;
}

/** 실행 중이면 멈춘다. 이미 끝났으면 아무것도 하지 않는다 */
export function stopExploreQa(sessionId: string): void {
  const entry = store.get(sessionId);
  if (entry?.run.status === 'running') entry.abort.abort();
}

export function clearExploreQaRun(sessionId: string): void {
  store.delete(sessionId);
}

export interface SaveExploreQaInput {
  service: string;
}

export interface SaveExploreQaResult {
  path: string;
  skipped: Array<{ index: number; tool: string; reason: string }>;
}

/**
 * 마지막으로 끝난 실행의 행동 기록을 studio.yaml의 workflow.pageChecks에 덧붙인다.
 * 사람이 "이 흐름을 게이트 화면 확인으로 저장" 버튼을 눌렀을 때만 호출한다(b-studio는 studio.yaml을 스스로 고치지 않는다는
 * 원칙의 유일한 예외 — 사람의 명시적 행동으로만 일어난다).
 */
export async function saveExploreQaRun(sessionId: string, input: SaveExploreQaInput): Promise<SaveExploreQaResult> {
  const run = await loadExploreQaRun(sessionId);
  if (!run || run.status !== 'done') throw new ExploreQaError(409, '저장할 수 있는 끝난 실행이 없습니다');
  if (run.actions.length === 0) throw new ExploreQaError(400, '저장할 행동이 없습니다');

  const { projectRoot } = exploreQaBackendFor(sessionId);
  const { check, skipped } = buildPageCheckFromExploreQa({ service: input.service, goal: run.goal, actions: run.actions, viewport: DEFAULT_VIEWPORT });
  const yamlPath = path.join(projectRoot, SPEC_FILE);
  const original = await readFile(yamlPath, 'utf8');
  const next = appendPageCheckToYaml(original, check);
  await writeFile(yamlPath, next, 'utf8');
  return { path: SPEC_FILE, skipped };
}
