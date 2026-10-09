import {
  createSdkMcpServer,
  query,
  tool,
  type AccountInfo,
  type McpServerConfig,
  type ModelInfo,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Effort } from './anthropic-client';
import { DEFAULT_SAME_SIGNATURE_TIMES, escalationPrompt, retryBudgetFor, shouldPromote, signatureSetKey, type EscalationPolicy } from './escalation';
import { recheckGateOnMaxTurns, VerificationGate } from './gate';
import { emptyUsage, formatSteering, takeSteering, type AgentEvent, type AgentResult, type AgentUsage, type RunAgentOptions, type RunMetrics, type Steering } from './loop';
import { loadProjectGuide } from './project-guide';
import { buildAskRequest, buildSystemPrompt, projectGuideSection } from './prompts';
import { createToolResultCache } from './tool-output';
import { buildTools, executeTool, SANDBOX_TOOLS, WRITE_TOOLS, type AskUserQuestion, type BoardAccess, type ToolContext } from './tools';
import { fetchContract } from './verify';
import { executionPolicyFor, workflowContext } from './workflow';
import { syncExternalChanges, Workspace } from './workspace';

const SERVER = 'b-studio';
/** 화면 표기. Agent SDK 브랜딩 가이드는 제품 안에서 "Claude Code"라는 이름을 쓰지 않도록 한다 */
const BACKEND = '로컬 Claude Agent';
/**
 * 세션이 노력 단계를 고르지 않았을 때 실제로 쓰이는 기본값. runClaudeCodeAgent의 기본 인자와 이 상수가 어긋나면
 * 실행 중 표시(노력: 높음)와 아직 아무것도 고르지 않은 화면(모델 선택 팝오버)이 서로 다른 값을 보여주게 된다 —
 * 리터럴을 두 곳에 따로 적지 않고 이 상수 하나로 맞춘다(apps/studio/lib/server/model-picker.ts가 그대로 쓴다).
 */
export const DEFAULT_CLAUDE_CODE_EFFORT: Effort = 'high';
/**
 * 자동 압축 기준 창(토큰). 이어받은 대화가 이 크기에 닿으면 SDK가 앞부분을 요약한다(ADR-151).
 * 200,000은 200K 창 모델의 표준 동작과 같은 수준이다. 1M 창 모델은 SDK 기본이 훨씬 커서 대화가 수십만 토큰까지 자란다.
 */
export const DEFAULT_COMPACT_WINDOW = 200_000;
/** 이보다 작은 창은 압축이 너무 자주 일어나 쓸모가 없으므로 무시한다 */
export const MIN_COMPACT_WINDOW = 50_000;
export const COMPACT_WINDOW_ENV = 'B_STUDIO_CLAUDE_CODE_COMPACT_WINDOW';
const SDK_COMPACT_WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

export interface CompactWindowSetting {
  /** SDK에 넘길 창 크기. null이면 넘기지 않아 SDK 기본 동작을 쓴다 */
  window: number | null;
  /** 값을 무시하고 기본값을 쓴 경우의 안내 */
  ignored?: string;
}

/**
 * B_STUDIO_CLAUDE_CODE_COMPACT_WINDOW 값을 해석한다(순수 함수).
 * 비어 있으면 기본값, `0`·`off`면 끄기(null), 숫자가 아니거나 MIN_COMPACT_WINDOW 미만이면 기본값을 쓰고 이유를 돌려준다.
 */
export function resolveCompactWindow(raw: string | undefined): CompactWindowSetting {
  const text = raw?.trim();
  if (!text) return { window: DEFAULT_COMPACT_WINDOW };
  if (text === '0' || text.toLowerCase() === 'off') return { window: null };
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (Number.isSafeInteger(value) && value >= MIN_COMPACT_WINDOW) return { window: value };
  return {
    window: DEFAULT_COMPACT_WINDOW,
    ignored: `${COMPACT_WINDOW_ENV}=${text} 값을 무시하고 기본값 ${DEFAULT_COMPACT_WINDOW.toLocaleString('ko-KR')} 토큰을 씁니다 (${MIN_COMPACT_WINDOW.toLocaleString('ko-KR')} 이상의 정수, 끄려면 0 또는 off)`,
  };
}

/** 지시 큐가 알림(onPush)을 주지 않을 때 확인하는 주기 */
const STEERING_POLL_MS = 300;

/**
 * 일시적 네트워크 오류 재시도 기본값(ADR-142). 같은 세션을 resume으로 이어받아 지수 백오프로 기다린다.
 * 상한(횟수·총 대기 시간 중 먼저 걸리는 쪽)을 넘으면 지금처럼 실패로 끝내되 사유를 'network'로 남긴다.
 */
const NETWORK_RETRY_MAX_ATTEMPTS = 6;
const NETWORK_RETRY_MAX_WAIT_MS = 10 * 60_000;
const NETWORK_RETRY_BASE_DELAY_MS = 5_000;
/** 재시도로 이어받을 때 보내는 안내. 이미 한 작업을 다시 하지 말라고 짧게만 알린다 */
const NETWORK_RESUME_PROMPT = '네트워크가 끊겼다가 돌아왔습니다. 하던 작업을 처음부터 다시 하지 말고 그대로 이어서 진행하세요.';

/**
 * 메시지에 일시적 네트워크 오류의 근거가 있는 패턴이 있는지 본다(실측: ENOTFOUND. 나머지는 Node·Anthropic API가
 * 문서화한 같은 종류의 오류). 인증 실패·잘못된 요청 같은 영구 오류 문구는 여기 걸리지 않아야
 * 재시도하지 않는다(ADR-142) — 근거가 없는 패턴은 넣지 않는다.
 */
export function isTransientNetworkFailure(message: string): boolean {
  return /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Can't reach the API server|overloaded_error|\boverloaded\b/i.test(message);
}

