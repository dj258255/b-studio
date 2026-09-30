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
import { analyzeContextGrowth } from '../context-growth';
import type { ReviewStateView, StudioEvent } from '../studio-events';
import { costForUsageByModel, estimateCostUsd, matchTokenPrices, parsePriceTable, type TokenBigResult, type TokenPrices, type TokenReport, type TokenTrimmed, type TokenTurn, type TokenToolTotal, type TokenWarning } from '../token-types';

export { estimateCostUsd } from '../token-types';
export type { TokenBigResult, TokenPrices, TokenReport, TokenToolTotal, TokenTrimmed, TokenTurn, TokenWarning, TokenWarningKind } from '../token-types';

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
  /** 턴별로 비운 도구 결과(횟수·글자). 비우기는 그 턴의 모델 호출 전에 일어나 turn_usage보다 먼저 온다 */
  clearedByTurn: Map<number, { count: number; chars: number }>;
  /** 이 실행의 agent 이벤트를 그대로 모아 둔다(context-growth.ts가 턴별 증가 원인을 다시 계산할 때 쓴다) */
  rawEvents: StudioEvent[];
  pending: PendingCall[];
  results: RecordedResult[];
  usage: AgentUsage;
  /** run_finished.metrics.usageByModel. 한 실행에 모델이 섞였을 때만 있다 */
  usageByModel?: Record<string, AgentUsage>;
  /** model_escalated 이벤트. 한 실행에 한 번만 온다 */
  escalation?: { from: string; to: string; attempt: number };
}

/** 보고서에 적용할 단가. 모델별 표가 있으면 단일 단가보다 우선한다 */
export interface TokenPricing {
  /** 모든 모델에 같은 단가(기존 환경 변수 네 개) */
  single?: TokenPrices;
  /** 모델 이름 일부 → 단가(B_STUDIO_TOKEN_PRICES_JSON) */
  byModel?: Record<string, TokenPrices>;
  /** 단가 표를 읽지 못한 이유. 있으면 보고서에 경고로 남기고 단가 없음으로 취급한다 */
  error?: string;
}

function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** 세션 기록에서 실행별 보고서를 만든다. 최신 실행이 먼저 온다 */
export function buildTokenReports(events: readonly StudioEvent[], pricing: TokenPricing = {}): TokenReport[] {
  const runs: DraftRun[] = [];
  let current: DraftRun | undefined;

  for (const event of events) {
    if (event.type === 'run_started') {
      current = { runId: event.runId, request: event.request, turns: [], clearedByTurn: new Map(), rawEvents: [], pending: [], results: [], usage: emptyUsage() };
      runs.push(current);
      continue;
    }
    if (!current) continue;
    if (event.type === 'agent') {
      current.rawEvents.push(event);
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
      // 모델별 사용량은 run_finished.metrics에 실려 온다(#98)
      // 토큰을 하나도 쓰지 않은 모델(고정 계획의 가짜 클라이언트 'scripted' 등)은 표에 "단가 없음"으로만 보여 헷갈리므로 뺀다
      if (event.metrics?.usageByModel) {
        const used = Object.entries(event.metrics.usageByModel).filter(([, usage]) => usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0);
        if (used.length > 0) current.usageByModel = Object.fromEntries(used);
      }
      current = undefined;
    }
  }

  return runs.map((run) => finalize(run, pricing)).reverse();
}

