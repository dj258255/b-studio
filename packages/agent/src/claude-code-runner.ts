import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Effort } from './anthropic-client';
import { childEnv, resolveCliCommand, spawnClaudeCli, type CliMessage, type CliStopOptions, type ClaudeCliProcess } from './claude-cli-process';
import { DEFAULT_SAME_SIGNATURE_TIMES, escalationPrompt, retryBudgetFor, shouldPromote, signatureSetKey, type EscalationPolicy } from './escalation';
import { recheckGateOnMaxTurns, VerificationGate } from './gate';
import { emptyUsage, formatSteering, takeSteering, type AgentEvent, type AgentResult, type AgentUsage, type RunAgentOptions, type RunMetrics, type Steering } from './loop';
import { decodeNative, encodeNative, native } from '@b-studio/sandbox';
import { startToolServer, type ToolServer } from './mcp-http-server';
import { loadProjectGuide } from './project-guide';
import { buildAskRequest, buildSystemPrompt, projectGuideSection, withLanguageReminder } from './prompts';
import { serialQueue } from './tool-schema';
import { createToolResultCache } from './tool-output';
import { buildTools, createMismatchLog, executeTool, SANDBOX_TOOLS, WRITE_TOOLS, type AskUserQuestion, type BoardAccess, type ToolContext } from './tools';
import { fetchContract } from './verify';
import { executionPolicyFor, workflowContext } from './workflow';
import { syncExternalChanges, Workspace } from './workspace';

export { serialQueue, zodShape } from './tool-schema';

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
 * 자동 압축 기준 창(토큰). 이어받은 대화가 이 크기에 닿으면 CLI가 앞부분을 요약한다(ADR-151).
 * 200,000은 200K 창 모델의 표준 동작과 같은 수준이다. 1M 창 모델은 CLI 기본이 훨씬 커서 대화가 수십만 토큰까지 자란다.
 */
export const DEFAULT_COMPACT_WINDOW = 200_000;
/** 이보다 작은 창은 압축이 너무 자주 일어나 쓸모가 없으므로 무시한다 */
export const MIN_COMPACT_WINDOW = 50_000;
export const COMPACT_WINDOW_ENV = 'B_STUDIO_CLAUDE_CODE_COMPACT_WINDOW';
/** CLI가 읽는 자동 압축 창 환경 변수(https://code.claude.com/docs/en/env-vars) */
const CLI_COMPACT_WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
/** 이어받을 대화의 id는 CLI가 준 값(UUID)만 받는다. 아니면 인자에 넣지 않는다 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MCP_TOKEN_ENV = 'B_STUDIO_MCP_TOKEN';

export interface CompactWindowSetting {
  /** CLI에 넘길 창 크기. null이면 넘기지 않아 CLI 기본 동작을 쓴다 */
  window: number | null;
  /** 값을 무시하고 기본값을 쓴 경우의 안내 */
  ignored?: string;
}

/**
 * B_STUDIO_CLAUDE_CODE_COMPACT_WINDOW 값을 해석한다(순수 함수, 판정은 Rust: crates/bstudio-guard/src/runner_judge.rs).
 * 비어 있으면 기본값, `0`·`off`면 끄기(null), 숫자가 아니거나 MIN_COMPACT_WINDOW 미만이면 기본값을 쓰고 이유를 돌려준다.
 */
