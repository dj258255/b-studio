/**
 * 턴마다 컨텍스트 크기가 얼마나 늘었는지 보고, 급증(jump)이 있으면 무엇이 늘렸는지와 다시 읽힐 비용을 추정한다(순수 함수).
 *
 * `turn_usage`가 그 턴 모델 호출의 컨텍스트 크기(contextTokens)를 남기고, 그 사이(다음 turn_usage 전까지) 온
 * `text`·`tool_call`(모델이 쓴 것)과 `tool_result`(도구 결과)가 다음 턴 컨텍스트에 얹힌다. 이 파일은 그 차이(delta)를
 * 직전 턴에서 생긴 것들로 나눠 "왜 늘었는지"를 사람이 읽을 형태로 만든다.
 *
 * 벤치(bench/coordination/turns.ts)처럼 늘어난 토큰을 글자 수 비율로 되추정하지 않는다. 여기서는 조각별 글자 수를
 * 그대로 보여주고("무엇이 얼마나 컸는지"), 급증 판정과 다시 읽힐 비용 추정만 컨텍스트 토큰 값(turn_usage가 남긴 값)으로 한다.
 */
import { isRepeatNote, type AgentEvent } from '@b-studio/agent';
import type { StudioEvent } from './studio-events';

/** 급증 판정: 절대 증가량(토큰). 도구 결과 예산(6,000자 ≈ 1,500토큰, E7 참고)보다 훨씬 큰 증가만 잡는다 */
export const JUMP_MIN_TOKENS = 4_000;
/** 급증 판정: 직전 컨텍스트 대비 증가 비율. 작은 컨텍스트에서도 상대적으로 크게 뛰면 잡는다(25%) */
export const JUMP_MIN_RATIO = 0.25;

export type ContextGrowthSourceKind = 'tool_result' | 'model_output';

export interface ContextGrowthSource {
  kind: ContextGrowthSourceKind;
  /** 도구 이름. kind가 model_output이면 없다 */
  name?: string;
  /** 그 사이 모델에 간 글자 수 합 */
  chars: number;
  /** 이 턴에 얹힌 전체 글자(도구 결과 + 모델 출력) 중 이 항목의 비중(0-1). 전체가 0이면 0 */
  share: number;
  /** 사람이 읽을 짧은 한국어 힌트 */
  hint: string;
}

export interface ContextGrowthTurn {
  turn: number;
  contextTokens: number;
  /** 직전 턴 대비 컨텍스트 증가량. 첫 턴은 contextTokens와 같다(줄어들면 음수일 수 있다) */
  delta: number;
  /** 이 증가를 만든 항목들(직전 턴이 부른 도구 결과·모델 출력). 첫 턴은 비교할 앞 턴이 없어 비어 있다 */
  sources: ContextGrowthSource[];
}

export interface ContextJump {
  turn: number;
  delta: number;
  previousContext: number;
  /** 무엇이 이 증가를 만들었는지(글자 수 큰 순) */
  sources: ContextGrowthSource[];
  /** 이 턴 뒤에 남은 턴 수. 늘어난 양이 이후 호출마다 다시 읽힌다고 보고 비용을 추정하는 데 쓴다 */
  remainingTurns: number;
  /** 다시 읽힐 것으로 추정되는 토큰 = delta × remainingTurns */
  estimatedRereadTokens: number;
  /** 같은 도구를 같은 입력으로 반복 호출했거나(또는 앞 결과와 같아 참조로 대체됐거나) */
  repeatedCall: boolean;
  /** 사람이 읽을 짧은 한국어 힌트 모음(원인별 + 반복 호출이면 추가) */
  hints: string[];
}

export interface ContextGrowthReport {
  turns: ContextGrowthTurn[];
  jumps: ContextJump[];
}

/** 급증 판정 함수. delta ≥ max(JUMP_MIN_TOKENS, previousContext × JUMP_MIN_RATIO) */
export function isContextJump(delta: number, previousContext: number): boolean {
  return delta >= Math.max(JUMP_MIN_TOKENS, previousContext * JUMP_MIN_RATIO);
}

const MODEL_OUTPUT_HINT = '모델이 쓴 응답(글·도구 입력)이 커서 늘었습니다. 요청을 더 작은 단위로 나누세요';
const REPEATED_HINT = '같은 도구를 같은 입력으로 반복 호출했습니다. 같은 결과를 반복해서 읽고 있습니다';

/** 도구 이름별 짧은 한국어 힌트. 모르는 도구는 일반 문구를 쓴다 */
function hintForTool(name: string): string {
  switch (name) {
    case 'read_file':
      return '파일 일부만 읽게(줄 범위) 요청하세요';
    case 'run_in_service':
      return '명령 출력을 grep/tail로 좁히게 하세요';
    case 'list_files':
      return '찾는 조건을 좁혀 결과 수를 줄이세요';
    case 'service_logs':
      return '로그 범위를 좁혀 받으세요';
    case 'http_request':
    case 'call_external_api':
      return '응답에서 필요한 필드만 받도록 요청을 좁히세요';
    default:
      return `${name} 결과가 커서 늘었습니다. 필요한 부분만 받도록 입력을 좁히세요`;
  }
}

interface PendingCall {
  name: string;
  input: unknown;
  turn?: number;
}

interface RawResult {
  name: string;
  input: unknown;
  chars: number;
  turn?: number;
  repeated: boolean;
}

