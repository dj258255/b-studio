import type { CliMessage } from './claude-cli-process';
import { emptyUsage, type AgentUsage } from './loop';

/**
 * 옮기기 전(ADR-191 3ac) `claude-code-runner.ts`의 판정·사용량 계산을 그대로 복사한 것. 차등 시험·벡터의 기준이다. 지우지 않는다.
 * `export`와 `SERVER` 상수만 더했다.
 */

const SERVER = 'b-studio';
const DEFAULT_COMPACT_WINDOW = 200_000;
const MIN_COMPACT_WINDOW = 50_000;
const COMPACT_WINDOW_ENV = 'B_STUDIO_CLAUDE_CODE_COMPACT_WINDOW';

export interface CompactWindowSetting {
  /** CLI에 넘길 창 크기. null이면 넘기지 않아 CLI 기본 동작을 쓴다 */
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


/**
 * 메시지에 일시적 네트워크 오류의 근거가 있는 패턴이 있는지 본다(실측: ENOTFOUND. 나머지는 Node·Anthropic API가
 * 문서화한 같은 종류의 오류). 인증 실패·잘못된 요청 같은 영구 오류 문구는 여기 걸리지 않아야
 * 재시도하지 않는다(ADR-142) — 근거가 없는 패턴은 넣지 않는다.
 */
export function isTransientNetworkFailure(message: string): boolean {
  return /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Can't reach the API server|overloaded_error|\boverloaded\b/i.test(message);
}


/** 프로세스가 결과 없이 끝났다는 실패 메시지. 종료 코드와 표준 오류의 끝부분을 담는다 */
export function noResultMessage(exit: { code: number | null; signal: NodeJS.Signals | null; error?: Error; stderr: string } | undefined): string {
  if (!exit) return 'Claude Code가 결과를 보내지 않고 종료됐습니다';
  const how = exit.error ? `실행하지 못함: ${exit.error.message}` : exit.signal ? `신호 ${exit.signal}` : `종료 코드 ${exit.code ?? '없음'}`;
  const tail = exit.stderr.trim().split('\n').slice(-3).join(' / ');
  return `Claude Code가 결과를 보내지 않고 종료됐습니다 (${how})${tail ? `: ${tail}` : ''}`;
}

/** init이 b-studio 도구 서버를 연결하지 못했다고 알리면 그 설명. 문서에 있는 mcp_servers·mcp_server_errors만 본다 */
export function mcpSetupFailure(message: CliMessage, server: string = SERVER): string | undefined {
  const errors = (message.mcp_server_errors ?? []).filter((entry) => entry.name === undefined || entry.name === server);
  const status = message.mcp_servers?.find((entry) => entry.name === server)?.status;
  // connected로 확인한 경우만 통과다. 목록에 없음·needs-auth·pending·disabled·모르는 값은 "모른다"이고 실패로 본다
  // (상태 값: https://code.claude.com/docs/en/agent-sdk/typescript 의 McpServerStatus)
  if (errors.length === 0 && status === 'connected') return undefined;
  const detail = errors[0]?.message ?? errors[0]?.type ?? status ?? '목록에 없음';
  return `Claude Code가 ${server} 도구 서버에 연결하지 못했습니다${detail ? `: ${detail}` : ''}`;
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

export function describeResultFailure(message: ClaudeResultMessage): string | undefined {
  switch (message.subtype) {
    case 'success':
      if (message.is_error) return `모델 호출이 실패했습니다: ${message.result ?? ''}`;
      if (message.stop_reason === 'refusal') return '모델이 요청을 거절했습니다';
      return undefined;
    case 'error_max_turns':
      return 'Claude Code의 최대 턴 수를 넘었습니다';
    case 'error_max_budget_usd':
      return 'Claude Code의 비용 한도를 넘었습니다';
    default:
      return `Claude Code 실행 중 오류가 났습니다${message.errors && message.errors.length > 0 ? `: ${message.errors.join('; ')}` : ''}`;
  }
}

type AssistantTokenUsage = {
  input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** modelUsage는 query 전체의 누적값이므로 더하지 않고 최신 값으로 바꾼다 */
/** result가 알려 주는 API 호출 시간 합(ms). 유한한 0 이상의 수가 아니면 재지 않은 것으로 본다 */
export function apiDurationOf(message: ClaudeResultMessage): number | undefined {
  const value: unknown = message.duration_api_ms;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

export function setUsage(usage: AgentUsage, message: ClaudeResultMessage): void {
  const models = Object.values(message.modelUsage ?? {});
  usage.inputTokens = models.reduce((sum, model) => sum + (model.inputTokens ?? 0), 0);
  usage.outputTokens = models.reduce((sum, model) => sum + (model.outputTokens ?? 0), 0);
  usage.cacheReadTokens = models.reduce((sum, model) => sum + (model.cacheReadInputTokens ?? 0), 0);
  usage.cacheWriteTokens = models.reduce((sum, model) => sum + (model.cacheCreationInputTokens ?? 0), 0);
}

/** 사용량을 0으로 되돌린다 */
export function resetUsage(usage: AgentUsage): void {
  usage.inputTokens = 0;
  usage.outputTokens = 0;
  usage.cacheReadTokens = 0;
  usage.cacheWriteTokens = 0;
}

/** 사용량을 다른 곳에 더한다 */
export function addUsageInto(target: AgentUsage, source: AgentUsage): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
}

/** result의 modelUsage(query 하나의 누적값)를 모델 이름별 AgentUsage로 옮긴다 */
export function usageByModelOf(message: ClaudeResultMessage): Record<string, AgentUsage> {
  const byModel: Record<string, AgentUsage> = {};
  for (const [model, usage] of Object.entries(message.modelUsage ?? {})) {
    byModel[model] = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadInputTokens ?? 0,
      cacheWriteTokens: usage.cacheCreationInputTokens ?? 0,
    };
  }
  return byModel;
}

/** 끝난 query들의 모델별 사용량(base)과 지금 query의 것(query)을 더해 실행 전체로 만든다 */
export function mergeUsageByModel(base: Record<string, AgentUsage>, query: Record<string, AgentUsage>): Record<string, AgentUsage> {
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
  observeResult(message: ClaudeResultMessage): void {
    this.#usageByModel = usageByModelOf(message);
    const models = Object.values(message.modelUsage ?? {});
    this.#usage.inputTokens = models.reduce((sum, model) => sum + (model.inputTokens ?? 0), 0);
    this.#usage.outputTokens = models.reduce((sum, model) => sum + (model.outputTokens ?? 0), 0);
    this.#usage.cacheReadTokens = models.reduce((sum, model) => sum + (model.cacheReadInputTokens ?? 0), 0);
    this.#usage.cacheWriteTokens = models.reduce((sum, model) => sum + (model.cacheCreationInputTokens ?? 0), 0);
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