export function resolveCompactWindow(raw: string | undefined): CompactWindowSetting {
  return decodeNative<CompactWindowSetting>(native.runnerResolveCompactWindow(raw));
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
  return native.runnerIsTransientNetworkFailure(message);
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

/**
 * `claude -p --output-format stream-json`의 모델 목록 한 항목. 이전에는 Agent SDK의 `supportedModels()`가 주던 꼴이다.
 * 공개 CLI 입출력에는 모델 목록을 묻는 방법이 없어 지금은 화면의 알려진 표가 같은 꼴을 직접 쓴다.
 */
export interface ModelInfo {
  /** 모델 별칭(`sonnet`)이나 id. 빈 문자열이면 계정의 기본 모델 */
  value: string;
  resolvedModel: string;
  displayName: string;
  description: string;
  supportedEffortLevels?: string[];
}

export interface ClaudeCodeAccount {
  subscriptionType?: string;
  apiKeySource?: string;
  apiProvider?: string;
}

export interface ClaudeCodeRunOptions extends Omit<RunAgentOptions, 'client' | 'conversation' | 'escalation'> {
  /**
   * 게이트 실패 서명이 `sameSignatureTimes`번 반복되면 다음 게이트 재시도부터 `to` 모델로 돈다.
   * 모델은 프로세스를 띄울 때 정해지므로, 같은 세션을 이어받는 새 프로세스를 모델만 바꿔 띄운다.
   */
  escalation?: EscalationPolicy;
  /** 이전 요청을 처리한 Claude Code 세션(CLI가 준 UUID). 넘기면 그 대화를 이어받는다 */
  resume?: string;
  /** 넘기지 않으면 로그인한 계정의 기본 모델을 쓴다 */
  model?: string;
  effort?: Effort;
  /** preflight에서 확인한 인증 정보. 화면에 어떤 계정으로 실행하는지 표시한다 */
  account?: ClaudeCodeAccount;
  /** 실행할 CLI 실행 파일(기본 `claude`). 테스트가 가짜 CLI를 끼우는 자리. 셸을 거치지 않고 인자 배열로 넘긴다 */
  command?: string;
  /** 실행 파일 바로 뒤, 이 러너가 붙이는 인자 앞에 오는 인자(가짜 CLI의 스크립트 경로 등) */
  commandArgs?: readonly string[];
  /** 자식 프로세스를 끝낼 때 기다리는 시간(테스트 전용 주입점). 기본: 입력을 닫고 10초 뒤 SIGTERM, 5초 뒤 SIGKILL */
  stop?: CliStopOptions;
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
 * `claude` CLI를 공개 입출력(`-p --input-format stream-json --output-format stream-json`)으로 띄운다. Agent SDK는 쓰지 않는다(ADR-194).
 * Claude Code의 기본 도구(Bash, Read, Edit …)와 사용자 설정·훅·플러그인은 모두 끄고,
 * b-studio 도구만 루프백 HTTP MCP 서버로 넘긴다. 모델이 작업 공간 규칙과 샌드박스를 우회해 호스트를 건드리지 못하게 하기 위해서다.
 * 완료 판정은 직접 만든 루프와 같은 검증 게이트가 한다. 모델이 턴을 끝낼 때마다(result 메시지) 게이트를 돌리고,
 * 실패하면 결과를 다음 사용자 메시지(표준 입력의 한 줄)로 넣는다.
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
    command = 'claude',
    commandArgs = [],
    stop: stopOptions,
    interactive = false,
    intent = 'build',
    research = false,
    steering,
    networkRetry = {},
    env: processEnv = process.env,
  } = options;
  signal?.throwIfAborted();
  // 자동 압축 기준 창. 사용자가 프로세스 환경에 직접 준 값은 덮어쓰지 않는다. 모든 프로세스(재시도·승격으로 다시 띄우는 것 포함)가 이 env를 쓴다.
  // (SDK가 붙이던 CLAUDE_AGENT_SDK_CLIENT_APP은 공식 환경 변수 문서에 없어 넘기지 않는다 — ADR-189)
  const compact = processEnv[CLI_COMPACT_WINDOW_ENV]?.trim() ? { window: null } : resolveCompactWindow(processEnv[COMPACT_WINDOW_ENV]);
  const queryEnv: NodeJS.ProcessEnv = {
    ...processEnv,
    ...(compact.window !== null ? { [CLI_COMPACT_WINDOW_ENV]: String(compact.window) } : {}),
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
  // 요구사항 문서의 기준을 고정한다(게이트가 사람 확인 기록 위조를 견주는 기준, ADR-157). 호출자가 마지막 체크포인트의
  // 문서를 넘겼으면 그것을, 아니면 지금 디스크의 문서를 쓴다
  workspace.beginRun(options.requirementsBaseline);
  // 이번 실행 전부터 작업 트리에 있던 변경(보관본 되살리기 등)을 먼저 알려, 에이전트가 이번 실행에서 파일을
  // 하나도 건드리지 않아도 게이트가 "검증할 변경 없음"으로 건너뛰지 않게 한다(ADR-131)
  if (options.externalChanges?.length) syncExternalChanges(workspace, options.externalChanges);
  // 질문 모드는 파일을 바꾸지 않으므로 계약 기준을 잡거나 게이트를 돌리지 않는다.
  // 지연 기동 세션(ensureSandbox)은 게이트를 여기서 만들지 않고, 첫 파일 변경·샌드박스 도구 때 샌드박스를 켠 뒤에 만든다.
  // 계약 기준은 샌드박스가 켜진 뒤, 아직 바뀌지 않은 코드에서 잡아야 하기 때문이다(API 경로와 같은 규칙)
  let gate: VerificationGate | undefined;
  let gatePromise: Promise<VerificationGate> | undefined;
  const gateFor = (): Promise<VerificationGate> =>
    (gatePromise ??= VerificationGate.create({ project, sandbox, workspace, allowBreaking, maxVerifyAttempts, verify: options.verify, allowCheckChanges: options.allowCheckChanges, outsideChanges: options.outsideChanges, fetcher, pageFetcher, browserRunner, saveArtifact, onBrowserFrame, signal, onServiceStatus, onEvent }));
  if (!ask && !options.ensureSandbox) gate = await gateFor();
  // 프로젝트 루트(세션 작업 복사본)의 AGENTS.md를 실행마다 새로 읽는다(ADR-077). 승격으로 runQuery를 다시 열어도
  // 같은 실행 안이므로 다시 읽지 않고 이 값을 그대로 재사용한다(아래 클로저가 캡처한다)
  const guide = await loadProjectGuide(project);
  // report_mismatch가 남긴 어긋남. 결과에 실어 호출자가 "확인 필요"로 보인다(#666)
  const mismatches = createMismatchLog();
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
    onMismatch: (mismatch) => {
      if (mismatches.add(mismatch)) onEvent({ type: 'mismatch', ...mismatch });
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
    ...(options.board ? { board: options.board } : {}),
    // 허용 도구 목록은 조율 도구와 어긋남 보고 도구를 넣을지 정할 때만 쓴다
    ...(context.policy?.allowedTools ? { allowedTools: context.policy.allowedTools } : {}),
    design: options.design !== undefined,
    interactive,
    mismatch: !ask,
  });
  const toolName = (name: string) => `mcp__${SERVER}__${name}`;

  // Claude Code는 읽기 도구를 동시에 부를 수 있다. 직접 만든 루프처럼 모델이 낸 순서대로 하나씩 실행한다
  const serial = serialQueue();
  // 실행 지표. 모델 응답 대기는 CLI 안에서 일어나 이 러너가 직접 재지 못한다. CLI가 result에 실어 주는 API 호출 시간 합(duration_api_ms)을
  // modelMs로 쓰고, result가 한 번도 오지 않으면 비워 둔다("재지 않음"). 전체 시간에서 도구·게이트 시간을 뺀 추측값은 넣지 않는다
  const metrics: RunMetrics = { modelCalls: 0, maxContextTokens: 0, toolMs: 0, gateMs: 0, ...(guide ? { guideChars: guide.charsUsed } : {}) };
  /** 실행이 끝났거나 끝내는 중이면 true. 그 뒤에 도착하는 도구 호출은 파일을 건드리지 않고 거절한다 */
  let toolsClosed = false;
  const runTool = (name: string, args: unknown) =>
    serial(async () => {
      // 취소하거나 끝낸 뒤 대기열에 남은 호출은 파일을 건드리지 않고 끝낸다
      signal?.throwIfAborted();
      if (toolsClosed) throw new Error('이 실행은 이미 끝나 도구를 쓸 수 없습니다');
      onEvent({ type: 'tool_call', name, input: args });
      // 지연 기동 세션: 첫 파일 변경·샌드박스 도구일 때 샌드박스를 켠다. 게이트(계약 기준)는 그 뒤에 만들어진다
      if (options.ensureSandbox && (SANDBOX_TOOLS.has(name) || WRITE_TOOLS.has(name))) {
        await options.ensureSandbox();
        gate = await gateFor();
      }
      const toolStarted = performance.now();
      const outcome = await executeTool(name, args, context);
      metrics.toolMs += Math.round(performance.now() - toolStarted);
      onEvent({ type: 'tool_result', name, ok: outcome.ok, content: outcome.content, chars: outcome.content.length, rawChars: outcome.rawChars ?? outcome.content.length });
      return outcome;
    });

  // 지금 떠 있는 CLI 프로세스. 취소하면 입력을 닫고 바로 SIGTERM을 보낸다(진행 중인 턴을 끝까지 기다리지 않는다)
  let currentProc: ClaudeCliProcess | undefined;
  const onAbort = () => currentProc?.stop('now');
  signal?.addEventListener('abort', onAbort, { once: true });

  // 승격은 게이트의 실패 서명이 정한다. 같은 집합이 N번 반복되면 다음 게이트 재시도 프로세스를 같은 세션에서
  // 이어받되 모델만 바꾼다. 모델은 프로세스를 띄울 때 정해지므로 대화를 이어받는 새 프로세스가 필요하다
  const escalation = options.escalation;
  const escalationHistory: string[] = [];
  let escalated = false;
  /** 마지막으로 모델에게 보낸 게이트 실패 안내. 상한이 소진된 뒤 승격하면 같은 안내를 다시 보낸다 */
  let lastFeedback: string | undefined;
  let modelForQuery = model;
  let resumeForQuery = resume;
  // 요청 글 끝에 언어 알림을 붙인다. 지시문에만 적으면 진행 문장이 영어로 나온다(트러블슈팅 132)
  let pendingPrompt = withLanguageReminder(ask ? buildAskRequest(request, { toolName, ...(researching ? { research: { webToolsAvailable: true } } : {}) }) : request);
  // 승격으로 다음 프로세스를 띄워야 하면 true. 게이트 재시도는 같은 대화에 이어 넣는다
  let reopen = false;
  // 마지막으로 끝난 프로세스의 종료 상태. 결과 없이 끝났을 때 실패 메시지에 쓴다
  let lastExit: { code: number | null; signal: NodeJS.Signals | null; error?: Error; stderr: string } | undefined;

  const usage = emptyUsage();
  // 승격으로 프로세스를 새로 띄우면 그 프로세스의 modelUsage에는 승격 뒤 사용량만 온다.
  // 끝난 프로세스들의 사용량(base)을 따로 쌓아 두고 지금 프로세스의 것과 더해야 승격 전 사용량을 잃지 않는다
  const baseUsage = emptyUsage();
  const queryUsage = emptyUsage();
  let queryByModel: Record<string, AgentUsage> = {};
  const usageByModelBase: Record<string, AgentUsage> = {};
  // duration_api_ms도 modelUsage처럼 이 프로세스의 누적값이다(한 프로세스에서 result가 두 번 오면 3,333 → 5,997ms로 늘었다).
  // 끝난 프로세스들의 값(base)에 지금 프로세스의 값을 더한다
  let modelMsBase = 0;
  let queryModelMs: number | undefined;
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
  // ask_user가 남긴 질문. 있으면 입력을 닫아 CLI를 끝내고 awaiting_input으로 끝내 사용자 답을 기다린다
  let asked: AskUserQuestion | undefined;

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
      ...(gate?.lastOutcome ? { gateOutcome: gate.lastOutcome } : {}),
      passedStages: gate ? [...gate.passedStages] : undefined,
      ...(options.verify === 'light' ? { verify: 'light' as const } : {}),
      ...(status === 'done' && gate?.passedAtTurnLimit ? { incomplete: 'max_turns' as const } : {}),
      ...(gate && gate.skippedStages.length > 0 ? { skippedStages: [...gate.skippedStages] } : {}),
      ...((status === 'done' || status === 'awaiting_input') && gate?.lastOutcome === 'pass' && gate.verifiedFingerprints
        ? { verifiedFingerprints: Object.fromEntries(gate.verifiedFingerprints) }
        : {}),
      verifyAttempts: gate?.attempts ?? 0,
      turns: messageIds.size,
      usage,
      metrics: { ...metrics },
      sessionId,
      ...(failureReason ? { failureReason } : {}),
      ...(mismatches.list.length > 0 ? { mismatches: [...mismatches.list] } : {}),
    };
    toolsClosed = true;
    onEvent(status === 'failed' ? { type: 'failed', result } : { type: 'done', result });
    // 입력을 닫으면 Claude Code가 남은 기록을 쓰고 스스로 끝난다. 끝나지 않으면 정해진 시간 뒤 SIGTERM, SIGKILL
    currentProc?.stop('graceful');
  };

  /**
   * 일시적 네트워크 오류(ADR-142)에서 재시도할지 정한다. 지수 백오프로 기다린 뒤 true를 돌려주면 호출한 쪽이
   * 같은 세션을 resume으로 이어받은 새 프로세스를 띄운다. 상한(횟수·총 대기 시간 중 먼저 걸리는 쪽)을 넘었거나
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

  /** CLI에 넘길 인자. 요청·프로젝트 안내 같은 바깥에서 온 글은 넣지 않는다(표준 입력과 파일로 보낸다) */
  const cliArgs = (files: { mcp: string; systemPrompt: string }): string[] => {
    const validResume = resumeForQuery !== undefined && SESSION_ID.test(resumeForQuery);
    return [
      ...commandArgs,
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--mcp-config',
      files.mcp,
      '--strict-mcp-config',
      // 기본 도구를 모두 끄고 b-studio 도구만 허용한다. 허용 목록에 없는 도구는 묻지 않고 거부한다.
      // "조사" 모드(researching)만 예외로 내장 WebSearch·WebFetch를 더 연다 — 파일·명령 도구는 절대 열지 않는다
      // (읽기 전용은 여전히 ToolContext.readOnly=ask가 b-studio 도구 쪽에서 막는다)
      '--tools',
      researching ? 'WebSearch,WebFetch' : '',
      '--allowedTools',
      (researching ? [...specs.map((spec) => toolName(spec.name)), 'WebSearch', 'WebFetch'] : specs.map((spec) => toolName(spec.name))).join(','),
      '--permission-mode',
      'dontAsk',
      // 사용자 전역·프로젝트 설정(훅, 플러그인, CLAUDE.md)이 에이전트 동작을 바꾸지 않게 한다
      '--setting-sources',
      '',
      // 지시문을 대화에 기록해 두고 이어받을 때 그대로 다시 쓰는 것이 CLI의 기본이다(snapshot). 그러면 이어받은 대화는 처음 만들 때의
      // 지시문으로만 돈다 — b-studio를 올려도, studio.yaml의 workflow나 프로젝트 안내 파일을 고쳐도 대화가 압축될 때까지 전달되지 않는다
      // (트러블슈팅 130). 요청마다 대화를 이어받는 구조라 기록을 끄고 매번 지금의 지시문을 보낸다. 지시문이 그대로면 캐시도 그대로고,
      // 바뀐 요청에서만 대화 캐시를 한 번 새로 쓴다
      '--system-prompt-file',
      files.systemPrompt,
      '--system-prompt-snapshot',
      'off',
      ...(modelForQuery ? ['--model', modelForQuery] : []),
      '--effort',
      effort,
      '--max-turns',
      String(maxTurns),
      // 실패한 실행이 다음 요청의 대화를 오염시키지 않도록 매번 갈라서 이어받는다
      ...(validResume ? ['--resume', resumeForQuery!, '--fork-session'] : []),
    ];
  };

  /**
   * CLI 프로세스 하나를 끝까지 돈다. 승격이면 같은 세션을 이어받은 새 프로세스를 모델만 바꿔 다시 띄운다.
   * 메시지 처리는 한 곳에만 두어(되묻기·진행 중 지시·도구 결과 캐시·턴별 사용량이 그대로 동작) 두 번 부른다.
   */
  const runQuery = async (files: { mcp: string; systemPrompt: string }): Promise<void> => {
    // 이 프로세스의 사용량. result의 modelUsage는 프로세스 누적값이라 result마다 덮어쓴다
    resetUsage(queryUsage);
    queryByModel = {};
    if (resumeForQuery !== undefined && !SESSION_ID.test(resumeForQuery)) {
      onEvent({ type: 'warning', message: '이어받을 대화의 id가 올바르지 않아 새 대화로 시작합니다' });
      resumeForQuery = undefined;
    }
    const proc = spawnClaudeCli({
      command,
      args: cliArgs(files),
      cwd: project.root,
      // 토큰은 파일에 쓰지 않는다. 자식 프로세스의 환경 변수로만 넘기고, MCP 설정 파일은 그 이름만 적는다
      env: { ...queryEnv, [MCP_TOKEN_ENV]: toolServer!.token },
      stop: stopOptions,
    });
    currentProc = proc;
    // 준비하는 동안 취소가 먼저 왔으면 리스너가 이 프로세스를 모른다
    if (signal?.aborted) proc.stop('now');
    // 입력 쪽은 사용자 메시지 한 줄씩. finish와 승격이 이 입력을 닫는다
    const input = { push: (text: string) => proc.send(text) };
    input.push(pendingPrompt);

    // 진행 중 지시는 표준 입력에 사용자 메시지로 넣는다. 승격으로 새 프로세스를 띄워도 이 연결을 다시 건다.
    // CLI는 스트리밍 입력에서 들어온 사용자 메시지를(현재 도구 호출이 끝난 뒤) 다음 모델 호출에서 처리한다.
    // 지금 하던 도구 호출을 중간에 끊지 않는 것은 이 방식의 성질이다(근거는 결과 문서에 적음)
    const detachSteering = attachSteering(steering, input, onEvent);
    // 승격 분기에서 프로세스를 닫기 전에 끊고, finally와 겹쳐도 한 번만 실행되게 감싼다
    let detached = false;
    const detachSteeringOnce = (): void => {
      if (detached) return;
      detached = true;
      detachSteering();
    };

    // 요약 중 상태를 한 번만 알리기 위한 표시(compact_boundary에서 푼다)
    let compacting = false;
    // 이 프로세스의 init이 b-studio 도구 서버를 connected로 알렸는가. 확인하지 못한 채 결과가 오면 통과시키지 않는다
    let toolServerConfirmed = false;
    try {
      messages: for await (const message of proc.messages()) {
        if (typeof message.session_id === 'string' && message.session_id) sessionId = message.session_id;
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
                backend: `${BACKEND} (CLI ${message.claude_code_version ?? '?'})`,
                model: message.model ?? modelForQuery ?? '기본 모델',
                auth: account ? describeAccount(account) : undefined,
                effort,
              });
            }
            // b-studio 도구 서버에 붙지 못한 채로 돌면 모델이 도구 없이 "끝났다"고 하고, 변경이 없어 게이트가 통과해 버린다.
            // 문서에 있는 init의 mcp_servers·mcp_server_errors로 알아채면 통과시키지 않고 실패로 끝낸다
            if (message.subtype === 'init') {
              const broken = mcpSetupFailure(message);
              if (broken) {
                proc.stop('now');
                finish('failed', broken);
                break;
              }
              toolServerConfirmed = true;
            }
            // 요약이 시작됐다. CLI는 같은 상태를 되풀이해 보낼 수 있어 요약 한 번에 한 번만 알린다
            if (message.subtype === 'status' && message.status === 'compacting' && !compacting) {
              compacting = true;
              onEvent({ type: 'context_compacting' });
            }
            if (message.subtype === 'compact_boundary' && message.compact_metadata) {
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
            if (message.parent_tool_use_id || !message.message?.id) break;
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
                // 진행 중인 턴을 끝까지 기다리지 않는다: 입력을 닫고 바로 SIGTERM. 이미 보낸 도구 호출이 더 닿아도 파일을 건드리지 않게 닫는다.
                // (SDK의 interrupt()는 공식 문서에 없는 제어 메시지라 쓰지 않는다 — ADR-194)
                toolsClosed = true;
                proc.stop('now');
                // 하던 도구 호출이 있으면 끝나기를 기다린 뒤 게이트를 본다
                await serial.idle();
                // 턴 상한에 걸렸다. 바로 실패로 끝내지 않고 지금까지의 변경이 게이트를 통과하는지 한 번 더 본다(ADR-131)
                const gateStarted = performance.now();
                const recheck = await recheckGateOnMaxTurns(gate, maxTurns, onEvent);
                metrics.gateMs += Math.round(performance.now() - gateStarted);
                if (recheck.pass) finish('done', recheck.summary);
                else finish('failed', recheck.summary, undefined, 'max_turns');
                break;
              }
            }
            const blocks = Array.isArray(message.message.content) ? (message.message.content as Array<{ type?: string; text?: string }>) : [];
            const text = blocks
              .flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
              .join('\n')
              .trim();
            if (text) {
              onEvent({ type: 'text', text });
              lastText = text;
            }
            break;
          }

          case 'result': {
            // init으로 도구 서버 연결을 확인하지 못했다(init이 없었다). 도구 없이 돈 턴일 수 있어 결과를 통과로 쓰지 않는다
            if (!toolServerConfirmed) {
              finish('failed', 'Claude Code가 b-studio 도구 서버에 연결됐는지 확인하지 못했습니다(시작 정보가 오지 않음)');
              break;
            }
            // modelUsage는 이 프로세스의 누적값이다. 끝난 프로세스들의 사용량(base)과 더해 실행 전체를 만든다
            setUsage(queryUsage, message);
            syncUsage();
            queryByModel = usageByModelOf(message);
            metrics.usageByModel = mergeUsageByModel(usageByModelBase, queryByModel);
            const apiMs = apiDurationOf(message);
            if (apiMs !== undefined) {
              // 누적값이라 줄어들 수 없다. 줄어든 값이 오면(형식이 바뀐 경우) 이미 잰 것을 깎지 않는다
              queryModelMs = Math.max(queryModelMs ?? 0, apiMs);
              metrics.modelMs = modelMsBase + queryModelMs;
            }
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
              // 승격처럼 이 프로세스는 여기서 닫고 새로 띄운다(reopen). 상한을 넘으면 실패로 끝나되 사유를 남긴다
              if (isTransientNetworkFailure(failure)) {
                detachSteeringOnce();
                if (await retryAfterNetworkFailure()) {
                  proc.stop('graceful');
                  reopen = true;
                  break messages;
                }
                finish('failed', `네트워크 연결이 끊겨 재시도했지만 복구되지 않았습니다: ${failure}`, undefined, 'network');
                break;
              }
              finish('failed', failure);
              break;
            }
            // 되묻고 멈추기: ask_user가 질문을 남겼으면 입력을 닫아 CLI가 끝나게 하고 실행을 끝낸다.
            // 이미 결과(턴의 끝)를 받았으므로 진행 중인 턴이 없어 신호로 끊을 필요가 없다.
            // 세션 id는 그대로 저장되어 다음 요청이 이 대화를 이어받는다.
            // 질문 전에 파일을 바꿨다면 그 변경도 게이트를 돌린다(변경이 없으면 돌리지 않는다)
            if (asked) {
              proc.closeInput();
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
                    // 닫히는 입력으로 지시가 들어가 사라지지 않게, 닫기 전에 이 프로세스의 지시 연결을 끊는다.
                    // 그 뒤 들어온 지시는 큐에 남아 새 프로세스가 연결할 때 flush로 가져간다
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
                    proc.stop('graceful');
                    reopen = true;
                    // 같은 대화를 이어받아 모델만 바꾸려면 새 프로세스가 필요하다. 이 프로세스는 여기서 닫는다
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
      // 결과 처리 중 난 예외(게이트 등)다. 프로세스를 바로 끝낸다. 이미 결과로 끝낸 실행이면 그 판정을 지킨다.
      // 던지게 두면 호출자가 오류로 보고, 턴 상한에서 게이트를 통과해 남기기로 한 변경까지 되돌린다(ADR-131, 트러블슈팅 131)
      proc.stop('now');
      if (!result) throw error;
    } finally {
      detachSteeringOnce();
      // 어떤 경로로 나왔든 프로세스를 끝낸다(이미 끝났거나 닫는 중이면 무시). 끝나기를 기다려 다음 프로세스와 겹치지 않게 한다
      proc.stop('graceful');
      const exit = await proc.exited;
      if (currentProc === proc) currentProc = undefined;
      // 이 프로세스의 사용량을 실행 전체 누적에 더한다. 승격이 없으면 여기서 한 번만 더해 결과가 지금과 같다
      addUsageInto(baseUsage, queryUsage);
      for (const [model, usage] of Object.entries(queryByModel)) addUsageInto((usageByModelBase[model] ??= emptyUsage()), usage);
      modelMsBase += queryModelMs ?? 0;
      queryModelMs = undefined;
      lastExit = { ...exit, stderr: proc.stderrTail() };
    }
  };

  // 승격이 일어나면 같은 세션을 이어받은 새 프로세스를 모델만 바꿔 다시 띄운다. 그 밖에는 한 프로세스로 끝까지 돈다
  let toolServer: ToolServer | undefined;
  const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-claude-code-'));
  try {
    toolServer = await startToolServer({ specs, name: SERVER, run: runTool });
    const files = { mcp: path.join(dir, 'mcp.json'), systemPrompt: path.join(dir, 'system-prompt.md') };
    // 도구 서버는 루프백 HTTP MCP다(codex·commandcode·관문 러너와 같다). 토큰은 파일에 쓰지 않고 환경 변수 이름만 적는다
    await writeFile(files.mcp, JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url: toolServer.url, headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` } } } }, null, 2), { mode: 0o600 });
    await writeFile(files.systemPrompt, buildSystemPrompt(project, { toolName, selfCheck: options.selfCheck }) + workflowContext(project) + projectGuideSection(guide), { mode: 0o600 });
    for (;;) {
      reopen = false;
      await runQuery(files);
      if (result) break;
      // 취소했으면 결과 없음이 아니라 취소다
      signal?.throwIfAborted();
      if (!reopen) throw new Error(noResultMessage(lastExit));
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    toolsClosed = true;
    await toolServer?.close().catch(() => {});
    // 프로세스를 닫아도 이미 시작한 도구 핸들러는 이어서 돈다. 호출한 쪽이 변경을 되돌리기 전에 끝나기를 기다린다
    await serial.idle();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  signal?.throwIfAborted();
  if (!result) throw new Error(noResultMessage(lastExit));
  return result;
}

/** 프로세스가 결과 없이 끝났다는 실패 메시지. 종료 코드와 표준 오류의 끝부분을 담는다 */
export function noResultMessage(exit: { code: number | null; signal: NodeJS.Signals | null; error?: Error; stderr: string } | undefined): string {
  if (!exit) return native.runnerNoResultMessage(false, undefined, undefined, undefined, '');
  return native.runnerNoResultMessage(true, exit.error ? String(exit.error.message) : undefined, exit.signal, exit.code, exit.stderr);
}

/** init이 b-studio 도구 서버를 연결하지 못했다고 알리면 그 설명(닫는 쪽: connected로 확인한 경우만 undefined). 문서에 있는 mcp_servers·mcp_server_errors만 본다 */
export function mcpSetupFailure(message: CliMessage, server: string = SERVER): string | undefined {
  let json: string;
  try {
    json = encodeNative({ mcp_servers: message.mcp_servers, mcp_server_errors: message.mcp_server_errors });
  } catch {
    // Rust로 보낼 수 없는 모양이면 연결을 확인하지 못한 것이다(실패로 닫는다)
    return `Claude Code가 ${server} 도구 서버에 연결하지 못했습니다: 도구 서버 목록의 형식을 읽지 못했습니다`;
  }
  return native.runnerMcpSetupFailure(json, server) ?? undefined;
}

/**
 * 진행 중 지시를 표준 입력(스트리밍 입력)에 넣는다. 알림(onPush)이 있으면 즉시, 없으면 짧은 주기로 확인한다.
 * 돌려준 함수로 구독이나 주기 확인을 멈춘다.
 */
function attachSteering(steering: Steering | undefined, input: { push(text: string): void }, onEvent: (event: AgentEvent) => void): () => void {
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
  // 승격으로 새 프로세스를 띄울 때처럼 연결하기 전에 이미 쌓여 있던 지시를 바로 꺼낸다
  flush();
  return detach;
}

/**
 * 샌드박스를 띄우기 전에 이 PC의 Claude Code가 실행되고 로그인돼 있는지 확인한다.
 * `claude auth status`(JSON, 로그인하지 않았으면 종료 코드 1)를 부른다. 프롬프트를 보내지 않으므로 사용량을 쓰지 않는다.
 * 근거: https://code.claude.com/docs/en/cli-reference (CLI commands의 `claude auth status`)
 */
export async function preflightClaudeCode(
  {
    command = 'claude',
    commandArgs = [],
    cwd = process.cwd(),
    timeoutMs = 60_000,
    env,
  }: {
    command?: string;
    commandArgs?: readonly string[];
    cwd?: string;
    timeoutMs?: number;
    /** CLI에 넘길 환경. 계정마다 설정 폴더(CLAUDE_CONFIG_DIR)를 따로 둘 때 준다(#885). 없으면 process.env */
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ ok: true; account: ClaudeCodeAccount } | { ok: false; reason: string }> {
  try {
    const output = await runToCompletion(command, [...commandArgs, 'auth', 'status'], { cwd, env: env ?? process.env, timeoutMs });
    let info: { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown; subscriptionType?: unknown };
    try {
      info = JSON.parse(output.stdout) as typeof info;
    } catch {
      throw new Error(`인증 상태를 읽지 못했습니다${output.stderr.trim() ? `: ${output.stderr.trim().split('\n').slice(-2).join(' / ')}` : ''}`);
    }
    if (typeof info !== 'object' || info === null || typeof info.loggedIn !== 'boolean') throw new Error('인증 상태를 읽지 못했습니다');
    // 이메일·조직은 화면과 로그에 남기지 않는다
    const account: ClaudeCodeAccount = {
      subscriptionType: typeof info.subscriptionType === 'string' ? info.subscriptionType : undefined,
      apiKeySource: info.authMethod === 'api_key' || info.authMethod === 'api_key_helper' ? info.authMethod : undefined,
      apiProvider: typeof info.apiProvider === 'string' ? info.apiProvider : undefined,
    };
    if (!info.loggedIn) {
      return { ok: false, reason: 'Claude Code에 로그인돼 있지 않습니다. 터미널에서 `claude`를 실행해 /login으로 로그인하세요.' };
    }
    return { ok: true, account };
  } catch (error) {
    return {
      ok: false,
      reason: `로컬 Claude Code를 실행하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 짧게 끝나는 명령을 한 번 돌려 출력을 모은다. 제한 시간을 넘기면 끝내고(SIGTERM, 뒤이어 SIGKILL) 실패로 던진다 */
function runToCompletion(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let resolved: string;
    try {
      // 사전 확인도 cwd(호출부는 프로젝트 루트를 넘긴다) 안의 실행 파일은 고르지 않는다
      resolved = resolveCliCommand(command, options.env, options.cwd);
    } catch (error) {
      reject(error as Error);
      return;
    }
    const child = spawn(resolved, args, { cwd: options.cwd, env: childEnv(options.env, options.cwd), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      killTimer.unref();
      reject(new Error(`${options.timeoutMs / 1000}초 안에 응답하지 않았습니다`));
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // 인증 상태 JSON은 작다. 상한을 넘게 쏟는 프로세스는 읽지 않는다(앞부분만 남긴다)
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(0, 64_000);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, code });
    });
  });
}