/**
 * 한 실행(run)의 이벤트에서 턴별 컨텍스트 증가와 급증을 뽑는다.
 * events는 **한 실행의 이벤트만** 담아야 한다(다른 실행과 섞으면 턴 번호가 겹쳐 잘못 묶인다).
 */
export function analyzeContextGrowth(events: readonly StudioEvent[]): ContextGrowthReport {
  let currentTurn: number | undefined;
  const contextByTurn: Array<{ turn: number; contextTokens: number }> = [];
  const outputCharsByTurn = new Map<number, number>();
  const pending: PendingCall[] = [];
  const results: RawResult[] = [];
  // 도구 이름+입력 조합이 이 실행에서 몇 번 불렸는지(반복 호출 탐지용)
  const callSignatureCount = new Map<string, number>();

  const addOutputChars = (turn: number | undefined, chars: number) => {
    if (turn === undefined || chars <= 0) return;
    outputCharsByTurn.set(turn, (outputCharsByTurn.get(turn) ?? 0) + chars);
  };

  for (const event of events) {
    if (event.type !== 'agent') continue;
    const agent = event.event as Exclude<AgentEvent, { type: 'tokens' }>;
    switch (agent.type) {
      case 'turn':
        currentTurn = agent.turn;
        break;
      case 'turn_usage':
        contextByTurn.push({ turn: agent.turn, contextTokens: agent.contextTokens });
        break;
      case 'text':
        addOutputChars(currentTurn, agent.text.length);
        break;
      case 'tool_call': {
        pending.push({ name: agent.name, input: agent.input, turn: currentTurn });
        addOutputChars(currentTurn, inputChars(agent.input));
        const signature = callSignature(agent.name, agent.input);
        callSignatureCount.set(signature, (callSignatureCount.get(signature) ?? 0) + 1);
        break;
      }
      case 'tool_result': {
        // 같은 이름의 가장 오래된 미완료 호출과 짝지어 턴·입력을 물려받는다(token-report와 같은 규칙)
        const index = pending.findIndex((call) => call.name === agent.name);
        const call = index === -1 ? { name: agent.name, input: {} } : pending.splice(index, 1)[0]!;
        const chars = agent.chars ?? agent.content.length;
        results.push({ name: agent.name, input: call.input, chars, turn: call.turn, repeated: isRepeatNote(agent.content) });
        break;
      }
      default:
        break;
    }
  }

  const turns: ContextGrowthTurn[] = [];
  const jumps: ContextJump[] = [];
  let previous: { turn: number; contextTokens: number } | undefined;

  contextByTurn.forEach((turn, index) => {
    const delta = previous ? turn.contextTokens - previous.contextTokens : turn.contextTokens;
    const sources = previous ? sourcesFor(previous.turn, results, outputCharsByTurn) : [];
    turns.push({ turn: turn.turn, contextTokens: turn.contextTokens, delta, sources });

    if (previous && isContextJump(delta, previous.contextTokens)) {
      const remainingTurns = contextByTurn.length - 1 - index;
      const repeatedCall = repeatedCallIn(previous.turn, results, callSignatureCount);
      const hints = sources.map((source) => source.hint);
      if (repeatedCall && !hints.includes(REPEATED_HINT)) hints.push(REPEATED_HINT);
      jumps.push({
        turn: turn.turn,
        delta,
        previousContext: previous.contextTokens,
        sources,
        remainingTurns,
        estimatedRereadTokens: Math.round(delta * remainingTurns),
        repeatedCall,
        hints,
      });
    }
    previous = turn;
  });

  return { turns, jumps };
}

/** 어떤 턴(turn) 직후에 생긴 도구 결과·모델 출력을 글자 수 큰 순으로 묶는다 */
function sourcesFor(turn: number, results: readonly RawResult[], outputCharsByTurn: ReadonlyMap<number, number>): ContextGrowthSource[] {
  const byName = new Map<string, number>();
  for (const result of results) {
    if (result.turn !== turn) continue;
    byName.set(result.name, (byName.get(result.name) ?? 0) + result.chars);
  }
  const outputChars = outputCharsByTurn.get(turn) ?? 0;
  const total = [...byName.values()].reduce((sum, chars) => sum + chars, 0) + outputChars;

  const items: ContextGrowthSource[] = [...byName.entries()].map(([name, chars]) => ({
    kind: 'tool_result' as const,
    name,
    chars,
    share: total === 0 ? 0 : chars / total,
    hint: hintForTool(name),
  }));
  if (outputChars > 0) {
    items.push({ kind: 'model_output', chars: outputChars, share: total === 0 ? 0 : outputChars / total, hint: MODEL_OUTPUT_HINT });
  }
  return items.sort((a, b) => b.chars - a.chars);
}

/** 그 턴 직후 결과 중 참조로 대체됐거나, 같은 도구·같은 입력이 이 실행에서 두 번 이상 불린 것이 있는지 */
function repeatedCallIn(turn: number, results: readonly RawResult[], callSignatureCount: ReadonlyMap<string, number>): boolean {
  for (const result of results) {
    if (result.turn !== turn) continue;
    if (result.repeated) return true;
    if ((callSignatureCount.get(callSignature(result.name, result.input)) ?? 0) > 1) return true;
  }
  return false;
}

function callSignature(name: string, input: unknown): string {
  return `${name}\u0000${safeStringify(input)}`;
}

function inputChars(input: unknown): number {
  if (input === undefined || input === null) return 0;
  if (typeof input === 'string') return input.length;
  return safeStringify(input).length;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
