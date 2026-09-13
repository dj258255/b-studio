import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentRequest, ModelClient, ModelClientInfo, ModelPreflight } from './loop';
import type { ModelProfile } from './model-router';

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;

interface ProviderClientOptions {
  profile: ModelProfile;
  maxTokens?: number;
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export function createProviderClient(options: ProviderClientOptions): ModelClient {
  if (options.profile.provider === 'openai') return new OpenAICompatibleModelClient(options);
  if (options.profile.provider === 'google') return new GoogleModelClient(options);
  throw new Error(`${options.profile.provider} 공급자는 전용 클라이언트를 사용해야 합니다`);
}

export class OpenAICompatibleModelClient implements ModelClient {
  readonly info: ModelClientInfo;
  readonly #profile: ModelProfile;
  readonly #maxTokens: number;
  readonly #fetch: typeof fetch;
  readonly #env: NodeJS.ProcessEnv;

  constructor({ profile, maxTokens = 64_000, fetcher = fetch, env = process.env }: ProviderClientOptions) {
    if (profile.provider !== 'openai') throw new Error('OpenAI 호환 클라이언트에는 openai 모델 설정이 필요합니다');
    this.#profile = profile;
    this.#maxTokens = maxTokens;
    this.#fetch = fetcher;
    this.#env = env;
    this.info = { provider: 'openai', backend: 'OpenAI 호환 API', model: profile.model, auth: profile.apiKeyEnv ?? 'API 키' };
  }

  async preflight(): Promise<ModelPreflight> {
    try {
      const key = apiKey(this.#profile, this.#env);
      const response = await this.#fetch(`${baseUrl(this.#profile, 'https://api.openai.com/v1')}/models/${encodeURIComponent(this.#profile.model)}`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { ok: true };
      return { ok: false, reason: `OpenAI 호환 API에서 ${this.#profile.model} 모델을 확인하지 못했습니다 (HTTP ${response.status})` };
    } catch (error) {
      return { ok: false, reason: `OpenAI 호환 API에 연결하지 못했습니다: ${describe(error)}` };
    }
  }

  async createMessage(request: AgentRequest, signal?: AbortSignal): Promise<BetaMessage> {
    const key = apiKey(this.#profile, this.#env);
    const response = await this.#fetch(`${baseUrl(this.#profile, 'https://api.openai.com/v1')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: this.#profile.model,
        messages: openAiMessages(request.system, request.messages),
        tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
        tool_choice: request.tools.length ? 'auto' : undefined,
        max_completion_tokens: this.#maxTokens,
      }),
      signal,
    });
    const payload = (await json(response)) as OpenAIResponse;
    if (!response.ok) throw new Error(`OpenAI 호환 API 호출 실패 (HTTP ${response.status}): ${providerError(payload)}`);
    const choice = payload.choices?.[0];
    if (!choice?.message) throw new Error('OpenAI 호환 API 응답에 message가 없습니다');
    const content: unknown[] = [];
    if (choice.message.content) content.push({ type: 'text', text: choice.message.content, citations: null });
    for (const call of choice.message.tool_calls ?? []) {
      content.push({ type: 'tool_use', id: call.id || `toolu_openai_${randomUUID()}`, name: call.function.name, input: parseArguments(call.function.arguments) });
    }
    if (choice.message.refusal && content.length === 0) content.push({ type: 'text', text: choice.message.refusal, citations: null });
    const stopReason = choice.message.refusal ? 'refusal' : choice.message.tool_calls?.length ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
    return betaMessage({
      id: payload.id ?? `msg_openai_${randomUUID()}`,
      model: payload.model ?? this.#profile.model,
      content,
      stopReason,
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
      cacheReadTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      refusal: choice.message.refusal ?? undefined,
    });
  }
}

export class GoogleModelClient implements ModelClient {
  readonly info: ModelClientInfo;
  readonly #profile: ModelProfile;
  readonly #maxTokens: number;
  readonly #fetch: typeof fetch;
  readonly #env: NodeJS.ProcessEnv;

  constructor({ profile, maxTokens = 64_000, fetcher = fetch, env = process.env }: ProviderClientOptions) {
    if (profile.provider !== 'google') throw new Error('Google 클라이언트에는 google 모델 설정이 필요합니다');
    this.#profile = profile;
    this.#maxTokens = maxTokens;
    this.#fetch = fetcher;
    this.#env = env;
    this.info = { provider: 'google', backend: 'Google Gemini API', model: profile.model, auth: profile.apiKeyEnv ?? 'API 키' };
  }