/** fetchClaudeCodeModels가 항상 던지는 사유. 부르는 쪽이 "목록을 못 불러온 오류"와 구분해 알려진 표를 조용히 쓴다 */
export const CLAUDE_CODE_MODELS_UNSUPPORTED = '공개 CLI 입출력에는 모델 목록을 묻는 방법이 없습니다';

/**
 * 로그인한 계정의 Claude Code가 보고하는 모델 목록. Agent SDK의 `supportedModels()`는 SDK가 쓰는 제어 메시지(control_request)로 받아 오는데
 * 공식 문서의 공개 CLI 입출력에는 모델 목록을 묻는 방법이 없다(ADR-189: 문서에 없는 규약은 쓰지 않는다).
 * 그래서 항상 실패로 알리고, 부르는 쪽(apps/studio/lib/server/claude-code-models.ts → model-picker.ts)이 알려진 별칭 표로 되돌아간다.
 */
export async function fetchClaudeCodeModels(_options: { command?: string; commandArgs?: readonly string[]; cwd?: string; timeoutMs?: number } = {}): Promise<ModelInfo[]> {
  throw new Error(CLAUDE_CODE_MODELS_UNSUPPORTED);
}

export function describeAccount(account: ClaudeCodeAccount): string {
  if (account.apiKeySource && account.apiKeySource !== 'none') return `API 키 (${account.apiKeySource})`;
  if (account.subscriptionType) return `${account.subscriptionType} 구독`;
  if (account.apiProvider && account.apiProvider !== 'firstParty') return account.apiProvider;
  return '로그인 계정';
}