/** 실제 대기(setTimeout). 중단 신호가 오면 바로 끝낸다 */
function defaultNetworkWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 네트워크 재시도 동작을 테스트가 주입할 수 있게 연 설정. 넘기지 않으면 기본값(위 상수)과 실제 대기를 쓴다 */
export interface NetworkRetryOptions {
  /** 실제 sleep 대신 테스트가 주입하는 대기 함수. 시간을 흐르게 하지 않고 바로 resolve해도 된다 */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxAttempts?: number;
  maxWaitMs?: number;
  baseDelayMs?: number;
}

/** 실제 SDK와 테스트용 가짜를 바꿔 끼우는 지점 */
export interface ClaudeCodeSdk {
  query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): ClaudeCodeQuery;
  createSdkMcpServer(options: { name: string; version?: string; tools?: Array<SdkMcpToolDefinition<any>> }): McpServerConfig;
}

export interface ClaudeCodeQuery extends AsyncIterable<SDKMessage> {
  accountInfo(): Promise<AccountInfo>;
  /** 로그인한 계정이 실제로 쓸 수 있는 모델 목록(별칭이 풀리는 id·설명·노력 단계 지원 여부 포함) */
  supportedModels(): Promise<ModelInfo[]>;
  interrupt(): Promise<unknown>;
  close(): void;
}

const DEFAULT_SDK: ClaudeCodeSdk = { query, createSdkMcpServer };

export interface ClaudeCodeAccount {
  subscriptionType?: string;
  apiKeySource?: string;
  apiProvider?: string;
}

