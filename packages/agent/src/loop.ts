import type Anthropic from '@anthropic-ai/sdk';
import type { Sandbox, StartOptions } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import type { BrowserRunner } from './browser-check';
import { VerificationGate, type PageFetcher } from './gate';
import { buildAskRequest, buildSystemPrompt } from './prompts';
import { buildTools, executeTool, type ToolContext } from './tools';
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
}

export interface AgentResult {
  status: 'done' | 'failed';
  summary: string;
  changedFiles: string[];
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
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; ok: boolean; content: string }
  | { type: 'policy'; tool: string; decision: 'allow' | 'deny'; reason?: string }
  | { type: 'stage'; stage: import('@b-studio/spec').WorkflowStage; source: 'platform' | 'agent' }
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
  project: LoadedProject;
  sandbox: Sandbox;
  client: ModelClient;
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
  /** 도구 호출을 실행기에서 통제하는 정책 */
  policy?: ExecutionPolicy;
  approvalToken?: string;
  requestApproval?: ToolContext['requestApproval'];
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
    intent = 'build',
  } = options;
  const ask = intent === 'ask';

  if (client.info) onEvent({ type: 'session', backend: client.info.backend, model: client.info.model, auth: client.info.auth });

  const workspace = new Workspace(project.root);
  // 질문 모드는 파일을 바꾸지 않으므로 계약 기준을 잡거나 게이트를 돌리지 않는다
  const gate = ask
    ? undefined
    : await VerificationGate.create({
        project,
        sandbox,
        workspace,
        allowBreaking,
        maxVerifyAttempts,
        fetcher,
        pageFetcher,
        browserRunner,
        signal,
        onServiceStatus,
        onEvent,
      });
  const system = buildSystemPrompt(project) + workflowContext(project);
  const tools = buildTools(project);
  const policy = options.policy ?? executionPolicyFor(project);
  let stage: import('@b-studio/spec').WorkflowStage = 'plan';
  onEvent({ type: 'stage', stage, source: 'platform' });
  messages.push({ role: 'user', content: ask ? buildAskRequest(request) : request });
  const usage = emptyUsage();
  const metrics = emptyMetrics();

  const finish = (status: AgentResult['status'], summary: string, turns: number): AgentResult => {
    const result: AgentResult = {
      status,
      summary,
      changedFiles: workspace.changedFiles(),
      report: gate?.report,
      checks: gate?.checks,
      passedStages: gate ? [...gate.passedStages] : undefined,
      verifyAttempts: gate?.attempts ?? 0,
      turns,
      usage,
      metrics: { ...metrics },
    };
    onEvent(status === 'done' ? { type: 'done', result } : { type: 'failed', result });
    return result;
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    signal?.throwIfAborted();
    onEvent({ type: 'turn', turn });

    const modelStarted = performance.now();
    const message = await client.createMessage({ system, tools, messages }, signal);
    metrics.modelMs += Math.round(performance.now() - modelStarted);
    metrics.modelCalls += 1;
    metrics.maxContextTokens = Math.max(metrics.maxContextTokens, contextTokens(message.usage));
    addUsage(usage, message.usage);
    // 요청이 취소되거나 오류로 끝나도 그때까지 쓴 양을 알 수 있게 응답마다 알린다
    onEvent({ type: 'tokens', usage: { ...usage } });
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
        const toolStarted = performance.now();
        const outcome = await executeTool(call.name, call.input, {
          project,
          workspace,
          sandbox,
          fetcher,
          signal,
          onServiceStatus,
          readOnly: ask,
          policy,
          approvalToken: options.approvalToken,
          requestApproval: options.requestApproval,
          onPolicyDecision: (decision) => onEvent({ type: 'policy', ...decision }),
        });
        metrics.toolMs += Math.round(performance.now() - toolStarted);
        if (outcome.ok && (call.name === 'write_file' || call.name === 'edit_file') && stage === 'plan') {
          stage = 'implement';
          onEvent({ type: 'stage', stage, source: 'platform' });
        } else if (outcome.ok && (call.name === 'run_in_service' || call.name === 'restart_service') && stage !== 'run') {
          stage = 'run';
          onEvent({ type: 'stage', stage, source: 'platform' });
        }
        onEvent({ type: 'tool_result', name: call.name, ok: outcome.ok, content: outcome.content });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, is_error: !outcome.ok });
      }
      messages.push({ role: 'user', content: results });
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