/** result 메시지에서 이 러너가 읽는 필드. Agent SDK의 SDKResultMessage도 이 꼴을 만족한다(벤치·질문 경로가 그대로 넘긴다) */
export interface ClaudeResultMessage {
  /** 없거나 모르는 값이면 실패로 본다 */
  subtype?: string;
  is_error?: boolean;
  result?: string;
  stop_reason?: string | null;
  errors?: string[];
  duration_api_ms?: number;
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
}

/** 결과 메시지가 실패이면 그 설명(닫는 쪽: 성공이 확실할 때만 undefined). 판정은 Rust(crates/bstudio-guard/src/runner_judge.rs) */
export function describeResultFailure(message: ClaudeResultMessage): string | undefined {
  let json: string;
  try {
    json = encodeNative({ subtype: message.subtype, is_error: message.is_error, result: message.result, stop_reason: message.stop_reason, errors: message.errors });
  } catch {
    return 'Claude Code 실행 중 오류가 났습니다';
  }
  return native.runnerDescribeResultFailure(json) ?? undefined;
}

type AssistantTokenUsage = {
  input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** result가 알려 주는 API 호출 시간 합(ms). 유한한 0 이상의 수가 아니면 재지 않은 것으로 본다 */
function apiDurationOf(message: ClaudeResultMessage): number | undefined {
  return native.runnerApiDurationOf(encodeNative(message.duration_api_ms ?? null)) ?? undefined;
}

/** result의 modelUsage(query 하나의 누적값)에서 전체 합과 모델 이름별 사용량을 뽑는다. modelUsage 항목이 null이면 던진다(옛 구현도 던졌다) */
function usageOfResult(message: ClaudeResultMessage): { total: AgentUsage; byModel: Record<string, AgentUsage> } {
  return decodeNative<{ total: AgentUsage; byModel: Record<string, AgentUsage> }>(native.runnerUsageOf(encodeNative(message.modelUsage ?? null)));
}

/** modelUsage는 query 전체의 누적값이므로 더하지 않고 최신 값으로 바꾼다 */
function setUsage(usage: AgentUsage, message: ClaudeResultMessage): void {
  Object.assign(usage, usageOfResult(message).total);
}

/** 사용량을 0으로 되돌린다 */
function resetUsage(usage: AgentUsage): void {
  Object.assign(usage, emptyUsage());
}

/** 사용량을 다른 곳에 더한다 */
function addUsageInto(target: AgentUsage, source: AgentUsage): void {
  Object.assign(target, decodeNative<AgentUsage>(native.runnerAddUsage(encodeNative(target), encodeNative(source))));
}

/** result의 modelUsage(query 하나의 누적값)를 모델 이름별 AgentUsage로 옮긴다 */
function usageByModelOf(message: ClaudeResultMessage): Record<string, AgentUsage> {
  return usageOfResult(message).byModel;
}

/** 끝난 query들의 모델별 사용량(base)과 지금 query의 것(query)을 더해 실행 전체로 만든다 */
function mergeUsageByModel(base: Record<string, AgentUsage>, query: Record<string, AgentUsage>): Record<string, AgentUsage> {
  return decodeNative<Record<string, AgentUsage>>(native.runnerMergeUsageByModel(encodeNative(base), encodeNative(query)));
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
  observeResult(message: ClaudeResultMessage): void {
    const { total, byModel } = usageOfResult(message);
    this.#usageByModel = byModel;
    Object.assign(this.#usage, total);
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
