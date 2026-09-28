/**
 * 세션 기록에서 실행별 "토큰 누수" 보고서를 만든다(순수 함수).
 *
 * 세션 기록의 `tokens` 이벤트는 실행 누적값이라 턴별 증가를 볼 수 없다. 그래서 러너가 턴마다 `turn_usage`를 남기고,
 * 도구 결과마다 `chars`(모델에 간 글자)와 `rawChars`(자르기 전)를 남긴다. 이 파일은 그 기록만 읽어
 * "어느 턴에서 컨텍스트가 커졌고, 어떤 도구 결과가 컨텍스트를 차지했는지"를 사람이 읽을 형태로 접는다.
 *
 * 토큰을 글자 수에서 추정하지 않는다. 언어·토크나이저마다 달라 틀린 숫자를 만들기 때문이다. 그래서 경고 규칙도 글자 수로만 판단한다.
 */
import { isRepeatNote, type AgentEvent, type AgentUsage } from '@b-studio/agent';
import type { StudioEvent } from '../studio-events';
import type { TokenBigResult, TokenPrices, TokenReport, TokenTurn, TokenToolTotal, TokenWarning } from '../token-types';

export type { TokenBigResult, TokenPrices, TokenReport, TokenToolTotal, TokenTurn, TokenWarning, TokenWarningKind } from '../token-types';

/** 한 결과가 이 글자를 넘으면 경고한다. 명령 출력 예산(6,000)보다 큰 결과를 낭비로 본다 */
export const BIG_RESULT_CHARS = 6_000;
/** 한 턴에 컨텍스트가 이 토큰 넘게 늘면 경고한다(20k는 작은 모델 컨텍스트의 10% 수준) */
export const CONTEXT_JUMP_TOKENS = 20_000;
/** 큰 결과 상위 개수 */
export const BIGGEST_LIMIT = 5;
/** 도구 입력 요약 길이 */
const INPUT_SUMMARY_CHARS = 80;

interface PendingCall {
  name: string;
  input: unknown;
  turn?: number;
}

interface RecordedResult extends PendingCall {
  chars: number;
  rawChars: number;
  repeated: boolean;
}

interface DraftRun {
  runId: string;
  request: string;
  currentTurn?: number;
  turns: Array<{ turn: number; contextTokens: number; output: number; cacheRead: number }>;
  pending: PendingCall[];
  results: RecordedResult[];
  usage: AgentUsage;
}

function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** 세션 기록에서 실행별 보고서를 만든다. 최신 실행이 먼저 온다 */
export function buildTokenReports(events: readonly StudioEvent[], prices?: TokenPrices): TokenReport[] {
  const runs: DraftRun[] = [];
  let current: DraftRun | undefined;

  for (const event of events) {
    if (event.type === 'run_started') {
      current = { runId: event.runId, request: event.request, turns: [], pending: [], results: [], usage: emptyUsage() };
      runs.push(current);
      continue;
    }
    if (!current) continue;
    if (event.type === 'agent') {
      applyAgentEvent(current, event.event);
      continue;
    }
    if (event.type === 'tokens') {
      // tokens는 실행 누적값이라 마지막 값이 그 실행의 합계다
      current.usage = event.usage;
      continue;
    }
    if (event.type === 'run_finished' && event.runId === current.runId) {
      if (event.usage) current.usage = event.usage;
      current = undefined;
    }
  }

  return runs.map((run) => finalize(run, prices)).reverse();
}

