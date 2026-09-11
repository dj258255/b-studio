import {
  createSdkMcpServer,
  query,
  tool,
  type AccountInfo,
  type McpServerConfig,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Effort } from './anthropic-client';
import { VerificationGate } from './gate';
import { emptyUsage, type AgentEvent, type AgentResult, type AgentUsage, type RunAgentOptions } from './loop';
import { buildSystemPrompt } from './prompts';
import { buildTools, executeTool, type ToolContext } from './tools';
import { fetchContract } from './verify';
import { Workspace } from './workspace';

const SERVER = 'b-studio';
/** 화면 표기. Agent SDK 브랜딩 가이드는 제품 안에서 "Claude Code"라는 이름을 쓰지 않도록 한다 */
const BACKEND = '로컬 Claude Agent';

/** 실제 SDK와 테스트용 가짜를 바꿔 끼우는 지점 */
export interface ClaudeCodeSdk {
  query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): ClaudeCodeQuery;
  createSdkMcpServer(options: { name: string; version?: string; tools?: Array<SdkMcpToolDefinition<any>> }): McpServerConfig;
}

export interface ClaudeCodeQuery extends AsyncIterable<SDKMessage> {
  accountInfo(): Promise<AccountInfo>;
  interrupt(): Promise<unknown>;
  close(): void;
}

const DEFAULT_SDK: ClaudeCodeSdk = { query, createSdkMcpServer };

export interface ClaudeCodeAccount {
  subscriptionType?: string;
  apiKeySource?: string;
  apiProvider?: string;
}

