import type Anthropic from '@anthropic-ai/sdk';
import type { Sandbox, StartOptions } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import type { BrowserRunner } from './browser-check';
import type { DesignSource } from './design';
import { clearOldToolResults, resolveContextClearing, type ContextClearingPolicy } from './context-clearing';
import { VerificationGate, type GateOptions, type PageFetcher } from './gate';
import { DEFAULT_SAME_SIGNATURE_TIMES, shouldEscalate, signatureSetKey, type EscalationPolicy } from './escalation';
import { buildAskRequest, buildSystemPrompt } from './prompts';
import { createToolResultCache } from './tool-output';
import { buildTools, executeTool, SANDBOX_TOOLS, WRITE_TOOLS, type AskUserQuestion, type BoardAccess, type ToolContext } from './tools';
import { fetchContract, type ContractFetcher, type VerificationReport } from './verify';
import { Workspace } from './workspace';
import type { ExecutionPolicy } from './policy';
import { executionPolicyFor, workflowContext, type WorkflowCheck } from './workflow';

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaTool = Anthropic.Beta.BetaTool;
type BetaToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

export interface AgentRequest {
  system: string;
  tools: BetaTool[];
  messages: BetaMessageParam[];
}

export interface ModelClientInfo {
  provider: 'anthropic' | 'openai' | 'google' | 'scripted';
  backend: string;
  model: string;
  auth?: string;
}

export type ModelPreflight = { ok: true } | { ok: false; reason: string };

/** 모델 호출을 추상화한다. 실제 Claude 클라이언트와 오프라인 검증용 스크립트 모델이 같은 루프를 쓴다 */
export interface ModelClient {
  readonly info?: ModelClientInfo;
  preflight?(): Promise<ModelPreflight>;
  createMessage(request: AgentRequest, signal?: AbortSignal): Promise<BetaMessage>;
}

/**
 * 실행 중 지시 큐. 스튜디오가 채우고 러너가 꺼내 간다. 꺼내는 시점은 러너마다 다르다
 * (API 루프·Codex는 다음 모델 호출 직전, 로컬 Claude는 입력 큐에 들어올 때).
 * 어떤 러너든 도구 호출 도중에 끼어들지 않고, 지금 하던 도구 호출이 끝난 뒤에만 반영한다.
 */
export interface Steering {
  /** 쌓인 지시를 꺼내 비운다 */
  take(): string[];
  /**
   * 지시가 들어올 때 알린다(선택). 모델 호출 지점을 직접 잡을 수 없는 로컬 Claude 러너가
   * 입력 큐에 대기 없이 넣는 데 쓴다. 없으면 러너가 짧은 주기로 take()를 부른다.
   * 돌려준 함수로 구독을 해제한다.
   */
  onPush?(listener: () => void): () => void;
}

/** 진행 중 지시를 대화에 넣을 때 붙이는 표시 */
export const STEERING_MARKER = '[진행 중 지시]';

/** 지시 여러 개를 한 사용자 메시지로 만든다. 여러 개면 줄바꿈으로 잇는다 */
export function formatSteering(texts: readonly string[]): string {
  return `${STEERING_MARKER} ${texts.join('\n')}`;
}

/** 지시 큐에서 꺼낸다. 큐 구현이 던져도 실행을 멈추지 않는다 */
export function takeSteering(steering: Steering | undefined): string[] {
  try {
    return steering?.take() ?? [];
  } catch {
    return [];
  }
}

/**
 * 사용자 메시지를 대화에 넣는다. API는 user/assistant가 번갈아야 하므로,
 * 마지막 메시지가 이미 사용자면 거기에 이어 붙이고(도구 결과 배열이면 텍스트 블록을 더한다),
 * 아니면 새 사용자 메시지를 넣는다.
 */