function applyAgentEvent(run: DraftRun, event: Exclude<AgentEvent, { type: 'tokens' }>): void {
  switch (event.type) {
    case 'turn':
      run.currentTurn = event.turn;
      break;
    case 'turn_usage':
      run.turns.push({ turn: event.turn, contextTokens: event.contextTokens, output: event.outputTokens, cacheRead: event.cacheReadTokens });
      break;
    case 'tool_call':
      run.pending.push({ name: event.name, input: event.input, turn: run.currentTurn });
      break;
    case 'tool_result': {
      // 같은 이름의 가장 오래된 미완료 호출과 짝지어 턴·입력을 물려받는다(화면의 대화 접기와 같은 규칙)
      const index = run.pending.findIndex((call) => call.name === event.name);
      const call = index === -1 ? { name: event.name, input: {} } : run.pending.splice(index, 1)[0]!;
      const chars = event.chars ?? event.content.length;
      run.results.push({ name: event.name, input: call.input, turn: call.turn, chars, rawChars: event.rawChars ?? chars, repeated: isRepeatNote(event.content) });
      break;
    }
    default:
      break;
  }
}

function finalize(run: DraftRun, prices: TokenPrices | undefined): TokenReport {
  const turns: TokenTurn[] = [];
  let previous = 0;
  for (const turn of run.turns) {
    const results = run.results.filter((result) => result.turn === turn.turn);
    const biggest = results.reduce<RecordedResult | undefined>((max, result) => (max === undefined || result.chars > max.chars ? result : max), undefined);
    turns.push({
      turn: turn.turn,
      contextTokens: turn.contextTokens,
      delta: turn.contextTokens - previous,
      output: turn.output,
      cacheRead: turn.cacheRead,
      ...(biggest ? { biggestTool: { name: biggest.name, input: summarizeInput(biggest.name, biggest.input), chars: biggest.chars } } : {}),
    });
    previous = turn.contextTokens;
  }

  const totalChars = run.results.reduce((sum, result) => sum + result.chars, 0);
  const totalsByName = new Map<string, { calls: number; chars: number }>();
  for (const result of run.results) {
    const entry = totalsByName.get(result.name) ?? { calls: 0, chars: 0 };
    entry.calls += 1;
    entry.chars += result.chars;
    totalsByName.set(result.name, entry);
  }
  const toolTotals: TokenToolTotal[] = [...totalsByName.entries()]
    .map(([name, entry]) => ({ name, calls: entry.calls, chars: entry.chars, share: totalChars === 0 ? 0 : entry.chars / totalChars }))
    .sort((a, b) => b.chars - a.chars);

  const biggest: TokenBigResult[] = [...run.results]
    .sort((a, b) => b.chars - a.chars)
    .slice(0, BIGGEST_LIMIT)
    .map((result) => ({ name: result.name, input: summarizeInput(result.name, result.input), chars: result.chars, rawChars: result.rawChars, turn: result.turn }));

  const report: TokenReport = {
    runId: run.runId,
    request: run.request,
    turns,
    toolTotals,
    biggest,
    warnings: warningsFor(run, turns),
    totals: run.usage,
    cacheHitRatio: cacheHitRatio(run.usage),
  };
  // 단가가 없으면 비용 칸을 비우고 문구만 남긴다
  return prices ? { ...report, estimatedCostUsd: estimateCostUsd(run.usage, prices) } : { ...report, priceNote: '단가 미설정' };
}

function warningsFor(run: DraftRun, turns: TokenTurn[]): TokenWarning[] {
  const warnings: TokenWarning[] = [];
  for (const result of run.results) {
    if (result.rawChars > BIG_RESULT_CHARS) {
      warnings.push({
        kind: 'big_result',
        turn: result.turn,
        tool: result.name,
        message: `${result.name} 결과가 원래 ${result.rawChars.toLocaleString('ko-KR')}자였습니다(모델에는 ${result.chars.toLocaleString('ko-KR')}자). 명령·읽기 범위를 좁히세요`,
      });
    }
    if (result.repeated) {
      warnings.push({ kind: 'repeated_result', turn: result.turn, tool: result.name, message: `${result.name}가 앞과 같은 결과를 다시 받았습니다(참조로 대체됨)` });
    }
    if (readsNodeModules(result.name, result.input)) {
      warnings.push({ kind: 'node_modules', turn: result.turn, tool: result.name, message: `${result.name}가 node_modules를 읽었습니다. 라이브러리 소스 대신 프로젝트 코드를 보세요` });
    }
  }
  for (const turn of turns) {
    if (turn.delta > CONTEXT_JUMP_TOKENS) {
      warnings.push({
        kind: 'context_jump',
        turn: turn.turn,
        message: `턴 ${turn.turn}에서 컨텍스트가 ${turn.delta.toLocaleString('ko-KR')} 토큰 늘었습니다`,
      });
    }
  }
  // 읽기 쉽게 턴 순서로 정렬하되, 턴이 없는 경고는 뒤로 보낸다
  return warnings.sort((a, b) => (a.turn ?? Number.MAX_SAFE_INTEGER) - (b.turn ?? Number.MAX_SAFE_INTEGER));
}