export interface ClaudeCodeRunOptions extends Omit<RunAgentOptions, 'client' | 'conversation'> {
  /** 이전 요청을 처리한 Claude Code 세션. 넘기면 그 대화를 이어받는다 */
  resume?: string;
  /** 넘기지 않으면 로그인한 계정의 기본 모델을 쓴다 */
  model?: string;
  effort?: Effort;
  /** preflight에서 확인한 인증 정보. 화면에 어떤 계정으로 실행하는지 표시한다 */
  account?: ClaudeCodeAccount;
  sdk?: ClaudeCodeSdk;
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
    resume,
    model,
    effort = 'high',
    account,
    sdk = DEFAULT_SDK,
  } = options;
  signal?.throwIfAborted();

  const workspace = new Workspace(project.root);
  const gate = await VerificationGate.create({ project, sandbox, workspace, allowBreaking, maxVerifyAttempts, fetcher, signal, onServiceStatus, onEvent });
  const context: ToolContext = { project, workspace, sandbox, fetcher, signal, onServiceStatus };
  const specs = buildTools(project);
  const toolName = (name: string) => `mcp__${SERVER}__${name}`;

  // Claude Code는 읽기 도구를 동시에 부를 수 있다. 직접 만든 루프처럼 모델이 낸 순서대로 하나씩 실행한다
  const serial = serialQueue();
  const definitions = specs.map((spec) =>
    tool(spec.name, spec.description ?? '', zodShape(spec.input_schema), (args) =>
      serial(async () => {
        // 취소한 뒤 대기열에 남은 호출은 파일을 건드리지 않고 끝낸다
        signal?.throwIfAborted();
        onEvent({ type: 'tool_call', name: spec.name, input: args });
        const outcome = await executeTool(spec.name, args, context);
        onEvent({ type: 'tool_result', name: spec.name, ok: outcome.ok, content: outcome.content });
        return { content: [{ type: 'text' as const, text: outcome.content }], isError: !outcome.ok };
      }),
    ),
  );

  const input = new InputQueue();
  const abort = new AbortController();
  const onAbort = () => abort.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });

  const conversation = sdk.query({
    prompt: input,
    options: {
      cwd: project.root,
      systemPrompt: buildSystemPrompt(project, { toolName }),
      // 기본 도구를 모두 끄고 b-studio 도구만 허용한다. 허용 목록에 없는 도구는 묻지 않고 거부한다
      tools: [],
      mcpServers: { [SERVER]: sdk.createSdkMcpServer({ name: SERVER, version: '0.0.0', tools: definitions }) },
      allowedTools: specs.map((spec) => toolName(spec.name)),
      permissionMode: 'dontAsk',
      strictMcpConfig: true,
      // 사용자 전역·프로젝트 설정(훅, 플러그인, CLAUDE.md)이 에이전트 동작을 바꾸지 않게 한다
      settingSources: [],
      model,
      effort,
      maxTurns,
      abortController: abort,
      // 실패한 실행이 다음 요청의 대화를 오염시키지 않도록 매번 갈라서 이어받는다
      ...(resume ? { resume, forkSession: true } : {}),
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'b-studio' },
    },
  });
  input.push(request);

  const usage = emptyUsage();
  const messageIds = new Set<string>();
  let sessionId: string | undefined;
  let lastText = '';
  let announced = false;
  let result: ClaudeCodeResult | undefined;

  const finish = (status: AgentResult['status'], summary: string): void => {
    result = {
      status,
      summary,
      changedFiles: workspace.changedFiles(),
      report: gate.report,
      verifyAttempts: gate.attempts,
      turns: messageIds.size,
      usage,
      sessionId,
    };
    onEvent(status === 'done' ? { type: 'done', result } : { type: 'failed', result });
    // 입력을 닫으면 Claude Code가 남은 기록을 쓰고 스스로 끝난다
    input.close();
  };

  try {
    for await (const message of conversation) {
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
            });
          }
          break;

        case 'assistant': {
          // 하위 에이전트 메시지는 없어야 하지만, 섞여 와도 본 대화로 세지 않는다
          if (message.parent_tool_use_id) break;
          if (!messageIds.has(message.message.id)) {
            messageIds.add(message.message.id);
            onEvent({ type: 'turn', turn: messageIds.size });
            if (messageIds.size > maxTurns) {
              await conversation.interrupt().catch(() => {});
              finish('failed', `최대 턴 수(${maxTurns})를 넘었습니다`);
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
          setUsage(usage, message);
          onEvent({ type: 'tokens', usage: { ...usage } });
          const failure = describeResultFailure(message);
          if (failure) {
            finish('failed', failure);
            break;
          }
          // 모델이 턴을 끝냈다 → 검증 게이트
          const outcome = await gate.check();
          if (outcome.kind === 'pass') finish('done', lastText);
          else if (outcome.kind === 'exhausted') finish('failed', outcome.summary);
          else {
            lastText = '';
            input.push(outcome.feedback);
          }
          break;
        }
      }
    }
  } catch (error) {
    conversation.close();
    throw error;
  } finally {
    input.close();
    signal?.removeEventListener('abort', onAbort);
    // 프로세스를 닫아도 이미 시작한 도구 핸들러는 이어서 돈다. 호출한 쪽이 변경을 되돌리기 전에 끝나기를 기다린다
    await serial.idle();
  }

  signal?.throwIfAborted();
  if (!result) throw new Error('Claude Code가 결과를 보내지 않고 종료됐습니다');
  return result;
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

export function describeAccount(account: ClaudeCodeAccount): string {
  if (account.apiKeySource && account.apiKeySource !== 'none') return `API 키 (${account.apiKeySource})`;
  if (account.subscriptionType) return `${account.subscriptionType} 구독`;
  if (account.apiProvider && account.apiProvider !== 'firstParty') return account.apiProvider;
  return '로그인 계정';
}

function describeResultFailure(message: SDKResultMessage): string | undefined {
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

/** modelUsage는 query 전체의 누적값이므로 더하지 않고 최신 값으로 바꾼다 */
function setUsage(usage: AgentUsage, message: SDKResultMessage): void {
  const models = Object.values(message.modelUsage ?? {});
  usage.inputTokens = models.reduce((sum, model) => sum + model.inputTokens, 0);
  usage.outputTokens = models.reduce((sum, model) => sum + model.outputTokens, 0);
  usage.cacheReadTokens = models.reduce((sum, model) => sum + model.cacheReadInputTokens, 0);
  usage.cacheWriteTokens = models.reduce((sum, model) => sum + model.cacheCreationInputTokens, 0);
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
    else if (value.type === 'array' && value.items?.type === 'string') type = z.array(z.string());
    else throw new Error(`지원하지 않는 도구 입력 형식입니다: ${key} ${JSON.stringify(value)}`);
    shape[key] = value.description ? type.describe(value.description) : type;
  }
  return shape;
}

function serialQueue() {
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
