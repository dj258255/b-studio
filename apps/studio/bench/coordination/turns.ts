/**
 * 모델 호출(턴)마다 문맥 크기와 그 호출이 부른 도구를 남기고, 토큰이 어디서 나왔는지 나눈다(순수 함수).
 *
 * E5에서 토큰의 92~93%가 캐시 읽기였고, 합계는 "호출 수 × 문맥 크기"로 거의 정해졌다. 합계만으로는
 * 호출마다 붙는 고정 문맥(시스템 프롬프트·도구 설명·요청)과, 앞에서 쌓인 도구 결과를 다시 읽는 양을 가를 수 없다.
 *
 * 분해는 실제 문맥 크기로 한다. 호출 t의 문맥을 c_t, 호출 수를 N이라 하면
 *   Σ c_t = N·c_0 + Σ_t (c_{t+1} − c_t)·(N − 1 − t)
 * 이다. 앞 항이 고정 문맥, 뒤 항은 호출 t 뒤에 늘어난 양이 그 뒤 호출마다 다시 읽힌 양이다.
 * 늘어난 양은 그 호출의 출력(모델이 쓴 글·도구 입력)과 도구 결과로 **글자 수 비율**로 나누고, 도구끼리도 결과 글자 수 비율로 나눈다.
 * 출력 토큰 값으로 나누지 않는 이유: 로컬 Claude Code는 응답 첫 조각의 사용량만 알려 출력이 1~16 토큰처럼 거의 0으로 잡힌다.
 * 그러면 Write로 쓴 파일 내용처럼 모델이 쓴 것이 도구 결과로 넘어간다(E6 첫 시도에서 발견).
 * 오래된 결과를 비워 문맥이 줄면 늘어난 양이 음수가 되고, 그만큼을 '비워서 줄어든 양'으로 따로 센다.
 */
import type { StudioEvent } from '../../lib/studio-events';

export interface TurnTool {
  name: string;
  /** 모델에 간 결과 글자 수(자르기 뒤) */
  chars: number;
}

export interface TurnRecord {
  /** 이 호출의 입력 크기 = input + cacheRead + cacheWrite */
  context: number;
  /** 알려진 출력 토큰. 로컬 Claude Code에서는 첫 조각 값이라 덜 잡힌다. 분해에는 outputChars를 쓴다 */
  output: number;
  /** 이 호출의 응답에서 모델이 쓴 글과 도구 입력(JSON)의 글자 수 */
  outputChars: number;
  cacheRead: number;
  cacheWrite: number;
  /** 이 호출의 응답이 부른 도구와 결과 크기(부른 순서) */
  tools: TurnTool[];
}

export interface TokenBreakdown {
  calls: number;
  /** 모든 호출의 입력 크기 합 */
  contextTotal: number;
  output: number;
  /** 첫 호출 문맥 크기 = 호출마다 붙는 고정 문맥의 근사 */
  firstContext: number;
  /** firstContext × calls */
  fixed: number;
  /** 모델 출력(글·도구 입력)이 그 뒤 호출에서 다시 읽힌 양 */
  outputReread: number;
  /** 도구 결과가 그 뒤 호출에서 다시 읽힌 양, 도구 이름별 */
  toolReread: Record<string, number>;
  /** 도구 이름별 결과 글자 수 합과 호출 수 */
  toolResults: Record<string, { calls: number; chars: number }>;
  /** 오래된 결과를 비워 문맥이 줄어든 뒤 호출들에서 덜 읽힌 양(양수) */
  clearedSaving: number;
}

/** b-studio 세션 이벤트에서 턴 기록을 뽑는다. turn_usage가 턴을 열고, 뒤따르는 tool_result가 그 턴에 붙는다 */
export function turnsFromEvents(events: readonly StudioEvent[]): TurnRecord[] {
  const turns: TurnRecord[] = [];
  for (const event of events) {
    if (event.type !== 'agent') continue;
    const agent = event.event;
    if (agent.type === 'turn_usage') {
      turns.push({
        context: agent.contextTokens,
        output: agent.outputTokens,
        cacheRead: agent.cacheReadTokens,
        cacheWrite: agent.cacheWriteTokens,
        outputChars: 0,
        tools: [],
      });
      continue;
    }
    // 러너는 turn_usage 다음에 그 응답의 글(text)과 도구 호출(tool_call)을 보낸다
    if (agent.type === 'text' || agent.type === 'tool_call') {
      const turn = turns.at(-1);
      if (turn) turn.outputChars += agent.type === 'text' ? agent.text.length : inputChars(agent.input);
      continue;
    }
    if (agent.type === 'tool_result') {
      const turn = turns.at(-1);
      if (turn) turn.tools.push({ name: agent.name, chars: agent.chars ?? agent.content.length });
    }
  }
  return turns;
}

