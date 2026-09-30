import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { claudeCodeAsk, type ClaudeCodeAskQuery, type ClaudeCodeAskSdk } from './claude-code-ask';

/** query()에 넘어온 options를 잡아 두고, 텍스트 하나만 돌려주는 가짜 SDK(실제 모델·네트워크 호출 없음) */
function fakeSdk(text = '{"ok":true}'): { sdk: ClaudeCodeAskSdk; optionsSeen: Options[] } {
  const optionsSeen: Options[] = [];
  const sdk: ClaudeCodeAskSdk = {
    query({ options }) {
      optionsSeen.push(options);
      async function* run(): AsyncGenerator<SDKMessage> {
        yield { type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null } as unknown as SDKMessage;
        yield { type: 'result', subtype: 'success', is_error: false, result: text, modelUsage: {} } as unknown as SDKMessage;
      }
      const query = Object.assign(run(), { close: () => {} }) as ClaudeCodeAskQuery;
      return query;
    },
  };
  return { sdk, optionsSeen };
}

describe('claudeCodeAsk', () => {
  it('기본값은 파일·명령 도구를 모두 닫고 한 번만 묻는다(maxTurns: 1)', async () => {
    const { sdk, optionsSeen } = fakeSdk();
    const ask = claudeCodeAsk({ cwd: '/tmp/project', sdk });

    const answer = await ask({ system: 's', user: 'u' });

    expect(answer.text).toBe('{"ok":true}');
    expect(optionsSeen[0]!.tools).toEqual([]);
    expect(optionsSeen[0]!.allowedTools).toEqual([]);
    expect(optionsSeen[0]!.maxTurns).toBe(1);
    expect(optionsSeen[0]!.settingSources).toEqual([]);
  });

  it('webTools: true는 WebSearch·WebFetch만 열고 턴 상한을 늘린다(파일·명령 도구는 그대로 닫는다)', async () => {
    const { sdk, optionsSeen } = fakeSdk('추천 답');
    const ask = claudeCodeAsk({ cwd: '/tmp/project', webTools: true, sdk });

    const answer = await ask({ system: 's', user: 'u' });

    expect(answer.text).toBe('추천 답');
    expect(optionsSeen[0]!.tools).toEqual(['WebSearch', 'WebFetch']);
    expect(optionsSeen[0]!.allowedTools).toEqual(['WebSearch', 'WebFetch']);
    expect(optionsSeen[0]!.maxTurns).toBeGreaterThan(1);
    // 웹 도구를 열어도 프로젝트/사용자 설정·MCP는 여전히 싣지 않는다
    expect(optionsSeen[0]!.settingSources).toEqual([]);
    expect(optionsSeen[0]!.mcpServers).toEqual({});
  });

  it('webTools를 생략하거나 false로 주면 기본값(도구 없음)과 같다', async () => {
    const { sdk, optionsSeen } = fakeSdk();
    await claudeCodeAsk({ cwd: '/tmp/project', webTools: false, sdk })({ system: 's', user: 'u' });

    expect(optionsSeen[0]!.tools).toEqual([]);
    expect(optionsSeen[0]!.maxTurns).toBe(1);
  });
});