export interface ClaudeCodeRunOptions extends Omit<RunAgentOptions, 'client' | 'conversation' | 'escalation'> {
  /**
   * 게이트 실패 서명이 `sameSignatureTimes`번 반복되면 다음 게이트 재시도부터 `to` 모델로 돈다.
   * 모델은 query를 열 때 정해지므로, 같은 세션을 이어받는 새 query를 모델만 바꿔 연다.
   */
  escalation?: EscalationPolicy;
  /** 이전 요청을 처리한 Claude Code 세션. 넘기면 그 대화를 이어받는다 */
  resume?: string;
  /** 넘기지 않으면 로그인한 계정의 기본 모델을 쓴다 */
  model?: string;
  effort?: Effort;
  /** preflight에서 확인한 인증 정보. 화면에 어떤 계정으로 실행하는지 표시한다 */
  account?: ClaudeCodeAccount;
  sdk?: ClaudeCodeSdk;
  /** 일시적 네트워크 오류(ADR-142)를 재시도할 때의 대기 전략. 넘기지 않으면 기본 상한·실제 대기를 쓴다(테스트 전용 주입점) */
  networkRetry?: NetworkRetryOptions;
  /** 환경 변수. 넘기지 않으면 process.env를 쓴다(테스트 전용 주입점) */
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeCodeResult extends AgentResult {
  /** 다음 요청이 이어받을 세션. 실행마다 갈라서 만든다 */
  sessionId?: string;
}

/**
 * 이 PC에 로그인한 Claude Code로 요청을 처리한다. API 키가 없어도 개인 구독으로 돌릴 수 있다.
 *
 * Claude Code의 기본 도구(Bash, Read, Edit …)와 사용자 설정·훅·플러그인은 모두 끄고,
 * b-studio 도구만 MCP 서버로 넘긴다. 모델이 작업 공간 규칙과 샌드박스를 우회해 호스트를 건드리지 못하게 하기 위해서다.
 * 완료 판정은 직접 만든 루프와 같은 검증 게이트가 한다. 모델이 턴을 끝낼 때마다(result 메시지) 게이트를 돌리고,
 * 실패하면 결과를 다음 사용자 메시지로 넣는다.
 */
export async function runClaudeCodeAgent(options: ClaudeCodeRunOptions): Promise<ClaudeCodeResult> {
  const {
    request,
    project,
    sandbox,
    allowBreaking = false,
    maxTurns = 60,
    maxVerifyAttempts = 3,
    signal,
    onEvent = () => {},
    onServiceStatus,
    fetcher = fetchContract,
    pageFetcher,
    browserRunner,
    saveArtifact,
    onBrowserFrame,
    resume,
    model,
    effort = DEFAULT_CLAUDE_CODE_EFFORT,
    account,
    sdk = DEFAULT_SDK,
    interactive = false,
    intent = 'build',
    research = false,
    steering,
    networkRetry = {},
    env: processEnv = process.env,
  } = options;
  signal?.throwIfAborted();
  // 자동 압축 기준 창. 사용자가 프로세스 환경에 직접 준 값은 덮어쓰지 않는다. 모든 query(재시도·승격으로 다시 여는 것 포함)가 이 env를 쓴다
  const compact = processEnv[SDK_COMPACT_WINDOW_ENV]?.trim() ? { window: null } : resolveCompactWindow(processEnv[COMPACT_WINDOW_ENV]);
  const queryEnv: Record<string, string | undefined> = {
    ...processEnv,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'b-studio',
    ...(compact.window !== null ? { [SDK_COMPACT_WINDOW_ENV]: String(compact.window) } : {}),
  };
  if (compact.ignored) onEvent({ type: 'warning', message: compact.ignored });
  const ask = intent === 'ask';
  const networkWait = networkRetry.wait ?? defaultNetworkWait;
  const networkMaxAttempts = networkRetry.maxAttempts ?? NETWORK_RETRY_MAX_ATTEMPTS;
  const networkMaxWaitMs = networkRetry.maxWaitMs ?? NETWORK_RETRY_MAX_WAIT_MS;
  const networkBaseDelayMs = networkRetry.baseDelayMs ?? NETWORK_RETRY_BASE_DELAY_MS;
  // 실행 전체에 걸친 네트워크 재시도 횟수·누적 대기 시간. 승격으로 query를 새로 열어도(reopen) 이어서 센다
  let networkAttempts = 0;
  let networkWaitedMs = 0;
  // "조사" 모드는 질문(ask)일 때만 뜻이 있다 — 만들기 요청에 섞여 와도(화면이 막지만 안전망으로) 조용히 무시한다
  const researching = ask && research;

  const workspace = new Workspace(project.root);
  // 이번 실행 전부터 작업 트리에 있던 변경(보관본 되살리기 등)을 먼저 알려, 에이전트가 이번 실행에서 파일을
  // 하나도 건드리지 않아도 게이트가 "검증할 변경 없음"으로 건너뛰지 않게 한다(ADR-131)
  if (options.externalChanges?.length) syncExternalChanges(workspace, options.externalChanges);
  // 질문 모드는 파일을 바꾸지 않으므로 계약 기준을 잡거나 게이트를 돌리지 않는다.
  // 지연 기동 세션(ensureSandbox)은 게이트를 여기서 만들지 않고, 첫 파일 변경·샌드박스 도구 때 샌드박스를 켠 뒤에 만든다.
  // 계약 기준은 샌드박스가 켜진 뒤, 아직 바뀌지 않은 코드에서 잡아야 하기 때문이다(API 경로와 같은 규칙)
  let gate: VerificationGate | undefined;
  let gatePromise: Promise<VerificationGate> | undefined;
  const gateFor = (): Promise<VerificationGate> =>
    (gatePromise ??= VerificationGate.create({ project, sandbox, workspace, allowBreaking, maxVerifyAttempts, verify: options.verify, fetcher, pageFetcher, browserRunner, saveArtifact, onBrowserFrame, signal, onServiceStatus, onEvent }));
  if (!ask && !options.ensureSandbox) gate = await gateFor();
  // 프로젝트 루트(세션 작업 복사본)의 AGENTS.md를 실행마다 새로 읽는다(ADR-077). 승격으로 runQuery를 다시 열어도
  // 같은 실행 안이므로 다시 읽지 않고 이 값을 그대로 재사용한다(아래 클로저가 캡처한다)
  const guide = await loadProjectGuide(project);
  const context: ToolContext = {
    project,
    selfCheck: options.selfCheck,
    workspace,
    sandbox,
    fetcher,
    signal,
    onServiceStatus,
    readOnly: ask,
    design: options.design,
    onQuestion: (question) => {
      asked = question;
      onEvent({ type: 'question', ...question });
    },
    // 직접 만든 루프와 같은 기본값. 없으면 studio.yaml의 워크플로 정책이 이 경로에만 빠진다
    policy: options.policy ?? executionPolicyFor(project),
    approvalToken: options.approvalToken,
    requestApproval: options.requestApproval,
    board: options.board,
    onPolicyDecision: (decision) => onEvent({ type: 'policy', ...decision }),
    // 실행 단위 도구 결과 캐시. 같은 도구·같은 입력의 결과가 반복되면 본문 대신 참조를 넣는다
    toolResults: createToolResultCache(),
    // 지연 기동 세션이면 샌드박스 도구를 실행하기 직전에 켠다(핸들러가 게이트 생성까지 함께 한다).
    // 세션의 ensureBooted가 동시 호출을 하나로 합치므로 중복 호출은 무해하다
    ...(options.ensureSandbox ? { ensureSandbox: options.ensureSandbox } : {}),
  };
  const specs = buildTools(project, {
    ...(options.board ? { board: options.board, allowedTools: context.policy?.allowedTools } : {}),
    design: options.design !== undefined,
    interactive,
  });
  const toolName = (name: string) => `mcp__${SERVER}__${name}`;

  // Claude Code는 읽기 도구를 동시에 부를 수 있다. 직접 만든 루프처럼 모델이 낸 순서대로 하나씩 실행한다
  const serial = serialQueue();
  // 실행 지표. modelMs는 모델 응답 대기가 SDK 안에서 일어나 이 러너가 관찰하지 못하므로 0으로 둔다.
  // 0은 "재지 않음"이고, 전체 시간에서 도구·게이트 시간을 뺀 추측값을 넣지 않는다
  const metrics: RunMetrics = { modelCalls: 0, maxContextTokens: 0, modelMs: 0, toolMs: 0, gateMs: 0, ...(guide ? { guideChars: guide.charsUsed } : {}) };
  const definitions = specs.map((spec) =>
    tool(spec.name, spec.description ?? '', zodShape(spec.input_schema), (args) =>
      serial(async () => {
        // 취소한 뒤 대기열에 남은 호출은 파일을 건드리지 않고 끝낸다
        signal?.throwIfAborted();
        onEvent({ type: 'tool_call', name: spec.name, input: args });
        // 지연 기동 세션: 첫 파일 변경·샌드박스 도구일 때 샌드박스를 켠다. 게이트(계약 기준)는 그 뒤에 만들어진다
        if (options.ensureSandbox && (SANDBOX_TOOLS.has(spec.name) || WRITE_TOOLS.has(spec.name))) {
          await options.ensureSandbox();
          gate = await gateFor();
        }
        const toolStarted = performance.now();
        const outcome = await executeTool(spec.name, args, context);
        metrics.toolMs += Math.round(performance.now() - toolStarted);
        onEvent({ type: 'tool_result', name: spec.name, ok: outcome.ok, content: outcome.content, chars: outcome.content.length, rawChars: outcome.rawChars ?? outcome.content.length });
        return { content: [{ type: 'text' as const, text: outcome.content }], isError: !outcome.ok };
      }),
    ),
  );

  const abort = new AbortController();
  const onAbort = () => abort.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });

  // 승격은 게이트의 실패 서명이 정한다. 같은 집합이 N번 반복되면 다음 게이트 재시도 query를 같은 세션에서
  // 이어받되 모델만 바꾼다. SDK는 query를 열 때 모델이 정해지므로 대화를 이어받는 새 query가 필요하다
  const escalation = options.escalation;
  const escalationHistory: string[] = [];
  let escalated = false;
  /** 마지막으로 모델에게 보낸 게이트 실패 안내. 상한이 소진된 뒤 승격하면 같은 안내를 다시 보낸다 */
  let lastFeedback: string | undefined;
  let modelForQuery = model;
  let resumeForQuery = resume;
  let pendingPrompt = ask ? buildAskRequest(request, { toolName, ...(researching ? { research: { webToolsAvailable: true } } : {}) }) : request;
  // 승격으로 다음 query를 열어야 하면 true. 게이트 재시도는 같은 대화에 이어 넣는다
  let reopen = false;

  const usage = emptyUsage();
  // 승격으로 query를 새로 열면 그 query의 modelUsage에는 승격 뒤 사용량만 온다.
  // 끝난 query들의 사용량(base)을 따로 쌓아 두고 지금 query의 것과 더해야 승격 전 사용량을 잃지 않는다
  const baseUsage = emptyUsage();
  const queryUsage = emptyUsage();
  let queryByModel: Record<string, AgentUsage> = {};
  const usageByModelBase: Record<string, AgentUsage> = {};
  const syncUsage = (): void => {
    usage.inputTokens = baseUsage.inputTokens + queryUsage.inputTokens;
    usage.outputTokens = baseUsage.outputTokens + queryUsage.outputTokens;
    usage.cacheReadTokens = baseUsage.cacheReadTokens + queryUsage.cacheReadTokens;
    usage.cacheWriteTokens = baseUsage.cacheWriteTokens + queryUsage.cacheWriteTokens;
  };
  const messageIds = new Set<string>();
  let sessionId: string | undefined;
  let lastText = '';
  let announced = false;
  let result: ClaudeCodeResult | undefined;
  // ask_user가 남긴 질문. 있으면 쿼리를 중단하고 awaiting_input으로 끝내 사용자 답을 기다린다
  let asked: AskUserQuestion | undefined;
  // 지금 열려 있는 query의 입력 큐. finish와 승격이 이 큐를 닫는다
  let currentInput: InputQueue | undefined;

  const finish = (status: AgentResult['status'], summary: string, question?: AskUserQuestion, failureReason?: AgentResult['failureReason']): void => {
    // 본 대화의 서로 다른 assistant 메시지 수. 이미 있는 messageIds Set의 크기와 같다
    metrics.modelCalls = messageIds.size;
    result = {
      status,
      summary,
      changedFiles: workspace.changedFiles(),
      ...(question ? { question } : {}),
      report: gate?.report,
      checks: gate?.checks,
      passedStages: gate ? [...gate.passedStages] : undefined,
      ...(options.verify === 'light' ? { verify: 'light' as const } : {}),
      ...(gate && gate.skippedStages.length > 0 ? { skippedStages: [...gate.skippedStages] } : {}),
      verifyAttempts: gate?.attempts ?? 0,
      turns: messageIds.size,
      usage,
      metrics: { ...metrics },
      sessionId,
      ...(failureReason ? { failureReason } : {}),
    };
    onEvent(status === 'failed' ? { type: 'failed', result } : { type: 'done', result });
    // 입력을 닫으면 Claude Code가 남은 기록을 쓰고 스스로 끝난다
    currentInput?.close();
  };

  /**
   * 일시적 네트워크 오류(ADR-142)에서 재시도할지 정한다. 지수 백오프로 기다린 뒤 true를 돌려주면 호출한 쪽이
   * 같은 세션을 resume으로 이어받은 새 query를 연다. 상한(횟수·총 대기 시간 중 먼저 걸리는 쪽)을 넘었거나
   * 아직 세션 id가 없어(첫 호출이 바로 끊긴 경우) 이어받을 대상이 없으면 false를 돌려준다 — 그 경우 호출한 쪽이
   * 원래 보내려던 요청을 그대로 다시 보낸다(resumeForQuery·pendingPrompt를 건드리지 않는다).
   */
  const retryAfterNetworkFailure = async (): Promise<boolean> => {
    if (networkAttempts >= networkMaxAttempts) return false;
    if (networkWaitedMs >= networkMaxWaitMs) return false;
    const delay = Math.min(networkBaseDelayMs * 2 ** networkAttempts, networkMaxWaitMs - networkWaitedMs);
    networkAttempts += 1;
    networkWaitedMs += delay;
    await networkWait(delay, signal);
    signal?.throwIfAborted();
    onEvent({
      type: 'warning',
      message: `네트워크 연결이 끊겨 ${Math.round(delay / 1000)}초 기다린 뒤 하던 작업을 이어서 진행합니다 (${networkAttempts}/${networkMaxAttempts}번째 재시도)`,
    });
    // 이어받을 세션이 있으면 그 세션을 resume으로 이어받아 짧은 안내만 보낸다(이미 한 작업을 다시 하지 않게).
    // 세션이 아직 없으면(첫 호출이 응답 전에 끊김) resumeForQuery·pendingPrompt를 그대로 둬 원래 요청을 다시 보낸다
    if (sessionId) {
      resumeForQuery = sessionId;
      pendingPrompt = NETWORK_RESUME_PROMPT;
    }
    return true;
  };

  /**
   * query 하나를 끝까지 돈다. 승격이면 같은 세션을 이어받은 새 query를 모델만 바꿔 다시 연다.
   * 메시지 처리는 한 곳에만 두어(되묻기·진행 중 지시·도구 결과 캐시·턴별 사용량이 그대로 동작) 두 번 부른다.
   */
  const runQuery = async (): Promise<void> => {
    // 이 query의 사용량. result의 modelUsage는 query 누적값이라 result마다 덮어쓴다
    resetUsage(queryUsage);
    queryByModel = {};
    const input = new InputQueue();
    currentInput = input;
    const conversation = sdk.query({
      prompt: input,
      options: {
        cwd: project.root,
        systemPrompt: buildSystemPrompt(project, { toolName, selfCheck: options.selfCheck }) + workflowContext(project) + projectGuideSection(guide),
        // 기본 도구를 모두 끄고 b-studio 도구만 허용한다. 허용 목록에 없는 도구는 묻지 않고 거부한다.
        // "조사" 모드(researching)만 예외로 내장 WebSearch·WebFetch를 더 연다 — 파일·명령 도구는 절대 열지 않는다
        // (읽기 전용은 여전히 ToolContext.readOnly=ask가 b-studio 도구 쪽에서 막는다)
        tools: researching ? ['WebSearch', 'WebFetch'] : [],
        mcpServers: { [SERVER]: sdk.createSdkMcpServer({ name: SERVER, version: '0.0.0', tools: definitions }) },
        allowedTools: researching ? [...specs.map((spec) => toolName(spec.name)), 'WebSearch', 'WebFetch'] : specs.map((spec) => toolName(spec.name)),
        permissionMode: 'dontAsk',
        strictMcpConfig: true,
        // 사용자 전역·프로젝트 설정(훅, 플러그인, CLAUDE.md)이 에이전트 동작을 바꾸지 않게 한다
        settingSources: [],
        model: modelForQuery,
        effort,
        maxTurns,
        abortController: abort,
        // 실패한 실행이 다음 요청의 대화를 오염시키지 않도록 매번 갈라서 이어받는다
        ...(resumeForQuery ? { resume: resumeForQuery, forkSession: true } : {}),
        env: queryEnv,
      },
    });
    input.push(pendingPrompt);

    // 진행 중 지시는 스트리밍 입력 큐에 사용자 메시지로 넣는다. 승격으로 새 query를 열어도 이 연결을 다시 건다.
    // SDK는 스트리밍 입력에서 큐에 들어온 사용자 메시지를(현재 도구 호출이 끝난 뒤) 다음 모델 호출에서 처리한다.
    // 지금 하던 도구 호출을 중간에 끊지 않는 것은 이 방식의 성질이다(근거는 결과 문서에 적음)
    const detachSteering = attachSteering(steering, input, onEvent);
    // 승격 분기에서 query를 닫기 전에 끊고, finally와 겹쳐도 한 번만 실행되게 감싼다
    let detached = false;
    const detachSteeringOnce = (): void => {
      if (detached) return;
      detached = true;
      detachSteering();
    };

    // 요약 중 상태를 한 번만 알리기 위한 표시(compact_boundary에서 푼다)
    let compacting = false;
    try {
      messages: for await (const message of conversation) {
        if ('session_id' in message && message.session_id) sessionId = message.session_id;
        if (result) {
          result.sessionId = sessionId;
          continue;
        }

        switch (message.type) {
          case 'system':
            // init은 턴마다 다시 올 수 있으므로 실행마다 한 번만 알린다
            if (message.subtype === 'init' && !announced) {
              announced = true;
              onEvent({
                type: 'session',
                backend: `${BACKEND} (CLI ${message.claude_code_version})`,
                model: message.model,
                auth: account ? describeAccount(account) : undefined,
                effort,
              });
            }
            // 요약이 시작됐다. SDK는 같은 상태를 되풀이해 보낼 수 있어 요약 한 번에 한 번만 알린다
            if (message.subtype === 'status' && message.status === 'compacting' && !compacting) {
              compacting = true;
              onEvent({ type: 'context_compacting' });
            }
            if (message.subtype === 'compact_boundary') {
              compacting = false;
              const { trigger, pre_tokens, post_tokens, duration_ms } = message.compact_metadata;
              onEvent({
                type: 'context_compacted',
                trigger,
                preTokens: pre_tokens,
                ...(post_tokens !== undefined ? { postTokens: post_tokens } : {}),
                ...(duration_ms !== undefined ? { durationMs: duration_ms } : {}),
              });
            }
            break;

          case 'assistant': {
            // 하위 에이전트 메시지는 없어야 하지만, 섞여 와도 본 대화로 세지 않는다
            if (message.parent_tool_use_id) break;
            // 한 호출의 입력 크기 = input + cache_read + cache_creation. 같은 id가 여러 번 와도 최댓값은 같다
            const messageUsage = message.message.usage;
            const turnContext = messageUsage
              ? (messageUsage.input_tokens ?? 0) + (messageUsage.cache_read_input_tokens ?? 0) + (messageUsage.cache_creation_input_tokens ?? 0)
              : 0;
            if (messageUsage) {
              metrics.maxContextTokens = Math.max(metrics.maxContextTokens, turnContext);
            }
            if (!messageIds.has(message.message.id)) {
              messageIds.add(message.message.id);
              const turn = messageIds.size;
              onEvent({ type: 'turn', turn });
              // 턴 하나의 사용량. 같은 메시지 id가 여러 번 와도 한 번만 남긴다(누적값 tokens와 다르다)
              if (messageUsage) {
                onEvent({
                  type: 'turn_usage',
                  turn,
                  inputTokens: messageUsage.input_tokens ?? 0,
                  outputTokens: messageUsage.output_tokens ?? 0,
                  cacheReadTokens: messageUsage.cache_read_input_tokens ?? 0,
                  cacheWriteTokens: messageUsage.cache_creation_input_tokens ?? 0,
                  contextTokens: turnContext,
                });
              }
              if (turn > maxTurns) {
                await conversation.interrupt().catch(() => {});
                // 턴 상한에 걸렸다. 바로 실패로 끝내지 않고 지금까지의 변경이 게이트를 통과하는지 한 번 더 본다(ADR-131)
                const gateStarted = performance.now();
                const recheck = await recheckGateOnMaxTurns(gate, maxTurns, onEvent);
                metrics.gateMs += Math.round(performance.now() - gateStarted);
                if (recheck.pass) finish('done', recheck.summary);
                else finish('failed', recheck.summary, undefined, 'max_turns');
                break;
              }
            }
            const text = message.message.content
              .flatMap((block) => (block.type === 'text' ? [block.text] : []))
              .join('\n')
              .trim();
            if (text) {
              onEvent({ type: 'text', text });
              lastText = text;
            }
            break;
          }

          case 'result': {
            // modelUsage는 이 query의 누적값이다. 끝난 query들의 사용량(base)과 더해 실행 전체를 만든다
            setUsage(queryUsage, message);
            syncUsage();
            queryByModel = usageByModelOf(message);
            metrics.usageByModel = mergeUsageByModel(usageByModelBase, queryByModel);
            onEvent({ type: 'tokens', usage: { ...usage } });
            const failure = describeResultFailure(message);
            if (failure) {
              // Claude Code 자신이 턴 상한(error_max_turns)으로 끝냈어도, 바로 실패로 끝내지 않고 지금까지의
              // 변경이 게이트를 통과하는지 한 번 더 본다(ADR-131). 다른 실패 사유(오류 등)는 그대로 바로 끝낸다
              if (message.subtype === 'error_max_turns') {
                const gateStarted = performance.now();
                const recheck = await recheckGateOnMaxTurns(gate, maxTurns, onEvent);
                metrics.gateMs += Math.round(performance.now() - gateStarted);
                if (recheck.pass) finish('done', recheck.summary);
                else finish('failed', recheck.summary, undefined, 'max_turns');
                break;
              }
              // 일시적 네트워크 오류(ENOTFOUND 등, ADR-142)면 바로 실패로 끝내지 않고 기다렸다 같은 세션을 이어받는다.
              // 승격처럼 이 query는 여기서 닫고 새 query를 연다(reopen). 상한을 넘으면 실패로 끝나되 사유를 남긴다
              if (isTransientNetworkFailure(failure)) {
                detachSteeringOnce();
                if (await retryAfterNetworkFailure()) {
                  conversation.close();
                  reopen = true;
                  break messages;
                }
                finish('failed', `네트워크 연결이 끊겨 재시도했지만 복구되지 않았습니다: ${failure}`, undefined, 'network');
                break;
              }
              finish('failed', failure);
              break;
            }
            // 되묻고 멈추기: ask_user가 질문을 남겼으면 쿼리를 중단하고 실행을 끝낸다.
            // 세션 id는 그대로 저장되어 다음 요청이 이 대화를 이어받는다.
            // 질문 전에 파일을 바꿨다면 그 변경도 게이트를 돌린다(변경이 없으면 돌리지 않는다)
            if (asked) {
              await conversation.interrupt().catch(() => {});
              const openGate = gate;
              if (openGate && workspace.changedFiles().length > 0) {
                const gateStarted = performance.now();
                await openGate.check();
                metrics.gateMs += Math.round(performance.now() - gateStarted);
              }
              finish('awaiting_input', asked.question, asked);
              break;
            }
            // 모델이 턴을 끝냈다 → 질문이면 답이 곧 결과이고, 만들기면 검증 게이트.
            // 지연 기동 세션이 아무것도 바꾸지 않았으면 게이트가 없다 → 샌드박스 없이 끝난다
            const activeGate = gate;
            if (!activeGate) {
              finish('done', lastText);
              break;
            }
            const gateStarted = performance.now();
            const outcome = await activeGate.check();
            metrics.gateMs += Math.round(performance.now() - gateStarted);
            if (outcome.kind === 'pass') {
              if (activeGate.verified) onEvent({ type: 'stage', stage: 'checkpoint', source: 'platform' });
              finish('done', lastText);
            }
            else {
              if (outcome.kind === 'retry') lastText = '';
              // 승격: 같은 서명이 반복되거나, 설정이 있으면 실패 N번이 계기가 된다. 한 실행에 한 번만 올린다
              if (escalation && !escalated) {
                const key = signatureSetKey(activeGate.report, activeGate.checks);
                escalationHistory.push(key);
                if (shouldPromote(escalation, escalationHistory)) {
                  // 올라간 모델에게 게이트 재시도를 새로 준다(기존 남은 횟수 대신)
                  const extended = activeGate.grantRetryBudget(retryBudgetFor(escalation));
                  // 상한이 이미 소진됐는데 예산도 못 받았으면 올려도 시도할 기회가 없다 — 아래에서 실패로 끝난다
                  if (outcome.kind === 'retry' || extended) {
                    escalated = true;
                    metrics.escalatedAt = activeGate.attempts;
                    // 닫히는 입력 큐로 지시가 들어가 사라지지 않게, close보다 먼저 이 query의 지시 연결을 끊는다.
                    // 그 뒤 들어온 지시는 큐에 남아 새 query가 연결할 때 flush로 가져간다
                    detachSteeringOnce();
                    onEvent({
                      type: 'model_escalated',
                      from: modelForQuery ?? '기본 모델',
                      to: escalation.to,
                      attempt: activeGate.attempts,
                      signature: key,
                      sameSignatureTimes: escalation.sameSignatureTimes ?? DEFAULT_SAME_SIGNATURE_TIMES,
                    });
                    modelForQuery = escalation.to;
                    resumeForQuery = sessionId;
                    // 상한을 새로 받은 경우에는 마지막 실패 안내를 다시 보낸다(올라간 모델이 무엇을 고칠지 알게)
                    pendingPrompt = outcome.kind === 'exhausted' ? escalationPrompt(outcome.summary, lastFeedback) : outcome.feedback;
                    conversation.close();
                    reopen = true;
                    // 같은 대화를 이어받아 모델만 바꾸려면 새 query를 열어야 한다. 이 query는 여기서 닫는다
                    break messages;
                  }
                }
              }
              if (outcome.kind === 'exhausted') finish('failed', outcome.summary);
              else {
                lastFeedback = outcome.feedback;
                input.push(outcome.feedback);
              }
            }
            break;
          }
        }
      }
    } catch (error) {
      conversation.close();
      throw error;
    } finally {
      detachSteeringOnce();
      input.close();
      // 이 query의 사용량을 실행 전체 누적에 더한다. 승격이 없으면 여기서 한 번만 더해 결과가 지금과 같다
      addUsageInto(baseUsage, queryUsage);
      for (const [model, usage] of Object.entries(queryByModel)) addUsageInto((usageByModelBase[model] ??= emptyUsage()), usage);
    }
  };

  // 승격이 일어나면 같은 세션을 이어받은 새 query를 모델만 바꿔 다시 연다. 그 밖에는 한 query로 끝까지 돈다
  try {
    for (;;) {
      reopen = false;
      await runQuery();
      if (result) break;
      if (!reopen) throw new Error('Claude Code가 결과를 보내지 않고 종료됐습니다');
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // 프로세스를 닫아도 이미 시작한 도구 핸들러는 이어서 돈다. 호출한 쪽이 변경을 되돌리기 전에 끝나기를 기다린다
    await serial.idle();
  }

  signal?.throwIfAborted();
  if (!result) throw new Error('Claude Code가 결과를 보내지 않고 종료됐습니다');
  return result;
}

