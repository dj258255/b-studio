import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Effort } from './anthropic-client';
import { childEnv, prepareCliSpawn, resolveCliCommand, timerMs, type CliMessage, type CliStopOptions } from './claude-cli-process';
import { signatureSetKey, type EscalationPolicy } from './escalation';
import { recheckGateOnMaxTurns, VerificationGate } from './gate';
import { emptyUsage, formatSteering, takeSteering, type AgentEvent, type AgentResult, type AgentUsage, type RunAgentOptions, type RunMetrics, type Steering } from './loop';
import { decodeNative, encodeLoneSurrogates, encodeNative, native } from '@b-studio/sandbox';
import { startToolServer, type ToolServer } from './mcp-http-server';
import { decodeLoneSurrogates } from './lone-surrogates';
import { loadProjectGuide } from './project-guide';
import { buildAskRequest, buildSystemPrompt, projectGuideSection, withLanguageReminder } from './prompts';
import { createToolResultCache } from './tool-output';
import { buildTools, createMismatchLog, executeTool, SANDBOX_TOOLS, WRITE_TOOLS, type AskUserQuestion, type BoardAccess, type ToolContext } from './tools';
import { decodeStrings, encodeStrings, fetchContract, type HookHandler, type HookRequest } from './verify';
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
 * 도구 요청이 그 호출이 든 assistant 메시지(stdout)보다 먼저 처리됐을 때 그 메시지를 기다리는 상한. 진짜 CLI는 메시지를 먼저 쓰므로 보통 몇 ms 안에 온다.
 * 넘기면 기다리지 않고 실행한다(메시지가 끝내 오지 않는 경우에 도구가 영영 멈추지 않게)
 */