interface SdkUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface SdkBlock {
  type: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: unknown;
  text?: string;
  input?: unknown;
}

/**
 * P0(그냥 Claude Code)의 SDK 메시지로 턴 기록을 만든다. 한 응답이 블록마다 같은 id로 여러 번 오므로 id로 묶고,
 * 도구 결과는 user 메시지의 tool_result 블록을 tool_use id로 찾아 그 턴에 붙인다.
 */
export class TurnRecorder {
  readonly turns: TurnRecord[] = [];
  readonly #byMessage = new Map<string, TurnRecord>();
  readonly #toolTurn = new Map<string, { turn: TurnRecord; name: string }>();

  observeAssistant(message: { id: string; usage?: SdkUsage | null; content: readonly SdkBlock[] }): void {
    let turn = this.#byMessage.get(message.id);
    if (!turn) {
      const usage = message.usage ?? {};
      const input = usage.input_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      turn = { context: input + cacheRead + cacheWrite, output: usage.output_tokens ?? 0, outputChars: 0, cacheRead, cacheWrite, tools: [] };
      this.#byMessage.set(message.id, turn);
      this.turns.push(turn);
    } else if (message.usage?.output_tokens) {
      // 같은 응답의 뒤 조각이 더 큰 출력 값을 가지고 올 수 있다
      turn.output = Math.max(turn.output, message.usage.output_tokens);
    }
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string') turn.outputChars += block.text.length;
      if (block.type === 'tool_use' && block.id && block.name) {
        this.#toolTurn.set(block.id, { turn, name: block.name });
        turn.outputChars += inputChars(block.input);
      }
    }
  }

  observeUser(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const block of content as SdkBlock[]) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      const owner = this.#toolTurn.get(block.tool_use_id);
      if (owner) owner.turn.tools.push({ name: owner.name, chars: resultChars(block.content) });
    }
  }
}

function inputChars(input: unknown): number {
  if (input === undefined || input === null) return 0;
  if (typeof input === 'string') return input.length;
  try {
    return JSON.stringify(input).length;
  } catch {
    return 0;
  }
}

function resultChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return (content as SdkBlock[]).reduce((sum, block) => sum + (typeof block.text === 'string' ? block.text.length : 0), 0);
}

export function tokenBreakdown(turns: readonly TurnRecord[]): TokenBreakdown {
  const calls = turns.length;
  const contextTotal = turns.reduce((sum, turn) => sum + turn.context, 0);
  const output = turns.reduce((sum, turn) => sum + turn.output, 0);
  const firstContext = turns[0]?.context ?? 0;
  const toolReread: Record<string, number> = {};
  const toolResults: Record<string, { calls: number; chars: number }> = {};
  let outputReread = 0;
  let clearedSaving = 0;

  for (const [index, turn] of turns.entries()) {
    for (const tool of turn.tools) {
      const entry = (toolResults[tool.name] ??= { calls: 0, chars: 0 });
      entry.calls += 1;
      entry.chars += tool.chars;
    }
    const next = turns[index + 1];
    if (!next) continue;
    const remaining = calls - 1 - index;
    const growth = next.context - turn.context;
    if (growth < 0) {
      clearedSaving += -growth * remaining;
      continue;
    }
    // 늘어난 양을 모델이 쓴 글자와 도구 결과 글자의 비율로 나눈다. 둘 다 0이면(기록이 없는 옛 행 등) 출력 쪽으로 센다
    const toolChars = turn.tools.reduce((sum, tool) => sum + tool.chars, 0);
    const writtenChars = turn.outputChars ?? 0;
    if (toolChars === 0) {
      outputReread += growth * remaining;
      continue;
    }
    const fromTools = (growth * toolChars) / (toolChars + writtenChars);
    outputReread += (growth - fromTools) * remaining;
    for (const tool of turn.tools) {
      toolReread[tool.name] = (toolReread[tool.name] ?? 0) + (fromTools * remaining * tool.chars) / toolChars;
    }
  }

  for (const name of Object.keys(toolReread)) toolReread[name] = Math.round(toolReread[name]!);
  outputReread = Math.round(outputReread);
  return {
    calls,
    contextTotal,
    output,
    firstContext,
    fixed: firstContext * calls,
    outputReread,
    toolReread,
    toolResults,
    clearedSaving,
  };
}