export function appendUserText(messages: BetaMessageParam[], text: string): void {
  const last = messages.at(-1);
  if (last?.role === 'user') {
    if (typeof last.content === 'string') {
      last.content = `${last.content}\n\n${text}`;
      return;
    }
    if (Array.isArray(last.content)) {
      last.content.push({ type: 'text', text });
      return;
    }
  }
  messages.push({ role: 'user', content: text });
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 요청 하나를 처리하며 관찰한 실행 지표. 토큰 합계(usage)와 달리 호출 횟수·입력 크기·단계별 시간을 남긴다 */
export interface RunMetrics {
  /** client.createMessage 호출 횟수 */
  modelCalls: number;
  /** 호출 한 번의 입력 크기(input+cache_read+cache_creation) 중 최댓값 */
  maxContextTokens: number;
  /** createMessage 호출에 걸린 시간 합 */
  modelMs: number;
  /** executeTool 실행 시간 합 */
  toolMs: number;
  /** gate.check() 실행 시간 합 */
  gateMs: number;
  /** 승격이 일어났다면 몇 번째 게이트 시도(실패) 뒤였는지. 승격이 없으면 없다 */
  escalatedAt?: number;
  /**
   * 모델 이름(또는 id)별 사용량. 승격 등으로 실행 중 모델이 바뀌면 모델별 비용을 나누어 계산할 수 있게 한다.
   * 모델을 구분할 수 없는 러너는 채우지 않는다
   */
  usageByModel?: Record<string, AgentUsage>;
}

export interface AgentResult {
  /** awaiting_input: 에이전트가 질문을 남기고 멈춰, 사용자 답을 다음 요청으로 기다린다 */
  status: 'done' | 'failed' | 'awaiting_input';
  summary: string;
  changedFiles: string[];
  /** awaiting_input이면 사용자의 답을 기다리는 질문 */
  question?: AskUserQuestion;
  /** 마지막 검증 게이트 결과 */
  report?: VerificationReport;
  /** 마지막 검증에서 플랫폼이 실행한 화면 확인·테스트·리뷰 */
  checks?: WorkflowCheck[];
  /** 마지막 검증에서 통과한 워크플로 검증 단계 */
  passedStages?: import('@b-studio/spec').WorkflowStage[];
  verifyAttempts: number;
  turns: number;
  usage: AgentUsage;
  /** 실행 지표. 로컬 Claude Code 러너는 모델 호출을 직접 보지 못해 채우지 않는다 */
  metrics?: RunMetrics;
}

export type AgentEvent =
  /** 실제로 요청을 처리하는 실행 환경. 로컬 Claude Code처럼 모델과 인증을 밖에서 정할 때 알린다 */
  | { type: 'session'; backend: string; model: string; auth?: string }
  | {
      type: 'route';
      selectedId: string;
      reason: string;
      complexity: 'simple' | 'normal' | 'complex';
      risk: 'normal' | 'high';
      candidates: Array<{ id: string; label: string; eligible: boolean; score: number; estimatedCostUsd?: number }>;
    }
  | { type: 'turn'; turn: number }
  /** 이번 실행에서 지금까지 쓴 토큰 누적값. 직접 만든 루프는 모델 응답마다, 로컬 Claude Code는 턴을 끝낼 때마다 온다 */
  | { type: 'tokens'; usage: AgentUsage }
  /**
   * 턴 하나의 모델 요청 사용량. 실행 누적값(tokens)과 달리 그 턴 한 번의 값이라 "어느 턴에서 컨텍스트가 커졌는지" 볼 수 있다.
   * contextTokens = input + cacheRead + cacheWrite (한 요청이 모델에 보낸 입력 크기).
   */
  | { type: 'turn_usage'; turn: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; contextTokens: number }
  /**
   * 직전 턴의 컨텍스트가 임계치를 넘어 오래된 도구 결과를 묶어서 비웠다.
   * clearedCount: 표시 문구로 바꾼 도구 결과 수, clearedChars: 그때 줄어든 글자 수
   */
  | { type: 'context_cleared'; turn: number; clearedCount: number; clearedChars: number }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  /** chars: 모델에 간 글자 수(자르기·반복 대체 뒤). rawChars: 자르기 전 원래 글자 수. 토큰 탭이 이 둘로 낭비를 찾는다 */
  | { type: 'tool_result'; name: string; ok: boolean; content: string; chars?: number; rawChars?: number }
  | { type: 'policy'; tool: string; decision: 'allow' | 'deny'; reason?: string }
  /** ask_user가 남긴 질문. 실행은 이 턴 뒤에 끝난다 */
  | { type: 'question'; question: string; options: string[]; allowOther: boolean }
  | { type: 'stage'; stage: import('@b-studio/spec').WorkflowStage; source: 'platform' | 'agent' }
  /** 진행 중 지시를 다음 모델 호출 전에 대화에 넣었다 */
  | { type: 'steer_applied'; count: number }
  /** 게이트의 실패 서명이 같은 값으로 반복돼 더 비싼 모델로 올렸다 */
  | { type: 'model_escalated'; from: string; to: string; attempt: number; signature: string; sameSignatureTimes: number }
  /**
   * 실행은 이어가지만 사람이 알면 좋은 사실. 지금은 두 가지다.
   *  - 이어받기를 요청했는데 상태 폴더가 없어 새 대화로 시작한다(구독 CLI 러너)
   *  - 이 러너가 모델 승격을 지원하지 않아 옵션을 무시했다
   */
  | { type: 'warning'; message: string }
  | { type: 'workflow_check'; check: WorkflowCheck }
  | { type: 'verify_start'; files: string[] }
  | { type: 'verify_result'; report: VerificationReport; text: string }
  | { type: 'done'; result: AgentResult }
  | { type: 'failed'; result: AgentResult };

export interface RunAgentOptions {
  request: string;
  /**
   * 이전 요청부터 이어지는 대화 기록. 넘기면 이번 실행의 메시지가 여기에 이어 붙는다.
   * 실행 중 예외가 나면 이번 실행분은 되돌려 다음 요청이 깨진 대화로 시작하지 않게 한다.
   */
  conversation?: BetaMessageParam[];
  /**
   * 실행 도중 들어온 지시를 꺼내는 큐. 주면 다음 모델 호출 직전에 take()해 대화에 넣는다.
   * 도구 호출 도중에는 끼어들지 않고, 도구 결과가 대화에 들어간 뒤 다음 호출 전에만 반영한다.
   */
  steering?: Steering;
  project: LoadedProject;
  sandbox: Sandbox;
  client: ModelClient;
  /**
   * 게이트 실패 서명이 `sameSignatureTimes`번 반복되면 이후 호출을 `client`로 바꾼다.
   * 주지 않으면 지금처럼 한 모델로 끝까지 돈다(승격 없음). 한 번 올리면 다시 올리지 않는다.
   */
  escalation?: EscalationPolicy & { client: ModelClient };
  /** 요청이 필드·엔드포인트 삭제나 타입 변경을 명시할 때만 true */
  allowBreaking?: boolean;
  /** ask: 질문 모드. 파일을 바꾸는 도구를 거부하고, 바뀐 파일이 없으므로 검증 게이트를 돌리지 않는다 */
  intent?: 'build' | 'ask';
  maxTurns?: number;
  /** 검증 게이트 실패를 몇 번까지 모델에게 돌려줄지 */
  maxVerifyAttempts?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /** 검증 게이트나 도구가 서비스를 재시작할 때의 상태. 재시작하면 호스트 포트가 바뀌므로 미리보기가 따라가야 한다 */
  onServiceStatus?: StartOptions['onStatus'];
  fetcher?: ContractFetcher;
  pageFetcher?: PageFetcher;
  browserRunner?: BrowserRunner;
  /** 화면 확인 스크린샷을 저장하고 식별자를 돌려준다. 저장은 호출자가 한다 (agent는 파일 위치를 모른다) */
  saveArtifact?: GateOptions['saveArtifact'];
  /** 화면 확인 중 받은 실시간 프레임. 미리보기 중계에 쓴다 */
  onBrowserFrame?: GateOptions['onBrowserFrame'];
  /** Figma 디자인 자료원. 세션이 디자인을 설정했을 때만 넘긴다(없으면 디자인 도구가 목록에 없다) */
  design?: DesignSource;
  /** true면 ask_user 도구를 넣는다. 단일 세션의 사용자 요청에만 켠다(레인·벤치·CLI는 기본 false) */
  interactive?: boolean;
  /** 도구 호출을 실행기에서 통제하는 정책 */
  policy?: ExecutionPolicy;
  /**
   * 컨텍스트가 커졌을 때 오래된 도구 결과를 묶어서 비우는 정책. **기본은 끔**(효과를 재기 전).
   * `B_STUDIO_CONTEXT_CLEARING=on`이면 기본 정책으로 켠다. `false`로 넘기면 환경 변수보다 우선해 끈다.
   * Claude Code·Codex 러너는 대화를 직접 다루지 않는다(각 CLI가 자체 압축을 한다). 이 옵션은 쓰지 않는다.
   */
  contextClearing?: ContextClearingPolicy | false;
  approvalToken?: string;
  requestApproval?: ToolContext['requestApproval'];
  /** 레인 조율 게시판. 주면 read_notes·(모델이 쓰는 전략이면) post_note 도구가 목록에 오른다 */
  board?: BoardAccess;
  /**
   * 샌드박스를 지금 켠다(지연 기동 세션). 주면 게이트를 실행 시작 때 만들지 않고, 첫 파일 변경·샌드박스 도구 때
   * 그때 켠 뒤에 만든다 — 계약 기준을 샌드박스가 켜진 뒤, 변경 전에 잡기 위해서다. 없으면 지금처럼 시작할 때 만든다
   */
  ensureSandbox?: () => Promise<void>;
}

export function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * Plan → Code → Run → Verify 루프.
 * 모델은 도구로 탐색·수정·실행하고, 턴을 끝내면 스튜디오가 검증 게이트를 돌린다.
 * 게이트가 실패하면 결과를 돌려주고 루프를 이어 가며, 통과해야만 완료로 본다.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const messages = options.conversation ?? [];
  const startLength = messages.length;
  try {
    return await run(options, messages);
  } catch (error) {
    // 도구 호출 뒤 결과를 붙이기 전에 끊기면 대화가 API 규칙을 어기므로 이번 실행분을 버린다
    messages.splice(startLength);
    throw error;
  }
}