/**
 * 진행 중 지시를 스트리밍 입력 큐에 넣는다. 알림(onPush)이 있으면 즉시, 없으면 짧은 주기로 확인한다.
 * 돌려준 함수로 구독이나 주기 확인을 멈춘다.
 */
function attachSteering(steering: Steering | undefined, input: InputQueue, onEvent: (event: AgentEvent) => void): () => void {
  if (!steering) return () => {};
  const flush = () => {
    const texts = takeSteering(steering);
    if (texts.length === 0) return;
    input.push(formatSteering(texts));
    onEvent({ type: 'steer_applied', count: texts.length });
  };
  let detach: () => void;
  if (steering.onPush) detach = steering.onPush(flush);
  else {
    const timer = setInterval(flush, STEERING_POLL_MS);
    timer.unref();
    detach = () => clearInterval(timer);
  }
  // 승격으로 새 query를 열 때처럼 연결하기 전에 이미 쌓여 있던 지시를 바로 꺼낸다
  flush();
  return detach;
}

/**
 * 샌드박스를 띄우기 전에 이 PC의 Claude Code가 실행되고 로그인돼 있는지 확인한다.
 * 프롬프트를 보내지 않으므로 사용량을 쓰지 않는다.
 */
export async function preflightClaudeCode(
  { sdk = DEFAULT_SDK, cwd = process.cwd(), timeoutMs = 60_000 }: { sdk?: ClaudeCodeSdk; cwd?: string; timeoutMs?: number } = {},
): Promise<{ ok: true; account: ClaudeCodeAccount } | { ok: false; reason: string }> {
  const input = new InputQueue();
  const conversation = sdk.query({
    prompt: input,
    options: { cwd, tools: [], settingSources: [], strictMcpConfig: true, permissionMode: 'dontAsk', persistSession: false },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const info = await Promise.race([
      conversation.accountInfo(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${timeoutMs / 1000}초 안에 응답하지 않았습니다`)), timeoutMs);
      }),
    ]);
    // 이메일·조직은 화면과 로그에 남기지 않는다
    const account: ClaudeCodeAccount = {
      subscriptionType: info.subscriptionType,
      apiKeySource: info.apiKeySource,
      apiProvider: info.apiProvider,
    };
    const firstParty = (info.apiProvider ?? 'firstParty') === 'firstParty';
    if (firstParty && !info.subscriptionType && !info.apiKeySource && !info.tokenSource) {
      return { ok: false, reason: 'Claude Code에 로그인돼 있지 않습니다. 터미널에서 `claude`를 실행해 /login으로 로그인하세요.' };
    }
    return { ok: true, account };
  } catch (error) {
    return {
      ok: false,
      reason: `로컬 Claude Code를 실행하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
    input.close();
    conversation.close();
  }
}

/**
 * 로그인한 계정의 Claude Code가 실제로 보고하는 모델 목록. 프롬프트를 보내지 않으므로 사용량을 쓰지 않는다
 * (preflightClaudeCode와 같은 모양: 아무것도 내보내지 않는 프롬프트로 query를 열고 필요한 정보만 받은 뒤 바로 닫는다).
 * 별칭(opus·sonnet·haiku·fable)이 실제로 풀리는 모델 id·공식 설명·노력 단계 지원 여부가 로그인 계정·CLI 버전에 따라 바뀌므로
 * 스튜디오가 미리 표를 외우는 대신 이 목록을 그대로 쓴다(apps/studio/lib/server/claude-code-models.ts가 캐시·대체 표를 맡는다).
 */
export async function fetchClaudeCodeModels(
  { sdk = DEFAULT_SDK, cwd = process.cwd(), timeoutMs = 15_000 }: { sdk?: ClaudeCodeSdk; cwd?: string; timeoutMs?: number } = {},
): Promise<ModelInfo[]> {
  const input = new InputQueue();
  const conversation = sdk.query({
    prompt: input,
    options: { cwd, tools: [], settingSources: [], strictMcpConfig: true, permissionMode: 'dontAsk', persistSession: false },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      conversation.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${timeoutMs / 1000}초 안에 응답하지 않았습니다`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    input.close();
    await conversation.interrupt().catch(() => {});
    conversation.close();
  }
}

export function describeAccount(account: ClaudeCodeAccount): string {
  if (account.apiKeySource && account.apiKeySource !== 'none') return `API 키 (${account.apiKeySource})`;
  if (account.subscriptionType) return `${account.subscriptionType} 구독`;
  if (account.apiProvider && account.apiProvider !== 'firstParty') return account.apiProvider;
  return '로그인 계정';
}

export function describeResultFailure(message: SDKResultMessage): string | undefined {
  switch (message.subtype) {
    case 'success':
      if (message.is_error) return `모델 호출이 실패했습니다: ${message.result}`;
      if (message.stop_reason === 'refusal') return '모델이 요청을 거절했습니다';
      return undefined;
    case 'error_max_turns':
      return 'Claude Code의 최대 턴 수를 넘었습니다';
    case 'error_max_budget_usd':
      return 'Claude Code의 비용 한도를 넘었습니다';
    default:
      return `Claude Code 실행 중 오류가 났습니다${message.errors.length > 0 ? `: ${message.errors.join('; ')}` : ''}`;
  }
}

type AssistantTokenUsage = {
  input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** modelUsage는 query 전체의 누적값이므로 더하지 않고 최신 값으로 바꾼다 */
function setUsage(usage: AgentUsage, message: SDKResultMessage): void {
  const models = Object.values(message.modelUsage ?? {});
  usage.inputTokens = models.reduce((sum, model) => sum + model.inputTokens, 0);
  usage.outputTokens = models.reduce((sum, model) => sum + model.outputTokens, 0);
  usage.cacheReadTokens = models.reduce((sum, model) => sum + model.cacheReadInputTokens, 0);
  usage.cacheWriteTokens = models.reduce((sum, model) => sum + model.cacheCreationInputTokens, 0);
}

/** 사용량을 0으로 되돌린다 */
function resetUsage(usage: AgentUsage): void {
  usage.inputTokens = 0;
  usage.outputTokens = 0;
  usage.cacheReadTokens = 0;
  usage.cacheWriteTokens = 0;
}

/** 사용량을 다른 곳에 더한다 */
function addUsageInto(target: AgentUsage, source: AgentUsage): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
}

/** result의 modelUsage(query 하나의 누적값)를 모델 이름별 AgentUsage로 옮긴다 */
function usageByModelOf(message: SDKResultMessage): Record<string, AgentUsage> {
  const byModel: Record<string, AgentUsage> = {};
  for (const [model, usage] of Object.entries(message.modelUsage ?? {})) {
    byModel[model] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      cacheWriteTokens: usage.cacheCreationInputTokens,
    };
  }
  return byModel;
}

/** 끝난 query들의 모델별 사용량(base)과 지금 query의 것(query)을 더해 실행 전체로 만든다 */
function mergeUsageByModel(base: Record<string, AgentUsage>, query: Record<string, AgentUsage>): Record<string, AgentUsage> {
  const out: Record<string, AgentUsage> = {};
  for (const [model, usage] of Object.entries(base)) out[model] = { ...usage };
  for (const [model, usage] of Object.entries(query)) addUsageInto((out[model] ??= emptyUsage()), usage);
  return out;
}

/**
 * Claude Code 메시지 스트림에서 실행 지표를 모으는 규칙. 로컬 러너와 기준선(P0, plain-baseline)이 같은 계산을 쓴다.
 * - 서로 다른 assistant 메시지 id가 곧 모델 호출 수다(같은 id가 여러 번 와도 한 번으로 센다)
 * - 한 호출의 입력 크기(input+cache_read+cache_creation)의 최댓값을 남긴다
 * - result의 modelUsage는 query 전체 누적값이라 더하지 않고 최신 값으로 바꾼다
 */
export class ClaudeCodeUsageTracker {
  readonly #messageIds = new Set<string>();
  readonly #usage: AgentUsage = emptyUsage();
  #usageByModel: Record<string, AgentUsage> = {};
  #maxContextTokens = 0;

  /** assistant 메시지 하나를 반영한다. 처음 보는 메시지 id면 true(모델 호출 1회) */
  observeAssistant(message: { id: string; usage?: AssistantTokenUsage | null }): boolean {
    const usage = message.usage;
    if (usage) {
      this.#maxContextTokens = Math.max(
        this.#maxContextTokens,
        (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      );
    }
    if (this.#messageIds.has(message.id)) return false;
    this.#messageIds.add(message.id);
    return true;
  }

  /** result의 modelUsage를 반영한다(누적값이므로 최신 값으로 바꾼다) */
  observeResult(message: SDKResultMessage): void {
    this.#usageByModel = usageByModelOf(message);
    const models = Object.values(message.modelUsage ?? {});
    this.#usage.inputTokens = models.reduce((sum, model) => sum + model.inputTokens, 0);
    this.#usage.outputTokens = models.reduce((sum, model) => sum + model.outputTokens, 0);
    this.#usage.cacheReadTokens = models.reduce((sum, model) => sum + model.cacheReadInputTokens, 0);
    this.#usage.cacheWriteTokens = models.reduce((sum, model) => sum + model.cacheCreationInputTokens, 0);
  }

  /** 서로 다른 assistant 메시지 수 = 모델 호출 수 */
  get modelCalls(): number {
    return this.#messageIds.size;
  }

  /** 호출 한 번의 최대 입력 크기 */
  get maxContextTokens(): number {
    return this.#maxContextTokens;
  }

  /** 지금까지 합산한 토큰. 바꾸지 말고 복사해서 쓴다 */
  get usage(): AgentUsage {
    return this.#usage;
  }

  /** 모델 이름별 토큰(result의 modelUsage 키). 모델마다 단가가 달라 환산 비용에 쓴다 */
  get usageByModel(): Record<string, AgentUsage> {
    return Object.fromEntries(Object.entries(this.#usageByModel).map(([model, usage]) => [model, { ...usage }]));
  }
}

type JsonProperty = { type?: string; enum?: unknown[]; items?: { type?: string }; description?: string };

/**
 * 도구 스키마는 buildTools 한 곳에서만 정의하고, MCP 도구가 요구하는 zod 형태로 옮긴다.
 * b-studio 도구가 쓰는 형태(문자열·열거형·정수·문자열 배열)만 지원하고 나머지는 바로 드러낸다.
 */
export function zodShape(schema: { properties?: unknown }): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries((schema.properties ?? {}) as Record<string, JsonProperty>)) {
    let type: z.ZodType;
    if (value.type === 'string' && value.enum?.length) type = z.enum(value.enum.map(String) as [string, ...string[]]);
    else if (value.type === 'string') type = z.string();
    else if (value.type === 'integer') type = z.number().int();
    else if (value.type === 'boolean') type = z.boolean();
    else if (value.type === 'array' && value.items?.type === 'string') type = z.array(z.string());
    else throw new Error(`지원하지 않는 도구 입력 형식입니다: ${key} ${JSON.stringify(value)}`);
    shape[key] = value.description ? type.describe(value.description) : type;
  }
  return shape;
}

/**
 * 도구 호출을 모델이 낸 순서대로 하나씩 실행한다. 로컬 Claude Code 러너와 Codex 러너가 같이 쓴다.
 * 끝난 뒤 실행 중이던 호출까지 기다릴 수 있게 idle()을 함께 돌려준다.
 */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.catch(() => {});
    return next;
  };
  return Object.assign(enqueue, { idle: () => tail });
}

/** 스트리밍 입력. 게이트 결과를 같은 대화에 이어 넣고, 끝나면 닫는다 */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  readonly #pending: SDKUserMessage[] = [];
  readonly #waiting: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  #closed = false;

  push(text: string): void {
    if (this.#closed) return;
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    const waiter = this.#waiting.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.#pending.push(message);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.#pending.shift();
        if (message) return Promise.resolve({ value: message, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiting.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
