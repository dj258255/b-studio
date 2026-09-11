import type Anthropic from '@anthropic-ai/sdk';
import type { Sandbox, StartOptions } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { VerificationGate } from './gate';
import { buildSystemPrompt } from './prompts';
import { buildTools, executeTool } from './tools';
import { fetchContract, type ContractFetcher, type VerificationReport } from './verify';
import { Workspace } from './workspace';

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

/** 모델 호출을 추상화한다. 실제 Claude 클라이언트와 오프라인 검증용 스크립트 모델이 같은 루프를 쓴다 */
export interface ModelClient {
  createMessage(request: AgentRequest, signal?: AbortSignal): Promise<BetaMessage>;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentResult {
  status: 'done' | 'failed';
  summary: string;
  changedFiles: string[];
  /** 마지막 검증 게이트 결과 */
  report?: VerificationReport;
  verifyAttempts: number;
  turns: number;
  usage: AgentUsage;
}

export type AgentEvent =
  /** 실제로 요청을 처리하는 실행 환경. 로컬 Claude Code처럼 모델과 인증을 밖에서 정할 때 알린다 */
  | { type: 'session'; backend: string; model: string; auth?: string }
  | { type: 'turn'; turn: number }
  /** 이번 실행에서 지금까지 쓴 토큰 누적값. 직접 만든 루프는 모델 응답마다, 로컬 Claude Code는 턴을 끝낼 때마다 온다 */
  | { type: 'tokens'; usage: AgentUsage }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; ok: boolean; content: string }
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
  maxTurns?: number;
  /** 검증 게이트 실패를 몇 번까지 모델에게 돌려줄지 */
  maxVerifyAttempts?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /** 검증 게이트나 도구가 서비스를 재시작할 때의 상태. 재시작하면 호스트 포트가 바뀌므로 미리보기가 따라가야 한다 */
  onServiceStatus?: StartOptions['onStatus'];
  fetcher?: ContractFetcher;
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
  } = options;

  const workspace = new Workspace(project.root);
  const gate = await VerificationGate.create({
    project,
    sandbox,
    workspace,
    allowBreaking,
    maxVerifyAttempts,
    fetcher,
    signal,
    onServiceStatus,
    onEvent,
  });
  const system = buildSystemPrompt(project);
  const tools = buildTools(project);
  messages.push({ role: 'user', content: request });
  const usage = emptyUsage();

  const finish = (status: AgentResult['status'], summary: string, turns: number): AgentResult => {
    const result: AgentResult = {
      status,
      summary,
      changedFiles: workspace.changedFiles(),
      report: gate.report,
      verifyAttempts: gate.attempts,
      turns,
      usage,
    };
    onEvent(status === 'done' ? { type: 'done', result } : { type: 'failed', result });
    return result;
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    signal?.throwIfAborted();
    onEvent({ type: 'turn', turn });

    const message = await client.createMessage({ system, tools, messages }, signal);
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
        const outcome = await executeTool(call.name, call.input, { project, workspace, sandbox, fetcher, signal, onServiceStatus });
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

    // 모델이 턴을 끝냈다 → 검증 게이트
    const outcome = await gate.check();
    if (outcome.kind === 'pass') return finish('done', text, turn);
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
