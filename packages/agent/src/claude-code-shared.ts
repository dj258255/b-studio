import { spawn } from 'node:child_process';
import { decodeNative, encodeNative, native } from '@b-studio/sandbox';
import { childEnv, resolveCliCommand, type CliMessage } from './claude-cli-process';
import { emptyUsage } from './loop';
import type { AgentUsage } from './agent-types';

/** b-studio 도구 서버의 MCP 이름. 러너와 사전 확인이 같은 이름을 쓴다 */
export const SERVER = 'b-studio';

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