function applyAgentEvent(run: DraftRun, event: Exclude<AgentEvent, { type: 'tokens' }>): void {
  switch (event.type) {
    case 'turn':
      run.currentTurn = event.turn;
      break;
    case 'turn_usage':
      run.turns.push({ turn: event.turn, contextTokens: event.contextTokens, output: event.outputTokens, cacheRead: event.cacheReadTokens });
      break;
    case 'context_cleared': {
      // 같은 턴에 여러 번 올 수 있어 더한다(보통은 한 번)
      const previous = run.clearedByTurn.get(event.turn) ?? { count: 0, chars: 0 };
      run.clearedByTurn.set(event.turn, { count: previous.count + event.clearedCount, chars: previous.chars + event.clearedChars });
      break;
    }
    case 'model_escalated':
      run.escalation = { from: event.from, to: event.to, attempt: event.attempt };
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

function finalize(run: DraftRun, pricing: TokenPricing): TokenReport {
  const turns: TokenTurn[] = [];
  let previous = 0;
  for (const turn of run.turns) {
    const results = run.results.filter((result) => result.turn === turn.turn);
    const biggest = results.reduce<RecordedResult | undefined>((max, result) => (max === undefined || result.chars > max.chars ? result : max), undefined);
    const cleared = run.clearedByTurn.get(turn.turn);
    turns.push({
      turn: turn.turn,
      contextTokens: turn.contextTokens,
      delta: turn.contextTokens - previous,
      output: turn.output,
      cacheRead: turn.cacheRead,
      ...(biggest ? { biggestTool: { name: biggest.name, input: summarizeInput(biggest.name, biggest.input), chars: biggest.chars } } : {}),
      ...(cleared ? { cleared } : {}),
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

  const warnings = warningsFor(run, turns);
  // 단가 표를 읽지 못했으면 경고를 남기고 단가 없음으로 취급한다
  if (pricing.error) warnings.unshift({ kind: 'price_table', message: pricing.error });
  const cost = resolveCost(run, pricing);

  return {
    runId: run.runId,
    request: run.request,
    turns,
    toolTotals,
    biggest,
    warnings,
    totals: run.usage,
    ...(run.usageByModel ? { usageByModel: run.usageByModel } : {}),
    ...(cost.modelCosts ? { modelCosts: cost.modelCosts } : {}),
    cacheHitRatio: cacheHitRatio(run.usage),
    cleared: clearedTotals(run.clearedByTurn),
    trimmed: trimmedTotals(run),
    priceSource: cost.priceSource,
    ...(cost.estimatedCostUsd !== undefined ? { estimatedCostUsd: cost.estimatedCostUsd } : {}),
    ...(cost.priceNote ? { priceNote: cost.priceNote } : {}),
    ...(run.escalation ? { escalation: run.escalation } : {}),
    contextGrowth: analyzeContextGrowth(run.rawEvents),
  };
}

/**
 * 비용을 계산한다. 모델별 단가 표가 있고 그 실행이 모델별 사용량을 남겼으면 모델별로 곱하고(단일 단가보다 우선),
 * 아니면 단일 단가로 계산한다. 둘 다 없으면 비용 칸을 비우고 문구만 남긴다.
 */
function resolveCost(
  run: DraftRun,
  pricing: TokenPricing,
): { priceSource: 'by-model' | 'single' | 'none'; estimatedCostUsd?: number; priceNote?: string; modelCosts?: Record<string, number> } {
  const usageByModel = run.usageByModel;
  if (pricing.byModel && usageByModel && Object.keys(usageByModel).length > 0) {
    const { costUsd, costNote } = costForUsageByModel(usageByModel, pricing.byModel);
    const modelCosts: Record<string, number> = {};
    for (const [model, usage] of Object.entries(usageByModel)) {
      const prices = matchTokenPrices(pricing.byModel, model);
      if (prices) modelCosts[model] = estimateCostUsd(usage, prices);
    }
    return { priceSource: 'by-model', ...(costUsd !== undefined ? { estimatedCostUsd: costUsd } : {}), ...(costNote ? { priceNote: costNote } : {}), modelCosts };
  }
  if (pricing.single) {
    const modelCosts = usageByModel
      ? Object.fromEntries(Object.entries(usageByModel).map(([model, usage]) => [model, estimateCostUsd(usage, pricing.single!)]))
      : undefined;
    return { priceSource: 'single', estimatedCostUsd: estimateCostUsd(run.usage, pricing.single), ...(modelCosts ? { modelCosts } : {}) };
  }
  return { priceSource: 'none', priceNote: '단가 미설정' };
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

/** 실행 전체에서 오래된 도구 결과를 비운 합계 */
function clearedTotals(byTurn: Map<number, { count: number; chars: number }>): { count: number; chars: number } {
  let count = 0;
  let chars = 0;
  for (const entry of byTurn.values()) {
    count += entry.count;
    chars += entry.chars;
  }
  return { count, chars };
}

/**
 * 도구 결과 예산이 잘라낸 양(측정)과, 자르지 않았다면 그 결과가 남은 모델 호출마다 다시 읽혔을 양(추정).
 * 추정식: Σ ((rawChars - chars) / 4) × (그 결과 뒤의 모델 호출 수 + 1). 글자→토큰은 4로 나눈 근사이고,
 * "+1"은 그 결과를 처음 실어 보낸 호출이다. 프로젝트 보고서가 이 값을 실행별로 더한다.
 */
function trimmedTotals(run: DraftRun): TokenTrimmed {
  const calls = run.turns.length;
  let chars = 0;
  let repeated = 0;
  let estimated = 0;
  for (const result of run.results) {
    if (result.repeated) repeated += 1;
    const cut = Math.max(0, result.rawChars - result.chars);
    if (cut === 0) continue;
    chars += cut;
    // 턴을 모르는 결과(턴 사용량을 남기지 않는 러너)는 실행 전체 호출 수로 센다
    const after = result.turn === undefined ? calls : run.turns.filter((turn) => turn.turn > result.turn!).length;
    estimated += (cut / 4) * (after + 1);
  }
  return { chars, repeated, estimatedTokens: Math.round(estimated) };
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

/**
 * 환경 변수에서 보고서용 단가를 모은다. 모델별 표(`B_STUDIO_TOKEN_PRICES_JSON`)가 잘못된 JSON이면
 * 서버를 죽이지 않고 error에 이유를 담아 보고서 경고로 넘긴다(단가 없음으로 취급).
 */
export function tokenPricing(env: Record<string, string | undefined>): TokenPricing {
  const single = pricesFromEnv(env);
  const base: TokenPricing = single ? { single } : {};
  const raw = env.B_STUDIO_TOKEN_PRICES_JSON?.trim();
  if (!raw) return base;
  try {
    return { ...base, byModel: parsePriceTable(JSON.parse(raw)) };
  } catch (error) {
    return { ...base, error: `단가 표를 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * PR 자동 리뷰 라운드(ADR-074)의 리뷰어 호출 토큰을 실행별 보고서와 같은 모양으로 만든다.
 * 리뷰어 호출은 도구 없는 한 번의 질문이라 세션 기록에 run_started/run_finished 이벤트를 남기지 않으므로,
 * 이벤트가 아니라 스냅샷의 review.rounds에 남긴 토큰을 그대로 읽는다. 턴별 분석은 없어(한 번만 묻는다) turns·toolTotals는 비워 둔다.
 * 토큰 탭·프로젝트 보고서가 `buildTokenReports`의 결과에 이 목록을 이어 붙여 "review"로 표시한다
 */
export function reviewTokenReports(review: ReviewStateView | undefined, pricing: TokenPricing = {}): TokenReport[] {
  if (!review) return [];
  return review.rounds
    .filter((round): round is typeof round & { tokens: AgentUsage } => round.tokens !== undefined)
    .map((round) => {
      const estimatedCostUsd = pricing.single ? estimateCostUsd(round.tokens, pricing.single) : undefined;
      return {
        runId: `review-${round.round}`,
        request: `[AI 리뷰] ${round.round}라운드 검토`,
        turns: [],
        toolTotals: [],
        biggest: [],
        warnings: [],
        totals: round.tokens,
        cacheHitRatio: cacheHitRatio(round.tokens),
        cleared: { count: 0, chars: 0 },
        trimmed: { chars: 0, repeated: 0, estimatedTokens: 0 },
        priceSource: pricing.single ? ('single' as const) : ('none' as const),
        ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
        kind: 'review' as const,
      };
    })
    .reverse();
}


