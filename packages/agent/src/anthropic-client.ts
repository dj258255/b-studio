import Anthropic from '@anthropic-ai/sdk';
import type { AgentRequest, ModelClient, ModelClientInfo } from './loop';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicModelClientOptions {
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  authLabel?: string;
}

export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Claude API 클라이언트.
 * - adaptive thinking (Opus 5는 기본값이지만 명시한다)
 * - 안전 분류기가 거절하면 서버가 권장 모델로 다시 실행하도록 fallbacks: "default"
 * - 도구 정의와 시스템 프롬프트는 고정이므로 캐시 지점을 두고, 대화 끝부분은 자동 캐시
 * - 긴 출력이 HTTP 타임아웃에 걸리지 않도록 스트리밍으로 받는다
 */
export class AnthropicModelClient implements ModelClient {
  readonly info: ModelClientInfo;
  readonly model: string;
  readonly effort: Effort;
  readonly #maxTokens: number;
  readonly #credentials: Pick<AnthropicModelClientOptions, 'apiKey' | 'authToken' | 'baseURL'>;
  #client: Anthropic | undefined;

  constructor({ model = DEFAULT_MODEL, effort = 'high', maxTokens = 64_000, apiKey, authToken, baseURL, authLabel = '서버 인증' }: AnthropicModelClientOptions = {}) {
    this.model = model;
    this.effort = effort;
    this.#maxTokens = maxTokens;
    this.#credentials = { apiKey, authToken, baseURL };
    this.info = { provider: 'anthropic', backend: 'Anthropic API', model, auth: authLabel };
  }

  /** 샌드박스를 띄우기 전에 인증과 모델 접근 권한을 토큰 소비 없이 확인한다 */
  async preflight(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.#anthropic().models.retrieve(this.model);
      return { ok: true };
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        return { ok: false, reason: 'Claude API 인증에 실패했습니다. API 키가 올바른지 확인하세요.' };
      }
      if (error instanceof Anthropic.NotFoundError) {
        return { ok: false, reason: `이 계정에서 ${this.model} 모델을 사용할 수 없습니다.` };
      }
      if (error instanceof Anthropic.APIConnectionError) {
        return { ok: false, reason: 'Claude API에 연결하지 못했습니다. 네트워크를 확인하세요.' };
      }
      if (error instanceof Anthropic.APIError) {
        return { ok: false, reason: `Claude API 확인에 실패했습니다 (HTTP ${error.status}): ${error.message}` };
      }
      // 인증 수단이 하나도 없으면 SDK가 요청을 만들기 전에 일반 Error를 던진다
      if (error instanceof Error) {
        return {
          ok: false,
          reason: `Claude API 인증 정보를 찾지 못했습니다. ANTHROPIC_API_KEY를 설정하거나 \`ant auth login\`으로 로그인하세요.\n(${error.message})`,
        };
      }
      throw error;
    }
  }

  async createMessage({ system, tools, messages }: AgentRequest, signal?: AbortSignal) {
    const stream = this.#anthropic().beta.messages.stream(
      {
        model: this.model,
        max_tokens: this.#maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: this.effort },
        cache_control: { type: 'ephemeral' },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools,
        messages,
      },
      { signal },
    );
    return stream.finalMessage();
  }

  #anthropic(): Anthropic {
    return (this.#client ??= new Anthropic(this.#credentials));
  }
}
