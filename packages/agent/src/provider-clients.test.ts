import { describe, expect, it, vi } from 'vitest';
import type { AgentRequest } from './loop';
import type { ModelProfile } from './model-router';
import { GoogleModelClient, OpenAICompatibleModelClient } from './provider-clients';

const request: AgentRequest = {
  system: '프로젝트 규칙',
  tools: [{ name: 'read_file', description: '파일 읽기', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  messages: [{ role: 'user', content: '파일을 읽어줘' }],
};

const profile = (provider: 'openai' | 'google'): ModelProfile => ({
  id: provider,
  provider,
  model: `${provider}-model`,
  label: provider,
  capabilities: ['tools'],
  contextWindow: 100_000,
  pricing: { inputPerMillion: 1, outputPerMillion: 2 },
  baselineQuality: 0.8,
  baselineLatencyMs: 1_000,
  apiKeyEnv: 'TEST_KEY',
});

describe('OpenAICompatibleModelClient', () => {
  it('공통 도구 계약을 OpenAI tool call로 왕복한다', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'msg-1',
          model: 'openai-model',
          choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } }],
          usage: { prompt_tokens: 30, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 10 } },
        }),
        { status: 200 },
      ),
    );
    const client = new OpenAICompatibleModelClient({ profile: profile('openai'), fetcher, env: { TEST_KEY: 'secret' } });
    const message = await client.createMessage(request);
    expect(message.stop_reason).toBe('tool_use');
    expect(message.content[0]).toMatchObject({ type: 'tool_use', name: 'read_file', input: { path: 'README.md' } });
    expect(message.usage.cache_read_input_tokens).toBe(10);
    const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(sent.tools[0].function.name).toBe('read_file');
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toEqual(expect.objectContaining({ TEST_KEY: expect.anything() }));
  });
});

describe('GoogleModelClient', () => {
  it('공통 도구 계약을 Gemini function call로 왕복한다', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          responseId: 'response-1',
          modelVersion: 'google-model',
          candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { id: 'call-2', name: 'read_file', args: { path: 'README.md' } } }] } }],
          usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 4 },
        }),
        { status: 200 },
      ),
    );
    const client = new GoogleModelClient({ profile: profile('google'), fetcher, env: { TEST_KEY: 'secret' } });
    const message = await client.createMessage(request);
    expect(message.stop_reason).toBe('tool_use');
    expect(message.content[0]).toMatchObject({ type: 'tool_use', name: 'read_file', input: { path: 'README.md' } });
    const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(sent.tools[0].functionDeclarations[0].parametersJsonSchema).toMatchObject({ type: 'object' });
    expect(fetcher.mock.calls[0]?.[0]).not.toContain('secret');
  });
});