async function run(options: RunAgentOptions, messages: BetaMessageParam[]): Promise<AgentResult> {
  const {
    request,
    project,
    sandbox,
    client,
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
    design,
    interactive = false,
    intent = 'build',
  } = options;
  const ask = intent === 'ask';

  if (client.info) onEvent({ type: 'session', backend: client.info.backend, model: client.info.model, auth: client.info.auth });

  const workspace = new Workspace(project.root);
  // 질문 모드는 파일을 바꾸지 않으므로 계약 기준을 잡거나 게이트를 돌리지 않는다.
  // 지연 기동 세션(ensureSandbox)은 게이트를 여기서 만들지 않고, 첫 파일 변경·샌드박스 도구 때 샌드박스를 켠 뒤에 만든다.
  // 계약 기준은 샌드박스가 켜진 뒤, 아직 바뀌지 않은 코드에서 잡아야 하기 때문이다
  let gate: VerificationGate | undefined;
  let gatePromise: Promise<VerificationGate> | undefined;
  const gateFor = (): Promise<VerificationGate> =>
    (gatePromise ??= VerificationGate.create({
      project,
      sandbox,
      workspace,
      allowBreaking,
      maxVerifyAttempts,
      fetcher,
      pageFetcher,
      browserRunner,
      saveArtifact,
      onBrowserFrame,
      signal,
      onServiceStatus,
      onEvent,
    }));
  if (!ask && !options.ensureSandbox) gate = await gateFor();
  const system = buildSystemPrompt(project) + workflowContext(project);
  const policy = options.policy ?? executionPolicyFor(project);
  const tools = buildTools(project, {
    ...(options.board ? { board: options.board, allowedTools: policy?.allowedTools } : {}),
    design: design !== undefined,
    interactive,
  });
  let stage: import('@b-studio/spec').WorkflowStage = 'plan';
  onEvent({ type: 'stage', stage, source: 'platform' });
  messages.push({ role: 'user', content: ask ? buildAskRequest(request) : request });
  const usage = emptyUsage();
  const metrics = emptyMetrics();
  // 모델 id별 사용량. 승격으로 클라이언트가 바뀌면 승격 전후가 다른 키로 쌓인다
  const usageByModel: Record<string, AgentUsage> = {};
  metrics.usageByModel = usageByModel;
  // 이번 턴에 ask_user가 남긴 질문. 있으면 도구 결과를 넣은 뒤 실행을 끝내고 사용자 답을 기다린다
  let asked: AskUserQuestion | undefined;
  // 실행 단위 도구 결과 캐시. 한 실행 안에서 같은 도구·같은 입력의 결과가 반복되면 본문 대신 참조를 넣는다
  const toolCache = createToolResultCache();
  // 기본은 끔 — 효과를 재기 전이다. B_STUDIO_CONTEXT_CLEARING=on이면 기본 정책으로 켠다
  const contextClearing = resolveContextClearing(options.contextClearing, process.env);
  // 직전 턴이 모델에 보낸 입력 크기. 이 값이 임계치를 넘으면 다음 호출 전에 오래된 도구 결과를 묶어서 비운다
  let previousContextTokens = 0;
  // 승격은 게이트의 실패 서명이 정한다. 게이트 실패마다 서명 집합을 쌓고, 같은 집합이 연속되면 모델을 바꾼다
  const escalation = options.escalation;
  const escalationHistory: string[] = [];
  let escalated = false;
  let activeClient = client;

  const finish = (status: AgentResult['status'], summary: string, turns: number, question?: AskUserQuestion): AgentResult => {
    const result: AgentResult = {
      status,
      summary,
      changedFiles: workspace.changedFiles(),
      ...(question ? { question } : {}),
      report: gate?.report,
      checks: gate?.checks,
      passedStages: gate ? [...gate.passedStages] : undefined,
      verifyAttempts: gate?.attempts ?? 0,
      turns,
      usage,
      metrics: { ...metrics },
    };
    onEvent(status === 'failed' ? { type: 'failed', result } : { type: 'done', result });
    return result;
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    signal?.throwIfAborted();
    onEvent({ type: 'turn', turn });

    // 오래된 도구 결과를 **한 번에 묶어서** 비운다. 매 턴 조금씩 지우면 그때마다 그 지점부터 프롬프트 캐시가 깨진다
    if (contextClearing && previousContextTokens >= contextClearing.triggerTokens) {
      const cleared = clearOldToolResults(messages, contextClearing);
      if (cleared.clearedCount > 0) {
        // 대화 배열은 호출자가 쥐고 있으므로 같은 배열을 그대로 채운다(참조를 바꾸지 않는다)
        messages.splice(0, messages.length, ...cleared.messages);
        onEvent({ type: 'context_cleared', turn, clearedCount: cleared.clearedCount, clearedChars: cleared.clearedChars });
      }
    }

    // 진행 중 지시는 다음 모델 호출 직전에만 넣는다. 도구 결과가 들어간 뒤라 도구 호출 도중에 끼어들지 않는다
    const steering = takeSteering(options.steering);
    if (steering.length > 0) {
      appendUserText(messages, formatSteering(steering));
      onEvent({ type: 'steer_applied', count: steering.length });
    }

    const modelStarted = performance.now();
    const message = await activeClient.createMessage({ system, tools, messages }, signal);
    metrics.modelMs += Math.round(performance.now() - modelStarted);
    metrics.modelCalls += 1;
    const turnContext = contextTokens(message.usage);
    metrics.maxContextTokens = Math.max(metrics.maxContextTokens, turnContext);
    addUsage(usage, message.usage);
    // 모델별 사용량. 클라이언트가 모델 id를 알려 주면 그 이름으로, 아니면 '알 수 없음'으로 묶는다
    addUsage((usageByModel[activeClient.info?.model ?? '알 수 없음'] ??= emptyUsage()), message.usage);
    // 요청이 취소되거나 오류로 끝나도 그때까지 쓴 양을 알 수 있게 응답마다 알린다
    onEvent({ type: 'tokens', usage: { ...usage } });
    // 그 턴 한 번의 사용량. 실행 누적값(tokens)과 달리 턴별 컨텍스트 증가를 볼 수 있다
    onEvent({
      type: 'turn_usage',
      turn,
      inputTokens: message.usage.input_tokens ?? 0,
      outputTokens: message.usage.output_tokens ?? 0,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      contextTokens: turnContext,
    });
    // 다음 턴은 이 크기를 보고 오래된 도구 결과를 비울지 정한다
    previousContextTokens = turnContext;
    // thinking·fallback 블록까지 응답 전체를 그대로 이어 붙여야 다음 요청이 올바르게 이어진다
    messages.push({ role: 'assistant', content: message.content });

    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim();
    if (text) onEvent({ type: 'text', text });

    if (message.stop_reason === 'refusal') {
      return finish('failed', `모델이 요청을 거절했습니다 (${message.stop_details?.category ?? 'category 없음'})`, turn);
    }
    if (message.stop_reason === 'model_context_window_exceeded') {
      return finish('failed', '대화가 모델의 컨텍스트 한도를 넘었습니다', turn);
    }

    const toolUses = message.content.filter((block): block is BetaToolUseBlock => block.type === 'tool_use');
    if (toolUses.length > 0) {
      // 쓰기 도구가 섞일 수 있으므로 모델이 낸 순서대로 실행하고, 결과는 한 메시지로 모아 돌려준다
      const results: BetaToolResultBlockParam[] = [];
      for (const call of toolUses) {
        onEvent({ type: 'tool_call', name: call.name, input: call.input });
        // 지연 기동 세션: 첫 파일 변경·샌드박스 도구일 때 샌드박스를 켠다. 게이트(계약 기준)는 그 뒤에 만들어진다
        if (options.ensureSandbox && (SANDBOX_TOOLS.has(call.name) || WRITE_TOOLS.has(call.name))) {
          await options.ensureSandbox();
          gate ??= await gateFor();
        }
        const toolStarted = performance.now();
        const outcome = await executeTool(call.name, call.input, {
          project,
          workspace,
          sandbox,
          fetcher,
          signal,
          onServiceStatus,
          readOnly: ask,
          design,
          onQuestion: (question) => {
            asked = question;
            onEvent({ type: 'question', ...question });
          },
          policy,
          approvalToken: options.approvalToken,
          requestApproval: options.requestApproval,
          board: options.board,
          onPolicyDecision: (decision) => onEvent({ type: 'policy', ...decision }),
          toolResults: toolCache,
        });
        metrics.toolMs += Math.round(performance.now() - toolStarted);
        if (outcome.ok && (call.name === 'write_file' || call.name === 'edit_file') && stage === 'plan') {
          stage = 'implement';
          onEvent({ type: 'stage', stage, source: 'platform' });
        } else if (outcome.ok && (call.name === 'run_in_service' || call.name === 'restart_service') && stage !== 'run') {
          stage = 'run';
          onEvent({ type: 'stage', stage, source: 'platform' });
        }
        onEvent({ type: 'tool_result', name: call.name, ok: outcome.ok, content: outcome.content, chars: outcome.content.length, rawChars: outcome.rawChars ?? outcome.content.length });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, is_error: !outcome.ok });
      }
      messages.push({ role: 'user', content: results });
      // 되묻고 멈추기: 질문이 나오면 실행을 끝내고 사용자 답을 다음 요청으로 받는다.
      // 도구 결과를 먼저 대화에 넣어 두어 이어받는 러너가 맥락을 그대로 잇는다.
      // 질문 전에 파일을 바꿨다면 그 변경도 게이트를 돌린다(변경이 없으면 돌리지 않는다)
      if (asked) {
        if (gate && workspace.changedFiles().length > 0) {
          const gateStarted = performance.now();
          await gate.check();
          metrics.gateMs += Math.round(performance.now() - gateStarted);
        }
        return finish('awaiting_input', asked.question, turn, asked);
      }
      continue;
    }

    if (message.stop_reason === 'pause_turn') continue;
    if (message.stop_reason === 'max_tokens') {
      messages.push({ role: 'user', content: '응답이 max_tokens에서 잘렸습니다. 이어서 진행하세요.' });
      continue;
    }

    // 모델이 턴을 끝냈다 → 질문이면 답이 곧 결과이고, 만들기면 검증 게이트
    if (!gate) return finish('done', text, turn);
    // 단계 이벤트(실행·계약·화면·테스트·리뷰)는 게이트가 직접 알린다. 로컬 Claude Code 러너도 같은 게이트를 쓴다
    const gateStarted = performance.now();
    const outcome = await gate.check();
    metrics.gateMs += Math.round(performance.now() - gateStarted);
    if (outcome.kind === 'pass') {
      // 바뀐 파일이 없어 검증 없이 끝났다면 체크포인트할 것도 없다
      if (gate.verified) onEvent({ type: 'stage', stage: 'checkpoint', source: 'platform' });
      return finish('done', text, turn);
    }
    if (outcome.kind === 'exhausted') return finish('failed', outcome.summary, turn);
    if (escalation && !escalated) {
      const key = signatureSetKey(gate.report, gate.checks);
      escalationHistory.push(key);
      const times = escalation.sameSignatureTimes ?? DEFAULT_SAME_SIGNATURE_TIMES;
      if (shouldEscalate(escalationHistory, times)) {
        escalated = true;
        metrics.escalatedAt = gate.attempts;
        onEvent({ type: 'model_escalated', from: client.info?.model ?? '알 수 없음', to: escalation.to, attempt: gate.attempts, signature: key, sameSignatureTimes: times });
        activeClient = escalation.client;
      }
    }
    messages.push({ role: 'user', content: outcome.feedback });
  }

  return finish('failed', `최대 턴 수(${maxTurns})를 넘었습니다`, maxTurns);
}

function addUsage(total: AgentUsage, usage: BetaMessage['usage']): void {
  total.inputTokens += usage.input_tokens ?? 0;
  total.outputTokens += usage.output_tokens ?? 0;
  total.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  total.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
}

function emptyMetrics(): RunMetrics {
  return { modelCalls: 0, maxContextTokens: 0, modelMs: 0, toolMs: 0, gateMs: 0 };
}

/**
 * 모델이 실제로 받은 입력 크기. Anthropic 응답의 input_tokens는 캐시 분을 빼고 세므로
 * cache_read·cache_creation을 더해야 한 호출의 입력 크기가 된다.
 */
function contextTokens(usage: BetaMessage['usage']): number {
  return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}