const TOOL_USE_WAIT_MS = 2_000;

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
 *
 * 메시지 루프와 실행 상태(턴·사용량·result 처리·게이트 분기·승격·네트워크 재시도·되묻기·프로세스 다시 띄우기)와 도구 순서 장부는 Rust가 쥔다
 * (crates/bstudio-io/src/cli_runner.rs·tool_ledger.rs, ADR-202, 4f A8b). Rust가 CLI 프로세스를 직접 쥐고 줄을 읽는다. 이 함수는 준비(작업 공간·게이트·도구 목록·임시 파일·
 * 도구 서버)와 Rust가 부르는 콜백(게이트·결과 조립·도구 실행·CLI 인자·지시·이벤트·네트워크 대기)을 제공하고, 끝나면 결과를 돌려준다.
 * 옛 TS 루프는 지웠다(#1347).
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
    (gatePromise ??= VerificationGate.create({ project, sandbox, workspace, allowBreaking, maxVerifyAttempts, verify: options.verify, allowCheckChanges: options.allowCheckChanges, outsideChanges: options.outsideChanges, fetcher, pageFetcher, browserRunner, saveArtifact, signal, onServiceStatus, onEvent }));
  if (!ask && !options.ensureSandbox) gate = await gateFor();
  // 프로젝트 루트(세션 작업 복사본)의 AGENTS.md를 실행마다 새로 읽는다(ADR-077). 승격으로 프로세스를 다시 열어도
  // 같은 실행 안이므로 다시 읽지 않고 이 값을 그대로 재사용한다(아래 클로저가 캡처한다)
  const guide = await loadProjectGuide(project);
  // report_mismatch가 남긴 어긋남. 결과에 실어 호출자가 "확인 필요"로 보인다(#666)
  const mismatches = createMismatchLog();
  // ask_user가 남긴 질문. 있으면 Rust가 입력을 닫아 CLI를 끝내고 awaiting_input으로 끝내 사용자 답을 기다린다
  let asked: AskUserQuestion | undefined;
  const context: ToolContext = {
    project,
    selfCheck: options.selfCheck,
    workspace,
    sandbox,
    fetcher,
    signal,
    onServiceStatus,
    readOnly: ask,
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
    interactive,
    mismatch: !ask,
  });
  const toolName = (name: string) => `mcp__${SERVER}__${name}`;

  // 도구 순서 장부(Rust, ADR-202). Claude Code는 읽기 도구를 동시에 부를 수 있다 — 직접 만든 루프처럼 모델이 낸 순서대로 하나씩 실행하고,
  // 그 호출이 든 assistant 메시지(턴 세기·턴 상한)를 본 뒤에 실행하며, 끝났거나 취소됐으면 실행하지 않는다. 러너 코어와 도구 서버가 이 객체를 나눠 쥔다(트러블슈팅 206)
  const ledger = new native.ToolLedger(toolName(''), TOOL_USE_WAIT_MS);
  // 실행 지표. 모델 응답 대기는 CLI 안에서 일어나 이 러너가 직접 재지 못한다. CLI가 result에 실어 주는 API 호출 시간 합(duration_api_ms)을
  // modelMs로 쓰고, result가 한 번도 오지 않으면 비워 둔다("재지 않음"). 전체 시간에서 도구·게이트 시간을 뺀 추측값은 넣지 않는다
  const metrics: RunMetrics = { modelCalls: 0, maxContextTokens: 0, toolMs: 0, gateMs: 0, ...(guide ? { guideChars: guide.charsUsed } : {}) };
  /** 도구 실행. 순서·닫힘·취소는 이 함수 앞에서 장부가 가린다(도구 서버의 `ledger` 옵션) */
  const runTool = async (name: string, args: unknown) => {
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
  };

  // 러너 코어. 취소하면 입력을 닫고 바로 SIGTERM을 보낸다(진행 중인 턴을 끝까지 기다리지 않는다)
  const core = new native.RunnerCore(ledger);
  const onAbort = () => core.abort(encodeLoneSurrogates(describeAbortReason(signal?.reason)));
  signal?.addEventListener('abort', onAbort, { once: true });
  // 준비하는 동안 취소가 먼저 왔으면 리스너가 모른다
  if (signal?.aborted) onAbort();

  // 승격은 게이트의 실패 서명이 정한다(판정과 상태는 Rust). 같은 집합이 N번 반복되면 다음 게이트 재시도 프로세스를 같은 세션에서 이어받되 모델만 바꾼다
  const escalation = options.escalation;
  // 요청 글 끝에 언어 알림을 붙인다. 지시문에만 적으면 진행 문장이 영어로 나온다(트러블슈팅 132)
  const pendingPrompt = withLanguageReminder(ask ? buildAskRequest(request, { toolName, ...(researching ? { research: { webToolsAvailable: true } } : {}) }) : request);

  let result: ClaudeCodeResult | undefined;
  let toolServer: ToolServer | undefined;
  let files: { mcp: string; systemPrompt: string } | undefined;

  /** CLI에 넘길 인자. 요청·프로젝트 안내 같은 바깥에서 온 글은 넣지 않는다(표준 입력과 파일로 보낸다) */
  const cliArgs = (modelForQuery: string | undefined, resumeForQuery: string | undefined): string[] => {
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
      files!.mcp,
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
      files!.systemPrompt,
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

  /** 프로세스마다 건 진행 중 지시 연결. 승격으로 새 프로세스를 띄워도 새 연결을 건다 */
  const steerDetaches = new Map<number, () => void>();
  /** 콜백이 던지면 오류를 보관하고 `{ fatal: true }`를 돌려준다(Rust는 그 뒤 단계를 하지 않고, 끝난 뒤 여기서 보관한 오류를 그대로 다시 던진다) */
  let thrown: { error: unknown } | undefined;
  const handlers: Record<string, HookHandler> = {
    event: ({ event }) => {
      onEvent(event as AgentEvent);
      return { ok: true };
    },
    args: ({ model: modelForQuery, resume: resumeForQuery }) => {
      // 토큰은 파일에 쓰지 않는다. 자식 프로세스의 환경 변수로만 넘기고, MCP 설정 파일은 그 이름만 적는다
      const prepared = prepareCliSpawn({ command, cwd: project.root, env: { ...queryEnv, [MCP_TOKEN_ENV]: toolServer!.token }, stop: stopOptions });
      const args = cliArgs(modelForQuery as string | undefined, resumeForQuery as string | undefined);
      if (!prepared.ok) return { ok: true, spawnError: prepared.error.message };
      return { ok: true, bin: prepared.resolved, args, env: prepared.env, cwd: project.root, termAfterMs: timerMs(prepared.termAfterMs), killAfterMs: timerMs(prepared.killAfterMs) };
    },
    steerAttach: ({ proc }) => {
      const seq = Number(proc);
      // 진행 중 지시는 표준 입력에 사용자 메시지로 넣는다. CLI는 스트리밍 입력에서 들어온 사용자 메시지를(현재 도구 호출이 끝난 뒤) 다음 모델 호출에서 처리한다.
      // 지금 하던 도구 호출을 중간에 끊지 않는 것은 이 방식의 성질이다(근거는 결과 문서에 적음)
      steerDetaches.set(seq, attachSteering(steering, { push: (text) => core.send(seq, encodeLoneSurrogates(text)) }, onEvent));
      return { ok: true };
    },
    steerDetach: ({ proc }) => {
      const seq = Number(proc);
      const detach = steerDetaches.get(seq);
      steerDetaches.delete(seq);
      detach?.();
      return { ok: true };
    },
    // 모델이 턴을 끝냈다 → 만들기면 검증 게이트. 지연 기동 세션이 아무것도 바꾸지 않았으면 게이트가 없다 → 샌드박스 없이 끝난다
    gateCheck: async () => {
      const activeGate = gate;
      if (!activeGate) return { ok: true, gate: false };
      const outcome = await activeGate.check();
      return { ok: true, gate: true, ...outcome, verified: activeGate.verified === true, attempts: activeGate.attempts };
    },
    // 턴 상한에 걸렸다. 바로 실패로 끝내지 않고 지금까지의 변경이 게이트를 통과하는지 한 번 더 본다(ADR-131)
    gateRecheck: async () => ({ ok: true, ...(await recheckGateOnMaxTurns(gate, maxTurns, onEvent)) }),
    // 되묻기 전에 파일을 바꿨다면 그 변경도 게이트를 돌린다(변경이 없으면 돌리지 않는다)
    gateAskedCheck: async () => {
      const openGate = gate;
      if (openGate && workspace.changedFiles().length > 0) {
        await openGate.check();
        return { ok: true, ran: true };
      }
      return { ok: true, ran: false };
    },
    asked: () => ({ ok: true, asked: asked !== undefined }),
    signature: () => ({ ok: true, key: signatureSetKey(gate!.report, gate!.checks) }),
    // 올라간 모델에게 게이트 재시도를 새로 준다(기존 남은 횟수 대신)
    grantBudget: ({ budget }) => {
      const extended = gate!.grantRetryBudget(Number(budget));
      return { ok: true, extended, attempts: gate!.attempts };
    },
    wait: async ({ ms }) => {
      await networkWait(Number(ms), signal);
      signal?.throwIfAborted();
      return { ok: true };
    },
    finish: ({ status, summary, useAsked, failureReason, part }) => {
      const rust = part as RustPart;
      const question = useAsked === true ? asked : undefined;
      // 본 대화의 서로 다른 assistant 메시지 수(Rust가 센다)
      metrics.modelCalls = rust.modelCalls;
      metrics.maxContextTokens = rust.maxContextTokens;
      metrics.gateMs = rust.gateMs;
      if (rust.usageByModel) metrics.usageByModel = rust.usageByModel;
      if (typeof rust.modelMs === 'number') metrics.modelMs = rust.modelMs;
      if (typeof rust.escalatedAt === 'number') metrics.escalatedAt = rust.escalatedAt;
      const finalStatus = status as AgentResult['status'];
      result = {
        status: finalStatus,
        summary: useAsked === true ? asked!.question : (summary as string),
        changedFiles: workspace.changedFiles(),
        ...(question ? { question } : {}),
        report: gate?.report,
        checks: gate?.checks,
        ...(gate?.lastOutcome ? { gateOutcome: gate.lastOutcome } : {}),
        passedStages: gate ? [...gate.passedStages] : undefined,
        ...(options.verify === 'light' ? { verify: 'light' as const } : {}),
        ...(finalStatus === 'done' && gate?.passedAtTurnLimit ? { incomplete: 'max_turns' as const } : {}),
        ...(gate && gate.skippedStages.length > 0 ? { skippedStages: [...gate.skippedStages] } : {}),
        ...((finalStatus === 'done' || finalStatus === 'awaiting_input') && gate?.lastOutcome === 'pass' && gate.verifiedFingerprints
          ? { verifiedFingerprints: Object.fromEntries(gate.verifiedFingerprints) }
          : {}),
        verifyAttempts: gate?.attempts ?? 0,
        turns: rust.turns,
        usage: rust.usage,
        metrics: { ...metrics },
        sessionId: rust.sessionId,
        ...(failureReason ? { failureReason: failureReason as AgentResult['failureReason'] } : {}),
        ...(mismatches.list.length > 0 ? { mismatches: [...mismatches.list] } : {}),
      };
      return { ok: true };
    },
    // 결과를 만들고 도구를 닫은 뒤 완료·실패 이벤트를 낸다(Rust가 이 순서를 정한다)
    finishEmit: () => {
      onEvent(result!.status === 'failed' ? { type: 'failed', result: result! } : { type: 'done', result: result! });
      return { ok: true };
    },
  };
  const hook = async (text: string): Promise<string> => {
    try {
      const request = decodeStrings(decodeNative<HookRequest>(text));
      const handler = handlers[String(request.op)];
      if (!handler) throw new Error(`알 수 없는 러너 콜백입니다: ${String(request.op)}`);
      return encodeNative(encodeStrings(await handler(request)));
    } catch (error) {
      thrown ??= { error };
      return JSON.stringify({ fatal: true });
    }
  };

  // 승격이 일어나면 같은 세션을 이어받은 새 프로세스를 모델만 바꿔 다시 띄운다(Rust). 그 밖에는 한 프로세스로 끝까지 돈다
  const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-claude-code-'));
  try {
    toolServer = await startToolServer({ specs, name: SERVER, run: runTool, ledger });
    files = { mcp: path.join(dir, 'mcp.json'), systemPrompt: path.join(dir, 'system-prompt.md') };
    // 도구 서버는 루프백 HTTP MCP다(codex·commandcode·관문 러너와 같다). 토큰은 파일에 쓰지 않고 환경 변수 이름만 적는다
    await writeFile(files.mcp, JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url: toolServer.url, headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` } } } }, null, 2), { mode: 0o600 });
    await writeFile(files.systemPrompt, buildSystemPrompt(project, { toolName, selfCheck: options.selfCheck }) + workflowContext(project) + projectGuideSection(guide), { mode: 0o600 });
    const input = {
      maxTurns,
      server: SERVER,
      backend: BACKEND,
      ...(account ? { auth: describeAccount(account) } : {}),
      effort,
      ...(model !== undefined ? { model } : {}),
      ...(resume !== undefined ? { resume } : {}),
      pendingPrompt,
      networkResumePrompt: NETWORK_RESUME_PROMPT,
      network: { maxAttempts: networkMaxAttempts, maxWaitMs: networkMaxWaitMs, baseDelayMs: networkBaseDelayMs },
      ...(escalation ? { escalation: { to: escalation.to, sameSignatureTimes: escalation.sameSignatureTimes, afterFailures: escalation.afterFailures, retryBudget: escalation.retryBudget } } : {}),
    };
    const answer = decodeNative<{ ok: boolean; outcome?: string; sessionId?: string | null; message?: string; kind?: string; errorKind?: string }>(await core.run(encodeNative(encodeStrings(input)), hook));
    if (!answer.ok) {
      if (answer.kind === 'hook') throw thrown?.error ?? new Error('러너 콜백이 실패했습니다');
      if (answer.kind === 'thrown') throw answer.errorKind === 'type' ? new TypeError(answer.message) : new Error(answer.message);
      throw new Error(answer.message ?? '러너 입력을 읽지 못했습니다');
    }
    // 결과를 만든 뒤에도 CLI가 세션 id를 바꿔 보낼 수 있다. 끝난 뒤의 마지막 값을 결과에 싣는다
    const finalSession = answer.sessionId === null || answer.sessionId === undefined ? undefined : decodeLoneSurrogates(answer.sessionId);
    if (result) result.sessionId = finalSession;
    // 취소했으면 결과 없음이 아니라 취소다
    if (answer.outcome === 'aborted') signal?.throwIfAborted();
    if (answer.outcome === 'noResult') {
      signal?.throwIfAborted();
      throw new Error(answer.message);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    ledger.close();
    await toolServer?.close().catch(() => {});
    // 프로세스를 닫아도 이미 시작한 도구 핸들러는 이어서 돈다. 호출한 쪽이 변경을 되돌리기 전에 끝나기를 기다린다
    await ledger.idle();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  signal?.throwIfAborted();
  if (!result) throw new Error(noResultMessage(undefined));
  return result;
}

/** 취소 이유를 도구 거절 글로 쓴다(옛 `throwIfAborted`가 던진 오류의 메시지, 도구 서버가 `describe(error)`로 쓰던 것과 같다) */
function describeAbortReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Rust 러너 코어가 결과 조립에 넘기는 값 */
interface RustPart {
  modelCalls: number;
  maxContextTokens: number;
  gateMs: number;
  usage: AgentUsage;
  usageByModel?: Record<string, AgentUsage>;
  modelMs?: number;
  escalatedAt?: number;
  turns: number;
  sessionId?: string;
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

/** result의 modelUsage(query 하나의 누적값)에서 전체 합과 모델 이름별 사용량을 뽑는다. modelUsage 항목이 null이면 던진다(옛 구현도 던졌다) */
function usageOfResult(message: ClaudeResultMessage): { total: AgentUsage; byModel: Record<string, AgentUsage> } {
  return decodeNative<{ total: AgentUsage; byModel: Record<string, AgentUsage> }>(native.runnerUsageOf(encodeNative(message.modelUsage ?? null)));
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