function cacheHitRatio(usage: AgentUsage): number {
  const denominator = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return denominator === 0 ? 0 : usage.cacheReadTokens / denominator;
}

/** 도구 입력을 80자로 줄여 사람이 읽을 한 줄로 만든다 */
export function summarizeInput(name: string, input: unknown): string {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const command = () => (Array.isArray(args.command) ? args.command.filter((value): value is string => typeof value === 'string').join(' ') : '');
  const summary = (() => {
    switch (name) {
      case 'read_file':
        return text(args.path);
      case 'list_files':
        return text(args.path);
      case 'write_file':
      case 'edit_file':
      case 'delete_file':
        return text(args.path);
      case 'run_in_service':
        return `${text(args.service)} ${command()}`.trim();
      case 'restart_service':
      case 'service_logs':
        return text(args.service);
      case 'http_request':
        return `${text(args.service)} ${text(args.method)} ${text(args.path)}`.trim();
      case 'call_external_api':
        return `${text(args.api)} ${text(args.method)} ${text(args.path)}`.trim();
      default:
        return name;
    }
  })();
  return summary.length > INPUT_SUMMARY_CHARS ? `${summary.slice(0, INPUT_SUMMARY_CHARS)}…` : summary;
}

/** node_modules를 읽는 호출인지. read_file의 경로, run_in_service의 cat·sed·head 인자를 본다 */
function readsNodeModules(name: string, input: unknown): boolean {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  if (name === 'read_file') return typeof args.path === 'string' && args.path.includes('node_modules');
  if (name === 'run_in_service' && Array.isArray(args.command)) {
    const parts = args.command.filter((value): value is string => typeof value === 'string');
    return /^(cat|sed|head|tail)$/.test(parts[0] ?? '') && parts.some((part) => part.includes('node_modules'));
  }
  return false;
}

/**
 * 환경 변수에서 단가를 읽는다. 네 값이 모두 있어야 하며, 하나라도 없으면 비용을 계산하지 않는다(단가 미설정).
 * 값이 잘못됐거나 음수여도 없는 것으로 본다.
 */
export function pricesFromEnv(env: Record<string, string | undefined>): TokenPrices | undefined {
  const read = (name: string): number | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const inputPerM = read('B_STUDIO_PRICE_INPUT_PER_M');
  const outputPerM = read('B_STUDIO_PRICE_OUTPUT_PER_M');
  const cacheReadPerM = read('B_STUDIO_PRICE_CACHE_READ_PER_M');
  const cacheWritePerM = read('B_STUDIO_PRICE_CACHE_WRITE_PER_M');
  if (inputPerM === undefined || outputPerM === undefined || cacheReadPerM === undefined || cacheWritePerM === undefined) return undefined;
  return { inputPerM, outputPerM, cacheReadPerM, cacheWritePerM };
}

/** 추정 비용(달러). 청구 금액이 아니라 단가를 넣었을 때의 환산값이다 */
export function estimateCostUsd(usage: AgentUsage, prices: TokenPrices): number {
  return (
    (usage.inputTokens * prices.inputPerM + usage.outputTokens * prices.outputPerM + usage.cacheReadTokens * prices.cacheReadPerM + usage.cacheWriteTokens * prices.cacheWritePerM) /
    1_000_000
  );
}
