import type Anthropic from '@anthropic-ai/sdk';
import type { AgentRequest, ModelClient, ModelClientInfo } from './loop';

export interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  /** 거절 같은 특수한 종료를 흉내 낼 때 */
  stopReason?: 'refusal';
}

/**
 * 미리 적어 둔 턴을 차례로 돌려주는 모델.
 * API 키 없이 루프, 도구, 검증 게이트, 샌드박스가 실제로 맞물리는지 확인하는 용도다.
 * 모델의 코드 작성 능력을 검증하는 도구가 아니다.
 */
export class ScriptedModelClient implements ModelClient {
  readonly info: ModelClientInfo = { provider: 'scripted', backend: '데모 스크립트', model: 'scripted' };
  readonly requests: AgentRequest[] = [];
  readonly #turns: ScriptedTurn[];
  #ids = 0;

  constructor(turns: readonly ScriptedTurn[]) {
    this.#turns = [...turns];
  }

  get remainingTurns(): number {
    return this.#turns.length;
  }

  async createMessage(request: AgentRequest): Promise<Anthropic.Beta.BetaMessage> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const turn = this.#turns.shift();
    if (!turn) throw new Error('스크립트에 남은 턴이 없습니다');

    const content = [
      ...(turn.text ? [{ type: 'text', text: turn.text, citations: null }] : []),
      ...(turn.toolCalls ?? []).map((call) => ({ type: 'tool_use', id: `toolu_scripted_${++this.#ids}`, name: call.name, input: call.input })),
    ];
    const stopReason = turn.stopReason ?? (turn.toolCalls?.length ? 'tool_use' : 'end_turn');

    // 루프가 읽는 필드만 채운 테스트 더블이다
    return {
      id: `msg_scripted_${++this.#ids}`,
      type: 'message',
      role: 'assistant',
      model: 'scripted',
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: stopReason === 'refusal' ? { type: 'refusal', category: 'scripted', explanation: null } : null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as Anthropic.Beta.BetaMessage;
  }
}
