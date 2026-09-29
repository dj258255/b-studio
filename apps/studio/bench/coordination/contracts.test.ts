import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { claudeCodeContractAsk, type ContractsQuery, type ContractsSdk } from './contracts';

/**
 * Claude Code 프로세스를 흉내 내는 가짜 SDK. 실제 모델 호출 없이 옵션과 파싱만 확인한다.
 * 계약 호출은 한 번의 query라서 assistant 텍스트 하나와 result 하나만 흉내 내면 된다.
 */
function fakeClaudeCode(options: { text?: string; result?: Record<string, unknown> } = {}) {
  const state = { options: undefined as Options | undefined, prompt: '', closed: false, queries: 0 };
  const sdk: ContractsSdk = {
    query({ prompt, options: queryOptions }) {
      state.queries += 1;
      state.options = queryOptions;
      state.prompt = prompt;
      async function* run(): AsyncGenerator<SDKMessage> {
        yield { type: 'system', subtype: 'init', claude_code_version: '9.9.9', model: 'test-model', session_id: 's1' } as unknown as SDKMessage;
        if (options.text !== undefined) {
          yield {
            type: 'assistant',
            message: { id: 'msg_1', content: [{ type: 'text', text: options.text }] },
            parent_tool_use_id: null,
            session_id: 's1',
          } as unknown as SDKMessage;
        }
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: options.text ?? '',
          stop_reason: 'end_turn',
          errors: [],
          modelUsage: { 'test-model': { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 40, cacheCreationInputTokens: 5 } },
          session_id: 's1',
          ...options.result,
        } as unknown as SDKMessage;
      }
      const query: ContractsQuery = Object.assign(run(), {
        close: () => {
          state.closed = true;
        },
      });
      return query;
    },
  };
  return { sdk, state };
}

describe('claudeCodeContractAsk', () => {
  it('도구·설정 없이 한 번만 묻고, 계약 텍스트와 usage를 돌려준다', async () => {
    const { sdk, state } = fakeClaudeCode({ text: '{"contracts":[{"body":"GET /api/orders → 200 JSON 배열","refs":["api"]}]}' });

    const answer = await claudeCodeContractAsk({ cwd: '/tmp/project', model: 'sonnet', sdk })({ system: '계약 시스템', user: '전체 요청: 주문 목록' });

    expect(answer.text).toContain('"contracts"');
    // usage는 result의 modelUsage에서 온다(러너와 같은 규칙)
    expect(answer.usage).toEqual({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 40, cacheWriteTokens: 5 });
    expect(state.queries).toBe(1);
    expect(state.prompt).toBe('전체 요청: 주문 목록');
    expect(state.closed).toBe(true);

    const options = state.options!;
    // 계약 한 번 호출에 필요한 최소 옵션. 도구·설정·세션을 남기지 않는다
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.maxTurns).toBe(1);
    expect(options.persistSession).toBe(false);
    expect(options.settingSources).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect(options.systemPrompt).toBe('계약 시스템');
    expect(options.model).toBe('sonnet');
    expect(options.cwd).toBe('/tmp/project');
  });

  it('--model이 없으면 모델을 고정하지 않는다(계정 기본)', async () => {
    const { sdk, state } = fakeClaudeCode({ text: '{"contracts":[]}' });
    await claudeCodeContractAsk({ cwd: '/tmp/project', sdk })({ system: 's', user: 'u' });
    expect(state.options!.model).toBeUndefined();
  });

  it('모델이 실패를 돌려주면 이유를 담아 던진다(사용 한도 문구도 그대로 남긴다)', async () => {
    const { sdk } = fakeClaudeCode({ result: { subtype: 'error_during_execution', is_error: true, errors: ['Claude usage limit reached'] } });

    await expect(claudeCodeContractAsk({ cwd: '/tmp/project', sdk })({ system: 's', user: 'u' })).rejects.toThrow(/사용 한도|usage limit/);
  });

  it('빈 응답이면 계약으로 쓰지 않고 실패시킨다', async () => {
    const { sdk } = fakeClaudeCode({ text: '   ' });
    await expect(claudeCodeContractAsk({ cwd: '/tmp/project', sdk })({ system: 's', user: 'u' })).rejects.toThrow(/빈 응답/);
  });
});