  async preflight(): Promise<ModelPreflight> {
    try {
      const response = await this.#fetch(`${baseUrl(this.#profile, 'https://generativelanguage.googleapis.com/v1beta')}/models/${encodeURIComponent(this.#profile.model)}`, {
        headers: googleHeaders(this.#profile, this.#env),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { ok: true };
      return { ok: false, reason: `Google API에서 ${this.#profile.model} 모델을 확인하지 못했습니다 (HTTP ${response.status})` };
    } catch (error) {
      return { ok: false, reason: `Google API에 연결하지 못했습니다: ${describe(error)}` };
    }
  }

  async createMessage(request: AgentRequest, signal?: AbortSignal): Promise<BetaMessage> {
    const response = await this.#fetch(
      `${baseUrl(this.#profile, 'https://generativelanguage.googleapis.com/v1beta')}/models/${encodeURIComponent(this.#profile.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...googleHeaders(this.#profile, this.#env) },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: googleContents(request.messages),
          tools: request.tools.length
            ? [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.input_schema })) }]
            : undefined,
          generationConfig: { maxOutputTokens: this.#maxTokens },
        }),
        signal,
      },
    );
    const payload = (await json(response)) as GoogleResponse;
    if (!response.ok) throw new Error(`Google API 호출 실패 (HTTP ${response.status}): ${providerError(payload)}`);
    const candidate = payload.candidates?.[0];
    if (!candidate) {
      const blocked = payload.promptFeedback?.blockReason;
      if (blocked) return betaMessage({ id: payload.responseId, model: payload.modelVersion ?? this.#profile.model, content: [], stopReason: 'refusal', refusal: blocked });
      throw new Error('Google API 응답에 candidate가 없습니다');
    }
    const content: unknown[] = [];
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text === 'string') content.push({ type: 'text', text: part.text, citations: null });
      if (part.functionCall) {
        content.push({ type: 'tool_use', id: part.functionCall.id || `toolu_google_${randomUUID()}`, name: part.functionCall.name, input: part.functionCall.args ?? {} });
      }
    }
    const toolUse = content.some((block) => Boolean(block && typeof block === 'object' && 'type' in block && block.type === 'tool_use'));
    const refused = ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(candidate.finishReason ?? '');
    const usage = payload.usageMetadata;
    return betaMessage({
      id: payload.responseId,
      model: payload.modelVersion ?? this.#profile.model,
      content,
      stopReason: refused ? 'refusal' : toolUse ? 'tool_use' : candidate.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn',
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
      refusal: refused ? candidate.finishReason : undefined,
    });
  }
}

function apiKey(profile: ModelProfile, env: NodeJS.ProcessEnv): string | undefined {
  const name = profile.apiKeyEnv ?? (profile.provider === 'openai' ? 'OPENAI_API_KEY' : profile.provider === 'google' ? 'GOOGLE_API_KEY' : 'ANTHROPIC_API_KEY');
  const value = env[name]?.trim();
  const local = profile.baseUrl && ['localhost', '127.0.0.1', '::1'].includes(new URL(profile.baseUrl).hostname);
  if (!value && !local) throw new Error(`${profile.label}에 필요한 ${name} 환경 변수가 없습니다`);
  return value;
}

function baseUrl(profile: ModelProfile, fallback: string): string {
  return (profile.baseUrl ?? fallback).replace(/\/$/, '');
}

function googleHeaders(profile: ModelProfile, env: NodeJS.ProcessEnv): Record<string, string> {
  const key = apiKey(profile, env);
  return key ? { 'x-goog-api-key': key } : {};
}

function openAiMessages(system: string, messages: BetaMessageParam[]): unknown[] {
  const result: unknown[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      result.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
      const toolCalls = message.content.flatMap((block) =>
        block.type === 'tool_use' ? [{ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } }] : [],
      );
      result.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    if (text) result.push({ role: 'user', content: text });
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      result.push({ role: 'tool', tool_call_id: block.tool_use_id, content: stringifyContent(block.content) });
    }
  }
  return result;
}

function googleContents(messages: BetaMessageParam[]): unknown[] {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content !== 'string') {
      for (const block of message.content) if (block.type === 'tool_use') toolNames.set(block.id, block.name);
    }
  }
  const contents: unknown[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] });
      continue;
    }
    const parts: unknown[] = [];
    for (const block of message.content) {
      if (block.type === 'text') parts.push({ text: block.text });
      if (block.type === 'tool_use') parts.push({ functionCall: { id: block.id, name: block.name, args: block.input } });
      if (block.type === 'tool_result') {
        parts.push({ functionResponse: { id: block.tool_use_id, name: toolNames.get(block.tool_use_id) ?? 'tool', response: block.is_error ? { error: stringifyContent(block.content) } : { output: stringifyContent(block.content) } } });
      }
    }
    if (parts.length) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  return contents;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.flatMap((block) => (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? [block.text] : [])).join('\n');
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function betaMessage({
  id = `msg_${randomUUID()}`,
  model,
  content,
  stopReason,
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  refusal,
}: {
  id?: string;
  model: string;
  content: unknown[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  refusal?: string;
}): BetaMessage {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: content as BetaContentBlock[],
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: stopReason === 'refusal' ? { type: 'refusal', category: refusal ?? 'provider', explanation: null } : null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: cacheReadTokens, cache_creation_input_tokens: 0 },
  } as unknown as BetaMessage;
}

async function json(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

function providerError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '응답 본문 없음';
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return '알 수 없는 오류';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface OpenAIResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string };
}

interface GoogleResponse {
  responseId?: string;
  modelVersion?: string;
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; functionCall?: { id?: string; name: string; args?: Record<string, unknown> } }> };
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
  error?: { message?: string };
}
